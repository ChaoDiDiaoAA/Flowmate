import { z } from 'zod';
import { appError, fail, MemoryConnectionConfigurationSchema, MemoryEntriesPageSchema, MemoryEntriesRequestSchema, MemoryEntryDetailSchema, MemoryEntryRequestSchema,
  MemoryOperationsPageSchema, MemoryOperationsRequestSchema, ok, type MemorySettings, type Result } from '@flowmate/contracts';
import type { DbHandle } from '../storage/database.ts';

const configuration = MemoryConnectionConfigurationSchema;
const policy = z.object({ expectedRevision: configuration.shape.expectedRevision, provider: z.enum(['native', 'openviking']),
  recallEnabled: z.boolean(), captureMode: configuration.shape.captureMode }).strict();
type IdentityRow = { id: number; account_id: string; user_id: string; peer_id: string };
type View = { settings: MemorySettings; identity: { accountId: string; userId: string; peerId: string } | null };

export function createMemoryManager(options: { database: Pick<DbHandle, 'read' | 'transaction'>;
  owner: { environment: 'local' | 'cloud'; ownerId: string }; readCredential(reference: string): Promise<string | undefined>; now(): string }) {
  const owner = z.object({ environment: z.enum(['local', 'cloud']), ownerId: z.string().min(1).max(128) }).strict().parse(options.owner);
  async function get(): Promise<Result<View>> {
    try { return await options.database.read(scope => {
      const settings = scope.memoryIntegration.getSettings(); if (!settings.ok) return settings;
      const identities = scope.db.query<IdentityRow, [string, string]>("SELECT id,account_id,user_id,peer_id FROM memory_identities WHERE environment=? AND owner_id=? AND state='active' LIMIT 2")
        .all(owner.environment, owner.ownerId);
      if (identities.length > 1) return fail(appError('state_conflict', 'runtime', 'The original memory identity is ambiguous.'));
      const row = identities[0];
      return ok({ settings: settings.data, identity: row ? { accountId: row.account_id, userId: row.user_id, peerId: row.peer_id } : null });
    }); } catch { return fail(appError('storage_read_failed', 'storage', 'The original memory settings could not be read.', true)); }
  }
  async function configure(raw: unknown): Promise<Result<View>> {
    const parsed = configuration.safeParse(raw);
    if (!parsed.success) return fail(appError('input_invalid', 'input', 'The memory connection is invalid.'));
    const input = parsed.data;
    let secret: string | undefined, cancel = () => {};
    const timeout = new Promise<undefined>(resolve => { const timer = setTimeout(resolve, 5000); cancel = () => clearTimeout(timer); });
    try { secret = await Promise.race([options.readCredential(input.credentialRef), timeout]); }
    catch { secret = undefined; }
    finally { cancel(); }
    if (!secret?.trim()) return fail(appError('memory_credential_unavailable', 'runtime', 'The memory credential is unavailable.', true));
    let rejected: Result<never> | undefined;
    try {
      return await options.database.transaction(scope => {
        const current = scope.memoryIntegration.getSettings();
        if (!current.ok) { rejected = current; throw Error('memory_settings_unavailable'); }
        if (current.data.revision !== input.expectedRevision) {
          rejected = fail(appError('state_conflict', 'input', 'The memory settings have changed.')); throw Error('memory_settings_conflict');
        }
        const row = scope.db.query<{ id: number }, [string, string, string, string, string]>(`SELECT id FROM memory_identities
          WHERE environment=? AND owner_id=? AND account_id=? AND user_id=? AND peer_id=?`)
          .get(owner.environment, owner.ownerId, input.accountId, input.userId, input.peerId);
        scope.db.query(`UPDATE memory_recalls SET status='disabled',entries_json='[]' WHERE binding_id IN
          (SELECT b.id FROM memory_bindings b JOIN memory_identities i ON i.id=b.identity_id
           WHERE i.environment=? AND i.owner_id=? AND i.state='active' AND i.id!=?)`).run(owner.environment, owner.ownerId, row?.id ?? -1);
        scope.db.query("UPDATE memory_identities SET state='disabled',updated_at=? WHERE environment=? AND owner_id=? AND state='active' AND id!=?")
          .run(options.now(), owner.environment, owner.ownerId, row?.id ?? -1);
        if (row) scope.db.query("UPDATE memory_identities SET credential_ref=?,state='active',updated_at=? WHERE id=?").run(input.credentialRef, options.now(), row.id);
        else scope.db.query(`INSERT INTO memory_identities(environment,owner_id,account_id,user_id,peer_id,credential_ref,state,created_at,updated_at)
          VALUES(?,?,?,?,?,?,'active',?,?)`).run(owner.environment, owner.ownerId, input.accountId, input.userId, input.peerId, input.credentialRef, options.now(), options.now());
        const saved = scope.memoryIntegration.saveSettings({ expectedRevision: input.expectedRevision, provider: 'openviking', endpoint: input.endpoint,
          recallEnabled: input.recallEnabled, captureMode: input.captureMode, at: options.now() });
        if (!saved.ok) { rejected = saved; throw Error('memory_settings_rejected'); }
        return ok({ settings: saved.data, identity: { accountId: input.accountId, userId: input.userId, peerId: input.peerId } });
      });
    } catch { return rejected ?? fail(appError('storage_write_failed', 'storage', 'The memory connection could not be saved.', true)); }
  }
  async function updatePolicy(raw: unknown): Promise<Result<View>> {
    const parsed = policy.safeParse(raw); if (!parsed.success) return fail(appError('input_invalid', 'input', 'The memory policy is invalid.'));
    try { return await options.database.transaction(scope => {
      const current = scope.memoryIntegration.getSettings(); if (!current.ok) return current;
      const identities = scope.db.query<IdentityRow, [string, string]>("SELECT id,account_id,user_id,peer_id FROM memory_identities WHERE environment=? AND owner_id=? AND state='active' LIMIT 2")
        .all(owner.environment, owner.ownerId);
      if (identities.length > 1 || parsed.data.provider === 'openviking' && identities.length !== 1)
        return fail(appError('memory_identity_unavailable', 'runtime', 'The original memory identity is unavailable.'));
      const saved = scope.memoryIntegration.saveSettings({ ...parsed.data, endpoint: current.data.endpoint, at: options.now() });
      if (!saved.ok) return saved;
      const row = identities[0];
      return ok({ settings: saved.data, identity: row ? { accountId: row.account_id, userId: row.user_id, peerId: row.peer_id } : null });
    }); } catch { return fail(appError('storage_write_failed', 'storage', 'The memory policy could not be saved.', true)); }
  }
  async function listEntries(raw: unknown): Promise<Result<z.infer<typeof MemoryEntriesPageSchema>>> {
    const parsed = MemoryEntriesRequestSchema.safeParse(raw);
    if (!parsed.success) return fail(appError('input_invalid', 'input', 'The memory list request is invalid.'));
    try { return await options.database.read(scope => {
      const rows = scope.db.query<{ id: number; endpoint: string; uri: string; revision: number; state: string; identity_state: string }, [string, string, number, number]>(
        `SELECT e.id,e.endpoint,e.uri,e.revision,e.state,i.state AS identity_state FROM memory_entries e
         JOIN memory_identities i ON i.id=e.identity_id WHERE i.environment=? AND i.owner_id=? AND e.id>? ORDER BY e.id LIMIT ?`)
        .all(owner.environment, owner.ownerId, parsed.data.afterId ?? 0, parsed.data.limit + 1);
      const items = rows.slice(0, parsed.data.limit).map(row => ({ entryId: row.id, endpoint: row.endpoint, uri: row.uri,
        revision: row.revision, state: row.state, identityActive: row.identity_state === 'active',
        grants: scope.db.query<{ scope_kind: string; scope_id: string }, [number, number]>(
          'SELECT scope_kind,scope_id FROM memory_grants WHERE entry_id=? AND revision=? ORDER BY scope_kind,scope_id')
          .all(row.id, row.revision).map(grant => ({ kind: grant.scope_kind, scopeId: grant.scope_id })) }));
      return ok(MemoryEntriesPageSchema.parse({ items, nextAfterId: rows.length > parsed.data.limit ? items.at(-1)!.entryId : null }));
    }); } catch { return fail(appError('storage_read_failed', 'storage', 'The memory list could not be read.', true)); }
  }
  async function listOperations(raw: unknown): Promise<Result<z.infer<typeof MemoryOperationsPageSchema>>> {
    const parsed = MemoryOperationsRequestSchema.safeParse(raw);
    if (!parsed.success) return fail(appError('input_invalid', 'input', 'The memory operation list request is invalid.'));
    const kind = parsed.data.kind;
    const sql = kind === 'forget' ? `SELECT r.id,r.request_id,r.state,r.entry_id,NULL AS session_id,NULL AS work_id,NULL AS item_id,
      NULL AS input_id,NULL AS phase_id,r.updated_at FROM memory_forget_requests r JOIN memory_identities i ON i.id=r.identity_id
      WHERE i.environment=? AND i.owner_id=? AND r.id>? ORDER BY r.id LIMIT ?`
      : `SELECT r.id,${kind === 'remember' ? 'r.request_id,r.entry_id' : 'NULL AS request_id,NULL AS entry_id'},r.state,
        b.session_id,b.work_id,b.item_id,r.input_id,r.phase_id,r.updated_at FROM ${kind === 'remember' ? 'memory_remember_requests' : 'memory_sync'} r
        JOIN memory_bindings b ON b.id=r.binding_id JOIN memory_identities i ON i.id=b.identity_id
        WHERE i.environment=? AND i.owner_id=? AND r.id>? ORDER BY r.id LIMIT ?`;
    try { return await options.database.read(scope => {
      const rows = scope.db.query<{ id: number; request_id: string | null; state: string; entry_id: number | null;
        session_id: number | null; work_id: number | null; item_id: number | null; input_id: number | null; phase_id: number | null; updated_at: string },
        [string, string, number, number]>(sql).all(owner.environment, owner.ownerId, parsed.data.afterId ?? 0, parsed.data.limit + 1);
      const items = rows.slice(0, parsed.data.limit).map(row => ({ operationId: row.id, kind, requestId: row.request_id, state: row.state,
        entryId: row.entry_id, sessionId: row.session_id, workId: row.work_id, itemId: row.item_id,
        inputId: row.input_id, phaseId: row.phase_id, updatedAt: row.updated_at }));
      return ok(MemoryOperationsPageSchema.parse({ items, nextAfterId: rows.length > parsed.data.limit ? items.at(-1)!.operationId : null }));
    }); } catch { return fail(appError('storage_read_failed', 'storage', 'The memory operation list could not be read.', true)); }
  }
  async function readEntry(raw: unknown): Promise<Result<z.infer<typeof MemoryEntryDetailSchema>>> {
    const parsed = MemoryEntryRequestSchema.safeParse(raw);
    if (!parsed.success) return fail(appError('input_invalid', 'input', 'The memory entry request is invalid.'));
    try { return await options.database.read(scope => {
      const row = scope.db.query<{ id: number; endpoint: string; uri: string; revision: number; state: string; identity_state: string; source_json: string },
        [number, string, string]>(`SELECT e.id,e.endpoint,e.uri,e.revision,e.state,e.source_json,i.state AS identity_state FROM memory_entries e
          JOIN memory_identities i ON i.id=e.identity_id WHERE e.id=? AND i.environment=? AND i.owner_id=?`)
        .get(parsed.data.entryId, owner.environment, owner.ownerId);
      if (!row) return fail(appError('memory_scope_denied', 'runtime', 'The original memory entry is unavailable.'));
      const source = z.object({ approvedContent: z.string().optional(), origin: z.unknown().optional() }).passthrough().parse(JSON.parse(row.source_json));
      const origin = z.object({ bindingId: z.number().int().positive(), inputId: z.number().int().positive().nullable(),
        phaseId: z.number().int().positive().nullable() }).strict().refine(value => (value.inputId === null) !== (value.phaseId === null)).safeParse(source.origin);
      const grants = scope.db.query<{ scope_kind: string; scope_id: string }, [number, number]>(
        'SELECT scope_kind,scope_id FROM memory_grants WHERE entry_id=? AND revision=? ORDER BY scope_kind,scope_id')
        .all(row.id, row.revision).map(grant => ({ kind: grant.scope_kind, scopeId: grant.scope_id }));
      return ok(MemoryEntryDetailSchema.parse({ entryId: row.id, endpoint: row.endpoint, uri: row.uri, revision: row.revision,
        state: row.state, identityActive: row.identity_state === 'active', grants,
        content: row.state === 'active' ? source.approvedContent ?? null : null, origin: row.state === 'active' && origin.success ? origin.data : null }));
    }); } catch { return fail(appError('storage_read_failed', 'storage', 'The memory entry could not be read.', true)); }
  }
  return { get, configure, updatePolicy, listEntries, readEntry, listOperations };
}
