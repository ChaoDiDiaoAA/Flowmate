import type { SynchronousDatabaseExecutor as Database } from '../storage/write-coordinator.ts';
import { ResearchContextSchema } from '@flowmate/contracts';
import type { ResearchContext } from '@flowmate/contracts';
import type { ResearchSourcePolicy } from '@flowmate/contracts';

export function researchMaterialScope(db: Database, policy: ResearchSourcePolicy) {
  const artifacts = new Set(policy.artifactIds);
  for (const id of policy.documentIds) {
    const row = db.query('SELECT status,hidden_at,parsed_artifact_id FROM documents WHERE id=?').get(id) as
      { status: string; hidden_at: string | null; parsed_artifact_id: number } | null;
    if (!row || row.status !== 'available' || row.hidden_at !== null) throw new Error('research_material_unavailable');
    artifacts.add(row.parsed_artifact_id);
  }
  for (const id of artifacts) if (!db.query('SELECT id FROM artifacts WHERE id=?').get(id)) throw new Error('research_material_unavailable');
  if (policy.documentIds.length > 64 || artifacts.size > 128) throw new Error('research_scope_too_large');
  return { allowedDocumentIds: [...policy.documentIds], allowedArtifactIds: [...artifacts] };
}

/** Read immutable research associations without depending on repository composition or current UI selection. */
export function readResearchContext(db: Database, runId: number): ResearchContext | null {
  if (!db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='research_runs'").get()) return null;
  const run = db.query('SELECT id,session_id,parent_run_id FROM runs WHERE id=?').get(runId) as
    { id: number; session_id: number; parent_run_id: number | null } | null;
  if (!run) return null;
  const rootRunId = run.parent_run_id ?? run.id;
  const row = db.query('SELECT * FROM research_runs WHERE run_id=?').get(rootRunId) as
    { research_id: number; phase: string; plan_id: number | null; revision: number | null; source_policy_json: string } | null;
  if (!row) return null;
  const plan = row.plan_id === null ? null : db.query('SELECT body_json FROM research_plans WHERE id=? AND research_id=? AND revision=?')
    .get(row.plan_id, row.research_id, row.revision) as { body_json: string } | null;
  if (row.plan_id !== null && !plan) throw new Error('research_plan_missing');
  return ResearchContextSchema.parse({ binding: { researchId: row.research_id, sessionId: run.session_id, runId, rootRunId,
    phase: row.phase, plan: row.plan_id === null ? null : { planId: row.plan_id, revision: row.revision }, sourcePolicy: JSON.parse(row.source_policy_json) },
    plan: plan ? JSON.parse(plan.body_json) : null });
}
