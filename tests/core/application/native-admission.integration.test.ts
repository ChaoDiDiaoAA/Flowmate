import { describe, expect, it } from 'bun:test';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdirSync, realpathSync } from 'node:fs';
import { appError, ok, INVOICE_CHAT_SYSTEM_PROMPT, INVOICE_TOOLS_SYSTEM_PROMPT, ToolExecutionFailure } from '@flowmate/contracts';
import type { AgentPort, AgentExecutionInput, ProviderConfig, AgentRunEvent } from '@flowmate/contracts';
import { createToolExecutor, createToolRecorder, makeApplication, RuntimeService, SessionService, createWorkspaceService } from '@flowmate/core';
import { z } from 'zod';
import { openTestDatabase } from '../../support/database.ts';
import { mkdtempSync } from '../../support/resources.ts';
import { createAgentHistoryFixture } from './agent-history-fixture.ts';

const config: ProviderConfig = { version: 1, name: 'offline', revision: 1,
  modelRef: { provider: 'fixture', model: 'offline' }, native: { authPath: 'C:\\fixture\\auth.json', modelsPath: null },
  connection: { baseUrl: 'https://fixture.invalid/v1', api: 'openai-completions' },
  parameters: { maxRetries: 0, maxRetryDelayMs: 100 } };

function harness(options: { unconfirmedTool?: boolean; conflictingSnapshot?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'flowmate-local-admission-'));
  const runtimeDir = join(root, 'runtime');
  const workingDirectory = join(root, 'task');
  mkdirSync(runtimeDir); mkdirSync(workingDirectory);
  const opened = openTestDatabase({ root, runtimeDir, databaseFile: join(root, 'data', 'app.sqlite'),
    artifactsDir: join(root, 'artifacts'), outputsDir: join(root, 'outputs'), logsDir: join(root, 'logs') });
  if (!opened.ok) throw new Error(opened.error.message);
  const db = opened.data;
  const now = () => new Date().toISOString();
  let nativeId = 0;
  const executions: AgentExecutionInput[] = [];
  const preparations: Array<Parameters<AgentPort['prepare']>[4]> = [];
  const history = createAgentHistoryFixture(runtimeDir, now);
  const agent: AgentPort = {
    createSession: () => { const nativeSessionId = `native-local-${++nativeId}`; history.create(nativeSessionId); return ok({ nativeSessionId }); },
    exportSession: history.exportSession,
    watchSession: history.watchSession,
    inspect: () => ({ availability: 'ready' }),
    prepare: async (nativeSessionId, selected, limits, _signal, settings) => { preparations.push(settings); return ok({ snapshot: {
      version: 1, name: selected.name, revision: selected.revision,
      requestedModel: selected.modelRef, resolvedModel: selected.modelRef, api: selected.connection?.api ?? null,
      endpoint: selected.connection?.baseUrl ?? null, sdk: { codingAgent: '0.85.1', ai: '0.85.1' },
      parameters: selected.parameters, limits, native: { authSource: 'pi-native', modelsSelection: null },
      agent: settings?.activeToolNames === undefined ? { policyVersion: 'p5-session-inputs-v1', nativeSessionId,
        systemPrompt: INVOICE_CHAT_SYSTEM_PROMPT, thinkingLevel: 'off', resourcePolicy: 'none', historyPolicy: 'memory-only',
        maxContextBytes: 524_288, maxOutputBytes: 262_144, maxAssistantContentBytes: 524_288, maxModelCalls: 12, sessionRetry: false }
        : { policyVersion: 'p3-invoice-tools-v1', nativeSessionId, systemPrompt: INVOICE_TOOLS_SYSTEM_PROMPT,
        thinkingLevel: 'off', resourcePolicy: 'none', historyPolicy: 'memory-only', maxContextBytes: 8_388_608,
        maxOutputBytes: 262_144, maxAssistantContentBytes: 524_288, maxModelCalls: 16, maxToolCalls: 24,
        toolTimeoutMs: 10_000, sessionRetry: false },
      ...(options.conflictingSnapshot ? { workingDirectory: runtimeDir, goalMode: 'save-candidate',
        workspaceContext: { formatVersion: 1, revision: 999, sessionId: 999, documentRef: null,
          jobId: null, candidateRef: null, activeView: 'original', selection: null } } : {}),
    }, execute: async (input, signal) => {
      executions.push(input);
      history.saveUser(nativeSessionId, input);
      if (options.unconfirmedTool) await input.toolBinding?.execute('powershell', {}, { nativeToolCallId: 'unconfirmed-process', signal });
      const outcome = { text: 'Done.', partial: false, stopReason: 'stop', responseId: null, responseModel: null,
        error: null, stopped: true, cleanupErrors: [], usage: { version: 1, source: 'unknown', reason: 'offline',
          sdkValues: null, attempts: 1, attemptsComplete: true, costSource: null, updatedAt: now() } as const,
        tokens: { inputTokens: null, outputTokens: null, totalTokens: null, cost: null, usageComplete: false },
        agent: { nativeSessionId, turnCount: 1, modelCallCount: 1 } };
      history.saveResult(nativeSessionId, input, outcome);
      return outcome;
    } }); },
    releaseSession: async () => ({ stopped: true, closed: true, errors: [] }),
    close: async () => ({ stopped: true, closed: true, errors: [] }),
  };
  const tools = createToolExecutor({ definitions: ['read', 'powershell'].map((name) => ({ name, version: '0.85.1',
    description: 'Offline admission fixture.', effect: name === 'read' ? 'READ' as const : 'LOCAL_WRITE' as const,
    executionMode: name === 'read' ? 'parallel' as const : 'sequential' as const,
    inputSchema: z.object({}).strict(), outputSchema: z.object({}).strict(), execute: async () => {
      if (options.unconfirmedTool && name === 'powershell') throw new ToolExecutionFailure(appError('stop_not_confirmed', 'runtime', 'Process termination was not confirmed.'), {});
      return {};
    } })),
    recorder: createToolRecorder(db.toolCalls, now), now });
  const runtime = new RuntimeService({ runs: db.runs, sessions: db.sessions, sessionInputs: db.sessionInputs, agent, tools,
    provider: { prepare: async () => ({ ok: false, error: appError('unused', 'provider', 'Unused.') }),
      close: async () => ({ stopped: true, closed: true, errors: [] }) },
    log: { write() {}, close: async () => {} }, now, monotonicNow: () => performance.now(),
    nativeTools: { runtimeDir, availability: [{ name: 'read', available: true, reason: null },
      { name: 'powershell', available: true, reason: null }, { name: 'bash', available: false, reason: 'Not installed.' }],
 },
  });
  const sessions = new SessionService(db.sessions, agent, () => runtime.state(), now, db.runs,
    db.sessionInputs, (request, submission, control) => runtime.start(request, control, submission));
  const app = makeApplication(runtime, db.runs, async () => {
    db.close(); return { stopped: true, closed: true, errors: [] };
  }, sessions, undefined, createWorkspaceService(db.workspace, now));
  return { app, store: db, db: db.db, executions, preparations, workingDirectory, runtimeDir };
}

