import { afterAll, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { reportFixture } from '../support/fixtures.ts';
import { saveReport, readReport } from '../../src/reports/store.ts';
import { exportEvents } from '../../src/langfuse/export.ts';
const root = mkdtempSync(join(tmpdir(), 'judge-report-config-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));
for (const provider of ['openai-compatible', 'anthropic'] as const) test('saved Judge config keeps actual ' + provider + ' parameters without invented defaults', () => {
    const report = reportFixture(), at = report.startedAt;
    report.trials[0]!.judgeCalls = [{ callId: 'synthetic-' + provider, configuration: {
        provider, model: 'synthetic', baseUrl: 'https://unused.invalid/v1', timeoutMs: 1000, protocolVersion: 'flowmate-judge/v2',
        ...(provider === 'anthropic' ? { modelCapabilities: { modelId: 'synthetic', maxOutputTokens: 64000, source: 'anthropic-models-api' } } : {})
    }, startedAt: at, endedAt: at, attempts: 0, usage: null, responseModel: null, raw: null, error: 'Synthetic error, generation was not sent',
        judgment: null, finishReason: null, responseComplete: false }] as any;
    const path = join(root, provider + '.json');
    saveReport(path, report);
    const loaded = readReport(path);
    expect(loaded.trials[0]!.judgeCalls[0]!.configuration).not.toHaveProperty('temperature');
    expect(loaded.trials[0]!.judgeCalls[0]!.configuration).not.toHaveProperty('maxTokens');
    const generation = exportEvents(loaded).find(event => event.body.name === 'Judge · 回答质量')!;
    expect(generation.body.modelParameters).toEqual(provider === 'anthropic' ? { max_tokens: 64000 } : {});
});
test('a known deterministic failure with incomplete counts remains readable without inventing a ratio',()=>{
    const report=reportFixture();report.trials[0]!.status='FAIL';report.trials[0]!.counts={FAIL:1};
    report.trials[0]!.scores=[{metricId:'tool-execution',name:'Original tool failure',version:1,method:'deterministic',required:true,
        value:null,status:'FAIL',reason:'Known failure, remaining trace incomplete',evidence:['tool-evidence'],
        statistics:{unit:'实际调用',numerator:0,denominator:null,missing:null}}];
    const path=join(root,'partial-failure.json');saveReport(path,report);
    expect(readReport(path).trials[0]!.scores[0]).toMatchObject({status:'FAIL',value:null,statistics:{denominator:null}});
});
