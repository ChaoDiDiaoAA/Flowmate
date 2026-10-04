import { appError, fail, normalizeSessionInputRequest, ok, SessionMessagesPageSchema, normalizeAgentRunRequest,
  SetSessionStatusRequestSchema, BranchSessionRequestSchema, WorkspaceContextSchema } from '@flowmate/contracts';
import { isDeepStrictEqual } from 'node:util';
import type {
  AgentPort,
  CreateSessionRequest,
  DbId,
  DeleteSessionResult,
  NormalizedListSessionsRequest,
  Result,
  RenameSessionRequest,
  RuntimeState,
  SessionAvailability,
  SessionPage,
  SessionSnapshot,
  NormalizedSessionMessagesRequest,
  SessionMessagesPage,
  MessageRunInput,
  AgentControl,
  NormalizedAgentRunRequest,
  NormalizedSessionInputRequest,
  RunAccepted,
  SessionInputRequest,
  SessionInputQuery,
  SessionInputQueryResult,
  SessionInputAccepted,
  NormalizedActiveInputRequest,
  SessionInputsRequest,
  SessionInputsPage,
  SetSessionStatusRequest,
  BranchSessionRequest,
  BranchSessionResult,
  MemoryStore, NativeHistoryPageRequest, NativeHistoryPage, SessionHistoryEntryRequest, SessionHistoryEntryDetail,
  NativeHistoryWrite, HistoryCommitReceipt,
} from '@flowmate/contracts';
import { createHistoryReader } from '../memory/history.ts';
import type { SessionRepository, SessionRow, RunRepository } from '../storage/repositories.ts';
import type { SessionInputLedger } from './input-ledger.ts';

export class SessionService {
  private readonly managing = new Set<DbId>();

  public constructor(
    private readonly repository: SessionRepository,
    private readonly agent: AgentPort,
    private readonly runtimeState: () => RuntimeState,
    private readonly now: () => string,
    private readonly runs: RunRepository,
    private readonly memory: Pick<MemoryStore, 'load' | 'commit'>,
    private readonly inputs?: SessionInputLedger,
    private readonly startInput?: (request: NormalizedAgentRunRequest, submission: NormalizedSessionInputRequest, control?: AgentControl) => Promise<Result<RunAccepted>>,
    private readonly appendInput?: (request: NormalizedActiveInputRequest) => Promise<Result<SessionInputAccepted>>,
    private readonly verifyMutation?: (sessionId: DbId) => Result<void>,
  ) {}

  public isManaging(sessionId: DbId): boolean { return this.managing.has(sessionId); }

  private historyReader() {
    return createHistoryReader({ repository: this.repository, agent: this.agent, project: row => this.project(row),
      managementReason: row => {
        const state = this.runtimeState();
        if (this.managing.has(row.sessionId) || state.active?.kind === 'agent' && state.active.sessionId === row.sessionId) return 'busy';
        const eligibility = this.verifyMutation?.(row.sessionId);
        if (state.blocked || eligibility && !eligibility.ok || row.status !== 'active' || row.deletePending) return 'session-unavailable';
        try {
          const availability = this.agent.inspect(row.nativeSessionId).availability;
          if (availability === 'busy') return 'busy';
          if (availability === 'unusable') return 'session-unavailable';
        } catch { return 'session-unavailable'; }
        return null;
      } });
  }
  public listHistory(request: NativeHistoryPageRequest): Result<NativeHistoryPage> { return this.historyReader().list(request); }
  public async querySessionHistory(request: NativeHistoryPageRequest): Promise<Result<NativeHistoryPage>> { return this.listHistory(request); }
  public async querySessionHistoryEntry(request: SessionHistoryEntryRequest): Promise<Result<SessionHistoryEntryDetail>> { return this.historyReader().detail(request); }

