import { appError, fail, InvoiceWorkFeedbackSchema, InvoiceWorkFeedbackSourceSchema, ok, type InvoiceWorkFeedback, type InvoiceWorkFeedbackApi } from '@flowmate/contracts';
import type { DbHandle, SqlDatabaseStore } from '../storage/database.ts';

type Target = Parameters<InvoiceWorkFeedbackApi['get']>[0];
type Candidate = { job_id: number; session_id: number; run_id: number | null; tool_call_id: number | null };
type Saved = { helpful: 0 | 1; saved_at: string; attempt_id: number | null; phase_id: number | null; run_id: number | null; tool_call_id: number | null };
const conflict = () => fail(appError('state_conflict', 'input', 'The feedback does not match the original candidate or saved vote.'));

export function createInvoiceWorkFeedback(database: DbHandle, now: () => string): InvoiceWorkFeedbackApi {
  function candidate(store: SqlDatabaseStore, input: Target) {
    return store.db.query<Candidate, [number, number, number, number]>(`
      SELECT c.job_id,w.session_id,c.run_id,c.tool_call_id
      FROM invoice_works w JOIN sessions s ON s.id=w.session_id
      JOIN invoice_work_items i ON i.work_id=w.id JOIN jobs j ON j.id=i.job_id
      JOIN invoice_candidates c ON c.job_id=j.id
      WHERE w.id=? AND i.id=? AND c.id=? AND c.sequence=? AND c.origin='model'
        AND s.runtime_kind='durable' AND s.durable_runtime_id='local'
        AND json_extract(j.input_json,'$.version')=2 AND json_extract(j.input_json,'$.workId')=w.id
        AND json_extract(j.input_json,'$.itemId')=i.id
    `).get(input.workId, input.itemId, input.candidateId, input.candidateSequence);
  }

  function read(store: SqlDatabaseStore, input: Target): InvoiceWorkFeedback | null {
    const saved = store.db.query<Saved, [number, number, number, number]>(`
      SELECT helpful,saved_at,attempt_id,phase_id,run_id,tool_call_id FROM invoice_work_feedback
      WHERE candidate_id=? AND candidate_sequence=? AND work_id=? AND item_id=?
    `).get(input.candidateId, input.candidateSequence, input.workId, input.itemId);
    if (!saved) return null;
    const source = saved.attempt_id === null ? undefined : readSource(store, saved);
    return InvoiceWorkFeedbackSchema.parse({ workId: input.workId, itemId: input.itemId, candidateId: input.candidateId,
      candidateSequence: input.candidateSequence, helpful: saved.helpful === 1, savedAt: saved.saved_at,
      association: saved.attempt_id === null ? { status: 'unavailable' } : {
        status: 'associated', attemptId: saved.attempt_id, phaseId: saved.phase_id, runId: saved.run_id, toolCallId: saved.tool_call_id,
        ...(source ? { source } : {}),
      },
    });
  }

  function readSource(store: SqlDatabaseStore, saved: Saved) {
    try {
      const row = store.db.query<{
        generation_task_id: number; assistant_entry_id: number; observation_id: string | null; call_sequence: number | null;
      }, [number | null, number | null, number | null]>(`SELECT s.generation_task_id,s.assistant_entry_id,s.observation_id,
        json_extract(m.summary_json,'$.callSequence') call_sequence
        FROM personal_tool_model_sources s JOIN tool_calls t ON t.run_id=s.run_id AND t.native_tool_call_id=s.native_tool_call_id
        LEFT JOIN personal_model_observations m ON m.observation_id=s.observation_id AND m.run_id=s.run_id
        WHERE t.id=? AND s.run_id=? AND s.phase_id=?`).get(saved.tool_call_id, saved.run_id, saved.phase_id);
      if (!row) return undefined;
      const parsed = InvoiceWorkFeedbackSourceSchema.safeParse({ generationTaskId: row.generation_task_id, assistantEntryId: row.assistant_entry_id,
        observationId: row.observation_id ?? undefined, callSequence: row.call_sequence ?? undefined });
      return parsed.success ? parsed.data : undefined;
    } catch { return undefined; } // Optional diagnostics must not hide the saved vote or ToolCall.
  }

  return {
    async get(input) {
      try {
        return await database.read(store => candidate(store, input) ? ok(read(store, input)) : conflict());
      } catch { return fail(appError('storage_read_failed', 'storage', 'Candidate feedback could not be read.')); }
    },
    async submit(input) {
      try {
        return await database.transaction(store => {
          const original = candidate(store, input);
          if (!original) return conflict();
          const prior = read(store, input);
          if (prior) return prior.helpful === input.helpful ? ok(prior) : conflict();
          let owner: { attempt_id: number; phase_id: number } | null = null;
          if (original.run_id !== null && original.tool_call_id !== null) {
            const commit = store.toolCalls.queryCandidateCommit({ toolCallId: original.tool_call_id, runId: original.run_id, sessionId: original.session_id });
            if (commit.ok && commit.data?.candidateId === input.candidateId && commit.data.sequence === input.candidateSequence
              && commit.data.jobId === original.job_id) {
              owner = store.db.query<{ attempt_id: number; phase_id: number }, [number, number, number, number, number]>(`
                SELECT p.attempt_id,p.id AS phase_id
                FROM tool_calls t JOIN invoice_work_tool_calls b ON b.tool_call_id=t.id
                JOIN invoice_work_phases p ON p.id=b.phase_id
                JOIN invoice_work_attempts a ON a.id=p.attempt_id AND a.work_id=p.work_id AND a.run_id=t.run_id
                WHERE t.id=? AND t.run_id=? AND t.session_id=? AND t.tool_name='save_invoice_candidate'
                  AND p.work_id=? AND p.item_id=? AND p.durable_runtime_id='local'
              `).get(original.tool_call_id, original.run_id, original.session_id, input.workId, input.itemId);
            }
          }
          store.db.query(`INSERT INTO invoice_work_feedback
            (candidate_id,candidate_sequence,work_id,item_id,helpful,saved_at,attempt_id,phase_id,run_id,tool_call_id)
            VALUES (?,?,?,?,?,?,?,?,?,?)`).run(input.candidateId, input.candidateSequence, input.workId, input.itemId, Number(input.helpful), now(),
            owner?.attempt_id ?? null, owner?.phase_id ?? null, owner ? original.run_id : null, owner ? original.tool_call_id : null);
          const saved = read(store, input);
          if (!saved) throw Error('storage_corrupt');
          return ok(saved);
        });
      } catch { return fail(appError('storage_write_failed', 'storage', 'Candidate feedback could not be saved.')); }
    },
  };
}
