import { expect, test } from 'bun:test';
import { InMemoryCredentialStore } from '@earendil-works/pi-ai';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createApplication } from '../../apps/composition.ts';
import { PiAgentAdapter } from '../../packages/runtime-pi/src/session.ts';
import type { AgentRunEvent, TraceBundle } from '@flowmate/contracts';
import { deferCleanup, mkdtempSync } from '../support/resources.ts';

test.each(['reported', 'missing', 'provider-error'] as const)('committed product completion preserves actual SDK I/O and %s usage', async mode => {
  const root = mkdtempSync(join(tmpdir(), 'flowmate-capture-integration-'));
  const paths = { root, databaseFile: join(root, 'data/app.sqlite'), artifactsDir: join(root, 'artifacts'),
    outputsDir: join(root, 'outputs'), logsDir: join(root, 'logs'), runtimeDir: join(root, 'runtime') };
  const payloads: unknown[] = [], traces: TraceBundle[] = [];
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: async request => {
    payloads.push(await request.json());
    if (mode === 'provider-error') return Response.json({ error: { message: 'Controlled provider rejection' } }, { status: 400 });
    const chunk = (delta: unknown, finish_reason: string | null) => 'data: ' + JSON.stringify({ id: 'capture-response',
      model: 'capture-fixture', choices: [{ index: 0, delta, finish_reason }] }) + '\n\n';
    const usage = mode === 'reported' ? 'data: ' + JSON.stringify({ id: 'capture-response', model: 'capture-fixture', choices: [],
      usage: { prompt_tokens: 23, completion_tokens: 7, total_tokens: 30, prompt_tokens_details: { cached_tokens: 5 } } }) + '\n\n' : '';
    return new Response(chunk({ role: 'assistant', content: '资料金额是 12.00。' }, null) + chunk({}, 'stop') + usage + 'data: [DONE]\n\n',
      { headers: { 'content-type': 'text/event-stream' } });
  } });
  deferCleanup(() => server.stop(true));
  const opened = await createApplication({ paths, traceCapture: { workspaceRoot: root, enabled: () => true,
    secrets: () => ['capture-secret'], onComplete: trace => traces.push(trace) },
    agentFactory: (tools, resourceContents, observeModel) => new PiAgentAdapter({ tools, resourceContents, observeModel,
      cwd: paths.runtimeDir, agentDir: paths.runtimeDir, credentials: new InMemoryCredentialStore(), runtimeApiKey: 'capture-secret' }) });
  if (!opened.ok) throw Error(opened.error.code);
  deferCleanup(() => opened.data.close());
  const session = await opened.data.createSession({ title: 'Real capture adapter' });
  if (!session.ok) throw Error(session.error.code);
  let finish!: () => void;
  const completed = new Promise<void>(resolve => { finish = resolve; });
  const started = await opened.data.startRun({ sessionId: session.data.sessionId, text: '  资料金额：12.00，请回答。\n',
    config: { version: 1, name: 'Capture fixture', revision: 1, modelRef: { provider: 'capture-fixture', model: 'capture-fixture' },
      native: { authPath: join(root, 'unused-auth.json'), modelsPath: null },
      connection: { baseUrl: `http://127.0.0.1:${server.port}/v1`, api: 'openai-completions', contextWindow: 64000, maxTokens: 16384 },
      parameters: { maxRetries: 0, maxRetryDelayMs: 1000 } } }, { onEvent(event: AgentRunEvent) { if (event.type === 'run_finished') finish(); } });
  if (!started.ok) throw Error(started.error.code);
  await completed;
  await new Promise(resolve => setTimeout(resolve, 20));
  expect(payloads).toHaveLength(1);
  expect(traces).toHaveLength(1);
  expect(traces[0]!.entry).toBe('chats');
  expect(traces[0]!.source.productRoot).toBe(root);
  expect(traces[0]!.input.prompt).toBe('  资料金额：12.00，请回答。\n');
  expect(traces[0]!.input.turns).toBeUndefined();
  expect(traces[0]!.events).toHaveLength(1);
  expect(traces[0]!.events[0]).toMatchObject({ kind: 'generation', input: payloads[0], output: { stopReason: mode === 'provider-error' ? 'error' : 'stop' } });
  const generation = traces[0]!.events[0] as Record<string, unknown>;
  if (mode === 'reported') {
    // Pi separates cached input from its input counter; preserve that actual SDK contract.
    expect(generation.usage).toEqual({ input: 18, output: 7, cacheRead: 5, totalTokens: 30 });
    expect(generation.parameters).toMatchObject({ usageSource: 'sdk' });
  } else {
    expect(generation.usage).toBeUndefined();
    expect(generation.parameters).toMatchObject({ usageSource: 'unknown' });
  }
  expect(traces[0]!.complete, JSON.stringify(traces[0]!.gaps)).toBe(true);
  expect(JSON.stringify(traces[0])).not.toContain('capture-secret');
}, 15000);
