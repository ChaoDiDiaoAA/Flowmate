import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { appError, CLOUD_DESKTOP_MAX_TRANSPORT_REQUESTS, fail, ok, type Result } from '@flowmate/contracts';
import {
  CLOUD_OPENVIKING_REQUEST_LIMIT, CLOUD_OPENVIKING_RESPONSE_LIMIT, CloudOpenVikingManagementEnvelopeSchema,
  CloudOpenVikingManagementIdentitySchema, CloudOpenVikingManagementTargetSchema, parseCloudOpenVikingManagementResult,
  type CloudOpenVikingManagementCommand,
} from '../../../packages/contracts/src/cloud-openviking-management.ts';
import { buildCloudSshLaunch } from './cloud-ssh-launch.ts';
import { safeChildEnvironment } from './host-client.ts';
import type { z } from 'zod';

const transportLost = () => fail(appError('cloud_openviking_transport_lost', 'runtime', 'The original cloud management response could not be confirmed.', true));
const invalid = () => fail(appError('input_invalid', 'input', 'The cloud OpenViking management request is invalid.'));
const denied = () => fail(appError('memory_scope_denied', 'input', 'The cloud Authority did not verify the original workspace and management role.'));
type Target = z.infer<typeof CloudOpenVikingManagementTargetSchema>;
type Identity = z.infer<typeof CloudOpenVikingManagementIdentitySchema>;

export function createCloudOpenVikingManagementProcess(child: ChildProcessWithoutNullStreams, workspaceId: string) {
  let buffered = Buffer.alloc(0), ended = false;
  let pending: { id: string; complete(result: Result<unknown>): void } | undefined;
  const stop = () => {
    if (ended) return;
    ended = true;
    pending?.complete(transportLost());
    try { child.kill(); } catch { /* The current request is already unconfirmed. */ }
  };
  child.on('error', stop);
  child.once('close', stop);
  child.stdin.on('error', stop);
  child.stderr.resume();
  child.stdout.on('data', (chunk: Buffer) => {
    if (ended) return;
    if (!pending || buffered.length + chunk.length > CLOUD_OPENVIKING_RESPONSE_LIMIT + 1) { stop(); return; }
    buffered = Buffer.concat([buffered, chunk]);
    const newline = buffered.indexOf(10);
    if (newline === -1) return;
    if (newline !== buffered.length - 1) { stop(); return; }
    try {
      const parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffered.subarray(0, newline)));
      const result = parseCloudOpenVikingManagementResult(parsed, pending.id);
      if (!result) { stop(); return; }
      buffered = Buffer.alloc(0);
      pending.complete(result);
    } catch { stop(); }
  });
  return {
    get ended() { return ended; },
    stop,
    request(command: CloudOpenVikingManagementCommand): Promise<Result<unknown>> {
      const id = randomUUID();
      const checked = CloudOpenVikingManagementEnvelopeSchema.safeParse({ version: 1, workspaceId, requestId: id, command });
      if (!checked.success) return Promise.resolve(invalid());
      const frame = JSON.stringify(checked.data) + '\n';
      if (Buffer.byteLength(frame) - 1 > CLOUD_OPENVIKING_REQUEST_LIMIT) return Promise.resolve(invalid());
      if (pending || ended || !child.stdin.writable) return Promise.resolve(transportLost());
      return new Promise(resolve => {
        const timeout = command.type === 'execute' ? 330_000 : 30_000;
        const timer = setTimeout(stop, timeout);
        pending = { id, complete(result) { pending = undefined; clearTimeout(timer); resolve(result); } };
        try { child.stdin.write(frame, error => { if (error) stop(); }); }
        catch { stop(); }
      });
    },
  };
}

export async function connectCloudOpenVikingManagement(raw: Target): Promise<Result<{
  identity: Identity; target: Target; request(command: CloudOpenVikingManagementCommand): Promise<Result<unknown>>; close(): void;
}>> {
  const target = CloudOpenVikingManagementTargetSchema.parse(raw);
  const launch = buildCloudSshLaunch(target.target);
  if (!launch.ok) return launch;
  let channel: ReturnType<typeof createCloudOpenVikingManagementProcess> | undefined;
  let identity: Identity | undefined, closed = false;
  let requests = 0;
  async function open(): Promise<Result<Identity>> {
    if (closed || !launch.ok) return transportLost();
    try {
      const env = safeChildEnvironment(false);
      for (const name of ['ProgramData', 'SystemDrive']) if (process.env[name]) env[name] = process.env[name];
      channel = createCloudOpenVikingManagementProcess(spawn(launch.data.executable, [...launch.data.args],
        { env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }), target.workspaceId);
      requests = 1;
      const status = await channel.request({ type: 'info' });
      if (!status.ok) { channel.stop(); return status; }
      const verified = CloudOpenVikingManagementIdentitySchema.safeParse(status.data);
      if (!verified.success || verified.data.workspaceId !== target.workspaceId || verified.data.role !== target.role
        || identity && !isDeepStrictEqual(verified.data, identity)) { channel.stop(); return denied(); }
      return ok(verified.data);
    } catch { channel?.stop(); return transportLost(); }
  }
  const connected = await open();
  if (!connected.ok) return connected;
  identity = connected.data;
  return ok({
    identity, target,
    async request(command) {
      if (closed) return transportLost();
      if (channel?.ended || requests >= CLOUD_DESKTOP_MAX_TRANSPORT_REQUESTS) channel?.stop();
      if (!channel || channel.ended) {
        const reopened = await open();
        if (!reopened.ok) return reopened;
      }
      requests++;
      return channel!.request(command);
    },
    close() { closed = true; channel?.stop(); },
  });
}
