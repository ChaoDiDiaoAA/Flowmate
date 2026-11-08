import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { createRegistry, defineTask, defineTool, MemoryStorage } from '@earendil-works/pi-durable';
import { Type } from '@earendil-works/pi-ai';
import { appError, fail, ok, type DurableAttemptIdentity, type ProviderConfig, type Result } from '@flowmate/contracts';
import { createDatabaseCoordinator } from '@flowmate/core';
import * as durable from '@flowmate/runtime-durable';

function need<T>(value: Result<T>): T { if (!value.ok) throw Error(value.error.code); return value.data; }

test('a Work retains a distinct original Durable conversation for each invoice', async () => {
  let authorizations = 0;
  const runtime = need(await durable.createDurableRuntime({ storage: new MemoryStorage(), readApiKey: () => undefined,
    verifyModelUse: () => { authorizations++; return ok(undefined); }, reserveModelRequest: () => ok(undefined) }));
  const owner = { workId: 7, sessionId: 70 }, first = { ...owner, itemId: 101 }, second = { ...owner, itemId: 102 };
  try {
    const opened = await Promise.all([runtime.openConversation(owner), runtime.openConversation(first),
      runtime.openConversation(second), runtime.openConversation(first)]);
    const root = need(opened[0]!), a = need(opened[1]!), b = need(opened[2]!);
    expect(a).toEqual(need(opened[3]!));
    expect(new Set([root.nativeConversationId, a.nativeConversationId, b.nativeConversationId]).size).toBe(3);
    expect(need(await runtime.openConversation(owner))).toEqual(root);
    expect(await runtime.openConversation({ workId: 8, sessionId: 70, itemId: 101 })).toMatchObject({ ok: false });
    expect(await runtime.openConversation({ ...owner, itemId: 0 })).toMatchObject({ ok: false, error: { code: 'input_invalid' } });
    expect(authorizations).toBe(0);
  } finally { await runtime.close(); }
});

