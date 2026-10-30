import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { discoverDatasets, resolveCase, REPO_ROOT } from '../../src/dataset-loader/local.ts';
import { findDataset } from '../../src/execution/plan.ts';
import { inspectCaseDeclaration } from '../../src/dataset-loader/declarations.ts';
import { acquireEvaluationWrite, EvaluationWriteConflict } from '../../src/reports/files.ts';
import { candidateFile, readTraceOperation } from '../../src/curation/store.ts';
import { publishedBenchmarkFile } from '../../src/curation/publication.ts';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const repo = () => { const root = mkdtempSync(join(tmpdir(), 'flowmate-curation-')); roots.push(root); return root; };
const at = '2026-10-28T01:00:00.000Z';
const trace = () => ({ id: randomUUID(), revision: 1, source: { kind: 'product', runId: 'product-run' }, entry: 'chats',
    startedAt: at, endedAt: at, input: { prompt: '  请保留原文。\n', turns: [{ id: 'later', role: 'user', content: '\n第二轮  ' }] },
    output: { answer: '错' }, status: 'FAIL', complete: true, gaps: [], configuration: {}, events: [], facts: {},
    materials: [{ id: 'source', path: 'materials/source/source.md', text: '业务要求：答案必须是正确。' }] });
function candidate(traceId: string, kind = 'regression') {
    return { id: randomUUID(), revision: 1, kind, traceRef: { id: traceId, revision: 1 }, sourceLabels: ['business-contract'], reason: 'Observed wrong answer; independently checked contract.',
        case: { name: 'answer_source_contract', category: 'task', difficulty: 'regression', purpose: 'regression', source: 'regression-bug',
            input: { prompt: '  请保留原文。\n', turns: [{ id: 'later', role: 'user', content: '\n第二轮  ' }] },
            expected: { success: ['回答正确'], failure: ['回答错误'], maxToolCalls: 0, mustHaveEvidence: true, expectedAnswerHint: '正确' },
            scoring: { deterministic: ['fact-check'], judge: [], manual: 'Human approval required.' }, risks: ['Controlled Q&A only.'], tags: ['business'] },
        gold: { values: {}, checks: [{ metric: 'fact-check', required: true, evidence: 'answer', path: ['text'], equals: '正确' }],
            opportunities: { 'task-success': 1 }, sources: ['materials/source/source.md'], basis: 'Independent business contract.' },
        scenario: { requires: ['agent'], materials: [{ source: 'local-text', sample: 'source', file: 'source.md' }],
            steps: [{ id: 'request', action: 'user-message', instruction: '$input' }, { id: 'later', action: 'user-message', turnId: 'later' }],
            selection: { enabledSkills: [], enabledExtensions: [] } },
        bindings: [{ materialId: 'source', quote: '答案必须是正确', label: 'Business contract', target: { kind: 'success', text: '回答正确' } },
            { materialId: 'source', quote: '答案必须是正确', label: 'Independent answer', target: { kind: 'answer', text: '正确' } }],
        controls: { negative: { label: 'Original wrong answer', evidence: { answer: { present: true, actual: { text: '错' }, source: 'Original trace output' } } },
            positive: { label: 'Independent correct answer', evidence: { answer: { present: true, actual: { text: '正确' }, source: 'Business contract' } } } },
        controlBindings: [{ control: 'negative', evidence: 'answer', path: ['text'], source: { kind: 'trace', path: ['output', 'answer'] } },
            { control: 'positive', evidence: 'answer', path: ['text'], source: { kind: 'material', materialId: 'source', quote: '正确' } }] };
}
async function api(root: string, deps?: unknown) {
    const path = '../../src/curation/index.ts';
    const module = await import(path).catch(() => ({}));
    expect(module.createCurationService).toBeFunction();
    return module.createCurationService(root, deps);
}
test('uncreated curation paths retain every component without creating directories', async () => {
    const root = repo(), id = randomUUID();
    const { traceDirectory, candidateDirectory } = await import('../../src/curation/store.ts');
    expect(traceDirectory(root, id)).toBe(join(root, 'agent-eval', 'traces'));
    expect(candidateDirectory(root, 'bad', id)).toBe(join(root, 'agent-eval', 'src', 'datasets', 'bad-candidates'));
    expect(existsSync(join(root, 'agent-eval'))).toBe(false);
});
test('removed badcase IDs cannot run and baseline registration remains exactly 62 cases with 7 smoke', () => {
    expect(() => findDataset(REPO_ROOT, { dataset: 'flowmate-badcase-business-v1' })).toThrow();
    expect(() => findDataset(REPO_ROOT, { dataset: 'flowmate-badcase-research-v1' })).toThrow();
    const datasets = discoverDatasets(join(REPO_ROOT, 'agent-eval/src/datasets'));
    expect(datasets.flatMap(d => d.cases)).toHaveLength(62);
    expect(datasets.flatMap(d => d.manifest.smoke)).toHaveLength(7);
    expect(datasets.flatMap(d => d.cases).find(c => c.id === 'FM-045')).toBeDefined();
    expect(datasets.flatMap(d => d.cases).find(c => c.id === 'FM-051')).toBeDefined();
});
test('saving traces creates no candidate collection and rejects stale revisions and linked paths', async () => {
    const root = repo(), service = await api(root), source = trace();
    expect(service.listTraces()).toEqual([]); service.saveTrace(source);
    expect(service.readTrace(source.id)).toEqual(source);
    expect(existsSync(join(root, 'agent-eval/src/datasets/gold-candidates'))).toBe(false);
    expect(() => service.saveTrace({ ...source, output: 'changed' })).toThrow();
    expect(() => service.readTrace('../escape')).toThrow();
    const outside = repo(); symlinkSync(outside, join(root, 'agent-eval/src'), 'junction');
    expect(() => service.saveCandidate(candidate(source.id))).toThrow();
});
test('candidate edits preserve original Chinese turns and invalidate approval and validation by revision', async () => {
    const root = repo(), service = await api(root), source = trace(); service.saveTrace(source);
    const saved = service.saveCandidate(candidate(source.id));
    expect(saved.case.id).toBeUndefined(); expect(saved.status).toBe('draft');
    expect(readdirSync(join(root, 'agent-eval/src/datasets/regression-candidates'))).toEqual([expect.stringMatching(/^Regression-.*-answer-source-contract-01\.json$/)]);
    const validation = await service.validateCandidate(saved.id, { expectedRevision: 1 });
    expect(validation.status).toBe('PASS'); expect(validation.replay.status).toBe('NOT_RUN');
    expect(validation.controls).toMatchObject({ negative: 'FAIL', positive: 'PASS' });
    const changed = service.editCandidate(saved.id, { expectedRevision: 1, reason: 'Human clarification' });
    expect(changed.revision).toBe(2); expect(changed.case.input).toEqual(source.input);
    expect(changed.validation).toBeUndefined();
    expect(() => service.editCandidate(saved.id, { expectedRevision: 1, reason: 'Lost update' })).toThrow();
    const targeted=service.editCandidate(saved.id,{expectedRevision:2,reviseCase:{id:'FM-063',version:1}});
    expect(targeted.reviseCase).toEqual({id:'FM-063',version:1});
    expect(service.editCandidate(saved.id,{expectedRevision:3,reviseCase:null}).reviseCase).toBeUndefined();
});

