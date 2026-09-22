import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { loadLiveProviderEnvironment, resolveProductPaths } from '@flowmate/shared';
import type { LangfuseClient } from '@langfuse/client';
import { startActiveObservation } from '@langfuse/tracing';
import { executeCase } from '../execution/execute-case.ts';
import { evaluateCase } from '../evaluators/mechanism.ts';
import type { CaseDefinition, CaseExecutionResult, EvaluationMode, EvaluationResult, GradeStatus } from '../types.ts';
import { caseLabel, datasetName, loadLocalP1Cases, P1_DATASET_ROOT, type LangfuseCaseLabel } from './datasets.ts';

export type ExperimentOutput = {
  case: LangfuseCaseLabel;
  execution: CaseExecutionResult;
  evaluation: EvaluationResult;
  evidenceSummary: { required: number; present: number; missing: string[] };
};

type ExperimentScore = {
  name: string;
  value: string | number;
  dataType: 'CATEGORICAL' | 'NUMERIC';
  comment: string;
};

export type ExperimentCaseSummary = {
  case: LangfuseCaseLabel;
  grade: GradeStatus;
  checks: Array<{ id: string; status: GradeStatus }>;
  traceId: string | null;
  traceUrl: string | null;
};

function executionId(): string {
  return `p1-${new Date().toISOString().replace(/[:.]/g, '-')}`;
}

function scoreComment(output: ExperimentOutput, message: string): string {
  const label = output.case;
  return `[${label.id}/v${label.version} | ${label.name} | ${label.capability}] ${message}`;
}

function caseIdentityValue(label: LangfuseCaseLabel): string {
  return `${label.id}/v${label.version} | ${label.name} | ${label.capability}`;
}

/** The child Observation name is for humans; Score keys remain stable for aggregation. */
export function caseObservationName(stage: string, mode: EvaluationMode, label: LangfuseCaseLabel): string {
  const modeLabel = mode === 'fixture' ? 'Fixture' : 'Live';
  return `${stage} · ${modeLabel} · ${label.id}/v${label.version} · ${label.name}`;
}

export function formatExperimentCaseSummaries(summaries: ExperimentCaseSummary[]): string {
  if (summaries.length === 0) return 'P1 Case 结果：\n- 无可报告 Case';
  return [
    'P1 Case 结果：',
    ...summaries.flatMap((summary) => [
      `- ${summary.case.id}/v${summary.case.version} | ${summary.case.name}`,
      `  能力点：${summary.case.capability}`,
      `  评测结论：${summary.grade}`,
      `  检查：${summary.checks.map((check) => `${check.id}=${check.status}`).join('；') || '无适用检查'}`,
      `  Trace：${summary.traceUrl ?? (summary.traceId ? `${summary.traceId}（链接未生成，请在 Experiments 中按 executionId 查找）` : '未生成（请在 Experiments 中按 executionId 查找）')}`,
    ]),
  ].join('\n');
}

/** Score keys stay stable for aggregation; every score comment names its Case. */
export function buildExperimentScores(output: ExperimentOutput): ExperimentScore[] {
  return [
    {
      // The score table shows this categorical value directly, so a reviewer
      // can identify the Case without decoding a generic check score name.
      name: 'p1_case_identity',
      value: caseIdentityValue(output.case),
      dataType: 'CATEGORICAL',
      comment: scoreComment(output, 'Case identity for this Item Run.'),
    },
    {
      name: 'p1_case_status',
      value: output.evaluation.status,
      dataType: 'CATEGORICAL',
      comment: scoreComment(output, output.evaluation.reason),
    },
    {
      name: 'p1_case_pass',
      value: output.evaluation.status === 'PASS' ? 1 : 0,
      dataType: 'NUMERIC',
      comment: scoreComment(output, output.evaluation.reason),
    },
    ...output.evaluation.checks
      .filter((check) => check.applicable)
      .map((check): ExperimentScore => ({
        name: `check_${check.checkId}`,
        value: check.status === 'PASS' ? 1 : 0,
        dataType: 'NUMERIC',
        comment: scoreComment(output, check.reason),
      })),
  ];
}

function evidenceSummary(caseData: CaseDefinition, execution: CaseExecutionResult): ExperimentOutput['evidenceSummary'] {
  const missing = caseData.expected.evidence_required.filter((name) => !execution.evidence[name]?.present);
  return {
    required: caseData.expected.evidence_required.length,
    present: caseData.expected.evidence_required.length - missing.length,
    missing,
  };
}

function experimentCaseSummary(output: ExperimentOutput, traceId: string | null, traceUrl: string | null): ExperimentCaseSummary {
  return {
    case: output.case,
    grade: output.evaluation.status,
    checks: output.evaluation.checks
      .filter((check) => check.applicable)
      .map((check) => ({ id: check.checkId, status: check.status ?? 'NOT_RUN' })),
    traceId,
    traceUrl,
  };
}

async function getTraceUrl(client: LangfuseClient, traceId: string | null | undefined): Promise<string | null> {
  if (!traceId) return null;
  try {
    return await client.getTraceUrl(traceId);
  } catch {
    return null;
  }
}

