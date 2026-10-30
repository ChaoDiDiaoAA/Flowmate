import { z } from 'zod';
import { isDeepStrictEqual } from 'node:util';
import { appError, fail, ok, PersonalAgentConfigurationSchema, InvoiceWorkContinueRequestSchema,
  type DurableModelBinding, type DurableRuntimePort, type DurableSubmissionQuery, type ProviderConfig, type Result } from '@flowmate/contracts';
import type { DbHandle } from '../storage/database.ts';

const id = InvoiceWorkContinueRequestSchema.shape.workId;
const querySchema = z.object({ workId: id, sessionId: id, attemptId: id,
  requestId: InvoiceWorkContinueRequestSchema.shape.requestId }).strict();
export type InvoiceWorkModelServiceOptions = {
  database: Pick<DbHandle, 'read' | 'transaction'>;
  runtime: Pick<DurableRuntimePort, 'prepareModel' | 'restoreModel'>;
  resolveConfiguration: (modelId: string) => Result<ProviderConfig> | Promise<Result<ProviderConfig>>;
  now: () => string;
};

/** Resolve once; later attempts and native recovery reuse committed model facts, never latest files. */
export class InvoiceWorkModelService {
  private readonly preparing = new Map<string, Promise<Result<DurableModelBinding>>>();
  constructor(private readonly options: InvoiceWorkModelServiceOptions) {}

  async prepare(raw: DurableSubmissionQuery): Promise<Result<DurableModelBinding>> {
    const input = querySchema.safeParse(raw);
    if (!input.success) return fail(appError('input_invalid', 'input', 'The model preparation identity is invalid.'));
    const key = JSON.stringify([input.data.workId, input.data.sessionId, input.data.attemptId]);
    let pending = this.preparing.get(key);
    if (!pending) {
      pending = this.prepareOnce(input.data).finally(() => this.preparing.delete(key));
      this.preparing.set(key, pending);
    }
    return structuredClone(await pending);
  }

  private async prepareOnce(query: DurableSubmissionQuery): Promise<Result<DurableModelBinding>> {
    try {
      const source = await this.options.database.read(scope => {
        const task = scope.invoiceWorkAttempts.get({ workId: query.workId, attemptId: query.attemptId });
        if (!task.ok) return task;
        if (task.data.task.sessionId !== query.sessionId || task.data.task.stopRequestedAt !== null || task.data.task.stoppedAt !== null)
          return fail(appError('state_conflict', 'runtime', 'The model attempt is not available for preparation.'));
        const original = scope.invoiceWorkModelBindings.get({ workId: query.workId, attemptId: query.attemptId });
        if (!original.ok) return original;
        const first = original.data ? original : scope.invoiceWorkModelBindings.getOriginal({ workId: query.workId });
        if (!first.ok) return first;
        const row = scope.db.query<{ configuration_json: string; status: string; current_attempt_id: number | null }, [number]>(
          'SELECT configuration_json,status,current_attempt_id FROM invoice_works WHERE id=?').get(query.workId);
        if (!row || row.status !== 'open' || row.current_attempt_id !== query.attemptId)
          return fail(appError('state_conflict', 'runtime', 'The model preparation no longer belongs to the current work attempt.'));
        const configuration = PersonalAgentConfigurationSchema.parse(JSON.parse(row.configuration_json));
        if (configuration.modelId === null) return fail(appError('provider_model_not_found', 'input', 'The invoice work has no explicitly selected model.'));
        return ok({ modelId: configuration.modelId, saved: original.data !== null, binding: first.data?.binding ?? null });
      });
      if (!source.ok) return source;
      if (source.data.saved && source.data.binding) return ok(source.data.binding);
      let binding = source.data.binding;
      if (binding === null) {
        const config = await this.options.resolveConfiguration(source.data.modelId);
        if (!config.ok) return config;
        const prepared = await this.options.runtime.prepareModel({ ...query, config: structuredClone(config.data) });
        if (!prepared.ok) return prepared;
        binding = prepared.data;
      }
      const captured = binding;
      try {
        const saved = await this.options.database.transaction(scope => scope.invoiceWorkModelBindings.save({ workId: query.workId,
          attemptId: query.attemptId, modelId: source.data.modelId, binding: captured, at: this.options.now() }));
        return saved.ok ? ok(saved.data.binding) : saved;
      } catch {
        const recovered = await this.options.database.read(scope => scope.invoiceWorkModelBindings.get({ workId: query.workId,
          attemptId: query.attemptId }));
        return recovered.ok && recovered.data && recovered.data.modelId === source.data.modelId
          && isDeepStrictEqual(recovered.data.binding, captured) ? ok(recovered.data.binding)
          : fail(appError('operation_result_unknown', 'storage', 'The original model binding commit could not be confirmed.', true));
      }
    } catch { return fail(appError('provider_model_configuration_unavailable', 'runtime', 'The original invoice model configuration is unavailable.', true)); }
  }

  async restore(raw: DurableSubmissionQuery): Promise<Result<void>> {
    const input = querySchema.safeParse(raw);
    if (!input.success) return fail(appError('input_invalid', 'input', 'The model restoration identity is invalid.'));
    try {
      const original = await this.options.database.read(scope => {
        const task = scope.invoiceWorkAttempts.get({ workId: input.data.workId, attemptId: input.data.attemptId });
        if (!task.ok) return task;
        if (task.data.task.sessionId !== input.data.sessionId) return fail(appError('source_invalid', 'runtime', 'The model belongs to another Session.'));
        return scope.invoiceWorkModelBindings.get({ workId: input.data.workId, attemptId: input.data.attemptId });
      });
      if (!original.ok) return original;
      if (!original.data) return fail(appError('provider_model_configuration_unavailable', 'runtime', 'The submitted phase has no original model binding.'));
      return await this.options.runtime.restoreModel({ ...input.data, binding: original.data.binding });
    } catch { return fail(appError('provider_model_configuration_unavailable', 'runtime', 'The original model binding could not be restored.', true)); }
  }
}
