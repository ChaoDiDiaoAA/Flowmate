import { SQLiteError, type Database } from 'bun:sqlite';
import { appError, fail, ok, HistoryCommitInputSchema, HistoryCommitStateSchema, NativeSessionHistorySchema } from '@flowmate/contracts';
import type { AppError, DbId, HistoryCommitInput, HistoryCommitReceipt, MemoryStore, StoredNativeHistory } from '@flowmate/contracts';
import type { RuntimeEventStore } from '../events/store.ts';
import { associateInputResult, markInputConsumed, verifyNativeCommitContexts } from '../sessions/input-ledger.ts';
import { NativeOriginFault } from './origins.ts';
import { appendResourceExpansionInTransaction } from '../context/repository.ts';

/** Thrown through transaction boundaries; convert only after SQLite and pending events roll back. */
export class MemoryCommitFault extends Error {
  constructor(readonly error: AppError) { super(error.code); }
}
function conflict(): never { throw new MemoryCommitFault(appError('state_conflict', 'session', 'Conversation history has changed.', true)); }
function invalid(): never { throw new MemoryCommitFault(appError('session_history_invalid', 'session', 'Saved conversation history is invalid. Start a new chat.')); }
function exhausted(): never {
  throw new MemoryCommitFault(appError('storage_write_failed', 'storage',
    'Conversation history commit revision is exhausted. Further changes cannot be saved.'));
}
function ordered(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(ordered);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, ordered(child)]));
  return value;
}
function same(a: unknown, b: unknown): boolean { return JSON.stringify(ordered(a)) === JSON.stringify(ordered(b)); }
type HistoryRow = { storage_version: number; header_json: string; leaf_id: string | null; entry_count: number; unusable: number; commit_revision: number };
type EntryRow = { sequence: number; entry_id: string; entry_json: string; run_id: number | null };
function historyRow(db: Database, sessionId: DbId) {
  // Historical repository fixtures can predate 016 and have no native Header.
  // Read the row before requiring revision so legacy absence remains absence.
  return db.query('SELECT * FROM session_native_history WHERE session_id=?')
    .get(sessionId) as HistoryRow | null;
}
function entryRows(db: Database, sessionId: DbId) {
  return db.query('SELECT sequence,entry_id,entry_json,run_id FROM session_native_entries WHERE session_id=? ORDER BY sequence').all(sessionId) as EntryRow[];
}
/** Existing contexts confirm original identities; they cannot fill an absent Input pointer. */
function confirmOriginalAssociation(db: Database, sessionId: DbId, context: HistoryCommitInput['contexts'][number]): void {
  type InputIdentity = { id: number; run_id: number | null; status: string; native_entry_id: string | null };
  const users = db.query('SELECT id,run_id,status,native_entry_id FROM session_inputs WHERE session_id=? AND native_entry_id=?')
    .all(sessionId, context.entryId) as InputIdentity[];
  if (context.inputId === undefined ? users.length !== 0
    : users.length !== 1 || users[0]!.id !== context.inputId || users[0]!.run_id !== context.runId || users[0]!.status !== 'consumed') conflict();
  const results = db.query('SELECT id,run_id,status,native_entry_id FROM session_inputs WHERE session_id=? AND result_entry_id=?')
    .all(sessionId, context.entryId) as InputIdentity[];
  const expected = context.resultInputIds ?? [];
  if (context.resultInputIds !== undefined && expected.length === 0 || new Set(expected).size !== expected.length
    || results.length !== expected.length || results.some(row => !expected.includes(row.id) || row.run_id !== context.runId
      || row.status !== 'consumed' || row.native_entry_id === null)) conflict();
}
/** Complete committed read. Resolver enrichment is assembled separately, under its read transaction. */
export function loadNativeHistoryInTransaction(db: Database, sessionId: DbId): StoredNativeHistory | null {
  const row = historyRow(db, sessionId);
  if (!row) return null;
  const session = db.query('SELECT native_session_id FROM sessions WHERE id=?').get(sessionId) as { native_session_id: string } | null;
  const rows = entryRows(db, sessionId);
  const entries = rows.map((item, index) => {
    const entry = JSON.parse(item.entry_json);
    if (item.sequence !== index || entry?.id !== item.entry_id) invalid();
    if (item.run_id !== null) {
      const run = db.query('SELECT kind,session_id FROM runs WHERE id=?').get(item.run_id) as { kind: string; session_id: number | null } | null;
      if (!Number.isSafeInteger(item.run_id) || item.run_id <= 0 || run?.kind !== 'agent' || run.session_id !== sessionId || entry.type !== 'message') invalid();
    }
    return entry;
  });
  const history = { storageVersion: row.storage_version, header: JSON.parse(row.header_json), entries, leafId: row.leaf_id, unusable: row.unusable === 1 };
  if (!NativeSessionHistorySchema.safeParse(history).success || row.unusable !== 0 && row.unusable !== 1
    || history.header.version !== 3 || history.header.id !== session?.native_session_id || rows.length !== row.entry_count) invalid();
  const commit = { commitRevision: row.commit_revision, entryCount: row.entry_count, leafId: row.leaf_id };
  if (!HistoryCommitStateSchema.safeParse(commit).success) invalid();
  return { history: history as StoredNativeHistory['history'], commit };
}