test('occupied candidate UUID rejects edits, validation commits and duplicate saves without changing the original', async () => {
    const root = repo(), service = await api(root), source = trace(); service.saveTrace(source);
    const input = candidate(source.id), saved = service.saveCandidate(input);
    const file = candidateFile(root, saved.id);
    const original = readFileSync(file, 'utf8');
    const release = acquireEvaluationWrite(join(root, 'agent-eval/src/datasets', 'candidate-' + saved.id));
    try {
        expect(() => service.editCandidate(saved.id, { expectedRevision: 1, reason: 'Concurrent edit' })).toThrow(EvaluationWriteConflict);
        await expect(service.validateCandidate(saved.id, { expectedRevision: 1 })).rejects.toThrow(EvaluationWriteConflict);
        expect(() => service.saveCandidate(input)).toThrow(EvaluationWriteConflict);
        expect(readFileSync(file, 'utf8')).toBe(original);
    } finally { release(); }
    expect(service.editCandidate(saved.id, { expectedRevision: 1, reason: 'After release' }).revision).toBe(2);
});

test('locking a first candidate does not scaffold any candidate collection', async () => {
    const root = repo(), service = await api(root), source = trace(); service.saveTrace(source);
    const input = candidate(source.id), { acquireCandidateWrite } = await import('../../src/curation/store.ts');
    const release = acquireCandidateWrite(root, input.id);
    try { expect(() => service.saveCandidate(input)).toThrow(EvaluationWriteConflict); }
    finally { release(); }
    for (const kind of ['gold', 'bad', 'regression'])
        expect(existsSync(join(root, 'agent-eval/src/datasets', kind + '-candidates'))).toBe(false);
    service.saveCandidate(input);
    expect(existsSync(candidateFile(root, input.id))).toBe(true);
});

