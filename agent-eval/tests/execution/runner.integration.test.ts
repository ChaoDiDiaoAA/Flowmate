import { judgeResponse, namedJudgment } from '../support/judge-response.ts';
import { mkdtempSync } from '../../../tests/support/resources.ts';
import { test, expect } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { existsSync,mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dataset, observed, task } from '../support/fixtures.ts';
import { runLocal } from '../../src/execution/runner.ts';
import { fixtureRepo as REPO_ROOT } from '../support/fixtures.ts';
import type { AgentKernel, AgentTrial } from '../../src/adapters/agent.ts';
import { executeCase } from '../../src/execution/execute-case.ts';
import { caseV2Schema, manifestSchema } from '../../src/dataset-loader/schema.ts';
import { metricCatalog } from '../../src/scoring/catalog.ts';
import { readReport, readReportMetadata } from '../../src/reports/store.ts';
import { archiveFile, readSnapshot } from '../../src/reports/archive.ts';
import { formalFixture } from '../support/formal.ts';
import { compileFormalSemanticPlan } from '../../src/scoring/formal-rules.ts';
import type { EvaluationProgress } from '../../src/execution/runner.ts';
function kernel(transform?: (r: ReturnType<typeof observed>) => void): AgentKernel {
    return { readiness: () => ({ ready: true, reason: 'test-only' }), async prepare(trial) {
            expect(trial).not.toHaveProperty('expected');
            expect(trial.input).not.toHaveProperty('steps');
            const result = observed();
            result.identity = trial.identity;
            result.input = trial.input;
            result.evidence.environment!.actual = { ...trial.identity, fresh: true };
            result.evidence['input-projection']!.actual = trial.input;
            transform?.(result);
            return { input: trial.input, async execute() { return result; }, async snapshot() { return result; }, async cancel() { }, async close() { return { present: true, actual: { closed: true, stopped: true }, source: 'test-session' }; } };
        } };
}

test('source drift preserves original scores, records changed paths and announces final invalidation once',async()=>{
    const path='packages/core/src/drift-'+randomUUID()+'.ts',file=join(REPO_ROOT,path);
    mkdirSync(join(file,'..'),{recursive:true});writeFileSync(file,'before');
    const events:EvaluationProgress[]=[];
    try{
        const data=structuredClone(dataset);data.cases=[data.cases[0]!];data.manifest.members=['cases/'+data.cases[0]!.id+'.json'];
        const run=await runLocal(REPO_ROOT,{dataset:data,backend:'local',judge:'off',executionId:'drift-'+randomUUID()},
            {env:{},kernel:kernel(()=>writeFileSync(file,'after')),onProgress:e=>events.push(e)});
        expect(run.report.executionComplete).toBe(false);
        expect(run.report.sourceInvalidation).toMatchObject({paths:[path]});
        expect(run.report.trials[0]!.status).toBe('ERROR');
        expect(run.report.trials[0]!.scores.some(s=>s.status==='PASS')).toBe(true);
        expect(events.filter(e=>e.type==='source-invalidated')).toHaveLength(1);
        expect(events.at(-1)).toMatchObject({type:'dataset-end',counts:{ERROR:1}});
        expect(readReport(run.file).sourceInvalidation).toEqual(run.report.sourceInvalidation);
        expect(readFileSync(archiveFile(run.file),'utf8')).not.toContain('workspaceHash');
    }finally{unlinkSync(file);}
},30000);

function semanticDataset() {
    const criteria = [
        { metricId: 'tool-selection', version: 1, unit: '决策点', denominator: 3, required: true, rule: 'Count three decisions.', evidence: ['task-facts'], trigger: 'started' },
        { metricId: 'tool-arguments', version: 1, unit: '请求', denominator: 4, required: true, rule: 'Count four requests.', evidence: ['task-facts'], trigger: 'completed-endpoint' }
    ];
    const item = caseV2Schema.parse({ ...structuredClone(task), contract: 'flowmate-agent-case/v2',
        input: { prompt: 'Execute the synthetic controlled protocol.', materials: [] }, expected: {
        success: ['Synthetic controlled task saved'], failure: ['Invent the save'],
        checks: [{ metric: 'fact-check', required: true, evidence: 'task-facts', path: ['saved'], equals: true }],
        semantic: { contract: 'flowmate-semantic-plan/v1', criteria }, metrics: metricCatalog.map(m => m.id === 'task-success'
            ? { metricId: m.id, version: m.version, unit: m.unit, denominator: 1 }
            : criteria.some(c => c.metricId === m.id) ? { metricId: m.id, version: m.version, unit: m.unit, denominator: criteria.find(c => c.metricId === m.id)!.denominator }
                : { metricId: m.id, version: m.version, unit: m.unit, notApplicable: 'Synthetic orchestration fixture only.' }) } });
    const data = { ...structuredClone(dataset), manifest: manifestSchema.parse({ ...dataset.manifest, contract: 'flowmate-agent-dataset/v2',
        members: ['cases/' + item.id + '.json'], smoke: [item.id], environment: { profile: 'isolated-agent/v2', source: 'voxel51', risks: ['synthetic'] },
        scoring: { ...dataset.manifest.scoring, judges: [{ id: 'semantic-batch', required: true }] } }), cases: [item] };

    return data;
}

