import { describe, expect, it } from 'bun:test';
import { readFileSync, mkdirSync } from 'node:fs';
import { Database } from 'bun:sqlite';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync, deferCleanup } from '../../support/resources.ts';
import { openTestDatabase } from '../../support/database.ts';
import { openTestDatabase as openDatabase } from '../../support/database.ts';
import { citedSentence, createResearchReviewReceipt } from '../../support/research.ts';
import type { Result } from '@flowmate/contracts';
import { RESEARCH_SEMANTIC_POLICY_VERSION, TOOL_CONFIG, projectCitedResearchReport } from '@flowmate/contracts';

const at = '2026-10-10T00:00:00.000Z';
const body = {
  question: 'Compare three deployment options.', scope: 'Public documents',
  dimensions: [{ id: 'cost', title: 'Cost', questions: [{ id: 'cost-1', question: 'What costs apply?', evidenceNeeded: ['Official pricing'] }] }],
  sourcePolicy: { web: false, domains: [], artifactIds: [1], documentIds: [] },
  stopConditions: ['Each dimension has evidence or an explicit gap.'],
  execution: { budget: { maxModelCalls: 12, maxToolCalls: 24, toolTimeoutMs: 10000 }, timeoutMs: 60000, stopGraceMs: 5000 },
};
function need<T>(value: Result<T>): T { if (!value.ok) throw new Error(value.error.code); return value.data; }
function paths(root = mkdtempSync(join(tmpdir(), 'flowmate-research-'))) {
  return { root, databaseFile: join(root, 'data', 'app.sqlite'), runtimeDir: join(root, 'runtime'),
    artifactsDir: join(root, 'artifacts'), logsDir: join(root, 'logs'), outputsDir: join(root, 'outputs') };
}
function fixture() {
  const store = need(openTestDatabase(paths()));
  store.db.query("INSERT INTO artifacts(id,kind,relative_path,bytes,mime_type,metadata_json,created_at) VALUES (1,'original','artifacts/1/source.txt',10,'text/plain','{}',?)").run(at);
  const session = need(store.sessions.create({ nativeSessionId: 'research-one', title: 'Research', at }));
  expect(store.research).toBeDefined();
  const task = need(store.research.create({ sessionId: session.sessionId, title: 'Deployment options', sourcePolicy: body.sourcePolicy, at }));
  return { store, sessionId: session.sessionId, task };
}
function run(f: ReturnType<typeof fixture>, phase: 'planning' | 'researching', plan?: { planId: number; revision: number }) {
  const saved = f.store.db.query(`INSERT INTO runs(kind,session_id,scope_json,status,goal,input_json,config_json,cleanup_json,usage_json,created_at,started_at)
    VALUES ('agent',?,'{"version":2,"allowedTools":[],"allowedDocumentIds":[],"allowedArtifactIds":[],"allowedResourcePaths":[]}',
    'running','isolated storage fixture','{}','{}','{}','{}',?,?)`).run(f.sessionId, at, at);
  const runId = Number(saved.lastInsertRowid);
  need(f.store.research.bindRun({ researchId: f.task.researchId, sessionId: f.sessionId, runId, phase, plan: plan ?? null, at }));
  return runId;
}
function call(f: ReturnType<typeof fixture>, runId: number, name: string, nativeToolCallId = name) {
  const c = need(f.store.toolCalls.request({ context: null, runId, sessionId: f.sessionId, nativeToolCallId, toolName: name,
    toolVersion: '1', effect: name === 'read_research_local' ? 'READ' : 'LOCAL_WRITE', rawArguments: {}, requestedAt: at }));
  need(f.store.toolCalls.fixArguments({ toolCallId: c.toolCallId, finalArguments: {} }));
  need(f.store.toolCalls.start({ toolCallId: c.toolCallId, startedAt: at }));
  return c.toolCallId;
}
function savePlan(f: ReturnType<typeof fixture>, runId: number, toolCallId: number, value = body) {
  return f.store.research.savePlan({ researchId: f.task.researchId, runId, toolCallId, body: value, at });
}
function stop(f: ReturnType<typeof fixture>, runId: number) {
  f.store.db.query(`UPDATE runs SET status='completed',output_json='{}',ended_at=?,stopped_at=? WHERE id=?`).run(at, at, runId);
}