test('an edit during asynchronous replay remains current and cannot be overwritten by its old validation', async () => {
    const root = repo(), source = trace(); let start!: () => void, finish!: () => void;
    const started = new Promise<void>(resolve => { start = resolve; }), finished = new Promise<void>(resolve => { finish = resolve; });
    const service = await api(root, { replay: async () => { start(); await finished;
        return { status: 'FAIL', kind: 'controlled', reason: 'Controlled race-test replay outcome' }; } });
    service.saveTrace(source); const saved = service.saveCandidate(candidate(source.id));
    const pending = service.validateCandidate(saved.id, { expectedRevision: 1, replay: true }); await started;
    let edited;
    try { edited = service.editCandidate(saved.id, { expectedRevision: 1, reason: 'Newer human edit' }); }
    finally { finish(); }
    await expect(pending).rejects.toThrow('changed during validation');
    expect(edited.revision).toBe(2); expect(service.readCandidate(saved.id)).toEqual(edited);
    expect(service.readCandidate(saved.id).validation).toBeUndefined();
});
test('missing independent proof blocks Gold and invalid quotes or unsafe replay steps block validation', async () => {
    const root = repo(), service = await api(root), source = trace(); service.saveTrace(source);
    const input = candidate(source.id, 'gold'); input.bindings = []; delete (input.controls as any).positive;
    const saved = service.saveCandidate(input);
    expect((await service.validateCandidate(saved.id, { expectedRevision: 1 })).status).toBe('BLOCKED');
    const forged = candidate(source.id); forged.bindings[0]!.quote = 'invented quotation';
    const bad = service.saveCandidate(forged);
    expect((await service.validateCandidate(bad.id, { expectedRevision: 1 })).issues.join(' ')).toContain('quote');
    const unsafe = candidate(source.id); (unsafe.scenario.steps as any).push({ id: 'form', action: 'fill-form' });
    expect((await service.validateCandidate(service.saveCandidate(unsafe).id, { expectedRevision: 1 })).issues.join(' ')).toContain('Replay');
});
test('human publication is explicit, idempotent, self-contained, globally numbered and full-only by default', async () => {
    const root = repo(), service = await api(root), source = trace(); service.saveTrace(source);
    const saved = service.saveCandidate(candidate(source.id)); await service.validateCandidate(saved.id, { expectedRevision: 1 });
    const approval = { operationId: randomUUID(), target: { kind: 'candidate-review', id: saved.id, revision: 1 }, reviewer: 'Human', source: 'human',
        verdict: 'approve', note: 'Checked the contract, quote and both controls.' };
    const feedback = service.addFeedback(approval); expect(service.addFeedback(approval)).toEqual(feedback);
    expect(() => service.addFeedback({ ...approval, note: 'Different retry' })).toThrow();
    expect(() => service.addFeedback({ ...approval, target: { kind: 'trace-feedback', id: source.id, revision: 1 } })).toThrow();
    const operationId = randomUUID(), request = { operationId, benchmarkId: 'support-regressions', candidateIds: [saved.id], approvals: [feedback.id] };
    const release = acquireEvaluationWrite(join(root, 'agent-eval/src/datasets', 'candidate-' + saved.id));
    try { expect(() => service.publish(request)).toThrow(EvaluationWriteConflict); }
    finally { release(); }
    expect(service.listPublishedBenchmarks()).toEqual([]);
    const published = service.publish(request); expect(service.publish(request)).toEqual(published);
    expect(published.members[0].caseId).toBe('FM-063'); expect(published.regressionCaseIds).toEqual(['FM-063']);
    const path = publishedBenchmarkFile(root, 'support-regressions', 1);
    expect(JSON.parse(readFileSync(path, 'utf8')).dataset.authored.fixtures).toBeDefined();
    const { loadPublishedBenchmark } = await import('../../src/curation/publication.ts');
    const datasets = loadPublishedBenchmark(root, 'support-regressions', 1);
    expect(datasets[0]!.manifest.smoke).toEqual([]);
    expect(datasets[0]!.cases[0]!.input).toMatchObject(source.input);
    const projection = resolveCase(datasets[0]!, datasets[0]!.cases[0]!, root).projected;
    expect(JSON.stringify(projection)).not.toContain('expectedAnswerHint');
    expect(JSON.stringify(projection)).not.toContain('Independent correct answer');
    const inspected = inspectCaseDeclaration(root, 'support-regressions', 'FM-063');
    expect(inspected.gaps).toEqual([]); expect(inspected.files.some(file => file.path === 'materials/source/source.md')).toBe(true);
    const duplicate = service.saveCandidate(candidate(source.id)); await service.validateCandidate(duplicate.id, { expectedRevision: 1 });
    const duplicateApproval = service.addFeedback({ ...approval, operationId: randomUUID(), target: { ...approval.target, id: duplicate.id } });
    expect(() => service.publish({ ...request, operationId: randomUUID(), candidateIds: [duplicate.id], approvals: [duplicateApproval.id] })).toThrow('reuse');
    const source2 = trace(); source2.input.prompt = '不同的新问题'; service.saveTrace(source2);
    const otherInput = candidate(source2.id); otherInput.case.input.prompt = source2.input.prompt;
    const other = service.saveCandidate(otherInput); await service.validateCandidate(other.id, { expectedRevision: 1 });
    const nextApproval = service.addFeedback({ ...approval, operationId: randomUUID(), target: { ...approval.target, id: other.id } });
    const second = service.publish({ ...request, operationId: randomUUID(), benchmarkId: 'other-benchmark', candidateIds: [other.id], approvals: [nextApproval.id] });
    expect(second.members[0].caseId).toBe('FM-064');
    expect(readFileSync(path, 'utf8')).toContain('请保留原文');
    service.saveTrace({ ...source, revision: 2, materials: [] });
    expect(loadPublishedBenchmark(root, 'support-regressions', 1)[0]!.cases[0]!.id).toBe('FM-063');
    writeFileSync(join(root, 'agent-eval/src/datasets/cases.ts'), '');
    expect(findDataset(root, { dataset: 'support-regressions', version: 1 }).cases[0]!.id).toBe('FM-063');
    const broken = JSON.parse(readFileSync(path, 'utf8')); delete broken.reviews['FM-063']; writeFileSync(path, JSON.stringify(broken));
    expect(() => loadPublishedBenchmark(root, 'support-regressions', 1)).toThrow();
});
test('agent approval and approvals for edited conditions cannot authorize publication', async () => {
    const root = repo(), service = await api(root), source = trace(); service.saveTrace(source);
    const saved = service.saveCandidate(candidate(source.id)); await service.validateCandidate(saved.id, { expectedRevision: 1 });
    const feedback = service.addFeedback({ operationId: randomUUID(), target: { kind: 'candidate-review', id: saved.id, revision: 1 },
        reviewer: 'Model', source: 'agent', verdict: 'approve', note: 'Agent review only' });
    expect(() => service.publish({ operationId: randomUUID(), benchmarkId: 'regressions', candidateIds: [saved.id], approvals: [feedback.id] })).toThrow('human');
});
test('mining records its operation before model invocation and never repeats an unknown response', async () => {
    const root = repo(); let calls = 0; const source = trace();
    const operationId = randomUUID();
    const service = await api(root, { generateJSON: async () => {
        calls++; expect(readTraceOperation(root, source.id, 'mining', operationId)).toMatchObject({ status: 'unknown' });
        throw Error('transport outcome unknown');
    } }); service.saveTrace(source);
    const input = { operationId, traceId: source.id, expectedRevision: 1, kind: 'regression' };
    const first = await service.mine(input); expect(first.status).toBe('unknown'); expect(calls).toBe(1);
    expect(await service.mine(input)).toEqual(first); expect(calls).toBe(1);
    expect(existsSync(join(root, 'agent-eval/src/datasets/regression-candidates'))).toBe(false);
});

