import { expect, it } from 'bun:test';
import { once } from 'node:events';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { HostClient } from '../../apps/desktop/main/host-client.ts';
import { mkdtempSync } from '../support/resources.ts';

const at = '2026-10-29T00:00:00.000Z';
const work = { workId: 7, personalAgentId: 1, sessionId: 70, runtimeKind: 'durable', revision: 3, goal: 'Original invoice work.',
  status: 'open', createdAt: at, updatedAt: at, counts: { total: 1, unresolved: 1, accepted: 0, rejected: 0, excluded: 0 },
  execution: { attempt: null, runStatus: null, queued: false, requiresContinue: false, stopUnconfirmed: false,
    waitingReason: 'Original material needs review.', ownedChildRunIds: [] }, actions: [] };
const receipt = { operation: 'continueWork', workId: 7, requestId: 'original-continue', revision: 4, receivedAt: at,
  execution: { kind: 'queued', authorizationAccepted: true, attempt: { attemptId: 21, runId: null, runtimeLinked: false }, relation: 'new' } };

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'flowmate-personal-client-'));
  mkdirSync(join(root, 'apps/host'), { recursive: true });
  writeFileSync(join(root, 'apps/host/main.ts'), `
    import { createInterface } from 'node:readline';
    import { createWriteStream } from 'node:fs';
    const stdout = createWriteStream('', { fd: 1, autoClose: false }), received = [];
    const work = ${JSON.stringify(work)}, receipt = ${JSON.stringify(receipt)};
    const send = (command, value, extra = {}) => stdout.write(JSON.stringify({ version: 1, type: 'response', requestId: command.requestId, value, ...extra })+'\\n');
    stdout.write(JSON.stringify({version:1,type:'ready',state:{version:1,ready:true,host:'ready',userDataPath:'synthetic'}})+'\\n');
    const input = createInterface({input:process.stdin});
    input.on('line', line => {
      const command = JSON.parse(line);
      if (command.type === 'get_state') { send(command, {received:[...received]}); return; }
      received.push(command.type);
      let value = command.type === 'invoice_work_get' ? {ok:true,data:{view:'work',work,items:[],nextAfterItemId:null}}
        : command.type === 'invoice_work_list' ? {ok:true,data:{items:[work],nextBeforeId:null}} : {ok:true,data:receipt};
      const key = command.requestId;
      if (key === 'foreign-work') value.data.work = {...work,workId:8};
      if (key === 'foreign-agent') value.data.items = [{...work,personalAgentId:2}];
      if (key === 'wrong-operation') value = {ok:true,data:{operation:'cancelWork',workId:7,requestId:receipt.requestId,revision:4,receivedAt:receipt.receivedAt,cancelled:true}};
      if (key === 'wrong-request') value.data = {...receipt,requestId:'foreign-original-request'};
      if (key === 'extra-data') value.data.nativeTaskId = 'native-handle';
      if (key === 'extra-result') value.extra = true;
      if (key === 'oversized') value = {ok:false,error:{code:'storage_read_failed',category:'storage',retryable:true,message:'x'.repeat(262144)}};
      if (key === 'private-error') value = {ok:false,error:{code:'state_conflict',category:'runtime',retryable:false,message:'PRIVATE_NATIVE_ERROR'}};
      send(command,value,key === 'extra-envelope' ? {extra:true} : {});
    });
    input.on('close',()=>process.exit(0));
  `);
  const client = new HostClient();
  expect(await client.start(root, '0.1.0', root)).toMatchObject({ ok: true });
  const child = (client as unknown as { child: ChildProcessWithoutNullStreams }).child;
  return { client, async close() {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, 'exit'); child.stdin.end(); await exited;
  } };
}

it('P18 HostClient rejects foreign work, operation and original request identities on real child pipes', async () => {
  const f = await fixture(), get = { type: 'invoice_work_get' as const, input: { view: 'work' as const, workId: 7, limit: 10 } },
    continued = { type: 'invoice_work_continue' as const, input: { workId: 7, requestId: 'original-continue', expectedRevision: 3, expectedAttemptId: null } };
  try {
    expect(await f.client.request(get)).toMatchObject({ ok: true, data: { work: { workId: 7 } } });
    expect(await f.client.request(continued)).toEqual({ ok: true, data: receipt });
    const commands = [{ ...get, requestId: 'foreign-work' },
      { type: 'invoice_work_list' as const, input: { personalAgentId: 1, limit: 10 }, requestId: 'foreign-agent' },
      { ...continued, requestId: 'wrong-operation' }, { ...continued, requestId: 'wrong-request' }];
    for (const command of commands)
      expect(await f.client.request(command, 500).then(() => 'resolved', error => error.message)).toBe('host_protocol_invalid');
    expect(await f.client.request({ type: 'invoice_work_query_operation', input: {
      operation: 'continueWork', workId: 7, requestId: 'original-continue' } })).toEqual({ ok: true, data: receipt });
    expect(await f.client.request(get)).toMatchObject({ ok: true, data: { work: { workId: 7 } } });
  } finally { await f.close(); }
}, 5_000);

it('P18 HostClient rejects extra fields and complete wire overflow, sanitizes errors, and rejects invalid requests before sending', async () => {
  const f = await fixture(), get = { type: 'invoice_work_get' as const, input: { view: 'work' as const, workId: 7, limit: 10 } };
  try {
    for (const requestId of ['extra-data', 'extra-result', 'extra-envelope', 'oversized'])
      expect(await f.client.request({ ...get, requestId }, 500).then(() => 'resolved', error => error.message)).toBe('host_protocol_invalid');
    expect(JSON.stringify(await f.client.request({ ...get, requestId: 'private-error' }))).not.toContain('PRIVATE_NATIVE_ERROR');
    const before = await f.client.request({ type: 'get_state' });
    for (const input of [{ ...get.input, workId: 0 }, { ...get.input, nativeTaskId: 'native' }, { ...get.input, limit: 101 }])
      expect(await f.client.request({ ...get, input } as never, 500).then(() => 'resolved', error => error.message)).toBe('host_protocol_invalid');
    expect(await f.client.request({ type: 'invoice_work_continue', input: { workId: 7, requestId: 'invalid', expectedRevision: 3 } } as never, 500)
      .then(() => 'resolved', error => error.message)).toBe('host_protocol_invalid');
    expect(await f.client.request({ type: 'get_state' })).toEqual(before);
  } finally { await f.close(); }
}, 5_000);
