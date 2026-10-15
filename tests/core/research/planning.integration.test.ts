import { expect, it } from 'bun:test';
import { InMemoryCredentialStore } from '@earendil-works/pi-ai';
import { Database } from 'bun:sqlite';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createApplication } from '../../../apps/composition.ts';
import { PiAgentAdapter } from '@flowmate/runtime-pi';
import type { AgentRunEvent, ProviderConfig, Result } from '@flowmate/contracts';
import { deferCleanup, mkdtempSync } from '../../support/resources.ts';

function need<T>(result: Result<T>): T { if (!result.ok) throw new Error(JSON.stringify(result.error)); return result.data; }
const plan = { question: 'Compare three Agent deployment options.', scope: 'Selected local materials only.',
  dimensions: [{ id: 'cost', title: 'Cost', questions: [{ id: 'cost-1', question: 'What costs apply?', evidenceNeeded: ['Official pricing'] }] }],
  sourcePolicy: { web: false, domains: [], artifactIds: [], documentIds: [] },
  stopConditions: ['Each dimension has evidence or an explicit gap.'],
  execution: { budget: { maxModelCalls: 12, maxToolCalls: 24, toolTimeoutMs: 10000 }, timeoutMs: 60000, stopGraceMs: 5000 } };

it('plans through real SDK tools, releases occupancy, and confirms the exact version once through the input ledger', async () => {
  const root = mkdtempSync(join(tmpdir(), 'flowmate-research-planning-'));
  const paths = { root, databaseFile: join(root, 'data', 'app.sqlite'), artifactsDir: join(root, 'artifacts'),
    runtimeDir: join(root, 'runtime'), logsDir: join(root, 'logs'), outputsDir: join(root, 'outputs') };
  const requests: Array<{ tools?: Array<{ function: { name: string } }>; messages: Array<{ role: string; content: unknown }> }> = [];
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    requests.push(await request.json());
    const chunk = (delta: object, reason: string | null = null) => `data: ${JSON.stringify({ id: 'research-fixture', model: 'research-fixture',
      choices: [{ index: 0, delta, finish_reason: reason }] })}\n\n`;
    const body = requests.length === 1
      ? chunk({ role: 'assistant', tool_calls: [{ index: 0, id: 'save-plan-1', type: 'function', function: { name: 'save_research_plan', arguments: JSON.stringify(plan) } }] }) + chunk({}, 'tool_calls')
      : chunk({ role: 'assistant', content: requests.length === 2 ? 'Plan saved. Please confirm it.' : 'No sufficient evidence is available in this fixture.' }) + chunk({}, 'stop');
    return new Response(body + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
  } });
  deferCleanup(() => server.stop(true));
  const app = need(await createApplication({ paths, logger: { write: () => undefined, close: async () => undefined },
    agentFactory: (tools, resourceContents) => new PiAgentAdapter({ cwd: paths.runtimeDir, agentDir: paths.runtimeDir, tools, resourceContents,
      credentials: new InMemoryCredentialStore(), runtimeApiKey: 'synthetic-research-key' }) }));
  deferCleanup(() => app.close());
  const session = need(await app.createSession({ title: 'Research planning' }));
  expect(typeof app.createResearchTask).toBe('function');
  const task = need(await app.createResearchTask({ sessionId: session.sessionId, title: 'Deployment comparison', sourcePolicy: plan.sourcePolicy }));
  const config: ProviderConfig = { version: 1, name: 'Research fixture', revision: 1,
    modelRef: { provider: 'research-fixture', model: 'research-fixture' }, native: { authPath: join(root, 'unused-auth.json'), modelsPath: null },
    connection: { baseUrl: `http://127.0.0.1:${server.port}/v1`, api: 'openai-completions', contextWindow: 64000, maxTokens: 4096 },
    parameters: { maxRetries: 0, maxRetryDelayMs: 1000 } };
  async function submit(sequence: number, research: { researchId: number; phase: 'planning' | 'researching'; plan: { planId: number; revision: number } | null }) {
    let finish!: (event: Extract<AgentRunEvent, { type: 'run_finished' }>) => void;
    const complete = new Promise<Extract<AgentRunEvent, { type: 'run_finished' }>>(resolve => { finish = resolve; });
    const request = { sessionId: session.sessionId, clientSequence: sequence, mode: 'prompt' as const, text: 'Compare the deployment options.', config, research };
    const accepted = need(await app.submitInput(request, { onEvent: event => { if (event.type === 'run_finished') finish(event); } }));
    return { accepted, request, terminal: await complete };
  }
  const planning = await submit(1, { researchId: task.researchId, phase: 'planning', plan: null });
  expect(planning.terminal.result).toMatchObject({ ok: true, data: { status: 'completed', stopped: true } });
  const saved = need(await app.queryResearchTask(task.researchId));
  expect(need(await app.queryRun(planning.accepted.runId)).input.goal).toBe('Deployment comparison');
  expect(saved.status).toBe('awaiting_confirmation');
  expect(saved.currentRunId).toBe(planning.accepted.runId);
  expect(Number.isSafeInteger(saved.currentPlanId)).toBe(true);
  expect(need(await app.queryRuntimeState()).active).toBeNull();
  const stored = need(await app.queryResearchPlan({ researchId: task.researchId, planId: saved.currentPlanId! }));
  expect(stored.body).toEqual(plan);
  const tools = requests[0]!.tools!.map(item => item.function.name);
  expect(tools).toContain('save_research_plan');
  expect(tools).not.toContain('search_research_sources');
  expect(tools).not.toContain('read_research_web');
  expect(tools).not.toContain('Agent');
  expect(requests[1]!.messages.some(m => m.role === 'tool' && JSON.stringify(m.content).includes('planId'))).toBe(true);
  expect(JSON.stringify(requests[0]!.messages)).toContain('planning');
  expect(await app.submitInput({ ...planning.request, clientSequence: 2, research: { researchId: task.researchId,
    phase: 'researching', plan: { planId: stored.planId, revision: stored.revision + 1 } } })).toMatchObject({ ok: false, error: { code: 'research_plan_stale' } });
  const confirmed = await submit(2, { researchId: task.researchId, phase: 'researching', plan: { planId: stored.planId, revision: stored.revision } });
  expect(confirmed.terminal.result).toMatchObject({ ok: true, data: { stopped: true } });
  expect(await app.submitInput(confirmed.request)).toEqual({ ok: true, data: confirmed.accepted });
  expect(await app.submitInput({ ...confirmed.request, clientSequence: 3 })).toMatchObject({ ok: false, error: { code: 'research_already_started' } });
  expect(need(await app.close()).closed).toBe(true);
  const audit = new Database(paths.databaseFile, { readonly: true }); deferCleanup(() => audit.close());
  expect(audit.query('SELECT COUNT(*) AS count FROM runs').get()).toEqual({ count: 2 });
  expect(audit.query('SELECT COUNT(*) AS count FROM session_inputs').get()).toEqual({ count: 2 });
  const row = audit.query('SELECT config_json FROM runs WHERE id=?').get(confirmed.accepted.runId) as { config_json: string };
  const configFacts = JSON.parse(row.config_json);
  expect(configFacts.runtimeBudget).toEqual(plan.execution.budget);
  expect(configFacts.limits).toEqual({ timeoutMs: 60000, stopGraceMs: 5000 });
  expect(requests).toHaveLength(3);
});
