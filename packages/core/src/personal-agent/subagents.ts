import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { appError, fail, ok, DelegateArgsSchema, DurableRunConfigSnapshotSchema, DurableSubagentConfigSnapshotSchema,
  DurableSubagentRunScopeSchema, DurableSubagentRunOutputSchema, InvoiceWorkWorkingContextSchema, NativeToolOutputSchema,
  PersonalAgentConfigurationSchema, ResourceBundleManifestSchema, resourceRefKey, SUBAGENT_ROLE, SUBAGENT_SYSTEM_PROMPT, SUBAGENT_TOOL_NAMES, ToolExecutionFailure,
  type AppError, type DelegateArgs, type DurableAttemptIdentity, type DurableSubagentCallbacks, type DurableSubagentIdentity,
  type DurableSubagentObservation, type DurableSubagentPlan, type DurableWorkingContextQuery, type InvoiceWorkWorkingContext,
  type NativeToolOutput, type ProductToolContext, type Result, type ToolCallContext, type ToolDefinition } from '@flowmate/contracts';
import type { DbHandle, SqlDatabaseStore } from '../storage/database.ts';
import type { DurableInvoiceGovernor } from './admission.ts';
import { resolveInvoiceWorkToolScope, verifyInvoiceWorkToolScope } from './tool-scope.ts';
import { visibleFrozenSkills } from '../skill-hub/capability-map.ts';

const id = z.number().int().positive().max(Number.MAX_SAFE_INTEGER), requestId = z.string().min(1).max(128);
const identitySchema = z.object({ workId: id, sessionId: id, attemptId: id, requestId,
  childRunId: id, childSessionId: id, originToolCallId: id, nativeToolTaskId: id }).strict();
const time = z.string().datetime({ offset: true });
class ChildFault extends Error { constructor(readonly fact: AppError) { super(fact.code); } }
function need<T>(result: Result<T>): T { if (!result.ok) throw new ChildFault(result.error); return result.data; }
function requireFact(value: unknown, code = 'subagent_origin_invalid', message = 'The original child ownership could not be verified.'): asserts value {
  if (!value) throw new ChildFault(appError(code, 'runtime', message));
}
function identityOf(value: DurableSubagentIdentity): DurableSubagentIdentity {
  return identitySchema.parse({ workId: value.workId, sessionId: value.sessionId, attemptId: value.attemptId, requestId: value.requestId,
    childRunId: value.childRunId, childSessionId: value.childSessionId, originToolCallId: value.originToolCallId, nativeToolTaskId: value.nativeToolTaskId });
}
const active = (status: string) => status === 'created' || status === 'running';

