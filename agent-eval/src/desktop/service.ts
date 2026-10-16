import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { appError, fail, ok, EvaluationConfigurationSnapshotSchema, EvaluationControlStateSchema,
  EvaluationIdSchema, EvaluationPreviewSchema, EvaluationProgressViewSchema, EvaluationExportResultSchema, evaluationRequests,
  type EvaluationConfigurationSnapshot, type EvaluationControlState, type EvaluationEvent,
  type EvaluationPreview, type EvaluationExportResult, type Result } from '@flowmate/contracts';
import { prepareAgentConnection, langfuseConnection } from '../configuration.ts';
import { createEvaluationPlan, sameEvaluationPlan, type EvaluationPlan } from '../execution/plan.ts';
import { runLocal, runBatch, type EvaluationProgress } from '../execution/runner.ts';
import { registerSecrets, scanEvidence } from '../execution/evidence-safety.ts';
import { judgeConnection, prepareJudge } from '../scoring/judges/client.ts';
import { createEvaluationReader, exportView } from './results.ts';
import { createEvaluationCases } from './cases.ts';
import { exportReport } from '../langfuse/export.ts';
import { readReport, reportPath, readExportState } from '../reports/store.ts';

export type EvaluationServiceOptions = {
  sessionId?: string; onEvent?: (event: EvaluationEvent) => void;
  prepareAgent?: typeof prepareAgentConnection; prepareJudge?: typeof prepareJudge;
  runLocal?: typeof runLocal; runBatch?: typeof runBatch;
};
export type EvaluationStartContext = { batchId: string; settings: EvaluationConfigurationSnapshot;
  credentials: { agent: string; judge: string | null } };
type StartRecord = { previewId: string; control: EvaluationControlState };
const activeStates = new Set<EvaluationControlState['state']>(['preparing', 'running', 'cancelling', 'stop-unconfirmed', 'interrupted']);
const text = (value: unknown) => scanEvidence(String(value)).value.slice(0, 16_000);
const failure = (code: string, message: string) => fail(appError(code, 'runtime', message, true));

