import { randomUUID } from 'node:crypto';
import { createConnection, type Socket } from 'node:net';
import { isAbsolute, resolve } from 'node:path';
import { z } from 'zod';
import { AppErrorSchema, InvoiceFormApplicationReceiptSchema, InvoiceFormBridgeRequestSchema, RuntimeEventsWakeSchema,
  appError, fail, ok, type InvoiceFormApplicationReceipt, type InvoiceFormBridgeRequest, type Result } from '@flowmate/contracts';
import type { ServiceInstallation } from '../../../packages/shared/src/service-layout.ts';
import { parseHostCommand, parseCompactionNotification, type HostCommand, type HostEvent, type HostResponse } from '../../host/protocol.ts';
import { SERVICE_DATA_VERSION, SERVICE_PROTOCOL_VERSION, parseServiceConnect, parseServiceHandshake, servicePipeName,
  ServicePrepareDisconnectSchema, parseForegroundDisconnectResult, type ForegroundDisconnectReport } from '../../service/protocol.ts';
import { parseServicePrivateCommand, parseServicePrivateResult, type ServicePrivateCommandType } from '../../service/protocol.ts';
import type { ServicePrepareActivationRequest } from '../../service/protocol.ts';
import type { ServiceCredentialStatus, ServiceCredentialOperationReceipt, ServiceCredentialMigrationRequest,
  ServiceCredentialOperationQuery, ServiceCredentialSettingsRequest } from '../../../packages/core/src/configuration/service-credentials.ts';
import { parseHostResponse, type HostCommandInput, type HostState } from './host-client.ts';
import { validateProductSettings } from '../../../packages/core/src/configuration/settings.ts';

const maxInboundFrameBytes = 14 * 1024 * 1024 + 64 * 1024;
const maxOutboundFrameBytes = 1_100_000;
const stateSchema = z.object({ version: z.literal(1), ready: z.boolean(), host: z.enum(['starting', 'ready', 'closing', 'error']),
  appVersion: z.string().min(1).max(128), userDataPath: z.string().max(32767), settings: z.unknown().optional().transform((value, context) => {
    if (value === undefined) return undefined;
    const result = validateProductSettings(value); if (result.ok) return result.data;
    context.addIssue({ code: 'custom', message: 'Service settings are invalid.' }); return z.NEVER;
  }) }).strict();
const stateResultSchema = z.union([z.object({ ok: z.literal(true), data: stateSchema }).strict(),
  z.object({ ok: z.literal(false), error: AppErrorSchema }).strict()]);
type Pending = { command: HostCommand | null; parseValue?: (value: unknown) => unknown;
  resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> };
export type ServiceCommandInput = Exclude<HostCommandInput, { type: 'close' | 'credential_response' | 'invoice_form_response' }>;

export class ServiceClient {
  private socket: Socket | null = null;
  private readonly pending = new Map<string, Pending>();
  private readonly listeners = new Set<(event: HostEvent['event']) => void>();
  private currentState: HostState | null = null;
  private status: 'disconnected' | 'connecting' | 'connected' = 'disconnected';
  private epoch = 0;
  private connectionId: string | null = null;
  private lastConnectionId: string | null = null;
  private installationId: string | null = null;
  private expectedDataRoot: string | null = null;
  private connectionChangeHandler: (() => void) | null = null;
  private invoiceFormHandler: ((request: InvoiceFormBridgeRequest, epoch: number) => Promise<InvoiceFormApplicationReceipt>) | null = null;

  public get state(): HostState | null { return this.currentState; }
  public get connectionEpoch(): number { return this.epoch; }
  public get connectionState(): 'disconnected' | 'connecting' | 'connected' { return this.status; }
  public get isConnected(): boolean { return this.status === 'connected' && this.socket !== null && !this.socket.destroyed; }
  public get serverConnectionId(): string | null { return this.isConnected ? this.connectionId : null; }
  public get lastServerConnectionId(): string | null { return this.lastConnectionId; }
  public setConnectionChangeHandler(handler: () => void): void { this.connectionChangeHandler = handler; }
  public setInvoiceFormHandler(handler: (request: InvoiceFormBridgeRequest, epoch: number) => Promise<InvoiceFormApplicationReceipt>): void {
    this.invoiceFormHandler = handler;
  }
  public subscribe(listener: (event: HostEvent['event']) => void): () => void {
    this.listeners.add(listener); return () => { this.listeners.delete(listener); };
  }

