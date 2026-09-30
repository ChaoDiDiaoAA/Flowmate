import { describe, expect, it } from 'bun:test';
import * as messages from '../../packages/contracts/src/runtime.ts';
import {
  normalizeAgentRunRequest,
  normalizeCreateSessionRequest,
  normalizeRenameSessionRequest,
  normalizeSessionId,
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

  it('normalizes rename titles and validates delete identities at the boundary', () => {
    expect(normalizeRenameSessionRequest({ sessionId: 7, title: '  Review  ' })).toEqual({
      ok: true, data: { sessionId: 7, title: 'Review' },
    });
    expect(normalizeRenameSessionRequest({ sessionId: 7, title: '   ' })).toMatchObject({ ok: false });
    expect(normalizeRenameSessionRequest({ sessionId: 7, title: '😀'.repeat(121) })).toMatchObject({ ok: false });
    expect(normalizeRenameSessionRequest({ sessionId: 7, title: 'x'.repeat(121) })).toMatchObject({ ok: false });
    expect(normalizeRenameSessionRequest({ sessionId: 0, title: 'Review' })).toMatchObject({ ok: false });
    expect(normalizeRenameSessionRequest({ sessionId: 7, title: 'Review', nativeSessionId: 'forged' })).toMatchObject({ ok: false });
    expect(normalizeSessionId(7)).toEqual({ ok: true, data: 7 });
    expect(normalizeSessionId('7')).toMatchObject({ ok: false });
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
    expect(normalizeAgentRunRequest({ sessionId: 4, text: 'Hello', config, goalMode: 'answer' })).toMatchObject({ ok: true });
    expect(normalizeAgentRunRequest({ sessionId: 4, text: 'Create a result', config, goalMode: 'save-candidate' }))
      .toMatchObject({ ok: false, error: { code: 'input_invalid' } });
    expect(normalizeAgentRunRequest({ sessionId: 4, text: 'Create a result', config, goalMode: 'save-candidate',
      workspace: { revision: 1, documentRef: { id: 2, version: 'v1' }, jobId: null, candidateRef: null, sessionId: 4 } }))
      .toMatchObject({ ok: false, error: { code: 'input_invalid' } });
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

describe('P4 message wire contracts', () => {
  const base = { entryId: 'e1', runId: 7, liveOrdinal: 1, timestamp: 1,
    persistence: 'saved', truncated: false, phase: 'ended', stopReason: null,
    toolCallId: null, toolName: null, isError: null };
  const user = { ...base, role: 'user', blocks: [{ type: 'text', text: 'Tax?' }], textOrigin: 'product-input' };
  const assistant = { ...base, role: 'assistant', blocks: [{ type: 'toolCall', id: 'c1', name: 'read_invoice_document' }],
    stopReason: 'toolUse', textOrigin: null };
  const result = { ...base, role: 'toolResult', blocks: [], toolCallId: 'c1', toolName: 'read_invoice_document',
    isError: false, textOrigin: null };
  const session = { sessionId: 2, nativeSessionId: 'native-2', title: 'Invoice', status: 'active',
    createdAt: '2026-09-30T00:00:00.000Z', updatedAt: '2026-09-30T00:00:00.000Z',
    availability: 'ready', historyState: 'recoverable', activeRunId: null, modelUseBlocked: false,
    hasBusinessHistory: false };

  it('rejects role-mixed fields and unknown properties while retaining all three legal variants', () => {
    expect(messages.SessionMessageViewSchema).toBeDefined();
    for (const value of [user, assistant, result]) expect(messages.SessionMessageViewSchema.safeParse(value).success).toBe(true);
    for (const value of [
      { ...user, toolCallId: 'forged' }, { ...user, blocks: assistant.blocks }, { ...user, secret: 'private' },
      { ...assistant, stopReason: null }, { ...assistant, textOrigin: 'product-input' },
      { ...assistant, blocks: [{ type: 'text', text: 'Done' }], textOrigin: null },
      { ...result, isError: undefined }, { ...result, toolCallId: '' }, { ...result, blocks: assistant.blocks },
      { ...user, timestamp: Infinity }, { ...user, persistence: 'saved', entryId: null },
      { ...user, liveOrdinal: 0 }, { ...user, blocks: Array.from({ length: 257 }, () => ({ type: 'text', text: '' })) },
      { ...user, blocks: [{ type: 'text', text: '票'.repeat(22_000) }] },
    ]) expect(messages.SessionMessageViewSchema.safeParse(value).success).toBe(false);
  });

  it('normalizes only legal message cursors and bounds without accepting privileged fields', () => {
    expect(messages.normalizeSessionMessagesRequest).toBeDefined();
    expect(messages.normalizeSessionMessagesRequest({ sessionId: 2 })).toEqual({ ok: true, data: { sessionId: 2, limit: 50 } });
    expect(messages.normalizeSessionMessagesRequest({ sessionId: 2, beforeEntryId: 'e1', limit: 100 }))
      .toEqual({ ok: true, data: { sessionId: 2, beforeEntryId: 'e1', limit: 100 } });
    for (const value of [{ sessionId: 0 }, { sessionId: 2, limit: null }, { sessionId: 2, limit: 101 },
      { sessionId: 2, beforeEntryId: null }, { sessionId: 2, beforeEntryId: '' },
      { sessionId: 2, beforeEntryId: 'x'.repeat(129) }, { sessionId: 2, nativeSessionId: 'forged' }]) {
      expect(messages.normalizeSessionMessagesRequest(value)).toMatchObject({ ok: false, error: { code: 'input_invalid' } });
    }
  });

  it('accepts saved query items but rejects temporary states and non-white-listed session fields', () => {
    expect(messages.SessionMessagesPageSchema).toBeDefined();
    const page = { session, leafId: 'e1', entryCount: 1, items: [user], nextBeforeEntryId: null };
    expect(messages.SessionMessagesPageSchema.safeParse(page).success).toBe(true);
    for (const value of [{ ...page, items: [{ ...user, persistence: 'pending' }] },
      { ...page, items: [{ ...assistant, phase: 'streaming' }] }, { ...page, nativeHistory: {} },
      { ...page, session: { ...session, credentials: 'private' } }]) {
      expect(messages.SessionMessagesPageSchema.safeParse(value).success).toBe(false);
    }
  });

  it('checks the complete upsert envelope and requires the message to belong to that real Run', () => {
    expect(messages.MessageUpsertEventSchema).toBeDefined();
    const event = { type: 'message_upsert', runId: 7, sessionId: 2, nativeSessionId: 'native-2',
      sequence: 1, at: '2026-09-30T00:00:00.000Z', message: user };
    expect(messages.MessageUpsertEventSchema.safeParse(event).success).toBe(true);
    for (const value of [{ ...event, runId: 8 }, { ...event, sequence: 0 }, { ...event, at: 'invalid' },
      { ...event, nativeSessionId: '' }, { ...event, extra: true }, { ...event, message: { ...user, liveOrdinal: null } }]) {
      expect(messages.MessageUpsertEventSchema.safeParse(value).success).toBe(false);
    }
  });
});
