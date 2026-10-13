import { expect, test } from 'bun:test';
import * as runner from '../../src/execution/runner.ts';
import { selectCases } from '../../src/dataset-loader/local.ts';
import { dataset, task, fixtureRepo, reportFixture } from '../support/fixtures.ts';
import type { AgentKernel } from '../../src/adapters/agent.ts';

const env = { FLOWMATE_JUDGE_PROVIDER: 'openai-compatible', FLOWMATE_JUDGE_MODEL: 'synthetic',
    FLOWMATE_JUDGE_BASE_URL: 'https://unused.invalid/v1', FLOWMATE_JUDGE_API_KEY: 'fake-batch-judge-key' };
const kernel: AgentKernel = { readiness: () => ({ready:true,reason:'synthetic'}), prepare: async () => { throw Error('must not generate'); } };
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
    const data=datasets();data[1]!.cases[0]!.input.materials[0]!.sha256='0'.repeat(64);
    await expect(runner.runBatch(fixtureRepo,{datasets:data,selection:'smoke',backend:'local',judge:'required'},{env,kernel,
        run:async()=>{calls++;throw Error('must not run');}})).rejects.toThrow();expect(calls).toBe(0);
    const results=await runner.runBatch(fixtureRepo,{datasets:datasets(),selection:'smoke',backend:'local',judge:'required'}, {env,kernel,
        run:async()=>{calls++;const report=reportFixture();report.trials[0]!.status='FAIL';return {report,file:'synthetic-report.json',stopped:false};}});
    expect(results).toHaveLength(2);expect(calls).toBe(2);
});
