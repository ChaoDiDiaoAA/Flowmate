import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { expect, it } from 'bun:test';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { Database } from 'bun:sqlite';
import { createServer } from 'node:http';
import { openDatabase } from '@flowmate/core';
import { resolveProductPaths } from '@flowmate/shared';
import { RuntimeToolPageSchema, RuntimeToolViewSchema, SessionMessageViewSchema } from '@flowmate/contracts';
import type { InvoiceFormApplicationReceipt, InvoiceFormBridgeRequest, SessionMessagesPage, SessionMessageView, Result,
  DocumentSnapshot, WorkspaceSnapshot, TaskOperation, CandidateSelection, RunAccepted, Page, RuntimeToolView } from '@flowmate/contracts';
import type { RuntimeEventsReadResult, RuntimeEventsWake, RuntimeSubscriptionInfo } from '@flowmate/contracts';
import { mkdtemp } from '../support/resources.ts';
import { HostClient, safeChildEnvironment } from '../../apps/desktop/main/host-client.ts';

it('returns the original P5 Desktop prompt after credentials or settings change without redelivery', async () => {
  const root = await mkdtemp(join(tmpdir(), 'flowmate-host-p5-dedup-'));
  let requests = 0, credentialReads = 0, credentialAvailable = true;
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch() {
    requests++;
    const chunk = (delta: unknown, finish_reason: string | null) => `data: ${JSON.stringify({ id: 'p5-dedup',
      choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
    return new Response(`${chunk({ role: 'assistant', content: 'Controlled P5 reply' }, null)}${chunk({}, 'stop')}data: [DONE]\n\n`,
      { headers: { 'content-type': 'text/event-stream' } });
  } });
  const client = new HostClient();
  client.setCredentialHandler(async () => {
    credentialReads++;
    return credentialAvailable ? { ok: true, credential: { type: 'api_key', key: 'synthetic-p5-dedup' } } : { ok: false };
  });
  const finished: number[] = [];
  client.subscribe(event => { if (event.type === 'agent_run_event' && event.value.type === 'run_finished') finished.push(event.value.runId); });
  try {
    expect(await client.start(root, '0.1.0', resolve(import.meta.dir, '../..'))).toMatchObject({ ok: true });
    const settings = { version: 2 as const, revision: 0, profile: { displayName: 'P5', theme: 'system' as const },
      models: [{ id: 'p5-dedup-model', credentialRef: 'p5_dedup_credential', name: 'P5 model', kind: 'custom' as const,
        providerId: null, baseUrl: `http://127.0.0.1:${server.port}/v1`, model: 'p5-dedup-model', api: 'openai-completions',
        contextWindow: 64_000, maxTokens: 16_384, reasoning: false }], defaultModelId: 'p5-dedup-model', updatedAt: '2026-10-01T00:00:00.000Z' };
    expect(await client.request({ type: 'save_settings', settings })).toMatchObject({ ok: true, data: { revision: 1 } });
    const session = await client.request({ type: 'create_session', input: { title: 'P5 dedup' } }) as Result<{ sessionId: number }>;
    if (!session.ok) throw new Error(session.error.code);
    const input = { sessionId: session.data.sessionId, clientSequence: 1, mode: 'prompt' as const,
      goalMode: 'answer' as const, text: 'Original request', modelId: 'p5-dedup-model' };
    const submit = (value = input) => client.request({ type: 'submit_session_input', input: value,
      expectedSettingsRevision: 1, expectedCredentialRef: settings.models[0]!.credentialRef }) as Promise<Result<import('@flowmate/contracts').SessionInputAccepted>>;
    const [original, concurrent] = await Promise.all([submit(), submit()]);
    if (!original.ok) throw new Error(original.error.code);
    expect(concurrent).toMatchObject({ ok: true, data: { inputId: original.data.inputId, runId: original.data.runId } });
    await waitFor(() => finished.includes(original.data.runId));
    const collisions = await Promise.all([submit({ ...input, clientSequence: 2, text: 'Window A' }),
      submit({ ...input, clientSequence: 2, text: 'Window B' })]);
    const winner = collisions.find(result => result.ok);
    if (!winner?.ok) throw new Error('Concurrent input had no accepted request');
    expect(collisions.filter(result => result.ok)).toHaveLength(1);
    expect(collisions.find(result => !result.ok)).toMatchObject({ ok: false, error: { code: 'state_conflict' } });
    await waitFor(() => finished.includes(winner.data.runId));
    let reads = credentialReads;
    expect(await client.request({ type: 'submit_session_input', input: { ...input, clientSequence: 3 } }))
      .toMatchObject({ ok: false, error: { code: 'state_conflict' } });
    credentialAvailable = false;
    expect(await submit({ ...input, clientSequence: 3 })).toMatchObject({ ok: false, error: { code: 'model_credential_unavailable' } });
    expect(credentialReads).toBe(reads + 1);
    reads = credentialReads;
    expect(await submit()).toMatchObject({ ok: true, data: { inputId: original.data.inputId, runId: original.data.runId } });
    // New identities retain the caller's intent, including omitted values.
    expect(await client.request({ type: 'submit_session_input', input: { ...input, goalMode: 'answer', timeoutMs: 60_000, stopGraceMs: 5000 },
      expectedSettingsRevision: 1, expectedCredentialRef: settings.models[0]!.credentialRef }))
      .toMatchObject({ ok: false, error: { code: 'state_conflict' } });
    expect(await client.request({ type: 'submit_session_input', input: { ...input, stopGraceMs: 5000 },
      expectedSettingsRevision: 1, expectedCredentialRef: settings.models[0]!.credentialRef }))
      .toMatchObject({ ok: false, error: { code: 'state_conflict' } });
    expect(await client.request({ type: 'save_settings', settings: { ...settings, version: 3, runtime: {
      budget: { maxModelCalls: 64, maxToolCalls: 100, toolTimeoutMs: 1_800_000 }, timeoutMs: 1_800_000 }, revision: 1, models: [], defaultModelId: null } }))
      .toMatchObject({ ok: true, data: { revision: 2 } });
    expect(await submit()).toMatchObject({ ok: true, data: { inputId: original.data.inputId, runId: original.data.runId } });
    expect(await submit({ ...input, text: 'Different request' })).toMatchObject({ ok: false, error: { code: 'state_conflict' } });
    expect(await client.request({ type: 'submit_session_input', input: { ...input, clientSequence: 3 } }))
      .toMatchObject({ ok: false, error: { code: 'model_not_configured' } });
    expect(credentialReads).toBe(reads);
    expect(requests).toBe(2);
    const page = await client.request({ type: 'list_session_inputs', input: { sessionId: input.sessionId, limit: 50 } }) as Result<import('@flowmate/contracts').SessionInputsPage>;
    if (!page.ok) throw new Error(page.error.code);
    expect(page.data.items).toHaveLength(2);
    expect(page.data.items.find(item => item.inputId === original.data.inputId))
      .toMatchObject({ inputId: original.data.inputId, status: 'consumed', processingStatus: 'completed',
        content: { version: 2, requestIdentityVersion: 1, originalBudgetOverrides: {}, desktopRequestHash: expect.stringMatching(/^[a-f0-9]{64}$/) } });
  } finally { await client.close(); server.stop(true); }
}, 15_000);

it.each(['prompt', 'connection'] as const)('rejects a Settings change during the Host credential read before %s admission', async mode => {
  const root = await mkdtemp(join(tmpdir(), 'flowmate-host-credential-revision-'));
  let requests = 0;
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch() { requests++; return new Response('Unexpected request', { status: 500 }); } });
  const client = new HostClient();
  const settings = { version: 3 as const, revision: 0, profile: { displayName: 'Revision race', theme: 'system' as const }, runtime: {},
    models: [{ id: 'revision-model', credentialRef: 'revision_model_credential', name: 'Revision model', kind: 'custom' as const,
      providerId: null, baseUrl: `http://127.0.0.1:${server.port}/v1`, model: 'revision-model', api: 'openai-completions',
      contextWindow: 64_000, maxTokens: 16_384, reasoning: false }], defaultModelId: 'revision-model', updatedAt: '2026-10-01T00:00:00.000Z' };
  let changed = false;
  client.setCredentialHandler(async () => {
    if (!changed) {
      changed = true;
      expect(await client.request({ type: 'save_settings', settings: { ...settings, revision: 1,
        runtime: { budget: { maxModelCalls: 64 }, timeoutMs: 1000 } } })).toMatchObject({ ok: true, data: { revision: 2 } });
    }
    return { ok: true, credential: { type: 'api_key', key: 'synthetic-revision-key' } };
  });
  try {
    expect(await client.start(root, '0.1.0', resolve(import.meta.dir, '../..'))).toMatchObject({ ok: true });
    expect(await client.request({ type: 'save_settings', settings })).toMatchObject({ ok: true, data: { revision: 1 } });
    const session = await client.request({ type: 'create_session', input: {} }) as Result<{ sessionId: number }>;
    if (!session.ok) throw new Error(session.error.code);
    const result = mode === 'prompt' ? await client.request({ type: 'submit_session_input', input: {
      mode: 'prompt', goalMode: 'answer', sessionId: session.data.sessionId, clientSequence: 1, text: 'Stale request', modelId: 'revision-model' },
      expectedSettingsRevision: 1, expectedCredentialRef: settings.models[0]!.credentialRef })
      : await client.request({ type: 'call_provider', input: { modelId: 'revision-model', goal: 'Connection test', text: 'Stale request' } });
    expect(result).toMatchObject({ ok: false, error: { code: 'state_conflict' } });
    expect(await client.request({ type: 'list_session_runs', input: { sessionId: session.data.sessionId } }))
      .toMatchObject({ ok: true, data: { items: [] } });
    expect(await client.request({ type: 'list_session_inputs', input: { sessionId: session.data.sessionId, limit: 50 } }))
      .toMatchObject({ ok: true, data: { items: [] } });
    expect(requests).toBe(0);
    expect(changed).toBe(true);
  } finally { await client.close(); server.stop(true); }
}, 15_000);

async function formBridgeFixture() {
  const root = await mkdtemp(join(tmpdir(), 'flowmate-host-form-bridge-'));
  mkdirSync(join(root, 'apps', 'host'), { recursive: true });
  writeFileSync(join(root, 'apps', 'host', 'main.ts'), [
    "import { createInterface } from 'node:readline';",
    "console.log(JSON.stringify({ version: 1, type: 'ready', state: { version: 1, ready: true, host: 'ready', userDataPath: 'synthetic' } }));",
    'const input = createInterface({ input: process.stdin }); let original;',
    "input.on('line', line => { const command = JSON.parse(line); if (command.type === 'get_state') { original = command.requestId; console.log(JSON.stringify({ version: 1, type: 'invoice_form_request', requestId: 'form-call-1', request: { operation: 'query', runId: 101, toolCallId: 21, nativeToolCallId: 'native-call-1', sessionId: 12, documentRef: { id: 4, version: 'v1' }, jobId: 7, candidateId: 9, candidateSequence: 1, target: { formInstanceId: 'form-1', expectedRevision: 0 } } })); } else if (command.type === 'invoice_form_response') console.log(JSON.stringify({ version: 1, type: 'response', requestId: original, value: command.receipt })); });",
    "input.on('close', () => process.exit(0));",
  ].join('\n'));
  return root;
}