test('Regression mining requests independent material controls without requiring a historical successful model run', async () => {
    const root = repo(), source = trace(); let system = '';
    const service = await api(root, { generateJSON: async (request: { system: string }) => {
        system = request.system;
        const { id, revision, kind, traceRef, ...draft } = candidate(source.id); return draft;
    } }); service.saveTrace(source);
    const operation = await service.mine({ operationId: randomUUID(), traceId: source.id, expectedRevision: 1, kind: 'regression' });
    expect(operation.status).toBe('completed');
    expect(system).toContain('Only kind=gold requires an independently supported successful original trace');
    expect(system).toContain('For kind=bad or kind=regression');
    expect(system).toContain('no prior successful model run is required');
    expect(system).toContain('Never use the Agent answer as the sole Gold source');
    const validation = await service.validateCandidate(operation.candidateId, { expectedRevision: 1 });
    expect(validation.status).toBe('PASS'); expect(validation.controls).toEqual({ negative: 'FAIL', positive: 'PASS' });
    expect(validation.replay.status).toBe('NOT_RUN'); expect(service.readTrace(source.id).status).toBe('FAIL');
});

test('control evidence must bind the actual original failure and an independent material value', async () => {
    const root = repo(), service = await api(root), source = trace(); service.saveTrace(source);
    const input = candidate(source.id); input.controls.negative.evidence.answer.actual.text = 'invented wrong result';
    const saved = service.saveCandidate(input), validation = await service.validateCandidate(saved.id, { expectedRevision: 1 });
    expect(validation.status).toBe('BLOCKED'); expect(validation.issues.join(' ')).toContain('control binding');
});

