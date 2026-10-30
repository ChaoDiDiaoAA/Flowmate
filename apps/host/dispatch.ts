import { isInputDefinitionHostCommand, parseInputDefinitionHostResult, matchesInputDefinitionResponse, inputDefinitionHostFailure } from './protocol.ts';
import { isResearchHostCommand, parseResearchCommand, parseResearchHostResult, matchesResearchResponse, researchOperations } from '../../packages/contracts/src/research-commands.ts';
import { randomUUID } from 'node:crypto';
import type { EvaluationAgentOverrides } from '../../packages/contracts/src/runtime-evaluation.ts';
import { readObservabilitySettings } from '../../agent-eval/src/observability-settings.ts';
import { controlledReplayTools } from '../../agent-eval/src/adapters/replay-policy.ts';
import { dirname, join, resolve } from 'node:path';
import type { Credential, CredentialStore } from '@earendil-works/pi-ai';
import { RUNTIME_CONFIG, appError, fail, normalizeAgentRunRequest, normalizeProviderRequest, ok, serializeDesktopPromptRequest, serializeDesktopInvoiceFormRequest,
  RuntimeEventsAvailableSchema, EMPTY_RESOURCE_SELECTION, ResourceSelectionSchema, EMPTY_EXTENSION_SELECTION, ExtensionSelectionSchema,
  } from '@flowmate/contracts';
import type { AgentRunEvent, Application, CloseReport, DesktopState, InvoiceFormApplicationReceipt, InvoiceFormBridgeRequest, ModelProfile, ProductSettings, ProviderConfig, Result } from '@flowmate/contracts';
import { defaultProductSettings, readProductSettings, saveProductSettings, validateProductSettings } from '@flowmate/core';
import { createPromptTraceBuffer, createRuntimeLogBuffer } from '@flowmate/logging';
import { HostDiagnosticCodeSchema, HostDiagnosticsSchema } from '@flowmate/contracts';
import { PI_SDK_VERSION } from '@flowmate/runtime-pi';
import { PiAgentAdapter, PiProviderAdapter, createPiModelCatalog, loginPiProvider, logoutPiProvider } from '@flowmate/runtime-pi';
import { resolveProductPaths, resolveRuntimeLayout } from '@flowmate/shared';
import { createApplication } from '../composition.ts';
import type { PersonalAgentRuntime } from '../personal-agent.ts';
import { isPersonalAgentHostCommand, parsePersonalAgentCommand, parsePersonalAgentHostResult,
  matchesPersonalAgentResponse, personalAgentHostFailure } from './protocol.ts';
import { isExtensionHostCommand, parseExtensionHostResult, matchesExtensionResponse, isResourceHostCommand, parseResourceHostResult, matchesResourceResponse } from './protocol.ts';
import { isSubagentHostCommand, parseSubagentHostResult, matchesSubagentResponse } from './protocol.ts';
import { parseCompactionHostResult, matchesCompactionResponse, compactionHostFailure, parseCompactionNotification } from './protocol.ts';
import { parseHostCommand, parseRuntimeHostResult, isRuntimeHostCommand, isContextHostCommand,
  parseContextHostResult, matchesContextResponse, contextHostFailure,
  isHistoryHostCommand, parseHistoryHostResult, matchesHistoryResponse, historyHostFailure } from './protocol.ts';
import type { HostCommand, HostOutput } from './protocol.ts';
import type { ForegroundReference } from '../service/protocol.ts';
import type { ServiceCredentialSettingsAuthority, ServiceCredentialSettingsScope } from '../../packages/core/src/configuration/service-credentials.ts';

