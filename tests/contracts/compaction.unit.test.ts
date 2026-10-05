import { describe, expect, it } from 'bun:test';
import { z } from 'zod';
import * as contracts from '../../packages/contracts/src/index.ts';

const at = '2026-10-05T04:00:00.000Z';
const operationId = '21e7f105-7170-4b77-b41e-97c5c5f26510';
const commit = { commitRevision: 8, entryCount: 12, leafId: 'entry-12' };
const policy = { version: 'p10-native-compaction-v1', autoEnabled: true, reserveTokens: 16384, keepRecentTokens: 20000 };
const capacity = { tokens: null, source: 'unknown', contextWindow: null, thresholdTokens: null, fitsEstimate: null };
const usage = { version: 1, source: 'not-requested', reason: 'not-started', sdkValues: null, attempts: 0,
  attemptsComplete: true, costSource: null, updatedAt: at };
const tokens = { inputTokens: null, outputTokens: null, totalTokens: null, cost: null, usageComplete: false };
const observation = {
  sessionId: 7, nativeSessionId: 'native-7', operationId, runId: null, reason: 'manual', observationSequence: 1,
  phase: 'preparing', generated: false, nativeOutcome: 'pending', entryId: null, saved: null, error: null,
  stopRequested: false, stopped: false, continuation: 'next-run', mayContinue: false, capacity, usage, tokens,
};
const auto = { ...observation, runId: 31, reason: 'threshold', continuation: 'current-run' };
const evidence = {
  sessionId: 7, nativeSessionId: 'native-7', operationId, runId: 31, reason: 'threshold',
  baseline: commit, firstKeptEntryId: 'retained', splitTurn: false, observation: auto, calls: [],
};
const call = {
  modelCallIndex: 1, purpose: 'history', model: { provider: 'controlled', model: 'offline', api: 'openai-completions', contextWindow: 64000 },
  transport: 'observed-fetch', sdkPayload: null, attempts: [], usage: null, tokens: null,
};
function schema(name: string): z.ZodType<unknown> {
  const value: unknown = Reflect.get(contracts, name);
  expect(value, `${name} must be exported`).toBeInstanceOf(z.ZodType);
  if (!(value instanceof z.ZodType)) throw new Error(`Missing ${name}`);
  return value;
}