/** The product records one child per original Agent call; Durable owns all internal native tasks. */
export function createDurableInvoiceSubagentService(options: {
  database: Pick<DbHandle, 'read' | 'transaction'>; now: () => string; governor: DurableInvoiceGovernor;
  observeSubagent: (identity: DurableSubagentIdentity) => Promise<Result<DurableSubagentObservation | null>>;
}) {
  async function operation<T>(action: () => Promise<T>): Promise<Result<T>> {
    try { return ok(await action()); }
    catch (error) { return fail(error instanceof ChildFault ? error.fact
      : appError('subagent_observation_unknown', 'runtime', 'The original child facts remain unconfirmed.', true)); }
  }
  function facts(store: SqlDatabaseStore, raw: DurableSubagentIdentity, live = false) {
    const identity = identityOf(raw), run = need(store.runs.get(identity.childRunId));
    const scope = DurableSubagentRunScopeSchema.parse(run.scope), config = DurableSubagentConfigSnapshotSchema.parse(run.config);
    const owner = store.db.query<{ session_id: number; run_id: number; plugin_agent_id: string }, [number, number, number]>(`SELECT w.session_id,a.run_id,r.plugin_agent_id
      FROM invoice_works w JOIN invoice_work_attempts a ON a.work_id=w.id JOIN runs r ON r.parent_run_id=a.run_id
      WHERE w.id=? AND a.id=? AND r.id=?`).get(identity.workId, identity.attemptId, identity.childRunId);
    requireFact(owner && owner.session_id === identity.sessionId && owner.run_id === scope.parentRunId
      && run.sessionId === identity.childSessionId && scope.workId === identity.workId && scope.attemptId === identity.attemptId
      && scope.originToolCallId === identity.originToolCallId && scope.parentRequestId === identity.requestId
      && owner.plugin_agent_id === `durable-task:${identity.nativeToolTaskId}`);
    const origin = need(store.toolCalls.getById(identity.originToolCallId)), args = DelegateArgsSchema.parse(origin.args.final);
    requireFact(origin.runId === owner.run_id && origin.sessionId === identity.sessionId && origin.toolName === 'Agent'
      && origin.nativeToolCallId === owner.plugin_agent_id && args.subagent_type === SUBAGENT_ROLE);
    const saved = need(store.invoiceWorkContexts.get({ workId: identity.workId, attemptId: identity.attemptId, requestId: identity.requestId }));
    requireFact(saved && saved.context.work.sessionId === identity.sessionId && saved.context.phase.phaseId === scope.phaseId
      && saved.context.item.itemId === scope.itemId && saved.context.phase.requestId === scope.parentRequestId);
    if (live) need(store.runs.verifyDurableSubagentAdmission(run.runId));
    return { identity, run, scope, config, origin, args, context: saved.context };
  }
  function contextInStore(store: SqlDatabaseStore, identity: DurableSubagentIdentity): InvoiceWorkWorkingContext {
    const found = facts(store, identity, true);
    need(store.invoiceWorks.readContextInput({ workId: identity.workId, attemptId: identity.attemptId, requestId: identity.requestId,
      remainingBudget: found.context.actions.remainingBudget }));
    need(resolveInvoiceWorkToolScope(store.db, { runId: found.scope.parentRunId, sessionId: identity.sessionId,
      workId: identity.workId, attemptId: identity.attemptId, requestId: identity.requestId,
      child: { childRunId: identity.childRunId, childSessionId: identity.childSessionId, originToolCallId: identity.originToolCallId } }));
    const { context } = found;
    const original = context.instructions?.resources;
    let resources = null;
    if (original) {
      const raw = store.contents.read({ ownerKind: 'resource-bundle', ownerId: original.bundleId, relativePath: 'bundle.json' });
      requireFact(raw !== null, 'resource_bundle_unavailable', 'The original child Skill bundle is unavailable.');
      const bundle = ResourceBundleManifestSchema.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw)));
      requireFact(bundle.bundleId === original.bundleId, 'resource_bundle_unavailable');
      const visible = new Set(visibleFrozenSkills({ prompt: null, discoveredSkills: original.skills.map(body => body.ref), manifests: bundle.resources },
        found.scope.allowedTools).map(resourceRefKey));
      resources = { bundleId: original.bundleId, prompt: null, skills: original.skills.filter(body => visible.has(resourceRefKey(body.ref))) };
    }
    return InvoiceWorkWorkingContextSchema.parse({ ...context,
      instructions: { version: 1, provenance: 'phase-instructions', preferences: '', role: SUBAGENT_ROLE, resources },
      modelReports: [], historicalInputReferences: context.historicalInputReferences.map(({ content: _content, ...reference }) => reference),
      delegation: { childRunId: identity.childRunId, childSessionId: identity.childSessionId, parentRunId: found.scope.parentRunId,
        originToolCallId: identity.originToolCallId, role: SUBAGENT_ROLE, prompt: found.args.prompt, description: found.args.description },
      actions: { ...context.actions, tools: found.scope.allowedTools, available: [], remainingBudget: { ...context.actions.remainingBudget, childSlots: 0 } },
    });
  }
  async function recordObservation(raw: DurableSubagentObservation): Promise<void> {
    const identity = identityOf(raw);
    requireFact(['created', 'not-started', 'unknown'].includes(raw.creation) && ['active', 'closed', 'unknown'].includes(raw.execution));
    requireFact(raw.creation !== 'created' || id.safeParse(raw.nativeConversationId).success);
    if (raw.nativeSubmissionId !== null) id.parse(raw.nativeSubmissionId);
    if (raw.consumedAt !== null) time.parse(raw.consumedAt);
    await options.database.transaction(store => {
      const found = facts(store, identity), at = time.parse(options.now());
      if (raw.creation === 'created') need(store.sessions.bindDurableConversation(identity.childSessionId, raw.nativeConversationId!, at));
      if (raw.execution !== 'closed' || raw.creation === 'unknown') return;
      if (!active(found.run.status)) {
        need(store.runs.confirmDurableSubagentStop({ observation: raw, at })); return;
      }
      requireFact(raw.creation === 'not-started' ? raw.nativeConversationId === null && raw.nativeSubmissionId === null
        : raw.status === 'done' || raw.status === 'unanswered');
      const parent = store.db.query<{ stop_requested_at: string | null; status: string }, [number, number]>(`SELECT a.stop_requested_at,w.status
        FROM invoice_work_attempts a JOIN invoice_works w ON w.id=a.work_id WHERE a.work_id=? AND a.id=?`)
        .get(identity.workId, identity.attemptId);
      requireFact(parent);
      const cancelled = parent.stop_requested_at !== null || parent.status === 'cancelled' || found.run.cancelRequestedAt !== null;
      const status = cancelled ? 'cancelled' : raw.creation === 'created' && raw.status === 'done' ? 'completed' : 'failed';
      const error = status === 'completed' ? null : appError(cancelled ? 'agent_cancelled' : 'subagent_failed', 'runtime',
        raw.reason ?? (raw.creation === 'not-started' ? 'The original child was not started.' : 'The child returned no confirmed answer.'));
      const output = raw.answer === null ? null : DurableSubagentRunOutputSchema.parse({ version: 4, text: raw.answer,
        partial: status !== 'completed', stopReason: raw.reason ?? raw.status ?? raw.creation, responseId: null, responseModel: null,
        durable: { workId: identity.workId, attemptId: identity.attemptId }, subagent: found.config.subagent });
      requireFact(need(store.runs.finish(found.run.runId, { status, output, error, usage: found.run.usage, tokens: found.run.tokens,
        cleanup: { version: 1, stopped: true, stopReason: raw.reason ?? 'native-child-closed', errors: [], lateObservationRequired: false },
        endedAt: at, stoppedAt: at, durationMs: found.run.startedAt === null ? null : Math.max(0, Date.parse(at) - Date.parse(found.run.startedAt)) })),
      'operation_result_unknown', 'The original child result could not be confirmed.');
    });
    if (raw.parentToolResultEntryId !== null && raw.parentModelTaskId !== null && raw.parentModelReceivedAt !== null) {
      need(await callbacks.onParentConsumed({ ...identity, nativeToolResultEntryId: raw.parentToolResultEntryId,
        nativeModelTaskId: raw.parentModelTaskId, observedAt: raw.parentModelReceivedAt }));
    }
  }
  async function synchronize(identity: DurableSubagentIdentity) {
    const observation = need(await options.observeSubagent(identity));
    if (observation) {
      requireFact(isDeepStrictEqual(identityOf(observation), identityOf(identity))); await recordObservation(observation);
      if (observation.execution === 'closed' && observation.creatorExecution === 'closed' && observation.creation !== 'unknown') {
        await options.database.transaction(store => {
          const found = facts(store, identity);
          if (found.origin.result !== null) need(store.runs.confirmDurableDelegationStop({ observation, at: options.now() }));
        });
      }
    }
    return observation;
  }
  const callbacks: DurableSubagentCallbacks = {
    async readPlan(raw) {
      return operation(async () => options.database.read(store => {
        const identity = identityOf(raw), found = facts(store, identity);
        const binding = need(store.invoiceWorkModelBindings.get({ workId: identity.workId, attemptId: identity.attemptId }));
        requireFact(binding, 'personal_agent_model_unavailable', 'The original Work model binding is unavailable.');
        const work = store.db.query<{ configuration_json: string }, [number]>('SELECT configuration_json FROM invoice_works WHERE id=?').get(identity.workId);
        requireFact(work);
        return { ...identity, role: SUBAGENT_ROLE, binding: binding.binding,
          thinkingLevel: PersonalAgentConfigurationSchema.parse(JSON.parse(work.configuration_json)).thinkingLevel,
          prompt: found.args.prompt, systemPrompt: SUBAGENT_SYSTEM_PROMPT, allowedTools: [...found.scope.allowedTools] } satisfies DurableSubagentPlan;
      }));
    },
    async verify(raw) {
      return operation(async () => {
        const identity = identityOf(raw); await synchronize(identity);
        need(await options.governor.verifySubagentModelUse(identity));
        await options.database.read(store => { const found = facts(store, identity, true);
          if (found.run.status === 'running') contextInStore(store, identity); });
      });
    },
    async adopt(raw) {
      return operation(async () => options.database.transaction(store => {
        const identity = identityOf(raw), found = facts(store, identity, true), nativeConversationId = id.parse(raw.nativeConversationId), at = options.now();
        need(store.sessions.bindDurableConversation(identity.childSessionId, nativeConversationId, at));
        if (found.run.status === 'created') need(store.runs.start(identity.childRunId, found.config, at));
      }));
    },
    async reserveModelRequest(raw) { return operation(async () => { need(await options.governor.reserveSubagentModelRequest(identityOf(raw))); }); },
    async onParentConsumed(raw) {
      return operation(async () => options.database.transaction(store => {
        const found = facts(store, raw), nativeEntryId = id.parse(raw.nativeToolResultEntryId), modelTaskId = id.parse(raw.nativeModelTaskId), at = time.parse(raw.observedAt);
        const binding = store.db.query<{ feedback_native_entry_id: number | null; parent_received_model_task_id: number | null; parent_received_at: string | null }, [number, number]>(
          `SELECT feedback_native_entry_id,parent_received_model_task_id,parent_received_at FROM invoice_work_tool_calls WHERE tool_call_id=? AND phase_id=?`)
          .get(raw.originToolCallId, found.scope.phaseId);
        requireFact(binding && binding.feedback_native_entry_id === nativeEntryId && found.origin.result !== null,
          'source_invalid', 'The parent consumption does not name the original committed tool feedback.');
        if (binding.parent_received_model_task_id !== null) { requireFact(binding.parent_received_at !== null); return; }
        store.db.query('UPDATE invoice_work_tool_calls SET parent_received_model_task_id=?,parent_received_at=? WHERE tool_call_id=?')
          .run(modelTaskId, at, raw.originToolCallId);
      }));
    },
  };
  async function prepare(args: DelegateArgs, call: ToolCallContext, product: ProductToolContext) {
    return options.database.transaction(store => {
      requireFact(call.nativeDelegate && !call.signal.aborted);
      const resolved = need(verifyInvoiceWorkToolScope(store.db, product)), phase = product.scope.invoiceWork;
      requireFact(phase && args.subagent_type === SUBAGENT_ROLE && product.scope.allowedTools.includes('Agent'));
      const parent = need(store.runs.get(product.runId)), parentConfig = DurableRunConfigSnapshotSchema.parse(parent.config);
      const origin = need(store.toolCalls.get({ runId: product.runId, sessionId: product.sessionId, nativeToolCallId: call.nativeToolCallId }));
      const parsed = DelegateArgsSchema.parse(args), match = /^durable-task:([1-9]\d*)$/.exec(call.nativeToolCallId);
      requireFact(match && origin.toolName === 'Agent' && origin.status === 'running' && isDeepStrictEqual(origin.args.final, parsed));
      const nativeToolTaskId = id.parse(Number(match[1])), previous = need(store.runs.getByOriginToolCall(origin.toolCallId));
      if (!previous) need(options.governor.verifySubagentAdmissionInStore(store, { workId: phase.workId, sessionId: product.sessionId, attemptId: phase.attemptId }));
      const saved = need(store.invoiceWorkContexts.get({ workId: phase.workId, attemptId: phase.attemptId,
        requestId: store.db.query<{ request_id: string }, [number]>('SELECT request_id FROM invoice_work_phases WHERE id=?').get(phase.phaseId)!.request_id }));
      requireFact(saved);
      const provenance = { parentRunId: product.runId, originToolCallId: origin.toolCallId, phaseId: phase.phaseId, itemId: phase.itemId,
        parentRequestId: saved.context.phase.requestId, role: SUBAGENT_ROLE };
      const config = DurableSubagentConfigSnapshotSchema.parse({ ...parentConfig, version: 4, subagent: provenance });
      const scope = DurableSubagentRunScopeSchema.parse({ ...provenance, version: 5, workId: phase.workId, attemptId: phase.attemptId,
        allowedTools: resolved.scope.allowedTools.filter(name => (SUBAGENT_TOOL_NAMES as readonly string[]).includes(name)),
        allowedDocumentIds: resolved.scope.allowedDocumentIds, allowedArtifactIds: resolved.scope.allowedArtifactIds,
        allowedResourcePaths: resolved.scope.allowedResourcePaths });
      const child = need(store.runs.createDurableSubagent({ parentRunId: product.runId, originToolCallId: origin.toolCallId,
        nativeToolTaskId, args: parsed, scope, config, at: options.now() }));
      return { workId: phase.workId, sessionId: product.sessionId, attemptId: phase.attemptId, requestId: provenance.parentRequestId,
        childRunId: child.runId, childSessionId: child.sessionId, originToolCallId: origin.toolCallId, nativeToolTaskId };
    });
  }
  const tool: ToolDefinition<DelegateArgs, NativeToolOutput> = { name: 'Agent', version: '1.4.0-p18', label: 'Agent', effect: 'READ', executionMode: 'parallel',
    description: 'Delegate a bounded invoice evidence question to the existing read-only invoice-evidence-checker. Delegate only when specialist review, independent parallel work, or local context isolation offers a clear benefit; use tools directly for routine reading, arithmetic, and deterministic checks. Maximum four owned children; no nested delegation, background option or business writes.',
    inputSchema: DelegateArgsSchema, outputSchema: NativeToolOutputSchema,
    async execute(args, call, product) {
      const result = await operation(async () => {
        const identity = await prepare(args, call, product), previous = await synchronize(identity);
        if (previous?.execution === 'closed' && previous.creation !== 'unknown') return { identity, observation: previous, error: null };
        const plan = need(await callbacks.readPlan(identity));
        const returned = await call.nativeDelegate!(plan, call.signal);
        if (!returned.ok && returned.error.code === 'durable_delegation_suspended') throw new ChildFault(returned.error);
        if (!returned.ok) return { identity, observation: null, error: returned.error };
        requireFact(isDeepStrictEqual(identityOf(returned.data), identity)); await recordObservation(returned.data);
        return { identity, observation: returned.data, error: null };
      });
      if (!result.ok) throw new ToolExecutionFailure(result.error);
      const { identity, observation, error } = result.data;
      const outcome = observation?.creation === 'created' && observation.status === 'done' && observation.execution === 'closed' ? 'reported' : 'gap';
      const text = observation?.answer ?? `Evidence gap: ${error?.message ?? observation?.reason ?? 'The original child execution remains unconfirmed.'}`;
      return { content: [{ type: 'text', text }], details: { ...identity, role: SUBAGENT_ROLE, outcome,
        creation: observation?.creation ?? 'unknown', execution: observation?.execution ?? 'unknown', text,
        uncertainty: 'Child text is a model report. Source validity, parent consumption and business acceptance require their own evidence.' } };
    } };
  return { tool, callbacks,
    async readWorkingContext(query: DurableWorkingContextQuery): Promise<Result<InvoiceWorkWorkingContext>> {
      return operation(async () => {
        if (!query.child) return options.database.read(store => {
          const saved = need(store.invoiceWorkContexts.get({ workId: query.workId, attemptId: query.attemptId, requestId: query.requestId }));
          requireFact(saved && saved.context.work.sessionId === query.sessionId);
          need(store.invoiceWorks.readContextInput({ workId: query.workId, attemptId: query.attemptId, requestId: query.requestId,
            remainingBudget: saved.context.actions.remainingBudget }));
          const parent = store.db.query<{ run_id: number }, [number, number]>('SELECT run_id FROM invoice_work_attempts WHERE work_id=? AND id=?').get(query.workId, query.attemptId);
          requireFact(parent); need(resolveInvoiceWorkToolScope(store.db, { ...query, runId: parent.run_id })); return saved.context;
        });
        const identity = await options.database.read(store => {
          const child = need(store.runs.get(query.child!.childRunId)), scope = DurableSubagentRunScopeSchema.parse(child.scope);
          const call = need(store.toolCalls.getById(query.child!.originToolCallId));
          const task = /^durable-task:([1-9]\d*)$/.exec(call.nativeToolCallId); requireFact(task && scope.parentRequestId === query.requestId);
          return identityOf({ ...query, ...query.child!, nativeToolTaskId: Number(task[1]) });
        });
        need(await callbacks.verify(identity));
        const remaining = need(await options.governor.remainingBudget(query.workId));
        return options.database.read(store => { const context = contextInStore(store, identity);
          return InvoiceWorkWorkingContextSchema.parse({ ...context, actions: { ...context.actions, remainingBudget: { ...remaining, childSlots: 0 } } }); });
      });
    },
    async reconcileAttempt(identity: DurableAttemptIdentity): Promise<Result<void>> {
      return operation(async () => {
        const children = await options.database.transaction(store => {
          const parent = store.db.query<{ stop_requested_at: string | null; status: string }, [number, number, number]>(
            `SELECT a.stop_requested_at,w.status FROM invoice_work_attempts a JOIN invoice_works w ON w.id=a.work_id
             WHERE w.id=? AND a.id=? AND w.session_id=?`).get(identity.workId, identity.attemptId, identity.sessionId);
          requireFact(parent);
          const rows = store.db.query<{ id: number; session_id: number; origin_tool_call_id: number; plugin_agent_id: string; scope_json: string }, [number, number, number]>(
            `SELECT r.id,r.session_id,r.origin_tool_call_id,r.plugin_agent_id,r.scope_json FROM runs r
             JOIN invoice_work_attempts a ON a.run_id=r.parent_run_id JOIN invoice_works w ON w.id=a.work_id
             WHERE w.id=? AND a.id=? AND w.session_id=? AND r.kind='subagent' ORDER BY r.id`)
            .all(identity.workId, identity.attemptId, identity.sessionId);
          return rows.map(row => { const scope = DurableSubagentRunScopeSchema.parse(JSON.parse(row.scope_json));
            if (parent.stop_requested_at !== null || parent.status === 'cancelled') need(store.runs.recordCancel(row.id, options.now()));
            const task = /^durable-task:([1-9]\d*)$/.exec(row.plugin_agent_id); requireFact(task);
            return identityOf({ ...identity, requestId: scope.parentRequestId, childRunId: row.id, childSessionId: row.session_id,
              originToolCallId: row.origin_tool_call_id, nativeToolTaskId: Number(task[1]) }); });
        });
        for (const child of children) await synchronize(child);
      });
    } };
}