it('routes a typed private form query through the current Host connection and preserves its original receipt', async () => {
  const root = await formBridgeFixture();
  const client = new HostClient();
  let observedEpoch = 0;
  client.setInvoiceFormHandler(async (request, epoch) => {
    observedEpoch = epoch;
    return { runId: request.runId, toolCallId: request.toolCallId, formInstanceId: request.target.formInstanceId,
      candidateId: request.candidateId, candidateSequence: request.candidateSequence, outcome: 'applied',
      appliedRevision: 1, observedAt: '2026-10-01T00:00:00.000Z', appliedAt: '2026-10-01T00:00:00.000Z' };
  });
  expect(await client.start(root, '0.1.0', root)).toMatchObject({ ok: true });
  try {
    expect(await client.request({ type: 'get_state' })).toMatchObject({ outcome: 'applied', toolCallId: 21, appliedRevision: 1 });
    expect(observedEpoch).toBe(client.connectionEpoch);
    expect(observedEpoch).toBeGreaterThan(0);
  } finally {
    const child = (client as unknown as { child: ChildProcessWithoutNullStreams }).child;
    const exited = once(child, 'exit'); child.stdin.end(); await exited;
  }
}, 5_000);

it('reports unknown for missing or mismatched form replies without claiming non-application', async () => {
  const root = await formBridgeFixture();
  const client = new HostClient();
  expect(await client.start(root, '0.1.0', root)).toMatchObject({ ok: true });
  try {
    expect(await client.request({ type: 'get_state' })).toMatchObject({ outcome: 'unknown', runId: 101, toolCallId: 21 });
    client.setInvoiceFormHandler(async () => ({ runId: 999, toolCallId: 21, formInstanceId: 'form-1', candidateId: 9,
      candidateSequence: 1, outcome: 'not_applied', reason: 'wrong-run', observedAt: '2026-10-01T00:00:00.000Z' }));
    expect(await client.request({ type: 'get_state' })).toMatchObject({ outcome: 'unknown', runId: 101, toolCallId: 21 });
  } finally {
    const child = (client as unknown as { child: ChildProcessWithoutNullStreams }).child;
    const exited = once(child, 'exit'); child.stdin.end(); await exited;
  }
}, 5_000);

it('closes promptly after a missing executable leaves Host unstarted', async () => {
  const userDataRoot = await mkdtemp(join(tmpdir(), 'flowmate-host-unstarted-'));
  const previousExecutable = process.env.FLOWMATE_BUN_EXECUTABLE;
  const client = new HostClient();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    process.env.FLOWMATE_BUN_EXECUTABLE = join(userDataRoot, 'missing-bun.exe');
    expect(await client.start(userDataRoot, '0.1.0', resolve(import.meta.dir, '../..')))
      .toMatchObject({ ok: false, error: { code: 'host_spawn_failed' } });
    const child = (client as unknown as { child: ChildProcessWithoutNullStreams }).child;
    expect(child.pid).toBeUndefined();
    expect(existsSync(join(userDataRoot, 'data', 'app.sqlite'))).toBe(false);
    const closed = await Promise.race([client.close(), new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Unstarted Host closure did not complete promptly')), 1_000);
    })]);
    expect(closed).toEqual({ ok: true, data: { stopped: true, closed: true, errors: [] } });
    expect(await client.close()).toEqual(closed);
    await expect(client.request({ type: 'get_state' })).rejects.toThrow('host_not_writable');
  } finally {
    clearTimeout(timer);
    if (previousExecutable === undefined) delete process.env.FLOWMATE_BUN_EXECUTABLE;
    else process.env.FLOWMATE_BUN_EXECUTABLE = previousExecutable;
  }
}, 5_000);

it('does not report Host closure from an acknowledgement while its process is still alive', async () => {
  const root = await mkdtemp(join(tmpdir(), 'flowmate-host-exit-confirmation-'));
  mkdirSync(join(root, 'apps', 'host'), { recursive: true });
  writeFileSync(join(root, 'apps', 'host', 'main.ts'), [
    "import { createInterface } from 'node:readline';",
    "console.log(JSON.stringify({ version: 1, type: 'ready', state: { version: 1, ready: true, host: 'ready', userDataPath: 'synthetic' } }));",
    'const input = createInterface({ input: process.stdin });',
    "input.on('line', line => { const request = JSON.parse(line); console.log(JSON.stringify({ version: 1, type: 'response', requestId: request.requestId, value: { ok: true, data: { stopped: true, closed: true, errors: [] } } })); });",
    "input.on('close', () => process.exit(0));",
  ].join('\n'));
  const client = new HostClient();
  expect(await client.start(root, '0.1.0', root)).toMatchObject({ ok: true });
  const child = (client as unknown as { child: ChildProcessWithoutNullStreams }).child;
  try {
    expect(await client.close()).toMatchObject({ ok: true, data: {
      stopped: true, closed: false, errors: [{ code: 'host_exit_unconfirmed' }],
    } });
    expect(child.exitCode).toBeNull();
    const exited = once(child, 'exit');
    child.stdin.end();
    await exited;
    expect(await client.close()).toMatchObject({ ok: true, data: { stopped: true, closed: true, errors: [] } });
  } finally {
    if (child.exitCode === null) { const exited = once(child, 'exit'); child.stdin.end(); await exited; }
  }
}, 10_000);

it('accepts a buffered Host close acknowledgement after the child exits normally', async () => {
  const root = await mkdtemp(join(tmpdir(), 'flowmate-host-buffered-close-'));
  mkdirSync(join(root, 'apps', 'host'), { recursive: true });
  writeFileSync(join(root, 'apps', 'host', 'main.ts'), [
    "import { createInterface } from 'node:readline';",
    "console.log(JSON.stringify({ version: 1, type: 'ready', state: { version: 1, ready: true, host: 'ready', userDataPath: 'synthetic' } }));",
    'const input = createInterface({ input: process.stdin });',
    "input.on('line', line => { const request = JSON.parse(line); console.log(JSON.stringify({ version: 1, type: 'response', requestId: request.requestId, value: { ok: true, data: { stopped: true, closed: true, errors: [] } } })); setTimeout(() => process.exit(0), 30); });",
    "input.on('close', () => process.exit(0));",
  ].join('\n'));
  const client = new HostClient();
  expect(await client.start(root, '0.1.0', root)).toMatchObject({ ok: true });
  const child = (client as unknown as { child: ChildProcessWithoutNullStreams }).child;
  try {
    child.stdout.pause();
    const exited = once(child, 'exit');
    const closing = client.close();
    await exited;
    expect(child.exitCode).toBe(0);
    child.stdout.resume();
    expect(await closing).toEqual({ ok: true, data: { stopped: true, closed: true, errors: [] } });
    expect(await client.close()).toEqual({ ok: true, data: { stopped: true, closed: true, errors: [] } });
  } finally {
    child.stdout.resume();
    if (child.exitCode === null) { const exited = once(child, 'exit'); child.stdin.end(); await exited; }
  }
}, 10_000);