test('invoice conversations keep their original submissions and history separate within one Work', async () => {
  const requests: string[] = [];
  const server = Bun.serve({ port: 0, fetch: async request => {
    const body = await request.text(); requests.push(body);
    const answer = body.includes('invoice one') ? 'first answer' : 'second answer';
    const chunk = { id: 'item', object: 'chat.completion.chunk', created: 1, model: 'selected-model',
      choices: [{ index: 0, delta: { role: 'assistant', content: answer }, finish_reason: 'stop' }] };
    return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } });
  } });
  const config: ProviderConfig = { version: 1, name: 'item-conversations', revision: 1,
    modelRef: { provider: 'controlled', model: 'selected-model' }, native: { authPath: 'unused-auth.json', modelsPath: null },
    connection: { api: 'openai-completions', baseUrl: `http://127.0.0.1:${server.port}/v1`, contextWindow: 64_000, maxTokens: 8_192 },
    parameters: { maxRetries: 0, maxRetryDelayMs: 1000 } };
  const runtime = need(await durable.createDurableRuntime({ storage: new MemoryStorage(), readApiKey: () => 'synthetic-key',
    verifyModelUse: () => ok(undefined), reserveModelRequest: () => ok(undefined) }));
  const owner = { workId: 7, sessionId: 70, attemptId: 700 }, first = { ...owner, itemId: 101, requestId: 'first' },
    second = { ...owner, itemId: 102, requestId: 'second' };
  try {
    need(await runtime.openConversation({ workId: first.workId, sessionId: first.sessionId, itemId: first.itemId }));
    need(await runtime.openConversation({ workId: second.workId, sessionId: second.sessionId, itemId: second.itemId }));
    const a = need(await runtime.submit({ ...first, text: 'Review invoice one.', config }));
    expect(need(await runtime.waitForSubmission(first))).toMatchObject({ ...first, status: 'done', answer: 'first answer' });
    const b = need(await runtime.submit({ ...second, text: 'Review invoice two.', config }));
    expect(need(await runtime.waitForSubmission(second))).toMatchObject({ ...second, status: 'done', answer: 'second answer' });
    expect(a.nativeConversationId).not.toBe(b.nativeConversationId);
    expect(need(await runtime.getSubmission(first))?.nativeSubmissionId).toBe(a.nativeSubmissionId);
    expect(need(await runtime.getSubmission({ ...first, itemId: second.itemId }))).toBeNull();
    const firstHistory = need(await runtime.queryHistory({ workId: first.workId, sessionId: first.sessionId, itemId: first.itemId, limit: 100 }));
    const secondHistory = need(await runtime.queryHistory({ workId: second.workId, sessionId: second.sessionId, itemId: second.itemId, limit: 100 }));
    expect(firstHistory.entries.some(entry => entry.json.includes('invoice one'))).toBe(true);
    expect(firstHistory.entries.some(entry => entry.json.includes('invoice two'))).toBe(false);
    expect(secondHistory.entries.some(entry => entry.json.includes('invoice two'))).toBe(true);
    const firstPage = need(await runtime.queryHistoryPage({ workId: first.workId, sessionId: first.sessionId, itemId: first.itemId, limit: 100 }));
    const secondPage = need(await runtime.queryHistoryPage({ workId: second.workId, sessionId: second.sessionId, itemId: second.itemId, limit: 100 }));
    expect(firstPage.owner).toMatchObject({ workId: first.workId, sessionId: first.sessionId, itemId: first.itemId, childRunId: null });
    expect(secondPage.owner.itemId).toBe(second.itemId);
    expect(firstPage.entries.some(entry => entry.preview.text.includes('invoice one'))).toBe(true);
    expect(firstPage.entries.some(entry => entry.preview.text.includes('invoice two'))).toBe(false);
    expect(secondPage.entries.some(entry => entry.preview.text.includes('invoice two'))).toBe(true);
    expect(await runtime.queryHistoryEntry({ workId: second.workId, sessionId: second.sessionId, itemId: second.itemId,
      entryId: firstPage.entries[0]!.entryId, throughEntryId: secondPage.throughEntryId })).toMatchObject({ ok: false });
    expect(requests).toHaveLength(2);
  } finally { await runtime.close(); server.stop(true); }
});

test('stopping an attempt stops each of its original invoice conversations', async () => {
  const entered = Promise.withResolvers<void>(); let running = 0;
  const registry = createRegistry();
  registry.install({ name: 'controlled-item-wait', tools: [defineTool({ name: 'wait_for_invoice',
    description: 'Wait for cancellation.', parameters: Type.Object({}), replay: 'safe', execute: async (_args, _api, context) => {
      if (++running === 2) entered.resolve();
      const signal = context.abortSignal;
      if (!signal) throw Error('Missing cancellation signal');
      await new Promise<void>(resolve => { if (signal.aborted) resolve(); else signal.addEventListener('abort', () => resolve(), { once: true }); });
      return { output: [{ type: 'text', text: 'stopped' }] };
    } })] });
  const server = Bun.serve({ port: 0, fetch: () => {
    const chunk = { id: 'item-stop', object: 'chat.completion.chunk', created: 1, model: 'selected-model',
      choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'wait', type: 'function',
        function: { name: 'wait_for_invoice', arguments: '{}' } }] }, finish_reason: 'tool_calls' }] };
    return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } });
  } });
  const config: ProviderConfig = { version: 1, name: 'item-stop', revision: 1,
    modelRef: { provider: 'controlled', model: 'selected-model' }, native: { authPath: 'unused-auth.json', modelsPath: null },
    connection: { api: 'openai-completions', baseUrl: `http://127.0.0.1:${server.port}/v1`, contextWindow: 64_000, maxTokens: 8_192 },
    parameters: { maxRetries: 0, maxRetryDelayMs: 1000 } };
  const runtime = need(await durable.createDurableRuntime({ storage: new MemoryStorage(), registry, readApiKey: () => 'synthetic-key',
    verifyModelUse: () => ok(undefined), reserveModelRequest: () => ok(undefined) }));
  const owner = { workId: 7, sessionId: 70, attemptId: 700 }, first = { ...owner, itemId: 101, requestId: 'first' },
    second = { ...owner, itemId: 102, requestId: 'second' };
  try {
    need(await runtime.openConversation({ workId: owner.workId, sessionId: owner.sessionId, itemId: first.itemId }));
    need(await runtime.openConversation({ workId: owner.workId, sessionId: owner.sessionId, itemId: second.itemId }));
    need(await runtime.submit({ ...first, text: 'First invoice.', config }));
    need(await runtime.submit({ ...second, text: 'Second invoice.', config }));
    await entered.promise;
    expect(need(await runtime.stopAttempt({ ...owner, stopGraceMs: 1000 }))).toMatchObject({ stopped: true, reason: 'stopped' });
    expect(need(await runtime.getSubmission(first))).toMatchObject({ status: 'unanswered' });
    expect(need(await runtime.getSubmission(second))).toMatchObject({ status: 'unanswered' });
  } finally { await runtime.close(); server.stop(true); }
}, 10_000);