async function context(app: ReturnType<typeof harness>['app']) {
  const before = await app.readWorkspace();
  if (!before.ok) throw new Error(before.error.code);
  const created = await app.createSession({ title: 'Ordinary chat', expectedRevision: before.data.revision });
  if (!created.ok) throw new Error(created.error.code);
  const current = await app.readWorkspace();
  if (!current.ok) throw new Error(current.error.code);
  const sessionId = created.data.sessionId;
  return { sessionId, workspace: { revision: current.data.revision, sessionId,
    documentRef: current.data.documentRef, jobId: current.data.jobId, candidateRef: current.data.candidateRef } };
}

async function run(app: ReturnType<typeof harness>['app'], request: Parameters<typeof app.startRun>[0]) {
  let resolve!: (event: AgentRunEvent) => void;
  const done = new Promise<AgentRunEvent>(finish => { resolve = finish; });
  const accepted = await app.startRun(request, { onEvent: event => { if (event.type === 'run_finished') resolve(event); } });
  if (!accepted.ok) throw new Error(accepted.error.code);
  return done;
}

describe('ordinary native tool Run admission', () => {
  it('keeps the frozen directory, goal and workspace when SDK preparation returns conflicting extensions', async () => {
    const { app, db, workingDirectory, executions } = harness({ conflictingSnapshot: true });
    try {
      const current = await context(app);
      const event = await run(app, { ...current, text: 'Keep this context.', config, goalMode: 'answer', workingDirectory });
      expect(event).toMatchObject({ type: 'run_finished', result: { ok: true, data: { status: 'completed' } } });
      const row = db.query('SELECT config_json FROM runs').get() as { config_json: string };
      expect(JSON.parse(row.config_json)).toMatchObject({ goalMode: 'answer', workingDirectory: realpathSync(workingDirectory),
        workspaceContext: { revision: current.workspace.revision, sessionId: current.sessionId } });
      expect(executions[0]).toMatchObject({ goalMode: 'answer', workingDirectory: realpathSync(workingDirectory) });
    } finally { await app.close(); }
  });

  it('freezes the ordinary Run directory and platform tools without new permissions or a special Session', async () => {
    const { app, db, workingDirectory, executions, preparations } = harness();
    try {
      const current = await context(app);
      const before = await app.readWorkspace();
      const event = await run(app, { ...current, text: 'Read a file.', config, goalMode: 'answer', workingDirectory });
      expect(event).toMatchObject({ type: 'run_finished', result: { ok: true, data: { status: 'completed' } } });
      const row = db.query('SELECT scope_json,config_json,job_id FROM runs').get() as { scope_json: string; config_json: string; job_id: number | null };
      expect(row.job_id).toBeNull();
      expect(JSON.parse(row.scope_json)).toEqual({ version: 2, allowedTools: ['normalize_invoice_values', 'calculate_invoice_amounts', 'read', 'powershell'],
        allowedDocumentIds: [], allowedArtifactIds: [], allowedResourcePaths: [] });
      expect(JSON.parse(row.config_json)).toMatchObject({ goalMode: 'answer', workingDirectory: realpathSync(workingDirectory) });
      expect(JSON.parse(row.config_json).agent.systemPrompt).toBe(INVOICE_TOOLS_SYSTEM_PROMPT);
      expect(preparations[0]).toMatchObject({ goalMode: 'answer', workingDirectory: realpathSync(workingDirectory),
        activeToolNames: ['normalize_invoice_values', 'calculate_invoice_amounts', 'read', 'powershell'] });
      expect(executions[0]).toMatchObject({ goalMode: 'answer', workingDirectory: realpathSync(workingDirectory) });
      expect(await app.readWorkspace()).toEqual(before);
      expect(db.query('SELECT * FROM jobs').all()).toHaveLength(0);
      expect(db.query('SELECT metadata_json FROM sessions').get()).toEqual({ metadata_json: '{"version":1,"model_use_blocked":null}' });
    } finally { await app.close(); }
  });

  it('uses runtime/<runId>/work by default and preserves the earlier no-workspace P2 path without tools', async () => {
    const { app, db, runtimeDir, executions, preparations } = harness();
    try {
      const current = await context(app);
      const event = await run(app, { ...current, text: 'Hello.', config });
      const directory = join(runtimeDir, String(event.runId), 'work');
      expect(preparations[0]?.workingDirectory).toBe(directory);
      expect(JSON.parse((db.query('SELECT config_json FROM runs WHERE id=?').get(event.runId) as { config_json: string }).config_json).workingDirectory).toBe(directory);
      const legacy = await app.createSession(); if (!legacy.ok) throw new Error(legacy.error.code);
      await run(app, { sessionId: legacy.data.sessionId, text: 'Legacy chat.', config });
      expect(preparations[1]).toMatchObject({ sessionInputs: true });
      expect(executions[1]?.toolBinding).toBeUndefined();
    } finally { await app.close(); }
  });

  it('rejects an unavailable directory before creating any Run or executing a model', async () => {
    const { app, db, executions, workingDirectory } = harness();
    try {
      const current = await context(app);
      expect(await app.startRun({ ...current, text: 'Read a file.', config, workingDirectory: join(workingDirectory, 'missing') }))
        .toMatchObject({ ok: false, error: { code: 'input_unavailable' } });
      expect(db.query('SELECT * FROM runs').all()).toHaveLength(0);
      expect(executions).toHaveLength(0);
    } finally { await app.close(); }
  });

  it('keeps the Runtime occupied when the existing tool/SDK stop is unconfirmed', async () => {
    const { app, workingDirectory } = harness({ unconfirmedTool: true });
    try {
      const current = await context(app);
      const request = { ...current, text: 'Run a command.', config, workingDirectory };
      const event = await run(app, request);
      expect(event).toMatchObject({ type: 'run_finished', result: { ok: true, data: { status: 'failed', stopped: false, error: { code: 'stop_not_confirmed' } } } });
      expect(await app.queryRuntimeState()).toMatchObject({ ok: true, data: { blocked: true } });
      expect(await app.startRun(request)).toMatchObject({ ok: false, error: { code: 'runtime_unusable' } });
    } finally { await app.close(); }
  });
});