export type ProductCommandDispatcherOptions = {
  userDataRoot: string;
  invoiceSourceRoot: string;
  runtimeRoot?: string;
  evaluationOverrides?: EvaluationAgentOverrides;
  evaluationWorkspaceRoot?: string;
  evaluationTrialRoot?: string;
  extensionEvaluationProfile?: import('@flowmate/contracts').ExtensionEvaluationProfile;
  caseEvaluationFaultProfile?: import('@flowmate/contracts').CaseEvaluationFaultProfile;
  send(output: HostOutput): Promise<void>;
  credentials?: {
    read(reference: string): Promise<Credential | undefined>;
    write(reference: string, credential: Credential): Promise<void>;
    delete(reference: string): Promise<void>;
  };
};
export type ProductCommandDispatcher = {
  dispatch(raw: unknown, control?: { signal?: AbortSignal }): Promise<void>;
  readForegroundStop(reference: ForegroundReference): Promise<Result<boolean>>;
  settingsAuthority: ProductSettingsAuthority;
  startRecovery(expectedSettingsRevision?: number): Promise<Result<void>>;
  close(): Promise<Result<CloseReport>>;
  // Owner-wide teardown for stdio failure or owner shutdown, never a service client disconnect.
  releaseRuntimeObservations(): void;
};
export type ProductSettingsWriteScope = ServiceCredentialSettingsScope;
export type ProductSettingsAuthority = ServiceCredentialSettingsAuthority;

// Saved receipts and evidence remain readable while the owner is still draining.
const closingReads: readonly HostCommand['type'][] = [
  'get_state', 'query_diagnostics', 'query_runtime_state', 'query_runtime_events',
  'list_run_tool_calls', 'query_run_tool_call', 'query_run_tool_evidence',
  'list_context_snapshots', 'query_context_snapshot', 'list_context_requests',
  'query_session_compaction', 'query_session_history', 'query_session_history_entry',
  'query_session_input', 'list_session_inputs', 'query_invoice_form_application',
  'read_invoice_export', 'query_invoice_candidate_operation',
  'list_input_commands', 'list_subagent_definitions', 'get_subagent_definition',
  'list_subagents', 'query_subagent', 'list_extensions', 'query_session_extensions', 'query_run_extensions',
  'list_resources', 'read_resource_file', 'query_run_resources', 'read_run_resource_file',
  'list_research_materials', 'list_research_tasks', 'query_research_task', 'query_research_for_session',
  'query_research_plan', 'query_research_source', 'query_research_evidence', 'query_research_claim',
  'query_research_report', 'list_research_sources', 'list_research_claims', 'list_research_reports',
  'query_run', 'read_workspace', 'query_task_operation', 'list_documents', 'query_document',
  'list_jobs', 'query_job', 'list_job_candidates', 'query_job_candidate', 'list_activity',
  'read_document_page', 'list_document_pages', 'read_document_original', 'query_native_tools',
  'list_sessions', 'query_session', 'list_session_runs', 'list_session_messages', 'query_prompt_trace',
  'personal_agent_get', 'personal_agent_open_conversation', 'invoice_work_list', 'invoice_work_get',
  'invoice_work_query_operation', 'personal_task_list', 'personal_task_get',
  'personal_task_history', 'personal_task_history_entry', 'invoice_work_timeline',
];