function deterministicDataset() {
    const data = semanticDataset(), item = data.cases[0]!;
    delete item.expected.semantic;
    item.expected.metrics = metricCatalog.map(m => ({ metricId: m.id, version: m.version, unit: m.unit,
        ...(m.id === 'task-success' ? { denominator: 1 } : { notApplicable: 'Exact controlled saved fact only.' }) }));
    data.manifest.scoring.judges = [{ id: 'semantic-batch', required: false }];

    return data;
}

test('a necessary semantic specialist check survives Runner, formal aggregation and report round trip',async()=>{
    const data=deterministicDataset(),item=data.cases[0]!;
    item.expected.diagnostics=[{evaluatorId:'task-judge',required:true,reason:'Disclose the independently recorded partial failure',
        params:{metricId:'diagnostic-partial-failure-explanation',denominator:1,evidence:['answer','task-facts']}}];
    item.expected.semantic=compileFormalSemanticPlan(item);
    data.cases[0]=caseV2Schema.parse(item);
    let generations=0;
    const run=await runLocal(REPO_ROOT,{dataset:data,backend:'local',judge:'required',executionId:'specialist-'+randomUUID()},
        {kernel:kernel(),env:{FLOWMATE_JUDGE_API:'openai-completions',FLOWMATE_JUDGE_MODEL:'llama-3.3-70b-versatile',
            FLOWMATE_JUDGE_BASE_URL:'https://unused.invalid/v1',FLOWMATE_JUDGE_API_KEY:'synthetic-specialist-key'},
            fetcher:async()=>{generations++;return judgeResponse({choices:[{message:{content:namedJudgment(item.expected.semantic!,{v:1,r:[[0,1,0]],f:[[0,0,1]]})},finish_reason:'stop'}]});}});
    const report=readReport(run.file),trial=report.trials[0]!;
    expect(generations).toBe(1);
    expect(trial.evaluatorPlan?.find(p=>p.evaluatorId==='diagnostic-partial-failure-explanation')).toMatchObject({applicable:true});
    expect(trial.scores.find(s=>s.metricId==='diagnostic-partial-failure-explanation')).toMatchObject({evaluatorId:'diagnostic-partial-failure-explanation',category:'diagnostic',status:'FAIL',required:true});
    expect(trial.scores.find(s=>s.metricId==='task-success')).toMatchObject({status:'FAIL'});
    expect(report.aggregation!.metrics).toHaveLength(39);
    expect(report.aggregation!.metrics.some(m=>m.metricId.startsWith('diagnostic-'))).toBe(false);
});

test('required mode executes a deterministic-only Case without reading or preparing Judge configuration', async () => {
    for (const registered of [true, false]) {
        const data = deterministicDataset();
        if (!registered) data.manifest.scoring.judges = [];
        const run = await runLocal(REPO_ROOT, { dataset: data, backend: 'local', judge: 'required', executionId: 'zero-judge-' + randomUUID() },
            { kernel: kernel(), env: { FLOWMATE_JUDGE_API: 'invalid-unused-api' },
                fetcher: async () => { throw Error('Deterministic Case must not contact Judge'); } });
        expect(run.report.trials[0]!.execution!.started).toBe(true);
        expect(run.report.trials[0]!.judgeCalls).toHaveLength(0);
        expect(run.report.trials[0]!.status).toBe('PASS');
        expect(run.report.scoringConfiguration.judge ?? null).toBeNull();
    }
});

test('a mixed Dataset generates only for the Case with declared semantic opportunities', async () => {
    const data = semanticDataset(), pure = deterministicDataset().cases[0]!;
    pure.id = 'deterministic-control';
    data.cases.push(pure);
    data.manifest.members.push('cases/' + pure.id + '.json');
    data.manifest.scoring.judges = [{ id: 'semantic-batch', required: false, requiredFor: [data.cases[0]!.id] }];
    let calls = 0;
    const run = await runLocal(REPO_ROOT, { dataset: data, backend: 'local', judge: 'required', executionId: 'mixed-judge-' + randomUUID() },
        { kernel: kernel(), env: { FLOWMATE_JUDGE_API: 'openai-completions', FLOWMATE_JUDGE_MODEL: 'llama-3.3-70b-versatile',
            FLOWMATE_JUDGE_BASE_URL: 'https://unused.invalid/v1', FLOWMATE_JUDGE_API_KEY: 'synthetic-mixed-key' },
            fetcher: async () => { calls++; return judgeResponse({ choices: [{ message: { content: namedJudgment(data.cases[0]!.expected.semantic!,
                { v: 1, r: [[3, 3, 0], [4, 4, 0]], f: [] }) }, finish_reason: 'stop' }] }); } });
    expect(calls).toBe(1);
    expect(run.report.trials.map(t => t.judgeCalls.length)).toEqual([1, 0]);
    expect(run.report.trials.map(t => t.status)).toEqual(['PASS', 'PASS']);
});

