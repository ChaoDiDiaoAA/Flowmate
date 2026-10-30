import { isDeepStrictEqual } from 'node:util';
import { appError, fail, ok, DurableSubagentConfigSnapshotSchema, DurableSubagentRunScopeSchema,
  PersonalHistoryEntryRequestSchema, PersonalHistoryEntrySchema, PersonalHistoryPageSchema, PersonalHistoryRequestSchema,
  type DurableHistoryOwner, type DurableRuntimePort, type PersonalHistoryApi, type PersonalHistoryOwner,
  type PersonalHistoryTarget, type Result } from '@flowmate/contracts';
import type { DbHandle } from '../storage/database.ts';

const invalid = () => fail(appError('input_invalid', 'input', 'The Personal Agent history request is invalid.'));
const conflict = () => fail(appError('state_conflict', 'input', 'The history does not belong to the requested invoice Work.'));
const unavailable = () => fail(appError('storage_read_failed', 'storage', 'The original Personal Agent history could not be read.', true));
const publicOwner = (owner: DurableHistoryOwner): PersonalHistoryOwner => ({ runtimeKind: 'durable', workId: owner.workId,
  sessionId: owner.child?.childSessionId ?? owner.sessionId, childRunId: owner.child?.childRunId ?? null });

/** Resolve saved business ownership before crossing the native read boundary; no live execution is required. */
export function createPersonalHistoryService(options: {
  database: Pick<DbHandle, 'read'>;
  runtime: Pick<DurableRuntimePort, 'queryHistoryPage' | 'queryHistoryEntry'>;
}): PersonalHistoryApi {
  async function owner(target: PersonalHistoryTarget): Promise<Result<DurableHistoryOwner>> {
    try { return await options.database.read(store => {
      const found = store.invoiceWorks.get({ view: 'work', workId: target.workId, limit: 1 }); if (!found.ok) return found;
      const session = store.sessions.get(found.data.work.sessionId); if (!session.ok) return session;
      if (session.data.runtimeKind !== 'durable') return conflict();
      const parent = { workId: target.workId, sessionId: session.data.sessionId };
      if (target.childRunId === undefined) return ok(parent);
      const child = store.runs.get(target.childRunId); if (!child.ok) return child;
      const run = child.data;
      if (run.kind !== 'subagent' || !('runtimeKind' in run) || run.runtimeKind !== 'durable' || run.sessionId === null) return conflict();
      const scope = DurableSubagentRunScopeSchema.safeParse(run.scope), config = DurableSubagentConfigSnapshotSchema.safeParse(run.config);
      if (!scope.success || !config.success || scope.data.workId !== target.workId
        || scope.data.originToolCallId !== run.originToolCallId || scope.data.parentRunId !== run.parentRunId
        || config.data.durable.workId !== target.workId || config.data.durable.attemptId !== scope.data.attemptId
        || !isDeepStrictEqual(config.data.subagent, { parentRunId: scope.data.parentRunId, originToolCallId: scope.data.originToolCallId,
          phaseId: scope.data.phaseId, itemId: scope.data.itemId, parentRequestId: scope.data.parentRequestId, role: scope.data.role })) return conflict();
      const source = store.db.query<{ plugin_agent_id: string | null }, [number, number, number, number, string, number]>(
        `SELECT r.plugin_agent_id FROM runs r JOIN invoice_work_attempts a ON a.run_id=r.parent_run_id
         JOIN invoice_work_phases p ON p.work_id=a.work_id AND p.attempt_id=a.id
         WHERE r.id=? AND a.work_id=? AND a.id=? AND p.id=? AND p.request_id=? AND p.item_id=?`)
        .get(run.runId, target.workId, scope.data.attemptId, scope.data.phaseId, scope.data.parentRequestId, scope.data.itemId);
      if (!source) return conflict();
      const origin = store.toolCalls.getById(scope.data.originToolCallId); if (!origin.ok) return origin;
      const native = /^durable-task:([1-9]\d*)$/.exec(origin.data.nativeToolCallId);
      if (!native || !Number.isSafeInteger(Number(native[1])) || origin.data.toolName !== 'Agent'
        || origin.data.runId !== scope.data.parentRunId || origin.data.sessionId !== parent.sessionId
        || source.plugin_agent_id !== origin.data.nativeToolCallId) return conflict();
      const childSession = store.sessions.get(run.sessionId); if (!childSession.ok) return childSession;
      if (childSession.data.runtimeKind !== 'durable') return conflict();
      return ok({ ...parent, child: { ...parent, attemptId: scope.data.attemptId, requestId: scope.data.parentRequestId,
        childRunId: run.runId, childSessionId: run.sessionId, originToolCallId: scope.data.originToolCallId, nativeToolTaskId: Number(native[1]) } });
    }); } catch { return unavailable(); }
  }
  return {
    async history(raw) {
      const parsed = PersonalHistoryRequestSchema.safeParse(raw); if (!parsed.success) return invalid();
      const resolved = await owner(parsed.data.target); if (!resolved.ok) return resolved;
      try {
        const { target: _target, ...paging } = parsed.data;
        const result = await options.runtime.queryHistoryPage({ ...resolved.data, ...paging }); if (!result.ok) return result;
        const page = PersonalHistoryPageSchema.safeParse(result.data);
        if (!page.success || !isDeepStrictEqual(page.data.owner, publicOwner(resolved.data))
          || parsed.data.throughEntryId !== undefined && page.data.throughEntryId !== parsed.data.throughEntryId
          || page.data.entries.length > parsed.data.limit
          || page.data.entries.some(entry => parsed.data.beforeEntryId !== undefined && entry.entryId >= parsed.data.beforeEntryId)) return conflict();
        return ok(page.data);
      } catch { return unavailable(); }
    },
    async historyEntry(raw) {
      const parsed = PersonalHistoryEntryRequestSchema.safeParse(raw); if (!parsed.success) return invalid();
      const resolved = await owner(parsed.data.target); if (!resolved.ok) return resolved;
      try {
        const { target: _target, ...paging } = parsed.data;
        const result = await options.runtime.queryHistoryEntry({ ...resolved.data, ...paging }); if (!result.ok) return result;
        const entry = PersonalHistoryEntrySchema.safeParse(result.data);
        if (!entry.success || !isDeepStrictEqual(entry.data.owner, publicOwner(resolved.data))
          || entry.data.throughEntryId !== parsed.data.throughEntryId || entry.data.entryId !== parsed.data.entryId
          || entry.data.offset !== parsed.data.offset || new TextEncoder().encode(entry.data.text).byteLength > parsed.data.limit) return conflict();
        return ok(entry.data);
      } catch { return unavailable(); }
    },
  };
}