  public async submitInput(raw: SessionInputRequest, control?: AgentControl): Promise<Result<SessionInputAccepted>> {
    const normalized = normalizeSessionInputRequest(raw);
    if (!normalized.ok) return normalized;
    if (!this.inputs) return fail(appError('session_input_unavailable', 'session', 'Session input is unavailable.'));
    let accepted: Result<RunAccepted>;
    const submission = normalized.data;
    if (submission.mode !== 'prompt') {
      if (!this.appendInput) return fail(appError('agent_input_unavailable', 'runtime', 'Active input is unavailable.'));
      accepted = await this.appendInput(submission);
    } else {
      if (!this.startInput) return fail(appError('session_input_unavailable', 'session', 'Session input is unavailable.'));
      const { clientSequence: _sequence, mode: _mode, ...withTarget } = submission;
      const { formTarget: _target, ...request } = withTarget as typeof withTarget & { formTarget?: unknown };
      const runRequest = submission.goalMode === 'fill-form' ? ok(request as NormalizedAgentRunRequest) : normalizeAgentRunRequest(request);
      if (!runRequest.ok) return runRequest;
      accepted = await this.startInput(runRequest.data, submission, control);
    }
    return !accepted.ok ? accepted : accepted.data.inputId === undefined
      ? fail(appError('input_processing_unconfirmed', 'runtime', 'Input admission returned no durable identity.'))
      : ok({ inputId: accepted.data.inputId, sessionId: accepted.data.sessionId, runId: accepted.data.runId });
  }

  public queryInput(request: SessionInputQuery): Result<SessionInputQueryResult> {
    return this.inputs?.query(request) ?? fail(appError('session_input_unavailable', 'session', 'Session input is unavailable.'));
  }

  public listInputs(request: SessionInputsRequest): Result<SessionInputsPage> {
    return this.inputs?.list(request) ?? fail(appError('session_input_unavailable', 'session', 'Session input storage is unavailable.'));
  }

  private acquireMutation(sessionId: DbId): Result<void> {
    if (this.managing.has(sessionId)) return fail(appError('session_busy', 'session', 'Session management is in progress.', true));
    const eligible = this.verifyMutation?.(sessionId);
    if (eligible && !eligible.ok) return eligible;
    const state = this.runtimeState();
    if (state.blocked) return fail(state.error ?? appError('runtime_unusable', 'runtime', 'Runtime is unavailable.', true));
    if (state.active?.kind === 'agent' && state.active.sessionId === sessionId)
      return fail(appError('session_busy', 'session', 'This Session has an active Run.', true));
    this.managing.add(sessionId);
    return ok(undefined);
  }

  public setStatus(raw: SetSessionStatusRequest): Result<SessionSnapshot> {
    const parsed = SetSessionStatusRequestSchema.safeParse(raw);
    if (!parsed.success) return fail(appError('input_invalid', 'input', 'Session status request is invalid.'));
    const acquired = this.acquireMutation(parsed.data.sessionId);
    if (!acquired.ok) return acquired;
    try {
      const changed = this.repository.setStatus({ ...parsed.data, at: this.now() });
      return changed.ok ? ok(this.project(changed.data)) : changed;
    } finally { this.managing.delete(parsed.data.sessionId); }
  }

