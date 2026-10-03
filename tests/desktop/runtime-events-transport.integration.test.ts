import { expect, it } from 'bun:test';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { Database } from 'bun:sqlite';
import { openDatabase } from '@flowmate/core';
import type { DbHandle } from '@flowmate/core';
import { resolveProductPaths } from '@flowmate/shared';
import type { Result, RuntimeSubscriptionInfo, RuntimeEventsReadResult, RuntimeEventCursor, SafeConfigSnapshot } from '@flowmate/contracts';
import { mkdtemp } from '../support/resources.ts';
import { HostClient } from '../../apps/desktop/main/host-client.ts';
import { drainEventReadQueue, enqueueEventRead } from '../../apps/desktop/renderer/src/event-state.ts';

async function fixture(prepareHost?: (root: string) => void,
  prepareStore?: (store: DbHandle, runId: number, config: SafeConfigSnapshot) => void) {
  const root = await mkdtemp(join(tmpdir(), 'flowmate-p6-transport-'));
  const paths = resolveProductPaths(root);
  if (!paths.ok) throw new Error(paths.error.code);
  const opened = openDatabase(paths.data);
  if (!opened.ok) throw new Error(opened.error.code);
  const at = '2026-10-03T00:00:00.000Z';
  const config: SafeConfigSnapshot = { version: 1, name: 'Offline fixture', revision: 1, requestedModel: { provider: 'fixture', model: 'offline' },
      resolvedModel: { provider: 'fixture', model: 'offline' }, api: 'openai-completions', endpoint: null,
      sdk: { codingAgent: '0.85.1', ai: '0.85.1' }, parameters: { maxRetries: 0, maxRetryDelayMs: 2000 },
      limits: { timeoutMs: 1000, stopGraceMs: 1000 }, native: { authSource: 'unknown', modelsSelection: null } };
  const created = opened.data.runs.create({ goal: 'Observe only', input: { version: 1, goal: 'Observe only', text: 'No model execution', messageTimestamp: Date.parse(at) },
    config,
    usage: { version: 1, source: 'unknown', reason: 'Offline fixture', sdkValues: null, attempts: null,
      attemptsComplete: false, costSource: null, updatedAt: at },
    cleanup: { version: 1, stopped: false, stopReason: null, lateObservationRequired: false, errors: [] }, createdAt: at });
  if (created.ok) prepareStore?.(opened.data, created.data, config);
  opened.data.close();
  if (!created.ok) throw new Error(created.error.code);
  prepareHost?.(root);
  const client = new HostClient();
  expect(await client.start(root, '0.1.0', prepareHost ? root : resolve(import.meta.dir, '../..'))).toMatchObject({ ok: true });
  const input = { runId: created.data, sessionId: null, cursor: { runId: created.data, lastPersistedSequence: 0 } };
  return { client, input, root };
}

// Reflect.apply keeps the first RED an actual missing Host response, not a TypeScript setup error.
const request = (client: HostClient, command: unknown): Promise<unknown> => Reflect.apply(client.request, client, [command]);

it('P6 real Host opens, reads and releases an owned observation without executing a model', async () => {
  const { client, input } = await fixture();
  const subscriptionId = randomUUID(), ownerToken = 'owner-a';
  try {
    const opened = await request(client, { type: 'subscribe_runtime_events', ownerToken, subscriptionId, input }) as Result<RuntimeSubscriptionInfo>;
    expect(opened).toMatchObject({ ok: true, data: { subscriptionId, runId: input.runId, sessionId: null } });
    expect(await request(client, { type: 'query_runtime_events', ownerToken, input: { ...input, subscriptionId } }))
      .toMatchObject({ ok: true, data: { runId: input.runId, sessionId: null } });
    expect(await request(client, { type: 'unsubscribe_runtime_events', ownerToken: 'owner-b', subscriptionId }))
      .toMatchObject({ ok: false, error: { code: 'event_subscription_invalid', category: 'input', retryable: false } });
    expect(await request(client, { type: 'unsubscribe_runtime_events', ownerToken, subscriptionId })).toMatchObject({ ok: true });
    expect(await request(client, { type: 'unsubscribe_runtime_events', ownerToken, subscriptionId })).toMatchObject({ ok: true });
    expect(await request(client, { type: 'query_runtime_events', ownerToken, input: { ...input, subscriptionId } }))
      .toMatchObject({ ok: false, error: { code: 'event_subscription_invalid' }, context: null });
    expect(await request(client, { type: 'list_run_tool_calls', input: { runId: input.runId, sessionId: null } }))
      .toEqual({ ok: true, data: { items: [], nextBeforeId: null } });
    expect(await request(client, { type: 'query_runtime_events', ownerToken, input: { ...input, cursor: { ...input.cursor, lastPersistedSequence: -1 } } }))
      .toMatchObject({ ok: false, error: { code: 'event_cursor_invalid' } });
    expect(await request(client, { type: 'query_runtime_events', ownerToken, input: { ...input, sessionId: 1 } }))
      .toMatchObject({ ok: false, error: { code: 'event_cursor_invalid' }, context: { runId: input.runId, sessionId: null } });
  } finally { await client.close(); }
}, 15_000);