test('a restarted Work resumes its original waiting invoice task after another invoice completes', async () => {
  const coordinator = createDatabaseCoordinator(new Database(':memory:'));
  const entered = Promise.withResolvers<void>(), tasks: number[] = [];
  let ready = false, requests = 0;
  const registry = createRegistry();
  registry.install({ name: 'controlled-restart-wait', tools: [defineTool({ name: 'wait_for_approval',
    description: 'Wait for a controlled decision.', parameters: Type.Object({}), replay: 'safe', execute: async (_args, api, context) => {
      tasks.push(api.taskId); entered.resolve();
      if (!ready) await new Promise<void>((_resolve, reject) => {
        const signal = context.abortSignal;
        if (!signal || signal.aborted) reject(Error('stopped'));
        else signal.addEventListener('abort', () => reject(Error('stopped')), { once: true });
      });
      return { output: [{ type: 'text', text: 'approved' }] };
    } })] });
  const server = Bun.serve({ port: 0, fetch: async request => {
    requests++; const body = await request.text();
    const tool = body.includes('invoice one') && !body.includes('approved');
    const delta = tool ? { role: 'assistant', tool_calls: [{ index: 0, id: 'original-approval', type: 'function',
      function: { name: 'wait_for_approval', arguments: '{}' } }] }
      : { role: 'assistant', content: body.includes('invoice one') ? 'first completed' : 'second completed' };
    const chunk = { id: 'item-restart', object: 'chat.completion.chunk', created: 1, model: 'selected-model',
      choices: [{ index: 0, delta, finish_reason: tool ? 'tool_calls' : 'stop' }] };
    return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } });
  } });
  const config: ProviderConfig = { version: 1, name: 'item-restart', revision: 1,
    modelRef: { provider: 'controlled', model: 'selected-model' }, native: { authPath: 'unused-auth.json', modelsPath: null },
    connection: { api: 'openai-completions', baseUrl: `http://127.0.0.1:${server.port}/v1`, contextWindow: 64_000, maxTokens: 8_192 },
    parameters: { maxRetries: 0, maxRetryDelayMs: 1000 } };
  const options = { registry, readApiKey: () => 'synthetic-key', verifyModelUse: () => ok(undefined), reserveModelRequest: () => ok(undefined) };
  const owner = { workId: 7, sessionId: 70, attemptId: 700 }, first = { ...owner, itemId: 101, requestId: 'first' },
    second = { ...owner, itemId: 102, requestId: 'second' };
  let runtime = need(await durable.createDurableRuntime({ ...options, storage: await durable.createDurableSqliteStorage(coordinator) }));
  try {
    need(await runtime.openConversation({ workId: owner.workId, sessionId: owner.sessionId, itemId: first.itemId }));
    need(await runtime.openConversation({ workId: owner.workId, sessionId: owner.sessionId, itemId: second.itemId }));
    const binding = need(await runtime.prepareModel({ ...first, config }));
    const original = need(await runtime.submit({ ...first, text: 'Review invoice one.', config, binding }));
    await entered.promise;
    need(await runtime.submit({ ...second, text: 'Review invoice two.', config }));
    expect(need(await runtime.waitForSubmission(second))).toMatchObject({ status: 'done', answer: 'second completed' });
    need(await runtime.close());
    runtime = need(await durable.createDurableRuntime({ ...options, storage: await durable.createDurableSqliteStorage(coordinator) }));
    need(await runtime.restoreModel({ ...first, binding })); ready = true;
    need(await runtime.resumeAttempt(owner));
    expect(need(await runtime.waitForSubmission(first))).toMatchObject({ nativeSubmissionId: original.nativeSubmissionId,
      nativeConversationId: original.nativeConversationId, status: 'done', answer: 'first completed' });
    expect(tasks).toHaveLength(2); expect(tasks[1]).toBe(tasks[0]); expect(requests).toBe(3);
  } finally { await runtime.close(); await coordinator.close(); server.stop(true); }
}, 15_000);

