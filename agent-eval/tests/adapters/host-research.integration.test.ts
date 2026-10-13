import { syntheticNativeModel } from '../support/native-model.ts';
import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { z } from 'zod';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { createHttpProvider, mkdtempSync } from '../../../tests/support/resources.ts';
import { researchPlan } from '../../../tests/support/research.ts';
import { SourceSnapshotSchema, ResearchPlanSchema, ClaimSchema } from '../../../packages/contracts/src/research.ts';
import { ExtensionManifestSchema, canonicalExtensionManifest } from '../../../packages/contracts/src/extensions.ts';
import { ToolCallSnapshotSchema } from '../../../packages/contracts/src/tool-evidence.ts';
import { prepareHostResearchTrial } from '../../src/adapters/host-research.ts';
import type { AgentTrial, AgentTrialSession } from '../../src/adapters/agent.ts';
import { REPO_ROOT, hash, loadDataset } from '../../src/dataset-loader/local.ts';
import { runLocal } from '../../src/execution/runner.ts';
import { executeCase } from '../../src/execution/execute-case.ts';
import { metricCatalog } from '../../src/scoring/catalog.ts';
import { evaluateAll } from '../../src/scoring/evaluate.ts';
import { judgeConfig } from '../../src/scoring/judges/client.ts';
import { judgeResponse } from '../support/judge-response.ts';
import { caseV2Schema } from '../../src/dataset-loader/schema.ts';
import { task } from '../support/fixtures.ts';
import { fixtureRepo } from '../support/fixtures.ts';
import { manifest } from '../fixtures/minimal-dataset.ts';
import {buildResearchFrame} from '../../src/scoring/research-frame.ts';