test('publication rejects a stale approval even when the edited revision is validated again', async () => {
    const root = repo(), service = await api(root), source = trace(); service.saveTrace(source);
    const saved = service.saveCandidate(candidate(source.id)); await service.validateCandidate(saved.id, { expectedRevision: 1 });
    const approval = service.addFeedback({ operationId: randomUUID(), target: { kind: 'candidate-review', id: saved.id, revision: 1 },
        reviewer: 'Human', source: 'human', verdict: 'approve', note: 'Checked revision one' });
    const changed = service.editCandidate(saved.id, { expectedRevision: 1, reason: 'New rationale' });
    await service.validateCandidate(saved.id, { expectedRevision: changed.revision });
    expect(() => service.publish({ operationId: randomUUID(), benchmarkId: 'stale-approval', candidateIds: [saved.id], approvals: [approval.id] })).toThrow('human');
});

test('a reused capability Case keeps its original labels while the publication requires it as a regression member', async () => {
    const root = repo(), service = await api(root), successful = trace(); successful.status = 'PASS'; successful.output.answer = '正确'; service.saveTrace(successful);
    const original = candidate(successful.id, 'gold'); original.case.difficulty = 'difficult'; original.case.purpose = 'capability'; original.case.source = 'real-trace';
    delete (original.controls as any).negative;
    original.controlBindings = original.controlBindings.filter(binding => binding.control === 'positive');
    (original.controlBindings as any).push({ control: 'positive', evidence: 'answer', path: ['text'], source: { kind: 'trace', path: ['output', 'answer'] } });
    const first = service.saveCandidate(original); expect((await service.validateCandidate(first.id, { expectedRevision: 1 })).status).toBe('PASS');
    const approve = (id: string) => service.addFeedback({ operationId: randomUUID(), target: { kind: 'candidate-review', id, revision: 1 }, reviewer: 'Human', source: 'human', verdict: 'approve', note: 'Verified source conditions' });
    service.publish({ operationId: randomUUID(), benchmarkId: 'known-capability', candidateIds: [first.id], approvals: [approve(first.id).id] });
    const failed = trace(); service.saveTrace(failed);
    const regression = { ...candidate(failed.id), reuseCaseId: 'FM-063', case: structuredClone(original.case) };
    const saved = service.saveCandidate(regression); expect((await service.validateCandidate(saved.id, { expectedRevision: 1 })).status).toBe('PASS');
    const publication = service.publish({ operationId: randomUUID(), benchmarkId: 'new-regression', candidateIds: [saved.id], approvals: [approve(saved.id).id] });
    expect(publication.members[0]).toMatchObject({ caseId: 'FM-063', reused: true });
    expect(publication.regressionCaseIds).toEqual(['FM-063']);
    expect(service.loadPublishedBenchmark('new-regression', 1)[0].cases[0]).toMatchObject({ difficulty: 'difficult', purpose: 'capability', source: 'real-trace' });
});