test('Durable runtime isolates product conversations and model configurations in one Harness without replaying receipt queries', async () => {
  expect(durable.createDurableRuntime).toBeFunction();
  const seen: Array<{ lane: string; model: unknown; content: string }> = [];
  const servers = ['A', 'B'].map(lane => Bun.serve({ port: 0, fetch: async request => {
    const body = await request.json() as { model?: unknown; messages?: unknown };
    seen.push({ lane, model: body.model, content: JSON.stringify(body.messages) });
    const chunk = { id: lane, object: 'chat.completion.chunk', created: 1, model: 'same-model',
      choices: [{ index: 0, delta: { role: 'assistant', content: `answer-${lane}` }, finish_reason: 'stop' }] };
    return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } });
  } }));
  const config = (port: number): ProviderConfig => ({ version: 1, name: 'same-config', revision: 1,
    modelRef: { provider: 'same-provider', model: 'same-model' }, native: { authPath: 'unused-auth.json', modelsPath: null },
    connection: { api: 'openai-completions', baseUrl: `http://127.0.0.1:${port}/v1`, contextWindow: 64_000, maxTokens: 8_192 },
    parameters: { maxRetries: 0, maxRetryDelayMs: 1000 } });
  const grants: DurableAttemptIdentity[] = [];
  const permissionInputs: DurableAttemptIdentity[] = [];
  const runtime = need(await durable.createDurableRuntime({ storage: new MemoryStorage(),
    readApiKey: async () => 'synthetic-runtime-key', verifyModelUse: async identity => { permissionInputs.push(identity); return ok(undefined); },
    reserveModelRequest: async identity => { grants.push(identity); return ok(undefined); } }));
  const a = { workId: 7, sessionId: 70 }, b = { workId: 8, sessionId: 80 };
  const first = { ...a, attemptId: 700, requestId: 'first', text: 'Only lane A.', config: config(servers[0]!.port!) };
  const second = { ...b, attemptId: 800, requestId: 'second', text: 'Only lane B.', config: config(servers[1]!.port!) };
  const firstQuery = { ...a, attemptId: 700, requestId: 'first' }, secondQuery = { ...b, attemptId: 800, requestId: 'second' };
  try {
    const opened = await Promise.all([runtime.openConversation(a), runtime.openConversation(a), runtime.openConversation(b)]);
    expect(need(opened[0]!)).toEqual(need(opened[1]!));
    expect(need(opened[0]!).nativeConversationId).not.toBe(need(opened[2]!).nativeConversationId);
    expect(await runtime.openConversation({ workId: 7, sessionId: 80 })).toMatchObject({ ok: false });
    expect(await runtime.openConversation({ workId: 9, sessionId: 70 })).toMatchObject({ ok: false, error: { code: 'state_conflict' } });
    expect(seen).toEqual([]); expect(grants).toEqual([]);
    const admitted = await Promise.all([runtime.submit(first), runtime.submit(second)]);
    const answers = await Promise.all([runtime.waitForSubmission(firstQuery), runtime.waitForSubmission(secondQuery)]);
    expect(need(answers[0]!)).toMatchObject({ status: 'done', answer: 'answer-A' });
    expect(need(answers[1]!)).toMatchObject({ status: 'done', answer: 'answer-B' });
    expect(seen).toHaveLength(2);
    expect(seen.find(value => value.lane === 'A')?.content).toContain('Only lane A.');
    expect(seen.find(value => value.lane === 'A')?.content).not.toContain('Only lane B.');
    expect(seen.find(value => value.lane === 'B')?.content).toContain('Only lane B.');
    expect(grants).toContainEqual({ ...a, attemptId: 700 }); expect(grants).toContainEqual({ ...b, attemptId: 800 });
    expect(runtime.queryHistory).toBeFunction();
    const permissionCount = permissionInputs.length;
    const history = need(await runtime.queryHistory({ ...a, limit: 100 }));
    expect(history.entries.some(entry => entry.json.includes('Only lane A.'))).toBe(true);
    expect(history.entries.some(entry => entry.json.includes('Only lane B.'))).toBe(false);
    let beforeEntryId: number | undefined;
    const paged: number[] = [];
    do {
      const page = need(await runtime.queryHistory({ ...a, limit: 1, ...(beforeEntryId === undefined ? {} : { beforeEntryId }) }));
      paged.push(...page.entries.map(entry => entry.nativeEntryId));
      beforeEntryId = page.nextBeforeEntryId ?? undefined;
      if (paged.length > 100) throw Error('History cursor did not advance');
    } while (beforeEntryId !== undefined);
    expect(paged).toEqual(history.entries.map(entry => entry.nativeEntryId));
    const foreign = need(await runtime.queryHistory({ ...b, limit: 1 })).entries[0];
    if (!foreign) throw Error('Missing foreign history');
    expect(await runtime.queryHistory({ ...a, beforeEntryId: foreign.nativeEntryId })).toMatchObject({ ok: false, error: { code: 'state_conflict' } });
    expect(await runtime.queryHistory({ ...a, limit: 101 })).toMatchObject({ ok: false, error: { code: 'input_invalid' } });
    expect(permissionInputs).toHaveLength(permissionCount); expect(grants).toHaveLength(2); expect(seen).toHaveLength(2);
    const queried = need(await runtime.getSubmission(firstQuery));
    if (!queried) throw Error('Missing saved submission');
    expect(queried.nativeSubmissionId).toBe(need(admitted[0]!).nativeSubmissionId);
    expect(need(await runtime.submit(first)).nativeSubmissionId).toBe(queried.nativeSubmissionId);
    expect(await runtime.submit({ ...first, text: 'Changed original intent.' })).toMatchObject({ ok: false, error: { code: 'state_conflict' } });
    expect(await runtime.getSubmission({ ...firstQuery, sessionId: 80 })).toMatchObject({ ok: false });
    expect(seen).toHaveLength(2); expect(grants).toHaveLength(2);
    const raced = await Promise.all([
      runtime.submit({ ...first, attemptId: 701, requestId: 'race', text: 'First race input.' }),
      runtime.submit({ ...first, attemptId: 701, requestId: 'race', text: 'Different race input.' }),
    ]);
    expect(raced.filter(value => value.ok)).toHaveLength(1);
    expect(raced.find(value => !value.ok)).toMatchObject({ ok: false, error: { code: 'state_conflict' } });
    expect(need(await runtime.waitForSubmission({ ...a, attemptId: 701, requestId: 'race' }))).toMatchObject({ status: 'done' });
    expect(seen).toHaveLength(3); expect(grants).toHaveLength(3);
    const configInputs = [
      { ...first, attemptId: 702, requestId: 'config-A', config: config(servers[0]!.port!) },
      { ...first, attemptId: 702, requestId: 'config-B', config: config(servers[1]!.port!) },
    ];
    const configs = await Promise.all(configInputs.map(input => runtime.submit(input)));
    expect(configs.filter(value => value.ok)).toHaveLength(1);
    expect(configs.find(value => !value.ok)).toMatchObject({ ok: false, error: { code: 'state_conflict' } });
    for (const [index, result] of configs.entries()) {
      const query = { ...a, attemptId: 702, requestId: configInputs[index]!.requestId };
      if (result.ok) expect(need(await runtime.waitForSubmission(query))).toMatchObject({ status: 'done', answer: index === 0 ? 'answer-A' : 'answer-B' });
      else expect(need(await runtime.getSubmission(query))).toBeNull();
    }
    expect(seen).toHaveLength(4); expect(grants).toHaveLength(4);
    expect(permissionInputs.length).toBeGreaterThan(0);
    for (const identity of permissionInputs) expect(Object.keys(identity).sort()).toEqual(['attemptId', 'sessionId', 'workId']);
  } finally { await runtime.close(); for (const server of servers) server.stop(true); }
}, 15_000);

