import { createHash, randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { createInterface } from 'node:readline';
import type { Credential, CredentialStore } from '@earendil-works/pi-ai';
import { RUNTIME_CONFIG, appError, fail, normalizeAgentRunRequest, normalizeProviderRequest, ok, serializeDesktopPromptRequest, serializeDesktopInvoiceFormRequest,
  RuntimeEventsAvailableSchema, EMPTY_RESOURCE_SELECTION, ResourceSelectionSchema, EMPTY_EXTENSION_SELECTION, ExtensionSelectionSchema,
  } from '@flowmate/contracts';
import type { AgentRunEvent, Application, DesktopState, InvoiceFormApplicationReceipt, InvoiceFormBridgeRequest, ModelProfile, ProductSettings, Result } from '@flowmate/contracts';
import { defaultProductSettings, readProductSettings, saveProductSettings, validateProductSettings } from '@flowmate/core';
import { createPromptTraceBuffer } from '@flowmate/logging';
import { PiAgentAdapter, PiProviderAdapter, createPiModelCatalog, loginPiProvider, logoutPiProvider } from '@flowmate/runtime-pi';
import { resolveProductPaths } from '@flowmate/shared';
import { createApplication } from '../composition.ts';
import { isExtensionHostCommand, parseExtensionHostResult, matchesExtensionResponse, isResourceHostCommand, parseResourceHostResult, matchesResourceResponse } from './protocol.ts';
import { parseCompactionHostResult, matchesCompactionResponse, compactionHostFailure, parseCompactionNotification } from './protocol.ts';
import { parseHostCommand, parseRuntimeHostResult, isRuntimeHostCommand, isContextHostCommand,
  parseContextHostResult, matchesContextResponse, contextHostFailure,
  isHistoryHostCommand, parseHistoryHostResult, matchesHistoryResponse, historyHostFailure } from './protocol.ts';
import type { HostCommand, HostOutput } from './protocol.ts';

for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) {
  console[method] = (...values: unknown[]) => process.stderr.write(`${values.map((value) => String(value)).join(' ')}\n`);
}

// Bun's native stdout can block inside write on Windows and reports no queue length.
// This fd=1 stream tracks real bytes waiting for pipe drain for every protocol line.
const stdout = createWriteStream('', { fd: 1, autoClose: false });
stdout.on('error', () => { /* parent may already have exited; runHost also releases observers */ });
function send(value: HostOutput): Promise<void> {
  if (value.type === 'event' && value.event.type === 'runtime_events_available' && stdout.writableLength >= 262144) return Promise.resolve();
  return new Promise(resolveWritten => {
    try { stdout.write(`${JSON.stringify(value)}\n`, () => resolveWritten()); }
    catch { resolveWritten(); }
  });
}

function startupRoot(): string | null {
  const index = process.argv.indexOf('--user-data-root');
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  return value && isAbsolute(value) ? value : null;
}

function startupInvoiceSourceRoot(): string | null {
  const index = process.argv.indexOf('--invoice-source-root');
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  return value && isAbsolute(value) ? value : null;
}

const root = startupRoot();
const invoiceSourceRoot = startupInvoiceSourceRoot() ?? join(process.cwd(), 'data', 'invoices', 'agent-input');
if (!root) {
  send({ version: 1, type: 'ready', state: { version: 1, ready: false, host: 'error', appVersion: '0.0.0', userDataPath: '' } as Omit<DesktopState, 'modelCredentials'> });
  process.exitCode = 2;
} else {
  await runHost(root, invoiceSourceRoot);
}

