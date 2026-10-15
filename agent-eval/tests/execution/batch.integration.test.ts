import { expect, test } from 'bun:test';
import * as runner from '../../src/execution/runner.ts';
import { selectCases } from '../../src/dataset-loader/local.ts';
import { dataset, task, fixtureRepo, reportFixture } from '../support/fixtures.ts';
import type { AgentKernel } from '../../src/adapters/agent.ts';
import type { EvaluationProgress } from '../../src/execution/runner.ts';

const env = { FLOWMATE_JUDGE_API:'openai-completions',FLOWMATE_JUDGE_PROVIDER:'openai-compatible', FLOWMATE_JUDGE_MODEL: 'llama-3.3-70b-versatile',
    FLOWMATE_JUDGE_BASE_URL: 'https://unused.invalid/v1', FLOWMATE_JUDGE_API_KEY: 'fake-batch-judge-key' };
const kernel: AgentKernel = { readiness: () => ({ready:true,reason:'synthetic'}), prepare: async () => { throw Error('must not generate'); } };
test('a deterministic-only batch does not parse unused Judge credentials in required mode',async()=>{
    const pure=structuredClone(dataset);pure.manifest.scoring.judges=[];
    let executions=0;
    const results=await runner.runBatch(fixtureRepo,{datasets:[pure],selection:'smoke',backend:'local',judge:'required'},
        {kernel,env:{FLOWMATE_JUDGE_API:'invalid-unused-api'},run:async(_,options,deps)=>{
            executions++;expect(options.judge).toBe('required');expect(deps!.preparedJudge).toBeNull();
            return{report:reportFixture(),file:'synthetic-report.json',stopped:false};
        }});
    expect(executions).toBe(1);expect(results).toHaveLength(1);
});
function datasets() {
    return [50, 12].map((count, group) => {
        const data = structuredClone(dataset);
        data.manifest.id = group ? 'flowmate-research-v1' : 'flowmate-agent-v1';
        data.cases = Array.from({length:count}, (_,i) => ({...structuredClone(task),id:`FM-${String(i+1+group*50).padStart(3,'0')}`}));
        data.manifest.smoke = data.cases.slice(0,group?4:10).map(c=>c.id);
        return data;
    });
}

test('batch selects 14 smoke or 62 full cases in two local Judge-enabled executions', async () => {
    expect(runner.runBatch).toBeFunction();
    for (const selection of ['smoke','full'] as const) {
        const selected: number[] = [], names: string[] = [];
        const results = await runner.runBatch(fixtureRepo, { datasets: datasets(), selection, backend:'local',judge:'required' }, {env,kernel,
            run: async (_, options, deps) => {
                expect(options.backend).toBe('local');expect(options.judge).toBe('required');
                expect(options.executionId).toBeUndefined();expect(options.caseId).toBeUndefined();
                expect(deps!.preparedJudge!.apiKey).toBe('fake-batch-judge-key');
                selected.push(selectCases(options.dataset,selection).length);names.push(options.dataset.manifest.id);
                return { report:reportFixture(),file:'synthetic-report.json',stopped:false };
            } });
        expect(selected).toEqual(selection==='smoke'?[10,4]:[50,12]);
        expect(names).toEqual(['flowmate-agent-v1','flowmate-research-v1']);expect(results).toHaveLength(2);
    }
});

test('stop uncertainty and cancellation block the second dataset', async () => {
    expect(runner.runBatch).toBeFunction();
    const results = await runner.runBatch(fixtureRepo,{datasets:datasets(),selection:'smoke',backend:'local',judge:'required'}, {env,kernel,
        run:async()=>({report:reportFixture(),file:'synthetic-report.json',stopped:true})});
    expect(results).toHaveLength(1);
    const controller=new AbortController();controller.abort();
    expect(await runner.runBatch(fixtureRepo,{datasets:datasets(),selection:'smoke',backend:'local',judge:'required'}, {env,kernel,signal:controller.signal,
        run:async()=>{throw Error('must not run');}})).toEqual([]);
});

