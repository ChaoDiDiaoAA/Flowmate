import { Database } from 'bun:sqlite';
import { createApplication } from '../../apps/composition.ts';
import { openDatabase } from '@flowmate/core';
import { CandidateDraftSchema, invoiceHeaderFields } from '@flowmate/contracts';
import type { Application, ProviderConfig, Result, SessionInputRequest, AgentRunEvent } from '@flowmate/contracts';
import { RuntimeService } from '../../packages/core/src/runtime/service.ts';
import { deferCleanup, waitFor } from '../support/resources.ts';
import { z } from 'zod';
import { expect, it } from 'bun:test';
import { SessionManager, sessionEntryToContextMessages } from '@earendil-works/pi-coding-agent';
import type { NativeSessionHistory, NativeHistoryRecoverySeed } from '@flowmate/contracts';
import { PiAgentAdapter } from '../../packages/runtime-pi/src/session.ts';
import { referenceIds } from '../../packages/runtime-pi/src/memory/history.ts';
import { appError, fail, ok } from '@flowmate/contracts';
import { mkdtempSync, writeFileSync, rmSync, readdirSync, mkdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InMemoryCredentialStore } from '@earendil-works/pi-ai';
import type { AgentSession } from '@earendil-works/pi-coding-agent';
import { validateNativeHistory, projectSessionMessages } from '../../packages/runtime-pi/src/messages.ts';

