import { Database } from 'bun:sqlite';
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readdirSync, realpathSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import type { ConversationId, ConversationRecord, Cursor, Storage, SubmissionId } from '@earendil-works/pi-durable';
import { CloudNativeOversizedResultSchema, CloudNativeResultReceiptSchema, CloudNativeResultSchema, CloudResultPageRequestSchema, CloudResultPageSchema, CloudResultRetryIdentitySchema,
  CloudRuntimeBindingSchema, CloudRuntimeIdSchema, appError, fail, ok, type CloudNativeOversizedResult, type CloudNativeResult, type CloudNativeResultReceipt,
  type CloudResultPage, type CloudResultPageRequest, type CloudResultRetryIdentity, type CloudRuntimeBinding, type Result } from '@flowmate/contracts';
import { createDatabaseCoordinator } from '../packages/core/src/storage/write-coordinator.ts';
import { createDurableSqliteStorage } from '../packages/runtime-durable/src/storage.ts';
import { acquireProductControllerLock } from '../packages/shared/src/controller-lock.ts';
import { resolveProductPaths } from '../packages/shared/src/paths.ts';
import { safeCloudAncestors } from './cloud-paths.ts';

export type CloudRuntimeWake = { attemptId: number; requestId: string | null; revision: number; active: boolean; at: number | null; blocked: boolean };
export type CloudRuntimeSession = { storage: Storage; enqueueResult(input: CloudNativeResult): Promise<Result<void>>;
  enqueueOversizedResult(input: CloudNativeOversizedResult): Promise<Result<void>>;
  readObservation(): Promise<Result<number>>; bumpObservation(): Promise<Result<number>>;
  armWake(input: { attemptId: number; requestId?: string }): Promise<Result<number>>;
  recordWake(input: { revision: number; active: boolean; at?: number }): Promise<Result<boolean>>;
  readWake(): Promise<Result<CloudRuntimeWake | null>>;
  finishWake(input: { revision: number; at: number; nextAt: number | null; blocked: boolean }): Promise<Result<boolean>>;
  pendingResults(): Promise<Result<Array<{ event: CloudNativeResult; attempts: number }>>>;
  listResults(input: CloudResultPageRequest): Promise<Result<CloudResultPage>>;
  nextResultRetry(): Promise<Result<number | null>>;
  acknowledgeResult(input: CloudNativeResult, receipt: CloudNativeResultReceipt): Promise<Result<void>>;
  recordDeliveryFailure(input: CloudNativeResult, failure: { deliveryId: string; at: string; nextAt: string }): Promise<Result<void>>;
  retryResult(input: CloudNativeResult): Promise<Result<void>>; retryResultByIdentity(input: CloudResultRetryIdentity): Promise<Result<void>>;
  close(): Promise<Result<void>> };
export type CloudRuntimeStore = {
  openSession(binding: CloudRuntimeBinding, create: boolean): Promise<Result<CloudRuntimeSession>>;
  listBindings(): Promise<Result<Array<{ binding: CloudRuntimeBinding; state: 'allocated' | 'ready' }>>>;
  close(): Promise<Result<void>>;
};

const failure = (code: string, message: string) => fail(appError(code, 'runtime', message, true));
const positiveId = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const wakeTime = z.number().int().nonnegative().max(8_640_000_000_000_000);
const wakeIntent = z.object({ attemptId: positiveId, requestId: z.string().min(1).max(128).optional() }).strict();
const wakeObservation = z.object({ revision: positiveId, active: z.boolean(), at: wakeTime.optional() }).strict();
const wakeFinish = z.object({ revision: positiveId, at: wakeTime, nextAt: wakeTime.nullable(), blocked: z.boolean() }).strict()
  .refine(value => !value.blocked || value.nextAt === null);
const wakeTable = `CREATE TABLE flowmate_cloud_wake (singleton INTEGER PRIMARY KEY CHECK(singleton=1),
  attempt_id INTEGER NOT NULL CHECK(attempt_id>0), request_id TEXT, revision INTEGER NOT NULL CHECK(revision>0),
  active INTEGER NOT NULL CHECK(active IN (0,1)), at_ms INTEGER, blocked INTEGER NOT NULL CHECK(blocked IN (0,1)))`;
class InvalidRuntimePath extends Error {}
class RuntimeOwnerMismatch extends Error {}
function verifyDirectory(path: string): void {
  const item = lstatSync(path);
  if (!item.isDirectory() || item.isSymbolicLink() || relative(resolve(path), realpathSync(path)) !== ''
    || process.platform === 'linux' && (typeof process.getuid !== 'function' || item.uid !== process.getuid()
      || (item.mode & 0o077) !== 0 || !safeCloudAncestors(path, item.uid)))
    throw new InvalidRuntimePath();
}
function verifyDatabaseFile(file: string): void {
  const item = lstatSync(file);
  if (!item.isFile() || item.isSymbolicLink() || relative(file, realpathSync(file)) !== ''
    || process.platform === 'linux' && (typeof process.getuid !== 'function' || item.uid !== process.getuid() || (item.mode & 0o077) !== 0))
    throw new InvalidRuntimePath();
}

