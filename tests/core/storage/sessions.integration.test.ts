import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'bun:test';
import { openTestDatabase } from '../../support/database.ts';
import { mkdtempSync } from '../../support/resources.ts';

function paths(root: string) {
  return { root, databaseFile: join(root, 'data', 'test.sqlite'), logsDir: join(root, 'logs'), artifactsDir: join(root, 'artifacts'), outputsDir: join(root, 'outputs'), runtimeDir: join(root, 'runtime') };
}

it('migrates P1 provider data and keeps Agent session identity separate from Run model facts', () => {
  const root = mkdtempSync(join(tmpdir(), 'flowmate-sessions-'));
  const opened = openTestDatabase(paths(root));
  expect(opened.ok).toBe(true);
  if (!opened.ok) return;
  const database = opened.data;
  const oldProvider = database.runs.create({
    goal: 'Existing Provider request',
    input: { version: 1, goal: 'Existing Provider request', text: 'legacy', messageTimestamp: 1 },
    config: { version: 1, name: 'legacy', revision: 1, requestedModel: { provider: 'p', model: 'm' }, resolvedModel: null, api: null, endpoint: null, sdk: { codingAgent: '0.85.1', ai: '0.85.1' }, parameters: { maxRetries: 0, maxRetryDelayMs: 2000 }, limits: { timeoutMs: 60000, stopGraceMs: 5000 }, native: { authSource: 'pi-native', modelsSelection: null } },
    usage: { version: 1, source: 'unknown', reason: 'test', sdkValues: null, attempts: null, attemptsComplete: false, costSource: null, updatedAt: new Date(0).toISOString() },
    cleanup: { version: 1, stopped: false, stopReason: null, errors: [], lateObservationRequired: false },
    createdAt: new Date(0).toISOString(),
  });
  expect(oldProvider.ok).toBe(true);
  if (oldProvider.ok) {
    expect(database.runs.start(oldProvider.data, {
      version: 1, name: 'legacy', revision: 1, requestedModel: { provider: 'p', model: 'm' }, resolvedModel: null,
      api: null, endpoint: null, sdk: { codingAgent: '0.85.1', ai: '0.85.1' }, parameters: { maxRetries: 0, maxRetryDelayMs: 2000 },
      limits: { timeoutMs: 60000, stopGraceMs: 5000 }, native: { authSource: 'pi-native', modelsSelection: null },
    }, new Date(1).toISOString()).ok).toBe(true);
    const finishedOld = database.runs.finish(oldProvider.data, {
      status: 'completed', output: { version: 1, text: 'legacy answer', partial: false, stopReason: 'stop', responseId: null, responseModel: 'm' },
      error: null, usage: { version: 1, source: 'unknown', reason: 'test', sdkValues: null, attempts: 1, attemptsComplete: true, costSource: null, updatedAt: new Date(2).toISOString() },
      tokens: { inputTokens: null, outputTokens: null, totalTokens: null, cost: null, usageComplete: false },
      cleanup: { version: 1, stopped: true, stopReason: 'native-stop', errors: [], lateObservationRequired: false },
      endedAt: new Date(2).toISOString(), stoppedAt: new Date(2).toISOString(), durationMs: 1,
    });
    expect(finishedOld.ok && finishedOld.data).toBe(true);
  }

  const first = database.sessions.create({ nativeSessionId: 'native-a', title: 'Invoice A', createdAt: '2026-09-24T00:00:00.000Z' });
  const second = database.sessions.create({ nativeSessionId: 'native-b', title: 'Invoice B', createdAt: '2026-09-24T00:00:01.000Z' });
  expect(first.ok && second.ok).toBe(true);
  if (!first.ok || !second.ok) return;
  expect(first.data.id).not.toBe(second.data.id);

  const listed = database.sessions.list({ limit: 10 });
  expect(listed.ok).toBe(true);
  if (listed.ok) expect(listed.data.items.map((item) => item.id)).toEqual([second.data.id, first.data.id]);
  if (oldProvider.ok) {
    const oldRead = database.runs.get(oldProvider.data);
    expect(oldRead.ok && oldRead.data.kind).toBe('provider');
    if (oldRead.ok) expect(oldRead.data.sessionId).toBeNull();
  }

  const agentConfig = {
    version: 1 as const, name: 'shared', revision: 1, requestedModel: { provider: 'profile-a', model: 'model-one' },
    resolvedModel: { provider: 'profile-a', model: 'model-one' }, api: 'openai-responses', endpoint: 'https://one.invalid/v1',
    sdk: { codingAgent: '0.85.1', ai: '0.85.1' }, parameters: { maxRetries: 0, maxRetryDelayMs: 2000 },
    limits: { timeoutMs: 60000, stopGraceMs: 5000 }, native: { authSource: 'pi-runtime-api-key' as const, modelsSelection: null },
    agent: { policyVersion: 'p2-invoice-chat-v1' as const, nativeSessionId: 'native-a', systemPrompt: 'invoice summary', thinkingLevel: 'off' as const,
      resourcePolicy: 'none' as const, historyPolicy: 'memory-only' as const, maxContextBytes: 524288, maxOutputBytes: 262144,
      maxAssistantContentBytes: 524288, maxModelCalls: 1 as const, sessionRetry: false as const },
  };
  const scope = { version: 1 as const, mode: 'chat-text' as const, toolNames: [] as [], resourcePaths: [] as [] };
  const firstRun = database.runs.createAgent({
    sessionId: first.data.id, scope, goal: 'invoice summary', input: { version: 1, goal: 'invoice summary', text: 'INV-A', messageTimestamp: 1 },
    config: agentConfig, usage: { version: 1, source: 'unknown', reason: 'request-not-finished', sdkValues: null, attempts: null, attemptsComplete: false, costSource: null, updatedAt: new Date(3).toISOString() },
    cleanup: { version: 1, stopped: false, stopReason: null, errors: [], lateObservationRequired: false }, createdAt: new Date(3).toISOString(),
  });
  expect(firstRun.ok).toBe(true);
  if (!firstRun.ok) return;
  expect(database.runs.start(firstRun.data, agentConfig, new Date(4).toISOString()).ok).toBe(true);
  const finishedAgent = database.runs.finish(firstRun.data, {
    status: 'completed', output: { version: 1, text: 'invoice fields', partial: false, stopReason: 'stop', responseId: null, responseModel: 'model-one', agent: { nativeSessionId: 'native-a', turnCount: 1, modelCallCount: 1 } },
    error: null, usage: { version: 1, source: 'unknown', reason: null, sdkValues: null, attempts: 1, attemptsComplete: true, costSource: null, updatedAt: new Date(5).toISOString() },
    tokens: { inputTokens: null, outputTokens: null, totalTokens: null, cost: null, usageComplete: false },
    cleanup: { version: 1, stopped: true, stopReason: 'native-stop', errors: [], lateObservationRequired: false }, endedAt: new Date(5).toISOString(), stoppedAt: new Date(5).toISOString(), durationMs: 1,
  });
  expect(finishedAgent.ok && finishedAgent.data).toBe(true);
  const secondModelConfig = { ...agentConfig, revision: 2, requestedModel: { provider: 'profile-b', model: 'model-two' }, resolvedModel: { provider: 'profile-b', model: 'model-two' }, endpoint: 'https://two.invalid/v1' };
  const secondRun = database.runs.createAgent({
    sessionId: first.data.id, scope, goal: 'invoice summary', input: { version: 1, goal: 'invoice summary', text: 'INV-A follow-up', messageTimestamp: 6 },
    config: secondModelConfig, usage: { version: 1, source: 'unknown', reason: 'request-not-finished', sdkValues: null, attempts: null, attemptsComplete: false, costSource: null, updatedAt: new Date(6).toISOString() },
    cleanup: { version: 1, stopped: false, stopReason: null, errors: [], lateObservationRequired: false }, createdAt: new Date(6).toISOString(),
  });
  expect(secondRun.ok).toBe(true);
  if (secondRun.ok) {
    const page = database.runs.listBySession({ sessionId: first.data.id, limit: 10 });
    expect(page.ok).toBe(true);
    if (page.ok) expect(page.data.items.map((item) => item.runId)).toEqual([secondRun.data, firstRun.data]);
    const firstSnapshot = database.runs.get(firstRun.data);
    expect(firstSnapshot.ok && firstSnapshot.data.kind).toBe('agent');
    if (firstSnapshot.ok) expect(firstSnapshot.data.config.requestedModel).toEqual({ provider: 'profile-a', model: 'model-one' });
  }

  const raw = database.db.query("SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1").get() as { version: number };
  expect(raw.version).toBe(2);
  expect(database.db.query('PRAGMA foreign_key_check').all()).toEqual([]);
});
