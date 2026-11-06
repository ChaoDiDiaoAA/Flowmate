import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { appError, CloudWorkspaceIdSchema, fail, ok, InvoiceWorkCreateRequestSchema, InvoiceWorkContinueRequestSchema,
  InvoiceWorkSupplementRequestSchema, InvoiceWorkDisposeItemRequestSchema, InvoiceWorkCancelRequestSchema,
  InvoiceWorkListRequestSchema, InvoiceWorkGetRequestSchema, InvoiceWorkQueryOperationRequestSchema,
  DesktopActionDecisionQuerySchema, DesktopActionDecisionRequestSchema, DesktopActionListRequestSchema, DesktopActionDiscardSchema,
  DurableModelBindingSchema, RuntimeRequestOverridesSchema } from '@flowmate/contracts';
import type { InvoiceWorksApi, InvoiceWorkCreateRequest, InvoiceWorkContinueRequest, InvoiceWorkSupplementRequest,
  InvoiceWorkDisposeItemRequest, InvoiceWorkCancelRequest, InvoiceWorkListRequest, InvoiceWorkGetRequest,
  InvoiceWorkQueryOperationRequest, InvoiceWorkOperationReceipt, InvoiceWorkCreateReceipt, InvoiceWorkContinueReceipt,
  InvoiceWorkSupplementReceipt, InvoiceWorkDisposeItemReceipt, InvoiceWorkCancelReceipt, InvoiceWorkListResult,
  InvoiceWorkGetResult, DurableModelBinding, PersonalAgentConfiguration, RuntimeRequestOverrides,
  InvoiceWorkTimelineRequest, InvoiceWorkTimelinePage, DesktopActionDecisionQuery, DesktopActionDecisionReceipt,
  DesktopActionDecisionRequest, DesktopActionListRequest, DesktopActionListResult, DesktopActionDiscard, DesktopActionView, Result } from '@flowmate/contracts';
import type { DbHandle, SqlDatabaseStore } from '../storage/database.ts';
import type { InvoiceWorkAdmission, InvoiceWorkRepository } from './repository.ts';
import { createInvoiceWorkTimelineService } from './timeline.ts';

export type InvoiceWorkExecutionCommand = { kind: 'create'; request: InvoiceWorkCreateRequest; runtimeOwner?: { workspaceId: string; cloudRuntimeId: string } }
  | { kind: 'continueWork'; request: InvoiceWorkContinueRequest }
  | { kind: 'supplement'; request: InvoiceWorkSupplementRequest };
export type InvoiceWorkServiceOptions = {
  database: Pick<DbHandle, 'read' | 'transaction'>;
  now: () => string;
  runtimeDefaults?: () => Result<RuntimeRequestOverrides>;
  cloudWorkspaceId?: string;
  captureModel?: (configuration: PersonalAgentConfiguration) => Result<DurableModelBinding | null> | Promise<Result<DurableModelBinding | null>>;
  assessExecution: (command: InvoiceWorkExecutionCommand) => Result<InvoiceWorkAdmission> | Promise<Result<InvoiceWorkAdmission>>;
  /** Signal persisted facts; the coordinator must recheck authorization before dispatch. */
  onChanged: (receipt: InvoiceWorkOperationReceipt) => void;
  onDesktopChanged?: () => void;
};

const invalid = () => fail(appError('input_invalid', 'input', 'Invoice Work request is invalid.'));
const writeFailure = () => fail(appError('storage_write_failed', 'storage', 'Invoice Work operation could not be confirmed.', true));
const forbidden = () => fail(appError('cloud_workspace_forbidden', 'input', 'The Work does not belong to this cloud workspace.'));
const replayAdmission: InvoiceWorkAdmission = { kind: 'waiting', reason: 'Only the original operation receipt is being recovered.' };

export class InvoiceWorkService implements InvoiceWorksApi {
  private readonly cloudWorkspaceId: string | undefined;
  public constructor(private readonly options: InvoiceWorkServiceOptions) {
    this.cloudWorkspaceId = options.cloudWorkspaceId === undefined ? undefined : CloudWorkspaceIdSchema.parse(options.cloudWorkspaceId);
  }

