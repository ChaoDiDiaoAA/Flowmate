import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ProviderConfig, ProviderOutcome, Result, RunSnapshot } from '@flowmate/contracts';
import { loadLiveProviderEnvironment } from '@flowmate/shared';
import { projectCaseInput } from '../datasets/load.ts';
import { ProductProcess } from '../adapters/product-process.ts';
import type { ResponseFrame } from '../adapters/flowmate.ts';
import type { CaseDefinition, CaseExecutionResult, EvaluationMode, EvidenceFact } from '../types.ts';
import { prepareTrial } from './trial.ts';

type Control = {
  budgets: Record<string, { timeoutMs: number; stopGraceMs: number; lateResultWindowMs: number }>;
};

function fixtureConfig(caseData: CaseDefinition, root: string): ProviderConfig {
  return {
    version: 1,
    name: 'p1-fixture',
    revision: 1,
    modelRef: {
      provider: 'deepseek',
      model: caseData.input.setup.fault_profile === 'invalid-model' ? 'flowmate-p1-intentionally-absent-model' : 'deepseek-v4-flash',
    },
    native: { authPath: join(root, 'runtime', 'fixture-auth.json'), modelsPath: null },
    parameters: { maxTokens: 64, maxRetries: caseData.input.setup.fault_profile === 'rate-limit' ? 1 : 0, maxRetryDelayMs: 10 },
  };
}

function productResult(frame: ResponseFrame): Result<ProviderOutcome> | null {
  if (frame.type !== 'result') return null;
  return frame.data.outcome as Result<ProviderOutcome>;
}

function queryResult(frame: ResponseFrame): Result<RunSnapshot> | null {
  if (frame.type !== 'result') return null;
  return frame.data.outcome as Result<RunSnapshot>;
}

function evidence(present: boolean, actual: unknown, source: string): EvidenceFact {
  return { present, actual, source };
}

function emptyResult(caseData: CaseDefinition, executionId: string, trialId: string, mode: EvaluationMode, goal: string, text: string, config: ProviderConfig): CaseExecutionResult {
  return {
    executed: true,
    identity: { executionId, trialId, caseId: caseData.id, caseVersion: caseData.version, requestId: null, runId: null },
    mode,
    input: { goal, text },
    configuration: { requestedModel: config.modelRef, resolvedModel: null, responseModel: null, overrides: [] },
    terminal: null,
    error: null,
    output: null,
    usage: { source: 'unknown', attempts: null, complete: false },
    timeline: [], queryBeforeLateWindow: null, queryAfterLateWindow: null, close: null, evidence: {}, facilityError: null,
  };
}

