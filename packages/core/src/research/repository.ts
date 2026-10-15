import type { Database } from 'bun:sqlite';
import { readResearchContext, researchMaterialScope } from './context.ts';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { appError, fail, ok, ResearchTaskSchema, ResearchPlanSchema, ResearchPlanBodySchema, ResearchSourcePolicySchema,
  ResearchRunBindingSchema, ResearchSourceDataSchema, SourceSnapshotSchema, ResearchClaimBodySchema, ClaimSchema,
  ResearchReportBodySchema, ResearchReportSchema, ResearchPageRequestSchema, ResearchMaterialSchema } from '@flowmate/contracts';
import type { Result, ResearchSourcePolicy, ResearchTask, ResearchPlanBody, ResearchPlan, ResearchRunBinding, SourceSnapshot,
  ResearchClaimBody, Claim, ResearchReportBody, ResearchReport, ResearchPageRequest, ResearchTaskPage, ResearchMaterial } from '@flowmate/contracts';
import type { PublishedArtifact } from '../storage/file-store.ts';
import { readTransaction } from '../storage/reads.ts';
import { createSessionRepository } from '../storage/repositories.ts';

type Identity = { researchId: number; runId: number; toolCallId: number; at: string };
type BindingInput = { researchId: number; sessionId: number; runId: number; phase: 'planning' | 'researching'; plan: { planId: number; revision: number } | null; continuation?: true; at: string };
type RecordRow = { id: number; research_id: number; run_id: number; tool_call_id: number; body_json: string; created_at: string; plan_id?: number; revision?: number };
type TaskRow = { id: number; session_id: number; title: string; source_policy_json: string; current_plan_id: number | null;
  current_run_id: number | null; current_report_id: number | null; created_at: string; updated_at: string };

export interface ResearchRepository {
  findMaterials(input: Pick<ResearchMaterial, 'title' | 'format'>): Result<ResearchMaterial[]>;
  registerMaterial(input: PublishedArtifact): Result<ResearchMaterial>;
  listMaterials(input: ResearchPageRequest): Result<{ items: ResearchMaterial[]; nextBeforeId: number | null }>;
  create(input: { sessionId: number; title: string; sourcePolicy: ResearchSourcePolicy; at: string }): Result<ResearchTask>;
  get(researchId: number): Result<ResearchTask>;
  forSession(sessionId: number): Result<ResearchTask | null>;
  list(input: ResearchPageRequest): Result<ResearchTaskPage>;
  bindRun(input: BindingInput): Result<ResearchRunBinding>;
  bindingForRun(runId: number): Result<ResearchRunBinding | null>;
  materialScope(policy: ResearchSourcePolicy): Result<{ allowedDocumentIds: number[]; allowedArtifactIds: number[] }>;
  savePlan(input: Identity & { body: ResearchPlanBody }): Result<ResearchPlan>;
  getPlan(input: { researchId: number; planId: number }): Result<ResearchPlan>;
  saveSource(input: Identity & { source: z.infer<typeof ResearchSourceDataSchema> }): Result<SourceSnapshot>;
  getSource(input: { researchId: number; sourceSnapshotId: number }): Result<SourceSnapshot>;
  listSources(input: ResearchPageRequest & { researchId: number }): Result<{ items: SourceSnapshot[]; nextBeforeId: number | null }>;
  saveClaim(input: Identity & { claim: ResearchClaimBody }): Result<Claim>;
  getClaim(input: { researchId: number; claimId: number }): Result<Claim>;
  listClaims(input: ResearchPageRequest & { researchId: number; planId: number }): Result<{ items: Claim[]; nextBeforeId: number | null }>;
  saveReport(input: Identity & { report: ResearchReportBody }): Result<ResearchReport>;
  getReport(input: { researchId: number; reportId: number }): Result<ResearchReport>;
  listReports(input: ResearchPageRequest & { researchId: number }): Result<{ items: ResearchReport[]; nextBeforeId: number | null }>;
}

