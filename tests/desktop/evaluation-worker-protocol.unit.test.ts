import { expect, test } from 'bun:test';

import { parseEvaluationWorkerCommand as parse, parseEvaluationWorkerOutput, type EvaluationWorkerReply, type EvaluationWorkerCommand } from '../../agent-eval/src/desktop/protocol.ts';
import type { EvaluationConfigurationSnapshot } from '@flowmate/contracts';
const snapshot = { revision: 1, agent: null, judge: null, credentials: { agent: 'missing', judge: 'missing' } } satisfies EvaluationConfigurationSnapshot;
const envelope = { version: 1 as const, sessionId: 'worker-1', messageId: 'message-1' };

test('Worker preview and control accept only their fixed operations and no secrets or arbitrary paths', () => {
  expect(parse?.({ ...envelope, type: 'query_evaluation_control', input: {} })).toEqual({ ...envelope, type: 'query_evaluation_control', input: {} });
  expect(parse?.({ ...envelope, type: 'preview_evaluation', input: { datasetId: 'all', selection: 'smoke', repeat: 1, judge: 'auto', configuration: {} }, settings: snapshot }))
    .toMatchObject({ type: 'preview_evaluation', settings: snapshot });
  expect(parse?.({ ...envelope, type: 'query_evaluation_control', input: {}, apiKey: 'synthetic-key' })).toBeNull();
  expect(parse?.({ ...envelope, type: 'exec', input: { command: 'anything' } })).toBeNull();
  expect(parse?.({ ...envelope, type: 'shutdown', input: {}, path: 'C:/private' })).toBeNull();
});

test('a reply carries the Worker sequence that makes late progress distinguishable from current state', () => {
  const reply = { ...envelope, type: 'response' as const, operation: 'shutdown' as const, sequence: 2,
    result: { ok: true as const, data: { closed: true, stopped: true } } };
  expect(parseEvaluationWorkerOutput(reply)).toEqual(reply);
  expect(parseEvaluationWorkerOutput({ ...reply, sequence: -1 })).toBeNull();
});

test('only the private start connection carries explicit keys and response identity cannot be changed', () => {
  const start = { ...envelope, type: 'start_evaluation' as const, input: { previewId: 'preview-1', requestId: 'start-1' }, context: {
    batchId: 'batch-1', settings: snapshot, credentials: { agent: 'synthetic-key', judge: null },
  } };
  expect(parse?.(start)).toEqual(start);
  expect(parse?.({ ...start, context: { ...start.context, credentials: { ...start.context.credentials, env: {} } } })).toBeNull();
  expect(parse?.({ ...start, version: 2 })).toBeNull();
  expect(parse?.({ ...start, messageId: '../command' })).toBeNull();
});

test('read-only report commands and replies remain bound to their Worker session and view', () => {
  expect(parse({ ...envelope, type: 'list_evaluation_executions', input: {} })).toMatchObject({ type: 'list_evaluation_executions', input: { offset: 0, limit: 50 } });
  expect(parse({ ...envelope, type: 'query_evaluation_result', input: { executionId: 'run-1', view: 'scores', path: 'C:/private' } })).toBeNull();
  const reply = { ...envelope, type: 'response', operation: 'list_evaluation_executions', sequence: 0,
    result: { ok: true, data: { version: 1, sessionId: 'worker-1', viewId: 'list-1', items: [],
      page: { offset: 0, limit: 50, total: 0, nextOffset: null, complete: true, unit: 'rows' } } } } satisfies EvaluationWorkerReply;
  expect(parseEvaluationWorkerOutput(reply)).toEqual(reply);
  expect(parseEvaluationWorkerOutput({ ...reply, result: { ok: true, data: { ...reply.result.data, sessionId: 'another-worker' } } })).toBeNull();
});

test('Case and feedback operations accept only bounded identities and cannot receive self-reported conditions or secrets', () => {
  expect(parse({ ...envelope, type: 'query_evaluation_catalog', input: { view: 'list' } }))
    .toMatchObject({ type: 'query_evaluation_catalog', input: { offset: 0, limit: 50 } });
  const input = { target: { kind: 'case-quality', datasetId: 'facility-test', caseId: 'test-fields', caseViewId: 'case-view' },
    operationId: 'feedback-1', reviewer: 'synthetic-reviewer', verdict: 'bad', note: 'Synthetic gap.' };
  expect(parse({ ...envelope, type: 'add_evaluation_feedback', input })).toMatchObject({ type: 'add_evaluation_feedback', input });
  expect(parse({ ...envelope, type: 'add_evaluation_feedback', input: { ...input, conditions: {} } })).toBeNull();
  expect(parse({ ...envelope, type: 'query_evaluation_feedback', input: {
    target: { kind: 'case-quality', datasetId: 'facility-test', caseId: 'test-fields' }, operationId: 'feedback-1', apiKey: 'synthetic-key' } })).toBeNull();
});

test('only the private export operation carries a validated fixed platform connection', () => {
  const command = { ...envelope, type: 'export_evaluation', input: { executionId: 'unit', operationId: 'upload-1' },
    connection: { baseUrl: 'https://platform.invalid', publicKey: 'synthetic-public', secretKey: 'synthetic-secret' } } satisfies EvaluationWorkerCommand;
  expect(parse(command)).toEqual(command);
  expect(parse({ ...command, connection: { ...command.connection, env: {} } })).toBeNull();
  expect(parse({ ...command, connection: { ...command.connection, baseUrl: 'https://user:secret@platform.invalid' } })).toBeNull();
  expect(parse({ ...command, input: { ...command.input, secretKey: 'untrusted' } })).toBeNull();
});

test('only a private experiment command accepts explicitly matched Subject credentials', () => {
  const context: Extract<EvaluationWorkerCommand, { type: 'evaluation_workflow' }>['context'] = {
    agentCredentials: [{ connection: { model: 'synthetic-agent', api: 'openai-completions', baseUrl: 'https://synthetic.invalid/v1' }, apiKey: 'synthetic-arm-key' }] };
  const command = { ...envelope, type: 'evaluation_workflow', input: { action: 'experiment.run', plan: { id: 'synthetic-experiment' } }, context } satisfies EvaluationWorkerCommand;
  expect(parse(command)).toEqual(command);
  expect(parse({ ...command, input: { ...command.input, apiKey: 'untrusted-public-key' } })).toBeNull();
  expect(parse({ ...command, input: { action: 'settings.get' } })).toBeNull();
  expect(parse({ ...command, context: { ...context, env: {} } })).toBeNull();
  expect(parse({ ...command, context: { agentCredentials: [{ ...context.agentCredentials[0], connection: { ...context.agentCredentials[0]!.connection, cwd: 'C:/private' } }] } })).toBeNull();
});
