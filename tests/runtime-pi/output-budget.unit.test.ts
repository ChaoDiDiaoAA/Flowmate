import { describe, expect, it } from 'bun:test';
import { resolveOutputBudget } from '../../packages/runtime-pi/src/output-budget.ts';

describe('output budget policy', () => {
  it('uses the model ceiling within a bounded automatic product budget', () => {
    expect(resolveOutputBudget(undefined, 2048)).toMatchObject({ ok: true, data: { selectedMaxTokens: 2048, modelMaxTokens: 2048, source: 'model-metadata' } });
    expect(resolveOutputBudget(undefined, 64000)).toMatchObject({ ok: true, data: { selectedMaxTokens: 8192, modelMaxTokens: 64000, source: 'model-metadata' } });
  });
  it('labels an unknown ceiling instead of passing a made-up model limit as fact', () => {
    expect(resolveOutputBudget(undefined, null)).toMatchObject({ ok: true, data: { requestedMaxTokens: null, selectedMaxTokens: 8192, modelMaxTokens: null, source: 'fallback' } });
    expect(resolveOutputBudget(16384, null)).toMatchObject({ ok: true, data: { requestedMaxTokens: 16384, selectedMaxTokens: 16384, modelMaxTokens: null, source: 'explicit' } });
  });
  it('rejects invalid values and overrides exceeding the known ceiling without silently reducing them', () => {
    for (const value of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) expect(resolveOutputBudget(value, null).ok).toBe(false);
    expect(resolveOutputBudget(4096, 2048)).toMatchObject({ ok: false, error: { code: 'config_output_budget_invalid' } });
    expect(resolveOutputBudget(2048, 2048).ok).toBe(true);
  });
});
