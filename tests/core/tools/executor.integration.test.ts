import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'bun:test';
import { z } from 'zod';
import { appError, ToolExecutionFailure, NativeToolOutputSchema, invoiceToolSchemas } from '@flowmate/contracts';
import type { AppError, ToolDefinition, ToolExecutionContext, ToolEffect, ToolRuntimeObservation } from '@flowmate/contracts';
import { deferCleanup } from '../../support/resources.ts';
import { openDatabase } from '../../../packages/core/src/storage/database.ts';
import { createToolExecutor } from '../../../packages/core/src/tools/executor.ts';
import { createToolRecorder } from '../../../packages/core/src/tools/recorder.ts';

function makeRuntime(names: string[], options: { maxToolCalls?: number; maxResultBytes?: number } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'flowmate-tool-executor-'));
  const opened = openDatabase({ root, databaseFile: join(root, 'data', 'flowmate.sqlite'), logsDir: join(root, 'logs'),
    artifactsDir: join(root, 'artifacts'), outputsDir: join(root, 'outputs'), runtimeDir: join(root, 'runtime') });
  expect(opened.ok).toBe(true);
  if (!opened.ok) throw new Error(opened.error.code);
  deferCleanup(() => opened.data.close());
  const at = '2026-09-28T00:00:00.000Z';
  const session = opened.data.sessions.create({ nativeSessionId: 'tool-executor-session', title: 'Fixture', at });
  expect(session.ok).toBe(true);
  if (!session.ok) throw new Error(session.error.code);
  opened.data.db.query(`INSERT INTO runs(kind,session_id,scope_json,status,goal,input_json,config_json,cleanup_json,usage_json,created_at,started_at)
    VALUES ('agent',?,?,'running','fixture','{}','{}','{}','{}',?,?)`).run(session.data.sessionId, JSON.stringify({ version: 2,
    allowedTools: names, allowedDocumentIds: [1], allowedArtifactIds: [1, 2], allowedResourcePaths: [] }), at, at);
  const scope = { version: 2 as const, allowedTools: names, allowedDocumentIds: [1], allowedArtifactIds: [1, 2], allowedResourcePaths: [] };
  const definitions: ToolDefinition<any, any>[] = names.map((name) => ({ name, version: '1', description: `Fixture ${name}`,
    inputSchema: z.object({ value: z.number().int() }).strict(), outputSchema: z.object({ value: z.number().int() }).strict(),
    effect: 'READ', executionMode: 'parallel', execute: async ({ value }) => ({ value }) }));
  const recorder = createToolRecorder(opened.data.toolCalls, () => at);
  const executor = createToolExecutor({ definitions, recorder, now: () => at, ...options });
  const context = (nativeToolCallId: string, signal = new AbortController().signal): ToolExecutionContext => ({
    runId: 1, sessionId: session.data.sessionId, nativeToolCallId, scope, signal,
  });
  return { ...opened.data, executor, context, sessionId: session.data.sessionId, at };
}

