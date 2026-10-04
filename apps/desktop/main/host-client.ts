import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { InvoiceFormApplicationReceiptSchema, InvoiceFormBridgeRequestSchema, RuntimeEventsWakeSchema, appError, fail, ok } from '@flowmate/contracts';
import type { InvoiceFormApplicationReceipt, InvoiceFormBridgeRequest, Result } from '@flowmate/contracts';
import type { HostCommand, HostCredentialRequest, HostEvent, HostOutput } from '../../host/protocol.ts';
import { isRuntimeHostCommand, isWorkspaceHostCommand, isContextHostCommand, matchesContextResponse, parseContextHostResult,
  isHistoryHostCommand, matchesHistoryResponse, parseHistoryHostResult,
  parseHostCommand, parseRuntimeHostResult, parseWorkspaceHostResult } from '../../host/protocol.ts';

type HostState = { version: 1; ready: boolean; host: 'starting' | 'ready' | 'closing' | 'error'; settings?: unknown; appVersion?: string; userDataPath: string };
type Pending = { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout>; command: HostCommand };
type HostCommandInput = HostCommand extends infer Command
  ? Command extends HostCommand ? Omit<Command, 'version' | 'requestId' | 'input'> & { requestId?: string }
    & (Command extends { type: 'query_session_history' } ? { input: import('@flowmate/contracts').NativeHistoryPageRequest }
      : Command extends { type: 'query_session_history_entry' } ? { input: import('@flowmate/contracts').SessionHistoryEntryRequest }
      : Command extends { type: 'list_context_snapshots' } ? { input: import('@flowmate/contracts').ContextSnapshotsRequest }
      : Command extends { type: 'list_context_requests' } ? { input: import('@flowmate/contracts').ContextRequestsRequest }
      : Command extends { input: infer Input } ? { input: Input } : {}) : never
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
  private closedReport: { closed: boolean; stopped: boolean; errors: readonly unknown[] } | null = null;
  private credentialHandler: ((request: HostCredentialRequest) => Promise<{ ok: boolean; credential?: unknown }>) | null = null;
  private epoch = 0;
  private invoiceFormHandler: ((request: InvoiceFormBridgeRequest, epoch: number) => Promise<InvoiceFormApplicationReceipt>) | null = null;
  private connectionChangeHandler: (() => void) | null = null;

  public get state(): HostState | null { return this.currentState; }
  public get connectionEpoch(): number { return this.epoch; }
  public setConnectionChangeHandler(handler: () => void): void { this.connectionChangeHandler = handler; }
  public captureRuntimeSubscriptionCleanup(ownerToken: string, subscriptionId: string): () => void {
    const child = this.child;
    return () => {
      if (!child || child.killed || child.exitCode !== null || child.signalCode !== null || child.stdin.destroyed || !child.stdin.writable) return;
      try { child.stdin.write(`${JSON.stringify({ version: 1, type: 'unsubscribe_runtime_events', requestId: randomUUID(), ownerToken, subscriptionId })}\n`); }
      catch { /* original Host may have exited; never send this ID to a replacement */ }
    };
  }
  public setInvoiceFormHandler(handler: (request: InvoiceFormBridgeRequest, epoch: number) => Promise<InvoiceFormApplicationReceipt>): void {
    this.invoiceFormHandler = handler;
  }

  public setCredentialHandler(handler: (request: HostCredentialRequest) => Promise<{ ok: boolean; credential?: unknown }>): void {
    this.credentialHandler = handler;
  }

  public subscribe(listener: (event: HostEvent['event']) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  public async start(userDataRoot: string, appVersion: string, cwd: string,
    invoiceSourceRoot = join(cwd, 'data', 'invoices', 'agent-input')): Promise<Result<HostState>> {
    this.connectionChangeHandler?.();
    if (this.child) this.failAll('host_replaced', 'Bun Host 连接已更换。');
    const executable = process.env.FLOWMATE_BUN_EXECUTABLE?.trim() || 'bun';
    const env = safeChildEnvironment();
    env.FLOWMATE_DESKTOP_VERSION = appVersion;
    const child = spawn(executable, ['--no-env-file', 'apps/host/main.ts', '--user-data-root', userDataRoot,
      '--invoice-source-root', invoiceSourceRoot], {
      cwd,
      env,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child = child;
    this.epoch++;
    this.expectedExit = false;
    this.processExited = false;
    this.closedReport = null;
    this.exited = new Promise<number | null>((resolveExit) => { this.resolveExit = resolveExit; });
    child.stdin.on('error', () => { if (this.child === child) this.failAll('host_write_failed', 'Bun Host 输入通道已关闭。'); });
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
      if (this.child !== child) return;
      this.failAll('host_spawn_failed', 'Bun Host 无法启动.');
      settleStartup(fail(appError('host_spawn_failed', 'runtime', 'Bun Host 无法启动。', true)));
    });
    child.on('exit', (code) => {
      if (this.child !== child) return;
      this.processExited = true;
      this.connectionChangeHandler?.();
      this.resolveExit?.(code);
      this.resolveExit = null;
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
    const rawMessage = { ...command, version: 1, requestId };
    const message = isRuntimeHostCommand(command.type) || isWorkspaceHostCommand(command.type) || isContextHostCommand(command.type) || isHistoryHostCommand(command.type)
      ? parseHostCommand(rawMessage) : rawMessage as HostCommand;
    if (!message) throw new Error('host_protocol_invalid');
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error('host_request_timeout'));
      }, timeoutMs);
      this.pending.set(requestId, { resolve, reject, timer, command: message });
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
    if (this.closedReport && this.processExited) return ok(this.closedReport);
    if (!this.child || this.child.pid === undefined) return ok({ closed: true, stopped: true, errors: [] });
    if (this.processExited || this.child.exitCode !== null) return ok({ closed: true, stopped: false,
      errors: [appError('host_exited', 'runtime', 'Bun Host 已退出，执行停止与清理未确认。', true)] });
    try {
      const response = this.closedReport ? ok(this.closedReport)
        : await this.request({ type: 'close' }, 15_000) as Result<{ closed: boolean; stopped: boolean; errors: readonly unknown[] }>;
      if (response.ok && response.data.closed) {
        this.closedReport = response.data;
        this.expectedExit = true;
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          const exited = await Promise.race([this.exited.then(() => true), new Promise<false>((resolve) => {
            timer = setTimeout(() => resolve(false), 2_000);
          })]);
          if (!exited) return ok({ ...response.data, closed: false, errors: [...response.data.errors,
            appError('host_exit_unconfirmed', 'runtime', 'Bun Host 已确认清理，但进程退出尚未确认。', true)] });
        } finally { clearTimeout(timer); }
      }
      return response;
    } catch {
      return fail(appError('host_close_failed', 'runtime', 'Bun Host 关闭未确认。', true));
    }
  }

  private readProtocol(child: ChildProcessWithoutNullStreams, onReady: (output: Extract<HostOutput, { type: 'ready' }>) => void, userDataPath: string): void {
    const input = createInterface({ input: child.stdout, crlfDelay: Infinity });
    input.on('line', (line) => {
      if (this.child !== child) return;
      let output: HostOutput;
      try { output = JSON.parse(line) as HostOutput; }
      catch {
        process.stderr.write('[Flowmate Host] Ignored invalid protocol output.\n');
        return;
      }
      if (!output || typeof output !== 'object' || output.version !== 1 || typeof output.type !== 'string') return;
      if (output.type === 'ready') { onReady(output); return; }
      if (output.type === 'invoice_form_request') {
        const request = InvoiceFormBridgeRequestSchema.safeParse(output.request);
        if (!request.success || typeof output.requestId !== 'string' || !output.requestId || output.requestId.length > 128) return;
        const original = request.data;
        const epoch = this.epoch;
        const unknown = (): InvoiceFormApplicationReceipt => ({ runId: original.runId, toolCallId: original.toolCallId,
          formInstanceId: original.target.formInstanceId, candidateId: original.candidateId, candidateSequence: original.candidateSequence,
          observedAt: new Date().toISOString(), outcome: 'unknown' });
        void Promise.resolve().then(() => this.invoiceFormHandler?.(original, epoch) ?? unknown())
          .catch(unknown).then(value => {
            if (this.child !== child || this.epoch !== epoch || !child.stdin.writable) return;
            const receipt = InvoiceFormApplicationReceiptSchema.safeParse(value);
            const matched = receipt.success && receipt.data.runId === original.runId && receipt.data.toolCallId === original.toolCallId
              && receipt.data.formInstanceId === original.target.formInstanceId && receipt.data.candidateId === original.candidateId
              && receipt.data.candidateSequence === original.candidateSequence;
            child.stdin.write(`${JSON.stringify({ version: 1, type: 'invoice_form_response', requestId: output.requestId,
              receipt: matched ? receipt.data : unknown() })}\n`);
          });
        return;
      }
      if (output.type === 'credential_request') {
        void Promise.resolve().then(() => this.credentialHandler?.(output) ?? { ok: false })
          .catch(() => ({ ok: false })).then((value) => {
            if (child.stdin.writable) child.stdin.write(`${JSON.stringify({ version: 1, type: 'credential_response',
              requestId: output.requestId, value })}\n`);
          });
        return;
      }
      if (output.type === 'response') {
        const pending = this.pending.get(output.requestId);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pending.delete(output.requestId);
        if (isRuntimeHostCommand(pending.command.type)) {
          const validEnvelope = Object.keys(output).every(key => ['version', 'type', 'requestId', 'value'].includes(key));
          const value = validEnvelope ? parseRuntimeHostResult(pending.command.type, output.value) : null;
          if (value === null || !matchesRuntimeResponse(pending.command, value)) pending.reject(new Error('host_protocol_invalid'));
          else pending.resolve(value);
        } else if (isHistoryHostCommand(pending.command.type)) {
          const validEnvelope = Object.keys(output).every(key => ['version', 'type', 'requestId', 'value'].includes(key));
          const value = validEnvelope ? parseHistoryHostResult(pending.command.type, output.value) : null;
          if (value === null || !matchesHistoryResponse(pending.command, value)) pending.reject(new Error('host_protocol_invalid'));
          else pending.resolve(value);
        } else if (isContextHostCommand(pending.command.type)) {
          const validEnvelope = Object.keys(output).every(key => ['version', 'type', 'requestId', 'value'].includes(key));
          const value = validEnvelope ? parseContextHostResult(pending.command.type, output.value) : null;
          if (value === null || !matchesContextResponse(pending.command, value)) pending.reject(new Error('host_protocol_invalid'));
          else pending.resolve(value);
        } else if (isWorkspaceHostCommand(pending.command.type)) {
          const validEnvelope = Object.keys(output).every(key => ['version', 'type', 'requestId', 'value'].includes(key));
          const value = validEnvelope ? parseWorkspaceHostResult(pending.command.type, output.value) : null;
          if (value === null) pending.reject(new Error('host_protocol_invalid'));
          else pending.resolve(value);
        } else pending.resolve(output.value);
      } else if (output.type === 'event') {
        if (!output.event || typeof output.event !== 'object') return;
        if (output.event.type === 'runtime_events_available') {
          if (!Object.keys(output).every(key => ['version', 'type', 'event'].includes(key))) return;
          const wake = RuntimeEventsWakeSchema.safeParse(output.event);
          if (!wake.success) return;
          this.emit(wake.data); return;
        }
        if (output.event.type === 'host_state') this.currentState = output.event.state as HostState;
        this.emit(output.event);
      }
    });
    input.on('close', () => {
      if (this.child !== child) return;
      // Exit can precede stdout draining its buffered close acknowledgement.
      this.failAll('host_exited', 'Bun Host 输出通道已关闭。');
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

function matchesRuntimeResponse(command: HostCommand, value: unknown): boolean {
  if (!isRuntimeHostCommand(command.type)) return true;
  const result = value as { ok: boolean; data?: unknown; error?: { code: string }; context?: import('@flowmate/contracts').RuntimeEventReadContext | null };
  if (!result.ok) return result.context == null || command.type !== 'query_runtime_events'
    || result.context.runId === command.input.runId
      && (result.context.sessionId === command.input.sessionId || result.error?.code === 'event_cursor_invalid');
  if (command.type === 'query_runtime_events') {
    const page = result.data as import('@flowmate/contracts').RuntimeEventsPage;
    const input = command.input, c = input.cursor.lastPersistedSequence, d = input.availableAfterSequence;
    const through = input.throughSequence ?? page.highWatermark, last = page.items.at(-1)?.sequence ?? d ?? c;
    if (page.runId !== input.runId || page.sessionId !== input.sessionId || input.cursor.runId !== input.runId || c < 0
      || through < c || through > page.highWatermark || page.hasMore !== (last < through)
      || page.items.length > input.limit || page.items.some(event => event.sequence > through)) return false;
    if (d !== undefined) return d >= c && d <= through && page.nextCursor.lastPersistedSequence === c
      && page.nextAvailableAfterSequence === (page.items.at(-1)?.sequence ?? d)
      && (page.items.length === 0 || page.items[0].sequence === d + 1);
    return page.nextAvailableAfterSequence === null && page.nextCursor.lastPersistedSequence === (page.items.at(-1)?.sequence ?? c)
      && (page.items.length === 0 || page.items[0].sequence === c + 1);
  }
  if (command.type === 'subscribe_runtime_events') {
    const info = result.data as import('@flowmate/contracts').RuntimeSubscriptionInfo;
    return info.subscriptionId === command.subscriptionId && info.runId === command.input.runId && info.sessionId === command.input.sessionId
      && command.input.cursor.runId === command.input.runId && command.input.cursor.lastPersistedSequence >= 0
      && command.input.cursor.lastPersistedSequence <= info.highWatermark;
  }
  if (command.type === 'list_run_tool_calls') {
    const page = result.data as import('@flowmate/contracts').Page<import('@flowmate/contracts').RuntimeToolView>;
    return page.items.length <= command.input.limit && (command.input.sessionId !== null || page.items.length === 0)
      && page.items.every(tool => tool.runId === command.input.runId && tool.sessionId === command.input.sessionId
        && (command.input.beforeId === undefined || tool.toolCallId < command.input.beforeId));
  }
  if (command.type === 'query_run_tool_call') {
    const tool = result.data as import('@flowmate/contracts').RuntimeToolView;
    return tool.runId === command.input.runId && tool.sessionId === command.input.sessionId && tool.toolCallId === command.input.toolCallId;
  }
  return true;
}

export function safeChildEnvironment(): NodeJS.ProcessEnv {
  const allowed = ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'COMSPEC', 'PATHEXT', 'TEMP', 'TMP', 'WINDIR', 'USERPROFILE', 'HOME', 'APPDATA', 'LOCALAPPDATA', 'BUN_INSTALL'];
  const env: NodeJS.ProcessEnv = {};
  env.PI_OFFLINE = '1';
  for (const name of allowed) if (process.env[name]) env[name] = process.env[name];
  for (const [name, value] of Object.entries(process.env)) {
    if (value && !/^(FLOWMATE_|LANGFUSE_|CODEX_)/.test(name)
      && (/_(?:API_KEY|AUTH_TOKEN|OAUTH_TOKEN|TOKEN|ACCESS_KEY_ID|SECRET_ACCESS_KEY|PROFILE|REGION|CREDENTIALS|CREDENTIALS_FILE|PROJECT|LOCATION)$/.test(name)
        || name.startsWith('AWS_'))) env[name] = value;
  }
  return env;
}