async function verifyNativeOwner(storage: Storage, binding: CloudRuntimeBinding): Promise<void> {
  const conversations: ConversationRecord[] = [];
  let cursor: Cursor | undefined;
  do {
    const page = await storage.scanConversations({}, 100, cursor, BACKGROUND_CONTEXT);
    conversations.push(...page.items); cursor = page.next;
  } while (cursor);
  if (!conversations.length) return;
  const roots = conversations.filter(record => !record.owner);
  if (roots.length !== 1) throw new RuntimeOwnerMismatch();
  const root = roots[0]!, records = new Map(conversations.map(record => [record.id, record]));
  for (const record of conversations) {
    const visited = new Set<number>(); let current = record;
    while (current.owner) {
      if (visited.has(current.id)) throw new RuntimeOwnerMismatch();
      visited.add(current.id);
      const task = await storage.task(current.owner.taskId, BACKGROUND_CONTEXT);
      const parent = records.get(current.owner.conversationId);
      if (!task || !parent || task.conversationId !== parent.id) throw new RuntimeOwnerMismatch();
      current = parent;
    }
    if (current.id !== root.id) throw new RuntimeOwnerMismatch();
  }
  const document = await storage.findDocument({ kind: 'flowmate.runtime.binding',
    scope: { kind: 'conversation', conversationId: root.id } }, 'current', BACKGROUND_CONTEXT);
  const saved = document && await storage.document(document.id, 'current', BACKGROUND_CONTEXT);
  if (!saved || saved.version !== 1 || saved.value.workId !== binding.workId || saved.value.sessionId !== binding.sessionId)
    throw new RuntimeOwnerMismatch();
}

