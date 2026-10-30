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

test('semantic scores show their shared Judge task and calibration scope without implying acceptance',()=>{
  const score:EvaluationScoreView={trialId:'trial-1',caseId:'case-1',repetition:1,metricId:'tool-selection',name:'Tool selection',version:1,
    method:'llm-judge',required:true,status:'FAIL',value:0,reason:'Wrong tool',reasonTruncated:false,evidence:['judge-response'],
    evaluatorId:'tool-selection',evaluatorVersion:2,category:'formal',applicabilityReason:'Case selected',statistics:{unit:'决策点',numerator:0,denominator:1,missing:0},
    judge:{callId:'shared-judge-task',criterion:1},calibration:{state:'version-mismatch',reference:'old-calibration',kind:'engineering-fixture',
      acceptance:'not-assessed',metricIds:['tool-selection','tool-arguments'],reason:'The selected Evaluator version changed'}};
  const html=renderToStaticMarkup(createElement(evaluation.EvaluationScores,{scores:[score]}));
  expect(html).toContain('shared-judge-task');expect(html).toContain('version-mismatch');expect(html).toContain('old-calibration');
  expect(html).toContain('tool-arguments');expect(html).toContain('not-assessed');
});