test('progress reduces Judge validation details to a brief cause while reports keep the full errors',async()=>{
    const data=semanticDataset(), events:EvaluationProgress[]=[];
    const run=await runLocal(REPO_ROOT,{dataset:data,backend:'local',judge:'required',executionId:'brief-judge-'+randomUUID()},
        {kernel:kernel(),env:{FLOWMATE_JUDGE_API:'openai-completions',FLOWMATE_JUDGE_MODEL:'llama-3.3-70b-versatile',
            FLOWMATE_JUDGE_BASE_URL:'https://unused.invalid/v1',FLOWMATE_JUDGE_API_KEY:'synthetic-brief-key'},
            fetcher:async()=>judgeResponse({choices:[{message:{content:'{"v":1,"results":[]}'},finish_reason:'stop'}]}),onProgress:e=>events.push(e)});
    const reason=events.find(e=>e.type==='scoring-end')!.reason;
    expect(reason).toContain('Judge 返回指标缺失');expect(reason).toContain('详见报告');
    expect(reason).not.toContain('Judge omitted a metric');expect(reason.length).toBeLessThan(180);
    expect(run.report.trials[0]!.judgeCalls[0]!.compact!.validationErrors).toHaveProperty('tool-arguments','Judge omitted a metric');
});

test('a simple authored Case without a Fixture executes and saves no placeholder scene', async () => {
    const data = structuredClone(dataset), item = data.cases[0]!;
    data.cases = [item]; data.manifest.members = ['cases/' + item.id + '.json']; data.manifest.smoke = [item.id];
    const content = readFileSync(join(REPO_ROOT, 'data/invoices/voxel51/000001/content.md'), 'utf8');
    const metadata = '{}';
    const file = (path: string, text: string) => ({ path, encoding: 'utf8' as const, content: text, bytes: Buffer.byteLength(text) });
    data.embedded = { manifest: data.manifest, tasks: {}, files: {
        'voxel51/000001/content.md': file('voxel51/000001/content.md', content),
        'voxel51/000001/metadata.json': file('voxel51/000001/metadata.json', metadata)
    }, inputs: { [item.id]: [] }, reviews: {},  authored: { version: 'v1', cases: [{ id: item.id, input: { prompt: item.input.prompt } }],
        gold: { [item.id]: {} }, reviews: {}, fixtures: {} } };
    let prepared = 0; const product = kernel(); const prepare = product.prepare;
    product.prepare = async (trial, signal) => { prepared++; return prepare(trial, signal); };
    const result = await runLocal(REPO_ROOT, { dataset: data, executionId: 'no-fixture-' + randomUUID(), backend: 'local', judge: 'off' }, { kernel: product });
    expect(prepared).toBe(1);
    expect(readReport(result.file).trials[0]!.execution!.status).toBe('completed');
    expect(readSnapshot(result.file).fixtures ?? {}).toEqual({});
});

test('Runner binds one compact Judge per Trial, distinct ratios and original counts without exposing grading plans to Agent', async () => {
    const data = semanticDataset(), id = 'compact-' + randomUUID(); let requests = 0;
    const selectedCriteria = structuredClone(data.cases[0]!.expected.semantic!.criteria);
    const product = kernel(), prepare = product.prepare;
    product.prepare = async (trial, signal) => {
        expect(JSON.stringify(trial)).not.toContain('flowmate-semantic-plan');
        expect(JSON.stringify(trial.input)).not.toContain('Count three decisions');
        data.cases[0]!.expected.semantic!.criteria[0]!.rule = 'Changed after the Trial was declared.';
        return prepare(trial, signal);
    };
    const run = await runLocal(REPO_ROOT, { dataset: data, executionId: id, backend: 'local', judge: 'auto', repeat: 2 }, { kernel: product,
        env: { FLOWMATE_JUDGE_API:'openai-completions',FLOWMATE_JUDGE_PROVIDER:'openai-compatible', FLOWMATE_JUDGE_MODEL: 'llama-3.3-70b-versatile', FLOWMATE_JUDGE_API_KEY: 'synthetic-batch-key',
            FLOWMATE_JUDGE_BASE_URL: 'https://unused.invalid/v1' }, fetcher: async (_, init) => {
            requests++; const body = JSON.parse(String(init.body)); expect(body).toHaveProperty('max_completion_tokens', 32768);expect(body).not.toHaveProperty('temperature');
            expect(JSON.parse(body.messages[1].content).plan.criteria).toHaveLength(2);
            expect(JSON.parse(body.messages[1].content).plan.criteria).toEqual(selectedCriteria);
            return judgeResponse({ choices: [{ message: { content: namedJudgment({criteria:[{metricId:'tool-selection'},{metricId:'tool-arguments'}]},'{"v":1,"r":[[2,3,0],[4,4,0]],"f":[[0,2,1]]}') }, finish_reason: 'stop' }] });
        } });
    expect(requests).toBe(2);
    expect(run.report.trials.map(t => t.judgeCalls.length)).toEqual([1, 1]);
    expect(readReport(run.file).trials[0]!.scores.filter(s => s.judge)).toMatchObject([
        { metricId: 'tool-selection', value: 2 / 3 }, { metricId: 'tool-arguments', value: 1 }
    ]);
    expect(run.report.aggregation!.metrics.find(m => m.metricId === 'tool-selection')).toMatchObject({ numerator: 4, denominator: 6, missing: 0, value: 2 / 3 });
    expect(run.report.aggregation!.metrics.find(m => m.metricId === 'tool-arguments')).toMatchObject({ numerator: 8, denominator: 8, missing: 0, value: 1 });
}, 30000);

