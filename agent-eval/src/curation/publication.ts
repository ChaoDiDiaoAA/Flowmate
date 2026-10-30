import { existsSync, lstatSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, extname, join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { atomicJson, acquireEvaluationWrite } from '../reports/files.ts';
import { inside, loadDataset, type LocalDataset } from '../dataset-loader/local.ts';
import { decodeFile, fileSchema, type EmbeddedFile, type FlatDataset } from '../dataset-loader/flat.ts';
import { TraceBundleSchema, type TraceBundle } from '../../../packages/contracts/src/evaluation-loop.ts';
import { readDeclarationSource, readDeclarationDatasets } from '../dataset-loader/declarations.ts';
import { listFeedback } from './feedback.ts';
import { expandCandidate, traceFiles } from './expansion.ts';
import { candidateConditions, datasetParts, directory, json, readCandidate, readTrace, acquireCandidateWrite } from './store.ts';
import { candidateSchema, feedbackSchema, validationSchema, publicationSchema, publishRequestSchema, scenarioSchema, type Candidate, type Publication } from './schemas.ts';
import { readableTimestamp } from '../reports/archive.ts';

function combineFlat(combined: FlatDataset | undefined, next: FlatDataset): FlatDataset {
    if (!combined) return next;
    for (const [path, file] of Object.entries(next.files)) {
        if (combined.files[path] && !decodeFile(combined.files[path]).bytes.equals(decodeFile(file).bytes)) throw Error('Conflicting published material path');
        combined.files[path] = file;
    }
    Object.assign(combined.tasks, next.tasks); Object.assign(combined.inputs, next.inputs); Object.assign(combined.reviews, next.reviews);
    combined.manifest.members.push(...next.manifest.members); combined.manifest.smoke.push(...next.manifest.smoke);
    combined.manifest.scoring.judges[0].requiredFor.push(...next.manifest.scoring.judges[0].requiredFor);
    combined.manifest.environment.risks = [...new Set([...combined.manifest.environment.risks, ...next.manifest.environment.risks])];
    combined.authored!.cases.push(...next.authored!.cases); Object.assign(combined.authored!.gold, next.authored!.gold);
    Object.assign(combined.authored!.reviews, next.authored!.reviews); Object.assign(combined.authored!.fixtures, next.authored!.fixtures);
    return combined;
}

const materialBodies = (files: EmbeddedFile[]) => Object.fromEntries(files.map(file => [file.path, decodeFile(file).bytes.toString('base64')]));
export type CaseSnapshot = { case: NonNullable<Candidate['case']>; version: number; gold: unknown; scenario: unknown; materials: () => Record<string, string>;
    publicOnly?: true; goldFiles?: () => EmbeddedFile[] };
type Member = Publication['members'][number];
const reviewSchema = z.object({ author: z.unknown(), humanApproval: feedbackSchema.omit({ conditions: true }),
    validation: validationSchema.omit({ conditions: true }).extend({ replay: validationSchema.shape.replay.omit({ evidence: true }) }),
    candidate: candidateSchema.pick({ id: true, revision: true, kind: true, traceRef: true, reason: true, sourceLabels: true, bindings: true, reuseCaseId: true, reviseCase: true }),
    originalCaseId: z.string().optional(), originalFixture: z.object({ name: z.string() }).strict().optional(),
    sourceMaterials: z.array(z.object({ id: z.string().min(1), path: z.string().min(1) }).strict()),
    controllerGoldPaths: z.array(z.string().min(1)),
    conditions: z.object({ caseId: z.string(), caseVersion: z.number().int().positive(), candidateId: z.string().uuid(), candidateRevision: z.number().int().positive(),
        sourceMaterialPaths: z.array(z.string()), controllerGoldPaths: z.array(z.string()) }).strict() }).strict();
type PublishedReview = z.infer<typeof reviewSchema>;
const externalFileSchema = fileSchema.omit({ content: true }).extend({ file: z.string().regex(/^materials\/Material-\d+\.(pdf|png|jpg|jpeg|gif|webp|zip|xlsx|docx|bin)$/) });
type StoredDataset = Omit<FlatDataset, 'inputs' | 'files'> & { inputs: Record<string, string[]>; files: Record<string, EmbeddedFile | z.infer<typeof externalFileSchema>> };
const bundleSchema = publicationSchema.extend({ dataset: z.custom<StoredDataset>(value => !!value && typeof value === 'object'), reviews: z.record(reviewSchema) });
function storeDataset(dataset: FlatDataset): StoredDataset {
    return { ...dataset, inputs: Object.fromEntries(Object.entries(dataset.inputs).map(([id, files]) => [id, files.map(file => file.path)])) };
}
function storeBinaryMaterials(root: string, dataset: FlatDataset): StoredDataset {
    const stored = storeDataset(dataset), files: StoredDataset['files'] = { ...dataset.files }, binaries: Array<{ file: string; bytes: Buffer }> = [];
    for (const [path, value] of Object.entries(dataset.files)) {
        if (!/\.(pdf|png|jpg|jpeg|gif|webp|zip|xlsx|docx|bin)$/i.test(path)) continue;
        const { file, bytes } = decodeFile(value), previous = binaries.find(material => material.bytes.equals(bytes));
        const reference = previous?.file ?? 'materials/Material-' + String(binaries.length + 1).padStart(3, '0') + extname(path).toLowerCase();
        if (!previous) {
            directory(root, ['materials'], true);
            const target = join(root, reference);
            if (lstatSync(target, { throwIfNoEntry: false })) {
                if (!readFileSync(inside(root, reference)).equals(bytes)) throw Error('Published binary material conditions differ');
            } else writeFileSync(target, bytes, { flag: 'wx', mode: 0o600 });
            binaries.push({ file: reference, bytes });
        }
        const { content, ...metadata } = file; files[path] = { ...metadata, file: reference };
    }
    return { ...stored, files };
}
function hydrateDataset(dataset: StoredDataset, root: string): FlatDataset {
    const files = Object.fromEntries(Object.entries(dataset.files).map(([path, value]) => {
        if (!('file' in value)) return [path, decodeFile(value).file];
        const { file, ...metadata } = externalFileSchema.parse(value), bytes = readFileSync(inside(root, file));
        return [path, decodeFile({ ...metadata, content: bytes.toString(metadata.encoding === 'utf8' ? 'utf8' : 'base64') }).file];
    }));
    return { ...dataset, files, inputs: Object.fromEntries(Object.entries(dataset.inputs).map(([id, paths]) => [id,
        z.array(z.string()).parse(paths).map(path => decodeFile(files[path]).file)])) };
}
function memberConditions(member: Member, sourceMaterials: PublishedReview['sourceMaterials'], controllerGoldPaths: string[]) {
    return { caseId: member.caseId, caseVersion: member.caseVersion, candidateId: member.candidateId, candidateRevision: member.candidateRevision,
        sourceMaterialPaths: sourceMaterials.map(item => item.path), controllerGoldPaths };
}
export function publishedBenchmarkFile(repo: string, id: string, revision: number) {
    publishRequestSchema.shape.benchmarkId.parse(id);
    const base = directory(repo, [...datasetParts, 'published', 'Benchmark-' + id]);
    const versions = existsSync(base) ? readdirSync(base).filter(name => new RegExp('^Version-' + String(revision).padStart(3, '0') + '-\\d{4}-\\d{2}-\\d{2}$').test(name)) : [];
    if (versions.length !== 1) throw Error(versions.length ? 'Duplicate published revision' : 'Unknown published revision');
    return join(directory(repo, [...datasetParts, 'published', 'Benchmark-' + id, versions[0]!]), 'benchmark.json');
}
function readMember(repo: string, publication: Publication, member: Member, bundle = bundleSchema.parse(json(publishedBenchmarkFile(repo, publication.id, publication.revision)))) {
    const root = dirname(publishedBenchmarkFile(repo, publication.id, publication.revision));
    const review = reviewSchema.parse(bundle.reviews[member.caseId]), flat = hydrateDataset(bundle.dataset, root), authored = flat.authored;
    if (!authored) throw Error('Published authored conditions are unavailable');
    const task = structuredClone(authored.cases.find(task => task.id === member.caseId));
    if (!task) throw Error('Published Case conditions are unavailable');
    const scenario = authored.fixtures[task.input.fixture?.name], { fixture, ...input } = task.input;
    task.input = { ...input, ...(review.originalFixture ? { fixture: review.originalFixture } : {}) }; if (!review.originalCaseId) delete task.id;
    const { caseId, version, ...gold } = authored.gold[member.caseId] ?? {};
    if (caseId !== member.caseId || version !== member.caseVersion) throw Error('Published Gold conditions differ');
    const candidate = candidateSchema.parse({ ...review.candidate, case: task, gold, scenario, review: review.author ?? undefined });
    if (candidate.id !== member.candidateId || candidate.revision !== member.candidateRevision || candidate.kind !== member.kind ||
        !isDeepStrictEqual(candidate.traceRef, member.traceRef)) throw Error('Published candidate identity differs');
    const trace: TraceBundle = { id: member.traceRef.id, revision: member.traceRef.revision, source: { kind: 'evaluation' }, entry: 'evaluation',
        startedAt: publication.at, endedAt: publication.at, input: candidate.case!.input, output: null, status: 'NOT_RUN', complete: false,
        gaps: ['Published material projection; original execution remains at its provenance reference.'], configuration: {}, events: [], facts: {},
        materials: review.sourceMaterials.map(source => { const file = decodeFile(flat.files[source.path]).file;
            return { id: source.id, path: file.path, encoding: file.encoding, content: file.content }; }) };
    const goldFiles = review.controllerGoldPaths.map(path => decodeFile(flat.files[path]).file);
    const conditions = memberConditions(member, review.sourceMaterials, review.controllerGoldPaths);
    if (review.humanApproval.id !== member.approvalId || review.humanApproval.source !== 'human' || review.humanApproval.verdict !== 'approve' ||
        review.humanApproval.target.id !== candidate.id || review.humanApproval.target.kind !== 'candidate-review' || review.humanApproval.target.revision !== candidate.revision ||
        review.validation.status !== 'PASS' || review.validation.revision !== candidate.revision || !isDeepStrictEqual(review.conditions, conditions))
        throw Error('Published human approval or validation conditions differ');
    for (const binding of candidate.bindings) {
        const material = trace.materials.find(material => material.id === binding.materialId), text = material?.content === undefined ? undefined : Buffer.from(material.content, material.encoding ?? 'utf8').toString('utf8');
        if (!text?.includes(binding.quote)) throw Error('Published source binding conditions differ');
    }
    const original = listFeedback(repo, review.humanApproval.target).find(record => record.id === member.approvalId);
    if (original) {
        const source = z.record(z.unknown()).parse(original.conditions), originalTrace = TraceBundleSchema.parse(source.trace);
        for (const key of ['case', 'gold', 'scenario', 'sourceLabels', 'bindings', 'reuseCaseId', 'reviseCase'] as const)
            if (!isDeepStrictEqual(source[key], candidate[key])) throw Error('Published source conditions differ: ' + key);
        if (!isDeepStrictEqual(materialBodies(Object.values(traceFiles(originalTrace))), materialBodies(Object.values(traceFiles(trace)))) ||
            !isDeepStrictEqual(materialBodies(z.array(z.unknown()).parse(source.controllerGoldFiles).map(file => decodeFile(file).file)), materialBodies(goldFiles)))
            throw Error('Published material conditions differ from original approval');
    }
    const formalCase: CaseSnapshot = { case: { ...candidate.case!, id: member.caseId }, version: member.caseVersion, gold: candidate.gold,
        scenario: candidate.scenario, materials: () => materialBodies(Object.values(traceFiles(trace))) };
    const expanded = expandCandidate(repo, candidate, trace, member.caseId, publication.id, publication.revision, root,
        publication.smokeCaseIds.includes(member.caseId), member.caseVersion, goldFiles, formalCase);
    const expected = JSON.parse(JSON.stringify(expanded.embedded!)) as FlatDataset;
    if (!isDeepStrictEqual(expected.tasks[`cases/${member.caseId}.json`], flat.tasks[`cases/${member.caseId}.json`]) ||
        !isDeepStrictEqual(expected.inputs[member.caseId]!.map(file => file.path), flat.inputs[member.caseId]?.map(file => file.path)) ||
        !isDeepStrictEqual(expected.reviews[member.caseId], flat.reviews[member.caseId]))
        throw Error('Published runtime conditions differ from approved authored conditions');
    for (const [path, file] of Object.entries(expected.files)) if (!isDeepStrictEqual(file, decodeFile(flat.files[path]).file)) throw Error('Published material conditions differ');
    return { candidate, trace, review, expanded, goldFiles, formalCase };
}
export function existingCaseSnapshots(repo: string): CaseSnapshot[] {
    const snapshots: CaseSnapshot[] = [];
    const base = join(repo, ...datasetParts);
    if (existsSync(join(base, 'cases.ts'))) {
        const source = readDeclarationSource(base, repo); let expanded: FlatDataset[] | undefined;
        for (const task of source.dataset.cases) snapshots.push({ case: task, version: 1, gold: source.gold[task.id], publicOnly: true,
            scenario: source.scenariosByName[task.input.fixture?.name ?? ''] ?? { requires: ['agent'], materials: [],
                steps: [{ id: 'request', action: 'user-message', instruction: '$input' }], selection: { enabledSkills: [], enabledExtensions: [] } }, materials: () => {
                expanded ??= readDeclarationDatasets(base, repo);
                const flat = expanded.find(group => group.tasks[`cases/${task.id}.json`])!;
                return materialBodies(flat.inputs[task.id] ?? []);
            }, goldFiles: () => {
                expanded ??= readDeclarationDatasets(base, repo);
                const flat = expanded.find(group => group.tasks[`cases/${task.id}.json`])!;
                return source.gold[task.id].sources.map((path: string) => flat.files[path]!);
            } });
    }
    for (const publication of listPublishedBenchmarks(repo)) for (const member of publication.members) {
        const { candidate, trace, goldFiles } = readMember(repo, publication, member);
        snapshots.push({ case: { ...candidate.case!, id: member.caseId }, version: member.caseVersion, gold: candidate.gold,
            scenario: candidate.scenario, materials: () => materialBodies(Object.values(traceFiles(trace))), goldFiles: () => goldFiles });
    }
    return snapshots;
}
function sameMaterials(snapshot: CaseSnapshot, trace: TraceBundle): boolean {
    const actual = materialBodies(Object.values(traceFiles(trace))), expected = snapshot.materials();
    if (!snapshot.publicOnly) return isDeepStrictEqual(actual, expected);
    const scenario = scenarioSchema.parse(snapshot.scenario), samples = new Set(scenario.materials.filter(ref => ref.source === 'voxel51').map(ref => ref.sample));
    const canonical = (path: string) => {
        const match = path.match(/^invoice-input\/(\d{6})\/(content\.json|pages\.json|metadata\.json|original\.(?:jpg|png))$/);
        return match && samples.has(match[1]!) ? 'voxel51/' + match[1] + '/' + match[2] : path;
    };
    const wanted: Record<string, string> = {}, observed: Record<string, string> = {};
    for (const [path, content] of Object.entries(expected)) {
        const key = canonical(path); if (wanted[key] !== undefined && wanted[key] !== content) return false; wanted[key] = content;
    }
    for (const [path, content] of Object.entries(actual)) {
        const mirror = path.match(/^materials\/(\d{6})\/(content|pages)\.json$/);
        const key = mirror && samples.has(mirror[1]!) ? 'voxel51/' + mirror[1] + '/' + mirror[2] + '.json' : canonical(path);
        if (wanted[key] === undefined) {
            if ((snapshot.gold as Candidate['gold'])?.sources.includes(path)) continue;
            return false;
        }
        if (content !== wanted[key] || observed[key] !== undefined && observed[key] !== content) return false;
        observed[key] = content;
    }
    return isDeepStrictEqual(observed, wanted);
}
export function sameCaseConditions(candidate: Candidate, snapshot: CaseSnapshot, trace: TraceBundle) {
    const conditions = (task: Candidate['case'], gold: unknown, scenario: unknown) => JSON.parse(JSON.stringify({
        input: task ? { prompt: task.input.prompt, turns: task.input.turns } : null, expected: task?.expected,
        scoring: task ? { deterministic: task.scoring.deterministic, judge: task.scoring.judge } : null, gold, scenario }));
    return isDeepStrictEqual(conditions(candidate.case, candidate.gold, candidate.scenario), conditions(snapshot.case, snapshot.gold, snapshot.scenario)) &&
        sameMaterials(snapshot, trace);
}

/** Targets are resolved from saved original snapshots, never from an edited candidate or live Trace. */
export function resolveCandidateCase(repo: string, candidate: Candidate, trace: TraceBundle, snapshots = existingCaseSnapshots(repo)):
    { caseId: string | undefined; caseVersion: number; goldFiles?: EmbeddedFile[]; formalCase?: CaseSnapshot } {
    if (candidate.reuseCaseId && candidate.reviseCase) throw Error('reuseCaseId and reviseCase are mutually exclusive');
    if (candidate.reuseCaseId) {
        const matching = snapshots.filter(snapshot => snapshot.case.id === candidate.reuseCaseId &&
            isDeepStrictEqual({ ...candidate.case, id: snapshot.case.id }, snapshot.case) && sameCaseConditions(candidate, snapshot, trace))
            .sort((a, b) => b.version - a.version)[0];
        if (!matching) throw Error('Reused Case conditions must match the existing Case, Gold, labels, scenario and materials');
        return { caseId: candidate.reuseCaseId, caseVersion: matching.version, formalCase: matching, ...(matching.goldFiles ? { goldFiles: matching.goldFiles() } : {}) };
    }
    if (candidate.reviseCase) {
        const target = snapshots.filter(snapshot => snapshot.case.id === candidate.reviseCase!.id).sort((a, b) => b.version - a.version)[0];
        if (!target || target.version !== candidate.reviseCase.version) throw Error('Case revision target is not the current published version');
        const fixed = (task: Candidate['case']) => {
            if (!task) return null; const { id, expected, scoring, ...identity } = task; return identity;
        };
        if (!isDeepStrictEqual(fixed(candidate.case), fixed(target.case)) || !isDeepStrictEqual(candidate.scenario, target.scenario) ||
            !sameMaterials(target, trace))
            throw Error('Case revision requires identical original input, scenario, labels and material bytes; changed goals require a new Case ID');
        if (sameCaseConditions(candidate, target, trace)) throw Error('Unchanged Case revision must use reuseCaseId');
        return { caseId: candidate.reviseCase.id, caseVersion: target.version + 1, ...(target.goldFiles ? { goldFiles: target.goldFiles() } : {}) };
    }
    return { caseId: undefined, caseVersion: 1 };
}

export function listPublishedBenchmarks(repo: string): Publication[] {
    const root = directory(repo, [...datasetParts, 'published']); if (!existsSync(root)) return [];
    const publications: Publication[] = [];
    for (const benchmark of readdirSync(root, { withFileTypes: true })) {
        if (!benchmark.isDirectory() || !benchmark.name.startsWith('Benchmark-')) continue;
        const base = directory(repo, [...datasetParts, 'published', benchmark.name]);
        for (const version of readdirSync(base, { withFileTypes: true })) {
            if (!version.isDirectory() || !/^Version-\d{3,}-\d{4}-\d{2}-\d{2}$/.test(version.name)) continue;
            const path = directory(repo, [...datasetParts, 'published', benchmark.name, version.name]);
            if (!existsSync(join(path, 'benchmark.json'))) continue;
            const { dataset, reviews, ...metadata } = bundleSchema.parse(json(join(path, 'benchmark.json'))), manifest = publicationSchema.parse(metadata);
            if ('Benchmark-' + manifest.id !== benchmark.name || !version.name.startsWith('Version-' + String(manifest.revision).padStart(3, '0') + '-')) throw Error('Published manifest identity differs');
            publications.push(manifest);
        }
    }
    return publications.sort((a, b) => a.id.localeCompare(b.id) || a.revision - b.revision);
}
export function loadPublishedBenchmark(repo: string, id: string, revision?: number): LocalDataset[] {
    const choices = listPublishedBenchmarks(repo).filter(value => value.id === id && (revision === undefined || value.revision === revision));
    const publication = choices.at(-1); if (!publication) return [];
    const file = publishedBenchmarkFile(repo, publication.id, publication.revision), root = dirname(file), bundle = bundleSchema.parse(json(file));
    let combined: FlatDataset | undefined;
    for (const member of publication.members) combined = combineFlat(combined, readMember(repo, publication, member, bundle).expanded.embedded!);
    if (!isDeepStrictEqual(JSON.parse(JSON.stringify(storeDataset(combined!))), storeDataset(hydrateDataset(bundle.dataset, root))) ||
        !isDeepStrictEqual(Object.keys(bundle.reviews).sort(), publication.members.map(member => member.caseId).sort()))
        throw Error('Published dataset conditions differ from approved members');
    const dataset = loadDataset(root, repo, combined);
    dataset.published = { benchmarkId: publication.id, revision: publication.revision, regressionCaseIds: publication.regressionCaseIds };
    return [dataset];
}
export function publish(repo: string, value: unknown): Publication {
    const request = publishRequestSchema.parse(value), publishedRoot = directory(repo, [...datasetParts, 'published'], true);
    const release = acquireEvaluationWrite(join(publishedRoot, 'publication')), candidateReleases: Array<() => void> = [];
    try {
        const publications = listPublishedBenchmarks(repo), prior = publications.find(item => item.operationId === request.operationId);
        if (prior) {
            if (!isDeepStrictEqual(prior.request, request)) throw Error('Publication operation differs from its original request'); return prior;
        }
        for (const id of [...new Set(request.candidateIds)].sort()) candidateReleases.push(acquireCandidateWrite(repo, id));
        const existing = existingCaseSnapshots(repo), previous = publications.filter(item => item.id === request.benchmarkId).at(-1);
        const selected = request.candidateIds.map(id => {
            const candidate = readCandidate(repo, id), trace = readTrace(repo, candidate.traceRef.id), target = resolveCandidateCase(repo, candidate, trace, existing);
            const conditions = candidateConditions(repo, candidate, trace, target.goldFiles ?? []);
            if (candidate.validation?.status !== 'PASS' || candidate.validation.revision !== candidate.revision || !isDeepStrictEqual(candidate.validation.conditions, conditions))
                throw Error('Current candidate revision must be validated');
            const approval = listFeedback(repo, { kind: 'candidate-review', id, revision: candidate.revision }).find(item => request.approvals.includes(item.id) &&
                item.target.revision === candidate.revision && item.verdict === 'approve' && item.source === 'human' && isDeepStrictEqual(item.conditions, conditions));
            if (!approval) throw Error('Current human approval is required');
            const covered = existing.find(snapshot => sameCaseConditions(candidate, snapshot, trace));
            if (!candidate.reuseCaseId && !candidate.reviseCase && covered) throw Error('Existing Case covers these conditions; edit reuseCaseId to ' + covered.case.id);
            return { candidate, approval, trace, target };
        });
        let nextId = Math.max(62, ...publications.flatMap(item => item.members.map(member => Number(member.caseId.slice(3))))) + 1;
        const revision = (previous?.revision ?? 0) + 1;
        const at = new Date().toISOString(), parts = [...datasetParts, 'published', 'Benchmark-' + request.benchmarkId,
            'Version-' + String(revision).padStart(3, '0') + '-' + readableTimestamp(new Date(at)).slice(0, 10)];
        const additions = selected.map(({ candidate, approval, trace, target }) => {
            const caseId = target.caseId ?? 'FM-' + String(nextId++).padStart(3, '0');
            if (!/^FM-\d{3}$/.test(caseId)) throw Error('Case identity space exhausted');
            const old = previous?.members.find(member => member.caseId === caseId);
            if (old && target.caseVersion !== old.caseVersion && !candidate.reviseCase) throw Error('Replacing a published Case version requires an explicit current revision target');
            return { member: { caseId, caseVersion: target.caseVersion, candidateId: candidate.id, candidateRevision: candidate.revision, approvalId: approval.id,
                kind: candidate.kind, traceRef: candidate.traceRef, reused: !!candidate.reuseCaseId }, candidate, trace, goldFiles: target.goldFiles, formalCase: target.formalCase,
                review: { author: candidate.review ?? null, humanApproval: approval, validation: candidate.validation! } };
        });
        if (new Set(additions.map(item => item.member.caseId)).size !== additions.length) throw Error('Duplicate published Case membership');
        const retained = (previous?.members ?? []).filter(member => !additions.some(item => item.member.caseId === member.caseId))
            .map(member => ({ member, ...readMember(repo, previous!, member) }));
        const rows = [...retained, ...additions].sort((a, b) => a.member.caseId.localeCompare(b.member.caseId));
        const members = rows.map(row => row.member), smokeCaseIds = [...new Set([...(previous?.smokeCaseIds ?? []), ...request.smokeCaseIds])];
        if (smokeCaseIds.some(id => !members.some(member => member.caseId === id))) throw Error('Unknown published smoke member');
        let combined: FlatDataset | undefined; const reviews: Record<string, PublishedReview> = {};
        for (const { member, candidate, trace, review, goldFiles, formalCase } of rows) {
            const expanded = expandCandidate(repo, candidate, trace, member.caseId, request.benchmarkId, revision, publishedRoot,
                smokeCaseIds.includes(member.caseId), member.caseVersion, goldFiles, formalCase);
            combined = combineFlat(combined, expanded.embedded!);
            const sourceMaterials = trace.materials.filter(material => material.path && (material.text !== undefined || material.content !== undefined))
                .map(material => ({ id: material.id, path: material.path! }));
            const controllerGoldPaths = (goldFiles ?? []).map(file => file.path);
            const { conditions: approvalConditions, ...humanApproval } = { conditions: undefined, ...review.humanApproval };
            const { conditions: validationConditions, replay, ...validation } = { conditions: undefined, ...review.validation };
            const { evidence: replayEvidence, ...replayReceipt } = { evidence: undefined, ...replay };
            reviews[member.caseId] = reviewSchema.parse({ author: review.author, humanApproval, validation: { ...validation, replay: replayReceipt },
                candidate: { id: candidate.id, revision: candidate.revision, kind: candidate.kind, traceRef: candidate.traceRef, reason: candidate.reason,
                    sourceLabels: candidate.sourceLabels, bindings: candidate.bindings, reuseCaseId: candidate.reuseCaseId, reviseCase: candidate.reviseCase },
                originalCaseId: candidate.case!.id, originalFixture: candidate.case!.input.fixture, sourceMaterials, controllerGoldPaths, conditions: memberConditions(member, sourceMaterials, controllerGoldPaths) });
        }
        loadDataset(publishedRoot, repo, combined);
        const publication = publicationSchema.parse({ contract: 'flowmate-published-benchmark/v1', id: request.benchmarkId, revision,
            operationId: request.operationId, at, request, members,
            regressionCaseIds: members.filter(member => member.kind === 'regression').map(member => member.caseId), smokeCaseIds });
        for (const { candidate, trace } of selected)
            if (!isDeepStrictEqual(candidateConditions(repo, candidate, trace), candidate.validation!.conditions))
                throw Error('Candidate controller sources changed during publication');
        const root = directory(repo, parts, true);
        atomicJson(join(root, 'benchmark.json'), bundleSchema.parse({ ...publication, dataset: storeBinaryMaterials(root, combined!), reviews })); return publication;
    } finally {
        try { for (const releaseCandidate of candidateReleases.reverse()) releaseCandidate(); }
        finally { release(); }
    }
}