class ResearchFault extends Error { constructor(readonly code: string, message = 'Research identity or state is unavailable.') { super(message); } }
function requireFact(condition: unknown, code = 'research_identity_conflict', message?: string): asserts condition { if (!condition) throw new ResearchFault(code, message); }
const validId = (value: number) => Number.isSafeInteger(value) && value > 0;
const validAt = (value: string) => z.string().datetime().safeParse(value).success;
function parseInput<T>(schema: z.ZodType<T, z.ZodTypeDef, unknown>, raw: unknown): T {
  const value = schema.safeParse(raw); if (!value.success) throw new ResearchFault('input_invalid'); return value.data;
}
function sourceSubset(child: ResearchSourcePolicy, parent: ResearchSourcePolicy): boolean {
  return child.artifactIds.every(id => parent.artifactIds.includes(id))
    && child.documentIds.every(id => parent.documentIds.includes(id));
}

/** Research owns domain facts; Run/ToolCall identities remain owned by their existing repositories. */
export function createResearchRepository(db: Database): ResearchRepository {
  const sessions = createSessionRepository(db);
  function operation<T>(write: boolean, work: () => T): Result<T> {
    try { return ok(write ? db.inTransaction ? work() : db.transaction(work).immediate() : readTransaction(db, work)); }
    catch (error) {
      if (error instanceof ResearchFault) return fail(appError(error.code, error.code === 'input_invalid' ? 'input' : 'runtime', error.message));
      return fail(appError(write ? 'research_write_failed' : 'research_read_failed', 'storage', 'Research storage is unavailable.', true));
    }
  }
  function taskRow(researchId: number): TaskRow {
    requireFact(validId(researchId), 'input_invalid');
    const row = db.query('SELECT * FROM research_tasks WHERE id=?').get(researchId) as TaskRow | null;
    requireFact(row, 'research_not_found'); return row;
  }
  function binding(runId: number): ResearchRunBinding | null {
    requireFact(validId(runId), 'input_invalid');
    return readResearchContext(db, runId)?.binding ?? null;
  }
  function active(researchId: number, runId: number): ResearchRunBinding {
    const value = binding(runId); requireFact(value && value.researchId === researchId);
    const row = taskRow(researchId); requireFact(row.current_run_id === value.rootRunId);
    for (const id of new Set([runId, value.rootRunId])) {
      const run = db.query('SELECT status,cancel_requested_at,session_id FROM runs WHERE id=?').get(id) as { status: string; cancel_requested_at: string | null; session_id: number } | null;
      requireFact(run && ['created', 'running'].includes(run.status) && run.cancel_requested_at === null, 'research_run_inactive');
      const permission = sessions.isModelUseBlocked(run.session_id);
      requireFact(permission.ok && !permission.data, 'research_source_denied');
      const session = sessions.get(run.session_id);
      requireFact(session.ok && session.data.status === 'active' && !session.data.deletePending, 'research_source_denied');
    }
    return value;
  }
  function execution(input: Identity, name: string, rootOnly: boolean): ResearchRunBinding {
    requireFact(validId(input.toolCallId) && validAt(input.at), 'input_invalid');
    const value = active(input.researchId, input.runId);
    requireFact(!rootOnly || value.rootRunId === input.runId, 'research_child_write_denied');
    const call = db.query('SELECT run_id,tool_name,status FROM tool_calls WHERE id=?').get(input.toolCallId) as { run_id: number; tool_name: string; status: string } | null;
    requireFact(call && call.run_id === input.runId && call.tool_name === name && call.status === 'running');
    return value;
  }
  function confirmed(row: TaskRow): boolean {
    return row.current_plan_id !== null && db.query("SELECT 1 FROM research_runs WHERE research_id=? AND plan_id=? AND phase='researching' LIMIT 1")
      .get(row.id, row.current_plan_id) !== null;
  }
  function project(row: TaskRow): ResearchTask {
    let status: ResearchTask['status'] = 'planning';
    if (row.current_run_id !== null) {
      const run = db.query('SELECT status,stopped_at,error_json FROM runs WHERE id=?').get(row.current_run_id) as { status: string; stopped_at: string | null; error_json: string | null } | null;
      const b = binding(row.current_run_id); requireFact(run && b);
      if (['created', 'running'].includes(run.status)) status = b.phase;
      else if (run.status === 'cancelled') status = 'cancelled';
      else if (run.status === 'failed') status = run.error_json && /interrupted/.test(JSON.parse(run.error_json).code ?? '') ? 'interrupted' : 'failed';
      else if (b.phase === 'planning') status = run.stopped_at !== null && row.current_plan_id !== null
        && record('plan', row.id, row.current_plan_id).runId === row.current_run_id ? 'awaiting_confirmation' : 'failed';
      else {
        const report = row.current_report_id === null ? null : record('report', row.id, row.current_report_id);
        status = !report || report.planId !== b.plan?.planId ? 'failed' : report.completeness === 'full' ? 'completed' : 'partial';
      }
    }
    return ResearchTaskSchema.parse({ researchId: row.id, sessionId: row.session_id, title: row.title, sourcePolicy: JSON.parse(row.source_policy_json),
      status, currentPlanId: row.current_plan_id, planConfirmed: confirmed(row), currentRunId: row.current_run_id, currentReportId: row.current_report_id,
      createdAt: row.created_at, updatedAt: row.updated_at });
  }
  const tables = { plan: 'research_plans', source: 'research_sources', claim: 'research_claims', report: 'research_reports' } as const;
  type Kind = keyof typeof tables;
  type Records = { plan: ResearchPlan; source: SourceSnapshot; claim: Claim; report: ResearchReport };
  function decode<K extends Kind>(kind: K, row: RecordRow): Records[K] {
    const common = { researchId: row.research_id, runId: row.run_id, toolCallId: row.tool_call_id, createdAt: row.created_at };
    const body = JSON.parse(row.body_json) as unknown;
    const value = kind === 'plan' ? ResearchPlanSchema.parse({ ...common, planId: row.id, revision: row.revision, body })
      : kind === 'source' ? SourceSnapshotSchema.parse({ ...common, sourceSnapshotId: row.id, ...body as object })
      : kind === 'claim' ? ClaimSchema.parse({ ...common, claimId: row.id, planId: row.plan_id, revision: row.revision, ...body as object })
      : ResearchReportSchema.parse({ ...common, reportId: row.id, planId: row.plan_id, revision: row.revision, ...body as object });
    return value as Records[K];
  }
  function record<K extends Kind>(kind: K, researchId: number, id: number): Records[K] {
    requireFact(validId(id) && validId(researchId), 'input_invalid');
    const row = db.query(`SELECT * FROM ${tables[kind]} WHERE id=? AND research_id=?`).get(id, researchId) as RecordRow | null;
    requireFact(row, 'research_not_found'); return decode(kind, row);
  }
  function duplicate<K extends Kind>(kind: K, input: Identity, body: unknown): Records[K] | null {
    const row = db.query(`SELECT * FROM ${tables[kind]} WHERE tool_call_id=?`).get(input.toolCallId) as RecordRow | null;
    if (!row) return null;
    requireFact(row.research_id === input.researchId && row.run_id === input.runId && isDeepStrictEqual(JSON.parse(row.body_json), body));
    return decode(kind, row);
  }
  function listRecords<K extends Kind>(kind: K, raw: ResearchPageRequest & { researchId: number; planId?: number }) {
    const { researchId, planId, ...page } = raw;
    taskRow(researchId); const parsed = parseInput(ResearchPageRequestSchema, page);
    requireFact(planId === undefined || validId(planId), 'input_invalid');
    const rows = db.query(`SELECT * FROM ${tables[kind]} WHERE research_id=? AND id<? ${planId === undefined ? '' : 'AND plan_id=?'} ORDER BY id DESC LIMIT ?`)
      .all(researchId, parsed.beforeId ?? Number.MAX_SAFE_INTEGER, ...(planId === undefined ? [] : [planId]), parsed.limit + 1) as RecordRow[];
    return { items: rows.slice(0, parsed.limit).map(row => decode(kind, row)), nextBeforeId: rows.length > parsed.limit ? rows[parsed.limit - 1]!.id : null };
  }
  function questionIds(plan: ResearchPlan) { return plan.body.dimensions.flatMap(d => d.questions.map(q => q.id)); }
  function currentPlan(value: ResearchRunBinding): ResearchPlan {
    requireFact(value.phase === 'researching' && value.plan, 'research_phase_invalid');
    const plan = record('plan', value.researchId, value.plan.planId);
    requireFact(plan.revision === value.plan.revision); return plan;
  }
  function material(row: { id: number; bytes: number; mime_type: string; metadata_json: string }): ResearchMaterial {
    const metadata = JSON.parse(row.metadata_json);
    requireFact(metadata.sourceKey === 'research-local-v1');
    return ResearchMaterialSchema.parse({ artifactId: row.id, title: metadata.sourceRecordId,
      bytes: row.bytes, format: row.mime_type === 'text/markdown' ? 'markdown' : 'text',
      ...(metadata.verificationGap === undefined ? {} : { verificationGap: metadata.verificationGap }) });
  }
  function checkSource(source: SourceSnapshot | z.infer<typeof ResearchSourceDataSchema>, policy: ResearchSourcePolicy) {
    if (source.kind === 'local') requireFact(source.artifactId && policy.artifactIds.includes(source.artifactId), 'research_source_denied');
    else requireFact(source.documentId && policy.documentIds.includes(source.documentId), 'research_source_denied');
  }
  return {
    findMaterials: input => operation(false, () => {
      const rows = db.query("SELECT id,bytes,mime_type,metadata_json FROM artifacts WHERE kind='original' AND json_extract(metadata_json,'$.sourceKey')='research-local-v1' AND json_extract(metadata_json,'$.sourceRecordId')=? AND mime_type=? ORDER BY id")
        .all(input.title, input.format === 'markdown' ? 'text/markdown' : 'text/plain') as Parameters<typeof material>[0][];
      return rows.map(material);
    }),
    registerMaterial: input => operation(true, () => {
      const name = input.mimeType === 'text/markdown' ? 'source.md' : 'source.txt';
      requireFact(input.kind === 'original' && ['text/plain', 'text/markdown'].includes(input.mimeType) && validId(input.artifactId) && validAt(input.createdAt)
        && input.relativePath === `artifacts/${input.artifactId}/${name}` && input.metadata.sourceKey === 'research-local-v1'
        && input.metadata.files.length === 1 && input.metadata.files[0]!.relativePath === name && input.metadata.files[0]!.bytes === input.bytes, 'input_invalid');
      const value = material({ id: input.artifactId, bytes: input.bytes, mime_type: input.mimeType, metadata_json: JSON.stringify(input.metadata) });
      db.query('INSERT INTO artifacts(id,kind,relative_path,bytes,mime_type,metadata_json,created_at) VALUES (?,?,?,?,?,?,?)')
        .run(input.artifactId, input.kind, input.relativePath, input.bytes, input.mimeType, JSON.stringify(input.metadata), input.createdAt);
      return value;
    }),
    listMaterials: raw => operation(false, () => {
      const page = parseInput(ResearchPageRequestSchema, raw);
      const rows = db.query("SELECT id,bytes,mime_type,metadata_json FROM artifacts WHERE kind='original' AND json_extract(metadata_json,'$.sourceKey')='research-local-v1' AND id<? ORDER BY id DESC LIMIT ?")
        .all(page.beforeId ?? Number.MAX_SAFE_INTEGER, page.limit + 1) as Parameters<typeof material>[0][];
      return { items: rows.slice(0, page.limit).map(material), nextBeforeId: rows.length > page.limit ? rows[page.limit - 1]!.id : null };
    }),
    create: input => operation(true, () => {
      requireFact(validId(input.sessionId) && validAt(input.at), 'input_invalid');
      const title = input.title.trim(); requireFact(title.length > 0 && [...title].length <= 120 && Buffer.byteLength(title) <= 480, 'input_invalid');
      const policy = parseInput(ResearchSourcePolicySchema, input.sourcePolicy), session = sessions.get(input.sessionId);
      try { researchMaterialScope(db, policy); }
      catch (error) {
        if (error instanceof Error && ['research_material_unavailable', 'research_scope_too_large'].includes(error.message)) throw new ResearchFault('research_source_denied');
        throw error;
      }
      requireFact(session.ok && session.data.status === 'active' && !session.data.deletePending);
      requireFact(!db.query('SELECT id FROM runs WHERE session_id=? LIMIT 1').get(input.sessionId), 'research_session_not_empty');
      const inserted = db.query('INSERT INTO research_tasks(session_id,title,source_policy_json,created_at,updated_at) VALUES (?,?,?,?,?)')
        .run(input.sessionId, title, JSON.stringify(policy), input.at, input.at);
      return project(taskRow(Number(inserted.lastInsertRowid)));
    }),
    get: id => operation(false, () => project(taskRow(id))),
    forSession: sessionId => operation(false, () => {
      requireFact(validId(sessionId), 'input_invalid');
      const row = db.query('SELECT * FROM research_tasks WHERE session_id=?').get(sessionId) as TaskRow | null;
      return row ? project(row) : null;
    }),
    list: input => operation(false, () => {
      const page = parseInput(ResearchPageRequestSchema, input);
      const rows = db.query('SELECT * FROM research_tasks WHERE id<? ORDER BY id DESC LIMIT ?').all(page.beforeId ?? Number.MAX_SAFE_INTEGER, page.limit + 1) as TaskRow[];
      return { items: rows.slice(0, page.limit).map(project), nextBeforeId: rows.length > page.limit ? rows[page.limit - 1]!.id : null };
    }),
    bindingForRun: runId => operation(false, () => binding(runId)),
    materialScope: policy => operation(false, () => researchMaterialScope(db, parseInput(ResearchSourcePolicySchema, policy))),
    bindRun: input => operation(true, () => {
      requireFact(validId(input.runId) && validId(input.sessionId) && validAt(input.at), 'input_invalid');
      const task = taskRow(input.researchId);
      const existing = binding(input.runId);
      if (existing) { requireFact(existing.researchId === input.researchId && existing.sessionId === input.sessionId
        && existing.phase === input.phase && isDeepStrictEqual(existing.plan, input.plan)); return existing; }
      const run = db.query('SELECT session_id,kind,status,cancel_requested_at FROM runs WHERE id=?').get(input.runId) as { session_id: number; kind: string; status: string; cancel_requested_at: string | null } | null;
      requireFact(run && run.kind === 'agent' && run.session_id === task.session_id && input.sessionId === task.session_id
        && ['created', 'running'].includes(run.status) && run.cancel_requested_at === null);
      const permission = sessions.isModelUseBlocked(task.session_id); requireFact(permission.ok && !permission.data, 'research_source_denied');
      let policy = ResearchSourcePolicySchema.parse(JSON.parse(task.source_policy_json));
      if (input.phase === 'planning') requireFact(input.plan === null);
      else {
        requireFact(input.phase === 'researching' && input.plan && input.plan.planId === task.current_plan_id, 'research_plan_stale');
        const plan = record('plan', task.id, input.plan.planId); requireFact(plan.revision === input.plan.revision, 'research_plan_stale');
        const previous = task.current_run_id === null ? null : binding(task.current_run_id);
        const wasConfirmed = confirmed(task);
        requireFact(!input.continuation || wasConfirmed, 'research_plan_not_confirmed');
        requireFact(!wasConfirmed || input.continuation, 'research_already_started');
        requireFact(wasConfirmed || previous?.runId === plan.runId, 'research_plan_not_ready');
        const planning = db.query('SELECT status,stopped_at FROM runs WHERE id=?').get(plan.runId) as { status: string; stopped_at: string | null };
        requireFact(planning.status === 'completed' && planning.stopped_at !== null, 'research_plan_not_ready'); policy = plan.body.sourcePolicy;
      }
      db.query('INSERT INTO research_runs(run_id,research_id,session_id,phase,plan_id,revision,source_policy_json,created_at) VALUES (?,?,?,?,?,?,?,?)')
        .run(input.runId, task.id, task.session_id, input.phase, input.plan?.planId ?? null, input.plan?.revision ?? null, JSON.stringify(policy), input.at);
      db.query('UPDATE research_tasks SET current_run_id=?,updated_at=? WHERE id=?').run(input.runId, input.at, task.id);
      return binding(input.runId)!;
    }),
    savePlan: input => operation(true, () => {
      const body = parseInput(ResearchPlanBodySchema, input.body), found = duplicate('plan', input, body); if (found) return found;
      const value = execution(input, 'save_research_plan', true); requireFact(value.phase === 'planning', 'research_phase_invalid');
      requireFact(sourceSubset(body.sourcePolicy, value.sourcePolicy), 'research_source_denied');
      const revision = (db.query('SELECT COALESCE(MAX(revision),0)+1 AS n FROM research_plans WHERE research_id=?').get(input.researchId) as { n: number }).n;
      const row = db.query('INSERT INTO research_plans(research_id,revision,run_id,tool_call_id,body_json,created_at) VALUES (?,?,?,?,?,?)')
        .run(input.researchId, revision, input.runId, input.toolCallId, JSON.stringify(body), input.at);
      const id = Number(row.lastInsertRowid);
      db.query('UPDATE research_tasks SET current_plan_id=?,updated_at=? WHERE id=?').run(id, input.at, input.researchId);
      return record('plan', input.researchId, id);
    }),
    getPlan: input => operation(false, () => record('plan', input.researchId, input.planId)),
    saveSource: input => operation(true, () => {
      const source = parseInput(ResearchSourceDataSchema, input.source), found = duplicate('source', input, source); if (found) return found;
      const value = execution(input, 'read_research_local', false);
      checkSource(source, value.sourcePolicy);
      requireFact(source.relativePath === `artifacts/research/${input.researchId}/source-${input.toolCallId}.txt`);
      const row = db.query('INSERT INTO research_sources(research_id,run_id,tool_call_id,artifact_id,document_id,body_json,created_at) VALUES (?,?,?,?,?,?,?)')
        .run(input.researchId, input.runId, input.toolCallId, source.artifactId, source.documentId, JSON.stringify(source), input.at);
      return record('source', input.researchId, Number(row.lastInsertRowid));
    }),
    getSource: input => operation(false, () => record('source', input.researchId, input.sourceSnapshotId)),
    listSources: input => operation(false, () => listRecords('source', input)),
    saveClaim: input => operation(true, () => {
      const claim = parseInput(ResearchClaimBodySchema, input.claim), found = duplicate('claim', input, claim); if (found) return found;
      const value = execution(input, 'save_research_claim', true), plan = currentPlan(value);
      requireFact(questionIds(plan).includes(claim.questionId));
      const dependencies = claim.dependencies.map(id => record('claim', input.researchId, id));
      requireFact(dependencies.every(dependency => dependency.planId === plan.planId));
      for (const { ref } of claim.evidence) {
        requireFact(ref.researchId === input.researchId && ref.planId === plan.planId && ref.revision === plan.revision);
        const source = record('source', input.researchId, ref.sourceSnapshotId); checkSource(source, value.sourcePolicy);
        requireFact(source.runId === ref.runId && source.toolCallId === ref.toolCallId && ref.locator.end <= source.characters);
        requireFact(!source.truncated || !['supported', 'refuted'].includes(claim.verification.status), 'research_evidence_incomplete');
      }
      if (claim.verification.status === 'supported') requireFact(claim.evidence.some(e => e.relation === 'supports')
        && claim.evidence.every(e => e.relation === 'supports') && dependencies.every(dependency => dependency.verification.status === 'supported'), 'research_evidence_incomplete');
      if (claim.verification.status === 'refuted') requireFact(claim.evidence.some(e => e.relation === 'refutes')
        && claim.evidence.every(e => e.relation === 'refutes'), 'research_evidence_incomplete');
      const row = db.query('INSERT INTO research_claims(research_id,plan_id,revision,run_id,tool_call_id,body_json,created_at) VALUES (?,?,?,?,?,?,?)')
        .run(input.researchId, plan.planId, plan.revision, input.runId, input.toolCallId, JSON.stringify(claim), input.at);
      return record('claim', input.researchId, Number(row.lastInsertRowid));
    }),
    getClaim: input => operation(false, () => record('claim', input.researchId, input.claimId)),
    listClaims: input => operation(false, () => listRecords('claim', input)),
    saveReport: input => operation(true, () => {
      const report = parseInput(ResearchReportBodySchema, input.report), found = duplicate('report', input, report); if (found) return found;
      const value = execution(input, 'save_research_report', true), plan = currentPlan(value), questions = questionIds(plan);
      requireFact(report.coverage.length === questions.length && report.coverage.every(c => questions.includes(c.questionId)), 'research_coverage_invalid',
        'coverage must contain exactly one record for every confirmed plan questionId, with no missing or unknown questions.');
      const ids = new Set([...report.sections.flatMap(s => s.claimIds), ...report.coverage.flatMap(c => c.claimIds)]);
      const claims = new Map([...ids].map(id => [id, record('claim', input.researchId, id)]));
      requireFact([...claims.values()].every(c => c.planId === plan.planId));
      requireFact(report.coverage.every(c => c.claimIds.every(id => claims.get(id)!.questionId === c.questionId)), 'research_coverage_invalid',
        'Each coverage.claimIds entry must reference a saved Claim for that same questionId and confirmed plan.');
      requireFact(report.coverage.every(c => c.status !== 'covered' || c.claimIds.length > 0
        && c.claimIds.every(id => claims.get(id)!.verification.status === 'supported')),
        report.completeness === 'full' ? 'research_evidence_incomplete' : 'research_coverage_invalid',
        'coverage.status=covered requires non-empty claimIds with every Claim verification.status=supported. Use gap or conflict for unsupported coverage.');
      if (report.completeness === 'full') {
        requireFact(report.coverage.every(c => c.status === 'covered' && c.claimIds.length > 0), 'research_evidence_incomplete',
          'completeness=full requires every planned question coverage.status=covered and non-empty claimIds. Correct the evidence or explicitly submit partial with gaps within the remaining budget.');
        requireFact([...claims.values()].every(c => c.verification.status === 'supported'), 'research_evidence_incomplete',
          'completeness=full requires every referenced Claim verification.status=supported. Preserve unsupported findings in an explicit partial report.');
        requireFact(report.unresolvedQuestions.length === 0, 'research_evidence_incomplete',
          'completeness=full requires unresolvedQuestions=[]. Resolve the questions with supported evidence or explicitly submit partial with the unresolved questions within the remaining budget.');
      }
      const row = db.query('INSERT INTO research_reports(research_id,plan_id,revision,run_id,tool_call_id,body_json,created_at) VALUES (?,?,?,?,?,?,?)')
        .run(input.researchId, plan.planId, plan.revision, input.runId, input.toolCallId, JSON.stringify(report), input.at);
      const id = Number(row.lastInsertRowid);
      db.query('UPDATE research_tasks SET current_report_id=?,updated_at=? WHERE id=?').run(id, input.at, input.researchId);
      return record('report', input.researchId, id);
    }),
    getReport: input => operation(false, () => record('report', input.researchId, input.reportId)),
    listReports: input => operation(false, () => listRecords('report', input)),
  };
}
