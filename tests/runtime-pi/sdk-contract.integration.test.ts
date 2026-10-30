import { describe, expect, it } from 'bun:test';
import { createSdkProbe } from '../../packages/runtime-pi/src/sdk-probe.ts';
import * as sdk from '@earendil-works/pi-coding-agent';
import type { AssistantMessage } from '@earendil-works/pi-ai';
import { RUNTIME_CONFIG } from '@flowmate/contracts';

const usage: AssistantMessage['usage'] = {
  input: 10, output: 3, cacheRead: 2, cacheWrite: 1, totalTokens: 16,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

describe('P10 fixed native compaction contract', () => {
  it('freezes the product policy without enabling unbound SDK sessions', () => {
    expect(RUNTIME_CONFIG).toHaveProperty('compaction', {
      version: 'p10-native-compaction-v1', autoEnabled: true,
      reserveTokens: 16384, keepRecentTokens: 20000,
    });
  });

  it('compaction-sdk-0851-public-surface distinguishes public and private methods', () => {
    for (const name of ['compact', 'shouldCompact', 'estimateTokens', 'findCutPoint', 'findTurnStartIndex'])
      expect(Reflect.get(sdk, name)).toBeFunction();
    expect(Reflect.get(sdk, 'prepareCompaction')).toBeUndefined();
    expect(Reflect.get(sdk, 'estimateContextTokens')).toBeUndefined();
    for (const name of ['compact', 'abortCompaction', 'getContextUsage', '_runDefaultCompaction', '_runAutoCompaction'])
      expect(Reflect.get(sdk.AgentSession.prototype, name)).toBeFunction();
  });

  it('compaction-threshold-and-unknown measures the strict SDK threshold and estimation limits', () => {
    const settings = sdk.DEFAULT_COMPACTION_SETTINGS;
    expect(settings).toEqual({ enabled: true, reserveTokens: 16384, keepRecentTokens: 20000 });
    expect(sdk.shouldCompact(183616, 200000, settings)).toBe(false);
    expect(sdk.shouldCompact(183617, 200000, settings)).toBe(true);
    expect(sdk.estimateTokens({ role: 'user', content: [{ type: 'text', text: '中'.repeat(100) }], timestamp: 0 })).toBe(25);
    expect(sdk.calculateContextTokens({ ...usage, totalTokens: 100 })).toBe(100);
    expect(sdk.calculateContextTokens({ ...usage, totalTokens: 0 })).toBe(16);
    // SDK comparison is not product admission: an invalid window still compares numerically.
    expect(sdk.shouldCompact(1, 0, settings)).toBe(true);
  });

  it('keeps tool pairs and adjacent metadata on the actual split-turn cut', () => {
    const manager = sdk.SessionManager.inMemory(process.cwd());
    const old = manager.appendMessage({ role: 'user', content: [{ type: 'text', text: 'old'.repeat(2000) }], timestamp: 1 });
    const metadata = manager.appendThinkingLevelChange('off');
    const assistant = manager.appendMessage({
      role: 'assistant', api: 'openai-completions', provider: 'controlled', model: 'offline',
      content: [{ type: 'text', text: 'a'.repeat(1200) }, { type: 'toolCall', id: 'tool-1', name: 'read', arguments: {} }],
      usage, stopReason: 'toolUse', timestamp: 2,
    });
    const result = manager.appendMessage({ role: 'toolResult', toolCallId: 'tool-1', toolName: 'read',
      content: [{ type: 'text', text: 'b'.repeat(1600) }], isError: false, timestamp: 3 });
    manager.appendMessage({ role: 'user', content: [{ type: 'text', text: 'next' }], timestamp: 4 });
    const entries = manager.getBranch();
    const cut = sdk.findCutPoint(entries, 0, entries.length, 500);
    expect(entries[cut.firstKeptEntryIndex]?.id).toBe(metadata);
    expect(cut.isSplitTurn).toBe(true);
    expect(entries[cut.turnStartIndex]?.id).toBe(old);
    expect(entries.slice(cut.firstKeptEntryIndex).map(entry => entry.id)).toContain(assistant);
    expect(entries.slice(cut.firstKeptEntryIndex).map(entry => entry.id)).toContain(result);
    const compactId = manager.appendCompaction('old facts', metadata, 19000);
    const messages = manager.buildSessionContext().messages;
    expect(messages[0]).toMatchObject({ role: 'compactionSummary', summary: 'old facts' });
    expect(manager.getEntry(compactId)).toMatchObject({ type: 'compaction', firstKeptEntryId: metadata });
    expect(manager.getEntry(old)).toMatchObject({ type: 'message' });
  });

  it('recognizes a context-visible custom message as a turn start', () => {
    const manager = sdk.SessionManager.inMemory(process.cwd());
    const entryId = manager.appendCustomMessageEntry('controlled', 'custom context', false);
    expect(sdk.findTurnStartIndex(manager.getBranch(), 0, 0)).toBe(0);
    expect(manager.getBranch()[0]?.id).toBe(entryId);
  });
});

describe('Pi SDK contract probe', () => {
  it('creates an offline ModelRuntime with a built-in model and no global model store', async () => {
    const probe = await createSdkProbe();

    expect(probe.error).toBeUndefined();
    expect(probe.model).toMatchObject({
      provider: 'deepseek',
      id: 'deepseek-flash',
    });
    expect(probe.missingModel).toBeUndefined();
    expect(probe.networkEnabled).toBe(false);
    await probe.close();
  });
});