  public async branch(raw: BranchSessionRequest): Promise<Result<BranchSessionResult>> {
    const parsed = BranchSessionRequestSchema.safeParse(raw);
    if (!parsed.success) return fail(appError('input_invalid', 'input', 'Session branch request is invalid.'));
    const request = parsed.data;
    const acquired = this.acquireMutation(request.sessionId);
    if (!acquired.ok) return acquired;
    let retainBlocked = false;
    try {
      const frozen = this.repository.readHistorySnapshot(request.sessionId, value => ok(value));
      if (!frozen.ok) return frozen;
      const { row, bundle, blocked } = frozen.data;
      if (row.deletePending) return fail(appError('session_delete_incomplete', 'session', 'Retry Delete to finish removing this Session.', true));
      if (row.status !== 'active') return fail(appError('session_archived', 'session', 'Session is archived.'));
      if (blocked) return fail(appError('session_scope_revoked', 'session', 'Material access was revoked.'));
      const { history, commit, seed } = bundle;
      if (!history || !commit || history.unusable || row.historyState !== 'recoverable')
        return fail(appError('session_history_invalid', 'session', 'Saved history is unusable.'));
      if (commit.commitRevision !== request.expectedCommitRevision || commit.entryCount !== request.expectedEntryCount || commit.leafId !== request.expectedLeafId)
        return fail(appError('state_conflict', 'session', 'Saved branch position has changed.', true));
      if (!this.agent.moveSessionLeaf || !this.agent.restoreSessionLeaf || !this.agent.inspectSessionHistory)
        return fail(appError('session_branch_unavailable', 'session', 'Native branch selection is unavailable.'));
      const inspection = this.agent.inspectSessionHistory({ history, seed });
      if (!inspection.ok) return inspection;
      if (inspection.data.positions.find(position => position.entryId === request.targetEntryId)?.contextState !== 'complete')
        return fail(appError('session_branch_unavailable', 'session', 'Select a complete saved native context.'));
      const restored = ensureNativeSession(this.repository, this.agent, row, this.memory);
      if (!restored.ok) return restored;
      const intended = { history: { ...history, leafId: request.targetEntryId }, seed,
        commit: { ...commit, leafId: request.targetEntryId, commitRevision: commit.commitRevision + (history.leafId === request.targetEntryId ? 0 : 1) } };
      const moved = await this.agent.moveSessionLeaf(row.nativeSessionId, request.targetEntryId);
      let failure = moved.ok ? appError('storage_write_failed', 'storage', 'Branch selection could not be saved.', true) : moved.error;
      if (moved.ok && sameJson(moved.data, intended.history)) {
        try {
          const saved = this.memory.commit({ sessionId: request.sessionId, expected: commit, header: history.header,
            appendEntries: [], contexts: [], leafId: request.targetEntryId, unusable: history.unusable });
          if (!saved.ok) failure = saved.error;
        } catch { /* Query this operation once; never repeat a position mutation or CAS. */ }
      }
      const readback = this.repository.readHistorySnapshot(request.sessionId, value => ok(value));
      const latest = readback.ok ? ok(readback.data.bundle) : readback;
      const unchangedAssociations = readback.ok && sameJson(readback.data.associations, frozen.data.associations) && !readback.data.blocked;
      const targetConfirmed = latest.ok && unchangedAssociations && sameJson(latest.data, intended);
      const oldConfirmed = latest.ok && unchangedAssociations && sameJson(latest.data, bundle);
      if (!latest.ok || !targetConfirmed && !oldConfirmed || !latest.data.history || !latest.data.commit) {
        retainBlocked = true;
        const sticky = this.repository.markHistoryUnusable(request.sessionId);
        try { await this.agent.releaseSession(row.nativeSessionId); } catch { /* The management gate remains closed. */ }
        return !sticky.ok ? sticky : !latest.ok ? latest : fail(appError('session_history_invalid', 'session', 'Committed branch position cannot be confirmed.', true));
      }
      const confirmed = this.agent.restoreSessionLeaf(row.nativeSessionId, latest.data.history, latest.data.seed, latest.data.commit);
      if (!confirmed.ok) {
        retainBlocked = true;
        const sticky = this.repository.markHistoryUnusable(request.sessionId);
        try { await this.agent.releaseSession(row.nativeSessionId); } catch { /* Preserve the management gate. */ }
        return !sticky.ok ? sticky : confirmed;
      }
      if (targetConfirmed && moved.ok)
        return ok({ session: this.project(row), leafId: request.targetEntryId, entryCount: history.entries.length });
      return fail(failure);
    } finally { if (!retainBlocked) this.managing.delete(request.sessionId); }
  }

  public async create(request: CreateSessionRequest): Promise<Result<SessionSnapshot>> {
    const native = this.agent.createSession();
    if (!native.ok) return native;
    const history = this.agent.exportSession?.(native.data.nativeSessionId);
    if (history && !history.ok) {
      await this.agent.releaseSession(native.data.nativeSessionId);
      return history;
    }
    const row = this.repository.create({ nativeSessionId: native.data.nativeSessionId, title: request.title ?? 'New Session',
      at: this.now(), ...(history?.ok ? { nativeHistory: history.data } : {}),
      ...(request.expectedRevision === undefined ? {} : { expectedRevision: request.expectedRevision }) });
    if (!row.ok) {
      try { await this.agent.releaseSession(native.data.nativeSessionId); } catch { /* preserve the failed DB insert */ }
      return row;
    }
    // Older ports can still create a browse-only product identity; no durable
    // Header means they cannot advertise native readiness or admit a new Run.
    if (!history) return ok(this.project(row.data));
    const watched = ensureNativeSession(this.repository, this.agent, row.data, this.memory);
    if (!watched.ok) {
      await this.agent.releaseSession(native.data.nativeSessionId);
      return watched;
    }
    return ok(this.project(row.data));
  }

