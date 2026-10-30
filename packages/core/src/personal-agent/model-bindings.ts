import { z } from 'zod';
import { isDeepStrictEqual } from 'node:util';
import { appError, fail, ok, DurableModelBindingSchema, PersonalAgentConfigurationSchema,
  type DurableModelBinding, type Result } from '@flowmate/contracts';
import type { SynchronousDatabaseExecutor } from '../storage/write-coordinator.ts';
import { readTransaction } from '../storage/reads.ts';

export type InvoiceWorkModelBinding = { workId: number; attemptId: number | null; modelId: string;
  binding: DurableModelBinding; createdAt: string };
export interface InvoiceWorkModelBindingRepository {
  get(input: { workId: number; attemptId: number }): Result<InvoiceWorkModelBinding | null>;
  getOriginal(input: { workId: number }): Result<InvoiceWorkModelBinding | null>;
  save(input: { workId: number; attemptId?: number; modelId: string; binding: DurableModelBinding; at: string }): Result<InvoiceWorkModelBinding>;
}
const id = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const keySchema = z.object({ workId: id, attemptId: id }).strict();
const saveSchema = keySchema.extend({ attemptId: id.optional(), modelId: z.string().min(1).max(128), binding: DurableModelBindingSchema,
  at: z.string().datetime({ offset: true }) });
type Row = { work_id: number; attempt_id: number | null; model_id: string; binding_json: string; created_at: string };
class BindingFault extends Error { constructor(readonly code: string) { super(code); } }
function requireFact(condition: unknown, code = 'state_conflict'): asserts condition { if (!condition) throw new BindingFault(code); }

/** Fixed model facts contain configuration references; live credentials stay outside product SQL. */
export function createInvoiceWorkModelBindingRepository(db: SynchronousDatabaseExecutor): InvoiceWorkModelBindingRepository {
  function operation<T>(write: boolean, action: () => T): Result<T> {
    try {
      if (write) requireFact(db.inTransaction);
      return ok(write ? db.transaction(action).immediate() : readTransaction(db, action));
    } catch (error) {
      return fail(appError(error instanceof BindingFault ? error.code
        : error instanceof z.ZodError || error instanceof SyntaxError ? 'storage_corrupt'
          : write ? 'storage_write_failed' : 'storage_read_failed', 'storage', 'The original invoice model binding could not be confirmed.', true));
    }
  }
  function owner(workId: number) {
    const row = db.query<{ status: string; current_attempt_id: number | null; configuration_json: string; runtime_kind: string }, [number]>(
      `SELECT w.status,w.current_attempt_id,w.configuration_json,s.runtime_kind
       FROM invoice_works w JOIN sessions s ON s.id=w.session_id WHERE w.id=?`).get(workId);
    requireFact(row && row.runtime_kind === 'durable', 'invoice_work_not_found');
    return row;
  }
  function attempt(workId: number, attemptId: number) {
    const row = db.query<{ stop_requested_at: string | null; stopped_at: string | null }, [number, number]>(
      'SELECT stop_requested_at,stopped_at FROM invoice_work_attempts WHERE work_id=? AND id=?').get(workId, attemptId);
    requireFact(row, 'invoice_work_attempt_not_found'); return row;
  }
  function read(row: Row): InvoiceWorkModelBinding {
    const original = owner(row.work_id);
    if (row.attempt_id !== null) attempt(row.work_id, row.attempt_id);
    requireFact(PersonalAgentConfigurationSchema.parse(JSON.parse(original.configuration_json)).modelId === row.model_id, 'storage_corrupt');
    return { workId: row.work_id, attemptId: row.attempt_id, modelId: row.model_id,
      binding: DurableModelBindingSchema.parse(JSON.parse(row.binding_json)), createdAt: row.created_at };
  }
  function find(workId: number) {
    const row = db.query<Row, [number]>(
      'SELECT * FROM invoice_work_model_bindings WHERE work_id=?').get(workId);
    return row ? read(row) : null;
  }
  return {
    getOriginal(raw) {
      return operation(false, () => {
        const input = keySchema.pick({ workId: true }).safeParse(raw); requireFact(input.success, 'input_invalid');
        owner(input.data.workId); return find(input.data.workId);
      });
    },
    get(raw) {
      return operation(false, () => {
        const input = keySchema.safeParse(raw); requireFact(input.success, 'input_invalid');
        owner(input.data.workId); attempt(input.data.workId, input.data.attemptId);
        return find(input.data.workId);
      });
    },
    save(raw) {
      return operation(true, () => {
        const input = saveSchema.safeParse(raw); requireFact(input.success, 'input_invalid');
        const { workId, attemptId, modelId, binding, at } = input.data;
        const original = owner(workId), source = attemptId === undefined ? null : attempt(workId, attemptId), prior = find(workId);
        if (prior) {
          requireFact(prior.modelId === modelId && isDeepStrictEqual(prior.binding, binding));
          return prior;
        }
        requireFact(original.status === 'open' && (source === null ? original.current_attempt_id === null
          : original.current_attempt_id === attemptId && source.stop_requested_at === null && source.stopped_at === null));
        requireFact(PersonalAgentConfigurationSchema.parse(JSON.parse(original.configuration_json)).modelId === modelId,
          'source_invalid');
        db.query('INSERT INTO invoice_work_model_bindings(attempt_id,work_id,model_id,binding_json,created_at) VALUES(?,?,?,?,?)')
          .run(attemptId ?? null, workId, modelId, JSON.stringify(binding), at);
        const saved = find(workId); requireFact(saved, 'storage_corrupt'); return saved;
      });
    },
  };
}
