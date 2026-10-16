import { describe, expect, it } from 'bun:test';
import * as contracts from '../../packages/contracts/src/index.ts';

const parse = Reflect.get(contracts, 'parseEvaluationCommand') as
  ((value: unknown) => { type: string; input: unknown } | null) | undefined;
const preview = { datasetId: 'business', selection: 'smoke', repeat: 1, judge: 'auto', configuration: {} };

describe('Evaluation public requests', () => {
  it('accepts a bounded registered selection without model or execution overrides', () => {
    expect(parse?.({ type: 'preview_evaluation', input: preview })).toEqual({ type: 'preview_evaluation', input: preview });
    expect(parse?.({ type: 'start_evaluation', input: { previewId: 'preview-1', requestId: 'request-1' } }))
      .toEqual({ type: 'start_evaluation', input: { previewId: 'preview-1', requestId: 'request-1' } });
  });

  it.each(['kernel', 'fetcher', 'cwd', 'workerPath', 'env', 'backend', 'apiKey', 'model'])(
    'rejects the untrusted %s field before execution', field => {
      expect(parse?.({ type: 'preview_evaluation', input: { ...preview, [field]: 'untrusted' } })).toBeNull();
    });

  it('requires an identified Dataset for a single Case and forbids a Case on a suite selection', () => {
    expect(parse?.({ type: 'preview_evaluation', input: { ...preview, datasetId: 'all', selection: 'case', caseId: 'FM-028' } })).toBeNull();
    expect(parse?.({ type: 'preview_evaluation', input: { ...preview, caseId: 'FM-028' } })).toBeNull();
    expect(parse?.({ type: 'preview_evaluation', input: { ...preview, selection: 'case', caseId: 'FM-028' } }))
      .toMatchObject({ input: { datasetId: 'business', selection: 'case', caseId: 'FM-028' } });
  });

  it('bounds repetitions, file identities and read pages', () => {
    for (const repeat of [0, 21, 1.5]) expect(parse?.({ type: 'preview_evaluation', input: { ...preview, repeat } })).toBeNull();
    expect(parse?.({ type: 'query_evaluation_result', input: { executionId: '../secrets', view: 'summary' } })).toBeNull();
    expect(parse?.({ type: 'query_evaluation_result', input: { executionId: 'agent-1', view: 'events', offset: -1 } })).toBeNull();
    expect(parse?.({ type: 'query_evaluation_catalog', input: { view: 'case', datasetId: 'business', caseId: 'FM-028', limit: 1_000_000 } })).toBeNull();
  });

  it('requires a Case view identity for new feedback and a precise Trial for run feedback', () => {
    const feedback = { operationId: 'feedback-1', reviewer: 'synthetic-reviewer', verdict: 'bad', note: 'Synthetic evidence gap' };
    expect(parse?.({ type: 'add_evaluation_feedback', input: { ...feedback, target: { kind: 'case-quality', datasetId: 'business', caseId: 'FM-028' } } })).toBeNull();
    expect(parse?.({ type: 'add_evaluation_feedback', input: { ...feedback, target: { kind: 'run-feedback', executionId: 'agent-1', caseId: 'FM-028' } } })).toBeNull();
    expect(parse?.({ type: 'add_evaluation_feedback', input: { ...feedback, target: { kind: 'case-quality', datasetId: 'business', caseId: 'FM-028', caseViewId: 'view-1' } } }))
      .toMatchObject({ input: { target: { caseViewId: 'view-1' }, reviewer: 'synthetic-reviewer' } });
  });

  it('rejects arbitrary commands, envelope fields and role credential references', () => {
    expect(parse?.({ type: 'exec', input: { command: 'bun' } })).toBeNull();
    expect(parse?.({ type: 'start_evaluation', input: { previewId: 'view-1', requestId: 'request-1' }, script: 'anything' })).toBeNull();
    expect(parse?.({ type: 'save_evaluation_settings', input: { expectedRevision: 0, role: 'business', connection: null } })).toBeNull();
    expect(parse?.({ type: 'save_evaluation_settings', input: { expectedRevision: 0, role: 'agent', connection: {
      api: 'openai-completions', baseUrl: 'https://provider.invalid/v1', model: 'synthetic', credentialRef: 'business-ref',
    } } })).toBeNull();
  });
});

