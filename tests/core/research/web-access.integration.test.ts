import { expect, it } from 'bun:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ResearchPlanBody, ResearchStep, Result } from '@flowmate/contracts';
import { openTestDatabase } from '../../support/database.ts';
import { mkdtempSync } from '../../support/resources.ts';

const at = '2026-10-10T00:00:00.000Z';
const updatedAt = '2026-10-10T00:01:00.000Z';
const planBody = {
  question: 'Compare deployment options.', scope: 'Deployment costs',
  dimensions: [{ id: 'cost', title: 'Cost', questions: [{ id: 'cost-1', question: 'What costs apply?', evidenceNeeded: ['Published costs'] }] }],
  stopConditions: ['Identify supported costs.'],
  execution: { budget: { maxModelCalls: 12, maxToolCalls: 24, toolTimeoutMs: 10000 }, timeoutMs: 60000, stopGraceMs: 5000 },
};
const localStep: ResearchStep = { id: 'local', tool: 'read_research_local', questionIds: ['cost-1'], input: { artifactId: 1, documentId: null } };
function need<T>(value: Result<T>): T { if (!value.ok) throw new Error(JSON.stringify(value.error)); return value.data; }

function fixture(web = true) {
  const root = mkdtempSync(join(tmpdir(), 'flowmate-research-web-access-'));
  const { db, research, sessions, toolCalls } = need(openTestDatabase({ root, databaseFile: join(root, 'data', 'app.sqlite'),
    runtimeDir: join(root, 'runtime'), artifactsDir: join(root, 'artifacts'), logsDir: join(root, 'logs'), outputsDir: join(root, 'outputs') }));
  const { sessionId } = need(sessions.create({ nativeSessionId: 'web-access', title: 'Research', at }));
  db.query(`INSERT INTO artifacts(id,kind,relative_path,bytes,mime_type,metadata_json,created_at) VALUES
    (1,'original','artifacts/1/source.txt',10,'text/plain','{}',?), (2,'original','artifacts/2/source.txt',10,'text/plain','{}',?)`).run(at, at);
  const task = need(research.create({ sessionId, title: 'Deployment options', sourcePolicy: { web, domains: [], artifactIds: [1, 2], documentIds: [] }, at }));
  const { researchId } = task;
  const update = (web: boolean, expectedWeb: boolean, timestamp = updatedAt) => research.updateWebAccess({ researchId, web, expectedWeb, at: timestamp });
  const run = () => Number(db.query(`INSERT INTO runs(kind,session_id,scope_json,status,goal,input_json,config_json,cleanup_json,usage_json,created_at,started_at)
    VALUES ('agent',?,'{}','running','web access fixture','{}','{}','{}','{}',?,?)`).run(sessionId, at, at).lastInsertRowid);
  const bind = (runId: number, plan: { planId: number; revision: number } | null = null, continuation?: true) =>
    research.bindRun({ researchId, sessionId, runId, phase: plan ? 'researching' : 'planning', plan, continuation, at });
  const call = (runId: number, toolName: string, start = true) => {
    const tool = need(toolCalls.request({ context: null, runId, sessionId, nativeToolCallId: `${runId}:${toolName}`, toolName,
      toolVersion: '1', effect: 'LOCAL_WRITE', rawArguments: {}, requestedAt: at }));
    if (start) {
      need(toolCalls.fixArguments({ toolCallId: tool.toolCallId, finalArguments: {} }));
      need(toolCalls.start({ toolCallId: tool.toolCallId, startedAt: at }));
    }
    return tool.toolCallId;
  };
  const finishCall = (toolCallId: number, confirmed = true) => db.query(`UPDATE tool_calls SET status='failed',result_json='{}',ended_at=?,
    stopped_at=?,cleanup_json=json_object('stopped',json(?)) WHERE id=?`).run(at, confirmed ? at : null, String(confirmed), toolCallId);
  const stop = (runId: number, confirmed = true) => db.query(`UPDATE runs SET status=?,output_json=?,error_json=?,ended_at=?,
    stopped_at=?,cleanup_json=json_object('stopped',json(?)) WHERE id=?`)
    .run(confirmed ? 'completed' : 'failed', confirmed ? '{}' : null, confirmed ? null : '{}', at, confirmed ? at : null, String(confirmed), runId);
  const plan = () => {
    const runId = run(); need(bind(runId));
    const toolCallId = call(runId, 'save_research_plan');
    const saved = need(research.savePlan({ researchId, runId, toolCallId, at, body: { ...planBody, sourcePolicy: task.sourcePolicy,
      steps: task.sourcePolicy.web ? [localStep, { id: 'web', tool: 'search_research_web', questionIds: ['cost-1'], input: { query: 'deployment costs' } }] : [localStep] } }));
    finishCall(toolCallId); stop(runId);
    return saved;
  };
  return { db, research, sessions, task, researchId, run, bind, call, finishCall, stop, plan, update };
}

