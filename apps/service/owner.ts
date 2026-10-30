import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { z } from 'zod';
import { RUNTIME_CONFIG, appError, ok, type CloseReport, type InvoiceFormApplicationReceipt, type Result } from '@flowmate/contracts';
import type { Credential } from '@earendil-works/pi-ai';
import { readServiceInstallation, resolveServiceRuntime, type ServiceInstallation } from '../../packages/shared/src/service-layout.ts';
import { createServiceSecureStorage } from '../../packages/shared/src/service-secure-storage.ts';
import { createCredentialStore } from '../../packages/shared/src/secure-credential-store.ts';
import { createServiceCredentialService } from '../../packages/core/src/configuration/service-credentials.ts';
import { parseHostCommand, type HostCommand, type HostInvoiceFormRequest, type HostOutput, type HostReady } from '../host/protocol.ts';
import type { ProductCommandDispatcher } from '../host/dispatch.ts';
import { createServicePipeServer, type ServicePipeConnection } from './pipe.ts';
import { parseServiceConnect, parseServicePrivateCommand, parseServicePrivateResult, SERVICE_DATA_VERSION, SERVICE_PROTOCOL_VERSION,
  type ForegroundDisconnectReport, type ForegroundReference, type ServiceFailure } from './protocol.ts';

export type ServiceOwner = { readonly pipeName: string; close(): Promise<Result<CloseReport>> };
type Client = { id: string; connection: ServicePipeConnection; live: boolean; foreground: AbortController;
  requests: Map<string, { id: string; protected: boolean }>; subscriptions: Set<string>; preparing: boolean;
  admissions: Map<string, string>; drain: Promise<ForegroundDisconnectReport> | null; lastReport: ForegroundDisconnectReport | null };
type Route = { client: Client; requestId: string; command: HostCommand; retained: boolean; finished: boolean };
type OwnedForeground = { client: Client; reference: ForegroundReference; admitted: boolean };
const credentialSchema = z.union([
  z.object({ type: z.literal('api_key'), key: z.string().min(1).max(65536), env: z.record(z.string()).optional() }).strict(),
  z.object({ type: z.literal('oauth'), refresh: z.string(), access: z.string(), expires: z.number().finite() }).passthrough(),
]);
const credentialReference = /^[a-zA-Z0-9_-]{16,80}$/;
const failure = (code: string, message: string) => ({ ok: false as const, error: appError(code, 'runtime', message, false) });
const interactive = (command: HostCommand) => ['start_run', 'submit_invoice_form_input', 'compact_session', 'call_provider'].includes(command.type)
  || command.type === 'submit_session_input' && command.input.mode === 'prompt';
const protectedRequest = (command: HostCommand) => interactive(command)
  || ['login_model', 'create_session', 'rename_session', 'delete_session'].includes(command.type);