const control = { version: 1, sessionId: 'worker-1', batchId: 'batch-1', requestId: 'start-1',
  state: 'preparing', outcome: null, startedAt: '2026-01-01T00:00:00.000Z', endedAt: null,
  executionIds: [], progress: null, stop: 'not-started', errors: [] };

it('verifies control replies against the original batch and rejects untyped or secret fields', () => {
  const read = Reflect.get(contracts, 'parseEvaluationResponse') as ((type: string, value: unknown) => unknown) | undefined;
  const matches = Reflect.get(contracts, 'matchesEvaluationResponse') as ((command: unknown, value: unknown) => boolean) | undefined;
  const response = { ok: true, data: control };
  expect(read?.('query_evaluation_control', response)).toEqual(response);
  expect(read?.('query_evaluation_control', { ok: true, data: { ...control, apiKey: 'synthetic-key' } })).toBeNull();
  expect(read?.('query_evaluation_control', { ok: true, data: { ...control, state: 'made-up' } })).toBeNull();
  expect(matches?.({ type: 'query_evaluation_control', input: { batchId: 'batch-1' } }, response)).toBe(true);
  expect(matches?.({ type: 'query_evaluation_control', input: { batchId: 'another-batch' } }, response)).toBe(false);
  expect(matches?.({ type: 'start_evaluation', input: { previewId: 'view-1', requestId: 'another-start' } }, response)).toBe(false);
});

it('preserves existing guardrail metric IDs independently of file-safe execution identities', () => {
  const plan = { evaluatorId: 'fact-check', version: 1, kind: 'deterministic' as const, applicable: true, reason: 'Declared Skill requirement',
    outputs: [{ metricId: 'fact-check/required-skills', category: 'guardrail' as const, applicable: true, reason: 'Declared Skill requirement', required: true }] };
  expect(contracts.EvaluationEvaluatorPlanSchema.parse(plan)).toEqual(plan);
  expect(contracts.EvaluationIdSchema.safeParse('fact-check/required-skills').success).toBe(false);
});

it('rejects cross-session events and invalid sequence or public evidence paths', () => {
  const read = Reflect.get(contracts, 'parseEvaluationEvent') as ((value: unknown) => unknown) | undefined;
  const event = { version: 1, sessionId: 'worker-1', sequence: 1, control };
  expect(read?.(event)).toEqual(event);
  expect(read?.({ ...event, sessionId: 'another-worker' })).toBeNull();
  expect(read?.({ ...event, sequence: 0 })).toBeNull();
  expect(read?.({ ...event, control: { ...control, progress: { type: 'trial-end', evidenceDirectory: 'C:/private' } } })).toBeNull();
});

it('accepts only a nonsecret dedicated settings reply for the requested role and a new revision', () => {
  const read = Reflect.get(contracts, 'parseEvaluationResponse') as ((type: string, value: unknown) => unknown) | undefined;
  const matches = Reflect.get(contracts, 'matchesEvaluationResponse') as ((command: unknown, value: unknown) => boolean) | undefined;
  const reply = { ok: true, data: { role: 'agent', revision: 2, evaluation: { agent: null, judge: null }, credentials: { agent: 'missing', judge: 'missing' } } };
  expect(read?.('save_evaluation_settings', reply)).toEqual(reply);
  expect(read?.('save_evaluation_settings', { ...reply, data: { ...reply.data, apiKey: 'synthetic-key' } })).toBeNull();
  expect(matches?.({ type: 'save_evaluation_settings', input: { expectedRevision: 1, role: 'agent', connection: null } }, reply)).toBe(true);
  expect(matches?.({ type: 'save_evaluation_settings', input: { expectedRevision: 1, role: 'judge', connection: null } }, reply)).toBe(false);
  expect(matches?.({ type: 'save_evaluation_settings', input: { expectedRevision: 2, role: 'agent', connection: null } }, reply)).toBe(false);
});

