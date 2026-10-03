import { Database } from 'bun:sqlite';
import { appError, RuntimeEventSchema, RuntimeEventsQuerySchema, RuntimeEventsReadResultSchema } from '@flowmate/contracts';
import type { DbId, RuntimeEvent, RuntimeEventsQuery, RuntimeEventsReadResult,
  RuntimeEventReadContext, RunEventPayload, ToolEventPayload, InputEventPayload } from '@flowmate/contracts';

type EventWriteBase = Readonly<{ runId: DbId; sessionId: DbId | null; toolCallId: DbId | null;
  occurredAt: string; sourceConnection?: string; sourceSequence?: number }>;
export type EventWrite = EventWriteBase & (
  | { type: 'run_created' | 'run_started' | 'run_completed' | 'run_failed' | 'run_cancelled'; payload: RunEventPayload; dedupeKey: string }
  | { type: 'tool_requested' | 'tool_started' | 'tool_succeeded' | 'tool_failed' | 'tool_cancelled'; payload: ToolEventPayload; dedupeKey: string }
  | { type: 'input_state_changed'; payload: InputEventPayload; dedupeKey: string }
  | { type: 'run_cancel_requested'; payload: { version: 1; requestedAt: string }; dedupeKey: string }
  | { type: 'run_usage_updated'; payload: Extract<RuntimeEvent, { type: 'run_usage_updated' }>['payload']; dedupeKey?: never }
);
export type CommittedEventRef = Readonly<{ runId: DbId; sequence: number }>;
type Row = { id: number; run_id: number; sequence: number; session_id: number | null; tool_call_id: number | null;
  source_connection: string | null; source_sequence: number | null; type: RuntimeEvent['type'];
  payload_json: string; occurred_at: string; received_at: string };
type FactRow = Record<string, unknown>;

class EventFault extends Error {
  constructor(readonly code: 'storage_corrupt' | 'state_conflict') { super(code); }
}
function object(json: unknown): FactRow {
  try {
    const value: unknown = typeof json === 'string' ? JSON.parse(json) : null;
    if (value && typeof value === 'object' && !Array.isArray(value)) return value as FactRow;
  } catch { /* normalize corrupt storage without exposing its contents */ }
  throw new EventFault('storage_corrupt');
}
function ordered(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(ordered);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
    .sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, ordered(child)]));
  return value;
}
function same(a: unknown, b: unknown): boolean { return JSON.stringify(ordered(a)) === JSON.stringify(ordered(b)); }
function stopped(json: unknown): boolean | null {
  const value = object(json).stopped;
  return typeof value === 'boolean' ? value : null;
}
function errorCode(json: unknown): string | null {
  if (json === null) return null;
  const value = object(json).code;
  return typeof value === 'string' && value.length ? value : null;
}
function decode(row: Row): RuntimeEvent {
  const parsed = RuntimeEventSchema.safeParse({ eventId: row.id, runId: row.run_id, sequence: row.sequence,
    sessionId: row.session_id, toolCallId: row.tool_call_id, sourceConnection: row.source_connection,
    sourceSequence: row.source_sequence, type: row.type, payload: object(row.payload_json),
    occurredAt: row.occurred_at, receivedAt: row.received_at });
  if (!parsed.success) throw new EventFault('storage_corrupt');
  return parsed.data;
}
function fact(event: Pick<RuntimeEvent, 'runId' | 'sessionId' | 'toolCallId' | 'type' | 'payload'>): unknown {
  const { origin: _origin, ...payload } = event.payload as RuntimeEvent['payload'] & { origin?: string };
  return { runId: event.runId, sessionId: event.sessionId, toolCallId: event.toolCallId, type: event.type, payload };
}
function migrationKey(write: EventWrite): string | null {
  switch (write.type) {
    case 'run_created': return 'run:created';
    case 'run_started': return 'run:started';
    case 'run_completed': case 'run_failed': case 'run_cancelled': return 'run:terminal';
    case 'run_cancel_requested': return 'run:cancel-requested';
    case 'tool_requested': return `tool:${write.toolCallId}:requested`;
    case 'tool_started': return `tool:${write.toolCallId}:started`;
    case 'tool_succeeded': case 'tool_failed': case 'tool_cancelled': return `tool:${write.toolCallId}:terminal`;
    case 'input_state_changed': return `input:${write.payload.inputId}:${write.payload.status}:${write.payload.processingStatus}:${write.payload.nativeEntryId ?? 'none'}:${write.payload.resultEntryId ?? 'none'}`;
    case 'run_usage_updated': return null;
  }
}
/** Fixed code only: the Host already bounds stderr; never report the thrown observer's data. */
export function reportEventObserverFailure(): void {
  try { console.warn('runtime_event_observer_failed'); } catch { /* diagnostics cannot undo COMMIT */ }
}