test('Durable runtime concurrent close waits for the original storage close result', async () => {
  const storage = new MemoryStorage();
  const entered = Promise.withResolvers<void>(), released = Promise.withResolvers<void>();
  const original = storage.close.bind(storage);
  storage.close = async context => { entered.resolve(); await released.promise; return original(context); };
  const runtime = need(await durable.createDurableRuntime({ storage, readApiKey: async () => undefined,
    verifyModelUse: () => ok(undefined), reserveModelRequest: () => ok(undefined) }));
  const first = runtime.close(); await entered.promise;
  let completed = false;
  const second = runtime.close().then(value => { completed = true; return value; });
  try {
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(completed).toBe(false);
  } finally { released.resolve(); }
  expect(await first).toEqual(ok(undefined)); expect(await second).toEqual(ok(undefined));
});

test('Durable runtime returns the product authorization refusal without replacing its code', async () => {
  const refusal = appError('session_scope_revoked', 'session', 'Product authority was withdrawn.');
  const runtime = need(await durable.createDurableRuntime({ storage: new MemoryStorage(), readApiKey: async () => undefined,
    verifyModelUse: () => fail(refusal), reserveModelRequest: () => ok(undefined) }));
  try {
    need(await runtime.openConversation({ workId: 7, sessionId: 70 }));
    const config: ProviderConfig = { version: 1, name: 'denied', revision: 1,
      modelRef: { provider: 'controlled', model: 'selected-model' }, native: { authPath: 'unused-auth.json', modelsPath: null },
      connection: { api: 'openai-completions', baseUrl: 'http://127.0.0.1:1/v1', contextWindow: 64_000, maxTokens: 8_192 },
      parameters: { maxRetries: 0, maxRetryDelayMs: 1000 } };
    expect(await runtime.submit({ workId: 7, sessionId: 70, attemptId: 700, requestId: 'denied', text: 'Review.', config }))
      .toEqual(fail(refusal));
  } finally { await runtime.close(); }
});

