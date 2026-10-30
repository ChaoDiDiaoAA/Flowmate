import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { InMemoryCredentialStore, Type } from '@earendil-works/pi-ai';
import { normalizeContext, toToolDeclaration } from '@earendil-works/pi-ai/utils/transcript';
import { SessionManager, VERSION } from '@earendil-works/pi-coding-agent';
import { NativeSessionHistorySchema } from '@flowmate/contracts';
import type { ProviderConfig } from '@flowmate/contracts';
import { observedFetch, prepareModelRuntime } from '../../packages/runtime-pi/src/model-runtime.ts';
import { managerFor, validateNativeHistory } from '../../packages/runtime-pi/src/memory/history.ts';
import { projectSessionMessages } from '../../packages/runtime-pi/src/messages.ts';

const limits = { timeoutMs: 10_000, stopGraceMs: 5_000 };

test('new runtime evidence identifies the SDKs actually resolving its explicit model configuration', async () => {
  const config: ProviderConfig = {
    version: 1, name: 'sdk-upgrade-explicit', revision: 1,
    modelRef: { provider: 'flowmate-sdk-upgrade', model: 'explicit-only' },
    native: { authPath: join(import.meta.dir, 'unused-auth.json'), modelsPath: null },
    connection: { baseUrl: 'http://127.0.0.1:1/v1', api: 'openai-completions', contextWindow: 64_000, maxTokens: 8_192 },
    parameters: { maxRetries: 0, maxRetryDelayMs: 1_000 },
  };
  const prepared = await prepareModelRuntime(config, limits, new AbortController().signal,
    { credentials: new InMemoryCredentialStore(), runtimeApiKey: 'synthetic-sdk-upgrade-key' });
  expect(prepared.ok).toBe(true);
  if (!prepared.ok) return;
  const aiEntry = fileURLToPath(import.meta.resolve('@earendil-works/pi-ai'));
  const aiPackage = JSON.parse(readFileSync(join(dirname(aiEntry), '../package.json'), 'utf8'));
  expect(prepared.data.snapshot.sdk).toEqual({ codingAgent: VERSION, ai: aiPackage.version });
  expect(prepared.data.snapshot.resolvedModel).toEqual({ provider: 'flowmate-sdk-upgrade', model: 'explicit-only' });
  expect(prepared.data.snapshot.native.authSource).toBe('pi-runtime-api-key');
});

test('an explicitly selected native model sends no unapproved server fallback models', async () => {
  const config: ProviderConfig = {
    version: 1, name: 'sdk-upgrade-native-selection', revision: 1,
    modelRef: { provider: 'anthropic', model: 'claude-fable-5' },
    native: { authPath: join(import.meta.dir, 'unused-auth.json'), modelsPath: null },
    parameters: { maxRetries: 0, maxRetryDelayMs: 1_000 },
  };
  const prepared = await prepareModelRuntime(config, limits, new AbortController().signal,
    { credentials: new InMemoryCredentialStore(), runtimeApiKey: 'synthetic-sdk-upgrade-key' });
  expect(prepared.ok).toBe(true);
  if (!prepared.ok) return;
  const catalogCompat = structuredClone(prepared.data.model.compat);
  const sent: { body: Record<string, unknown>; headers: Headers }[] = [];
  const stream = prepared.data.runtime.streamSimple(prepared.data.model,
    normalizeContext({ messages: [{ role: 'user', content: 'Check this invoice.', timestamp: 1 }] }), {
      maxTokens: 128, maxRetries: 0,
      fetch: observedFetch('anthropic-messages', async (input, init) => {
        const request = new Request(input, init);
        sent.push({ body: await request.json() as Record<string, unknown>, headers: request.headers });
        const events = [
          { type: 'message_start', message: { id: 'controlled-selection', type: 'message', role: 'assistant', content: [],
            model: config.modelRef.model, stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } },
          { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
          { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Checked.' } },
          { type: 'content_block_stop', index: 0 },
          { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } },
          { type: 'message_stop' },
        ];
        return new Response(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''),
          { headers: { 'content-type': 'text/event-stream' } });
      }),
    });
  expect((await stream.result()).stopReason).toBe('stop');
  expect(sent).toHaveLength(1);
  expect(sent[0]!.body.model).toBe(config.modelRef.model);
  expect(sent[0]!.body).not.toHaveProperty('fallbacks');
  expect(sent[0]!.headers.get('anthropic-beta') ?? '').not.toContain('server-side-fallback');
  expect(prepared.data.model.compat).toEqual(catalogCompat);
});