/** One product owner and command implementation, independent of transport and process exit. */
export async function createProductCommandDispatcher(options: ProductCommandDispatcherOptions): Promise<Result<ProductCommandDispatcher>> {
  const { userDataRoot, invoiceSourceRoot, extensionEvaluationProfile, caseEvaluationFaultProfile, runtimeRoot, evaluationOverrides, evaluationWorkspaceRoot, evaluationTrialRoot, send } = options;
  const pathsResult = resolveProductPaths(userDataRoot);
  if (!pathsResult.ok) {
    send({ version: 1, type: 'ready', state: { version: 1, ready: false, host: 'error', appVersion: '0.0.0', userDataPath: userDataRoot } as Omit<DesktopState, 'modelCredentials'> });
    return pathsResult;
  }
  const paths = pathsResult.data;
  const installed = runtimeRoot ? resolveRuntimeLayout({ isPackaged: true, appPath: join(dirname(runtimeRoot), 'app.asar'),
    resourcesPath: dirname(runtimeRoot), userDataRoot: paths.root }) : null;
  const layout = installed?.ok ? installed.data : null;
  if (installed && (!installed.ok || !layout?.release || resolve(runtimeRoot!) !== layout.runtimeRoot
    || process.env.PI_PACKAGE_DIR !== layout.sdkRoot || process.env.PI_CODING_AGENT_DIR !== paths.runtimeDir)) {
    process.stderr.write(`[Flowmate] ${installed.ok ? 'installation_runtime_invalid' : installed.error.code}\n`);
    await send({ version: 1, type: 'ready', state: { version: 1, ready: false, host: 'error', appVersion: '0.0.0',
      userDataPath: paths.root } as Omit<DesktopState, 'modelCredentials'> });
    return installed.ok ? fail(appError('installation_runtime_invalid', 'runtime', 'Installed runtime layout or version is invalid.')) : installed;
  }
  const settingsFile = join(paths.root, 'data', 'settings.json');
  const authFile = join(paths.runtimeDir, 'pi-desktop', 'auth.json');

  let currentSettings: ProductSettings = defaultProductSettings();
  const active = new Map<string, { controller: AbortController; runId: number | null }>();
  const recentlySeen = new Set<string>();
  const seenOrder: string[] = [];
  let application: Application;
  let personalControl: Pick<PersonalAgentRuntime, 'start' | 'conditionsChanged'> | undefined;
  let credentialRecoveryHook: ((scope: ProductSettingsWriteScope) => Promise<Result<void>>) | undefined;
  let settingsWriteQueue = Promise.resolve();
  const enqueueSettingsWrite = <T>(action: () => Promise<Result<T>>): Promise<Result<T>> => {
    const result = settingsWriteQueue.then(async () => {
      if (closing) return fail(appError('host_closing', 'runtime', 'The product owner is closing.', true));
      const recovered = await credentialRecoveryHook?.(settingsScope);
      if (recovered && !recovered.ok) return recovered;
      return action();
    });
    settingsWriteQueue = result.then(() => undefined, () => undefined);
    return result;
  };
  const publishSettings = (saved: ProductSettings, notifyConditionsChanged = true) => {
    currentSettings = saved;
    if (notifyConditionsChanged) personalControl?.conditionsChanged();
    void send({ version: 1, type: 'event', event: { type: 'host_state', state: state() } });
  };
  const selectionKey = (settings: ProductSettings) => JSON.stringify({ resources: ResourceSelectionSchema.parse(settings.resources ?? EMPTY_RESOURCE_SELECTION),
    extensions: ExtensionSelectionSchema.parse(settings.extensions ?? EMPTY_EXTENSION_SELECTION) });
  const saveUnderAuthority = async (raw: unknown, options: { notifyConditionsChanged?: boolean } = {}): Promise<Result<ProductSettings>> => {
    if (closing) return fail(appError('host_closing', 'runtime', 'The product owner is closing.', true));
    const validated = validateProductSettings(raw);
    if (!validated.ok) return validated;
    if (validated.data.revision !== currentSettings.revision)
      return fail(appError('config_revision_conflict', 'input', 'Reload current configuration before saving.', true));
    if (selectionKey(validated.data) !== selectionKey(currentSettings)) {
      const extensions = application.validateExtensionSelection(validated.data.extensions!);
      if (!extensions.ok) return extensions;
      const resources = await application.validateResourceSelection(validated.data.resources!, validated.data.extensions);
      if (!resources.ok) return resources;
    }
    const written = await saveProductSettings(settingsFile, validated.data);
    if (written.ok) publishSettings(written.data, options.notifyConditionsChanged !== false);
    return written;
  };
  const settingsScope: ProductSettingsWriteScope = {
    get current() { return structuredClone(currentSettings); }, save: saveUnderAuthority,
    conditionsChanged() { if (!closing) personalControl?.conditionsChanged(); },
  };
  const settingsAuthority: ProductSettingsAuthority = {
    async readSettings() { return ok(structuredClone(currentSettings)); },
    withSettingsWrite: action => enqueueSettingsWrite(() => action(settingsScope)),
    setCredentialRecoveryHook(hook) { credentialRecoveryHook = hook; },
  };
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
  const traceSecrets = new Set<string>();
  const collect = (value: unknown): void => { if (typeof value === 'string' && value.length >= 8) traceSecrets.add(value);
    else if (value && typeof value === 'object') for (const item of Object.values(value)) collect(item); };
  const credentialRequest = (ref: string, operation: 'read' | 'write' | 'delete', credential?: Credential): Promise<Credential | undefined> => {
    collect(credential);
    const direct = options.credentials;
    if (direct) return (async () => {
      let value: Credential | undefined;
      if (operation === 'read') value = await direct.read(ref);
      else if (operation === 'write') {
        if (credential === undefined) throw new Error('credential_invalid');
        await direct.write(ref, credential);
      } else await direct.delete(ref);
      collect(value);
      if (operation !== 'read') personalControl?.conditionsChanged();
      return value;
    })();
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { pendingCredentials.delete(requestId); reject(new Error('credential_timeout')); }, 10_000);
      pendingCredentials.set(requestId, (value) => {
        clearTimeout(timeout);
        if (!value.ok) reject(new Error('credential_unavailable'));
        else {
          collect(value.credential);
          resolve(value.credential as Credential | undefined);
          if (operation !== 'read') personalControl?.conditionsChanged();
        }
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
  const hostLog = createRuntimeLogBuffer();
  const catalog = await createPiModelCatalog();
  const configurationFor = (profile: ModelProfile): ProviderConfig => ({
    version: 1, name: `desktop-${profile.name}`, revision: Math.max(1, currentSettings.revision),
    modelRef: { provider: profile.kind === 'catalog' ? profile.providerId! : `flowmate-profile-${profile.id}`, model: profile.model },
    credentialRef: profile.credentialRef, native: { authPath: authFile, modelsPath: null },
    ...(profile.kind === 'custom' ? { connection: { baseUrl: profile.baseUrl, api: profile.api,
      contextWindow: profile.contextWindow!, maxTokens: profile.maxTokens!, reasoning: profile.reasoning } } : {}),
    parameters: { ...RUNTIME_CONFIG.provider },
  });
  const created = await createApplication({
    logger: hostLog,
    paths,
    ...(layout?.release ? { installedRelease: layout.release, resourceRoot: layout.resourceRoot } : {}),
    invoiceSourceRoot,
    extensionEvaluationProfile,
    caseEvaluationFaultProfile,
    ...(extensionEvaluationProfile || caseEvaluationFaultProfile || evaluationOverrides || evaluationTrialRoot ? { sampleSource: 'evaluation' as const } : {}),
    systemPromptOverride: evaluationOverrides?.systemPrompt,
    thinkingLevelOverride: evaluationOverrides?.reasoning,
    runtimePolicy: evaluationOverrides?.strategy,
    ...(evaluationOverrides?.controlledReplay ? { toolDefinitions: controlledReplayTools } : {}),
    ...(evaluationWorkspaceRoot || evaluationTrialRoot ? { traceCapture: { workspaceRoot: evaluationTrialRoot ?? evaluationWorkspaceRoot!,
      enabled: () => evaluationTrialRoot !== undefined || readObservabilitySettings(evaluationWorkspaceRoot!).capture, secrets: () => [...traceSecrets],
      ...(evaluationWorkspaceRoot ? { onComplete: (trace: import('@flowmate/contracts').TraceBundle) => {
        void send({ version: 1, type: 'evaluation_trace_available', traceId: trace.id, workspaceRoot: evaluationWorkspaceRoot }); } } : {}) } } : {}),
    provider: new PiProviderAdapter({ credentialsFor }),
    personalAgent: {
      resolveConfiguration: modelId => {
        const profile = currentSettings.models.find(model => model.id === modelId);
        if (!profile) return fail(appError('model_not_configured', 'input', 'The selected model is unavailable.'));
        if (profile.kind === 'legacy') return fail(appError('model_reconfiguration_required', 'input', 'Choose an explicit Pi catalog or custom model.'));
        return ok(configurationFor(profile));
      },
      readApiKey: async config => {
        const authorizedProfile = () => currentSettings.models.find(profile => {
          if (profile.kind === 'legacy') return false;
          const current = configurationFor(profile);
          return current.credentialRef === config.credentialRef && current.modelRef.provider === config.modelRef.provider
            && current.modelRef.model === config.modelRef.model && current.connection?.baseUrl === config.connection?.baseUrl
            && current.connection?.api === config.connection?.api;
        });
        const profile = authorizedProfile(); if (!profile) return undefined;
        try {
          if (profile.kind === 'catalog' && !(await catalog.list(profile.providerId ?? undefined))
            .find(provider => provider.id === profile.providerId)?.authMethods.includes('api_key')) return undefined;
          const credential = await credentialRequest(profile.credentialRef, 'read');
          return authorizedProfile() && credential?.type === 'api_key' && typeof credential.key === 'string' && credential.key.trim() ? credential.key : undefined;
        } catch { return undefined; }
      },
      onReady: control => { personalControl = control; },
    },
    agentFactory: (tools, resourceContents, observeModel) => new PiAgentAdapter({ resourceContents, credentialsFor, observeModel,
      systemPromptOverride: evaluationOverrides?.systemPrompt, thinkingLevelOverride: evaluationOverrides?.reasoning, cwd: paths.runtimeDir, agentDir: paths.runtimeDir,
      resourceBundleRoot: join(paths.runtimeDir, 'resource-bundles'), promptTrace, tools }),
    promptTrace,
    runtimeDefaults: () => ok(currentSettings.runtime ?? {}),
    resourceDefaults: () => ok({ revision: currentSettings.revision, selection: currentSettings.resources ?? EMPTY_RESOURCE_SELECTION,
      extensions: currentSettings.extensions ?? EMPTY_EXTENSION_SELECTION }),
    saveResourceSelection: input => enqueueSettingsWrite(async () => {
      if (input.expectedRevision !== currentSettings.revision)
        return fail(appError('config_revision_conflict', 'input', 'Reload current resource selection before saving.', true));
      const valid = await application.validateResourceSelection(input.selection, currentSettings.extensions);
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
      const resources = await application.validateResourceSelection(currentSettings.resources ?? EMPTY_RESOURCE_SELECTION, input.selection);
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
    const code = HostDiagnosticCodeSchema.safeParse(created.error.code);
    process.stderr.write(`[Flowmate] ${code.success ? code.data : 'host_application_start_failed'}\n`);
    send({ version: 1, type: 'ready', state: { version: 1, ready: false, host: 'error', appVersion: '0.0.0', userDataPath: paths.root } as Omit<DesktopState, 'modelCredentials'> });
    return created;
  }
  application = created.data;
  hostLog.write({ at: new Date().toISOString(), level: 'info', component: 'host', event: 'application_opened' });
  const settings = await readProductSettings(settingsFile);
  if (!settings.ok) {
    await application.close();
    send({ version: 1, type: 'ready', state: { version: 1, ready: false, host: 'error', appVersion: '0.0.0', userDataPath: paths.root } as Omit<DesktopState, 'modelCredentials'> });
    return settings;
  }
  currentSettings = settings.data;
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
  let closing = false;
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
  const close = async (): Promise<Result<CloseReport>> => {
    closing = true;
    closeRuntimeObservations();
    return application.close();
  };
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
    ready: !closing,
    host: closing ? 'closing' : 'ready',
    settings: currentSettings,
    appVersion: layout?.release?.productVersion ?? process.env.FLOWMATE_DESKTOP_VERSION ?? '0.1.0',
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

  const execute = async (command: HostCommand, control?: { signal?: AbortSignal }): Promise<void> => {
    if (isPersonalAgentHostCommand(command.type)) {
      const captured = parsePersonalAgentCommand({ type: command.type, input: 'input' in command ? command.input : undefined });
      if (!captured) { await send({ version: 1, type: 'response', requestId: command.requestId,
        value: fail(appError('input_invalid', 'input', 'The Personal Agent request is invalid.')) }); return; }
      let value: unknown;
      switch (captured.type) {
        case 'personal_agent_get': value = await application.personalAgent.get(); break;
        case 'personal_agent_update': value = await application.personalAgent.update(captured.input); break;
        case 'personal_agent_open_conversation': value = await application.personalAgent.openConversation(captured.input); break;
        case 'invoice_work_create': value = await application.invoiceWorks.create(captured.input); break;
        case 'invoice_work_list': value = await application.invoiceWorks.list(captured.input); break;
        case 'invoice_work_get': value = await application.invoiceWorks.get(captured.input); break;
        case 'invoice_work_supplement': value = await application.invoiceWorks.supplement(captured.input); break;
        case 'invoice_work_dispose_item': value = await application.invoiceWorks.disposeItem(captured.input); break;
        case 'invoice_work_continue': value = await application.invoiceWorks.continueWork(captured.input); break;
        case 'invoice_work_cancel': value = await application.invoiceWorks.cancelWork(captured.input); break;
        case 'invoice_work_query_operation': value = await application.invoiceWorks.queryOperation(captured.input); break;
        case 'personal_task_list': value = await application.personalTasks.list(captured.input); break;
        case 'personal_task_get': value = await application.personalTasks.get(captured.input); break;
        case 'personal_task_stop': value = await application.personalTasks.stop(captured.input); break;
        case 'personal_task_history': value = await application.personalTasks.history(captured.input); break;
        case 'personal_task_history_entry': value = await application.personalTasks.historyEntry(captured.input); break;
        case 'invoice_work_timeline': value = await application.invoiceWorks.timeline(captured.input); break;
      }
      const result = parsePersonalAgentHostResult(captured.type, value);
      await send({ version: 1, type: 'response', requestId: command.requestId,
        value: result && matchesPersonalAgentResponse(captured, result) ? result : personalAgentHostFailure(captured.type) }); return;
    }
    if (command.type === 'query_diagnostics') {
      const data = HostDiagnosticsSchema.parse({ version: 1, productVersion: layout?.release?.productVersion ?? process.env.FLOWMATE_DESKTOP_VERSION ?? '0.1.0',
        ...hostLog.snapshot(), runtime: { bunVersion: Bun.version, sdkVersion: PI_SDK_VERSION, platform: process.platform, arch: process.arch } });
      await send({ version: 1, type: 'response', requestId: command.requestId, value: ok(data) }); return;
    }
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
    if (command.type === 'replay_invoice_save') { runtimeReply(command, await application.replayInvoiceSave(command.input)); return; }
    if (command.type === 'query_run_tool_evidence') { runtimeReply(command, await application.queryRunToolEvidence(command.input)); return; }
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
    if (command.type === 'read_invoice_export') { send({ version: 1, type: 'response', requestId: command.requestId, value: await application.readInvoiceExport(command.input) }); return; }
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
      const saved = await enqueueSettingsWrite(() => settingsScope.save(command.settings));
      send({ version: 1, type: 'response', requestId: command.requestId, value: saved });
      return;
    }
    if (isInputDefinitionHostCommand(command.type)) {
      const value = command.type === 'list_input_commands' ? await application.listInputCommands(command.input)
        : command.type === 'list_subagent_definitions' ? await application.listSubagentDefinitions()
        : command.type === 'get_subagent_definition' ? await application.getSubagentDefinition(command.input)
        : command.type === 'save_subagent_definition' ? await application.saveSubagentDefinition(command.input) : null;
      const result = parseInputDefinitionHostResult(command.type, value);
      send({ version: 1, type: 'response', requestId: command.requestId, value: result && matchesInputDefinitionResponse(command, result) ? result
        : inputDefinitionHostFailure(command.type) }); return;
    }
    if (isSubagentHostCommand(command.type)) {
      const value = command.type === 'list_subagents' ? await application.listSubagents(command.input)
        : command.type === 'query_subagent' ? await application.querySubagent(command.input)
          : command.type === 'cancel_subagent' ? await application.cancelSubagent(command.input) : null;
      const result = parseSubagentHostResult(command.type, value);
      send({ version: 1, type: 'response', requestId: command.requestId, value: result && matchesSubagentResponse(command, result) ? result
        : fail(appError('host_protocol_invalid', 'runtime', 'Child response could not be verified.')) }); return;
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
    if (isResearchHostCommand(command.type)) {
      const captured = parseResearchCommand({ type: command.type, input: 'input' in command ? command.input : undefined });
      if (!captured) { send({ version: 1, type: 'response', requestId: command.requestId, value: fail(appError('input_invalid', 'input', 'Research request is invalid.')) }); return; }
      const value = captured.type === 'query_research_task' ? await application.queryResearchTask((captured.input as { researchId: number }).researchId)
        : await application[researchOperations[captured.type][0]](captured.input as never);
      const result = parseResearchHostResult(captured.type, value);
      send({ version: 1, type: 'response', requestId: command.requestId, value: result && matchesResearchResponse(captured, result) ? result
        : fail(appError('host_protocol_invalid', 'runtime', 'Research response could not be verified.')) }); return;
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
    if (command.type === 'import_prepared_invoice_material') {
      send({ version: 1, type: 'response', requestId: command.requestId,
        value: await application.importPreparedInvoiceMaterial(command.input) });
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
      const report = await close();
      await send({ version: 1, type: 'response', requestId: command.requestId, value: report });
      if (report.ok && report.data.closed) {
        await send({ version: 1, type: 'event', event: { type: 'host_state', state: { ...state(), ready: false, host: 'closing' } } });
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
      let desktopRequestIdentity: string | undefined;
      if (command.type === 'submit_session_input' && command.input.mode === 'prompt') {
        desktopRequestIdentity = serializeDesktopPromptRequest(command.input, 1);
      }
      if (command.type === 'submit_invoice_form_input') {
        desktopRequestIdentity = serializeDesktopInvoiceFormRequest(command.input);
        const original = await application.querySessionInput({ sessionId: command.input.workspace.sessionId, clientSequence: command.input.clientSequence });
        if (!original.ok) { send({ version: 1, type: 'response', requestId: command.requestId, value: original }); return; }
        if (original.data.input) {
          const prior = original.data.input;
          const value = prior.mode === 'prompt' && prior.goalMode === 'fill-form' && prior.content.version === 2
            && prior.content.desktopRequestIdentity === desktopRequestIdentity && prior.runId !== null
            ? ok({ inputId: prior.inputId, sessionId: prior.sessionId, runId: prior.runId, requestId: command.requestId })
            : fail(appError('state_conflict', 'input', 'This client sequence belongs to another Fill request.'));
          send({ version: 1, type: 'response', requestId: command.requestId, value }); return;
        }
      }
      if (desktopRequestIdentity !== undefined && command.type === 'submit_session_input') {
        const original = await application.querySessionInput({ sessionId: command.input.sessionId, clientSequence: command.input.clientSequence });
        if (!original.ok) { send({ version: 1, type: 'response', requestId: command.requestId, value: original }); return; }
        if (original.data.input) {
          const prior = original.data.input;
          if (prior.content.version === 2 && command.input.mode === 'prompt') desktopRequestIdentity = serializeDesktopPromptRequest(command.input, prior.content.requestIdentityVersion);
          const value = prior.content.version === 2 && prior.content.desktopRequestIdentity === desktopRequestIdentity
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
      if (control?.signal?.aborted) {
        send({ version: 1, type: 'response', requestId: command.requestId,
          value: fail(appError('runtime_shutdown', 'runtime', 'The foreground connection is no longer active.')) }); return;
      }
      const config = configurationFor(profile);
      if (command.type === 'compact_session') {
        const { modelId: _modelId, ...request } = command.input;
        await compactionReply(command, await application.compactSession({ ...request, config }, control));
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
        const agentControl = { ...control, ...(desktopRequestIdentity === undefined ? {} : { desktopRequestIdentity }), onEvent(event: AgentRunEvent) {
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
        }, agentControl);
        else if (command.type === 'submit_session_input' && command.input.mode === 'prompt') {
          const { modelId: _modelId, ...request } = command.input;
          accepted = await application.submitInput({ ...request, config }, agentControl);
        }
        else if (normalized?.ok) accepted = await application.startRun(normalized.data, agentControl);
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
      if (control?.signal?.aborted) {
        send({ version: 1, type: 'response', requestId: command.requestId,
          value: fail(appError('runtime_shutdown', 'runtime', 'The foreground connection is no longer active.')) }); return;
      }
      const config = configurationFor(profile);
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
      const disconnected = () => controller.abort(control?.signal?.reason);
      control?.signal?.addEventListener('abort', disconnected, { once: true });
      if (control?.signal?.aborted) disconnected();
      const current = { controller, runId: null as number | null };
      active.set(command.requestId, current);
      let accepted = false;
      let result: Awaited<ReturnType<Application['callProvider']>>;
      try { result = await application.callProvider(normalized.data, {
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
      }); } finally {
        active.delete(command.requestId);
        control?.signal?.removeEventListener('abort', disconnected);
      }
      if (accepted && current.runId !== null) {
        send({ version: 1, type: 'event', event: { type: 'provider_finished', requestId: command.requestId, runId: current.runId, result } });
      } else if (!accepted) {
        send({ version: 1, type: 'response', requestId: command.requestId, value: result });
      }
      return;
    }
  };

  let recovery: Promise<Result<void>> | undefined;
  return ok({
    settingsAuthority,
    async readForegroundStop(reference) {
      if (reference.kind === 'run') {
        const run = await application.queryRun(reference.runId);
        if (!run.ok) return run;
        if (run.data.sessionId !== reference.sessionId || run.data.kind === 'subagent'
          || 'runtimeKind' in run.data && run.data.runtimeKind === 'durable')
          return fail(appError('state_conflict', 'runtime', 'The original foreground reference does not match.'));
        return ok(run.data.stoppedAt !== null && run.data.cleanup.stopped === true);
      }
      const result = await application.querySessionCompaction({ sessionId: reference.sessionId, operationId: reference.operationId });
      if (!result.ok) return result;
      const operation = result.data.operation;
      return ok(operation?.sessionId === reference.sessionId && operation.operationId === reference.operationId && operation.stopped === true);
    },
    async dispatch(raw, control) {
      const command = parseHostCommand(raw);
      if (!command) return;
      try {
        if (closing && !closingReads.includes(command.type)
          && !(command.type === 'list_model_catalog' && !command.refresh)
          && command.type !== 'close' && command.type !== 'credential_response' && command.type !== 'invoice_form_response') {
          await send({ version: 1, type: 'response', requestId: command.requestId,
            value: fail(appError('host_closing', 'runtime', 'The product owner is closing.', true)) });
          return;
        }
        await execute(command, control);
      } catch {
        const error = appError('host_command_failed', 'runtime', 'Host 命令处理失败。', true);
        if (isRuntimeHostCommand(command.type)) runtimeReply(command, command.type === 'query_runtime_events'
          ? { ok: false, error, context: null } : fail(error));
        else if (isContextHostCommand(command.type)) await contextReply(command, contextHostFailure());
        else if (isHistoryHostCommand(command.type)) await historyReply(command, historyHostFailure());
        else if (isPersonalAgentHostCommand(command.type)) await send({ version: 1, type: 'response', requestId: command.requestId,
          value: personalAgentHostFailure(command.type) });
        else await send({ version: 1, type: 'response', requestId: command.requestId, value: fail(error) });
      }
    },
    startRecovery(expectedSettingsRevision) {
      if (closing) return Promise.resolve(fail(appError('host_closing', 'runtime', 'The product owner is closing.', true)));
      let startInvoked = false;
      recovery ??= enqueueSettingsWrite(async () => {
        if (closing) return fail(appError('host_closing', 'runtime', 'The product owner is closing.', true));
        if (expectedSettingsRevision !== undefined && currentSettings.revision !== expectedSettingsRevision)
          return fail(appError('config_revision_conflict', 'input', 'The original activation configuration changed before recovery.', true));
        startInvoked = true;
        return personalControl?.start() ?? ok(undefined);
      }).then(result => {
        if (!result.ok) {
          if (!startInvoked) recovery = undefined;
          hostLog.write({ at: new Date().toISOString(), level: 'error', component: 'personal_agent', event: 'recovery_failed', code: result.error.code });
        }
        return result;
      }).catch(() => {
        if (!startInvoked) recovery = undefined;
        hostLog.write({ at: new Date().toISOString(), level: 'error', component: 'personal_agent', event: 'recovery_failed', code: 'runtime_failed' });
        return fail(appError('runtime_failed', 'runtime', 'Personal Agent recovery could not be completed.', true));
      });
      return recovery;
    },
    close,
    releaseRuntimeObservations: closeRuntimeObservations,
  });
}
