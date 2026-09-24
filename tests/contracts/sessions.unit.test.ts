import { describe, expect, it } from 'bun:test';
import {
  normalizeAgentRunRequest,
  normalizeCreateSessionRequest,
  normalizeListSessionsRequest,
  normalizeSessionRunsRequest,
} from '../../packages/contracts/src/schemas.ts';

const config = {
  version: 1,
  name: 'local-p2',
  revision: 1,
  modelRef: { provider: 'fixture', model: 'fixture-model' },
  native: { authPath: 'C:\\Users\\test\\.pi\\auth.json', modelsPath: null },
  parameters: { maxRetries: 0, maxRetryDelayMs: 2000 },
};

describe('session and Agent contracts', () => {
  it('normalizes and bounds session titles without accepting unknown fields', () => {
    expect(normalizeCreateSessionRequest(undefined)).toEqual({ ok: true, data: { title: 'New Session' } });
    expect(normalizeCreateSessionRequest({ title: '  Invoice review  ' })).toEqual({
      ok: true,
      data: { title: 'Invoice review' },
    });
    expect(normalizeCreateSessionRequest({ title: '   ' })).toMatchObject({ ok: false, error: { code: 'input_invalid' } });
    expect(normalizeCreateSessionRequest({ title: '票'.repeat(121) })).toMatchObject({ ok: false });
    expect(normalizeCreateSessionRequest({ title: 'x'.repeat(121) })).toMatchObject({ ok: false });
    expect(normalizeCreateSessionRequest({ title: 'Invoice', nativeSessionId: 'attacker-chosen' })).toMatchObject({
      ok: false,
      error: { code: 'input_invalid' },
    });
  });

  it('preserves valid input text, sets bounded execution defaults, and rejects privileged or oversized input', () => {
    const result = normalizeAgentRunRequest({ sessionId: 4, text: '  Invoice: INV-7  ', config });
    expect(result).toMatchObject({ ok: true });
    if (result.ok) {
      expect(result.data.text).toBe('  Invoice: INV-7  ');
      expect(result.data.timeoutMs).toBe(60_000);
      expect(result.data.stopGraceMs).toBe(5_000);
      expect(result.data.sessionId).toBe(4);
      expect('goal' in result.data).toBe(false);
    }
    expect(normalizeAgentRunRequest({ sessionId: 0, text: 'Invoice', config })).toMatchObject({ ok: false });
    expect(normalizeAgentRunRequest({ sessionId: Number.MAX_SAFE_INTEGER + 1, text: 'Invoice', config })).toMatchObject({ ok: false });
    expect(normalizeAgentRunRequest({ sessionId: 4, text: ' \n\t ', config })).toMatchObject({ ok: false });
    expect(normalizeAgentRunRequest({ sessionId: 4, text: '票'.repeat(22_000), config })).toMatchObject({
      ok: false,
      error: { code: 'input_too_large' },
    });
    expect(normalizeAgentRunRequest({ sessionId: 4, text: 'Invoice', config, tools: ['read'] })).toMatchObject({
      ok: false,
      error: { code: 'input_invalid' },
    });
    expect(normalizeAgentRunRequest({ sessionId: 4, text: 'Invoice', config, goal: 'change trusted goal' })).toMatchObject({
      ok: false,
      error: { code: 'input_invalid' },
    });
  });

  it('bounds session pages and validates the composite updated-time cursor', () => {
    expect(normalizeListSessionsRequest(undefined)).toEqual({ ok: true, data: { limit: 50 } });
    expect(normalizeListSessionsRequest({ limit: 100 })).toEqual({ ok: true, data: { limit: 100 } });
    expect(normalizeListSessionsRequest({ limit: 101 })).toMatchObject({ ok: false });
    expect(normalizeListSessionsRequest({ limit: 10, before: { updatedAt: '2026-09-24T00:00:00.000Z', sessionId: 9 } }))
      .toMatchObject({ ok: true });
    expect(normalizeListSessionsRequest({ before: { updatedAt: 'not-a-date', sessionId: 9 } })).toMatchObject({ ok: false });
    expect(normalizeListSessionsRequest({ before: { updatedAt: '2026-09-24T00:00:00Z', sessionId: -1 } })).toMatchObject({ ok: false });
    expect(normalizeListSessionsRequest({ limit: 50, cursor: 'opaque' })).toMatchObject({ ok: false });
  });

  it('validates session-run pages and rejects a mismatched session identity', () => {
    expect(normalizeSessionRunsRequest({ sessionId: 3 })).toEqual({
      ok: true,
      data: { sessionId: 3, limit: 50 },
    });
    expect(normalizeSessionRunsRequest({ sessionId: 3, limit: 1, beforeRunId: 7 })).toEqual({
      ok: true,
      data: { sessionId: 3, limit: 1, beforeRunId: 7 },
    });
    expect(normalizeSessionRunsRequest({ sessionId: 3, beforeRunId: 0 })).toMatchObject({ ok: false });
    expect(normalizeSessionRunsRequest({ sessionId: 3, limit: 0 })).toMatchObject({ ok: false });
    expect(normalizeSessionRunsRequest({ sessionId: 3, runId: 7 })).toMatchObject({ ok: false });
  });
});