export async function executeCase(input: {
  caseData: CaseDefinition;
  mode: EvaluationMode;
  executionId: string;
  trialIndex: number;
  trialBaseRoot: string;
  datasetRoot: string;
  controlFile: string;
}): Promise<CaseExecutionResult> {
  const trial = prepareTrial({ baseRoot: input.trialBaseRoot, executionId: input.executionId, caseId: input.caseData.id, trialIndex: input.trialIndex });
  const projected = projectCaseInput(input.caseData, input.datasetRoot);
  const control = JSON.parse(readFileSync(input.controlFile, 'utf8')) as Control;
  const budgetName = input.caseData.input.setup.budget_profile ?? 'normal';
  const budget = control.budgets[budgetName];
  if (!budget) throw new Error(`Unknown budget profile: ${budgetName}`);
  const liveProvider = input.mode === 'live'
    ? loadLiveProviderEnvironment(process.env, trial.paths)
    : null;
  if (liveProvider && !liveProvider.ok) {
    throw new Error(`${liveProvider.error.code}: ${liveProvider.error.message}`);
  }
  const config = input.mode === 'fixture'
    ? fixtureConfig(input.caseData, trial.paths.root)
    : liveProvider!.data.config;
  const result = emptyResult(input.caseData, input.executionId, trial.trialId, input.mode, projected.goal, projected.text, config);
  const product = new ProductProcess({ executionId: input.executionId, trialId: trial.trialId });
  try {
    await product.start({ paths: trial.paths, productConfig: config, mode: input.mode, faultProfile: input.caseData.input.setup.fault_profile ?? 'none' });
    const call = product.beginProvider({ goal: projected.goal, text: projected.text, timeoutMs: budget.timeoutMs, stopGraceMs: budget.stopGraceMs });
    result.identity.requestId = call.requestId;
    if (input.caseData.input.setup.fault_profile === 'cancel') {
      const dispatched = await product.waitForEvent(call.requestId, 'request_dispatched', budget.timeoutMs);
      const runId = Number((dispatched.data.event as { runId?: number }).runId);
      if (Number.isSafeInteger(runId)) result.identity.runId = runId;
      await product.cancel(call.requestId, result.identity.runId ?? undefined);
    }
    const callFrame = await call.result;
    const outcome = productResult(callFrame);
    if (!outcome) throw new Error(`Provider call returned ${callFrame.type}`);
    const runId = outcome.ok ? outcome.data.runId : outcome.runId ?? outcome.error.runId;
    if (runId === undefined) throw new Error('Provider result did not include a runId');
    result.identity.runId = runId;
    const beforeFrame = await product.query(runId);
    const before = queryResult(beforeFrame);
    result.queryBeforeLateWindow = before;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, budget.lateResultWindowMs));
    const afterFrame = await product.query(runId);
    const after = queryResult(afterFrame);
    result.queryAfterLateWindow = after;
    const snapshot = after?.ok ? after.data : before?.ok ? before.data : null;
    if (snapshot) {
      result.terminal = snapshot.status === 'created' || snapshot.status === 'running' ? null : snapshot.status;
      result.error = snapshot.error ? { code: snapshot.error.code, message: snapshot.error.message } : null;
      const output = snapshot.output as { text?: string; partial?: boolean; responseModel?: string | null } | null;
      result.output = output ? { text: output.text ?? '', partial: output.partial ?? false } : null;
      const configSnapshot = snapshot.config as { resolvedModel?: { model?: string } | null };
      result.configuration.resolvedModel = configSnapshot.resolvedModel?.model ?? null;
      result.configuration.responseModel = output?.responseModel ?? null;
      const usage = snapshot.usage as { source?: string; attempts?: number | null; attemptsComplete?: boolean };
      result.usage = { source: usage.source ?? 'unknown', attempts: usage.attempts ?? null, complete: snapshot.tokens.usageComplete };
    }
    const closeFrame = await product.close();
    result.close = { stopped: closeFrame.data.stopped === true, closed: closeFrame.data.closed === true, errors: Array.isArray(closeFrame.data.errors) ? closeFrame.data.errors : [] };
    result.timeline = product.timeline.map((frame) => ({ requestId: frame.requestId, type: frame.type, data: frame.data }));
    const serialized = JSON.stringify({ snapshot, timeline: result.timeline, diagnostics: product.diagnostics });
    const configuredSecrets = [
      process.env.FLOWMATE_LLM_API_KEY,
      process.env.LANGFUSE_SECRET_KEY,
      process.env.LANGFUSE_PUBLIC_KEY,
    ].filter((value): value is string => Boolean(value));
    const leakedSecret = ['fixture-synthetic-key', ...configuredSecrets].some((secret) => serialized.includes(secret));
    const hasEvent = (eventType: string) => result.timeline.some((item) => (item.data as { event?: { type?: string } }).event?.type === eventType);
    const hasFrame = (type: string) => result.timeline.some((item) => item.type === type);
    result.evidence = {
      'run-created': evidence(hasEvent('run_created'), { runId }, 'protocol:event'),
      'request-dispatched': evidence(hasEvent('request_dispatched'), { runId, requestId: call.requestId }, 'protocol:event'),
      'response-started': evidence(hasEvent('response_started'), true, 'protocol:event'),
      'run-query': evidence(Boolean(snapshot), snapshot, 'protocol:query'),
      'late-window-query': evidence(Boolean(before && after), { before, after, windowMs: budget.lateResultWindowMs }, 'protocol:query'),
      output: evidence(Boolean(result.output), result.output, 'run.output_json'),
      'partial-output': evidence(result.output?.partial === true, result.output, 'run.output_json'),
      configuration: evidence(Boolean(snapshot?.config), snapshot?.config ?? null, 'run.config_json'),
      usage: evidence(Boolean(snapshot?.usage), snapshot?.usage ?? null, 'run.usage_json'),
      attempts: evidence(result.usage.attempts !== null, result.usage.attempts, 'run.usage_json'),
      'cancel-ack': evidence(hasFrame('cancel_ack'), true, 'protocol:cancel_ack'),
      stopped: evidence(hasFrame('stopped') && result.close.stopped, { close: result.close, cleanup: snapshot?.cleanup }, 'protocol:stopped+close'),
      'abort-observed': evidence(Boolean((snapshot?.cleanup as { stopped?: boolean } | undefined)?.stopped), snapshot?.cleanup ?? null, 'run.cleanup_json'),
      'redaction-scan': evidence(!leakedSecret && !/sk-lf-[A-Za-z0-9-]+/.test(serialized), { leaked: false }, 'evaluation:redaction-scan'),
    };
  } catch (error) {
    result.timeline = product.timeline.map((frame) => ({ requestId: frame.requestId, type: frame.type, data: frame.data }));
    result.facilityError = { code: 'evaluation_execution_error', message: error instanceof Error ? error.message : String(error) };
    try { await product.close(); } catch { /* preserve the first facility error */ }
  }
  mkdirSync(trial.paths.artifactsDir, { recursive: true });
  writeFileSync(join(trial.paths.artifactsDir, 'case-result.json'), `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  if (product.diagnostics) writeFileSync(join(trial.paths.logsDir, 'product.stderr.log'), product.diagnostics, 'utf8');
  return result;
}
