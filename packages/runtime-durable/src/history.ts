import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import type { ConversationId, EntryId, EntryRecord, Storage } from '@earendil-works/pi-durable';
import { z } from 'zod';
import { appError, fail, ok, PersonalHistoryEntryRequestSchema, PersonalHistoryEntrySchema, PersonalHistoryOwnerSchema,
  PersonalHistoryPageSchema, PersonalHistoryRequestSchema, type DurableHistoryOwner, type DurablePublicHistoryEntryQuery,
  type DurablePublicHistoryQuery, type PersonalHistoryEntry, type PersonalHistoryOwner, type PersonalHistoryPage, type Result } from '@flowmate/contracts';

const context = BACKGROUND_CONTEXT;
const id = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const ownerSchema = z.object({ workId: id, sessionId: id, child: z.object({ workId: id, sessionId: id, attemptId: id,
  requestId: z.string().min(1).max(128), childRunId: id, childSessionId: id, originToolCallId: id, nativeToolTaskId: id }).strict().optional(),
}).strict().refine(value => !value.child || value.child.workId === value.workId && value.child.sessionId === value.sessionId);
const bytes = (text: string) => new TextEncoder().encode(text);
const decoder = new TextDecoder('utf-8', { fatal: true });
function prefix(value: Uint8Array, start: number, limit: number): string {
  if (start > value.length || start < value.length && (value[start]! & 0xc0) === 0x80) throw Error('input_invalid');
  let end = Math.min(start + limit, value.length);
  while (end > start && end < value.length && (value[end]! & 0xc0) === 0x80) end--;
  if (end === start && start < value.length) throw Error('input_invalid');
  return decoder.decode(value.subarray(start, end));
}
function summary(entry: EntryRecord) {
  const raw = bytes(JSON.stringify(entry)), text = prefix(raw, 0, 1024), message = entry.model?.[0];
  const timestamp = message?.timestamp;
  return { entryId: entry.id, kind: entry.kind, createdAt: typeof timestamp === 'number' && Number.isFinite(timestamp)
    && Math.abs(timestamp) <= 8_640_000_000_000_000 ? new Date(timestamp).toISOString() : null,
  role: message?.role ?? null, preview: { text, truncated: bytes(text).length < raw.length }, byteLength: raw.length,
  format: 'pi-durable-entry/v1' as const };
}

/** Immutable native entries can be paged without opening a Conversation or enabling its scheduler. */
export function createDurableHistoryReader(options: {
  storage: Storage;
  resolveOwner(input: DurableHistoryOwner): Promise<{ owner: PersonalHistoryOwner; conversationId: ConversationId | undefined }>;
  read<T>(action: () => Promise<T>): Promise<T>;
}) {
  const safe = async <T>(action: () => Promise<T>): Promise<Result<T>> => {
    try { return ok(await action()); }
    catch (error) { return fail(appError(error instanceof Error && ['input_invalid', 'state_conflict'].includes(error.message)
      ? error.message : 'storage_read_failed', 'storage', 'The original Durable history could not be read.', true)); }
  };
  const parseOwner = (raw: DurableHistoryOwner) => {
    const parsed = ownerSchema.safeParse(raw); if (!parsed.success) throw Error('input_invalid'); return parsed.data;
  };
  const resolve = async (input: DurableHistoryOwner) => {
    const resolved = await options.resolveOwner(input), parsed = PersonalHistoryOwnerSchema.safeParse(resolved.owner);
    if (!parsed.success || parsed.data.workId !== input.workId
      || parsed.data.sessionId !== (input.child?.childSessionId ?? input.sessionId)
      || parsed.data.childRunId !== (input.child?.childRunId ?? null)
      || resolved.conversationId !== undefined && !id.safeParse(resolved.conversationId).success) throw Error('state_conflict');
    return { owner: parsed.data, conversationId: resolved.conversationId };
  };
  const entryAt = async (conversationId: ConversationId, entryId: number) => {
    const record = await options.read(() => options.storage.entry(entryId as EntryId, context));
    if (!record || record.entry.conversationId !== conversationId) throw Error('state_conflict');
    return record.entry;
  };
  const watermark = async (conversationId: ConversationId | undefined, captured: number | undefined) => {
    if (captured === 0) return 0;
    if (conversationId === undefined) { if (captured !== undefined) throw Error('state_conflict'); return 0; }
    if (captured !== undefined) { await entryAt(conversationId, captured); return captured; }
    return (await options.read(() => options.storage.scanEntries({ conversationId, order: 'descending' }, 1, undefined, context))).items[0]?.id ?? 0;
  };
  return {
    queryHistoryPage: (raw: DurablePublicHistoryQuery): Promise<Result<PersonalHistoryPage>> => safe(async () => {
      const { workId, sessionId, child, ...paging } = raw;
      const input = parseOwner({ workId, sessionId, ...(child === undefined ? {} : { child }) });
      const parsed = PersonalHistoryRequestSchema.safeParse({ target: { workId, ...(child ? { childRunId: child.childRunId } : {}) }, ...paging });
      if (!parsed.success) throw Error('input_invalid');
      // Owner resolution may itself use the same storage queue; never hold a product read around it.
      const resolved = await resolve(input), throughEntryId = await watermark(resolved.conversationId, parsed.data.throughEntryId);
      const upper = parsed.data.beforeEntryId === undefined ? throughEntryId : parsed.data.beforeEntryId - 1;
      if (parsed.data.beforeEntryId !== undefined && resolved.conversationId !== undefined)
        await entryAt(resolved.conversationId, parsed.data.beforeEntryId);
      const records = resolved.conversationId === undefined || upper === 0 ? [] : (await options.read(() => options.storage.scanEntries({
        conversationId: resolved.conversationId!, order: 'descending', maxEntryId: upper as EntryId,
      }, parsed.data.limit + 1, undefined, context))).items;
      const entries = records.slice(0, parsed.data.limit).map(summary);
      return PersonalHistoryPageSchema.parse({ owner: resolved.owner, throughEntryId, entries,
        nextBeforeEntryId: records.length > parsed.data.limit ? entries.at(-1)!.entryId : null });
    }),
    queryHistoryEntry: (raw: DurablePublicHistoryEntryQuery): Promise<Result<PersonalHistoryEntry>> => safe(async () => {
      const { workId, sessionId, child, ...paging } = raw;
      const input = parseOwner({ workId, sessionId, ...(child === undefined ? {} : { child }) });
      const parsed = PersonalHistoryEntryRequestSchema.safeParse({ target: { workId, ...(child ? { childRunId: child.childRunId } : {}) }, ...paging });
      if (!parsed.success) throw Error('input_invalid');
      const resolved = await resolve(input);
      await watermark(resolved.conversationId, parsed.data.throughEntryId);
      if (resolved.conversationId === undefined) throw Error('state_conflict');
      const record = await entryAt(resolved.conversationId, parsed.data.entryId), rawEntry = bytes(JSON.stringify(record));
      const text = prefix(rawEntry, parsed.data.offset, parsed.data.limit), end = parsed.data.offset + bytes(text).length;
      return PersonalHistoryEntrySchema.parse({ owner: resolved.owner, throughEntryId: parsed.data.throughEntryId,
        entryId: record.id, kind: record.kind, format: 'pi-durable-entry/v1', offset: parsed.data.offset,
        totalBytes: rawEntry.length, text, nextOffset: end < rawEntry.length ? end : null });
    }),
  };
}
