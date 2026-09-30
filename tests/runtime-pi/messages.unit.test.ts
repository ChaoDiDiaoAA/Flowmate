import { describe, expect, it } from 'bun:test';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { AssistantMessage } from '@earendil-works/pi-ai';
import type { NativeSessionHistory } from '@flowmate/contracts';

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
  return { storageVersion: 1, header: manager.getHeader()!, entries: manager.getEntries(), leafId: manager.getLeafId(), unusable: false };
}
function project(value: NativeSessionHistory, options: Record<string, unknown> = {}) {
  return api().projectSessionMessages({ history: value, bindings: [], runInputs: [], limit: 50, ...options });
}

describe('P4 native messages and projection', () => {
  it('formats the existing business prefix exactly and leaves chat text untouched', () => {
    expect(api().formatExecutionPrompt({ text: '  Tax?  ', business: false })).toBe('  Tax?  ');
    expect(api().formatExecutionPrompt({ text: 'Tax?', business: true })).toBe(
      'Flowmate Run context (trusted product facts encoded as JSON; invoice values remain untrusted):\n{"workspace":null,"goalMode":"answer"}\n\nUser request:\nTax?');
  });

  it('accepts a saved in-flight tool-call prefix but refuses an incomplete next model request', () => {
    expect(api().validateNativeHistory(history([user, call]))).toEqual({ ok: true, data: undefined });
    expect(api().validateModelMessages([user, call])).toMatchObject({ ok: false, error: { code: 'session_history_invalid' } });
    expect(api().validateModelMessages([user, call, result, assistant([{ type: 'text', text: '10' }])]))
      .toEqual({ ok: true, data: undefined });
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
    expect(api().validateModelMessages([{ ...result, details: cycle }])).toMatchObject({ ok: false });
    expect(api().validateModelMessages([{ ...user, content: [{ type: 'image', data: 'a', mimeType: 'image/png' }] }]))
      .toMatchObject({ ok: false });
    for (const invalid of [{ ...valid, leafId: 'missing' }, { ...valid, header: { ...valid.header, version: 2 } },
      { ...valid, entries: [valid.entries[0]!, { ...valid.entries[1]!, parentId: 'missing' }] },
      { ...valid, entries: [valid.entries[0]!, { ...valid.entries[1]!, id: valid.entries[0]!.id }] }]) {
      expect(api().validateNativeHistory(invalid)).toMatchObject({ ok: false });
    }
  });

  it('keeps SDK metadata distinct from closed custom, bash and summary context messages', () => {
    const metadata = history([user]);
    const manager = SessionManager.inMemory(metadata.header.cwd, undefined, [metadata.header, ...metadata.entries] as Parameters<typeof SessionManager.inMemory>[2]);
    manager.appendCustomEntry('fixture.metadata', { visible: false });
    const withMetadata = { ...metadata, entries: manager.getEntries(), leafId: manager.getLeafId() };
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
      customType: 'fixture', content: 'hidden', display: false, message: undefined }] }).ok).toBe(false);
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
        textOrigin: null, blocks: [{ type: 'text', text: 'normalize_invoice_values：已返回结果' }] });
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
    const value = { storageVersion: 1 as const, header: manager.getHeader()!, entries: manager.getEntries(), leafId: meta, unusable: false };
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