it('P6 real Host bounds owned capacity, keeps opens idempotent and releases slots', async () => {
  const { client, input } = await fixture();
  const slots: { ownerToken: string; subscriptionId: string }[] = [];
  const open = (ownerToken: string, subscriptionId: string = randomUUID(), value = input) =>
    request(client, { type: 'subscribe_runtime_events', ownerToken, subscriptionId, input: value }) as Promise<Result<RuntimeSubscriptionInfo>>;
  try {
    for (let owner = 0; owner < 8; owner++) for (let count = 0; count < 8; count++) {
      const slot = { ownerToken: `capacity-${owner}`, subscriptionId: randomUUID() };
      expect(await open(slot.ownerToken, slot.subscriptionId)).toMatchObject({ ok: true });
      slots.push(slot);
    }
    const first = slots[0]!;
    expect(await open(first.ownerToken, first.subscriptionId)).toMatchObject({ ok: true, data: { subscriptionId: first.subscriptionId } });
    expect(await open('foreign-owner', first.subscriptionId)).toMatchObject({ ok: false, error: { code: 'event_subscription_invalid' } });
    expect(await open(first.ownerToken, first.subscriptionId, { ...input, cursor: { ...input.cursor, lastPersistedSequence: 1 } }))
      .toMatchObject({ ok: false, error: { code: 'state_conflict', category: 'runtime', retryable: false } });
    expect(await open(first.ownerToken)).toMatchObject({ ok: false, error: { code: 'event_subscription_limit' } });
    expect(await open('ninth-owner')).toMatchObject({ ok: false, error: { code: 'event_subscription_limit' } });
    expect(await request(client, { type: 'unsubscribe_runtime_events', ...first })).toMatchObject({ ok: true });
    expect(await open(first.ownerToken)).toMatchObject({ ok: true });
    // Released IDs cannot be reopened, and an illegal owner did not steal the slot.
    expect(await open(first.ownerToken, first.subscriptionId)).toMatchObject({ ok: false, error: { code: 'event_subscription_invalid' } });
  } finally { expect(await client.close()).toMatchObject({ ok: true, data: { closed: true } }); }
}, 15_000);