it('preserves unconfirmed cleanup after a Host crash and recovers its interrupted Run without replay', async () => {
  const userDataRoot = await mkdtemp(join(tmpdir(), 'flowmate-host-crash-'));
  let requests = 0;
  let markStarted!: () => void;
  const requestStarted = new Promise<void>((resolveStarted) => { markStarted = resolveStarted; });
  const server = createServer((request, response) => {
    request.resume();
    request.on('end', () => {
      requests += 1;
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write(`data: ${JSON.stringify({ id: 'host-crash', choices: [{ index: 0, delta: { role: 'assistant', content: 'Partial' }, finish_reason: null }] })}\n\n`);
      markStarted();
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Fixture server has no port');
  const client = new HostClient();
  let releasePreparation!: () => void;
  const preparation = new Promise<void>(resolvePreparation => { releasePreparation = resolvePreparation; });
  let credentialReads = 0;
  client.setCredentialHandler(async () => {
    if (++credentialReads > 1) await preparation;
    return { ok: true, credential: { type: 'api_key', key: 'synthetic-host-crash-key' } };
  });
  const oldSubscriptionId = randomUUID(), newSubscriptionId = randomUUID();
  const receivedWakes: RuntimeEventsWake[] = [];
  client.subscribe(event => { if (event.type === 'runtime_events_available') receivedWakes.push(event); });
  const lateRequestId = 'before-crash-held-page';
  let heldWake: Buffer | undefined, heldPage: Buffer | undefined;
  let releaseOldPipe: (() => void) | undefined;
  let child: ChildProcessWithoutNullStreams | null = null;
  try {
    expect(await client.start(userDataRoot, '0.1.0', resolve(import.meta.dir, '../..'))).toMatchObject({ ok: true, data: { ready: true } });
    child = (client as unknown as { child: ChildProcessWithoutNullStreams }).child;
    const oldChild = child, oldEpoch = client.connectionEpoch, oldPid = child.pid;
    const oldEmit = oldChild.stdout.emit;
    const heldEnd: Array<{ event: string | symbol; values: unknown[] }> = [];
    let buffered = Buffer.alloc(0);
    let wakeCaptured!: () => void, pageCaptured!: () => void;
    const wakePacket = new Promise<void>(resolveCaptured => { wakeCaptured = resolveCaptured; });
    const pagePacket = new Promise<void>(resolveCaptured => { pageCaptured = resolveCaptured; });
    // Preserve real old-Host packets and EOF so its readline callback remains installed across replacement.
    oldChild.stdout.emit = function(event: string | symbol, ...values: unknown[]): boolean {
      if (event === 'end' || event === 'close') { heldEnd.push({ event, values }); return true; }
      if (event !== 'data' || !Buffer.isBuffer(values[0])) return Reflect.apply(oldEmit, this, [event, ...values]);
      buffered = Buffer.concat([buffered, values[0]]);
      const forward: Buffer[] = [];
      for (let newline = buffered.indexOf(10); newline >= 0; newline = buffered.indexOf(10)) {
        const line = Buffer.from(buffered.subarray(0, newline + 1)); buffered = buffered.subarray(newline + 1);
        const output = JSON.parse(line.toString('utf8'));
        if (output.type === 'event' && output.event?.type === 'runtime_events_available'
          && output.event.subscriptionId === oldSubscriptionId) { heldWake = line; wakeCaptured(); continue; }
        if (output.type === 'response' && output.requestId === lateRequestId) { heldPage = line; pageCaptured(); continue; }
        forward.push(line);
      }
      return forward.length ? Reflect.apply(oldEmit, this, ['data', Buffer.concat(forward), ...values.slice(1)]) : true;
    };
    releaseOldPipe = () => {
      oldChild.stdout.emit = oldEmit;
      for (const held of heldEnd.splice(0)) Reflect.apply(oldEmit, oldChild.stdout, [held.event, ...held.values]);
    };
    expect(await client.request({ type: 'save_settings', settings: {
      version: 2, revision: 0, profile: { displayName: 'Crash test', theme: 'system' },
      models: [{ id: 'crash-model', credentialRef: 'credential_reference_crash', name: 'Crash model', kind: 'custom', providerId: null,
        baseUrl: `http://127.0.0.1:${address.port}/v1`, model: 'crash-model', api: 'openai-completions',
        contextWindow: 64_000, maxTokens: 16_384, reasoning: false }], defaultModelId: 'crash-model', updatedAt: '2026-09-30T00:00:00.000Z',
    } })).toMatchObject({ ok: true });
    const accepted = await client.request({ type: 'call_provider', input: { modelId: 'crash-model', goal: 'Test crash recovery', text: 'Hold this request.' } }) as Result<{ runId: number }>;
    expect(accepted.ok).toBe(true);
    if (!accepted.ok) return;
    const eventInput = { runId: accepted.data.runId, sessionId: null, cursor: { runId: accepted.data.runId, lastPersistedSequence: 0 }, limit: 100 };
    const subscriptionInput = { runId: eventInput.runId, sessionId: null, cursor: eventInput.cursor };
    expect(await client.request({ type: 'subscribe_runtime_events', ownerToken: 'before-crash', subscriptionId: oldSubscriptionId,
      input: subscriptionInput })).toMatchObject({ ok: true, data: { subscriptionId: oldSubscriptionId, highWatermark: 1 } });
    const oldCleanup = client.captureRuntimeSubscriptionCleanup('before-crash', oldSubscriptionId);
    releasePreparation();
    await Promise.race([Promise.all([requestStarted, wakePacket]), new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Provider or persisted wake did not start')), 5_000))]);
    expect(await client.request({ type: 'query_run', runId: accepted.data.runId })).toMatchObject({ ok: true, data: { status: 'running' } });
    expect(JSON.parse(heldWake!.toString('utf8')).event).toEqual({ type: 'runtime_events_available', subscriptionId: oldSubscriptionId,
      runId: accepted.data.runId, sequence: 2 });
    expect(receivedWakes).toEqual([]);
    const liveEvents = await client.request({ type: 'query_runtime_events', ownerToken: 'before-crash',
      input: { ...eventInput, subscriptionId: oldSubscriptionId } }) as RuntimeEventsReadResult;
    expect(liveEvents).toMatchObject({ ok: true, data: { coverage: 'from-created' } });
    if (!liveEvents.ok) throw new Error(liveEvents.error.code);
    expect(liveEvents.data.items.map(event => event.type)).toEqual(['run_created', 'run_started']);
    const latePage = client.request({ type: 'query_runtime_events', requestId: lateRequestId, ownerToken: 'before-crash',
      input: { ...eventInput, subscriptionId: oldSubscriptionId } }).then(() => 'resolved', error => (error as Error).message);
    await pagePacket;
    expect(JSON.parse(heldPage!.toString('utf8')).value).toEqual(liveEvents);
    const exited = once(child, 'exit');
    child.kill(); // Deliberate crash; this is not the normal shutdown/abort test.
    await exited;
    expect(await client.close()).toMatchObject({ ok: true, data: { closed: true, stopped: false, errors: [{ code: 'host_exited' }] } });
    await expect(client.request({ type: 'get_state' })).rejects.toThrow('host_not_writable');
    const paths = resolveProductPaths(userDataRoot);
    expect(paths.ok).toBe(true);
    if (!paths.ok) return;
    // Inspect the committed prefix without openDatabase: recovery must happen in the restarted real Host.
    const stoppedDatabase = new Database(paths.data.databaseFile);
    let legacyFacts: Record<string, string | number | null>;
    try {
      const original = stoppedDatabase.query('SELECT * FROM runs WHERE id=?').get(accepted.data.runId) as Record<string, string | number | null>;
      expect(original.status).toBe('running');
      expect(stoppedDatabase.query('SELECT sequence,type FROM runtime_events WHERE run_id=? ORDER BY sequence').all(accepted.data.runId))
        .toEqual([{ sequence: 1, type: 'run_created' }, { sequence: 2, type: 'run_started' }]);
      expect(stoppedDatabase.query('SELECT (SELECT count(*) FROM tool_calls) AS tools, (SELECT count(*) FROM session_inputs) AS inputs').get())
        .toEqual({ tools: 0, inputs: 0 });
      legacyFacts = original;
    } finally { stoppedDatabase.close(); }
    // Production controller-lock stale remains15s. Wait naturally after confirmed PID exit; do not alter its mtime or delete it.
    await new Promise(resolveStaleLock => setTimeout(resolveStaleLock, 16_000));
    expect(await latePage).toBe('host_request_timeout');
    expect(await client.start(userDataRoot, '0.1.0', resolve(import.meta.dir, '../..'))).toMatchObject({ ok: true, data: { ready: true } });
    child = (client as unknown as { child: ChildProcessWithoutNullStreams }).child;
    expect(child.pid).not.toBe(oldPid);
    expect(client.connectionEpoch).toBeGreaterThan(oldEpoch);
    const newCommands: Array<{ type: string; subscriptionId?: string }> = [];
    const newWrite = child.stdin.write;
    child.stdin.write = function(...values: unknown[]): boolean {
      newCommands.push(JSON.parse(String(values[0])));
      return Reflect.apply(newWrite, this, values);
    };
    oldCleanup(); // The confirmed dead child cannot send its ID to the replacement connection.
    expect(newCommands).toEqual([]);
    const reopened = await client.request({ type: 'subscribe_runtime_events', ownerToken: 'after-crash', subscriptionId: newSubscriptionId,
      input: { ...subscriptionInput, cursor: liveEvents.data.nextCursor } }) as Result<RuntimeSubscriptionInfo>;
    expect(reopened).toMatchObject({ ok: true, data: { subscriptionId: newSubscriptionId, highWatermark: 3 } });
    const resumedPage = client.request({ type: 'query_runtime_events', requestId: lateRequestId, ownerToken: 'after-crash',
      input: { ...eventInput, cursor: liveEvents.data.nextCursor, subscriptionId: newSubscriptionId } }) as Promise<RuntimeEventsReadResult>;
    expect(heldEnd.some(held => held.event === 'end')).toBe(true);
    expect(oldChild.stdout.listenerCount('data')).toBeGreaterThan(0);
    Reflect.apply(oldEmit, oldChild.stdout, ['data', Buffer.concat([heldWake!, heldPage!])]);
    expect(receivedWakes).toEqual([]);
    expect(await resumedPage).toMatchObject({ ok: true, data: { highWatermark: 3, nextCursor: { lastPersistedSequence: 3 },
      items: [{ sequence: 3, type: 'run_failed', payload: { origin: 'recovery' } }] } });
    releaseOldPipe(); releaseOldPipe = undefined;
    for (const ownerToken of ['before-crash', 'after-crash']) expect(await client.request({ type: 'query_runtime_events', ownerToken,
      input: { ...eventInput, subscriptionId: oldSubscriptionId } })).toMatchObject({ ok: false, error: { code: 'event_subscription_invalid' }, context: null });
    expect(await client.request({ type: 'query_runtime_events', ownerToken: 'after-crash',
      input: { ...eventInput, cursor: liveEvents.data.nextCursor, subscriptionId: newSubscriptionId } })).toMatchObject({ ok: true });
    expect(newCommands.filter(command => command.type === 'unsubscribe_runtime_events' && command.subscriptionId === oldSubscriptionId)).toEqual([]);
    const recoveredEvents = await client.request({ type: 'query_runtime_events', ownerToken: 'after-crash', input: eventInput }) as import('@flowmate/contracts').RuntimeEventsReadResult;
    expect(recoveredEvents).toMatchObject({ ok: true, data: { coverage: 'from-created', highWatermark: 3 } });
    if (!recoveredEvents.ok) throw new Error(recoveredEvents.error.code);
    expect(recoveredEvents.data.items.slice(0, 2)).toEqual([...liveEvents.data.items]);
    expect(recoveredEvents.data.items.map(event => event.sequence)).toEqual([1, 2, 3]);
    expect(recoveredEvents.data.items.map(event => event.type)).toEqual(['run_created', 'run_started', 'run_failed']);
    expect(recoveredEvents.data.items[2]?.payload).toMatchObject({ origin: 'recovery', status: 'failed', stopped: false, errorCode: 'runtime_interrupted' });
    expect(await client.request({ type: 'query_run', runId: accepted.data.runId })).toMatchObject({ ok: true, data: {
      status: 'failed', output: null, stoppedAt: null, error: { code: 'runtime_interrupted' }, cleanup: { stopped: false, lateObservationRequired: true } } });
    expect(await client.request({ type: 'query_runtime_state' })).toMatchObject({ ok: true, data: { blocked: true } });
    expect(await client.request({ type: 'query_runtime_events', ownerToken: 'after-crash', input: eventInput })).toEqual(recoveredEvents);
    expect(requests).toBe(1);
    expect(await client.request({ type: 'unsubscribe_runtime_events', ownerToken: 'after-crash', subscriptionId: newSubscriptionId })).toMatchObject({ ok: true });
    expect(await client.close()).toMatchObject({ ok: true, data: { closed: true } });
    const unchangedExecution = new Database(paths.data.databaseFile, { readonly: true });
    try { expect(unchangedExecution.query('SELECT (SELECT count(*) FROM tool_calls) AS tools, (SELECT count(*) FROM session_inputs) AS inputs').get())
      .toEqual({ tools: 0, inputs: 0 }); } finally { unchangedExecution.close(); }
    // The one-active-Run constraint remains in force: seed a separate pre-P6 row only after recovery closed the original.
    const legacyDatabase = new Database(paths.data.databaseFile);
    let legacyRunId: number;
    try {
      const columns = Object.keys(legacyFacts).filter(column => column !== 'id');
      const inserted = legacyDatabase.query(`INSERT INTO runs(${columns.join(',')}) VALUES(${columns.map(() => '?').join(',')})`)
        .run(...columns.map(column => legacyFacts[column]!));
      legacyRunId = Number(inserted.lastInsertRowid);
      expect(legacyDatabase.query('SELECT COUNT(*) AS count FROM runtime_events WHERE run_id=?').get(legacyRunId)).toEqual({ count: 0 });
    } finally { legacyDatabase.close(); }
    expect(await client.start(userDataRoot, '0.1.0', resolve(import.meta.dir, '../..'))).toMatchObject({ ok: true, data: { ready: true } });
    child = (client as unknown as { child: ChildProcessWithoutNullStreams }).child;
    const legacyEvents = await client.request({ type: 'query_runtime_events', ownerToken: 'legacy-after-crash', input: {
      runId: legacyRunId, sessionId: null, cursor: { runId: legacyRunId, lastPersistedSequence: 0 }, limit: 100 } }) as import('@flowmate/contracts').RuntimeEventsReadResult;
    expect(legacyEvents).toMatchObject({ ok: true, data: { coverage: 'partial', highWatermark: 1,
      items: [{ sequence: 1, type: 'run_failed', payload: { origin: 'recovery', stopped: false } }] } });
    if (!legacyEvents.ok) throw new Error(legacyEvents.error.code);
    expect(legacyEvents.data.items).toHaveLength(1);
    expect(await client.request({ type: 'query_run', runId: legacyRunId })).toMatchObject({ ok: true,
      data: { output: null, stoppedAt: null, cleanup: { stopped: false } } });
    expect(requests).toBe(1);
    expect(await client.close()).toMatchObject({ ok: true, data: { closed: true } });
  } finally {
    releasePreparation(); releaseOldPipe?.();
    if (child && child.exitCode === null && child.signalCode === null) { const exited = once(child, 'exit'); child.kill(); await exited; }
    server.closeAllConnections();
    server.close();
  }
}, 45_000);

it('passes Pi provider ambient auth to Host without Judge or platform credentials', () => {
  const previous = { deepseek: process.env.DEEPSEEK_API_KEY, judge: process.env.FLOWMATE_JUDGE_API_KEY,
    langfuse: process.env.LANGFUSE_SECRET_KEY };
  try {
    process.env.DEEPSEEK_API_KEY = 'ambient-fixture';
    process.env.FLOWMATE_JUDGE_API_KEY = 'judge-fixture';
    process.env.LANGFUSE_SECRET_KEY = 'platform-fixture';
    const env = safeChildEnvironment();
    expect(env.PI_OFFLINE).toBe('1');
    expect(env.DEEPSEEK_API_KEY).toBe('ambient-fixture');
    expect(env.FLOWMATE_JUDGE_API_KEY).toBeUndefined();
    expect(env.LANGFUSE_SECRET_KEY).toBeUndefined();
  } finally {
    for (const [name, value] of Object.entries({ DEEPSEEK_API_KEY: previous.deepseek,
      FLOWMATE_JUDGE_API_KEY: previous.judge, LANGFUSE_SECRET_KEY: previous.langfuse })) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
  }
});

it('turns a Host stdin EPIPE into rejected pending requests instead of an uncaught main-process error', async () => {
  const repoRoot = resolve(import.meta.dir, '../..');
  const userDataRoot = await mkdtemp(join(tmpdir(), 'flowmate-host-client-epipe-'));
  const client = new HostClient();
  const started = await client.start(userDataRoot, '0.1.0', repoRoot);
  const child = (client as unknown as { child: ChildProcessWithoutNullStreams }).child;
  try {
    expect(started.ok).toBe(true);
    if (!started.ok) return;

    const exited = once(child, 'exit');
    const pending = client.request({ type: 'get_state' }, 2_000);
    const pipeError = Object.assign(new Error('write EPIPE'), { code: 'EPIPE' });
    child.stdin.destroy(pipeError);

    await expect(pending).rejects.toThrow('host_write_failed');
    await Promise.race([exited, new Promise((resolveExit) => setTimeout(resolveExit, 5_000))]);
  } finally {
    if (child && child.exitCode === null) {
      child.kill();
      await Promise.race([once(child, 'exit'), new Promise((resolveExit) => setTimeout(resolveExit, 1_000))]);
    }
  }
});

it('uses Pi native API-key login and returns the credential to the protected Main store', async () => {
  const repoRoot = resolve(import.meta.dir, '../..');
  const userDataRoot = await mkdtemp(join(tmpdir(), 'flowmate-host-pi-login-'));
  const client = new HostClient();
  let stored: unknown;
  client.setCredentialHandler(async (request) => {
    if (request.operation === 'read') return { ok: true, ...(stored === undefined ? {} : { credential: stored }) };
    if (request.operation === 'write') { stored = request.credential; return { ok: true }; }
    stored = undefined;
    return { ok: true };
  });
  const unsubscribe = client.subscribe((event) => {
    if (event.type === 'model_auth_prompt') void client.request({ type: 'auth_reply',
      loginRequestId: event.requestId, promptId: event.promptId, value: 'synthetic-pi-key' });
  });
  try {
    const started = await client.start(userDataRoot, '0.1.0', repoRoot);
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    const settings = { version: 2 as const, revision: 0, profile: { displayName: 'Login test', theme: 'system' as const },
      models: [{ id: 'pi-deepseek', credentialRef: 'login_credential_reference_1', name: 'DeepSeek',
        kind: 'catalog' as const, providerId: 'deepseek', baseUrl: '', model: 'deepseek-v4-flash',
        api: '', contextWindow: null, maxTokens: null, reasoning: false }],
      defaultModelId: 'pi-deepseek', updatedAt: '2026-09-29T00:00:00.000Z' };
    expect(await client.request({ type: 'save_settings', settings })).toMatchObject({ ok: true });
    expect(await client.request({ type: 'login_model', requestId: 'pi-login-1', modelId: 'pi-deepseek', authType: 'api_key' }, 30_000))
      .toMatchObject({ ok: true, data: { configured: true } });
    expect(stored).toEqual({ type: 'api_key', key: 'synthetic-pi-key' });
    expect(await client.request({ type: 'logout_model', modelId: 'pi-deepseek' })).toMatchObject({ ok: true });
    expect(stored).toBeUndefined();
  } finally {
    unsubscribe();
    await client.close();
  }
});

it('rejects Pi requests without a local API key even when environment or OAuth credentials exist', async () => {
  const repoRoot = resolve(import.meta.dir, '../..');
  const userDataRoot = await mkdtemp(join(tmpdir(), 'flowmate-host-local-key-'));
  const client = new HostClient();
  let stored: { type: string; key?: string; access?: string; refresh?: string; expires?: number } | undefined;
  client.setCredentialHandler(async (request) => request.operation === 'read'
    ? { ok: true, ...(stored ? { credential: stored } : {}) } : { ok: false });
  const previousKey = process.env.DEEPSEEK_API_KEY;
  process.env.DEEPSEEK_API_KEY = 'synthetic-ambient-key';
  try {
    const started = await client.start(userDataRoot, '0.1.0', repoRoot);
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    const profile = { id: 'pi-deepseek', credentialRef: 'local_key_credential_ref_1234', name: 'DeepSeek',
      kind: 'catalog' as const, providerId: 'deepseek', baseUrl: '', model: 'deepseek-v4-flash',
      api: '', contextWindow: null, maxTokens: null, reasoning: false };
    const settings = { version: 2 as const, revision: 0,
      profile: { displayName: 'Local key test', theme: 'system' as const }, models: [profile],
      defaultModelId: profile.id, updatedAt: '2026-09-30T00:00:00.000Z' };
    const saved = await client.request({ type: 'save_settings', settings }) as { ok: boolean; data?: { revision: number } };
    expect(saved).toMatchObject({ ok: true, data: { revision: 1 } });
    const created = await client.request({ type: 'create_session', requestId: 'local-key-session', input: {} }) as {
      ok: boolean; data?: { sessionId: number } };
    expect(created.ok).toBe(true);
    if (!created.data) return;
    const call = () => client.request({ type: 'call_provider', requestId: crypto.randomUUID(),
      input: { goal: 'Check', text: 'OK', modelId: profile.id } });
    const run = () => client.request({ type: 'start_run', requestId: crypto.randomUUID(),
      input: { sessionId: created.data!.sessionId, text: 'Check', modelId: profile.id, goalMode: 'answer' },
      expectedSettingsRevision: 1, expectedCredentialRef: profile.credentialRef });
    expect(await call()).toMatchObject({ ok: false, error: { code: 'model_credential_missing' } });
    expect(await run()).toMatchObject({ ok: false, error: { code: 'model_credential_missing' } });
    stored = { type: 'oauth', access: 'old-access', refresh: 'old-refresh', expires: Date.now() + 60_000 };
    expect(await call()).toMatchObject({ ok: false, error: { code: 'model_credential_missing' } });
    expect(await run()).toMatchObject({ ok: false, error: { code: 'model_credential_missing' } });
    stored = { type: 'api_key', key: 'synthetic-local-key' };
    const unsupported = await client.request({ type: 'save_settings', settings: {
      ...settings, revision: 1, models: [{ ...profile, providerId: 'openai-codex' }],
    } });
    expect(unsupported).toMatchObject({ ok: true });
    expect(await call()).toMatchObject({ ok: false, error: { code: 'model_api_key_unsupported' } });
    expect(await client.request({ type: 'list_session_runs', input: { sessionId: created.data.sessionId, limit: 10 } }))
      .toMatchObject({ ok: true, data: { items: [] } });
  } finally {
    if (previousKey === undefined) delete process.env.DEEPSEEK_API_KEY;
    else process.env.DEEPSEEK_API_KEY = previousKey;
    await client.close();
  }
});

it('wires the real Host Agent path, rejects stale model state after credential lookup and continues native history per Session', async () => {
  const repoRoot = resolve(import.meta.dir, '../..');
  const userDataRoot = await mkdtemp(join(tmpdir(), 'flowmate-host-agent-'));
  const requestBodies: Array<{ body: { messages?: Array<{ role: string; content?: unknown }>; tools?: unknown[] }; authorization: string | null }> = [];
  const replies = ['发票 INV-2048，价税合计 1060 元。', '上文发票的价税合计是 1060 元。'];
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      requestBodies.push({ body: await request.json(), authorization: request.headers.get('authorization') });
      const content = replies[requestBodies.length - 1] ?? 'fixture reply';
      const chunk = (delta: Record<string, unknown>, finishReason: string | null = null) =>
        `data: ${JSON.stringify({ id: `host-agent-${requestBodies.length}`, object: 'chat.completion.chunk', created: 1, model: 'host-agent-fixture', choices: [{ index: 0, delta, finish_reason: finishReason }] })}\n\n`;
      return new Response(`${chunk({ role: 'assistant', content })}${chunk({}, 'stop')}data: [DONE]\n\n`, {
        headers: { 'content-type': 'text/event-stream' },
      });
    },
  });
  const client = new HostClient();
  const finished: Array<{ runId: number; result: unknown }> = [];
  const credentialRequests: string[] = [];
  client.setCredentialHandler(async (request) => {
    credentialRequests.push(request.operation);
    return request.operation === 'read'
      ? { ok: true, credential: { type: 'api_key', key: 'synthetic-host-agent-key' } }
      : { ok: false };
  });
  client.subscribe((event) => {
    if (event.type === 'agent_run_event' && event.value.type === 'run_finished') {
      finished.push({ runId: event.value.runId, result: event.value.result });
    }
  });
  try {
    const started = await client.start(userDataRoot, '0.1.0', repoRoot);
    expect(started.ok).toBe(true);
    if (!started.ok) return;

    const profile = { id: 'fixture-model', credentialRef: 'credential_reference_1234', name: 'Fixture', kind: 'custom' as const,
      providerId: null, baseUrl: `http://127.0.0.1:${server.port}/v1`, model: 'host-agent-fixture', api: 'openai-completions',
      contextWindow: 64_000, maxTokens: 16_384, reasoning: false };
    const initialSettings = {
      version: 2 as const,
      revision: 0,
      profile: { displayName: 'Host Agent Test', theme: 'system' as const },
      models: [profile],
      defaultModelId: 'fixture-model',
      updatedAt: '2026-09-24T00:00:00.000Z',
    };
    const saved = await client.request({
      type: 'save_settings',
      settings: initialSettings,
    }) as { ok: boolean; data?: { revision: number } };
    expect(saved).toMatchObject({ ok: true, data: { revision: 1 } });

    const createCommand = { type: 'create_session' as const, requestId: 'primary-session-create', input: {} };
    const created = await client.request(createCommand) as { ok: boolean; data?: { sessionId: number } };
    expect(created.ok).toBe(true);
    if (!created.ok || !created.data) return;
    const workspaceBound = await client.request({
      type: 'update_workspace', requestId: 'bind-primary-session',
      input: { expectedRevision: 0, change: { kind: 'session', sessionId: created.data.sessionId } },
    }) as { ok: boolean; data?: { revision: number; sessionId: number } };
    expect(workspaceBound).toMatchObject({ ok: true, data: { revision: 1, sessionId: created.data.sessionId } });
    const workspace = { revision: 1, documentRef: null, jobId: null, candidateRef: null, sessionId: created.data.sessionId };
    const duplicateCreate = await client.request(createCommand) as { ok: boolean; error?: { code: string } };
    expect(duplicateCreate).toMatchObject({ ok: false, error: { code: 'request_duplicate' } });
    expect(await client.request({ type: 'list_sessions', input: { limit: 10 } })).toMatchObject({ ok: true, data: { items: [{ sessionId: created.data.sessionId }] } });
    expect(requestBodies).toHaveLength(0);
    expect(await client.request({ type: 'query_runtime_state' })).toMatchObject({ ok: true, data: { active: null } });

    // Model the Main-process race: it read revision 1, yielded while reading the
    // protected credential, and settings advanced before start_run reached Host.
    const updated = await client.request({
      type: 'save_settings',
      settings: { ...initialSettings, revision: 1, models: [{ ...profile, name: 'Changed during credential lookup' }] },
    }) as { ok: boolean; data?: { revision: number } };
    expect(updated).toMatchObject({ ok: true, data: { revision: 2 } });

    const stale = await client.request({
      type: 'start_run', requestId: 'stale-agent-run',
      input: { sessionId: created.data.sessionId, text: 'stale config must not dispatch', modelId: 'fixture-model', workspace, goalMode: 'answer' },
      expectedSettingsRevision: saved.data?.revision ?? 1, expectedCredentialRef: 'credential_reference_1234',
    }) as { ok: boolean; error?: { code: string } };
    expect(stale).toMatchObject({ ok: false, error: { code: 'state_conflict' } });
    expect(requestBodies).toHaveLength(0);

    const firstPending = client.request({
      type: 'start_run', requestId: 'first-agent-run',
      input: { sessionId: created.data.sessionId, text: '發票摘要：號碼 INV-2048，價稅合計 1060 元，日期缺失。', modelId: 'fixture-model', workspace, goalMode: 'answer' },
      expectedSettingsRevision: updated.data?.revision ?? 2, expectedCredentialRef: 'credential_reference_1234',
    }, 30_000) as Promise<{ ok: boolean; data?: { runId: number; sessionId: number } }>;
    const first = await firstPending;
    expect(first).toMatchObject({ ok: true, data: { runId: 1, sessionId: created.data.sessionId } });
    await waitFor(() => finished.some((event) => event.runId === 1));
    const duplicateStart = await client.request({
      type: 'start_run', requestId: 'first-agent-run',
      input: { sessionId: created.data.sessionId, text: 'must not replay a completed Run', modelId: 'fixture-model', workspace, goalMode: 'answer' },
      expectedSettingsRevision: updated.data?.revision ?? 2, expectedCredentialRef: 'credential_reference_1234',
    }) as { ok: boolean; error?: { code: string } };
    expect(duplicateStart).toMatchObject({ ok: false, error: { code: 'request_duplicate' } });
    expect(requestBodies).toHaveLength(1);

    const second = await client.request({
      type: 'start_run', requestId: 'follow-up-agent-run',
      input: { sessionId: created.data.sessionId, text: '剛才那張發票的價稅合計是多少？', modelId: 'fixture-model', workspace, goalMode: 'answer' },
      expectedSettingsRevision: updated.data?.revision ?? 2, expectedCredentialRef: 'credential_reference_1234',
    }) as { ok: boolean; data?: { runId: number; sessionId: number } };
    expect(second).toMatchObject({ ok: true, data: { runId: 2, sessionId: created.data.sessionId } });
    await waitFor(() => finished.some((event) => event.runId === 2));

    expect(finished.map((event) => event.runId)).toEqual([1, 2]);
    expect(finished[0].result).toMatchObject({ ok: true, data: { status: 'completed', text: replies[0] } });
    expect(finished[1].result).toMatchObject({ ok: true, data: { status: 'completed', text: replies[1] } });
    expect(requestBodies).toHaveLength(2);
    expect(requestBodies.every(({ authorization }) => authorization === 'Bearer synthetic-host-agent-key')).toBe(true);
    expect(credentialRequests).toContain('read');
    expect(requestBodies.map(({ body }) => (body.tools ?? []).map((tool) =>
      (tool as { function?: { name?: string } }).function?.name).sort())).toEqual([
      ['bash', 'calculate_invoice_amounts', 'edit', 'find', 'grep', 'ls', 'normalize_invoice_values', 'powershell', 'read', 'write'],
      ['bash', 'calculate_invoice_amounts', 'edit', 'find', 'grep', 'ls', 'normalize_invoice_values', 'powershell', 'read', 'write'],
    ]);
    expect(JSON.stringify(requestBodies[0].body.messages)).toContain('INV-2048');
    expect(JSON.stringify(requestBodies[1].body.messages)).toContain('INV-2048');
    expect(JSON.stringify(requestBodies[1].body.messages)).toContain(replies[0]);
    expect(JSON.stringify(requestBodies[1].body.messages)).toContain('價稅合計是多少');

    const trace = await client.request({ type: 'query_prompt_trace', runId: 2, callSequence: 1 }) as {
      ok: boolean;
      data?: { availability: string; droppedCalls: number | null; calls: Array<{ runId: number; sessionId: number; callSequence: number; state: string; entries: Array<{ event: string; summary: string }> }> };
    };
    expect(trace).toMatchObject({ ok: true, data: { availability: 'available', calls: [{ runId: 2, sessionId: created.data.sessionId, callSequence: 1, state: 'ended' }] } });
    expect(trace.data?.calls[0].entries.map((entry) => entry.event)).toContain('model_request');
    expect(trace.data?.calls[0].entries.map((entry) => entry.event)).toContain('native_terminal');
    const traceText = JSON.stringify(trace.data);
    expect(traceText).not.toContain('Invoice summary');
    expect(traceText).not.toContain(replies[1]);

    const runs = await client.request({ type: 'list_session_runs', input: { sessionId: created.data.sessionId, limit: 10 } });
    expect(runs).toMatchObject({ ok: true, data: { items: [
      { runId: 2, kind: 'agent', status: 'completed', sessionId: created.data.sessionId },
      { runId: 1, kind: 'agent', status: 'completed', sessionId: created.data.sessionId },
    ] } });

    const renamed = await client.request({ type: 'rename_session', requestId: 'rename-primary-session',
      input: { sessionId: created.data.sessionId, title: 'Renamed invoice session' } });
    expect(renamed).toMatchObject({ ok: true, data: { sessionId: created.data.sessionId, title: 'Renamed invoice session' } });
    const other = await client.request({ type: 'create_session', requestId: 'other-session-create', input: { title: 'Other Session' } }) as { ok: boolean; data?: { sessionId: number } };
    expect(other.ok).toBe(true);
    if (!other.data) return;
    const deleted = await client.request({ type: 'delete_session', requestId: 'delete-other-session', sessionId: other.data.sessionId });
    expect(deleted).toEqual({ ok: true, data: { deletedSessionId: other.data.sessionId, disposition: 'permanent' } });
    expect(await client.request({ type: 'query_session', sessionId: created.data.sessionId })).toMatchObject({ ok: true, data: { sessionId: created.data.sessionId } });
    expect(await client.request({ type: 'query_session', sessionId: other.data.sessionId })).toMatchObject({ ok: false, error: { code: 'session_not_found' } });
    expect(await client.request({ type: 'query_run', runId: 1 })).toMatchObject({ ok: true, data: { kind: 'agent', sessionId: created.data.sessionId } });
    expect(await client.request({ type: 'query_prompt_trace', runId: 2, callSequence: 1 })).toMatchObject({ ok: true, data: { availability: 'available' } });
    expect(await client.request({ type: 'list_sessions', input: { limit: 10 } })).toMatchObject({ ok: true, data: { items: [{ sessionId: created.data.sessionId }] } });
  } finally {
    const child = (client as unknown as { child: ChildProcessWithoutNullStreams }).child;
    await client.close();
    if (child && child.exitCode === null) {
      child.kill();
      await Promise.race([once(child, 'exit'), new Promise((resolveExit) => setTimeout(resolveExit, 1_000))]);
    }
    server.stop(true);
  }
}, 30_000);

it('queries real Pi messages through Host across tool delivery, model changes, Session isolation and restart', async () => {
  const repoRoot = resolve(import.meta.dir, '../..');
  const userDataRoot = await mkdtemp(join(tmpdir(), 'flowmate-host-p4-messages-'));
  type WireMessage = { role: string; content?: unknown; tool_call_id?: string };
  const requests: Array<{ model: string; messages: WireMessage[] }> = [];
  const callId = 'call-p4-host-1';
  const args = { operation: 'tax', netAmount: '100', taxRate: '13', scale: 2 };
  const reply = '精确税额是 13.00 元。';
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    const body = await request.json() as typeof requests[number];
    requests.push(body);
    const chunk = (delta: Record<string, unknown>, finishReason: string | null = null) =>
      `data: ${JSON.stringify({ id: `p4-host-${requests.length}`, object: 'chat.completion.chunk', created: 1,
        model: body.model, choices: [{ index: 0, delta, finish_reason: finishReason }] })}\n\n`;
    const stream = requests.length === 1
      ? `${chunk({ role: 'assistant', tool_calls: [{ index: 0, id: callId, type: 'function',
        function: { name: 'calculate_invoice_amounts', arguments: JSON.stringify(args) } }] })}${chunk({}, 'tool_calls')}`
      : `${chunk({ role: 'assistant', content: reply })}${chunk({}, 'stop')}`;
    return new Response(`${stream}data: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } });
  } });
  const clients: HostClient[] = [];
  const finished: Array<{ runId: number; result: unknown }> = [];
  const upserts: Array<{ runId: number; sessionId: number; message: SessionMessageView }> = [];
  const credentials: string[] = [];
  const newClient = () => {
    const client = new HostClient();
    clients.push(client);
    client.setCredentialHandler(async (request) => {
      credentials.push(request.operation);
      return request.operation === 'read' ? { ok: true, credential: { type: 'api_key', key: 'synthetic-p4-host-key' } } : { ok: false };
    });
    client.subscribe((event) => {
      if (event.type !== 'agent_run_event') return;
      if (event.value.type === 'run_finished') finished.push({ runId: event.value.runId, result: event.value.result });
      if (event.value.type === 'message_upsert') upserts.push({ runId: event.value.runId, sessionId: event.value.sessionId, message: event.value.message });
    });
    return client;
  };
  const client = newClient();
  try {
    expect((await client.start(userDataRoot, '0.1.0', repoRoot)).ok).toBe(true);
    const created = await client.request({ type: 'create_session', requestId: 'p4-primary', input: { title: 'Tax discussion' } }) as Result<{ sessionId: number }>;
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const sessionId = created.data.sessionId;
    expect(await client.request({ type: 'list_session_messages', input: { sessionId, limit: 20 } }))
      .toMatchObject({ ok: true, data: { items: [], leafId: null, entryCount: 0 } });
    const profile = { id: 'p4-model-a', credentialRef: 'p4_host_credential_ref_a', name: 'P4 A', kind: 'custom' as const,
      providerId: null, baseUrl: `http://127.0.0.1:${server.port}/v1`, model: 'host-p4-model-a', api: 'openai-completions',
      contextWindow: 64_000, maxTokens: 16_384, reasoning: false };
    const alternate = { ...profile, id: 'p4-model-b', credentialRef: 'p4_host_credential_ref_b', name: 'P4 B', model: 'host-p4-model-b' };
    expect(await client.request({ type: 'save_settings', settings: { version: 2, revision: 0,
      profile: { displayName: 'P4 messages', theme: 'system' }, models: [profile, alternate], defaultModelId: profile.id,
      updatedAt: '2026-09-30T00:00:00.000Z' } })).toMatchObject({ ok: true, data: { revision: 1 } });
    expect(await client.request({ type: 'update_workspace', requestId: 'p4-bind-primary',
      input: { expectedRevision: 0, change: { kind: 'session', sessionId } } })).toMatchObject({ ok: true, data: { revision: 1 } });
    const workspace = { revision: 1, documentRef: null, jobId: null, candidateRef: null, sessionId };
    const firstText = '请计算 100 元按 13% 税率的税额，记住这是 P4_PRIMARY_ONLY。';
    const first = await client.request({ type: 'start_run', requestId: 'p4-run-first',
      input: { sessionId, text: firstText, modelId: profile.id, workspace, goalMode: 'answer' },
      expectedSettingsRevision: 1, expectedCredentialRef: profile.credentialRef }) as Result<{ runId: number }>;
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    await waitFor(() => finished.some((event) => event.runId === first.data.runId));
    expect(finished.find((event) => event.runId === first.data.runId)?.result).toMatchObject({ ok: true, data: { status: 'completed', text: reply } });
    expect(requests).toHaveLength(2);
    const toolWire = requests[1]!.messages.find((message) => message.role === 'tool');
    expect(toolWire?.tool_call_id).toBe(callId);
    expect(JSON.parse(String(toolWire?.content))).toMatchObject({ operation: 'tax', exact: '13', rounded: '13.00', scale: 2 });
    const firstPage = await client.request({ type: 'list_session_messages', input: { sessionId, limit: 100 } }) as Result<SessionMessagesPage>;
    expect(firstPage.ok).toBe(true);
    if (!firstPage.ok) return;
    expect(firstPage.data.items.map((message) => message.role)).toEqual(['user', 'assistant', 'toolResult', 'assistant']);
    expect(firstPage.data.items.every((message) => message.runId === first.data.runId && message.entryId !== null && message.liveOrdinal !== null
      && message.phase === 'ended' && message.persistence === 'saved' && SessionMessageViewSchema.safeParse(message).success)).toBe(true);
    expect(firstPage.data.items[0]).toMatchObject({ textOrigin: 'product-input', blocks: [{ type: 'text', text: firstText }] });
    expect(firstPage.data.items[1]).toMatchObject({ blocks: [{ type: 'toolCall', id: callId, name: 'calculate_invoice_amounts' }] });
    expect(firstPage.data.items[2]).toMatchObject({ toolCallId: callId, toolName: 'calculate_invoice_amounts', isError: false });
    const firstSaved = upserts.filter((event) => event.runId === first.data.runId && event.message.persistence === 'saved');
    expect(new Set(firstSaved.map((event) => event.message.entryId)).size).toBe(4);
    for (const message of firstPage.data.items) expect(firstSaved).toContainEqual({ runId: first.data.runId, sessionId, message });
    const noQueryRequests = requests.length;
    const noQueryCredentials = credentials.length;
    expect(await client.request({ type: 'list_session_messages', input: { sessionId, limit: 100 } })).toEqual(firstPage);
    expect(requests).toHaveLength(noQueryRequests);
    expect(credentials).toHaveLength(noQueryCredentials);

    const secondText = '为什么这个税额是 13 元？沿用上一轮记忆回答。';
    const second = await client.request({ type: 'start_run', requestId: 'p4-run-switch-model',
      input: { sessionId, text: secondText, modelId: alternate.id, workspace, goalMode: 'answer' },
      expectedSettingsRevision: 1, expectedCredentialRef: alternate.credentialRef }) as Result<{ runId: number }>;
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    await waitFor(() => finished.some((event) => event.runId === second.data.runId));
    expect(requests).toHaveLength(3);
    expect(requests[2]!.model).toBe(alternate.model);
    expect(JSON.stringify(requests[2]!.messages)).toContain('P4_PRIMARY_ONLY');
    expect(JSON.stringify(requests[2]!.messages)).toContain(reply);
    expect(requests[2]!.messages.filter((message) => message.role === 'user')).toHaveLength(2);
    expect(requests[2]!.messages.filter((message) => message.role === 'tool')).toHaveLength(1);
    expect(await client.request({ type: 'query_run', runId: second.data.runId })).toMatchObject({ ok: true,
      data: { config: { requestedModel: { model: alternate.model }, resolvedModel: { model: alternate.model } } } });
    const all = await client.request({ type: 'list_session_messages', input: { sessionId, limit: 100 } }) as Result<SessionMessagesPage>;
    expect(all.ok).toBe(true);
    if (!all.ok) return;
    expect(all.data.items).toHaveLength(6);
    expect(all.data.items.slice(0, 4)).toEqual(firstPage.data.items);
    expect(all.data.items.slice(4).map((message) => message.runId)).toEqual([second.data.runId, second.data.runId]);
    const recent = await client.request({ type: 'list_session_messages', input: { sessionId, limit: 2 } }) as Result<SessionMessagesPage>;
    expect(recent.ok).toBe(true);
    if (!recent.ok) return;
    expect(recent.data.items).toEqual(all.data.items.slice(4));
    expect(recent.data.nextBeforeEntryId).toBe(recent.data.items[0]!.entryId);
    const older = await client.request({ type: 'list_session_messages', input: { sessionId,
      beforeEntryId: recent.data.nextBeforeEntryId!, limit: 100 } }) as Result<SessionMessagesPage>;
    expect(older).toMatchObject({ ok: true, data: { items: firstPage.data.items, nextBeforeEntryId: null } });

    const other = await client.request({ type: 'create_session', requestId: 'p4-other', input: { title: 'Other tax discussion' } }) as Result<{ sessionId: number }>;
    expect(other.ok).toBe(true);
    if (!other.ok) return;
    expect(await client.request({ type: 'update_workspace', requestId: 'p4-bind-other',
      input: { expectedRevision: 1, change: { kind: 'session', sessionId: other.data.sessionId } } })).toMatchObject({ ok: true, data: { revision: 2 } });
    const isolated = await client.request({ type: 'start_run', requestId: 'p4-run-other', input: { sessionId: other.data.sessionId,
      text: 'P4_OTHER_ONLY 独立对话', modelId: alternate.id, workspace: { ...workspace, revision: 2, sessionId: other.data.sessionId }, goalMode: 'answer' },
      expectedSettingsRevision: 1, expectedCredentialRef: alternate.credentialRef }) as Result<{ runId: number }>;
    expect(isolated.ok).toBe(true);
    if (!isolated.ok) return;
    await waitFor(() => finished.some((event) => event.runId === isolated.data.runId));
    expect(requests).toHaveLength(4);
    expect(JSON.stringify(requests[3]!.messages)).not.toContain('P4_PRIMARY_ONLY');
    expect(requests[3]!.messages.filter((message) => message.role === 'user')).toHaveLength(1);
    const otherPage = await client.request({ type: 'list_session_messages', input: { sessionId: other.data.sessionId, limit: 100 } }) as Result<SessionMessagesPage>;
    expect(otherPage).toMatchObject({ ok: true, data: { items: [{ role: 'user', runId: isolated.data.runId }, { role: 'assistant', runId: isolated.data.runId }] } });
    expect(await client.request({ type: 'list_session_messages', input: { sessionId, limit: 100 } })).toEqual(all);

    expect(await client.close()).toMatchObject({ ok: true, data: { closed: true } });
    const databaseFile = join(userDataRoot, 'data', 'app.sqlite');
    const savedDb = new Database(databaseFile, { readonly: true });
    const savedRows = savedDb.query('SELECT session_id,sequence,entry_id,entry_json,run_id FROM session_native_entries ORDER BY session_id,sequence').all();
    const savedHeads = savedDb.query('SELECT * FROM session_native_history ORDER BY session_id').all();
    const readToolFacts = (toolDb: Database) => ({
      counts: toolDb.query(`SELECT (SELECT COUNT(*) FROM tool_calls) AS tools,
        (SELECT COUNT(*) FROM session_inputs) AS inputs,
        (SELECT COUNT(*) FROM runtime_events) AS events`).get(),
      tools: toolDb.query('SELECT * FROM tool_calls ORDER BY id').all(),
      inputs: toolDb.query('SELECT * FROM session_inputs ORDER BY id').all(),
      runs: toolDb.query('SELECT * FROM runs ORDER BY id').all(),
      events: toolDb.query('SELECT * FROM runtime_events ORDER BY run_id,sequence').all(),
    });
    const beforeToolsRead = { facts: readToolFacts(savedDb), requests: requests.length, credentials: credentials.length,
      finished: finished.length, upserts: upserts.length };
    expect(beforeToolsRead.facts.counts).toMatchObject({ tools: 1, inputs: 3 });
    const storedTool = savedDb.query('SELECT id,run_id,session_id,args_json,result_json FROM tool_calls').get() as {
      id: number; run_id: number; session_id: number; args_json: string; result_json: string;
    };
    expect(storedTool).toMatchObject({ run_id: first.data.runId, session_id: sessionId });
    expect(JSON.parse(storedTool.args_json)).toMatchObject({ raw: args, final: args });
    expect(storedTool.result_json).toContain('13.00');
    expect(savedDb.query('SELECT native_tool_call_id,status,delivery_json FROM tool_calls').all()).toEqual([{ native_tool_call_id: callId, status: 'succeeded',
      delivery_json: expect.stringContaining('"state":"request_observed"') }]);
    expect(savedDb.query('SELECT COUNT(*) AS count FROM tool_calls').get()).toEqual({ count: 1 });
    expect(savedDb.query('SELECT entry_id FROM session_native_entries WHERE run_id=? AND json_extract(entry_json,\'$.type\')=\'message\' ORDER BY sequence')
      .all(first.data.runId)).toEqual(firstPage.data.items.map((message) => ({ entry_id: message.entryId })));
    expect(savedDb.query('PRAGMA foreign_key_check').all()).toEqual([]);
    savedDb.close();
    const restarted = newClient();
    expect((await restarted.start(userDataRoot, '0.1.0', repoRoot)).ok).toBe(true);
    // Public Activity queries read the actual SDK Tool from the restarted Host SQL store.
    const toolsPage = await restarted.request({ type: 'list_run_tool_calls',
      input: { runId: first.data.runId, sessionId, limit: 100 } }) as Result<Page<RuntimeToolView>>;
    expect(toolsPage.ok).toBe(true);
    if (!toolsPage.ok) throw new Error('The actual Agent Tool list must be readable.');
    expect(RuntimeToolPageSchema.safeParse(toolsPage.data).success).toBe(true);
    expect(toolsPage.data.nextBeforeId).toBeNull();
    expect(toolsPage.data.items).toHaveLength(1);
    const actualTool = toolsPage.data.items[0]!;
    expect(actualTool).toMatchObject({ toolCallId: storedTool.id, runId: first.data.runId, sessionId,
      toolName: 'calculate_invoice_amounts', status: 'succeeded', committedCandidateId: null,
      errorCode: null, stopped: true, deliveryState: 'request_observed', formApplicationOutcome: null });
    expect(actualTool.requestedAt).toBeString();
    expect(actualTool.startedAt).toBeString();
    expect(actualTool.endedAt).toBeString();
    expect(Object.keys(actualTool).sort()).toEqual(['toolCallId', 'runId', 'sessionId', 'toolName', 'status',
      'requestedAt', 'startedAt', 'endedAt', 'stoppedAt', 'committedCandidateId', 'errorCode', 'stopped',
      'deliveryState', 'formApplicationOutcome'].sort());
    expect(RuntimeToolViewSchema.safeParse(actualTool).success).toBe(true);
    expect(JSON.stringify(actualTool)).not.toContain('netAmount');
    expect(JSON.stringify(actualTool)).not.toContain('taxRate');
    expect(JSON.stringify(actualTool)).not.toContain('rounded');
    expect(JSON.stringify(actualTool)).not.toContain(reply);
    const oneTool = await restarted.request({ type: 'query_run_tool_call',
      input: { runId: first.data.runId, sessionId, toolCallId: storedTool.id } }) as Result<RuntimeToolView>;
    expect(oneTool).toEqual({ ok: true, data: actualTool });
    expect(await restarted.request({ type: 'list_run_tool_calls',
      input: { runId: first.data.runId, sessionId, beforeId: storedTool.id, limit: 1 } }))
      .toEqual({ ok: true, data: { items: [], nextBeforeId: null } });
    expect(await restarted.request({ type: 'list_run_tool_calls',
      input: { runId: first.data.runId, sessionId: other.data.sessionId, limit: 50 } }))
      .toMatchObject({ ok: false, error: { code: 'state_conflict' } });
    expect(await restarted.request({ type: 'query_run_tool_call',
      input: { runId: first.data.runId, sessionId: other.data.sessionId, toolCallId: storedTool.id } }))
      .toMatchObject({ ok: false, error: { code: 'state_conflict' } });
    expect(await restarted.request({ type: 'query_run_tool_call',
      input: { runId: second.data.runId, sessionId, toolCallId: storedTool.id } }))
      .toMatchObject({ ok: false, error: { code: 'state_conflict' } });
    expect(await restarted.request({ type: 'query_run_tool_call',
      input: { runId: isolated.data.runId, sessionId: other.data.sessionId, toolCallId: storedTool.id } }))
      .toMatchObject({ ok: false, error: { code: 'state_conflict' } });
    expect(await restarted.request({ type: 'list_run_tool_calls', input: { runId: second.data.runId, sessionId, limit: 50 } }))
      .toEqual({ ok: true, data: { items: [], nextBeforeId: null } });
    const beforeRead = { requests: requests.length, credentials: credentials.length, events: upserts.length };
    const recovered = await restarted.request({ type: 'list_session_messages', input: { sessionId, limit: 100 } }) as Result<SessionMessagesPage>;
    expect(recovered.ok).toBe(true);
    if (!recovered.ok) return;
    expect(recovered.data.items).toEqual(all.data.items.map((message) => ({ ...message, liveOrdinal: null })));
    expect(recovered.data.leafId).toBe(all.data.leafId);
    expect(recovered.data.session).toMatchObject({ availability: 'ready', historyState: 'recoverable' });
    expect(await restarted.request({ type: 'query_prompt_trace', runId: first.data.runId }))
      .toMatchObject({ ok: true, data: { availability: 'process-exited', calls: [], droppedCalls: null } });
    expect(await restarted.request({ type: 'query_prompt_trace', runId: isolated.data.runId, callSequence: 1 }))
      .toMatchObject({ ok: true, data: { availability: 'process-exited', calls: [], droppedCalls: null } });
    expect(await restarted.request({ type: 'list_session_messages', input: { sessionId: other.data.sessionId, limit: 100 } }))
      .toMatchObject({ ok: true, data: { items: [{ runId: isolated.data.runId, liveOrdinal: null }, { runId: isolated.data.runId, liveOrdinal: null }] } });
    expect({ requests: requests.length, credentials: credentials.length, events: upserts.length }).toEqual(beforeRead);
    expect(await restarted.close()).toMatchObject({ ok: true, data: { closed: true } });
    const unchanged = new Database(databaseFile, { readonly: true });
    try {
      expect({ facts: readToolFacts(unchanged), requests: requests.length, credentials: credentials.length,
        finished: finished.length, upserts: upserts.length }).toEqual(beforeToolsRead);
      expect(unchanged.query('SELECT session_id,sequence,entry_id,entry_json,run_id FROM session_native_entries ORDER BY session_id,sequence').all()).toEqual(savedRows);
      expect(unchanged.query('SELECT * FROM session_native_history ORDER BY session_id').all()).toEqual(savedHeads);
      expect(unchanged.query('SELECT COUNT(*) AS count FROM tool_calls').get()).toEqual({ count: 1 });
    } finally { unchanged.close(); }
    const resumed = newClient();
    expect((await resumed.start(userDataRoot, '0.1.0', repoRoot)).ok).toBe(true);
    expect(await resumed.request({ type: 'update_workspace', requestId: 'p4-restore-workspace',
      input: { expectedRevision: 2, change: { kind: 'session', sessionId } } })).toMatchObject({ ok: true, data: { revision: 3 } });
    const resumedRun = await resumed.request({ type: 'start_run', requestId: 'p4-resumed-run', input: { sessionId,
      text: '恢复后再解释 P4_RESUME_ONLY。', modelId: alternate.id, workspace: { ...workspace, revision: 3 }, goalMode: 'answer' },
      expectedSettingsRevision: 1, expectedCredentialRef: alternate.credentialRef }) as Result<{ runId: number }>;
    expect(resumedRun.ok).toBe(true);
    if (!resumedRun.ok) return;
    await waitFor(() => finished.some((event) => event.runId === resumedRun.data.runId));
    expect(finished.find((event) => event.runId === resumedRun.data.runId)?.result).toMatchObject({ ok: true, data: { status: 'completed' } });
    expect(requests).toHaveLength(5);
    expect(JSON.stringify(requests[4]!.messages)).toContain('P4_PRIMARY_ONLY');
    expect(JSON.stringify(requests[4]!.messages)).not.toContain('P4_OTHER_ONLY');
    expect(JSON.stringify(requests[4]!.messages)).toContain('P4_RESUME_ONLY');
    expect(requests[4]!.messages.filter((message) => message.role === 'tool')).toHaveLength(1);
    expect(requests[4]!.messages.filter((message) => message.role === 'user')).toHaveLength(3);
    const resumedPage = await resumed.request({ type: 'list_session_messages', input: { sessionId, limit: 100 } }) as Result<SessionMessagesPage>;
    expect(resumedPage.ok).toBe(true);
    if (!resumedPage.ok) return;
    expect(resumedPage.data.items.slice(0, 6)).toEqual(all.data.items.map((message) => ({ ...message, liveOrdinal: null })));
    expect(resumedPage.data.items.slice(6).map((message) => [message.runId, message.liveOrdinal])).toEqual([
      [resumedRun.data.runId, 1], [resumedRun.data.runId, 2],
    ]);
    expect(await resumed.close()).toMatchObject({ ok: true, data: { closed: true } });
  } finally {
    for (const active of clients) await active.close();
    server.stop(true);
  }
}, 30_000);

it('retains the actual Host late applied receipt after cancellation without changing terminal core or delivery', async () => {
  const repoRoot = resolve(import.meta.dir, '../..');
  const userDataRoot = await mkdtemp(join(tmpdir(), 'flowmate-host-late-form-'));
  const sourceRoot = await mkdtemp(join(tmpdir(), 'flowmate-host-late-source-')), source = join(sourceRoot, '000001');
  mkdirSync(source, { recursive: true });
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/a54AAAAASUVORK5CYII=', 'base64');
  const content = JSON.stringify([{ type: 'text', text: 'Synthetic late receipt invoice', bbox: [0, 0, 1, 1], page_idx: 0 }]);
  const pages = JSON.stringify([{ pageNumber: 1, text: 'Synthetic late receipt invoice', blockCount: 1 }]);
  writeFileSync(join(source, 'original.png'), png); writeFileSync(join(source, 'content.json'), content); writeFileSync(join(source, 'pages.json'), pages);
  writeFileSync(join(source, 'metadata.json'), JSON.stringify({ schemaVersion: 1, sampleId: '000001',
    datasetId: 'voxel51-hq-invoice-ocr', sourceRecordId: 'host-late-form', datasetRevision: 'host-late-fixture', qualityStatus: 'complete',
    allowedUsesClaim: ['local test'], licenseVerification: 'not_verified', files: [{ path: 'original.png', bytes: png.length },
      { path: 'content.json', bytes: Buffer.byteLength(content) }, { path: 'pages.json', bytes: Buffer.byteLength(pages) }] }));
  const missing = { raw: null, normalized: null, state: 'missing', alternatives: [], sources: [] };
  const candidate = { fields: Object.fromEntries(['invoiceNumber', 'issueDate', 'sellerName', 'sellerTaxId', 'buyerName',
    'buyerTaxId', 'currency', 'netAmount', 'taxAmount', 'totalAmount'].map(name => [name, missing])), lines: [], notes: [] };
  const requests: Array<{ tools?: Array<{ function: { name: string } }>; messages: Array<{ tool_call_id?: string }> }> = [];
  const response = (value: string | { name: string; id: string; args: unknown }) => {
    const chunk = (delta: unknown, finish_reason: string | null) => `data: ${JSON.stringify({ id: 'host-late-form', object: 'chat.completion.chunk',
      created: 1, model: 'host-late-model', choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
    const delta = typeof value === 'string' ? { role: 'assistant', content: value } : { role: 'assistant', tool_calls: [{ index: 0,
      id: value.id, type: 'function', function: { name: value.name, arguments: JSON.stringify(value.args) } }] };
    return new Response(`${chunk(delta, null)}${chunk({}, typeof value === 'string' ? 'stop' : 'tool_calls')}data: [DONE]\n\n`,
      { headers: { 'content-type': 'text/event-stream' } });
  };
  let candidateId = 0, documentId = 0;
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    const body = await request.json() as typeof requests[number]; requests.push(body);
    if (body.tools?.some(tool => tool.function.name === 'fill_invoice_form'))
      return response({ name: 'fill_invoice_form', id: 'host-late-apply', args: { candidateId } });
    return body.messages.some(message => message.tool_call_id === 'host-late-save') ? response('Candidate ready.')
      : response({ name: 'save_invoice_candidate', id: 'host-late-save', args: { documentId, candidate } });
  } });
  const client = new HostClient();
  client.setCredentialHandler(async () => ({ ok: true, credential: { type: 'api_key', key: 'synthetic-host-late-form-key' } }));
  const finished: number[] = [], bridgeCalls: InvoiceFormBridgeRequest[] = [];
  client.subscribe(event => { if (event.type === 'agent_run_event' && event.value.type === 'run_finished') finished.push(event.value.runId); });
  let replyLate!: (receipt: InvoiceFormApplicationReceipt) => void, dispatchedAt = 0;
  client.setInvoiceFormHandler(async request => {
    bridgeCalls.push(request);
    if (request.operation === 'query') return { runId: request.runId, toolCallId: request.toolCallId, formInstanceId: request.target.formInstanceId,
      candidateId: request.candidateId, candidateSequence: request.candidateSequence, outcome: 'unknown', observedAt: new Date().toISOString() };
    dispatchedAt = Date.now();
    return new Promise(resolveReply => { replyLate = resolveReply; });
  });
  const need = <T>(result: Result<T>): T => { if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`); return result.data; };
  let db: Database | null = null;
  try {
    expect(await client.start(userDataRoot, '0.1.0', repoRoot, sourceRoot)).toMatchObject({ ok: true, data: { ready: true } });
    const model = { id: 'host-late-model', credentialRef: 'host_late_form_credential', name: 'Host late form', kind: 'custom' as const,
      providerId: null, baseUrl: `http://127.0.0.1:${server.port}/v1`, model: 'host-late-model', api: 'openai-completions',
      contextWindow: 64_000, maxTokens: 16_384, reasoning: false };
    expect(await client.request({ type: 'save_settings', settings: { version: 2, revision: 0, profile: { displayName: 'Host late form', theme: 'system' },
      models: [model], defaultModelId: model.id, updatedAt: '2026-10-01T00:00:00.000Z' } })).toMatchObject({ ok: true, data: { revision: 1 } });
    const document = need(await client.request({ type: 'import_invoice_material', sourceDirectory: source }) as Result<DocumentSnapshot>);
    documentId = document.documentRef.id;
    const session = need(await client.request({ type: 'create_session', input: {} }) as Result<{ sessionId: number }>);
    let workspace = need(await client.request({ type: 'read_workspace' }) as Result<WorkspaceSnapshot>);
    workspace = need(await client.request({ type: 'update_workspace', input: { expectedRevision: workspace.revision,
      change: { kind: 'session', sessionId: session.sessionId } } }) as Result<WorkspaceSnapshot>);
    workspace = need(await client.request({ type: 'update_workspace', input: { expectedRevision: workspace.revision,
      change: { kind: 'document', documentId } } }) as Result<WorkspaceSnapshot>);
    const task = need(await client.request({ type: 'start_task', input: { clientSequence: 1, expectedRevision: workspace.revision,
      documentRef: document.documentRef, goal: 'Prepare selected candidate for a late form receipt.' } }) as Result<TaskOperation>);
    const expectation = (value: WorkspaceSnapshot) => ({ revision: value.revision, sessionId: session.sessionId,
      documentRef: value.documentRef, jobId: value.jobId, candidateRef: value.candidateRef });
    const generated = need(await client.request({ type: 'start_run', input: { sessionId: session.sessionId, text: 'Save the controlled candidate.',
      modelId: model.id, goalMode: 'save-candidate', workspace: expectation(task.workspace) }, expectedSettingsRevision: 1,
      expectedCredentialRef: model.credentialRef }) as Result<RunAccepted>);
    await waitFor(() => finished.includes(generated.runId));
    const list = need(await client.request({ type: 'list_job_candidates', input: { jobId: task.job.jobId } }) as Result<{ items: Array<{ candidateId: number }> }>);
    candidateId = list.items[0]!.candidateId;
    workspace = need(await client.request({ type: 'read_workspace' }) as Result<WorkspaceSnapshot>);
    const selected = need(await client.request({ type: 'select_candidate', input: { jobId: task.job.jobId, candidateId,
      expectedCandidateId: workspace.candidateRef?.id ?? null, expectedRevision: workspace.revision } }) as Result<CandidateSelection>);
    const nextInput = need(await client.request({ type: 'query_session_input', input: { sessionId: session.sessionId } }) as Result<{ nextClientSequence: number | null }>);
    if (nextInput.nextClientSequence === null) throw new Error('Fixture input sequence is exhausted.');
    const fill = need(await client.request({ type: 'submit_invoice_form_input', input: { modelId: model.id, clientSequence: nextInput.nextClientSequence,
      target: { formInstanceId: 'host-late-form-instance', expectedRevision: 0 }, workspace: expectation(selected.workspace) },
      expectedSettingsRevision: 1, expectedCredentialRef: model.credentialRef }) as Result<RunAccepted>);
    await waitFor(() => bridgeCalls.some(call => call.operation === 'apply'));
    const apply = bridgeCalls.find(call => call.operation === 'apply')!;
    const appliedAt = new Date().toISOString(); // The action occurred before cancel; its reply is still in transit.
    expect(await client.request({ type: 'cancel_run', runId: fill.runId })).toMatchObject({ ok: true });
    await waitFor(() => finished.includes(fill.runId));
    const beforeRun = await client.request({ type: 'query_run', runId: fill.runId }), beforeRequests = requests.length;
    expect(beforeRun).toMatchObject({ ok: true, data: { status: 'cancelled' } });
    expect(await client.request({ type: 'query_invoice_form_application', input: { runId: fill.runId, toolCallId: apply.toolCallId } }))
      .toMatchObject({ ok: true, data: { outcome: 'unknown' } });
    expect(Date.now() - dispatchedAt).toBeLessThan(3_000);
    replyLate({ runId: apply.runId, toolCallId: apply.toolCallId, formInstanceId: apply.target.formInstanceId, candidateId: apply.candidateId,
      candidateSequence: apply.candidateSequence, outcome: 'applied', appliedRevision: 1, observedAt: new Date().toISOString(), appliedAt });
    // Allow the original Host response to cross the pipe, then use a public read barrier.
    // SQLite is EXCLUSIVE while Host lives; authoritative SQL is read only after normal close.
    await new Promise(resolveWait => setTimeout(resolveWait, 100));
    await client.request({ type: 'get_state' });
    expect(await client.request({ type: 'query_run', runId: fill.runId })).toEqual(beforeRun);
    expect(requests).toHaveLength(beforeRequests);
    expect(bridgeCalls.filter(call => call.operation === 'apply')).toHaveLength(1);
    expect(await client.request({ type: 'query_invoice_form_application', input: { runId: fill.runId, toolCallId: apply.toolCallId } }))
      .toMatchObject({ ok: true, data: { outcome: 'applied', appliedRevision: 1, appliedAt } });
    expect(await client.close()).toMatchObject({ ok: true, data: { closed: true } });
    db = new Database(join(userDataRoot, 'data', 'app.sqlite'), { readonly: true });
    const saved = db.query('SELECT status,result_json,delivery_json FROM tool_calls WHERE id=?').get(apply.toolCallId) as {
      status: string; result_json: string; delivery_json: string };
    expect(['failed', 'cancelled']).toContain(saved.status);
    expect(JSON.parse(saved.result_json)).toMatchObject({ formApplication: { outcome: 'applied' } });
    expect(JSON.parse(saved.result_json).data?.applied).not.toBe(true);
    expect(JSON.parse(saved.delivery_json).state).not.toBe('request_observed');
  } finally {
    db?.close();
    if (replyLate && bridgeCalls[0]) { const original = bridgeCalls[0]; replyLate({ runId: original.runId, toolCallId: original.toolCallId,
      formInstanceId: original.target.formInstanceId, candidateId: original.candidateId, candidateSequence: original.candidateSequence,
      outcome: 'unknown', observedAt: new Date().toISOString() }); }
    await client.close(); server.stop(true);
  }
}, 15_000);

async function waitFor(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!check() && Date.now() < deadline) await new Promise((resolveWait) => setTimeout(resolveWait, 10));
  expect(check()).toBe(true);
}
