import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { InMemoryCredentialStore } from '@earendil-works/pi-ai';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { openDatabase } from '@flowmate/core';
import { type TraceBundle, type CompactionObservation } from '@flowmate/contracts';
import { createApplication } from '../../apps/composition.ts';
import { PiAgentAdapter } from '../../packages/runtime-pi/src/session.ts';
import { createHttpProvider, mkdtempSync, waitFor } from '../support/resources.ts';

test('composition records a real manual SDK summary and saved operation without a business Run', async () => {
  const root = mkdtempSync(join(tmpdir(), 'flowmate-manual-trace-'));
  const paths = { root, databaseFile: join(root, 'data/app.sqlite'), runtimeDir: join(root, 'runtime'), logsDir: join(root, 'logs'),
    artifactsDir: join(root, 'artifacts'), outputsDir: join(root, 'outputs') };
  const store = openDatabase(paths); if (!store.ok) throw Error(store.error.message);
  const native = SessionManager.inMemory(root), at = '2026-10-28T01:00:00Z';
  for (let index = 0; index < 4; index++) {
    native.appendMessage({ role: 'user', content: 'Original native history ' + index + ' ' + 'x'.repeat(45000), timestamp: index * 2 + 1 });
    native.appendMessage({ role: 'assistant', content: [{ type: 'text', text: 'Original native reply.' }], api: 'openai-completions', provider: 'manual-fixture', model: 'manual-fixture',
      timestamp: index * 2 + 2, stopReason: 'stop', usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
  }
  const created = await store.data.transaction(db => db.sessions.create({ nativeSessionId: native.getSessionId(), title: 'Native maintenance', at,
    nativeHistory: { storageVersion: 1, header: native.getHeader()!, entries: native.getEntries().map(value => ({ ...value })), leafId: native.getLeafId(), unusable: false } }));
  if (!created.ok) throw Error(created.error.message);
  const current = await store.data.read(db => db.sessions.loadHistoryForContext(created.data.sessionId)); if (!current.ok) throw Error(current.error.message);
  await store.data.close();
  const payloads: unknown[] = [], traces: TraceBundle[] = [], observations: CompactionObservation[] = [];
  const server = await createHttpProvider(async request => {
    payloads.push(await request.json());
    const chunk = (delta: unknown, finish: string | null) => 'data: ' + JSON.stringify({ id: 'native-summary', model: 'manual-fixture', choices: [{ index: 0, delta, finish_reason: finish }] }) + '\n\n';
    const usage = 'data: ' + JSON.stringify({ id: 'native-summary', model: 'manual-fixture', choices: [],
      usage: { prompt_tokens: 41, completion_tokens: 9, total_tokens: 50, prompt_tokens_details: { cached_tokens: 6 } } }) + '\n\n';
    return new Response(chunk({ role: 'assistant', content: 'Actual native maintenance summary.' }, null) + chunk({}, 'stop') + usage + 'data: [DONE]\n\n',
      { headers: { 'content-type': 'text/event-stream' } });
  });
  const opened = await createApplication({ paths, traceCapture: { workspaceRoot: root, enabled: () => true, onComplete: trace => traces.push(trace) },
    observeCompaction: value => observations.push(value), agentFactory: (tools, resourceContents, observeModel) => new PiAgentAdapter({ tools, resourceContents, observeModel,
      cwd: root, agentDir: root, credentials: new InMemoryCredentialStore(), runtimeApiKey: 'controlled-manual-key' }) });
  if (!opened.ok) throw Error(opened.error.message);
  try {
    const operationId = randomUUID();
    const started = await opened.data.compactSession({ sessionId: created.data.sessionId, operationId, expected: current.data.commit!, config: {
      version: 1, name: 'Manual fixture', revision: 1, modelRef: { provider: 'manual-fixture', model: 'manual-fixture' },
      native: { authPath: join(root, 'unused.json'), modelsPath: null }, connection: { api: 'openai-completions', baseUrl: `http://127.0.0.1:${server.port}/v1`, contextWindow: 64000, maxTokens: 16384 },
      parameters: { maxRetries: 0, maxRetryDelayMs: 100 } } });
    if (!started.ok) throw Error(started.error.code + ': ' + started.error.message);
    expect(started.ok).toBe(true);
    await waitFor(async () => { const value = await opened.data.querySessionCompaction({ sessionId: created.data.sessionId, operationId });
      return value.ok && value.data.operation?.phase === 'ended' && value.data.operation.stopped; });
    expect(payloads).toHaveLength(1); expect(traces).toHaveLength(1);
    expect(traces[0]).toMatchObject({ complete: true, configuration: { purpose: 'native-maintenance' }, source: { productRoot: root, operationId, sessionId: String(created.data.sessionId) } });
    expect(traces[0]!.source.runId).toBeUndefined(); expect(JSON.parse(traces[0]!.input.prompt)).toEqual(payloads[0]);
    expect(traces[0]!.events[0]).toMatchObject({ kind: 'generation', input: payloads[0], output: { content: [{ type: 'text', text: 'Actual native maintenance summary.' }] } });
    expect(traces[0]!.events[0]).toMatchObject({ usage: { input: 35, output: 9, cacheRead: 6, totalTokens: 50 }, parameters: { usageSource: 'sdk' } });
    expect(observations.at(-1)).toMatchObject({ operationId, generated: true, stopped: true, saved: { leafId: expect.any(String) } });
    const runs = await opened.data.listSessionRuns({ sessionId: created.data.sessionId, limit: 20 });
    expect(runs).toMatchObject({ ok: true, data: { items: [] } });
  } finally { await opened.data.close(); await server.stop(); }
}, 15000);
