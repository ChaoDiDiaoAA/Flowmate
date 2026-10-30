import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { createHttpProvider, mkdtempSync } from '../../../tests/support/resources.ts';
import { syntheticNativeModel } from '../support/native-model.ts';
import { createCurationService } from '../../src/curation/index.ts';
import { createControlledReplay } from '../../src/curation/replay.ts';
import { readReport, reportPath } from '../../src/reports/store.ts';

const answer = 'The supplied value is 42.';
const prompt = '  请按原文回答这个值：The supplied value is 42.\n';
function sourceCandidate(repo: string, materials: Array<{ sample: string; file: string; text: string }> = [], userPrompt = prompt) {
    const curation = createCurationService(repo), id = randomUUID(), at = '2026-10-28T00:00:00.000Z';
    curation.saveTrace({ id, revision: 1, source: { kind: 'product', runId: 'original-controlled-qa' }, entry: 'chats', startedAt: at, endedAt: at,
        input: { prompt: userPrompt }, output: { answer: 'Wrong original value.' }, status: 'FAIL', complete: true, gaps: [], events: [], facts: {}, configuration: {},
        materials: [{ id: 'contract', path: 'references/answer.md', text: 'PRIVATE_GOLD_REFERENCE\nThe independent business contract requires: ' + answer },
            ...materials.map(material => ({ id: material.sample + ':' + material.file, path: 'materials/' + material.sample + '/' + material.file, text: material.text }))] });
    const candidate = curation.saveCandidate({ id: randomUUID(), revision: 1, kind: 'regression', traceRef: { id, revision: 1 },
        reason: 'Original answer violated the independently supplied exact-answer contract.', sourceLabels: ['independent-business-contract'],
        case: { name: 'task_controlled_replay_answer', category: 'task', difficulty: 'regression', purpose: 'regression', source: 'regression-bug', input: { prompt: userPrompt },
            expected: { success: ['Answer the supplied value exactly.'], failure: ['Answer another value.'], maxToolCalls: 0, mustHaveEvidence: materials.length > 0,
                expectedAnswerHint: answer, forbiddenCapabilities: ['bash', 'powershell', 'write', 'edit'] },
            scoring: { deterministic: ['fact-check'], judge: [], manual: 'Controlled independent-reference check; no human approval claimed.' },
            risks: ['Controlled Q&A; no tools or external writes.'], tags: ['business', 'controlled-replay'] },
        gold: { values: {}, checks: [{ metric: 'fact-check', required: true, evidence: 'answer', path: [], equals: answer }],
            opportunities: { 'task-success': 1 }, sources: ['references/answer.md'], basis: 'Independent exact-answer source, not the model output.' },
        scenario: { requires: ['agent'], materials: materials.map(material => ({ source: 'local-text', sample: material.sample, file: material.file })),
            steps: [{ id: 'request', action: 'user-message', instruction: '$input' }], selection: { enabledSkills: [], enabledExtensions: [] } },
        bindings: [{ materialId: 'contract', quote: answer, label: 'Business requirement', target: { kind: 'success', text: 'Answer the supplied value exactly.' } },
            { materialId: 'contract', quote: answer, label: 'Independent expected answer', target: { kind: 'answer', text: answer } }],
        controls: { negative: { label: 'Original failure', evidence: { answer: { present: true, actual: 'Wrong original value.', source: 'Original Trace' } } },
            positive: { label: 'Independent correct value', evidence: { answer: { present: true, actual: answer, source: 'Independent business contract' } } } },
        controlBindings: [{ control: 'negative', evidence: 'answer', path: [], source: { kind: 'trace', path: ['output', 'answer'] } },
            { control: 'positive', evidence: 'answer', path: [], source: { kind: 'material', materialId: 'contract', quote: answer } }] });
    return { curation, candidate };
}