test('compact selection and required criteria are checked before Agent preparation or Judge dispatch', async () => {
    let prepared = 0;
    const product = kernel(); product.prepare = async () => { prepared++; throw new Error('must not prepare'); };
    const data = semanticDataset();
    await expect(runLocal(REPO_ROOT, { dataset: data, backend: 'local', judge: 'auto' }, { kernel: product, env: {} })).rejects.toThrow('Required Judge');
    data.manifest.scoring.judges = [];
    await expect(runLocal(REPO_ROOT, { dataset: data, backend: 'local', judge: 'off' }, { kernel: product })).rejects.toThrow('semantic-batch');
    expect(prepared).toBe(0);
});
test('requiring a Judge preserves the Case distinction between optional process metrics and necessary task predicates',async()=>{
    const data=semanticDataset();data.cases[0]!.expected.semantic!.criteria[0]!.required=false;
    const run=await runLocal(REPO_ROOT,{dataset:data,executionId:'optional-process-'+randomUUID(),backend:'local',judge:'required'},{kernel:kernel(),env:{FLOWMATE_JUDGE_API:'openai-completions',FLOWMATE_JUDGE_PROVIDER:'openai-compatible',FLOWMATE_JUDGE_MODEL:'llama-3.3-70b-versatile',FLOWMATE_JUDGE_API_KEY:'synthetic-optional-key',FLOWMATE_JUDGE_BASE_URL:'https://unused.invalid/v1'},
        fetcher:async()=>judgeResponse({choices:[{message:{content:namedJudgment({criteria:[{metricId:'tool-selection'},{metricId:'tool-arguments'}]},'{"v":1,"r":[[0,3,0],[4,4,0]],"f":[[0,0,1],[0,1,1],[0,2,1]]}')},finish_reason:'stop'}]})});
    expect(run.report.trials[0]!.scores.find(s=>s.metricId==='tool-selection')).toMatchObject({status:'FAIL',required:false});
    expect(run.report.trials[0]!.status).toBe('PASS');
});
test('production adapter requires its dedicated credential, never Provider fallback', async () => {
    await expect(runLocal(REPO_ROOT, { dataset, backend: 'local', judge: 'off' }, { env: {} })).rejects.toThrow('FLOWMATE_EVAL_AGENT_API_KEY');
});
test('a linked result root is rejected before creating an Execution or preparing Agent', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'flowmate-result-root-')), outside = mkdtempSync(join(tmpdir(), 'flowmate-result-outside-'));
    mkdirSync(join(repo, 'agent-eval'));
    symlinkSync(outside, join(repo, 'agent-eval/runs'), 'junction');
    let prepared = 0;
    const product = kernel(); product.prepare = async () => { prepared++; throw new Error('must not prepare'); };
    await expect(runLocal(repo, { dataset, executionId: 'linked-root', backend: 'local', judge: 'off' }, { kernel: product })).rejects.toThrow('Linked Run');
    expect(prepared).toBe(0);
    expect(readdirSync(outside)).toEqual([]);
});
test('local orchestration stores all selected members, independent trials and missing material; no backend needed', async () => {
    const id = 'unit-' + randomUUID(), data = structuredClone(dataset);data.cases[0]!.input.materials[0]!.file='missing.md' as any;

    // Limit to two tasks for this orchestration test, never a production Benchmark.
    data.cases = data.cases.slice(0, 2);
    try {
        const { report, file } = await runLocal(REPO_ROOT, { dataset: data, executionId: id, backend: 'local', judge: 'off', repeat: 2 }, { kernel: kernel() });
        expect(report.trials).toHaveLength(4);
        expect(report.contract).toBe('flowmate-agent-run/v2');
        expect(report.aggregation?.cases).toHaveLength(2);
        // The second fixture has pending Gold, so its two attempts cannot claim success.
        expect(report.aggregation?.metrics.find(m => m.metricId === 'task-success')).toMatchObject({ numerator: 0, denominator: 4, value: 0, missing: 4 });
        expect(report.trials[0]!.status).toBe('NOT_RUN');
        expect(report.trials[2]!.status).toBe('NOT_RUN');
        expect(report.trials[1]!.execution!.identity.trialId).not.toBe(report.trials[3]!.execution!.identity.trialId);
        expect(report.export.status).toBe('disabled');
        expect(report.manualReview).toBe('none');
        expect(readSnapshot(file).cases).toHaveLength(2);
        await expect(runLocal(REPO_ROOT, { dataset: data, executionId: id, backend: 'local', judge: 'off' }, { kernel: kernel() })).rejects.toThrow();
    }
    finally {
        rmSync(join(REPO_ROOT, 'agent-eval/runs/business', id), { recursive: true, force: true });
    }
}, 30000);
test('Judge preflight rejects partial or missing configuration before preparing Agent', async () => {
    let called = 0;
    const product = kernel();
    product.prepare = async () => { called++; throw new Error('unexpected'); };
    for (const env of [{ FLOWMATE_JUDGE_MODEL: 'partial' }, {}]) {
        await expect(runLocal(REPO_ROOT, { dataset, backend: 'local', judge: 'required' }, { kernel: product, env })).rejects.toThrow();
    }
    expect(called).toBe(0);
});
test('wrong identity and failed cleanup block grading; timeout requests actual cancellation', async () => {
    const trial = (): AgentTrial => ({ identity: observed().identity, directory: mkdtempSync(join(tmpdir(), 'flowmate-trial-')), input: observed().input, requires: [], configuration: {} });
    const wrong = await executeCase(kernel(r => { r.identity = { ...r.identity, trialId: 'wrong' }; }), trial(), 50, 50);
    expect(wrong.execution.status).toBe('error');
    expect(wrong.stopFailed).toBe(true);
    expect(wrong.execution.identity).toEqual(observed().identity);
    expect(wrong.execution.evidence['identity-conflict']).toMatchObject({ present: true, actual: { observed: { trialId: 'wrong' } } });
    let cancelled = 0;
    const hanging = kernel();
    hanging.prepare = async () => ({ input: observed().input, execute: async () => new Promise(() => { }), snapshot: async () => observed(), cancel: async () => { cancelled++; }, close: async () => ({ present: true, actual: { closed: true, stopped: true }, source: 'test' }) });
    const timed = await executeCase(hanging, trial(), 5, 50);
    expect(timed.execution.status).toBe('timeout');
    expect(cancelled).toBe(1);
});

