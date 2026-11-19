import { expect, test } from 'bun:test';
import { UsageRecordV2Schema, appError, type NativeOutcome, type UsageRecordV1 } from '@flowmate/contracts';
import { addResearchReviewUsage } from '../../../packages/core/src/runtime/research-usage.ts';

function metered(input: number, output: number, cost: string, attempts = 1) {
  const totalTokens = input + output;
  const usage: UsageRecordV1 = {
    version: 1, source: 'sdk', reason: null,
    sdkValues: { input, output, cacheRead: 0, cacheWrite: 0, totalTokens,
      costInput: null, costOutput: null, costCacheRead: null, costCacheWrite: null, costTotal: null },
    attempts, attemptsComplete: true, costSource: 'pi-sdk-model-catalog-estimate', updatedAt: '2026-11-19T00:00:00.000Z',
  };
  return { usage, tokens: { inputTokens: input, outputTokens: output, totalTokens, cost, usageComplete: true } };
}

const unknown = {
  usage: { ...metered(0, 0, '0').usage, source: 'unknown', reason: 'no-final-message', sdkValues: null,
    attempts: null, attemptsComplete: false, costSource: null } satisfies UsageRecordV1,
  tokens: { inputTokens: null, outputTokens: null, totalTokens: null, cost: null, usageComplete: false },
};

test('adds completed and failed reviewer usage without renumbering native calls', () => {
  const nativeCalls = [
    { callSequence: 2, ...metered(3, 2, '0.1') },
    { callSequence: 5, ...metered(7, 3, '1e-19') },
  ];
  const base = metered(10, 5, '0.1000000000000000001', 2);
  const reviewer = metered(4, 2, '2e-19');
  const failed = {
    ...metered(6, 3, '0.2', 2), text: '', partial: true, stopReason: 'error', responseId: null,
    responseModel: null, error: appError('review_failed', 'runtime', 'Review failed.'), stopped: true, cleanupErrors: [],
  } satisfies NativeOutcome;

  const result = addResearchReviewUsage({ ...base, usage: { ...base.usage, version: 2, calls: nativeCalls } }, [reviewer, failed]);
  const usage = UsageRecordV2Schema.parse(result.usage);
  expect(result.tokens).toEqual({ inputTokens: 20, outputTokens: 10, totalTokens: 30,
    cost: '0.3000000000000000003', usageComplete: true });
  expect(usage).toMatchObject({ source: 'sdk', attempts: 5, attemptsComplete: true, costSource: base.usage.costSource,
    sdkValues: { input: 20, output: 10, totalTokens: 30, costTotal: null } });
  expect(usage.calls).toEqual([...nativeCalls, { callSequence: 6, ...reviewer },
    { callSequence: 7, usage: failed.usage, tokens: failed.tokens }]);
});

test('retains unknown usage and skips a reviewer that never attempted a request', () => {
  const base = metered(5, 2, '0.1');
  const notRequested = { ...unknown, usage: { ...unknown.usage, source: 'not-requested', attempts: 0 } satisfies UsageRecordV1 };
  expect(addResearchReviewUsage(base, [])).toBe(base);
  expect(addResearchReviewUsage(base, [notRequested])).toBe(base);

  const result = addResearchReviewUsage(base, [notRequested, unknown]);
  const usage = UsageRecordV2Schema.parse(result.usage);
  expect(result.tokens).toEqual(unknown.tokens);
  expect(usage).toMatchObject({ source: 'unknown', sdkValues: null, attempts: null, attemptsComplete: false, costSource: null });
  expect(usage.calls).toEqual([{ callSequence: 1, ...base }, { callSequence: 2, ...unknown }]);
});

test('keeps usage from reviewer calls beyond the 64 recorded call limit', () => {
  const call = metered(1, 1, '0.01');
  const base = metered(63, 63, '0.63', 63);
  const nativeCalls = Array.from({ length: 63 }, (_, i) => ({ callSequence: i + 1, ...call }));
  const reviewer = metered(2, 2, '0.02', 2);
  const result = addResearchReviewUsage({ ...base, usage: { ...base.usage, version: 2, calls: nativeCalls } }, [
    { ...reviewer, usage: { ...reviewer.usage, version: 2, calls: [
      { callSequence: 1, ...call }, { callSequence: 2, ...call },
    ] } },
  ]);

  const usage = UsageRecordV2Schema.parse(result.usage);
  expect(usage.calls).toEqual([...nativeCalls, { callSequence: 64, ...call }]);
  expect(usage.attempts).toBe(65);
  expect(result.tokens).toEqual({ inputTokens: 65, outputTokens: 65, totalTokens: 130, cost: '0.65', usageComplete: true });
});
