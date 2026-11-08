import { isDeepStrictEqual } from 'node:util';
import { appError, BrowserTargetSchema, CloudWorkspaceIdSchema, fail, ok, INVOICE_REVIEW_TOOL_NAMES, SKILL_RESOURCE_TOOL_NAMES, PERSONAL_DESKTOP_TOOL_NAMES, PERSONAL_BROWSER_TOOL_NAMES, PERSONAL_INVOICE_FORM_TOOL_NAMES, DelegateArgsSchema, PersonalAgentConfigurationSchema, resourceRefKey,
  type AppError, type BrowserReadRebind, type BrowserReadView, type BrowserTarget, type DesktopActionProposal, type DesktopActionRebind, type DesktopActionTarget, type DesktopActionView, type DurableAttemptIdentity, type DurableProductToolCall, type DurableRuntimePort, type FrozenResources, type ManagedFileContents,
  type PersonalAgentConfiguration, type ProviderConfig, type RuntimeRequestOverrides, type Result } from '@flowmate/contracts';
import { createResourceService, createToolExecutor, createInvoiceWorkToolBridge, DurableInvoiceGovernor,
  InvoiceWorkModelService, InvoiceWorkPhaseContextService, InvoiceWorkPhaseObserver, PersonalAgentService,
  InvoiceWorkService, PersonalTasksService, InvoiceWorkCoordinator, prepareInvoiceWorkInstructions, createDurableInvoiceSubagentService,
  createPersonalHistoryService, createInvoiceWorkApprovalWait, createInvoiceWorkCompactionCallbacks, createDesktopProposalTool, createDesktopExecutionTool, createDesktopReadTools,
  createPersonalInvoiceFormTool, createPersonalInvoiceFormObserveTool, createBrowserRequestTool, createBrowserExecutionTool, resolveInvoiceWorkToolScope, type InvoiceFormService } from '@flowmate/core';
import type { DbHandle } from '../packages/core/src/storage/database.ts';
import { buildInvoiceWorkContext, createDurableRuntime, createDurableSqliteStorage, prepareDurableModelBinding, DURABLE_SDK_VERSIONS,
  type DurableRuntimeOptions } from '@flowmate/runtime-durable';
import { inspectNativeResources, toPiParameters } from '@flowmate/runtime-pi';
import { createLocalDurableRuntime } from './local-durable-runtime.ts';
import type { CloudAuthorityCallbacks } from './cloud-authority-rpc.ts';
import type { CloudQueueAuthority } from './cloud-queue-authority.ts';

export type PersonalAgentRuntimeOptions = {
  memory?: { owner: { environment: 'local' | 'cloud'; ownerId: string }; runtime: ReturnType<typeof import('@flowmate/core').createMemoryRuntime> };
  database: DbHandle;
  definitions: Parameters<typeof createToolExecutor>[0]['definitions'];
  resourceRoot: string;
  importedResourceRoot?: string;
  bundleRoot: string;
  resolveConfiguration: (modelId: string) => Result<ProviderConfig> | Promise<Result<ProviderConfig>>;
  readApiKey: (config: ProviderConfig) => string | undefined | Promise<string | undefined>;
  foregroundBusy: () => boolean;
  now: () => string;
  defaultConfiguration?: PersonalAgentConfiguration;
  runtimeDefaults?: () => Result<RuntimeRequestOverrides>;
  cloud?: { workspaceId: string; runtime: DurableRuntimePort };
  onError?: (error: AppError) => void;
  desktop?: Pick<Parameters<typeof createDesktopExecutionTool>[0], 'resolveTarget' | 'dispatch'> & Parameters<typeof createDesktopReadTools>[0];
  browser?: Pick<Parameters<typeof createBrowserExecutionTool>[0], 'resolveTarget' | 'read'>;
  form?: { service: InvoiceFormService; observe: Parameters<typeof createPersonalInvoiceFormObserveTool>[0]['observe'] };
};
type OriginalFile = { owner_kind: string; owner_id: string; relative_path: string; content: Uint8Array };
const resourceKey = (configuration: PersonalAgentConfiguration, revision: number) => JSON.stringify([
  revision, configuration.resources, configuration.tools, configuration.extensions,
]);
const callIdentity = ({ workId, sessionId, itemId, attemptId, requestId }: DurableProductToolCall) =>
  ({ workId, sessionId, ...(itemId === undefined ? {} : { itemId }), attemptId, requestId });

