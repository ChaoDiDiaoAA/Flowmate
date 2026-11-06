import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { appError, fail, ok, type Result } from '@flowmate/contracts';
import { createCloudDesktopHandler } from '../../../apps/cloud-desktop-gateway.ts';
import { CloudDesktopRelay } from '../../../apps/cloud-desktop-relay.ts';
import { callCloudUnixRpc, listenCloudUnixRpc } from '../../../apps/cloud-unix-rpc.ts';
import { mkdtempSync } from '../../support/resources.ts';

const workspaceId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const requestId = '11111111-1111-4111-8111-111111111111';
const at = '2026-10-29T00:00:00.000Z';
const configuration = { modelId: null, thinkingLevel: 'off', resources: { prompt: null, enabledSkills: [] },
  extensions: { enabledExtensions: [] }, tools: [], workingDirectory: null, preferences: '' } as const;
const snapshot = { personalAgentId: 1, revision: 0, runtimeKind: 'durable', configuration, createdAt: at, updatedAt: at };
const envelope = { version: 1, workspaceId, requestId, command: { type: 'personal_agent_get', input: {} } };
function need<T>(result: Result<T>): T { if (!result.ok) throw Error(result.error.code); return result.data; }

test('cloud relay commands deliver a request and validate the original receiver and reply', async () => {
  const relay = new CloudDesktopRelay(), connectionId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  const handle = createCloudDesktopHandler({ workspaceId, authorize: async () => ok(undefined), dispatch: async () => ok(snapshot), desktopRelay: relay });
  const command = (type: string, input: unknown) => ({ ...envelope, command: { type, input } });
  expect(await handle(command('cloud_desktop_attach', { connectionId }))).toEqual(ok({ connectionId }));
  const pending = relay.request({ kind: 'list', workId: 7, itemId: 8 }, new AbortController().signal);
  const next = need(await handle(command('cloud_desktop_next', { connectionId }))) as { event: { kind: string; id: string; request: unknown } };
  expect(next.event).toMatchObject({ kind: 'request', request: { kind: 'list', workId: 7, itemId: 8 } });
  const result = { ok: true as const, data: { kind: 'list' as const, windows: [] } };
  expect(await handle(command('cloud_desktop_reply', { connectionId, id: next.event.id, result }))).toEqual(ok({ connectionId }));
  expect(await pending).toEqual(result);
  expect(await handle(command('cloud_desktop_detach', { connectionId }))).toEqual(ok({ connectionId }));
});

