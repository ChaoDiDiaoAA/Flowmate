import { describe, expect, it } from 'bun:test';
import { SessionManager, type AgentSession } from '@earendil-works/pi-coding-agent';
import type { AssistantMessage } from '@earendil-works/pi-ai';
import type { NativeSessionHistory } from '@flowmate/contracts';
import { formatExecutionPrompt } from '@flowmate/contracts';

type AgentMessage = AgentSession['messages'][number];

const module = await import('../../packages/runtime-pi/src/messages.ts').catch(() => null);
function api() { expect(module).not.toBeNull(); return module!; }
const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
function assistant(content: AssistantMessage['content'], stopReason: AssistantMessage['stopReason'] = 'stop'): AssistantMessage {
  return { role: 'assistant', content, api: 'openai-completions', provider: 'fixture', model: 'fixture',
    usage, stopReason, timestamp: 2, responseId: 'response-secret' };
}
const user = { role: 'user' as const, content: 'Tax?', timestamp: 1 };
const call = assistant([{ type: 'toolCall', id: 'c1', name: 'normalize_invoice_values', arguments: { private: 'not-ui' } }], 'toolUse');
const result = { role: 'toolResult' as const, toolCallId: 'c1', toolName: 'normalize_invoice_values',
  content: [{ type: 'text' as const, text: '{"secret":"not-ui"}' }], isError: false, timestamp: 3,
  details: { private: 'not-ui' } };
function history(messages: readonly AgentMessage[]): NativeSessionHistory {
  const manager = SessionManager.inMemory('D:/fixture');
  for (const message of messages) manager.appendMessage(message as Parameters<typeof manager.appendMessage>[0]);
  return { storageVersion: 1, header: manager.getHeader()!, entries: manager.getEntries().map(entry => ({ ...entry })), leafId: manager.getLeafId(), unusable: false };
}
function project(value: NativeSessionHistory, options: Record<string, unknown> = {}) {
  return api().projectSessionMessages({ history: value, bindings: [], runInputs: [], limit: 50, ...options });
}