  public async connect(installation: ServiceInstallation, timeoutMs = 10_000): Promise<Result<HostState>> {
    if (this.socket) return fail(appError('service_connection_active', 'runtime', 'The desktop already has a service connection.'));
    const expectedDataRoot = installation.dataRoot;
    const hello = parseServiceConnect({ version: 1, type: 'service_connect', installationId: installation.installationId,
      releaseId: installation.releaseId, protocolVersion: SERVICE_PROTOCOL_VERSION, dataVersion: SERVICE_DATA_VERSION });
    if (!hello || typeof expectedDataRoot !== 'string' || !isAbsolute(expectedDataRoot) || resolve(expectedDataRoot) !== expectedDataRoot)
      return fail(appError('service_installation_invalid', 'runtime', 'The saved service identity is invalid.'));
    this.connectionChangeHandler?.();
    this.epoch++; this.status = 'connecting'; this.expectedDataRoot = expectedDataRoot; this.installationId = hello.installationId;
    const epoch = this.epoch, deadline = Date.now() + timeoutMs;
    const socket = createConnection({ path: servicePipeName(hello.installationId) }); this.socket = socket;
    let resolveHandshake!: () => void, rejectHandshake!: (error: Error) => void;
    const handshake = new Promise<void>((resolve, reject) => { resolveHandshake = resolve; rejectHandshake = reject; });
    const failure = (code: string) => { rejectHandshake(Error(code)); this.dropConnection(socket, code); };
    const timer = setTimeout(() => failure('service_connect_timeout'), timeoutMs);
    socket.on('connect', () => { try { this.write(socket, hello); } catch { failure('service_connect_failed'); } });
    socket.on('error', () => failure('service_connect_failed'));
    socket.on('close', () => failure('service_disconnected'));
    let parts: Buffer[] = [], bytes = 0;
    socket.on('end', () => failure(bytes ? 'host_protocol_invalid' : 'service_disconnected'));
    const decoder = new TextDecoder('utf-8', { fatal: true });
    const forms = new Set<string>();
    socket.on('data', (chunk: Buffer) => {
      if (this.socket !== socket || this.epoch !== epoch) return;
      for (let start = 0; start < chunk.length;) {
        const newline = chunk.indexOf(10, start), end = newline === -1 ? chunk.length : newline;
        bytes += end - start;
        if (bytes > maxInboundFrameBytes) { failure('host_protocol_invalid'); return; }
        parts.push(chunk.subarray(start, end));
        if (newline === -1) return;
        try {
          const output: unknown = JSON.parse(decoder.decode(Buffer.concat(parts, bytes))); parts = []; bytes = 0;
          if (!this.connectionId) {
            const ready = parseServiceHandshake(output);
            if (!ready || ready.type !== 'service_ready' || ready.installationId !== hello.installationId || ready.releaseId !== hello.releaseId)
              throw Error('host_protocol_invalid');
            this.connectionId = ready.connectionId; resolveHandshake();
          } else this.readOutput(socket, epoch, forms, output);
        } catch { failure('host_protocol_invalid'); return; }
        if (this.socket !== socket || this.epoch !== epoch) return;
        start = newline + 1;
      }
    });
    try {
      await handshake;
      const state = stateResultSchema.safeParse(await this.sendRequest({ type: 'get_state' }, Math.max(1, deadline - Date.now())));
      if (!state.success || !state.data.ok || state.data.data.userDataPath !== expectedDataRoot
        || this.socket !== socket || this.epoch !== epoch) throw Error('host_protocol_invalid');
      this.currentState = state.data.data; this.status = 'connected';
      return ok(this.currentState);
    } catch (cause) {
      const code = cause instanceof Error && cause.message === 'host_protocol_invalid' ? 'host_protocol_invalid'
        : cause instanceof Error && cause.message === 'service_connect_timeout' ? 'service_connect_timeout' : 'service_connect_failed';
      this.dropConnection(socket, code);
      return fail(appError(code, 'runtime', 'The desktop could not confirm the installed service connection.', true));
    } finally { clearTimeout(timer); }
  }

