import { readableTimestamp } from '../../../packages/shared/src/evaluation-files.ts';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { acquireEvaluationWrite, atomicJson, atomicText } from './files.ts';
import type { LocalReport } from './store.ts';

const identity = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/);
const sections = ['executions', 'snapshots', 'exports', 'comparisons', 'gates', 'diagnostics', 'sources', 'scoringRevisions'] as const;
type Section = typeof sections[number] | 'experiment';
const archiveSchema = z.object({
    contract: z.literal('flowmate-evaluation-run/v1'), id: identity, selection: z.string(),
    startedAt: z.string().datetime(), endedAt: z.string().datetime().nullable(), status: z.string(),
    caseSnapshots: z.record(z.record(z.unknown())), fixtures: z.record(z.unknown()), scoring: z.record(z.unknown()),
    materials: z.record(z.object({ path: z.string(), file: z.string() }).strict()).default({}),
    sources: z.record(z.unknown()), executions: z.record(z.unknown()), snapshots: z.record(z.unknown()),
    exports: z.record(z.unknown()), comparisons: z.record(z.unknown()), gates: z.record(z.unknown()), diagnostics: z.record(z.unknown()),
    scoringRevisions: z.record(z.unknown()).default({}),
    experiment: z.unknown().optional(), workflow: z.unknown().optional(),
}).strict();
export type RunArchive = z.infer<typeof archiveSchema>;

