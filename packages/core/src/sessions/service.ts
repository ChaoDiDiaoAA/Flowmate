import { appError, fail, normalizeSessionInputRequest, ok, SessionMessagesPageSchema, normalizeAgentRunRequest,
  SetSessionStatusRequestSchema, BranchSessionRequestSchema, WorkspaceContextSchema } from '@flowmate/contracts';
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
} from '@flowmate/contracts';
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
    private readonly inputs?: SessionInputLedger,
    private readonly startInput?: (request: NormalizedAgentRunRequest, submission: NormalizedSessionInputRequest, control?: AgentControl) => Promise<Result<RunAccepted>>,
    private readonly appendInput?: (request: NormalizedActiveInputRequest) => Promise<Result<SessionInputAccepted>>,
    private readonly verifyMutation?: (sessionId: DbId) => Result<void>,
  ) {}

  public isManaging(sessionId: DbId): boolean { return this.managing.has(sessionId); }

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
      const row = this.repository.get(request.sessionId);
      if (!row.ok) return row;
      if (row.data.deletePending) return fail(appError('session_delete_incomplete', 'session', 'Retry Delete to finish removing this Session.', true));
      if (row.data.status !== 'active') return fail(appError('session_archived', 'session', 'Session is archived.'));
      if (row.data.modelUseBlocked) return fail(appError('session_scope_revoked', 'session', 'Material access was revoked.'));
      if (row.data.nativeUnusable || row.data.historyState !== 'recoverable') return fail(appError('session_history_invalid', 'session', 'Saved history is unusable.'));
      const restored = ensureNativeSession(this.repository, this.agent, row.data);
      if (!restored.ok) return restored;
      if (!this.agent.moveSessionLeaf || !this.agent.restoreSessionLeaf) return fail(appError('session_branch_unavailable', 'session', 'Native branch selection is unavailable.'));
      if (this.agent.inspect(row.data.nativeSessionId).availability !== 'ready') return fail(appError('session_busy', 'session', 'Native Session is active.', true));
      const loaded = this.repository.loadHistory(request.sessionId);
      if (!loaded.ok) return loaded;
      const committed = loaded.data;
      if (!committed || committed.leafId !== request.expectedLeafId || committed.entries.length !== request.expectedEntryCount)
        return fail(appError('state_conflict', 'session', 'Saved branch position has changed.', true));
      const path = new Set<string>();
      let entryId = committed.leafId;
      while (entryId !== null) {
        if (path.has(entryId)) return fail(appError('session_history_invalid', 'session', 'Saved path is invalid.'));
        path.add(entryId);
        const entry = committed.entries.find(item => item.id === entryId);
        if (!entry) return fail(appError('session_history_invalid', 'session', 'Saved path is incomplete.'));
        entryId = entry.parentId;
      }
      const target = committed.entries.find(entry => entry.id === request.targetEntryId);
      const message = target?.message as { role?: string; stopReason?: string; content?: { type?: string; text?: string }[] } | undefined;
      if (!path.has(request.targetEntryId) || target?.type !== 'message' || message?.role !== 'assistant' || message.stopReason !== 'stop'
        || !Array.isArray(message.content) || message.content.some(part => part.type === 'toolCall')
        || !message.content.some(part => part.type === 'text' && part.text?.trim()))
        return fail(appError('input_invalid', 'input', 'Select a saved final assistant response on the current branch.'));
      const moved = committed.leafId === request.targetEntryId ? ok(committed)
        : await this.agent.moveSessionLeaf(row.data.nativeSessionId, request.targetEntryId);
      let confirmed = committed.leafId === request.targetEntryId ? committed : null;
      if (moved.ok && confirmed === null) {
        const saved = this.repository.saveHistory(request.sessionId, moved.data);
        if (saved.ok) confirmed = moved.data;
      }
      if (confirmed === null) {
        const latest = this.repository.loadHistory(request.sessionId);
        if (!latest.ok || !latest.data) {
          retainBlocked = true;
          try { await this.agent.releaseSession(row.data.nativeSessionId); } catch { /* the management gate remains closed */ }
          return fail(appError('session_history_invalid', 'session', 'Committed branch position cannot be confirmed.', true));
        }
        confirmed = latest.data;
      }
      const reverted = this.agent.restoreSessionLeaf(row.data.nativeSessionId, confirmed);
      if (!reverted.ok) {
        retainBlocked = true;
        this.repository.saveHistory(request.sessionId, { ...confirmed, unusable: true });
        return fail(appError('session_history_invalid', 'session', 'Native branch restoration could not be confirmed.', true));
      }
      if (confirmed.leafId === request.targetEntryId)
        return ok({ session: this.project(row.data), leafId: request.targetEntryId, entryCount: confirmed.entries.length });
      return moved.ok ? fail(appError('storage_write_failed', 'storage', 'Branch selection could not be saved.', true)) : moved;
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
    const watched = this.agent.watchSession?.(native.data.nativeSessionId,
      (snapshot, context) => this.repository.saveHistory(row.data.sessionId, snapshot, context));
    if (watched && !watched.ok) {
      await this.agent.releaseSession(native.data.nativeSessionId);
      return watched;
    }
    return ok(this.project(row.data));
  }

  public get(sessionId: DbId) {
    const row = this.repository.get(sessionId);
    if (!row.ok) return row;
    const restored = ensureNativeSession(this.repository, this.agent, row.data);
    return ok(this.project(!restored.ok && restored.error.code === 'session_history_invalid'
      ? { ...row.data, historyState: 'invalid' } : row.data));
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
      if (!run.ok || run.data.kind !== 'agent' || run.data.sessionId !== request.sessionId) {
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

export function ensureNativeSession(repository: SessionRepository, agent: AgentPort, row: SessionRow): Result<void> {
  if (row.nativeUnusable) return fail(appError('agent_session_unusable', 'session', 'This conversation cannot continue after an interrupted request.'));
  try {
    if (agent.inspect(row.nativeSessionId).availability !== 'missing') return ok(undefined);
  } catch { return fail(appError('agent_session_unavailable', 'session', 'Conversation state is unavailable.')); }
  if (row.historyState !== 'recoverable' || !agent.restoreSession || !agent.watchSession) {
    return fail(appError(row.historyState === 'invalid' ? 'session_history_invalid' : 'session_history_unavailable',
      'session', 'This conversation cannot be restored. Start a new chat.'));
  }
  const history = repository.loadHistory(row.sessionId);
  if (!history.ok) return history;
  if (!history.data) return fail(appError('session_history_unavailable', 'session', 'This conversation has no saved native history.'));
  const restored = agent.restoreSession(row.nativeSessionId, history.data);
  if (!restored.ok) return restored;
  return agent.watchSession(row.nativeSessionId, (snapshot, context) => repository.saveHistory(row.sessionId, snapshot, context));
}

function deleteInProgress<T>(): Result<T> {
  return fail(appError('session_delete_in_progress', 'session', 'A Session deletion is already in progress.', true));
}

function failDeleteSession(): Result<DeleteSessionResult> {
  return { ok: false, error: { code: 'session_delete_incomplete', category: 'session', message: 'Session deletion is incomplete. Retry Delete Session to finish removing it.', retryable: true } };
}