test('Benchmark revisions accumulate approved frozen members and preserve existing Smoke without reapproving old candidates',async()=>{
    const root=repo(),service=await api(root),source=trace();service.saveTrace(source);
    const approve=async(value:unknown)=>{
        const saved=service.saveCandidate(value);expect((await service.validateCandidate(saved.id,{expectedRevision:1})).status).toBe('PASS');
        const approval=service.addFeedback({operationId:randomUUID(),target:{kind:'candidate-review',id:saved.id,revision:1},reviewer:'Human',source:'human',verdict:'approve',note:'Verified snapshot'});
        return{saved,approval};
    };
    const first=await approve(candidate(source.id));
    service.publish({operationId:randomUUID(),benchmarkId:'cumulative',candidateIds:[first.saved.id],approvals:[first.approval.id],smokeCaseIds:['FM-063']});
    service.editCandidate(first.saved.id,{expectedRevision:1,reason:'Unapproved later candidate edit'});
    service.saveTrace({...source,revision:2,materials:[]});
    const otherSource=trace();otherSource.input.prompt='A different user goal.';
    otherSource.materials[0]!.path='materials/other/source.md';otherSource.materials[0]!.text+=' A distinct business request.';service.saveTrace(otherSource);
    const other=candidate(otherSource.id);other.case.input.prompt=otherSource.input.prompt;
    other.scenario.materials[0]!.sample='other';other.gold.sources=['materials/other/source.md'];
    const second=await approve(other);
    const publication=service.publish({operationId:randomUUID(),benchmarkId:'cumulative',candidateIds:[second.saved.id],approvals:[second.approval.id]});
    expect(publication.members.map((member:any)=>[member.caseId,member.caseVersion])).toEqual([['FM-063',1],['FM-064',1]]);
    expect(publication.smokeCaseIds).toEqual(['FM-063']);
    expect(service.loadPublishedBenchmark('cumulative',1)[0].cases.map((task:any)=>task.id)).toEqual(['FM-063']);
    const latest=service.loadPublishedBenchmark('cumulative',2)[0];
    expect(latest.cases.map((task:any)=>task.id)).toEqual(['FM-063','FM-064']);expect(latest.manifest.smoke).toEqual(['FM-063']);
});