it('P6 real Host rejects a duplicate in-flight owner query while another owner can read', async () => {
  const { client, input, root } = await fixture(root => {
    mkdirSync(join(root, 'apps', 'host'), { recursive: true });
    // OS pipe reads may split independent writes across turns after the first query has finished.
    // Batch only the three requested query lines into one real stdin data turn; Host/SQL stay intact.
    writeFileSync(join(root, 'apps', 'host', 'main.ts'), [
      "import fs from 'node:fs'; const emit = process.stdin.emit; let buffered = ''; let batch = [];",
      `const journal = ${JSON.stringify(join(root, 'query-batches.jsonl'))};`,
      "process.stdin.emit = function(event, ...values) { if (event !== 'data' || !Buffer.isBuffer(values[0])) return emit.apply(this, [event, ...values]);",
      " buffered += values[0].toString('utf8'); let newline; while ((newline = buffered.indexOf('\\n')) >= 0) {",
      " const line = buffered.slice(0, newline + 1); buffered = buffered.slice(newline + 1); const command = JSON.parse(line);",
      " if (command.type === 'query_runtime_events' && command.requestId.startsWith('busy-batch-')) { batch.push(line); if (batch.length === 3) {",
      " fs.appendFileSync(journal, JSON.stringify(batch.map(line => JSON.parse(line).requestId)) + '\\n'); const packet = Buffer.from(batch.join('')); batch = []; emit.call(this, 'data', packet); } }",
      " else emit.call(this, 'data', Buffer.from(line)); } return true; };",
      `await import(${JSON.stringify(pathToFileURL(resolve(import.meta.dir, '../../apps/host/main.ts')).href)});`,
    ].join('\n'));
  });
  try {
    for (let round = 0; round < 30; round++) {
      const results = await Promise.all([request(client, { type: 'query_runtime_events', requestId: `busy-batch-${round}-first`, ownerToken: 'busy-owner', input }),
        request(client, { type: 'query_runtime_events', requestId: `busy-batch-${round}-duplicate`, ownerToken: 'busy-owner', input }),
        request(client, { type: 'query_runtime_events', requestId: `busy-batch-${round}-other`, ownerToken: 'another-owner', input })]) as RuntimeEventsReadResult[];
      expect(results[0]).toMatchObject({ ok: true });
      expect(results[1]).toMatchObject({ ok: false, error: { code: 'event_query_busy', category: 'runtime', retryable: true }, context: null });
      expect(results[2]).toMatchObject({ ok: true });
    }
    const batches = readFileSync(join(root, 'query-batches.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
    expect(batches).toEqual(Array.from({ length: 30 }, (_, round) => [
      `busy-batch-${round}-first`, `busy-batch-${round}-duplicate`, `busy-batch-${round}-other`,
    ]));
    // Once a query finishes, the same owner can issue another query in a later turn.
    for (let turn = 0; turn < 2; turn++) expect(await request(client, { type: 'query_runtime_events',
      requestId: `sequential-${turn}`, ownerToken: 'busy-owner', input })).toMatchObject({ ok: true });
  } finally { await client.close(); }
}, 15_000);

it('P6 real Host uses a 90-second native lease and renews only matching subscribed queries, including errors', async () => {
  const { client, input, root } = await fixture(root => {
    mkdirSync(join(root, 'apps', 'host'), { recursive: true });
    // Fault only actual transport bytes and one SQLite read; registrations and native lease clocks stay intact.
    writeFileSync(join(root, 'apps', 'host', 'main.ts'), [
      "import fs from 'node:fs'; import { Database } from 'bun:sqlite';",
      `const marker = ${JSON.stringify(join(root, 'read-failure'))}; const journal = ${JSON.stringify(join(root, 'lease-faults.jsonl'))};`,
      "const query = Database.prototype.query; Database.prototype.query = function(sql, ...values) { if (sql === 'SELECT id,session_id FROM runs WHERE id=?' && fs.existsSync(marker)) { fs.unlinkSync(marker); throw new Error('Controlled SQLite read failure'); } return query.call(this, sql, ...values); };",
      "const write = fs.WriteStream.prototype.write; fs.WriteStream.prototype.write = function(...values) { let packet; try { packet = JSON.parse(String(values[0])); } catch {}",
      " if (this.fd === 1 && packet?.type === 'response' && packet.requestId === 'lease-lost-release-ack') { fs.appendFileSync(journal, JSON.stringify({ fault: 'lost-ack', value: packet.value }) + '\\n'); queueMicrotask(() => values.find(value => typeof value === 'function')?.()); return true; } return write.apply(this, values); };",
      "const emit = process.stdin.emit; let buffered = ''; process.stdin.emit = function(event, ...values) { if (event !== 'data' || !Buffer.isBuffer(values[0])) return emit.apply(this, [event, ...values]);",
      " buffered += values[0].toString('utf8'); let newline; while ((newline = buffered.indexOf('\\n')) >= 0) { const line = buffered.slice(0, newline + 1); buffered = buffered.slice(newline + 1); const command = JSON.parse(line);",
      " if (command.requestId === 'lease-lost-release-request') fs.appendFileSync(journal, JSON.stringify({ fault: 'lost-request', subscriptionId: command.subscriptionId }) + '\\n'); else emit.call(this, 'data', Buffer.from(line)); } return true; };",
      `await import(${JSON.stringify(pathToFileURL(resolve(import.meta.dir, '../../apps/host/main.ts')).href)});`,
    ].join('\n'));
  }, (store, runId, config) => {
    const run = store.runs.get(runId); if (!run.ok) throw new Error(run.error.code);
    const at = '2026-10-03T00:00:01.000Z';
    expect(store.runs.start(runId, config, at)).toMatchObject({ ok: true });
    expect(store.runs.recordCancel(runId, at)).toEqual({ ok: true, data: true });
    expect(store.runs.finish(runId, { status: 'failed', output: null,
      error: { code: 'fixture_stopped', category: 'provider', message: 'Read-only lease fixture.', retryable: false },
      usage: run.data.usage, tokens: run.data.tokens,
      cleanup: { version: 1, stopped: true, stopReason: 'fixture-stop', errors: [], lateObservationRequired: false },
      endedAt: at, stoppedAt: at, durationMs: 1000 })).toEqual({ ok: true, data: true });
    store.db.query('DELETE FROM runtime_events WHERE run_id=? AND sequence=2').run(runId);
  });
  const renewed: string[] = [], expires = randomUUID(), naked = randomUUID(), lostAck = randomUUID(), lostRequest = randomUUID();
  const read = (ownerToken: string, subscriptionId?: string, extra = {}) =>
    request(client, { type: 'query_runtime_events', ownerToken, input: { ...input, ...(subscriptionId ? { subscriptionId } : {}), ...extra } });
  try {
    for (let count = 0; count < 8; count++) {
      const subscriptionId = randomUUID(); renewed.push(subscriptionId);
      expect(await request(client, { type: 'subscribe_runtime_events', ownerToken: 'renewed-owner', subscriptionId, input })).toMatchObject({ ok: true });
    }
    expect(await request(client, { type: 'subscribe_runtime_events', ownerToken: 'expires-owner', subscriptionId: expires, input })).toMatchObject({ ok: true });
    expect(await request(client, { type: 'subscribe_runtime_events', ownerToken: 'naked-owner', subscriptionId: naked, input })).toMatchObject({ ok: true });
    expect(await request(client, { type: 'subscribe_runtime_events', ownerToken: 'lost-ack-owner', subscriptionId: lostAck, input })).toMatchObject({ ok: true });
    expect(await request(client, { type: 'subscribe_runtime_events', ownerToken: 'lost-request-owner', subscriptionId: lostRequest, input })).toMatchObject({ ok: true });
    const startedAt = performance.now();
    await Promise.all([
      expect(client.request({ type: 'unsubscribe_runtime_events', requestId: 'lease-lost-release-ack', ownerToken: 'lost-ack-owner', subscriptionId: lostAck }))
        .rejects.toThrow('host_request_timeout'),
      expect(client.request({ type: 'unsubscribe_runtime_events', requestId: 'lease-lost-release-request', ownerToken: 'lost-request-owner', subscriptionId: lostRequest }))
        .rejects.toThrow('host_request_timeout'),
    ]);
    expect(await read('lost-ack-owner', lostAck)).toMatchObject({ ok: false, error: { code: 'event_subscription_invalid' }, context: null });
    // A release whose request never reached Host remains an orphan; idempotent open does not renew it.
    expect(await request(client, { type: 'subscribe_runtime_events', ownerToken: 'lost-request-owner', subscriptionId: lostRequest, input })).toMatchObject({ ok: true });
    expect(readFileSync(join(root, 'lease-faults.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line)))
      .toEqual(expect.arrayContaining([{ fault: 'lost-ack', value: { ok: true } }, { fault: 'lost-request', subscriptionId: lostRequest }]));
    await new Promise(resolveDelay => setTimeout(resolveDelay, Math.max(0, 80_000 - (performance.now() - startedAt))));
    expect(await read('renewed-owner', renewed[0], { cursor: { ...input.cursor, lastPersistedSequence: 1 } }))
      .toMatchObject({ ok: false, error: { code: 'event_gap' }, context: { gap: { fromSequence: 2, toSequence: 2 } } });
    writeFileSync(join(root, 'read-failure'), 'fail the next actual SQLite read');
    expect(await read('renewed-owner', renewed[1])).toMatchObject({ ok: false, error: { code: 'storage_read_failed', retryable: true }, context: null });
    for (const subscriptionId of renewed.slice(2)) expect(await read('renewed-owner', subscriptionId,
      { cursor: { ...input.cursor, lastPersistedSequence: -1 } })).toMatchObject({ ok: false, error: { code: 'event_cursor_invalid' } });
    expect(await read('expires-owner')).toMatchObject({ ok: true });
    expect(await read('foreign-owner', expires)).toMatchObject({ ok: false, error: { code: 'event_subscription_invalid' }, context: null });
    expect(await read('naked-owner', naked, { runId: input.runId + 1, cursor: { runId: input.runId + 1, lastPersistedSequence: 0 } }))
      .toMatchObject({ ok: false, error: { code: 'event_subscription_invalid' }, context: null });
    await new Promise(resolveDelay => setTimeout(resolveDelay, Math.max(0, 91_500 - (performance.now() - startedAt))));
    expect(await read('expires-owner', expires)).toMatchObject({ ok: false, error: { code: 'event_subscription_invalid' }, context: null });
    expect(await read('naked-owner', naked)).toMatchObject({ ok: false, error: { code: 'event_subscription_invalid' }, context: null });
    expect(await read('lost-request-owner', lostRequest)).toMatchObject({ ok: false, error: { code: 'event_subscription_invalid' }, context: null });
    expect(await read('lost-ack-owner', lostAck)).toMatchObject({ ok: false, error: { code: 'event_subscription_invalid' }, context: null });
    for (const subscriptionId of renewed) expect(await read('renewed-owner', subscriptionId)).toMatchObject({ ok: true });
    // All eight legal FIFO observers survive the original lease, and expiry frees Host capacity.
    expect(await request(client, { type: 'subscribe_runtime_events', ownerToken: 'expires-owner', subscriptionId: randomUUID(), input })).toMatchObject({ ok: true });
  } finally { expect(await client.close()).toMatchObject({ ok: true, data: { closed: true } }); }
}, 110_000);

it('P6 actual Host drops only wake hints at measured stdout pressure and retains control, stop and persisted pages', async () => {
  const root = await mkdtemp(join(tmpdir(), 'flowmate-p6-pressure-'));
  const client = new HostClient();
  // The wrapper observes the real stdout queue without changing its stream, pressure or Host implementation.
  const queueMetric = join(root, 'stdout-queue.txt');
  mkdirSync(join(root, 'apps', 'host'), { recursive: true });
  writeFileSync(join(root, 'apps', 'host', 'main.ts'), [
    "import fs from 'node:fs';",
    `const metric = ${JSON.stringify(queueMetric)}; const write = fs.WriteStream.prototype.write; let maximum = 0;`,
    'fs.WriteStream.prototype.write = function(...values) { const result = write.apply(this, values); if(this.fd !== 1) return result; const size = this.writableLength; if (size > maximum) { maximum = size; fs.writeFileSync(metric, String(size)); } return result; };',
    `await import(${JSON.stringify(pathToFileURL(resolve(import.meta.dir, '../../apps/host/main.ts')).href)});`,
  ].join('\n'));
  let providerRequests = 0;
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch() {
    providerRequests++;
    return new Response(new ReadableStream({ start(controller) {
      controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ id: 'p6-pressure', choices: [{ index: 0,
        delta: { role: 'assistant', content: 'Controlled partial response' }, finish_reason: null }] })}\n\n`));
    } }), { headers: { 'content-type': 'text/event-stream' } });
  } });
  client.setCredentialHandler(async () => ({ ok: true, credential: { type: 'api_key', key: 'synthetic-p6-pressure' } }));
  const wakes: unknown[] = [];
  client.subscribe(event => { if (event.type === 'runtime_events_available') wakes.push(event); });
  let child: ChildProcessWithoutNullStreams | undefined;
  try {
    expect(await client.start(root, '0.1.0', root)).toMatchObject({ ok: true });
    child = (client as unknown as { child: ChildProcessWithoutNullStreams }).child;
    let observedControls = 0, observedLines = '';
    child.stdout.on('data', chunk => {
      observedLines += chunk.toString('utf8');
      let newline;
      while ((newline = observedLines.indexOf('\n')) >= 0) {
        if (observedLines.slice(0, newline).includes('"requestId":"pressure-')) observedControls++;
        observedLines = observedLines.slice(newline + 1);
      }
    });
    expect(await client.request({ type: 'save_settings', settings: { version: 3, revision: 0, runtime: {},
      profile: { displayName: 'P6 pressure', theme: 'system' }, models: [{ id: 'pressure-model', credentialRef: 'pressure_model_credential',
        name: 'Controlled pressure', kind: 'custom', providerId: null, baseUrl: `http://127.0.0.1:${server.port}/v1`,
        model: 'pressure-model', api: 'openai-completions', contextWindow: 64000, maxTokens: 16384, reasoning: false }],
      defaultModelId: 'pressure-model', updatedAt: '2026-10-03T00:00:00.000Z' } })).toMatchObject({ ok: true });
    const targetRequestId = randomUUID();
    const accepted = await client.request({ type: 'call_provider', requestId: targetRequestId,
      input: { goal: 'Controlled pressure fixture', text: 'Hold only this local stream', modelId: 'pressure-model' } }) as Result<{ runId: number }>;
    if (!accepted.ok) throw new Error(accepted.error.code);
    await waitUntil(() => providerRequests === 1);
    const observedInput = { runId: accepted.data.runId, sessionId: null, cursor: { runId: accepted.data.runId, lastPersistedSequence: 0 } };
    const subscriptionId = randomUUID(), ownerToken = 'pressure-owner';
    expect(await request(client, { type: 'subscribe_runtime_events', ownerToken, subscriptionId, input: observedInput })).toMatchObject({ ok: true });
    child.stdout.pause();
    const controls = 3000;
    const backlog = Array.from({ length: controls }, (_, index) => JSON.stringify({ version: 1, type: 'get_state', requestId: `pressure-${index}` })).join('\n') + '\n';
    child.stdin.write(backlog);
    try { await waitUntil(() => existsSync(queueMetric) && Number(readFileSync(queueMetric, 'utf8')) >= 262144); }
    catch { throw new Error(`Host fd=1 output stream pressure never reached the threshold: ${existsSync(queueMetric) ? readFileSync(queueMetric, 'utf8') : 'zero'}`); }
    const pressuredQuery = request(client, { type: 'query_runtime_events', ownerToken, input: { ...observedInput, subscriptionId } });
    const stopped = client.request({ type: 'cancel_provider', targetRequestId });
    await new Promise(resolveDelay => setTimeout(resolveDelay, 200));
    child.stdout.resume();
    expect(await stopped).toMatchObject({ ok: true, data: { accepted: true, runId: accepted.data.runId } });
    expect(await pressuredQuery).toMatchObject({ ok: true });
    expect(Number(readFileSync(queueMetric, 'utf8'))).toBeGreaterThanOrEqual(262144);
    const page = await request(client, { type: 'query_runtime_events', ownerToken, input: { ...observedInput, subscriptionId } }) as RuntimeEventsReadResult;
    expect(page).toMatchObject({ ok: true });
    if (!page.ok) throw new Error(page.error.code);
    expect(page.data.items.some(event => event.type === 'run_cancelled')).toBe(true);
    expect(wakes).toHaveLength(0);
    expect(observedControls).toBe(controls);
    expect(providerRequests).toBe(1);
    expect(await client.close()).toMatchObject({ ok: true, data: { closed: true, stopped: true } });
  } finally { child?.stdout.resume(); await client.close(); server.stop(true); }
}, 15_000);