describe('P4 native messages and projection', () => {
  it('projects the legacy Run fallback using its frozen nonempty Workspace context', () => {
    const workspaceInput = { documentRef: { id: 2, version: 'v1' }, job: null, candidate: null };
    const workspaceContext = { formatVersion: 1 as const, revision: 4, sessionId: 3,
      documentRef: workspaceInput.documentRef, jobId: null, candidateRef: null, activeView: 'parsed' as const,
      selection: { formatVersion: 1 as const, kind: 'source' as const, target: 'document' as const,
        targetId: 2, targetVersion: 'v1', artifactId: 4, page: 1, block: 'b1' } };
    const prompt = formatExecutionPrompt({ text: 'Tax?', business: true, workspaceInput, workspaceContext });
    const value = history([{ ...user, content: prompt }]);
    const projected = project(value, { bindings: [{ entryId: value.entries[0]!.id, runId: 7 }],
      runInputs: [{ runId: 7, goalMode: 'answer', workspaceContext,
        input: { version: 2, goal: 'Invoice', text: 'Tax?', messageTimestamp: 1, workspaceInput } }] });
    expect(projected).toMatchObject({ ok: true, data: { items: [{ role: 'user', textOrigin: 'product-input',
      blocks: [{ type: 'text', text: 'Tax?' }] }] } });
    expect(project(value, { bindings: [{ entryId: value.entries[0]!.id, runId: 7 }],
      runInputs: [{ runId: 7, goalMode: 'answer',
        input: { version: 2, goal: 'Invoice', text: 'Tax?', messageTimestamp: 1, workspaceInput } }] }).ok).toBe(false);
  });
  it('retains the single-user legacy fallback when the P5 association collection is empty', () => {
    const manager = SessionManager.inMemory('D:/fixture');
    manager.appendMessage({ role: 'user', content: 'Legacy question', timestamp: 1 });
    const entryId = manager.getLeafId()!;
    const history: NativeSessionHistory = { storageVersion: 1, header: manager.getHeader()!, entries: manager.getEntries().map(entry => ({ ...entry })), leafId: entryId, unusable: false };
    const projected = api().projectSessionMessages({ history, limit: 50, bindings: [{ entryId, runId: 1 }], sessionInputs: [],
      runInputs: [{ runId: 1, goalMode: null, input: { version: 1, goal: 'chat', text: 'Legacy question', messageTimestamp: 1 } }] });
    expect(projected.ok).toBe(true);
    if (projected.ok) expect(projected.data.items[0]).toMatchObject({ textOrigin: 'product-input', blocks: [{ type: 'text', text: 'Legacy question' }] });
  });
  it('projects each P5 user from its own persisted input association even with identical Run and text', () => {
    const value = history([user, assistant([{ type: 'text', text: 'First response' }]), { ...user, timestamp: 3 }]);
    const content = { version: 2, text: 'Tax?', promptText: 'Tax?', workspaceContext: null, workspaceInput: null,
      allowedDocumentIds: [], allowedArtifactIds: [] };
    const options = { bindings: value.entries.map(entry => ({ entryId: entry.id, runId: 7 })),
      runInputs: [{ runId: 7, input: { version: 1, goal: '', text: 'Tax?', messageTimestamp: 123 }, goalMode: null }],
      sessionInputs: [{ inputId: 100, runId: 7, nativeEntryId: value.entries[0]!.id, content },
        { inputId: 101, runId: 7, nativeEntryId: value.entries[2]!.id, content }] };
    expect(project(value, options)).toMatchObject({ ok: true, data: { items: [
      { role: 'user', textOrigin: 'product-input' }, { role: 'assistant' }, { role: 'user', textOrigin: 'product-input' },
    ] } });
    expect(project(value, { ...options, sessionInputs: options.sessionInputs.slice(0, 1) }).ok).toBe(false);
    expect(project(value, { ...options, sessionInputs: options.sessionInputs.map((item, index) => index === 1
      ? { ...item, content: { ...content, promptText: 'forged' } } : item) }).ok).toBe(false);
    expect(project(value, { ...options, sessionInputs: options.sessionInputs.map(item => ({ ...item, inputId: 100 })) }).ok).toBe(false);
  });

  it('projects SDK streaming partial calls only once their real identity is formed', () => {
    const partial = assistant([{ type: 'toolCall', id: '', name: '', arguments: {} }], 'pending');
    const context = { entryId: null, runId: 7, liveOrdinal: 1, persistence: 'pending' as const, phase: 'streaming' as const };
    expect(api().projectMessageView(partial, context)).toMatchObject({ ok: true, data: { role: 'assistant', blocks: [], textOrigin: null } });
    expect(api().projectMessageView(call, context)).toMatchObject({ ok: true, data: {
      blocks: [{ type: 'toolCall', id: 'c1', name: 'normalize_invoice_values' }] } });
    expect(api().projectMessageView(partial, { ...context, phase: 'ended' })).toMatchObject({ ok: false });
  });

  it('creates a schema-checked saved read summary rather than exposing its raw output', () => {
    const data = { documentRef: { id: 2, version: 'v1' }, parsedArtifactId: 1, page: 1, pageCount: 1,
      blocks: [], nextAfterBlockId: null, completePage: true };
    const readCall = assistant([{ type: 'toolCall', id: 'read1', name: 'read_invoice_document', arguments: { documentId: 2 } }], 'toolUse');
    const readResult = { ...result, toolCallId: 'read1', toolName: 'read_invoice_document', content: [{ type: 'text' as const, text: JSON.stringify(data) }] };
    expect(project(history([user, readCall, readResult]))).toMatchObject({ ok: true, data: { items: [
      { role: 'user' }, { role: 'assistant' }, { role: 'toolResult', blocks: [{ type: 'text', text: 'Read page 1; returned 0 parsed blocks.' }] },
    ] } });
    expect(project(history([user, readCall, { ...readResult, content: [{ type: 'text' as const, text: '{"page":"forged"}' }] }])))
      .toMatchObject({ ok: true, data: { items: [{ role: 'user' }, { role: 'assistant' }, {
        role: 'toolResult', toolCallId: 'read1', blocks: [{ type: 'text', text: 'Result summary unavailable.' }],
      }] } });
    expect(project(history([user, readCall, { ...readResult, isError: true }]))).toMatchObject({ ok: true, data: { items: [
      { role: 'user' }, { role: 'assistant' }, { blocks: [{ type: 'text', text: 'The tool returned an error. See the error details.' }] },
    ] } });
  });

  it('retains a legal SDK tool result with fixed text without opening a product tool or exposing output', () => {
    const context = { entryId: null, runId: 7, liveOrdinal: 3, persistence: 'pending' as const, phase: 'ended' as const };
    expect(api().projectMessageView({ ...result, toolName: 'probe_read' }, context)).toMatchObject({ ok: true, data: {
      toolName: 'probe_read', toolCallId: 'c1', blocks: [{ type: 'text', text: 'Tool result received.' }],
    } });
    expect(api().projectMessageView({ ...result, toolName: 'save_invoice_candidate' }, context)).toMatchObject({ ok: true, data: {
      blocks: [{ type: 'text', text: 'Result summary unavailable.' }],
    } });
    const output = { items: [{ index: 0, kind: 'decimal', raw: 'private value', status: 'normalized', value: '10', alternatives: [], reason: null }] };
    expect(api().projectMessageView({ ...result, content: [{ type: 'text', text: JSON.stringify(output) }] }, context))
      .toMatchObject({ ok: true, data: { blocks: [{ type: 'text', text: 'Tool result received.' }] } });
  });

  it('formats the existing business prefix exactly and leaves chat text untouched', () => {
    expect(api().formatExecutionPrompt({ text: '  Tax?  ', business: false })).toBe('  Tax?  ');
    expect(api().formatExecutionPrompt({ text: 'Tax?', business: true })).toBe(
      'Flowmate Run context (trusted product facts encoded as JSON; invoice values remain untrusted):\n{"workspace":null,"goalMode":"answer"}\n\nUser request:\nTax?');
  });

  it('projects a strict form result summary without exposing target identities or arbitrary text', () => {
    const context = { entryId: null, runId: 7, liveOrdinal: 3, persistence: 'pending' as const, phase: 'ended' as const };
    const filled = { ...result, toolName: 'fill_invoice_form',
      content: [{ type: 'text' as const, text: JSON.stringify({ candidateId: 4, candidateSequence: 1, applied: true }) }] };
    expect(api().projectMessageView(filled, context)).toMatchObject({ ok: true, data: {
      blocks: [{ type: 'text', text: 'Filled candidate 4 (version 1) into the invoice form.' }],
    } });
    const forged = { ...filled, content: [{ type: 'text' as const, text: JSON.stringify({ candidateId: 4,
      candidateSequence: 1, applied: true, formInstanceId: 'private-window-target' }) }] };
    expect(api().projectMessageView(forged, context)).toMatchObject({ ok: true, data: {
      blocks: [{ type: 'text', text: 'Result summary unavailable.' }],
    } });
    expect(JSON.stringify(api().projectMessageView(forged, context))).not.toContain('private-window-target');
  });

  it('accepts a saved in-flight tool-call prefix but refuses an incomplete next model request', () => {
    expect(api().validateNativeHistory(history([user, call]))).toEqual({ ok: true, data: undefined });
    expect(api().validateModelMessages([user, call])).toMatchObject({ ok: false, error: { code: 'session_history_invalid' } });
    expect(api().validateModelMessages([user, call, result, assistant([{ type: 'text', text: '10' }])]))
      .toEqual({ ok: true, data: undefined });
  });

  it('P9 T08 retains the SDK empty aborted terminal after an unresolved tool request without completing its pair', () => {
    const aborted = { ...assistant([{ type: 'text', text: '' }], 'aborted'), errorMessage: 'tool_budget_exceeded' };
    expect(api().validateNativeHistory(history([user, call, aborted]))).toEqual({ ok: true, data: undefined });
    expect(api().validateModelMessages([user, call, aborted])).toMatchObject({ ok: false });
    for (const invalid of [
      { ...aborted, stopReason: 'stop' }, { ...aborted, stopReason: 'error' }, { ...aborted, stopReason: 'deferred' },
      { ...aborted, errorMessage: '' }, { ...aborted, content: [{ type: 'text', text: 'extra output' }] },
      { ...aborted, content: [{ type: 'text', text: '', textSignature: 'not-the-SDK-terminal' }] },
      { ...aborted, content: [{ type: 'toolCall', id: 'another', name: 'read', arguments: {} }] },
    ]) expect(api().validateNativeHistory(history([user, call, invalid as AssistantMessage]))).toMatchObject({ ok: false });
    for (const later of [user, result, assistant([{ type: 'text', text: 'later' }]), aborted])
      expect(api().validateNativeHistory(history([user, call, aborted, later]))).toMatchObject({ ok: false });
  });

  it('rejects orphan, duplicate, mismatched and reused tool identities in their own path', () => {
    for (const messages of [[user, result], [user, call, result, result],
      [user, call, { ...result, toolName: 'wrong' }], [user, call, result, call],
      [user, call, assistant([{ type: 'text', text: 'premature continuation' }])]]) {
      expect(api().validateModelMessages(messages)).toMatchObject({ ok: false });
      expect(api().validateNativeHistory(history(messages))).toMatchObject({ ok: false });
    }
  });

  it('rejects corrupted native structures and preserves literal image-looking text', () => {
    const valid = history([user, assistant([{ type: 'text', text: '{"type":"image"}' }])]);
    expect(api().validateNativeHistory(valid).ok).toBe(true);
    const message = valid.entries[1]!.message as AssistantMessage;
    const invalidMessages = [
      { ...message, content: [{ type: 'image', data: 'a', mimeType: 'image/png' }] },
      { ...message, role: 'toolCall' }, { ...message, content: 'invalid' }, { ...message, timestamp: NaN },
      { ...message, usage: { ...usage, totalTokens: Infinity } },
      { ...message, content: [{ type: 'text', text: 'hello', execute: () => null }] },
      { ...message, deferred: { provider: 'p', modelId: 'm', api: 'api', id: 'id', data: new Date() } },
    ];
    for (const invalid of invalidMessages) {
      const changed = structuredClone(valid);
      changed.entries[1]!.message = invalid;
      expect(api().validateNativeHistory(changed)).toMatchObject({ ok: false });
    }
    const cycle: Record<string, unknown> = {}; cycle.self = cycle;
    expect(api().validateModelMessages([{ ...result, details: cycle } as AgentMessage])).toMatchObject({ ok: false });
    expect(api().validateModelMessages([{ ...user, content: [{ type: 'image', data: 'a', mimeType: 'image/png' }] }]))
      .toMatchObject({ ok: true });
    for (const invalid of [{ ...valid, leafId: 'missing' }, { ...valid, header: { ...valid.header, version: 2 } },
      { ...valid, entries: [valid.entries[0]!, { ...valid.entries[1]!, parentId: 'missing' }] },
      { ...valid, entries: [valid.entries[0]!, { ...valid.entries[1]!, id: valid.entries[0]!.id }] }]) {
      expect(api().validateNativeHistory(invalid)).toMatchObject({ ok: false });
    }
  });

  it('allows omitted SDK object fields but rejects array holes, undefined array elements and accessor data', () => {
    expect(api().validateModelMessages([user, call, { ...result, details: { optional: undefined } } as unknown as AgentMessage]).ok).toBe(true);
    for (const details of [[undefined], new Array(1), { get secret() { return 'hidden'; } }, { [Symbol('secret')]: 'hidden' }]) {
      expect(api().validateModelMessages([user, call, { ...result, details } as AgentMessage]).ok).toBe(false);
    }
  });

  it('keeps SDK metadata distinct from closed custom, bash and summary context messages', () => {
    const metadata = history([user]);
    const manager = SessionManager.inMemory(metadata.header.cwd, undefined, [metadata.header, ...metadata.entries] as Parameters<typeof SessionManager.inMemory>[2]);
    manager.appendCustomEntry('fixture.metadata', { visible: false });
    const withMetadata = { ...metadata, entries: manager.getEntries().map(entry => ({ ...entry })), leafId: manager.getLeafId() };
    expect(api().validateNativeHistory(withMetadata).ok).toBe(true);
    expect(project(withMetadata)).toMatchObject({ ok: true, data: { items: [{ role: 'user' }] } });
    const closed = [
      { role: 'bashExecution', command: 'echo a', output: 'a', exitCode: 0, cancelled: false, truncated: false, timestamp: 1 },
      { role: 'custom', customType: 'fixture', content: 'secret', display: false, timestamp: 1 },
      { role: 'branchSummary', summary: 'summary', fromId: null, timestamp: 1 },
      { role: 'compactionSummary', summary: 'summary', tokensBefore: 1, timestamp: 1 },
    ];
    for (const message of closed) expect(api().validateModelMessages([message as AgentMessage]).ok).toBe(false);
    expect(api().validateNativeHistory({ ...metadata, entries: [{ ...metadata.entries[0]!, type: 'custom_message',
      customType: 'fixture', content: 'hidden', display: false, message: undefined }] }).ok).toBe(true);
  });

  it('projects only safe text/call identities and never mutates signed authoritative messages', () => {
    const value = history([user, assistant([{ type: 'thinking', thinking: 'hidden', thinkingSignature: 'signature' },
      { type: 'text', text: 'Reading', textSignature: 'opaque' }, ...call.content], 'toolUse'), result]);
    const before = JSON.stringify(value);
    const page = project(value);
    expect(page.ok).toBe(true);
    if (page.ok) {
      expect(page.data.items.map(item => item.role)).toEqual(['user', 'assistant', 'toolResult']);
      expect(page.data.items[1]!.blocks).toEqual([{ type: 'text', text: 'Reading' },
        { type: 'toolCall', id: 'c1', name: 'normalize_invoice_values' }]);
      expect(page.data.items[2]).toMatchObject({ toolCallId: 'c1', toolName: 'normalize_invoice_values', isError: false,
        textOrigin: null, blocks: [{ type: 'text', text: 'Result summary unavailable.' }] });
      expect(JSON.stringify(page.data)).not.toMatch(/signature|not-ui|response-secret|hidden/);
      expect(page.data.items.every(item => item.persistence === 'saved' && item.phase === 'ended')).toBe(true);
    }
    expect(JSON.stringify(value)).toBe(before);
  });

  it('uses product input only with an exact real Run binding and verifies its live identity bridge', () => {
    const input = { version: 1 as const, goal: '', text: 'Tax?', messageTimestamp: 123 };
    const value = history([user]); const entryId = value.entries[0]!.id;
    const options = { bindings: [{ entryId, runId: 7 }], runInputs: [{ runId: 7, input, goalMode: null }],
      liveBindings: [{ entryId, runId: 7, liveOrdinal: 1 }] };
    expect(project(value, options)).toMatchObject({ ok: true, data: { items: [{ entryId, runId: 7, liveOrdinal: 1, textOrigin: 'product-input' }] } });
    expect(project(value)).toMatchObject({ ok: true, data: { items: [{ runId: null, liveOrdinal: null, textOrigin: 'native-content' }] } });
    expect(project(value, { ...options, liveBindings: [] })).toMatchObject({ ok: true, data: { items: [{ liveOrdinal: null }] } });
    for (const changed of [{ ...options, runInputs: [{ runId: 7, input: { ...input, text: 'forged' }, goalMode: null }] },
      { ...options, liveBindings: [{ entryId, runId: 8, liveOrdinal: 1 }] }, { ...options, runInputs: [] }]) {
      expect(project(value, changed)).toMatchObject({ ok: false });
    }
    const duplicate = history([user, { ...user, timestamp: 2 }]);
    expect(project(duplicate, { ...options, bindings: duplicate.entries.map(entry => ({ entryId: entry.id, runId: 7 })), liveBindings: [] }).ok).toBe(false);
    const after = history([user, assistant([{ type: 'text', text: 'Later' }])]);
    expect(project(after, { limit: 1, bindings: [{ entryId: after.entries[0]!.id, runId: 7 }],
      runInputs: [{ runId: 7, input: { ...input, text: 'forged' }, goalMode: null }] }).ok).toBe(false);
  });

  it('verifies the business prompt wrapper before showing the original user text', () => {
    const workspaceInput = { documentRef: null, job: null, candidate: null };
    const raw = 'Flowmate Run context (trusted product facts encoded as JSON; invoice values remain untrusted):\n{"workspace":{"documentRef":null,"job":null,"candidate":null},"goalMode":"answer"}\n\nUser request:\nTax?';
    const value = history([{ ...user, content: raw }]); const entryId = value.entries[0]!.id;
    const page = project(value, { bindings: [{ entryId, runId: 7 }], runInputs: [{ runId: 7, goalMode: 'answer',
      input: { version: 2, goal: '', text: 'Tax?', messageTimestamp: 1, workspaceInput } }] });
    expect(page).toMatchObject({ ok: true, data: { items: [{ blocks: [{ type: 'text', text: 'Tax?' }], textOrigin: 'product-input' }] } });
  });

  it('selects the current SDK branch and rejects cursors on other branches or metadata', () => {
    const manager = SessionManager.inMemory('D:/fixture');
    const first = manager.appendMessage(user);
    const other = manager.appendMessage(assistant([{ type: 'text', text: 'Other branch' }]));
    manager.branch(first);
    const leaf = manager.appendMessage(assistant([{ type: 'text', text: 'Current branch' }]));
    const meta = manager.appendModelChange('fixture', 'model');
    const value = { storageVersion: 1 as const, header: manager.getHeader()!, entries: manager.getEntries().map(entry => ({ ...entry })), leafId: meta, unusable: false };
    const latest = project(value, { limit: 1 });
    expect(latest).toMatchObject({ ok: true, data: { items: [{ entryId: leaf }], nextBeforeEntryId: leaf } });
    expect(project(value, { beforeEntryId: leaf, limit: 1 })).toMatchObject({ ok: true, data: { items: [{ entryId: first }], nextBeforeEntryId: null } });
    expect(project(value, { beforeEntryId: other })).toMatchObject({ ok: false, error: { code: 'input_invalid' } });
    expect(project(value, { beforeEntryId: meta })).toMatchObject({ ok: false, error: { code: 'input_invalid' } });
  });

  it('keeps UTF-8 characters intact, limits blocks and pages without dropping intervening messages', () => {
    const value = history([user, assistant([{ type: 'text', text: '票'.repeat(30_000) }])]);
    const projected = project(value);
    expect(projected.ok).toBe(true);
    if (projected.ok) {
      const item = projected.data.items[1]!;
      expect(item.truncated).toBe(true);
      expect(item.blocks).toEqual([{ type: 'text', text: '票'.repeat(21_845) }]);
    }
    const blocks = project(history([assistant(Array.from({ length: 257 }, (_, n) => ({ type: 'text', text: String(n) })))]));
    expect(blocks).toMatchObject({ ok: true, data: { items: [{ truncated: true }] } });
    if (blocks.ok) expect(blocks.data.items[0]!.blocks).toHaveLength(256);
    const large = history(Array.from({ length: 20 }, (_, n) => assistant([{ type: 'text', text: `${n}:` + 'x'.repeat(65_534) }])));
    const page = project(large, { limit: 100 }); expect(page.ok).toBe(true);
    if (page.ok) {
      expect(Buffer.byteLength(JSON.stringify(page.data))).toBeLessThanOrEqual(1_048_576);
      expect(page.data.items.length).toBeLessThan(20);
      expect(page.data.items.at(-1)!.entryId).toBe(large.leafId);
      expect(page.data.nextBeforeEntryId).toBe(page.data.items[0]!.entryId);
      expect(project(large, { beforeEntryId: page.data.nextBeforeEntryId, limit: 100 }).ok).toBe(true);
    }
    const huge = history([assistant([{ type: 'toolCall', id: 'c'.repeat(1_048_577), name: 'tool', arguments: {} }], 'toolUse')]);
    expect(project(huge)).toMatchObject({ ok: false, error: { code: 'session_history_invalid' } });
  });
});
