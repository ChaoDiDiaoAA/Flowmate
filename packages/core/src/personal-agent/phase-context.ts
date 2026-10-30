import { z } from 'zod';
import { isDeepStrictEqual } from 'node:util';
import { appError, fail, ok, InvoiceWorkContextBuildInputSchema, InvoiceWorkContinueRequestSchema,
  InvoiceWorkPhaseBasisSchema, type DurableSubmissionQuery, type InvoiceWorkContextBuildInput,
  type InvoiceWorkWorkingContext, type DurableRuntimePort, type Result } from '@flowmate/contracts';
import type { DbHandle, SqlDatabaseStore } from '../storage/database.ts';
import type { InvoiceWorkPhase } from './repository.ts';
import type { InvoiceWorkPhaseInstructions } from '../../../contracts/src/personal-context.ts';

const id = InvoiceWorkContinueRequestSchema.shape.workId;
const requestId = InvoiceWorkContinueRequestSchema.shape.requestId;
const phaseKey = z.object({ workId: id, attemptId: id, requestId }).strict();
const querySchema = phaseKey.extend({ sessionId: id });
const freezeSchema = phaseKey.extend({ itemId: id, kind: z.literal('prompt'), basis: InvoiceWorkPhaseBasisSchema,
  remainingBudget: InvoiceWorkContextBuildInputSchema.unwrap().shape.remainingBudget });
export type InvoiceWorkFreezeContextRequest = z.infer<typeof freezeSchema>;
export type InvoiceWorkContextSnapshot = { contextId: number; context: InvoiceWorkWorkingContext };
export type InvoiceWorkPhaseContextOptions = {
  database: Pick<DbHandle, 'read' | 'transaction'>;
  now: () => string;
  buildContext: (input: InvoiceWorkContextBuildInput) => Result<InvoiceWorkWorkingContext>;
  prepareInstructions?: (input: InvoiceWorkContextBuildInput, store: SqlDatabaseStore) => Result<InvoiceWorkPhaseInstructions>;
};
const invalid = () => fail(appError('input_invalid', 'input', 'The invoice phase request is invalid.'));
const missing = () => fail(appError('state_conflict', 'runtime', 'The original invoice phase context is unavailable.'));

/** Product transaction first; the native runtime reads the saved phase through get/verify. */
export class InvoiceWorkPhaseContextService {
  constructor(private readonly options: InvoiceWorkPhaseContextOptions) {}

  /** The Coordinator checks admission and freezes the original phase in this same owner transaction. */
  freezeInStore(scope: SqlDatabaseStore, raw: InvoiceWorkFreezeContextRequest): Result<InvoiceWorkContextSnapshot> {
    const parsed = freezeSchema.safeParse(raw);
    if (!parsed.success) return invalid();
    const { remainingBudget, ...input } = parsed.data;
    const phase = scope.invoiceWorks.freezePhase({ ...input, at: this.options.now() });
    if (!phase.ok) return phase;
    const original = scope.invoiceWorkContexts.get({ workId: input.workId, attemptId: input.attemptId, requestId: input.requestId });
    if (!original.ok) return original;
    if (original.data) return ok(original.data);
    const basis = scope.invoiceWorks.readContextInput({ ...input, remainingBudget });
    if (!basis.ok) return basis;
    const context = this.options.buildContext(basis.data);
    if (!context.ok) return context;
    const instructions = this.options.prepareInstructions?.(basis.data, scope);
    if (instructions && !instructions.ok) return instructions;
    return scope.invoiceWorkContexts.save({ context: instructions?.ok
      ? { ...context.data, instructions: instructions.data } : context.data, at: this.options.now() });
  }

  async freeze(raw: InvoiceWorkFreezeContextRequest): Promise<Result<InvoiceWorkContextSnapshot>> {
    const parsed = freezeSchema.safeParse(raw);
    if (!parsed.success) return invalid();
    const { remainingBudget, ...input } = parsed.data;
    let rejected: Result<never> | undefined;
    try {
      return await this.options.database.transaction(scope => {
        const saved = this.freezeInStore(scope, { ...input, remainingBudget });
        if (!saved.ok) { rejected = saved; throw Error('invoice_context_save_failed'); }
        return saved;
      });
    } catch {
      if (rejected) return rejected;
      // A lost response after COMMIT must recover this exact phase instead of rebuilding it.
      return this.recoverFrozen(parsed.data);
    }
  }

