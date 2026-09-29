import { appError, fail, ok } from '@flowmate/contracts';
import type {
  AgentPort,
  CreateSessionRequest,
  DbId,
  NormalizedListSessionsRequest,
  Result,
  RenameSessionRequest,
  RuntimeState,
  SessionAvailability,
  SessionPage,
  SessionSnapshot,
} from '@flowmate/contracts';
import type { SessionRepository, SessionRow } from '../storage/repositories.ts';

export class SessionService {
  private deleting = false;

  public constructor(
    private readonly repository: SessionRepository,
    private readonly agent: AgentPort,
    private readonly runtimeState: () => RuntimeState,
    private readonly now: () => string,
  ) {}

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
      (snapshot) => this.repository.saveHistory(row.data.sessionId, snapshot));
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

  public async deleteSession(sessionId: DbId): Promise<Result<{ deletedSessionId: DbId }>> {
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
      return deleted.ok ? ok({ deletedSessionId: sessionId }) : failDeleteSession();
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
  return agent.watchSession(row.nativeSessionId, (snapshot) => repository.saveHistory(row.sessionId, snapshot));
}

function deleteInProgress<T>(): Result<T> {
  return fail(appError('session_delete_in_progress', 'session', 'A Session deletion is already in progress.', true));
}

function failDeleteSession(): Result<{ deletedSessionId: DbId }> {
  return { ok: false, error: { code: 'session_delete_incomplete', category: 'session', message: 'Session deletion is incomplete. Retry Delete Session to finish removing it.', retryable: true } };
}
