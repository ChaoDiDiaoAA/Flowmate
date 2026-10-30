import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { createDatabaseCoordinator } from '@flowmate/core';
import { ok, type ProviderConfig, type Result } from '@flowmate/contracts';
import { createDurableRuntime } from '../../packages/runtime-durable/src/runtime.ts';
import { createDurableSqliteStorage } from '../../packages/runtime-durable/src/storage.ts';

function need<T>(result: Result<T>): T { if (!result.ok) throw Error(result.error.code); return result.data; }
async function bounded<T>(promise: Promise<T>, stage = 'native submission'): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(Error(`${stage} did not settle.`)), 1500); })]); }
  finally { if (timer !== undefined) clearTimeout(timer); }
}
const owner = { workId: 7, sessionId: 70, attemptId: 700 }, query = { ...owner, requestId: 'original-submission' };
function config(port: number): ProviderConfig { return { version: 1, name: 'submission-barrier', revision: 1,
  modelRef: { provider: 'controlled-barrier', model: 'barrier-model' }, native: { authPath: 'unused-auth.json', modelsPath: null },
  connection: { api: 'openai-completions', baseUrl: `http://127.0.0.1:${port}/v1`, contextWindow: 64000, maxTokens: 8192 },
  parameters: { maxRetries: 0, maxRetryDelayMs: 1000 } }; }
function answer(): Response {
  const chunk = { id: 'barrier', object: 'chat.completion.chunk', created: 1, model: 'barrier-model',
    choices: [{ index: 0, delta: { role: 'assistant', content: 'Original input finished.' }, finish_reason: 'stop' }] };
  return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } });
}

test.each(['unopened', 'opened', 'reopened'] as const)('a never-submitted native scope proves not-started without model authorization: %s', async state => {
  const coordinator = createDatabaseCoordinator(new Database(':memory:')); let requests = 0, reservations = 0, keys = 0;
  const server = Bun.serve({ port: 0, fetch: () => { requests++; return answer(); } });
  const options = { readApiKey: () => { keys++; return 'synthetic-key'; }, verifyModelUse: () => { throw Error('Stop must not request model authorization.'); },
    reserveModelRequest: () => { reservations++; return ok(undefined); } };
  let runtime = need(await createDurableRuntime({ ...options, storage: await createDurableSqliteStorage(coordinator) }));
  const input = { ...query, text: 'Never submitted.', config: config(server.port!) };
  try {
    if (state !== 'unopened') {
      need(await runtime.prepareModel({ ...query, config: input.config }));
      need(await runtime.openConversation({ workId: owner.workId, sessionId: owner.sessionId }));
    }
    if (state === 'reopened') { need(await runtime.close()); runtime = need(await createDurableRuntime({ ...options, storage: await createDurableSqliteStorage(coordinator) })); }
    expect(need(await runtime.stopAttempt({ ...owner, stopGraceMs: 1000 }))).toEqual({ ...owner, stopped: true, reason: 'not-started' });
    expect(need(await runtime.getSubmission(query))).toBeNull();
    expect(await runtime.submit(input)).toMatchObject({ ok: false, error: { code: 'state_conflict' } });
    expect(need(await runtime.stopAttempt({ ...owner, stopGraceMs: 1000 })).reason).toBe('not-started');
    expect(requests).toBe(0); expect(reservations).toBe(0); expect(keys).toBe(0);
  } finally { need(await runtime.close()); await coordinator.close(); server.stop(true); }
});