async function waitUntil(check: () => boolean): Promise<void> {
  const deadline = performance.now() + 3000;
  while (!check()) {
    if (performance.now() > deadline) throw new Error('Controlled Host fixture did not reach its expected state');
    await new Promise(resolveDelay => setTimeout(resolveDelay, 10));
  }
}

it('P6 the App drain gives eight real Host observations a FIFO turn through ten-second transport timeouts', async () => {
  const { client, input } = await fixture(root => {
    mkdirSync(join(root, 'apps', 'host'), { recursive: true });
    // Fault injection delays eight actual query response packets; Host registration/SQL/lease clocks are unchanged.
    writeFileSync(join(root, 'apps', 'host', 'main.ts'), [
      "import fs from 'node:fs'; const write = fs.WriteStream.prototype.write; let remaining = 8;",
      "fs.WriteStream.prototype.write = function(...values) { let packet; try { packet=JSON.parse(String(values[0]).trim()); } catch {}",
      " if (this.fd===1 && packet?.type==='response' && packet.value?.ok && packet.value.data?.nextCursor && remaining-- > 0) { setTimeout(()=>write.apply(this,values),11000); return true; } return write.apply(this,values); };",
      `await import(${JSON.stringify(pathToFileURL(resolve(import.meta.dir, '../../apps/host/main.ts')).href)});`,
    ].join('\n'));
  });
  const ownerToken = 'slow-fifo-owner', ids = Array.from({ length: 8 }, () => randomUUID());
  let queue: string[] = [], inFlight = 0, maximum = 0, turns = 0;
  const order: string[] = [], starts: number[] = [];
  try {
    for (const subscriptionId of ids) {
      expect(await request(client, { type: 'subscribe_runtime_events', ownerToken, subscriptionId, input })).toMatchObject({ ok: true });
      queue = enqueueEventRead(queue, subscriptionId);
    }
    const started = performance.now();
    await drainEventReadQueue(() => queue.shift(), () => turns < 9, async subscriptionId => {
      order.push(subscriptionId); starts.push(performance.now() - started); inFlight++; maximum = Math.max(maximum, inFlight);
      try {
        const reading = request(client, { type: 'query_runtime_events', ownerToken, input: { ...input, subscriptionId } });
        if (turns < 8) await expect(reading).rejects.toThrow('host_request_timeout');
        else expect(await reading).toMatchObject({ ok: true });
      } finally { inFlight--; turns++; }
      // A hot first observation and duplicate wakes go behind every already waiting observation.
      if (subscriptionId === ids[0] && turns === 1) {
        queue = enqueueEventRead(queue, subscriptionId); queue = enqueueEventRead(queue, subscriptionId);
      }
    });
    expect(order).toEqual([...ids, ids[0]!]); expect(maximum).toBe(1); expect(queue).toEqual([]);
    expect(starts[7]).toBeGreaterThanOrEqual(69_000); expect(starts[8]).toBeLessThan(88_000);
    // The first observer renews at ~80s; all eight remain valid beyond their original 90s lease.
    await new Promise(resolveDelay => setTimeout(resolveDelay, Math.max(0, 91_500 - (performance.now() - started))));
    for (const subscriptionId of ids) expect(await request(client, { type: 'query_runtime_events', ownerToken,
      input: { ...input, subscriptionId } })).toMatchObject({ ok: true });
    expect(await client.request({ type: 'query_runtime_state' })).toMatchObject({ ok: true, data: { active: null } });
  } finally { expect(await client.close()).toMatchObject({ ok: true, data: { closed: true } }); }
}, 110_000);