test('preparation uses the task budget without extending the stopping grace', async () => {
    const product = kernel(), prepare = product.prepare.bind(product);
    product.prepare = async (trial, signal) => {
        await new Promise(resolve => setTimeout(resolve, 60));
        return prepare(trial, signal);
    };
    const trial = (): AgentTrial => ({ identity: observed().identity, directory: mkdtempSync(join(tmpdir(), 'flowmate-prepare-budget-')),
        input: observed().input, requires: [], configuration: {} });
    const ready = await executeCase(product, trial(), 1000, 10);
    expect(ready.execution.status).toBe('completed'); expect(ready.stopFailed).toBe(false);
    const normal = product.prepare.bind(product);
    product.prepare = async (trial, signal) => ({ ...await normal(trial, signal), close: async () => {
        await new Promise(resolve => setTimeout(resolve, 60));
        return { present: true, actual: { closed: true, stopped: true }, source: 'late owned cleanup' };
    } });
    const lateClose = await executeCase(product, trial(), 1000, 10);
    expect(lateClose.stopFailed).toBe(true); expect(lateClose.execution.error?.code).toBe('cleanup_failed');
});

test('cancellation during preparation returns before its task budget and closes a late Session without execution', async () => {
    const product = kernel(), prepare = product.prepare.bind(product), controller = new AbortController();
    let entered!: () => void, release!: () => void, closed!: () => void, executed = false;
    const started = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
    const cleanup = new Promise<void>(resolve => { closed = resolve; });
    product.prepare = async (trial, signal) => {
        entered(); await gate; expect(signal.aborted).toBe(true);
        const session = await prepare(trial, signal), close = session.close.bind(session);
        return { ...session, execute: async () => { executed = true; return session.execute(signal); },
            close: async () => { const fact = await close(); closed(); return fact; } };
    };
    const running = executeCase(product, { identity: observed().identity, directory: mkdtempSync(join(tmpdir(), 'flowmate-prepare-cancel-')),
        input: observed().input, requires: [], configuration: {} }, 2000, 100, controller.signal);
    let timer: ReturnType<typeof setTimeout>;
    try {
        await started; controller.abort();
        const result = await Promise.race([running, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(Error('Cancellation waited for preparation budget')), 500); })]);
        expect(result.stopFailed).toBe(true); expect(result.execution.status).toBe('cancelled');
    } finally { clearTimeout(timer!); release(); await running; await cleanup; }
    expect(executed).toBe(false);
});