export { readableTimestamp } from '../../../packages/shared/src/evaluation-files.ts';
export function readableSlug(value: string) {
    return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 70).replace(/-+$/g, '') || 'record';
}
export function archiveFile(reference: string) { return reference.split('#')[0]!; }
export function isArchiveReference(reference: string) { return /run\.json#(?:experiment$|(?:executions|snapshots|exports|comparisons|gates|diagnostics|scoringRevisions)=)/.test(reference); }
export function archiveReference(file: string, section: Section, id?: string) {
    if (!['experiment', ...sections].includes(section)) throw Error('Unknown Run section');
    if (section !== 'experiment') identity.parse(id);
    return archiveFile(file) + '#' + section + (section === 'experiment' ? '' : '=' + id);
}
function part(reference: string) {
    const [file, fragment, extra] = reference.split('#');
    if (!fragment || extra !== undefined) throw Error('Invalid Run reference');
    const [section, id, trailing] = fragment.split('=');
    if (trailing !== undefined || !['experiment', ...sections].includes(section!)) throw Error('Invalid Run section');
    if (section !== 'experiment') identity.parse(id);
    else if (id !== undefined) throw Error('Invalid experiment reference');
    return { file: file!, section: section as Section, id: id! };
}
function object(value: unknown): Record<string, any> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('Invalid Run object');
    return value as Record<string, any>;
}
export function readArchive(file: string): RunArchive {
    file = archiveFile(file);
    if (lstatSync(file).isSymbolicLink() || realpathSync(dirname(file)).toLowerCase() !== resolve(dirname(file)).toLowerCase())
        throw Error('Linked Run archive rejected');
    return archiveSchema.parse(JSON.parse(readFileSync(file, 'utf8')));
}
export function saveArchive(file: string, archive: RunArchive) { atomicJson(archiveFile(file), archiveSchema.parse(archive)); }
export function updateArchive(file: string, update: (archive: RunArchive) => void) {
    file = archiveFile(file); const release = acquireEvaluationWrite(file);
    try { const archive = readArchive(file); update(archive); saveArchive(file, archive); }
    finally { release(); }
}
export function finishArchive(file: string, status: 'complete' | 'blocked' | 'stopped') {
    updateArchive(file, archive => { archive.status = status; archive.endedAt = new Date().toISOString(); });
}
export function createArchive(repo: string, options: { selection: string; compare?: boolean; id?: string }) {
    let root = realpathSync(repo);
    for (const component of ['agent-eval', 'runs']) {
        root = join(root, component);
        const stat = lstatSync(root, { throwIfNoEntry: false });
        if (stat && (!stat.isDirectory() || stat.isSymbolicLink())) throw Error('Linked Run directory rejected');
        if (!stat) mkdirSync(root);
        if (realpathSync(root).toLowerCase() !== resolve(root).toLowerCase()) throw Error('Run directory escapes workspace');
    }
    const prefix = 'Run-' + readableTimestamp() + '-' + readableSlug(options.selection) + (options.compare ? '-compare' : '');
    let sequence = 1, name: string;
    do { name = options.id?.startsWith('Run-') ? identity.parse(options.id) : prefix + '-' + String(sequence++).padStart(2, '0');
        if (options.id?.startsWith('Run-') && existsSync(join(root, name))) throw Error('Run identity already exists');
    } while (existsSync(join(root, name)));
    root = join(root, name); mkdirSync(root);
    const file = join(root, 'run.json'), archive: RunArchive = { contract: 'flowmate-evaluation-run/v1', id: name,
        selection: options.selection, startedAt: new Date().toISOString(), endedAt: null, status: 'running', caseSnapshots: {},
        fixtures: {}, scoring: {}, materials: {}, sources: {}, executions: {}, snapshots: {}, exports: {}, comparisons: {}, gates: {}, diagnostics: {}, scoringRevisions: {} };
    saveArchive(file, archive);
    atomicText(join(root, 'README.md'), '# ' + name + '\n\nStatus: running. Original progress and evidence are saved in `run.json`.\n');
    return { id: name, file };
}
function sharedCase(archive: RunArchive, key: string, field: string, value: unknown) {
    const entry = archive.caseSnapshots[key] ??= {};
    if (field in entry && !isDeepStrictEqual(entry[field], value)) throw Error('Shared Case conditions differ: ' + key + '/' + field);
    entry[field] = value;
}
function materialPath(file: string, reference: string) {
    if (!/^materials\/Material-[0-9]+\.[a-z0-9]+$/.test(reference)) throw Error('Invalid Run material reference');
    const path = join(dirname(file), reference), parent = dirname(path);
    if (lstatSync(parent).isSymbolicLink() || lstatSync(path).isSymbolicLink() || realpathSync(path).toLowerCase() !== resolve(path).toLowerCase())
        throw Error('Linked Run material rejected');
    return path;
}
function storeMaterials(archive: RunArchive, file: string, value: any): any {
    if (Array.isArray(value)) return value.map(item => storeMaterials(archive, file, item));
    if (!value || typeof value !== 'object') return value;
    if (typeof value.path === 'string' && value.encoding === 'base64' && typeof value.content === 'string' &&
        /\.(pdf|png|jpg|jpeg|gif|webp|zip|xlsx|docx|bin)$/i.test(value.path) && Object.keys(value).every(key => ['path', 'encoding', 'content', 'bytes'].includes(key))) {
        const bytes = Buffer.from(value.content, 'base64');
        if (bytes.toString('base64') !== value.content) throw Error('Invalid binary material encoding');
        if (value.bytes !== undefined && (!Number.isSafeInteger(value.bytes) || value.bytes !== bytes.length)) throw Error('Invalid binary material byte count');
        const previous = Object.entries(archive.materials).find(([, material]) => material.path === value.path);
        if (previous) {
            if (!readFileSync(materialPath(file, previous[1].file)).equals(bytes)) throw Error('Run source material changed');
            return { materialRef: previous[0], ...(value.bytes === undefined ? {} : { bytes: value.bytes }) };
        }
        const root = join(dirname(file), 'materials');
        if (!existsSync(root)) mkdirSync(root);
        if (lstatSync(root).isSymbolicLink() || realpathSync(root).toLowerCase() !== resolve(root).toLowerCase()) throw Error('Linked Run materials rejected');
        const id = 'Material-' + String(Object.keys(archive.materials).length + 1).padStart(3, '0'), extension = value.path.split('.').at(-1)!.toLowerCase();
        const reference = 'materials/' + id + '.' + extension;
        writeFileSync(join(dirname(file), reference), bytes, { flag: 'wx', mode: 0o600 });
        archive.materials[id] = { path: value.path, file: reference };
        return { materialRef: id, ...(value.bytes === undefined ? {} : { bytes: value.bytes }) };
    }
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, storeMaterials(archive, file, item)]));
}
function loadMaterials(archive: RunArchive, file: string, value: any): any {
    if (Array.isArray(value)) return value.map(item => loadMaterials(archive, file, item));
    if (!value || typeof value !== 'object') return value;
    if (typeof value.materialRef === 'string' && Object.keys(value).every(key => ['materialRef', 'bytes'].includes(key))) {
        const material = archive.materials[value.materialRef]; if (!material) throw Error('Missing Run material');
        const bytes = readFileSync(materialPath(file, material.file));
        if (value.bytes !== undefined && (!Number.isSafeInteger(value.bytes) || value.bytes !== bytes.length)) throw Error('Invalid binary material byte count');
        return { path: material.path, encoding: 'base64', content: bytes.toString('base64'), ...(value.bytes === undefined ? {} : { bytes: value.bytes }) };
    }
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, loadMaterials(archive, file, item)]));
}
function storeSnapshot(archive: RunArchive, id: string, value: unknown) {
    const snapshot = object(JSON.parse(JSON.stringify(value))), caseIds: string[] = [];
    for (const task of snapshot.cases ?? []) {
        const key = task.id + '@' + String(task.version ?? 1).replace(/^v/, ''); caseIds.push(key);
        sharedCase(archive, key, 'case', task);
        if (snapshot.gold?.[task.id] !== undefined) sharedCase(archive, key, 'gold', snapshot.gold[task.id]);
        const materials = snapshot.materials?.find((item: any) => item.caseId === task.id);
        if (materials) sharedCase(archive, key, 'materials', materials);
    }
    const fixtureNames = Object.keys(snapshot.fixtures ?? {});
    for (const name of fixtureNames) {
        if (name in archive.fixtures && !isDeepStrictEqual(archive.fixtures[name], snapshot.fixtures[name])) throw Error('Shared scenario differs');
        archive.fixtures[name] = snapshot.fixtures[name];
    }
    if (snapshot.scoring !== undefined) {
        const key = String(snapshot.dataset);
        if (key in archive.scoring && !isDeepStrictEqual(archive.scoring[key], snapshot.scoring)) throw Error('Shared scoring conditions differ');
        archive.scoring[key] = snapshot.scoring;
    }
    let sourceRef: string | undefined;
    if (snapshot.runtimeSource !== undefined) {
        sourceRef = Object.keys(archive.sources).find(key => isDeepStrictEqual(archive.sources[key], snapshot.runtimeSource));
        sourceRef ??= 'Source-' + String(Object.keys(archive.sources).length + 1).padStart(2, '0');
        archive.sources[sourceRef] = snapshot.runtimeSource;
    }
    const { cases: _, gold: __, materials: ___, fixtures: ____, scoring: _____, runtimeSource: ______, ...rest } = snapshot;
    archive.snapshots[id] = { ...rest, caseIds, fixtureNames, ...(snapshot.scoring === undefined ? {} : { scoringRef: String(snapshot.dataset) }),
        ...(sourceRef ? { sourceRef } : {}) };
}
function loadSnapshot(archive: RunArchive, value: unknown) {
    const snapshot = structuredClone(object(value));
    const { caseIds, fixtureNames, scoringRef, sourceRef, ...rest } = snapshot;
    const entries = (caseIds ?? []).map((key: string) => object(archive.caseSnapshots[key]));
    return { ...rest, cases: entries.map((entry: any) => entry.case),
        ...(entries.some((entry: any) => entry.gold !== undefined) ? { gold: Object.fromEntries(entries.map((entry: any) => [entry.case.id, entry.gold])) } : {}),
        materials: entries.flatMap((entry: any) => entry.materials ? [entry.materials] : []),
        ...(fixtureNames?.length ? { fixtures: Object.fromEntries(fixtureNames.map((name: string) => [name, archive.fixtures[name]])) } : {}),
        ...(scoringRef === undefined ? {} : { scoring: archive.scoring[scoringRef] }),
        ...(sourceRef === undefined ? {} : { runtimeSource: archive.sources[sourceRef] }) };
}
export function readArchivePart(reference: string): any {
    const { file, section, id } = part(reference), archive = readArchive(file);
    if (section === 'experiment') {
        if (!archive.experiment) throw Object.assign(Error('Experiment unavailable'), { code: 'ENOENT' });
        return archive.experiment;
    }
    const value = archive[section][id];
    if (value === undefined) throw Object.assign(Error('Run record unavailable: ' + section + '/' + id), { code: 'ENOENT' });
    if (section === 'snapshots') return loadMaterials(archive, file, loadSnapshot(archive, value));
    if (section !== 'executions') return value;
    const report = structuredClone(object(value));
    report.trials = report.trials.map((trial: any) => {
        const { caseConditionsRef, ...rest } = trial;
        return { ...rest, ...(caseConditionsRef ? { caseConditions: archive.caseSnapshots[caseConditionsRef]?.conditions } : {}) };
    });
    report.export = archive.exports[id] ?? { backend: 'local', status: 'disabled' };
    return loadMaterials(archive, file, report);
}
export function writeArchivePart(reference: string, value: unknown, expectedExecution?: LocalReport | null) {
    const { file, section, id } = part(reference);
    updateArchive(file, archive => {
    if (section === 'executions' && expectedExecution !== undefined) {
        const exists = Object.hasOwn(archive.executions, id);
        const facts = ({ export: _, ...report }: LocalReport) => report;
        if (expectedExecution === null ? exists : !exists || !isDeepStrictEqual(facts(readArchivePart(reference)), facts(expectedExecution)))
            throw Error('Stale open report; original execution changed before saving');
    }
    value = storeMaterials(archive, file, value);
    if (section === 'experiment') archive.experiment = value;
    else if (section === 'snapshots') storeSnapshot(archive, id, value);
    else if (section === 'executions') {
        const report = structuredClone(object(value));
        if (report.executionId !== id) throw Error('Foreign execution identity');
        if (!Object.hasOwn(archive.exports, id)) archive.exports[id] = report.export;
        delete report.export;
        report.trials = report.trials.map((trial: any) => {
            const { caseConditions, ...rest } = trial;
            if (caseConditions === undefined) return rest;
            const key = trial.caseId + '@' + trial.caseVersion;
            sharedCase(archive, key, 'conditions', caseConditions);
            return { ...rest, caseConditionsRef: key };
        });
        archive.executions[id] = report;
    } else archive[section][id] = value;
    });
}
export function snapshotReference(reference: string) {
    const parsed = part(reference); return archiveReference(parsed.file, 'snapshots', parsed.id);
}
export function readSnapshot(reference: string) {
    return isArchiveReference(reference) ? readArchivePart(snapshotReference(reference))
        : JSON.parse(readFileSync(join(dirname(reference), 'snapshot.json'), 'utf8'));
}
export function writeExportState(reference: string, value: LocalReport['export']) {
    if (isArchiveReference(reference)) { const parsed = part(reference); writeArchivePart(archiveReference(parsed.file, 'exports', parsed.id), value); }
    else atomicJson(join(dirname(reference), 'export.json'), value);
}
export function listArchives(repo: string) {
    const root = join(repo, 'agent-eval', 'runs'); if (!existsSync(root)) return [];
    if (lstatSync(root).isSymbolicLink()) throw Error('Linked Run collection rejected');
    return readdirSync(root, { withFileTypes: true }).filter(entry => entry.isDirectory() && !entry.isSymbolicLink() && entry.name.startsWith('Run-'))
        .map(entry => join(root, entry.name, 'run.json')).filter(file => existsSync(file));
}
export function findArchive(repo: string, id: string) {
    identity.parse(id);
    const found = listArchives(repo).filter(file => { const value = readArchive(file); return value.id === id || object(value.experiment ?? {}).id === id; });
    if (found.length !== 1) throw Error(found.length ? 'Duplicate Run identity' : 'Unknown Run: ' + id);
    return found[0]!;
}
export function archiveExecutionLocations(repo: string) {
    return listArchives(repo).flatMap(file => Object.keys(readArchive(file).executions).map(executionId => ({ executionId,
        report: archiveReference(file, 'executions', executionId), error: null })));
}
export function archiveLabel(reference: string) { return basename(dirname(archiveFile(reference))); }