it('catalog replies retain their selected view and cannot stand in for an Execution list', () => {
  const reply = { ok: true as const, data: { version: 1, sessionId: 'worker-1', view: 'list', viewId: 'catalog-1', items: [],
    page: { offset: 0, limit: 50, total: 0, nextOffset: null, complete: true, unit: 'rows' } } } satisfies contracts.Result<contracts.EvaluationCatalog>;
  expect(contracts.parseEvaluationResponse('query_evaluation_catalog', reply)).toEqual(reply);
  const command = contracts.parseEvaluationCommand({ type: 'query_evaluation_catalog', input: { view: 'list', viewId: 'catalog-1' } })!;
  expect(contracts.matchesEvaluationResponse(command, contracts.parseEvaluationResponse('query_evaluation_catalog', reply)!)).toBe(true);
  expect(contracts.matchesEvaluationResponse(contracts.parseEvaluationCommand({ type: 'list_evaluation_executions', input: {} })!,
    contracts.parseEvaluationResponse('query_evaluation_catalog', reply)!)).toBe(false);
  expect(contracts.parseEvaluationResponse('query_evaluation_catalog', { ...reply, data: { ...reply.data, root: 'C:/private' } })).toBeNull();
});

it('feedback replies bind the original operation, reviewer and exact target without exposing private conditions', () => {
  const record = { id: 'feedback-1', kind: 'case-quality', datasetId: 'facility-test', caseId: 'test-fields', caseVersion: 1,
    executionId: null, trialId: null, reviewer: 'synthetic-reviewer', reviewerTruncated: false, at: '2026-01-01T00:00:00.000Z',
    verdict: 'bad', note: 'Synthetic gap.', noteTruncated: false, source: 'local', sourceTruncated: false } satisfies contracts.EvaluationFeedbackRecord;
  const reply = { ok: true as const, data: { version: 1, sessionId: 'worker-1', operationId: 'feedback-1', record } } satisfies contracts.Result<contracts.EvaluationFeedbackSaved>;
  const parsed = contracts.parseEvaluationResponse('add_evaluation_feedback', reply)!;
  const input = { operationId: 'feedback-1', reviewer: record.reviewer, verdict: record.verdict, note: record.note,
    target: { kind: 'case-quality', datasetId: 'facility-test', caseId: 'test-fields', caseViewId: 'case-view-1' } };
  expect(parsed).toEqual(reply);
  expect(contracts.matchesEvaluationResponse(contracts.parseEvaluationCommand({ type: 'add_evaluation_feedback', input })!, parsed)).toBe(true);
  expect(contracts.matchesEvaluationResponse(contracts.parseEvaluationCommand({ type: 'add_evaluation_feedback', input: {
    ...input, target: { ...input.target, caseId: 'test-lines' } } })!, parsed)).toBe(false);
  expect(contracts.parseEvaluationResponse('add_evaluation_feedback', { ...reply, data: { ...reply.data, record: { ...record, conditions: {} } } })).toBeNull();
});

it('export replies match the original Execution and action and never accept platform keys', () => {
  const reply = { ok: true as const, data: { version: 1, sessionId: 'worker-1', executionId: 'unit', operationId: 'upload-1',
    export: { backend: 'langfuse', status: 'complete', target: { baseUrl: 'https://platform.invalid', projectId: 'synthetic-project' },
      progress: { total: 3, accepted: 3, rejected: 0, unconfirmed: 0 }, error: null, errorTruncated: false } } } satisfies contracts.Result<contracts.EvaluationExportResult>;
  const parsed = contracts.parseEvaluationResponse('export_evaluation', reply)!;
  expect(parsed).toEqual(reply);
  expect(contracts.matchesEvaluationResponse(contracts.parseEvaluationCommand({ type: 'export_evaluation', input: { executionId: 'unit', operationId: 'upload-1' } })!, parsed)).toBe(true);
  expect(contracts.matchesEvaluationResponse(contracts.parseEvaluationCommand({ type: 'export_evaluation', input: { executionId: 'different', operationId: 'upload-1' } })!, parsed)).toBe(false);
  expect(contracts.parseEvaluationResponse('export_evaluation', { ...reply, data: { ...reply.data, secretKey: 'synthetic-secret' } })).toBeNull();
});