async function runHost(userDataRoot: string, invoiceSourceRoot: string): Promise<void> {
  const pathsResult = resolveProductPaths(userDataRoot);
  if (!pathsResult.ok) {
    send({ version: 1, type: 'ready', state: { version: 1, ready: false, host: 'error', appVersion: '0.0.0', userDataPath: userDataRoot } as Omit<DesktopState, 'modelCredentials'> });
    process.exitCode = 2;
    return;
  }
  const paths = pathsResult.data;
  const settingsFile = join(paths.root, 'data', 'settings.json');
  const authFile = join(paths.runtimeDir, 'pi-desktop', 'auth.json');

  let settings = await readProductSettings(settingsFile);
  if (!settings.ok) {
    send({ version: 1, type: 'ready', state: { version: 1, ready: false, host: 'error', appVersion: '0.0.0', userDataPath: paths.root } as Omit<DesktopState, 'modelCredentials'> });
    process.exitCode = 2;
    return;
  }
  let currentSettings: ProductSettings = settings.data ?? defaultProductSettings();
  const active = new Map<string, { controller: AbortController; runId: number | null }>();
  const recentlySeen = new Set<string>();
  const seenOrder: string[] = [];
  let application: Application;
  let settingsWriteQueue = Promise.resolve();
  const enqueueSettingsWrite = <T>(action: () => Promise<T>): Promise<T> => {
    const result = settingsWriteQueue.then(action);
    settingsWriteQueue = result.then(() => undefined, () => undefined);
    return result;
  };
  const publishSettings = (saved: ProductSettings) => {
    currentSettings = saved;
    void send({ version: 1, type: 'event', event: { type: 'host_state', state: state() } });
  };
  const selectionKey = (settings: ProductSettings) => JSON.stringify({ resources: ResourceSelectionSchema.parse(settings.resources ?? EMPTY_RESOURCE_SELECTION),
    extensions: ExtensionSelectionSchema.parse(settings.extensions ?? EMPTY_EXTENSION_SELECTION) });
  const pendingCredentials = new Map<string, (value: { ok: boolean; credential?: unknown }) => void>();
  const pendingForms = new Map<string, { request: InvoiceFormBridgeRequest; resolve(receipt: InvoiceFormApplicationReceipt): void }>();
  const invoiceFormBridge = (request: InvoiceFormBridgeRequest, signal: AbortSignal): Promise<InvoiceFormApplicationReceipt> => {
    const requestId = randomUUID();
    const unknown = (): InvoiceFormApplicationReceipt => ({ runId: request.runId, toolCallId: request.toolCallId,
      formInstanceId: request.target.formInstanceId, candidateId: request.candidateId, candidateSequence: request.candidateSequence,
      observedAt: new Date().toISOString(), outcome: 'unknown' });
    if (signal.aborted) return Promise.resolve(unknown());
    return new Promise(resolve => {
      const finish = (receipt: InvoiceFormApplicationReceipt) => {
        clearTimeout(timer); pendingForms.delete(requestId); resolve(receipt);
      };
      // Core ends its local wait on cancellation. Keep this original receiver
      // within the existing deadline so a late receipt can supplement its call.
      const timer = setTimeout(() => finish(unknown()), 7500);
      pendingForms.set(requestId, { request, resolve: finish });
      send({ version: 1, type: 'invoice_form_request', requestId, request });
    });
  };
  const credentialWrites = new Map<string, Promise<unknown>>();
  const credentialRequest = (ref: string, operation: 'read' | 'write' | 'delete', credential?: Credential): Promise<Credential | undefined> => {
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { pendingCredentials.delete(requestId); reject(new Error('credential_timeout')); }, 10_000);
      pendingCredentials.set(requestId, (value) => {
        clearTimeout(timeout);
        if (!value.ok) reject(new Error('credential_unavailable'));
        else resolve(value.credential as Credential | undefined);
      });
      send({ version: 1, type: 'credential_request', requestId, credentialRef: ref, operation,
        ...(credential === undefined ? {} : { credential }) });
    });
  };
  const credentialsFor = (config: { credentialRef?: string; modelRef: { provider: string } }): CredentialStore | undefined => {
    const ref = config.credentialRef;
    if (!ref) return undefined;
    const providerId = config.modelRef.provider;
    const read = () => credentialRequest(ref, 'read');
    const serialize = <T>(operation: () => Promise<T>): Promise<T> => {
      const previous = credentialWrites.get(ref) ?? Promise.resolve();
      const current = previous.catch(() => undefined).then(operation);
      credentialWrites.set(ref, current.catch(() => undefined));
      return current;
    };
    return {
      read: async (id) => id === providerId ? read() : undefined,
      list: async () => { const credential = await read(); return credential ? [{ providerId, type: credential.type }] : []; },
      modify: (id, fn) => {
        if (id !== providerId) return Promise.reject(new Error('credential_provider_mismatch'));
        return serialize(async () => {
          const current = await read();
          const next = await fn(current);
          if (next !== undefined) await credentialRequest(ref, 'write', next);
          return next ?? current;
        });
      },
      delete: (id) => id === providerId
        ? serialize(async () => { await credentialRequest(ref, 'delete'); })
        : Promise.reject(new Error('credential_provider_mismatch')),
    };
  };
  const promptTrace = createPromptTraceBuffer();
  const created = await createApplication({
    paths,
    invoiceSourceRoot,
    provider: new PiProviderAdapter({ credentialsFor }),
    agentFactory: (tools) => new PiAgentAdapter({ credentialsFor, cwd: paths.runtimeDir, agentDir: paths.runtimeDir,
      resourceBundleRoot: join(paths.runtimeDir, 'resource-bundles'), promptTrace, tools }),
    promptTrace,
    runtimeDefaults: () => ok(currentSettings.runtime ?? {}),
    resourceDefaults: () => ok({ revision: currentSettings.revision, selection: currentSettings.resources ?? EMPTY_RESOURCE_SELECTION,
      extensions: currentSettings.extensions ?? EMPTY_EXTENSION_SELECTION }),
    saveResourceSelection: input => enqueueSettingsWrite(async () => {
      if (input.expectedRevision !== currentSettings.revision)
        return fail(appError('config_revision_conflict', 'input', 'Reload current resource selection before saving.', true));
      const valid = application.validateResourceSelection(input.selection, currentSettings.extensions);
      if (!valid.ok) return valid;
      const saved = await saveProductSettings(settingsFile, { ...currentSettings, resources: input.selection });
      if (!saved.ok) return saved;
      publishSettings(saved.data);
      return ok({ revision: saved.data.revision, selection: saved.data.resources! });
    }),
    saveExtensionSelection: input => enqueueSettingsWrite(async () => {
      if (input.expectedRevision !== currentSettings.revision)
        return fail(appError('config_revision_conflict', 'input', 'Reload current extension selection before saving.', true));
      const extensions = application.validateExtensionSelection(input.selection); if (!extensions.ok) return extensions;
      const resources = application.validateResourceSelection(currentSettings.resources ?? EMPTY_RESOURCE_SELECTION, input.selection);
      if (!resources.ok) return resources;
      const saved = await saveProductSettings(settingsFile, { ...currentSettings, extensions: input.selection });
      if (!saved.ok) return saved;
      publishSettings(saved.data);
      return ok({ revision: saved.data.revision, selection: saved.data.extensions! });
    }),
    observeCompaction: observation => {
      const value = parseCompactionNotification({ type: 'compaction_observation', observation });
      if (value) void send({ version: 1, type: 'event', event: value });
    },
    invoiceFormBridge,
  });
  if (!created.ok) {
    send({ version: 1, type: 'ready', state: { version: 1, ready: false, host: 'error', appVersion: '0.0.0', userDataPath: paths.root } as Omit<DesktopState, 'modelCredentials'> });
    process.exitCode = 2;
    return;
  }
  application = created.data;
  type RuntimeRegistration = {
    ownerToken: string; identity: string; input: import('@flowmate/contracts').RuntimeEventsSubscriptionRequest;
    closed: boolean; local?: import('@flowmate/contracts').RuntimeEventSubscription;
    timer?: ReturnType<typeof setTimeout>; pendingWake: number | null; wakeQueued: boolean;
    opened: Promise<Result<import('@flowmate/contracts').RuntimeSubscriptionInfo>>;
  };
  const runtimeRegistrations = new Map<string, RuntimeRegistration>();
  const releasedRuntimeRegistrations = new Map<string, string>();
  const runtimeQueries = new Set<string>();
  let runtimeObservationsClosing = false;
  const rememberRelease = (id: string, owner: string) => {
    releasedRuntimeRegistrations.set(id, owner);
    if (releasedRuntimeRegistrations.size > 4096) releasedRuntimeRegistrations.delete(releasedRuntimeRegistrations.keys().next().value!);
  };
  const releaseRuntimeRegistration = (id: string) => {
    const entry = runtimeRegistrations.get(id);
    if (!entry) return;
    entry.closed = true; clearTimeout(entry.timer); entry.pendingWake = null;
    runtimeRegistrations.delete(id); rememberRelease(id, entry.ownerToken);
    try { entry.local?.unsubscribe(); } catch { /* observer disposal never changes execution */ }
  };
  const renewRuntimeRegistration = (id: string, entry: RuntimeRegistration) => {
    clearTimeout(entry.timer);
    entry.timer = setTimeout(() => releaseRuntimeRegistration(id), 90_000);
    entry.timer.unref();
  };
  const closeRuntimeObservations = () => {
    runtimeObservationsClosing = true;
    for (const id of runtimeRegistrations.keys()) releaseRuntimeRegistration(id);
    releasedRuntimeRegistrations.clear();
  };
  stdout.once('error', closeRuntimeObservations);
  const runtimeReply = (command: HostCommand, value: unknown) => {
    const checked = parseRuntimeHostResult(command.type, value);
    const error = appError('host_protocol_invalid', 'runtime', 'Runtime observation response is invalid.', true);
    send({ version: 1, type: 'response', requestId: command.requestId,
      value: checked ?? (command.type === 'query_runtime_events' ? { ok: false, error, context: null } : fail(error)) });
  };
  const contextReply = (command: HostCommand, value: unknown) => {
    const checked = parseContextHostResult(command.type, value);
    return send({ version: 1, type: 'response', requestId: command.requestId,
      value: checked !== null && matchesContextResponse(command, checked) ? checked : contextHostFailure() });
  };
  const historyReply = (command: HostCommand, value: unknown) => {
    const checked = parseHistoryHostResult(command.type, value);
    return send({ version: 1, type: 'response', requestId: command.requestId,
      value: checked !== null && matchesHistoryResponse(command, checked) ? checked : historyHostFailure() });
  };
  const compactionReply = (command: HostCommand, value: unknown) => {
    const checked = parseCompactionHostResult(command.type, value);
    return send({ version: 1, type: 'response', requestId: command.requestId,
      value: checked !== null && matchesCompactionResponse(command, checked) ? checked : compactionHostFailure() });
  };
  const catalog = await createPiModelCatalog();
  const requireDesktopPiKey = async (profile: ModelProfile): Promise<Result<void>> => {
    const revision = currentSettings.revision;
    if (profile.kind === 'catalog') {
      let provider;
      try { provider = (await catalog.list(profile.providerId ?? undefined)).find((item) => item.id === profile.providerId); }
      catch { return fail(appError('provider_catalog_unavailable', 'provider', 'Pi model catalog is unavailable.', true)); }
      if (!provider?.authMethods.includes('api_key'))
        return fail(appError('model_api_key_unsupported', 'input', 'This Pi provider does not support API key access.'));
    }
    try {
      const credential = await credentialRequest(profile.credentialRef, 'read');
      if (currentSettings.revision !== revision)
        return fail(appError('state_conflict', 'input', 'Model settings changed while checking the API key. Reload before sending.', true));
      if (credential?.type === 'api_key' && typeof credential.key === 'string' && credential.key.trim()) return ok(undefined);
    } catch { return fail(appError('model_credential_unavailable', 'storage', 'The saved API key could not be read.')); }
    return fail(appError('model_credential_missing', 'input', 'Save an API key for this model in Models.'));
  };
  const logins = new Map<string, AbortController>();
  const authPrompts = new Map<string, { requestId: string; resolve(value: string): void; reject(error: Error): void }>();

  const state = (): Omit<DesktopState, 'modelCredentials'> => ({
    version: 1,
    ready: true,
    host: 'ready',
    settings: currentSettings,
    appVersion: process.env.FLOWMATE_DESKTOP_VERSION ?? '0.1.0',
    userDataPath: paths.root,
  });
  send({ version: 1, type: 'ready', state: state() });
  const claimRequestId = (requestId: string) => {
    if (recentlySeen.has(requestId)) return false;
    recentlySeen.add(requestId);
    seenOrder.push(requestId);
    if (seenOrder.length > 4096) recentlySeen.delete(seenOrder.shift()!);
    return true;
  };

  const dispatch = async (command: HostCommand): Promise<void> => {
    if (command.type === 'subscribe_runtime_events') {
      const { subscriptionId: id, ownerToken: owner, input } = command;
      const identity = JSON.stringify(input), existing = runtimeRegistrations.get(id);
      if (existing) {
        runtimeReply(command, existing.ownerToken !== owner
          ? fail(appError('event_subscription_invalid', 'input', 'Observation belongs to another owner.'))
          : existing.identity !== identity ? fail(appError('state_conflict', 'runtime', 'Observation parameters conflict.'))
            : await existing.opened);
        return;
      }
      if (runtimeObservationsClosing || releasedRuntimeRegistrations.has(id)) {
        runtimeReply(command, fail(appError('event_subscription_invalid', 'input', 'Observation has been released.'))); return;
      }
      if (runtimeRegistrations.size >= 64 || [...runtimeRegistrations.values()].filter(entry => entry.ownerToken === owner).length >= 8) {
        runtimeReply(command, fail(appError('event_subscription_limit', 'runtime', 'Observation capacity reached.'))); return;
      }
      if ([...runtimeRegistrations.values()].some(entry => entry.ownerToken === owner && entry.input.runId === input.runId && !entry.local)) {
        runtimeReply(command, fail(appError('event_subscription_invalid', 'input', 'An observation for this Run is opening.'))); return;
      }
      const entry: RuntimeRegistration = { ownerToken: owner, identity, input, closed: false, pendingWake: null,
        wakeQueued: false, opened: Promise.resolve(fail(appError('event_subscription_invalid', 'input', 'Observation is opening.'))) };
      runtimeRegistrations.set(id, entry); renewRuntimeRegistration(id, entry);
      entry.opened = Promise.resolve().then(() => application.subscribeRuntimeEvents(input, wake => {
        if (entry.closed || !RuntimeEventsAvailableSchema.safeParse(wake).success || wake.runId !== input.runId) return;
        entry.pendingWake = Math.max(entry.pendingWake ?? 0, wake.sequence);
        if (entry.wakeQueued) return;
        entry.wakeQueued = true;
        queueMicrotask(() => {
          entry.wakeQueued = false;
          const sequence = entry.pendingWake; entry.pendingWake = null;
          if (!entry.closed && sequence !== null) send({ version: 1, type: 'event',
            event: { type: 'runtime_events_available', subscriptionId: id, runId: input.runId, sequence } });
        });
      })).then(result => {
        if (!result.ok) { releaseRuntimeRegistration(id); return result; }
        if (entry.closed) { result.data.unsubscribe(); return fail(appError('event_subscription_invalid', 'input', 'Observation was released while opening.')); }
        entry.local = result.data;
        const { unsubscribe: _unsubscribe, ...context } = result.data;
        return ok({ ...context, subscriptionId: id });
      }).catch(() => { releaseRuntimeRegistration(id); return fail(appError('storage_read_failed', 'storage', 'Observation could not open.', true)); });
      runtimeReply(command, await entry.opened); return;
    }
    if (command.type === 'unsubscribe_runtime_events') {
      const existing = runtimeRegistrations.get(command.subscriptionId);
      const knownOwner = existing?.ownerToken ?? releasedRuntimeRegistrations.get(command.subscriptionId);
      if (knownOwner !== undefined && knownOwner !== command.ownerToken) {
        runtimeReply(command, fail(appError('event_subscription_invalid', 'input', 'Observation belongs to another owner.'))); return;
      }
      releaseRuntimeRegistration(command.subscriptionId);
      rememberRelease(command.subscriptionId, command.ownerToken);
      runtimeReply(command, ok(undefined)); return;
    }
    if (command.type === 'query_runtime_events') {
      const { subscriptionId: id, ...input } = command.input;
      if (id !== undefined) {
        const entry = runtimeRegistrations.get(id);
        if (!entry || entry.ownerToken !== command.ownerToken || entry.input.runId !== input.runId || entry.input.sessionId !== input.sessionId) {
          runtimeReply(command, { ok: false, error: appError('event_subscription_invalid', 'input', 'Observation identity is invalid.'), context: null }); return;
        }
        renewRuntimeRegistration(id, entry);
      }
      if (runtimeQueries.has(command.ownerToken)) {
        runtimeReply(command, { ok: false, error: appError('event_query_busy', 'runtime', 'An event query is already in flight.', true), context: null }); return;
      }
      runtimeQueries.add(command.ownerToken);
      try { runtimeReply(command, await application.queryRuntimeEvents(input)); }
      finally { runtimeQueries.delete(command.ownerToken); }
      return;
    }
    if (command.type === 'list_run_tool_calls') { runtimeReply(command, await application.listRunToolCalls(command.input)); return; }
    if (command.type === 'query_run_tool_call') { runtimeReply(command, await application.queryRunToolCall(command.input)); return; }
    if (command.type === 'list_context_snapshots') { await contextReply(command, await application.listContextSnapshots(command.input)); return; }
    if (command.type === 'query_context_snapshot') { await contextReply(command, await application.queryContextSnapshot(command.input)); return; }
    if (command.type === 'list_context_requests') { await contextReply(command, await application.listContextRequests(command.input)); return; }
    if (command.type === 'query_session_compaction') { await compactionReply(command, await application.querySessionCompaction(command.input)); return; }
    if (command.type === 'cancel_session_compaction') { await compactionReply(command, await application.cancelSessionCompaction(command.input)); return; }
    if (command.type === 'invoice_form_response') {
      const pending = pendingForms.get(command.requestId);
      if (!pending) return;
      const original = pending.request, receipt = command.receipt;
      if (receipt.runId === original.runId && receipt.toolCallId === original.toolCallId
        && receipt.formInstanceId === original.target.formInstanceId && receipt.candidateId === original.candidateId
        && receipt.candidateSequence === original.candidateSequence
        && (receipt.outcome !== 'applied' || receipt.appliedRevision === original.target.expectedRevision + 1)) pending.resolve(receipt);
      return;
    }
    if (command.type === 'save_invoice_candidate') { send({ version: 1, type: 'response', requestId: command.requestId, value: await application.saveInvoiceCandidate(command.input) }); return; }
    if (command.type === 'accept_invoice_candidate') { send({ version: 1, type: 'response', requestId: command.requestId, value: await application.acceptInvoiceCandidate(command.input) }); return; }
    if (command.type === 'reject_invoice_candidate') { send({ version: 1, type: 'response', requestId: command.requestId, value: await application.rejectInvoiceCandidate(command.input) }); return; }
    if (command.type === 'export_invoice_candidate') { send({ version: 1, type: 'response', requestId: command.requestId, value: await application.exportInvoiceCandidate(command.input) }); return; }
    if (command.type === 'query_invoice_candidate_operation') { send({ version: 1, type: 'response', requestId: command.requestId, value: await application.queryInvoiceCandidateOperation(command.input) }); return; }
    if (command.type === 'query_session_input') {
      send({ version: 1, type: 'response', requestId: command.requestId, value: await application.querySessionInput(command.input) });
      return;
    }
    if (command.type === 'list_session_inputs') {
      send({ version: 1, type: 'response', requestId: command.requestId, value: await application.listSessionInputs(command.input) });
      return;
    }
    if (command.type === 'set_session_status') {
      send({ version: 1, type: 'response', requestId: command.requestId, value: await application.setSessionStatus(command.input) });
      return;
    }
    if (command.type === 'branch_session') {
      await historyReply(command, await application.branchSession(command.input));
      return;
    }
    if (command.type === 'query_session_history') { await historyReply(command, await application.querySessionHistory(command.input)); return; }
    if (command.type === 'query_session_history_entry') { await historyReply(command, await application.querySessionHistoryEntry(command.input)); return; }
    if (command.type === 'fork_session') { await historyReply(command, await application.forkSession(command.input)); return; }
    if (command.type === 'submit_session_input' && command.input.mode !== 'prompt') {
      const accepted = await application.submitInput(command.input, { onEvent(event: AgentRunEvent) {
        send({ version: 1, type: 'event', event: { type: 'agent_run_event', requestId: command.requestId, value: event } });
      } });
      send({ version: 1, type: 'response', requestId: command.requestId,
        value: accepted.ok ? ok({ ...accepted.data, requestId: command.requestId }) : accepted });
      return;
    }
    if (command.type === 'query_invoice_form_application') {
      send({ version: 1, type: 'response', requestId: command.requestId, value: await application.queryInvoiceFormApplication(command.input) });
      return;
    }
    if (command.type === 'credential_response') {
      pendingCredentials.get(command.requestId)?.(command.value);
      pendingCredentials.delete(command.requestId);
      return;
    }
    if (command.type === 'get_state') {
      send({ version: 1, type: 'response', requestId: command.requestId, value: ok(state()) });
      return;
    }
    if (command.type === 'list_model_catalog') {
      try { send({ version: 1, type: 'response', requestId: command.requestId,
        value: ok(await catalog.list(command.providerId, command.refresh)) }); }
      catch { send({ version: 1, type: 'response', requestId: command.requestId,
        value: fail(appError('provider_catalog_unavailable', 'provider', 'Pi model catalog is unavailable.', true)) }); }
      return;
    }
    if (command.type === 'auth_reply') {
      const prompt = authPrompts.get(command.promptId);
      if (!prompt || prompt.requestId !== command.loginRequestId) {
        send({ version: 1, type: 'response', requestId: command.requestId,
          value: fail(appError('auth_prompt_missing', 'input', 'The login prompt is no longer active.')) });
        return;
      }
      authPrompts.delete(command.promptId);
      if (command.value === null) prompt.reject(new Error('auth_cancelled'));
      else prompt.resolve(command.value);
      send({ version: 1, type: 'response', requestId: command.requestId, value: ok(undefined) });
      return;
    }
    if (command.type === 'cancel_login') {
      logins.get(command.loginRequestId)?.abort();
      send({ version: 1, type: 'response', requestId: command.requestId, value: ok(undefined) });
      return;
    }
    if (command.type === 'login_model') {
      if (logins.size > 0 || !claimRequestId(command.requestId)) {
        send({ version: 1, type: 'response', requestId: command.requestId,
          value: fail(appError('auth_login_busy', 'input', 'Another model login is already active.')) });
        return;
      }
      const profile = currentSettings.models.find((model) => model.id === command.modelId);
      if (!profile || profile.kind !== 'catalog' || !profile.providerId) {
        send({ version: 1, type: 'response', requestId: command.requestId,
          value: fail(appError('model_not_configured', 'input', 'Choose and save a Pi provider model first.')) });
        return;
      }
      const credentials = credentialsFor({ credentialRef: profile.credentialRef, modelRef: { provider: profile.providerId } })!;
      const controller = new AbortController();
      logins.set(command.requestId, controller);
      const timer = setTimeout(() => controller.abort(), 180_000);
      try {
        await loginPiProvider(profile.providerId, command.authType, credentials, {
          signal: controller.signal,
          notify: (notice) => send({ version: 1, type: 'event', event: {
            type: 'model_auth_notice', requestId: command.requestId, notice,
          } }),
          prompt: (prompt) => {
            const promptId = randomUUID();
            return new Promise<string>((resolve, reject) => {
              const abort = () => { authPrompts.delete(promptId); reject(new Error('auth_cancelled')); };
              if (controller.signal.aborted || prompt.signal?.aborted) { abort(); return; }
              authPrompts.set(promptId, { requestId: command.requestId, resolve, reject });
              controller.signal.addEventListener('abort', abort, { once: true });
              prompt.signal?.addEventListener('abort', abort, { once: true });
              const { signal: _signal, ...visiblePrompt } = prompt;
              send({ version: 1, type: 'event', event: {
                type: 'model_auth_prompt', requestId: command.requestId, promptId, prompt: visiblePrompt,
              } });
            });
          },
        });
        send({ version: 1, type: 'response', requestId: command.requestId, value: ok({ configured: true }) });
      } catch {
        send({ version: 1, type: 'response', requestId: command.requestId,
          value: fail(appError(controller.signal.aborted ? 'auth_cancelled' : 'auth_login_failed', 'provider',
            controller.signal.aborted ? 'Model login was cancelled or timed out.' : 'Pi provider login failed.', true)) });
      } finally {
        clearTimeout(timer);
        logins.delete(command.requestId);
        for (const [id, prompt] of authPrompts) if (prompt.requestId === command.requestId) authPrompts.delete(id);
      }
      return;
    }
    if (command.type === 'logout_model') {
      if (logins.size > 0) {
        send({ version: 1, type: 'response', requestId: command.requestId,
          value: fail(appError('auth_login_busy', 'input', 'Finish the active model login first.')) });
        return;
      }
      const profile = currentSettings.models.find((model) => model.id === command.modelId);
      if (!profile || profile.kind !== 'catalog' || !profile.providerId) {
        send({ version: 1, type: 'response', requestId: command.requestId,
          value: fail(appError('model_not_configured', 'input', 'The Pi provider model is unavailable.')) });
        return;
      }
      try {
        await logoutPiProvider(profile.providerId, credentialsFor({ credentialRef: profile.credentialRef,
          modelRef: { provider: profile.providerId } })!);
        send({ version: 1, type: 'response', requestId: command.requestId, value: ok(undefined) });
      } catch {
        send({ version: 1, type: 'response', requestId: command.requestId,
          value: fail(appError('auth_logout_failed', 'provider', 'Pi provider logout failed.', true)) });
      }
      return;
    }
    if (command.type === 'save_settings') {
      const saved = await enqueueSettingsWrite(async () => {
        const validated = validateProductSettings(command.settings);
        if (!validated.ok) return validated;
        if (validated.data.revision !== currentSettings.revision)
          return fail(appError('config_revision_conflict', 'input', 'Reload current configuration before saving.', true));
        if (selectionKey(validated.data) !== selectionKey(currentSettings)) {
          const extensions = application.validateExtensionSelection(validated.data.extensions!);
          if (!extensions.ok) return extensions;
          const resources = application.validateResourceSelection(validated.data.resources!, validated.data.extensions);
          if (!resources.ok) return resources;
        }
        const written = await saveProductSettings(settingsFile, validated.data);
        if (written.ok) publishSettings(written.data);
        return written;
      });
      send({ version: 1, type: 'response', requestId: command.requestId, value: saved });
      return;
    }
    if (isExtensionHostCommand(command.type)) {
      const value = command.type === 'list_extensions' ? await application.listExtensions()
        : command.type === 'update_extension_selection' ? await application.updateExtensionSelection(command.input)
        : command.type === 'query_session_extensions' ? await application.querySessionExtensions(command.input)
        : command.type === 'query_run_extensions' ? await application.queryRunExtensions(command.input)
        : command.type === 'execute_extension_command' ? await application.executeExtensionCommand(command.input)
        : command.type === 'dispose_session_extensions' ? await application.disposeSessionExtensions(command.input) : null;
      const result = parseExtensionHostResult(command.type, value);
      send({ version: 1, type: 'response', requestId: command.requestId, value: result && matchesExtensionResponse(command, result) ? result
        : fail(appError('host_protocol_invalid', 'runtime', 'Extension response could not be verified.')) }); return;
    }
    if (isResourceHostCommand(command.type)) {
      const value = command.type === 'list_resources' ? await application.listResources()
        : command.type === 'read_resource_file' ? await application.readResourceFile(command.input)
        : command.type === 'update_resource_selection' ? await application.updateResourceSelection(command.input)
        : command.type === 'query_run_resources' ? await application.queryRunResources(command.input)
        : command.type === 'read_run_resource_file' ? await application.readRunResourceFile(command.input) : null;
      const result = parseResourceHostResult(command.type, value);
      send({ version: 1, type: 'response', requestId: command.requestId, value: result && matchesResourceResponse(command, result) ? result
        : fail(appError('host_protocol_invalid', 'runtime', 'Resource response could not be verified.')) }); return;
    }
    if (command.type === 'query_run') {
      send({ version: 1, type: 'response', requestId: command.requestId, value: await application.queryRun(command.runId) });
      return;
    }
    if (command.type === 'read_workspace') {
      send({ version: 1, type: 'response', requestId: command.requestId, value: await application.readWorkspace() });
      return;
    }
    if (command.type === 'restore_workspace') {
      send({ version: 1, type: 'response', requestId: command.requestId, value: await application.restoreWorkspace() });
      return;
    }
    if (command.type === 'update_workspace') {
      send({ version: 1, type: 'response', requestId: command.requestId, value: await application.updateWorkspace(command.input) });
      return;
    }
    if (command.type === 'start_task') {
      send({ version: 1, type: 'response', requestId: command.requestId, value: await application.startTask(command.input) });
      return;
    }
    if (command.type === 'query_task_operation') {
      send({ version: 1, type: 'response', requestId: command.requestId, value: await application.queryTaskOperation(command.clientSequence) });
      return;
    }
    if (command.type === 'select_candidate') {
      send({ version: 1, type: 'response', requestId: command.requestId, value: await application.selectCandidate(command.input) });
      return;
    }
    if (command.type === 'list_documents') {
      send({ version: 1, type: 'response', requestId: command.requestId, value: await application.listDocuments(command.input) });
      return;
    }
    if (command.type === 'query_document') {
      send({ version: 1, type: 'response', requestId: command.requestId, value: await application.queryDocument(command.documentId) });
      return;
    }
    if (command.type === 'hide_document') {
      send({ version: 1, type: 'response', requestId: command.requestId, value: await application.hideDocument(command.documentId) });
      return;
    }
    if (command.type === 'list_jobs') {
      send({ version: 1, type: 'response', requestId: command.requestId, value: await application.listJobs(command.input) });
      return;
    }
    if (command.type === 'query_job') {
      send({ version: 1, type: 'response', requestId: command.requestId, value: await application.queryJob(command.jobId) });
      return;
    }
    if (command.type === 'hide_job') {
      send({ version: 1, type: 'response', requestId: command.requestId, value: await application.hideJob(command.jobId) });
      return;
    }
    if (command.type === 'list_job_candidates') {
      send({ version: 1, type: 'response', requestId: command.requestId,
        value: await application.listJobCandidates({ ...command.input, beforeSequence: command.input.beforeSequence ?? undefined }) });
      return;
    }
    if (command.type === 'query_job_candidate') {
      send({ version: 1, type: 'response', requestId: command.requestId, value: await application.queryJobCandidate(command.input) });
      return;
    }
    if (command.type === 'list_activity') {
      send({ version: 1, type: 'response', requestId: command.requestId, value: await application.listActivity(command.input) });
      return;
    }
    if (command.type === 'import_invoice_material') {
      send({ version: 1, type: 'response', requestId: command.requestId,
        value: await application.importInvoiceMaterial(command.sourceDirectory) });
      return;
    }
    if (command.type === 'list_document_pages') {
      send({ version: 1, type: 'response', requestId: command.requestId, value: await application.listDocumentPages(command.input) });
      return;
    }
    if (command.type === 'read_document_page') {
      send({ version: 1, type: 'response', requestId: command.requestId, value: await application.readDocumentPage(command.input) });
      return;
    }
    if (command.type === 'read_document_original') {
      send({ version: 1, type: 'response', requestId: command.requestId,
        value: await application.readDocumentOriginal(command.documentId, command.page) });
      return;
    }
    if (command.type === 'revoke_document_use') {
      send({ version: 1, type: 'response', requestId: command.requestId,
        value: await application.revokeDocumentUse(command.documentId) });
      return;
    }
    if (command.type === 'create_session') {
      if (!claimRequestId(command.requestId)) {
        send({ version: 1, type: 'response', requestId: command.requestId, value: fail(appError('request_duplicate', 'input', '该请求身份已使用，未重复执行。')) });
        return;
      }
      send({ version: 1, type: 'response', requestId: command.requestId, value: await application.createSession(command.input) });
      return;
    }
    if (command.type === 'query_native_tools') {
      send({ version: 1, type: 'response', requestId: command.requestId, value: await application.queryNativeTools() });
      return;
    }
    if (command.type === 'rename_session') {
      if (!claimRequestId(command.requestId)) {
        send({ version: 1, type: 'response', requestId: command.requestId, value: fail(appError('request_duplicate', 'input', '该请求身份已使用，未重复执行。')) });
        return;
      }
      send({ version: 1, type: 'response', requestId: command.requestId, value: await application.renameSession(command.input) });
      return;
    }
    if (command.type === 'delete_session') {
      if (!claimRequestId(command.requestId)) {
        send({ version: 1, type: 'response', requestId: command.requestId, value: fail(appError('request_duplicate', 'input', '该请求身份已使用，未重复执行。')) });
        return;
      }
      send({ version: 1, type: 'response', requestId: command.requestId, value: await application.deleteSession(command.sessionId) });
      return;
    }
    if (command.type === 'list_sessions') {
      send({ version: 1, type: 'response', requestId: command.requestId, value: await application.listSessions(command.input) });
      return;
    }
    if (command.type === 'query_session') {
      send({ version: 1, type: 'response', requestId: command.requestId, value: await application.querySession(command.sessionId) });
      return;
    }
    if (command.type === 'list_session_runs') {
      send({ version: 1, type: 'response', requestId: command.requestId, value: await application.listSessionRuns(command.input) });
      return;
    }
    if (command.type === 'list_session_messages') {
      send({ version: 1, type: 'response', requestId: command.requestId, value: await application.listSessionMessages(command.input) });
      return;
    }
    if (command.type === 'query_prompt_trace') {
      send({ version: 1, type: 'response', requestId: command.requestId, value: await application.queryPromptTrace(command.runId, command.callSequence) });
      return;
    }
    if (command.type === 'cancel_run') {
      send({ version: 1, type: 'response', requestId: command.requestId, value: await application.cancelRun(command.runId) });
      return;
    }
    if (command.type === 'query_runtime_state') {
      send({ version: 1, type: 'response', requestId: command.requestId, value: await application.queryRuntimeState() });
      return;
    }
    if (command.type === 'cancel_provider') {
      const target = active.get(command.targetRequestId);
      if (target && !target.controller.signal.aborted) target.controller.abort();
      send({ version: 1, type: 'response', requestId: command.requestId, value: ok({ accepted: Boolean(target), runId: target?.runId ?? null }) });
      return;
    }
    if (command.type === 'close') {
      closeRuntimeObservations();
      const report = await application.close();
      await send({ version: 1, type: 'response', requestId: command.requestId, value: report });
      if (report.ok && report.data.closed) {
        await send({ version: 1, type: 'event', event: { type: 'host_state', state: { ...state(), ready: false, host: 'closing' } } });
        setTimeout(() => process.exit(0), 30);
      }
      return;
    }
    if (command.type === 'start_run' || command.type === 'submit_invoice_form_input' || command.type === 'submit_session_input' || command.type === 'compact_session') {
      if (!claimRequestId(command.requestId)) {
        send({ version: 1, type: 'response', requestId: command.requestId, value: fail(appError('request_duplicate', 'input', '该请求身份已使用，未重复执行。')) });
        return;
      }
      if (!('modelId' in command.input)) return;
      const input = command.input;
      let desktopRequestHash: string | undefined;
      if (command.type === 'submit_session_input' && command.input.mode === 'prompt') {
        desktopRequestHash = createHash('sha256').update(serializeDesktopPromptRequest(command.input, 1)).digest('hex');
      }
      if (command.type === 'submit_invoice_form_input') {
        desktopRequestHash = createHash('sha256').update(serializeDesktopInvoiceFormRequest(command.input)).digest('hex');
        const original = await application.querySessionInput({ sessionId: command.input.workspace.sessionId, clientSequence: command.input.clientSequence });
        if (!original.ok) { send({ version: 1, type: 'response', requestId: command.requestId, value: original }); return; }
        if (original.data.input) {
          const prior = original.data.input;
          const value = prior.mode === 'prompt' && prior.goalMode === 'fill-form' && prior.content.version === 2
            && prior.content.desktopRequestHash === desktopRequestHash && prior.runId !== null
            ? ok({ inputId: prior.inputId, sessionId: prior.sessionId, runId: prior.runId, requestId: command.requestId })
            : fail(appError('state_conflict', 'input', 'This client sequence belongs to another Fill request.'));
          send({ version: 1, type: 'response', requestId: command.requestId, value }); return;
        }
      }
      if (desktopRequestHash !== undefined && command.type === 'submit_session_input') {
        const original = await application.querySessionInput({ sessionId: command.input.sessionId, clientSequence: command.input.clientSequence });
        if (!original.ok) { send({ version: 1, type: 'response', requestId: command.requestId, value: original }); return; }
        if (original.data.input) {
          const prior = original.data.input;
          if (prior.content.version === 2 && command.input.mode === 'prompt') desktopRequestHash = createHash('sha256')
            .update(serializeDesktopPromptRequest(command.input, prior.content.requestIdentityVersion)).digest('hex');
          const value = prior.content.version === 2 && prior.content.desktopRequestHash === desktopRequestHash
            ? prior.runId === null ? fail(appError('operation_result_unknown', 'session', 'The original Run cannot be confirmed.'))
              : ok({ inputId: prior.inputId, sessionId: prior.sessionId, runId: prior.runId, requestId: command.requestId })
            : fail(appError('state_conflict', 'input', 'This client sequence belongs to another input. Query the original input.'));
          send({ version: 1, type: 'response', requestId: command.requestId, value }); return;
        }
      }
      const profile = currentSettings.models.find((model) => model.id === input.modelId);
      if (command.expectedSettingsRevision !== undefined && (currentSettings.revision !== command.expectedSettingsRevision
        || profile && profile.credentialRef !== command.expectedCredentialRef)) {
        send({ version: 1, type: 'response', requestId: command.requestId, value: fail(appError('state_conflict', 'input', '模型配置已变化，请重新加载后再发送。', true)) });
        return;
      }
      if (!profile) {
        send({ version: 1, type: 'response', requestId: command.requestId, value: fail(appError('model_not_configured', 'input', '所选模型配置不存在。')) });
        return;
      }
      if (command.type === 'submit_session_input' && (command.expectedSettingsRevision === undefined || command.expectedCredentialRef === undefined)) {
        send({ version: 1, type: 'response', requestId: command.requestId,
          value: fail(appError('state_conflict', 'input', 'Model preparation is missing. Reload the model before submitting a new input.', true)) });
        return;
      }
      if (profile.kind === 'legacy') {
        send({ version: 1, type: 'response', requestId: command.requestId,
          value: fail(appError('model_reconfiguration_required', 'input', 'Choose this model again from the Pi catalog or configure it as custom.')) });
        return;
      }
      const key = await requireDesktopPiKey(profile);
      if (!key.ok) { send({ version: 1, type: 'response', requestId: command.requestId, value: key }); return; }
      const providerId = profile.kind === 'catalog' ? profile.providerId! : `flowmate-profile-${profile.id}`;
      const config = {
        version: 1 as const,
        name: `desktop-${profile.name}`,
        revision: Math.max(1, currentSettings.revision),
        modelRef: { provider: providerId, model: profile.model },
        credentialRef: profile.credentialRef,
        native: { authPath: authFile, modelsPath: null },
        ...(profile.kind === 'custom' ? { connection: { baseUrl: profile.baseUrl, api: profile.api,
          contextWindow: profile.contextWindow!, maxTokens: profile.maxTokens!, reasoning: profile.reasoning } } : {}),
        parameters: { ...RUNTIME_CONFIG.provider },
      };
      if (command.type === 'compact_session') {
        const { modelId: _modelId, ...request } = command.input;
        await compactionReply(command, await application.compactSession({ ...request, config }));
        return;
      }
      const normalized = command.type === 'start_run' ? normalizeAgentRunRequest({
        sessionId: command.input.sessionId,
        text: command.input.text,
        ...(command.input.requiredSkill === undefined ? {} : { requiredSkill: command.input.requiredSkill }),
        config,
        ...(command.input.workspace === undefined ? {} : { workspace: command.input.workspace }),
        ...(command.input.workingDirectory === undefined ? {} : { workingDirectory: command.input.workingDirectory }),
        goalMode: command.input.goalMode,
        ...(command.input.budget === undefined ? {} : { budget: command.input.budget }),
        ...(command.input.timeoutMs === undefined ? {} : { timeoutMs: command.input.timeoutMs }),
        ...(command.input.stopGraceMs === undefined ? {} : { stopGraceMs: command.input.stopGraceMs }),
      }) : null;
      if (normalized && !normalized.ok) {
        send({ version: 1, type: 'response', requestId: command.requestId, value: normalized });
        return;
      }
      let accepted;
      try {
        const control = { ...(desktopRequestHash === undefined ? {} : { desktopRequestHash }), onEvent(event: AgentRunEvent) {
          send({ version: 1, type: 'event', event: { type: 'agent_run_event', requestId: command.requestId, value: event } });
        } };
        if (command.type === 'submit_invoice_form_input') accepted = await application.submitInput({
          sessionId: command.input.workspace.sessionId, clientSequence: command.input.clientSequence, mode: 'prompt', goalMode: 'fill-form',
          text: '将当前已选候选录入发票表单，保留供人工检查。', config,
          ...(command.input.requiredSkill === undefined ? {} : { requiredSkill: command.input.requiredSkill }),
          workspace: command.input.workspace, formTarget: command.input.target,
          ...(command.input.budget === undefined ? {} : { budget: command.input.budget }),
          ...(command.input.timeoutMs === undefined ? {} : { timeoutMs: command.input.timeoutMs }),
          ...(command.input.stopGraceMs === undefined ? {} : { stopGraceMs: command.input.stopGraceMs }),
        }, control);
        else if (command.type === 'submit_session_input' && command.input.mode === 'prompt') {
          const { modelId: _modelId, ...request } = command.input;
          accepted = await application.submitInput({ ...request, config }, control);
        }
        else if (normalized?.ok) accepted = await application.startRun(normalized.data, control);
        else throw new Error('invalid_request');
      } catch {
        send({ version: 1, type: 'response', requestId: command.requestId, value: fail(appError('host_command_failed', 'runtime', 'Agent Run 未能提交。', true)) });
        return;
      }
      if (!accepted.ok) {
        send({ version: 1, type: 'response', requestId: command.requestId, value: accepted });
        return;
      }
      send({ version: 1, type: 'response', requestId: command.requestId, value: ok({ ...accepted.data, requestId: command.requestId }) });
      return;
    }
    if (command.type === 'call_provider') {
      if (!claimRequestId(command.requestId)) {
        send({ version: 1, type: 'response', requestId: command.requestId, value: fail(appError('request_duplicate', 'input', '该请求身份已使用，未重复执行。')) });
        return;
      }
      const profile = currentSettings.models.find((model) => model.id === command.input.modelId);
      if (!profile) {
        send({ version: 1, type: 'response', requestId: command.requestId, value: fail(appError('model_not_configured', 'input', '所选模型配置不存在。')) });
        return;
      }
      if (profile.kind === 'legacy') {
        send({ version: 1, type: 'response', requestId: command.requestId,
          value: fail(appError('model_reconfiguration_required', 'input', 'Choose this model again from the Pi catalog or configure it as custom.')) });
        return;
      }
      const key = await requireDesktopPiKey(profile);
      if (!key.ok) { send({ version: 1, type: 'response', requestId: command.requestId, value: key }); return; }
      const providerId = profile.kind === 'catalog' ? profile.providerId! : `flowmate-profile-${profile.id}`;
      const config = {
        version: 1 as const,
        name: `desktop-${profile.name}`,
        revision: Math.max(1, currentSettings.revision),
        modelRef: { provider: providerId, model: profile.model },
        credentialRef: profile.credentialRef,
        native: { authPath: authFile, modelsPath: null },
        ...(profile.kind === 'custom' ? { connection: { baseUrl: profile.baseUrl, api: profile.api,
          contextWindow: profile.contextWindow!, maxTokens: profile.maxTokens!, reasoning: profile.reasoning } } : {}),
        parameters: {
          ...RUNTIME_CONFIG.provider,
        },
      };
      const normalized = normalizeProviderRequest({
        goal: command.input.goal,
        text: command.input.text,
        config,
        ...(command.input.timeoutMs === undefined ? {} : { timeoutMs: command.input.timeoutMs }),
      });
      if (!normalized.ok) {
        send({ version: 1, type: 'response', requestId: command.requestId, value: normalized });
        return;
      }
      const controller = new AbortController();
      const current = { controller, runId: null as number | null };
      active.set(command.requestId, current);
      let accepted = false;
      const result = await application.callProvider(normalized.data, {
        signal: controller.signal,
        onObservation(event) {
          if (event.type === 'run_created') {
            current.runId = event.runId;
            accepted = true;
            send({ version: 1, type: 'response', requestId: command.requestId, value: ok({ accepted: true, requestId: command.requestId, runId: event.runId }) });
          }
          send({ version: 1, type: 'event', event: {
            type: 'provider_observation', requestId: command.requestId, runId: event.runId,
            sequence: event.sequence, observation: event.type, at: event.at, data: event.data,
          } });
        },
      });
      active.delete(command.requestId);
      if (accepted && current.runId !== null) {
        send({ version: 1, type: 'event', event: { type: 'provider_finished', requestId: command.requestId, runId: current.runId, result } });
      } else if (!accepted) {
        send({ version: 1, type: 'response', requestId: command.requestId, value: result });
      }
      return;
    }
  };

  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  input.on('line', (line) => {
    if (Buffer.byteLength(line, 'utf8') > 1_100_000) return;
    let raw: unknown;
    try { raw = JSON.parse(line) as unknown; } catch { return; }
    const command = parseHostCommand(raw);
    if (!command) return;
    void dispatch(command).catch(() => {
      const error = appError('host_command_failed', 'runtime', 'Host 命令处理失败。', true);
      if (isRuntimeHostCommand(command.type)) runtimeReply(command, command.type === 'query_runtime_events'
        ? { ok: false, error, context: null } : fail(error));
      else if (isContextHostCommand(command.type)) void contextReply(command, contextHostFailure());
      else if (isHistoryHostCommand(command.type)) void historyReply(command, historyHostFailure());
      else send({ version: 1, type: 'response', requestId: command.requestId, value: fail(error) });
    });
  });
  input.on('close', () => {
    closeRuntimeObservations();
    let retry: ReturnType<typeof setInterval> | undefined;
    const closeEventually = async () => {
      const report = await application.close();
      if (report.ok && report.data.closed) {
        if (retry) clearInterval(retry);
        process.exit(0);
      }
    };
    void closeEventually();
    retry = setInterval(() => { void closeEventually(); }, 500);
    retry.unref();
  });
}