test('an ambient provider key cannot replace the explicitly empty product credential store', async () => {
  const previous = process.env.DEEPSEEK_API_KEY;
  process.env.DEEPSEEK_API_KEY = 'synthetic-ambient-key-must-not-be-used';
  try {
    const config: ProviderConfig = {
      version: 1, name: 'sdk-upgrade-no-credentials', revision: 1,
      modelRef: { provider: 'deepseek', model: 'deepseek-flash' },
      native: { authPath: join(import.meta.dir, 'unused-auth.json'), modelsPath: null },
      parameters: { maxRetries: 0, maxRetryDelayMs: 1_000 },
    };
    const prepared = await prepareModelRuntime(config, limits, new AbortController().signal,
      { credentials: new InMemoryCredentialStore() });
    expect(prepared.ok).toBe(false);
    if (!prepared.ok) expect(prepared.error.code).toBe('provider_auth_failed');
  } finally {
    if (previous === undefined) delete process.env.DEEPSEEK_API_KEY;
    else process.env.DEEPSEEK_API_KEY = previous;
  }
});

test('native system tool declarations survive history validation without becoming user conversation bubbles', () => {
  const manager = SessionManager.inMemory(import.meta.dir);
  const declaration = toToolDeclaration({ name: 'lookup_invoice', description: 'Read an authorized invoice.',
    parameters: Type.Object({ invoice: Type.Integer() }) });
  const systemId = manager.appendMessage({ role: 'system', content: 'Use the selected invoice only.',
    sections: { evidence: 'Report missing evidence.' }, toolsAdded: [declaration], timestamp: 1 });
  const userId = manager.appendMessage({ role: 'user', content: 'Review the invoice.', timestamp: 2 });
  const history = NativeSessionHistorySchema.safeParse({ storageVersion: 1, header: manager.getHeader(),
    entries: manager.getEntries(), leafId: manager.getLeafId(), unusable: false });
  expect(history.success).toBe(true);
  if (!history.success) return;
  expect(validateNativeHistory(history.data).ok).toBe(true);
  expect(history.data.entries[0]).toMatchObject({ id: systemId, type: 'message',
    message: { role: 'system', toolsAdded: [{ name: 'lookup_invoice' }] } });
  const page = projectSessionMessages({ history: history.data, bindings: [], runInputs: [], limit: 10 });
  expect(page.ok).toBe(true);
  if (page.ok) expect(page.data.items.map(item => ({ entryId: item.entryId, role: item.role })))
    .toEqual([{ entryId: userId, role: 'user' }]);
});

test('a removed catalog model stays explicitly unavailable rather than being silently renamed', async () => {
  const config: ProviderConfig = {
    version: 1, name: 'saved-before-sdk-upgrade', revision: 7,
    modelRef: { provider: 'deepseek', model: 'deepseek-v4-flash' },
    native: { authPath: join(import.meta.dir, 'unused-auth.json'), modelsPath: null },
    parameters: { maxRetries: 0, maxRetryDelayMs: 1_000 },
  };
  const prepared = await prepareModelRuntime(config, limits, new AbortController().signal,
    { credentials: new InMemoryCredentialStore(), runtimeApiKey: 'synthetic-sdk-upgrade-key' });
  expect(prepared).toMatchObject({ ok: false, error: { code: 'provider_model_not_found' } });
  expect(config.modelRef).toEqual({ provider: 'deepseek', model: 'deepseek-v4-flash' });
  expect(config.revision).toBe(7);
});

