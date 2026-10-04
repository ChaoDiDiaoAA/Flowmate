import { describe, expect, it } from 'bun:test';
import { z } from 'zod';
import * as contracts from '../../packages/contracts/src/index.ts';

const at = '2026-10-04T00:00:00.000Z';
const commit = { commitRevision: 1, entryCount: 1, leafId: 'user' };
const user = { type: 'message', id: 'user', parentId: null, timestamp: at,
  message: { role: 'user', content: 'Hello', timestamp: 1 } };
const history = { storageVersion: 1, header: { type: 'session', id: 'native', version: 3, timestamp: at, cwd: 'D:/fixture' },
  entries: [user], leafId: 'user', unusable: false };
const seed = { sessionId: 4, inputs: [{ nativeEntryId: 'user', originRunId: 7, inputId: 8, snapshotId: 9 }],
  origins: [{ nativeEntryId: 'user', originSessionId: 2, originRunId: 7 }] };
function schema(name: string): z.ZodTypeAny {
  const found = Reflect.get(contracts, name);
  expect(found, `${name} must be exported`).toBeInstanceOf(z.ZodType);
  return found;
}
function normalize(name: string, input: unknown) {
  const found = Reflect.get(contracts, name);
  expect(found, `${name} must be exported`).toBeFunction();
  return found(input);
}

