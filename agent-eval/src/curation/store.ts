import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { TraceBundleSchema, type TraceBundle } from '../../../packages/contracts/src/evaluation-loop.ts';
import { atomicJson, acquireEvaluationWrite } from '../reports/files.ts';
import { candidateSchema, kindSchema, uuid, safePath, type Candidate } from './schemas.ts';
import { resolveCandidateCase } from './publication.ts';
import { decodeFile, type EmbeddedFile } from '../dataset-loader/flat.ts';
import { z } from 'zod';
import { archiveExecutionLocations, archiveFile, readableTimestamp, readableSlug, readArchive, readSnapshot, saveArchive } from '../reports/archive.ts';
import { readReport } from '../reports/store.ts';
import { reportTraces } from '../execution/trace.ts';

export function directory(repo: string, parts: string[], create = false): string {
    let current = realpathSync(repo);
    for (const part of parts) {
        safePath.parse(part); if (part.includes('/')) throw Error('Expected one directory component');
        current = join(current, part); const stat = lstatSync(current, { throwIfNoEntry: false });
        if (stat && (!stat.isDirectory() || stat.isSymbolicLink())) throw Error('Linked or invalid curation directory');
        if (!stat) { if (!create) continue; mkdirSync(current); }
        if (realpathSync(current).toLowerCase() !== resolve(current).toLowerCase()) throw Error('Curation path escapes repository');
    }
    return current;
}
export function json(file: string): unknown {
    const stat = lstatSync(file); if (!stat.isFile() || stat.isSymbolicLink()) throw Error('Linked or invalid curation file');
    return JSON.parse(readFileSync(file, 'utf8'));
}
export const datasetParts = ['agent-eval', 'src', 'datasets'];
export function acquireCandidateWrite(repo: string, id: string): () => void {
    uuid.parse(id);
    return acquireEvaluationWrite(join(directory(repo, datasetParts, true), 'candidate-' + id));
}
export const traceDirectory = (repo: string, id: string, create = false) => { uuid.parse(id); return directory(repo, ['agent-eval', 'traces'], create); };
export const candidateDirectory = (repo: string, kind: Candidate['kind'], id: string, create = false) => {
    uuid.parse(id); return directory(repo, [...datasetParts, kindSchema.parse(kind) + '-candidates'], create);
};
function files(root: string, prefix: string) {
    return !existsSync(root) ? [] : readdirSync(root, { withFileTypes: true }).filter(item =>
        (item.isFile() || item.isSymbolicLink()) && item.name.startsWith(prefix + '-') && item.name.endsWith('.json')).map(item => join(root, item.name));
}
function availableFile(root: string, prefix: string) {
    let sequence = 1, file: string;
    do { file = join(root, prefix + '-' + String(sequence++).padStart(2, '0') + '.json'); } while (existsSync(file));
    return file;
}
const operationsSchema = z.record(z.record(z.unknown()));
export type TraceState = { operations: z.infer<typeof operationsSchema>; platformSnapshot?: { readAt: string; trace: TraceBundle } };
function traceRecord(file: string) {
    const { operations = {}, platformSnapshot, ...content } = z.record(z.unknown()).parse(json(file));
    return { trace: TraceBundleSchema.parse(content), operations: operationsSchema.parse(operations),
        ...(platformSnapshot === undefined ? {} : { platformSnapshot: z.object({ readAt: z.string().datetime(), trace: TraceBundleSchema }).strict().parse(platformSnapshot) }) };
}
function localTrace(repo: string, id: string) {
    uuid.parse(id);
    const matches = files(traceDirectory(repo, id), 'Trace').filter(file => traceRecord(file).trace.id === id);
    if (matches.length > 1) throw Error('Duplicate Trace identity'); return matches[0];
}
function benchmarkTraces(repo: string) {
    return archiveExecutionLocations(repo).flatMap(location => {
        const report = readReport(location.report), snapshot = readSnapshot(location.report);
        const visibleFiles = Object.fromEntries((snapshot.materials ?? []).map((item: { caseId: string; files?: EmbeddedFile[] }) => [item.caseId, item.files ?? []]));
        return reportTraces(report, visibleFiles).map(trace => ({ trace, file: location.report }));
    });
}
export function traceFile(repo: string, id: string): string {
    const file = localTrace(repo, id); if (file) return file;
    const matches = benchmarkTraces(repo).filter(row => row.trace.id === id);
    if (matches.length !== 1) throw Error(matches.length ? 'Duplicate Trace identity' : 'Unknown Trace'); return matches[0]!.file;
}
export function readTrace(repo: string, id: string): TraceBundle {
    const file = localTrace(repo, id); if (file) return traceRecord(file).trace;
    const matches = benchmarkTraces(repo).filter(row => row.trace.id === id);
    if (matches.length !== 1) throw Error(matches.length ? 'Duplicate Trace identity' : 'Unknown Trace'); return matches[0]!.trace;
}
export function readTraceState(repo: string, id: string): TraceState {
    const file = localTrace(repo, id); if (file) { const { trace, ...state } = traceRecord(file); return state; }
    const archive = readArchive(traceFile(repo, id)), workflow = z.record(z.unknown()).parse(archive.workflow ?? {});
    const states = z.record(z.unknown()).parse(workflow.traceOperations ?? {}), state = z.record(z.unknown()).parse(states[id] ?? {});
    return { operations: operationsSchema.parse(state.operations ?? {}), ...(state.platformSnapshot === undefined ? {} : {
        platformSnapshot: z.object({ readAt: z.string().datetime(), trace: TraceBundleSchema }).strict().parse(state.platformSnapshot) }) };
}
export function updateTraceState(repo: string, id: string, update: (state: TraceState) => void): TraceState {
    const file = traceFile(repo, id), release = acquireEvaluationWrite(archiveFile(file));
    try {
        const state = readTraceState(repo, id); update(state); operationsSchema.parse(state.operations);
        if (file.includes('#')) {
            const archive = readArchive(file), workflow = z.record(z.unknown()).parse(archive.workflow ?? {});
            const states = z.record(z.unknown()).parse(workflow.traceOperations ?? {});
            states[id] = state; archive.workflow = { ...workflow, traceOperations: states }; saveArchive(file, archive);
        } else atomicJson(file, { ...traceRecord(file).trace, ...state });
        return state;
    } finally { release(); }
}
export const readTraceOperation = (repo: string, id: string, group: string, key: string) => readTraceState(repo, id).operations[group]?.[key];
export function writeTraceOperation(repo: string, id: string, group: string, key: string, value: unknown) {
    updateTraceState(repo, id, state => { (state.operations[group] ??= {})[key] = value; });
}
export function saveTrace(repo: string, value: unknown): TraceBundle {
    const trace = TraceBundleSchema.parse(value);
    if (trace.source.kind === 'evaluation') throw Error('Benchmark Traces are derived from their saved Execution');
    const root = traceDirectory(repo, trace.id, true), release = acquireEvaluationWrite(join(root, 'collection'));
    try {
        const existing = localTrace(repo, trace.id);
        const purpose = ['native-maintenance', 'manual-compaction'].includes(String(trace.configuration.purpose)) ? String(trace.configuration.purpose) : 'task';
        const file = existing ?? availableFile(root, 'Trace-' + readableTimestamp(new Date(trace.startedAt)) + '-' + trace.entry + '-' + purpose);
        const unlock = acquireEvaluationWrite(file);
        try {
            if (existing) {
                const previous = readTrace(repo, trace.id);
                if (isDeepStrictEqual(previous, trace)) return previous;
                if (trace.revision !== previous.revision + 1) throw Error('Stale trace revision');
            } else if (trace.revision !== 1) throw Error('First trace revision must be 1');
            atomicJson(file, { ...trace, ...(existing ? readTraceState(repo, trace.id) : {}) });
        } finally { unlock(); } return trace;
    } finally { release(); }
}
export function listTraces(repo: string): TraceBundle[] {
    const traces = [...files(directory(repo, ['agent-eval', 'traces']), 'Trace').map(file => traceRecord(file).trace), ...benchmarkTraces(repo).map(row => row.trace)];
    if (new Set(traces.map(trace => trace.id)).size !== traces.length) throw Error('Duplicate Trace identity');
    return traces.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}