describe('P10 compaction strict contracts', () => {
  it('manual-contract-rejects-config-and-forged-facts', () => {
    const request = { sessionId: 7, operationId, expected: commit, modelId: 'invoice-model' };
    const validator = schema('DesktopSessionCompactionRequestSchema');
    expect(validator.safeParse(request).success).toBe(true);
    for (const patch of [{ apiKey: 'secret' }, { config: {} }, { history: {} }, { operationId: 'old' },
      { sessionId: 0 }, { expected: { ...commit, commitRevision: Number.MAX_SAFE_INTEGER + 1 } }])
      expect(validator.safeParse({ ...request, ...patch }).success).toBe(false);
    const op = schema('CompactionObservationSchema');
    expect(op.safeParse(observation).success).toBe(true);
    for (const patch of [{ runId: 31 }, { continuation: 'current-run' }, { observationSequence: 0 },
      { saved: commit }, { generated: false, nativeOutcome: 'succeeded' }, { snapshotId: 51 }])
      expect(op.safeParse({ ...observation, ...patch }).success).toBe(false);
  });

  it('keeps native, submitted and continuation facts independent', () => {
    const validator = schema('CompactionObservationSchema');
    const measured = { tokens: 1000, source: 'sdk-post-compaction-estimate', contextWindow: 64000, thresholdTokens: 47616, fitsEstimate: true };
    const completed = { ...observation, phase: 'ended', generated: true, nativeOutcome: 'succeeded', stopped: true, capacity: measured };
    expect(validator.safeParse(completed).success).toBe(true); // SDK success alone need not prove SQL.
    const stored = { ...completed, entryId: 'compacted', saved: { ...commit, leafId: 'compacted', entryCount: 13, commitRevision: 9 } };
    expect(validator.safeParse({ ...stored, mayContinue: true }).success).toBe(true);
    expect(validator.safeParse({ ...stored, stopRequested: true, mayContinue: true }).success).toBe(false);
    expect(validator.safeParse({ ...stored, capacity, mayContinue: true }).success).toBe(false);
    expect(validator.safeParse({ ...stored, saved: { ...stored.saved, leafId: 'elsewhere' } }).success).toBe(false);
    const failed = { ...completed, nativeOutcome: 'failed', error: { code: 'compaction_failed', category: 'runtime', message: 'Failed safely.', retryable: false } };
    expect(validator.safeParse(failed).success).toBe(true);
    expect(validator.safeParse({ ...failed, saved: null, generated: false, mayContinue: true }).success).toBe(true); // Stable unchanged-prefix proof belongs to core.
  });

  it('does not turn unknown capacity into permission', () => {
    const validator = schema('CompactionCapacitySchema');
    expect(validator.safeParse(capacity).success).toBe(true);
    expect(validator.safeParse({ ...capacity, tokens: 1000, source: 'message-estimate' }).success).toBe(true);
    for (const patch of [{ fitsEstimate: true }, { tokens: -1 }, { source: 'sdk-usage-estimate' }, { contextWindow: 0 },
      { tokens: 1000, source: 'message-estimate', contextWindow: 64000, thresholdTokens: 100, fitsEstimate: true }])
      expect(validator.safeParse({ ...capacity, ...patch }).success).toBe(false);
  });

  it('validates real saved identity and no-operation snapshot without inventing a Run', () => {
    const snapshot = { sessionId: 7, nativeSessionId: 'native-7', commit, policy, capacity,
      lastSaved: null, operation: null, operationAvailability: 'none', manualAllowed: true, blockCode: null };
    const validator = schema('SessionCompactionSnapshotSchema');
    expect(validator.safeParse(snapshot).success).toBe(true);
    expect(validator.safeParse({ ...snapshot, operation: { ...observation, sessionId: 8 }, operationAvailability: 'live' }).success).toBe(false);
    expect(validator.safeParse({ ...snapshot, operation: observation, operationAvailability: 'none' }).success).toBe(false);
    expect(validator.safeParse({ ...snapshot, manualAllowed: true, blockCode: 'session_busy' }).success).toBe(false);
    expect(schema('CompactionAcceptedSchema').safeParse({ sessionId: 7, operationId }).success).toBe(true);
    expect(schema('SessionCompactionCancelSchema').safeParse({ sessionId: 7, operationId, runId: 31 }).success).toBe(false);
    expect(schema('SessionCompactionQuerySchema').safeParse({ sessionId: 7, operationId, runId: 31 }).success).toBe(true);
  });

  it('auto-evidence-identity-and-bounds', () => {
    const validator = schema('RunCompactionEvidenceSchema');
    expect(validator.safeParse(evidence).success).toBe(true);
    for (const patch of [{ reason: 'manual' }, { runId: 32 }, { sessionId: 8 },
      { nativeSessionId: 'foreign' }, { operationId: '1bd17087-cd09-470a-975f-1debf7e2c620' },
      { observation: observation }, { calls: [call, call, call] }, { calls: [{ ...call, inputId: 2 }] }])
      expect(validator.safeParse({ ...evidence, ...patch }).success).toBe(false);
    const split = { ...evidence, splitTurn: true, calls: [call, { ...call, modelCallIndex: 2, purpose: 'turn-prefix' }] };
    expect(validator.safeParse(split).success).toBe(true);
    expect(validator.safeParse({ ...split, calls: [...split.calls].reverse() }).success).toBe(false);
    expect(validator.safeParse({ ...split, calls: [call, { ...split.calls[1], modelCallIndex: 1 }] }).success).toBe(false);
  });

  it('rejects fictional and discontinuous summary HTTP attempts', () => {
    const attempt = { attempt: 1, preparedAt: at, enteredAt: null, responseAt: null, responseStatus: null,
      transportErrorCode: null, nativeRequestId: null, wireInclusion: 'confirmed', wireReason: null };
    const validator = schema('SummaryCallEvidenceSchema');
    expect(validator.safeParse({ ...call, attempts: [attempt] }).success).toBe(true);
    expect(validator.safeParse({ ...call, transport: 'not-observable', attempts: [attempt] }).success).toBe(false);
    expect(validator.safeParse({ ...call, attempts: [{ ...attempt, attempt: 2 }] }).success).toBe(false);
    expect(validator.safeParse({ ...call, attempts: [attempt, { ...attempt, attempt: 2 }, { ...attempt, attempt: 3 }] }).success).toBe(false);
    expect(validator.safeParse({ ...call, attempts: [{ ...attempt, responseAt: at }] }).success).toBe(false);
  });

  it('legacy-journal-preserves-omission and accepts separate summaries', () => {
    const validator = schema('ContextObservationsSchema');
    const legacy = { requests: [], version: 1 };
    expect(JSON.stringify(validator.parse(legacy))).toBe(JSON.stringify(legacy));
    expect(validator.safeParse({ ...legacy, compactions: [evidence] }).success).toBe(true);
    expect(schema('NativeContextObservationsSchema').safeParse({ ...legacy, compactions: [evidence] }).success).toBe(true);
    expect(schema('PublicContextObservationsSchema').safeParse({ ...legacy, compactions: [evidence] }).success).toBe(true);
    expect(contracts.readContextObservations({ ...legacy, compactions: [evidence] }, 'p9-native-history-v1')).toMatchObject({
      ok: true, data: { compactions: [evidence], requests: [] },
    });
    expect(validator.safeParse({ ...legacy, compactions: [evidence, evidence] }).success).toBe(false);
    expect(validator.safeParse({ ...legacy, unrelated: [] }).success).toBe(false);
  });

  it('limits summary observations and escaped journal bytes', () => {
    const validator = schema('ContextObservationsSchema');
    const records = Array.from({ length: 64 }, (_, index) => ({
      ...evidence, operationId: `21e7f105-7170-4b77-b41e-${String(index).padStart(12, '0')}`,
      observation: { ...auto, operationId: `21e7f105-7170-4b77-b41e-${String(index).padStart(12, '0')}` },
    }));
    expect(validator.safeParse({ version: 1, requests: [], compactions: records }).success).toBe(true);
    expect(validator.safeParse({ version: 1, requests: [], compactions: [...records, records[0]] }).success).toBe(false);
    const oversized = records.map(record => ({ ...record, observation: { ...record.observation,
      error: { code: 'compaction_failed', category: 'runtime', message: '\0'.repeat(12000), retryable: false } } }));
    expect(validator.safeParse({ version: 1, requests: [], compactions: oversized }).success).toBe(false);
  });

  it('registers safe compaction errors and strict Result envelopes', () => {
    const validator = schema('CompactionAcceptedResultSchema');
    expect(validator.safeParse({ ok: true, data: { sessionId: 7, operationId } }).success).toBe(true);
    expect(validator.safeParse({ ok: false, error: { code: 'compaction_failed', category: 'runtime', message: 'Safe.', retryable: false } }).success).toBe(true);
    expect(validator.safeParse({ ok: false, error: { code: 'compaction_failed', category: 'storage', message: 'Safe.', retryable: false } }).success).toBe(false);
    expect(validator.safeParse({ ok: false, error: { code: 'raw_provider_secret', category: 'provider', message: 'Safe.', retryable: false } }).success).toBe(false);
    expect(validator.safeParse({ ok: true, data: { sessionId: 7, operationId }, config: {} }).success).toBe(false);
  });
});
