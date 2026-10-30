import { ResearchPlanBodySchema, ResearchWorkflowSchema, type ResearchWorkflow } from '@flowmate/contracts';
import type { SynchronousDatabaseExecutor as Database } from '../storage/write-coordinator.ts';

/** A checkpoint is a projection of the original plan and actual tool receipts. */
export function readResearchWorkflow(db: Database, researchId: number, planId: number): ResearchWorkflow | null {
  const row = db.query('SELECT revision,body_json FROM research_plans WHERE id=? AND research_id=?').get(planId, researchId) as
    { revision: number; body_json: string } | null;
  if (!row) throw Error('research_plan_missing');
  const plan = ResearchPlanBodySchema.parse(JSON.parse(row.body_json));
  if (!plan.steps) return null;
  const attempts = db.query(`SELECT e.step_id,e.run_id,e.tool_call_id,t.status,t.result_json,t.cleanup_json,
    r.status AS run_status,r.error_json AS run_error,s.id AS source_id FROM research_step_executions e
    JOIN tool_calls t ON t.id=e.tool_call_id AND t.run_id=e.run_id JOIN runs r ON r.id=e.run_id
    LEFT JOIN research_sources s ON s.tool_call_id=t.id WHERE e.plan_id=? AND e.research_id=? ORDER BY e.id DESC`)
    .all(planId, researchId) as { step_id: string; run_id: number; tool_call_id: number; status: string; result_json: string | null;
      cleanup_json: string; run_status: string; run_error: string | null; source_id: number | null }[];
  const latest = new Map<string, (typeof attempts)[number]>();
  for (const attempt of attempts) if (!latest.has(attempt.step_id)) latest.set(attempt.step_id, attempt);
  const items = plan.steps.map(step => {
    const attempt = latest.get(step.id);
    let status: ResearchWorkflow['steps'][number]['status'] = 'pending';
    let error = attempt?.result_json ? JSON.parse(attempt.result_json).error ?? null : null;
    if (attempt) {
      const stopped = JSON.parse(attempt.cleanup_json).stopped === true;
      if (attempt.status === 'succeeded' && stopped && attempt.source_id !== null) status = 'succeeded';
      else if (['requested', 'running'].includes(attempt.status) && ['created', 'running'].includes(attempt.run_status)) status = 'running';
      else if (['requested', 'running'].includes(attempt.status) || attempt.run_error && /interrupted/.test(JSON.parse(attempt.run_error).code ?? '')) {
        status = 'interrupted';
        error ??= { code: 'runtime_interrupted', category: 'runtime', message: 'Acquisition was interrupted before a confirmed receipt.', retryable: true };
      } else status = 'failed';
    }
    return { ...step, status, runId: attempt?.run_id ?? null, toolCallId: attempt?.tool_call_id ?? null,
      sourceSnapshotId: status === 'succeeded' ? attempt!.source_id : null, error };
  });
  return ResearchWorkflowSchema.parse({ planId, revision: row.revision,
    phase: items.some(step => ['pending', 'running', 'interrupted'].includes(step.status)) ? 'acquiring' : 'synthesizing', steps: items });
}
