import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { createModels, InMemoryCredentialStore, InMemoryModelsStore } from '@earendil-works/pi-ai';
import { createRegistry, Harness, type ConversationId } from '@earendil-works/pi-durable';
import { createDatabaseCoordinator } from '../../packages/core/src/storage/write-coordinator.ts';
import { type Result } from '@flowmate/contracts';
import { createDurableSqliteStorage } from '../../packages/runtime-durable/src/storage.ts';
import { createDurableHistoryReader } from '../../packages/runtime-durable/src/history.ts';

const context = BACKGROUND_CONTEXT;
function need<T>(result: Result<T>): T { if (!result.ok) throw Error(result.error.code); return result.data; }
async function fixture() {
  const coordinator = createDatabaseCoordinator(new Database(':memory:'));
  const storage = await createDurableSqliteStorage(coordinator);
  const models = createModels({ credentials: new InMemoryCredentialStore(), modelsStore: new InMemoryModelsStore(),
    authContext: { env: async () => undefined, fileExists: async () => false } });
  const harness = await Harness.open(storage, { models, registry: createRegistry() }, context);
  const [a, b] = await harness.commit(async tx => Promise.all([
    tx.createConversation({ ownership: { kind: 'ownerless' } }), tx.createConversation({ ownership: { kind: 'ownerless' } }),
  ]), context);
  const owner = { workId: 7, sessionId: 70 };
  const reader = createDurableHistoryReader({ storage, read: action => action(), resolveOwner: async input => ({
    owner: { runtimeKind: 'durable', workId: input.workId, sessionId: input.child?.childSessionId ?? input.sessionId,
      childRunId: input.child?.childRunId ?? null },
    conversationId: input.workId === 7 ? a!.id : input.workId === 8 ? b!.id : undefined,
  }) });
  const append = (conversationId: ConversationId, text: string) => harness.commit(tx => tx.appendEntry(conversationId,
    { kind: 'flowmate.test.history', model: [{ role: 'user', content: text, timestamp: 1793232000000 }], data: { text } }), context);
  return { coordinator, storage, harness, reader, owner, a: a!, b: b!, append,
    close: async () => { await harness.close(context); await coordinator.close(); } };
}

test('Durable history uses a stable original watermark, exact native IDs and read-only SQLite queries', async () => {
  const f = await fixture();
  try {
    const first = await f.append(f.a.id, 'first'), foreign = await f.append(f.b.id, 'foreign'), second = await f.append(f.a.id, 'second');
    const before = await f.coordinator.read(sql => sql.get('SELECT COUNT(*) AS count FROM fm_durable_record_ids'));
    const page = need(await f.reader.queryHistoryPage({ ...f.owner, limit: 1 }));
    expect(await f.coordinator.read(sql => sql.get('SELECT COUNT(*) AS count FROM fm_durable_record_ids'))).toEqual(before);
    expect(page).toMatchObject({ owner: { ...f.owner, runtimeKind: 'durable', childRunId: null }, throughEntryId: second.id,
      entries: [{ entryId: second.id, kind: 'flowmate.test.history', role: 'user', format: 'pi-durable-entry/v1' }], nextBeforeEntryId: second.id });
    expect(page.entries[0]!.byteLength).toBe(Buffer.byteLength(JSON.stringify(second)));
    const late = await f.append(f.a.id, 'new after original page');
    const continued = need(await f.reader.queryHistoryPage({ ...f.owner, throughEntryId: page.throughEntryId,
      beforeEntryId: page.nextBeforeEntryId!, limit: 1 }));
    expect(continued.entries.map(entry => entry.entryId)).toEqual([first.id]); expect(continued.nextBeforeEntryId).toBeNull();
    expect(need(await f.reader.queryHistoryPage({ ...f.owner, limit: 1 })).entries[0]!.entryId).toBe(late.id);
    for (const changed of [{ throughEntryId: foreign.id }, { throughEntryId: second.id, beforeEntryId: foreign.id }, { beforeEntryId: first.id }])
      expect(await f.reader.queryHistoryPage({ ...f.owner, ...changed })).toMatchObject({ ok: false });
    expect(await f.reader.queryHistoryEntry({ ...f.owner, entryId: foreign.id, throughEntryId: second.id })).toMatchObject({ ok: false });
    const after = await f.coordinator.read(sql => sql.get('SELECT COUNT(*) AS count FROM fm_durable_record_ids'));
    expect(after).not.toEqual(before); // Only the explicit append above allocated an ID.
    const stable = await f.coordinator.read(sql => sql.get('SELECT COUNT(*) AS count FROM fm_durable_record_ids'));
    for (let i = 0; i < 3; i++) need(await f.reader.queryHistoryPage({ ...f.owner }));
    expect(await f.coordinator.read(sql => sql.get('SELECT COUNT(*) AS count FROM fm_durable_record_ids'))).toEqual(stable);
    expect((await f.storage.scanTasks({}, 100, undefined, context)).items).toEqual([]);
  } finally { await f.close(); }
});

test('uncreated history stays empty and bounded UTF-8 detail reconstructs an oversized original entry', async () => {
  const f = await fixture();
  try {
    expect(need(await f.reader.queryHistoryPage({ workId: 9, sessionId: 90 }))).toEqual({
      owner: { runtimeKind: 'durable', workId: 9, sessionId: 90, childRunId: null }, throughEntryId: 0, entries: [], nextBeforeEntryId: null,
    });
    const entry = await f.append(f.a.id, '发票🙂'.repeat(5000));
    const page = need(await f.reader.queryHistoryPage(f.owner));
    expect(Buffer.byteLength(page.entries[0]!.preview.text)).toBeLessThanOrEqual(1024);
    expect(page.entries[0]!.preview.truncated).toBe(true);
    expect(need(await f.reader.queryHistoryPage({ ...f.owner, throughEntryId: 0 })).entries).toEqual([]);
    let text = '', offset = 0;
    do {
      const chunk = need(await f.reader.queryHistoryEntry({ ...f.owner, entryId: entry.id, throughEntryId: page.throughEntryId, offset, limit: 1001 }));
      expect(Buffer.byteLength(chunk.text)).toBeLessThanOrEqual(1001); expect(chunk.text).not.toContain('\uFFFD');
      expect(chunk.offset).toBe(offset); expect(chunk.totalBytes).toBe(page.entries[0]!.byteLength);
      text += chunk.text;
      if (chunk.nextOffset === null) break;
      expect(chunk.nextOffset).toBeGreaterThan(offset); offset = chunk.nextOffset;
    } while (offset < page.entries[0]!.byteLength);
    expect(text).toBe(JSON.stringify(entry));
    const bytes = Buffer.from(text), inside = bytes.findIndex(value => value >= 128 && value < 192);
    expect(inside).toBeGreaterThan(0);
    expect(await f.reader.queryHistoryEntry({ ...f.owner, entryId: entry.id, throughEntryId: page.throughEntryId, offset: inside })).toMatchObject({ ok: false });
    expect(await f.reader.queryHistoryEntry({ ...f.owner, entryId: entry.id, throughEntryId: page.throughEntryId, offset: bytes.length + 1 })).toMatchObject({ ok: false });
  } finally { await f.close(); }
});