export function createRuntimeEventStore(db: Database) {
  let depth = 0;
  const pending: CommittedEventRef[] = [];
  const listeners = new Set<(refs: readonly CommittedEventRef[]) => void>();

  function withTransaction<T>(write: () => T): T {
    // An unrelated outer transaction cannot publish before its own COMMIT.
    if (depth === 0 && db.inTransaction) throw new EventFault('state_conflict');
    const mark = pending.length;
    depth += 1;
    let value: T;
    try { value = db.transaction(write).immediate(); }
    catch (error) { pending.length = mark; throw error; }
    finally { depth -= 1; }
    if (depth === 0) {
      const committed = Object.freeze(pending.splice(0).map(ref => Object.freeze(ref)));
      if (committed.length) for (const listener of [...listeners]) {
        try { listener(committed); } catch { reportEventObserverFailure(); }
      }
    }
    return value;
  }

  function validateFact(write: EventWrite): void {
    const run = db.query('SELECT * FROM runs WHERE id=?').get(write.runId) as FactRow | null;
    if (!run || run.session_id !== write.sessionId
      || run.kind === 'provider' && (write.sessionId !== null || write.toolCallId !== null)) throw new EventFault('state_conflict');
    switch (write.type) {
      case 'run_created': case 'run_started': case 'run_completed': case 'run_failed': case 'run_cancelled': {
        const at = write.type === 'run_created' ? run.created_at : write.type === 'run_started' ? run.started_at : run.ended_at;
        if (write.toolCallId !== null || run.status !== write.payload.status || at !== write.occurredAt
          || stopped(run.cleanup_json) !== write.payload.stopped || errorCode(run.error_json) !== write.payload.errorCode) throw new EventFault('state_conflict');
        break;
      }
      case 'run_cancel_requested':
        if (write.toolCallId !== null || run.cancel_requested_at !== write.payload.requestedAt
          || write.occurredAt !== write.payload.requestedAt) throw new EventFault('state_conflict');
        break;
      case 'run_usage_updated': {
        const usage = object(run.usage_json);
        const tokens = { inputTokens: run.input_tokens, outputTokens: run.output_tokens, totalTokens: run.total_tokens,
          cost: run.cost, usageComplete: run.usage_complete === 1 };
        if (write.toolCallId !== null || !same(tokens, write.payload.tokens)
          || (usage.attempts ?? null) !== write.payload.attempts || (usage.attemptsComplete === true) !== write.payload.attemptsComplete
          || (usage.source ?? 'unknown') !== write.payload.source) throw new EventFault('state_conflict');
        break;
      }
      case 'tool_requested': case 'tool_started': case 'tool_succeeded': case 'tool_failed': case 'tool_cancelled': {
        const call = db.query('SELECT * FROM tool_calls WHERE id=? AND run_id=? AND session_id=?')
          .get(write.toolCallId, write.runId, write.sessionId) as FactRow | null;
        if (!call) throw new EventFault('state_conflict');
        const result = call.result_json === null ? null : object(call.result_json);
        const at = write.type === 'tool_requested' ? call.requested_at : write.type === 'tool_started' ? call.started_at : call.ended_at;
        if (call.status !== write.payload.status || call.tool_name !== write.payload.toolName
          || at !== write.occurredAt || (result?.committedCandidateId ?? null) !== write.payload.committedCandidateId
          || stopped(call.cleanup_json) !== write.payload.stopped
          || (result?.error && typeof result.error === 'object' ? (result.error as FactRow).code : null) !== write.payload.errorCode) throw new EventFault('state_conflict');
        break;
      }
      case 'input_state_changed': {
        const input = db.query('SELECT * FROM session_inputs WHERE id=? AND run_id=? AND session_id=?')
          .get(write.payload.inputId, write.runId, write.sessionId) as FactRow | null;
        if (write.toolCallId !== null || !input || input.status !== write.payload.status
          || input.processing_status !== write.payload.processingStatus || input.native_entry_id !== write.payload.nativeEntryId
          || input.result_entry_id !== write.payload.resultEntryId || errorCode(input.error_json) !== write.payload.errorCode
          || input.updated_at !== write.occurredAt) throw new EventFault('state_conflict');
        break;
      }
    }
  }

  function appendInTransaction(write: EventWrite): RuntimeEvent {
    if (depth === 0 || !db.inTransaction) throw new EventFault('state_conflict');
    const receivedAt = new Date().toISOString();
    const checked = RuntimeEventSchema.safeParse({ eventId: 1, runId: write.runId, sequence: 1,
      sessionId: write.sessionId, toolCallId: write.toolCallId, sourceConnection: write.sourceConnection ?? null,
      sourceSequence: write.sourceSequence ?? null, type: write.type, payload: write.payload,
      occurredAt: write.occurredAt, receivedAt });
    if (!checked.success) throw new EventFault('state_conflict');
    const expectedKey = migrationKey(write);
    if (expectedKey !== null && (write.dedupeKey !== expectedKey || expectedKey.length > 2048)) throw new EventFault('state_conflict');
    if (write.type === 'run_usage_updated' && write.dedupeKey !== undefined) throw new EventFault('state_conflict');
    if (expectedKey !== null) {
      const previous = db.query('SELECT * FROM runtime_events WHERE run_id=? AND dedupe_key=?')
        .get(write.runId, expectedKey) as Row | null;
      if (previous) {
        const event = decode(previous);
        if (!same(fact(event), fact(checked.data))) throw new EventFault('state_conflict');
        return event;
      }
    }
    validateFact(write);
    const sequence = (db.query('SELECT COALESCE(MAX(sequence),0) AS sequence FROM runtime_events WHERE run_id=?')
      .get(write.runId) as { sequence: number }).sequence + 1;
    if (!Number.isSafeInteger(sequence) || sequence < 1) throw new EventFault('storage_corrupt');
    const inserted = db.query(`INSERT INTO runtime_events(run_id,sequence,session_id,tool_call_id,dedupe_key,
      source_connection,source_sequence,type,payload_json,occurred_at,received_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)`)
      .run(write.runId, sequence, write.sessionId, write.toolCallId, expectedKey ?? `run:usage:${sequence}`,
        write.sourceConnection ?? null, write.sourceSequence ?? null, write.type, JSON.stringify(checked.data.payload), write.occurredAt, receivedAt);
    const eventId = Number(inserted.lastInsertRowid);
    const event = RuntimeEventSchema.parse({ ...checked.data, eventId, sequence });
    pending.push({ runId: write.runId, sequence });
    return event;
  }

  function query(input: RuntimeEventsQuery): RuntimeEventsReadResult {
    let context: RuntimeEventReadContext | null = null;
    const failure = (code: string, category: 'input' | 'storage', retryable = false): RuntimeEventsReadResult => ({
      ok: false, error: appError(code, category, code, retryable, input.runId), context });
    const parsed = RuntimeEventsQuerySchema.safeParse(input);
    if (!parsed.success) return { ok: false, error: appError('input_invalid', 'input', 'Runtime event query is invalid.'), context: null };
    try {
      return db.transaction((): RuntimeEventsReadResult => {
        const request = parsed.data;
        const run = db.query('SELECT id,session_id FROM runs WHERE id=?').get(request.runId) as { id: number; session_id: number | null } | null;
        if (!run) return failure('run_not_found', 'input');
        const range = db.query(`SELECT MIN(sequence) AS first,MAX(sequence) AS last,
          MAX(CASE WHEN type='run_created' THEN 1 ELSE 0 END) AS has_created FROM runtime_events WHERE run_id=?`)
          .get(request.runId) as { first: number | null; last: number | null; has_created: number | null };
        if (range.first !== null && (!Number.isSafeInteger(range.first) || range.first < 1
          || !Number.isSafeInteger(range.last) || range.last! < range.first)) throw new EventFault('storage_corrupt');
        const highWatermark = range.last ?? 0;
        context = { runId: run.id, sessionId: run.session_id, highWatermark,
          availableRange: range.first === null ? null : { fromSequence: range.first, toSequence: highWatermark },
          coverage: range.first === null ? 'none' : range.has_created === 1 ? 'from-created' : 'partial' };
        const c = request.cursor.lastPersistedSequence;
        const through = request.throughSequence ?? highWatermark;
        const d = request.availableAfterSequence;
        if (run.session_id !== request.sessionId || request.cursor.runId !== run.id || c < 0 || c > highWatermark
          || through < c || through > highWatermark || d !== undefined && (d < c || d > through)) return failure('event_cursor_invalid', 'input');
        const position = d ?? c;
        const rows = db.query('SELECT * FROM runtime_events WHERE run_id=? AND sequence>? AND sequence<=? ORDER BY sequence LIMIT ?')
          .all(run.id, position, through, request.limit + 1) as Row[];
        const items: RuntimeEvent[] = [];
        let last = position;
        const page = (hasMore: boolean): RuntimeEventsReadResult => ({ ok: true, data: { ...context!, items,
          nextCursor: { runId: run.id, lastPersistedSequence: d === undefined ? last : c }, hasMore,
          nextAvailableAfterSequence: d === undefined ? null : last } });
        for (const row of rows) {
          if (row.sequence !== last + 1) {
            if (items.length) return page(true);
            return { ok: false, error: appError('event_gap', 'storage', 'A persisted event interval is missing.', false, run.id),
              context: { ...context!, gap: { fromSequence: last + 1, toSequence: row.sequence - 1, continueAfterSequence: row.sequence - 1 } } };
          }
          if (items.length >= request.limit) return page(true);
          const event = decode(row);
          if (event.runId !== run.id || event.sessionId !== run.session_id) throw new EventFault('storage_corrupt');
          items.push(event);
          const previous = last;
          last = event.sequence;
          if (Buffer.byteLength(JSON.stringify(page(last < through)), 'utf8') > 262144) {
            items.pop(); last = previous;
            if (!items.length) throw new EventFault('storage_corrupt');
            return page(true);
          }
        }
        // A fixed through position can itself fall inside a hole before a later row.
        // Do not return an empty hasMore page forever or silently confirm that hole.
        if (!items.length && last < through) {
          const next = db.query('SELECT sequence FROM runtime_events WHERE run_id=? AND sequence>? ORDER BY sequence LIMIT 1')
            .get(run.id, last) as { sequence: number } | null;
          if (!next || next.sequence <= last + 1) throw new EventFault('storage_corrupt');
          return { ok: false, error: appError('event_gap', 'storage', 'A persisted event interval is missing.', false, run.id),
            context: { ...context!, gap: { fromSequence: last + 1, toSequence: next.sequence - 1, continueAfterSequence: next.sequence - 1 } } };
        }
        const result = page(last < through);
        if (!RuntimeEventsReadResultSchema.safeParse(result).success) throw new EventFault('storage_corrupt');
        return result;
      })();
    } catch (error) {
      return error instanceof EventFault ? failure('storage_corrupt', 'storage') : failure('storage_read_failed', 'storage', true);
    }
  }

  return { withTransaction, appendInTransaction, query,
    onCommitted(listener: (refs: readonly CommittedEventRef[]) => void): () => void {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    } };
}
export type RuntimeEventStore = ReturnType<typeof createRuntimeEventStore>;