it('P6 the App drain gives each real Host observation one SQL page before a hot backlog returns', async () => {
  const readFacts = (db: Database) => ({
    runs: db.query('SELECT * FROM runs ORDER BY id').all(),
    events: db.query('SELECT * FROM runtime_events ORDER BY run_id,sequence').all(),
    executionCounts: db.query(`SELECT (SELECT COUNT(*) FROM tool_calls) AS tools,
      (SELECT COUNT(*) FROM session_inputs) AS inputs`).get(),
  });
  let beforeFacts: ReturnType<typeof readFacts> | undefined;
  const at = '2026-10-03T00:00:01.000Z';
  const { client, input, root } = await fixture(undefined, (store, runId, config) => {
    const run = store.runs.get(runId);
    if (!run.ok || run.data.kind !== 'provider') throw new Error('The SQL backlog fixture must own a Provider Run.');
    expect(store.runs.start(runId, config, at)).toMatchObject({ ok: true });
    expect(store.runs.recordCancel(runId, at)).toEqual({ ok: true, data: true });
    expect(store.runs.finish(runId, { status: 'failed', output: null,
      error: { code: 'fixture_stopped', category: 'provider', message: 'Prepared read-only backlog.', retryable: false },
      usage: run.data.usage, tokens: run.data.tokens,
      cleanup: { version: 1, stopped: true, stopReason: 'fixture-stop', errors: [], lateObservationRequired: false },
      endedAt: at, stoppedAt: at, durationMs: 1000 })).toEqual({ ok: true, data: true });
    beforeFacts = readFacts(store.db);
    expect(beforeFacts.executionCounts).toEqual({ tools: 0, inputs: 0 });
  });
  const ownerToken = 'sql-pages-owner', ids = Array.from({ length: 8 }, () => randomUUID());
  const cursors = new Map<string, RuntimeEventCursor>(ids.map(id => [id, input.cursor]));
  const seen = new Map<string, number[]>(ids.map(id => [id, []]));
  const order: string[] = [];
  let queue: string[] = [], inFlight = 0, maximum = 0, credentialRequests = 0, executionEvents = 0;
  client.setCredentialHandler(async () => { credentialRequests++; return { ok: false }; });
  client.subscribe(event => {
    if (event.type === 'agent_run_event' || event.type === 'provider_observation' || event.type === 'provider_finished') executionEvents++;
  });
  try {
    const baseline = await request(client, { type: 'query_runtime_events', ownerToken, input }) as RuntimeEventsReadResult;
    expect(baseline.ok).toBe(true);
    if (!baseline.ok) throw new Error('The actual SQL backlog must be readable.');
    expect(baseline.data.items.map(event => event.type))
      .toEqual(['run_created', 'run_started', 'run_cancel_requested', 'run_failed']);
    expect(baseline.data.highWatermark).toBe(4);
    const beforeRun = await client.request({ type: 'query_run', runId: input.runId });
    const beforeRuntime = await client.request({ type: 'query_runtime_state' });
    for (const subscriptionId of ids) {
      expect(await request(client, { type: 'subscribe_runtime_events', ownerToken, subscriptionId, input })).toMatchObject({ ok: true });
      queue = enqueueEventRead(queue, subscriptionId);
    }
    await drainEventReadQueue(() => queue.shift(), () => order.length < 40, async subscriptionId => {
      order.push(subscriptionId); inFlight++; maximum = Math.max(maximum, inFlight);
      try {
        const cursor = cursors.get(subscriptionId)!;
        const page = await request(client, { type: 'query_runtime_events', ownerToken,
          input: { ...input, subscriptionId, cursor, limit: 1 } }) as RuntimeEventsReadResult;
        expect(page.ok).toBe(true);
        if (!page.ok) throw new Error(page.error.code);
        expect(page.data.items).toHaveLength(1);
        const event = page.data.items[0]!;
        expect(event).toEqual(baseline.data.items[cursor.lastPersistedSequence]);
        expect(page.data.nextCursor.lastPersistedSequence).toBe(cursor.lastPersistedSequence + 1);
        seen.get(subscriptionId)!.push(event.sequence);
        cursors.set(subscriptionId, page.data.nextCursor);
        // Actual SQL hasMore alone drives the next page, behind all waiting IDs.
        if (page.data.hasMore) queue = enqueueEventRead(queue, subscriptionId);
      } finally { inFlight--; }
    });
    expect(order).toEqual(Array.from({ length: 4 }, () => ids).flat());
    expect(order.slice(0, 8)).toEqual(ids);
    expect(order.indexOf(ids[0]!, 1)).toBe(8);
    expect(maximum).toBe(1);
    expect(queue).toEqual([]);
    for (const subscriptionId of ids) {
      expect(seen.get(subscriptionId)).toEqual([1, 2, 3, 4]);
      expect(cursors.get(subscriptionId)).toEqual(baseline.data.nextCursor);
    }
    expect(await request(client, { type: 'query_runtime_events', ownerToken, input })).toEqual(baseline);
    expect(await client.request({ type: 'query_run', runId: input.runId })).toEqual(beforeRun);
    expect(await client.request({ type: 'query_runtime_state' })).toEqual(beforeRuntime);
    expect({ credentialRequests, executionEvents }).toEqual({ credentialRequests: 0, executionEvents: 0 });
  } finally { expect(await client.close()).toMatchObject({ ok: true, data: { closed: true } }); }
  if (beforeFacts === undefined) throw new Error('Missing the actual SQL baseline.');
  const after = new Database(join(root, 'data', 'app.sqlite'), { readonly: true });
  try { expect(readFacts(after)).toEqual(beforeFacts); }
  finally { after.close(); }
}, 15_000);
