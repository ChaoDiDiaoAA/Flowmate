import { describe, expect, it } from 'bun:test';
import * as messages from '../../packages/contracts/src/runtime.ts';
import * as inputs from '../../packages/contracts/src/session-inputs.ts';
import * as ports from '../../packages/contracts/src/ports.ts';
import { serializeDesktopPromptRequest } from '../../packages/contracts/src/settings.ts';
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

describe('P5 input and management contracts', () => {
  const prompt = { sessionId: 4, clientSequence: 7, mode: 'prompt', text: 'Review tax', config };
  const active = { sessionId: 4, clientSequence: 8, mode: 'steer', runId: 12, text: 'Check source' };

  it('validates frozen strategy bounds and rejects duplicated calibration groups', () => {
    expect(ports.RuntimeStrategySnapshotSchema).toBeDefined();
    if (!ports.RuntimeStrategySnapshotSchema) return;
    const group = { toolName: 'read_invoice_document', toolVersion: '1', groupKey: 'group', attemptCount: 20,
      eligibleCount: 20, p95Ms: 100, selectedTimeoutMs: 1000, timeoutSource: 'statistical', fallbackReason: null };
    const strategy = { version: 'runtime-v1', sampleSource: 'test',
      calibration: { sourceCutoffToolCallId: 20, groups: [group] },
      experience: { version: 1, modelKey: 'fixture', promptVersion: 'runtime-v1', taskType: 'answer', items: [] } };
    expect(ports.RuntimeStrategySnapshotSchema.safeParse(strategy).success).toBe(true);
    for (const groups of [[{ ...group, attemptCount: 201 }], [{ ...group, eligibleCount: 21 }],
      [{ ...group, selectedTimeoutMs: Infinity }], [group, group]])
      expect(ports.RuntimeStrategySnapshotSchema.safeParse({ ...strategy, calibration: { ...strategy.calibration, groups } }).success).toBe(false);
  });

  it('preserves old Desktop identity bytes and distinguishes new omitted and explicit limits', () => {
    const request = { sessionId: 4, clientSequence: 7, mode: 'prompt' as const, text: 'Review', modelId: 'model' };
    expect(serializeDesktopPromptRequest(request)).toBe(serializeDesktopPromptRequest({ ...request, timeoutMs: 60_000 }));
    expect(serializeDesktopPromptRequest(request)).not.toBe(serializeDesktopPromptRequest({ ...request, budget: {} }));
    expect(serializeDesktopPromptRequest(request)).not.toBe(serializeDesktopPromptRequest({ ...request, budget: { maxModelCalls: 32 } }));
    expect(serializeDesktopPromptRequest(request, 1)).not.toBe(serializeDesktopPromptRequest({ ...request, timeoutMs: 60_000 }, 1));
    expect(serializeDesktopPromptRequest({ ...request, budget: { maxModelCalls: 32, maxToolCalls: 40 } }, 1))
      .toBe(serializeDesktopPromptRequest({ ...request, budget: { maxToolCalls: 40, maxModelCalls: 32 } }, 1));
  });

  it('reads up to 64 logical request Usage facts while rejecting an overflow', () => {
    const usage = { version: 1 as const, source: 'unknown' as const, reason: null, sdkValues: null, attempts: null,
      attemptsComplete: false, costSource: null, updatedAt: '2026-10-02T00:00:00Z' };
    const tokens = { inputTokens: null, outputTokens: null, totalTokens: null, cost: null, usageComplete: false };
    const record = { ...usage, version: 2, calls: Array.from({ length: 64 }, (_, index) => ({ callSequence: index + 1, usage, tokens })) };
    expect(messages.UsageRecordV2Schema.safeParse(record).success).toBe(true);
    expect(messages.UsageRecordV2Schema.safeParse({ ...record, calls: [...record.calls, { callSequence: 65, usage, tokens }] }).success).toBe(false);
  });

  it('preserves new prompt budget intent and bounds it without letting active inputs change a Run', () => {
    const request = { ...prompt, timeoutMs: 1_800_000, stopGraceMs: 10_000,
      budget: { maxModelCalls: 64, maxToolCalls: 100, toolTimeoutMs: 1_800_000 } };
    expect(inputs.normalizeSessionInputRequest(request)).toMatchObject({ ok: true, data: request });
    const absent = inputs.normalizeSessionInputRequest(prompt);
    expect(absent.ok && absent.data.mode === 'prompt' && absent.data.timeoutMs).toBeUndefined();
    for (const budget of [{ maxModelCalls: 0 }, { maxModelCalls: 65 }, { maxToolCalls: -1 },
      { maxToolCalls: 101 }, { toolTimeoutMs: 99 }, { toolTimeoutMs: 1_800_001 }, { maxToolCalls: 1.5 }, { scope: [] }]) {
      expect(inputs.normalizeSessionInputRequest({ ...prompt, budget }).ok).toBe(false);
    }
    expect(inputs.normalizeSessionInputRequest({ ...active, budget: {} }).ok).toBe(false);
  });

  it('keeps input content v2 and requires paired original request identity fields', () => {
    const content = { version: 2, text: 'Review', workspaceContext: null, workspaceInput: null,
      allowedDocumentIds: [], allowedArtifactIds: [], promptText: 'Review' };
    expect(inputs.SessionInputContentV2Schema.safeParse({ ...content, requestIdentityVersion: 1,
      originalBudgetOverrides: {} }).success).toBe(true);
    expect(inputs.SessionInputContentV2Schema.safeParse({ ...content, requestIdentityVersion: 1 }).success).toBe(false);
    expect(inputs.SessionInputContentV2Schema.safeParse({ ...content, originalBudgetOverrides: {} }).success).toBe(false);
    expect(inputs.SessionInputContentV2Schema.safeParse(content).success).toBe(true);
    expect(inputs.SessionInputContentV2Schema.safeParse({ ...content, version: 3 }).success).toBe(false);
  });

  it('accepts ordinary prompts with bounded defaults and rejects invalid identities or payloads', () => {
    expect(inputs.normalizeSessionInputRequest(prompt)).toMatchObject({ ok: true,
      data: { mode: 'prompt', goalMode: 'answer' } });
    for (const request of [{ ...prompt, text: ' ' }, { ...prompt, text: '票'.repeat(22000) },
      { ...prompt, clientSequence: 0 }, { ...prompt, clientSequence: Number.MAX_SAFE_INTEGER + 1 },
      { ...prompt, mode: 'unknown' }, { ...prompt, scope: {} }, { ...prompt, timeoutMs: 99 }]) {
      expect(inputs.normalizeSessionInputRequest(request).ok).toBe(false);
    }
  });

  it('accepts both active modes without allowing changes to the frozen execution configuration', () => {
    for (const mode of ['steer', 'followUp'] as const) {
      expect(inputs.normalizeSessionInputRequest({ ...active, mode })).toEqual({ ok: true, data: { ...active, mode } });
    }
    for (const field of [{ config }, { goalMode: 'answer' }, { workingDirectory: 'D:/other' },
      { timeoutMs: 1000 }, { stopGraceMs: 100 }, { formTarget: {} }, { modelId: 'other' }]) {
      expect(inputs.normalizeSessionInputRequest({ ...active, ...field }).ok).toBe(false);
    }
    expect(inputs.normalizeSessionInputRequest({ ...active, runId: 0 }).ok).toBe(false);
  });

  it('keeps Fill as prompt with a complete same-Session target and rejects unsupported goal changes', () => {
    expect(inputs.normalizeSessionInputRequest({ ...prompt, goalMode: 'fill-form' }).ok).toBe(false);
    expect(inputs.normalizeSessionInputRequest({ ...active, goalMode: 'fill-form' }).ok).toBe(false);
    expect(inputs.normalizeSessionInputRequest({ ...prompt, goalMode: 'save-candidate' }).ok).toBe(false);
  });

  it('allows original-key or input-id queries but rejects ambiguous selectors', () => {
    expect(inputs.SessionInputQuerySchema.safeParse({ sessionId: 4, inputId: 9 }).success).toBe(true);
    expect(inputs.SessionInputQuerySchema.safeParse({ sessionId: 4 }).success).toBe(true);
    expect(inputs.SessionInputQuerySchema.safeParse({ sessionId: 4, inputId: 9, clientSequence: 7 }).success).toBe(false);
  });

  it('bounds input pages without accepting execution or cursor aliases', () => {
    expect(inputs.normalizeSessionInputsRequest).toBeFunction();
    expect(inputs.normalizeSessionInputsRequest({ sessionId: 4 })).toEqual({ ok: true, data: { sessionId: 4, limit: 50 } });
    expect(inputs.normalizeSessionInputsRequest({ sessionId: 4, runId: 12, beforeInputId: 9, limit: 100 }).ok).toBe(true);
    for (const request of [{ sessionId: 4, limit: 101 }, { sessionId: 4, beforeInputId: 0 },
      { sessionId: 4, runId: 0 }, { sessionId: 4, config }, { sessionId: 4, inputId: 9 }]) {
      expect(inputs.normalizeSessionInputsRequest(request).ok).toBe(false);
    }
  });

  it('normalizes status expectations and rejects arbitrary lifecycle states', () => {
    expect(messages.normalizeSetSessionStatusRequest).toBeFunction();
    expect(messages.normalizeSetSessionStatusRequest({ sessionId: 4, expectedStatus: 'active', status: 'archived' }).ok).toBe(true);
    for (const request of [{ sessionId: 4, expectedStatus: 'active', status: 'running' },
      { sessionId: 4, status: 'archived' }, { sessionId: 0, expectedStatus: 'active', status: 'archived' },
      { sessionId: 4, expectedStatus: 'active', status: 'archived', nativeSessionId: 'forged' }]) {
      expect(messages.normalizeSetSessionStatusRequest(request).ok).toBe(false);
    }
  });

  it('requires explicit committed position expectations for native branches', () => {
    expect(messages.normalizeBranchSessionRequest).toBeFunction();
    expect(messages.normalizeBranchSessionRequest({ sessionId: 4, expectedLeafId: null, expectedEntryCount: 0, expectedCommitRevision: 0, targetEntryId: 'reply-1' }).ok).toBe(true);
    for (const request of [{ sessionId: 4, targetEntryId: 'reply-1' },
      { sessionId: 4, expectedLeafId: null, expectedEntryCount: -1, targetEntryId: 'reply-1' },
      { sessionId: 4, expectedLeafId: 'leaf', expectedEntryCount: 1, targetEntryId: '' }]) {
      expect(messages.normalizeBranchSessionRequest(request).ok).toBe(false);
    }
  });
});