function saveReport(f: ReturnType<typeof fixture>, input: Omit<Parameters<typeof f.store.research.saveReport>[0], 'semanticReview'>,
  evidenceBindings?: Parameters<typeof createResearchReviewReceipt>[2]) {
  const task = need(f.store.research.get(input.researchId));
  const plan = need(f.store.research.getPlan({ researchId: input.researchId, planId: task.currentPlanId! }));
  return f.store.research.saveReport({ ...input, semanticReview: createResearchReviewReceipt(input.report, {
    researchId: input.researchId, planId: plan.planId, revision: plan.revision, runId: input.runId, toolCallId: input.toolCallId, reviewedAt: at,
  }, evidenceBindings) });
}

function pricingEvidence(f: ReturnType<typeof fixture>, runId: number, plan: { planId: number; revision: number }) {
  const researchId = f.task.researchId, toolCallId = call(f, runId, 'read_research_local');
  const source = need(f.store.research.saveSource({ researchId, runId, toolCallId, at,
    source: { kind: 'local', address: 'artifact:1', title: 'Costs', artifactId: 1, documentId: null,
      fetchedAt: at, publishedAt: null, relativePath: `artifacts/research/${researchId}/source-${toolCallId}.txt`,
      bytes: 4, characters: 4, truncated: false } }));
  const ref = { researchId, planId: plan.planId, revision: plan.revision, runId, toolCallId,
    sourceSnapshotId: source.sourceSnapshotId, locator: { start: 0, end: 4, quote: 'Cost' } };
  const claim = need(f.store.research.saveClaim({ researchId, runId, toolCallId: call(f, runId, 'save_research_claim'), at,
    claim: { questionId: 'cost-1', text: 'Costs apply.', dependencies: [], evidence: [{ relation: 'supports', ref }],
      verification: { status: 'supported', reasons: ['Controlled pricing fixture.'] } } }));
  return { claim, binding: { claimId: claim.claimId, evidenceIndex: 0, ref: claim.evidence[0]!.ref, source } };
}

it.each([['unknown', 'gap', 'partial', 'research_coverage_invalid', 'coverage'],
  ['cost-1', 'gap', 'full', 'research_evidence_incomplete', 'covered'],
  ['cost-1', 'covered', 'partial', 'input_invalid', 'input']] as const)
  ('reports bounded domain constraints for %s %s %s without changing report completeness', (questionId, status, completeness, code, constraint) => {
    const f=fixture(),planning=run(f,'planning'),plan=need(savePlan(f,planning,call(f,planning,'save_research_plan'))); stop(f,planning);
    const runId=run(f,'researching',plan),toolCallId=call(f,runId,'save_research_report');
    const evidence = completeness === 'full' ? pricingEvidence(f, runId, plan) : undefined;
    const body = evidence ? [citedSentence('Potential finding.', [evidence.claim.claimId])] : [];
    const result=saveReport(f, {researchId:f.task.researchId,runId,toolCallId,at,
      report:{formatVersion:3,answer:body,sections:body.length ? [{title:'Cost',sentences:body}] : [],completeness,conflicts:[],limitations:[],unresolvedQuestions:[],
      coverage:[{questionId,claimIds:[],status,reason:'No supported claims yet.'}]}}, evidence ? [evidence.binding] : []);
    expect(result).toMatchObject({ok:false,error:{code}});
    if(result.ok)throw new Error('Invalid report unexpectedly committed.');
    if (code !== 'input_invalid') expect(result.error.message).toContain(constraint);expect(result.error.message.length).toBeLessThanOrEqual(4000);
    expect(need(f.store.research.get(f.task.researchId)).currentReportId).toBeNull();
  });

