import { describe, expect, it } from 'bun:test';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { appError, INVOICE_TOOLS_SYSTEM_PROMPT } from '@flowmate/contracts';
import type { ProductToolContext, SafeConfigSnapshot, P3AgentConfigFacts } from '@flowmate/contracts';
import { openTestDatabase } from '../../support/database.ts';
import { deferCleanup, mkdtempSync } from '../../support/resources.ts';

const stamp = '2026-10-01T00:00:00.000Z';
const usage = { version: 1 as const, source: 'unknown' as const, reason: 'offline', sdkValues: null,
  attempts: 1, attemptsComplete: true, costSource: null, updatedAt: stamp };
const cleanup = { version: 1 as const, stopped: false, stopReason: null, errors: [], lateObservationRequired: false };
const input = { version: 1 as const, goal: 'Local fixture', text: 'Read the file.', messageTimestamp: 1 };

function fixture(toolName = 'powershell') {
  const root = mkdtempSync(join(tmpdir(), 'flowmate-native-facts-'));
  const opened = openTestDatabase({ root, runtimeDir: join(root, 'runtime'), databaseFile: join(root, 'data', 'app.sqlite'),
    artifactsDir: join(root, 'artifacts'), outputsDir: join(root, 'outputs'), logsDir: join(root, 'logs') });
  if (!opened.ok) throw new Error(opened.error.message);
  const store = opened.data;
  deferCleanup(() => store.close());
  const session = store.sessions.create({ nativeSessionId: 'native-facts', title: 'Native fixture', at: stamp });
  if (!session.ok) throw new Error(session.error.message);
  const workingDirectory = join(root, 'task');
  const snapshot: SafeConfigSnapshot & { agent: P3AgentConfigFacts; goalMode: 'answer'; workingDirectory: string } = {
    version: 1, name: 'offline', revision: 1, requestedModel: { provider: 'fixture', model: 'offline' }, resolvedModel: null,
    api: null, endpoint: null, sdk: { codingAgent: '0.85.1', ai: '0.85.1' }, parameters: { maxRetries: 0, maxRetryDelayMs: 100 },
    limits: { timeoutMs: 1000, stopGraceMs: 100 }, native: { authSource: 'unknown', modelsSelection: null },
    agent: { policyVersion: 'p3-invoice-tools-v1', nativeSessionId: 'native-facts',
      systemPrompt: INVOICE_TOOLS_SYSTEM_PROMPT,
      thinkingLevel: 'off', resourcePolicy: 'none', historyPolicy: 'memory-only', maxContextBytes: 8_388_608,
      maxOutputBytes: 262_144, maxAssistantContentBytes: 524_288, maxModelCalls: 12, maxToolCalls: 24,
      toolTimeoutMs: 10_000, sessionRetry: false },
    goalMode: 'answer', workingDirectory,
  };
  const scope = { version: 2 as const, allowedTools: [toolName], allowedDocumentIds: [], allowedArtifactIds: [], allowedResourcePaths: [] };
  const accepted = store.runs.createAgent({ goal: input.goal, input, config: snapshot, usage, cleanup,
    createdAt: stamp, sessionId: session.data.sessionId, scope });
  if (!accepted.ok) throw new Error(accepted.error.message);
  const context: ProductToolContext = { runId: accepted.data, sessionId: session.data.sessionId, scope };
  expect(store.runs.start(context.runId, snapshot, stamp).ok).toBe(true);
  const requested = store.toolCalls.request({ context: null, runId: context.runId, sessionId: context.sessionId,
    nativeToolCallId: 'native-call', toolName, toolVersion: '0.85.1', effect: toolName === 'grep' ? 'READ' : 'LOCAL_WRITE',
    rawArguments: {}, requestedAt: stamp });
  if (!requested.ok) throw new Error(requested.error.message);
  const toolCallId = requested.data.toolCallId;
  expect(store.toolCalls.fixArguments({ toolCallId, finalArguments: {} }).ok).toBe(true);
  expect(store.toolCalls.start({ toolCallId, startedAt: stamp }).ok).toBe(true);
  return { store, context, toolCallId, snapshot, workingDirectory };
}

