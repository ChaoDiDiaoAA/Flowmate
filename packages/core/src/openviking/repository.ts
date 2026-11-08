import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { appError, fail, ok, MemorySessionBindingRequestSchema, MemorySessionBindingSchema, MemoryWorkBindingRequestSchema, MemoryWorkBindingSchema, MemoryRecallKeySchema, MemoryRecallReserveSchema, MemoryRecallCompleteSchema, MemoryRecallSnapshotSchema, MemorySettingsSchema, MemorySettingsUpdateSchema,
  type MemorySessionBinding, type MemorySessionBindingRequest, type MemoryWorkBinding, type MemoryWorkBindingRequest, type MemoryRecallKey, type MemoryRecallSnapshot, type MemoryRecallResult, type MemorySettings, type MemorySettingsUpdate, type Result } from '@flowmate/contracts';
import { readTransaction } from '../storage/reads.ts';
import type { SynchronousDatabaseExecutor } from '../storage/write-coordinator.ts';

export interface MemoryIntegrationRepository {
  getSettings(): Result<MemorySettings>;
  saveSettings(input: MemorySettingsUpdate): Result<MemorySettings>;
  getSessionBinding(input: { sessionId: number; branch: number }): Result<MemorySessionBinding | null>;
  getCurrentSessionBinding(sessionId: number): Result<MemorySessionBinding | null>;
  getSessionInputBinding(input: { sessionId: number; inputId: number }): Result<MemorySessionBinding | null>;
  bindSessionInput(input: { sessionId: number; inputId: number; bindingId: number }): Result<void>;
  bindSession(input: MemorySessionBindingRequest): Result<MemorySessionBinding>;
  getWorkBinding(input: { workId: number; itemId: number; branch: number }): Result<MemoryWorkBinding | null>;
  bindWork(input: MemoryWorkBindingRequest): Result<MemoryWorkBinding>;
  getRecall(input: MemoryRecallKey): Result<MemoryRecallSnapshot | null>;
  reserveRecall(input: MemoryRecallKey & { at: string }): Result<{ created: boolean; snapshot: MemoryRecallSnapshot }>;
  completeRecall(input: MemoryRecallKey & { result: MemoryRecallResult }): Result<MemoryRecallSnapshot>;
}
const key = z.object({ sessionId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  branch: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER) }).strict();
const workKey = z.object({ workId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  itemId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), branch: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER) }).strict();
class MemoryFault extends Error { constructor(readonly code: string) { super(code); } }
function requireFact(value: unknown, code: string): asserts value { if (!value) throw new MemoryFault(code); }
type SettingsRow = { revision: number; provider: string; recall_enabled: number; capture_mode: string; endpoint: string | null; updated_at: string };
type BindingRow = { id: number; runtime_kind: string; session_id: number; work_id: number | null; item_id: number | null; branch: number; provider: string;
  identity_id: number | null; remote_session_id: string | null; created_at: string };

type RecallRow = { id: number; binding_id: number; input_id: number | null; phase_id: number | null;
  status: string; entries_json: string; created_at: string };

