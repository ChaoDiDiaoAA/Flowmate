import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'bun:test';
import { z } from 'zod';
import { appError, ToolExecutionFailure, NativeToolOutputSchema } from '@flowmate/contracts';
import type { ToolDefinition, ToolExecutionContext } from '@flowmate/contracts';
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
      result: { status: 'failed', error: { code: 'stop_not_confirmed' } }, fatal: true, call: { cleanup: { stopped: false } },
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