const cwd = 'D:\\p9-t04-fixture';
const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
function snapshot(manager: SessionManager): NativeSessionHistory {
  return structuredClone({ storageVersion: 1 as const, header: manager.getHeader()!, entries: manager.getEntries().map(e => ({ ...e })), leafId: manager.getLeafId(), unusable: false });
}
function seed(history: NativeSessionHistory): NativeHistoryRecoverySeed {
  return { sessionId: 7, origins: history.entries.map(e => ({ nativeEntryId: e.id, originSessionId: 7, originRunId: null })),
    inputs: history.entries.flatMap(e => e.type === 'message' && (e.message as { role: string }).role === 'user'
      ? [{ nativeEntryId: e.id, originRunId: null, inputId: null, snapshotId: null }] : []) };
}
function mixed() {
  const manager = SessionManager.inMemory(cwd);
  manager.appendModelChange('fixture', 'M1'); manager.appendThinkingLevelChange('off');
  const user = manager.appendMessage({ role: 'user', content: [{ type: 'text', text: 'same' }, { type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' }], timestamp: 1 });
  manager.appendMessage({ role: 'assistant', content: [{ type: 'toolCall', id: 'used-id', name: 'fixture', arguments: {} }],
    provider: 'fixture', api: 'openai-completions', model: 'M2', usage, stopReason: 'toolUse', timestamp: 2 });
  const result = manager.appendMessage({ role: 'toolResult', toolCallId: 'used-id', toolName: 'fixture', content: [{ type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' }], isError: false, timestamp: 3 });
  manager.appendMessage({ role: 'bashExecution', command: 'fixture', output: 'same', exitCode: 0, cancelled: false, truncated: false, timestamp: 4, excludeFromContext: true });
  manager.appendCustomMessageEntry('fixture', [{ type: 'text', text: 'same' }, { type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' }], false, { opaque: { kept: true } });
  manager.appendCustomEntry('opaque', { notAReference: 'missing-is-legal' });
  manager.appendSessionInfo('fixture'); manager.appendLabelChange(user, 'keep');
  manager.appendCompaction('summary', user, 10, { nested: true });
  manager.appendMessage({ role: 'custom', customType: 'fixture', content: 'same', display: false, timestamp: 5 });
  const h = snapshot(manager);
  const last = h.leafId!;
  const extra = [
    { id: 'branch', parentId: last, timestamp: new Date(0).toISOString(), type: 'branch_summary' as const, fromId: result, summary: 'same', details: { keep: true } },
    { id: 'role-branch', parentId: 'branch', timestamp: new Date(0).toISOString(), type: 'message' as const, message: { role: 'branchSummary' as const, fromId: null, summary: 'same', timestamp: 6 } },
    { id: 'role-compaction', parentId: 'role-branch', timestamp: new Date(0).toISOString(), type: 'message' as const, message: { role: 'compactionSummary' as const, summary: 'same', tokensBefore: 10, timestamp: 7 } },
  ];
  return { ...h, entries: [...h.entries, ...extra], leafId: 'role-compaction' };
}

it('P9 T04 round trips nine entries seven roles and additional references', () => {
  const history = mixed(); const original = JSON.stringify(history);
  expect(validateNativeHistory(history)).toEqual({ ok: true, data: undefined });
  const adapter = new PiAgentAdapter({ cwd });
  expect(adapter.restoreSession(history.header.id, history, seed(history), { commitRevision: 3, entryCount: history.entries.length, leafId: history.leafId }).ok).toBe(true);
  expect(adapter.exportSession(history.header.id)).toEqual({ ok: true, data: history });
  expect(JSON.stringify(history)).toBe(original);
  for (const mutation of [
    (h: NativeSessionHistory) => { h.leafId = 'missing'; },
    (h: NativeSessionHistory) => { (h.entries[0] as any).parentId = 'missing'; },
    (h: NativeSessionHistory) => { (h.entries.find(e => e.type === 'branch_summary') as any).fromId = 'missing'; },
    (h: NativeSessionHistory) => { (h.entries.find(e => e.id === 'role-branch') as any).message.fromId = 'missing'; },
    (h: NativeSessionHistory) => { (h.entries[0] as any).opaque = NaN; },
  ]) { const bad = structuredClone(history); mutation(bad); expect(validateNativeHistory(bad).ok).toBe(false); }
});

it('P9 T04 projects mixed native roles without breaking the existing chat query', () => {
  const history = mixed(); const original = JSON.stringify(history);
  const page = projectSessionMessages({ history, limit: 2, bindings: [], runInputs: [] });
  expect(page).toMatchObject({ ok: true, data: { items: [{ role: 'assistant' }, { role: 'toolResult' }] } });
  if (!page.ok) return;
  expect(projectSessionMessages({ history, limit: 2, bindings: [], runInputs: [], beforeEntryId: page.data.nextBeforeEntryId! }))
    .toMatchObject({ ok: true, data: { items: [{ role: 'user', blocks: [{ type: 'text', text: 'same' }] }], nextBeforeEntryId: null } });
  expect(JSON.stringify(history)).toBe(original);
});

it('P9 T04 requires complete origin seeds and mandatory receipts', () => {
  const manager = SessionManager.inMemory(cwd); manager.appendMessage({ role: 'user', content: 'same', timestamp: 1 });
  const history = snapshot(manager), recovery = seed(history), commit = { commitRevision: 3, entryCount: 1, leafId: history.leafId };
  for (const bad of [undefined, { ...recovery, origins: [] }, { ...recovery, origins: [...recovery.origins, ...recovery.origins] },
    { ...recovery, inputs: [{ ...recovery.inputs[0], originRunId: 55 }] }]) {
    const adapter = new PiAgentAdapter({ cwd });
    expect(adapter.restoreSession(history.header.id, history, bad as any, commit).ok).toBe(false);
  }
  expect(new PiAgentAdapter({ cwd }).restoreSession(history.header.id, history, recovery, { ...commit, entryCount: 0 }).ok).toBe(false);
});

it('P9 T04 distinguishes persist ordering and synchronously confirmed commits', () => {
  const adapter = new PiAgentAdapter({ cwd }); const created = adapter.createSession(); if (!created.ok) throw created.error;
  const nativeId = created.data.nativeSessionId, h = adapter.exportSession(nativeId); if (!h.ok) throw h.error;
  const writes: any[] = [];
  expect(adapter.watchSession(nativeId, { commitRevision: 1, entryCount: 0, leafId: null }, seed(h.data), write => {
    writes.push(structuredClone(write));
    return ok({ commitRevision: write.expected.commitRevision + 1, entryCount: write.history.entries.length, leafId: write.history.leafId });
  }).ok).toBe(true);
  const record = (adapter as any).sessions.get(nativeId);
  const id = record.manager.appendSessionInfo('saved');
  expect(writes).toHaveLength(1); expect(writes[0].contexts).toEqual([]);
  expect(record.lastSavedHistory.entries[0].id).toBe(id);
  record.manager._persist(record.manager.getEntry(id));
  expect(writes).toHaveLength(1); expect(record.receipt.commitRevision).toBe(2);
  record.manager.branch(id); expect(writes).toHaveLength(1);
  expect(adapter.watchSession(nativeId, { commitRevision: 2, entryCount: 1, leafId: id }, seed(record.lastSavedHistory), () => fail(appError('state_conflict', 'session', 'stale'))).ok).toBe(true);
  expect(() => record.manager.appendSessionInfo('failed')).toThrow();
  expect(record.lastSavedHistory.entries).toHaveLength(1); expect(adapter.inspect(nativeId).availability).toBe('unusable');
});

it('P9 T04 fork closes off-path summary references and related labels without files or registry mutation', () => {
  const root = mkdtempSync(join(tmpdir(), 'flowmate-p9-fork-'));
  try {
    const manager = SessionManager.inMemory(root), adapter = new PiAgentAdapter({ cwd: root });
    const first = manager.appendMessage({ role: 'user', content: 'root user', timestamp: 1 });
    const referenced = manager.appendMessage({ role: 'assistant', content: [{ type: 'text', text: 'referenced branch' }], api: 'openai-completions', provider: 'p9-fixture', model: 'M1', usage, stopReason: 'stop', timestamp: 2 });
    manager.appendLabelChange(referenced, 'related'); const label = manager.getLeafId()!;
    manager.branch(first);
    const unrelated = manager.appendMessage({ role: 'user', content: 'unrelated branch', timestamp: 3 });
    const source = snapshot(manager);
    const target = { id: 'selected-summary', parentId: first, timestamp: new Date().toISOString(), type: 'branch_summary', fromId: referenced, summary: 'selected path' };
    source.entries = [...source.entries, target]; source.leafId = target.id;
    const before = structuredClone(source), files = readdirSync(root);
    const fork = adapter.buildForkSessionHistory({ source, targetEntryId: target.id });
    expect(fork.ok).toBe(true);
    if (fork.ok) {
      expect(fork.data.entries.map(e => e.id)).toEqual([first, referenced, label, target.id]);
      expect(fork.data.entries.some(e => e.id === unrelated)).toBe(false);
      const selected = SessionManager.inMemory(root, undefined, [fork.data.header, ...fork.data.entries] as Parameters<typeof SessionManager.inMemory>[2]); selected.branch(target.id);
      expect(selected.buildSessionContext().messages).toHaveLength(2);
      expect(JSON.stringify(selected.buildSessionContext())).not.toContain('referenced branch');
    }
    expect(source).toEqual(before); expect(readdirSync(root)).toEqual(files); expect(adapter.inspect(source.header.id).availability).toBe('missing');
    const sentinel = structuredClone(source); (sentinel.entries.at(-1) as any).fromId = 'root'; expect(validateNativeHistory(sentinel).ok).toBe(true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it('P9 T04 rejects an inconsistent hard receipt without advancing saved history', () => {
  const adapter = new PiAgentAdapter({ cwd }); const created = adapter.createSession(); if (!created.ok) throw created.error;
  const nativeId = created.data.nativeSessionId, h = adapter.exportSession(nativeId); if (!h.ok) throw h.error;
  expect(adapter.watchSession(nativeId, { commitRevision: 1, entryCount: 0, leafId: null }, seed(h.data), write =>
    ok({ commitRevision: 3, entryCount: write.history.entries.length, leafId: write.history.leafId })).ok).toBe(true);
  const record = (adapter as any).sessions.get(nativeId);
  expect(() => record.manager.appendSessionInfo('unknown')).toThrow();
  expect(record.lastSavedHistory).toEqual(h.data);
});

it('P9 T04 inspects all positions and builds a detached reference closure without changing source', () => {
  const history = mixed(), original = structuredClone(history), adapter = new PiAgentAdapter({ cwd });
  const inspected = adapter.inspectSessionHistory({ history, seed: seed(history) });
  expect(inspected.ok).toBe(true);
  if (inspected.ok) expect(inspected.data.positions.find(p => p.entryId === history.entries[3]!.id)?.contextState).toBe('incomplete-tool-pair');
  const fork = adapter.buildForkSessionHistory({ source: history, targetEntryId: history.leafId! });
  expect(fork.ok).toBe(true);
  if (fork.ok) { expect(fork.data.header.id).not.toBe(history.header.id); expect(fork.data.entries).toEqual(history.entries); expect(fork.data.header.parentSession).toBeUndefined(); }
  expect(history).toEqual(original); expect(adapter.inspect(history.header.id).availability).toBe('missing');
});

async function realFixture(api: 'openai-completions' | 'openai-responses' | 'google-generative-ai' = 'openai-completions', images = false, collision = false, imageCapability = true, extraDerived = 0, storedModel = 'M1', reasoning = false) {
  const root = mkdtempSync(join(tmpdir(), 'flowmate-p9-memory-')); const payloads: any[] = [];
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    payloads.push(await request.json());
    if (api === 'openai-responses') {
      const item = { id: 'message-1', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'answer', annotations: [] }] };
      const events = [{ type: 'response.created', response: { id: 'response-1' } }, { type: 'response.output_item.added', output_index: 0, item: { ...item, content: [] } },
        { type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: 'answer' }, { type: 'response.output_item.done', output_index: 0, item },
        { type: 'response.completed', response: { id: 'response-1', status: 'completed', output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } }];
      return new Response(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
    }
    if (collision) return new Response('data: ' + JSON.stringify({ id: 'collision', choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'inherited-call', type: 'function', function: { name: 'probe', arguments: '{}' } }] }, finish_reason: 'tool_calls' }] }) + '\n\ndata: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
    const chunks = api === 'openai-completions' ? [
      { id: 'fixture-answer', model: 'M3', choices: [{ index: 0, delta: { role: 'assistant', content: 'answer' }, finish_reason: null }] },
      { id: 'fixture-answer', model: 'M3', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
    ] : [];
    return new Response(chunks.map(c => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
  } });
  const modelsPath = join(root, 'models.json');
  writeFileSync(modelsPath, JSON.stringify({ providers: { 'p9-fixture': { baseUrl: `http://127.0.0.1:${server.port}/v1`, api,
    models: [{ id: 'M3', name: 'M3', reasoning, input: imageCapability ? ['text', 'image'] : ['text'], contextWindow: 64000, maxTokens: 16384,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] } } }));
  let session!: AgentSession; let actualTools = 0;
  const tool = { name: 'probe', version: '1', label: 'Probe', description: 'fixture', effect: 'READ' as const, executionMode: 'parallel' as const, inputSchema: z.object({}).strict(), outputSchema: z.object({}).strict(), execute: async () => { actualTools++; return {}; } };
  const adapter = new PiAgentAdapter({ cwd: root, agentDir: root, credentials: new InMemoryCredentialStore(), runtimeApiKey: 'synthetic-fixture', tools: [tool], sessionSetup: s => { session = s; } });
  const manager = SessionManager.inMemory(root);
  manager.appendModelChange('p9-fixture', storedModel); manager.appendThinkingLevelChange('high');
  manager.appendMessage({ role: 'assistant', content: [{ type: 'text', text: 'prior' }], api, provider: 'p9-fixture', model: 'M2', usage, stopReason: 'stop', timestamp: 1 });
  if (collision) {
    manager.appendMessage({ role: 'assistant', content: [{ type: 'toolCall', id: 'inherited-call', name: 'probe', arguments: {} }], api, provider: 'p9-fixture', model: 'M2', usage, stopReason: 'toolUse', timestamp: 2 });
    manager.appendMessage({ role: 'toolResult', toolCallId: 'inherited-call', toolName: 'probe', content: [{ type: 'text', text: '{}' }], isError: false, timestamp: 3 });
  }
  manager.appendMessage({ role: 'bashExecution', command: 'fixture', output: 'same', cancelled: false, truncated: false, exitCode: 0, excludeFromContext: true, timestamp: 2 });
  manager.appendCustomMessageEntry('same', 'same', false);
  manager.appendCustomMessageEntry('same', 'same', true);
  manager.appendCustomEntry('metadata', { ignored: true });
  for (let i = 0; i < extraDerived; i++) manager.appendCustomMessageEntry('budget', 'same', false);
  if (images) {
    manager.appendMessage({ role: 'user', content: [{ type: 'text', text: 'restored image' }, { type: 'image', data: png, mimeType: 'image/png' }], timestamp: 3 });
    manager.appendCustomMessageEntry('image', [{ type: 'image', data: png, mimeType: 'image/png' }, { type: 'text', text: 'custom image' }], false);
  }
  const history = snapshot(manager), recovery = seed(history), commit = { commitRevision: 5, entryCount: history.entries.length, leafId: history.leafId };
  if (collision) Object.assign(recovery, { origins: recovery.origins.map(o => ({ ...o, originSessionId: 99 })) });
  const restored = adapter.restoreSession(history.header.id, history, recovery, commit); if (!restored.ok) throw restored.error;
  const writes: any[] = [];
  const watched = adapter.watchSession(history.header.id, commit, recovery, write => { writes.push(structuredClone(write)); return ok({ commitRevision: write.expected.commitRevision + 1, entryCount: write.history.entries.length, leafId: write.history.leafId }); });
  if (!watched.ok) throw watched.error;
  const config = { version: 1 as const, name: 'fixture', revision: 1, modelRef: { provider: 'p9-fixture', model: 'M3' },
    native: { authPath: join(root, 'unused.json'), modelsPath }, parameters: { maxRetries: 0 as const, maxRetryDelayMs: 1000 } };
  return { root, adapter, history, config, writes, payloads, actualTools: () => actualTools, session: () => session,
    close: async () => { await adapter.close(); server.stop(true); rmSync(root, { recursive: true, force: true }); } };
}

it('P9 T04 records effective prepare changes after restore without duplicate metadata', async () => {
  const f = await realFixture();
  try {
    const prepare = () => f.adapter.prepare(f.history.header.id, f.config, { timeoutMs: 3000, stopGraceMs: 100 }, new AbortController().signal);
    expect((await prepare()).ok).toBe(true);
    const entries = f.adapter.exportSession(f.history.header.id); if (!entries.ok) throw entries.error;
    expect(entries.data.entries.slice(f.history.entries.length).map(e => e.type)).toEqual(['model_change', 'thinking_level_change']);
    expect(f.writes.every(w => w.contexts.length === 0)).toBe(true);
    expect((await prepare()).ok).toBe(true); expect(f.writes).toHaveLength(2); expect(f.payloads).toHaveLength(0);
  } finally { await f.close(); }
});

it('P9 T04 maps excluded bash custom and summaries by actual conversion indexes', async () => {
  const f = await realFixture();
  try {
    expect((await f.adapter.prepare(f.history.header.id, f.config, { timeoutMs: 3000, stopGraceMs: 100 }, new AbortController().signal)).ok).toBe(true);
    const session = f.session(), record = (f.adapter as any).sessions.get(f.history.header.id);
    // A real active execution supplies the request authorization; conversion uses the installed Agent objects.
    record.active = { input: { verifyModelUse: () => ok(undefined) }, inputs: new Map(), failure: null, signal: new AbortController().signal };
    const actual = session.agent.state.messages;
    const converted = await session.agent.convertToLlm(actual);
    expect(converted).toHaveLength(3);
    expect(record.convertedOrigins.get(converted[1])).toMatchObject({ nativeEntryId: f.history.entries[4]!.id, contextMessageIndex: 2 });
    expect(record.convertedOrigins.get(converted[2])).toMatchObject({ nativeEntryId: f.history.entries[5]!.id, contextMessageIndex: 3 });
    const another = sessionEntryToContextMessages(session.sessionManager.getEntry(f.history.entries[4]!.id)!)[0]!;
    expect(another).not.toBe(actual[2]); expect(record.nativeObjects.has(another)).toBe(false);
    record.active = undefined;
  } finally { await f.close(); }
});

it('P9 T04 binds idle custom appended before its event using the actual Agent object', async () => {
  const f = await realFixture();
  try {
    const prepared = await f.adapter.prepare(f.history.header.id, f.config, { timeoutMs: 3000, stopGraceMs: 100 }, new AbortController().signal);
    if (!prepared.ok) throw prepared.error;
    await f.session().sendCustomMessage({ customType: 'idle', content: 'idle context', display: false });
    const record = (f.adapter as any).sessions.get(f.history.header.id), actual = f.session().messages.at(-1)!;
    expect(actual.role).toBe('custom');
    expect(record.nativeObjects.get(actual)?.entryId).toBe(f.session().sessionManager.getLeafId());
    expect(record.recoverySeed.origins.at(-1).originRunId).toBeNull();
    expect(f.writes.at(-1).contexts).toEqual([]); expect(f.payloads).toHaveLength(0);
  } finally { await f.close(); }
});


const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=';
for (const api of ['openai-completions', 'openai-responses'] as const) it(`P9 T04 validates images by structure origin model and codec: ${api}`, async () => {
  const f = await realFixture(api, true); const bindings: any[] = [], evidence: any[] = [];
  try {
    const prepared = await f.adapter.prepare(f.history.header.id, f.config, { timeoutMs: 3000, stopGraceMs: 100 }, new AbortController().signal);
    if (!prepared.ok) throw prepared.error;
    expect(f.session().model?.input).toEqual(['text', 'image']);
    const result = await prepared.data.execute({ runId: 9, sessionId: 7, inputId: 50, contextSnapshotId: 60, text: 'new input', promptText: 'new input', goal: 'test', messageTimestamp: 4,
      verifyModelUse: () => ok(undefined), verifyInputUse: () => ok(undefined), completeInputResult: () => ok(undefined),
      contextHooks: { bind: value => { bindings.push(value.binding); return ok(undefined); }, record: (_binding, update) => { evidence.push(update); return ok(undefined); },
        resolveToolResult: () => fail(appError('context_binding_unknown', 'runtime', 'No tool expected.')) } }, new AbortController().signal, () => {});
    expect(result.error).toBeNull(); expect(f.payloads).toHaveLength(1);
    expect(JSON.stringify(f.payloads[0]).split(`data:image/png;base64,${png}`).length - 1).toBe(2);
    expect(bindings[0].includedNativeContexts).toHaveLength(3);
    expect(JSON.stringify(bindings) + JSON.stringify(evidence)).not.toContain(png);
    expect(evidence.some(e => e.kind === 'sdk-payload' && e.inclusion === 'confirmed')).toBe(true);
  } finally { await f.close(); }
});

it('P9 T04 denies inherited tool IDs before actual request and executor effects', async () => {
  const f = await realFixture('openai-completions', false, true); let observed = 0, executed = 0, rejected = 0;
  try {
    const prepared = await f.adapter.prepare(f.history.header.id, f.config, { timeoutMs: 3000, stopGraceMs: 100 }, new AbortController().signal, { activeToolNames: ['probe'] });
    if (!prepared.ok) throw prepared.error;
    const assistantMessage = f.session().messages.find(m => m.role === 'assistant' && m.content.some(b => b.type === 'toolCall'))!;
    if (assistantMessage.role !== 'assistant') throw new Error('assistant required');
    const toolCall = assistantMessage.content.find(b => b.type === 'toolCall')!; if (toolCall.type !== 'toolCall') throw new Error('call required');
    expect(await f.session().agent.beforeToolCall!({ assistantMessage, toolCall, args: {}, context: { messages: f.session().messages, systemPrompt: '', tools: [] } })).toMatchObject({ block: true });
    const outcome = await prepared.data.execute({ runId: 9, sessionId: 7, text: 'call probe', goal: 'test', messageTimestamp: 4, verifyModelUse: () => ok(undefined),
      toolBinding: { context: { runId: 9, sessionId: 7, scope: { version: 2, allowedTools: ['probe'], allowedDocumentIds: [], allowedArtifactIds: [], allowedResourcePaths: [] } },
        observeRequest: () => { observed++; return ok(undefined); }, rejectRequest: () => { rejected++; return ok(undefined); }, recordDelivery: () => ok(undefined),
        execute: async () => { executed++; return { result: { status: 'succeeded', data: {} }, fatal: false }; } } }, new AbortController().signal, () => {});
    expect(outcome.error?.code).toBe('context_binding_conflict'); expect(f.payloads).toHaveLength(1);
    expect({ observed, executed, rejected, native: f.actualTools() }).toEqual({ observed: 0, executed: 0, rejected: 0, native: 0 });
  } finally { await f.close(); }
});

for (const reason of ['capability', 'codec', 'replaced-object', 'altered-payload'] as const)
it(`P9 T04 rejects image request before dispatch for ${reason}`, async () => {
  const f = await realFixture(reason === 'codec' ? 'google-generative-ai' : 'openai-completions', true, false, reason !== 'capability');
  try {
    const prepared = await f.adapter.prepare(f.history.header.id, f.config, { timeoutMs: 3000, stopGraceMs: 100 }, new AbortController().signal);
    if (!prepared.ok) throw prepared.error;
    if (reason === 'replaced-object') f.session().agent.transformContext = async messages => messages.map(m => m.role === 'custom' ? { ...m } : m);
    if (reason === 'altered-payload') {
      const stream = f.session().agent.streamFunction;
      f.session().agent.streamFunction = (model, context, options) => stream(model, context, { ...options, onPayload: payload => {
        const altered = structuredClone(payload) as { messages: { role: string; content: unknown }[] };
        altered.messages = altered.messages.map(m => m.role === 'user' ? { ...m, content: 'silently removed image' } : m); return altered;
      } });
    }
    const outcome = await prepared.data.execute({ runId: 9, sessionId: 7, inputId: 50, contextSnapshotId: 60, text: 'new input', promptText: 'new input', goal: 'test', messageTimestamp: 4,
      verifyModelUse: () => ok(undefined), verifyInputUse: () => ok(undefined), completeInputResult: () => ok(undefined),
      contextHooks: { bind: () => ok(undefined), record: () => ok(undefined), resolveToolResult: () => fail(appError('context_binding_unknown', 'runtime', 'No tools.')) } }, new AbortController().signal, () => {});
    expect(outcome.error?.code).toBe(reason === 'capability' ? 'agent_model_image_unsupported' : reason === 'codec' ? 'agent_image_history_blocked'
      : reason === 'replaced-object' ? 'context_binding_unknown' : 'context_payload_mismatch');
    expect(f.payloads).toHaveLength(0);
    const history = f.adapter.exportSession(f.history.header.id); expect(history.ok && JSON.stringify(history.data)).toContain(png);
  } finally { await f.close(); }
});



for (const count of [509, 510]) it(`P9 T04 budgets combined actual derived and input sources at ${count + 3}`, async () => {
  const f = await realFixture('openai-completions', false, false, true, count); const bindings: any[] = [];
  try {
    const prepared = await f.adapter.prepare(f.history.header.id, f.config, { timeoutMs: 10000, stopGraceMs: 100 }, new AbortController().signal);
    if (!prepared.ok) throw prepared.error;
    const outcome = await prepared.data.execute({ runId: 9, sessionId: 7, inputId: 50, contextSnapshotId: 60, text: 'new input', promptText: 'new input', goal: 'test', messageTimestamp: 4,
      verifyModelUse: () => ok(undefined), verifyInputUse: () => ok(undefined), completeInputResult: () => ok(undefined),
      contextHooks: { bind: value => { bindings.push(value.binding); return ok(undefined); }, record: () => ok(undefined), resolveToolResult: () => fail(appError('context_binding_unknown', 'runtime', 'No tools.')) } }, new AbortController().signal, () => {});
    expect(outcome.error?.code ?? null).toBe(count === 509 ? null : 'context_evidence_too_large');
    expect(f.payloads).toHaveLength(count === 509 ? 1 : 0);
    if (count === 509) { expect(bindings[0].includedBindings).toHaveLength(1); expect(bindings[0].includedNativeContexts).toHaveLength(511); }
    else expect(bindings).toHaveLength(0);
  } finally { await f.close(); }
});

it('P9 T04 failed effective prepare keeps acknowledged history and prevents any prompt', async () => {
  const f = await realFixture();
  try {
    const record = (f.adapter as any).sessions.get(f.history.header.id);
    const saved = structuredClone({ history: record.lastSavedHistory, receipt: record.receipt, seed: record.recoverySeed }); let attempts = 0;
    expect(f.adapter.watchSession(f.history.header.id, record.receipt, record.recoverySeed, () => { attempts++; return fail(appError('storage_write_failed', 'storage', 'controlled metadata failure')); }).ok).toBe(true);
    const prepare = () => f.adapter.prepare(f.history.header.id, f.config, { timeoutMs: 3000, stopGraceMs: 100 }, new AbortController().signal);
    expect(await prepare()).toMatchObject({ ok: false, error: { code: 'storage_write_failed' } });
    expect(await prepare()).toMatchObject({ ok: false, error: { code: 'storage_write_failed' } });
    expect(attempts).toBe(1); expect({ history: record.lastSavedHistory, receipt: record.receipt, seed: record.recoverySeed }).toEqual(saved); expect(f.payloads).toHaveLength(0);
  } finally { await f.close(); }
});


it('P9 T04 fix1 confirms an idle saved user without duplicating seed or receipt', async () => {
  const f = await realFixture();
  try {
    expect((await f.adapter.prepare(f.history.header.id, f.config, { timeoutMs: 3000, stopGraceMs: 100 }, new AbortController().signal)).ok).toBe(true);
    const record = (f.adapter as any).sessions.get(f.history.header.id);
    const id = record.manager.appendMessage({ role: 'user', content: 'idle native user', timestamp: 8 });
    const before = structuredClone({ saved: record.lastSavedHistory, seed: record.recoverySeed, receipt: record.receipt });
    const writes = f.writes.length;
    expect(() => record.manager._persist(record.manager.getEntry(id))).not.toThrow();
    expect({ saved: record.lastSavedHistory, seed: record.recoverySeed, receipt: record.receipt }).toEqual(before);
    expect(f.writes).toHaveLength(writes); expect(f.adapter.inspect(f.history.header.id).availability).toBe('ready');
    expect((await f.adapter.prepare(f.history.header.id, f.config, { timeoutMs: 3000, stopGraceMs: 100 }, new AbortController().signal)).ok).toBe(true);
    expect(f.payloads).toHaveLength(0);
    record.manager.getEntry(id).message.content = 'changed same ID';
    expect(() => record.manager._persist(record.manager.getEntry(id))).toThrow();
    expect({ saved: record.lastSavedHistory, seed: record.recoverySeed, receipt: record.receipt }).toEqual(before);
    expect(f.writes).toHaveLength(writes); expect(f.adapter.inspect(f.history.header.id).availability).toBe('unusable');
  } finally { await f.close(); }
});

it('P9 T04 fix1 retains real root label and compaction references in fork and actual request binding', async () => {
  const f = await realFixture(); const bindings: any[] = [];
  try {
    const header = SessionManager.inMemory(f.root).getHeader()!, timestamp = new Date(0).toISOString();
    const history: NativeSessionHistory = { storageVersion: 1, header, unusable: false, leafId: 'compact', entries: [
      { id: 'root', parentId: null, timestamp, type: 'message', message: { role: 'user', content: 'off-path real root', timestamp: 1 } },
      { id: 'label', parentId: 'root', timestamp, type: 'label', targetId: 'root', label: 'root label' },
      { id: 'selected', parentId: null, timestamp, type: 'message', message: { role: 'user', content: 'selected branch', timestamp: 2 } },
      { id: 'compact', parentId: 'selected', timestamp, type: 'compaction', summary: 'kept summary', firstKeptEntryId: 'root', tokensBefore: 10 },
    ] };
    expect(validateNativeHistory(history).ok).toBe(true);
    const before = structuredClone(history), files = readdirSync(f.root);
    const fork = f.adapter.buildForkSessionHistory({ source: history, targetEntryId: 'compact' });
    expect(fork.ok).toBe(true);
    if (fork.ok) expect(fork.data.entries).toEqual(history.entries);
    expect(history).toEqual(before); expect(readdirSync(f.root)).toEqual(files);
    expect(referenceIds(history.entries[1]!)).toEqual(['root']); expect(referenceIds(history.entries[3]!)).toEqual(['root']);
    for (const fromId of ['root', null]) {
      expect(referenceIds({ id: 'summary', parentId: null, timestamp, type: 'branch_summary', summary: 'summary', fromId })).toEqual([]);
      expect(referenceIds({ id: 'message', parentId: null, timestamp, type: 'message', message: { role: 'branchSummary', summary: 'summary', fromId, timestamp: 1 } })).toEqual([]);
    }
    const recovery = seed(history), commit = { commitRevision: 1, entryCount: history.entries.length, leafId: history.leafId };
    expect(f.adapter.restoreSession(header.id, history, recovery, commit).ok).toBe(true);
    expect(f.adapter.watchSession(header.id, commit, recovery, write => ok({ commitRevision: write.expected.commitRevision + 1,
      entryCount: write.history.entries.length, leafId: write.history.leafId })).ok).toBe(true);
    const prepared = await f.adapter.prepare(header.id, f.config, { timeoutMs: 3000, stopGraceMs: 100 }, new AbortController().signal);
    if (!prepared.ok) throw prepared.error;
    const outcome = await prepared.data.execute({ runId: 9, sessionId: 7, inputId: 50, contextSnapshotId: 60, text: 'new input', promptText: 'new input', goal: 'test', messageTimestamp: 4,
      verifyModelUse: () => ok(undefined), verifyInputUse: () => ok(undefined), completeInputResult: () => ok(undefined),
      contextHooks: { bind: value => { bindings.push(value.binding); return ok(undefined); }, record: () => ok(undefined), resolveToolResult: () => fail(appError('context_binding_unknown', 'runtime', 'No tools.')) } }, new AbortController().signal, () => {});
    expect(outcome.error).toBeNull(); expect(f.payloads).toHaveLength(1);
    expect(bindings[0].includedNativeContexts).toContainEqual(expect.objectContaining({ nativeEntryId: 'compact', referenceEntryIds: ['root'] }));
  } finally { await f.close(); }
});

it('P9 T09 observes effective model and same-process thinking metadata with exact acknowledged failure state', async () => {
  const f = await realFixture('openai-completions', false, false, true, 0, 'M3', true);
  try {
    const record = (f.adapter as any).sessions.get(f.history.header.id);
    const prepare = () => f.adapter.prepare(f.history.header.id, f.config, { timeoutMs: 3000, stopGraceMs: 100 }, new AbortController().signal);
    // The installed SDK resolves the later assistant's effective M2 over stored M3 metadata.
    expect(record.manager.buildSessionContext().model).toEqual({ provider: 'p9-fixture', modelId: 'M2' });
    expect(await prepare()).toMatchObject({ ok: true });
    expect(f.session().model?.id).toBe('M3');
    expect(record.lastSavedHistory.entries.slice(f.history.entries.length).map((e: any) => e.type)).toEqual(['model_change', 'thinking_level_change']);
    expect(record.receipt.commitRevision).toBe(7);
    const afterPrepare = structuredClone({ history: record.lastSavedHistory, receipt: record.receipt, seed: record.recoverySeed });
    expect(await prepare()).toMatchObject({ ok: true });
    expect({ history: record.lastSavedHistory, receipt: record.receipt, seed: record.recoverySeed }).toEqual(afterPrepare);
    // Use the actual SDK setter; append/dedupe is observed through the installed _persist shim.
    f.session().setThinkingLevel('low');
    const afterThinking = structuredClone({ history: record.lastSavedHistory, receipt: record.receipt, seed: record.recoverySeed });
    expect(afterThinking.receipt.commitRevision).toBe(8);
    expect(afterThinking.history.entries.at(-1)).toMatchObject({ type: 'thinking_level_change', thinkingLevel: 'low' });
    f.session().setThinkingLevel('low');
    expect(await prepare()).toMatchObject({ ok: true });
    expect({ history: record.lastSavedHistory, receipt: record.receipt, seed: record.recoverySeed }).toEqual(afterThinking);
    const prepared = need(await prepare());
    const outcome = await prepared.execute({ runId: 9, sessionId: 7, inputId: 50, contextSnapshotId: 60, text: 'T09 explicit model edge',
      promptText: 'T09 explicit model edge', goal: 'test', messageTimestamp: 4,
      verifyModelUse: () => ok(undefined), verifyInputUse: () => ok(undefined), completeInputResult: () => ok(undefined),
      contextHooks: { bind: () => ok(undefined), record: () => ok(undefined), resolveToolResult: () => fail(appError('context_binding_unknown', 'runtime', 'No tool expected')) }
    }, new AbortController().signal, () => {});
    expect(outcome.error).toBeNull(); expect(f.payloads).toHaveLength(1); expect(f.payloads[0].model).toBe('M3');
    const beforeFailure = structuredClone({ history: record.lastSavedHistory, receipt: record.receipt, seed: record.recoverySeed });
    let attempts = 0;
    expect(f.adapter.watchSession(f.history.header.id, record.receipt, record.recoverySeed, () => {
      attempts++; return fail(appError('storage_write_failed', 'storage', 'T09 controlled required save failure'));
    }).ok).toBe(true);
    expect(() => f.session().setThinkingLevel('high')).toThrow();
    expect(await prepare()).toMatchObject({ ok: false, error: { code: 'storage_write_failed' } });
    expect(await prepare()).toMatchObject({ ok: false, error: { code: 'storage_write_failed' } });
    expect(attempts).toBe(1);
    expect({ history: record.lastSavedHistory, receipt: record.receipt, seed: record.recoverySeed }).toEqual(beforeFailure);
    expect(f.payloads).toHaveLength(1);
    console.log('T09 installed SDK metadata', JSON.stringify({ effectiveBefore: 'M2', effectiveAfter: 'M3', afterPrepare, afterThinking, attempts, http: f.payloads.length }));
  } finally { await f.close(); }
});

function need<T>(result: Result<T>): T { if (!result.ok) throw new Error(result.error.code); return result.data; }
function reply(text = 'T09 controlled answer') {
  return new Response('data: ' + JSON.stringify({ choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: 'stop' }] })
    + '\n\ndata: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
}
async function begin(app: Application, input: SessionInputRequest) {
  let finish!: (event: AgentRunEvent & { type: 'run_finished' }) => void;
  const terminal = new Promise<AgentRunEvent & { type: 'run_finished' }>(resolve => { finish = resolve; });
  const accepted = need(await app.submitInput(input, { onEvent(event) { if (event.type === 'run_finished') finish(event); } }));
  return { accepted, terminal };
}
async function t09Fixture(ownedRoot?: string) {
  const root = ownedRoot ?? mkdtempSync(join(tmpdir(), 'flowmate-p9-t09-app-'));
  if (!ownedRoot) deferCleanup(() => rmSync(root, { recursive: true, force: true }));
  const api = 'openai-completions', imageCapability = true;
  const paths = { root: join(root, 'product'), databaseFile: join(root, 'product/data/app.sqlite'), logsDir: join(root, 'product/logs'), artifactsDir: join(root, 'product/artifacts'),
    outputsDir: join(root, 'product/outputs'), runtimeDir: join(root, 'product/runtime') };
  const payloads: any[] = [];
  let failSave: ((write: any) => boolean) | undefined;
  let replyTool: unknown, responseHook: (() => Response | Promise<Response>) | undefined;
  const calls = { http: 0, base: 0, observe: 0, execute: 0, enqueue: 0 };
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    payloads.push(await request.json()); calls.http++;
    if (responseHook) return responseHook();
    if (replyTool) {
      const tool = replyTool; replyTool = undefined;
      return new Response('data: ' + JSON.stringify({ choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0,
        id: 't07-original-call', type: 'function', function: { name: 'save_invoice_candidate', arguments: JSON.stringify(tool) } }] },
        finish_reason: 'tool_calls' }] }) + '\n\ndata: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
    }
    return reply('T09 controlled answer');
  } });
  deferCleanup(() => server.stop(true));
  const modelsPath = join(root, 'models.json');
  writeFileSync(modelsPath, JSON.stringify({ providers: { 't07-loopback': { baseUrl: `http://127.0.0.1:${server.port}/v1`, api,
    models: ['M1', 'M2', 'M3'].map(id => ({ id, name: id, reasoning: false, input: imageCapability ? ['text', 'image'] : ['text'],
      contextWindow: 128000, maxTokens: 16384, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } })) } } }));
  const config = (model = 'M1', retries: 0 | 1 = 0): ProviderConfig => ({ version: 1, name: 'T07', revision: 1,
    modelRef: { provider: 't07-loopback', model }, native: { authPath: join(root, 'unused.json'), modelsPath },
    parameters: { maxRetries: retries, maxRetryDelayMs: 100 } });
  let ownedStore: any;
  let app!: Application, adapter!: PiAgentAdapter, sdk!: AgentSession, ownedDb!: Database;
  const runtimeState = RuntimeService.prototype.state;
  RuntimeService.prototype.state = function (...args) {
    ownedStore = (this as any).dependencies.contextService.options.store; ownedDb = ownedStore.db; return runtimeState.apply(this, args);
  };
  deferCleanup(() => { RuntimeService.prototype.state = runtimeState; });
  const sql = <T>(fn: (db: Database) => T): T => fn(ownedDb);
  const open = async () => {
    app = need(await createApplication({ paths, invoiceSourceRoot: join(root, 'source'), logger: { write() {}, async close() {} }, agentFactory: tools => {
      adapter = new PiAgentAdapter({ cwd: paths.runtimeDir, agentDir: paths.runtimeDir, tools,
        credentials: new InMemoryCredentialStore(), runtimeApiKey: 'synthetic-t07',
        fetch: (input, init) => { calls.base++; return globalThis.fetch(input, init); }, sessionSetup(session) {
          sdk = session;
        } });
      const prepare = adapter.prepare.bind(adapter);
      adapter.prepare = async (...args) => {
        const prepared = await prepare(...args); if (!prepared.ok) return prepared;
        const execute = prepared.data.execute;
        return { ...prepared, data: { ...prepared.data, async execute(input, signal, observe) {
          const binding = input.toolBinding;
          return execute({ ...input,
            ...(binding ? { toolBinding: { ...binding,
              observeRequest(...call) { calls.observe++; return binding.observeRequest(...call); },
              execute(...call) { calls.execute++; return binding.execute(...call); } } } : {}) }, signal, observe);
        } } };
      };
      const enqueue = adapter.enqueueInput.bind(adapter); adapter.enqueueInput = (...args) => { calls.enqueue++; return enqueue(...args); };
      const watch = adapter.watchSession.bind(adapter);
      adapter.watchSession = (id, receipt, seed, write) => watch(id, receipt, seed, value =>
        failSave?.(value)
          ? fail(appError('storage_write_failed', 'storage', 'Controlled T09 native commit failure.')) : write(value));
      return adapter;
    } }));
    await app.queryRuntimeState();
    const opened = app; deferCleanup(() => opened.close()); return app;
  };
  await open();
  const session = need(await app.createSession({ title: 'T07 source', expectedRevision: need(await app.readWorkspace()).revision }));
  const input = async (sessionId: number, sequence: number, text: string, model = 'M1', material = false, retries: 0 | 1 = 0) => {
    const workspace = need(await app.readWorkspace());
    return begin(app, { sessionId, clientSequence: sequence, mode: 'prompt', text, config: config(model, retries), timeoutMs: 7000, stopGraceMs: 500,
      ...(material ? { goalMode: 'save-candidate' as const, workspace: { revision: workspace.revision, documentRef: workspace.documentRef,
        jobId: workspace.jobId, candidateRef: workspace.candidateRef, sessionId } } : {}) });
  };
  const fork = async (sourceSessionId: number, targetEntryId?: string) => {
    const page = need(await app.querySessionHistory({ sessionId: sourceSessionId }));
    return need(await app.forkSession({ sourceSessionId, expected: page.commit, targetEntryId: targetEntryId ?? page.commit.leafId!,
      title: 'T07 fork', clientOperationId: crypto.randomUUID() }));
  };
  const branch = async (sessionId: number, targetEntryId: string) => {
    const page = need(await app.querySessionHistory({ sessionId }));
    return need(await app.branchSession({ sessionId, targetEntryId, expectedCommitRevision: page.commit.commitRevision,
      expectedEntryCount: page.commit.entryCount, expectedLeafId: page.commit.leafId }));
  };
  const counts = () => sql(db => Object.fromEntries(['runs', 'session_inputs', 'context_snapshots', 'tool_calls', 'invoice_candidates'].map(t => [t,
    (db.query(`SELECT COUNT(*) n FROM ${t}`).get() as { n: number }).n])));
  const facts = (sessionId: number) => sql(db => ({ runs: db.query('SELECT * FROM runs WHERE session_id=? ORDER BY id').all(sessionId),
    inputs: db.query('SELECT * FROM session_inputs WHERE session_id=? ORDER BY id').all(sessionId),
    tools: db.query('SELECT * FROM tool_calls WHERE run_id IN (SELECT id FROM runs WHERE session_id=?) ORDER BY id').all(sessionId),
    snapshots: db.query('SELECT * FROM context_snapshots WHERE session_id=? ORDER BY id').all(sessionId),
    jobs: db.query('SELECT * FROM jobs ORDER BY id').all(),
    candidates: db.query('SELECT * FROM invoice_candidates ORDER BY id').all() }));
  const journal = (runId: number) => sql(db => JSON.parse((db.query('SELECT context_observations_json FROM runs WHERE id=?').get(runId) as any).context_observations_json));
  const material = async () => {
    const source = join(root, 'source/000001'); mkdirSync(source, { recursive: true });
    const original = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/a54AAAAASUVORK5CYII=', 'base64'), content = JSON.stringify([{ type: 'text', text: 'T07 invoice 113.00', bbox: [0, 0, 1, 1], page_idx: 0 }]);
    const pages = JSON.stringify([{ pageNumber: 1, text: 'T07 invoice 113.00', blockCount: 1 }]);
    writeFileSync(join(source, 'original.png'), original); writeFileSync(join(source, 'content.json'), content); writeFileSync(join(source, 'pages.json'), pages);
    writeFileSync(join(source, 'metadata.json'), JSON.stringify({ schemaVersion: 1, sampleId: '000001', datasetId: 'voxel51-hq-invoice-ocr',
      sourceRecordId: 'synthetic-t07', datasetRevision: 'fixture', qualityStatus: 'complete', allowedUsesClaim: ['local test'], licenseVerification: 'not_verified',
      files: [{ path: 'original.png', bytes: original.length }, { path: 'content.json', bytes: Buffer.byteLength(content) }, { path: 'pages.json', bytes: Buffer.byteLength(pages) }] }));
    const document = need(await app.importInvoiceMaterial(source)), documentId = document.documentRef.id;
    const selected = need(await app.updateWorkspace({ expectedRevision: need(await app.readWorkspace()).revision, change: { kind: 'document', documentId } }));
    const task = need(await app.startTask({ clientSequence: 1, expectedRevision: selected.revision, documentRef: document.documentRef, goal: 'T07 save actual candidate' }));
    const page = need(await app.readDocumentPage({ documentId, page: 1, afterBlockId: null, limit: 50 }));
    const missing = { raw: null, normalized: null, state: 'missing', alternatives: [], sources: [] };
    const candidate = CandidateDraftSchema.parse({ fields: { ...Object.fromEntries(invoiceHeaderFields.map(name => [name, missing])),
      totalAmount: { raw: '113.00', normalized: '113.00', state: 'present', alternatives: [], sources: [{ documentId, version: document.documentRef.version,
        artifactId: document.parsedArtifactId, page: 1, blockId: page.blocks[0]!.id, quote: '113.00' }] } }, lines: [], notes: [] });
    replyTool = { documentId, candidate };
    const run = await input(session.sessionId, 1, 'Original invoice request', 'M1', true);
    expect((await run.terminal).result).toMatchObject({ ok: true, data: { status: 'completed' } });
    expect(calls).toMatchObject({ http: 2, base: 2, observe: 1, execute: 1 });
    const saved = need(await app.listJobCandidates({ jobId: task.job.jobId })).items;
    expect(saved).toHaveLength(1); expect(saved[0]!.context).toMatchObject({ snapshotId: expect.any(Number), requestSequence: 1 });
    return { run, tool: { documentId, candidate }, saved: saved[0]! };
  };
  const durable = (sessionId: number) => ({
    header: ownedDb.query('SELECT * FROM session_native_history WHERE session_id=?').get(sessionId),
    entries: ownedDb.query('SELECT * FROM session_native_entries WHERE session_id=? ORDER BY sequence').all(sessionId),
    stored: need(ownedStore.memory.load(sessionId)), bundle: need(ownedStore.sessions.loadHistoryForContext(sessionId)),
    facts: facts(sessionId), fk: ownedDb.query('PRAGMA foreign_key_check').all(),
  });
  return { durable, paths, session, config, input, fork, branch, counts, facts, journal, material, open, sql, calls, payloads,
    get app() { return app; }, get adapter() { return adapter; }, get sdk() { return sdk; },
    failSave(fn: typeof failSave) { failSave = fn; },
    committed(fn: (refs: unknown) => void) { return ownedStore.runtimeEventStore.onCommitted(fn); },
    respond(fn: typeof responseHook) { responseHook = fn; } };
}


it('P9 T09 reopens a corrected nested fork and sends one explicit run through the public chain', async () => {
  const f = await t09Fixture(), original = await f.material(), a = f.session.sessionId;
  const base = need(await f.app.querySessionHistory({ sessionId: a })).commit.leafId!;
  const abandoned = await f.input(a, 2, 'ABANDONED amount 999', 'M2'); expect((await abandoned.terminal).result.ok).toBe(true);
  await f.branch(a, base);
  const corrected = await f.input(a, 3, 'CORRECTED amount 113', 'M2'); expect((await corrected.terminal).result.ok).toBe(true);
  const b = await f.fork(a);
  const parentRun = await f.input(b.session.sessionId, 1, 'PARENT local correction 113', 'M2');
  expect((await parentRun.terminal).result).toMatchObject({ ok: true, data: { status: 'completed' } });
  const before = f.facts(a), count = f.counts(), effects = { ...f.calls };
  const c = await f.fork(b.session.sessionId);
  const durable = [a, b.session.sessionId, c.session.sessionId].map(id => f.durable(id));
  expect(f.counts()).toEqual(count); expect(f.calls).toEqual(effects);
  need(await f.app.close()); await f.open();
  for (const [index, id] of [a, b.session.sessionId, c.session.sessionId].entries()) {
    need(await f.app.querySessionHistory({ sessionId: id }));
    expect(f.durable(id)).toEqual(durable[index]);
  }
  need(await f.app.queryRun(parentRun.accepted.runId));
  need(await f.app.querySessionInput({ sessionId: b.session.sessionId, inputId: parentRun.accepted.inputId }));
  need(await f.app.listContextRequests({ sessionId: b.session.sessionId, runId: parentRun.accepted.runId }));
  need(await f.app.queryRun(original.run.accepted.runId));
  need(await f.app.querySessionInput({ sessionId: a, inputId: original.run.accepted.inputId }));
  need(await f.app.listContextRequests({ sessionId: a, runId: original.run.accepted.runId }));
  expect(f.facts(a)).toEqual(before); expect(f.counts()).toEqual(count); expect(f.calls).toEqual(effects);
  const next = await f.input(c.session.sessionId, 1, 'Use selected correction', 'M3');
  expect((await next.terminal).result).toMatchObject({ ok: true, data: { status: 'completed' } });
  expect(f.counts()).toEqual({ ...count, runs: count.runs! + 1, session_inputs: count.session_inputs! + 1, context_snapshots: count.context_snapshots! + 1 });
  expect(f.calls).toMatchObject({ http: effects.http + 1, base: effects.base + 1, execute: 1, observe: 1 });
  const wire = JSON.stringify(f.payloads.at(-1)); expect(wire).toContain('CORRECTED amount 113'); expect(wire).not.toContain('ABANDONED amount 999');
  expect(wire).toContain('t07-original-call'); expect(wire).toContain('113.00'); expect(f.payloads.at(-1).model).toBe('M3');
  const input = need(await f.app.querySessionInput({ sessionId: c.session.sessionId, inputId: next.accepted.inputId })).input!;
  const request = f.journal(next.accepted.runId).requests[0];
  expect(request.binding).toMatchObject({ sessionId: c.session.sessionId, inputId: next.accepted.inputId, snapshotId: input.contextSnapshotId,
    includedNativeContexts: [] });
  expect(request.binding.includedBindings.map((v: any) => v.inputId)).toEqual([original.run.accepted.inputId, corrected.accepted.inputId, parentRun.accepted.inputId, next.accepted.inputId]);
  expect(request.sdkPayload.inclusion).toBe('confirmed'); expect(request.attempts[0].wireInclusion).toBe('confirmed');
  const originalTool = request.binding.includedToolResults[0];
  expect(originalTool).toMatchObject({ originRunId: original.run.accepted.runId, nativeToolCallId: 't07-original-call' });
  const toolView = need(await f.app.queryRunToolCall({ sessionId: a, runId: original.run.accepted.runId, toolCallId: originalTool.toolCallId }));
  expect(toolView).toMatchObject({ toolCallId: originalTool.toolCallId, status: 'succeeded' });
  const originalSnapshot = need(await f.app.queryContextSnapshot({ sessionId: a, runId: original.run.accepted.runId, snapshotId: originalTool.context.snapshotId }));
  expect(originalSnapshot.snapshot.id).toBe(originalTool.context.snapshotId);
  const targetSnapshot = need(await f.app.queryContextSnapshot({ sessionId: c.session.sessionId, runId: next.accepted.runId, snapshotId: input.contextSnapshotId! }));
  expect(targetSnapshot.snapshot.id).not.toBe(originalSnapshot.snapshot.id);
  expect(f.facts(a)).toEqual(before);
  expect(f.durable(a)).toEqual(durable[0]); expect(f.durable(b.session.sessionId)).toEqual(durable[1]);
  expect(wire).toContain('PARENT local correction 113');
  console.log('T09 selected real effects', JSON.stringify({ before: effects, after: f.calls, counts: f.counts() }));
});


// This case exists only in the positively owned subprocess. The parent receives
// the last acknowledged snapshot over IPC and kills it while the SDK awaits HTTP.
if (process.env.FLOWMATE_T09_CHILD_ROOT) it('P9 T09 child fixture', async () => {
  const f = await t09Fixture(process.env.FLOWMATE_T09_CHILD_ROOT), original = await f.material();
  let entered!: () => void;
  const held = new Promise<void>(resolve => { entered = resolve; });
  f.respond(async () => { entered(); await new Promise(() => {}); return reply(); });
  const active = await f.input(f.session.sessionId, 2, 'T09 consumed primary before process death');
  await held;
  const queued = need(await f.app.submitInput({ sessionId: f.session.sessionId, runId: active.accepted.runId,
    clientSequence: 3, mode: 'followUp', text: 'T09 QUEUED NEVER CONSUMED' }));
  const consumed = need(await f.app.querySessionInput({ sessionId: f.session.sessionId, inputId: active.accepted.inputId })).input!;
  const followUp = need(await f.app.querySessionInput({ sessionId: f.session.sessionId, inputId: queued.inputId })).input!;
  expect(consumed.status).toBe('consumed'); expect(typeof consumed.nativeEntryId).toBe('string');
  expect(followUp).toMatchObject({ status: 'queued', nativeEntryId: null });
  process.send!(JSON.stringify({ phase: 'durable-active', pid: process.pid, paths: f.paths, session: f.session, original: original.run.accepted,
    active: active.accepted, queued, consumed, followUp, durable: f.durable(f.session.sessionId), calls: { ...f.calls } }));
  await new Promise(() => {});
});

it('P9 T09 first cold opener preserves the exact acknowledged native prefix after active process death', async () => {
  const root = mkdtempSync(join(tmpdir(), 'flowmate-p9-t09-kill-'));
  deferCleanup(() => rmSync(root, { recursive: true, force: true }));
  let acknowledged: any;
  const child = Bun.spawn([process.execPath, '--no-env-file', 'test', '--isolate', '--timeout', '15000', import.meta.path,
    '--test-name-pattern', '^P9 T09 child fixture$'], { cwd: process.cwd(), env: { ...process.env, FLOWMATE_T09_CHILD_ROOT: root },
    stdout: 'pipe', stderr: 'pipe', ipc(message) { acknowledged = JSON.parse(String(message)); } });
  const stdout = new Response(child.stdout).text(), stderr = new Response(child.stderr).text();
  try {
    await waitFor(async () => acknowledged?.phase === 'durable-active', 7000);
    expect(acknowledged.pid).toBe(child.pid);
    expect(acknowledged.calls).toMatchObject({ http: 3, base: 3, execute: 1, observe: 1, enqueue: 1 });
    expect(acknowledged.durable.fk).toEqual([]);
    const killedAt = Date.now(); child.kill(); const exit = await child.exited;
    expect(exit).toBe(143); expect(child.signalCode).toBe('SIGTERM');
    console.log('T09 child process death', JSON.stringify({ pid: child.pid, exit, signal: child.signalCode,
      stdout: await stdout, stderr: await stderr, acknowledged }));
    // No raw reader precedes this open: this is the very first post-death SQLite
    // opener and executes the product's actual original boot repair transaction.
    const first = need(openDatabase(acknowledged.paths));
    const capture = (store: typeof first) => ({
      header: store.db.query('SELECT * FROM session_native_history WHERE session_id=?').get(acknowledged.session.sessionId),
      entries: store.db.query('SELECT * FROM session_native_entries WHERE session_id=? ORDER BY sequence').all(acknowledged.session.sessionId),
      stored: need(store.memory.load(acknowledged.session.sessionId)),
      bundle: need(store.sessions.loadHistoryForContext(acknowledged.session.sessionId)),
      runs: store.db.query('SELECT * FROM runs ORDER BY id').all(), inputs: store.db.query('SELECT * FROM session_inputs ORDER BY id').all(),
      tools: store.db.query('SELECT * FROM tool_calls ORDER BY id').all(), candidates: store.db.query('SELECT * FROM invoice_candidates ORDER BY id').all(),
      jobs: store.db.query('SELECT * FROM jobs ORDER BY id').all(), snapshots: store.db.query('SELECT * FROM context_snapshots ORDER BY id').all(),
      events: store.db.query('SELECT * FROM runtime_events ORDER BY id').all(), fk: store.db.query('PRAGMA foreign_key_check').all(),
    });
    let repaired: ReturnType<typeof capture>;
    try {
      repaired = capture(first);
      const before = acknowledged.durable;
      expect(repaired.header).toEqual({ ...before.header, unusable: 1, commit_revision: before.header.commit_revision + 1 });
      expect(repaired.entries).toEqual(before.entries);
      expect(repaired.stored).toEqual({ history: { ...before.stored.history, unusable: true },
        commit: { ...before.stored.commit, commitRevision: before.stored.commit.commitRevision + 1 } });
      expect(repaired.bundle.seed).toEqual(before.bundle.seed);
      expect(repaired.bundle.commit).toEqual(repaired.stored!.commit);
      expect(repaired.bundle.seed.origins).toHaveLength(before.entries.length);
      expect(new Set(repaired.bundle.seed.origins.map(o => o.nativeEntryId)).size).toBe(before.entries.length);
      expect(repaired.bundle.seed.inputs.some(i => i.inputId === acknowledged.queued.inputId)).toBe(false);
      expect(repaired.inputs.find((i: any) => i.id === acknowledged.active.inputId)).toMatchObject({ status: 'consumed',
        native_entry_id: acknowledged.consumed.nativeEntryId, processing_status: 'failed' });
      expect(repaired.inputs.find((i: any) => i.id === acknowledged.queued.inputId)).toMatchObject({ status: 'delivery_unknown', native_entry_id: null,
        processing_status: 'failed' });
      expect(repaired.runs.find((r: any) => r.id === acknowledged.original.runId)).toEqual(before.facts.runs.find((r: any) => r.id === acknowledged.original.runId));
      expect(repaired.runs.find((r: any) => r.id === acknowledged.active.runId)).toMatchObject({ status: 'failed', stopped_at: null });
      expect(repaired.inputs.find((i: any) => i.id === acknowledged.original.inputId)).toEqual(before.facts.inputs.find((i: any) => i.id === acknowledged.original.inputId));
      expect(repaired.tools).toEqual(before.facts.tools); expect(repaired.candidates).toEqual(before.facts.candidates); expect(repaired.fk).toEqual([]);
      expect(repaired.jobs).toEqual(before.facts.jobs); expect(repaired.snapshots).toEqual(before.facts.snapshots);
      console.log('T09 first cold repair', JSON.stringify(repaired));
    } finally { first.close(); }
    const second = need(openDatabase(acknowledged.paths));
    try { expect(capture(second)).toEqual(repaired!); } finally { second.close(); }
    // Actual Application ownership is a 15s stale lease; do not delete its lock.
    await waitFor(async () => {
      try { return Date.now() - statSync(acknowledged.paths.databaseFile + '.lock').mtimeMs > 15_000; }
      catch { return true; }
    }, 20_000);
    console.log('T09 actual lease condition', JSON.stringify({ killedAt, readyAt: Date.now(),
      lockMtimeMs: statSync(acknowledged.paths.databaseFile + '.lock').mtimeMs }));
    let http = 0, prepares = 0, enqueues = 0;
    const app = need(await createApplication({ paths: acknowledged.paths, invoiceSourceRoot: join(root, 'source'),
      logger: { write() {}, async close() {} }, agentFactory: tools => {
        const adapter = new PiAgentAdapter({ cwd: acknowledged.paths.runtimeDir, agentDir: acknowledged.paths.runtimeDir, tools,
          credentials: new InMemoryCredentialStore(), runtimeApiKey: 'synthetic-t09-cold', fetch: (input, init) => { http++; return fetch(input, init); } });
        const prepare = adapter.prepare.bind(adapter), enqueue = adapter.enqueueInput.bind(adapter);
        adapter.prepare = (...args) => { prepares++; return prepare(...args); };
        adapter.enqueueInput = (...args) => { enqueues++; return enqueue(...args); }; return adapter;
      } }));
    try {
      need(await app.querySessionHistory({ sessionId: acknowledged.session.sessionId }));
      need(await app.queryRun(acknowledged.original.runId));
      need(await app.listContextRequests({ sessionId: acknowledged.session.sessionId, runId: acknowledged.original.runId }));
      expect(need(await app.querySessionInput({ sessionId: acknowledged.session.sessionId, inputId: acknowledged.queued.inputId })).input)
        .toMatchObject({ status: 'delivery_unknown', nativeEntryId: null });
      expect(need(await app.querySessionInput({ sessionId: acknowledged.session.sessionId, inputId: acknowledged.active.inputId })).input)
        .toMatchObject({ status: 'consumed', nativeEntryId: acknowledged.consumed.nativeEntryId });
      expect({ http, prepares, enqueues }).toEqual({ http: 0, prepares: 0, enqueues: 0 });
    } finally { need(await app.close()); }
    console.log('T09 no recovery effects', JSON.stringify({ http, prepares, enqueues, childExit: exit, fk: repaired!.fk }));
  } finally {
    if (child.exitCode === null) { child.kill(); await child.exited; }
    console.log('T09 child final transport', JSON.stringify({ exit: child.exitCode, signal: child.signalCode, stdout: await stdout, stderr: await stderr }));
  }
}, 30_000);

for (const fault of ['saved-block', 'ignored-block', 'exhausted-block', 'already-sticky-max'] as const)
  it(`P9 T09 all legacy unusable writers advance revision in original recovery transactions: W6 actual failed finish ${fault}`, async () => {
    const f = await t09Fixture(), original = await f.material(), sessionId = f.session.sessionId;
    f.sql(db => {
      db.exec("CREATE TRIGGER t09_finish_fail BEFORE UPDATE ON runs WHEN NEW.status='failed' BEGIN SELECT RAISE(ABORT,'T09 finish rollback'); END");
      if (fault === 'ignored-block') db.exec('CREATE TRIGGER t09_block_ignore BEFORE UPDATE OF unusable ON session_native_history WHEN NEW.unusable=1 BEGIN SELECT RAISE(IGNORE); END');
    });
    let failedPrefix: any, fullBefore: any, notifications: unknown[] = [];
    const all = () => f.sql(db => Object.fromEntries(['runs', 'jobs', 'tool_calls', 'session_inputs', 'session_native_entries', 'runtime_events']
      .map(table => [table, db.query(`SELECT * FROM ${table} ORDER BY rowid`).all()])));
    f.failSave(write => {
      const last = write.history.entries.at(-1);
      if (last?.type !== 'message' || last.message.role !== 'assistant') return false;
      if (fault === 'exhausted-block' || fault === 'already-sticky-max') f.sql(db =>
        db.query('UPDATE session_native_history SET commit_revision=?,unusable=? WHERE session_id=?')
          .run(Number.MAX_SAFE_INTEGER, fault === 'already-sticky-max' ? 1 : 0, sessionId));
      failedPrefix = f.sql(db => ({ header: db.query('SELECT * FROM session_native_history WHERE session_id=?').get(sessionId),
        entries: db.query('SELECT * FROM session_native_entries WHERE session_id=? ORDER BY sequence').all(sessionId) }));
      fullBefore = all(); f.committed(refs => notifications.push(refs));
      return true;
    });
    const failed = await f.input(sessionId, 2, 'T09 actual SDK save failure');
    const terminal = await failed.terminal;
    expect(failedPrefix).toBeDefined();
    expect(terminal.result).toMatchObject({ ok: false, error: { code: fault === 'ignored-block' ? 'state_conflict' : 'storage_write_failed' } });
    const head = f.sql(db => db.query('SELECT * FROM session_native_history WHERE session_id=?').get(sessionId));
    expect(head).toEqual(fault === 'saved-block' ? { ...failedPrefix.header, unusable: 1, commit_revision: failedPrefix.header.commit_revision + 1 } : failedPrefix.header);
    expect(all()).toEqual(fullBefore); expect(notifications).toEqual([]);
    expect(need(await f.app.queryRun(failed.accepted.runId))).toMatchObject({ status: 'running', endedAt: null, stoppedAt: null });
    expect(need(await f.app.queryRun(original.run.accepted.runId))).toMatchObject({ status: 'completed' });
    expect(await f.app.submitInput({ sessionId, clientSequence: 3, mode: 'prompt', text: 'Never replay', config: f.config() }))
      .toMatchObject({ ok: false, error: { code: 'runtime_unusable' } });
    expect(f.calls).toMatchObject({ http: 3, base: 3, execute: 1, observe: 1 });
    expect(f.sql(db => db.query('PRAGMA foreign_key_check').all())).toEqual([]);
    console.log('T09 W6 actual SDK', JSON.stringify({ fault, terminal, before: failedPrefix.header, after: head,
      notifications: notifications.length, calls: f.calls }));
  });

it('P9 T09 measures a long legal tree and exact detached fork without speculative caching', () => {
  const manager = SessionManager.inMemory(cwd), adapter = new PiAgentAdapter({ cwd });
  const start = performance.now();
  for (let n = 0; n < 1200; n++) manager.appendMessage({ role: 'user', content: `legal ${n}`, timestamp: n });
  const selected = manager.getLeafId()!, first = manager.getEntries()[0]!.id;
  for (let n = 0; n < 300; n++) { manager.branch(first); manager.appendMessage({ role: 'user', content: `other branch ${n}`, timestamp: 1200 + n }); }
  const history = snapshot(manager), builtMs = performance.now() - start, before = JSON.stringify(history);
  const inspectStart = performance.now(); expect(validateNativeHistory(history).ok).toBe(true); const validationMs = performance.now() - inspectStart;
  const forkStart = performance.now(), fork = need(adapter.buildForkSessionHistory({ source: history, targetEntryId: selected }));
  const forkMs = performance.now() - forkStart;
  expect(fork.entries).toEqual(history.entries.slice(0, 1200)); expect(fork.leafId).toBe(selected);
  expect(fork.header.id).not.toBe(history.header.id); expect(JSON.stringify(history)).toBe(before);
  console.log('T09 long legal tree', JSON.stringify({ entries: history.entries.length, forkEntries: fork.entries.length, builtMs, validationMs, forkMs }));
});


it('P9 T09 preserves Document rows during real concurrent artifact root rename and public read', async () => {
  const f = await t09Fixture(), original = await f.material();
  const before = f.sql(db => db.query('SELECT * FROM documents ORDER BY id').all());
  const artifactRoot = f.paths.artifactsDir, held = artifactRoot + '.t09-held';
  const child = Bun.spawn([process.execPath, '--no-env-file', '--eval', `
    const fs = require('node:fs'), p = require('node:path');
    const [owner, original, held] = process.argv.slice(1);
    for (const value of [original, held]) { const rel = p.relative(p.resolve(owner), p.resolve(value));
      if (!rel || rel.startsWith('..') || p.isAbsolute(rel)) throw new Error('not owned'); }
    const startedAt = Date.now(), deadline = startedAt + 3500; let moves = 0;
    process.send('ready'); await Bun.sleep(100);
    try { while (Date.now() < deadline) { try { fs.renameSync(original, held); moves++; } catch {} try { fs.renameSync(held, original); } catch {} } }
    finally { if (fs.existsSync(held) && !fs.existsSync(original)) fs.renameSync(held, original); }
    process.send(JSON.stringify({ moves, startedAt, endedAt: Date.now() }));
  `, f.paths.root, artifactRoot, held], { env: { ...process.env }, stdout: 'pipe', stderr: 'pipe', ipc(message) { messages.push(String(message)); } });
  const messages: string[] = [], stdout = new Response(child.stdout).text(), stderr = new Response(child.stderr).text();
  let observed: unknown, reads = 0;
  try {
    await waitFor(async () => messages.includes('ready'), 2000);
    const deadline = Date.now() + 4500;
    for (let n = 0; n < 20000 && Date.now() < deadline; n++) {
      if (n % 16 === 0) await Bun.sleep(0);
      const result = await f.app.readDocumentPage({ documentId: original.tool.documentId, page: 1, afterBlockId: null, limit: 50 });
      reads++;
      const after = f.sql(db => db.query('SELECT * FROM documents ORDER BY id').all());
      if (JSON.stringify(after) !== JSON.stringify(before)) { observed = { n, result, before, after }; break; }
      if (child.exitCode !== null) break;
    }
    const exit = await child.exited;
    expect(observed).toBeUndefined(); expect(exit).toBe(0);
    expect(f.sql(db => db.query('SELECT * FROM documents ORDER BY id').all())).toEqual(before);
    expect(await f.app.readDocumentPage({ documentId: original.tool.documentId, page: 1, afterBlockId: null, limit: 50 })).toMatchObject({ ok: true });
    console.log('T09 workspace real rename diagnostic', JSON.stringify({ exit, reads, messages, stdout: await stdout, stderr: await stderr, observed,
      restoredRoot: statSync(artifactRoot).isDirectory(), readAfter: await f.app.readDocumentPage({ documentId: original.tool.documentId, page: 1, afterBlockId: null, limit: 50 }) }));
  } finally { if (child.exitCode === null && child.signalCode === null) { child.kill(); await child.exited; }
    console.log('T09 rename transport', JSON.stringify({ messages, stdout: await stdout, stderr: await stderr })); }
});