describe('P3 Tool Executor', () => {
  it.each([['READ', false], ['LOCAL_WRITE', true]] as const)('uses monotonic timeout evidence and preserves %s recovery eligibility', async (effect, fatal) => {
    const store = makeRuntime(['read_fixture']);
    const clock = [100, 250, 300, 310];
    let executions = 0;
    const definition = { ...store.executor.listTools()[0]!, effect, execute: async ({ value }: { value: number }) => {
      executions++; return { value };
    } };
    const executor = createToolExecutor({ definitions: [definition], recorder: createToolRecorder(store.toolCalls, () => store.at),
      now: () => store.at, maxToolTimeoutMs: 100, monotonicNow: () => clock.shift()! });
    expect(await executor.execute('read_fixture', { value: 1 }, store.context('timer-lag'))).toMatchObject({ fatal,
      result: { status: 'failed', error: { code: 'tool_timeout' } }, call: { runtimeObservation: {
        executionDurationMs: 150, timingComplete: true, diagnosticCode: 'tool_timeout', effectiveTimeoutMs: 100,
        commit: 'none_confirmed',
      } } });
    if (effect === 'READ') {
      expect(await executor.execute('read_fixture', { value: 1 }, store.context('timer-lag'))).toMatchObject({
        fatal: false, result: { status: 'failed', error: { code: 'tool_timeout' } },
      });
      expect(executions).toBe(1);
      expect(await executor.execute('read_fixture', { value: 2 }, store.context('legal-new-call'))).toMatchObject({
        fatal: false, result: { status: 'succeeded', data: { value: 2 } },
      });
      expect(executions).toBe(2);
    }
  });

  it.each(['bash', 'powershell'])('honors the existing shorter %s timeout and measures execution with the monotonic clock', async (name) => {
    const store = makeRuntime([name]);
    const clock = [100, 110, 135];
    const executor = createToolExecutor({ recorder: createToolRecorder(store.toolCalls, () => store.at), now: () => store.at,
      monotonicNow: () => clock.shift()!, definitions: [{ name, version: '0.85.1', description: 'Native timeout fixture', effect: 'LOCAL_WRITE',
        executionMode: 'parallel', inputSchema: z.object({ timeout: z.number().positive() }).strict(), outputSchema: NativeToolOutputSchema,
        execute: async () => ({ content: [{ type: 'text' as const, text: 'Done' }], details: {} }) }] });
    executor.setRunDeadline(1, 2100);
    expect(await executor.execute(name, { timeout: 1 }, store.context('short-native-timeout'))).toMatchObject({ result: { status: 'succeeded' },
      call: { runtimeObservation: { effectiveTimeoutMs: 1000, timeoutSource: 'native', runDeadlineTruncated: false,
        executionDurationMs: 25, timingComplete: true } } });
  });
  it('closes a timed-out READ when its tool deadline was truncated by the Run deadline', async () => {
    const store = makeRuntime(['read_fixture']);
    const clock = [0, 0, 150];
    const executor = createToolExecutor({ definitions: store.executor.listTools(), recorder: createToolRecorder(store.toolCalls, () => store.at),
      now: () => store.at, maxToolTimeoutMs: 200, monotonicNow: () => clock.shift()! });
    executor.setRunDeadline(1, 100);
    expect(await executor.execute('read_fixture', { value: 1 }, store.context('run-timeout'))).toMatchObject({ fatal: true,
      result: { status: 'failed', error: { code: 'tool_timeout' } }, call: { runtimeObservation: {
        effectiveTimeoutMs: 100, runDeadlineTruncated: true, commit: 'none_confirmed',
      } } });
  });
  it('closes a failed READ when its recorded owned process has not confirmed stop', async () => {
    const store = makeRuntime(['read_fixture']);
    const executor = createToolExecutor({ definitions: [{ ...store.executor.listTools()[0]!, execute: async () => {
      store.db.query('UPDATE tool_calls SET cleanup_json=? WHERE native_tool_call_id=?').run(JSON.stringify({
        version: 1, stopReason: null, stopped: false, errors: [], nativeProcesses: [{ nativeToolCallId: 'failed-process',
          pid: 4001, identity: 'owned-process', executable: 'fixture', startedAt: store.at, stopped: false }],
      }), 'failed-process');
      throw new ToolExecutionFailure(appError('tool_execution_failed', 'tool', 'Process observation failed.'));
    } }], recorder: createToolRecorder(store.toolCalls, () => store.at), now: () => store.at });
    expect(await executor.execute('read_fixture', { value: 1 }, store.context('failed-process'))).toMatchObject({ fatal: true,
      result: { status: 'failed', error: { code: 'tool_execution_failed' } }, call: { cleanup: { stopped: false },
        runtimeObservation: { timingComplete: false, commit: 'unknown' },
      } });
  });
  it('rejects schema-valid invoice output belonging to a document outside the original Run', async () => {
    const store = makeRuntime(['list_invoice_pages']);
    const executor = createToolExecutor({ recorder: createToolRecorder(store.toolCalls, () => store.at), now: () => store.at,
      definitions: [{ name: 'list_invoice_pages', version: '1', description: 'Wrong document fixture', effect: 'READ', executionMode: 'parallel',
        inputSchema: invoiceToolSchemas.list_invoice_pages.input, outputSchema: invoiceToolSchemas.list_invoice_pages.output,
        execute: async () => ({ documentRef: { id: 999, version: 'v1' }, parsedArtifactId: 2, pageCount: 1, pages: [] }) }] });
    expect(await executor.execute('list_invoice_pages', { documentId: 1 }, store.context('wrong-doc'))).toMatchObject({
      result: { status: 'failed', error: { code: 'tool_invalid_output' } }, call: { runtimeObservation: {
        afterStructure: 'valid', afterDomain: 'invalid', failureStage: 'validation',
      } },
    });
  });
  it('counts serialized feedback envelopes against one shared Run result budget', async () => {
    const store = makeRuntime(['read_fixture']);
    const definition = { ...store.executor.listTools()[0]!, outputSchema: z.object({ text: z.string() }).strict(),
      execute: async () => ({ text: 'x'.repeat(100) }) };
    const executor = createToolExecutor({ definitions: [definition], recorder: createToolRecorder(store.toolCalls, () => store.at),
      now: () => store.at, maxResultBytes: 500 });
    expect(await executor.execute('read_fixture', { value: 1 }, store.context('feedback-1'))).toMatchObject({ result: { status: 'succeeded' } });
    expect(await executor.execute('read_fixture', { value: 2 }, store.context('feedback-2'))).toMatchObject({ result: { status: 'failed',
      error: { code: 'tool_context_limit' } }, fatal: true });
  });
  it('counts failed error feedback once and closes admission when parallel failures exceed the shared budget', async () => {
    const store = makeRuntime(['read_fixture']);
    let executions = 0;
    const executor = createToolExecutor({ definitions: [{ ...store.executor.listTools()[0]!, execute: async () => {
      executions++; throw new ToolExecutionFailure(appError('tool_execution_failed', 'tool', 'x'.repeat(1000)));
    } }], recorder: createToolRecorder(store.toolCalls, () => store.at), now: () => store.at, maxResultBytes: 1500 });
    const first = await executor.execute('read_fixture', { value: 1 }, store.context('failure-1'));
    expect(first).toMatchObject({ fatal: false, result: { status: 'failed', error: { code: 'tool_execution_failed' } } });
    expect(await executor.execute('read_fixture', { value: 1 }, store.context('failure-1'))).toMatchObject({ fatal: false, call: first.call });
    const remaining = await Promise.all([
      executor.execute('read_fixture', { value: 2 }, store.context('failure-2')),
      executor.execute('read_fixture', { value: 3 }, store.context('failure-3')),
    ]);
    expect(remaining.every(result => result.fatal && result.result.status === 'failed' && result.result.error.code === 'tool_context_limit')).toBe(true);
    expect(await executor.execute('read_fixture', { value: 4 }, store.context('failure-4'))).toMatchObject({ fatal: true,
      result: { status: 'failed', error: { code: 'tool_budget_exceeded' } } });
    expect(executions).toBe(3);
    expect(store.db.query('SELECT tool_call_count FROM runs WHERE id=1').get()).toEqual({ tool_call_count: 3 });
  });
  it('counts Host and SDK refusal feedback against the same result budget without fabricating executions', async () => {
    const store = makeRuntime(['read_fixture']);
    const host = createToolExecutor({ definitions: store.executor.listTools(), recorder: createToolRecorder(store.toolCalls, () => store.at),
      now: () => store.at, maxResultBytes: 1 });
    expect(await host.execute('unknown_fixture', {}, store.context('host-byte-limit'))).toMatchObject({ fatal: true,
      result: { status: 'failed', error: { code: 'tool_context_limit' } }, call: { startedAt: null,
        runtimeObservation: { beforeOutcome: 'rejected', executionDurationMs: null, afterStructure: 'not_applicable' } } });
    const sdk = createToolExecutor({ definitions: store.executor.listTools(), recorder: createToolRecorder(store.toolCalls, () => store.at),
      now: () => store.at, maxResultBytes: 1500 });
    const reason = appError('tool_invalid_input', 'tool', 'x'.repeat(1000));
    expect(sdk.rejectRequest('read_fixture', { value: 'bad' }, store.context('sdk-byte-1'), reason, 'sdk_arguments').ok).toBe(true);
    expect(sdk.rejectRequest('read_fixture', { value: 'bad' }, store.context('sdk-byte-1'), reason, 'sdk_arguments').ok).toBe(true);
    expect(sdk.rejectRequest('read_fixture', { value: 'bad' }, store.context('sdk-byte-2'), reason, 'sdk_arguments')).toMatchObject({
      ok: false, error: { code: 'tool_context_limit' },
    });
    expect(sdk.queryCall(store.context('sdk-byte-2'), 'sdk-byte-2')).toMatchObject({ ok: true, data: {
      startedAt: null, runtimeObservation: { beforeOutcome: 'rejected', failureStage: 'sdk_arguments', executionDurationMs: null },
    } });
    expect(await sdk.execute('read_fixture', { value: 3 }, store.context('sdk-byte-3'))).toMatchObject({ fatal: true,
      result: { status: 'failed', error: { code: 'tool_budget_exceeded' } } });
  });
  it('counts native failed content and details rather than a replacement error message', async () => {
    const store = makeRuntime(['bash']);
    const output = { content: [{ type: 'text' as const, text: 'x'.repeat(800) }], details: { exitCode: 7 } };
    const executor = createToolExecutor({ definitions: [{ ...store.executor.listTools()[0]!, effect: 'LOCAL_WRITE',
      outputSchema: NativeToolOutputSchema, execute: async () => {
        throw new ToolExecutionFailure(appError('tool_execution_failed', 'tool', 'y'.repeat(10_000)), output);
      } }], recorder: createToolRecorder(store.toolCalls, () => store.at), now: () => store.at, maxResultBytes: 2200 });
    for (const id of ['native-feedback-1', 'native-feedback-2']) {
      expect(await executor.execute('bash', { value: 1 }, store.context(id))).toMatchObject({ fatal: false,
        result: { status: 'failed', data: output, error: { code: 'tool_execution_failed' } } });
    }
    expect(await executor.execute('bash', { value: 1 }, store.context('native-feedback-1'))).toMatchObject({ fatal: false });
    expect(await executor.execute('bash', { value: 1 }, store.context('native-feedback-3'))).toMatchObject({ fatal: true,
      result: { status: 'failed', error: { code: 'tool_context_limit' }, data: output } });
  });

  it('blocks further execution when a committed terminal response and its recovery query are both lost', async () => {
    const store = makeRuntime(['read_fixture']);
    let executions = 0;
    let committed = false;
    const recorder = createToolRecorder({ ...store.toolCalls,
      finish(input) { const saved = store.toolCalls.finish(input); expect(saved.ok).toBe(true); committed = true; throw new Error('Response lost.'); },
      getById(id) { if (committed) throw new Error('Query unavailable.'); return store.toolCalls.getById(id); },
    }, () => store.at);
    const executor = createToolExecutor({ definitions: [{ ...store.executor.listTools()[0]!, execute: async ({ value }) => {
      executions++; return { value };
    } }], recorder, now: () => store.at });
    expect(await executor.execute('read_fixture', { value: 1 }, store.context('lost-terminal'))).toMatchObject({ fatal: true,
      result: { status: 'failed', error: { code: 'storage_write_failed' } } });
    const saved = store.toolCalls.get({ runId: 1, sessionId: store.sessionId, nativeToolCallId: 'lost-terminal' });
    expect(saved).toMatchObject({ ok: true, data: { status: 'succeeded', result: { data: { value: 1 } },
      runtimeObservation: { timingComplete: true, afterStructure: 'valid' } } });
    expect(await executor.execute('read_fixture', { value: 1 }, store.context('lost-terminal'))).toMatchObject({ fatal: true,
      call: saved.ok ? saved.data : {} });
    expect(await executor.execute('read_fixture', { value: 2 }, store.context('lost-terminal-next'))).toMatchObject({ fatal: true,
      result: { status: 'failed', error: { code: 'tool_budget_exceeded' } } });
    expect(executions).toBe(1);
  });
  it('rechecks the frozen Run scope after SDK preparation and records a Host refusal', async () => {
    const store = makeRuntime(['read_fixture']);
    let executions = 0;
    const executor = createToolExecutor({ definitions: [{ ...store.executor.listTools()[0]!, execute: async () => {
      executions++; return { value: 1 };
    } }], recorder: createToolRecorder(store.toolCalls, () => store.at), now: () => store.at });
    const context = store.context('scope-changed');
    expect(executor.observeRequest('read_fixture', { value: 1 }, context).ok).toBe(true);
    store.db.query('UPDATE runs SET scope_json=? WHERE id=1').run(JSON.stringify({ ...context.scope, allowedDocumentIds: [] }));
    expect(await executor.execute('read_fixture', { value: 1 }, context)).toMatchObject({ result: { status: 'failed',
      error: { code: 'tool_access_denied' } }, call: { startedAt: null, runtimeObservation: { beforeOutcome: 'rejected', failureStage: 'before' } } });
    expect(executions).toBe(0);
  });
  it('freezes SDK parameter diagnostics without including another call private arguments', () => {
    const store = makeRuntime(['read_fixture']);
    const config = { allowedTools: ['read_fixture'], configuredToolTimeoutMs: 10_000,
      sdk: { codingAgent: '0.85.1', ai: '0.85.1' }, environment: 'fixture', sampleSource: 'test' as const,
      taskType: 'answer', modelKey: 'model-A', promptVersion: 'prompt-A' };
    const initial = store.executor.freezeStrategy(config);
    if (!initial.ok) throw new Error(initial.error.code);
    store.executor.configureRun(1, { budget: { maxToolCalls: 24, maxModelCalls: 16, toolTimeoutMs: 10_000 }, strategy: initial.data });
    expect(() => store.executor.configureRun(1, { budget: { maxToolCalls: 100, maxModelCalls: 64, toolTimeoutMs: 500 },
      strategy: initial.data })).toThrow('runtime_strategy_fixed');
    expect(store.executor.rejectRequest('read_fixture', { value: 'private invoice body C:/private.pdf' }, store.context('bad-args'),
      appError('tool_invalid_input', 'tool', 'private invoice body'), 'sdk_arguments').ok).toBe(true);
    const summary = store.executor.freezeStrategy(config);
    expect(summary).toMatchObject({ ok: true, data: { calibration: { groups: [{ attemptCount: 0 }] },
      experience: { items: [{ toolName: 'read_fixture', failureStage: 'sdk_arguments', diagnosticCode: 'tool_invalid_input',
        afterStructure: 'not_applicable', afterDomain: 'not_applicable', timingComplete: false, count: 1 }] } } });
    expect(JSON.stringify(summary)).not.toContain('private invoice');
    expect(JSON.stringify(summary)).not.toContain('C:/private.pdf');
    expect(store.executor.freezeStrategy({ ...config, modelKey: 'model-B' })).toMatchObject({ ok: true,
      data: { experience: { items: [] } } });
  });
  it('excludes environment and control failures from frozen tool experience without changing their facts or counts', () => {
    const store = makeRuntime(['read_fixture']);
    const config = { allowedTools: ['read_fixture'], configuredToolTimeoutMs: 10_000,
      sdk: { codingAgent: '0.85.1', ai: '0.85.1' }, environment: 'fixture', sampleSource: 'test' as const,
      taskType: 'answer', modelKey: 'model-A', promptVersion: 'prompt-A' };
    const initial = store.executor.freezeStrategy(config);
    if (!initial.ok) throw new Error(initial.error.code);
    const groupKey = initial.data.calibration.groups[0]!.groupKey;
    const diagnostics: Array<{ id: string; error: AppError; stage: ToolRuntimeObservation['failureStage'];
      rejected?: boolean; diagnosticCode?: string; afterStructure?: 'invalid'; afterDomain?: 'invalid';
      commitError?: AppError; truncated?: boolean; cancelled?: boolean }> = [
      { id: 'sdk-arguments', error: appError('tool_invalid_input', 'tool', 'Correct SDK arguments.'), stage: 'sdk_arguments', rejected: true },
      { id: 'host-arguments', error: appError('input_invalid', 'input', 'Correct arguments.'), stage: 'before', rejected: true },
      { id: 'read-reference', error: appError('tool_invalid_input', 'input', 'Read the correct page.'), stage: 'execute' },
      { id: 'candidate-source', error: appError('source_invalid', 'input', 'Correct the source reference.'), stage: 'execute' },
      { id: 'execution-1', error: appError('tool_execution_failed', 'tool', 'Execution failed.'), stage: 'execute' },
      { id: 'execution-2', error: appError('tool_execution_failed', 'tool', 'Another execution failed.'), stage: 'execute' },
      { id: 'output-structure', error: appError('tool_invalid_output', 'tool', 'Invalid output.'), stage: 'validation', afterStructure: 'invalid' },
      { id: 'output-receipt', error: appError('tool_invalid_output', 'tool', 'Incompatible receipt.'), stage: 'validation', afterDomain: 'invalid' },
      { id: 'tool-timeout', error: appError('tool_timeout', 'runtime', 'Tool deadline elapsed.'), stage: 'execute' },
      { id: 'permission', error: appError('tool_access_denied', 'runtime', 'Permission denied.'), stage: 'before', rejected: true },
      { id: 'material', error: appError('input_unavailable', 'input', 'Material unavailable.'), stage: 'execute', afterStructure: 'invalid' },
      { id: 'artifact', error: appError('artifact_unavailable', 'input', 'Artifact unavailable.'), stage: 'execute' },
      { id: 'storage-result', error: appError('storage_corrupt', 'storage', 'Stored facts unavailable.'), stage: 'execute',
        diagnosticCode: 'tool_execution_failed', afterDomain: 'invalid' },
      { id: 'storage-commit', error: appError('tool_invalid_output', 'tool', 'Output could not be verified.'), stage: 'validation',
        afterDomain: 'invalid', commitError: appError('storage_corrupt', 'storage', 'Commit query failed.') },
      { id: 'storage-stage', error: appError('tool_execution_failed', 'tool', 'Storage stage failed.'), stage: 'storage' },
      { id: 'history-stage', error: appError('tool_execution_failed', 'tool', 'History stage failed.'), stage: 'history' },
      { id: 'delivery-stage', error: appError('tool_execution_failed', 'tool', 'Delivery stage failed.'), stage: 'delivery' },
      { id: 'sdk-after-stage', error: appError('tool_execution_failed', 'tool', 'SDK feedback failed.'), stage: 'sdk_after' },
      { id: 'revoked', error: appError('session_scope_revoked', 'session', 'Permission revoked.'), stage: 'before', rejected: true },
      { id: 'cancelled', error: appError('agent_cancelled', 'runtime', 'Run cancelled.'), stage: 'execute', cancelled: true },
      { id: 'budget', error: appError('tool_budget_exceeded', 'runtime', 'Call budget exhausted.'), stage: 'before', rejected: true },
      { id: 'feedback-budget', error: appError('tool_context_limit', 'runtime', 'Feedback budget exhausted.'), stage: 'validation', afterDomain: 'invalid' },
      { id: 'run-deadline', error: appError('agent_timeout', 'runtime', 'Run deadline elapsed.'), stage: 'before', rejected: true },
      { id: 'truncated-timeout', error: appError('tool_timeout', 'runtime', 'Run deadline truncated the tool.'), stage: 'execute', truncated: true },
    ];
    for (const sample of diagnostics) {
      const requested = store.toolCalls.request({ context: null, runId: 1, sessionId: store.sessionId, nativeToolCallId: sample.id,
        toolName: 'read_fixture', toolVersion: '1', effect: 'READ', rawArguments: { value: 1 }, requestedAt: store.at });
      if (!requested.ok) throw new Error(requested.error.code);
      const toolCallId = requested.data.toolCallId;
      const observation: ToolRuntimeObservation = { version: 1, groupKey, strategyVersion: 'runtime-v1', sampleSource: 'test',
        beforeOutcome: sample.rejected ? 'rejected' : 'allowed', failureStage: sample.stage,
        diagnosticCode: sample.diagnosticCode ?? sample.error.code, afterStructure: sample.afterStructure ?? 'not_applicable',
        afterDomain: sample.afterDomain ?? 'not_applicable', executionDurationMs: sample.rejected ? null : 1,
        timingComplete: !sample.rejected && !sample.cancelled, effectiveTimeoutMs: sample.rejected ? null : 10_000,
        timeoutSource: sample.rejected ? null : 'configured', runDeadlineTruncated: sample.truncated ?? false,
        commit: sample.commitError ? 'unknown' : 'none_confirmed', commitError: sample.commitError ?? null };
      const facts = { toolCallId, result: { version: 1 as const, status: sample.cancelled ? 'cancelled' as const : 'failed' as const,
        error: sample.error, committedCandidateId: null }, cleanup: { version: 1 as const, stopped: true, stopReason: 'fixture', errors: [] },
        endedAt: store.at, runtimeObservation: observation };
      if (sample.rejected) expect(store.toolCalls.reject(facts).ok).toBe(true);
      else {
        expect(store.toolCalls.fixArguments({ toolCallId, finalArguments: { value: 1 } }).ok).toBe(true);
        expect(store.toolCalls.start({ toolCallId, startedAt: store.at }).ok).toBe(true);
        expect(store.toolCalls.finish({ ...facts, stoppedAt: store.at }).ok).toBe(true);
      }
    }
    const readFacts = () => store.db.query('SELECT * FROM tool_calls ORDER BY id').all();
    const persisted = readFacts();
    expect(store.db.query('SELECT tool_call_count FROM runs WHERE id=1').get()).toEqual({ tool_call_count: 24 });
    const frozen = store.executor.freezeStrategy(config);
    if (!frozen.ok) throw new Error(frozen.error.code);
    expect(frozen.data.experience.items.map(item => [item.failureStage, item.diagnosticCode, item.afterStructure, item.afterDomain, item.count]))
      .toEqual([
        ['execute', 'tool_timeout', 'not_applicable', 'not_applicable', 1],
        ['validation', 'tool_invalid_output', 'not_applicable', 'invalid', 1],
        ['validation', 'tool_invalid_output', 'invalid', 'not_applicable', 1],
        ['execute', 'tool_execution_failed', 'not_applicable', 'not_applicable', 2],
        ['execute', 'source_invalid', 'not_applicable', 'not_applicable', 1],
        ['execute', 'tool_invalid_input', 'not_applicable', 'not_applicable', 1],
        ['before', 'input_invalid', 'not_applicable', 'not_applicable', 1],
        ['sdk_arguments', 'tool_invalid_input', 'not_applicable', 'not_applicable', 1],
      ]);
    expect(readFacts()).toEqual(persisted);
    expect(store.db.query('SELECT tool_call_count FROM runs WHERE id=1').get()).toEqual({ tool_call_count: 24 });
  });
  it('freezes nearest-rank P95 from the last 200 started attempts before selecting eligible samples', () => {
    const store = makeRuntime(['read_fixture', 'write_fixture', 'read']);
    const config = { allowedTools: ['read_fixture'], configuredToolTimeoutMs: 60_000,
      sdk: { codingAgent: '0.85.1', ai: '0.85.1' }, environment: 'fixture', sampleSource: 'test' as const,
      taskType: 'answer', modelKey: 'fixture-model', promptVersion: 'fixture-prompt' };
    const initial = store.executor.freezeStrategy(config);
    expect(initial.ok).toBe(true);
    if (!initial.ok) throw new Error(initial.error.code);
    const groupKey = initial.data.calibration.groups[0]!.groupKey;
    let next = 0;
    const record = (success: boolean, durationMs: number, timeout = false, truncated = false,
      toolName = 'read_fixture', effect: ToolEffect = 'READ', key = groupKey) => {
      const requested = store.toolCalls.request({ context: null, runId: 1, sessionId: store.sessionId, nativeToolCallId: `sample-${next++}`,
        toolName, toolVersion: '1', effect, rawArguments: {}, requestedAt: store.at });
      if (!requested.ok) throw new Error(requested.error.code);
      store.toolCalls.fixArguments({ toolCallId: requested.data.toolCallId, finalArguments: {} });
      store.toolCalls.start({ toolCallId: requested.data.toolCallId, startedAt: store.at });
      const finished = store.toolCalls.finish({ toolCallId: requested.data.toolCallId,
        result: success ? { version: 1, status: 'succeeded', data: {}, committedCandidateId: null }
          : { version: 1, status: 'failed', error: appError(timeout ? 'tool_timeout' : 'tool_execution_failed', 'tool', 'Fixture failure.'), committedCandidateId: null },
        cleanup: { version: 1, stopped: true, stopReason: 'settled', errors: [] }, endedAt: store.at, stoppedAt: store.at,
        runtimeObservation: { version: 1, groupKey: key, strategyVersion: 'runtime-v1', sampleSource: 'test', beforeOutcome: 'allowed',
          failureStage: success ? null : 'execute', diagnosticCode: success ? null : timeout ? 'tool_timeout' : 'tool_execution_failed',
          afterStructure: 'valid', afterDomain: 'not_applicable', executionDurationMs: durationMs, timingComplete: true,
          effectiveTimeoutMs: 60_000, timeoutSource: 'configured', runDeadlineTruncated: truncated, commit: 'none_confirmed', commitError: null } });
      expect(finished.ok).toBe(true);
    };
    for (let i = 1; i <= 21; i++) record(true, i * 1000);
    const calibrated = store.executor.freezeStrategy(config);
    expect(calibrated).toMatchObject({ ok: true, data: { calibration: { groups: [{ attemptCount: 21, eligibleCount: 21,
      p95Ms: 20_000, selectedTimeoutMs: 30_000, timeoutSource: 'statistical', fallbackReason: null }] } } });
    expect(store.executor.freezeStrategy({ ...config, configuredToolTimeoutMs: 500 })).toMatchObject({ ok: true,
      data: { calibration: { groups: [{ selectedTimeoutMs: 500 }] } } });
    if (!calibrated.ok) throw new Error(calibrated.error.code);
    const cutoff = calibrated.data.calibration.sourceCutoffToolCallId;
    record(true, 500, false, true);
    expect(store.executor.freezeStrategy(config)).toMatchObject({ ok: true, data: { calibration: { groups: [{
      attemptCount: 22, eligibleCount: 21, p95Ms: null, selectedTimeoutMs: 60_000,
      timeoutSource: 'configured', fallbackReason: 'recent_risk',
    }] } } });
    const fixedWindow = store.toolCalls.recentStarted({ groupKey, cutoff });
    const fixedExperience = store.toolCalls.recentObservations({ groupKey, cutoff });
    expect(fixedWindow.ok && fixedWindow.data.length).toBe(21);
    expect(fixedWindow.ok && fixedWindow.data.every(call => call.toolCallId <= cutoff && !call.runtimeObservation?.runDeadlineTruncated)).toBe(true);
    expect(fixedExperience.ok && fixedExperience.data.length).toBe(21);
    expect(fixedExperience.ok && fixedExperience.data.every(call => call.toolCallId <= cutoff)).toBe(true);
    expect(calibrated.data.calibration.groups[0]).toMatchObject({ attemptCount: 21, eligibleCount: 21,
      p95Ms: 20_000, selectedTimeoutMs: 30_000, timeoutSource: 'statistical', fallbackReason: null });
    const unreadable = createToolExecutor({ definitions: store.executor.listTools(), now: () => store.at,
      recorder: createToolRecorder({ ...store.toolCalls, recentStarted: () => ({ ok: false,
        error: appError('storage_corrupt', 'storage', 'Statistics could not be read.') }) }, () => store.at) });
    expect(unreadable.freezeStrategy(config)).toMatchObject({ ok: true, data: { calibration: { groups: [{
      attemptCount: 0, eligibleCount: 0, p95Ms: null, selectedTimeoutMs: 60_000,
      timeoutSource: 'configured', fallbackReason: 'read_failed',
    }] } } });
    for (const [name, effect] of [['write_fixture', 'LOCAL_WRITE'], ['read', 'READ']] as const) {
      const excluded = createToolExecutor({ definitions: [{ ...store.executor.listTools().find(tool => tool.name === name)!, effect }],
        now: () => store.at, recorder: createToolRecorder(store.toolCalls, () => store.at) });
      const excludedConfig = { ...config, allowedTools: [name] };
      const excludedStrategy = excluded.freezeStrategy(excludedConfig);
      if (!excludedStrategy.ok) throw new Error(excludedStrategy.error.code);
      const excludedKey = excludedStrategy.data.calibration.groups[0]!.groupKey;
      for (let i = 1; i <= 21; i++) record(true, i * 1000, false, false, name, effect, excludedKey);
      expect(excluded.freezeStrategy(excludedConfig)).toMatchObject({ ok: true, data: { calibration: { groups: [{
        toolName: name, attemptCount: 21, eligibleCount: 21, p95Ms: null, selectedTimeoutMs: 60_000,
        timeoutSource: 'configured', fallbackReason: 'ineligible_tool',
      }] } } });
    }
    store.db.query('UPDATE runs SET config_json=? WHERE id=1').run(JSON.stringify({ runtimeStrategy: initial.data }));
    const crashed = store.toolCalls.request({ context: null, runId: 1, sessionId: store.sessionId, nativeToolCallId: 'crash-without-observation',
      toolName: 'read_fixture', toolVersion: '1', effect: 'READ', rawArguments: {}, requestedAt: store.at });
    if (!crashed.ok) throw new Error(crashed.error.code);
    store.toolCalls.fixArguments({ toolCallId: crashed.data.toolCallId, finalArguments: {} });
    store.toolCalls.start({ toolCallId: crashed.data.toolCallId, startedAt: store.at });
    expect(store.executor.freezeStrategy(config)).toMatchObject({ ok: true, data: { calibration: { groups: [{
      attemptCount: 23, eligibleCount: 21, fallbackReason: 'recent_risk', selectedTimeoutMs: 60_000,
    }] } } });
    record(false, 60_000, true);
    expect(store.executor.freezeStrategy(config)).toMatchObject({ ok: true, data: { calibration: { groups: [{
      selectedTimeoutMs: 60_000, timeoutSource: 'configured', fallbackReason: 'recent_risk',
    }] } } });
    for (let i = 0; i < 200; i++) record(false, 10);
    expect(store.executor.freezeStrategy(config)).toMatchObject({ ok: true, data: { calibration: { groups: [{
      attemptCount: 200, eligibleCount: 0, p95Ms: null, fallbackReason: 'insufficient_samples',
    }] } } });
    expect(calibrated.ok && calibrated.data.calibration.groups[0]?.attemptCount).toBe(21);
  });
  it('rejects an expired Host deadline without invoking the business tool or inventing execution timing', async () => {
    const store = makeRuntime(['read_fixture']);
    let executions = 0;
    const executor = createToolExecutor({ definitions: [{ ...store.executor.listTools()[0]!, execute: async () => {
      executions++; return { value: 1 };
    } }], recorder: createToolRecorder(store.toolCalls, () => store.at), now: () => store.at, monotonicNow: () => 100 });
    expect(executor.observeRequest('read_fixture', { value: '1' }, store.context('expired'))).toMatchObject({
      ok: true, data: { args: { raw: { value: '1' }, final: null } },
    });
    executor.setRunDeadline(1, 100);
    const result = await executor.execute('read_fixture', { value: 1 }, store.context('expired'), { value: '1' });
    expect(executions).toBe(0);
    expect(result).toMatchObject({ call: { startedAt: null, args: { final: { value: 1 } }, runtimeObservation: {
      beforeOutcome: 'rejected', failureStage: 'before', diagnosticCode: 'agent_timeout',
      executionDurationMs: null, timingComplete: false, afterStructure: 'not_applicable', afterDomain: 'not_applicable',
    } }, result: { status: 'failed', error: { code: 'agent_timeout' } } });
  });

  it('persists the SDK refusal phase and exposes a pure query that reports a running call immediately', async () => {
    const store = makeRuntime(['read_fixture']);
    expect(store.executor.rejectRequest('read_fixture', { value: 'bad' }, store.context('sdk-refusal'),
      appError('tool_invalid_input', 'tool', 'SDK schema rejected.'), 'sdk_arguments').ok).toBe(true);
    expect(store.executor.queryCall(store.context('sdk-refusal'), 'sdk-refusal')).toMatchObject({ ok: true, data: {
      startedAt: null, runtimeObservation: { beforeOutcome: 'rejected', failureStage: 'sdk_arguments', executionDurationMs: null },
    } });
    let release!: () => void;
    const barrier = new Promise<void>(resolve => { release = resolve; });
    const executor = createToolExecutor({ definitions: [{ ...store.executor.listTools()[0]!, execute: async () => {
      await barrier; return { value: 1 };
    } }], recorder: createToolRecorder(store.toolCalls, () => store.at), now: () => store.at });
    const running = executor.execute('read_fixture', { value: 1 }, store.context('inflight'));
    expect(executor.queryCall(store.context('inflight'), 'inflight')).toMatchObject({ ok: true, data: { status: 'running', result: null } });
    release();
    expect((await running).call.runtimeObservation).toMatchObject({ beforeOutcome: 'allowed', timingComplete: true, afterStructure: 'valid' });
  });

  it('does not believe a forged candidate ID and distinguishes an unverified commit from no commit', async () => {
    const store = makeRuntime(['save_invoice_candidate']);
    const definition = { ...store.executor.listTools()[0]!, effect: 'LOCAL_WRITE' as const,
      outputSchema: z.object({ candidateId: z.number().int().positive() }).strict(), execute: async () => ({ candidateId: 123 }) };
    const executor = createToolExecutor({ definitions: [definition], recorder: createToolRecorder(store.toolCalls, () => store.at), now: () => store.at });
    expect(await executor.execute('save_invoice_candidate', { value: 1 }, store.context('forged-commit'))).toMatchObject({
      result: { status: 'failed', error: { code: 'tool_invalid_output' } }, fatal: true,
      call: { result: { committedCandidateId: null }, runtimeObservation: { commit: 'none_confirmed', afterDomain: 'invalid', failureStage: 'validation' } },
    });
    const recorder = createToolRecorder({ ...store.toolCalls, queryCandidateCommit: () => ({ ok: false,
      error: appError('storage_corrupt', 'storage', 'Commit query unavailable.') }) }, () => store.at);
    const unverified = createToolExecutor({ definitions: [definition], recorder, now: () => store.at });
    expect(await unverified.execute('save_invoice_candidate', { value: 1 }, store.context('unknown-commit'))).toMatchObject({
      fatal: true, call: { runtimeObservation: { commit: 'unknown', commitError: { code: 'storage_corrupt' }, failureStage: 'commit', afterDomain: 'unknown' } },
    });
  });
  it('does not treat a referenced candidate in a read result as a newly committed candidate', async () => {
    const store = makeRuntime(['get_invoice_candidate']);
    const definition: ToolDefinition<{ value: number }, { candidateId: number }> = {
      ...store.executor.listTools()[0]!, outputSchema: z.object({ candidateId: z.number().int().positive() }).strict(),
      execute: async () => ({ candidateId: 123 }),
    };
    const executor = createToolExecutor({ definitions: [definition],
      recorder: createToolRecorder(store.toolCalls, () => store.at), now: () => store.at });
    const executed = await executor.execute('get_invoice_candidate', { value: 1 }, store.context('read-candidate'));
    expect(executed).toMatchObject({ fatal: false, call: { status: 'succeeded',
      result: { status: 'succeeded', committedCandidateId: null } },
      result: { status: 'succeeded', data: { candidateId: 123 } } });
    expect(executor.candidateFacts(1)).toMatchObject({ ok: true, data: { candidateIds: [], deliveredCandidateIds: [] } });
  });

  it('preserves the observed raw request while validating final arguments and deduplicating its execution', async () => {
    const store = makeRuntime(['read_fixture']);
    let executions = 0;
    let release!: () => void;
    const barrier = new Promise<void>(resolve => { release = resolve; });
    const definition = store.executor.listTools()[0]!;
    const executor = createToolExecutor({ definitions: [{ ...definition, execute: async ({ value }) => {
      executions += 1; await barrier; return { value };
    } }], recorder: createToolRecorder(store.toolCalls, () => store.at), now: () => store.at });
    const raw = { value: '2', optional: null };
    const final = { value: 2 };
    const context = store.context('normalized-call');
    expect(executor.observeRequest('read_fixture', raw, context).ok).toBe(true);
    const pending = executor.execute('read_fixture', final, context, raw);
    const duplicate = executor.execute('read_fixture', final, context, raw);
    const activeInvalid = executor.execute('read_fixture', { value: '2' }, context, raw);
    const activeConflict = executor.execute('read_fixture', { value: 3 }, context, raw);
    release();
    const executed = await pending;
    expect(executed).toMatchObject({ call: { status: 'succeeded', args: { raw, final } },
      result: { status: 'succeeded', data: final } });
    expect((await duplicate).result).toEqual(executed.result);
    expect(await activeInvalid).toMatchObject({ result: { status: 'failed', error: { code: 'tool_invalid_input' } } });
    expect(await activeConflict).toMatchObject({ result: { status: 'failed', error: { code: 'state_conflict' } }, fatal: true });
    expect((await executor.execute('read_fixture', final, context, raw)).result).toEqual(executed.call.result!);
    expect(executions).toBe(1);
    expect(store.db.query('SELECT tool_call_count FROM runs WHERE id=1').get()).toEqual({ tool_call_count: 1 });
    expect(await executor.execute('read_fixture', { value: '2' }, context, raw))
      .toMatchObject({ result: { status: 'failed', error: { code: 'tool_invalid_input' } } });
    expect(await executor.execute('read_fixture', { value: 3 }, context, raw))
      .toMatchObject({ result: { status: 'failed', error: { code: 'state_conflict' } }, fatal: true });
    expect(executions).toBe(1);
    expect(await executor.execute('read_fixture', final, context, { value: '3' }))
      .toMatchObject({ result: { status: 'failed', error: { code: 'state_conflict' } }, fatal: true });
    expect(executions).toBe(1);
    expect(store.toolCalls.get({ runId: context.runId, sessionId: context.sessionId, nativeToolCallId: context.nativeToolCallId }))
      .toEqual({ ok: true, data: executed.call });
    expect(store.db.query('SELECT tool_call_count FROM runs WHERE id=1').get()).toEqual({ tool_call_count: 1 });
  });

  it('preserves SDK-sized native input/output and never repeats a write after its terminal record fails', async () => {
    const store = makeRuntime(['write']);
    let executions = 0;
    const raw = { path: 'note.txt', content: 'x'.repeat(300_000) };
    const output = { content: [{ type: 'text' as const, text: raw.content }], details: { fullOutputPath: 'SDK-output.log', truncated: false } };
    const definition: ToolDefinition<any, any> = { name: 'write', version: '0.85.1', description: 'Native contract fixture',
      effect: 'LOCAL_WRITE', executionMode: 'sequential', inputSchema: z.object({ path: z.string(), content: z.string() }).strict(),
      outputSchema: NativeToolOutputSchema, execute: async () => { executions += 1; return output; } };
    const executor = createToolExecutor({ definitions: [definition], recorder: createToolRecorder(store.toolCalls, () => store.at), now: () => store.at });
    const first = await executor.execute('write', raw, store.context('native-large'));
    expect(first).toMatchObject({ result: { status: 'succeeded', data: output }, fatal: false });
    expect(first.call.args.final).toEqual(raw);
    expect((await executor.execute('write', raw, store.context('native-large'))).result).toEqual(first.call.result!);
    expect(executions).toBe(1);
    store.db.exec(`CREATE TRIGGER fail_native_terminal BEFORE UPDATE OF status ON tool_calls
      WHEN NEW.status='succeeded' BEGIN SELECT RAISE(ABORT,'fixture storage failure'); END;`);
    expect(await executor.execute('write', raw, store.context('native-store-failed'))).toMatchObject({
      result: { status: 'failed', error: { code: 'storage_write_failed' }, data: output }, fatal: true,
    });
    await executor.execute('write', raw, store.context('native-store-failed'));
    expect(executions).toBe(2);
  });
  it('preserves schema-checked native failure output and leaves an unconfirmed stop fatal', async () => {
    const store = makeRuntime(['read_fixture']);
    const definition = store.executor.listTools()[0]!;
    const executor = createToolExecutor({ definitions: [{ ...definition, execute: async () => {
      throw new ToolExecutionFailure(appError('tool_execution_failed', 'tool', 'The process exited with code 7.'), { value: 7 });
    } }], recorder: createToolRecorder(store.toolCalls, () => store.at), now: () => store.at });
    expect(await executor.execute('read_fixture', { value: 1 }, store.context('native-failed'))).toMatchObject({
      result: { status: 'failed', error: { code: 'tool_execution_failed', message: 'The process exited with code 7.' }, data: { value: 7 } }, fatal: false,
    });
    const unsafe = createToolExecutor({ definitions: [{ ...definition, execute: async () => {
      throw new ToolExecutionFailure(appError('stop_not_confirmed', 'runtime', 'The owned process is not confirmed stopped.'));
    } }], recorder: createToolRecorder(store.toolCalls, () => store.at), now: () => store.at });
    expect(await unsafe.execute('read_fixture', { value: 1 }, store.context('native-unknown'))).toMatchObject({
      result: { status: 'failed', error: { code: 'stop_not_confirmed' } }, fatal: true, call: { cleanup: { stopped: false },
        runtimeObservation: { timingComplete: false, commit: 'unknown', commitError: { code: 'stop_not_confirmed' } } },
    });
  });
  it('validates and freezes the assembled definition list', () => {
    const store = makeRuntime(['read_fixture']);
    const definition = store.executor.listTools()[0]!;
    const recorder = createToolRecorder(store.toolCalls, () => store.at);
    const assemble = (definitions: ToolDefinition<any, any>[]) => createToolExecutor({ definitions, recorder, now: () => store.at });
    expect(() => assemble([definition, definition])).toThrow('tool_name_duplicate');
    expect(() => assemble([{ ...definition, version: '' }])).toThrow('tool_definition_invalid');
    expect(() => assemble([{ ...definition, execute: undefined as never }])).toThrow('tool_definition_invalid');
    expect(Object.isFrozen(store.executor.listTools())).toBe(true);
    expect(Object.isFrozen(definition)).toBe(true);
  });

  it('validates before business execution, scopes names, records once, and returns the original result for duplicate IDs', async () => {
    let executions = 0;
    const store = makeRuntime(['read_fixture']);
    const definition = store.executor.listTools()[0]!;
    const definitions: ToolDefinition<any, any>[] = [{ ...definition, execute: async ({ value }) => { executions += 1; return { value }; } }];
    const executor = createToolExecutor({ definitions, recorder: createToolRecorder(store.toolCalls, () => store.at), now: () => store.at });
    const input = { value: 4 };
    const first = await executor.execute('read_fixture', input, store.context('call-1'));
    const duplicate = await executor.execute('read_fixture', input, store.context('call-1'));
    expect(first).toMatchObject({ result: { status: 'succeeded', data: input }, fatal: false });
    if (!first.call.result) throw new Error('missing_tool_result_fact');
    expect(duplicate.result).toEqual(first.call.result);
    expect(executions).toBe(1);
    expect(store.db.query('SELECT tool_call_count FROM runs WHERE id=1').get()).toEqual({ tool_call_count: 1 });
    await expect(executor.execute('read_fixture', { value: '4' }, store.context('invalid-args')))
      .resolves.toMatchObject({ result: { status: 'failed', error: { code: 'tool_invalid_input' } }, fatal: false });
    const forbiddenContext = { ...store.context('forbidden'), scope: { ...store.context('forbidden').scope, allowedTools: [] } };
    await expect(executor.execute('read_fixture', input, forbiddenContext)).resolves.toMatchObject({
      result: { status: 'failed', error: { code: 'tool_access_denied' } }, fatal: false,
    });
    expect(executions).toBe(1);
    expect(store.db.query("SELECT COUNT(*) AS count FROM tool_calls WHERE status='failed'").get()).toEqual({ count: 2 });
  });

  it('allows concurrent independent calls, preserves call identity, and enforces one shared count budget', async () => {
    const store = makeRuntime(['read_fixture'], { maxToolCalls: 2 });
    let active = 0;
    let maximum = 0;
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => { release = resolve; });
    const definition = store.executor.listTools()[0]!;
    const definitions: ToolDefinition<any, any>[] = [{ ...definition, execute: async ({ value }, call, context) => {
      active += 1;
      maximum = Math.max(maximum, active);
      await barrier;
      active -= 1;
      return { value, callId: call.nativeToolCallId, runId: context.runId };
    }, outputSchema: z.object({ value: z.number().int(), callId: z.string(), runId: z.number().int() }).strict() }];
    const executor = createToolExecutor({ definitions, recorder: createToolRecorder(store.toolCalls, () => store.at), now: () => store.at,
      maxToolCalls: 2 });
    const left = executor.execute('read_fixture', { value: 1 }, store.context('call-left'));
    const right = executor.execute('read_fixture', { value: 2 }, store.context('call-right'));
    await Promise.resolve();
    await Promise.resolve();
    release();
    const [a, b] = await Promise.all([left, right]);
    expect(maximum).toBe(2);
    expect(a.result).toMatchObject({ status: 'succeeded', data: { value: 1, callId: 'call-left', runId: 1 } });
    expect(b.result).toMatchObject({ status: 'succeeded', data: { value: 2, callId: 'call-right', runId: 1 } });
    const overBudget = await executor.execute('read_fixture', { value: 3 }, store.context('call-over-budget'));
    expect(overBudget).toMatchObject({ fatal: true, result: { status: 'failed', error: { code: 'tool_budget_exceeded' } } });
    expect(store.db.query('SELECT tool_call_count FROM runs WHERE id=1').get()).toEqual({ tool_call_count: 2 });
    expect(store.db.query('SELECT COUNT(*) AS count FROM tool_calls').get()).toEqual({ count: 2 });
  });

  it('waits for ignored cancellation to actually settle before returning a terminal record', async () => {
    const store = makeRuntime(['read_fixture']);
    const base = store.executor.listTools()[0]!;
    let started!: () => void;
    let release!: () => void;
    const didStart = new Promise<void>((resolve) => { started = resolve; });
    const work = new Promise<{ value: number }>((resolve) => { release = () => resolve({ value: 9 }); });
    const definitions: ToolDefinition<any, any>[] = [{ ...base, execute: async () => { started(); return work; } }];
    const executor = createToolExecutor({ definitions, recorder: createToolRecorder(store.toolCalls, () => store.at), now: () => store.at });
    const controller = new AbortController();
    let settled = false;
    const execution = executor.execute('read_fixture', { value: 1 }, store.context('call-cancel', controller.signal)).finally(() => { settled = true; });
    await didStart;
    controller.abort();
    await Promise.resolve();
    expect(settled).toBe(false);
    release();
    await expect(execution).resolves.toMatchObject({ result: { status: 'cancelled', error: { code: 'agent_cancelled' } }, call: { status: 'cancelled', cleanup: { stopped: true } } });
  });

  it('treats an unrecordable terminal as fatal and does not replay the operation', async () => {
    let executions = 0;
    const store = makeRuntime(['read_fixture']);
    store.db.exec(`CREATE TRIGGER fail_tool_terminal BEFORE UPDATE OF status ON tool_calls
      WHEN NEW.status='succeeded' BEGIN SELECT RAISE(ABORT,'fixture storage failure'); END;`);
    const base = store.executor.listTools()[0]!;
    const definitions: ToolDefinition<any, any>[] = [{ ...base, execute: async ({ value }) => { executions += 1; return { value }; } }];
    const executor = createToolExecutor({ definitions, recorder: createToolRecorder(store.toolCalls, () => store.at), now: () => store.at });
    const result = await executor.execute('read_fixture', { value: 1 }, store.context('call-store-fail'));
    expect(result).toMatchObject({ fatal: true, result: { status: 'failed', error: { code: 'storage_write_failed' } } });
    expect(executions).toBe(1);
    expect(store.db.query("SELECT status FROM tool_calls WHERE native_tool_call_id='call-store-fail'").get()).toEqual({ status: 'running' });
  });
});