test('a foreign owner cannot borrow an existing attempt identity to stop or gate its original input', async () => {
  const coordinator = createDatabaseCoordinator(new Database(':memory:')); let requests = 0;
  const server = Bun.serve({ port: 0, fetch: () => { requests++; return answer(); } });
  const runtime = need(await createDurableRuntime({ storage: await createDurableSqliteStorage(coordinator), readApiKey: () => 'synthetic-key',
    verifyModelUse: () => ok(undefined), reserveModelRequest: () => ok(undefined) }));
  const input = { ...query, text: 'The original owner is still admitted.', config: config(server.port!) };
  try {
    need(await runtime.prepareModel({ ...query, config: input.config }));
    need(await runtime.openConversation({ workId: owner.workId, sessionId: owner.sessionId }));
    need(await runtime.openConversation({ workId: 8, sessionId: 80 }));
    expect(await runtime.stopAttempt({ workId: 8, sessionId: 80, attemptId: owner.attemptId, stopGraceMs: 1000 }))
      .toMatchObject({ ok: false, error: { code: 'state_conflict' } });
    need(await runtime.submit(input)); expect(need(await runtime.waitForSubmission(query)).status).toBe('done'); expect(requests).toBe(1);
  } finally { need(await runtime.close()); await coordinator.close(); server.stop(true); }
});

test.each(['verification', 'configuration', 'native-input'] as const)('stop drains the original %s submission boundary before proving whether it started', async boundary => {
  const coordinator = createDatabaseCoordinator(new Database(':memory:'));
  const storage = await createDurableSqliteStorage(coordinator), commit = storage.commit.bind(storage);
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  let held = false, armed = false, requests = 0, reservations = 0;
  const inputIds = new Set<number>();
  storage.commit = async (batch, context) => {
    const nativeInput = batch.some(write => write.type === 'submission' && write.value.type === 'input');
    const configuration = batch.some(write => write.type === 'document.change'
      || (write.type === 'document.create' || write.type === 'document.copy') && write.record.kind === 'pi.agent');
    const seq = await commit(batch, context);
    for (const write of batch) if (write.type === 'submission' && write.value.type === 'input') inputIds.add(write.value.id);
    if (armed && !held && (boundary === 'native-input' && nativeInput || boundary === 'configuration' && configuration)) {
      held = true; entered.resolve(); await release.promise;
    }
    return seq;
  };
  const server = Bun.serve({ port: 0, fetch: () => { requests++; return answer(); } });
  const runtime = need(await createDurableRuntime({ storage, readApiKey: () => 'synthetic-key', verifyModelUse: async () => {
    if (boundary === 'verification' && !held) { held = true; entered.resolve(); await release.promise; }
    return ok(undefined);
  }, reserveModelRequest: () => { reservations++; return ok(undefined); } }));
  const input = { ...query, text: 'Submit this original input once.', config: config(server.port!) };
  try {
    need(await runtime.prepareModel({ ...query, config: input.config }));
    need(await runtime.openConversation({ workId: owner.workId, sessionId: owner.sessionId }));
    armed = true; const submitting = runtime.submit(input); await bounded(entered.promise, `enter ${boundary}`);
    expect(need(await bounded(runtime.stopAttempt({ ...owner, stopGraceMs: 10 }), `stop pending ${boundary}`)))
      .toMatchObject({ stopped: false, reason: 'stop-unconfirmed' });
    const later = await bounded(runtime.submit({ ...input, requestId: 'must-not-enter-after-stop' }), `reject later ${boundary}`);
    expect(later).toMatchObject({ ok: false, error: { code: 'state_conflict' } });
    release.resolve(); expect(await bounded(submitting, `settle original ${boundary}`)).toMatchObject({ ok: false });
    const stopped = need(await bounded(runtime.stopAttempt({ ...owner, stopGraceMs: 1000 }), `stop settled ${boundary}`));
    expect(stopped).toEqual({ ...owner, stopped: true, reason: boundary === 'native-input' ? 'stopped' : 'not-started' });
    const original = need(await runtime.getSubmission(query));
    if (boundary === 'native-input') expect(original).toMatchObject({ status: 'unanswered' });
    else expect(original).toBeNull();
    expect(inputIds.size).toBe(boundary === 'native-input' ? 1 : 0); expect(requests).toBe(0); expect(reservations).toBe(0);
    expect(need(await runtime.getSubmission({ ...query, requestId: 'must-not-enter-after-stop' }))).toBeNull();
  } finally { release.resolve(); storage.commit = commit; need(await runtime.close()); await coordinator.close(); server.stop(true); }
}, 10_000);
