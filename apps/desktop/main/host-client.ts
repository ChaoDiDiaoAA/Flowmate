import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { appError, fail, ok } from '@flowmate/contracts';
import type { Result } from '@flowmate/contracts';
import type { HostCommand, HostEvent, HostOutput } from '../../host/protocol.ts';

type HostState = { version: 1; ready: boolean; host: 'starting' | 'ready' | 'closing' | 'error'; settings?: unknown; appVersion?: string; userDataPath: string };
type Pending = { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> };
type HostCommandInput = HostCommand extends infer Command
  ? Command extends HostCommand ? Omit<Command, 'version' | 'requestId'> & { requestId?: string } : never
  : never;

export class HostClient {
  private child: ChildProcessWithoutNullStreams | null = null;
  private readonly pending = new Map<string, Pending>();
  private readonly listeners = new Set<(event: HostEvent['event']) => void>();
  private currentState: HostState | null = null;
  private expectedExit = false;
  private processExited = false;
  private exited = Promise.resolve<number | null>(null);
  private resolveExit: ((code: number | null) => void) | null = null;

  public get state(): HostState | null { return this.currentState; }

  public subscribe(listener: (event: HostEvent['event']) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  public async start(userDataRoot: string, appVersion: string, cwd: string): Promise<Result<HostState>> {
    const executable = process.env.FLOWMATE_BUN_EXECUTABLE?.trim() || 'bun';
    const env = safeChildEnvironment();
    env.FLOWMATE_DESKTOP_VERSION = appVersion;
    const child = spawn(executable, ['--no-env-file', 'apps/host/main.ts', '--user-data-root', userDataRoot], {
      cwd,
      env,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child = child;
    this.exited = new Promise<number | null>((resolveExit) => { this.resolveExit = resolveExit; });
    child.stdin.on('error', () => this.failAll('host_write_failed', 'Bun Host 输入通道已关闭。'));
    child.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8').trimEnd();
      if (text) process.stderr.write(`[Flowmate Host] ${text}\n`);
    });
    let resolveStartup!: (result: Result<HostState>) => void;
    let startupSettled = false;
    const ready = new Promise<Result<HostState>>((resolveReady) => { resolveStartup = resolveReady; });
    const settleStartup = (result: Result<HostState>) => {
      if (startupSettled) return;
      startupSettled = true;
      resolveStartup(result);
    };
    child.on('error', () => {
      this.failAll('host_spawn_failed', 'Bun Host 无法启动.');
      settleStartup(fail(appError('host_spawn_failed', 'runtime', 'Bun Host 无法启动。', true)));
    });
    child.on('exit', (code) => {
      this.processExited = true;
      this.resolveExit?.(code);
      this.resolveExit = null;
      this.failAll('host_exited', 'Bun Host 已退出。');
      if (!startupSettled) settleStartup(fail(appError('host_exited', 'runtime', 'Bun Host 在就绪前退出。', true)));
      if (!this.expectedExit) this.emit({ type: 'host_state', state: { version: 1, ready: false, host: 'error', appVersion: '0.0.0', userDataPath: userDataRoot } });
    });
    const timeout = setTimeout(() => settleStartup(fail(appError('host_start_timeout', 'runtime', 'Bun Host 未在启动期限内就绪。', true))), 20_000);
    this.readProtocol(child, (output) => {
      if (output.type !== 'ready') return;
      this.currentState = output.state as HostState;
      settleStartup(ok(this.currentState));
    }, userDataRoot);
    const result = await ready;
    clearTimeout(timeout);
    if (!result.ok) {
      process.stderr.write(`[Flowmate Host] Startup failed (${result.error.code}); working directory: ${cwd}\n`);
      child.kill();
      return result;
    }
    return result;
  }

  public async request(command: HostCommandInput, timeoutMs = 10_000): Promise<unknown> {
    const child = this.child;
    if (!child || this.processExited || child.killed || child.stdin.destroyed || !child.stdin.writable) throw new Error('host_not_writable');
    const requestId = command.requestId ?? randomUUID();
    const message = { ...command, version: 1, requestId } as HostCommand;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error('host_request_timeout'));
      }, timeoutMs);
      this.pending.set(requestId, { resolve, reject, timer });
      try {
        child.stdin.write(`${JSON.stringify(message)}\n`, 'utf8', (error) => {
          if (!error) return;
          clearTimeout(timer);
          this.pending.delete(requestId);
          reject(new Error('host_write_failed'));
        });
      } catch {
        clearTimeout(timer);
        this.pending.delete(requestId);
        reject(new Error('host_write_failed'));
      }
    });
  }

  public async close(): Promise<Result<{ closed: boolean; stopped: boolean; errors: readonly unknown[] }>> {
    if (!this.child) return ok({ closed: true, stopped: true, errors: [] });
    if (this.processExited || this.child.exitCode !== null) return ok({ closed: true, stopped: true, errors: [] });
    try {
      const response = await this.request({ type: 'close' }, 15_000) as Result<{ closed: boolean; stopped: boolean; errors: readonly unknown[] }>;
      if (response.ok && response.data.closed) {
        this.expectedExit = true;
        await Promise.race([this.exited, new Promise((resolve) => setTimeout(resolve, 2_000))]);
      }
      return response;
    } catch {
      return fail(appError('host_close_failed', 'runtime', 'Bun Host 关闭未确认。', true));
    }
  }

  private readProtocol(child: ChildProcessWithoutNullStreams, onReady: (output: Extract<HostOutput, { type: 'ready' }>) => void, userDataPath: string): void {
    const input = createInterface({ input: child.stdout, crlfDelay: Infinity });
    input.on('line', (line) => {
      let output: HostOutput;
      try { output = JSON.parse(line) as HostOutput; }
      catch {
        process.stderr.write('[Flowmate Host] Ignored invalid protocol output.\n');
        return;
      }
      if (output.version !== 1 || typeof output.type !== 'string') return;
      if (output.type === 'ready') { onReady(output); return; }
      if (output.type === 'response') {
        const pending = this.pending.get(output.requestId);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pending.delete(output.requestId);
        pending.resolve(output.value);
      } else if (output.type === 'event') {
        if (output.event.type === 'host_state') this.currentState = output.event.state as HostState;
        this.emit(output.event);
      }
    });
    input.on('close', () => {
      if (!this.expectedExit) this.emit({ type: 'host_state', state: { version: 1, ready: false, host: 'error', appVersion: '0.0.0', userDataPath } });
    });
  }

  private emit(event: HostEvent['event']): void {
    for (const listener of this.listeners) {
      try { listener(event); } catch { /* one renderer subscriber cannot block Host protocol */ }
    }
  }

  private failAll(code: string, message: string): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error(code));
    }
    this.pending.clear();
    if (code === 'host_spawn_failed') process.stderr.write(`[Flowmate Host] ${message}\n`);
  }
}

function safeChildEnvironment(): NodeJS.ProcessEnv {
  const allowed = ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'COMSPEC', 'PATHEXT', 'TEMP', 'TMP', 'WINDIR', 'USERPROFILE', 'HOME', 'APPDATA', 'LOCALAPPDATA', 'BUN_INSTALL'];
  const env: NodeJS.ProcessEnv = {};
  for (const name of allowed) if (process.env[name]) env[name] = process.env[name];
  return env;
}