  public get(sessionId: DbId) {
    const row = this.repository.get(sessionId);
    if (!row.ok) return row;
    return ok(this.project(row.data));
  }

  public rename(request: RenameSessionRequest): Result<SessionSnapshot> {
    if (this.managing.has(request.sessionId)) return deleteInProgress();
    const row = this.repository.rename({ sessionId: request.sessionId, title: request.title, at: this.now() });
    return row.ok ? ok(this.project(row.data)) : row;
  }

  public async deleteSession(sessionId: DbId): Promise<Result<DeleteSessionResult>> {
    const acquired = this.acquireMutation(sessionId);
    if (!acquired.ok) return acquired;
    try {
      const prepared = this.repository.prepareDelete(sessionId, this.now());
      if (!prepared.ok) return prepared;
      let released;
      try { released = await this.agent.releaseSession(prepared.data.nativeSessionId); }
      catch { return failDeleteSession(); }
      if (!released.stopped || !released.closed) return failDeleteSession();
      const deleted = this.repository.delete(sessionId, this.now());
      return deleted.ok ? ok({ deletedSessionId: sessionId, disposition: deleted.data }) : failDeleteSession();
    } finally {
      this.managing.delete(sessionId);
    }
  }

  public list(request: NormalizedListSessionsRequest): Result<SessionPage> {
    const page = this.repository.list(request);
    if (!page.ok) return page;
    return ok({
      items: page.data.items.map((row) => this.project(row)),
      next: page.data.next,
    });
  }

  public listMessages(request: NormalizedSessionMessagesRequest): Result<SessionMessagesPage> {
    const row = this.repository.get(request.sessionId);
    if (!row.ok) return row;
    const stored = this.repository.readHistoryForDisplay(request.sessionId);
    if (!stored.ok) return stored;
    if (!stored.data.history && row.data.historyState === 'legacy-read-only') {
      return ok({ session: this.project(row.data), leafId: null, entryCount: 0, items: [], nextBeforeEntryId: null });
    }
    if (!stored.data.history || !this.agent.projectSessionMessages) {
      return fail(appError('session_history_unavailable', 'session', 'Saved native messages are unavailable.'));
    }
    const runInputs: MessageRunInput[] = [];
    for (const runId of new Set(stored.data.bindings.map((binding) => binding.runId))) {
      const run = this.runs.get(runId);
      if (!run.ok || run.data.kind !== 'agent' || !stored.data.origins.filter(origin => origin.originRunId === runId).every(origin => origin.originSessionId === run.data.sessionId)) {
        return fail(appError('session_history_invalid', 'session', 'Saved message Run identity is inconsistent.'));
      }
      const config = run.data.config as Record<string, unknown>;
      const mode = config.goalMode;
      const goalMode = mode === 'answer' || mode === 'save-candidate' || mode === 'fill-form' ? mode : null;
      if (run.data.input.version === 2 && goalMode === null) {
        return fail(appError('session_history_invalid', 'session', 'Saved message Run context is incomplete.'));
      }
      const context = config.workspaceContext === undefined ? undefined : WorkspaceContextSchema.safeParse(config.workspaceContext);
      if (context && !context.success)
        return fail(appError('session_history_invalid', 'session', 'Saved message Workspace context is invalid.'));
      runInputs.push({ runId, input: run.data.input, goalMode,
        ...(context?.success ? { workspaceContext: context.data } : {}),
        ...(typeof config.workingDirectory === 'string' ? { workingDirectory: config.workingDirectory } : {}) });
    }
    const projected = this.agent.projectSessionMessages({ history: stored.data.history, bindings: stored.data.bindings,
      runInputs, sessionInputs: stored.data.sessionInputs, limit: request.limit, ...(request.beforeEntryId === undefined ? {} : { beforeEntryId: request.beforeEntryId }) });
    if (!projected.ok) return projected;
    const page = { session: this.project(row.data), leafId: stored.data.history.leafId,
      entryCount: stored.data.history.entries.length, ...projected.data };
    const parsed = SessionMessagesPageSchema.safeParse(page);
    return parsed.success ? ok(parsed.data) : fail(appError('session_history_invalid', 'session', 'Saved message projection is invalid.'));
  }

