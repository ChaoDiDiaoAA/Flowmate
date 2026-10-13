import { expect, spyOn, test } from 'bun:test';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { HostClient } from '../../../apps/desktop/main/host-client.ts';
import { createHttpProvider, mkdtempSync } from '../../../tests/support/resources.ts';
import { researchPlan } from '../../../tests/support/research.ts';
import { prepareHostTrial } from '../../src/adapters/host-research.ts';
import { REPO_ROOT } from '../../src/dataset-loader/local.ts';
import { executeCase } from '../../src/execution/execute-case.ts';
import type { AgentTrial } from '../../src/adapters/agent.ts';
import { syntheticNativeModel } from '../support/native-model.ts';
import { z } from 'zod';

for (const gap of ['none', 'context', 'descendants', 'original-stop'] as const) test(
    'failed Research retains its original started Runs and partial saved evidence with ' + gap + ' capture gap', async () => {
        let requests = 0, originalStopObserved = false, descendantGapObserved = false, contextGapArmed = false;
        const server = await createHttpProvider(async request => {
            const body = await request.json(); requests++;
            const selected = JSON.stringify(body).match(/artifactIds\\?":\[([\d,]*)\]/);
            const artifactIds = JSON.parse('[' + selected?.[1] + ']');
            const tool = requests === 1 ? { name: 'save_research_plan', arguments: JSON.stringify({ ...researchPlan,
                sourcePolicy: { ...researchPlan.sourcePolicy, artifactIds },
                execution: { ...researchPlan.execution, budget: { ...researchPlan.execution.budget, maxToolCalls: 1 } } }) }
                : requests === 3 ? { name: 'read_research_local', arguments: JSON.stringify({ artifactId: artifactIds[0], documentId: null }) }
                : { name: 'save_research_claim', arguments: '{}' };
            const delta = requests === 2 ? { role: 'assistant', content: 'Confirm the exact saved plan.' }
                : { role: 'assistant', tool_calls: [{ index: 0, id: 'failed-research-' + requests, type: 'function', function: tool }] };
            const chunk = (delta: object, finish: string | null) => `data: ${JSON.stringify({ id: 'failed-research',
                choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
            return new Response(chunk(delta, null) + chunk({}, requests === 2 ? 'stop' : 'tool_calls') + 'data: [DONE]\n\n',
                { headers: { 'content-type': 'text/event-stream' } });
        });
        const item: AgentTrial = { identity: { executionId: 'failed-host-engineering', trialId: gap, caseId: 'failed-research', caseVersion: 1 },
            directory: mkdtempSync(join(tmpdir(), 'eval-host-failure-')), requires: ['agent', 'research'],
            input: { prompt: researchPlan.question, materials: [{ sample: 'synthetic', file: 'policy.md', text: 'A saved source remains available after failure.' }] },
            steps: [{ id: 'plan', action: 'research-plan', instruction: researchPlan.question },
                { id: 'confirm', action: 'research-confirm', instruction: 'Execute the saved plan.', planFromStep: 'plan', revisionOffset: 0, expected: 'accepted' },
                { id: 'future', action: 'research-replay', fromStep: 'confirm' }],
            configuration: { modelCapabilities: syntheticNativeModel, model: 'failed-research', baseUrl: `http://127.0.0.1:${server.port}/v1`, api: 'openai-completions' } };
        const originalRequest = HostClient.prototype.request;
        const requestSpy = spyOn(HostClient.prototype, 'request').mockImplementation(async function (this: HostClient, command, timeout) {
            if (gap === 'context' && contextGapArmed && command.type === 'list_context_requests')
                return { ok: false, error: { code: 'storage_read_failed', category: 'storage', message: 'Controlled optional context read failure.', retryable: false } };
            if (gap === 'descendants' && command.type === 'list_subagents' && !descendantGapObserved) {
                descendantGapObserved = true;
                return { ok: false, error: { code: 'storage_read_failed', category: 'storage', message: 'Controlled descendant enumeration gap.', retryable: false } };
            }
            const result = await originalRequest.call(this, command, timeout);
            if (gap === 'original-stop' && command.type === 'query_run' && command.runId === 2 && !originalStopObserved) {
                const failed = z.object({ ok: z.literal(true), data: z.object({ status: z.literal('failed') }).passthrough() }).passthrough().safeParse(result);
                if (failed.success) {
                    originalStopObserved = true;
                    return { ...failed.data, data: { ...failed.data.data, cleanup: { stopped: false, lateObservationRequired: true } } };
                }
            }
            return result;
        });
        try {
            const { execution, stopFailed } = await executeCase({ readiness: () => ({ ready: true, reason: 'Controlled Host only.' }),
                async prepare(trial, signal) {
                    const session = await prepareHostTrial(trial, signal, { repo: REPO_ROOT, credential: 'synthetic-failure-key' });
                    if (gap === 'context') {
                        const before = await session.snapshot();
                        expect(['context-requests', 'tools', 'tool-evidence', 'resources'].map(key => before.evidence[key]!.present)).toEqual([true, true, true, true]);
                        contextGapArmed = true;
                    }
                    return { ...session, async execute(signal) {
                        const result = await session.execute(signal);
                        return gap === 'descendants' ? session.snapshot() : result;
                    } };
                } }, item, 30000, 10000);
            expect({ started: execution.started, status: execution.status, endpointReached: execution.endpointReached, startedAt: execution.startedAt, error: execution.error }).toMatchObject({ started: true, status: gap === 'descendants' || gap === 'original-stop' ? 'error' : 'failed',
                endpointReached: false, startedAt: expect.any(String),
                error: { code: gap === 'descendants' || gap === 'original-stop' ? 'stop_unconfirmed' : 'tool_budget_exceeded',
                    infrastructure: gap === 'descendants' || gap === 'original-stop' } });
            expect(stopFailed).toBe(gap === 'descendants' || gap === 'original-stop');
            expect(execution.evidence.runs!.actual).toMatchObject([{ runId: 1, status: 'completed', startedAt: expect.any(String), stoppedAt: expect.any(String) },
                { runId: 2, status: 'failed', startedAt: expect.any(String), stoppedAt: expect.any(String), error: { code: 'tool_budget_exceeded' } }]);
            expect(execution.evidence.research).toMatchObject({ present: true, actual: { plans: [{ planId: 1 }], sources: [{ sourceSnapshotId: 1 }], reports: [], reportCount: 0 } });
            expect(execution.evidence.cleanup).toMatchObject({ present: true, actual: { closed: true, stopped: true } });
            expect((execution.evidence['step-results']!.actual as Array<{ stepId: string }>).map(step => step.stepId)).toEqual(['plan', 'confirm']);
            if (gap === 'context') {
                expect(execution.evidence['capture-gaps']).toMatchObject({ present: false, actual: expect.any(Array) });
                expect(['context-requests', 'tools', 'tool-evidence', 'resources'].map(key => execution.evidence[key]!.present)).toEqual([false, false, false, false]);
            }
            if (gap === 'original-stop') expect(execution.evidence['original-stop-gaps']).toMatchObject({ present: false, actual: expect.any(Array) });
            expect(requests).toBe(4);
        } finally { requestSpy.mockRestore(); await server.stop(); }
    }, 45000);