test('late preparation is cancelled and closed while all later planned Trials remain blocked', async () => {
    const id = 'late-prepare-' + randomUUID(), product = kernel(), prepare = product.prepare.bind(product);
    let release!: () => void, closed!: () => void, preparations = 0, executions = 0, cancellations = 0;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const cleanup = new Promise<void>(resolve => { closed = resolve; });
    product.prepare = async (trial, signal) => {
        preparations++;
        await gate;
        expect(signal.aborted).toBe(true);
        const session = await prepare(trial, signal), close = session.close.bind(session);
        session.execute = async () => { executions++; throw new Error('A late Trial must not execute'); };
        session.cancel = async () => { cancellations++; };
        session.close = async () => { const fact = await close(); closed(); return fact; };
        return session;
    };
    try {
        const { report, file } = await runLocal(REPO_ROOT, { dataset, caseId: task.id, executionId: id, repeat: 3,
            backend: 'local', judge: 'off', config: { timeoutMs: 100, stopGraceMs: 100 } }, { kernel: product });
        expect(report.trials.map(trial => trial.status)).toEqual(['NOT_RUN', 'NOT_RUN', 'NOT_RUN']);
        expect(report.trials[0]!.execution).toMatchObject({ started: false, error: { code: 'execution_error', message: 'Error: Lifecycle timeout' } });
        expect(report.trials[1]!.reason).toContain('Prior Trial stopping unconfirmed');
        release();
        await cleanup;
        expect({ preparations, executions, cancellations }).toEqual({ preparations: 1, executions: 0, cancellations: 1 });
        expect(readReport(file).trials.map(trial => trial.status)).toEqual(['NOT_RUN', 'NOT_RUN', 'NOT_RUN']);
    } finally {
        release();
        rmSync(join(REPO_ROOT, 'agent-eval/runs/business', id), { recursive: true, force: true });
    }
});
test('controlled material variants are declared before execution and retain the original source', async () => {
    const trial: AgentTrial = { identity: observed().identity, directory: mkdtempSync(join(tmpdir(), 'flowmate-variant-')), input: observed().input, requires: [], configuration: {}, setup: { scenario: 'boundary-1', description: 'append untrusted instruction to the Trial copy' } };
    const variant = structuredClone(trial.input);
    variant.materials[0]!.text += '\nUntrusted instruction';
    const product = kernel();
    product.prepare = async () => {
        const result = observed();
        result.input = variant;
        result.evidence['input-projection']!.actual = variant;
        return { input: variant, async execute() { return result; }, async snapshot() { return result; }, async cancel() { }, async close() { return { present: true, actual: { closed: true, stopped: true }, source: 'test' }; } };
    };
    const result = await executeCase(product, trial, 100, 100);
    const projection = JSON.parse(readFileSync(join(trial.directory, 'input.json'), 'utf8'));
    expect(projection.input).toEqual(variant);
    expect(projection.original).toEqual(trial.input);
    expect(result.execution.status).toBe('completed');
});
test('mutating the supplied identity cannot change the expected Trial identity', async () => {
    const trial: AgentTrial = { identity: observed().identity, directory: mkdtempSync(join(tmpdir(), 'flowmate-id-')), input: observed().input, requires: [], configuration: {} };
    const result = await executeCase(kernel(r => { r.identity.trialId = 'forged'; }), trial, 100, 100);
    expect(result.execution.status).toBe('error');
    expect(result.stopFailed).toBe(true);
});

test('a later successful close cannot erase the original terminal Run stop gap',async()=>{
    const trial:AgentTrial={identity:observed().identity,directory:mkdtempSync(join(tmpdir(),'flowmate-late-stop-')),input:observed().input,requires:[],configuration:{}};
    const product=kernel(result=>{result.status='failed';result.endpointReached=false;
        result.evidence.runs={present:true,actual:[{runId:1,status:'failed',stoppedAt:null,cleanup:{stopped:false,lateObservationRequired:true}}],source:'original Run query'};});
    const result=await executeCase(product,trial,100,100);
    expect(result.execution.evidence.cleanup).toMatchObject({present:true,actual:{closed:true,stopped:true}});
    expect(result.stopFailed).toBe(true);expect(result.execution.status).toBe('error');
    expect(result.execution.evidence.runs).toMatchObject({actual:[{cleanup:{stopped:false,lateObservationRequired:true}}]});
});
test('a controller stop observation timeout blocks the next Trial even after actual late cleanup',async()=>{
    const trial:AgentTrial={identity:observed().identity,directory:mkdtempSync(join(tmpdir(),'flowmate-controller-stop-')),input:observed().input,requires:[],configuration:{}};
    const product=kernel(result=>{result.status='error';result.endpointReached=false;
        result.error={code:'stop_unconfirmed',message:'Original controller stop observation expired before every descendant stopped.',infrastructure:true};
        result.evidence.runs={present:true,actual:[{runId:1,status:'cancelled',stoppedAt:'2026-10-12T00:00:00.000Z',cleanup:{stopped:true,lateObservationRequired:false}}],source:'later stopped original Run query'};});
    const result=await executeCase(product,trial,100,100);
    expect(result.execution.evidence.cleanup).toMatchObject({present:true,actual:{closed:true,stopped:true}});
    expect(result.stopFailed).toBe(true);expect(result.execution.error?.code).toBe('stop_unconfirmed');
});

test('042 original descendant stop gap blocks all later Trials despite successful late close',async()=>{
    let prepared=0;
    const product=kernel(result=>{
        result.endpointReached=false;
        result.evidence['case-controller']={present:true,actual:{profile:{id:'invoice-save-cancel-race',version:1},exposure:{verified:true},
            cancelRequests:1,stopConfirmed:false,linearization:'commit-unknown',candidateCount:null},source:'Original controlled race stop observation'};
    });
    const prepare=product.prepare.bind(product);product.prepare=(trial,signal)=>{prepared++;return prepare(trial,signal);};
    const id='cancel-race-stop-'+randomUUID();
    const {report,file}=await runLocal(REPO_ROOT,{dataset,executionId:id,repeat:3,backend:'local',judge:'off'}, {kernel:product,env:{}});
    const statuses=['ERROR',...Array(dataset.cases.length*3-1).fill('NOT_RUN')];
    expect(prepared).toBe(1);expect(report.trials.map(t=>t.status)).toEqual(statuses);
    expect(report.trials[0]!.execution!.error?.code).toBe('stop_unconfirmed');
    expect(report.trials[0]!.execution!.evidence.cleanup).toMatchObject({actual:{closed:true,stopped:true}});
    expect(readReport(file).trials.map(t=>t.status)).toEqual(statuses);
});