  private allowed(scope: SqlDatabaseStore, workId: number): boolean {
    if (!this.cloudWorkspaceId) return true;
    return scope.db.query(`SELECT w.id FROM invoice_works w JOIN sessions s ON s.id=w.session_id
      WHERE w.id=? AND s.durable_runtime_id!='local' AND s.cloud_workspace_id=?`).get(workId, this.cloudWorkspaceId) !== null;
  }

  private allowedDesktop(scope: SqlDatabaseStore, workId: number): boolean {
    return this.cloudWorkspaceId ? this.allowed(scope, workId) : scope.db.query(`SELECT w.id FROM invoice_works w
      JOIN sessions s ON s.id=w.session_id WHERE w.id=? AND s.runtime_kind='durable' AND s.durable_runtime_id='local'`).get(workId) !== null;
  }

  public async timeline(input: InvoiceWorkTimelineRequest): Promise<Result<InvoiceWorkTimelinePage>> {
    if (this.cloudWorkspaceId) {
      try { if (!await this.options.database.read(scope => this.allowed(scope, input.workId))) return forbidden(); }
      catch { return fail(appError('storage_read_failed', 'storage', 'Invoice Work state could not be read.', true)); }
    }
    return createInvoiceWorkTimelineService({ database: this.options.database }).timeline(input);
  }

  private async read<T>(operation: (repository: InvoiceWorkRepository) => Result<T>, workId?: number): Promise<Result<T>> {
    try { return await this.options.database.read(scope => workId !== undefined && !this.allowed(scope, workId) ? forbidden() : operation(scope.invoiceWorks)); }
    catch { return fail(appError('storage_read_failed', 'storage', 'Invoice Work state could not be read.', true)); }
  }

