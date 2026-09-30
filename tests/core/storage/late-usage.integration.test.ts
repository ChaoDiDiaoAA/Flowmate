import { expect, it } from 'bun:test';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { appError } from '@flowmate/contracts';
import type { TokenColumns, UsageRecord, UsageRecordV1, UsageRecordV2 } from '@flowmate/contracts';
import { resolveProductPaths } from '@flowmate/shared';
import { openTestDatabase } from '../../support/database.ts';
import { mkdtempSync } from '../../support/resources.ts';

it('fills late V2 usage by call identity without downgrading, replacing known facts or accumulating duplicates', () => {
  const paths = resolveProductPaths(mkdtempSync(join(tmpdir(), 'flowmate-late-usage-')));
  if (!paths.ok) throw new Error(paths.error.code);
  const opened = openTestDatabase(paths.data);
  if (!opened.ok) throw new Error(opened.error.code);
  const { runs } = opened.data;
  const at = '2026-09-30T00:00:00.000Z';
  const unknown: UsageRecordV1 = { version: 1, source: 'unknown', reason: 'pending', sdkValues: null,
    attempts: null, attemptsComplete: false, costSource: null, updatedAt: at };
  const empty: TokenColumns = { inputTokens: null, outputTokens: null, totalTokens: null, cost: null, usageComplete: false };
  const known: UsageRecordV1 = { ...unknown, source: 'sdk', reason: null, attempts: 1, attemptsComplete: true,
    costSource: 'sdk', sdkValues: { input: 5, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 7,
      costInput: 0.001, costOutput: 0, costCacheRead: 0, costCacheWrite: 0, costTotal: 0.001 } };
  const tokens: TokenColumns = { inputTokens: 5, outputTokens: 2, totalTokens: 7, cost: '0.001', usageComplete: true };
  const first = { callSequence: 1, usage: known, tokens };
  const terminal = (usage: UsageRecord) => {
    const created = runs.create({ goal: 'Synthetic late usage', input: { version: 1, goal: 'Synthetic late usage',
      text: 'No provider request', messageTimestamp: 1 }, config: { version: 1, name: 'fixture', revision: 1,
      requestedModel: { provider: 'fixture', model: 'fixture' }, resolvedModel: { provider: 'fixture', model: 'fixture' },
      api: 'openai-completions', endpoint: null, sdk: { codingAgent: '0.85.1', ai: '0.85.1' },
      parameters: { maxRetries: 0, maxRetryDelayMs: 2000 }, limits: { timeoutMs: 1000, stopGraceMs: 100 },
      native: { authSource: 'pi-native', modelsSelection: null } }, usage, createdAt: at,
      cleanup: { version: 1, stopped: false, stopReason: null, errors: [], lateObservationRequired: false } });
    if (!created.ok) throw new Error(created.error.code);
    expect(runs.finish(created.data, { status: 'failed', output: null, error: appError('stop_unconfirmed', 'runtime', 'Synthetic stop'),
      usage, tokens: empty, cleanup: { version: 1, stopped: false, stopReason: 'shutdown', errors: [], lateObservationRequired: true },
      endedAt: at, stoppedAt: null, durationMs: 1 })).toEqual({ ok: true, data: true });
    return created.data;
  };
  const read = (runId: number) => {
    const result = runs.get(runId);
    if (!result.ok) throw new Error(result.error.code);
    return result.data;
  };

  const runId = terminal(unknown);
  const late: UsageRecordV2 = { ...known, version: 2, calls: [first] };
  expect(runs.supplementUsage(runId, late, tokens)).toEqual({ ok: true, data: true });
  expect(read(runId)).toMatchObject({ usage: late, tokens });
  expect(runs.supplementUsage(runId, late, tokens)).toEqual({ ok: true, data: true });
  expect(read(runId)).toMatchObject({ usage: late, tokens });
  expect(runs.supplementUsage(runId, unknown, empty)).toEqual({ ok: true, data: true });
  expect(read(runId)).toMatchObject({ usage: late, tokens });

  const partial: UsageRecordV2 = { ...unknown, version: 2, calls: [first,
    { callSequence: 2, usage: unknown, tokens: { ...empty, inputTokens: 5 } }] };
  const secondRun = terminal(partial);
  const second = { callSequence: 2, usage: known, tokens };
  const completed: UsageRecordV2 = { ...unknown, version: 2, calls: [
    { callSequence: 1, usage: unknown, tokens: empty }, second, second,
  ] };
  expect(runs.supplementUsage(secondRun, completed, empty)).toEqual({ ok: true, data: true });
  expect(read(secondRun).usage).toEqual({ ...partial, calls: [first, second] });
  expect(runs.supplementUsage(secondRun, completed, empty)).toEqual({ ok: true, data: true });
  expect(read(secondRun).usage).toEqual({ ...partial, calls: [first, second] });
});