/** Trusted create/fork may use expected=null. Call only inside the original write transaction. */
export function commitInTransaction(db: Database, input: HistoryCommitInput, events?: RuntimeEventStore): HistoryCommitReceipt {
  if (!db.inTransaction) conflict();
  if (!HistoryCommitInputSchema.safeParse(input).success) invalid();
  const session = db.query('SELECT native_session_id FROM sessions WHERE id=?').get(input.sessionId) as { native_session_id: string } | null;
  if (!session || input.header.id !== session.native_session_id || input.header.version !== 3) invalid();
  const previous = loadNativeHistoryInTransaction(db, input.sessionId);
  if (input.expected === null ? previous !== null : previous === null || !same(input.expected, previous.commit)) conflict();
  if (previous && !same(previous.history.header, input.header)) conflict();
  const rows = entryRows(db, input.sessionId), byId = new Map(rows.map(row => [row.entry_id, row]));
  const entries = [...(previous?.history.entries ?? [])];
  const supplied = new Set<string>(), added: typeof entries = [];
  for (const entry of input.appendEntries) {
    if (supplied.has(entry.id)) conflict();
    supplied.add(entry.id);
    const old = byId.get(entry.id);
    if (old) { if (!same(JSON.parse(old.entry_json), entry)) conflict(); }
    else { entries.push(entry); added.push(entry); }
  }
  const unusable = previous?.history.unusable === true || input.unusable;
  const history = { storageVersion: 1, header: input.header, entries, leafId: input.leafId, unusable };
  if (!NativeSessionHistorySchema.safeParse(history).success) invalid();
  const contexts = new Map<string, HistoryCommitInput['contexts'][number]>();
  for (const context of input.contexts) {
    const duplicate = contexts.get(context.entryId);
    if (duplicate && !same(duplicate, context)) conflict();
    contexts.set(context.entryId, context);
    const entry = entries.find(entry => entry.id === context.entryId);
    const run = db.query('SELECT kind,session_id FROM runs WHERE id=?').get(context.runId) as { kind: string; session_id: number | null } | null;
    const old = byId.get(context.entryId);
    if (entry?.type !== 'message' || run?.kind !== 'agent' || run.session_id !== input.sessionId || old && old.run_id !== context.runId) conflict();
    const role = (entry.message as { role?: unknown }).role;
    if (context.inputId !== undefined && (role !== 'user' || context.resultInputIds !== undefined)) conflict();
    if (context.resultInputIds !== undefined && role !== 'assistant') conflict();
    if (role === 'user' && context.inputId === undefined && db.query('SELECT id FROM session_inputs WHERE run_id=? LIMIT 1').get(context.runId)) conflict();
    if (old) confirmOriginalAssociation(db, input.sessionId, context);
  }
  const changed = previous === null || added.length > 0 || input.leafId !== previous.history.leafId || unusable !== previous.history.unusable;
  if (changed && previous?.commit.commitRevision === Number.MAX_SAFE_INTEGER) exhausted();
  const revision = previous ? previous.commit.commitRevision + (changed ? 1 : 0) : 1;
  try { verifyNativeCommitContexts(db, input.sessionId, input.contexts); }
  catch (error) {
    if (error instanceof SQLiteError) throw error;
    throw new MemoryCommitFault(error instanceof NativeOriginFault ? error.error
      : appError('context_binding_unknown', 'runtime', 'Native commit source evidence could not be verified.'));
  }
  if (!previous) db.query('INSERT INTO session_native_history(session_id,storage_version,header_json,leaf_id,entry_count,unusable,commit_revision) VALUES(?,1,?,NULL,0,0,0)')
    .run(input.sessionId, JSON.stringify(input.header));
  for (const [index, entry] of added.entries()) db.query('INSERT INTO session_native_entries(session_id,sequence,entry_id,entry_json,run_id) VALUES(?,?,?,?,?)')
    .run(input.sessionId, rows.length + index, entry.id, JSON.stringify(entry), contexts.get(entry.id)?.runId ?? null);
  // Association order follows the native sequence, independent of caller context order.
  // A response in this commit must see its user inputs consumed first.
  for (const entry of entries) {
    const context = contexts.get(entry.id);
    if (!context) continue;
    if (context.inputId !== undefined) {
      markInputConsumed(db, context.inputId, context.runId, entry.id, entry.timestamp, events);
      const inputRow = db.query('SELECT status,native_entry_id FROM session_inputs WHERE id=?').get(context.inputId) as { status: string; native_entry_id: string | null } | null;
      if (inputRow?.status !== 'consumed' || inputRow.native_entry_id !== entry.id) conflict();
    }
    if (context.resultInputIds !== undefined) associateInputResult(db, context.runId, context.resultInputIds, entry.id, entry.timestamp, events);
  }
  const old = previous?.commit ?? { commitRevision: 0, entryCount: 0, leafId: null };
  const changes = db.query(`UPDATE session_native_history SET leaf_id=?,entry_count=?,unusable=?,commit_revision=?
    WHERE session_id=? AND commit_revision=? AND entry_count=? AND leaf_id IS ?`)
    .run(input.leafId, entries.length, unusable ? 1 : 0, revision, input.sessionId, old.commitRevision, old.entryCount, old.leafId).changes;
  if (changes !== 1) conflict();
  for (const context of input.contexts) if (context.resourceExpansion) {
    try { appendResourceExpansionInTransaction(db, { sessionId: input.sessionId, runId: context.runId }, context.resourceExpansion); }
    catch { throw new MemoryCommitFault(appError('resource_evidence_write_failed', 'storage', 'Native Skill expansion evidence could not be saved.', true)); }
  }
  return { commitRevision: revision, entryCount: entries.length, leafId: input.leafId };
}