test('same-scene Gold/assertion correction preserves the ID, increments actual Case/Gold versions, and keeps old revisions runnable',async()=>{
    const root=repo(),service=await api(root),source=trace();service.saveTrace(source);
    const approve=async(value:unknown)=>{
        const saved=service.saveCandidate(value),validation=await service.validateCandidate(saved.id,{expectedRevision:1});
        expect(validation.status).toBe('PASS');
        const approval=service.addFeedback({operationId:randomUUID(),target:{kind:'candidate-review',id:saved.id,revision:1},reviewer:'Human',source:'human',verdict:'approve',note:'Verified Case revision'});
        return{saved,approval};
    };
    const first=await approve(candidate(source.id));
    service.publish({operationId:randomUUID(),benchmarkId:'corrected',candidateIds:[first.saved.id],approvals:[first.approval.id]});
    const changed={...candidate(source.id),reviseCase:{id:'FM-063',version:1}};
    changed.gold.checks[0]!.equals='正';changed.controls.positive.evidence.answer.actual.text='正';
    changed.case.expected.expectedAnswerHint='正';changed.bindings[1]!.target.text='正';
    const corrected=await approve(changed);
    const publication=service.publish({operationId:randomUUID(),benchmarkId:'corrected',candidateIds:[corrected.saved.id],approvals:[corrected.approval.id]});
    expect(publication.members).toHaveLength(1);expect(publication.members[0]).toMatchObject({caseId:'FM-063',caseVersion:2,reused:false});
    const old=service.loadPublishedBenchmark('corrected',1)[0],current=service.loadPublishedBenchmark('corrected',2)[0];
    expect(old.cases[0]).toMatchObject({id:'FM-063',version:1});expect(old.cases[0].expected.checks[0].equals).toBe('正确');
    expect(current.cases[0]).toMatchObject({id:'FM-063',version:2});expect(current.cases[0].expected.checks[0].equals).toBe('正');
    const stored=JSON.parse(readFileSync(publishedBenchmarkFile(root,'corrected',2),'utf8')).dataset;
    expect(stored.tasks['cases/FM-063.json'].version).toBe(2);
    expect(stored.authored.gold['FM-063']).toMatchObject({caseId:'FM-063',version:2});
    const obsolete=service.saveCandidate({...changed,id:randomUUID()});
    expect((await service.validateCandidate(obsolete.id,{expectedRevision:1})).issues.join(' ')).toContain('current');
});

test('revision targets cannot preserve an ID after user input, scenario, material bytes, or original labels change',async()=>{
    const root=repo(),service=await api(root),source=trace();service.saveTrace(source);
    const first=service.saveCandidate(candidate(source.id));await service.validateCandidate(first.id,{expectedRevision:1});
    const approval=service.addFeedback({operationId:randomUUID(),target:{kind:'candidate-review',id:first.id,revision:1},reviewer:'Human',source:'human',verdict:'approve',note:'Verified original'});
    service.publish({operationId:randomUUID(),benchmarkId:'fixed-identity',candidateIds:[first.id],approvals:[approval.id]});
    for(const edit of ['input','scenario','materials','labels']){
        const nextTrace=trace(),next={...candidate(nextTrace.id),reviseCase:{id:'FM-063',version:1}};
        if(edit==='input'){nextTrace.input.prompt='Different question';next.case.input.prompt=nextTrace.input.prompt;}
        if(edit==='scenario')next.scenario.requires.push('history');
        if(edit==='materials')nextTrace.materials[0]!.text+=' New input fact.';
        if(edit==='labels')next.case.category='tools';
        service.saveTrace(nextTrace);const saved=service.saveCandidate(next);
        const validation=await service.validateCandidate(saved.id,{expectedRevision:1});
        expect(validation.status).toBe('BLOCKED');expect(validation.issues.join(' ')).toContain('revision');
    }
    expect(()=>service.saveCandidate({...candidate(source.id),reuseCaseId:'FM-063',reviseCase:{id:'FM-063',version:1}})).toThrow('exclusive');
});