describe('native ToolCall storage facts', () => {
  it.each([12, 16, 13])('reads historical and current fixed P3 budgets without accepting arbitrary budgets: %s', modelCalls => {
    const f = fixture();
    const config = { ...f.snapshot, agent: { ...f.snapshot.agent, maxModelCalls: modelCalls } };
    f.store.db.query('UPDATE runs SET config_json=? WHERE id=?').run(JSON.stringify(config), f.context.runId);
    if (modelCalls === 13) expect(f.store.runs.get(f.context.runId)).toMatchObject({ ok: false, error: { code: 'storage_corrupt' } });
    else expect(f.store.runs.get(f.context.runId)).toMatchObject({ ok: true, data: { config: { agent: { maxModelCalls: modelCalls } } } });
    expect(f.store.db.query('SELECT config_json FROM runs WHERE id=?').get(f.context.runId)).toEqual({ config_json: JSON.stringify(config) });
  });

  it('uses the frozen ordinary Run identity and retains the SDK raw result instead of an output/process platform', () => {
    const f = fixture();
    expect(f.store.toolCalls.getNativeWorkingDirectory(f.context)).toEqual({ ok: true, data: f.workingDirectory });
    expect(f.store.toolCalls.getNativeWorkingDirectory({ ...f.context, sessionId: 999 })).toMatchObject({ ok: false });
    expect(f.store.toolCalls.getNativeWorkingDirectory({ ...f.context, scope: { ...f.context.scope, allowedTools: [] } }))
      .toMatchObject({ ok: false, error: { code: 'tool_access_denied' } });
    const data = { content: [{ type: 'text', text: 'x'.repeat(300_000) }], details: { exitCode: 1, fullOutputPath: 'C:\\SDK-output.log', truncated: true } };
    expect(f.store.toolCalls.finish({ toolCallId: f.toolCallId,
      result: { version: 1, committedCandidateId: null, status: 'failed', error: appError('tool_execution_failed', 'tool', 'The command failed.'), data },
      cleanup: { version: 1, stopped: true, stopReason: 'tool-settled', errors: [] }, endedAt: stamp, stoppedAt: stamp }))
      .toMatchObject({ ok: true, data: { result: { status: 'failed', data }, cleanup: { stopped: true } } });
    expect(f.store.toolCalls.getById(f.toolCallId)).toMatchObject({ ok: true, data: { result: { data } } });
  });

  it('preserves old v3 Run facts and optional output/process facts as read-only history', () => {
    const f = fixture();
    const oldScope = { ...f.context.scope, version: 3, allowedResourcePaths: [f.workingDirectory],
      allowedWritePaths: [f.workingDirectory], commandAccess: 'trusted-local' };
    const oldConfig = { ...f.snapshot, goalMode: 'local-task' };
    f.store.db.query('UPDATE runs SET scope_json=?,config_json=? WHERE id=?').run(JSON.stringify(oldScope), JSON.stringify(oldConfig), f.context.runId);
    f.store.db.query('UPDATE sessions SET metadata_json=? WHERE id=?').run(JSON.stringify({ version: 1, model_use_blocked: null, tool_profile: 'trusted-local' }), f.context.sessionId);
    const oldCleanup = { version: 1, stopped: false, stopReason: null, errors: [], nativeProcesses: [{
      nativeToolCallId: 'native-call', pid: 4001, identity: 'old-process', executable: 'fixture', startedAt: stamp, stopped: false,
    }], nativeOutputs: [{ nativeToolCallId: 'native-call', fileName: 'old.log', bytes: 5, observedBytes: 5, truncated: false }] };
    f.store.db.query('UPDATE tool_calls SET cleanup_json=? WHERE id=?').run(JSON.stringify(oldCleanup), f.toolCallId);
    expect(f.store.runs.get(f.context.runId)).toMatchObject({ ok: true, data: { scope: oldScope, config: oldConfig } });
    expect(f.store.sessions.get(f.context.sessionId)).toMatchObject({ ok: true, data: { title: 'Native fixture' } });
    expect(f.store.toolCalls.getById(f.toolCallId)).toMatchObject({ ok: true, data: { cleanup: oldCleanup } });
    expect(f.store.db.query('SELECT scope_json,config_json FROM runs WHERE id=?').get(f.context.runId))
      .toEqual({ scope_json: JSON.stringify(oldScope), config_json: JSON.stringify(oldConfig) });
    expect(f.store.toolCalls.getNativeWorkingDirectory(f.context)).toMatchObject({ ok: false, error: { code: 'storage_corrupt' } });
  });

  it('records interrupted calls without replay and rejects directory lookup after termination', () => {
    const f = fixture('read');
    expect(f.store.runs.failInterrupted(stamp)).toEqual({ ok: true, data: 1 });
    expect(f.store.toolCalls.getById(f.toolCallId)).toMatchObject({ ok: true, data: { status: 'failed', result: { error: { code: 'runtime_interrupted' } } } });
    expect(f.store.toolCalls.getNativeWorkingDirectory(f.context)).toMatchObject({ ok: false, error: { code: 'run_state_invalid' } });
  });
});