/** One product owner assembles both runtime boundaries; only committed commands wake business execution. */
export async function createPersonalAgentRuntime(options: PersonalAgentRuntimeOptions) {
  const { database, now } = options;
  const governor = new DurableInvoiceGovernor(database, now, options.foregroundBusy, options.cloud ? 'cloud' : 'local');
  const browserRebindings = new Map<string, { original: BrowserTarget; current: BrowserTarget; enabled: boolean }>();
  const desktopRebindings = new Map<string, { originalAction: DesktopActionProposal; originalTarget: DesktopActionTarget; action: DesktopActionProposal; target: DesktopActionTarget; enabled: boolean }>();
  const browserKey = (input: { workId: number; itemId: number; proposalId: number }) => JSON.stringify([input.workId, input.itemId, input.proposalId]);
  const browserApprovedTarget = (_context: unknown, proposal: BrowserReadView) => {
    const saved = browserRebindings.get(browserKey(proposal));
    return saved?.enabled && isDeepStrictEqual(saved.original, proposal.target) ? saved.current : undefined;
  };
  const desktopApprovedAction = (_context: unknown, proposal: DesktopActionView) => {
    const saved = desktopRebindings.get(browserKey(proposal));
    return saved?.enabled && isDeepStrictEqual(saved.originalAction, proposal.action) && isDeepStrictEqual(saved.originalTarget, proposal.target)
      ? { action: saved.action, target: saved.target } : undefined;
  };
  let nativeRuntime: DurableRuntimePort | undefined;
  try {
  const subagents = createDurableInvoiceSubagentService({ database, now, governor,
    observeSubagent: identity => nativeRuntime?.observeSubagent(identity)
      ?? Promise.resolve(fail(appError('personal_agent_unavailable', 'runtime', 'The native child observer is not ready.'))) });
  const desktop = options.desktop ? [...createDesktopReadTools(options.desktop), createDesktopProposalTool({ database, now, ...options.desktop }),
    createDesktopExecutionTool({ database, now, ...options.desktop, approvedAction: desktopApprovedAction })] : [];
  const browser = options.browser ? [createBrowserRequestTool({ database, now, ...options.browser }),
    createBrowserExecutionTool({ database, now, ...options.browser, approvedTarget: browserApprovedTarget })] : [];
  const form = options.form && !options.cloud ? [createPersonalInvoiceFormObserveTool({ database, observe: options.form.observe }),
    createPersonalInvoiceFormTool(options.form.service)] : [];
  const definitions = options.definitions.filter(tool => (INVOICE_REVIEW_TOOL_NAMES as readonly string[]).includes(tool.name)
    || (SKILL_RESOURCE_TOOL_NAMES as readonly string[]).includes(tool.name)).concat(subagents.tool, ...desktop, ...browser, ...form);
  const preparedResources = new Map<string, FrozenResources | null>();
  const report = (error: AppError) => { try { options.onError?.(error); } catch { /* Diagnostics do not replace committed facts. */ } };
  const prepareResources = async (configuration: PersonalAgentConfiguration, revision: number): Promise<Result<void>> => {
    if (configuration.extensions.enabledExtensions.length)
      return fail(appError('personal_agent_extensions_unavailable', 'extension', 'The selected extensions have no Durable phase adapter.'));
    const key = resourceKey(configuration, revision), original = preparedResources.get(key);
    const hub = createResourceService({ resourceRoot: options.resourceRoot, importedResourceRoot: options.importedResourceRoot, bundleRoot: options.bundleRoot,
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
        "SELECT * FROM managed_file_contents WHERE owner_kind IN ('resource-author','cloud-resource-manifest') AND owner_id IN (SELECT value FROM json_each(?))")
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
      const hub = createResourceService({ resourceRoot: options.resourceRoot, importedResourceRoot: options.importedResourceRoot, bundleRoot: options.bundleRoot,
        registeredToolNames: definitions.map(tool => tool.name), inspectNativeResources });
      return prepareInvoiceWorkInstructions({ configuration, resources: preparedResources.get(key) ?? null,
        readFrozenFile: (frozen, request) => hub.readFrozenFile(frozen, request, scope.contents) });
    } });
  let coordinator: InvoiceWorkCoordinator | undefined;
  const approvalWait = createInvoiceWorkApprovalWait({ database, now, onChanged: () => { if (activated) coordinator?.wake(); } });
  const checkedApproval = { begin: approvalWait.begin, read: async (input: Parameters<typeof approvalWait.read>[0]) => {
    const state = await approvalWait.read(input);
    if (!state.ok || state.data.status !== 'approved' || state.data.scheduling !== 'active') return state;
    try {
      const original = await database.read(scope => {
        const attempt = scope.invoiceWorkAttempts.get({ workId: input.workId, attemptId: input.attemptId });
        if (!attempt.ok || attempt.data.task.attempt.runId === null) return null;
        const runId = attempt.data.task.attempt.runId;
        const resolved = resolveInvoiceWorkToolScope(scope.db, { runId, sessionId: input.sessionId, workId: input.workId,
          itemId: input.itemId, attemptId: input.attemptId, requestId: input.requestId });
        if (!resolved.ok) return null;
        const key = { workId: input.workId, itemId: input.itemId, proposalId: input.proposalId };
        const proposal = input.kind === 'browser' ? scope.invoiceWorkBrowserReads.get(key) : scope.invoiceWorkDesktopActions.get(key);
        return proposal.ok ? { context: { runId, sessionId: input.sessionId, scope: resolved.data.scope }, proposal: proposal.data } : null;
      });
      if (!original) return ok({ ...state.data, deviceReady: false });
      const held = 'action' in original.proposal ? desktopRebindings.get(browserKey(original.proposal)) : browserRebindings.get(browserKey(original.proposal));
      if (held && !held.enabled) return ok({ ...state.data, deviceReady: false });
      const signal = AbortSignal.timeout(5000);
      const rebound = 'action' in original.proposal ? desktopApprovedAction(original.context, original.proposal) : undefined;
      const current = input.kind === 'browser' && options.browser ? await options.browser.resolveTarget(original.context, signal)
        : input.kind === 'desktop' && options.desktop && 'action' in original.proposal
          ? await options.desktop.resolveTarget(rebound?.action ?? original.proposal.action, original.context, signal) : null;
      const expected = 'action' in original.proposal ? rebound?.target ?? original.proposal.target
        : browserApprovedTarget(original.context, original.proposal) ?? original.proposal.target;
      return ok({ ...state.data, deviceReady: current?.ok === true && isDeepStrictEqual(current.data, expected) });
    } catch { return ok({ ...state.data, deviceReady: false }); }
  } };
  const rebindDesktopAction = async (input: DesktopActionRebind): Promise<Result<DesktopActionView>> => {
    const denied = () => fail(appError('state_conflict', 'runtime', 'The original approved desktop action cannot be rebound.'));
    if (!options.desktop) return denied();
    try {
      const original = await database.read(scope => {
        const proposal = scope.invoiceWorkDesktopActions.get({ workId: input.workId, itemId: input.itemId, proposalId: input.proposalId });
        const row = scope.db.query<{ phase_id: number; attempt_id: number; request_id: string; session_id: number;
          run_id: number; native_conversation_id: number; native_tool_call_id: string }, [number]>(`SELECT p.id phase_id,p.attempt_id,p.request_id,
          w.session_id,a.run_id,p.native_conversation_id,t.native_tool_call_id FROM invoice_work_desktop_actions da
          JOIN invoice_work_tool_calls b ON b.tool_call_id=da.proposal_tool_call_id JOIN tool_calls t ON t.id=b.tool_call_id
          JOIN invoice_work_phases p ON p.id=b.phase_id JOIN invoice_work_attempts a ON a.id=p.attempt_id
          JOIN invoice_works w ON w.id=p.work_id WHERE da.id=?`).get(input.proposalId);
        if (!proposal.ok || proposal.data.status !== 'approved' || !proposal.data.resumeOriginal || proposal.data.executionToolCallId !== null
          || !isDeepStrictEqual(proposal.data.action, input.confirmedAction) || !isDeepStrictEqual(proposal.data.target, input.confirmedTarget) || !row) return null;
        const task = /^durable-task:([1-9]\d*)$/.exec(row.native_tool_call_id);
        if (!task || !Number.isSafeInteger(Number(task[1]))) return null;
        const identity = { workId: input.workId, itemId: input.itemId, sessionId: row.session_id, attemptId: row.attempt_id,
          phaseId: row.phase_id, requestId: row.request_id, nativeConversationId: row.native_conversation_id,
          nativeTaskId: Number(task[1]), proposalId: input.proposalId, kind: 'desktop' as const };
        const resolved = resolveInvoiceWorkToolScope(scope.db, { runId: row.run_id, sessionId: row.session_id, workId: input.workId,
          itemId: input.itemId, attemptId: row.attempt_id, requestId: row.request_id });
        return resolved.ok ? { identity, proposal: proposal.data, context: { runId: row.run_id, sessionId: row.session_id, scope: resolved.data.scope } } : null;
      });
      if (!original) return denied();
      const state = await approvalWait.read(original.identity);
      if (!state.ok || state.data.status !== 'approved' || !['ready', 'active'].includes(state.data.scheduling)) return denied();
      let action = input.currentAction;
      if (!action) {
        const observed = await options.desktop.observe(original.context, AbortSignal.timeout(5000));
        if (!observed.ok || observed.data.truncated || !isDeepStrictEqual(observed.data.window, input.confirmedTarget.window)) return denied();
        action = { ...input.confirmedAction, observationId: observed.data.observationId };
      }
      if (!isDeepStrictEqual({ ...action, observationId: input.confirmedAction.observationId }, input.confirmedAction)) return denied();
      const target = await options.desktop.resolveTarget(action, original.context, AbortSignal.timeout(5000));
      if (!target.ok || input.currentTarget && !isDeepStrictEqual(target.data, input.currentTarget)
        || !isDeepStrictEqual(target.data.window, input.confirmedTarget.window) || target.data.element !== input.confirmedTarget.element) return denied();
      const checked = await approvalWait.read(original.identity);
      if (!checked.ok || checked.data.status !== 'approved' || !['ready', 'active'].includes(checked.data.scheduling)) return denied();
      const previous = desktopRebindings.get(browserKey(input));
      if (input.resume && (!previous || !isDeepStrictEqual(previous.originalAction, input.confirmedAction)
        || !isDeepStrictEqual(previous.originalTarget, input.confirmedTarget) || !isDeepStrictEqual(previous.target, target.data))) return denied();
      desktopRebindings.set(browserKey(input), { originalAction: structuredClone(input.confirmedAction), originalTarget: structuredClone(input.confirmedTarget),
        action: structuredClone(action), target: structuredClone(target.data), enabled: input.resume === true });
      if (activated && input.resume) coordinator?.wake();
      return ok(original.proposal);
    } catch { return denied(); }
  };
  const rebindBrowserRead = async (input: BrowserReadRebind): Promise<Result<BrowserReadView>> => {
    const denied = () => fail(appError('state_conflict', 'runtime', 'The original approved browser target cannot be rebound.'));
    if (!options.browser || input.currentTarget.origin !== input.confirmedTarget.origin) return denied();
    try {
      const original = await database.read(scope => {
        const proposal = scope.invoiceWorkBrowserReads.get({ workId: input.workId, itemId: input.itemId, proposalId: input.proposalId });
        const row = scope.db.query<{ phase_id: number; attempt_id: number; request_id: string; session_id: number;
          run_id: number; native_conversation_id: number; native_tool_call_id: string }, [number]>(`SELECT p.id phase_id,p.attempt_id,p.request_id,
          w.session_id,a.run_id,p.native_conversation_id,t.native_tool_call_id FROM invoice_work_browser_reads br
          JOIN invoice_work_tool_calls b ON b.tool_call_id=br.proposal_tool_call_id JOIN tool_calls t ON t.id=b.tool_call_id
          JOIN invoice_work_phases p ON p.id=b.phase_id JOIN invoice_work_attempts a ON a.id=p.attempt_id
          JOIN invoice_works w ON w.id=p.work_id WHERE br.id=?`).get(input.proposalId);
        if (!proposal.ok || proposal.data.status !== 'approved' || !proposal.data.resumeOriginal || proposal.data.executionToolCallId !== null
          || !isDeepStrictEqual(proposal.data.target, input.confirmedTarget) || !row) return null;
        const task = /^durable-task:([1-9]\d*)$/.exec(row.native_tool_call_id);
        if (!task || !Number.isSafeInteger(Number(task[1]))) return null;
        const identity = { workId: input.workId, itemId: input.itemId, sessionId: row.session_id, attemptId: row.attempt_id,
          phaseId: row.phase_id, requestId: row.request_id, nativeConversationId: row.native_conversation_id,
          nativeTaskId: Number(task[1]), proposalId: input.proposalId, kind: 'browser' as const };
        const resolved = resolveInvoiceWorkToolScope(scope.db, { runId: row.run_id, sessionId: row.session_id, workId: input.workId,
          itemId: input.itemId, attemptId: row.attempt_id, requestId: row.request_id });
        return resolved.ok ? { identity, proposal: proposal.data, context: { runId: row.run_id, sessionId: row.session_id, scope: resolved.data.scope } } : null;
      });
      if (!original) return denied();
      const state = await approvalWait.read(original.identity);
      if (!state.ok || state.data.status !== 'approved' || !['ready', 'active'].includes(state.data.scheduling)) return denied();
      const target = await options.browser.resolveTarget(original.context, AbortSignal.timeout(5000));
      if (!target.ok || !isDeepStrictEqual(target.data, input.currentTarget)) return denied();
      const checked = await approvalWait.read(original.identity);
      if (!checked.ok || checked.data.status !== 'approved' || !['ready', 'active'].includes(checked.data.scheduling)) return denied();
      const previous = browserRebindings.get(browserKey(input));
      if (input.resume && (!previous || !isDeepStrictEqual(previous.original, input.confirmedTarget)
        || !isDeepStrictEqual(previous.current, input.currentTarget))) return denied();
      browserRebindings.set(browserKey(input), { original: structuredClone(input.confirmedTarget), current: structuredClone(input.currentTarget), enabled: input.resume === true });
      if (activated && input.resume) coordinator?.wake();
      return ok(original.proposal);
    } catch { return denied(); }
  };
  let observer: InvoiceWorkPhaseObserver | undefined;
  let cloudQueue: Pick<CloudQueueAuthority, 'currentEdit' | 'wasCancelled' | 'verifyInputs'> | undefined;
  let activated = false;
  const reader = createInvoiceWorkToolBridge({ database, executor: createToolExecutor({ database, definitions, now }) });
  const authorizedToolResult = async (call: DurableProductToolCall, signal = new AbortController().signal) => {
    const prior = await reader.readToolResult(call);
    if (!prior.ok || call.name !== 'browser_read_approved' || prior.data?.status !== 'succeeded') return prior;
    const denied = () => fail(appError('browser_target_changed', 'runtime', 'The approved browser binding is no longer available.'));
    if (!options.browser || signal.aborted) return denied();
    try {
      const original = await database.read(scope => {
        const row = scope.db.query<{ id: number; item_id: number; target_json: string; run_id: number }, [number, number, string, number, string]>(
          `SELECT b.id,b.item_id,b.target_json,a.run_id FROM invoice_work_browser_reads b
           JOIN tool_calls t ON t.id=b.execution_tool_call_id JOIN invoice_work_tool_calls c ON c.tool_call_id=t.id
           JOIN invoice_work_phases p ON p.id=c.phase_id JOIN invoice_work_attempts a ON a.id=p.attempt_id
           WHERE b.work_id=? AND p.attempt_id=? AND p.request_id=? AND t.session_id=? AND t.native_tool_call_id=?`)
          .get(call.workId, call.attemptId, call.requestId, call.sessionId, `durable-task:${call.nativeTaskId}`);
        if (!row) return denied();
        const target = BrowserTargetSchema.safeParse(JSON.parse(row.target_json));
        const resolved = resolveInvoiceWorkToolScope(scope.db, { runId: row.run_id, sessionId: call.sessionId,
          workId: call.workId, attemptId: call.attemptId, requestId: call.requestId });
        if (!target.success || !resolved.ok || resolved.data.scope.invoiceWork?.itemId !== row.item_id) return denied();
        return ok({ row, target: target.data, context: { runId: row.run_id, sessionId: call.sessionId, scope: resolved.data.scope } });
      });
      if (!original.ok) return original;
      const current = await options.browser.resolveTarget(original.data.context, signal);
      const rebound = browserRebindings.get(browserKey({ workId: call.workId, itemId: original.data.row.item_id, proposalId: original.data.row.id }));
      const expected = rebound && isDeepStrictEqual(rebound.original, original.data.target) ? rebound.current : original.data.target;
      if (!current.ok || signal.aborted || !isDeepStrictEqual(current.data, expected)) {
        await database.transaction(scope => scope.invoiceWorkBrowserReads.revoke({ workId: call.workId, itemId: original.data.row.item_id,
          proposalId: original.data.row.id, at: now() }));
        return denied();
      }
      return reader.readToolResult(call);
    } catch { return denied(); }
  };
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
  if (options.cloud) CloudWorkspaceIdSchema.parse(options.cloud.workspaceId);
  const runtimeOptions: Omit<DurableRuntimeOptions, 'storage'> = {
    approvalWait: checkedApproval,
    readApiKey: (_identity, config) => options.readApiKey(config), verifyModelUse: identity => governor.verifyModelUse(identity),
    verifySchedulingUse: (identity, pendingFeedback) => governor.verifySchedulingUse(identity, pendingFeedback),
    reserveModelRequest: identity => governor.reserveModelRequest(identity),
    compactions: createInvoiceWorkCompactionCallbacks({ database, governor, contexts, subagents: subagents.callbacks }),
    subagents: subagents.callbacks,
    readWorkingContext: async query => {
      const saved = query.child ? await subagents.readWorkingContext(query) : await contexts.get(query);
      if (!saved.ok || !options.cloud || query.participant === 'reviewer') return saved;
      if (!cloudQueue) return fail(appError('cloud_queue_unavailable', 'runtime', 'The cloud queue authority is unavailable.', true));
      const edit = await cloudQueue.currentEdit({ workId: query.workId, sessionId: query.sessionId,
        ...(query.itemId === undefined ? {} : { itemId: query.itemId }), attemptId: query.attemptId, requestId: query.requestId });
      if (!edit.ok) return edit;
      return edit.data ? ok({ ...saved.data, queueInstruction: { provenance: 'user-provided' as const, ...edit.data } }) : saved;
    },
    ...(options.memory ? { readMemory: async (query: import('@flowmate/contracts').DurableWorkingContextQuery) => {
      if (query.child || query.participant === 'reviewer') return ok({ status: 'disabled' as const, items: [] });
      const allowed = await governor.verifyModelUse({ workId: query.workId, sessionId: query.sessionId, attemptId: query.attemptId });
      if (!allowed.ok) return allowed;
      const saved = await contexts.get(query); if (!saved.ok) return saved;
      const budget = await governor.remainingBudget(query.workId); if (!budget.ok) return budget;
      const timeoutMs = Math.min(2000, Math.floor(budget.data.timeoutMs));
      if (timeoutMs <= 0) return ok({ status: 'unavailable' as const, items: [] });
      const context = saved.data, text = [context.work.goal, ...context.userInputs.map(input => input.text)].join('\n').trim().slice(0, 500);
      return options.memory!.runtime.recallWork({ workId: query.workId, sessionId: query.sessionId, itemId: context.item.itemId,
        attemptId: query.attemptId, phaseId: context.phase.phaseId, requestId: query.requestId,
        owner: options.memory!.owner, query: text, timeoutMs });
    } } : {}),
    verifyWorkingContext: async query => {
      if (!query.child) return contexts.verify(query);
      const context = await subagents.readWorkingContext(query); return context.ok ? ok(undefined) : context;
    }, tools: definitions.map(tool => ({ name: tool.name,
      description: tool.description, executionMode: tool.executionMode, effect: tool.effect, inputSchema: { ...toPiParameters(tool.name === 'Agent'
        ? DelegateArgsSchema.extend({ run_in_background: DelegateArgsSchema.shape.run_in_background.removeDefault() }) : tool.inputSchema) } })),
    executeTool: async call => {
      if (!observer) return fail(appError('personal_agent_unavailable', 'runtime', 'The original tool phase is not ready.'));
      const linked = await observer.reconcile(callIdentity(call)); if (!linked.ok) return linked;
      try {
        const result = await (await executionBridge(call)).executeTool(call);
        if (call.name !== 'browser_read_approved' || !result.ok || result.data.status !== 'succeeded') return result;
        const checked = await authorizedToolResult(call, call.signal);
        if (!checked.ok) return checked;
        return checked.data ? ok(checked.data) : fail(appError('tool_commit_unconfirmed', 'runtime', 'The browser result is no longer available.'));
      }
      catch { return fail(appError('tool_execution_failed', 'runtime', 'The original invoice tool execution could not be admitted.', true)); }
    }, readToolResult: call => authorizedToolResult(call), onToolFeedback: async feedback => {
      if (feedback.name === 'browser_read_approved') {
        const { nativeEntryId: _nativeEntryId, feedbackJson: _feedbackJson, ...call } = feedback;
        const checked = await authorizedToolResult(call);
        if (!checked.ok) return checked;
        if (checked.data === null) return fail(appError('tool_commit_unconfirmed', 'runtime', 'The browser result is no longer available.'));
      }
      return reader.onToolFeedback(feedback);
    },
    onChanged: () => { if (activated) coordinator?.wake(); },
  };
  const opened = options.cloud ? ok(options.cloud.runtime)
    : await createDurableRuntime({ ...runtimeOptions, storage: await createDurableSqliteStorage(database.coordinator) });
  if (!opened.ok) return opened;
  const runtime = options.cloud ? opened.data : createLocalDurableRuntime(opened.data, database);
  nativeRuntime = runtime;
  observer = new InvoiceWorkPhaseObserver({ database, runtime, now });
  const modelService = new InvoiceWorkModelService({ database, runtime, now,
    resolveConfiguration: () => fail(appError('original_model_binding_unavailable', 'runtime', 'The Work has no model configuration captured at acceptance.')) });
  const tasks = new PersonalTasksService({ database, runtime, phaseObserver: observer, now,
    history: createPersonalHistoryService({ database, runtime }),
    reconcileChildren: identity => subagents.reconcileAttempt(identity),
    verifyModelUse: identity => governor.verifyModelUse(identity), onChanged: () => { if (activated) coordinator?.wake(); },
    restoreAttempt: async (identity: DurableAttemptIdentity) => {
      const phases = await database.read(scope => scope.db.query<{ request_id: string; item_id: number | null; scheduler_state: string; participant: 'reviewer' | null }, [number, number]>(
        `SELECT request_id,item_id,scheduler_state,json_extract(basis_json,'$.participant') participant FROM invoice_work_phases
          WHERE work_id=? AND attempt_id=? AND native_submission_id IS NOT NULL ORDER BY id`)
        .all(identity.workId, identity.attemptId));
      for (const phase of phases) { const restored = await modelService.restore({ ...identity, requestId: phase.request_id,
        ...(phase.scheduler_state !== 'legacy' && phase.item_id !== null ? { itemId: phase.item_id } : {}),
        ...(phase.participant ? { participant: phase.participant } : {}) }); if (!restored.ok) return restored; }
      return ok(undefined);
    } });
  coordinator = new InvoiceWorkCoordinator({ database, runtime, modelService, contexts, phaseObserver: observer,
    governor, tasks, now, runtimeScope: options.cloud ? 'cloud' : 'local', sdk: DURABLE_SDK_VERSIONS, verifyResources: prepareResources,
    queueCancelled: options.cloud ? input => cloudQueue ? cloudQueue.wasCancelled(input)
      : Promise.resolve(fail(appError('cloud_queue_unavailable', 'runtime', 'The cloud queue authority is unavailable.', true))) : undefined,
    onError: report });
  const agent = new PersonalAgentService({ database, now, validateConfiguration: async configuration => {
    if (configuration.tools.some(name => !definitions.some(tool => tool.name === name)))
      return fail(appError('personal_agent_tool_unavailable', 'input', 'The selected tool has no Personal Agent adapter.'));
    const resources = await prepareResources(configuration, 0); if (!resources.ok) return resources;
    if (configuration.modelId === null) return ok(undefined);
    const config = await options.resolveConfiguration(configuration.modelId); if (!config.ok) return config;
    const fixed = await prepareDurableModelBinding(config.data); return fixed.ok ? ok(undefined) : fixed;
  } });
  const works = new InvoiceWorkService({ database, now, runtimeDefaults: options.runtimeDefaults, cloudWorkspaceId: options.cloud?.workspaceId,
    ...(options.memory ? { bindMemoryWork: (scope, work) => options.memory!.runtime.bindWorkInStore(scope, work, options.memory!.owner) } : {}),
    onChanged: () => { if (activated) coordinator?.wake(); },
    onDesktopChanged: () => { if (activated) coordinator?.wake(); }, rebindDesktopAction, rebindBrowserRead,
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
    thinkingLevel: 'off', tools: definitions.filter(tool => !([...PERSONAL_DESKTOP_TOOL_NAMES, ...PERSONAL_BROWSER_TOOL_NAMES, ...PERSONAL_INVOICE_FORM_TOOL_NAMES] as readonly string[]).includes(tool.name)).map(tool => tool.name),
    resources: { prompt: null, enabledSkills: [] },
    extensions: { enabledExtensions: [] }, workingDirectory: null, preferences: '' }));
  if (!initialized.ok) { await runtime.close(); return initialized; }
  const callbacks: CloudAuthorityCallbacks = {
    readWorkingContext: async input => runtimeOptions.readWorkingContext!(input),
    ...(runtimeOptions.readMemory ? { readMemory: async input => runtimeOptions.readMemory!(input) } : {}),
    verifyQueueInputs: async input => {
      if (!options.cloud || !cloudQueue) return fail(appError('cloud_queue_unavailable', 'runtime', 'The cloud queue authority is unavailable.', true));
      const verified = await contexts.verify({ workId: input.workId, sessionId: input.sessionId,
        ...(input.itemId === undefined ? {} : { itemId: input.itemId }), attemptId: input.attemptId, requestId: input.requestId });
      return verified.ok ? cloudQueue.verifyInputs(input) : verified;
    },
    verifyWorkingContext: async input => runtimeOptions.verifyWorkingContext!(input),
    verifyModelUse: async input => runtimeOptions.verifyModelUse(input),
    verifySchedulingUse: async (input, pending) => runtimeOptions.verifySchedulingUse!(input, pending),
    executeTool: async input => runtimeOptions.executeTool!(input),
    readToolResult: async input => runtimeOptions.readToolResult!(input),
    onToolFeedback: async input => runtimeOptions.onToolFeedback!(input),
    approvalWait: checkedApproval,
    subagents: runtimeOptions.subagents, compactions: runtimeOptions.compactions,
  };
  return ok({ personal: { agent, works, tasks }, coordinator,
    cloudAuthority: options.cloud ? { workspaceId: options.cloud.workspaceId, callbacks, governor, tools: runtimeOptions.tools ?? [],
      attachQueue: (queue: Pick<CloudQueueAuthority, 'currentEdit' | 'wasCancelled' | 'verifyInputs'>) => { if (cloudQueue && cloudQueue !== queue) throw Error('cloud_queue_owner_conflict'); cloudQueue = queue; },
      reconcilePhase: (identity: Parameters<InvoiceWorkPhaseObserver['reconcile']>[0]) => observer!.reconcile(identity) } : null,
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