test('native recovery omissions and attributed usage retain the original failed response in saved history', () => {
  const manager = SessionManager.inMemory(import.meta.dir);
  manager.appendMessage({ role: 'user', content: 'Review the original invoice.', timestamp: 1 });
  const usage = { input: 10, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 10,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
  const failedId = manager.appendMessage({ role: 'assistant', content: [], stopReason: 'error',
    errorMessage: 'maximum context length exceeded', api: 'openai-completions', provider: 'controlled', model: 'invoice', usage, timestamp: 2 });
  const editId = manager.appendContextEdit(failedId, null);
  const usageEntry = manager.appendUsage('cache_warm', 'controlled', 'invoice', usage);
  const parsed = NativeSessionHistorySchema.safeParse({ storageVersion: 1, header: manager.getHeader(),
    entries: manager.getEntries(), leafId: manager.getLeafId(), unusable: false });
  expect(parsed.success).toBe(true);
  if (!parsed.success) return;
  expect(validateNativeHistory(parsed.data).ok).toBe(true);
  expect(parsed.data.entries).toContainEqual(expect.objectContaining({ id: failedId, message: expect.objectContaining({ stopReason: 'error' }) }));
  expect(parsed.data.entries).toContainEqual(expect.objectContaining({ id: editId, type: 'context_edit', targetId: failedId, replacement: null }));
  expect(parsed.data.entries).toContainEqual(expect.objectContaining({ id: usageEntry.id, type: 'usage', provider: 'controlled', usage }));
  expect(managerFor(parsed.data).buildSessionContext().messages).toEqual([{ role: 'user', content: 'Review the original invoice.', timestamp: 1 }]);
  expect(NativeSessionHistorySchema.safeParse({ ...parsed.data,
    entries: parsed.data.entries.map(entry => entry.id === editId ? { ...entry, targetId: 'missing' } : entry) }).success).toBe(false);
});

test.each(['metadata', 'system', 'other-branch'] as const)('rejects a saved native context edit targeting %s content', kind => {
  const manager = SessionManager.inMemory(import.meta.dir);
  const rootId = manager.appendMessage({ role: 'user', content: 'Review the selected invoice.', timestamp: 1 });
  const targetId = kind === 'metadata' ? manager.appendModelChange('controlled', 'invoice')
    : manager.appendMessage({ role: kind === 'system' ? 'system' : 'user', content: 'Uneditable target.', timestamp: 2 });
  if (kind === 'other-branch') manager.branch(rootId);
  const editableId = manager.appendMessage({ role: 'user', content: 'Current invoice input.', timestamp: 3 });
  const editId = manager.appendContextEdit(editableId, null);
  expect(() => manager.appendContextEdit(targetId, null)).toThrow();
  const history = NativeSessionHistorySchema.parse({ storageVersion: 1, header: manager.getHeader(),
    entries: manager.getEntries().map(entry => entry.id === editId ? { ...entry, targetId } : entry),
    leafId: manager.getLeafId(), unusable: false });
  expect(validateNativeHistory(history)).toMatchObject({ ok: false, error: { code: 'session_history_invalid' } });
});

test('accepts a native custom-message edit on an inactive saved branch without changing its original entries', () => {
  const manager = SessionManager.inMemory(import.meta.dir);
  const rootId = manager.appendMessage({ role: 'user', content: 'Review the selected invoice.', timestamp: 1 });
  const noteId = manager.appendCustomMessageEntry('invoice-note', 'Original model note.', true);
  const editId = manager.appendContextEdit(noteId, { content: 'Revised model note.' });
  manager.branch(rootId);
  manager.appendMessage({ role: 'user', content: 'Continue on another saved branch.', timestamp: 2 });
  const history = NativeSessionHistorySchema.parse({ storageVersion: 1, header: manager.getHeader(),
    entries: manager.getEntries(), leafId: manager.getLeafId(), unusable: false });
  expect(validateNativeHistory(history).ok).toBe(true);
  expect(managerFor(history).getEntry(editId)).toMatchObject({ type: 'context_edit', targetId: noteId,
    replacement: { content: 'Revised model note.' } });
  expect(history.entries.find(entry => entry.id === noteId)).toMatchObject({ type: 'custom_message', content: 'Original model note.' });
});