test('Case-level Judge cannot bypass the shared scoring configuration', async () => {
    const data = structuredClone(dataset);
    data.manifest.scoring.judges = [];
    for (const c of data.cases)
        c.expected.checks.push({ metric: 'answer-relevance', required: true });
    await expect(runLocal(REPO_ROOT, { dataset: data, backend: 'local', judge: 'auto', repeat: 2 }, { kernel: kernel(), env: {} })).rejects.toThrow('configure Judges once');
});

test('unknown semantic denominators do not restore a removed Judge output budget',async()=>{
 const data=semanticDataset(),id='compact-bound-'+randomUUID();
 for(const criterion of data.cases[0]!.expected.semantic!.criteria)criterion.denominator=null;
 for(const metric of data.cases[0]!.expected.metrics)if(!metric.notApplicable&&metric.metricId!=='task-success')metric.denominator=null;
 let requests=0;const product=kernel();
 const run=await runLocal(REPO_ROOT,{dataset:data,caseId:data.cases[0]!.id,executionId:id,backend:'local',judge:'required'},{kernel:product,
  env:{FLOWMATE_JUDGE_API:'openai-completions',FLOWMATE_JUDGE_PROVIDER:'openai-compatible',FLOWMATE_JUDGE_MODEL:'llama-3.3-70b-versatile',FLOWMATE_JUDGE_API_KEY:'synthetic-bound-key',FLOWMATE_JUDGE_BASE_URL:'https://unused.invalid/v1'},
  fetcher:async(_url,init)=>{requests++;expect(JSON.parse(String(init.body))).toHaveProperty('max_completion_tokens', 32768);
   return judgeResponse({choices:[{message:{content:namedJudgment({criteria:[{metricId:'tool-selection'},{metricId:'tool-arguments'}]},'{"v":1,"r":[[2,3,0],[4,4,0]],"f":[[0,2,1]]}')},finish_reason:'stop'}]});}});
 expect(requests).toBe(1);expect(run.report.trials[0]!.judgeCalls).toHaveLength(1);expect(existsSync(archiveFile(run.file))).toBe(true);
});
for(const metric of ['skill-guidance','model-violation'] as const)test('declared '+metric+' grades survive saving and a hard failure cannot become a passing report',async()=>{
 const data=structuredClone(dataset),item=formalFixture(metric).task;
 item.input.materials=[];
 if(item.expected.reference)item.expected.reference.status='verified';
 if(metric==='skill-guidance')Object.assign(item.expected,{requiredSkills:['invoice-header-extraction']});
 item.expected.semantic=compileFormalSemanticPlan(item);data.cases=[item];
 data.manifest=manifestSchema.parse({...data.manifest,contract:'flowmate-agent-dataset/v2',environment:{...data.manifest.environment,profile:'isolated-agent/v2'},scoring:{...data.manifest.scoring,judges:[{id:'semantic-batch',required:true}]}});
 const run=await runLocal(REPO_ROOT,{dataset:data,executionId:'declared-'+metric+'-'+randomUUID(),backend:'local',judge:'required'},
 {kernel:kernel(),env:{FLOWMATE_JUDGE_API:'openai-completions',FLOWMATE_JUDGE_PROVIDER:'openai-compatible',FLOWMATE_JUDGE_MODEL:'llama-3.3-70b-versatile',FLOWMATE_JUDGE_API_KEY:'declared-predicate-fake-key',FLOWMATE_JUDGE_BASE_URL:'https://unused.invalid/v1'},
 fetcher:async()=>judgeResponse({choices:[{message:{content:namedJudgment({criteria:[{metricId:metric}]},{v:1,r:[metric==='model-violation'?[1,1,0]:[0,1,0]],f:[[0,0,1]]})},finish_reason:'stop'}]})});
 const loaded=readReport(run.file),trial=loaded.trials[0]!;
 expect(trial.semanticPlan!.criteria[0]!.required).toBe(true);
 const score=trial.scores.find(s=>s.metricId===metric);
 if(!score)throw new Error('Missing declared score: '+trial.reason+' '+JSON.stringify(trial.execution?.error));
 expect(score).toMatchObject({status:'FAIL',required:true});
 expect(trial.status).toBe('FAIL');
 expect(readReportMetadata(run.file).metadata.trials[0]!.dimensions![metric==='model-violation'?'safety':'process']!.status).toBe('FAIL');
});