/** One installed product owner. A connection owns only its foreground operations and receivers. */
export async function createServiceOwner(input: { installationFile: string; runtimeRoot: string }): Promise<Result<ServiceOwner>> {
  const installation = await readServiceInstallation(input); if (!installation.ok) return installation;
  const saved = installation.data;
  const layout = await resolveServiceRuntime(saved); if (!layout.ok) return layout;
  // Set SDK paths before importing its module; inherited product/evaluation keys are never a service authority.
  const allowed = new Set(['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'COMSPEC', 'PATHEXT', 'TEMP', 'TMP',
    'WINDIR', 'HOME', 'USERPROFILE', 'LOCALAPPDATA', 'APPDATA', 'PI_OFFLINE']);
  for (const name of Object.keys(process.env)) if (!allowed.has(name)) delete process.env[name];
  process.env.PI_PACKAGE_DIR = layout.data.runtime.sdkRoot;
  process.env.PI_CODING_AGENT_DIR = join(saved.dataRoot, 'runtime');
  const clients = new Set<Client>(), retiredClients = new Map<string, Client>(), routes = new Map<string, Route>();
  const subscriptions = new Map<string, Client>(), runs = new Map<number, OwnedForeground>();
  const forms = new Map<string, { client: Client; output: HostInvoiceFormRequest }>();
  const compactions = new Map<string, OwnedForeground>();
  let dispatcher: ProductCommandDispatcher, ready: HostReady | undefined, closed = false;
  let credentialService: ReturnType<typeof createServiceCredentialService>, activatedOperationId: string | null = null, ownerClosing = false;
  const trustedBootOperationId = saved.enabled === true ? saved.activationOperationId ?? null : null;
  let closing: Promise<Result<CloseReport>> | null = null;
  const unknownForm = (output: HostInvoiceFormRequest): InvoiceFormApplicationReceipt => ({
    runId: output.request.runId, toolCallId: output.request.toolCallId, candidateId: output.request.candidateId,
    candidateSequence: output.request.candidateSequence, formInstanceId: output.request.target.formInstanceId,
    observedAt: new Date().toISOString(), outcome: 'unknown',
  });
  async function write(client: Client, output: unknown) {
    if (!client.live) return;
    try { await client.connection.write(output); }
    catch { await disconnect(client); }
  }
  function forget(id: string) {
    const route = routes.get(id);
    if (route) {
      const binding = route.client.requests.get(route.requestId);
      if (binding?.id === id && !binding.protected) route.client.requests.delete(route.requestId);
    }
    routes.delete(id);
  }
  async function revokeReceivers(client: Client) {
    const revoked: Promise<void>[] = [];
    for (const id of client.subscriptions) {
      subscriptions.delete(id);
      revoked.push(dispatcher.dispatch({ version: 1, requestId: randomUUID(), type: 'unsubscribe_runtime_events',
        ownerToken: client.id, subscriptionId: id }));
    }
    client.subscriptions.clear();
    for (const [id, pending] of forms) if (pending.client === client) {
      forms.delete(id);
      revoked.push(dispatcher.dispatch({ version: 1, requestId: id, type: 'invoice_form_response', receipt: unknownForm(pending.output) }));
    }
    for (const [id, route] of routes) if (route.client === client) {
      if (route.command.type === 'login_model') revoked.push(dispatcher.dispatch({ version: 1, requestId: randomUUID(),
        type: 'cancel_login', loginRequestId: id }));
    }
    await Promise.allSettled(revoked);
  }
  async function checkStop(owned: OwnedForeground) {
    try {
      const result = await dispatcher.readForegroundStop(owned.reference);
      if (!result.ok || !result.data) return;
      if (owned.reference.kind === 'run' && runs.get(owned.reference.runId) === owned) runs.delete(owned.reference.runId);
      if (owned.reference.kind === 'compaction' && compactions.get(owned.reference.operationId) === owned) compactions.delete(owned.reference.operationId);
    } catch { /* Unknown original facts keep the reference and its capacity visible. */ }
  }
  function rememberRun(client: Client, runId: number, sessionId: number | null) {
    let owned = runs.get(runId);
    if (!owned) { owned = { client, reference: { kind: 'run', runId, sessionId }, admitted: true }; runs.set(runId, owned); }
    return owned;
  }
  const references = (client: Client) => [...runs.values(), ...compactions.values()].filter(owned => owned.client === client);
  function disconnectReport(client: Client): ForegroundDisconnectReport {
    const pending = references(client).map(owned => owned.reference), pendingAdmissions = [...client.admissions.values()];
    const stopped = pending.length === 0 && pendingAdmissions.length === 0;
    const report = { connectionId: client.id, stopped, pendingAdmissions, pending,
      errors: stopped ? [] : [appError('foreground_stop_unconfirmed', 'runtime', 'The original foreground stop is not yet confirmed.', true)] };
    client.lastReport = report;
    // Recent positive proofs are bounded; unknown disconnected scopes are never evicted.
    if (retiredClients.size > 64) for (const [id, old] of retiredClients) {
      if (retiredClients.size <= 64) break;
      if (old.lastReport?.stopped && old.admissions.size === 0 && references(old).length === 0) retiredClients.delete(id);
    }
    return report;
  }
  async function checkOriginalStops(client: Client, remaining: number) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { await Promise.race([Promise.all(references(client).map(checkStop)),
      new Promise<void>(resolve => { timer = setTimeout(resolve, Math.max(0, remaining)); })]); }
    finally { clearTimeout(timer); }
  }
  async function queryDisconnect(client: Client): Promise<ForegroundDisconnectReport> {
    await checkOriginalStops(client, RUNTIME_CONFIG.request.stopGraceMs);
    return disconnectReport(client);
  }
  function prepareDisconnect(client: Client): Promise<ForegroundDisconnectReport> {
    if (client.drain) return client.drain;
    client.preparing = true; client.foreground.abort('shutdown');
    client.drain = (async () => {
      const deadline = performance.now() + RUNTIME_CONFIG.request.stopGraceMs;
      await revokeReceivers(client);
      for (;;) {
        await checkOriginalStops(client, deadline - performance.now());
        if (client.admissions.size === 0 && references(client).length === 0 || performance.now() >= deadline) break;
        await Bun.sleep(25);
      }
      return disconnectReport(client);
    })().finally(() => { client.drain = null; });
    return client.drain;
  }
  async function disconnect(client: Client) {
    if (!client.live) return;
    client.live = false; clients.delete(client); retiredClients.set(client.id, client);
    void prepareDisconnect(client);
    for (const [id, route] of routes) if (route.client === client && !interactive(route.command)) forget(id);
    client.requests.clear();
    try { await client.connection.close(); } catch { /* server close retains and retries native pending I/O */ }
  }
  async function activationRecord(operationId: string): Promise<Result<ServiceInstallation>> {
    const current = await readServiceInstallation(input);
    if (!current.ok || current.data.installationId !== saved.installationId || current.data.ownerSid !== saved.ownerSid
      || current.data.dataRoot !== saved.dataRoot || current.data.releaseId !== saved.releaseId)
      return failure('service_installation_invalid', 'The original installation could not be confirmed.');
    if (current.data.activationOperationId !== operationId)
      return failure('service_activation_pending', 'The original activation operation does not match.');
    return current;
  }
  async function activationConditions(operationId: string, expectedRevision: number | undefined, pending: boolean): Promise<Result<number>> {
    const current = await activationRecord(operationId); if (!current.ok) return current;
    if (pending ? current.data.enabled === true : current.data.enabled !== true)
      return failure('service_activation_pending', 'The original activation is not at the required publication phase.');
    const receipt = await credentialService.queryOperation({ installationId: saved.installationId, operationId });
    if (!receipt.ok || receipt.data?.kind !== 'migration' || receipt.data.phase !== 'committed')
      return failure('service_activation_pending', 'The original migration has not been committed.');
    const revision = expectedRevision ?? receipt.data.expectedSettingsRevision;
    const capturedRevision = current.data.activationSettingsRevision;
    const configuration = await dispatcher.settingsAuthority.readSettings();
    if (!configuration.ok || configuration.data.revision !== revision || receipt.data.expectedSettingsRevision !== revision
      || receipt.data.settingsRevision !== revision
      || capturedRevision !== null && capturedRevision !== undefined && capturedRevision !== revision)
      return failure('config_revision_conflict', 'The original activation configuration has changed.');
    const credentials = await credentialService.getStatus();
    if (!credentials.ok || credentials.data.settingsRevision !== revision)
      return failure('service_activation_unconfirmed', 'The original service credentials could not be confirmed.');
    if (credentials.data.models.length !== receipt.data.models.length || receipt.data.models.some(model => {
      const actual = credentials.data.models.find(value => value.modelId === model.modelId && value.credentialRef === model.credentialRef);
      return actual?.status !== (model.state === 'missing' ? 'missing' : 'configured');
    })) return failure('service_credential_not_prepared', 'The original migrated credentials are not readable.');
    const observed = await dispatcher.settingsAuthority.readSettings();
    if (!observed.ok || observed.data.revision !== revision)
      return failure('config_revision_conflict', 'The original activation configuration has changed.');
    return ok(revision);
  }
  async function startActivation(operationId: string, expectedRevision?: number) {
    const recovered = await dispatcher.startRecovery(expectedRevision);
    if (!recovered.ok) return recovered;
    if (ownerClosing || closed)
      return failure('service_activation_unconfirmed', 'The original recovery could not be confirmed.');
    if (activatedOperationId !== null && activatedOperationId !== operationId)
      return failure('service_activation_pending', 'Another original activation has already started scheduling.');
    activatedOperationId = operationId;
    return ok({ installationId: saved.installationId, operationId, active: true as const });
  }
  async function send(output: HostOutput) {
    if (output.type === 'ready') { ready = output; return; }
    if (output.type === 'credential_request') return; // The dispatcher has direct DPAPI access; never expose secrets to a client.
    // Manual trace capture is configured only by the local development Host.
    if (output.type === 'evaluation_trace_available') return;
    if (output.type === 'invoice_form_request') {
      const client = runs.get(output.request.runId)?.client;
      if (client?.live && !client.preparing) { forms.set(output.requestId, { client, output }); await write(client, output); }
      else await dispatcher.dispatch({ version: 1, requestId: output.requestId, type: 'invoice_form_response', receipt: unknownForm(output) });
      return;
    }
    if (output.type === 'event') {
      if (output.event.type === 'host_state') {
        await Promise.all([...clients].map(client => write(client, output))); return;
      }
      if (output.event.type === 'runtime_events_available') {
        const client = subscriptions.get(output.event.subscriptionId); if (client) await write(client, output); return;
      }
      if (output.event.type === 'compaction_observation') {
        const owned = compactions.get(output.event.observation.operationId);
        if (owned) { owned.admitted = true; await write(owned.client, output); if (output.event.observation.stopped) void checkStop(owned); }
        return;
      }
      const route = routes.get(output.event.requestId); if (!route) return;
      if (output.event.type === 'agent_run_event') rememberRun(route.client, output.event.value.runId, output.event.value.sessionId);
      await write(route.client, { ...output, event: { ...output.event, requestId: route.requestId } });
      if (output.event.type === 'agent_run_event' && output.event.value.type === 'run_finished') {
        const owned = runs.get(output.event.value.runId); if (owned) void checkStop(owned);
        route.finished = true;
        if (route.retained) forget(output.event.requestId);
      }
      if (output.event.type === 'provider_finished') { const owned = runs.get(output.event.runId); if (owned) void checkStop(owned); }
      return;
    }
    const route = routes.get(output.requestId); if (!route) return;
    let value = output.value;
    if (value && typeof value === 'object' && 'ok' in value && value.ok === true && 'data' in value
      && value.data && typeof value.data === 'object') {
      const data = value.data as Record<string, unknown>;
      if (interactive(route.command) && typeof data.runId === 'number') {
        const sessionId = typeof data.sessionId === 'number' ? data.sessionId : null;
        rememberRun(route.client, data.runId, sessionId);
        route.retained = route.command.type !== 'call_provider' && !route.finished;
      }
      if (data.requestId === output.requestId) value = { ...value, data: { ...data, requestId: route.requestId } };
    }
    if (route.command.type === 'compact_session') {
      const owned = compactions.get(route.command.input.operationId);
      if (owned && value && typeof value === 'object' && 'ok' in value) {
        if (value.ok) owned.admitted = true;
        else if (!owned.admitted) compactions.delete(route.command.input.operationId);
      }
    }
    const subscription = route.command.type === 'subscribe_runtime_events' || route.command.type === 'unsubscribe_runtime_events' ? route.command : null;
    if (subscription && (subscription.type === 'unsubscribe_runtime_events'
      || value && typeof value === 'object' && 'ok' in value && !value.ok)) {
      const id = subscription.subscriptionId;
      subscriptions.delete(id); route.client.subscriptions.delete(id);
    }
    await write(route.client, { ...output, requestId: route.requestId, value });
  }
  try {
    const { createProductCommandDispatcher } = await import('../host/dispatch.ts');
    const storage = createServiceSecureStorage(saved.ownerSid);
    const store = (reference: string) => {
      if (!credentialReference.test(reference)) throw Error('service_credential_reference_invalid');
      return createCredentialStore(join(saved.dataRoot, 'security/service-credentials', reference + '.json'), storage);
    };
    const created = await createProductCommandDispatcher({ userDataRoot: saved.dataRoot, runtimeRoot: saved.runtimeRoot,
      invoiceSourceRoot: layout.data.runtime.invoiceSourceRoot, send, credentials: {
        async read(reference) {
          const result = await store(reference).read(); if (!result.ok) throw Error(result.error.code);
          if (result.data === null) return undefined;
          return credentialSchema.parse(JSON.parse(result.data)) as Credential;
        },
        async write(reference, credential) {
          const value = credentialSchema.parse(credential);
          const result = await dispatcher.settingsAuthority.withSettingsWrite(async scope => {
            if (!scope.current.models.some(model => model.credentialRef === reference)) return failure('credential_model_missing', 'The selected model is unavailable.');
            return store(reference).write(JSON.stringify(value));
          });
          if (!result.ok) throw Error(result.error.code);
        },
        async delete(reference) {
          const result = await dispatcher.settingsAuthority.withSettingsWrite(async scope => {
            if (!scope.current.models.some(model => model.credentialRef === reference)) return failure('credential_model_missing', 'The selected model is unavailable.');
            return store(reference).remove();
          });
          if (!result.ok) throw Error(result.error.code);
        },
      } });
    if (!created.ok) return created;
    dispatcher = created.data;
    credentialService = createServiceCredentialService({ installationId: saved.installationId, dataRoot: saved.dataRoot,
      secureStorage: storage, settingsAuthority: dispatcher.settingsAuthority });
    if (!ready?.state.ready) { await dispatcher.close(); return failure('service_owner_unavailable', 'The service owner could not open.'); }
  } catch { return failure('service_owner_unavailable', 'The installed service owner could not open.'); }
  let server: Awaited<ReturnType<typeof createServicePipeServer>>;
  try { server = await createServicePipeServer(saved); }
  catch { await dispatcher.close(); return failure('service_pipe_unavailable', 'The service pipe could not open.'); }

  async function dispatch(client: Client, raw: unknown) {
    const control = parseServicePrivateCommand(raw);
    if (control) {
      let value: unknown;
      try {
        if ('input' in control && 'installationId' in control.input && control.input.installationId !== saved.installationId)
          value = failure('service_installation_invalid', 'The original installation identity does not match.');
        else if (ownerClosing && !['service_credentials_status', 'service_credentials_query_operation', 'service_prepare_disconnect', 'service_query_disconnect', 'service_query_activation'].includes(control.type))
          value = failure('host_closing', 'The service owner is closing.');
        else switch (control.type) {
          case 'service_prepare_disconnect': value = ok(await prepareDisconnect(client)); break;
          case 'service_query_disconnect': {
            const original = [...clients].find(candidate => candidate.id === control.input.connectionId) ?? retiredClients.get(control.input.connectionId);
            value = original ? ok(await queryDisconnect(original)) : failure('service_connection_unknown', 'The original connection stop facts are unavailable.'); break;
          }
          case 'service_credentials_status': value = await credentialService.getStatus(); break;
          case 'service_credentials_prepare': value = await credentialService.prepareMigration(control.input); break;
          case 'service_credentials_commit': value = await credentialService.commitMigration(control.input); break;
          case 'service_credentials_query_operation': value = await credentialService.queryOperation(control.input); break;
          case 'service_settings_save': value = await credentialService.saveSettings(control.input); break;
          case 'service_prepare_activation': {
            const prepared = await activationConditions(control.input.operationId, control.input.expectedSettingsRevision, true);
            value = prepared.ok ? ok({ installationId: saved.installationId, operationId: control.input.operationId,
              settingsRevision: prepared.data, ready: true }) : prepared;
            break;
          }
          case 'service_query_activation': {
            const current = await activationRecord(control.input.operationId);
            value = current.ok ? ok({ ...control.input, active: current.data.enabled === true
              && activatedOperationId === control.input.operationId && !ownerClosing && !closed }) : current;
            break;
          }
          case 'service_activate': {
            const current = await activationRecord(control.input.operationId);
            if (!current.ok) value = current;
            else if (current.data.enabled !== true)
              value = failure('service_activation_pending', 'The original activation has not been published.');
            else if (activatedOperationId === control.input.operationId) value = ok({ ...control.input, active: true });
            else if (trustedBootOperationId === control.input.operationId) value = await startActivation(control.input.operationId);
            else {
              const conditions = await activationConditions(control.input.operationId, undefined, false);
              value = conditions.ok ? await startActivation(control.input.operationId, conditions.data) : conditions;
            }
            break;
          }
        }
      } catch { value = failure('service_control_failed', 'The service operation could not be confirmed.'); }
      await write(client, { version: 1, type: 'response', requestId: control.requestId,
        value: parseServicePrivateResult(control.type, value) ?? failure('service_control_failed', 'The service operation could not be confirmed.') }); return;
    }
    const command = parseHostCommand(raw);
    if (!command) {
      const requestId = raw && typeof raw === 'object' && 'requestId' in raw ? raw.requestId : null;
      if (typeof requestId === 'string' && requestId.length <= 128) await write(client, { version: 1, type: 'response', requestId,
        value: failure('host_protocol_invalid', 'The product command is invalid.') });
      return;
    }
    const reject = (code = 'service_command_forbidden') => write(client, { version: 1, type: 'response', requestId: command.requestId,
      value: failure(code, 'This operation is not available to this service connection.') });
    if (command.type === 'close' || command.type === 'credential_response') { await reject(); return; }
    if (activatedOperationId === null && (interactive(command) || command.type === 'submit_session_input' || command.type === 'login_model')) { await reject('service_standby'); return; }
    if (client.preparing && (interactive(command) || command.type === 'submit_session_input'
      || command.type === 'login_model' || command.type === 'subscribe_runtime_events')) { await reject('service_connection_draining'); return; }
    if (command.type === 'invoice_form_response') {
      const pending = forms.get(command.requestId);
      if (pending?.client !== client) { await reject(); return; }
      const original = pending.output.request, receipt = command.receipt;
      if (receipt.runId !== original.runId || receipt.toolCallId !== original.toolCallId
        || receipt.formInstanceId !== original.target.formInstanceId || receipt.candidateId !== original.candidateId
        || receipt.candidateSequence !== original.candidateSequence
        || receipt.outcome === 'applied' && receipt.appliedRevision !== original.target.expectedRevision + 1) { await reject(); return; }
      await dispatcher.dispatch(command); forms.delete(command.requestId); return;
    }
    if (command.type === 'cancel_run' && runs.get(command.runId)?.client !== client
      || command.type === 'submit_session_input' && command.input.mode !== 'prompt' && runs.get(command.input.runId)?.client !== client
      || command.type === 'cancel_session_compaction' && compactions.get(command.input.operationId)?.client !== client) { await reject(); return; }
    const previous = client.requests.get(command.requestId);
    if (previous && (routes.has(previous.id) || previous.protected && protectedRequest(command))) {
      await reject(command.type === 'login_model' ? 'auth_login_busy' : 'request_duplicate'); return;
    }
    if (!previous?.protected && protectedRequest(command)
      && [...client.requests.values()].filter(value => value.protected).length >= 4096) { await reject('service_request_capacity'); return; }
    let scoped = command;
    if (command.type === 'subscribe_runtime_events' || command.type === 'unsubscribe_runtime_events'
      || command.type === 'query_runtime_events') {
      const id = command.type === 'query_runtime_events' ? command.input.subscriptionId : command.subscriptionId;
      if (id && (subscriptions.has(id) && subscriptions.get(id) !== client
        || command.type !== 'subscribe_runtime_events' && subscriptions.get(id) !== client)) { await reject(); return; }
      if (command.type === 'subscribe_runtime_events') { subscriptions.set(command.subscriptionId, client); client.subscriptions.add(command.subscriptionId); }
      scoped = { ...command, ownerToken: client.id };
    }
    if (command.type === 'auth_reply' || command.type === 'cancel_login' || command.type === 'cancel_provider') {
      const target = command.type === 'cancel_provider' ? command.targetRequestId : command.loginRequestId;
      const internal = client.requests.get(target)?.id, route = internal ? routes.get(internal) : null;
      if (!route || route.command.type !== (command.type === 'cancel_provider' ? 'call_provider' : 'login_model')) { await reject(); return; }
      scoped = command.type === 'cancel_provider' ? { ...command, targetRequestId: internal! } : { ...command, loginRequestId: internal! };
    }
    if (command.type === 'compact_session') {
      if (compactions.has(command.input.operationId) && compactions.get(command.input.operationId)?.client !== client) { await reject(); return; }
      compactions.set(command.input.operationId, { client, reference: { kind: 'compaction', sessionId: command.input.sessionId,
        operationId: command.input.operationId }, admitted: false });
    }
    const id = previous?.id ?? randomUUID(), route: Route = { client, requestId: command.requestId, command, retained: false, finished: false };
    routes.set(id, route);
    // Keep protected identities until disconnect; pure reads must never evict them and enable a repeated effect.
    client.requests.set(command.requestId, { id, protected: previous?.protected || protectedRequest(command) });
    if (interactive(command) || command.type === 'login_model') client.admissions.set(id, command.requestId);
    try {
      if (client.live) await dispatcher.dispatch({ ...scoped, requestId: id }, interactive(command) ? { signal: client.foreground.signal } : undefined);
    } finally { client.admissions.delete(id); if (!route.retained) forget(id); }
  }
  async function serve(connection: ServicePipeConnection) {
    let client: Client | undefined;
    try {
      const timer = setTimeout(() => { void connection.close().catch(() => {}); }, 5000);
      let hello; try { hello = parseServiceConnect(await connection.read()); } finally { clearTimeout(timer); }
      if (connection.peerSid !== saved.ownerSid || !hello || hello.installationId !== saved.installationId
        || hello.releaseId !== saved.releaseId || clients.size >= 64) {
        const output: ServiceFailure = { version: 1, type: 'service_error', result: failure('service_incompatible', 'The service identity is incompatible.') };
        await connection.write(output); return;
      }
      client = { id: randomUUID(), connection, live: true, foreground: new AbortController(), requests: new Map(), subscriptions: new Set(),
        preparing: false, admissions: new Map(), drain: null, lastReport: null };
      await connection.write({ version: 1, type: 'service_ready', installationId: saved.installationId, releaseId: saved.releaseId,
        protocolVersion: SERVICE_PROTOCOL_VERSION, dataVersion: SERVICE_DATA_VERSION, connectionId: client.id });
      clients.add(client);
      while (client.live && !closed) {
        const command = await connection.read();
        void dispatch(client, command).catch(() => disconnect(client!));
      }
    } catch { /* Disconnect changes only this connection's authority and foreground resources. */ }
    finally { if (client) await disconnect(client); else await connection.close().catch(() => {}); }
  }
  void (async () => {
    while (!closed) {
      try { const connection = await server.accept(); void serve(connection); }
      catch { if (!closed) await new Promise(resolve => setTimeout(resolve, 50)); }
    }
  })();
  // The authenticated pipe reader is installed before recovery can schedule work.
  if (trustedBootOperationId !== null) void startActivation(trustedBootOperationId);
  return ok({ pipeName: server.name, close() {
    ownerClosing = true;
    if (closing) return closing;
    closing = (async () => {
      const report = await dispatcher.close();
      if (!report.ok || !report.data.stopped || !report.data.closed) return report;
      runs.clear(); compactions.clear();
      closed = true;
      await Promise.all([...clients].map(disconnect));
      try { await server.close(); return report; }
      catch { return ok({ ...report.data, closed: false, errors: [...report.data.errors,
        appError('service_pipe_close_unconfirmed', 'runtime', 'The service pipe has not confirmed release.', true)] }); }
    })().finally(() => { closing = null; });
    return closing;
  } });
}