  private project(row: SessionRow): SessionSnapshot {
    const activeRun = this.runtimeState().active;
    const activeRunId = activeRun?.kind === 'agent' && activeRun.sessionId === row.sessionId ? activeRun.runId : null;
    let availability: SessionAvailability;
    if (row.status === 'archived') availability = 'archived';
    else {
      try {
        const inspected = this.agent.inspect(row.nativeSessionId);
        availability = row.nativeUnusable ? 'unusable'
          : row.historyState !== 'recoverable' ? 'history-unavailable'
          : activeRunId !== null || inspected.availability === 'busy' ? 'busy'
          : inspected.availability === 'ready' ? 'ready'
            : inspected.availability === 'unusable' ? 'unusable'
              : row.historyState === 'recoverable' ? 'ready' : 'history-unavailable';
      } catch {
        availability = 'history-unavailable';
      }
    }
    return {
      sessionId: row.sessionId,
      nativeSessionId: row.nativeSessionId,
      title: row.title,
      status: row.status,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      availability,
      historyState: row.historyState,
      activeRunId,
      modelUseBlocked: row.modelUseBlocked,
      hasBusinessHistory: row.hasBusinessHistory,
      deletePending: row.deletePending,
    };
  }
}

export function ensureNativeSession(repository: SessionRepository, agent: AgentPort, row: SessionRow, memory: Pick<MemoryStore, 'load' | 'commit'>): Result<void> {
  if (row.nativeUnusable) return fail(appError('agent_session_unusable', 'session', 'This conversation cannot continue after an interrupted request.'));
  let availability: ReturnType<AgentPort['inspect']>['availability'];
  try {
    availability = agent.inspect(row.nativeSessionId).availability;
  } catch { return fail(appError('agent_session_unavailable', 'session', 'Conversation state is unavailable.')); }
  if (availability === 'busy') return fail(appError('session_busy', 'session', 'Native Session is active.', true));
  if (availability === 'unusable') return fail(appError('agent_session_unusable', 'session', 'Native Session is unusable.'));
  if (availability === 'missing' && (row.historyState !== 'recoverable' || !agent.restoreSession || !agent.watchSession)) {
    return fail(appError(row.historyState === 'invalid' ? 'session_history_invalid' : 'session_history_unavailable',
      'session', 'This conversation cannot be restored. Start a new chat.'));
  }
  const bundle = repository.readHistorySnapshot(row.sessionId, value => value.blocked
    ? fail(appError('session_scope_revoked', 'session', 'Material access was revoked.')) : ok(value.bundle));
  if (!bundle.ok) return bundle;
  if (!bundle.data.history || !bundle.data.commit || !agent.watchSession)
    return fail(appError('session_history_unavailable', 'session', 'This conversation has no saved native history.'));
  const restore = availability === 'ready' ? agent.restoreSessionLeaf : agent.restoreSession;
  if (!restore) return fail(appError('context_binding_unknown', 'runtime', 'Saved conversation sources cannot be reconnected.'));
  const restored = restore.call(agent, row.nativeSessionId, bundle.data.history, bundle.data.seed, bundle.data.commit);
  if (!restored.ok) return restored;
  return agent.watchSession(row.nativeSessionId, bundle.data.commit, bundle.data.seed, write => commitNativeWrite(repository, memory, row.sessionId, write));
}