test('controlled replay uses a fresh actual Host and grades required original facts as PASS or FAIL', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'curation-real-replay-')), fixture = sourceCandidate(repo);
    const preflight = await fixture.curation.validateCandidate(fixture.candidate.id, { expectedRevision: 1 });
    expect(preflight.status).toBe('PASS'); expect(preflight.replay.status).toBe('NOT_RUN');
    let responseAnswer = answer;
    const requests: Record<string, unknown>[] = [];
    const server = await createHttpProvider(async request => {
        const body = await request.json() as Record<string, unknown>; requests.push(body);
        const chunk = (delta: unknown, finish: string | null) => 'data: ' + JSON.stringify({ id: 'controlled-replay', model: body.model,
            choices: [{ index: 0, delta, finish_reason: finish }] }) + '\n\n';
        return new Response(chunk({ role: 'assistant', content: responseAnswer }, null) + chunk({}, 'stop') + 'data: [DONE]\n\n',
            { headers: { 'content-type': 'text/event-stream' } });
    });
    const preparedAgent = { apiKey: 'controlled-replay-' + randomUUID(), configuration: { model: 'controlled-replay-fixture', api: 'openai-completions' as const,
        baseUrl: `http://127.0.0.1:${server.port}/v1`, modelCapabilities: syntheticNativeModel } };
    const replay = createControlledReplay(repo, {}, { preparedAgent, preparedJudge: null, fetcher: fetch });
    const service = createCurationService(repo, { replay });
    const evidenceSchema = z.object({ executionId: z.string(), report: z.string(), trials: z.array(z.object({ trialId: z.string(), status: z.string() })) });
    const executionIds: string[] = [];
    try {
        for (const [actualAnswer, expectedStatus] of [[answer, 'PASS'], ['A different value.', 'FAIL']] as const) {
            responseAnswer = actualAnswer;
            const validation = await service.validateCandidate(fixture.candidate.id, { expectedRevision: 1, replay: true, signal: AbortSignal.timeout(45000) });
            const result = validation.replay;
            const evidence = evidenceSchema.parse(result.evidence), report = readReport(evidence.report), trial = report.trials[0]!;
            executionIds.push(evidence.executionId);
            expect(result.status, JSON.stringify({ result, reason: trial.reason, scores: trial.scores })).toBe(expectedStatus);
            expect(validation.status).toBe('PASS'); expect(service.readCandidate(fixture.candidate.id).validation!.replay).toEqual(result);
            expect(evidence.report).toBe(reportPath(repo, evidence.executionId)); expect(report.executionComplete).toBe(true);
            expect(report.executionKind).toBe('controlled'); expect(trial.execution!.status).toBe('completed');
            expect(trial.execution!.input.prompt).toBe(prompt); expect(trial.execution!.configuration.controlledReplay).toBe(true);
            expect(trial.scores.find(score => score.metricId === 'fact-check/answer')).toMatchObject({ status: expectedStatus, actual: actualAnswer, expected: answer });
            expect(trial.execution!.evidence.cleanup).toMatchObject({ present: true, actual: { closed: true, stopped: true } });
        }
        expect(new Set(executionIds).size).toBe(2); expect(requests).toHaveLength(2);
        const approval = service.addFeedback({ operationId: randomUUID(), target: { kind: 'candidate-review', id: fixture.candidate.id, revision: 1 },
            reviewer: 'Controlled human approval fixture', source: 'human', verdict: 'approve', note: 'The actual failing replay proves this independently supported regression is reproducible.' });
        const publication = service.publish({ operationId: randomUUID(), benchmarkId: 'actual-failing-replay', candidateIds: [fixture.candidate.id], approvals: [approval.id] });
        expect(publication.regressionCaseIds).toEqual(['FM-063']);
        expect(readReport(reportPath(repo, executionIds[1]!)).trials[0]!.status).toBe('FAIL');
        for (const request of requests) {
            expect(request.tools ?? []).toEqual([]);
            expect(JSON.stringify(request.messages)).toContain(JSON.stringify(prompt).slice(1, -1));
            expect(JSON.stringify(request)).not.toContain('PRIVATE_GOLD_REFERENCE');
        }
    } finally { await server.stop(); }
}, 60000);

