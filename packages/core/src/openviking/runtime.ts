import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { appError, fail, MemoryForgetCheckSchema, MemoryForgetWriteSchema, ok, type MemoryRecallKey, type MemoryRecallResult, type MemorySettings, type Result } from '@flowmate/contracts';
import type { DbHandle, SqlDatabaseStore } from '../storage/database.ts';
import { createOpenVikingService } from './service.ts';
import { createMemorySync } from './sync.ts';
import { hasCredentialMarker } from './privacy.ts';

const id = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const inputSchema = z.object({ bindingId: id, inputId: id.nullable(), phaseId: id.nullable(),
  owner: z.object({ environment: z.enum(['local', 'cloud']), ownerId: z.string().min(1).max(128) }).strict(),
  query: z.string().trim().min(1).max(500), timeoutMs: z.number().int().min(1).max(2000) }).strict()
  .refine(value => (value.inputId === null) !== (value.phaseId === null));
type Input = z.infer<typeof inputSchema>;
const workInputSchema = z.object({ workId: id, sessionId: id, itemId: id, attemptId: id, phaseId: id,
  requestId: z.string().min(1).max(128), owner: inputSchema.innerType().shape.owner,
  query: z.string().trim().min(1).max(500), timeoutMs: z.number().int().min(1).max(2000) }).strict();
const rememberInputSchema = z.object({ bindingId: id, inputId: id.nullable(), phaseId: id.nullable(), owner: inputSchema.innerType().shape.owner,
  requestId: z.string().trim().min(1).max(128), content: z.string().min(1).refine(value => value.trim().length > 0 && new TextEncoder().encode(value).byteLength <= 65000),
  scope: z.discriminatedUnion('kind', [z.object({ kind: z.literal('personal') }).strict(),
    z.object({ kind: z.literal('session'), sessionId: id }).strict(), z.object({ kind: z.literal('work'), workId: id }).strict()]),
  confirmed: z.literal(true) }).strict().refine(value => (value.inputId === null) !== (value.phaseId === null));
const forgetInputSchema = MemoryForgetWriteSchema.extend({ owner: inputSchema.innerType().shape.owner })
  .or(MemoryForgetCheckSchema.extend({ owner: inputSchema.innerType().shape.owner }));
type RememberInput = z.infer<typeof rememberInputSchema>;
type ForgetInput = z.infer<typeof forgetInputSchema>;
type RememberRow = { id: number; binding_id: number; input_id: number | null; phase_id: number | null; request_id: string;
  uri: string; content: string; scope_kind: 'personal' | 'session' | 'work'; scope_id: string; state: 'pending' | 'sending' | 'unknown' | 'completed' | 'failed' | 'forgotten';
  content_confirmed: number; entry_id: number | null };
type RememberResult = { requestId: string; state: 'pending' | 'unknown' | 'completed' | 'failed'; uri: string; entryId: number | null; contentConfirmed: boolean };
type ForgetResult = { requestId: string; entryId: number; state: 'pending' | 'unknown' | 'completed' | 'conflict' };
type Identity = { id: number; accountId: string; userId: string; peerId: string; credentialRef: string; active: boolean };
type Authorized = { provider: 'native' | 'openviking'; settings: MemorySettings; identity: Identity | null; remoteSessionId: string | null };
type BindingRow = { provider: 'native' | 'openviking'; runtime_kind: 'agent_session' | 'durable'; session_id: number;
  endpoint: string | null; remote_session_id: string | null; identity_id: number | null;
  work_id: number | null; item_id: number | null; durable_runtime_id: string; cloud_workspace_id: string | null;
  hidden_at: string | null; delete_pending: number;
  environment: string | null; owner_id: string | null; account_id: string | null; user_id: string | null; peer_id: string | null;
  credential_ref: string | null; identity_state: string | null };
const denied = () => fail(appError('memory_scope_denied', 'runtime', 'The original memory owner or input is unavailable.'));
const unavailable = (): MemoryRecallResult => ({ status: 'unavailable', items: [] });
const disabled = (): MemoryRecallResult => ({ status: 'disabled', items: [] });
const sameIdentity = (current: Identity | null, original: Identity) => current?.active === true && current.id === original.id
  && current.accountId === original.accountId && current.userId === original.userId && current.peerId === original.peerId && current.credentialRef === original.credentialRef;

