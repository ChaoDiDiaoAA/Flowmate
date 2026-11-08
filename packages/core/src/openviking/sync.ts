import { z } from 'zod';
import { appError, fail, ok, SessionInputContentV2Schema, type Result } from '@flowmate/contracts';
import type { DbHandle, SqlDatabaseStore } from '../storage/database.ts';
import { createOpenVikingService } from './service.ts';
import { hasCredentialMarker } from './privacy.ts';

const id = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const sourceSchema = z.object({ version: z.literal(1), sessionId: id, runId: id, inputIds: z.array(id).min(1),
  resultEntryId: z.string().min(1).max(256) }).strict();
type Source = z.infer<typeof sourceSchema>;
type Owner = { environment: 'local' | 'cloud'; ownerId: string };
type Row = { id: number; binding_id: number; input_id: number; state: string; cursor: number; source_json: string; remote_task_id: string | null;
  remote_session_id: string; credential_ref: string; account_id: string; user_id: string; peer_id: string; environment: string; owner_id: string;
  endpoint: string; identity_state: string; durable_runtime_id: string; cloud_workspace_id: string | null };

export function createMemorySync(options: { database: Pick<DbHandle, 'read' | 'transaction'>; owner?: Owner;
  readCredential(reference: string): Promise<string | undefined>; now(): string; fetch?: typeof fetch },
  ensureMirrorSession: (bindingId: number, remoteSessionId: string, service: ReturnType<typeof createOpenVikingService>) => Promise<boolean>) {
  let running: Promise<void> | undefined, timer: ReturnType<typeof setTimeout> | undefined, closed = false, requested = false;
  const abort = new AbortController();
  function enqueue(scope: SqlDatabaseStore, source: Source): void {
    const parsed = sourceSchema.parse(source), settings = scope.memoryIntegration.getSettings();
    if (!settings.ok || settings.data.captureMode !== 'auto' || !options.owner) return;
    const binding = scope.db.query<{ id: number }, [number, number, string, string]>(`SELECT b.id FROM memory_bindings b
      JOIN memory_input_bindings m ON m.binding_id=b.id JOIN memory_identities i ON i.id=b.identity_id JOIN sessions s ON s.id=b.session_id
      WHERE m.input_id=? AND b.session_id=? AND b.runtime_kind='agent_session' AND b.provider='openviking'
        AND i.environment=? AND i.owner_id=? AND i.state='active' AND s.durable_runtime_id='local' AND s.cloud_workspace_id IS NULL`)
      .get(parsed.inputIds[0]!, parsed.sessionId, options.owner.environment, options.owner.ownerId);
    if (!binding || options.owner.environment !== 'local') return;
    const encoded = JSON.stringify(parsed);
    const prior = scope.db.query<{ source_json: string }, [number, number]>(
      'SELECT source_json FROM memory_sync WHERE binding_id=? AND input_id=?').get(binding.id, parsed.inputIds[0]!);
    if (prior) { if (prior.source_json !== encoded) throw Error('memory_sync_identity_conflict'); return; }
    if (sourceMessages(scope, parsed, binding.id)?.some(message => hasCredentialMarker(message.content))) return;
    scope.db.query(`INSERT INTO memory_sync(binding_id,input_id,phase_id,state,source_json,cursor,created_at,updated_at)
      VALUES(?,?,NULL,'pending',?,0,?,?)`).run(binding.id, parsed.inputIds[0]!, encoded, options.now(), options.now());
    scope.db.afterCommit!(() => wake());
  }
  function sourceMessages(scope: SqlDatabaseStore, source: Source, bindingId: number): Array<{ role: 'user' | 'assistant'; content: string; sourceMessageIds: string[] }> | null {
    const messages: Array<{ role: 'user' | 'assistant'; content: string; sourceMessageIds: string[] }> = [];
    for (const inputId of source.inputIds) {
      const row = scope.db.query<{ content_json: string }, [number, number, number, string, number]>(`SELECT i.content_json FROM session_inputs i
        JOIN memory_input_bindings m ON m.input_id=i.id WHERE i.id=? AND i.session_id=? AND i.run_id=? AND i.result_entry_id=?
        AND i.processing_status='completed' AND m.binding_id=?`).get(inputId, source.sessionId, source.runId, source.resultEntryId, bindingId);
      if (!row) return null;
      const input = SessionInputContentV2Schema.safeParse(JSON.parse(row.content_json));
      if (!input.success || !input.data.text.trim() || new TextEncoder().encode(input.data.text).byteLength > 65000) return null;
      messages.push({ role: 'user', content: input.data.text, sourceMessageIds: [`input-${inputId}`] });
    }
    const row = scope.db.query<{ entry_json: string }, [number, string, number]>(
      'SELECT entry_json FROM session_native_entries WHERE session_id=? AND entry_id=? AND run_id=?')
      .get(source.sessionId, source.resultEntryId, source.runId);
    if (!row) return null;
    const entry = z.object({ type: z.literal('message'), message: z.object({ role: z.literal('assistant'), stopReason: z.literal('stop'),
      content: z.array(z.object({ type: z.string(), text: z.string().optional() }).passthrough()) }).passthrough() }).passthrough()
      .safeParse(JSON.parse(row.entry_json));
    if (!entry.success || entry.data.message.content.some(part => part.type === 'toolCall')) return null;
    const content = entry.data.message.content.filter(part => part.type === 'text').map(part => part.text ?? '').join('');
    if (!content.trim() || new TextEncoder().encode(content).byteLength > 65000) return null;
    messages.push({ role: 'assistant', content, sourceMessageIds: [`entry-${source.resultEntryId}`] });
    return messages;
  }
  async function finishExtracted(row: Row, service: ReturnType<typeof createOpenVikingService>, task: Record<string, unknown>): Promise<boolean> {
    const result = z.object({ session_id: z.literal(row.remote_session_id), memory_diff_uri: z.string().nullable().optional(),
      memories_extracted: z.record(z.number().int().nonnegative()) }).passthrough().safeParse(task.result);
    if (!result.success) return false;
    let additions: Array<{ uri: string; after: string }> = [], changed: string[] = [];
    if (result.data.memory_diff_uri) {
      const diff = await service.readMirrorDiff(row.remote_session_id, result.data.memory_diff_uri); if (!diff.ok) return false;
      additions = diff.data.adds; changed = diff.data.changed;
      for (const item of additions) {
        const content = await service.readMemoryItem(item.uri);
        if (!content.ok || content.data !== item.after) return false;
      }
    } else if (Object.values(result.data.memories_extracted).some(value => value > 0)) return false;
    try {
      return await options.database.transaction(scope => {
        const original = scope.db.query<{ identity_id: number }, [number, string, number, string, string, string, string, string, string, string]>(`SELECT b.identity_id FROM memory_sync t
          JOIN memory_bindings b ON b.id=t.binding_id JOIN memory_identities i ON i.id=b.identity_id JOIN sessions s ON s.id=b.session_id
          WHERE t.id=? AND t.remote_task_id=? AND t.cursor=? AND t.state IN ('accepted','running','unknown')
            AND b.endpoint=? AND i.environment=? AND i.owner_id=? AND i.account_id=? AND i.user_id=? AND i.peer_id=?
            AND i.credential_ref=? AND i.state='active' AND s.hidden_at IS NULL
            AND COALESCE(json_extract(s.metadata_json,'$.delete_pending'),0)!=1`).get(row.id, row.remote_task_id!, row.cursor, row.endpoint, row.environment,
              row.owner_id, row.account_id, row.user_id, row.peer_id, row.credential_ref);
        if (!original) return false;
        const settings = scope.memoryIntegration.getSettings();
        if (!settings.ok || settings.data.endpoint !== row.endpoint) return false;
        for (const uri of changed) {
          scope.db.query('DELETE FROM memory_grants WHERE entry_id IN (SELECT id FROM memory_entries WHERE identity_id=? AND endpoint=? AND uri=?)')
            .run(original.identity_id, row.endpoint, uri);
          scope.db.query(`UPDATE memory_recalls SET status='disabled',entries_json='[]' WHERE binding_id IN
            (SELECT id FROM memory_bindings WHERE identity_id=? AND endpoint=?) AND id IN
            (SELECT r.id FROM memory_recalls r,json_each(r.entries_json) item WHERE json_extract(item.value,'$.uri')=?)`)
            .run(original.identity_id, row.endpoint, uri);
        }
        if (settings.data.captureMode === 'auto') for (const item of additions) {
          if (scope.db.query('SELECT id FROM memory_entries WHERE identity_id=? AND endpoint=? AND uri=?').get(original.identity_id, row.endpoint, item.uri)) continue;
          const entry = scope.db.query(`INSERT INTO memory_entries(identity_id,endpoint,uri,revision,state,source_json,created_at,updated_at)
            VALUES(?,?,?,1,'active',?,?,?)`).run(original.identity_id, row.endpoint, item.uri, JSON.stringify({ version: 1, approvedContent: item.after,
              origin: { bindingId: row.binding_id, inputId: row.input_id, phaseId: null }, extraction: { syncId: row.id, taskId: row.remote_task_id } }), options.now(), options.now());
          scope.db.query("INSERT INTO memory_grants(entry_id,scope_kind,scope_id,revision) VALUES(?,'personal',?,1)")
            .run(Number(entry.lastInsertRowid), row.owner_id);
        }
        if (scope.db.query("UPDATE memory_sync SET state='completed',updated_at=? WHERE id=? AND remote_task_id=? AND state IN ('accepted','running','unknown')")
          .run(options.now(), row.id, row.remote_task_id!).changes !== 1) throw Error('memory_sync_state_conflict');
        return true;
      });
    } catch { return false; }
  }
  function matchesTask(row: Row, task: Record<string, unknown>): boolean {
    return task.task_id === row.remote_task_id && task.task_type === 'session_commit' && task.resource_id === row.remote_session_id;
  }
  async function step(deferred: readonly number[]): Promise<'more' | 'done' | number> {
    const selected = await options.database.read(scope => {
      const row = scope.db.query<Row, [string]>(`SELECT t.*,b.remote_session_id,b.endpoint,i.credential_ref,i.account_id,i.user_id,i.peer_id,i.environment,i.owner_id,
        i.state AS identity_state,s.durable_runtime_id,s.cloud_workspace_id FROM memory_sync t JOIN memory_bindings b ON b.id=t.binding_id
        JOIN memory_identities i ON i.id=b.identity_id JOIN sessions s ON s.id=b.session_id
        WHERE t.state IN ('pending','accepted','running') AND s.hidden_at IS NULL
          AND COALESCE(json_extract(s.metadata_json,'$.delete_pending'),0)!=1
          AND t.id NOT IN (SELECT value FROM json_each(?)) AND NOT EXISTS
          (SELECT 1 FROM memory_sync p WHERE p.binding_id=t.binding_id AND p.id<t.id AND p.state!='completed'
            AND NOT (p.state='cancelled' AND p.cursor<=1 AND p.remote_task_id IS NULL)) ORDER BY t.id LIMIT 1`)
        .get(JSON.stringify(deferred));
      if (!row) return null;
      if (!options.owner || row.environment !== options.owner.environment || row.owner_id !== options.owner.ownerId
        || row.identity_state !== 'active' || row.durable_runtime_id !== 'local' || row.cloud_workspace_id !== null) return { row, blocked: true as const };
      const settings = scope.memoryIntegration.getSettings();
      if (!settings.ok || !settings.data.endpoint || settings.data.endpoint !== row.endpoint
        || row.state === 'pending' && settings.data.captureMode !== 'auto') return { row, blocked: true as const };
      const source = sourceSchema.parse(JSON.parse(row.source_json));
      const messages = sourceMessages(scope, source, row.binding_id); if (!messages) return { row, settings: settings.data, messages: null };
      const prior = scope.db.query('SELECT id FROM memory_sync WHERE binding_id=? AND id<? AND state=\'completed\' LIMIT 1').get(row.binding_id, row.id) !== null;
      return { row, settings: settings.data, messages, prior };
    });
    if (!selected) return 'done';
    if ('blocked' in selected) return selected.row.id;
    const { row, settings, messages } = selected;
    if (!messages) {
      await options.database.transaction(scope => scope.db.query("UPDATE memory_sync SET state='failed',updated_at=? WHERE id=? AND state=?").run(options.now(), row.id, row.state));
      return 'more';
    }
    if (row.state === 'pending' && messages.some(message => hasCredentialMarker(message.content))) {
      // Keep the ID for operation history. Only batches that never appended a message can unblock later writes.
      await options.database.transaction(scope => scope.db.query(`UPDATE memory_sync
        SET state=CASE WHEN cursor<=1 AND remote_task_id IS NULL THEN 'cancelled' ELSE 'unknown' END,updated_at=?
        WHERE id=? AND state='pending' AND cursor=?`).run(options.now(), row.id, row.cursor));
      return 'more';
    }
    if (row.state === 'pending' && row.cursor === 0 && selected.prior) {
      await options.database.transaction(scope => scope.db.query("UPDATE memory_sync SET cursor=1,updated_at=? WHERE id=? AND state='pending' AND cursor=0").run(options.now(), row.id));
      return 'more';
    }
    let key: string | undefined, cancelTimeout = () => {};
    const timeout = new Promise<undefined>(resolve => { const handle = setTimeout(resolve, 2000); cancelTimeout = () => clearTimeout(handle); });
    try { key = await Promise.race([options.readCredential(row.credential_ref), timeout]); }
    catch { return row.id; }
    finally { cancelTimeout(); }
    if (!key || closed) return row.id;
    const service = createOpenVikingService({ endpoint: settings.endpoint!, apiKey: key,
      owner: { accountId: row.account_id, userId: row.user_id, peerId: row.peer_id }, fetch: options.fetch, signal: abort.signal });
    if (row.state !== 'pending') {
      const task = row.remote_task_id ? await service.readMirrorTask(row.remote_task_id) : null;
      if (!task?.ok || !task.data) return row.id;
      if (!matchesTask(row, task.data)) return row.id;
      const status = task.data.status;
      if (status !== 'completed' && status !== 'failed' && status !== 'cancelled' && status !== 'canceled') return row.id;
      if (status === 'completed' && (!task.data.result || typeof task.data.result !== 'object'
        || Array.isArray(task.data.result) || (task.data.result as Record<string, unknown>).session_id !== row.remote_session_id)) return row.id;
      if (status === 'completed') {
        if (!await finishExtracted(row, service, task.data))
          await options.database.transaction(scope => scope.db.query("UPDATE memory_sync SET state='unknown',updated_at=? WHERE id=? AND state IN ('accepted','running')")
            .run(options.now(), row.id));
        return 'more';
      }
      await options.database.transaction(scope => scope.db.query("UPDATE memory_sync SET state=?,updated_at=? WHERE id=? AND state IN ('accepted','running')")
        .run(status === 'canceled' ? 'cancelled' : status, options.now(), row.id));
      return 'more';
    }
    const claimed = await options.database.transaction(scope => scope.db.query(`UPDATE memory_sync SET state='sending',updated_at=?
      WHERE id=? AND state='pending' AND cursor=? AND EXISTS (SELECT 1 FROM memory_config c WHERE c.id=1 AND c.capture_mode='auto' AND c.endpoint=?)
        AND EXISTS (SELECT 1 FROM memory_bindings b JOIN memory_identities i ON i.id=b.identity_id JOIN sessions s ON s.id=b.session_id
          WHERE b.id=memory_sync.binding_id AND b.endpoint=? AND i.state='active' AND i.account_id=? AND i.user_id=? AND i.peer_id=? AND i.credential_ref=?
            AND s.hidden_at IS NULL AND COALESCE(json_extract(s.metadata_json,'$.delete_pending'),0)!=1)`)
      .run(options.now(), row.id, row.cursor, row.endpoint, row.endpoint, row.account_id, row.user_id, row.peer_id, row.credential_ref).changes === 1);
    if (!claimed) return 'more';
    const result = row.cursor === 0 ? await ensureMirrorSession(row.binding_id, row.remote_session_id, service)
      ? { ok: true as const, data: {} } : { ok: false as const, error: { code: 'operation_result_unknown' } }
      : row.cursor <= messages.length ? await service.appendMirrorMessage(row.remote_session_id, { ...messages[row.cursor - 1]!, turnId: `turn-${row.id}` })
        : await service.commitMirrorSession(row.remote_session_id);
    const state = !result.ok ? result.error.code === 'operation_result_unknown' ? 'unknown' : 'failed'
      : row.cursor > messages.length ? 'accepted' : 'pending';
    const taskId = result.ok && row.cursor > messages.length && typeof result.data.task_id === 'string' ? result.data.task_id : null;
    await options.database.transaction(scope => scope.db.query("UPDATE memory_sync SET state=?,cursor=?,remote_task_id=?,updated_at=? WHERE id=? AND state='sending' AND cursor=?")
      .run(state, result.ok && state === 'pending' ? row.cursor + 1 : row.cursor, taskId, options.now(), row.id, row.cursor));
    return 'more';
  }
  function wake(): void {
    if (closed) return;
    if (running) { requested = true; return; }
    if (timer) { clearTimeout(timer); timer = undefined; }
    running = (async () => {
      const deferred: number[] = [];
      while (!closed) {
        const state = await step(deferred);
        if (state === 'done') {
          if (deferred.length) timer = setTimeout(() => { timer = undefined; wake(); }, 2000);
          return;
        }
        if (typeof state === 'number') deferred.push(state);
      }
    })().catch(() => {}).finally(() => { running = undefined; if (requested) { requested = false; wake(); } });
  }
  async function reconcile(syncId: number, abandonConfirmed?: true): Promise<Result<{ state: 'pending' | 'unknown' | 'completed' | 'abandoned' }>> {
    if (!id.safeParse(syncId).success) return fail(appError('input_invalid', 'input', 'The original memory synchronization is invalid.'));
    try {
      if (abandonConfirmed === true) {
        const owner = options.owner;
        if (owner?.environment !== 'local') return fail(appError('memory_scope_denied', 'runtime', 'The original memory synchronization is unavailable.'));
        return await options.database.transaction(scope => {
          const row = scope.db.query<{ state: 'unknown' | 'abandoned' }, [number, string]>(`SELECT t.state FROM memory_sync t
            JOIN memory_bindings b ON b.id=t.binding_id JOIN memory_identities i ON i.id=b.identity_id JOIN sessions s ON s.id=b.session_id
            WHERE t.id=? AND t.state IN ('unknown','abandoned') AND i.environment='local' AND i.owner_id=?
              AND s.durable_runtime_id='local' AND s.cloud_workspace_id IS NULL`).get(syncId, owner.ownerId);
          if (!row) return fail(appError('memory_scope_denied', 'runtime', 'The original memory synchronization is unavailable.'));
          if (row.state === 'unknown') scope.db.query("UPDATE memory_sync SET state='abandoned',updated_at=? WHERE id=? AND state='unknown'")
            .run(options.now(), syncId);
          // An abandoned batch still blocks later writes to the same remote session.
          return ok({ state: 'abandoned' as const });
        });
      }
      const selected = await options.database.read(scope => {
        const row = scope.db.query<Row, [number]>(`SELECT t.*,b.remote_session_id,b.endpoint,i.credential_ref,i.account_id,i.user_id,i.peer_id,i.environment,i.owner_id,
          i.state AS identity_state,s.durable_runtime_id,s.cloud_workspace_id FROM memory_sync t JOIN memory_bindings b ON b.id=t.binding_id
          JOIN memory_identities i ON i.id=b.identity_id JOIN sessions s ON s.id=b.session_id WHERE t.id=? AND t.state='unknown'`).get(syncId);
        if (!row || !options.owner || row.environment !== options.owner.environment || row.owner_id !== options.owner.ownerId
          || row.identity_state !== 'active' || row.durable_runtime_id !== 'local' || row.cloud_workspace_id !== null) return null;
        const settings = scope.memoryIntegration.getSettings(); if (!settings.ok || settings.data.endpoint !== row.endpoint) return null;
        const source = sourceSchema.parse(JSON.parse(row.source_json)), messages = sourceMessages(scope, source, row.binding_id);
        return messages ? { row, messages } : null;
      });
      if (!selected) return fail(appError('memory_scope_denied', 'runtime', 'The original memory synchronization is unavailable.'));
      const { row, messages } = selected;
      if (row.cursor > messages.length && !row.remote_task_id) return ok({ state: 'unknown' });
      if (row.cursor <= messages.length && messages.some(message => hasCredentialMarker(message.content))) return ok({ state: 'unknown' });
      const key = await options.readCredential(row.credential_ref); if (!key) return ok({ state: 'unknown' });
      const service = createOpenVikingService({ endpoint: row.endpoint, apiKey: key,
        owner: { accountId: row.account_id, userId: row.user_id, peerId: row.peer_id }, fetch: options.fetch, signal: abort.signal });
      if (row.cursor > messages.length) {
        const task = await service.readMirrorTask(row.remote_task_id!);
        return task.ok && task.data && matchesTask(row, task.data) && task.data.status === 'completed' && await finishExtracted(row, service, task.data)
          ? ok({ state: 'completed' }) : ok({ state: 'unknown' });
      }
      let confirmed = false;
      if (row.cursor === 0) confirmed = await service.verifyMirrorSession(row.remote_session_id);
      else {
        const remote = await service.readMirrorMessages(row.remote_session_id), expected = messages[row.cursor - 1]!;
        if (remote.ok) {
          const records = remote.data.split('\n').filter(line => line.trim()).map(line => JSON.parse(line));
          const matches = records.filter(item => item && Array.isArray(item.source_message_ids)
            && item.source_message_ids.some((value: unknown) => expected.sourceMessageIds.includes(String(value))));
          const match = matches[0];
          confirmed = matches.length === 1 && match.role === expected.role && match.turn_id === `turn-${row.id}`
            && match.source_message_ids.length === expected.sourceMessageIds.length
            && match.source_message_ids.every((value: unknown, index: number) => value === expected.sourceMessageIds[index])
            && Array.isArray(match.parts) && match.parts.length === 1 && match.parts[0]?.type === 'text' && match.parts[0]?.text === expected.content;
        }
      }
      if (!confirmed || closed) return ok({ state: 'unknown' });
      const saved = await options.database.transaction(scope => {
        const valid = scope.db.query(`SELECT t.id FROM memory_sync t JOIN memory_bindings b ON b.id=t.binding_id
          JOIN memory_identities i ON i.id=b.identity_id JOIN memory_config c ON c.id=1 WHERE t.id=? AND t.state='unknown' AND t.cursor=?
          AND b.endpoint=? AND c.endpoint=? AND i.state='active' AND i.environment=? AND i.owner_id=? AND i.account_id=?
          AND i.user_id=? AND i.peer_id=? AND i.credential_ref=?`).get(row.id, row.cursor, row.endpoint, row.endpoint,
          row.environment, row.owner_id, row.account_id, row.user_id, row.peer_id, row.credential_ref);
        if (!valid) return false;
        if (row.cursor === 0) scope.db.query("UPDATE memory_bindings SET remote_state='ready' WHERE id=? AND remote_state IN ('unknown','ready')").run(row.binding_id);
        return scope.db.query("UPDATE memory_sync SET state='pending',cursor=cursor+1,updated_at=? WHERE id=? AND state='unknown' AND cursor=?")
          .run(options.now(), row.id, row.cursor).changes === 1;
      });
      if (!saved) return ok({ state: 'unknown' });
      wake(); return ok({ state: 'pending' });
    } catch { return ok({ state: 'unknown' }); }
  }
  return { enqueue, wake, reconcile, async close() { closed = true; abort.abort(); if (timer) clearTimeout(timer); await running; } };
}