/** Opens native Session stores in an existing private root; it does not open or resume a Harness. */
export async function openCloudRuntimeStore(root: string): Promise<Result<CloudRuntimeStore>> {
  const paths = resolveProductPaths(root); if (!paths.ok) return paths;
  const productPaths = paths.data;
  let boundary: string;
  try {
    boundary = realpathSync(productPaths.root);
    if (relative(productPaths.root, boundary) !== '') throw new InvalidRuntimePath();
    verifyDirectory(boundary);
  } catch { return failure('cloud_runtime_path_invalid', 'Cloud runtime root is unavailable.'); }
  const lease = await acquireProductControllerLock(productPaths); if (!lease.ok) return lease;
  try { verifyDirectory(boundary); if (realpathSync(productPaths.root) !== boundary) throw new InvalidRuntimePath(); }
  catch {
    const released = await lease.data.release(); if (!released.ok) return released;
    return failure('cloud_runtime_path_invalid', 'Cloud runtime root is unavailable.');
  }
  type Entry = { binding: CloudRuntimeBinding; promise: Promise<Result<CloudRuntimeSession>>; closing?: boolean };
  const entries = new Map<string, Entry>();
  let closing: Promise<Result<void>> | undefined;
  let ownerUnconfirmed = false;

  async function open(binding: CloudRuntimeBinding, create: boolean): Promise<Result<CloudRuntimeSession>> {
    let db: Database | undefined;
    let coordinator: ReturnType<typeof createDatabaseCoordinator> | undefined;
    let storage: Storage | undefined;
    try {
      verifyDirectory(boundary);
      if (realpathSync(productPaths.root) !== boundary) throw new InvalidRuntimePath();
      const sessions = join(boundary, 'sessions'), directory = join(sessions, binding.cloudRuntimeId);
      if (!existsSync(sessions)) {
        if (!create) return failure('cloud_runtime_session_not_found', 'The original cloud session is unavailable.');
        mkdirSync(sessions, { mode: 0o700 });
      }
      verifyDirectory(sessions);
      if (!existsSync(directory)) {
        if (!create) return failure('cloud_runtime_session_not_found', 'The original cloud session is unavailable.');
        mkdirSync(directory, { mode: 0o700 });
      }
      verifyDirectory(directory);
      const file = join(directory, 'runtime.sqlite');
      const exists = existsSync(file);
      if (!exists && !create) return failure('cloud_runtime_session_not_found', 'The original cloud session is unavailable.');
      if (exists) {
        verifyDatabaseFile(file);
      } else {
        const fd = openSync(file, 'wx', 0o600); closeSync(fd);
      }
      db = new Database(file, { create: false });
      db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=1000; PRAGMA journal_mode=DELETE; PRAGMA locking_mode=EXCLUSIVE');
      const hasBinding = db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='flowmate_cloud_binding'").get();
      if (!hasBinding) {
        if (!create || db.query("SELECT name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' LIMIT 1").get())
          throw new Error('cloud_runtime_binding_missing');
        db.exec('BEGIN IMMEDIATE');
        db.exec(`CREATE TABLE flowmate_cloud_binding (singleton INTEGER PRIMARY KEY CHECK(singleton=1),
          workspace_id TEXT NOT NULL, runtime_id TEXT NOT NULL, work_id INTEGER NOT NULL, session_id INTEGER NOT NULL,
          state TEXT NOT NULL CHECK(state IN ('allocated','ready')))`);
        db.exec("CREATE TRIGGER cloud_binding_immutable BEFORE UPDATE OF workspace_id,runtime_id,work_id,session_id ON flowmate_cloud_binding BEGIN SELECT RAISE(ABORT,'cloud_binding_immutable'); END");
        db.exec("CREATE TRIGGER cloud_binding_state_forward BEFORE UPDATE OF state ON flowmate_cloud_binding WHEN OLD.state!='allocated' OR NEW.state!='ready' BEGIN SELECT RAISE(ABORT,'cloud_binding_state_invalid'); END");
        db.exec("CREATE TRIGGER cloud_binding_preserved BEFORE DELETE ON flowmate_cloud_binding BEGIN SELECT RAISE(ABORT,'cloud_binding_preserved'); END");
        db.exec(`CREATE TABLE flowmate_cloud_results (native_submission_id INTEGER PRIMARY KEY, event_json TEXT NOT NULL CHECK(json_valid(event_json)),
          state TEXT NOT NULL CHECK(state IN ('pending','delivered','blocked')), attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 8),
          next_at TEXT,
          receipt_json TEXT CHECK(receipt_json IS NULL OR json_valid(receipt_json)),
          CHECK((state IN ('pending','blocked') AND receipt_json IS NULL) OR (state='delivered' AND receipt_json IS NOT NULL)))`);
        db.exec(`CREATE TABLE flowmate_cloud_result_attempts (delivery_id TEXT PRIMARY KEY, native_submission_id INTEGER NOT NULL
          REFERENCES flowmate_cloud_results(native_submission_id), attempted_at TEXT NOT NULL, next_at TEXT NOT NULL)`);
        db.exec("CREATE TRIGGER cloud_result_identity_immutable BEFORE UPDATE OF native_submission_id,event_json ON flowmate_cloud_results BEGIN SELECT RAISE(ABORT,'cloud_result_identity_immutable'); END");
        db.exec("CREATE TRIGGER cloud_result_preserved BEFORE DELETE ON flowmate_cloud_results BEGIN SELECT RAISE(ABORT,'cloud_result_preserved'); END");
        db.exec("CREATE TRIGGER cloud_result_attempt_immutable BEFORE UPDATE ON flowmate_cloud_result_attempts BEGIN SELECT RAISE(ABORT,'cloud_result_attempt_immutable'); END");
        db.exec("CREATE TRIGGER cloud_result_attempt_preserved BEFORE DELETE ON flowmate_cloud_result_attempts BEGIN SELECT RAISE(ABORT,'cloud_result_attempt_preserved'); END");
        db.query("INSERT INTO flowmate_cloud_binding VALUES (1,?,?,?,?,'allocated')")
          .run(binding.workspaceId, binding.cloudRuntimeId, binding.workId, binding.sessionId);
        db.exec('COMMIT');
      }
      const saved = db.query<{ workspace_id: string; runtime_id: string; work_id: number; session_id: number; state: string }, []>(
        'SELECT workspace_id,runtime_id,work_id,session_id,state FROM flowmate_cloud_binding WHERE singleton=1').get();
      if (!saved || !isDeepStrictEqual({ workspaceId: saved.workspace_id, cloudRuntimeId: saved.runtime_id,
        workId: saved.work_id, sessionId: saved.session_id }, binding)) {
        db.close(); db = undefined;
        return failure('cloud_runtime_owner_conflict', 'The original cloud session belongs to another Work.');
      }
      if (!db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='flowmate_cloud_results'").get()
        || !db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='flowmate_cloud_result_attempts'").get())
        throw new Error('cloud_result_store_missing');
      if (!db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='flowmate_cloud_wake'").get()) db.exec(wakeTable);
      db.exec('CREATE TABLE IF NOT EXISTS flowmate_cloud_observation (singleton INTEGER PRIMARY KEY CHECK(singleton=1), revision INTEGER NOT NULL CHECK(revision>=0))');
      db.exec('INSERT OR IGNORE INTO flowmate_cloud_observation(singleton,revision) VALUES(1,0)');
      const nativeTables = db.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type='table' AND name GLOB 'fm_durable_*'").all();
      if (saved.state !== 'ready' && (saved.state !== 'allocated' || !create)) throw new Error('cloud_native_initialization_unconfirmed');
      if (saved.state === 'ready' || nativeTables.length > 0) {
        const required = ['durable_schema', 'durable_metadata', 'record_ids', 'conversations', 'entries', 'tasks', 'submissions', 'documents', 'document_revisions'];
        if (required.some(name => !nativeTables.some(table => table.name === `fm_durable_${name}`))) throw new Error('cloud_native_schema_missing');
        const version = db.query<{ singleton: number; version: number }, []>('SELECT singleton,version FROM fm_durable_durable_schema').all();
        if (version.length !== 1 || version[0]?.singleton !== 1 || version[0]?.version !== 2) throw new Error('cloud_native_schema_invalid');
        if (db.query(`SELECT 1 FROM fm_durable_tasks t LEFT JOIN fm_durable_conversations c ON c.id=t.conversation_id WHERE c.id IS NULL
          UNION ALL SELECT 1 FROM fm_durable_entries e LEFT JOIN fm_durable_conversations c ON c.id=e.conversation_id WHERE c.id IS NULL
          UNION ALL SELECT 1 FROM fm_durable_submissions s LEFT JOIN fm_durable_conversations c ON c.id=s.conversation_id WHERE c.id IS NULL
          UNION ALL SELECT 1 FROM fm_durable_documents d WHERE
            (d.scope_kind='conversation' AND NOT EXISTS (SELECT 1 FROM fm_durable_conversations c WHERE c.id=d.owner_id)) OR
            (d.scope_kind='task' AND NOT EXISTS (SELECT 1 FROM fm_durable_tasks t WHERE t.id=d.owner_id))
          UNION ALL SELECT 1 FROM fm_durable_document_revisions r LEFT JOIN fm_durable_documents d ON d.id=r.document_id WHERE d.id IS NULL
          LIMIT 1`).get()) throw new Error('cloud_native_reference_invalid');
      }
      if (saved.state === 'allocated' && nativeTables.length > 0 && db.query('SELECT id FROM fm_durable_record_ids LIMIT 1').get()) {
        throw new Error('cloud_native_initialization_unconfirmed');
      }
      coordinator = createDatabaseCoordinator(db); db = undefined;
      storage = await createDurableSqliteStorage(coordinator);
      await verifyNativeOwner(storage, binding);
      if (saved.state === 'allocated') await coordinator.transaction(async sql => {
        const changed = await sql.run("UPDATE flowmate_cloud_binding SET state='ready' WHERE singleton=1 AND state='allocated'");
        if (changed.changes !== 1) throw new Error('cloud_native_initialization_unconfirmed');
      });
      const owner = coordinator;
      const nativeStorage = storage;
      type ResultRow = { event_json: string; state: string; attempts: number; receipt_json: string | null; next_at: string | null };
      const readResult = (nativeSubmissionId: number) => owner.read(sql => sql.get<ResultRow>(
        'SELECT event_json,state,attempts,receipt_json,next_at FROM flowmate_cloud_results WHERE native_submission_id=?', nativeSubmissionId));
      const validateEvent = (raw: CloudNativeResult) => {
        const event = CloudNativeResultSchema.parse(raw);
        if (event.workspaceId !== binding.workspaceId || event.cloudRuntimeId !== binding.cloudRuntimeId
          || event.workId !== binding.workId || event.sessionId !== binding.sessionId) throw new RuntimeOwnerMismatch();
        return event;
      };
      const validateOversized = (raw: CloudNativeOversizedResult) => {
        const event = CloudNativeOversizedResultSchema.parse(raw);
        if (event.workspaceId !== binding.workspaceId || event.cloudRuntimeId !== binding.cloudRuntimeId
          || event.workId !== binding.workId || event.sessionId !== binding.sessionId) throw new RuntimeOwnerMismatch();
        return event;
      };
      const storedEvent = (row: ResultRow) => z.union([CloudNativeResultSchema, CloudNativeOversizedResultSchema]).parse(JSON.parse(row.event_json));
      const sameEvent = (row: ResultRow, event: CloudNativeResult | CloudNativeOversizedResult) => isDeepStrictEqual(storedEvent(row), event);
      const validateNativeResult = async (event: CloudNativeResult | CloudNativeOversizedResult) => {
        const conversationId = event.nativeConversationId as ConversationId;
        const submission = await nativeStorage.submission(event.nativeSubmissionId as SubmissionId, BACKGROUND_CONTEXT);
        if (!submission || submission.type !== 'input' || submission.conversationId !== conversationId
          || submission.requestId !== JSON.stringify([event.attemptId, event.requestId]) || submission.status !== event.status
          || (submission.entry ?? null) !== event.nativeInputEntryId) throw new RuntimeOwnerMismatch();
        if (submission.status === 'done') {
          const found = await nativeStorage.entry(submission.answer, BACKGROUND_CONTEXT), message = found?.entry.model?.find(value => value.role === 'assistant');
          const answer = message?.role === 'assistant' ? message.content.filter(block => block.type === 'text').map(block => block.text).join('') : null;
          if (submission.answer !== event.nativeAnswerEntryId || found?.entry.kind !== 'pi.assistant' || found.entry.conversationId !== conversationId
            || answer === null || ('answerBytes' in event ? Buffer.byteLength(answer, 'utf8') !== event.answerBytes : answer !== event.answer))
            throw new RuntimeOwnerMismatch();
        } else if (submission.status !== 'unanswered' || ('reasonLength' in event ? submission.reason.length !== event.reasonLength
          : !('reason' in event) || submission.reason !== event.reason)) throw new RuntimeOwnerMismatch();
        if (submission.entry !== undefined) {
          const original = (await nativeStorage.entry(submission.entry, BACKGROUND_CONTEXT))?.entry;
          const data = original?.data as { workId?: number; sessionId?: number; attemptId?: number; requestId?: string } | undefined;
          if (original?.kind !== 'flowmate.input' || original.conversationId !== conversationId || data?.workId !== event.workId
            || data.sessionId !== event.sessionId || data.attemptId !== event.attemptId || data.requestId !== event.requestId) throw new RuntimeOwnerMismatch();
        }
        const document = await nativeStorage.findDocument({ kind: 'flowmate.runtime.consumption',
          scope: { kind: 'conversation', conversationId }, key: JSON.stringify([event.attemptId, event.requestId]) }, 'current', BACKGROUND_CONTEXT);
        const consumed = document && await nativeStorage.document(document.id, 'current', BACKGROUND_CONTEXT);
        if ((consumed?.value.consumedAt ?? null) !== event.consumedAt || consumed && (consumed.value.workId !== event.workId
          || consumed.value.sessionId !== event.sessionId || consumed.value.attemptId !== event.attemptId || consumed.value.requestId !== event.requestId
          || consumed.value.nativeSubmissionId !== event.nativeSubmissionId || consumed.value.nativeEntryId !== event.nativeInputEntryId))
          throw new RuntimeOwnerMismatch();
        if (submission.status !== 'unanswered' || submission.entry !== undefined) {
          for (const status of ['pending', 'running', 'waiting', 'sleeping', 'completing'] as const)
            if ((await nativeStorage.scanTasks({ status }, 1, undefined, BACKGROUND_CONTEXT)).items.length) throw new Error('cloud_result_execution_active');
        }
      };
      let closed: Promise<Result<void>> | undefined;
      const session: CloudRuntimeSession = { storage: nativeStorage,
        async readObservation() {
          try { const row = await owner.read(sql => sql.get<{ revision: number }>('SELECT revision FROM flowmate_cloud_observation WHERE singleton=1'));
            return row && Number.isSafeInteger(row.revision) && row.revision >= 0 ? ok(row.revision)
              : failure('cloud_observation_unavailable', 'The native observation revision is unavailable.');
          } catch { return failure('cloud_observation_unavailable', 'The native observation revision could not be read.'); }
        },
        async bumpObservation() {
          try { return await owner.transaction(async sql => {
            const row = await sql.get<{ revision: number }>('SELECT revision FROM flowmate_cloud_observation WHERE singleton=1');
            if (!row || !Number.isSafeInteger(row.revision) || row.revision < 0 || row.revision >= Number.MAX_SAFE_INTEGER)
              return failure('cloud_observation_unavailable', 'The native observation revision is unavailable.');
            await sql.run('UPDATE flowmate_cloud_observation SET revision=? WHERE singleton=1', row.revision + 1); return ok(row.revision + 1);
          }); } catch { return failure('cloud_observation_unavailable', 'The native observation revision could not be saved.'); }
        },
        async armWake(raw) {
          const parsed = wakeIntent.safeParse(raw); if (!parsed.success) return failure('input_invalid', 'The wake identity is invalid.');
          try {
            return await owner.transaction(async sql => {
              const prior = await sql.get<{ attempt_id: number; request_id: string | null; revision: number }>(
                'SELECT attempt_id,request_id,revision FROM flowmate_cloud_wake WHERE singleton=1');
              const revision = (prior?.revision ?? 0) + 1;
              if (!Number.isSafeInteger(revision)) return failure('cloud_wake_unavailable', 'The original wake revision is unavailable.');
              const same = prior?.attempt_id === parsed.data.attemptId
                && (parsed.data.requestId === undefined || parsed.data.requestId === prior.request_id);
              const requestId = parsed.data.requestId ?? (same ? prior!.request_id : null);
              await sql.run(`INSERT INTO flowmate_cloud_wake(singleton,attempt_id,request_id,revision,active,at_ms,blocked) VALUES(1,?,?,?,0,NULL,0)
                ON CONFLICT(singleton) DO UPDATE SET attempt_id=excluded.attempt_id,request_id=excluded.request_id,revision=excluded.revision,
                active=CASE WHEN ? THEN active ELSE 0 END,at_ms=CASE WHEN ? THEN at_ms ELSE NULL END,blocked=0`,
              parsed.data.attemptId, requestId, revision, same ? 1 : 0, same ? 1 : 0);
              return ok(revision);
            });
          } catch { return failure('cloud_wake_unavailable', 'The original wake intent could not be saved.'); }
        },
        async recordWake(raw) {
          const parsed = wakeObservation.safeParse(raw); if (!parsed.success) return failure('input_invalid', 'The native wake is invalid.');
          try {
            const changed = await owner.transaction(sql => sql.run('UPDATE flowmate_cloud_wake SET active=?,at_ms=?,blocked=0 WHERE singleton=1 AND revision=?',
              parsed.data.active ? 1 : 0, parsed.data.at ?? null, parsed.data.revision));
            return ok(changed.changes === 1);
          } catch { return failure('cloud_wake_unavailable', 'The native wake could not be saved.'); }
        },
        async readWake() {
          try {
            const row = await owner.read(sql => sql.get<{ attempt_id: number; request_id: string | null; revision: number;
              active: number; at_ms: number | null; blocked: number }>('SELECT attempt_id,request_id,revision,active,at_ms,blocked FROM flowmate_cloud_wake WHERE singleton=1'));
            if (!row) return ok(null);
            const checked = z.object({ attemptId: positiveId, requestId: z.string().min(1).max(128).nullable(), revision: positiveId,
              active: z.boolean(), at: wakeTime.nullable(), blocked: z.boolean() }).strict().parse({ attemptId: row.attempt_id,
              requestId: row.request_id, revision: row.revision, active: row.active === 1, at: row.at_ms, blocked: row.blocked === 1 });
            if (![0, 1].includes(row.active) || ![0, 1].includes(row.blocked) || checked.blocked && checked.at !== null) throw Error('invalid_wake');
            return ok(checked);
          } catch { return failure('cloud_wake_unavailable', 'The original wake intent could not be read.'); }
        },
        async finishWake(raw) {
          const parsed = wakeFinish.safeParse(raw); if (!parsed.success) return failure('input_invalid', 'The wake completion is invalid.');
          try {
            const changed = await owner.transaction(sql => sql.run(`UPDATE flowmate_cloud_wake SET at_ms=?,blocked=?
              WHERE singleton=1 AND revision=? AND at_ms=?`, parsed.data.nextAt, parsed.data.blocked ? 1 : 0, parsed.data.revision, parsed.data.at));
            return ok(changed.changes === 1);
          } catch { return failure('cloud_wake_unavailable', 'The original wake completion could not be saved.'); }
        },
        async enqueueResult(raw) {
          try {
            const event = validateEvent(raw), existing = await readResult(event.nativeSubmissionId);
            if (existing) return sameEvent(existing, event) ? ok(undefined) : failure('cloud_result_conflict', 'The original native result differs.');
            await validateNativeResult(event);
            return await owner.transaction(async sql => {
              const prior = await sql.get<ResultRow>('SELECT event_json,state,attempts,receipt_json,next_at FROM flowmate_cloud_results WHERE native_submission_id=?', event.nativeSubmissionId);
              if (prior) return sameEvent(prior, event) ? ok(undefined) : failure('cloud_result_conflict', 'The original native result differs.');
              await sql.run("INSERT INTO flowmate_cloud_results(native_submission_id,event_json,state) VALUES (?,?,'pending')",
                event.nativeSubmissionId, JSON.stringify(event)); return ok(undefined);
            });
          } catch (error) { return failure(error instanceof RuntimeOwnerMismatch ? 'cloud_result_conflict' : 'cloud_result_unavailable',
            'The original native result could not be confirmed.'); }
        },
        async enqueueOversizedResult(raw) {
          try {
            const event = validateOversized(raw), existing = await readResult(event.nativeSubmissionId);
            if (existing) return sameEvent(existing, event) ? ok(undefined) : failure('cloud_result_conflict', 'The original native result differs.');
            await validateNativeResult(event);
            return await owner.transaction(async sql => {
              const prior = await sql.get<ResultRow>('SELECT event_json,state,attempts,receipt_json,next_at FROM flowmate_cloud_results WHERE native_submission_id=?', event.nativeSubmissionId);
              if (prior) return sameEvent(prior, event) ? ok(undefined) : failure('cloud_result_conflict', 'The original native result differs.');
              await sql.run("INSERT INTO flowmate_cloud_results(native_submission_id,event_json,state) VALUES (?,?,'blocked')", event.nativeSubmissionId, JSON.stringify(event));
              return ok(undefined);
            });
          } catch (error) { return failure(error instanceof RuntimeOwnerMismatch ? 'cloud_result_conflict' : 'cloud_result_unavailable',
            'The oversized native result could not be confirmed.'); }
        },
        async pendingResults() {
          try {
            const rows = await owner.read(sql => sql.all<ResultRow>("SELECT event_json,state,attempts,receipt_json,next_at FROM flowmate_cloud_results WHERE state='pending' AND (next_at IS NULL OR next_at<=?) ORDER BY native_submission_id LIMIT 50", new Date().toISOString()));
            return ok(rows.map(row => ({ event: validateEvent(CloudNativeResultSchema.parse(JSON.parse(row.event_json))), attempts: row.attempts })));
          } catch { return failure('cloud_result_unavailable', 'The original native result outbox could not be read.'); }
        },
        async listResults(raw) {
          const parsed = CloudResultPageRequestSchema.safeParse(raw); if (!parsed.success) return failure('input_invalid', 'The result page identity is invalid.');
          try {
            const input = parsed.data, rows = await owner.read(sql => sql.all<ResultRow & { native_submission_id: number }>(
              `SELECT native_submission_id,event_json,state,attempts,receipt_json,next_at FROM flowmate_cloud_results
               WHERE json_extract(event_json,'$.attemptId')=? AND native_submission_id>? ORDER BY native_submission_id LIMIT ?`,
              input.attemptId, input.afterSubmissionId ?? 0, input.limit + 1));
            const items = rows.slice(0, input.limit).map(row => {
              const saved = storedEvent(row), event = 'answerBytes' in saved || 'reasonLength' in saved ? validateOversized(saved) : validateEvent(saved);
              if (event.attemptId !== input.attemptId || event.nativeSubmissionId !== row.native_submission_id
                || (row.state === 'delivered') !== (row.receipt_json !== null)) throw new RuntimeOwnerMismatch();
              if (('answerBytes' in event || 'reasonLength' in event) && (row.state !== 'blocked' || row.attempts !== 0 || row.next_at !== null)) throw new RuntimeOwnerMismatch();
              if (row.receipt_json !== null) {
                const receipt = CloudNativeResultReceiptSchema.parse(JSON.parse(row.receipt_json));
                if (receipt.cloudRuntimeId !== event.cloudRuntimeId || receipt.workId !== event.workId || receipt.sessionId !== event.sessionId
                  || receipt.nativeConversationId !== event.nativeConversationId || receipt.nativeSubmissionId !== event.nativeSubmissionId) throw new RuntimeOwnerMismatch();
              }
              return { requestId: event.requestId, nativeSubmissionId: event.nativeSubmissionId, state: row.state,
                attempts: row.attempts, nextAt: row.next_at, nativeStatus: event.status,
                ...(row.state === 'blocked' ? { blockedReason: 'answerBytes' in event || 'reasonLength' in event ? 'size_limit' as const : 'retry_limit' as const } : {}) };
            });
            return ok(CloudResultPageSchema.parse({ items, nextAfterSubmissionId: rows.length > input.limit ? items.at(-1)?.nativeSubmissionId ?? null : null }));
          } catch { return failure('cloud_result_unavailable', 'The original result delivery page could not be read.'); }
        },
        async nextResultRetry() {
          try {
            const row = await owner.read(sql => sql.get<{ next_at: string | null }>(
              "SELECT next_at FROM flowmate_cloud_results WHERE state='pending' ORDER BY COALESCE(next_at,''),native_submission_id LIMIT 1"));
            if (!row) return ok(null);
            if (row.next_at === null) return ok(0);
            const timestamp = Date.parse(row.next_at);
            return Number.isFinite(timestamp) ? ok(timestamp) : failure('cloud_result_unavailable', 'The original result retry time is invalid.');
          } catch { return failure('cloud_result_unavailable', 'The original result retry time could not be read.'); }
        },
        async acknowledgeResult(raw, rawReceipt) {
          try {
            const event = validateEvent(raw), receipt = CloudNativeResultReceiptSchema.parse(rawReceipt);
            if (receipt.cloudRuntimeId !== event.cloudRuntimeId || receipt.workId !== event.workId || receipt.sessionId !== event.sessionId
              || receipt.nativeConversationId !== event.nativeConversationId || receipt.nativeSubmissionId !== event.nativeSubmissionId)
              return failure('cloud_result_conflict', 'The Authority receipt belongs to another native result.');
            return await owner.transaction(async sql => {
              const prior = await sql.get<ResultRow>('SELECT event_json,state,attempts,receipt_json,next_at FROM flowmate_cloud_results WHERE native_submission_id=?', event.nativeSubmissionId);
              if (!prior || !sameEvent(prior, event)) return failure('cloud_result_conflict', 'The original native result differs.');
              if (prior.state === 'delivered') return prior.receipt_json !== null
                && isDeepStrictEqual(CloudNativeResultReceiptSchema.parse(JSON.parse(prior.receipt_json)), receipt) ? ok(undefined)
                : failure('cloud_result_conflict', 'The original Authority receipt differs.');
              await sql.run("UPDATE flowmate_cloud_results SET state='delivered',receipt_json=?,next_at=NULL WHERE native_submission_id=? AND state IN ('pending','blocked')",
                JSON.stringify(receipt), event.nativeSubmissionId);
              return ok(undefined);
            });
          } catch { return failure('cloud_result_unavailable', 'The original native result acknowledgement could not be confirmed.'); }
        },
        async recordDeliveryFailure(raw, rawFailure) {
          try {
            const event = validateEvent(raw), parsed = z.object({ deliveryId: z.string().uuid(), at: z.string().datetime({ offset: true }),
              nextAt: z.string().datetime({ offset: true }) }).strict().parse(rawFailure);
            const at = new Date(parsed.at).toISOString(), nextAt = new Date(parsed.nextAt).toISOString();
            if (Date.parse(nextAt) <= Date.parse(at)) return failure('input_invalid', 'The result retry time is invalid.');
            return await owner.transaction(async sql => {
              const priorAttempt = await sql.get<{ native_submission_id: number; attempted_at: string; next_at: string }>(
                'SELECT native_submission_id,attempted_at,next_at FROM flowmate_cloud_result_attempts WHERE delivery_id=?', parsed.deliveryId);
              if (priorAttempt) return priorAttempt.native_submission_id === event.nativeSubmissionId && priorAttempt.attempted_at === at && priorAttempt.next_at === nextAt
                ? ok(undefined) : failure('cloud_result_conflict', 'The original delivery attempt differs.');
              const prior = await sql.get<ResultRow>('SELECT event_json,state,attempts,receipt_json,next_at FROM flowmate_cloud_results WHERE native_submission_id=?', event.nativeSubmissionId);
              if (!prior || prior.state !== 'pending' || !sameEvent(prior, event)) return failure('cloud_result_conflict', 'The original native result is not retryable.');
              await sql.run('INSERT INTO flowmate_cloud_result_attempts(delivery_id,native_submission_id,attempted_at,next_at) VALUES(?,?,?,?)',
                parsed.deliveryId, event.nativeSubmissionId, at, nextAt);
              await sql.run("UPDATE flowmate_cloud_results SET attempts=attempts+1,state=CASE WHEN attempts+1>=8 THEN 'blocked' ELSE 'pending' END,next_at=? WHERE native_submission_id=? AND state='pending'",
                nextAt, event.nativeSubmissionId);
              return ok(undefined);
            });
          } catch { return failure('cloud_result_unavailable', 'The original delivery failure could not be recorded.'); }
        },
        async retryResult(raw) {
          try {
            const event = validateEvent(raw);
            return await owner.transaction(async sql => {
              const prior = await sql.get<ResultRow>('SELECT event_json,state,attempts,receipt_json,next_at FROM flowmate_cloud_results WHERE native_submission_id=?', event.nativeSubmissionId);
              if (!prior || !sameEvent(prior, event)) return failure('cloud_result_conflict', 'The original native result differs.');
              if (prior.state === 'pending' && prior.attempts === 0 && prior.next_at === null) return ok(undefined);
              if (prior.state !== 'blocked') return failure('cloud_result_conflict', 'The original native result is not blocked.');
              await sql.run("UPDATE flowmate_cloud_results SET state='pending',attempts=0,next_at=NULL WHERE native_submission_id=? AND state='blocked'", event.nativeSubmissionId);
              return ok(undefined);
            });
          } catch { return failure('cloud_result_unavailable', 'The original result retry could not be confirmed.'); }
        },
        async retryResultByIdentity(raw) {
          const parsed = CloudResultRetryIdentitySchema.safeParse(raw); if (!parsed.success) return failure('input_invalid', 'The result retry identity is invalid.');
          try {
            const row = await readResult(parsed.data.nativeSubmissionId);
            if (!row) return failure('cloud_result_conflict', 'The original native result is unavailable.');
            const saved = storedEvent(row), event = 'answerBytes' in saved || 'reasonLength' in saved ? validateOversized(saved) : validateEvent(saved);
            if (event.attemptId !== parsed.data.attemptId || event.requestId !== parsed.data.requestId
              || event.nativeSubmissionId !== parsed.data.nativeSubmissionId) return failure('cloud_result_conflict', 'The result retry belongs to another phase.');
            if ('answerBytes' in event || 'reasonLength' in event) return failure('cloud_result_too_large', 'The original result exceeds the delivery limit and remains in native history.');
            return session.retryResult(event);
          } catch { return failure('cloud_result_unavailable', 'The original result retry could not be confirmed.'); }
        },
        close() {
        const entry = entries.get(binding.cloudRuntimeId);
        if (entry?.binding === binding) entry.closing = true;
        closed ??= (async () => {
          try {
            await nativeStorage.close(BACKGROUND_CONTEXT); await owner.close();
            if (entries.get(binding.cloudRuntimeId)?.binding === binding) entries.delete(binding.cloudRuntimeId);
            return ok(undefined);
          } catch { return failure('cloud_runtime_close_failed', 'The cloud session could not be closed.'); }
        })();
        return closed;
      } };
      return ok(session);
    } catch (error) {
      try { await storage?.close(BACKGROUND_CONTEXT); } catch { /* still close the database owner */ }
      try { if (coordinator) await coordinator.close(); else db?.close(); }
      catch { ownerUnconfirmed = true; return failure('cloud_runtime_close_failed', 'The cloud storage owner could not be closed.'); }
      if (error instanceof InvalidRuntimePath) return failure('cloud_runtime_path_invalid', 'Cloud session storage is not inside its controlled root.');
      if (error instanceof RuntimeOwnerMismatch) return failure('cloud_runtime_owner_conflict', 'The original native conversation belongs to another Work.');
      return failure('cloud_runtime_storage_unavailable', 'The original cloud session storage is unavailable.');
    }
  }

  return ok({
    async listBindings() {
      if (closing || entries.size || ownerUnconfirmed) return failure('cloud_runtime_busy', 'Cloud Session discovery requires the unopened Runtime owner.');
      try {
        verifyDirectory(boundary);
        const sessions = join(boundary, 'sessions');
        if (!existsSync(sessions)) return ok([]);
        verifyDirectory(sessions);
        const found: Array<{ binding: CloudRuntimeBinding; state: 'allocated' | 'ready' }> = [];
        for (const name of readdirSync(sessions).sort()) {
          if (!CloudRuntimeIdSchema.safeParse(name).success) throw new InvalidRuntimePath();
          const directory = join(sessions, name), file = join(directory, 'runtime.sqlite'); verifyDirectory(directory);
          if (!existsSync(file)) continue;
          verifyDatabaseFile(file);
          const database = new Database(file, { readonly: true });
          try {
            const row = database.query<{ workspace_id: string; runtime_id: string; work_id: number; session_id: number; state: string }, []>(
              'SELECT workspace_id,runtime_id,work_id,session_id,state FROM flowmate_cloud_binding WHERE singleton=1').get();
            if (!row || row.runtime_id !== name || row.state !== 'allocated' && row.state !== 'ready') throw new RuntimeOwnerMismatch();
            const binding = CloudRuntimeBindingSchema.parse({ workspaceId: row.workspace_id, cloudRuntimeId: row.runtime_id,
              workId: row.work_id, sessionId: row.session_id });
            found.push({ binding, state: row.state });
          } finally { database.close(); }
        }
        return ok(found);
      } catch (error) { return failure(error instanceof InvalidRuntimePath ? 'cloud_runtime_path_invalid' : 'cloud_runtime_storage_unavailable',
        'Cloud Session discovery could not verify its original bindings.'); }
    },
    openSession(raw, create) {
      const parsed = CloudRuntimeBindingSchema.safeParse(raw);
      if (!parsed.success || typeof create !== 'boolean')
        return Promise.resolve(failure('input_invalid', 'Cloud session identity is invalid.'));
      if (closing) return Promise.resolve(failure('cloud_runtime_closed', 'The cloud runtime is closing.'));
      if (ownerUnconfirmed) return Promise.resolve(failure('cloud_runtime_close_failed', 'A previous cloud storage owner could not be closed.'));
      const binding = parsed.data, existing = entries.get(binding.cloudRuntimeId);
      if (existing) {
        if (!isDeepStrictEqual(existing.binding, binding))
          return Promise.resolve(failure('cloud_runtime_owner_conflict', 'The original cloud session belongs to another Work.'));
        return existing.closing ? Promise.resolve(failure('cloud_runtime_session_closing', 'The original cloud session is closing.')) : existing.promise;
      }
      const promise = open(binding, create);
      entries.set(binding.cloudRuntimeId, { binding, promise });
      void promise.then(result => { if (!result.ok && entries.get(binding.cloudRuntimeId)?.promise === promise) entries.delete(binding.cloudRuntimeId); });
      return promise;
    },
    close() {
      closing ??= (async () => {
        for (const entry of entries.values()) {
          const opened = await entry.promise;
          if (opened.ok) { const closed = await opened.data.close(); if (!closed.ok) return closed; }
        }
        if (ownerUnconfirmed) return failure('cloud_runtime_close_failed', 'A previous cloud storage owner could not be closed.');
        return lease.data.release();
      })();
      return closing;
    },
  });
}
