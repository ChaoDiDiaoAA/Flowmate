import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'bun:test';
import { z } from 'zod';
import type { ToolDefinition, ToolExecutionContext } from '@flowmate/contracts';
import { deferCleanup } from '../../support/resources.ts';
import { openDatabase } from '../../../packages/core/src/storage/database.ts';
import { createToolExecutor } from '../../../packages/core/src/tools/executor.ts';
import { createToolRecorder } from '../../../packages/core/src/tools/recorder.ts';
import { ToolRegistry } from '../../../packages/core/src/tools/registry.ts';

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
  const registry = new ToolRegistry(definitions);
  const recorder = createToolRecorder(opened.data.toolCalls, () => at);
  const executor = createToolExecutor({ registry, recorder, now: () => at, ...options });
  const context = (nativeToolCallId: string, signal = new AbortController().signal): ToolExecutionContext => ({
    runId: 1, sessionId: session.data.sessionId, nativeToolCallId, scope, signal,
  });
  return { ...opened.data, executor, context, sessionId: session.data.sessionId, at };
}

describe('P3 Tool Executor', () => {
  it('validates before business execution, scopes names, records once, and returns the original result for duplicate IDs', async () => {
    let executions = 0;
    const store = makeRuntime(['read_fixture']);
    const definition = store.executor.listTools()[0]!;
    const registry = new ToolRegistry([{ ...definition, execute: async ({ value }) => { executions += 1; return { value }; } }]);
    const executor = createToolExecutor({ registry, recorder: createToolRecorder(store.toolCalls, () => store.at), now: () => store.at });
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
    const registry = new ToolRegistry([{ ...definition, execute: async ({ value }, call, context) => {
      active += 1;
      maximum = Math.max(maximum, active);
      await barrier;
      active -= 1;
      return { value, callId: call.nativeToolCallId, runId: context.runId };
    }, outputSchema: z.object({ value: z.number().int(), callId: z.string(), runId: z.number().int() }).strict() }]);
    const executor = createToolExecutor({ registry, recorder: createToolRecorder(store.toolCalls, () => store.at), now: () => store.at,
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
    const registry = new ToolRegistry([{ ...base, execute: async () => { started(); return work; } }]);
    const executor = createToolExecutor({ registry, recorder: createToolRecorder(store.toolCalls, () => store.at), now: () => store.at });
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
    const registry = new ToolRegistry([{ ...base, execute: async ({ value }) => { executions += 1; return { value }; } }]);
    const executor = createToolExecutor({ registry, recorder: createToolRecorder(store.toolCalls, () => store.at), now: () => store.at });
    const result = await executor.execute('read_fixture', { value: 1 }, store.context('call-store-fail'));
    expect(result).toMatchObject({ fatal: true, result: { status: 'failed', error: { code: 'storage_write_failed' } } });
    expect(executions).toBe(1);
    expect(store.db.query("SELECT status FROM tool_calls WHERE native_tool_call_id='call-store-fail'").get()).toEqual({ status: 'running' });
  });
});
