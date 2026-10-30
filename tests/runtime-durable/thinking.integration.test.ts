import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { MemoryStorage } from '@earendil-works/pi-durable';
import { ok, type ProviderConfig, type Result } from '@flowmate/contracts';
import { createDatabaseCoordinator } from '@flowmate/core';
import { createDurableRuntime } from '../../packages/runtime-durable/src/runtime.ts';
import { createDurableSqliteStorage } from '../../packages/runtime-durable/src/storage.ts';

function need<T>(value: Result<T>): T { if (!value.ok) throw Error(value.error.code); return value.data; }
const owner = { workId: 7, sessionId: 70, attemptId: 700 };
function config(port: number, reasoning = true): ProviderConfig { return { version: 1, name: 'thinking-profile', revision: 1,
  modelRef: { provider: 'controlled-thinking', model: 'thinking-model' }, native: { authPath: 'unused-auth.json', modelsPath: null },
  connection: { api: 'openai-completions', baseUrl: `http://127.0.0.1:${port}/v1`, contextWindow: 64_000, maxTokens: 8192, reasoning },
  parameters: { maxRetries: 0, maxRetryDelayMs: 1000 } }; }
function answer(): Response {
  const chunk = { id: 'thinking', object: 'chat.completion.chunk', created: 1, model: 'thinking-model',
    choices: [{ index: 0, delta: { role: 'assistant', content: 'Original thinking level used.' }, finish_reason: 'stop' }] };
  return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } });
}

test('native submit configures the requested thinking level and rejects changes to its original intent', async () => {
  const seen: Array<Record<string, unknown>> = [];
  const server = Bun.serve({ port: 0, fetch: async request => { seen.push(await request.json() as Record<string, unknown>); return answer(); } });
  const runtime = need(await createDurableRuntime({ storage: new MemoryStorage(), readApiKey: () => 'synthetic-key',
    verifyModelUse: () => ok(undefined), reserveModelRequest: () => ok(undefined) }));
  const high = { ...owner, requestId: 'high-phase' }, omitted = { ...owner, requestId: 'legacy-off' };
  try {
    need(await runtime.openConversation({ workId: owner.workId, sessionId: owner.sessionId }));
    const input = { ...high, text: 'Use the frozen Work thinking level.', thinkingLevel: 'high' as const, config: config(server.port!) };
    const submitted = need(await runtime.submit(input));
    expect(need(await runtime.waitForSubmission(high)).status).toBe('done');
    expect(seen[0]?.reasoning_effort).toBe('high');
    expect(need(await runtime.submit(input)).nativeSubmissionId).toBe(submitted.nativeSubmissionId);
    expect(await runtime.submit({ ...input, thinkingLevel: 'off' })).toMatchObject({ ok: false, error: { code: 'state_conflict' } });
    need(await runtime.submit({ ...omitted, text: 'An omitted level remains off.', config: config(server.port!) }));
    expect(need(await runtime.waitForSubmission(omitted)).status).toBe('done');
    expect(seen).toHaveLength(2); expect(seen[1]?.reasoning_effort).toBeUndefined();
    const history = need(await runtime.queryHistory({ workId: owner.workId, sessionId: owner.sessionId, limit: 100 }));
    const inputs = history.entries.filter(entry => entry.kind === 'flowmate.input').map(entry => JSON.parse(entry.json).data);
    expect(inputs).toContainEqual(expect.objectContaining({ requestId: high.requestId, thinkingLevel: 'high' }));
    expect(inputs).toContainEqual(expect.objectContaining({ requestId: omitted.requestId, thinkingLevel: 'off' }));
  } finally { need(await runtime.close()); server.stop(true); }
}, 10_000);

test('an unsupported thinking level is rejected before native input, credentials, reservation or transport', async () => {
  let keys = 0, reserved = 0, requests = 0;
  const server = Bun.serve({ port: 0, fetch: () => { requests++; return answer(); } });
  const runtime = need(await createDurableRuntime({ storage: new MemoryStorage(), readApiKey: () => { keys++; return 'synthetic-key'; },
    verifyModelUse: () => ok(undefined), reserveModelRequest: () => { reserved++; return ok(undefined); } }));
  const query = { ...owner, requestId: 'unsupported-high' };
  try {
    need(await runtime.openConversation({ workId: owner.workId, sessionId: owner.sessionId }));
    expect(await runtime.submit({ ...query, thinkingLevel: 'high', text: 'Never silently lower high to off.', config: config(server.port!, false) }))
      .toMatchObject({ ok: false, error: { code: 'provider_thinking_level_unsupported' } });
    expect(need(await runtime.getSubmission(query))).toBeNull();
    expect(keys).toBe(0); expect(reserved).toBe(0); expect(requests).toBe(0);
  } finally { need(await runtime.close()); server.stop(true); }
});

test('SQLite native request recovery preserves its original thinking level and input identity', async () => {
  const coordinator = createDatabaseCoordinator(new Database(':memory:'));
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const seen: Array<Record<string, unknown>> = [];
  const server = Bun.serve({ port: 0, fetch: async request => {
    seen.push(await request.json() as Record<string, unknown>);
    if (seen.length === 1) { entered.resolve(); await release.promise; }
    return answer();
  } });
  const options = { readApiKey: () => 'synthetic-key', verifyModelUse: () => ok(undefined), reserveModelRequest: () => ok(undefined) };
  let runtime = need(await createDurableRuntime({ ...options, storage: await createDurableSqliteStorage(coordinator) }));
  const query = { ...owner, requestId: 'restored-high' }, selected = config(server.port!);
  try {
    const binding = need(await runtime.prepareModel({ ...query, config: selected }));
    need(await runtime.openConversation({ workId: owner.workId, sessionId: owner.sessionId }));
    const submitted = need(await runtime.submit({ ...query, thinkingLevel: 'high', text: 'Restore original reasoning.', config: selected, binding }));
    await entered.promise; need(await runtime.close()); release.resolve();
    runtime = need(await createDurableRuntime({ ...options, storage: await createDurableSqliteStorage(coordinator) }));
    need(await runtime.restoreModel({ ...query, binding }));
    expect(need(await runtime.waitForSubmission(query))).toMatchObject({ nativeSubmissionId: submitted.nativeSubmissionId, status: 'done' });
    expect(seen.map(body => body.reasoning_effort)).toEqual(['high', 'high']);
    const history = need(await runtime.queryHistory({ workId: owner.workId, sessionId: owner.sessionId, limit: 100 }));
    expect(history.entries.filter(entry => entry.kind === 'flowmate.input')).toHaveLength(1);
  } finally { release.resolve(); need(await runtime.close()); await coordinator.close(); server.stop(true); }
}, 15_000);
