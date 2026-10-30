import { appError, fail, ok, INVOICE_REVIEW_TOOL_NAMES, SKILL_RESOURCE_TOOL_NAMES, DelegateArgsSchema, PersonalAgentConfigurationSchema, resourceRefKey,
  type AppError, type DurableAttemptIdentity, type DurableProductToolCall, type DurableRuntimePort, type FrozenResources, type ManagedFileContents,
  type PersonalAgentConfiguration, type ProviderConfig, type RuntimeRequestOverrides, type Result } from '@flowmate/contracts';
import { createResourceService, createToolExecutor, createInvoiceWorkToolBridge, DurableInvoiceGovernor,
  InvoiceWorkModelService, InvoiceWorkPhaseContextService, InvoiceWorkPhaseObserver, PersonalAgentService,
  InvoiceWorkService, PersonalTasksService, InvoiceWorkCoordinator, prepareInvoiceWorkInstructions, createDurableInvoiceSubagentService,
  createPersonalHistoryService, createInvoiceWorkCompactionCallbacks } from '@flowmate/core';
import type { DbHandle } from '../packages/core/src/storage/database.ts';
import { buildInvoiceWorkContext, createDurableRuntime, createDurableSqliteStorage, prepareDurableModelBinding, DURABLE_SDK_VERSIONS } from '@flowmate/runtime-durable';
import { inspectNativeResources, toPiParameters } from '@flowmate/runtime-pi';

export type PersonalAgentRuntimeOptions = {
  database: DbHandle;
  definitions: Parameters<typeof createToolExecutor>[0]['definitions'];
  resourceRoot: string;
  bundleRoot: string;
  resolveConfiguration: (modelId: string) => Result<ProviderConfig> | Promise<Result<ProviderConfig>>;
  readApiKey: (config: ProviderConfig) => string | undefined | Promise<string | undefined>;
  foregroundBusy: () => boolean;
  now: () => string;
  defaultConfiguration?: PersonalAgentConfiguration;
  runtimeDefaults?: () => Result<RuntimeRequestOverrides>;
  onError?: (error: AppError) => void;
};
type OriginalFile = { owner_kind: string; owner_id: string; relative_path: string; content: Uint8Array };
const resourceKey = (configuration: PersonalAgentConfiguration, revision: number) => JSON.stringify([
  revision, configuration.resources, configuration.tools, configuration.extensions,
]);
const callIdentity = ({ workId, sessionId, attemptId, requestId }: DurableProductToolCall) => ({ workId, sessionId, attemptId, requestId });