it('resets the current plan and run while preserving the historical report and local source policy', () => {
  const f = fixture(false), plan = f.plan(), runId = f.run();
  const reference = { planId: plan.planId, revision: plan.revision };
  need(f.bind(runId, reference));
  const toolCallId = f.call(runId, 'save_research_report');
  const saved = f.db.query('INSERT INTO research_reports(research_id,plan_id,revision,run_id,tool_call_id,body_json,created_at) VALUES(?,?,?,?,?,?,?)')
    .run(f.researchId, plan.planId, plan.revision, runId, toolCallId, JSON.stringify({ answer: 'No evidence collected.',
      sections: [{ title: 'Costs', text: 'No evidence collected.', claimIds: [] }], completeness: 'partial', conflicts: [], limitations: [],
      unresolvedQuestions: [], coverage: [{ questionId: 'cost-1', status: 'gap', claimIds: [], reason: 'No evidence collected.' }] }), at);
  const reportId = Number(saved.lastInsertRowid);
  f.db.query('UPDATE research_tasks SET current_report_id=? WHERE id=?').run(reportId, f.researchId);
  f.finishCall(toolCallId); f.stop(runId);

  const updated = need(f.update(true, false));
  expect(updated).toMatchObject({ sourcePolicy: { web: true, domains: [], artifactIds: [1, 2], documentIds: [] },
    currentRunId: null, currentPlanId: null, currentReportId: reportId, planConfirmed: false, status: 'planning', updatedAt });
  expect(need(f.research.getReport({ researchId: f.researchId, reportId })).reportId).toBe(reportId);
  expect(need(f.research.getPlan({ researchId: f.researchId, planId: plan.planId }))).toEqual(plan);
  expect(need(f.update(true, false, '2026-10-10T00:02:00.000Z'))).toEqual(updated);
  expect(f.update(false, false)).toMatchObject({ ok: false, error: { code: 'state_conflict' } });
  expect(need(f.update(false, true)).sourcePolicy).toEqual(f.task.sourcePolicy);
  expect(f.bind(f.run(), reference, true)).toMatchObject({ ok: false, error: { code: 'research_plan_stale' } });
});

it.each(['active root', 'unconfirmed old root', 'requested old tool', 'unconfirmed old tool', 'unconfirmed old child'] as const)
  ('blocks changes when execution is unsettled: %s', blocker => {
    const f = fixture(), root = f.run();
    need(f.bind(root));
    if (blocker === 'unconfirmed old child') {
      const childSession = need(f.sessions.create({ nativeSessionId: 'web-access-child', title: 'Child', at }));
      const origin = f.call(root, 'Agent');
      const child = Number(f.db.query(`INSERT INTO runs(kind,session_id,scope_json,status,goal,input_json,config_json,cleanup_json,usage_json,
        created_at,parent_run_id,origin_tool_call_id,plugin_agent_id) VALUES ('subagent',?,'{}','created','child','{}','{}','{}','{}',?,?,?,'test-child')`)
        .run(childSession.sessionId, at, root, origin).lastInsertRowid);
      f.stop(child, false); f.finishCall(origin);
    }
    if (blocker === 'requested old tool') f.call(root, 'read_research_web', false);
    if (blocker === 'unconfirmed old tool') f.finishCall(f.call(root, 'read_research_web'), false);
    if (blocker !== 'active root') {
      f.stop(root, blocker !== 'unconfirmed old root');
      const current = f.run(); need(f.bind(current)); f.stop(current);
    }
    expect(f.update(false, true)).toMatchObject({ ok: false, error: { code: 'research_web_access_busy' } });
    expect(need(f.research.get(f.researchId)).sourcePolicy.web).toBe(true);
  });

it('does not change the web policy when model use was revoked', () => {
  const f = fixture(false);
  f.db.query("UPDATE sessions SET metadata_json=json_set(metadata_json,'$.model_use_blocked',json(?)) WHERE id=?")
    .run(JSON.stringify({ at, documentIds: [1], reason: 'document_use_revoked' }), f.task.sessionId);
  expect(f.update(true, false)).toMatchObject({ ok: false, error: { code: 'research_source_denied' } });
  expect(need(f.research.get(f.researchId)).sourcePolicy.web).toBe(false);
});

it('rejects continuation if a previously confirmed plan still allows web access after the task policy changed', () => {
  const f = fixture(), plan = f.plan(), runId = f.run();
  const reference = { planId: plan.planId, revision: plan.revision };
  need(f.bind(runId, reference)); f.stop(runId);
  // Retain the old pointer to exercise the admission guard independently of the toggle's pointer reset.
  f.db.query("UPDATE research_tasks SET source_policy_json=json_set(source_policy_json,'$.web',json('false')) WHERE id=?").run(f.researchId);
  expect(f.bind(f.run(), reference, true)).toMatchObject({ ok: false, error: { code: 'research_plan_stale' } });
});

it('requires an authorized local read step when both web and local materials are available', () => {
  const f = fixture(), runId = f.run();
  need(f.bind(runId));
  const toolCallId = f.call(runId, 'save_research_plan');
  const save = (sourcePolicy: ResearchPlanBody['sourcePolicy'], steps?: ResearchPlanBody['steps']) =>
    f.research.savePlan({ researchId: f.researchId, runId, toolCallId, at, body: { ...planBody, sourcePolicy, steps } });
  const web: ResearchPlanBody['steps'] = [{ id: 'search', tool: 'search_research_web', questionIds: ['cost-1'], input: { query: 'deployment costs' } }];
  expect(save({ ...f.task.sourcePolicy, artifactIds: [] }, web)).toMatchObject({ ok: false, error: { code: 'research_plan_local_step_required' } });
  expect(save(f.task.sourcePolicy)).toMatchObject({ ok: false, error: { code: 'research_plan_local_step_required' } });
  expect(save(f.task.sourcePolicy, [localStep])).toMatchObject({ ok: false, error: { code: 'research_plan_web_step_required' } });
  expect(save({ ...f.task.sourcePolicy, web: false }, [localStep])).toMatchObject({ ok: false, error: { code: 'research_source_denied' } });
  expect(save({ ...f.task.sourcePolicy, artifactIds: [1] }, [...web, localStep])).toMatchObject({ ok: true });
});
