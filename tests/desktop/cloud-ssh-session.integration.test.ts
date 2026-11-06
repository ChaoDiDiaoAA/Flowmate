import { expect, test } from 'bun:test';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { CloudSshSession } from '../../apps/desktop/main/cloud-ssh-session.ts';

const workspaceId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', at = '2026-10-29T00:00:00.000Z';
const snapshot = { personalAgentId: 1, revision: 0, runtimeKind: 'durable', createdAt: at, updatedAt: at,
  configuration: { modelId: null, thinkingLevel: 'off', resources: { prompt: null, enabledSkills: [] },
    extensions: { enabledExtensions: [] }, tools: [], workingDirectory: null, preferences: '' } };
const read = { type: 'personal_agent_get', input: {} };
const cancel = { type: 'invoice_work_cancel', input: { workId: 7, requestId: 'original-cancel', expectedRevision: 0 } };

function fixture(mode: 'normal' | 'late' | 'foreign' | 'host-key' | 'held') {
  const source = `
    import { createInterface } from 'node:readline';
    const mode=${JSON.stringify(mode)}, base=${JSON.stringify(snapshot)}; let count=0;
    if(mode==='host-key') { process.stderr.write('Host key verification failed.'); process.exit(255); }
    createInterface({input:process.stdin}).on('line', line => {
      const request=JSON.parse(line); count++;
      const cancel=request.command.type==='invoice_work_cancel';
      const data=cancel?{operation:'cancelWork',workId:7,requestId:'original-cancel',revision:1,receivedAt:${JSON.stringify(at)},cancelled:true}
        :{...base,revision:count};
      const send=()=>process.stdout.write(JSON.stringify({version:1,requestId:mode==='foreign'?'11111111-1111-4111-8111-111111111111':request.requestId,result:{ok:true,data}})+'\\n');
      if(mode==='late' && cancel) setTimeout(send,80); else if(mode==='held' && !cancel) setTimeout(send,200); else send();
    });
  `;
  const env: NodeJS.ProcessEnv = {};
  for (const name of ['PATH', 'Path', 'SystemRoot', 'TEMP', 'TMP', 'USERPROFILE', 'HOME', 'ProgramData']) if (process.env[name]) env[name] = process.env[name];
  return spawn(process.execPath, ['--no-env-file', '-e', source], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env });
}

test('SSH session correlates replies and rejects commands outside the cloud whitelist', async () => {
  const session = new CloudSshSession(fixture('normal'), workspaceId);
  try {
    expect(await session.request({ type: 'call_provider', input: {} })).toMatchObject({ ok: false, error: { code: 'input_invalid' } });
    const [first, second] = await Promise.all([session.request(read), session.request(read)]);
    expect(first).toMatchObject({ ok: true, data: { revision: 1 } });
    expect(second).toMatchObject({ ok: true, data: { revision: 2 } });
  } finally { expect(await session.close()).toEqual({ ok: true, data: undefined }); }
});

test('desktop SSH requests leave capacity for stopping work while ordinary requests are pending', async () => {
  const session = new CloudSshSession(fixture('held'), workspaceId);
  try {
    const reads = Array.from({ length: 30 }, () => session.request(read));
    expect(await session.request(read)).toMatchObject({ ok: false, error: { code: 'cloud_ssh_busy' } });
    expect(await session.request(cancel)).toMatchObject({ ok: true, data: { workId: 7, cancelled: true } });
    expect((await Promise.all(reads)).every(result => result.ok)).toBe(true);
  } finally { expect(await session.close()).toEqual({ ok: true, data: undefined }); }
});

test('a timed-out cloud write is not resent and its late reply cannot corrupt another request', async () => {
  const session = new CloudSshSession(fixture('late'), workspaceId);
  try {
    expect(await session.request(cancel, 10)).toMatchObject({ ok: false, error: { code: 'operation_result_unknown' } });
    await new Promise(resolve => setTimeout(resolve, 150));
    expect(await session.request(read)).toMatchObject({ ok: true, data: { revision: 2 } });
  } finally { expect(await session.close()).toEqual({ ok: true, data: undefined }); }
});

test('a reply carrying another transport identity closes the session instead of being attached to the request', async () => {
  const session = new CloudSshSession(fixture('foreign'), workspaceId);
  try { expect(await session.request(read)).toMatchObject({ ok: false }); }
  finally { expect(await session.close()).toEqual({ ok: true, data: undefined }); }
});

test('a failed pinned-host check is exposed without copying raw SSH diagnostics', async () => {
  const session = new CloudSshSession(fixture('host-key'), workspaceId);
  try {
    const result = await session.request(read);
    expect(result).toMatchObject({ ok: false, error: { code: 'cloud_ssh_host_key_invalid' } });
    expect(JSON.stringify(result)).not.toContain('Host key verification failed');
  } finally { expect(await session.close()).toEqual({ ok: true, data: undefined }); }
});