/** Block only SQL's already committed collection; legacy has no Header to manufacture. */
export function markUnusableInTransaction(db: Database, sessionId: DbId): void {
  if (!db.inTransaction) conflict();
  const row = historyRow(db, sessionId);
  if (!row || row.unusable === 1) return;
  if (row.unusable !== 0 || !HistoryCommitStateSchema.safeParse({ commitRevision: row.commit_revision, entryCount: row.entry_count, leafId: row.leaf_id }).success) invalid();
  if (row.commit_revision === Number.MAX_SAFE_INTEGER) exhausted();
  const changed = db.query(`UPDATE session_native_history SET unusable=1,commit_revision=commit_revision+1
    WHERE session_id=? AND unusable=0 AND commit_revision=? AND entry_count=? AND leaf_id IS ?`)
    .run(sessionId, row.commit_revision, row.entry_count, row.leaf_id).changes;
  if (changed !== 1) conflict();
}

export function createMemoryStore(db: Database, events: RuntimeEventStore): Pick<MemoryStore, 'load' | 'commit'> {
  return {
    load(sessionId) {
      try { return ok(db.transaction(() => loadNativeHistoryInTransaction(db, sessionId)).deferred()); }
      catch (error) { return fail(error instanceof MemoryCommitFault ? error.error : appError('session_history_invalid', 'session', 'Saved conversation history is invalid. Start a new chat.')); }
    },
    commit(input) {
      try {
        // Initial Header belongs to the Session/fork transaction, never an ordinary upsert.
        if (input.expected === null) conflict();
        return ok(events.withTransaction(() => commitInTransaction(db, input, events)));
      } catch (error) {
        return fail(error instanceof MemoryCommitFault ? error.error : appError('storage_write_failed', 'storage', 'Conversation history could not be saved.', true));
      }
    },
  };
}