/** One product owner assembles both runtime boundaries; only committed commands wake business execution. */
export async function createPersonalAgentRuntime(options: PersonalAgentRuntimeOptions) {
  const { database, now } = options;
  const governor = new DurableInvoiceGovernor(database, now, options.foregroundBusy);
  let nativeRuntime: DurableRuntimePort | undefined;
  try {
  const subagents = createDurableInvoiceSubagentService({ database, now, governor,
    observeSubagent: identity => nativeRuntime?.observeSubagent(identity)
      ?? Promise.resolve(fail(appError('personal_agent_unavailable', 'runtime', 'The native child observer is not ready.'))) });
  const definitions = options.definitions.filter(tool => (INVOICE_REVIEW_TOOL_NAMES as readonly string[]).includes(tool.name)
    || (SKILL_RESOURCE_TOOL_NAMES as readonly string[]).includes(tool.name)).concat(subagents.tool);
  const preparedResources = new Map<string, FrozenResources | null>();
  const report = (error: AppError) => { try { options.onError?.(error); } catch { /* Diagnostics do not replace committed facts. */ } };
  const prepareResources = async (configuration: PersonalAgentConfiguration, revision: number): Promise<Result<void>> => {
    if (configuration.extensions.enabledExtensions.length)
      return fail(appError('personal_agent_extensions_unavailable', 'extension', 'The selected extensions have no Durable phase adapter.'));
    const key = resourceKey(configuration, revision), original = preparedResources.get(key);
    const hub = createResourceService({ resourceRoot: options.resourceRoot, bundleRoot: options.bundleRoot,
      registeredToolNames: definitions.map(tool => tool.name), inspectNativeResources });
    if (preparedResources.has(key)) {
      if (original === null) return ok(undefined);
      if (original) return database.read(scope => hub.verifyFrozen(original, scope.contents));
    }
    if (configuration.resources.prompt === null && configuration.resources.enabledSkills.length === 0) {
      preparedResources.set(key, null); return ok(undefined);
    }
    try {
      const selected = new Set([...(configuration.resources.prompt ? [configuration.resources.prompt] : []),
        ...configuration.resources.enabledSkills].map(resourceRefKey));
      const rows = await database.read(scope => scope.db.query<OriginalFile, [string]>(
        "SELECT * FROM managed_file_contents WHERE owner_kind='resource-author' AND owner_id IN (SELECT value FROM json_each(?))")
        .all(JSON.stringify([...selected])));
      const values = new Map(rows.map(row => [JSON.stringify([row.owner_kind, row.owner_id, row.relative_path]), Uint8Array.from(row.content)]));
      const writes: Array<{ owner: Parameters<ManagedFileContents['read']>[0]; content: Uint8Array }> = [];
      const contents: ManagedFileContents = {
        read: owner => { const content = values.get(JSON.stringify([owner.ownerKind, owner.ownerId, owner.relativePath])); return content ? Uint8Array.from(content) : null; },
        remember: (owner, content) => {
          const id = JSON.stringify([owner.ownerKind, owner.ownerId, owner.relativePath]), before = values.get(id);
          if (before && !Buffer.from(before).equals(Buffer.from(content))) throw Error('resource_version_changed');
          if (!before) { const copy = Uint8Array.from(content); values.set(id, copy); writes.push({ owner: { ...owner }, content: copy }); }
        },
      };
      // Bundle publication uses copied author bytes outside the product SQL transaction.
      const frozen = hub.freeze({ selection: configuration.resources, settingsRevision: revision,
        activeToolNames: configuration.tools.filter(name => definitions.some(tool => tool.name === name)), requiredSkill: null }, contents);
      if (!frozen.ok) return frozen;
      if (frozen.data?.excludedSkills.length) return fail(appError('resource_required_unavailable', 'input', 'An explicitly selected Skill is unavailable.'));
      await database.transaction(scope => {
        for (const write of writes) if (write.owner.ownerKind === 'resource-bundle' && write.owner.ownerId === frozen.data?.bundleId
          || write.owner.ownerKind === 'resource-author' && selected.has(write.owner.ownerId)) scope.contents.remember(write.owner, write.content);
      });
      preparedResources.set(key, frozen.data); return ok(undefined);
    } catch { return fail(appError('resource_bundle_unavailable', 'storage', 'The original selected instruction resources could not be prepared.', true)); }
  };
  const contexts = new InvoiceWorkPhaseContextService({ database, now, buildContext: buildInvoiceWorkContext,
    prepareInstructions: (input, scope) => {
      const work = scope.db.query<{ configuration_json: string }, [number]>('SELECT configuration_json FROM invoice_works WHERE id=?').get(input.work.workId);
      if (!work) return fail(appError('invoice_work_not_found', 'input', 'The invoice Work is unavailable.'));
      const configuration = PersonalAgentConfigurationSchema.parse(JSON.parse(work.configuration_json));
      const key = resourceKey(configuration, input.phase.basis.configurationRevision);
      if (!preparedResources.has(key)) return fail(appError('resource_bundle_unavailable', 'storage', 'The original phase resources have not been prepared.'));
      const hub = createResourceService({ resourceRoot: options.resourceRoot, bundleRoot: options.bundleRoot,
        registeredToolNames: definitions.map(tool => tool.name), inspectNativeResources });
      return prepareInvoiceWorkInstructions({ configuration, resources: preparedResources.get(key) ?? null,
        readFrozenFile: (frozen, request) => hub.readFrozenFile(frozen, request, scope.contents) });
    } });
  let coordinator: InvoiceWorkCoordinator | undefined;
  let observer: InvoiceWorkPhaseObserver | undefined;
  let activated = false;
  const reader = createInvoiceWorkToolBridge({ database, executor: createToolExecutor({ database, definitions, now }) });
  const executors = new Map<number, Promise<ReturnType<typeof createInvoiceWorkToolBridge>>>();
  const executionBridge = async (call: DurableProductToolCall) => {
    const task = await database.read(scope => scope.invoiceWorkAttempts.get({ workId: call.workId, attemptId: call.attemptId }));
    if (!task.ok) throw task.error;
    const runId = task.data.task.attempt.runId;
    if (runId === null || task.data.task.sessionId !== call.sessionId) throw Error('state_conflict');
    let bridge = executors.get(runId);
    if (!bridge) {
      bridge = (async () => {
        const remaining = await governor.remainingBudget(call.workId); if (!remaining.ok) throw remaining.error;
        const run = await database.read(scope => scope.runs.get(runId)); if (!run.ok) throw run.error;
        const limits = run.data.config.runtimeBudget;
        if (!limits || typeof limits !== 'object' || !('toolTimeoutMs' in limits) || typeof limits.toolTimeoutMs !== 'number') throw Error('storage_corrupt');
        const executor = createToolExecutor({ database, definitions, now, maxToolCalls: remaining.data.toolCalls,
          maxResultBytes: remaining.data.toolFeedbackBytes, maxToolTimeoutMs: limits.toolTimeoutMs });
        executor.setRunDeadline(runId, performance.now() + remaining.data.timeoutMs);
        return createInvoiceWorkToolBridge({ database, executor });
      })();
      executors.set(runId, bridge);
    }
    return bridge;
  };
  const opened = await createDurableRuntime({ storage: await createDurableSqliteStorage(database.coordinator),
    readApiKey: (_identity, config) => options.readApiKey(config), verifyModelUse: identity => governor.verifyModelUse(identity),
    verifySchedulingUse: (identity, pendingFeedback) => governor.verifySchedulingUse(identity, pendingFeedback),
    reserveModelRequest: identity => governor.reserveModelRequest(identity),
    compactions: createInvoiceWorkCompactionCallbacks({ database, governor, contexts, subagents: subagents.callbacks }),
    subagents: subagents.callbacks,
    readWorkingContext: query => query.child ? subagents.readWorkingContext(query) : contexts.get(query),
    verifyWorkingContext: async query => {
      if (!query.child) return contexts.verify(query);
      const context = await subagents.readWorkingContext(query); return context.ok ? ok(undefined) : context;
    }, tools: definitions.map(tool => ({ name: tool.name,
      description: tool.description, executionMode: tool.executionMode, effect: tool.effect, inputSchema: { ...toPiParameters(tool.name === 'Agent'
        ? DelegateArgsSchema.extend({ run_in_background: DelegateArgsSchema.shape.run_in_background.removeDefault() }) : tool.inputSchema) } })),
    executeTool: async call => {
      if (!observer) return fail(appError('personal_agent_unavailable', 'runtime', 'The original tool phase is not ready.'));
      const linked = await observer.reconcile(callIdentity(call)); if (!linked.ok) return linked;
      try { return await (await executionBridge(call)).executeTool(call); }
      catch { return fail(appError('tool_execution_failed', 'runtime', 'The original invoice tool execution could not be admitted.', true)); }
    }, readToolResult: call => reader.readToolResult(call), onToolFeedback: feedback => reader.onToolFeedback(feedback),
    onChanged: () => { if (activated) coordinator?.wake(); },
  });
  if (!opened.ok) return opened;
  const runtime = opened.data;
  nativeRuntime = runtime;
  observer = new InvoiceWorkPhaseObserver({ database, runtime, now });
  const modelService = new InvoiceWorkModelService({ database, runtime, now,
    resolveConfiguration: () => fail(appError('original_model_binding_unavailable', 'runtime', 'The Work has no model configuration captured at acceptance.')) });
  const tasks = new PersonalTasksService({ database, runtime, phaseObserver: observer, now,
    history: createPersonalHistoryService({ database, runtime }),
    reconcileChildren: identity => subagents.reconcileAttempt(identity),
    verifyModelUse: identity => governor.verifyModelUse(identity), onChanged: () => { if (activated) coordinator?.wake(); },
    restoreAttempt: async (identity: DurableAttemptIdentity) => {
      const phases = await database.read(scope => scope.db.query<{ request_id: string }, [number, number]>(
        'SELECT request_id FROM invoice_work_phases WHERE work_id=? AND attempt_id=? AND native_submission_id IS NOT NULL ORDER BY id')
        .all(identity.workId, identity.attemptId));
      for (const phase of phases) { const restored = await modelService.restore({ ...identity, requestId: phase.request_id }); if (!restored.ok) return restored; }
      return ok(undefined);
    } });
  coordinator = new InvoiceWorkCoordinator({ database, runtime, modelService, contexts, phaseObserver: observer,
    governor, tasks, now, sdk: DURABLE_SDK_VERSIONS, verifyResources: prepareResources, onError: report });
  const agent = new PersonalAgentService({ database, now, validateConfiguration: async configuration => {
    if (configuration.tools.some(name => !definitions.some(tool => tool.name === name)))
      return fail(appError('personal_agent_tool_unavailable', 'input', 'The selected tool has no Personal Agent adapter.'));
    const resources = await prepareResources(configuration, 0); if (!resources.ok) return resources;
    if (configuration.modelId === null) return ok(undefined);
    const config = await options.resolveConfiguration(configuration.modelId); if (!config.ok) return config;
    const fixed = await prepareDurableModelBinding(config.data); return fixed.ok ? ok(undefined) : fixed;
  } });
  const works = new InvoiceWorkService({ database, now, runtimeDefaults: options.runtimeDefaults,
    onChanged: () => { if (activated) coordinator?.wake(); },
    captureModel: async configuration => {
      if (configuration.modelId === null) return ok(null);
      const config = await options.resolveConfiguration(configuration.modelId); return config.ok ? prepareDurableModelBinding(config.data) : config;
    }, assessExecution: async command => {
      const assessment = await governor.assess(command); if (!assessment.ok || assessment.data.kind === 'blocked' || assessment.data.kind === 'waiting') return assessment;
      const config = command.kind === 'create'
        ? await database.read(scope => scope.personalAgents.getDefault())
        : await database.read(scope => scope.invoiceWorkModelBindings.getOriginal({ workId: command.request.workId }));
      if (!config.ok) return config;
      let fixed: ProviderConfig | null = null;
      if (command.kind === 'create' && config.data && 'configuration' in config.data && config.data.configuration.modelId) {
        const resolved = await options.resolveConfiguration(config.data.configuration.modelId); if (!resolved.ok) return resolved; fixed = resolved.data;
      } else if (config.data && 'binding' in config.data) fixed = config.data.binding.configuration;
      if (!fixed || !(await options.readApiKey(fixed))?.trim()) return fail(appError('model_credential_missing', 'input', 'The original selected model has no available API key.'));
      return assessment;
    } });
  const initialized = await agent.initialize(options.defaultConfiguration ?? PersonalAgentConfigurationSchema.parse({ modelId: null,
    thinkingLevel: 'off', tools: definitions.map(tool => tool.name), resources: { prompt: null, enabledSkills: [] },
    extensions: { enabledExtensions: [] }, workingDirectory: null, preferences: '' }));
  if (!initialized.ok) { await runtime.close(); return initialized; }
  return ok({ personal: { agent, works, tasks }, coordinator,
    conditionsChanged: () => { if (activated) coordinator?.wake(); },
    start: async () => {
      activated = true;
      const started = coordinator!.startRecovery();
      if (!started.ok) activated = false;
      return started;
    }, close: async () => {
      activated = false;
      const stopping = coordinator!.close(); const native = await runtime.close(); const scheduled = await stopping;
      return native.ok ? scheduled : native;
    } });
  } catch {
    if (nativeRuntime) await nativeRuntime.close();
    return fail(appError('personal_agent_initialization_failed', 'runtime', 'The Personal Agent runtime could not be initialized.', true));
  }
}

export type PersonalAgentRuntime = Extract<Awaited<ReturnType<typeof createPersonalAgentRuntime>>, { ok: true }>['data'];
