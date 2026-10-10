import { expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { researchFixture, researchNeed as need, researchPlan as plan } from '../../support/research.ts';
import { deferCleanup } from '../../support/resources.ts';

it('requires an initial confirmation before continuation', async () => {
  const f = await researchFixture((_request, index) => index === 1 ? { tool: 'save_research_plan', id: 'plan', args: plan } : { text: 'Plan saved.' });
  await f.run(f.request(1));
  const task = need(await f.app.queryResearchTask(f.task.researchId));
  expect((task as typeof task & { planConfirmed: boolean }).planConfirmed).toBe(false);
  const saved = need(await f.app.queryResearchPlan({ researchId: task.researchId, planId: task.currentPlanId! }));
  expect(await f.app.submitInput(f.request(2, { researchId: task.researchId, phase: 'researching', plan: { planId: saved.planId, revision: saved.revision }, continuation: true })))
    .toMatchObject({ ok: false, error: { code: 'research_plan_not_confirmed' } });
  expect(f.requests).toHaveLength(2);
});

it('retains a research task when its empty Session is deleted', async () => {
  const f = await researchFixture(() => ({ text: 'No model request is allowed.' }));
  expect(await f.app.deleteSession(f.session.sessionId)).toMatchObject({ ok: true, data: { disposition: 'hidden' } });
  expect(need(await f.app.queryResearchTask(f.task.researchId)).sessionId).toBe(f.session.sessionId);
  expect(need(await f.app.querySession(f.session.sessionId)).status).toBe('archived'); expect(f.requests).toHaveLength(0);
});

it('keeps a research Session from bypassing its task binding through ordinary Chat admission', async () => {
  const f = await researchFixture(() => ({ text: 'No request should execute.' }));
  const { research: _research, ...chat } = f.request(1);
  expect(await f.app.submitInput(chat)).toMatchObject({ ok: false, error: { code: 'research_intent_required' } });
  expect(f.requests).toHaveLength(0);
  expect(need(await f.app.queryRuntimeState()).active).toBeNull();
});

it('modifies a plan through a separate planning Run and rejects old confirmation or a changed execution budget', async () => {
  const revised = { ...plan, scope: 'Official documentation and supported versions only.' };
  const f = await researchFixture((_request, index) => index === 1 || index === 3
    ? { tool: 'save_research_plan', id: `plan-${index}`, args: index === 1 ? plan : revised } : { text: 'Plan saved.' });
  await f.run(f.request(1));
  const first = need(await f.app.queryResearchTask(f.task.researchId)).currentPlanId!;
  await f.run(f.request(2));
  const second = need(await f.app.queryResearchTask(f.task.researchId)).currentPlanId!;
  expect(second).toBeGreaterThan(first);
  const saved = need(await f.app.queryResearchPlan({ researchId: f.task.researchId, planId: second }));
  expect(saved.revision).toBe(2);
  const confirm = f.request(3, { researchId: f.task.researchId, phase: 'researching', plan: { planId: second, revision: 2 } });
  expect(await f.app.submitInput({ ...confirm, research: { ...confirm.research, plan: { planId: first, revision: 1 } } }))
    .toMatchObject({ ok: false, error: { code: 'research_plan_stale' } });
  expect(await f.app.submitInput({ ...confirm, budget: { maxToolCalls: 25 } })).toMatchObject({ ok: false, error: { code: 'research_budget_conflict' } });
  expect(f.requests).toHaveLength(4);
  expect(need(await f.app.querySessionInput({ sessionId: f.session.sessionId, clientSequence: 3 })).input).toBeNull();
});

it('rolls failed confirmation admission back with its Run, input and task pointer', async () => {
  const f = await researchFixture((_request, index) => index === 1 ? { tool: 'save_research_plan', id: 'plan-1', args: plan } : { text: 'Plan saved.' },
    db => db.exec("CREATE TRIGGER reject_research_binding BEFORE INSERT ON research_runs WHEN NEW.phase='researching' BEGIN SELECT RAISE(ABORT,'isolated admission fault'); END"));
  const planning = await f.run(f.request(1));
  const before = need(await f.app.queryResearchTask(f.task.researchId));
  expect(await f.app.submitInput(f.request(2, { researchId: f.task.researchId, phase: 'researching', plan: { planId: before.currentPlanId!, revision: 1 } })))
    .toMatchObject({ ok: false, error: { code: 'research_write_failed' } });
  expect(await f.app.queryResearchTask(f.task.researchId)).toEqual({ ok: true, data: before });
  expect(need(await f.app.queryRuntimeState()).active).toBeNull();
  expect(need(await f.app.querySessionInput({ sessionId: f.session.sessionId, clientSequence: 2 })).input).toBeNull();
  expect(need(await f.app.listSessionRuns({ sessionId: f.session.sessionId })).items.map(run => run.runId)).toEqual([planning.accepted.runId]);
});

it('does not offer confirmation after the actual plan write failed', async () => {
  const f = await researchFixture((_request, index) => index === 1 ? { tool: 'save_research_plan', id: 'plan-fail', args: plan } : { text: 'The plan could not be saved.' },
    db => db.exec("CREATE TRIGGER reject_research_plan BEFORE INSERT ON research_plans BEGIN SELECT RAISE(ABORT,'isolated plan fault'); END"));
  const planning = await f.run(f.request(1));
  const task = need(await f.app.queryResearchTask(f.task.researchId));
  expect(task.currentPlanId).toBeNull(); expect(task.status).toBe('failed');
  expect(planning.terminal.result).toMatchObject({ ok: true, data: { status: 'failed', error: { code: 'research_write_failed' } } });
  expect(need(await f.app.listRunToolCalls({ runId: planning.accepted.runId, sessionId: f.session.sessionId })).items[0]!.status).toBe('failed');
  expect(need(await f.app.close()).closed).toBe(true);
  const audit = new Database(f.paths.databaseFile, { readonly: true }); deferCleanup(() => audit.close());
  expect(audit.query('SELECT COUNT(*) AS count FROM research_plans').get()).toEqual({ count: 0 });
  expect(f.requests).toHaveLength(1);
});

it('keeps the global root occupied during planning and cancels the actual HTTP model execution', async () => {
  let entered!: () => void, release!: () => void;
  const requested = new Promise<void>(resolve => { entered = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  const f = await researchFixture(async () => { entered(); await held; return { text: 'Late output.' }; });
  deferCleanup(() => release());
  const started = await f.start(f.request(1)); const accepted = need(started.accepted); await requested;
  const other = need(await f.app.createSession({ title: 'Other task' }));
  expect(await f.app.submitInput({ ...f.request(1), sessionId: other.sessionId, research: undefined })).toMatchObject({ ok: false, error: { code: 'runtime_busy' } });
  expect(need(await f.app.cancelRun(accepted.runId)).accepted).toBe(true);
  const terminal = await started.completion;
  expect(terminal.result).toMatchObject({ ok: true, data: { status: 'cancelled', stopped: true } });
  expect(need(await f.app.queryResearchTask(f.task.researchId)).status).toBe('cancelled');
  expect(need(await f.app.queryRuntimeState()).active).toBeNull();
  expect(f.requests).toHaveLength(1); release();
});

it('returns the same receipt for concurrent confirmation retries without a second investigation', async () => {
  let entered!: () => void, release!: () => void;
  const requested = new Promise<void>(resolve => { entered = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  const f = await researchFixture(async (_request, index) => {
    if (index === 1) return { tool: 'save_research_plan', id: 'confirm-plan', args: plan };
    if (index === 3) { entered(); await held; }
    return { text: 'Ready.' };
  });
  deferCleanup(() => release());
  await f.run(f.request(1));
  const saved = need(await f.app.queryResearchTask(f.task.researchId));
  const confirm = f.request(2, { researchId: f.task.researchId, phase: 'researching', plan: { planId: saved.currentPlanId!, revision: 1 } });
  const started = await f.start(confirm), accepted = need(started.accepted); await requested;
  const retries = await Promise.all([f.app.submitInput(confirm), f.app.submitInput(confirm)]);
  expect(retries).toEqual([{ ok: true, data: accepted }, { ok: true, data: accepted }]);
  expect(await f.app.submitInput({ ...confirm, clientSequence: 3 })).toMatchObject({ ok: false, error: { code: 'research_already_started' } });
  expect(need(await f.app.listSessionRuns({ sessionId: f.session.sessionId })).items).toHaveLength(2);
  need(await f.app.cancelRun(accepted.runId)); await started.completion; release();
  expect(f.requests).toHaveLength(3);
});
