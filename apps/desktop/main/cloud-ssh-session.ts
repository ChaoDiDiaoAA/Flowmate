import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { CLOUD_DESKTOP_MAX_IN_FLIGHT, CLOUD_DESKTOP_MAX_TRANSPORT_REQUESTS, CLOUD_DESKTOP_RESERVED_CONTROL,
  CloudDesktopEnvelopeSchema, CloudWorkspaceIdSchema, appError, cloudDesktopFailure, fail, ok, parseCloudDesktopResult,
  type CloudDesktopCommand, type Result } from '@flowmate/contracts';
import { buildCloudSshLaunch } from './cloud-ssh-launch.ts';
import { safeChildEnvironment } from './host-client.ts';

const maxFrameBytes = 14 * 1024 * 1024 + 64 * 1024;
const responseSchema = z.object({ version: z.literal(1), requestId: z.string().uuid(), result: z.unknown() }).strict();
type Pending = { command: CloudDesktopCommand; resolve(value: Result<unknown>): void; timer: ReturnType<typeof setTimeout> };

/** One SSH process is a transport only; closing it does not stop cloud Work. */
export class CloudSshSession {
  private readonly workspaceId: string;
  private readonly pending = new Map<string, Pending>();
  private readonly expired = new Set<string>();
  private buffered = Buffer.alloc(0);
  private stderr = '';
  private ended = false;
  private closing = false;
  private inputFailed = false;
  private failureCode = 'cloud_ssh_unavailable';
  private sent = 0;
  private readonly exited: Promise<void>;
  private resolveExit!: () => void;
  private closePromise: Promise<Result<void>> | undefined;

  constructor(private readonly child: ChildProcessWithoutNullStreams, workspaceId: string) {
    this.workspaceId = CloudWorkspaceIdSchema.parse(workspaceId);
    this.exited = new Promise(resolve => { this.resolveExit = resolve; });
    child.stdout.on('data', chunk => this.read(Buffer.from(chunk)));
    child.stderr.on('data', chunk => { if (this.stderr.length < 8192) this.stderr += Buffer.from(chunk).toString('utf8').slice(0, 8192 - this.stderr.length); });
    child.stdin.on('error', () => { this.inputFailed = true; });
    child.once('error', () => { this.finish('cloud_ssh_unavailable'); this.resolveExit(); });
    child.once('close', () => {
      const hostKey = /host key verification failed|remote host identification has changed/i.test(this.stderr);
      this.finish(hostKey ? 'cloud_ssh_host_key_invalid' : this.failureCode); this.resolveExit();
    });
  }

  private failure(command: CloudDesktopCommand): Result<unknown> {
    const original = cloudDesktopFailure(command);
    if (original.error.code === 'operation_result_unknown') return original;
    return fail(appError(this.failureCode, 'runtime', this.failureCode === 'cloud_ssh_host_key_invalid'
      ? 'The cloud SSH host key could not be verified.' : 'The cloud SSH connection is unavailable.', true));
  }

  private finish(code: string): void {
    if (this.ended) return;
    this.ended = true; this.failureCode = code;
    for (const item of this.pending.values()) { clearTimeout(item.timer); item.resolve(this.failure(item.command)); }
    this.pending.clear();
  }

  private invalidProtocol(): void {
    this.finish('cloud_ssh_protocol_invalid');
    try { this.child.kill(); } catch { /* close() still waits for the actual process exit */ }
  }

  private failedWrite(requestId: string): void {
    this.inputFailed = true;
    const current = this.pending.get(requestId); if (!current) return;
    const failure = cloudDesktopFailure(current.command);
    // Writes may already have reached Authority; reads can wait for the SSH exit diagnosis.
    if (failure.error.code === 'operation_result_unknown') {
      clearTimeout(current.timer); this.pending.delete(requestId); this.expired.add(requestId); current.resolve(failure);
    }
  }