export function createEvaluationService(repo: string, options: EvaluationServiceOptions = {}) {
  const sessionId = EvaluationIdSchema.parse(options.sessionId ?? randomUUID());
  const reader = createEvaluationReader(repo, sessionId);
  const cases = createEvaluationCases(repo, sessionId);
  let state: EvaluationControlState = { version: 1, sessionId, batchId: null, requestId: null, state: 'idle', outcome: null,
    startedAt: null, endedAt: null, executionIds: [], progress: null, stop: 'not-started', errors: [] };
  let sequence = 0, closing = false, active: Promise<void> | null = null, cancellation: AbortController | null = null;
  let preview: { value: EvaluationPreview; plan: EvaluationPlan; consumed: boolean } | null = null;
  const starts = new Map<string, StartRecord>();
  let exporting: Promise<Result<EvaluationExportResult>> | null = null;
  const exports = new Map<string, { executionId: string; promise: Promise<Result<EvaluationExportResult>> }>();
  const snapshot = () => structuredClone(state);
  const emit = () => {
    const control = EvaluationControlStateSchema.parse(snapshot());
    if (state.requestId) starts.get(state.requestId)!.control = control;
    try { options.onEvent?.({ version: 1, sessionId, sequence: ++sequence, control }); }
    catch { /* A disconnected view cannot change execution or stopping. */ }
  };
  function progress(event: EvaluationProgress) {
    if (event.type === 'dataset-start' && !state.executionIds.includes(event.executionId)) state.executionIds.push(event.executionId);
    if (event.type === 'trial-phase' && event.phase === 'preparing') state.stop = 'pending';
    if (event.type === 'trial-cleanup') state.stop = state.stop === 'unconfirmed' || !event.stopConfirmed ? 'unconfirmed' : 'confirmed';
    const fields = Object.fromEntries(Object.entries(event).filter(([key]) => Object.hasOwn(EvaluationProgressViewSchema.shape, key)));
    for (const field of ['reason', 'error'] as const) if (typeof fields[field] === 'string') fields[field] = text(fields[field]);
    const checked = EvaluationProgressViewSchema.safeParse(scanEvidence(fields).value);
    state.progress = checked.success ? checked.data : null;
    emit();
  }
  function readControl(input: unknown = {}): Result<EvaluationControlState> {
    const parsed = evaluationRequests.query_evaluation_control.safeParse(input);
    if (!parsed.success) return failure('input_invalid', '评测状态查询无效。');
    const { requestId, batchId } = parsed.data;
    const control = requestId ? starts.get(requestId)?.control : batchId
      ? [...starts.values()].find(record => record.control.batchId === batchId)?.control : state;
    if (!control || batchId && control.batchId !== batchId) return failure('evaluation_request_unknown', '原评测请求不存在于当前控制会话。');
    return ok(structuredClone(control));
  }
  function cancel(input: unknown): Result<EvaluationControlState> {
    const parsed = evaluationRequests.cancel_evaluation.safeParse(input);
    if (!parsed.success) return failure('input_invalid', '评测停止请求无效。');
    const found = readControl({ batchId: parsed.data.batchId }); if (!found.ok) return found;
    if (state.batchId === parsed.data.batchId && ['preparing', 'running', 'cancelling'].includes(state.state)) {
      state.state = 'cancelling'; cancellation?.abort(); emit(); return ok(snapshot());
    }
    return found;
  }
  async function execute(plan: EvaluationPlan, context: EvaluationStartContext, controller: AbortController) {
    try {
      const agent = await (options.prepareAgent ?? prepareAgentConnection)(context.settings.agent!, context.credentials.agent, undefined,
        { signal: controller.signal, timeoutMs: plan.summary.configuration.timeoutMs });
      controller.signal.throwIfAborted();
      const needsJudge = plan.summary.judgeMaxGenerations > 0 && context.settings.judge !== null && context.credentials.judge !== null;
      const judge = needsJudge ? await (options.prepareJudge ?? prepareJudge)(judgeConnection({ ...context.settings.judge!, apiKey: context.credentials.judge! }),
        undefined, controller.signal) : null;
      controller.signal.throwIfAborted();
      if (!sameEvaluationPlan(plan, createEvaluationPlan(repo, plan.request))) throw Error('预览后的评测条件已变化，请重新预览。');
      controller.signal.throwIfAborted(); state.state = 'running'; emit();
      const shared = { backend: 'local' as const, judge: plan.request.judge, repeat: plan.request.repeat, config: plan.summary.configuration };
      const deps = { preparedAgent: agent, preparedJudge: judge, signal: controller.signal, onProgress: progress };
      const results = plan.request.selection === 'case'
        ? [await (options.runLocal ?? runLocal)(repo, { ...shared, dataset: plan.datasets[0]!, caseId: plan.request.caseId, selection: 'full' }, deps)]
        : await (options.runBatch ?? runBatch)(repo, { ...shared, datasets: plan.datasets, selection: plan.request.selection }, deps);
      for (const result of results) {
        if (!state.executionIds.includes(result.report.executionId)) state.executionIds.push(result.report.executionId);
        for (const trial of result.report.trials) if (trial.execution) {
          const cleanup = trial.execution.evidence.cleanup;
          const actual = cleanup?.present && cleanup.actual !== null && typeof cleanup.actual === 'object' ? cleanup.actual : null;
          if (!actual || !('closed' in actual) || actual.closed !== true || !('stopped' in actual) || actual.stopped !== true)
            state.stop = 'unconfirmed';
          else if (state.stop !== 'unconfirmed') state.stop = 'confirmed';
        }
      }
      state.outcome = controller.signal.aborted ? 'cancelled' : results.length !== plan.datasets.length || results.some(result => result.stopped || !result.report.executionComplete)
        ? 'failed' : 'completed';
    } catch (error) {
      state.outcome = controller.signal.aborted ? 'cancelled' : 'failed';
      if (!controller.signal.aborted) state.errors.push(text(error));
    } finally {
      if (state.stop === 'pending') state.stop = 'unconfirmed';
      state.state = state.stop === 'unconfirmed' ? 'stop-unconfirmed' : 'finished';
      if (state.stop === 'unconfirmed') state.errors.push('实际停止未确认，后续执行保持阻断。');
      state.endedAt = new Date().toISOString(); emit();
    }
  }
  return {
    ...reader,
    catalog: cases.catalog, feedback: cases.feedback,
    addFeedback(input: unknown) {
      if (closing || exporting || activeStates.has(state.state)) return failure('evaluation_busy', '评测正在运行、导出、关闭或停止未确认，反馈请在空闲后提交。');
      return cases.addFeedback(input);
    },
    export(input: unknown, connectionInput: unknown): Promise<Result<EvaluationExportResult>> {
      const parsed = evaluationRequests.export_evaluation.safeParse(input);
      if (!parsed.success) return Promise.resolve(failure('input_invalid', '评测导出请求无效。'));
      const request = parsed.data, prior = exports.get(request.operationId);
      if (prior) return prior.executionId === request.executionId ? prior.promise
        : Promise.resolve(failure('evaluation_request_conflict', '原导出操作ID不能改绑其他Execution。'));
      if (closing || exporting || activeStates.has(state.state)) return Promise.resolve(failure('evaluation_busy', '评测正在运行、导出、关闭或停止未确认。'));
      const work = (async (): Promise<Result<EvaluationExportResult>> => {
        try {
          const connection = langfuseConnection(connectionInput), file = reportPath(repo, request.executionId), report = readReport(file);
          if (report.executionId !== request.executionId) throw Error('Export execution identity mismatch');
          await exportReport(report, file, undefined, repo, { connection });
          return ok(EvaluationExportResultSchema.parse({ version: 1, sessionId, ...request,
            export: exportView(readExportState(file, report.export)) }));
        } catch (error) { return failure('evaluation_export_failed', text(error)); }
      })();
      exporting = work; exports.set(request.operationId, { executionId: request.executionId, promise: work });
      void work.finally(() => { if (exporting === work) exporting = null; });
      return work;
    },
    preview(input: unknown, settingsInput: unknown): Result<EvaluationPreview> {
      try {
        const settings = EvaluationConfigurationSnapshotSchema.parse(settingsInput), plan = createEvaluationPlan(repo, input), issues: string[] = [];
        if (!settings.agent || settings.credentials.agent !== 'configured') issues.push('评测Agent未配置或凭据不可用。');
        if (plan.summary.judgeRequired && (!settings.judge || settings.credentials.judge !== 'configured')) issues.push('适用的必要Judge未配置或凭据不可用。');
        const value = EvaluationPreviewSchema.parse({ version: 1, previewId: randomUUID(), request: plan.request, settings, plan: plan.summary,
          ready: !issues.length, issues });
        preview = { value, plan, consumed: false }; return ok(structuredClone(value));
      } catch (error) { return failure('evaluation_preview_invalid', text(error)); }
    },
    start(input: unknown, context: EvaluationStartContext): Result<EvaluationControlState> {
      const parsed = evaluationRequests.start_evaluation.safeParse(input);
      if (!parsed.success) return failure('input_invalid', '评测启动请求无效。');
      const { previewId, requestId } = parsed.data, prior = starts.get(requestId);
      if (prior) return prior.previewId === previewId ? ok(structuredClone(prior.control)) : failure('evaluation_request_conflict', '原请求ID不能改绑其他预览。');
      if (closing || exporting || activeStates.has(state.state)) return failure('evaluation_busy', '评测正在运行、导出、关闭或停止未确认。');
      if (!preview || preview.value.previewId !== previewId) return failure('evaluation_preview_unknown', '预览已失效，请刷新。');
      if (preview.consumed) return failure('evaluation_preview_consumed', '该预览已受理，重跑须重新预览。');
      if (!preview.value.ready) return failure('evaluation_not_ready', preview.value.issues.join('；'));
      if (!isDeepStrictEqual(preview.value.settings, context.settings)) return failure('evaluation_preview_changed', '模型设置或凭据状态已变化，请刷新。');
      if (!context.credentials.agent.trim() || preview.plan.summary.judgeRequired && !context.credentials.judge?.trim())
        return failure('evaluation_not_ready', '所选评测所需凭据不可用。');
      try { if (!sameEvaluationPlan(preview.plan, createEvaluationPlan(repo, preview.plan.request))) return failure('evaluation_preview_changed', '评测条件已变化，请刷新。'); }
      catch (error) { return failure('evaluation_preview_changed', text(error)); }
      const batchId = EvaluationIdSchema.safeParse(context.batchId); if (!batchId.success) return failure('input_invalid', '评测批次身份无效。');
      registerSecrets([context.credentials.agent, context.credentials.judge].filter((key): key is string => key !== null));
      preview.consumed = true; cancellation = new AbortController();
      state = { version: 1, sessionId, batchId: batchId.data, requestId, state: 'preparing', outcome: null,
        startedAt: new Date().toISOString(), endedAt: null, executionIds: [], progress: null, stop: 'not-started', errors: [] };
      starts.set(requestId, { previewId, control: snapshot() }); emit();
      const task = execute(preview.plan, structuredClone(context), cancellation); active = task;
      void task.finally(() => { if (active === task) active = null; }).catch(() => { /* execute retains its batch failure. */ });
      return ok(snapshot());
    },
    control: readControl, cancel,
    async shutdown(): Promise<Result<{ closed: boolean; stopped: boolean }>> {
      closing = true;
      if (state.batchId && ['preparing', 'running', 'cancelling'].includes(state.state)) cancel({ batchId: state.batchId });
      await active;
      await exporting;
      const stopped = state.stop !== 'pending' && state.stop !== 'unconfirmed';
      return ok({ closed: stopped, stopped });
    },
  };
}
export type EvaluationService = ReturnType<typeof createEvaluationService>;
