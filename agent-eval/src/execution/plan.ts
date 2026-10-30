import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { EvaluationPreviewRequestSchema, EvaluationPlanSummarySchema, RuntimeBudgetOverridesSchema,
  ResourceSelectionSchema, ExtensionSelectionSchema } from '@flowmate/contracts';
import { agentApiSchema } from '../configuration.ts';
import { discoverDatasets, selectCases, assertSemanticSelection, judgeSelection, resolveCase, caseFiles,
  REPO_ROOT, type LocalDataset } from '../dataset-loader/local.ts';
import { compileEvaluatorPlan } from '../scoring/evaluator-plan.ts';
import { changedSourcePaths, codeIdentity, type EvaluationRuntime } from './source.ts';
import { loadPublishedBenchmark } from '../curation/publication.ts';
import { EvaluationAgentOverridesSchema } from '../../../packages/contracts/src/runtime-evaluation.ts';

export const evaluationRunDefaults = { timeoutMs: 120_000, stopGraceMs: 5000, environment: 'development' } as const;
export const runConfigSchema = z.object({
  ...EvaluationAgentOverridesSchema.shape,
  model: z.string().min(1).optional(), baseUrl: z.string().url().optional(), api: agentApiSchema.optional(),
  repeat: z.number().int().min(1).max(20).optional(),
  timeoutMs: z.number().int().min(100).max(120000).optional(), stopGraceMs: z.number().int().min(100).max(10000).optional(),
  environment: z.string().regex(/^[a-z0-9_-]+$/).optional(), resources: ResourceSelectionSchema.optional(),
  extensions: ExtensionSelectionSchema.optional(), budget: RuntimeBudgetOverridesSchema.optional(),
}).strict();
export function parseRunConfig(value: unknown) {
  const parsed = runConfigSchema.safeParse(value);
  if (!parsed.success) {
    const fields = [...new Set(parsed.error.issues.map(issue => issue.path.join('.') || 'options'))];
    throw Error('Invalid evaluation run configuration; check ' + fields.join(', '));
  }
  return parsed.data;
}
export function findDataset(repo: string, options: { dataset?: string; version?: number } = {}, resourceRepository = repo) {
  const directory = join(repo, 'agent-eval/src/datasets');
  const id = options.dataset ?? 'flowmate-agent-v1';
  const published = ['flowmate-agent-v1', 'flowmate-research-v1'].includes(id) ? [] : loadPublishedBenchmark(repo, id, options.version);
  const matches = published.length ? published : discoverDatasets(directory, repo, resourceRepository).filter(d => d.manifest.id === id);
  if (matches.length === 0)
    throw Error(`Dataset ${options.dataset ?? 'flowmate-agent-v1'} 不存在：尚未制作，等待评测工程验收；真实入口与必要采证接通、工程验证通过后，依据 01/02 制作。未调用模型、未创建执行记录。`);
  if (matches.length !== 1) throw Error('Select exactly one local Dataset');
  const dataset = matches[0]!;
  if (options.version !== undefined && dataset.manifest.version !== options.version)
    throw Error('Dataset version differs; restore the requested source revision');
  return dataset;
}

export function createEvaluationPlan(repo: string, input: unknown, runtime?: EvaluationRuntime) {
  const request = EvaluationPreviewRequestSchema.parse(input);
  const resourceRepository = runtime?.mode === 'installed' ? runtime.layout.runtimeRoot : repo;
  const datasets = request.datasetId === 'all'
    ? ['flowmate-agent-v1', 'flowmate-research-v1'].map(dataset => findDataset(repo, { dataset }, resourceRepository))
    : [findDataset(repo, { dataset: request.datasetId }, resourceRepository)];
  const conditions: Array<{ manifest: LocalDataset['manifest']; cases: unknown[] }> = [];
  const datasetPlans = datasets.map(dataset => {
    const selected = selectCases(dataset, request.selection === 'case' ? 'full' : request.selection, request.caseId);
    if (!selected.length) throw Error('No Cases in selected partition');
    assertSemanticSelection({ manifest: dataset.manifest, cases: selected }, request.judge === 'required');
    const cases = selected.map(task => {
      resolveCase(dataset, task, repo);
      const selection = judgeSelection({ manifest: dataset.manifest, cases: [task] }, request.judge === 'required');
      return { caseId: task.id, caseVersion: task.version, name: task.name, category: task.category,
        evaluators: compileEvaluatorPlan(task, [...dataset.manifest.scoring.required.map(metric => ({ metric, required: true })), ...task.expected.checks]),
        judge: { applicable: selection.needed, required: selection.required, enabled: request.judge !== 'off' && selection.needed } };
    });
    const authored = dataset.embedded?.authored;
    conditions.push({ manifest: structuredClone(dataset.manifest), cases: selected.map(task => {
      const fixture = authored?.cases.find(c => c.id === task.id)?.input.fixture?.name;
      return { task: structuredClone(task), files: caseFiles(dataset, task), gold: authored?.gold[task.id] ?? null,
        fixture: fixture ? authored!.fixtures[fixture] : null };
    }) });
    return { id: dataset.manifest.id, version: dataset.manifest.version, name: dataset.manifest.name,
      caseCount: cases.length, total: cases.length * request.repeat, cases };
  });
  const cases = datasetPlans.flatMap(dataset => dataset.cases);
  const summary = EvaluationPlanSummarySchema.parse({ selection: request.selection, repeat: request.repeat, judge: request.judge,
    configuration: { ...evaluationRunDefaults, ...request.configuration }, datasets: datasetPlans,
    caseCount: cases.length, total: cases.length * request.repeat,
    judgeMaxGenerations: cases.filter(task => task.judge.enabled).length * request.repeat,
    judgeRequired: cases.some(task => task.judge.enabled && task.judge.required),
    unmeasuredRequiredCaseIds: cases.filter(task => task.judge.required && !task.judge.enabled).map(task => task.caseId),
  });
  const sourceRoot = runtime ? runtime.mode === 'development' ? runtime.repository : runtime.layout.runtimeRoot
    : existsSync(join(repo, 'apps/host/main.ts')) ? repo : REPO_ROOT;
  return { request, datasets, summary, conditions, source: codeIdentity(sourceRoot, undefined, runtime) };
}
export type EvaluationPlan = ReturnType<typeof createEvaluationPlan>;
export function sameEvaluationPlan(before: EvaluationPlan, after: EvaluationPlan): boolean {
  return isDeepStrictEqual(before.request, after.request) && isDeepStrictEqual(before.conditions, after.conditions)
    && isDeepStrictEqual(before.summary, after.summary) && isDeepStrictEqual(before.source, after.source)
    && changedSourcePaths(before.source, after.source).length === 0;
}