  public disconnect(): void { if (this.socket) this.dropConnection(this.socket, 'service_disconnected'); }

  public async prepareDisconnect(timeoutMs = 15_000): Promise<Result<ForegroundDisconnectReport>> {
    const connectionId = this.connectionId;
    if (!this.isConnected) return fail(appError('service_disconnect_unconfirmed', 'runtime', 'The foreground connection could not be confirmed.', true));
    try {
      const message = ServicePrepareDisconnectSchema.parse({ version: 1, type: 'service_prepare_disconnect', requestId: randomUUID() });
      return await this.sendPacket(message, timeoutMs, null, value => {
        const result = parseForegroundDisconnectResult(value);
        if (!result || result.ok && result.data.connectionId !== connectionId) throw Error('host_protocol_invalid');
        return result;
      }) as Result<ForegroundDisconnectReport>;
    } catch (cause) { return fail(appError(cause instanceof Error && cause.message === 'host_protocol_invalid' ? 'host_protocol_invalid'
      : 'service_disconnect_unconfirmed', 'runtime', 'The original foreground stop could not be confirmed. Query or retry before disconnecting.', true)); }
  }

  public async queryDisconnect(originalConnectionId: string, timeoutMs = 10_000): Promise<Result<ForegroundDisconnectReport>> {
    return this.serviceRequest('service_query_disconnect', { connectionId: originalConnectionId }, timeoutMs) as Promise<Result<ForegroundDisconnectReport>>;
  }

  public async getCredentialStatus(timeoutMs = 10_000): Promise<Result<ServiceCredentialStatus>> {
    return this.serviceRequest('service_credentials_status', undefined, timeoutMs) as Promise<Result<ServiceCredentialStatus>>;
  }
  public async prepareCredentialMigration(input: ServiceCredentialMigrationRequest, timeoutMs = 10_000): Promise<Result<ServiceCredentialOperationReceipt>> {
    return this.serviceRequest('service_credentials_prepare', input, timeoutMs) as Promise<Result<ServiceCredentialOperationReceipt>>;
  }
  public async commitCredentialMigration(input: ServiceCredentialOperationQuery, timeoutMs = 10_000): Promise<Result<ServiceCredentialOperationReceipt>> {
    return this.serviceRequest('service_credentials_commit', input, timeoutMs) as Promise<Result<ServiceCredentialOperationReceipt>>;
  }
  public async queryCredentialOperation(input: ServiceCredentialOperationQuery, timeoutMs = 10_000): Promise<Result<ServiceCredentialOperationReceipt | null>> {
    return this.serviceRequest('service_credentials_query_operation', input, timeoutMs) as Promise<Result<ServiceCredentialOperationReceipt | null>>;
  }
  public async saveServiceSettings(input: ServiceCredentialSettingsRequest, timeoutMs = 10_000): Promise<Result<ServiceCredentialOperationReceipt>> {
    return this.serviceRequest('service_settings_save', input, timeoutMs) as Promise<Result<ServiceCredentialOperationReceipt>>;
  }
  public async activateService(input: ServiceCredentialOperationQuery, timeoutMs = 10_000): Promise<Result<{ installationId: string; operationId: string; active: true }>> {
    return this.serviceRequest('service_activate', input, timeoutMs) as Promise<Result<{ installationId: string; operationId: string; active: true }>>;
  }
  public async prepareActivation(input: ServicePrepareActivationRequest, timeoutMs = 10_000):
  Promise<Result<{ installationId: string; operationId: string; settingsRevision: number; ready: true }>> {
    return this.serviceRequest('service_prepare_activation', input, timeoutMs) as Promise<Result<{
      installationId: string; operationId: string; settingsRevision: number; ready: true }>>;
  }
  public async queryActivation(input: ServiceCredentialOperationQuery, timeoutMs = 10_000):
  Promise<Result<{ installationId: string; operationId: string; active: boolean }>> {
    return this.serviceRequest('service_query_activation', input, timeoutMs) as Promise<Result<{
      installationId: string; operationId: string; active: boolean }>>;
  }