  private async command<T extends InvoiceWorkOperationReceipt>(key: InvoiceWorkQueryOperationRequest,
    write: (repository: InvoiceWorkRepository, at: string, admission: InvoiceWorkAdmission, runtimeDefaults: RuntimeRequestOverrides | undefined,
      scope: SqlDatabaseStore) => Result<T>,
    execution?: InvoiceWorkExecutionCommand): Promise<Result<T>> {
    const original = await this.read(repository => repository.queryOperation(key), key.operation === 'create' ? undefined : key.workId);
    if (!original.ok) return original;
    let admission: InvoiceWorkAdmission = replayAdmission;
    let captured: { modelId: string; binding: DurableModelBinding } | undefined;
    if (original.data === null && execution) {
      let captureFailure = false;
      if (execution.kind === 'create' && this.options.captureModel) {
        const configuration = await this.options.database.read(scope => {
          const agent = scope.personalAgents.getDefault(); if (!agent.ok) return agent;
          if (agent.data === null || agent.data.personalAgentId !== execution.request.personalAgentId)
            return fail(appError('personal_agent_not_found', 'input', 'The original Personal Agent does not exist.'));
          if (agent.data.revision !== execution.request.expectedAgentRevision)
            return fail(appError('state_conflict', 'input', 'The Personal Agent revision changed. Refresh before creating this work.'));
          return ok(agent.data.configuration);
        }).catch(() => fail(appError('storage_read_failed', 'storage', 'The original Personal Agent configuration could not be read.', true)));
        if (!configuration.ok) return configuration;
        try {
          const prepared = await this.options.captureModel(structuredClone(configuration.data));
          const binding = prepared.ok && prepared.data !== null ? DurableModelBindingSchema.safeParse(prepared.data) : null;
          if (configuration.data.modelId !== null && binding?.success) captured = { modelId: configuration.data.modelId, binding: binding.data };
          else {
            captureFailure = true;
            admission = { kind: 'blocked', reason: !prepared.ok ? prepared.error
              : appError('original_model_binding_unavailable', 'input', 'The original selected model configuration could not be captured.') };
          }
        } catch {
          captureFailure = true;
          admission = { kind: 'blocked', reason: appError('original_model_binding_unavailable', 'runtime',
            'The original selected model configuration could not be captured.', true) };
        }
      }
      if (!captureFailure) try {
        const assessment = await this.options.assessExecution(structuredClone(execution));
        admission = assessment.ok ? assessment.data : { kind: 'blocked', reason: assessment.error };
      } catch { admission = { kind: 'blocked',
        reason: appError('invoice_work_assessment_unavailable', 'runtime', 'Execution qualification could not be checked.', true) }; }
    }
    let rejected: Result<never> | undefined;
    try {
      const saved = await this.options.database.transaction(scope => {
        if (key.operation !== 'create' && !this.allowed(scope, key.workId)) { rejected = forbidden(); throw Error('cloud_workspace_forbidden'); }
        const prior = scope.invoiceWorks.queryOperation(key);
        if (!prior.ok) { rejected = prior; throw Error('invoice_work_command_rejected'); }
        const replayed = prior.data !== null;
        let runtimeDefaults: RuntimeRequestOverrides | undefined;
        if (!replayed && execution?.kind === 'create') {
          // Read settings after asynchronous qualification, in the same owner transaction as Work acceptance.
          const configured = this.options.runtimeDefaults?.() ?? ok({});
          if (!configured.ok) { rejected = configured; throw Error('invoice_work_defaults_rejected'); }
          const parsed = RuntimeRequestOverridesSchema.safeParse(configured.data);
          if (!parsed.success) {
            rejected = fail(appError('config_settings_invalid', 'input', 'Runtime defaults are invalid.'));
            throw Error('invoice_work_defaults_rejected');
          }
          runtimeDefaults = parsed.data;
        }
        const result = write(scope.invoiceWorks, this.options.now(), replayed ? replayAdmission : admission, runtimeDefaults, scope);
        if (!result.ok) { rejected = result; throw Error('invoice_work_command_rejected'); }
        if (!replayed) {
          if (captured && result.data.operation === 'create') {
            const binding = scope.invoiceWorkModelBindings.save({ workId: result.data.workId,
              ...(result.data.execution.attempt ? { attemptId: result.data.execution.attempt.attemptId } : {}),
              ...captured, at: result.data.receivedAt });
            if (!binding.ok) { rejected = binding; throw Error('invoice_work_model_capture_rejected'); }
          }
          if (!scope.db.afterCommit) throw Error('invoice_work_commit_callback_unavailable');
          scope.db.afterCommit(() => {
            try { this.options.onChanged(structuredClone(result.data)); }
            catch { /* The committed receipt remains available for coordinator reconciliation. */ }
          });
        }
        return { receipt: result.data, replayed };
      });
      return ok(saved.receipt);
    } catch {
      if (rejected) return rejected;
      try {
        return await this.options.database.transaction(scope => {
          const prior = scope.invoiceWorks.queryOperation(key);
          if (!prior.ok || prior.data === null) return writeFailure();
          if (key.operation !== 'create' && !this.allowed(scope, key.workId)) return forbidden();
          return write(scope.invoiceWorks, this.options.now(), replayAdmission, undefined, scope);
        });
      } catch { return writeFailure(); }
    }
  }

  public async create(input: InvoiceWorkCreateRequest): Promise<Result<InvoiceWorkCreateReceipt>> {
    const parsed = InvoiceWorkCreateRequestSchema.safeParse(input);
    if (!parsed.success) return invalid();
    const key = { operation: 'create' as const, personalAgentId: parsed.data.personalAgentId, requestId: parsed.data.requestId };
    const proposedOwner = this.cloudWorkspaceId ? { workspaceId: this.cloudWorkspaceId, cloudRuntimeId: randomUUID() } : undefined;
    return this.command(key, (repository, at, admission, runtimeDefaults, scope) => {
      let runtimeOwner: { workspaceId: string; cloudRuntimeId: string } | undefined;
      if (this.cloudWorkspaceId) {
        const prior = repository.queryOperation(key); if (!prior.ok) return prior;
        if (prior.data) {
          if (prior.data.operation !== 'create' || !this.allowed(scope, prior.data.workId)) return forbidden();
          const session = scope.sessions.get(prior.data.sessionId); if (!session.ok) return session;
          if (session.data.runtimeKind !== 'durable' || session.data.durableRuntimeId === 'local') return forbidden();
          runtimeOwner = { workspaceId: this.cloudWorkspaceId, cloudRuntimeId: session.data.durableRuntimeId };
        } else {
          if (parsed.data.documents.some(ref => !scope.db.query(`SELECT d.id FROM cloud_workspace_documents m JOIN documents d
            ON d.id=m.document_id AND d.version=m.document_version WHERE m.workspace_id=? AND m.document_id=? AND m.document_version=?
            AND d.status='available' AND d.hidden_at IS NULL`).get(this.cloudWorkspaceId!, ref.id, ref.version))) return forbidden();
          runtimeOwner = proposedOwner;
        }
      }
      return repository.create(parsed.data, { at, admission, runtimeDefaults, runtimeOwner });
    }, { kind: 'create', request: parsed.data, ...(proposedOwner ? { runtimeOwner: proposedOwner } : {}) });
  }

