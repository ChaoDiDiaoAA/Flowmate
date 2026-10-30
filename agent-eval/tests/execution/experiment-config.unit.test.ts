import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { readSnapshot } from '../../src/reports/archive.ts';
import { parseRunConfig } from '../../src/execution/plan.ts';
import { runLocal } from '../../src/execution/runner.ts';
import { dataset, fixtureRepo, observed } from '../support/fixtures.ts';
import type { AgentKernel } from '../../src/adapters/agent.ts';

const overrides = { systemPrompt: 'Evaluate original invoice evidence.', reasoning: 'max' as const,
  controlledReplay: true as const,
  strategy: { budgetAwareness: false, statistics: true, experience: false } };
test('experiment runtime options are validated without silently discarding requested behavior', () => {
  expect(parseRunConfig(overrides)).toEqual(overrides);
  expect(() => parseRunConfig({ reasoning: 'unsupported' })).toThrow();
  expect(() => parseRunConfig({ controlledReplay: false })).toThrow();
  expect(() => parseRunConfig({ strategy: { budgetAwareness: false } })).toThrow();
});

test('controlled published runs retain exact startup configuration and publication identity', async () => {
  const published = { benchmarkId: 'published-example', revision: 2, regressionCaseIds: [] };
  const data = { ...structuredClone(dataset), published };
  const kernel: AgentKernel = { readiness: () => ({ ready: true, reason: 'controlled' }), async prepare(trial) {
    expect(trial.configuration).toMatchObject(overrides);
    const result = observed(); result.identity = trial.identity; result.input = trial.input;
    result.evidence.environment!.actual = { ...trial.identity, fresh: true };
    result.evidence['input-projection']!.actual = trial.input;
    return { input: trial.input, async execute() { return result; }, async snapshot() { return result; }, async cancel() {},
      async close() { return { present: true, actual: { closed: true, stopped: true }, source: 'controlled' }; } };
  } };
  const result = await runLocal(fixtureRepo, { dataset: data, caseId: data.cases[0]!.id, executionId: 'runtime-config-' + randomUUID(),
    backend: 'local', judge: 'off', config: overrides }, { kernel });
  expect(result.report.executionKind).toBe('controlled');
  expect(readSnapshot(result.file).published).toEqual(published);
});