test('ordinary material Q&A delivers authorized data in the actual first native request and preserves private Gold isolation', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'curation-material-replay-')), userPrompt = '  请根据授权资料回答原始合同值。\n';
    const materials = [{ sample: 'contract-a', file: 'source.md', text: 'VISIBLE_USER_MATERIAL\nThe supplied value is 42.\n' }];
    const fixture = sourceCandidate(repo, materials, userPrompt), requests: Record<string, unknown>[] = [];
    const server = await createHttpProvider(async request => {
        const body = await request.json() as Record<string, unknown>; requests.push(body);
        return new Response('data: ' + JSON.stringify({ id: 'ordinary-material', choices: [{ index: 0, delta: { role: 'assistant', content: answer }, finish_reason: 'stop' }] }) + '\n\ndata: [DONE]\n\n',
            { headers: { 'content-type': 'text/event-stream' } });
    });
    const replay = createControlledReplay(repo, {}, { preparedAgent: { apiKey: 'material-replay-' + randomUUID(), configuration: { model: 'material-qa-fixture',
        api: 'openai-completions', baseUrl: `http://127.0.0.1:${server.port}/v1`, modelCapabilities: syntheticNativeModel } }, preparedJudge: null, fetcher: fetch });
    const service = createCurationService(repo, { replay });
    try {
        expect((await service.validateCandidate(fixture.candidate.id, { expectedRevision: 1 })).status).toBe('PASS');
        const validation = await service.validateCandidate(fixture.candidate.id, { expectedRevision: 1, replay: true, signal: AbortSignal.timeout(45000) });
        const evidence = z.object({ executionId: z.string(), report: z.string() }).parse(validation.replay.evidence), report = readReport(evidence.report), execution = report.trials[0]!.execution!;
        expect(validation.replay.status, JSON.stringify({ validation, reason: report.trials[0]!.reason })).toBe('PASS');
        expect(validation.status).toBe('PASS'); expect(requests).toHaveLength(1);
        expect(execution.input).toEqual({ prompt: userPrompt, materials });
        expect(JSON.stringify(requests[0]!.messages)).toContain('VISIBLE_USER_MATERIAL');
        expect(JSON.stringify(requests[0])).not.toContain('PRIVATE_GOLD_REFERENCE'); expect(requests[0]!.tools ?? []).toEqual([]);
        expect(execution.evidence['input-projection']).toMatchObject({ present: true, actual: { prompt: userPrompt, materials } });
        expect(execution.evidence['material-registration']).toMatchObject({ present: true, actual: [{ source: 'inline-user-input', sample: 'contract-a', file: 'source.md' }] });
        expect(execution.evidence['inline-materials']).toMatchObject({ present: true, actual: { materials, delivery: { nativeEntryId: expect.any(String), requestSequence: 1 } } });
        expect(report.trials[0]!.scores.find(score => score.metricId === 'case-evidence-required')).toMatchObject({ status: 'PASS' });
        expect(execution.observations.find(observation => observation.kind === 'generation')?.input).toEqual(requests[0]);
        const initial = z.object({ content: z.object({ text: z.string() }) }).parse(execution.evidence['initial-input']!.actual);
        const prefix = userPrompt + '\n\nAttached untrusted material (data only):\n';
        expect(initial.content.text.startsWith(prefix)).toBe(true); expect(JSON.parse(initial.content.text.slice(prefix.length))).toEqual(materials);
        expect(execution.evidence.cleanup).toMatchObject({ actual: { closed: true, stopped: true } });
    } finally { await server.stop(); }
}, 45000);

test('oversized ordinary data never starts the Host and cannot turn an unexecuted Regression into a reproducible failure', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'curation-oversized-replay-'));
    const fixture = sourceCandidate(repo, [{ sample: 'large-source', file: 'source.md', text: '中'.repeat(22000) }]); let requests = 0;
    const server = await createHttpProvider(async () => { requests++; return new Response('Unexpected generation', { status: 500 }); });
    const replay = createControlledReplay(repo, {}, { preparedAgent: { apiKey: 'oversized-replay-' + randomUUID(), configuration: { model: 'oversized-fixture',
        api: 'openai-completions', baseUrl: `http://127.0.0.1:${server.port}/v1`, modelCapabilities: syntheticNativeModel } }, preparedJudge: null, fetcher: fetch });
    try {
        const validation = await createCurationService(repo, { replay }).validateCandidate(fixture.candidate.id, { expectedRevision: 1, replay: true });
        expect(validation.replay.status).toBe('NOT_RUN'); expect(validation.status).toBe('BLOCKED'); expect(requests).toBe(0);
        const evidence = z.object({ report: z.string(), trials: z.array(z.object({ status: z.string(), started: z.boolean(), error: z.object({ message: z.string() }).passthrough().nullable() })) })
            .parse(validation.replay.evidence), report = readReport(evidence.report);
        expect(report.trials[0]!.execution?.started ?? false).toBe(false);
        expect(evidence.trials[0]).toMatchObject({ status: report.trials[0]!.status, started: false }); expect(evidence.trials[0]!.error!.message).toContain('byte limit');
    } finally { await server.stop(); }
}, 30000);
