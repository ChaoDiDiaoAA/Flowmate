import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { appError, fail, ok, DurableCompactionPlanSchema, DurableCompactionRequestSchema, PersonalAgentConfigurationSchema,
  type DurableCompactionCallbacks, type DurableCompactionPlan, type DurableCompactionRequest, type DurableSubagentCallbacks,
  type DurableSubmissionQuery, type Result } from '@flowmate/contracts';
import type { DbHandle } from '../storage/database.ts';
import type { DurableInvoiceGovernor } from './admission.ts';
import type { InvoiceWorkPhaseContextService } from './phase-context.ts';

const phase = ({ workId, sessionId, attemptId, requestId }: DurableSubmissionQuery): DurableSubmissionQuery => ({ workId, sessionId, attemptId, requestId });
const parent = ({ workId, sessionId, attemptId }: DurableSubmissionQuery) => ({ workId, sessionId, attemptId });
const invalid = () => fail(appError('input_invalid', 'input', 'The original summary request is invalid.'));
const changed = () => fail(appError('source_invalid', 'runtime', 'The summary differs from its original phase model or thinking level.'));

/** A summary uses the original live phase authority and budget, without opening another business attempt. */
export function createInvoiceWorkCompactionCallbacks(options: {
  database: Pick<DbHandle, 'read'>;
  governor: Pick<DurableInvoiceGovernor, 'verifyModelUse' | 'reserveModelRequest'>;
  contexts: Pick<InvoiceWorkPhaseContextService, 'verify'>;
  subagents?: Pick<DurableSubagentCallbacks, 'readPlan' | 'verify' | 'reserveModelRequest'>;
}): DurableCompactionCallbacks {
  async function guarded<T>(operation: () => Promise<Result<T>>, write = false): Promise<Result<T>> {
    try { return await operation(); }
    catch (error) {
      let code = write ? 'storage_write_failed' : 'storage_read_failed';
      if (error instanceof z.ZodError || error instanceof SyntaxError) code = 'storage_corrupt';
      return fail(appError(code, 'storage', 'The original summary authority could not be verified.', true));
    }
  }

  async function readPlan(raw: DurableCompactionRequest): Promise<Result<DurableCompactionPlan>> {
    const parsed = DurableCompactionRequestSchema.safeParse(raw); if (!parsed.success) return invalid();
    const input = parsed.data;
    return guarded(async () => {
      const context = await options.contexts.verify(phase(input)); if (!context.ok) return context;
      if (input.child) {
        const callbacks = options.subagents;
        if (!callbacks) return fail(appError('personal_compaction_unavailable', 'runtime', 'The child summary adapter is unavailable.'));
        const verified = await callbacks.verify(input.child); if (!verified.ok) return verified;
        const original = await callbacks.readPlan(input.child); if (!original.ok) return original;
        return ok(DurableCompactionPlanSchema.parse({ ...input, binding: original.data.binding, thinkingLevel: original.data.thinkingLevel }));
      }
      const allowed = await options.governor.verifyModelUse(parent(input)); if (!allowed.ok) return allowed;
      return options.database.read(store => {
        const original = store.invoiceWorkModelBindings.get({ workId: input.workId, attemptId: input.attemptId });
        if (!original.ok) return original;
        if (!original.data) return fail(appError('original_model_binding_unavailable', 'runtime', 'The original summary model has not been saved.'));
        const row = store.db.query<{ configuration_json: string }, [number, number]>(
          'SELECT configuration_json FROM invoice_works WHERE id=? AND session_id=?').get(input.workId, input.sessionId);
        if (!row) return changed();
        const configuration = PersonalAgentConfigurationSchema.parse(JSON.parse(row.configuration_json));
        return ok(DurableCompactionPlanSchema.parse({ ...input, binding: original.data.binding, thinkingLevel: configuration.thinkingLevel }));
      });
    });
  }

  async function verify(raw: DurableCompactionPlan): Promise<Result<void>> {
    const parsed = DurableCompactionPlanSchema.safeParse(raw); if (!parsed.success) return invalid();
    const { binding, thinkingLevel, ...request } = parsed.data;
    const original = await readPlan(request); if (!original.ok) return original;
    return thinkingLevel === original.data.thinkingLevel && isDeepStrictEqual(binding, original.data.binding) ? ok(undefined) : changed();
  }

  return {
    readPlan, verify,
    async reserveModelRequest(raw) {
      const parsed = DurableCompactionPlanSchema.safeParse(raw); if (!parsed.success) return invalid();
      return guarded(async () => {
        const allowed = await verify(parsed.data); if (!allowed.ok) return allowed;
        // The existing governor reserves before transport; its later eligibility check still applies.
        if (!parsed.data.child) return options.governor.reserveModelRequest(parent(parsed.data));
        const child = options.subagents;
        return child ? child.reserveModelRequest(parsed.data.child)
          : fail(appError('personal_compaction_unavailable', 'runtime', 'The child summary adapter is unavailable.'));
      }, true);
    },
  };
}
