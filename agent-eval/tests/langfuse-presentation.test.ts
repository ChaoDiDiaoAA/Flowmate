import { describe, expect, test } from 'bun:test';
import { buildExperimentScores, caseObservationName, formatExperimentCaseSummaries } from '../src/langfuse/experiment.ts';
import { createLangfuseDatasetItem, loadLocalP1Cases } from '../src/langfuse/datasets.ts';

describe('Langfuse P1 presentation', () => {
  test('publishes a Case label separately from the strictly projected model input', () => {
    const caseData = loadLocalP1Cases().find((item) => item.id === 'provider-invalid-auth');
    if (!caseData) throw new Error('P1 auth Case is missing');

    const item = createLangfuseDatasetItem('flowmate/P1/v1/fixture', 'P1', 'fixture', caseData);

    expect(item.input).toMatchObject({
      case: {
        id: 'provider-invalid-auth',
        version: 1,
        name: '认证失败且秘密不泄露',
        capability: 'provider-authentication-failure',
      },
      modelInput: { goal: '验证无效认证配置能够明确失败。', text: '' },
    });
    expect(JSON.stringify(item.input)).not.toContain('fault_profile');
    expect(item.metadata).toMatchObject({
      caseId: 'provider-invalid-auth',
      caseName: '认证失败且秘密不泄露',
      capability: 'provider-authentication-failure',
      projectionVersion: 2,
    });
  });

  test('keeps score names aggregatable while putting the Case identity in every score comment', () => {
    const scores = buildExperimentScores({
      case: {
        id: 'provider-invalid-auth',
        version: 1,
        name: '认证失败且秘密不泄露',
        capability: 'provider-authentication-failure',
        relatedCapabilities: ['error-normalization'],
      },
      execution: {} as never,
      evaluation: {
        status: 'PASS',
        productSuccess: false,
        reason: 'All applicable deterministic checks passed',
        checks: [{ checkId: 'auth-terminal', applicable: true, status: 'PASS', expected: {}, actual: {}, reason: 'run fails with provider_auth_failed', evidenceRefs: [] }],
      },
      evidenceSummary: { required: 3, present: 3, missing: [] },
    });

    expect(scores.map((score) => score.name)).toEqual(['p1_case_identity', 'p1_case_status', 'p1_case_pass', 'check_auth-terminal']);
    expect(scores[0]).toMatchObject({
      name: 'p1_case_identity',
      value: 'provider-invalid-auth/v1 | 认证失败且秘密不泄露 | provider-authentication-failure',
      dataType: 'CATEGORICAL',
    });
    expect(scores.every((score) => score.comment.startsWith('[provider-invalid-auth/v1 | 认证失败且秘密不泄露 | provider-authentication-failure]'))).toBeTrue();
  });

  test('uses the Case identity in observations and terminal summaries instead of raw score names', () => {
    const label = {
      id: 'provider-invalid-auth',
      version: 1,
      name: '认证失败且秘密不泄露',
      capability: 'provider-authentication-failure',
      relatedCapabilities: ['error-normalization'],
    };

    expect(caseObservationName('P1', 'fixture', label)).toBe('P1 · Fixture · provider-invalid-auth/v1 · 认证失败且秘密不泄露');
    expect(formatExperimentCaseSummaries([{
      case: label,
      grade: 'PASS',
      checks: [{ id: 'auth-terminal', status: 'PASS' }, { id: 'no-secret', status: 'PASS' }],
      traceId: 'trace-id',
      traceUrl: 'http://localhost:3000/project/project-id/traces/trace-id',
    }])).toBe([
      'P1 Case 结果：',
      '- provider-invalid-auth/v1 | 认证失败且秘密不泄露',
      '  能力点：provider-authentication-failure',
      '  评测结论：PASS',
      '  检查：auth-terminal=PASS；no-secret=PASS',
      '  Trace：http://localhost:3000/project/project-id/traces/trace-id',
    ].join('\n'));
  });

  test('keeps the trace identifier visible when Langfuse cannot build a UI link', () => {
    expect(formatExperimentCaseSummaries([{
      case: {
        id: 'provider-timeout',
        version: 1,
        name: '超时后确认实际停止并拒绝迟到结果',
        capability: 'provider-timeout',
        relatedCapabilities: ['cancellation'],
      },
      grade: 'UNJUDGEABLE',
      checks: [{ id: 'request-stopped', status: 'UNJUDGEABLE' }],
      traceId: 'trace-timeout',
      traceUrl: null,
    }])).toContain('Trace：trace-timeout（链接未生成，请在 Experiments 中按 executionId 查找）');
  });
});