export function createMemoryRuntime(options: { database: Pick<DbHandle, 'read' | 'transaction'>;
  readCredential(reference: string): Promise<string | undefined>; now(): string; fetch?: typeof fetch; owner?: Input['owner'] }) {
  const active = new Map<string, Promise<Result<MemoryRecallResult>>>();
  const remembering = new Map<string, { input: RememberInput; promise: Promise<Result<RememberResult>> }>();
  const forgetting = new Map<string, { input: ForgetInput; promise: Promise<Result<ForgetResult>> }>();
  const sessions = new Map<number, Promise<boolean>>();
  async function ensureMirrorSession(bindingId: number, remoteSessionId: string, service: ReturnType<typeof createOpenVikingService>): Promise<boolean> {
    const existing = sessions.get(bindingId); if (existing) return existing;
    const pending = (async () => {
      const state = await options.database.transaction(scope => {
        const row = scope.db.query<{ remote_state: string }, [number, string]>(
          "SELECT remote_state FROM memory_bindings WHERE id=? AND remote_session_id=? AND provider='openviking'").get(bindingId, remoteSessionId);
        if (!row || row.remote_state === 'creating') return 'blocked';
        if (row.remote_state === 'unknown') return 'verify';
        if (row.remote_state === 'ready') return 'ready';
        const claimed = scope.db.query(`UPDATE memory_bindings SET remote_state='creating' WHERE id=? AND remote_state='pending'
          AND EXISTS (SELECT 1 FROM sessions s WHERE s.id=memory_bindings.session_id AND s.hidden_at IS NULL
            AND COALESCE(json_extract(s.metadata_json,'$.delete_pending'),0)!=1)`).run(bindingId).changes === 1;
        return claimed ? 'create' : 'unknown';
      });
      if (state === 'ready') return service.verifyMirrorSession(remoteSessionId);
      if (state === 'verify') {
        if (!await service.verifyMirrorSession(remoteSessionId)) return false;
        return options.database.transaction(scope => {
          scope.db.query(`UPDATE memory_bindings SET remote_state='ready' WHERE id=? AND remote_session_id=? AND remote_state='unknown'
            AND EXISTS (SELECT 1 FROM sessions s WHERE s.id=memory_bindings.session_id AND s.hidden_at IS NULL
              AND COALESCE(json_extract(s.metadata_json,'$.delete_pending'),0)!=1)`).run(bindingId, remoteSessionId);
          return scope.db.query(`SELECT b.id FROM memory_bindings b JOIN sessions s ON s.id=b.session_id
            WHERE b.id=? AND b.remote_session_id=? AND b.remote_state='ready' AND s.hidden_at IS NULL
              AND COALESCE(json_extract(s.metadata_json,'$.delete_pending'),0)!=1`).get(bindingId, remoteSessionId) !== null;
        });
      }
      if (state !== 'create') return false;
      const created = await service.createMirrorSession(remoteSessionId);
      const status = created.ok ? 'ready' : 'unknown';
      const saved = await options.database.transaction(scope => scope.db.query(
        "UPDATE memory_bindings SET remote_state=? WHERE id=? AND remote_state='creating'").run(status, bindingId).changes === 1);
      return created.ok && saved;
    })().catch(() => false);
    sessions.set(bindingId, pending);
    try { return await pending; } finally { if (sessions.get(bindingId) === pending) sessions.delete(bindingId); }
  }
  const sync = createMemorySync(options, ensureMirrorSession);
  function bindSessionInStore(scope: SqlDatabaseStore, sessionId: number, owner: Input['owner']) {
    const prior = scope.memoryIntegration.getCurrentSessionBinding(sessionId);
    if (!prior.ok || prior.data) return prior;
    const settings = scope.memoryIntegration.getSettings(); if (!settings.ok) return settings;
    const identities = settings.data.provider === 'openviking' ? scope.db.query<{ id: number }, [string, string]>(
      "SELECT id FROM memory_identities WHERE environment=? AND owner_id=? AND state='active'").all(owner.environment, owner.ownerId) : [];
    if (settings.data.provider === 'openviking' && identities.length !== 1) return ok(null);
    return scope.memoryIntegration.bindSession({ sessionId, branch: 0, provider: settings.data.provider,
      identityId: identities[0]?.id ?? null, remoteSessionId: identities.length ? randomUUID() : null, at: options.now() });
  }
  function bindWorkInStore(scope: SqlDatabaseStore, work: { workId: number; sessionId: number }, owner: Input['owner']): Result<void> {
    const session = scope.db.query<{ durable_runtime_id: string; cloud_workspace_id: string | null }, [number, number]>(
      `SELECT s.durable_runtime_id,s.cloud_workspace_id FROM invoice_works w JOIN sessions s ON s.id=w.session_id
       WHERE w.id=? AND s.id=? AND s.runtime_kind='durable'`).get(work.workId, work.sessionId);
    if (!session || (owner.environment === 'local' ? session.durable_runtime_id !== 'local' || session.cloud_workspace_id !== null
      : session.durable_runtime_id === 'local' || session.cloud_workspace_id !== owner.ownerId)) return denied();
    const settings = scope.memoryIntegration.getSettings(); if (!settings.ok) return settings;
    const identities = settings.data.provider === 'openviking' ? scope.db.query<{ id: number }, [string, string]>(
      "SELECT id FROM memory_identities WHERE environment=? AND owner_id=? AND state='active'").all(owner.environment, owner.ownerId) : [];
    if (settings.data.provider === 'openviking' && identities.length !== 1) return ok(undefined);
    const items = scope.db.query<{ id: number }, [number]>('SELECT id FROM invoice_work_items WHERE work_id=? ORDER BY id').all(work.workId);
    for (const item of items) {
      const prior = scope.memoryIntegration.getWorkBinding({ workId: work.workId, itemId: item.id, branch: 0 });
      if (!prior.ok) return prior;
      if (prior.data) continue;
      const saved = scope.memoryIntegration.bindWork({ workId: work.workId, sessionId: work.sessionId, itemId: item.id, branch: 0, provider: settings.data.provider,
        identityId: identities[0]?.id ?? null, remoteSessionId: identities.length ? randomUUID() : null, at: options.now() });
      if (!saved.ok) return saved;
    }
    return ok(undefined);
  }
  async function authorize(input: Input): Promise<Result<Authorized>> {
    try {
      return await options.database.read(scope => {
        const row = scope.db.query<BindingRow, [number]>(`SELECT b.provider,b.runtime_kind,b.session_id,b.work_id,b.item_id,b.endpoint,b.remote_session_id,b.identity_id,
          s.durable_runtime_id,s.cloud_workspace_id,s.hidden_at,COALESCE(json_extract(s.metadata_json,'$.delete_pending'),0) AS delete_pending,
          i.environment,i.owner_id,i.account_id,i.user_id,i.peer_id,i.credential_ref,i.state AS identity_state
          FROM memory_bindings b JOIN sessions s ON s.id=b.session_id LEFT JOIN memory_identities i ON i.id=b.identity_id WHERE b.id=?`).get(input.bindingId);
        if (!row || row.hidden_at !== null || row.delete_pending === 1) return denied();
        const local = row.durable_runtime_id === 'local' && row.cloud_workspace_id === null;
        if (input.owner.environment === 'local' ? !local : local || row.cloud_workspace_id !== input.owner.ownerId) return denied();
        const source = input.inputId !== null
          ? row.runtime_kind === 'agent_session' && scope.db.query(`SELECT i.id FROM session_inputs i JOIN memory_input_bindings m ON m.input_id=i.id
              WHERE i.id=? AND i.session_id=? AND m.binding_id=?`).get(input.inputId, row.session_id, input.bindingId)
          : row.runtime_kind === 'durable' && scope.db.query('SELECT id FROM invoice_work_phases WHERE id=? AND work_id=? AND item_id=?')
            .get(input.phaseId, row.work_id, row.item_id);
        if (!source) return denied();
        const settings = scope.memoryIntegration.getSettings(); if (!settings.ok) return settings;
        if (row.provider === 'native') return ok({ provider: row.provider, settings: settings.data, identity: null, remoteSessionId: null });
        if (row.environment !== input.owner.environment || row.owner_id !== input.owner.ownerId || !row.account_id || !row.user_id || !row.peer_id || !row.credential_ref || !row.remote_session_id || !row.identity_id)
          return denied();
        return ok({ provider: row.provider, settings: settings.data, remoteSessionId: row.remote_session_id, identity: { id: row.identity_id, accountId: row.account_id, userId: row.user_id, peerId: row.peer_id,
          credentialRef: row.credential_ref, active: row.identity_state === 'active' && row.endpoint === settings.data.endpoint } });
      });
    } catch { return fail(appError('storage_read_failed', 'storage', 'The memory owner could not be checked.', true)); }
  }
  async function credentialWithin(reference: string, milliseconds: number): Promise<string | undefined> {
    let cancel = () => {};
    const timeout = new Promise<undefined>(resolve => { const timer = setTimeout(resolve, milliseconds); cancel = () => clearTimeout(timer); });
    try { return await Promise.race([options.readCredential(reference), timeout]); }
    catch { return undefined; }
    finally { cancel(); }
  }
  function allowedEntries(scope: Parameters<Parameters<typeof options.database.read>[0]>[0], input: Input): Array<{ uri: string; revision: number; approvedContent: string }> {
    // The saved origin survives deletion of its source Session or Work.
    return scope.db.query<{ uri: string; revision: number; source_json: string }, [number, string]>(`SELECT DISTINCT e.uri,e.revision,e.source_json FROM memory_entries e
      JOIN memory_grants g ON g.entry_id=e.id AND g.revision=e.revision
      JOIN memory_bindings b ON b.identity_id=e.identity_id AND b.endpoint=e.endpoint
      WHERE b.id=? AND e.state='active' AND (
        (g.scope_kind='personal' AND g.scope_id=? AND json_type(e.source_json,'$.origin.bindingId')='integer' AND (
          (b.runtime_kind='agent_session' AND json_type(e.source_json,'$.origin.inputId')='integer'
            AND json_type(e.source_json,'$.origin.phaseId')='null') OR
          (b.runtime_kind='durable' AND json_type(e.source_json,'$.origin.inputId')='null'
            AND json_type(e.source_json,'$.origin.phaseId')='integer'))) OR
        (g.scope_kind='session' AND b.runtime_kind='agent_session' AND g.scope_id=CAST(b.session_id AS TEXT)) OR
        (g.scope_kind='work' AND b.runtime_kind='durable' AND g.scope_id=CAST(b.work_id AS TEXT)))`)
      .all(input.bindingId, input.owner.ownerId).map(row => ({ uri: row.uri, revision: row.revision,
        approvedContent: z.object({ version: z.literal(1), approvedContent: z.string().min(1) }).passthrough().parse(JSON.parse(row.source_json)).approvedContent }));
  }
  async function authorizedSnapshot(input: Input, result: MemoryRecallResult, settingsRevision: number): Promise<MemoryRecallResult> {
    if (result.status !== 'ready') return result;
    return options.database.transaction(scope => {
      const valid = scope.db.query(`SELECT b.id FROM memory_bindings b JOIN memory_identities i ON i.id=b.identity_id
        JOIN sessions s ON s.id=b.session_id JOIN memory_config c ON c.id=1 JOIN memory_recalls r ON r.binding_id=b.id
        WHERE b.id=? AND r.input_id IS ? AND r.phase_id IS ? AND r.status='ready' AND c.revision=? AND c.recall_enabled=1
        AND c.endpoint=b.endpoint AND i.state='active' AND i.environment=? AND i.owner_id=? AND s.hidden_at IS NULL
        AND COALESCE(json_extract(s.metadata_json,'$.delete_pending'),0)!=1`)
        .get(input.bindingId, input.inputId, input.phaseId, settingsRevision, input.owner.environment, input.owner.ownerId);
      if (!valid) return disabled();
      const allowed = allowedEntries(scope, input), items = result.items.filter(item => allowed.some(entry => entry.uri === item.uri && entry.revision === item.revision));
      if (items.length === result.items.length) return result;
      const reduced: MemoryRecallResult = items.length ? { status: 'ready', items } : disabled();
      scope.db.query("UPDATE memory_recalls SET status=?,entries_json=? WHERE binding_id=? AND input_id IS ? AND phase_id IS ?")
        .run(reduced.status, JSON.stringify(reduced.items), input.bindingId, input.inputId, input.phaseId);
      return reduced;
    });
  }
  async function run(input: Input, original: Authorized): Promise<Result<MemoryRecallResult>> {
    if (original.provider === 'native') return ok(disabled());
    const key: MemoryRecallKey = { bindingId: input.bindingId, inputId: input.inputId, phaseId: input.phaseId };
    const reservation = await options.database.transaction(scope => scope.memoryIntegration.reserveRecall({ ...key, at: options.now() }));
    if (!reservation.ok) return reservation;
    if (!original.settings.recallEnabled || !original.identity?.active) {
      await options.database.transaction(scope => scope.db.query("UPDATE memory_recalls SET status='disabled',entries_json='[]' WHERE binding_id=? AND input_id IS ? AND phase_id IS ?")
        .run(input.bindingId, input.inputId, input.phaseId));
      return ok(disabled());
    }
    const previous = reservation.data.created ? null : reservation.data.snapshot;
    if (previous && previous.status !== 'ready') return ok(previous.status === 'pending' ? unavailable() : { status: previous.status, items: previous.items });
    const start = performance.now();
    const abort = new AbortController(), timer = setTimeout(() => abort.abort(), input.timeoutMs);
    let result = unavailable();
    try {
      const secret = await credentialWithin(original.identity.credentialRef, input.timeoutMs);
      const preflight = await authorize(input);
      if (secret && !abort.signal.aborted && original.settings.endpoint && original.remoteSessionId && preflight.ok
        && sameIdentity(preflight.data.identity, original.identity)
        && preflight.data.settings.revision === original.settings.revision) {
        const client = createOpenVikingService({ endpoint: original.settings.endpoint, apiKey: secret,
          owner: { accountId: original.identity.accountId, userId: original.identity.userId, peerId: original.identity.peerId }, fetch: options.fetch, signal: abort.signal });
        const confirmed = await ensureMirrorSession(input.bindingId, original.remoteSessionId, client);
        const current = await authorize(input), remaining = Math.floor(input.timeoutMs - (performance.now() - start));
        if (confirmed && current.ok && sameIdentity(current.data.identity, original.identity)
          && current.data.settings.revision === original.settings.revision && remaining > 0) {
          if (previous) {
            const local = await authorizedSnapshot(input, { status: 'ready', items: previous.items }, original.settings.revision);
            if (local.status === 'ready') {
              const allowed = await options.database.read(scope => allowedEntries(scope, input));
              const verified = await client.verifyRecall(local.items, allowed, remaining);
              if (verified.ok) result = verified.data;
            } else result = local;
          }
          else {
            const allowed = await options.database.read(scope => allowedEntries(scope, input));
            const read = await client.recall({ query: input.query, timeoutMs: remaining, allowedEntries: allowed });
            if (read.ok) result = read.data;
          }
        }
      }
    } catch { /* A failed optional memory read is recorded as unavailable. */ }
    finally { clearTimeout(timer); }
    const current = await authorize(input);
    if (!current.ok) return current;
    if (!current.data.settings.recallEnabled || !sameIdentity(current.data.identity, original.identity)
      || current.data.settings.revision !== original.settings.revision
      ) result = disabled();
    if (previous) return ok(await authorizedSnapshot(input, result, original.settings.revision));
    const saved = await options.database.transaction(scope => scope.memoryIntegration.completeRecall({ ...key, result }));
    if (saved.ok) return ok(await authorizedSnapshot(input, { status: saved.data.status === 'pending' ? 'unavailable' : saved.data.status, items: saved.data.items }, original.settings.revision));
    const reread = await options.database.read(scope => scope.memoryIntegration.getRecall(key));
    if (reread.ok && reread.data?.status === 'disabled') return ok(disabled());
    return saved;
  }
  async function recall(raw: unknown): Promise<Result<MemoryRecallResult>> {
      const parsed = inputSchema.safeParse(raw); if (!parsed.success) return fail(appError('input_invalid', 'input', 'The memory recall request is invalid.'));
      const input = parsed.data, owner = await authorize(input); if (!owner.ok) return owner;
      const key = `${input.bindingId}:${input.inputId ?? `phase-${input.phaseId}`}`;
      const pending = active.get(key); if (pending) return pending;
      const work = run(input, owner.data); active.set(key, work);
      try { return await work; } finally { if (active.get(key) === work) active.delete(key); }
  }
  async function search(raw: unknown): Promise<Result<MemoryRecallResult>> {
    const parsed = inputSchema.safeParse(raw);
    if (!parsed.success) return fail(appError('input_invalid', 'input', 'The memory search request is invalid.'));
    try {
    const input = parsed.data, original = await authorize(input);
    if (!original.ok) return original;
    if (original.data.provider === 'native') return ok(disabled());
    const identity = original.data.identity, endpoint = original.data.settings.endpoint;
    if (!identity?.active || !endpoint) return ok(unavailable());
    const start = performance.now(), secret = await credentialWithin(identity.credentialRef, input.timeoutMs);
    if (!secret) return ok(unavailable());
    const before = await authorize(input);
    if (!before.ok || !sameIdentity(before.data.identity, identity) || before.data.settings.revision !== original.data.settings.revision) return ok(unavailable());
    const entries = await options.database.read(scope => allowedEntries(scope, input));
    const remaining = Math.floor(input.timeoutMs - (performance.now() - start));
    if (remaining <= 0) return ok(unavailable());
    const service = createOpenVikingService({ endpoint, apiKey: secret,
      owner: { accountId: identity.accountId, userId: identity.userId, peerId: identity.peerId }, fetch: options.fetch });
    const result = await service.recall({ query: input.query, timeoutMs: remaining, allowedEntries: entries });
    const after = await authorize(input);
    if (!result.ok || !after.ok || !sameIdentity(after.data.identity, identity) || after.data.settings.revision !== original.data.settings.revision) return ok(unavailable());
    const current = await options.database.read(scope => {
      const valid = scope.db.query(`SELECT b.id FROM memory_bindings b JOIN memory_identities i ON i.id=b.identity_id
        JOIN sessions s ON s.id=b.session_id JOIN memory_config c ON c.id=1 WHERE b.id=? AND b.endpoint=? AND c.endpoint=b.endpoint AND c.revision=?
        AND i.id=? AND i.state='active' AND i.environment=? AND i.owner_id=? AND i.account_id=? AND i.user_id=? AND i.peer_id=?
        AND i.credential_ref=? AND s.hidden_at IS NULL AND COALESCE(json_extract(s.metadata_json,'$.delete_pending'),0)!=1`)
        .get(input.bindingId, endpoint, original.data.settings.revision, identity.id, input.owner.environment, input.owner.ownerId,
          identity.accountId, identity.userId, identity.peerId, identity.credentialRef);
      return valid ? allowedEntries(scope, input) : null;
    });
    if (!current) return ok(unavailable());
    if (result.data.status !== 'ready') return result;
    const items = result.data.items.filter(item => current.some(entry => entry.uri === item.uri && entry.revision === item.revision));
    return ok(items.length ? { status: 'ready', items } : disabled());
    } catch { return ok(unavailable()); }
  }
  function rememberOutput(row: RememberRow, state: RememberResult['state'], entryId = row.entry_id, contentConfirmed = row.content_confirmed === 1): RememberResult {
    return { requestId: row.request_id, state, uri: row.uri, entryId, contentConfirmed };
  }
  async function completeRemember(row: RememberRow, identity: Identity, settingsRevision: number, expectedState: 'sending' | 'unknown'): Promise<Result<RememberResult>> {
    try {
      return await options.database.transaction(scope => {
        const current = scope.memoryIntegration.getSettings();
        const allowed = scope.db.query(`SELECT id FROM memory_identities WHERE id=? AND state='active' AND credential_ref=?
          AND account_id=? AND user_id=? AND peer_id=?`).get(identity.id, identity.credentialRef, identity.accountId, identity.userId, identity.peerId);
        if (!current.ok || !allowed || current.data.revision !== settingsRevision || current.data.captureMode === 'off') {
          scope.db.query("UPDATE memory_remember_requests SET state='unknown',updated_at=? WHERE id=? AND state='sending'").run(options.now(), row.id);
          return ok(rememberOutput(row, 'unknown'));
        }
        const inserted = scope.db.query(`INSERT INTO memory_entries(identity_id,endpoint,uri,revision,state,source_json,created_at,updated_at)
          VALUES(?,?,?,1,'active',?,?,?)`).run(identity.id, current.data.endpoint, row.uri, JSON.stringify({ version: 1, approvedContent: row.content,
          origin: { bindingId: row.binding_id, inputId: row.input_id, phaseId: row.phase_id } }), options.now(), options.now());
        const entryId = Number(inserted.lastInsertRowid);
        scope.db.query('INSERT INTO memory_grants(entry_id,scope_kind,scope_id,revision) VALUES(?,?,?,1)').run(entryId, row.scope_kind, row.scope_id);
        if (scope.db.query("UPDATE memory_remember_requests SET state='completed',content_confirmed=1,entry_id=?,updated_at=? WHERE id=? AND state=?")
          .run(entryId, options.now(), row.id, expectedState).changes !== 1) throw Error('memory_remember_state_conflict');
        return ok(rememberOutput(row, 'completed', entryId, true));
      });
    } catch { return ok(rememberOutput(row, 'unknown')); }
  }
  async function rememberOperation(input: RememberInput, original: Authorized, checkOnly = false): Promise<Result<RememberResult>> {
    const identity = original.identity;
    if (original.provider !== 'openviking' || !identity?.active || !original.settings.endpoint || !original.remoteSessionId || original.settings.captureMode === 'off')
      return fail(appError('memory_disabled', 'runtime', 'The original memory connection is not enabled.'));
    const selected = await options.database.transaction(scope => {
      const binding = scope.db.query<{ runtime_kind: string; session_id: number; work_id: number | null }, [number, number]>(
        'SELECT runtime_kind,session_id,work_id FROM memory_bindings WHERE id=? AND identity_id=?').get(input.bindingId, identity.id);
      if (!binding || input.scope.kind === 'session' && (binding.runtime_kind !== 'agent_session' || binding.session_id !== input.scope.sessionId)
        || input.scope.kind === 'work' && (binding.runtime_kind !== 'durable' || binding.work_id !== input.scope.workId)) return denied();
      const scopeId = input.scope.kind === 'personal' ? input.owner.ownerId
        : input.scope.kind === 'session' ? String(input.scope.sessionId) : String(input.scope.workId);
      const prior = scope.db.query<RememberRow, [number, string]>('SELECT * FROM memory_remember_requests WHERE identity_id=? AND request_id=?')
        .get(identity.id, input.requestId);
      if (prior) {
        if (prior.state === 'forgotten' || prior.entry_id !== null && scope.db.query("SELECT id FROM memory_entries WHERE id=? AND state='forgotten'").get(prior.entry_id))
          return fail(appError('memory_forgotten', 'runtime', 'The original memory has been forgotten.'));
        if (prior.binding_id !== input.bindingId || prior.input_id !== input.inputId || prior.phase_id !== input.phaseId
          || prior.content !== input.content || prior.scope_kind !== input.scope.kind || prior.scope_id !== scopeId)
          return fail(appError('state_conflict', 'input', 'The original remember request has different content or scope.'));
        return ok(prior);
      }
      if (checkOnly) return denied();
      const current = scope.memoryIntegration.getSettings();
      if (!current.ok) return current;
      if (current.data.revision !== original.settings.revision || current.data.captureMode === 'off') return fail(appError('state_conflict', 'input', 'The memory configuration changed.'));
      const uri = `viking://user/${identity.userId}/memories/flowmate-${randomUUID()}.md`;
      scope.db.query(`INSERT INTO memory_remember_requests(identity_id,binding_id,input_id,phase_id,request_id,uri,content,scope_kind,scope_id,state,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,'pending',?,?)`).run(identity.id, input.bindingId, input.inputId, input.phaseId, input.requestId, uri, input.content,
        input.scope.kind, scopeId, options.now(), options.now());
      return ok(scope.db.query<RememberRow, [number, string]>('SELECT * FROM memory_remember_requests WHERE identity_id=? AND request_id=?').get(identity.id, input.requestId)!);
    });
    if (!selected.ok) return selected;
    const row = selected.data, output = (state: RememberResult['state']): RememberResult => rememberOutput(row, state);
    if (row.state === 'forgotten') return fail(appError('memory_forgotten', 'runtime', 'The original memory has been forgotten.'));
    if (checkOnly || row.state !== 'pending') return ok(output(row.state === 'sending' ? 'unknown' : row.state));
    const secret = await credentialWithin(identity.credentialRef, 10000);
    if (!secret) return ok(output('pending'));
    const service = createOpenVikingService({ endpoint: original.settings.endpoint, apiKey: secret,
      owner: { accountId: identity.accountId, userId: identity.userId, peerId: identity.peerId }, fetch: options.fetch });
    const preflight = await authorize({ bindingId: input.bindingId, inputId: input.inputId, phaseId: input.phaseId,
      owner: input.owner, query: 'remember', timeoutMs: 2000 });
    if (!preflight.ok || !sameIdentity(preflight.data.identity, identity) || preflight.data.settings.revision !== original.settings.revision) return ok(output('pending'));
    if (!await ensureMirrorSession(input.bindingId, original.remoteSessionId, service)) {
      await options.database.transaction(scope => scope.db.query("UPDATE memory_remember_requests SET state='unknown',updated_at=? WHERE id=? AND state='pending'").run(options.now(), row.id));
      return ok(output('unknown'));
    }
    const claimed = await options.database.transaction(scope => scope.db.query(`UPDATE memory_remember_requests SET state='sending',updated_at=?
      WHERE id=? AND state='pending' AND EXISTS (SELECT 1 FROM memory_config c WHERE c.id=1 AND c.revision=? AND c.capture_mode!='off' AND c.endpoint=?)
      AND EXISTS (SELECT 1 FROM memory_identities i WHERE i.id=memory_remember_requests.identity_id AND i.state='active' AND i.credential_ref=?
        AND i.account_id=? AND i.user_id=? AND i.peer_id=?)
      AND EXISTS (SELECT 1 FROM memory_bindings b JOIN sessions s ON s.id=b.session_id WHERE b.id=memory_remember_requests.binding_id
        AND s.hidden_at IS NULL AND COALESCE(json_extract(s.metadata_json,'$.delete_pending'),0)!=1)`)
      .run(options.now(), row.id, original.settings.revision, original.settings.endpoint, identity.credentialRef, identity.accountId, identity.userId, identity.peerId).changes === 1);
    if (!claimed) return ok(output('unknown'));
    const written = await service.createMemoryItem(row.uri, row.content);
    if (!written.ok) {
      await options.database.transaction(scope => scope.db.query("UPDATE memory_remember_requests SET state='unknown',updated_at=? WHERE id=? AND state='sending'").run(options.now(), row.id));
      return ok(output('unknown'));
    }
    if (!written.data.indexComplete) {
      await options.database.transaction(scope => scope.db.query("UPDATE memory_remember_requests SET state='unknown',content_confirmed=1,updated_at=? WHERE id=? AND state='sending'").run(options.now(), row.id));
      return ok(rememberOutput(row, 'unknown', null, true));
    }
    return completeRemember(row, identity, original.settings.revision, 'sending');
  }
  async function remember(raw: unknown): Promise<Result<RememberResult>> {
    const parsed = rememberInputSchema.safeParse(raw); if (!parsed.success) return fail(appError('input_invalid', 'input', 'The remember request is invalid.'));
    const input = parsed.data, owner = await authorize({ bindingId: input.bindingId, inputId: input.inputId, phaseId: input.phaseId,
      owner: input.owner, query: 'remember', timeoutMs: 2000 });
    if (!owner.ok) return owner;
    const key = JSON.stringify([input.bindingId, input.requestId]);
    const pending = remembering.get(key);
    if (pending) return isDeepStrictEqual(pending.input, input) ? pending.promise
      : fail(appError('state_conflict', 'input', 'The original remember request has different content or scope.'));
    const work = rememberOperation(input, owner.data); remembering.set(key, { input, promise: work });
    try { return await work; } finally { if (remembering.get(key)?.promise === work) remembering.delete(key); }
  }
  async function reconcileRemember(raw: unknown): Promise<Result<RememberResult>> {
    const parsed = rememberInputSchema.safeParse(raw); if (!parsed.success) return fail(appError('input_invalid', 'input', 'The remember request is invalid.'));
    const input = parsed.data;
    const original = await authorize({ bindingId: input.bindingId, inputId: input.inputId, phaseId: input.phaseId,
      owner: input.owner, query: 'remember', timeoutMs: 2000 });
    if (!original.ok) return original;
    const prior = await rememberOperation(input, original.data, true);
    if (!prior.ok || prior.data.state !== 'unknown') return prior;
    const identity = original.data.identity;
    if (!identity?.active || !original.data.settings.endpoint || !original.data.remoteSessionId || original.data.settings.captureMode === 'off') return prior;
    const row = await options.database.read(scope => scope.db.query<RememberRow, [number, string]>(
      "SELECT * FROM memory_remember_requests WHERE identity_id=? AND request_id=? AND state='unknown'").get(identity.id, input.requestId));
    if (!row) return prior;
    const secret = await credentialWithin(identity.credentialRef, 10000); if (!secret) return prior;
    const service = createOpenVikingService({ endpoint: original.data.settings.endpoint, apiKey: secret,
      owner: { accountId: identity.accountId, userId: identity.userId, peerId: identity.peerId }, fetch: options.fetch });
    if (!await service.verifyMirrorSession(original.data.remoteSessionId)) return prior;
    const content = await service.readMemoryItem(row.uri); if (!content.ok || content.data !== row.content) return prior;
    const checked = await options.database.transaction(scope => {
      const settings = scope.memoryIntegration.getSettings();
      const current = scope.db.query(`SELECT b.id FROM memory_bindings b JOIN memory_identities i ON i.id=b.identity_id
        WHERE b.id=? AND b.remote_session_id=? AND b.endpoint=? AND i.id=? AND i.state='active' AND i.credential_ref=?`)
        .get(input.bindingId, original.data.remoteSessionId, original.data.settings.endpoint, identity.id, identity.credentialRef);
      if (!settings.ok || settings.data.revision !== original.data.settings.revision || !current) return false;
      const saved = scope.db.query("UPDATE memory_remember_requests SET content_confirmed=1,updated_at=? WHERE id=? AND state='unknown'").run(options.now(), row.id);
      if (saved.changes !== 1) return false;
      scope.db.query("UPDATE memory_bindings SET remote_state='ready' WHERE id=? AND remote_state='unknown'").run(input.bindingId);
      return true;
    });
    return checked ? ok(rememberOutput(row, 'unknown', row.entry_id, true)) : prior;
  }
  async function forgetOperation(input: ForgetInput): Promise<Result<ForgetResult>> {
    type Entry = { id: number; identity_id: number; endpoint: string; uri: string; revision: number; state: string; source_json: string;
      environment: string; owner_id: string; account_id: string; user_id: string; peer_id: string; credential_ref: string; identity_state: string };
    type Request = { id: number; entry_id: number; expected_revision: number; request_id: string; state: 'pending' | 'sending' | 'unknown' | 'completed' | 'conflict' };
    const output = (row: Request): ForgetResult => ({ requestId: row.request_id, entryId: row.entry_id, state: row.state === 'sending' ? 'unknown' : row.state });
    try {
      const selected = await options.database.transaction(scope => {
        const entry = scope.db.query<Entry, [number]>(`SELECT e.*,i.environment,i.owner_id,i.account_id,i.user_id,i.peer_id,i.credential_ref,i.state AS identity_state
          FROM memory_entries e JOIN memory_identities i ON i.id=e.identity_id WHERE e.id=?`).get(input.entryId);
        if (!entry || entry.environment !== input.owner.environment || entry.owner_id !== input.owner.ownerId
          || options.owner && (options.owner.environment !== input.owner.environment || options.owner.ownerId !== input.owner.ownerId)) return denied();
        const previous = scope.db.query<Request, [number, string]>('SELECT * FROM memory_forget_requests WHERE identity_id=? AND request_id=?')
          .get(entry.identity_id, input.requestId);
        if (previous) return previous.entry_id === entry.id && ('operationId' in input ? previous.id === input.operationId
          : previous.expected_revision === input.expectedRevision) ? ok({ entry, row: previous })
          : fail(appError('state_conflict', 'input', 'The original forget request has a different identity.'));
        if ('operationId' in input) return denied();
        if (entry.state !== 'active' || entry.revision !== input.expectedRevision)
          return fail(appError('state_conflict', 'input', 'The original memory has changed.'));
        const settings = scope.memoryIntegration.getSettings();
        if (!settings.ok || settings.data.endpoint !== entry.endpoint || entry.identity_state !== 'active')
          return fail(appError('memory_unavailable', 'runtime', 'The original memory connection is unavailable.', true));
        const source = z.object({ version: z.literal(1), approvedContent: z.string().min(1) }).passthrough().safeParse(JSON.parse(entry.source_json));
        if (!source.success) return fail(appError('memory_unavailable', 'runtime', 'The original memory content is unavailable.'));
        scope.db.query("UPDATE memory_entries SET state='forgotten',updated_at=? WHERE id=? AND state='active' AND revision=?")
          .run(options.now(), entry.id, entry.revision);
        scope.db.query('DELETE FROM memory_grants WHERE entry_id=?').run(entry.id);
        scope.db.query(`UPDATE memory_recalls SET status='disabled',entries_json='[]' WHERE binding_id IN
          (SELECT id FROM memory_bindings WHERE identity_id=? AND endpoint=?) AND id IN
          (SELECT r.id FROM memory_recalls r,json_each(r.entries_json) item WHERE json_extract(item.value,'$.uri')=?)`)
          .run(entry.identity_id, entry.endpoint, entry.uri);
        scope.db.query(`INSERT INTO memory_forget_requests(identity_id,entry_id,request_id,expected_revision,state,created_at,updated_at)
          VALUES(?,?,?,?,'pending',?,?)`).run(entry.identity_id, entry.id, input.requestId, input.expectedRevision, options.now(), options.now());
        const row = scope.db.query<Request, [number, string]>('SELECT * FROM memory_forget_requests WHERE identity_id=? AND request_id=?')
          .get(entry.identity_id, input.requestId)!;
        return ok({ entry, row });
      });
      if (!selected.ok) return selected;
      const { entry, row } = selected.data;
      const checking = 'operationId' in input;
      if (checking ? row.state !== 'unknown' && row.state !== 'pending' : row.state !== 'pending') return ok(output(row));
      const current = await options.database.read(scope => scope.memoryIntegration.getSettings());
      if (!current.ok || current.data.endpoint !== entry.endpoint) return ok(output(row));
      const source = z.object({ version: z.literal(1), approvedContent: z.string().min(1) }).passthrough().safeParse(JSON.parse(entry.source_json));
      if (!source.success || entry.identity_state !== 'active') return ok(output(row));
      const secret = await credentialWithin(entry.credential_ref, 10000); if (!secret) return ok(output(row));
      const service = createOpenVikingService({ endpoint: entry.endpoint, apiKey: secret,
        owner: { accountId: entry.account_id, userId: entry.user_id, peerId: entry.peer_id }, fetch: options.fetch });
      if (checking) {
        if (!await service.memoryItemAbsent(entry.uri)) return ok(output(row));
      } else {
        const remote = await service.readMemoryItem(entry.uri); if (!remote.ok) return ok(output(row));
        if (remote.data !== source.data.approvedContent) {
          await options.database.transaction(scope => scope.db.query("UPDATE memory_forget_requests SET state='conflict',updated_at=? WHERE id=? AND state='pending'")
            .run(options.now(), row.id));
          return ok({ ...output(row), state: 'conflict' });
        }
        const claimed = await options.database.transaction(scope => scope.db.query(`UPDATE memory_forget_requests SET state='sending',updated_at=?
          WHERE id=? AND state='pending' AND EXISTS (SELECT 1 FROM memory_config c WHERE c.id=1 AND c.endpoint=?)
          AND EXISTS (SELECT 1 FROM memory_entries e JOIN memory_identities i ON i.id=e.identity_id WHERE e.id=memory_forget_requests.entry_id
            AND e.state='forgotten' AND e.revision=? AND e.endpoint=? AND i.state='active' AND i.credential_ref=?
            AND i.account_id=? AND i.user_id=? AND i.peer_id=?)`).run(options.now(), row.id, entry.endpoint, entry.revision,
          entry.endpoint, entry.credential_ref, entry.account_id, entry.user_id, entry.peer_id).changes === 1);
        if (!claimed) return ok(output(row));
        const removed = await service.removeMemoryItem(entry.uri);
        if (!removed.ok) {
          await options.database.transaction(scope => scope.db.query("UPDATE memory_forget_requests SET state='unknown',updated_at=? WHERE id=? AND state='sending'")
            .run(options.now(), row.id));
          return ok({ ...output(row), state: 'unknown' });
        }
      }
      try {
        await options.database.transaction(scope => {
          if (checking) {
            const stillOriginal = scope.db.query(`SELECT e.id FROM memory_entries e JOIN memory_identities i ON i.id=e.identity_id
              JOIN memory_config c ON c.id=1 AND c.endpoint=e.endpoint
              WHERE e.id=? AND e.identity_id=? AND e.endpoint=? AND e.uri=? AND i.state='active' AND i.credential_ref=?`)
              .get(entry.id, entry.identity_id, entry.endpoint, entry.uri, entry.credential_ref);
            if (!stillOriginal) throw Error('memory_forget_identity_changed');
          }
          if (scope.db.query("UPDATE memory_entries SET revision=revision+1,source_json=?,updated_at=? WHERE id=? AND state='forgotten' AND revision=?")
            .run(JSON.stringify({ version: 1, forgotten: true }), options.now(), entry.id, entry.revision).changes !== 1) throw Error('memory_forget_conflict');
          scope.db.query("UPDATE memory_remember_requests SET state='forgotten',content='',updated_at=? WHERE entry_id=? AND state='completed'")
            .run(options.now(), entry.id);
          if (scope.db.query("UPDATE memory_forget_requests SET state='completed',updated_at=? WHERE id=? AND state=?")
            .run(options.now(), row.id, checking ? row.state : 'sending').changes !== 1) throw Error('memory_forget_conflict');
        });
        return ok({ ...output(row), state: 'completed' });
      } catch { return ok({ ...output(row), state: 'unknown' }); }
    } catch { return fail(appError('storage_write_failed', 'storage', 'The original forget request could not be saved.', true)); }
  }
  async function forget(raw: unknown): Promise<Result<ForgetResult>> {
    const parsed = forgetInputSchema.safeParse(raw); if (!parsed.success) return fail(appError('input_invalid', 'input', 'The forget request is invalid.'));
    const input = parsed.data, key = JSON.stringify([input.owner.environment, input.owner.ownerId, input.requestId]);
    const pending = forgetting.get(key);
    if (pending) return isDeepStrictEqual(pending.input, input) ? pending.promise
      : fail(appError('state_conflict', 'input', 'The original forget request has a different identity.'));
    const work = forgetOperation(input); forgetting.set(key, { input, promise: work });
    try { return await work; } finally { if (forgetting.get(key)?.promise === work) forgetting.delete(key); }
  }
  return {
    recall,
    search,
    remember,
    reconcileRemember,
    forget,
    sync,
    bindSessionInStore,
    bindWorkInStore,
    async recallSession(input: { sessionId: number; inputId: number; owner: Input['owner']; timeoutMs: number }): Promise<Result<MemoryRecallResult>> {
      const selected = await options.database.transaction(scope => {
        const saved = scope.sessionInputs.get(input.inputId);
        if (!saved.ok) return saved;
        if (!saved.data || saved.data.sessionId !== input.sessionId) return denied();
        const session = scope.db.query<{ durable_runtime_id: string; cloud_workspace_id: string | null }, [number]>(
          "SELECT durable_runtime_id,cloud_workspace_id FROM sessions WHERE id=? AND runtime_kind='agent_session'").get(input.sessionId);
        if (!session || input.owner.environment !== 'local' || session.durable_runtime_id !== 'local' || session.cloud_workspace_id !== null) return denied();
        const binding = scope.memoryIntegration.getSessionInputBinding({ sessionId: input.sessionId, inputId: input.inputId }); if (!binding.ok) return binding;
        const text = saved.data.content.text.trim();
        return binding.data && !hasCredentialMarker(text) ? ok({ binding: binding.data, query: text.slice(0, 500) }) : ok(null);
      });
      if (!selected.ok) return selected;
      if (!selected.data || !selected.data.query) return ok(unavailable());
      return recall({ bindingId: selected.data.binding.id, inputId: input.inputId, phaseId: null,
        owner: input.owner, query: selected.data.query, timeoutMs: input.timeoutMs });
    },
    async recallWork(raw: z.infer<typeof workInputSchema>): Promise<Result<MemoryRecallResult>> {
      const parsed = workInputSchema.safeParse(raw);
      if (!parsed.success) return fail(appError('input_invalid', 'input', 'The memory phase request is invalid.'));
      const input = parsed.data;
      const selected = await options.database.transaction(scope => {
        const session = scope.db.query<{ durable_runtime_id: string; cloud_workspace_id: string | null }, [number, number, number, number, number, string]>(
          `SELECT s.durable_runtime_id,s.cloud_workspace_id FROM invoice_work_phases p
           JOIN invoice_works w ON w.id=p.work_id JOIN sessions s ON s.id=w.session_id
           WHERE w.id=? AND s.id=? AND p.item_id=? AND p.attempt_id=? AND p.id=? AND p.request_id=? AND s.runtime_kind='durable'`)
          .get(input.workId, input.sessionId, input.itemId, input.attemptId, input.phaseId, input.requestId);
        if (!session || (input.owner.environment === 'local'
          ? session.durable_runtime_id !== 'local' || session.cloud_workspace_id !== null
          : session.durable_runtime_id === 'local' || session.cloud_workspace_id !== input.owner.ownerId)) return denied();
        let binding = scope.memoryIntegration.getWorkBinding({ workId: input.workId, itemId: input.itemId, branch: 0 });
        if (!binding.ok) return binding;
        if (!binding.data) {
          const settings = scope.memoryIntegration.getSettings(); if (!settings.ok) return settings;
          const identities = settings.data.provider === 'openviking' ? scope.db.query<{ id: number }, [string, string]>(
            "SELECT id FROM memory_identities WHERE environment=? AND owner_id=? AND state='active'").all(input.owner.environment, input.owner.ownerId) : [];
          if (settings.data.provider === 'openviking' && identities.length !== 1) return ok(null);
          binding = scope.memoryIntegration.bindWork({ sessionId: input.sessionId, workId: input.workId, itemId: input.itemId,
            branch: 0, provider: settings.data.provider, identityId: identities[0]?.id ?? null,
            remoteSessionId: identities.length ? randomUUID() : null, at: options.now() });
          if (!binding.ok) return binding;
        }
        return ok(binding.data);
      });
      if (!selected.ok) return selected;
      if (!selected.data) return ok(unavailable());
      return recall({ bindingId: selected.data.id, inputId: null, phaseId: input.phaseId,
        owner: input.owner, query: input.query, timeoutMs: input.timeoutMs });
    },
  };
}