export async function runStageExperiment(client: LangfuseClient, input: {
  stage: 'P1'; mode: EvaluationMode; repoRoot: string; caseId?: string; executionId?: string;
}): Promise<{ executionId: string; dataset: string; reportFile: string; formatted: string; caseSummaries: ExperimentCaseSummary[] }> {
  const id = input.executionId ?? executionId();
  const name = datasetName(input.stage, input.mode);
  const dataset = await client.dataset.get(name);
  const allCases = loadLocalP1Cases();
  const byIdentity = new Map(allCases.map((item) => [`${item.id}/${item.version}`, item]));
  const items = input.caseId ? dataset.items.filter((item) => (item.metadata as { caseId?: string } | undefined)?.caseId === input.caseId) : dataset.items;
  if (items.length === 0) throw new Error(`No dataset item selected in ${name}`);
  const trialBaseRoot = resolve(input.repoRoot, 'agent-eval', 'runs', id, 'trials');
  mkdirSync(trialBaseRoot, { recursive: true });
  if (input.mode === 'live') {
    const paths = resolveProductPaths(join(trialBaseRoot, 'preflight'));
    if (!paths.ok) throw new Error(`${paths.error.code}: ${paths.error.message}`);
    const config = loadLiveProviderEnvironment(process.env, paths.data);
    if (!config.ok) throw new Error(`${config.error.code}: ${config.error.message}`);
  }
  let trialIndex = 0;
  const result = await client.experiment.run({
    name: `${input.stage} ${input.mode === 'fixture' ? 'Fixture' : 'Live'} Provider Evaluation`,
    runName: id,
    description: 'Flowmate product execution through flowmate-eval/v1; deterministic evaluator; LLM judge disabled.',
    metadata: { stage: input.stage, mode: input.mode, executionId: id, caseContractVersion: 1, casePresentationVersion: 3 },
    data: items,
    maxConcurrency: 1,
    task: async (item): Promise<ExperimentOutput> => {
      const metadata = item.metadata as { caseId: string; caseVersion: number };
      const caseData = byIdentity.get(`${metadata.caseId}/${metadata.caseVersion}`);
      if (!caseData) throw new Error(`Local case is missing: ${metadata.caseId}/v${metadata.caseVersion}`);
      trialIndex += 1;
      const label = caseLabel(caseData);
      return startActiveObservation(caseObservationName(input.stage, input.mode, label), async (span) => {
        span.update({
          input: { evaluationInput: item.input, mode: input.mode },
          metadata: {
            executionId: id,
            caseId: label.id,
            caseVersion: label.version,
            caseName: label.name,
            capability: label.capability,
          },
        });
        const execution = await executeCase({
          caseData,
          mode: input.mode,
          executionId: id,
          trialIndex,
          trialBaseRoot,
          datasetRoot: P1_DATASET_ROOT,
          controlFile: join(P1_DATASET_ROOT, 'fixtures', 'control.json'),
        });
        const evaluation = evaluateCase(caseData, execution);
        const output: ExperimentOutput = { case: label, execution, evaluation, evidenceSummary: evidenceSummary(caseData, execution) };
        span.update({
          output: {
            case: label,
            terminal: execution.terminal,
            error: execution.error,
            grade: evaluation.status,
            checks: evaluation.checks,
            evidenceSummary: output.evidenceSummary,
          },
          metadata: { runId: execution.identity.runId, trialId: execution.identity.trialId },
        });
        return output;
      });
    },
    evaluators: [async ({ output }: { output: ExperimentOutput }) => buildExperimentScores(output)],
  });
  const formatted = await result.format({ includeItemResults: false });
  const caseSummaries = await Promise.all(result.itemResults.map(async (item) => {
    const traceId = item.traceId ?? null;
    return experimentCaseSummary(item.output, traceId, await getTraceUrl(client, traceId));
  }));
  const reportDir = resolve(input.repoRoot, 'agent-eval', 'runs', id);
  mkdirSync(reportDir, { recursive: true });
  const reportFile = join(reportDir, 'summary.json');
  writeFileSync(reportFile, `${JSON.stringify({ executionId: id, dataset: name, mode: input.mode, casePresentationVersion: 3, caseSummaries, itemResults: result.itemResults }, null, 2)}\n`, 'utf8');
  return { executionId: id, dataset: name, reportFile, formatted, caseSummaries };
}

export async function replaySavedExperiment(client: LangfuseClient, reportFile: string): Promise<string> {
  if (!isAbsolute(reportFile)) throw new Error('resend requires an absolute --report path');
  const saved = JSON.parse(readFileSync(reportFile, 'utf8')) as { executionId: string; itemResults: Array<{ input: unknown; expectedOutput?: unknown; output: ExperimentOutput }> };
  const result = await client.experiment.run({
    name: 'Flowmate saved evaluation evidence replay',
    runName: `${saved.executionId}-replay-${Date.now()}`,
    description: 'Replays saved evidence to Langfuse without executing the product again.',
    metadata: { replay: true, originalExecutionId: saved.executionId },
    data: saved.itemResults.map((item) => ({ input: item.input, expectedOutput: item.expectedOutput, metadata: { replay: true } })),
    task: async (_item, index?: unknown) => saved.itemResults.shift()?.output,
    evaluators: [async ({ output }: { output: ExperimentOutput }) => buildExperimentScores(output).map((score) => ({ ...score, comment: `${score.comment} [replayed saved evidence]` }))],
    maxConcurrency: 1,
  });
  return result.format({ includeItemResults: true });
}
