import { appError, fail, ok, InvoiceWorkCreateRequestSchema, InvoiceWorkContinueRequestSchema,
  InvoiceWorkSupplementRequestSchema, InvoiceWorkDisposeItemRequestSchema, InvoiceWorkCancelRequestSchema,
  InvoiceWorkListRequestSchema, InvoiceWorkGetRequestSchema, InvoiceWorkQueryOperationRequestSchema,
  DurableModelBindingSchema, RuntimeRequestOverridesSchema } from '@flowmate/contracts';
import type { InvoiceWorksApi, InvoiceWorkCreateRequest, InvoiceWorkContinueRequest, InvoiceWorkSupplementRequest,
  InvoiceWorkDisposeItemRequest, InvoiceWorkCancelRequest, InvoiceWorkListRequest, InvoiceWorkGetRequest,
  InvoiceWorkQueryOperationRequest, InvoiceWorkOperationReceipt, InvoiceWorkCreateReceipt, InvoiceWorkContinueReceipt,
  InvoiceWorkSupplementReceipt, InvoiceWorkDisposeItemReceipt, InvoiceWorkCancelReceipt, InvoiceWorkListResult,
  InvoiceWorkGetResult, DurableModelBinding, PersonalAgentConfiguration, RuntimeRequestOverrides,
  InvoiceWorkTimelineRequest, InvoiceWorkTimelinePage, Result } from '@flowmate/contracts';
import type { DbHandle } from '../storage/database.ts';
import type { InvoiceWorkAdmission, InvoiceWorkRepository } from './repository.ts';
import { createInvoiceWorkTimelineService } from './timeline.ts';

export type InvoiceWorkExecutionCommand = { kind: 'create'; request: InvoiceWorkCreateRequest }
  | { kind: 'continueWork'; request: InvoiceWorkContinueRequest }
  | { kind: 'supplement'; request: InvoiceWorkSupplementRequest };
export type InvoiceWorkServiceOptions = {
  database: Pick<DbHandle, 'read' | 'transaction'>;
  now: () => string;
  runtimeDefaults?: () => Result<RuntimeRequestOverrides>;
  captureModel?: (configuration: PersonalAgentConfiguration) => Result<DurableModelBinding | null> | Promise<Result<DurableModelBinding | null>>;
  assessExecution: (command: InvoiceWorkExecutionCommand) => Result<InvoiceWorkAdmission> | Promise<Result<InvoiceWorkAdmission>>;
  /** Signal persisted facts; the coordinator must recheck authorization before dispatch. */
  onChanged: (receipt: InvoiceWorkOperationReceipt) => void;
};

const invalid = () => fail(appError('input_invalid', 'input', 'Invoice Work request is invalid.'));
const writeFailure = () => fail(appError('storage_write_failed', 'storage', 'Invoice Work operation could not be confirmed.', true));
const replayAdmission: InvoiceWorkAdmission = { kind: 'waiting', reason: 'Only the original operation receipt is being recovered.' };

export class InvoiceWorkService implements InvoiceWorksApi {
  public constructor(private readonly options: InvoiceWorkServiceOptions) {}

  public timeline(input: InvoiceWorkTimelineRequest): Promise<Result<InvoiceWorkTimelinePage>> {
    return createInvoiceWorkTimelineService({ database: this.options.database }).timeline(input);
  }

  private async read<T>(operation: (repository: InvoiceWorkRepository) => Result<T>): Promise<Result<T>> {
    try { return await this.options.database.read(scope => operation(scope.invoiceWorks)); }
    catch { return fail(appError('storage_read_failed', 'storage', 'Invoice Work state could not be read.', true)); }
  }

  private async command<T extends InvoiceWorkOperationReceipt>(key: InvoiceWorkQueryOperationRequest,
    write: (repository: InvoiceWorkRepository, at: string, admission: InvoiceWorkAdmission, runtimeDefaults?: RuntimeRequestOverrides) => Result<T>,
    execution?: InvoiceWorkExecutionCommand): Promise<Result<T>> {
    const original = await this.read(repository => repository.queryOperation(key));
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
        const result = write(scope.invoiceWorks, this.options.now(), replayed ? replayAdmission : admission, runtimeDefaults);
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
          return write(scope.invoiceWorks, this.options.now(), replayAdmission);
        });
      } catch { return writeFailure(); }
    }
  }

  public async create(input: InvoiceWorkCreateRequest): Promise<Result<InvoiceWorkCreateReceipt>> {
    const parsed = InvoiceWorkCreateRequestSchema.safeParse(input);
    if (!parsed.success) return invalid();
    return this.command({ operation: 'create', personalAgentId: parsed.data.personalAgentId, requestId: parsed.data.requestId },
      (repository, at, admission, runtimeDefaults) => repository.create(parsed.data, { at, admission, runtimeDefaults }), { kind: 'create', request: parsed.data });
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

  public async list(input: InvoiceWorkListRequest): Promise<Result<InvoiceWorkListResult>> {
    const parsed = InvoiceWorkListRequestSchema.safeParse(input);
    return parsed.success ? this.read(repository => repository.list(parsed.data)) : invalid();
  }

  public async get(input: InvoiceWorkGetRequest): Promise<Result<InvoiceWorkGetResult>> {
    const parsed = InvoiceWorkGetRequestSchema.safeParse(input);
    return parsed.success ? this.read(repository => repository.get(parsed.data)) : invalid();
  }

  public async queryOperation(input: InvoiceWorkQueryOperationRequest): Promise<Result<InvoiceWorkOperationReceipt | null>> {
    const parsed = InvoiceWorkQueryOperationRequestSchema.safeParse(input);
    return parsed.success ? this.read(repository => repository.queryOperation(parsed.data)) : invalid();
  }
}