test('an early stdin error does not hide the later SSH host-key rejection', async () => {
  const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: () => true });
  const session = new CloudSshSession(child as unknown as ChildProcessWithoutNullStreams, workspaceId);
  const pending = session.request(read);
  child.stdin.emit('error', Error('controlled early pipe error'));
  child.stderr.write('Host key verification failed.');
  child.emit('close', 255, null);
  expect(await pending).toMatchObject({ ok: false, error: { code: 'cloud_ssh_host_key_invalid' } });
  expect(await session.close()).toEqual({ ok: true, data: undefined });
});

test('desktop SSH session exchanges real framed requests with the bridge implementation', async () => {
  const bridge = new URL('../../apps/cloud-desktop-bridge.ts', import.meta.url).href;
  const contracts = new URL('../../packages/contracts/src/index.ts', import.meta.url).href;
  const source = `import {runCloudDesktopBridge} from ${JSON.stringify(bridge)}; import {ok} from ${JSON.stringify(contracts)};
    const result=await runCloudDesktopBridge(process.stdin,process.stdout,async()=>ok(ok(${JSON.stringify(snapshot)})));
    if(!result.ok) process.exitCode=1;`;
  const env: NodeJS.ProcessEnv = {};
  for (const name of ['PATH', 'Path', 'SystemRoot', 'TEMP', 'TMP', 'USERPROFILE', 'HOME', 'ProgramData']) if (process.env[name]) env[name] = process.env[name];
  const child = spawn(process.execPath, ['--no-env-file', '-e', source], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env });
  const session = new CloudSshSession(child, workspaceId);
  try { expect(await session.request(read)).toEqual({ ok: true, data: snapshot }); }
  finally { expect(await session.close()).toEqual({ ok: true, data: undefined }); }
}, 15_000);

test('desktop SSH session accepts a scoped material status through the bridge', async () => {
  const bridge = new URL('../../apps/cloud-desktop-bridge.ts', import.meta.url).href;
  const contracts = new URL('../../packages/contracts/src/index.ts', import.meta.url).href;
  const uploadId = '22222222-2222-4222-8222-222222222222';
  const status = { workspaceId, uploadId, status: 'receiving', receipt: null,
    files: [{ kind: 'original', name: 'source.md', offset: 3 }, { kind: 'parsed', name: 'parsed.json', offset: 0 }] };
  const source = `import {runCloudDesktopBridge} from ${JSON.stringify(bridge)}; import {ok} from ${JSON.stringify(contracts)};
    await runCloudDesktopBridge(process.stdin,process.stdout,async()=>ok(ok(${JSON.stringify(status)})));`;
  const env: NodeJS.ProcessEnv = {};
  for (const name of ['PATH', 'Path', 'SystemRoot', 'TEMP', 'TMP', 'USERPROFILE', 'HOME', 'ProgramData']) if (process.env[name]) env[name] = process.env[name];
  const child = spawn(process.execPath, ['--no-env-file', '-e', source], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env });
  const session = new CloudSshSession(child, workspaceId);
  try { expect(await session.request({ type: 'cloud_material_status', input: { workspaceId, uploadId } })).toEqual({ ok: true, data: status }); }
  finally { expect(await session.close()).toEqual({ ok: true, data: undefined }); }
}, 15_000);

test('desktop SSH session receives the complete maximum original image through the bridge', async () => {
  const bridge = new URL('../../apps/cloud-desktop-bridge.ts', import.meta.url).href;
  const contracts = new URL('../../packages/contracts/src/index.ts', import.meta.url).href;
  const input = { workId: 1, itemId: 2, documentRef: { id: 3, version: 'v1' }, page: 1 as const };
  const source = `import {runCloudDesktopBridge} from ${JSON.stringify(bridge)}; import {ok} from ${JSON.stringify(contracts)};
    const image={workId:1,itemId:2,documentRef:{id:3,version:'v1'},mimeType:'image/png',base64:Buffer.alloc(10*1024*1024,123).toString('base64')};
    await runCloudDesktopBridge(process.stdin,process.stdout,async()=>ok(ok(image)));`;
  const env: NodeJS.ProcessEnv = {};
  for (const name of ['PATH', 'Path', 'SystemRoot', 'TEMP', 'TMP', 'USERPROFILE', 'HOME', 'ProgramData']) if (process.env[name]) env[name] = process.env[name];
  const child = spawn(process.execPath, ['--no-env-file', '-e', source], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env });
  const session = new CloudSshSession(child, workspaceId);
  try {
    const result = await session.request({ type: 'cloud_review_original', input });
    expect(result.ok).toBe(true);
    if (!result.ok) throw Error(result.error.code);
    const image = result.data as { base64: string };
    expect(Buffer.from(image.base64, 'base64').equals(Buffer.alloc(10 * 1024 * 1024, 123))).toBe(true);
  } finally { expect(await session.close()).toEqual({ ok: true, data: undefined }); }
}, 45_000);