export function copySessionMemoryBinding(db: SynchronousDatabaseExecutor, sourceSessionId: number, targetSessionId: number, at: string): void {
  if (!db.inTransaction) throw Error('memory_binding_transaction_required');
  const source = db.query<{ branch: number; provider: 'native' | 'openviking'; identity_id: number | null; endpoint: string | null }, [number]>(
    "SELECT branch,provider,identity_id,endpoint FROM memory_bindings WHERE runtime_kind='agent_session' AND session_id=? ORDER BY branch DESC LIMIT 1")
    .get(sourceSessionId);
  if (!source || sourceSessionId === targetSessionId && source.provider === 'native') return;
  const branch = sourceSessionId === targetSessionId ? source.branch + 1 : 0;
  if (!Number.isSafeInteger(branch)) throw Error('memory_binding_branch_exhausted');
  db.query(`INSERT INTO memory_bindings(runtime_kind,session_id,branch,provider,identity_id,remote_session_id,endpoint,remote_state,created_at)
    VALUES('agent_session',?,?,?,?,?,?,?,?)`).run(targetSessionId, branch, source.provider, source.identity_id,
      source.provider === 'openviking' ? randomUUID() : null, source.endpoint, source.provider === 'openviking' ? 'pending' : null, at);
  if (sourceSessionId !== targetSessionId && source.provider === 'openviking')
    db.query(`INSERT INTO memory_grants(entry_id,scope_kind,scope_id,revision)
      SELECT g.entry_id,'session',?,g.revision FROM memory_grants g JOIN memory_entries e ON e.id=g.entry_id
      WHERE g.scope_kind='session' AND g.scope_id=? AND e.identity_id=? AND e.endpoint=? AND e.state='active' AND e.revision=g.revision`)
      .run(String(targetSessionId), String(sourceSessionId), source.identity_id, source.endpoint);
}
export function createMemoryIntegrationRepository(db: SynchronousDatabaseExecutor): MemoryIntegrationRepository {
  function operation<T>(write: boolean, body: () => T): Result<T> {
    try {
      if (write) requireFact(db.inTransaction, 'state_conflict');
      return ok(write ? db.transaction(body).immediate() : readTransaction(db, body));
    } catch (error) {
      const code = error instanceof MemoryFault ? error.code : error instanceof z.ZodError ? 'storage_corrupt'
        : write ? 'storage_write_failed' : 'storage_read_failed';
      return fail(appError(code, code === 'input_invalid' || code === 'state_conflict' ? 'input' : 'storage',
        'The original memory configuration or binding could not be confirmed.', code.startsWith('storage_')));
    }
  }
  function settings(): MemorySettings {
    const row = db.query<SettingsRow, []>('SELECT * FROM memory_config WHERE id=1').get();
    requireFact(row, 'storage_corrupt');
    return MemorySettingsSchema.parse({ revision: row.revision, provider: row.provider, recallEnabled: row.recall_enabled === 1,
      captureMode: row.capture_mode, endpoint: row.endpoint, updatedAt: row.updated_at });
  }
  function session(sessionId: number): void {
    requireFact(db.query('SELECT id FROM sessions WHERE id=? AND runtime_kind=\'agent_session\'').get(sessionId), 'session_not_found');
  }
  function binding(sessionId: number, branch: number): MemorySessionBinding | null {
    const row = db.query<BindingRow, [number, number]>("SELECT * FROM memory_bindings WHERE runtime_kind='agent_session' AND session_id=? AND branch=?").get(sessionId, branch);
    return row ? MemorySessionBindingSchema.parse({ id: row.id, runtimeKind: row.runtime_kind, sessionId: row.session_id,
      branch: row.branch, provider: row.provider, identityId: row.identity_id, remoteSessionId: row.remote_session_id, createdAt: row.created_at }) : null;
  }
  function workOwner(workId: number, itemId: number): number {
    const row = db.query<{ session_id: number }, [number, number]>(`SELECT w.session_id FROM invoice_works w
      JOIN invoice_work_items i ON i.work_id=w.id JOIN sessions s ON s.id=w.session_id
      WHERE w.id=? AND i.id=? AND s.runtime_kind='durable'`).get(workId, itemId);
    requireFact(row, 'state_conflict'); return row.session_id;
  }
  function workBinding(workId: number, itemId: number, branch: number): MemoryWorkBinding | null {
    const row = db.query<BindingRow, [number, number, number]>("SELECT * FROM memory_bindings WHERE runtime_kind='durable' AND work_id=? AND item_id=? AND branch=?").get(workId, itemId, branch);
    return row ? MemoryWorkBindingSchema.parse({ id: row.id, runtimeKind: row.runtime_kind, sessionId: row.session_id,
      workId: row.work_id, itemId: row.item_id, branch: row.branch, provider: row.provider, identityId: row.identity_id,
      remoteSessionId: row.remote_session_id, createdAt: row.created_at }) : null;
  }
  function recall(input: MemoryRecallKey): MemoryRecallSnapshot | null {
    const row = db.query<RecallRow, [number, number | null, number | null]>(
      'SELECT * FROM memory_recalls WHERE binding_id=? AND input_id IS ? AND phase_id IS ?').get(input.bindingId, input.inputId, input.phaseId);
    return row ? MemoryRecallSnapshotSchema.parse({ id: row.id, bindingId: row.binding_id, inputId: row.input_id, phaseId: row.phase_id,
      status: row.status, items: JSON.parse(row.entries_json), createdAt: row.created_at }) : null;
  }
  return {
    getSettings() { return operation(false, settings); },
    saveSettings(raw) {
      return operation(true, () => {
        const parsed = MemorySettingsUpdateSchema.safeParse(raw); requireFact(parsed.success, 'input_invalid');
        const input = parsed.data, current = settings(); requireFact(current.revision === input.expectedRevision, 'state_conflict');
        const changed = db.query(`UPDATE memory_config SET revision=revision+1,provider=?,recall_enabled=?,capture_mode=?,endpoint=?,updated_at=?
          WHERE id=1 AND revision=?`).run(input.provider, input.recallEnabled ? 1 : 0, input.captureMode, input.endpoint, input.at, input.expectedRevision);
        requireFact(changed.changes === 1, 'state_conflict');
        if (!input.recallEnabled || current.endpoint !== input.endpoint)
          db.query("UPDATE memory_recalls SET status='disabled',entries_json='[]' WHERE status!='disabled'").run();
        return settings();
      });
    },
    getSessionBinding(raw) {
      return operation(false, () => { const parsed = key.safeParse(raw); requireFact(parsed.success, 'input_invalid');
        session(parsed.data.sessionId); return binding(parsed.data.sessionId, parsed.data.branch); });
    },
    getCurrentSessionBinding(sessionId) {
      return operation(false, () => {
        requireFact(key.shape.sessionId.safeParse(sessionId).success, 'input_invalid'); session(sessionId);
        const row = db.query<{ branch: number }, [number]>("SELECT branch FROM memory_bindings WHERE runtime_kind='agent_session' AND session_id=? ORDER BY branch DESC LIMIT 1").get(sessionId);
        return row ? binding(sessionId, row.branch) : null;
      });
    },
    getSessionInputBinding(input) {
      return operation(false, () => {
        requireFact(z.object({ sessionId: key.shape.sessionId, inputId: key.shape.sessionId }).strict().safeParse(input).success, 'input_invalid');
        const row = db.query<{ branch: number }, [number, number]>(`SELECT b.branch FROM memory_input_bindings m JOIN memory_bindings b ON b.id=m.binding_id
          JOIN session_inputs i ON i.id=m.input_id WHERE i.id=? AND i.session_id=? AND b.session_id=i.session_id AND b.runtime_kind='agent_session'`)
          .get(input.inputId, input.sessionId);
        return row ? binding(input.sessionId, row.branch) : null;
      });
    },
    bindSessionInput(input) {
      return operation(true, () => {
        requireFact(z.object({ sessionId: key.shape.sessionId, inputId: key.shape.sessionId, bindingId: key.shape.sessionId }).strict().safeParse(input).success, 'input_invalid');
        requireFact(db.query("SELECT b.id FROM memory_bindings b JOIN session_inputs i ON i.session_id=b.session_id WHERE b.id=? AND i.id=? AND b.session_id=? AND b.runtime_kind='agent_session'")
          .get(input.bindingId, input.inputId, input.sessionId), 'state_conflict');
        const original = db.query<{ binding_id: number }, [number]>('SELECT binding_id FROM memory_input_bindings WHERE input_id=?').get(input.inputId);
        if (original) { requireFact(original.binding_id === input.bindingId, 'state_conflict'); return; }
        db.query('INSERT INTO memory_input_bindings(input_id,binding_id) VALUES(?,?)').run(input.inputId, input.bindingId);
      });
    },
    getRecall(raw) {
      return operation(false, () => { const parsed = MemoryRecallKeySchema.safeParse(raw); requireFact(parsed.success, 'input_invalid'); return recall(parsed.data); });
    },
    reserveRecall(raw) {
      return operation(true, () => {
        const parsed = MemoryRecallReserveSchema.safeParse(raw); requireFact(parsed.success, 'input_invalid');
        const { at, ...input } = parsed.data;
        const previous = recall(input); if (previous) return { created: false, snapshot: previous };
        requireFact(db.query("SELECT id FROM memory_bindings WHERE id=? AND provider='openviking'").get(input.bindingId), 'state_conflict');
        db.query("INSERT INTO memory_recalls(binding_id,input_id,phase_id,status,created_at) VALUES(?,?,?,'pending',?)")
          .run(input.bindingId, input.inputId, input.phaseId, at);
        const saved = recall(input); requireFact(saved, 'storage_write_failed'); return { created: true, snapshot: saved };
      });
    },
    completeRecall(raw) {
      return operation(true, () => {
        const parsed = MemoryRecallCompleteSchema.safeParse(raw); requireFact(parsed.success, 'input_invalid');
        const { result, ...input } = parsed.data, previous = recall(input); requireFact(previous, 'state_conflict');
        if (previous.status !== 'pending') { requireFact(previous.status === result.status && isDeepStrictEqual(previous.items, result.items), 'state_conflict'); return previous; }
        const changed = db.query("UPDATE memory_recalls SET status=?,entries_json=? WHERE id=? AND status='pending'")
          .run(result.status, JSON.stringify(result.items), previous.id); requireFact(changed.changes === 1, 'state_conflict');
        const saved = recall(input); requireFact(saved, 'storage_write_failed'); return saved;
      });
    },
    getWorkBinding(raw) {
      return operation(false, () => { const parsed = workKey.safeParse(raw); requireFact(parsed.success, 'input_invalid');
        workOwner(parsed.data.workId, parsed.data.itemId); return workBinding(parsed.data.workId, parsed.data.itemId, parsed.data.branch); });
    },
    bindWork(raw) {
      return operation(true, () => {
        const parsed = MemoryWorkBindingRequestSchema.safeParse(raw); requireFact(parsed.success, 'input_invalid');
        const input = parsed.data; requireFact(workOwner(input.workId, input.itemId) === input.sessionId, 'state_conflict');
        const prior = workBinding(input.workId, input.itemId, input.branch);
        if (prior) { requireFact(prior.sessionId === input.sessionId && prior.provider === input.provider
          && prior.identityId === input.identityId && prior.remoteSessionId === input.remoteSessionId, 'state_conflict'); return prior; }
        if (input.identityId !== null) requireFact(db.query("SELECT id FROM memory_identities WHERE id=? AND state='active'").get(input.identityId), 'state_conflict');
        const endpoint = input.provider === 'openviking' ? settings().endpoint : null;
        if (input.provider === 'openviking') requireFact(endpoint, 'state_conflict');
        db.query(`INSERT INTO memory_bindings(runtime_kind,session_id,work_id,item_id,branch,provider,identity_id,remote_session_id,endpoint,remote_state,created_at)
          VALUES('durable',?,?,?,?,?,?,?,?,?,?)`).run(input.sessionId, input.workId, input.itemId, input.branch, input.provider,
          input.identityId, input.remoteSessionId, endpoint, input.provider === 'openviking' ? 'pending' : null, input.at);
        const saved = workBinding(input.workId, input.itemId, input.branch); requireFact(saved, 'storage_write_failed'); return saved;
      });
    },
    bindSession(raw) {
      return operation(true, () => {
        const parsed = MemorySessionBindingRequestSchema.safeParse(raw); requireFact(parsed.success, 'input_invalid');
        const input = parsed.data; session(input.sessionId);
        const prior = binding(input.sessionId, input.branch);
        if (prior) { requireFact(prior.provider === input.provider && prior.identityId === input.identityId
          && prior.remoteSessionId === input.remoteSessionId, 'state_conflict'); return prior; }
        if (input.identityId !== null) requireFact(db.query("SELECT id FROM memory_identities WHERE id=? AND state='active'").get(input.identityId), 'state_conflict');
        const endpoint = input.provider === 'openviking' ? settings().endpoint : null;
        if (input.provider === 'openviking') requireFact(endpoint, 'state_conflict');
        db.query(`INSERT INTO memory_bindings(runtime_kind,session_id,branch,provider,identity_id,remote_session_id,endpoint,remote_state,created_at)
          VALUES('agent_session',?,?,?,?,?,?,?,?)`).run(input.sessionId, input.branch, input.provider, input.identityId, input.remoteSessionId, endpoint,
          input.provider === 'openviking' ? 'pending' : null, input.at);
        const saved = binding(input.sessionId, input.branch); requireFact(saved, 'storage_write_failed'); return saved;
      });
    },
  };
}
