import { expect, it } from 'bun:test';
import { InMemoryCredentialStore } from '@earendil-works/pi-ai';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { ok } from '@flowmate/contracts';
import type { Result, Application } from '@flowmate/contracts';
import { createApplication } from '../../../apps/composition.ts';
import { PiAgentAdapter } from '../../../packages/runtime-pi/src/session.ts';
import { resolveProductPaths } from '../../../packages/shared/src/paths.ts';
import { RuntimeService } from '../../../packages/core/src/runtime/service.ts';
import { createHttpProvider, deferCleanup, mkdtempSync } from '../../support/resources.ts';
const need = <T>(result: Result<T>): T => { if (!result.ok) throw Error(result.error.code+': '+result.error.message); return result.data; };

for (const scenario of ['complete', 'cancel', 'workspace'] as const) it(`parallel SDK children: ${scenario}`, async () => {
  const root = mkdtempSync(join(tmpdir(), 'flowmate-parallel-')), paths = need(resolveProductPaths(join(root, 'product')));
  const payloads: any[] = []; let waiting = 0, peak = 0, parent = 0, release!: () => void;
  const barrier = new Promise<void>(resolve => release = resolve);
  let ready!: () => void;
  const started = new Promise<void>(resolve => ready = resolve);
  const server = await createHttpProvider(async request => {
    const payload = await request.json(); payloads.push(payload);
    const child = payload.messages[0]?.content.startsWith('Analyze the task');
    let delta: object;
    if (child) { waiting++; peak = Math.max(peak, waiting);
      if (waiting === (scenario === 'cancel' ? 2 : 4)) { ready(); if (scenario !== 'cancel') release(); }
      await Promise.race([barrier, new Promise((_, reject) => setTimeout(() => reject(Error('Children did not overlap')), 3000))]);
      waiting--; delta = { role: 'assistant', content: 'Independent finding.' }; }
    else if (++parent === 1) delta = { role: 'assistant', tool_calls: Array.from({ length: scenario === 'cancel' ? 2 : 5 }, (_, index) => ({ index, id: 'delegate-'+index,
      type: 'function', function: { name: 'Agent', arguments: JSON.stringify({ subagent_type: 'general-analyst', prompt: 'Analyze issue '+index,
        description: 'Independent check '+index, run_in_background: false }) } })) };
    else delta = { role: 'assistant', content: 'Four verified checks; the fifth was busy.' };
    const chunk = (delta: object, finish: string | null) => `data: ${JSON.stringify({ id: 'parallel', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
    return new Response(chunk(delta, null)+chunk({}, 'tool_calls' in delta ? 'tool_calls' : 'stop')+'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
  }); deferCleanup(() => server.stop());
  let extensions: import('@flowmate/contracts').ExtensionRef[] = [];
  const app: Application = need(await createApplication({ paths, resourceRoot: resolve(import.meta.dir, '../../../resources'),
    resourceDefaults: () => ok({ revision: 1, selection: { prompt: null, enabledSkills: [] }, extensions: { enabledExtensions: extensions } }),
    agentFactory: (tools, resourceContents) => {
      return new PiAgentAdapter({ cwd: paths.runtimeDir, agentDir: paths.runtimeDir, tools, resourceContents,
        credentials: new InMemoryCredentialStore(), runtimeApiKey: 'controlled-only' });
    } })); deferCleanup(() => app.close());
  extensions = need(await app.listExtensions()).items.filter(item => item.ref.id === 'subagents').map(item => item.ref);
  const session = need(await app.createSession());
  let runtime: RuntimeService | undefined;
  const prepare = RuntimeService.prototype.prepareSubagent;
  RuntimeService.prototype.prepareSubagent = function (...args) { runtime = this; return prepare.apply(this, args); };
  deferCleanup(() => { RuntimeService.prototype.prepareSubagent = prepare; });
  const workspace = scenario === 'workspace' ? need(await app.updateWorkspace({ expectedRevision: 0,
    change: { kind: 'session', sessionId: session.sessionId } })) : null;
  let finish!: (event: Extract<import('@flowmate/contracts').AgentRunEvent, { type: 'run_finished' }>) => void;
  const done = new Promise<Extract<import('@flowmate/contracts').AgentRunEvent, { type: 'run_finished' }>>(resolve => finish = resolve);
  const accepted = need(await app.submitInput({ sessionId: session.sessionId, clientSequence: 1, mode: 'prompt', text: 'Run independent checks concurrently.',
    ...(workspace ? { workspace: { revision: workspace.revision, sessionId: session.sessionId, documentRef: workspace.documentRef,
      jobId: workspace.jobId, candidateRef: workspace.candidateRef } } : {}),
    config: { version: 1, name: 'parallel', revision: 1, modelRef: { provider: 'parallel', model: 'parallel' },
      native: { authPath: join(root, 'auth.json'), modelsPath: null },
      connection: { baseUrl: `http://127.0.0.1:${server.port}/v1`, api: 'openai-completions', contextWindow: 64000, maxTokens: 16000 }, parameters: { maxRetries: 0, maxRetryDelayMs: 100 } },
    timeoutMs: 12000, budget: { maxModelCalls: 8, maxToolCalls: 8 } }, { onEvent: event => { if (event.type === 'run_finished') finish(event); } }));
  if (scenario === 'cancel') {
    await started;
    const active = need(await app.listSubagents({ parentRunId: accepted.runId, parentSessionId: session.sessionId })).items;
    expect(active).toHaveLength(2);
    need(await app.cancelSubagent({ parentRunId: accepted.runId, childRunId: active[0]!.childRunId }));
    const remaining = need(await app.listSubagents({ parentRunId: accepted.runId, parentSessionId: session.sessionId })).items;
    expect(remaining.find(item => item.childRunId === active[1]!.childRunId)?.cancelRequestedAt).toBeNull();
    need(await app.cancelRun(accepted.runId)); release();
  }
  const completion = need((await done).result);
  expect(completion.status).toBe(scenario === 'cancel' ? 'cancelled' : 'completed');
  const children = need(await app.listSubagents({ parentRunId: accepted.runId, parentSessionId: session.sessionId }));
  const count = scenario === 'cancel' ? 2 : 4;
  expect(peak).toBe(count); expect(children.items).toHaveLength(count); expect(new Set(children.items.map(item => item.childNativeSessionId)).size).toBe(count);
  expect(children.items.every(item => item.status === (scenario === 'cancel' ? 'cancelled' : 'completed') && item.stoppedAt !== null)).toBe(true);
  expect(runtime && Reflect.get(runtime, 'childSlots').size).toBe(0);
  expect(payloads.filter(item => item.messages[0]?.content.startsWith('Analyze the task')).every(item => !item.tools?.length)).toBe(true);
  expect(payloads[0].messages[0].content).toContain('general-analyst');
});
