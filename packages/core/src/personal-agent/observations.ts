import { z } from 'zod';
import type { DurableSubmissionQuery, PromptTraceCall } from '@flowmate/contracts';
import type { DbHandle, SqlDatabaseStore } from '../storage/database.ts';

const id = z.number().int().positive().safe();
const ms = z.number().finite().nonnegative().nullable();
const at = z.string().datetime();
const timingSchema = z.object({
  elapsedMs: ms, budgetMs: ms, beforeHttpMs: ms, firstTextMs: ms,
  transport: z.enum(['unobservable', 'not-entered', 'entered']),
  outcome: z.enum(['pending', 'done', 'error', 'aborted', 'incomplete']),
  attempts: z.array(z.object({
    headersMs: ms, status: z.number().int().min(0).max(599).nullable(),
    outcome: z.enum(['pending', 'headers', 'error', 'aborted']),
  }).strict()).max(16),
  droppedAttempts: z.number().int().nonnegative(),
}).strict();
const observation = z.object({
  observationId: z.string().uuid(), runId: id, sessionId: id, nativeSessionId: z.string().regex(/^\d+$/), callSequence: id,
  startedAt: at, endedAt: at.optional(),
  durable: z.object({ workId: id, itemId: id, attemptId: id, phaseId: id, nativeTaskId: id }).strict(),
  timing: timingSchema,
}).strict();

type ModelSource = DurableSubmissionQuery & { nativeTaskId: number; generationTaskId: number; assistantEntryId: number; phaseId: number; observationId?: string };
const retentionMs = 7 * 24 * 60 * 60 * 1_000;

export function createPersonalObservations(database: DbHandle, now: () => string, onUnavailable?: () => void) {
  let pending = 0;
  const unavailable = () => { try { onUnavailable?.(); } catch { /* Observation errors do not affect execution. */ } };
  function enqueue(write: (store: SqlDatabaseStore) => void) {
    if (pending >= 64) { unavailable(); return; }
    pending++;
    void database.transaction(write).catch(unavailable).finally(() => { pending--; });
  }

  return {
    capture(call: PromptTraceCall) {
      const { observationId, runId, sessionId, nativeSessionId, callSequence, startedAt, endedAt, durable, timing } = call;
      const safe = observation.safeParse({ observationId, runId, sessionId, nativeSessionId, callSequence, startedAt, endedAt, durable, timing });
      if (!safe.success) { unavailable(); return; }
      const saved = safe.data;
      enqueue(({ db }) => {
        db.query(`INSERT INTO personal_model_observations(observation_id,run_id,started_at,summary_json)
          VALUES(?,?,?,?) ON CONFLICT(observation_id) DO UPDATE SET summary_json=excluded.summary_json`)
          .run(saved.observationId, saved.runId, saved.startedAt, JSON.stringify(saved));
        db.query('DELETE FROM personal_model_observations WHERE started_at < ?').run(new Date(Date.parse(now()) - retentionMs).toISOString());
        db.query(`DELETE FROM personal_model_observations WHERE rowid IN (
          SELECT rowid FROM personal_model_observations ORDER BY started_at, rowid
          LIMIT MAX(0, (SELECT COUNT(*) FROM personal_model_observations) - 10000)
        )`).run();
      });
    },
    source(input: ModelSource) {
      enqueue(({ db }) => {
        db.query(`INSERT INTO personal_tool_model_sources(run_id,native_tool_call_id,phase_id,generation_task_id,assistant_entry_id,observation_id)
          SELECT a.run_id,?,p.id,?,?,?
          FROM invoice_work_phases p JOIN invoice_work_attempts a ON a.id=p.attempt_id AND a.work_id=p.work_id
          JOIN runs r ON r.id=a.run_id AND r.session_id=?
          WHERE p.id=? AND p.work_id=? AND p.attempt_id=? AND p.request_id=? AND p.durable_runtime_id='local'
          ON CONFLICT(run_id,native_tool_call_id) DO NOTHING`).run(`durable-task:${input.nativeTaskId}`,
          input.generationTaskId, input.assistantEntryId, input.observationId ?? null, input.sessionId,
          input.phaseId, input.workId, input.attemptId, input.requestId);
      });
    },
    async read(runId: number, callSequence?: number): Promise<PromptTraceCall[]> {
      const since = new Date(Date.parse(now()) - retentionMs).toISOString();
      return database.read(({ db }) => db.query<{ summary_json: string }, [number, string, number | null, number | null]>(`
        SELECT summary_json FROM personal_model_observations WHERE run_id=? AND started_at>=?
          AND (? IS NULL OR json_extract(summary_json,'$.callSequence')=?)
        ORDER BY started_at DESC, rowid DESC LIMIT 100`).all(runId, since, callSequence ?? null, callSequence ?? null).flatMap(row => {
        try {
          const parsed = observation.parse(JSON.parse(row.summary_json));
          return [{ ...parsed, state: 'ended', entries: [], droppedEntries: 0,
            timing: parsed.endedAt ? parsed.timing : { ...parsed.timing, outcome: 'incomplete' } } satisfies PromptTraceCall];
        } catch { unavailable(); return []; }
      }).reverse());
    },
  };
}