test('the cloud desktop gateway permits only the original workspace and personal-agent command schemas', async () => {
  const accepted: unknown[] = [], dispatched: unknown[] = [];
  const handle = createCloudDesktopHandler({ workspaceId,
    authorize: async command => { accepted.push(command); return ok(undefined); },
    dispatch: async command => { dispatched.push(command); return ok(snapshot); } });
  expect(await handle(envelope)).toEqual({ ok: true, data: snapshot });
  for (const command of [
    { type: 'call_provider', input: {} }, { type: 'update_workspace', input: {} },
    { type: 'personal_agent_get', input: { extra: true } },
    { type: 'personal_agent_update', input: { personalAgentId: 1, expectedRevision: 0,
      configuration: { ...configuration, workingDirectory: process.platform === 'win32' ? 'C:\\Users\\local' : '/tmp/local' } } },
  ]) expect(await handle({ ...envelope, command })).toMatchObject({ ok: false, error: { code: 'input_invalid' } });
  expect(await handle({ ...envelope, workspaceId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' }))
    .toMatchObject({ ok: false, error: { code: 'cloud_workspace_forbidden' } });
  expect(accepted).toEqual([envelope.command]); expect(dispatched).toEqual([envelope.command]);
});

test('the cloud desktop gateway checks business authorization before dispatch and validates responses', async () => {
  let dispatched = 0;
  const denied = createCloudDesktopHandler({ workspaceId,
    authorize: async () => fail(appError('source_invalid', 'input', 'Not authorized.')),
    dispatch: async () => { dispatched++; return ok(snapshot); } });
  expect(await denied(envelope)).toMatchObject({ ok: false, error: { code: 'source_invalid' } });
  expect(dispatched).toBe(0);
  const wrong = createCloudDesktopHandler({ workspaceId, authorize: async () => ok(undefined),
    dispatch: async () => ok({ ...snapshot, personalAgentId: 'wrong' }) });
  expect(await wrong(envelope)).toMatchObject({ ok: false, error: { code: 'storage_read_failed' } });
  const lost = createCloudDesktopHandler({ workspaceId, authorize: async () => ok(undefined),
    dispatch: async () => { throw Error('controlled response loss'); } });
  expect(await lost({ ...envelope, command: { type: 'invoice_work_cancel',
    input: { workId: 7, requestId: 'original-cancel', expectedRevision: 0 } } }))
    .toMatchObject({ ok: false, error: { code: 'operation_result_unknown' } });
});

test('material progress is scoped to the workspace and the original upload', async () => {
  const uploadId = '22222222-2222-4222-8222-222222222222'; let calls = 0;
  const status = { workspaceId, uploadId, status: 'receiving' as const, receipt: null,
    files: [{ kind: 'original' as const, name: 'source.md' as const, offset: 3 },
      { kind: 'parsed' as const, name: 'parsed.json' as const, offset: 0 }] };
  const material = { begin: async () => ok({ status: 'receiving' as const, receipt: null }), append: async () => ok(undefined),
    finish: async () => fail(appError('source_invalid', 'input', 'Unavailable.')),
    status: async () => { calls++; return ok(status); } };
  const handle = createCloudDesktopHandler({ workspaceId, authorize: async () => ok(undefined),
    dispatch: async () => ok(snapshot), material });
  const command = { type: 'cloud_material_status', input: { workspaceId, uploadId } };
  expect(await handle({ ...envelope, command })).toEqual(ok(status));
  expect(await handle({ ...envelope, command: { ...command, input: { ...command.input,
    workspaceId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' } } })).toMatchObject({ ok: false });
  expect(calls).toBe(1);
  const wrong = createCloudDesktopHandler({ workspaceId, authorize: async () => ok(undefined), dispatch: async () => ok(snapshot),
    material: { ...material, status: async () => ok({ ...status, uploadId: requestId }) } });
  expect(await wrong({ ...envelope, command })).toMatchObject({ ok: false });
});

test('desktop queue commands retain the original Work and control receipt identity', async () => {
  const owner = { workId: 7, sessionId: 8, attemptId: 9 };
  const queue = { read: async () => ok({ ...owner, version: 1, items: [] }),
    apply: async (input: { controlRequestId: string }) => ok({ ...owner, controlRequestId: input.controlRequestId, status: 'applied' as const, version: 2 }),
    queryControl: async () => ok(null) };
  const handle = createCloudDesktopHandler({ workspaceId, authorize: async () => ok(undefined), dispatch: async () => ok(snapshot), queue });
  expect(await handle({ ...envelope, command: { type: 'cloud_queue_read', input: owner } })).toEqual(ok({ ...owner, version: 1, items: [] }));
  const input = { ...owner, controlRequestId: 'original-control', expectedVersion: 1, action: { kind: 'reorder', submissionIds: [] } };
  expect(await handle({ ...envelope, command: { type: 'cloud_queue_control', input } })).toMatchObject({ ok: true, data: { controlRequestId: input.controlRequestId } });
  const wrong = createCloudDesktopHandler({ workspaceId, authorize: async () => ok(undefined), dispatch: async () => ok(snapshot),
    queue: { ...queue, apply: async () => ok({ ...owner, controlRequestId: 'different', status: 'applied' as const, version: 2 }) } });
  expect(await wrong({ ...envelope, command: { type: 'cloud_queue_control', input } })).toMatchObject({ ok: false });
});

test('authorization and response validation use the original command even when a callback mutates its copy', async () => {
  const request = { ...envelope, command: { type: 'invoice_work_cancel', input: { workId: 7, requestId: 'original-cancel', expectedRevision: 0 } } };
  const receipt = { operation: 'cancelWork', workId: 7, requestId: 'original-cancel', revision: 1, receivedAt: at, cancelled: true };
  let dispatchedWork: number | undefined;
  const handle = createCloudDesktopHandler({ workspaceId, authorize: async command => {
    if (command.type === 'invoice_work_cancel') Reflect.set(command.input, 'workId', 99);
    return ok(undefined);
  }, dispatch: async command => {
    if (command.type === 'invoice_work_cancel') dispatchedWork = command.input.workId;
    return ok(receipt);
  } });
  expect(await handle(request)).toEqual({ ok: true, data: receipt });
  expect(dispatchedWork).toBe(7);
  const changedReply = createCloudDesktopHandler({ workspaceId, authorize: async () => ok(undefined), dispatch: async command => {
    if (command.type === 'invoice_work_cancel') Reflect.set(command.input, 'workId', 99);
    return ok({ ...receipt, workId: 99 });
  } });
  expect(await changedReply(request)).toMatchObject({ ok: false, error: { code: 'operation_result_unknown' } });
});

test.skipIf(process.platform !== 'linux')('a real Unix socket reaches only authorized cloud desktop commands', async () => {
  const root = mkdtempSync(join(tmpdir(), 'flowmate-cloud-desktop-rpc-')), socket = join(root, 'desktop.sock');
  let dispatched = 0;
  const handler = createCloudDesktopHandler({ workspaceId, authorize: async () => ok(undefined),
    dispatch: async () => { dispatched++; return ok(snapshot); } });
  const server = need(await listenCloudUnixRpc({ socketPath: socket, handle: handler }));
  try {
    expect(await callCloudUnixRpc(socket, envelope)).toEqual({ ok: true, data: { ok: true, data: snapshot } });
    expect(await callCloudUnixRpc(socket, { ...envelope, command: { type: 'call_provider', input: {} } }))
      .toMatchObject({ ok: true, data: { ok: false, error: { code: 'input_invalid' } } });
    expect(dispatched).toBe(1);
  } finally { need(await server.close()); }
});
