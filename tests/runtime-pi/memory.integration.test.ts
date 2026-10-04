import { z } from 'zod';
import { expect, it } from 'bun:test';
import { SessionManager, sessionEntryToContextMessages } from '@earendil-works/pi-coding-agent';
import type { NativeSessionHistory, NativeHistoryRecoverySeed } from '@flowmate/contracts';
import { PiAgentAdapter } from '../../packages/runtime-pi/src/session.ts';
import { referenceIds } from '../../packages/runtime-pi/src/memory/history.ts';
import { appError, fail, ok } from '@flowmate/contracts';
import { mkdtempSync, writeFileSync, rmSync, readdirSync } from 'node:fs';
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

async function realFixture(api: 'openai-completions' | 'openai-responses' | 'google-generative-ai' = 'openai-completions', images = false, collision = false, imageCapability = true, extraDerived = 0) {
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
    models: [{ id: 'M3', name: 'M3', reasoning: false, input: imageCapability ? ['text', 'image'] : ['text'], contextWindow: 64000, maxTokens: 16384,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] } } }));
  let session!: AgentSession; let actualTools = 0;
  const tool = { name: 'probe', version: '1', label: 'Probe', description: 'fixture', effect: 'READ' as const, executionMode: 'parallel' as const, inputSchema: z.object({}).strict(), outputSchema: z.object({}).strict(), execute: async () => { actualTools++; return {}; } };
  const adapter = new PiAgentAdapter({ cwd: root, agentDir: root, credentials: new InMemoryCredentialStore(), runtimeApiKey: 'synthetic-fixture', tools: [tool], sessionSetup: s => { session = s; } });
  const manager = SessionManager.inMemory(root);
  manager.appendModelChange('p9-fixture', 'M1'); manager.appendThinkingLevelChange('high');
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
    const record = (f.adapter as any).sessions.get(f.history.header.id), saved = structuredClone(record.lastSavedHistory); let attempts = 0;
    expect(f.adapter.watchSession(f.history.header.id, record.receipt, record.recoverySeed, () => { attempts++; return fail(appError('storage_write_failed', 'storage', 'controlled metadata failure')); }).ok).toBe(true);
    const prepare = () => f.adapter.prepare(f.history.header.id, f.config, { timeoutMs: 3000, stopGraceMs: 100 }, new AbortController().signal);
    expect(await prepare()).toMatchObject({ ok: false, error: { code: 'storage_write_failed' } });
    expect(await prepare()).toMatchObject({ ok: false, error: { code: 'storage_write_failed' } });
    expect(attempts).toBe(1); expect(record.lastSavedHistory).toEqual(saved); expect(f.payloads).toHaveLength(0);
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