  public async continueWork(input: InvoiceWorkContinueRequest): Promise<Result<InvoiceWorkContinueReceipt>> {
    const parsed = InvoiceWorkContinueRequestSchema.safeParse(input);
    if (!parsed.success) return invalid();
    return this.command({ operation: 'continueWork', workId: parsed.data.workId, requestId: parsed.data.requestId },
      (repository, at, admission) => repository.continueWork(parsed.data, { at, admission }), { kind: 'continueWork', request: parsed.data });
  }

  public async supplement(input: InvoiceWorkSupplementRequest): Promise<Result<InvoiceWorkSupplementReceipt>> {
    const parsed = InvoiceWorkSupplementRequestSchema.safeParse(input);
    if (!parsed.success) return invalid();
    return this.command({ operation: 'supplement', workId: parsed.data.workId, requestId: parsed.data.requestId },
      (repository, at, admission) => repository.supplement(parsed.data, { at, admission }), { kind: 'supplement', request: parsed.data });
  }

  public async disposeItem(input: InvoiceWorkDisposeItemRequest): Promise<Result<InvoiceWorkDisposeItemReceipt>> {
    const parsed = InvoiceWorkDisposeItemRequestSchema.safeParse(input);
    if (!parsed.success) return invalid();
    return this.command({ operation: 'disposeItem', workId: parsed.data.workId, requestId: parsed.data.requestId },
      (repository, at) => repository.disposeItem(parsed.data, { at }));
  }

  public async cancelWork(input: InvoiceWorkCancelRequest): Promise<Result<InvoiceWorkCancelReceipt>> {
    const parsed = InvoiceWorkCancelRequestSchema.safeParse(input);
    if (!parsed.success) return invalid();
    return this.command({ operation: 'cancelWork', workId: parsed.data.workId, requestId: parsed.data.requestId },
      (repository, at) => repository.cancelWork(parsed.data, { at }));
  }

  public async listDesktopActions(input: DesktopActionListRequest): Promise<Result<DesktopActionListResult>> {
    const parsed = DesktopActionListRequestSchema.safeParse(input); if (!parsed.success) return invalid();
    try { return await this.options.database.read(scope => this.allowedDesktop(scope, parsed.data.workId)
      ? scope.invoiceWorkDesktopActions.list(parsed.data) : forbidden()); }
    catch { return fail(appError('storage_read_failed', 'storage', 'Desktop action state could not be read.', true)); }
  }

  public async queryDesktopDecision(input: DesktopActionDecisionQuery): Promise<Result<DesktopActionDecisionReceipt | null>> {
    const parsed = DesktopActionDecisionQuerySchema.safeParse(input); if (!parsed.success) return invalid();
    try { return await this.options.database.read(scope => this.allowedDesktop(scope, parsed.data.workId)
      ? scope.invoiceWorkDesktopActions.queryDecision(parsed.data) : forbidden()); }
    catch { return fail(appError('storage_read_failed', 'storage', 'The original desktop decision could not be read.', true)); }
  }