test('concurrent mining requests for one operation call the model at most once and persist the successful candidate', async () => {
    const root = repo(), source = trace(), operationId = randomUUID(); let calls = 0;
    const service = await api(root, { generateJSON: async () => {
        calls++; const { id, revision, kind, traceRef, ...draft } = candidate(source.id); return draft;
    } }); service.saveTrace(source);
    const input = { operationId, traceId: source.id, expectedRevision: 1, kind: 'regression' };
    const [first, second] = await Promise.all([service.mine(input), service.mine(input)]);
    expect(calls).toBe(1); expect(first.status).toBe('completed');
    expect(service.readCandidate(first.candidateId).review.source).toBe('agent');
    expect((await service.mine(input)).candidateId).toBe(first.candidateId);
    expect(['unknown', 'completed']).toContain(second.status);
});

test('a trace changed during asynchronous validation cannot receive a passing revision snapshot', async () => {
    const root = repo(), source = trace(); let service: any;
    service = await api(root, { replay: async () => {
        service.saveTrace({ ...source, revision: 2, output: { answer: 'new output' } });
        return { status: 'PASS', kind: 'controlled', reason: 'Controlled adapter result' };
    } });
    service.saveTrace(source); const saved = service.saveCandidate(candidate(source.id));
    await expect(service.validateCandidate(saved.id, { expectedRevision: 1, replay: true })).rejects.toThrow('changed');
    expect(service.readCandidate(saved.id).validation).toBeUndefined();
});

test('publication cannot shadow baseline IDs or the all selector', async () => {
    const root = repo(), service = await api(root);
    for (const benchmarkId of ['flowmate-agent-v1', 'flowmate-research-v1', 'all', 'baseline'])
        expect(() => service.publish({ operationId: randomUUID(), benchmarkId, candidateIds: [randomUUID()], approvals: [randomUUID()] })).toThrow('reserved');
    expect(existsSync(join(root, 'agent-eval/src/datasets/published'))).toBe(false);
});
test('a reproduced Regression can be published before repair while replay ERROR and NOT_RUN remain blocked', async () => {
    const root = repo(); let status = 'FAIL';
    const failure = { executionId: 'controlled-failure', report: 'saved-original-failure-report.json' };
    const service = await api(root, { replay: async () => ({ status, kind: 'controlled', reason: 'Controlled replay outcome', evidence: failure }) });
    const source = trace(); service.saveTrace(source); const saved = service.saveCandidate(candidate(source.id));
    const validation = await service.validateCandidate(saved.id, { expectedRevision: 1, replay: true });
    expect(validation.status).toBe('PASS'); expect(validation.replay).toMatchObject({ status: 'FAIL', evidence: failure });
    expect(validation.controls).toEqual({ negative: 'FAIL', positive: 'PASS' });
    const approval = service.addFeedback({ operationId: randomUUID(), target: { kind: 'candidate-review', id: saved.id, revision: 1 },
        reviewer: 'Human', source: 'human', verdict: 'approve', note: 'Valid reproducer; the implementation is still failing.' });
    const publication = service.publish({ operationId: randomUUID(), benchmarkId: 'unfixed-regression', candidateIds: [saved.id], approvals: [approval.id] });
    expect(publication.regressionCaseIds).toEqual(['FM-063']); expect(service.readTrace(source.id)).toEqual(source);
    for (status of ['ERROR', 'NOT_RUN']) expect((await service.validateCandidate(saved.id, { expectedRevision: 1, replay: true })).status).toBe('BLOCKED');
    status = 'FAIL'; const bad = service.saveCandidate(candidate(source.id, 'bad'));
    expect((await service.validateCandidate(bad.id, { expectedRevision: 1, replay: true })).status).toBe('BLOCKED');
});
