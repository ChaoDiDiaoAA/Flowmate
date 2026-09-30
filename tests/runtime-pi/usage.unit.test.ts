import type { AssistantMessage } from '@earendil-works/pi-ai';
import { expect, it } from 'bun:test';
import { normalizeUsage } from '../../packages/runtime-pi/src/model-runtime.ts';

it('keeps reported usage partial without proving SDK zero values or retry totals', () => {
  const message: AssistantMessage = {
    role: 'assistant', content: [{ type: 'text', text: 'Reported answer' }],
    api: 'openai-completions', provider: 'synthetic', model: 'synthetic',
    stopReason: 'stop', timestamp: 1,
    usage: { input: 3, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 3,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  };
  const partial = normalizeUsage(message, { attempts: 1, complete: true }, true);
  expect(partial.tokens).toEqual({ inputTokens: 3, outputTokens: null, totalTokens: 3, cost: null, usageComplete: false });
  expect(partial.usage).toMatchObject({ source: 'sdk', reason: 'sdk-usage-presence-unconfirmed',
    sdkValues: { input: 3, output: 0 }, costSource: null });

  message.usage.output = 2;
  message.usage.totalTokens = 5;
  message.usage.cost.total = 0.001;
  for (const complete of [true, false]) {
    const reported = normalizeUsage(message, { attempts: 1, complete }, true);
    expect(reported.tokens).toEqual({ inputTokens: 3, outputTokens: 2, totalTokens: 5, cost: '0.001', usageComplete: false });
  }
  const retried = normalizeUsage(message, { attempts: 2, complete: true }, true);
  expect(retried.tokens).toEqual({ inputTokens: 3, outputTokens: 2, totalTokens: 5, cost: '0.001', usageComplete: false });
  expect(retried.usage).toMatchObject({ attempts: 2, reason: 'retry-usage-incomplete' });
  expect(normalizeUsage(message, { attempts: 1, complete: true }, false).tokens.cost).toBeNull();

  message.usage.input = message.usage.output = message.usage.totalTokens = 0;
  const missing = normalizeUsage(message, { attempts: 1, complete: true }, true);
  expect(missing.tokens).toEqual({ inputTokens: null, outputTokens: null, totalTokens: null, cost: null, usageComplete: false });
  expect(missing.usage.source).toBe('unknown');
});