test('cancellation during the only Judge request aborts transport and preserves all later planned Trials', async () => {
    const id = 'judge-cancel-' + randomUUID(), abort = new AbortController();
    let calls = 0, prepared = 0, transport: AbortSignal | null | undefined;
    const product = kernel(), prepare = product.prepare.bind(product);
    product.prepare = (trial, signal) => { prepared++; return prepare(trial, signal); };
    try {
        const { report } = await runLocal(REPO_ROOT, { dataset, caseId: task.id, executionId: id, repeat: 2, backend: 'local', judge: 'required' }, {
            kernel: product, signal: abort.signal,
            env: { FLOWMATE_JUDGE_API:'openai-completions',FLOWMATE_JUDGE_PROVIDER:'openai-compatible', FLOWMATE_JUDGE_MODEL: 'llama-3.3-70b-versatile', FLOWMATE_JUDGE_BASE_URL: 'https://unused.invalid/v1', FLOWMATE_JUDGE_API_KEY: 'synthetic-judge-key' },
            fetcher: async (_, init) => { calls++; transport = init.signal; abort.abort(); return new Promise(() => {}); }
        });
        expect({ calls, prepared, aborted: transport?.aborted }).toEqual({ calls: 1, prepared: 1, aborted: true });
        expect(report.trials.map(t => t.status)).toEqual(['ERROR', 'NOT_RUN']);
        expect(report.trials[0]!.judgeCalls).toMatchObject([{ attempts: 1, judgment: null, usage: null, error: 'Judge cancelled' }]);
        expect(report.trials[1]!.judgeCalls).toHaveLength(0);
        expect(report.aggregation!.metrics.find(m => m.metricId === 'task-success')).toMatchObject({ denominator: 2, numerator: 0 });
    } finally { rmSync(join(REPO_ROOT, 'agent-eval/runs/business', id), { recursive: true, force: true }); }
}, 30000);

test('semantic-only task cannot pass with Judge off; auto requires its Judge before Agent starts', async () => {
    const data = structuredClone(dataset);
    data.cases = [structuredClone(task)];
    // No tool calls is a useful constraint, but cannot prove an explanation correct.
    data.cases[0]!.expected.checks = [{ metric: 'fact-check', required: true, evidence: 'task-facts', path: ['saved'], equals: true }];
    Object.assign(data.manifest.scoring.judges[0]!, { requiredFor: [task.id] });
    let called = 0;
    const unavailable = kernel();
    unavailable.prepare = async () => { called++; throw new Error('must not start'); };
    const id = 'unit-' + randomUUID();
    try {
        await expect(runLocal(REPO_ROOT, { dataset: data, backend: 'local', judge: 'auto', executionId: id }, { kernel: unavailable, env: {} })).rejects.toThrow('Required Judge');
        expect(called).toBe(0);
        const { report } = await runLocal(REPO_ROOT, { dataset: data, backend: 'local', judge: 'off', executionId: id }, { kernel: kernel(r => { r.answer = 'irrelevant'; }) });
        expect(report.trials[0]!.status).toBe('UNJUDGEABLE');
        expect(report.trials[0]!.scores.find(s => s.metricId === 'answer-relevance')).toMatchObject({ required: true, status: 'NOT_RUN', value: null });
    } finally {
        rmSync(join(REPO_ROOT, 'agent-eval/runs/business', id), { recursive: true, force: true });
    }
}, 30000);

for(const source of ['cleanup','controller-observation'] as const)test('unconfirmed stopping blocks later planned Trials and preserves the originating reason, source='+source, async () => {
    const id = 'stop-' + randomUUID(), product = kernel(result=>{
        if(source==='controller-observation'){result.status='error';result.endpointReached=false;result.error={code:'stop_unconfirmed',message:'Original cancellation observation was unconfirmed; late actual cleanup is independent.',infrastructure:true};}
    });
    const prepare = product.prepare.bind(product);
    let started = 0;
    product.prepare = async (trial, signal) => {
        started++;
        const session = await prepare(trial, signal);
        if(source==='cleanup')session.close = async () => ({ present: true, actual: { closed: true, stopped: false }, source: 'controlled-unknown-stop' });
        return session;
    };
    try {
        const { report } = await runLocal(REPO_ROOT, { dataset, caseId: task.id, executionId: id, repeat: 3, backend: 'local', judge: 'off' }, { kernel: product });
        expect(started).toBe(1);
        expect(report.trials.map(t => t.status)).toEqual(['ERROR', 'NOT_RUN', 'NOT_RUN']);
        expect(report.trials[1]!.reason).toContain(source==='cleanup'?'Cleanup not proven':'Original cancellation observation was unconfirmed');
        expect(report.aggregation?.cases[0]).toMatchObject({ planned: 3, started: 1, statuses: { ERROR: 1, NOT_RUN: 2 } });
        expect(report.aggregation?.metrics.find(m => m.metricId === 'task-success')).toMatchObject({ denominator: 3, numerator: 0, missing: 3 });
    } finally {
        rmSync(join(REPO_ROOT, 'agent-eval/runs/business', id), { recursive: true, force: true });
    }
}, 30000);

test('matching Case and repetition in different Executions retain distinct Trial and Trace identities', async () => {
    const ids = ['first-' + randomUUID(), 'second-' + randomUUID()];
    try {
        const reports = [];
        for (const id of ids) reports.push((await runLocal(REPO_ROOT,
            { dataset, caseId: task.id, executionId: id, backend: 'local', judge: 'off' }, { kernel: kernel() })).report);
        expect(reports[0]!.trials[0]!.trialId).not.toBe(reports[1]!.trials[0]!.trialId);
        expect(reports[0]!.trials[0]!.traceId).not.toBe(reports[1]!.trials[0]!.traceId);
        expect(reports.map(r => r.aggregation!.metrics.find(m => m.metricId === 'task-success')!.sources[0]!.executionId)).toEqual(ids);
    } finally {
        for (const id of ids) rmSync(join(REPO_ROOT, 'agent-eval/runs/business', id), { recursive: true, force: true });
    }
}, 30000);