test('Durable runtime closes after a fatal original receipt read instead of admitting work on the same Harness', async () => {
  const storage = new MemoryStorage(), original = storage.submissionByRequest.bind(storage);
  const runtime = need(await durable.createDurableRuntime({ storage, readApiKey: async () => undefined,
    verifyModelUse: () => ok(undefined), reserveModelRequest: () => ok(undefined) }));
  try {
    need(await runtime.openConversation({ workId: 7, sessionId: 70 }));
    storage.submissionByRequest = async () => { throw Error('Controlled fatal storage failure'); };
    expect(await runtime.getSubmission({ workId: 7, sessionId: 70, attemptId: 700, requestId: 'lost' })).toMatchObject({ ok: false });
    storage.submissionByRequest = original;
    expect(await runtime.openConversation({ workId: 8, sessionId: 80 }))
      .toMatchObject({ ok: false, error: { code: 'durable_runtime_closed' } });
  } finally { storage.submissionByRequest = original; await runtime.close(); }
});

test('Durable runtime does not confirm stop while its owned tool ignores abort, and never resumes the ended attempt', async () => {
  const entered = Promise.withResolvers<void>(), released = Promise.withResolvers<void>();
  let requests = 0, allowed = true;
  const server = Bun.serve({ port: 0, fetch: () => {
    requests++;
    const chunk = { id: 'controlled-stop', object: 'chat.completion.chunk', created: 1, model: 'selected-model',
      choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'waiting-tool', type: 'function',
        function: { name: 'wait_for_evidence', arguments: '{}' } }] }, finish_reason: 'tool_calls' }] };
    return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } });
  } });
  const registry = createRegistry();
  registry.install({ name: 'controlled-wait', tools: [defineTool({ name: 'wait_for_evidence', description: 'Wait for controlled evidence.',
    parameters: Type.Object({}), replay: 'unsafe', execute: async () => { entered.resolve(); await released.promise;
      return { output: [{ type: 'text', text: 'Original evidence.' }] }; } })] });
  const runtime = need(await durable.createDurableRuntime({ storage: new MemoryStorage(), registry,
    readApiKey: async () => 'synthetic-key', verifyModelUse: () => allowed ? ok(undefined) : fail(appError('session_scope_revoked', 'session', 'Stopped.')),
    reserveModelRequest: () => ok(undefined) }));
  const identity = { workId: 7, sessionId: 70, attemptId: 700 };
  const config: ProviderConfig = { version: 1, name: 'stop-owned-tool', revision: 1,
    modelRef: { provider: 'controlled', model: 'selected-model' }, native: { authPath: 'unused-auth.json', modelsPath: null },
    connection: { api: 'openai-completions', baseUrl: `http://127.0.0.1:${server.port}/v1`, contextWindow: 64_000, maxTokens: 8_192 },
    parameters: { maxRetries: 0, maxRetryDelayMs: 1000 } };
  try {
    need(await runtime.openConversation({ workId: 7, sessionId: 70 }));
    need(await runtime.submit({ ...identity, requestId: 'waiting', text: 'Wait for evidence.', config }));
    await entered.promise;
    expect(await runtime.resumeAttempt(identity)).toEqual(ok(undefined)); expect(requests).toBe(1);
    allowed = false;
    expect(need(await runtime.stopAttempt({ ...identity, stopGraceMs: 50 }))).toMatchObject({ stopped: false, reason: 'stop-unconfirmed' });
    expect(await runtime.resumeAttempt(identity)).toMatchObject({ ok: false });
    expect(requests).toBe(1); released.resolve();
    expect(need(await runtime.stopAttempt({ ...identity, stopGraceMs: 1000 }))).toMatchObject({ stopped: true, reason: 'stopped' });
    expect(await runtime.getSubmission({ ...identity, requestId: 'waiting' })).toMatchObject({ ok: true, data: { status: 'unanswered' } });
    expect(await runtime.resumeAttempt(identity)).toMatchObject({ ok: false }); expect(requests).toBe(1);
  } finally { released.resolve(); await runtime.close(); server.stop(true); }
}, 10_000);

