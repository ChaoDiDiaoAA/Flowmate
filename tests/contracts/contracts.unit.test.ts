import { describe, expect, it } from 'bun:test';
import { normalizeProviderRequest } from '../../packages/contracts/src/schemas.ts';

const validRequest = {
  goal: '请概述这段合成发票。',
  text: '发票号码：SYN-P1-001',
  config: {
    version: 1,
    name: 'local-p1',
    revision: 1,
    modelRef: { provider: 'deepseek', model: 'deepseek-v4-flash' },
    native: { authPath: 'C:\\Users\\test\\.pi\\auth.json', modelsPath: null },
    parameters: { maxTokens: 512, maxRetries: 0, maxRetryDelayMs: 2000 },
  },
};

describe('public provider contracts', () => {
  it('preserves automatic budget selection and allows an override above the old 2048 cap', () => {
    const request = { ...validRequest, config: { ...validRequest.config, parameters: { maxRetries: 0, maxRetryDelayMs: 1000 } } };
    const automatic = normalizeProviderRequest(request);
    expect(automatic.ok && automatic.data.config.parameters.maxTokens).toBeUndefined();
    expect(normalizeProviderRequest({ ...request, config: { ...request.config, parameters: { ...request.config.parameters, maxTokens: 16384 } } }).ok).toBe(true);
  });
  it('normalizes bounded timeout defaults without exposing arbitrary provider options', () => {
    const result = normalizeProviderRequest(validRequest);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.timeoutMs).toBe(60_000);
    expect(result.data.stopGraceMs).toBe(5_000);
    expect(result.data.config.parameters.maxTokens).toBe(512);
  });

  it('rejects a secret-like or unknown request field before a Run exists', () => {
    const result = normalizeProviderRequest({
      ...validRequest,
      apiKey: 'do-not-accept',
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('input_invalid');
  });

  it('measures UTF-8 bytes for the combined prompt bound', () => {
    const result = normalizeProviderRequest({
      ...validRequest,
      text: '票'.repeat(22_000),
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('input_too_large');
  });
});