describe('P9 T01', () => {
  // These catch missing strict boundary checks, unsafe identity ranges, and accidental owner injection.
  it('strict history fork and branch requests', () => {
    expect(normalize('normalizeNativeHistoryPageRequest', { sessionId: 4 })).toEqual({ ok: true, data: { sessionId: 4, limit: 50 } });
    expect(normalize('normalizeNativeHistoryPageRequest', { sessionId: 4, afterSequence: 0, expectedCommitRevision: 0, limit: 100 }).ok).toBe(true);
    for (const patch of [{ sessionId: 0 }, { sessionId: Number.MAX_SAFE_INTEGER + 1 }, { limit: 101 }, { afterSequence: -1 },
      { afterSequence: 0 }, { expectedCommitRevision: -1 }, { expectedCommitRevision: 1.5 },
      { expectedCommitRevision: Number.MAX_SAFE_INTEGER + 1 }, { owner: 8 }, { header: {} }]) {
      expect(normalize('normalizeNativeHistoryPageRequest', { sessionId: 4, ...patch })).toMatchObject({ ok: false, error: { code: 'input_invalid' } });
    }
    const detail = { sessionId: 4, entryId: 'user', expectedCommitRevision: 1 };
    expect(normalize('normalizeSessionHistoryEntryRequest', detail)).toEqual({ ok: true, data: { ...detail, partIndex: 0, offset: 0 } });
    for (const patch of [{ entryId: 'x'.repeat(257) }, { partIndex: -1 }, { offset: Number.MAX_SAFE_INTEGER + 1 },
      { expectedCommitRevision: undefined }, { nativeSessionId: 'forged' }])
      expect(normalize('normalizeSessionHistoryEntryRequest', { ...detail, ...patch })).toMatchObject({ ok: false, error: { code: 'input_invalid' } });
    const fork = { sourceSessionId: 4, expected: commit, targetEntryId: 'user', title: '  Fork  ',
      clientOperationId: 'A5C0C8C1-E27F-4DCF-ACBD-04FC98137F21' };
    expect(normalize('normalizeForkSessionRequest', fork)).toEqual({ ok: true, data: { ...fork, title: 'Fork',
      clientOperationId: 'a5c0c8c1-e27f-4dcf-acbd-04fc98137f21' } });
    expect(schema('ForkSessionRequestSchema').parse(fork).title).toBe('Fork');
    for (const patch of [{ title: ' ' }, { title: '😀'.repeat(121) }, { clientOperationId: 'invalid' },
      { originSessionId: 5 }, { runId: 7 }, { header: history.header }, { targetEntryId: 'x'.repeat(257) },
      { expected: { ...commit, commitRevision: -1 } }, { expected: { ...commit, entryCount: Number.MAX_SAFE_INTEGER + 1 } }])
      expect(normalize('normalizeForkSessionRequest', { ...fork, ...patch })).toMatchObject({ ok: false, error: { code: 'input_invalid' } });
  });

  // These catch lossy parse/role narrowing and missing seed coverage, without importing SDK objects.
  it('preserves complete native JSON and recovery seed identity', () => {
    const usage = { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, reasoning: 1, totalTokens: 3,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
    const image = { type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' };
    const messages = [
      { role: 'user', content: [{ type: 'text', text: 'Hello', textSignature: 'sig' }, image], timestamp: 1 },
      { role: 'assistant', content: [{ type: 'thinking', thinking: '', thinkingSignature: 'encrypted', redacted: true },
        { type: 'text', text: 'Answer', textSignature: 'sig' },
        { type: 'toolCall', id: 'call', name: 'tool', arguments: { nested: [true, null] }, thoughtSignature: 'thought', namespace: 'ns' }],
        api: 'openai-responses', provider: 'fixture', model: 'm', usage, stopReason: 'toolUse', timestamp: 2,
        responseModel: 'actual', responseId: 'response', providerThinkingLevel: 'high', diagnostics: [],
        deferred: { provider: 'fixture', modelId: 'm', api: 'openai-responses', id: 'deferred', data: { opaque: true } },
        errorMessage: '', rawStopReason: 'tool_calls', endTurn: false },
      { role: 'toolResult', toolCallId: 'call', toolName: 'tool', content: [image], details: { secret: 'stored only' },
        usage, addedToolNames: ['tool2'], isError: false, timestamp: 3 },
      { role: 'bashExecution', command: 'echo hello', output: 'hello', exitCode: undefined, cancelled: false,
        truncated: false, fullOutputPath: 'D:/private', excludeFromContext: true, timestamp: 4 },
      { role: 'custom', customType: 'extension', content: [image], display: false, details: { opaque: [1] }, timestamp: 5 },
      { role: 'branchSummary', summary: 'branch', fromId: 'root', timestamp: 6 },
      { role: 'compactionSummary', summary: 'compact', tokensBefore: 100, timestamp: 7 },
    ];
    const extra = [
      { type: 'model_change', provider: 'fixture', modelId: 'm' },
      { type: 'thinking_level_change', thinkingLevel: 'high' },
      { type: 'compaction', summary: 'compact', firstKeptEntryId: 'e0', tokensBefore: 100, details: { opaque: 1 }, usage, fromHook: true },
      { type: 'branch_summary', fromId: 'root', summary: 'branch', details: { opaque: 2 }, usage, fromHook: false },
      { type: 'custom', customType: 'extension', data: { a: [1, null] } },
      { type: 'custom_message', customType: 'extension', content: [image], display: false, details: { opaque: 3 } },
      { type: 'label', targetId: 'e0', label: undefined },
      { type: 'session_info', name: 'Name' },
    ];
    const entries = [...messages.map(message => ({ type: 'message', message })), ...extra].map((entry, index) =>
      ({ ...entry, id: `e${index}`, parentId: index === 0 ? null : `e${index - 1}`, timestamp: at }));
    const complete = { ...history, entries, leafId: 'e14' };
    expect(JSON.stringify(schema('NativeSessionHistorySchema').parse(complete))).toBe(JSON.stringify(complete));
    for (const entry of entries) expect(JSON.stringify(schema('NativeSessionEntrySchema').parse(entry))).toBe(JSON.stringify(entry));
    for (const message of messages) expect(JSON.stringify(schema('NativeAgentMessageSchema').parse(message))).toBe(JSON.stringify(message));
    const bundle = { history, commit, seed };
    expect(schema('NativeHistoryRecoveryBundleSchema').parse(bundle)).toEqual(bundle);
    for (const patch of [{ history: null }, { commit: null }, { commit: { ...commit, entryCount: 2 } },
      { seed: { ...seed, origins: [] } }, { seed: { ...seed, origins: [...seed.origins, seed.origins[0]] } },
      { seed: { ...seed, origins: [{ ...seed.origins[0], nativeEntryId: 'missing' }] } },
      { seed: { ...seed, inputs: [...seed.inputs, seed.inputs[0]] } },
      { seed: { ...seed, inputs: [{ ...seed.inputs[0], originRunId: 10 }] } }])
      expect(schema('NativeHistoryRecoveryBundleSchema').safeParse({ ...bundle, ...patch }).success).toBe(false);
    expect(schema('NativeHistoryRecoveryBundleSchema').safeParse({ history: null, commit: null,
      seed: { sessionId: 4, inputs: [], origins: [] } }).success).toBe(true);
    expect(schema('NativeHistoryRecoveryBundleSchema').safeParse({ history: null, commit: null, seed }).success).toBe(false);
    const derivedHistory = { ...history, entries: [{ ...user, message: messages[4] }] };
    expect(schema('NativeHistoryRecoveryBundleSchema').safeParse({ ...bundle, history: derivedHistory }).success).toBe(false);
  });

  it('rejects unknown native shapes and unsafe JSON without invoking accessors', () => {
    const validator = schema('NativeSessionHistorySchema');
    const cycle: Record<string, unknown> = {}; cycle.self = cycle;
    let accessed = 0;
    const accessor = Object.defineProperty({}, 'secret', { enumerable: true, get() { accessed++; return 1; } });
    for (const data of [cycle, accessor, Infinity, NaN, new Date(), new Map(), 1n, () => 1, [undefined], Array(1), Symbol('invalid')]) {
      expect(validator.safeParse({ ...history, entries: [{ ...user, type: 'custom', customType: 'fixture', data }] }).success).toBe(false);
    }
    expect(accessed).toBe(0);
    for (const entries of [[{ ...user, type: 'unknown' }], [{ ...user, message: { role: 'unknown', timestamp: 1 } }],
      [{ ...user, parentId: 'missing' }], [user, user], [{ ...user, type: 'branch_summary', summary: 'x', fromId: 'missing' }]])
      expect(validator.safeParse({ ...history, entries }).success).toBe(false);
    expect(validator.safeParse({ ...history, commitRevision: 1 }).success).toBe(false);
  });

  // A required identity disappearing from persisted JSON must fail before a write is accepted.
  it('rejects non-enumerable native fields that disappear during serialization', () => {
    const hiddenId = Object.defineProperty({ ...user }, 'id', { value: 'user', enumerable: false });
    expect(JSON.parse(JSON.stringify(hiddenId)).id).toBeUndefined();
    expect(schema('NativeSessionEntrySchema').safeParse(hiddenId).success).toBe(false);
    expect(schema('NativeSessionHistorySchema').safeParse({ ...history, entries: [hiddenId] }).success).toBe(false);
    const hiddenHeaderId = Object.defineProperty({ ...history.header }, 'id', { value: 'native', enumerable: false });
    expect(schema('NativeSessionHeaderSchema').safeParse(hiddenHeaderId).success).toBe(false);
    const hiddenRole = Object.defineProperty({ ...user.message }, 'role', { value: 'user', enumerable: false });
    expect(schema('NativeAgentMessageSchema').safeParse(hiddenRole).success).toBe(false);
    const hiddenData = Object.defineProperty({}, 'opaque', { value: 'must not vanish', enumerable: false });
    expect(schema('NativeSessionEntrySchema').safeParse({ ...user, type: 'custom', customType: 'fixture', data: hiddenData }).success).toBe(false);
    const optional = Object.defineProperty({ ...user, type: 'label', targetId: 'user' }, 'label', { value: undefined, enumerable: false });
    expect(JSON.stringify(schema('NativeSessionEntrySchema').parse(optional))).toBe(JSON.stringify(optional));
    expect(schema('NativeSessionHistorySchema').safeParse(JSON.parse(JSON.stringify(history))).success).toBe(true);
  });

  // Numeric-looking properties outside array indices cannot conceal unsupported native values.
  it('rejects array own properties outside canonical in-range slots', () => {
    for (const key of ['4294967295', '9007199254740991', '01', '-1', '1.0', 'extra']) {
      const data: unknown[] = ['kept'];
      Object.defineProperty(data, key, { value: Infinity, enumerable: true });
      expect(JSON.stringify(data)).toBe('["kept"]');
      expect(schema('NativeSessionEntrySchema').safeParse({ ...user, type: 'custom', customType: 'fixture', data }).success).toBe(false);
    }
    const valid: unknown[] = ['kept'];
    Object.defineProperty(valid, '0', { value: 'kept', enumerable: false });
    const entry = { ...user, type: 'custom', customType: 'fixture', data: valid };
    expect(JSON.stringify(schema('NativeSessionEntrySchema').parse(entry))).toBe(JSON.stringify(entry));
  });

  it('enforces public whitelist identity and UTF8 display budgets', () => {
    const summary = { sequence: 0, entryId: 'user', parentId: null, type: 'message', timestamp: at,
      isCurrentPath: true, isLeaf: true, preview: 'Hello', truncated: false,
      originSessionId: 2, originRunId: 7, canSelect: true, cannotSelectReason: null };
    const session = { sessionId: 4, nativeSessionId: 'native', title: 'Title', status: 'active', createdAt: at, updatedAt: at,
      availability: 'ready', historyState: 'recoverable', activeRunId: null, modelUseBlocked: false,
      hasBusinessHistory: false, deletePending: false };
    const page = { session, commit, items: [summary], nextAfterSequence: null };
    expect(schema('NativeHistoryPageResultSchema').safeParse({ ok: true, data: page }).success).toBe(true);
    expect(schema('NativeHistoryPageResultSchema').safeParse({ ok: true, data: { ...page,
      commit: { ...commit, entryCount: 2, leafId: null }, items: [{ ...summary, isLeaf: false }, { ...summary, sequence: 1, isLeaf: false }] } }).success).toBe(false);
    for (const patch of [{ preview: '税'.repeat(342) }, { canSelect: true, cannotSelectReason: 'busy' },
      { originSessionId: 0 }, { type: 'unknown' }, { fullOutputPath: 'D:/private' }])
      expect(schema('NativeHistoryPageResultSchema').safeParse({ ok: true, data: { ...page, items: [{ ...summary, ...patch }] } }).success).toBe(false);
    const detail = { summary, commit, fields: { type: 'message', role: 'user', toolName: null, callId: null,
      stopReason: null, isError: null, hasImages: false, imageMimeTypes: [] },
      part: { kind: 'text', text: 'x'.repeat(65536) }, partIndex: 0, offset: 0, next: null };
    expect(schema('SessionHistoryEntryResultSchema').safeParse({ ok: true, data: detail }).success).toBe(true);
    for (const patch of [{ part: { kind: 'text', text: 'x'.repeat(65537) } }, { part: { kind: 'text', text: '' } }, { fields: { ...detail.fields, arguments: {} } },
      { fields: { ...detail.fields, imageMimeTypes: ['image/png'], hasImages: false } }, { partIndex: -1 },
      { fields: { ...detail.fields, callId: 'forged-call' } },
      { fields: { type: 'custom', customType: { text: 'fixture', truncated: false }, hasOpaqueData: true } }])
      expect(schema('SessionHistoryEntryResultSchema').safeParse({ ok: true, data: { ...detail, ...patch } }).success).toBe(false);
  });

  it('bounds whole escaped Result envelopes and commit writes', () => {
    const validator = schema('HistoryCommitInputSchema');
    const write = { sessionId: 4, expected: null, header: history.header, appendEntries: [user], leafId: 'user', unusable: false, contexts: [] };
    expect(validator.safeParse(write).success).toBe(true);
    for (const patch of [{ expected: undefined }, { contexts: undefined }, { expected: { ...commit, commitRevision: Infinity } }])
      expect(validator.safeParse({ ...write, ...patch }).success).toBe(false);
    expect(schema('HistoryCommitReceiptSchema').safeParse({ ...commit, commitRevision: Number.MAX_SAFE_INTEGER }).success).toBe(true);
    expect(schema('HistoryCommitReceiptSchema').safeParse({ ...commit, commitRevision: Number.MAX_SAFE_INTEGER + 1 }).success).toBe(false);
    const error = { code: 'session_history_invalid', category: 'session', message: '\u0000'.repeat(23000), retryable: false };
    expect(schema('SessionHistoryEntryResultSchema').safeParse({ ok: false, error }).success).toBe(false);
    expect(schema('SessionHistoryEntryResultSchema').safeParse({ ok: false, error: { ...error, message: 'Unavailable' } }).success).toBe(true);
    for (const invalid of [{ ...error, code: 'token=private-value', message: 'Unavailable' },
      { code: 'context_evidence_too_large', category: 'session', retryable: false, message: 'Too large' },
      { code: 'context_evidence_too_large', category: 'runtime', retryable: true, message: 'Too large' }]) {
      expect(schema('SessionHistoryEntryResultSchema').safeParse({ ok: false, error: invalid }).success).toBe(false);
      expect(schema('NativeHistoryPageResultSchema').safeParse({ ok: false, error: invalid }).success).toBe(false);
      expect(schema('ForkSessionResponseSchema').safeParse({ ok: false, error: invalid }).success).toBe(false);
    }
  });
});