test.each(['conversation', 'owned-conversation', 'late-conversation'] as const)('Durable stop preserves owned work and rejects later admission: %s', async scope => {
  const entered = Promise.withResolvers<void>(), released = Promise.withResolvers<void>();
  const beforeCreate = Promise.withResolvers<void>(), allowCreate = Promise.withResolvers<void>();
  const storage = new MemoryStorage(), admission = Promise.withResolvers<boolean>();
  const background = defineTask<Record<string, never>, { phase: 'wait' }, null>({ name: 'test.background-evidence', version: 1,
    initial: () => ({ phase: 'wait' }), phases: { wait: async (_task, runtime, context) => {
      entered.resolve(); await released.promise;
      await runtime.commit(() => ({ status: 'terminal', outcome: { status: 'completed', result: null } }), context);
    } }, abort: (_task, runtime, context) => runtime.commit(() => ({ status: 'terminal', outcome: { status: 'aborted' } }), context) });
  let requests = 0;
  const server = Bun.serve({ port: 0, fetch: () => {
    requests++;
    const chunk = { id: 'controlled-background', object: 'chat.completion.chunk', created: 1, model: 'selected-model',
      choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'background-tool', type: 'function',
        function: { name: 'start_background_evidence', arguments: '{}' } }] }, finish_reason: 'tool_calls' }] };
    return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } });
  } });
  const registry = createRegistry();
  registry.install({ name: 'controlled-background', tasks: [background], tools: [defineTool({ name: 'start_background_evidence',
    description: 'Start a controlled owned background task.', parameters: Type.Object({}), replay: 'safe', execute: async (_args, api, context) => {
      if (scope === 'late-conversation') { beforeCreate.resolve(); await allowCreate.promise; }
      try {
        if (scope === 'conversation' || scope === 'late-conversation') await api.createTask(background, {}, { ownership: { kind: 'conversation' }, background: true },
          scope === 'late-conversation' ? BACKGROUND_CONTEXT : context);
        else await api.commit(async tx => {
          const child = await tx.createConversation({ ownership: { kind: 'task', taskId: api.taskId } });
          await tx.createTask(background, {}, { conversationId: child.id, ownership: { kind: 'conversation' }, background: true });
        }, context);
      } catch (error) { admission.resolve(false); throw error; }
      admission.resolve(true);
      return { output: [{ type: 'text', text: 'Original task started.' }], control: { terminate: true } };
    } })] });
  const runtime = need(await durable.createDurableRuntime({ storage, registry, readApiKey: () => 'synthetic-key',
    verifyModelUse: () => ok(undefined), reserveModelRequest: () => ok(undefined) }));
  const identity = { workId: 7, sessionId: 70, attemptId: 700 };
  const query = { ...identity, requestId: 'background' };
  const config: ProviderConfig = { version: 1, name: 'background', revision: 1,
    modelRef: { provider: 'controlled', model: 'selected-model' }, native: { authPath: 'unused-auth.json', modelsPath: null },
    connection: { api: 'openai-completions', baseUrl: `http://127.0.0.1:${server.port}/v1`, contextWindow: 64_000, maxTokens: 8_192 },
    parameters: { maxRetries: 0, maxRetryDelayMs: 1000 } };
  try {
    need(await runtime.openConversation({ workId: 7, sessionId: 70 })); need(await runtime.submit({ ...query, config, text: 'Start.' }));
    if (scope === 'late-conversation') {
      await beforeCreate.promise;
      expect(need(await runtime.stopAttempt({ ...identity, stopGraceMs: 50 })).stopped).toBe(false);
      allowCreate.resolve();
      expect(await admission.promise).toBe(false);
      expect(need(await runtime.stopAttempt({ ...identity, stopGraceMs: 1000 })).stopped).toBe(true);
      expect((await storage.scanTasks({ kind: 'test.background-evidence' }, 1, undefined, BACKGROUND_CONTEXT)).items).toEqual([]);
      expect(await runtime.getSubmission(query)).toMatchObject({ ok: true, data: { status: 'unanswered' } });
      expect(requests).toBe(1);
      return;
    }
    await entered.promise;
    expect(need(await runtime.waitForSubmission(query)).status).toBe('done');
    expect(await runtime.submit({ ...query, attemptId: 701, requestId: 'next-attempt', config, text: 'Start another attempt.' }))
      .toMatchObject({ ok: false, error: { code: 'agent_busy' } });
    expect(need(await runtime.stopAttempt({ ...identity, stopGraceMs: 50 }))).toMatchObject({ stopped: false });
    released.resolve(); expect(need(await runtime.stopAttempt({ ...identity, stopGraceMs: 1000 }))).toMatchObject({ stopped: true });
    expect(requests).toBe(1);
    expect(need(await runtime.getSubmission({ ...identity, attemptId: 701, requestId: 'next-attempt' }))).toBeNull();
    need(await runtime.submit({ ...query, attemptId: 701, requestId: 'next-attempt', config, text: 'Start another attempt.' }));
    expect(need(await runtime.waitForSubmission({ ...identity, attemptId: 701, requestId: 'next-attempt' })).status).toBe('done');
    expect(requests).toBe(2);
  } finally { allowCreate.resolve(); released.resolve(); await runtime.close(); server.stop(true); }
}, 10_000);