const candidatePrefix = { gold: 'Gold', bad: 'Bad', regression: 'Regression' };
export function candidateFile(repo: string, id: string): string {
    uuid.parse(id);
    const matches = kindSchema.options.flatMap(kind => files(candidateDirectory(repo, kind, id), candidatePrefix[kind]).filter(file => {
        const value = candidateSchema.parse(json(file)); if (value.kind !== kind) throw Error('Candidate collection identity differs'); return value.id === id;
    }));
    if (matches.length !== 1) throw Error(matches.length ? 'Duplicate candidate identity' : 'Unknown candidate'); return matches[0]!;
}
export function readCandidate(repo: string, id: string): Candidate {
    return candidateSchema.parse(json(candidateFile(repo, id)));
}
export function writeCandidate(repo: string, value: Candidate): Candidate {
    const candidate = candidateSchema.parse(value), root = candidateDirectory(repo, candidate.kind, candidate.id, true);
    if(candidate.reuseCaseId&&candidate.reviseCase)throw Error('reuseCaseId and reviseCase are mutually exclusive');
    const release = acquireEvaluationWrite(join(root, 'collection'));
    try {
        const existing = listCandidates(repo).find(item => item.id === candidate.id);
        const label = candidate.case?.name ?? readTrace(repo, candidate.traceRef.id).entry;
        const file = existing ? candidateFile(repo, candidate.id) : availableFile(root,
            candidatePrefix[candidate.kind] + '-' + readableTimestamp(new Date(candidate.createdAt ?? Date.now())) + '-' + readableSlug(label));
        atomicJson(file, candidate); return candidate;
    } finally { release(); }
}
export function saveCandidate(repo: string, value: unknown): Candidate {
    const candidate = candidateSchema.parse(value);
    if (candidate.revision !== 1) throw Error('New candidate revision must be 1');
    const release = acquireCandidateWrite(repo, candidate.id);
    try {
        if (listCandidates(repo).some(item => item.id === candidate.id)) throw Error('Candidate already exists');
        const trace = readTrace(repo, candidate.traceRef.id);
        if (trace.revision !== candidate.traceRef.revision) throw Error('Stale candidate trace revision');
        const now = new Date().toISOString();
        return writeCandidate(repo, { ...candidate, status: 'draft', validation: undefined, createdAt: now, updatedAt: now });
    } finally { release(); }
}
export function listCandidates(repo: string, kind?: Candidate['kind']): Candidate[] {
    return (kind ? [kindSchema.parse(kind)] : kindSchema.options).flatMap(value => {
        const root = directory(repo, [...datasetParts, value + '-candidates']); if (!existsSync(root)) return [];
        return files(root, candidatePrefix[value]).map(file => { const candidate = candidateSchema.parse(json(file));
            if (candidate.kind !== value) throw Error('Candidate collection identity differs'); return candidate; });
    });
}
export function candidateConditions(repo: string, candidate: Candidate, trace = readTrace(repo, candidate.traceRef.id), controllerGoldFiles?: EmbeddedFile[] | null) {
    if (controllerGoldFiles === undefined) {
        try { controllerGoldFiles = candidate.reuseCaseId || candidate.reviseCase ? resolveCandidateCase(repo, candidate, trace).goldFiles ?? [] : []; }
        catch { controllerGoldFiles = null; }
    }
    return JSON.parse(JSON.stringify({ revision: candidate.revision, kind: candidate.kind, traceRef: candidate.traceRef, sourceLabels: candidate.sourceLabels,
        case: candidate.case, gold: candidate.gold, scenario: candidate.scenario, bindings: candidate.bindings, controls: candidate.controls, controlBindings: candidate.controlBindings,
        reuseCaseId: candidate.reuseCaseId, reviseCase: candidate.reviseCase, trace,
        controllerGoldFiles: controllerGoldFiles === null ? null : controllerGoldFiles.map(file => decodeFile(file).file).sort((a, b) => a.path.localeCompare(b.path)) }));
}