  private async serviceRequest(type: ServicePrivateCommandType, input: unknown, timeoutMs: number): Promise<unknown> {
    if (!this.isConnected) return fail(appError('service_operation_unavailable', 'runtime', 'The installed service is not connected.', true));
    const message = parseServicePrivateCommand({ version: 1, type, requestId: randomUUID(), ...(input === undefined ? {} : { input }) });
    const expectedInstallation = this.installationId;
    if (!message || 'input' in message && 'installationId' in message.input && message.input.installationId !== expectedInstallation)
      return fail(appError('service_credential_request_invalid', 'input', 'The service request does not match the installed owner.'));
    const submittedSettings = message.type === 'service_settings_save' ? validateProductSettings(message.input.settings) : null;
    try {
      return await this.sendPacket(message, timeoutMs, null, value => {
        const result = parseServicePrivateResult(type, value); if (!result) throw Error('host_protocol_invalid');
        if (result.ok && result.data !== null && 'connectionId' in result.data && message.type === 'service_query_disconnect'
          && result.data.connectionId !== message.input.connectionId) throw Error('host_protocol_invalid');
        if (result.ok && result.data !== null && 'installationId' in result.data) {
          if (result.data.installationId !== expectedInstallation) throw Error('host_protocol_invalid');
          if ('input' in message && 'operationId' in message.input && 'operationId' in result.data
            && result.data.operationId !== message.input.operationId) throw Error('host_protocol_invalid');
          if (message.type === 'service_prepare_activation' && (!('settingsRevision' in result.data)
            || result.data.settingsRevision !== message.input.expectedSettingsRevision)) throw Error('host_protocol_invalid');
          if ('kind' in result.data) {
            if (type === 'service_settings_save' && result.data.kind !== 'settings'
              || ['service_credentials_prepare', 'service_credentials_commit'].includes(type) && result.data.kind !== 'migration') throw Error('host_protocol_invalid');
            if (message.type === 'service_credentials_prepare' && (result.data.expectedSettingsRevision !== message.input.expectedSettingsRevision
              || result.data.models.length !== message.input.credentials.length || result.data.models.some(model => !message.input.credentials.some(
                original => original.modelId === model.modelId && original.credentialRef === model.credentialRef)))) throw Error('host_protocol_invalid');
            if (message.type === 'service_settings_save') {
              const update = message.input.credentialUpdate;
              if (!submittedSettings?.ok || result.data.expectedSettingsRevision !== submittedSettings.data.revision
                || result.data.models.length !== (update ? 1 : 0) || update && result.data.models[0]!.modelId !== update.modelId)
                throw Error('host_protocol_invalid');
              if (update && result.data.phase === 'committed') {
                const model = result.data.settings?.models.find(model => model.id === update.modelId);
                if (!model || model.credentialRef !== result.data.models[0]!.credentialRef) throw Error('host_protocol_invalid');
              }
            }
            if (result.data.phase === 'committed' && result.data.settingsRevision !== result.data.expectedSettingsRevision + (result.data.kind === 'settings' ? 1 : 0))
              throw Error('host_protocol_invalid');
          }
        }
        return result;
      });
    } catch (cause) { return fail(appError(cause instanceof Error && cause.message === 'host_protocol_invalid' ? 'host_protocol_invalid'
      : 'operation_result_unknown', 'runtime', 'The original service operation could not be confirmed. Query its original operation ID before retrying.', true)); }
  }