  private read(chunk: Buffer): void {
    if (this.ended || this.closing) return;
    try {
      this.buffered = Buffer.concat([this.buffered, chunk]);
      for (;;) {
        const end = this.buffered.indexOf(10); if (end < 0) break;
        if (end > maxFrameBytes) throw Error('response_too_large');
        const frame = this.buffered.subarray(0, end); this.buffered = this.buffered.subarray(end + 1);
        const raw: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(frame));
        const parsed = responseSchema.safeParse(raw); if (!parsed.success) throw Error('response_invalid');
        const current = this.pending.get(parsed.data.requestId);
        if (!current) { if (this.expired.delete(parsed.data.requestId)) continue; throw Error('response_identity_invalid'); }
        const result = parseCloudDesktopResult(current.command, parsed.data.result);
        if (!result) throw Error('response_scope_invalid');
        clearTimeout(current.timer); this.pending.delete(parsed.data.requestId); current.resolve(result);
      }
      if (this.buffered.byteLength > maxFrameBytes) throw Error('response_too_large');
    } catch { this.invalidProtocol(); }
  }

  public request(command: unknown, timeoutMs = 30_000): Promise<Result<unknown>> {
    const requestId = randomUUID();
    const envelope = CloudDesktopEnvelopeSchema.safeParse({ version: 1, workspaceId: this.workspaceId, requestId, command });
    if (!envelope.success || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000)
      return Promise.resolve(fail(appError('input_invalid', 'input', 'The cloud desktop request is invalid.')));
    if (this.ended || this.closing || this.inputFailed || !this.child.stdin.writable)
      return Promise.resolve(fail(appError(this.failureCode, 'runtime', 'The cloud SSH connection is unavailable.', true)));
    if (this.sent >= CLOUD_DESKTOP_MAX_TRANSPORT_REQUESTS)
      return Promise.resolve(fail(appError('cloud_ssh_reconnect_required', 'runtime', 'Reconnect before sending another cloud request.', true)));
    const control = envelope.data.command.type === 'personal_task_stop' || envelope.data.command.type === 'invoice_work_cancel';
    if (this.pending.size >= (control ? CLOUD_DESKTOP_MAX_IN_FLIGHT : CLOUD_DESKTOP_MAX_IN_FLIGHT - CLOUD_DESKTOP_RESERVED_CONTROL))
      return Promise.resolve(fail(appError('cloud_ssh_busy', 'runtime', 'Cloud request capacity is temporarily full.', true)));
    return new Promise(resolve => {
      const timer = setTimeout(() => {
        const current = this.pending.get(requestId); if (!current) return;
        this.pending.delete(requestId); this.expired.add(requestId); resolve(cloudDesktopFailure(current.command));
      }, timeoutMs);
      this.pending.set(requestId, { command: structuredClone(envelope.data.command), resolve, timer });
      this.sent++;
      try {
        this.child.stdin.write(JSON.stringify(envelope.data) + '\n', error => {
          if (error) this.failedWrite(requestId);
        });
      } catch {
        this.failedWrite(requestId);
      }
    });
  }

  public close(): Promise<Result<void>> {
    if (this.closePromise) return this.closePromise;
    this.closing = true; this.finish('cloud_ssh_unavailable');
    this.closePromise = (async () => {
      try { this.child.stdin.end(); } catch { /* Wait for the actual SSH exit below. */ }
      const wait = async () => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try { return await Promise.race([this.exited.then(() => true), new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), 5000); })]); }
        finally { if (timer) clearTimeout(timer); }
      };
      if (await wait()) return ok(undefined);
      try { this.child.kill(); } catch { /* A failed kill is not an exit receipt. */ }
      return await wait() ? ok(undefined) : fail(appError('cloud_ssh_close_unconfirmed', 'runtime', 'The SSH process exit is unconfirmed.', true));
    })();
    return this.closePromise;
  }
}

/** Connect only after the dedicated SSH key and trusted host key have been configured. */
export async function connectCloudSsh(target: unknown, workspaceId: string): Promise<Result<CloudSshSession>> {
  const parsedWorkspace = CloudWorkspaceIdSchema.safeParse(workspaceId), launch = buildCloudSshLaunch(target);
  if (!parsedWorkspace.success) return fail(appError('input_invalid', 'input', 'The cloud workspace is invalid.'));
  if (!launch.ok) return launch;
  try {
    const env = safeChildEnvironment(false);
    for (const name of ['ProgramData', 'SystemDrive']) if (process.env[name]) env[name] = process.env[name];
    const child = spawn(launch.data.executable, [...launch.data.args], { env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    const session = new CloudSshSession(child, parsedWorkspace.data);
    const ready = await session.request({ type: 'personal_agent_get', input: {} }, 15_000);
    if (!ready.ok) { const closed = await session.close(); return closed.ok ? ready : closed; }
    return ok(session);
  } catch { return fail(appError('cloud_ssh_unavailable', 'runtime', 'The cloud SSH connection is unavailable.', true)); }
}
