import { expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import * as evaluation from '../../apps/desktop/renderer/src/evaluation.tsx';
import type { EvaluationScoreView } from '@flowmate/contracts';

test('formal scores, additional diagnostics and hard constraints render separately without replacing unknown values', () => {
  const base: EvaluationScoreView = { trialId: 'trial-1', caseId: 'case-1', repetition: 1, metricId: 'task-success', name: 'Task success',
    version: 1, method: 'deterministic', required: true, status: 'UNJUDGEABLE', value: null, reason: 'Synthetic missing fact',
    reasonTruncated: false, evidence: [], evaluatorId: 'task-completion', evaluatorVersion: 1, category: 'formal', applicabilityReason: 'Declared target',
    statistics: { unit: 'Trial', numerator: null, denominator: 0, missing: null } };
  const component = Reflect.get(evaluation, 'EvaluationScores');
  expect(component).toBeFunction();
  const html = renderToStaticMarkup(createElement(component, { scores: [base,
    { ...base, metricId: 'diagnostic-latency', category: 'diagnostic' }, { ...base, metricId: 'closed', category: 'guardrail' }] }));
  const formal = html.slice(html.indexOf('aria-label="Formal metric scores"'), html.indexOf('aria-label="Additional diagnostics"'));
  expect(formal).toContain('task-success'); expect(formal).not.toContain('diagnostic-latency'); expect(formal).not.toContain('>closed<');
  expect(html).toContain('aria-label="Additional diagnostics"'); expect(html).toContain('aria-label="Hard constraints"');
  expect(html).toContain('unknown'); expect(html).toContain('&quot;numerator&quot;: null'); expect(html).toContain('&quot;denominator&quot;: 0');
});