  public async request(command: ServiceCommandInput, timeoutMs = 10_000): Promise<unknown> {
    if (['close', 'credential_response', 'invoice_form_response'].includes(command.type)) throw Error('service_command_forbidden');
    if (!this.isConnected) throw Error('host_not_writable');
    return this.sendRequest(command, timeoutMs);
  }

  private async sendRequest(command: ServiceCommandInput, timeoutMs: number): Promise<unknown> {
    const message = parseHostCommand({ ...command, version: 1, requestId: command.requestId ?? randomUUID() });
    if (!message) throw Error('host_protocol_invalid');
    return this.sendPacket(message, timeoutMs, message);
  }

  private async sendPacket(message: { version: 1; type: string; requestId: string }, timeoutMs: number,
    command: HostCommand | null, parseValue?: (value: unknown) => unknown): Promise<unknown> {
    const socket = this.socket;
    if (!socket || !this.connectionId || socket.destroyed || !socket.writable) throw Error('host_not_writable');
    if (this.pending.has(message.requestId)) throw Error('service_request_pending');
    const frame = JSON.stringify(message) + '\n';
    if (Buffer.byteLength(frame) - 1 > maxOutboundFrameBytes) throw Error('host_protocol_invalid');
    return new Promise((resolve, reject) => {
      const pending: Pending = { command, parseValue, resolve, reject, timer: setTimeout(() => {
        if (this.pending.get(message.requestId) !== pending) return;
        this.pending.delete(message.requestId); reject(Error('host_request_timeout'));
      }, timeoutMs) };
      this.pending.set(message.requestId, pending);
      try { socket.write(frame, 'utf8', error => {
        if (!error || this.pending.get(message.requestId) !== pending) return;
        clearTimeout(pending.timer); this.pending.delete(message.requestId); reject(Error('host_write_failed'));
      }); } catch {
        clearTimeout(pending.timer); this.pending.delete(message.requestId); reject(Error('host_write_failed'));
      }
    });
  }

  public captureRuntimeSubscriptionCleanup(ownerToken: string, subscriptionId: string): () => void {
    const socket = this.socket, epoch = this.epoch;
    return () => {
      if (!socket || !this.isConnected || socket.destroyed || !socket.writable || this.socket !== socket || this.epoch !== epoch) return;
      const command = parseHostCommand({ version: 1, type: 'unsubscribe_runtime_events', requestId: randomUUID(), ownerToken, subscriptionId });
      if (command) try { this.write(socket, command); } catch { /* Only the original connection owns this subscription. */ }
    };
  }