for (const isolation of [undefined] as const) test
('the actual ' + (isolation ?? 'local') + ' Host executes planning, exact confirmation, research tools and replay inside one Trial', async () => {
    const requests: Array<{ messages: Array<{ role: string; content: unknown }> }> = [];
    const prefix = 'Usage is metered. ', text = prefix + 'a'.repeat(3999 - prefix.length) + '😀' + 'End of synthetic source.';
    let session!: AgentTrialSession;
    const server = await createHttpProvider(async request => {
        const body = await request.json() as typeof requests[number]; requests.push(body);
        const index = requests.length;
        let reply: { tool: string; args: unknown } | string = index === 2 ? 'Plan saved; confirm its exact version.' : 'Research report saved.';
        const selected = JSON.stringify(body.messages).match(/artifactIds\\?":\[([\d,]*)\]/);
        if (index === 1) reply = { tool: 'save_research_plan', args: { ...researchPlan,
            sourcePolicy: { ...researchPlan.sourcePolicy, artifactIds: JSON.parse('[' + selected?.[1] + ']') } } };
        if (index === 3) reply = { tool: 'Agent', args: { subagent_type: 'research-investigator', description: 'Synthetic cost evidence', prompt: 'Read the selected local cost source and return its saved source identity.' } };
        if (index === 4) reply = { tool: 'read_research_local', args: { artifactId: JSON.parse('[' + selected?.[1] + ']')[0], documentId: null } };
        if (index === 5) reply = 'CHILD_EVIDENCE: sourceSnapshotId:1; Usage is metered.';
        if (index >= 6 && index <= 8) {
            const snapshot = await session.snapshot();
            const evidence = z.object({ sources: z.array(SourceSnapshotSchema), plans: z.array(ResearchPlanSchema), claims: z.array(ClaimSchema) }).passthrough().parse(snapshot.evidence.research!.actual);
            const source = evidence.sources[0]!, plan = evidence.plans[0]!;
            if (index === 6) reply = { tool: 'query_research_evidence', args: { sourceSnapshotId: source.sourceSnapshotId, offset: 3999, limit: 4000 } };
            if (index === 7) reply = { tool: 'save_research_claim', args: { questionId: 'cost-1', text: 'Usage is metered.', dependencies: [],
                evidence: [{ relation: 'supports', ref: { researchId: source.researchId, planId: plan.planId, revision: plan.revision, runId: source.runId,
                    toolCallId: source.toolCallId, sourceSnapshotId: source.sourceSnapshotId, locator: { start: 0, end: prefix.length, quote: prefix } } }],
                verification: { status: 'supported', reasons: ['The synthetic source explicitly states this condition.'] } } };
            if (index === 8) reply = { tool: 'save_research_report', args: { answer: 'Usage is metered.', completeness: 'full',
                sections: [{ title: 'Cost', text: 'Usage is metered.', claimIds: evidence.claims.map(c => c.claimId) }], conflicts: [], limitations: ['Synthetic engineering fixture.'], unresolvedQuestions: [],
                coverage: [{ questionId: 'cost-1', claimIds: evidence.claims.map(c => c.claimId), status: 'covered', reason: 'Explicit source evidence.' }] } };
        }
        const chunk = (delta: object, finish: string | null = null) => `data: ${JSON.stringify({ id: 'eval-host-fixture', model: 'eval-host-fixture', choices: [{ index: 0, delta, finish_reason: finish }],
            ...(finish ? { usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } } : {}) })}\n\n`;
        const output = typeof reply === 'string' ? chunk({ role: 'assistant', content: reply }) + chunk({}, 'stop')
            : chunk({ role: 'assistant', tool_calls: [{ index: 0, id: 'fixture-' + index, type: 'function', function: { name: reply.tool, arguments: JSON.stringify(reply.args) } }] }) + chunk({}, 'tool_calls');
        return new Response(output + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
    }, isolation ? '0.0.0.0' : undefined);
    const extension = ExtensionManifestSchema.parse(JSON.parse(readFileSync(join(REPO_ROOT, 'resources/extensions/subagents-v1.json'), 'utf8')));
    const trial: AgentTrial = { identity: { executionId: 'engineering-host', trialId: 'research-1', caseId: 'synthetic-research', caseVersion: 1 },
        directory: mkdtempSync(join(tmpdir(), 'eval-host-trial-')), input: { prompt: researchPlan.question, materials: [{ sample: 'synthetic', file: 'policy.md', text }] },
        requires: ['agent', 'research', 'subagent'], configuration: { modelCapabilities: syntheticNativeModel, model: 'eval-host-fixture', baseUrl: `http://${isolation ? '127.0.0.1' : '127.0.0.1'}:${server.port}/v1`, api: 'openai-completions',
            extensions: { enabledExtensions: [{ id: extension.id, version: extension.version, manifestHash: hash(canonicalExtensionManifest(extension)) }] } }, steps: [
            { id: 'plan', action: 'research-plan', instruction: researchPlan.question },
            { id: 'stale', action: 'research-confirm', instruction: 'Do not accept a changed revision.', planFromStep: 'plan', revisionOffset: 1, expected: 'research_plan_stale' },
            { id: 'confirm', action: 'research-confirm', instruction: 'FUTURE_CONFIRMATION: execute the exact plan.', planFromStep: 'plan', revisionOffset: 0, expected: 'accepted' },
            { id: 'replay', action: 'research-replay', fromStep: 'confirm' },
            { id: 'again', action: 'research-confirm', instruction: 'Do not start a second investigation.', planFromStep: 'plan', revisionOffset: 0, expected: 'research_already_started' }
        ] };
    try {
        session = await prepareHostResearchTrial(trial, new AbortController().signal, { repo: REPO_ROOT, credential: 'synthetic-host-key' });
        const result = await session.execute(new AbortController().signal);
        expect({ identity: result.identity, status: result.status, endpointReached: result.endpointReached })
            .toEqual({ identity: trial.identity, status: 'completed', endpointReached: true });
        expect(result.evidence.research).toMatchObject({ present: true, actual: { reportCount: 1, sourceTexts: [{ text }] } });
        expect(result.evidence['research-integrity']).toMatchObject({ present: true, actual: { valid: true, reports: [{ reportId: expect.any(Number) }] } });
        expect(result.evidence.runs!.actual).toHaveLength(3);
        expect(result.evidence.subagents).toMatchObject({ present: true, actual: { children: [{ stopConfirmed: true, role: 'research-investigator',
            scope: { allowedTools: ['read_research_local', 'query_research_evidence'] } }] } });
        expect(result.evidence['subagent-history']).toMatchObject({ present: true });
        expect(result.evidence['tool-evidence']).toMatchObject({ present: true });
        const originalTools = z.object({ calls: z.array(z.object({ tool: ToolCallSnapshotSchema }).passthrough()) }).passthrough()
            .parse(result.evidence['tool-evidence']!.actual).calls.map(call => call.tool);
        expect(originalTools).toHaveLength(6);
        expect(originalTools.find(call => call.toolName === 'Agent')?.args.raw).toMatchObject({ subagent_type: 'research-investigator' });
        expect(originalTools.find(call => call.toolName === 'save_research_plan')?.args.raw).toMatchObject({ question: researchPlan.question });
        const originalSource = z.object({ sources: z.array(SourceSnapshotSchema) }).passthrough().parse(result.evidence.research!.actual).sources[0]!;
        expect(originalTools.find(call => call.toolCallId === originalSource.toolCallId)).toMatchObject({ runId: originalSource.runId,
            toolName: 'read_research_local', args: { raw: { documentId: null } }, result: { status: 'succeeded', data: {
                source: { sourceSnapshotId: originalSource.sourceSnapshotId }, excerpt: { start: 0, end: 3999 } } },
            delivery: { state: 'request_observed' }, cleanup: { stopped: true } });
        const researchTask=caseV2Schema.parse({...task,contract:'flowmate-agent-case/v2',expected:{...task.expected,
            metrics:metricCatalog.map(m=>m.id==='task-success'?{metricId:m.id,version:m.version,unit:m.unit,denominator:1}:
                {metricId:m.id,version:m.version,unit:m.unit,notApplicable:'Independent frame engineering fixture.'}),
            research:{status:'verified',claims:[{id:'metered',text:'Usage is metered.',required:true,acceptable:['Usage is metered.'],conditions:[],entities:[],
                evidence:[{sample:'synthetic',sha256:hash(text),start:0,end:prefix.length,quote:prefix,relation:'support'}]}],chains:[],forbidden:[]}}});
        const frame=buildResearchFrame({task:researchTask,result,projected:trial.input,judge:null})!;
        expect(frame).toMatchObject({contract:'flowmate-research-frame/v1',complete:true,gold:{claims:[{id:'metered'}]},links:[{valid:true}],sources:[{text,modelRead:false}]});
        const drIds=['DR01','DR02','DR04','DR05'];
        researchTask.expected.metrics=researchTask.expected.metrics.map(m=>drIds.includes(m.metricId)||m.metricId==='DR03'?
            {metricId:m.metricId,version:m.version,unit:m.unit,denominator:m.metricId==='DR02'?1:null}:m);
        researchTask.expected.semantic={contract:'flowmate-semantic-plan/v1',
            criteria:drIds.map(metricId=>({metricId,version:1,unit:metricCatalog.find(m=>m.id===metricId)!.unit,denominator:metricId==='DR02'?1:null,
                required:true,rule:'Independently match the actual Report to the declared synthetic source and reference.',evidence:['research-frame','gold-research'],trigger:'started'}))};
        let researchJudgeRequests=0;
        const scoredResearch=await evaluateAll({task:researchTask,result,projected:trial.input,judge:judgeConfig({FLOWMATE_JUDGE_API:'openai-completions',FLOWMATE_JUDGE_PROVIDER:'openai-compatible',FLOWMATE_JUDGE_MODEL:'llama-3.3-70b-versatile',
            FLOWMATE_JUDGE_BASE_URL:'https://unused.invalid/v1',FLOWMATE_JUDGE_API_KEY:'independent-fixture-key'}),fetcher:async()=>{
                researchJudgeRequests++;return judgeResponse({choices:[{message:{content:JSON.stringify({v:1,r:drIds.map(()=>null),f:[],research:{atoms:[{block:0,start:0,length:frame.blocks[0]!.text.length,correct:1,needsCitation:true,covered:1,gold:1,matchUncertain:false}],links:[{atom:0,state:1}],chains:[]}})},finish_reason:'stop'}]});
            }},[]);
        expect(researchJudgeRequests,JSON.stringify(scoredResearch.scores.filter(s=>drIds.includes(s.metricId)))).toBe(1);expect(scoredResearch.judgeCalls[0]!.error).toBeNull();
        expect(scoredResearch.scores.filter(s=>s.metricId.startsWith('DR')&&s.metricId!=='DR06').map(s=>s.value)).toEqual([1,1,1,1,1]);
        expect(frame.blocks.map(b=>b.kind)).toEqual(['claim','report-answer','report-section']);
        const changed={...result,evidence:{...result.evidence,research:structuredClone(result.evidence.research!)}};
        const changedResearch=changed.evidence.research!.actual as{reports:Array<{sections:Array<{text:string}>}>};
        changedResearch.reports[0]!.sections[0]!.text+=' An additional unchecked fact.';
        const additional=buildResearchFrame({task:researchTask,result:changed,projected:trial.input,judge:null})!;
        expect(additional.blocks.some(b=>b.text.includes('additional unchecked fact'))).toBe(true);
        expect(additional.integrity.valid).toBe(false);
        expect(JSON.stringify(requests[5])).toContain('CHILD_EVIDENCE');
        expect(result.evidence.history).toMatchObject({ present: true, actual: { sessionId: 1, acquisition: 'controller-query' } });
        expect(result.evidence['step-results']!.actual).toHaveLength(5);
        expect(result.evidence['interaction-history']).toMatchObject({ present: true, actual: [
            { clientSequence: 1, content: { text: researchPlan.question }, answer: 'Plan saved; confirm its exact version.' },
            { clientSequence: 2, content: { text: 'FUTURE_CONFIRMATION: execute the exact plan.' }, answer: 'Research report saved.' }
        ] });
        expect(JSON.stringify(result.evidence['interaction-history'])).not.toContain('Do not accept a changed revision.');
        expect(JSON.stringify(result.evidence['interaction-history'])).not.toContain('Do not start a second investigation.');
        let judgeRequests = 0;
        const judged = await evaluateAll({ task: caseV2Schema.parse({ ...task, contract: 'flowmate-agent-case/v2', requires: trial.requires, steps: trial.steps,
            expected: { ...task.expected, metrics: metricCatalog.map(m => m.id === 'task-success'
                ? { metricId: m.id, version: m.version, unit: m.unit, denominator: 1 }
                : { metricId: m.id, version: m.version, unit: m.unit, notApplicable: 'Synthetic Judge transport connection only' }) } }), result, projected: trial.input,
            judge: judgeConfig({ FLOWMATE_JUDGE_API: 'openai-completions', FLOWMATE_JUDGE_PROVIDER: 'openai-compatible', FLOWMATE_JUDGE_MODEL: 'llama-3.3-70b-versatile',
                FLOWMATE_JUDGE_BASE_URL: 'https://unused.invalid/v1', FLOWMATE_JUDGE_API_KEY: 'synthetic-judge-key' }),
            fetcher: async (_, init) => {
                judgeRequests++;
                const data = JSON.parse(JSON.parse(String(init.body)).messages[1].content);
                expect(data.interactions).toEqual(result.evidence['interaction-history']!.actual);
                expect(data).not.toHaveProperty('steps');
                return judgeResponse({ choices: [{ message: { content: '{"score":1,"reason":"Synthetic transport only."}' }, finish_reason: 'stop' }] });
            } }, [{ metric: 'answer-relevance', required: true }]);
        expect(judged.scores[0]).toMatchObject({ status: 'PASS', value: 1 });
        expect(judgeRequests).toBe(1);
        expect(judged.judgeCalls).toHaveLength(1);
        expect(result.evidence.environment).toMatchObject({ present: true, actual: { fresh: true,
            isolation: { contract: 'flowmate-local-host/v1', kind: 'local-process', filesystemSandbox: false } } });
        expect(JSON.stringify(requests[0])).not.toContain('FUTURE_CONFIRMATION');
        expect(JSON.stringify(requests)).not.toContain('synthetic-host-key');
        expect(requests).toHaveLength(9);
        expect(result.usage).toMatchObject({ inputTokens: 90, outputTokens: 18, totalTokens: 108, cost: null });
        const before = requests.length;
        const reread = await session.snapshot();
        expect(reread.evidence.research).toEqual(result.evidence.research);
        expect(requests).toHaveLength(before);
    } finally {
        if (session) {
            const closed = await session.close();
            expect(closed).toMatchObject({ present: true, actual: { closed: true, stopped: true } });
            expect(await session.close()).toEqual(closed);
        }
        await server.stop();
    }
}, 65000);

test('two independent local Trials rebuild the same material projection without sharing product state', async () => {
    let requests = 0;
    const server = await createHttpProvider(async request => {
        const body = await request.json(); requests++;
        const selected = JSON.stringify(body).match(/artifactIds\\?":\[([\d,]*)\]/);
        const planning = requests % 2 === 1;
        const delta = planning ? { role: 'assistant', tool_calls: [{ index: 0, id: 'fresh-' + requests, type: 'function',
            function: { name: 'save_research_plan', arguments: JSON.stringify({ ...researchPlan,
                sourcePolicy: { ...researchPlan.sourcePolicy, artifactIds: JSON.parse('[' + selected?.[1] + ']') } }) } }] }
            : { role: 'assistant', content: 'Confirm the saved exact Plan.' };
        const chunk = (delta: object, finish: string | null) => `data: ${JSON.stringify({ id: 'fresh-trial', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
        return new Response(chunk(delta, null) + chunk({}, planning ? 'tool_calls' : 'stop') + 'data: [DONE]\n\n',
            { headers: { 'content-type': 'text/event-stream' } });
    }, '0.0.0.0');
    const root = mkdtempSync(join(tmpdir(), 'eval-fresh-isolated-'));
    const results = [];
    try {
        for (let repetition = 1; repetition <= 2; repetition++) {
            const trial: AgentTrial = { identity: { executionId: 'engineering-fresh', trialId: 'fresh-' + repetition, caseId: 'fresh', caseVersion: 1 },
                directory: join(root, 'trial-' + repetition), requires: ['agent', 'research'],
                input: { prompt: researchPlan.question, materials: [{ sample: 'synthetic', file: 'policy.md', text: 'Declared synthetic source.' }] },
                configuration: { modelCapabilities: syntheticNativeModel, model: 'fresh-model', baseUrl: `http://127.0.0.1:${server.port}/v1`, api: 'openai-completions' },
                steps: [{ id: 'plan', action: 'research-plan', instruction: researchPlan.question }] };
            const result = await executeCase({ readiness: () => ({ ready: true, reason: 'Synthetic engineering only' }),
                prepare: (trial, signal) => prepareHostResearchTrial(trial, signal, { repo: REPO_ROOT, credential: 'synthetic-fresh' }) },
                trial, 60000, 10000);
            results.push(result);
            expect(result).toMatchObject({ stopFailed: false, execution: { status: 'completed', endpointReached: true,
                evidence: { cleanup: { present: true, actual: { stopped: true } } } } });
            const research = z.object({ sources: z.array(z.unknown()), plans: z.array(ResearchPlanSchema) }).passthrough().parse(result.execution.evidence.research!.actual);
            expect(research.sources).toHaveLength(0);
            expect(research.plans).toMatchObject([{ planId: 1, researchId: 1, runId: 1 }]);
            expect(existsSync(join(trial.directory, 'product/runtime/previous-trial.txt'))).toBe(false);
            writeFileSync(join(trial.directory, 'product/runtime/previous-trial.txt'), 'Owned synthetic contamination probe');
        }
        expect(results[0]!.projected).toEqual(results[1]!.projected);
        expect(results[0]!.execution.evidence['material-registration']).toEqual(results[1]!.execution.evidence['material-registration']);
        const environments = results.map(result => z.object({ isolation: z.object({ kind: z.literal('local-process'), files: z.unknown(), productRoot: z.string() }).passthrough() })
            .passthrough().parse(result.execution.evidence.environment!.actual).isolation);
        expect(environments[0]!.productRoot).not.toBe(environments[1]!.productRoot);
        expect(environments[0]!.files).toEqual(environments[1]!.files);
        expect(requests).toBe(4);
    } finally { await server.stop(); }
}, 65000);

test('unsupported setup or capabilities are rejected before creating a product instance', async () => {
    const trial: AgentTrial = { identity: { executionId: 'engineering', trialId: 'unsupported', caseId: 'unsupported', caseVersion: 1 },
        directory: '/no-instance', input: { prompt: 'Synthetic', materials: [] }, requires: ['research', 'fill'], configuration: {} };
    await expect(prepareHostResearchTrial(trial, new AbortController().signal, { repo: REPO_ROOT, credential: 'synthetic' })).rejects.toThrow('Unsupported');
});

test('a configured remote endpoint prepares a local Host without generating an answer', async () => {
    const trial: AgentTrial = { identity: { executionId: 'engineering', trialId: 'remote-preparation', caseId: 'synthetic', caseVersion: 1 },
        directory: '', input: { prompt: 'Synthetic', materials: [] }, requires: ['research'], configuration: {} };
    trial.directory = mkdtempSync(join(tmpdir(), 'eval-host-unverified-'));
    trial.requires = ['research']; trial.steps = [{ id: 'plan', action: 'research-plan', instruction: trial.input.prompt }];
    trial.configuration = { modelCapabilities: syntheticNativeModel, model: 'synthetic', baseUrl: 'https://invalid.example/v1', api: 'openai-completions' };
    let session: AgentTrialSession | undefined;
    try {
        session = await prepareHostResearchTrial(trial, new AbortController().signal, { repo: REPO_ROOT, credential: 'synthetic-remote-preparation-key' });
        expect(session.input.prompt).toBe('Synthetic');
        expect(existsSync(join(trial.directory, 'product'))).toBe(true);
    } finally { if (session) expect((await session.close()).present).toBe(true); }
});

test('the production Host bridge imports in Node without opening Bun SQLite', () => {
    const output = execFileSync('node', ['--import', 'tsx', '--input-type=module', '--eval',
        "await import('./agent-eval/src/adapters/host-research.ts'); process.stdout.write('node-controller-loaded');"],
        { cwd: REPO_ROOT, encoding: 'utf8', timeout: 15000, windowsHide: true });
    expect(output).toBe('node-controller-loaded');
});

test('Runner retains one Trial and its declared denominator for two actual research Runs that do not save a report', async () => {
    let calls = 0;
    const server = await createHttpProvider(async () => {
        calls++;
        const delta = calls === 1 ? { role: 'assistant', tool_calls: [{ index: 0, id: 'plan', type: 'function', function: { name: 'save_research_plan', arguments: JSON.stringify(researchPlan) } }] }
            : { role: 'assistant', content: calls === 2 ? 'Please confirm the saved Plan.' : 'No sufficient evidence is available.' };
        return new Response(`data: ${JSON.stringify({ id: 'runner-fixture', model: 'runner-fixture', choices: [{ index: 0, delta, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ id: 'runner-fixture', model: 'runner-fixture', choices: [{ index: 0, delta: {}, finish_reason: calls === 1 ? 'tool_calls' : 'stop' }] })}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } });
    });
    const root = join(fixtureRepo, 'agent-eval/src/datasets/research-controller'); mkdirSync(join(root, 'cases'), { recursive: true });
    writeFileSync(join(root, 'dataset.json'), JSON.stringify({ ...manifest, contract: 'flowmate-agent-dataset/v2', id: 'research-controller',
        members: ['cases/research-controller.json'], smoke: ['research-controller'], environment: { profile: 'isolated-agent/v2', source: 'local', risks: ['Synthetic engineering only'] }, scoring: { ...manifest.scoring, judges: [] } }));
    writeFileSync(join(root, 'cases/research-controller.json'), JSON.stringify({ contract: 'flowmate-agent-case/v2', id: 'research-controller', version: 1,
        name: 'Synthetic engineering only', category: 'research', tags: ['synthetic'], requires: ['agent', 'research'], input: { prompt: researchPlan.question, materials: [] },
        steps: [{ id: 'plan', action: 'research-plan', instruction: researchPlan.question }, { id: 'confirm', action: 'research-confirm', instruction: 'Confirm the saved version.', planFromStep: 'plan' }],
        expected: { success: ['Report saved if supported'], failure: ['Invent a report receipt'], checks: [{ metric: 'fact-check', required: true, evidence: 'research', path: ['reportCount'], equals: 0 }],
            metrics: metricCatalog.map(m => m.id === 'task-success' ? { metricId: m.id, version: m.version, unit: m.unit, denominator: 1 }
                : { metricId: m.id, version: m.version, unit: m.unit, notApplicable: 'Synthetic controller integration only' }) }, review: { status: 'pending' } }));
    try {
        const { report } = await runLocal(fixtureRepo, { dataset: loadDataset(root), executionId: 'engineering-' + randomUUID(), backend: 'local', judge: 'off',
            config: { model: 'runner-fixture', baseUrl: `http://127.0.0.1:${server.port}/v1`, api: 'openai-completions', stopGraceMs: 10000 } },
            { kernel: { readiness: () => ({ ready: true, reason: 'Controlled integration only' }), prepare: (trial, signal) => prepareHostResearchTrial({ ...trial, configuration: { ...trial.configuration, modelCapabilities: syntheticNativeModel } }, signal, { repo: REPO_ROOT, credential: 'synthetic-runner-key' }) } });
        expect(report.trials).toHaveLength(1);
        expect(report.trials[0]!.execution!.evidence.runs!.actual).toHaveLength(2);
        expect(report.trials[0]).toMatchObject({ status: 'FAIL', judgeCalls: [] });
        expect(report.aggregation!.metrics.find(m => m.metricId === 'task-success')).toMatchObject({ numerator: 0, denominator: 1, value: 0 });
        expect(calls).toBe(3);
    } finally { await server.stop(); }
}, 60000);