describe('P9 T01 branch revision', () => {
  it('requires the saved revision while preserving count and leaf expectations', () => {
    const request = { sessionId: 4, expectedLeafId: null, expectedEntryCount: 0, targetEntryId: 'reply-1' };
    expect(messages.normalizeBranchSessionRequest(request)).toMatchObject({ ok: false, error: { code: 'input_invalid' } });
    expect(messages.normalizeBranchSessionRequest({ ...request, expectedCommitRevision: 0, targetEntryId: 'x'.repeat(256) }).ok).toBe(true);
    for (const expectedCommitRevision of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1])
      expect(messages.normalizeBranchSessionRequest({ ...request, expectedCommitRevision })).toMatchObject({ ok: false, error: { code: 'input_invalid' } });
    expect(messages.normalizeBranchSessionRequest({ ...request, expectedCommitRevision: 0, targetEntryId: 'x'.repeat(257) }).ok).toBe(false);
  });
});

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

  it('preserves valid input text and omitted Runtime limits, rejecting privileged or oversized input', () => {
    const result = normalizeAgentRunRequest({ sessionId: 4, text: '  Invoice: INV-7  ', config });
    expect(result).toMatchObject({ ok: true });
    if (result.ok) {
      expect(result.data.text).toBe('  Invoice: INV-7  ');
      expect(result.data.timeoutMs).toBeUndefined();
      expect(result.data.stopGraceMs).toBeUndefined();
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
    hasBusinessHistory: false, deletePending: false };

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