  public async discardDesktopAction(input: DesktopActionDiscard): Promise<Result<DesktopActionView>> {
    const parsed = DesktopActionDiscardSchema.safeParse(input); if (!parsed.success) return invalid();
    try {
      return await this.options.database.transaction(scope => {
        if (!this.allowedDesktop(scope, parsed.data.workId)) return forbidden();
        const local = scope.invoiceWorkDesktopActions.list({ workId: parsed.data.workId, itemId: parsed.data.itemId, limit: 1 }); if (!local.ok) return local;
        const work = scope.invoiceWorks.get({ view: 'item', workId: parsed.data.workId, itemId: parsed.data.itemId });
        if (!work.ok) return work;
        if (work.data.view !== 'item' || work.data.work.status !== 'open' || work.data.item.disposition !== 'unresolved')
          return fail(appError('state_conflict', 'input', 'The original invoice is no longer open.'));
        const result = scope.invoiceWorkDesktopActions.invalidate({ ...parsed.data, at: this.options.now() });
        if (result.ok && this.options.onDesktopChanged) {
          if (!scope.db.afterCommit) throw Error('desktop_action_commit_callback_unavailable');
          scope.db.afterCommit(() => { try { this.options.onDesktopChanged?.(); } catch { /* The saved state remains queryable. */ } });
        }
        return result;
      });
    } catch { return writeFailure(); }
  }

  public async decideDesktopAction(input: DesktopActionDecisionRequest): Promise<Result<DesktopActionDecisionReceipt>> {
    const parsed = DesktopActionDecisionRequestSchema.safeParse(input); if (!parsed.success) return invalid();
    const request = parsed.data, query = { workId: request.workId, itemId: request.itemId,
      proposalId: request.proposalId, requestId: request.requestId };
    try {
      return await this.options.database.transaction(scope => {
        if (!this.allowedDesktop(scope, request.workId)) return forbidden();
        const prior = scope.invoiceWorkDesktopActions.queryDecision(query); if (!prior.ok) return prior;
        const result = scope.invoiceWorkDesktopActions.decide(request, this.options.now());
        if (result.ok && prior.data === null && this.options.onDesktopChanged) {
          if (!scope.db.afterCommit) throw Error('desktop_action_commit_callback_unavailable');
          scope.db.afterCommit(() => { try { this.options.onDesktopChanged?.(); } catch { /* The decision remains queryable. */ } });
        }
        return result;
      });
    } catch {
      const recovered = await this.queryDesktopDecision(query);
      if (!recovered.ok || recovered.data === null) return writeFailure();
      const { revision: _revision, receivedAt: _receivedAt, ...original } = recovered.data;
      return isDeepStrictEqual(original, request) ? ok(recovered.data)
        : fail(appError('state_conflict', 'input', 'The original desktop decision belongs to a different request.'));
    }
  }

  public async list(input: InvoiceWorkListRequest): Promise<Result<InvoiceWorkListResult>> {
    const parsed = InvoiceWorkListRequestSchema.safeParse(input);
    return parsed.success ? this.read(repository => repository.list(parsed.data, this.cloudWorkspaceId ? { cloudWorkspaceId: this.cloudWorkspaceId } : undefined)) : invalid();
  }

  public async get(input: InvoiceWorkGetRequest): Promise<Result<InvoiceWorkGetResult>> {
    const parsed = InvoiceWorkGetRequestSchema.safeParse(input);
    return parsed.success ? this.read(repository => repository.get(parsed.data), parsed.data.workId) : invalid();
  }

  public async queryOperation(input: InvoiceWorkQueryOperationRequest): Promise<Result<InvoiceWorkOperationReceipt | null>> {
    const parsed = InvoiceWorkQueryOperationRequestSchema.safeParse(input);
    if (!parsed.success) return invalid();
    try {
      return await this.options.database.read(scope => {
        if (parsed.data.operation !== 'create' && !this.allowed(scope, parsed.data.workId)) return forbidden();
        const result = scope.invoiceWorks.queryOperation(parsed.data);
        return result.ok && result.data && !this.allowed(scope, result.data.workId) ? ok(null) : result;
      });
    } catch { return fail(appError('storage_read_failed', 'storage', 'Invoice Work state could not be read.', true)); }
  }
}