  private readOutput(socket: Socket, epoch: number, forms: Set<string>, raw: unknown): void {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw Error('host_protocol_invalid');
    const output = raw as Record<string, unknown>;
    if (output.version !== 1 || typeof output.type !== 'string') throw Error('host_protocol_invalid');
    if (output.type === 'credential_request') throw Error('host_protocol_invalid');
    if (output.type === 'response') {
      if (typeof output.requestId !== 'string' || !output.requestId || output.requestId.length > 128)
        throw Error('host_protocol_invalid');
      const pending = this.pending.get(output.requestId); if (!pending) return;
      clearTimeout(pending.timer); this.pending.delete(output.requestId);
      try {
        if (Object.keys(output).some(key => !['version', 'type', 'requestId', 'value'].includes(key)) || !Object.hasOwn(output, 'value'))
          throw Error('host_protocol_invalid');
        if (pending.parseValue) { pending.resolve(pending.parseValue(output.value)); return; }
        if (!pending.command) throw Error('host_protocol_invalid');
        const value = parseHostResponse(pending.command, output as HostResponse);
        if (pending.command.type === 'get_state') {
          const state = stateResultSchema.safeParse(value); if (!state.success) throw Error('host_protocol_invalid');
          if (state.data.ok) {
            if (state.data.data.userDataPath !== this.expectedDataRoot) { this.dropConnection(socket, 'host_protocol_invalid'); throw Error('host_protocol_invalid'); }
            this.currentState = state.data.data;
          }
          pending.resolve(state.data);
        } else pending.resolve(value);
      } catch { pending.reject(Error('host_protocol_invalid')); }
      return;
    }
    if (output.type === 'invoice_form_request') {
      if (!this.isConnected) throw Error('host_protocol_invalid');
      if (Object.keys(output).some(key => !['version', 'type', 'requestId', 'request'].includes(key))
        || typeof output.requestId !== 'string' || !output.requestId || output.requestId.length > 128) throw Error('host_protocol_invalid');
      const request = InvoiceFormBridgeRequestSchema.safeParse(output.request); if (!request.success) throw Error('host_protocol_invalid');
      const requestId = output.requestId, original = request.data;
      if (forms.has(requestId)) return; forms.add(requestId);
      const unknown = (): InvoiceFormApplicationReceipt => ({ runId: original.runId, toolCallId: original.toolCallId,
        formInstanceId: original.target.formInstanceId, candidateId: original.candidateId, candidateSequence: original.candidateSequence,
        observedAt: new Date().toISOString(), outcome: 'unknown' });
      void Promise.resolve().then(() => this.socket === socket && this.epoch === epoch ? this.invoiceFormHandler?.(original, epoch) ?? unknown() : unknown())
        .catch(unknown).then(value => {
          if (this.socket !== socket || this.epoch !== epoch || socket.destroyed || !socket.writable) return;
          const receipt = InvoiceFormApplicationReceiptSchema.safeParse(value);
          const matched = receipt.success && receipt.data.runId === original.runId && receipt.data.toolCallId === original.toolCallId
            && receipt.data.formInstanceId === original.target.formInstanceId && receipt.data.candidateId === original.candidateId
            && receipt.data.candidateSequence === original.candidateSequence;
          try { this.write(socket, { version: 1, type: 'invoice_form_response', requestId, receipt: matched ? receipt.data : unknown() }); }
          catch { this.dropConnection(socket, 'host_write_failed'); }
        });
      return;
    }
    if (output.type !== 'event' || Object.keys(output).some(key => !['version', 'type', 'event'].includes(key))
      || !output.event || typeof output.event !== 'object' || Array.isArray(output.event)) throw Error('host_protocol_invalid');
    const event = output.event as HostEvent['event'];
    if (event.type === 'runtime_events_available') {
      const wake = RuntimeEventsWakeSchema.safeParse(event); if (wake.success) this.emit(wake.data);
    } else if (event.type === 'compaction_observation') {
      const observation = parseCompactionNotification(event); if (observation) this.emit(observation);
    } else if (event.type === 'host_state') {
      const state = stateSchema.safeParse(event.state);
      if (!state.success || state.data.userDataPath !== this.expectedDataRoot
        || Object.keys(event).some(key => !['type', 'state'].includes(key))) throw Error('host_protocol_invalid');
      this.currentState = state.data; this.emit({ type: 'host_state', state: state.data });
    } else if (['provider_observation', 'provider_finished', 'model_auth_notice', 'model_auth_prompt', 'agent_run_event'].includes(event.type)) this.emit(event);
  }

  private write(socket: Socket, value: unknown): void {
    const frame = JSON.stringify(value) + '\n';
    if (Buffer.byteLength(frame) - 1 > maxOutboundFrameBytes || socket.destroyed || !socket.writable) throw Error('host_write_failed');
    socket.write(frame);
  }
  private dropConnection(socket: Socket, code: string): void {
    if (this.socket !== socket) return;
    if (this.status === 'connected' && this.connectionId) this.lastConnectionId = this.connectionId;
    this.status = 'disconnected';
    this.connectionChangeHandler?.();
    this.socket = null; this.connectionId = null; this.installationId = null; this.expectedDataRoot = null; this.currentState = null; this.epoch++;
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(Error(code)); }
    this.pending.clear(); socket.destroy();
  }
  private emit(event: HostEvent['event']): void {
    for (const listener of this.listeners) try { listener(event); } catch { /* A subscriber cannot block the service connection. */ }
  }
}