test('all datasets are checked before the first execution; ordinary failed results still permit the second group', async () => {
    expect(runner.runBatch).toBeFunction();let calls=0;
    const data=datasets();data[1]!.cases[0]!.input.materials[0]!.file='missing.md' as any;
    await expect(runner.runBatch(fixtureRepo,{datasets:data,selection:'smoke',backend:'local',judge:'required'},{env,kernel,
        run:async()=>{calls++;throw Error('must not run');}})).rejects.toThrow();expect(calls).toBe(0);
    const results=await runner.runBatch(fixtureRepo,{datasets:datasets(),selection:'smoke',backend:'local',judge:'required'}, {env,kernel,
        run:async()=>{calls++;const report=reportFixture();report.trials[0]!.status='FAIL';return {report,file:'synthetic-report.json',stopped:false};}});
    expect(results).toHaveLength(2);expect(calls).toBe(2);
});

test('batch progress uses one plan and global indices for smoke, full and repeated Trials', async () => {
    for (const [selection, repeat, total] of [['smoke',1,14],['full',1,62],['smoke',2,28],['smoke',5,70],['full',5,310]] as const) {
        const events: EvaluationProgress[] = [];
        await runner.runBatch(fixtureRepo, { datasets: datasets(), selection, repeat, backend: 'local', judge: 'required' },
            { env, kernel, onProgress: event => { events.push(event); }, run: async (_, options, deps) => {
                const items = selectCases(options.dataset, selection), localTotal = items.length * repeat;
                deps!.onProgress?.({ type: 'plan', selection, total: localTotal, datasets: [{ id: options.dataset.manifest.id, total: localTotal }] });
                for (let index = 1; index <= localTotal; index++) {
                    const identity = { index, total: localTotal, caseId: items[(index-1)%items.length]!.id, trialId: 'synthetic-' + index };
                    deps!.onProgress?.({ type: 'trial-phase', ...identity, phase: 'executing' });
                    deps!.onProgress?.({ type: 'agent-end', ...identity, status: 'completed' });
                    deps!.onProgress?.({ type: 'scoring-end', ...identity, status: 'PASS', reason: 'Synthetic.' });
                }
                return { report: reportFixture(), file: 'synthetic-report.json', stopped: false };
            } });
        expect(events.filter(e => e.type === 'plan')).toEqual([{ type: 'plan' as const, selection, total,
            caseCount: selection === 'full' ? 62 : 14, trialsPerCase: repeat,
            datasets: [{ id: 'flowmate-agent-v1', caseCount: selection === 'full' ? 50 : 10, total: (selection === 'full' ? 50 : 10) * repeat },
                { id: 'flowmate-research-v1', caseCount: selection === 'full' ? 12 : 4, total: (selection === 'full' ? 12 : 4) * repeat }] }]);
        expect(events.filter(e => e.type === 'trial-phase').map(e => [e.index,e.total]))
            .toEqual(Array.from({ length: total }, (_,i) => [i+1,total]));
        for (const completed of [events.filter(e => e.type === 'agent-end'), events.filter(e => e.type === 'scoring-end')])
            expect(completed.map(e => [e.index,e.total]))
                .toEqual(Array.from({ length: total }, (_,i) => [i+1,total]));
    }
});

test('a progress observer cannot mutate the batch plan and prevent the next dataset', async () => {
    let calls = 0;
    const result = await runner.runBatch(fixtureRepo, { datasets: datasets(), selection: 'smoke', backend: 'local', judge: 'required' },
        { env, kernel, onProgress(event) { if (event.type === 'plan') event.datasets.length = 0; },
            run: async () => { calls++; return { report: reportFixture(), file: 'synthetic-report.json', stopped: false }; } });
    expect(calls).toBe(2); expect(result).toHaveLength(2);
});