function sameJson(a: unknown, b: unknown): boolean { return isDeepStrictEqual(JSON.parse(JSON.stringify(a)), JSON.parse(JSON.stringify(b))); }
function commitNativeWrite(repository: SessionRepository, memory: Pick<MemoryStore, 'load' | 'commit'>, sessionId: DbId,
  write: NativeHistoryWrite): Result<HistoryCommitReceipt> {
  const writeInputIds = [...new Set(write.contexts.flatMap(context => [
    ...(context.inputId === undefined ? [] : [context.inputId]), ...(context.resultInputIds ?? [])]))];
  const before = repository.readHistorySnapshot(sessionId, value => ok(value), writeInputIds);
  if (!before.ok) return before;
  const frozen = before.data;
  if (!frozen.bundle.history || !sameJson(frozen.bundle.commit, write.expected))
    return fail(appError('state_conflict', 'session', 'Conversation history has changed.', true));
  const changed = !sameJson(frozen.bundle.history, write.history);
  const intended = { commitRevision: write.expected.commitRevision + (changed ? 1 : 0), entryCount: write.history.entries.length, leafId: write.history.leafId };
  const contexts = new Map(write.contexts.map(context => [context.entryId, context]));
  const oldEntries = new Map(frozen.associations.entries.map(entry => [entry.entry_id, entry]));
  // Freeze the exact association effects declared by this write, before invoking SQL.
  const associations = { entries: write.history.entries.map(entry => oldEntries.get(entry.id)
      ?? { entry_id: entry.id, run_id: contexts.get(entry.id)?.runId ?? null }),
    inputs: structuredClone(frozen.associations.inputs) };
  for (const entry of write.history.entries) {
    const context = contexts.get(entry.id); if (!context) continue;
    for (const input of associations.inputs) {
      if (input.id === context.inputId && input.status !== 'consumed') {
        input.status = 'consumed'; input.native_entry_id = entry.id; input.updated_at = entry.timestamp;
      }
      if (context.resultInputIds?.includes(input.id as number) && input.result_entry_id === null) {
        input.result_entry_id = entry.id; input.updated_at = entry.timestamp;
      }
    }
  }
  let saved: Result<HistoryCommitReceipt>;
  try { saved = memory.commit({ sessionId, expected: write.expected, header: write.history.header, appendEntries: write.history.entries,
    leafId: write.history.leafId, unusable: write.history.unusable, contexts: write.contexts }); }
  catch { saved = fail(appError('storage_write_failed', 'storage', 'Conversation history could not be saved.', true)); }
  if (saved.ok && sameJson(saved.data, intended)) return saved;
  const loaded = repository.readHistorySnapshot(sessionId, value => ok(value), writeInputIds);
  if (loaded.ok && sameJson(loaded.data.bundle.history, write.history) && sameJson(loaded.data.bundle.commit, intended)
    && sameJson(loaded.data.associations, associations)) {
    const seed = loaded.data.bundle.seed;
    const origins = new Map(seed.origins.map(origin => [origin.nativeEntryId, origin]));
    const originalSourcesMatch = frozen.bundle.seed.origins.every(origin => sameJson(origin, origins.get(origin.nativeEntryId)))
      && frozen.bundle.seed.inputs.every(input => sameJson(input, seed.inputs.find(item => item.nativeEntryId === input.nativeEntryId)));
    const appendedSourcesMatch = write.history.entries.slice(write.expected.entryCount).every(entry => {
      const context = contexts.get(entry.id); const origin = origins.get(entry.id);
      return origin?.originSessionId === sessionId && origin.originRunId === (context?.runId ?? null);
    });
    if (originalSourcesMatch && appendedSourcesMatch) return ok(intended);
  }
  const blocked = repository.markHistoryUnusable(sessionId);
  if (!blocked.ok) return blocked;
  return !saved.ok ? saved : fail(appError('storage_write_failed', 'storage', 'Conversation history receipt could not be confirmed.', true));
}

function deleteInProgress<T>(): Result<T> {
  return fail(appError('session_delete_in_progress', 'session', 'A Session deletion is already in progress.', true));
}

function failDeleteSession(): Result<DeleteSessionResult> {
  return { ok: false, error: { code: 'session_delete_incomplete', category: 'session', message: 'Session deletion is incomplete. Retry Delete Session to finish removing it.', retryable: true } };
}