function legacy18(p: ReturnType<typeof paths>) {
  mkdirSync(join(p.root, 'data'), { recursive: true });
  const db = new Database(p.databaseFile);
  try {
    db.exec('PRAGMA foreign_keys=ON');
    for (const [version, name] of ['001_provider','002_agent_sessions','003_invoice_tools','004_parsed_documents','005_native_session_history',
      '006_hidden_processing','007_hidden_chats_invoices','008_native_entry_runs','009_session_inputs','010_human_candidates','011_session_management',
      '012_tool_runtime_observations','013_runtime_events','014_workspace_selection','015_context_snapshots','016_native_history_commits','017_subagent_runs','018_subagent_parallel'].entries()) {
      if (version === 16) db.exec('PRAGMA foreign_keys=OFF; PRAGMA legacy_alter_table=ON;');
      db.exec(readFileSync(new URL(`../../../packages/core/src/storage/migrations/${name}.sql`, import.meta.url), 'utf8'));
      if (db.inTransaction) db.exec('COMMIT');
      if (version === 16) db.exec('PRAGMA foreign_keys=ON; PRAGMA legacy_alter_table=OFF;');
    }
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

describe('P15 research storage, isolated engineering fixtures', () => {
  it('owns one dedicated Session and exposes bounded stable list pagination', () => {
    const f = fixture();
    expect(f.store.research.create({ sessionId: f.sessionId, title: 'Duplicate', sourcePolicy: body.sourcePolicy, at })).toMatchObject({ ok: false });
    expect(f.store.research.create({ sessionId: 999, title: 'Forged', sourcePolicy: body.sourcePolicy, at })).toMatchObject({ ok: false });
    const s = need(f.store.sessions.create({ nativeSessionId: 'research-two', title: 'Second', at }));
    const second = need(f.store.research.create({ sessionId: s.sessionId, title: 'Second', sourcePolicy: body.sourcePolicy, at }));
    expect(need(f.store.research.list({ limit: 1 }))).toMatchObject({ items: [{ researchId: second.researchId }], nextBeforeId: second.researchId });
    expect(need(f.store.research.list({ limit: 1, beforeId: second.researchId }))).toMatchObject({ items: [{ researchId: f.task.researchId }], nextBeforeId: null });
    expect(f.store.research.list({ limit: 1001 })).toMatchObject({ ok: false });
    expect(need(f.store.research.get(f.task.researchId))).toMatchObject({ sessionId: f.sessionId, status: 'planning', currentPlanId: null });
  });

  it('saves immutable plan versions once per actual tool call and waits for the planning Run to stop', () => {
    const f = fixture(), runId = run(f, 'planning'), toolCallId = call(f, runId, 'save_research_plan');
    const first = need(savePlan(f, runId, toolCallId));
    expect(first).toMatchObject({ revision: 1, body });
    expect(savePlan(f, runId, toolCallId)).toEqual({ ok: true, data: first });
    expect(savePlan(f, runId, toolCallId, { ...body, scope: 'Changed' })).toMatchObject({ ok: false, error: { code: 'research_identity_conflict' } });
    expect(need(f.store.research.get(f.task.researchId)).status).toBe('planning');
    stop(f, runId);
    expect(need(f.store.research.get(f.task.researchId)).status).toBe('awaiting_confirmation');
    const nextRun = run(f, 'planning'), nextCall = call(f, nextRun, 'save_research_plan', 'version-two');
    const next = need(savePlan(f, nextRun, nextCall, { ...body, scope: 'Revised' }));
    expect(next.revision).toBe(2);
    expect(need(f.store.research.getPlan({ researchId: f.task.researchId, planId: first.planId }))).toEqual(first);
    expect(() => f.store.db.query('UPDATE research_plans SET body_json=? WHERE id=?').run('{}', first.planId)).toThrow();
    stop(f, nextRun);
    const raw = f.store.db.query(`INSERT INTO runs(kind,session_id,scope_json,status,goal,input_json,config_json,cleanup_json,usage_json,created_at,started_at)
      VALUES ('agent',?,'{}','running','stale plan fixture','{}','{}','{}','{}',?,?)`).run(f.sessionId, at, at);
    expect(f.store.research.bindRun({ researchId: f.task.researchId, sessionId: f.sessionId, runId: Number(raw.lastInsertRowid),
      phase: 'researching', plan: { planId: first.planId, revision: 1 }, at })).toMatchObject({ ok: false, error: { code: 'research_plan_stale' } });
  });

  it('rejects foreign, nonexistent or wrong-phase execution and rolls back failed plan publication', () => {
    const f = fixture(), runId = run(f, 'planning'), toolCallId = call(f, runId, 'save_research_plan');
    expect(savePlan(f, runId + 1, toolCallId)).toMatchObject({ ok: false });
    expect(savePlan(f, runId, toolCallId + 1)).toMatchObject({ ok: false });
    f.store.db.exec(`CREATE TRIGGER fail_plan_pointer BEFORE UPDATE OF current_plan_id ON research_tasks BEGIN SELECT RAISE(ABORT,'isolated fault'); END;`);
    expect(savePlan(f, runId, toolCallId)).toMatchObject({ ok: false, error: { code: 'research_write_failed' } });
    expect(f.store.db.query('SELECT COUNT(*) AS n FROM research_plans').get()).toEqual({ n: 0 });
    expect(need(f.store.research.get(f.task.researchId)).currentPlanId).toBeNull();
  });

  it('reports interruption without pretending that an unknown stop has released execution', () => {
    const f = fixture(), runId = run(f, 'planning');
    f.store.db.query("UPDATE runs SET status='failed',error_json=?,ended_at=? WHERE id=?")
      .run(JSON.stringify({ code: 'runtime_interrupted', category: 'runtime', message: 'Interrupted', retryable: false }), at, runId);
    expect(need(f.store.research.get(f.task.researchId)).status).toBe('interrupted');
    expect(f.store.db.query('SELECT stopped_at FROM runs WHERE id=?').get(runId)).toEqual({ stopped_at: null });
  });

  it('does not offer an old plan for confirmation after a later planning Run produces none', () => {
    const f = fixture(), firstRun = run(f, 'planning');
    const first = need(savePlan(f, firstRun, call(f, firstRun, 'save_research_plan'))); stop(f, firstRun);
    const laterRun = run(f, 'planning'); stop(f, laterRun);
    expect(need(f.store.research.get(f.task.researchId))).toMatchObject({ status: 'failed', currentPlanId: first.planId });
  });

  it('keeps source, Claim and report ownership tied to a confirmed plan and real execution', () => {
    const f = fixture(), planning = run(f, 'planning');
    const plan = need(savePlan(f, planning, call(f, planning, 'save_research_plan')));
    stop(f, planning);
    const runId = run(f, 'researching', plan), toolCallId = call(f, runId, 'read_research_local');
    const saveSource = (toolCallId: number) => need(f.store.research.saveSource({ researchId: f.task.researchId, runId, toolCallId,
      source: { kind: 'local', address: 'artifact:1', title: 'Local pricing', artifactId: 1, documentId: null,
        fetchedAt: at, publishedAt: null, relativePath: `artifacts/research/${f.task.researchId}/source-${toolCallId}.txt`,
        bytes: 10, characters: 10, truncated: false }, at }));
    const source = saveSource(toolCallId);
    expect(source).toMatchObject({ runId, toolCallId, publishedAt: null });
    const ref = { researchId: f.task.researchId, planId: plan.planId, revision: plan.revision, runId, toolCallId,
      sourceSnapshotId: source.sourceSnapshotId, locator: { start: 0, end: 4, quote: 'Cost' } };
    const claimCall = call(f, runId, 'save_research_claim');
    const draft = { questionId: 'cost-1', text: 'Cost depends on usage.', dependencies: [], evidence: [{ relation: 'supports' as const, ref }],
      verification: { status: 'unverified' as const, reasons: ['Pending semantic verification.'] } };
    const claim = need(f.store.research.saveClaim({ researchId: f.task.researchId, runId, toolCallId: claimCall, claim: draft, at }));
    expect(f.store.research.saveClaim({ researchId: f.task.researchId, runId, toolCallId: claimCall,
      claim: { ...draft, text: 'Different' }, at })).toMatchObject({ ok: false, error: { code: 'research_identity_conflict' } });
    const invalidCall = call(f, runId, 'save_research_claim', 'forged-claim');
    const otherSource = saveSource(call(f, runId, 'read_research_local', 'second-source'));
    expect(f.store.research.saveClaim({ researchId: f.task.researchId, runId, toolCallId: invalidCall,
      claim: { ...draft, evidence: [{ relation: 'supports', ref: { ...ref, sourceSnapshotId: otherSource.sourceSnapshotId } }] }, at }))
      .toMatchObject({ ok: false, error: { code: 'research_identity_conflict' } });
    for (const bad of [{ ...ref, researchId: 999 }, { ...ref, toolCallId: 999 }, { ...ref, revision: 99 },
      { ...ref, locator: { start: 0, end: 99, quote: 'Cost' } }]) {
      expect(f.store.research.saveClaim({ researchId: f.task.researchId, runId, toolCallId: invalidCall,
        claim: { ...draft, evidence: [{ relation: 'supports', ref: bad }] }, at })).toMatchObject({ ok: false });
    }
    expect(f.store.research.saveClaim({ researchId: f.task.researchId, runId, toolCallId: invalidCall,
      claim: { ...draft, dependencies: [999] }, at })).toMatchObject({ ok: false });
    expect(f.store.research.saveClaim({ researchId: f.task.researchId, runId, toolCallId: invalidCall,
      claim: { ...draft, dependencies: [claim.claimId], verification: { status: 'supported', reasons: ['Pretend the unverified intermediate link is complete.'] } }, at }))
      .toMatchObject({ ok: false, error: { code: 'research_evidence_incomplete' } });
    expect(f.store.research.saveClaim({ researchId: f.task.researchId, runId, toolCallId: invalidCall,
      claim: { ...draft, evidence: [...draft.evidence, { relation: 'refutes', ref }],
        verification: { status: 'supported', reasons: ['Pretend conflicting evidence is resolved.'] } }, at }))
      .toMatchObject({ ok: false, error: { code: 'research_evidence_incomplete' } });
    const reportCall = call(f, runId, 'save_research_report');
    expect(saveReport(f, { researchId: f.task.researchId, runId, toolCallId: reportCall,
      report: { formatVersion: 3, answer: [citedSentence('Usage is metered.', [claim.claimId])],
        sections: [{ title: 'Cost', sentences: [citedSentence('Usage is metered.', [claim.claimId])] }],
        completeness: 'partial', conflicts: [], limitations: ['Not verified.'], unresolvedQuestions: ['Cost conditions'],
        coverage: [{ questionId: 'cost-1', claimIds: [claim.claimId], status: 'covered', reason: 'Pretend the question is covered.' }] }, at },
      [{ claimId: claim.claimId, evidenceIndex: 0, ref: claim.evidence[0]!.ref, source }]))
      .toMatchObject({ ok: false, error: { code: 'research_coverage_invalid' } });
    const report = need(saveReport(f, { researchId: f.task.researchId, runId, toolCallId: reportCall,
      report: { formatVersion: 3, answer: [], sections: [],
        completeness: 'partial', conflicts: [], limitations: ['Not verified.'], unresolvedQuestions: ['Cost conditions'],
        coverage: [{ questionId: 'cost-1', claimIds: [claim.claimId], status: 'gap', reason: 'Pending verification.' }] }, at }));
    expect(need(f.store.research.get(f.task.researchId)).status).toBe('researching');
    stop(f, runId);
    expect(need(f.store.research.get(f.task.researchId))).toMatchObject({ status: 'partial', currentReportId: report.reportId });
    expect(need(f.store.research.getReport({ researchId: f.task.researchId, reportId: report.reportId }))).toEqual(report);
    expect(f.store.research.getReport({ researchId: 999, reportId: report.reportId })).toMatchObject({ ok: false });
    expect(() => f.store.db.query('DELETE FROM sessions WHERE id=?').run(f.sessionId)).toThrow();
    const revisionRun = run(f, 'planning');
    const revised = need(savePlan(f, revisionRun, call(f, revisionRun, 'save_research_plan', 'revision-plan'))); stop(f, revisionRun);
    const emptyInvestigation = run(f, 'researching', revised); stop(f, emptyInvestigation);
    expect(need(f.store.research.get(f.task.researchId))).toMatchObject({ status: 'failed', currentReportId: report.reportId });
  });

  it('requires a receipt for the exact report, confirmed plan and writing ToolCall', () => {
    const f = fixture(), planning = run(f, 'planning');
    const plan = need(savePlan(f, planning, call(f, planning, 'save_research_plan'))); stop(f, planning);
    const runId = run(f, 'researching', plan), toolCallId = call(f, runId, 'save_research_report');
    const researchId = f.task.researchId;
    const report = { formatVersion: 3 as const, answer: [], sections: [], completeness: 'partial' as const,
      conflicts: [], limitations: [], unresolvedQuestions: [],
      coverage: [{ questionId: 'cost-1', claimIds: [], status: 'gap' as const, reason: 'No pricing is available.' }] };
    const input = { researchId, runId, toolCallId, report, at };
    const semanticReview = createResearchReviewReceipt(report, { researchId, runId, toolCallId, planId: plan.planId,
      revision: plan.revision, reviewedAt: at });
    // @ts-expect-error The required receipt must also be checked at runtime.
    expect(f.store.research.saveReport(input)).toMatchObject({ ok: false, error: { code: 'input_invalid' } });
    for (const receipt of [{ ...semanticReview, planId: plan.planId + 1 }, { ...semanticReview, revision: plan.revision + 1 },
      { ...semanticReview, runId: planning }, { ...semanticReview, toolCallId: call(f, runId, 'save_research_report', 'other-report') }]) {
      expect(f.store.research.saveReport({ ...input, semanticReview: receipt }))
        .toMatchObject({ ok: false, error: { code: 'research_review_mismatch' } });
    }
    expect(f.store.research.saveReport({ ...input, report: { ...report, limitations: ['A later edit.'] }, semanticReview }))
      .toMatchObject({ ok: false, error: { code: 'input_invalid' } });
    expect(need(f.store.research.listReports({ researchId, limit: 10 })).items).toEqual([]);
    expect(need(f.store.research.get(researchId)).currentReportId).toBeNull();
    const saved = need(f.store.research.saveReport({ ...input, semanticReview }));
    expect(saved.semanticReview).toEqual(semanticReview);
    expect(saved.semanticReview).toMatchObject({ policyVersion: RESEARCH_SEMANTIC_POLICY_VERSION,
      status: 'no_findings', evidenceBindings: [], context: { mode: 'full', segments: [] }, stages: [] });
    expect(f.store.research.saveReport({ ...input, semanticReview })).toEqual({ ok: true, data: saved });
    stop(f, runId);
    expect(f.store.research.saveReport({ ...input, semanticReview })).toEqual({ ok: true, data: saved });
    const changedReport = { ...report, limitations: ['A later edit after completion.'] };
    const changedReview = createResearchReviewReceipt(changedReport, { researchId, runId, toolCallId, planId: plan.planId,
      revision: plan.revision, reviewedAt: at });
    expect(f.store.research.saveReport({ ...input, report: changedReport, semanticReview: changedReview }))
      .toMatchObject({ ok: false, error: { code: 'research_identity_conflict' } });
    expect(need(f.store.research.listReports({ researchId, limit: 10 })).items).toEqual([saved]);
  });

  it('reads historical v1 receipts but only writes v2 receipts bound to saved Claims, Sources and complete context', () => {
    const f = fixture(), planning = run(f, 'planning');
    const plan = need(savePlan(f, planning, call(f, planning, 'save_research_plan'))); stop(f, planning);
    const runId = run(f, 'researching', plan), researchId = f.task.researchId;
    const { claim, binding } = pricingEvidence(f, runId, plan);
    const historicalCall = call(f, runId, 'save_research_report', 'historical-report');
    const toolCallId = call(f, runId, 'save_research_report');
    const report = { formatVersion: 3 as const, answer: [citedSentence('Costs apply.', [claim.claimId])], sections: [],
      completeness: 'partial' as const, conflicts: [], limitations: [], unresolvedQuestions: [],
      coverage: [{ questionId: 'cost-1', claimIds: [claim.claimId], status: 'covered' as const, reason: 'Costs documented.' }] };
    const semanticReview = createResearchReviewReceipt(report, { researchId, runId, toolCallId, planId: plan.planId,
      revision: plan.revision, reviewedAt: at }, [binding]);
    if (semanticReview.status !== 'verified') throw Error('Expected a controlled finding review.');
    const { evidenceBindings: _bindings, context, stages: _stages, ...historicalFields } = semanticReview;
    const historical = { ...historicalFields, policyVersion: 'research-semantic-v1' as const, toolCallId: historicalCall,
      sentences: historicalFields.sentences.map(({ citationReviews: _reviews, ...row }) => row) };
    const legacy = f.store.db.query(`INSERT INTO research_reports(research_id,plan_id,revision,run_id,tool_call_id,body_json,created_at)
      VALUES (?,?,?,?,?,?,?)`).run(researchId, plan.planId, plan.revision, runId, historicalCall,
      JSON.stringify({ ...report, semanticReview: historical }), at);
    expect(need(f.store.research.getReport({ researchId, reportId: Number(legacy.lastInsertRowid) })).semanticReview).toEqual(historical);
    const input = { researchId, runId, toolCallId, report, at };
    for (const receipt of [
      { ...historical, toolCallId },
      { ...semanticReview, evidenceBindings: [{ ...binding, ref: { ...binding.ref, locator: { ...binding.ref.locator, quote: 'Fees' } } }] },
      { ...semanticReview, evidenceBindings: [{ ...binding, source: { ...binding.source, title: 'Substituted source title' } }] },
      { ...semanticReview, context: { ...context!, segments: [{ ...context!.segments[0]!, start: 1, readStart: 1 }] } },
    ]) expect(f.store.research.saveReport({ ...input, semanticReview: receipt }))
      .toMatchObject({ ok: false, error: { code: 'research_review_mismatch' } });
    expect(need(f.store.research.get(researchId)).currentReportId).toBeNull();
    expect(need(f.store.research.listReports({ researchId, limit: 10 })).items).toHaveLength(1);
    const saved = need(f.store.research.saveReport({ ...input, semanticReview }));
    expect(saved.semanticReview).toEqual(semanticReview);
    expect(need(f.store.research.getReport({ researchId, reportId: saved.reportId }))).toEqual(saved);
  });

  it('refuses an otherwise valid report whose ToolCall result envelope would exceed storage limits', () => {
    const f = fixture(), planning = run(f, 'planning');
    const plan = need(savePlan(f, planning, call(f, planning, 'save_research_plan'))); stop(f, planning);
    const runId = run(f, 'researching', plan), researchId = f.task.researchId;
    const { claim, binding } = pricingEvidence(f, runId, plan);
    const toolCallId = call(f, runId, 'save_research_report');
    const report = { formatVersion: 3 as const, answer: [citedSentence('Costs apply.', [claim.claimId])], sections: [],
      completeness: 'partial' as const, conflicts: [], limitations: [], unresolvedQuestions: [],
      coverage: [{ questionId: 'cost-1', claimIds: [claim.claimId], status: 'covered' as const, reason: 'Costs documented.' }] };
    const semanticReview = createResearchReviewReceipt(report, { researchId, runId, toolCallId, planId: plan.planId,
      revision: plan.revision, reviewedAt: at }, [binding]);
    if (semanticReview.status !== 'verified') throw Error('Expected a controlled finding review.');
    const fact = { ...semanticReview.sentences[0]!.facts[0]!, reason: 'x'.repeat(512) };
    const metadata = { researchId, planId: plan.planId, revision: plan.revision, runId, toolCallId,
      reportId: Number.MAX_SAFE_INTEGER, createdAt: at };
    const projected = () => ({ ...projectCitedResearchReport({ ...report, semanticReview }), ...metadata });
    semanticReview.sentences[0]!.facts = [fact];
    const targetBytes = TOOL_CONFIG.payload.maxOutputBytes - 1;
    const check = semanticReview.sentences[0]!.citationReviews![0]!;
    const contribution = check.contributions[0]!;
    const extraFactBytes = Buffer.byteLength(JSON.stringify(fact)) + Buffer.byteLength(JSON.stringify(contribution)) + 2;
    const count = Math.ceil((targetBytes - Buffer.byteLength(JSON.stringify(projected()))) / extraFactBytes) + 1;
    semanticReview.sentences[0]!.facts = Array.from({ length: count }, () => ({ ...fact }));
    check.contributions = Array.from({ length: count }, (_, factIndex) => ({ ...contribution, factIndex }));
    let excess = Buffer.byteLength(JSON.stringify(projected())) - targetBytes;
    for (const item of semanticReview.sentences[0]!.facts) {
      const removed = Math.min(excess, item.reason.length - 1);
      item.reason = item.reason.slice(removed); excess -= removed;
      if (excess === 0) break;
    }
    expect(Buffer.byteLength(JSON.stringify(projected()))).toBe(targetBytes);
    expect(Buffer.byteLength(JSON.stringify({ version: 1, status: 'succeeded', committedCandidateId: null, data: projected() })))
      .toBeGreaterThan(TOOL_CONFIG.payload.maxStoredResultEnvelopeBytes);
    const rejected = f.store.research.saveReport({ researchId, runId, toolCallId, report, semanticReview, at });
    expect(rejected.ok).toBe(false);
    if (rejected.ok) throw Error('An oversized ToolCall result envelope was committed.');
    expect(rejected.error.code).toBe('research_report_too_large');
    expect(need(f.store.research.get(researchId)).currentReportId).toBeNull();
    expect(need(f.store.research.listReports({ researchId, limit: 10 })).items).toEqual([]);
    const envelopeBytes = () => Buffer.byteLength(JSON.stringify({ version: 1, status: 'succeeded', committedCandidateId: null, data: projected() }));
    let envelopeExcess = envelopeBytes() - TOOL_CONFIG.payload.maxStoredResultEnvelopeBytes;
    for (const item of semanticReview.sentences[0]!.facts) {
      const removed = Math.min(envelopeExcess, item.reason.length - 1);
      item.reason = item.reason.slice(removed); envelopeExcess -= removed;
      if (envelopeExcess === 0) break;
    }
    expect(envelopeBytes()).toBe(TOOL_CONFIG.payload.maxStoredResultEnvelopeBytes);
    const accepted = need(f.store.research.saveReport({ researchId, runId, toolCallId, report, semanticReview, at }));
    expect(need(f.store.research.get(researchId)).currentReportId).toBe(accepted.reportId);
    expect(need(f.store.research.getReport({ researchId, reportId: accepted.reportId }))).toEqual(accepted);
  });

  it('upgrades an existing v18 store without fabricating research identities or changing old records', () => {
    const p = paths(), db = legacy18(p);
    db.query("INSERT INTO sessions(native_session_id,title,status,created_at,updated_at) VALUES ('legacy-research-fixture','Legacy','active',?,?)").run(at, at);
    const columns = db.query<{ name: string }, []>('PRAGMA table_info(sessions)').all().map(row => row.name);
    const before = db.query('SELECT * FROM sessions').all(); db.close();
    const store = need(openDatabase(p)); deferCleanup(() => store.close());
    expect(store.db.query(`SELECT ${columns.join(',')} FROM sessions`).all()).toEqual(before);
    expect(store.db.query('SELECT runtime_kind,durable_conversation_id FROM sessions').all())
      .toEqual([{ runtime_kind: 'agent_session', durable_conversation_id: null }]);
    expect(store.db.query('SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1').get()).toEqual({ version: 30 });
    expect(need(store.research.list({ limit: 50 })).items).toEqual([]);
    expect(store.db.query('PRAGMA foreign_key_check').all()).toEqual([]);
  });

  it('rolls the entire research migration back when its final registration fails, preserving the v18 database', () => {
    const p = paths(), db = legacy18(p);
    db.query("INSERT INTO sessions(native_session_id,title,status,created_at,updated_at) VALUES ('rollback-fixture','Keep me','active',?,?)").run(at, at);
    db.exec("CREATE TRIGGER fail_research_migration BEFORE INSERT ON schema_migrations WHEN NEW.version=19 BEGIN SELECT RAISE(ABORT,'isolated fixture'); END;");
    const before = { schema: db.query('SELECT name,sql FROM sqlite_master ORDER BY name').all(), sessions: db.query('SELECT * FROM sessions').all(),
      versions: db.query('SELECT * FROM schema_migrations ORDER BY version').all() }; db.close();
    expect(openDatabase(p)).toMatchObject({ ok: false, error: { code: 'storage_open_failed' } });
    const audit = new Database(p.databaseFile, { readonly: true }); deferCleanup(() => audit.close());
    expect({ schema: audit.query('SELECT name,sql FROM sqlite_master ORDER BY name').all(), sessions: audit.query('SELECT * FROM sessions').all(),
      versions: audit.query('SELECT * FROM schema_migrations ORDER BY version').all() }).toEqual(before);
  });
});
