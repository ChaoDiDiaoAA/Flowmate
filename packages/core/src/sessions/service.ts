import { appError, fail, normalizeSessionInputRequest, ok, SessionMessagesPageSchema } from '@flowmate/contracts';
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
} from '@flowmate/contracts';
import type { SessionRepository, SessionRow, RunRepository } from '../storage/repositories.ts';
import type { SessionInputLedger } from './input-ledger.ts';

export class SessionService {
  private deleting = false;

  public constructor(
    private readonly repository: SessionRepository,
    private readonly agent: AgentPort,
    private readonly runtimeState: () => RuntimeState,
    private readonly now: () => string,
    private readonly runs: RunRepository,
    private readonly inputs?: SessionInputLedger,
    private readonly startInput?: (request: NormalizedAgentRunRequest, submission: NormalizedSessionInputRequest, control?: AgentControl) => Promise<Result<RunAccepted>>,
  ) {}

  public submitInput(raw: SessionInputRequest, control?: AgentControl): Promise<Result<RunAccepted>> {
    const normalized = normalizeSessionInputRequest(raw);
    if (!normalized.ok) return Promise.resolve(normalized);
    if (!this.inputs || !this.startInput) return Promise.resolve(fail(appError('session_input_unavailable', 'session', 'Session input is unavailable.')));
    const { clientSequence: _clientSequence, mode: _mode, formTarget: _target, ...request } = normalized.data;
    return this.startInput(request, normalized.data, control);
  }

  public queryInput(request: SessionInputQuery): Result<SessionInputQueryResult> {
    return this.inputs?.query(request) ?? fail(appError('session_input_unavailable', 'session', 'Session input is unavailable.'));
  }

  public async create(request: CreateSessionRequest): Promise<Result<SessionSnapshot>> {
    if (this.deleting) return deleteInProgress();
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
    if (this.deleting) return deleteInProgress();
    const row = this.repository.rename({ sessionId: request.sessionId, title: request.title, at: this.now() });
    return row.ok ? ok(this.project(row.data)) : row;
  }

  public async deleteSession(sessionId: DbId): Promise<Result<DeleteSessionResult>> {
    if (this.deleting) return deleteInProgress();
    this.deleting = true;
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
      this.deleting = false;
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
      runInputs.push({ runId, input: run.data.input, goalMode,
        ...(typeof config.workingDirectory === 'string' ? { workingDirectory: config.workingDirectory } : {}) });
    }
    const projected = this.agent.projectSessionMessages({ history: stored.data.history, bindings: stored.data.bindings,
      runInputs, limit: request.limit, ...(request.beforeEntryId === undefined ? {} : { beforeEntryId: request.beforeEntryId }) });
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