  async recoverFrozen(raw: InvoiceWorkFreezeContextRequest): Promise<Result<InvoiceWorkContextSnapshot>> {
    const parsed = freezeSchema.safeParse(raw);
    if (!parsed.success) return invalid();
    const input = parsed.data;
    try {
      return await this.options.database.read(scope => {
        const original = scope.invoiceWorkContexts.get({ workId: input.workId, attemptId: input.attemptId, requestId: input.requestId });
        if (!original.ok) return original;
        if (!original.data) return fail(appError('storage_write_failed', 'storage', 'The invoice context commit could not be confirmed.', true));
        const phase = scope.invoiceWorks.getPhase(input);
        if (!phase.ok) return phase;
        if (!phase.data || phase.data.itemId !== input.itemId || !isDeepStrictEqual(phase.data.basis, input.basis)) return missing();
        return ok(original.data);
      });
    } catch { return fail(appError('storage_read_failed', 'storage', 'The original invoice context could not be recovered.', true)); }
  }

  private current(scope: SqlDatabaseStore, query: DurableSubmissionQuery): Result<InvoiceWorkWorkingContext> {
    const saved = scope.invoiceWorkContexts.get({ workId: query.workId, attemptId: query.attemptId, requestId: query.requestId });
    if (!saved.ok) return saved;
    if (!saved.data || saved.data.context.work.sessionId !== query.sessionId) return missing();
    const current = scope.invoiceWorks.readContextInput({ workId: query.workId, attemptId: query.attemptId,
      requestId: query.requestId, remainingBudget: saved.data.context.actions.remainingBudget });
    return current.ok ? ok(saved.data.context) : current;
  }

  async get(raw: DurableSubmissionQuery): Promise<Result<InvoiceWorkWorkingContext>> {
    const parsed = querySchema.safeParse(raw);
    if (!parsed.success) return invalid();
    try { return await this.options.database.read(scope => this.current(scope, parsed.data)); }
    catch { return fail(appError('storage_read_failed', 'storage', 'The invoice phase context could not be read.', true)); }
  }

  async verify(query: DurableSubmissionQuery): Promise<Result<void>> {
    const current = await this.get(query);
    return current.ok ? ok(undefined) : current;
  }
}

export class InvoiceWorkPhaseObserver {
  constructor(private readonly options: { database: Pick<DbHandle, 'read' | 'transaction'>;
    runtime: Pick<DurableRuntimePort, 'observeSubmission'>; now: () => string }) {}

  async reconcile(raw: DurableSubmissionQuery): Promise<Result<InvoiceWorkPhase | null>> {
    const input = querySchema.safeParse(raw);
    if (!input.success) return invalid();
    try {
      const original = await this.options.database.read(scope => {
        const work = scope.invoiceWorks.get({ view: 'work', workId: input.data.workId, limit: 1 });
        if (!work.ok) return work;
        if (work.data.work.sessionId !== input.data.sessionId) return missing();
        return scope.invoiceWorks.getPhase(phaseKey.parse({ workId: input.data.workId,
          attemptId: input.data.attemptId, requestId: input.data.requestId }));
      });
      if (!original.ok || original.data === null) return original;
      const originalPhase = original.data;
      const observed = await this.options.runtime.observeSubmission(input.data);
      if (!observed.ok) return observed;
      if (observed.data === null) return ok(null);
      const observation = observed.data;
      if (observation.workId !== input.data.workId || observation.sessionId !== input.data.sessionId
        || observation.attemptId !== input.data.attemptId || observation.requestId !== input.data.requestId)
        return fail(appError('source_invalid', 'runtime', 'The native receipt belongs to another invoice phase.'));
      let rejected: Result<never> | undefined;
      try {
        return await this.options.database.transaction(scope => {
          const linked = scope.invoiceWorks.linkPhase({ workId: input.data.workId, attemptId: input.data.attemptId,
            phaseId: originalPhase.phaseId, nativeConversationId: observation.nativeConversationId,
            nativeSubmissionId: observation.nativeSubmissionId, at: this.options.now() });
          if (!linked.ok) { rejected = linked; throw Error('invoice_phase_link_failed'); }
          const saved = scope.invoiceWorks.recordPhaseObservation({ observation, at: this.options.now() });
          if (!saved.ok) { rejected = saved; throw Error('invoice_phase_observation_failed'); }
          return saved;
        });
      } catch {
        return rejected ?? fail(appError('operation_result_unknown', 'storage', 'The phase observation commit could not be confirmed.', true));
      }
    } catch { return fail(appError('storage_read_failed', 'storage', 'The original phase execution could not be observed.', true)); }
  }
}
