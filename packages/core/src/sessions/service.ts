import { appError, fail, ok } from '@flowmate/contracts';
import type { AgentPort, CreateSessionRequest, DbId, ListSessionsRequest, Result, SessionAvailability, SessionPage, SessionRunsPage, SessionRunsRequest, SessionSnapshot } from '@flowmate/contracts';
import { normalizeCreateSessionRequest, normalizeListSessionsRequest } from '@flowmate/contracts';
import type { RunRepository, SessionRecord, SessionRepository } from '../storage/repositories.ts';

export class SessionService {
  private readonly sessions: SessionRepository;
  private readonly runs: RunRepository;
  private readonly agent: AgentPort;
  private readonly active: () => { runId: DbId; sessionId: DbId | null } | null;

  public constructor(input: { sessions: SessionRepository; runs: RunRepository; agent: AgentPort; active: () => { runId: DbId; sessionId: DbId | null } | null }) {
    this.sessions = input.sessions;
    this.runs = input.runs;
    this.agent = input.agent;
    this.active = input.active;
  }

  public create(raw: CreateSessionRequest): Result<SessionSnapshot> {
    const normalized = normalizeCreateSessionRequest(raw);
    if (!normalized.ok) return normalized;
    const createdNative = this.agent.createSession();
    if (!createdNative.ok) return createdNative;
    const stored = this.sessions.create({ nativeSessionId: createdNative.data.nativeSessionId, title: normalized.data.title, createdAt: new Date().toISOString() });
    if (!stored.ok) {
      void this.agent.releaseSession(createdNative.data.nativeSessionId);
      return stored;
    }
    return ok(this.project(stored.data));
  }

  public list(raw?: ListSessionsRequest): Result<SessionPage> {
    const normalized = normalizeListSessionsRequest(raw);
    if (!normalized.ok) return normalized;
    const result = this.sessions.list(normalized.data);
    return result.ok ? ok({ items: result.data.items.map((item) => this.project(item)), next: result.data.next }) : result;
  }

  public query(sessionId: DbId): Result<SessionSnapshot> {
    if (!Number.isSafeInteger(sessionId) || sessionId <= 0) return fail(appError('session_id_invalid', 'input', 'Session ID 无效。'));
    const result = this.sessions.get(sessionId);
    return result.ok ? ok(this.project(result.data)) : result;
  }

  public resolve(sessionId: DbId): Result<SessionRecord> {
    const result = this.sessions.get(sessionId);
    if (!result.ok) return result;
    if (result.data.status !== 'active') return fail(appError('session_archived', 'session', 'Archived Session 不能继续执行。'));
    const availability = this.agent.inspect(result.data.nativeSessionId).availability;
    if (availability === 'missing') return fail(appError('session_history_unavailable', 'session', 'Session 原生历史在当前进程中不可用。'));
    if (availability === 'unusable') return fail(appError('session_unusable', 'session', 'Session 尚未确认停止，不能复用。'));
    if (availability === 'busy') return fail(appError('session_busy', 'session', '该 Session 已有 Run 正在执行。'));
    return result;
  }

  public listRuns(raw: SessionRunsRequest): Result<SessionRunsPage> {
    const session = this.sessions.get(raw.sessionId);
    if (!session.ok) return session;
    const limit = raw.limit ?? 50;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100
      || (raw.beforeRunId !== undefined && (!Number.isSafeInteger(raw.beforeRunId) || raw.beforeRunId <= 0))) {
      return fail(appError('session_runs_query_invalid', 'input', 'Session Run 查询参数无效。'));
    }
    return this.runs.listBySession({ sessionId: raw.sessionId, ...(raw.beforeRunId === undefined ? {} : { beforeRunId: raw.beforeRunId }), limit });
  }

  private project(record: SessionRecord): SessionSnapshot {
    const active = this.active();
    const observed = record.status === 'archived' ? 'archived' : this.agent.inspect(record.nativeSessionId).availability;
    const availability: SessionAvailability = observed === 'missing' ? 'history-unavailable' : observed;
    const activeRunId = active && active.sessionId === record.id ? active.runId : null;
    return {
      sessionId: record.id,
      nativeSessionId: record.nativeSessionId,
      title: record.title,
      status: record.status,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      availability: activeRunId !== null && availability === 'ready' ? 'busy' : availability,
      activeRunId,
    };
  }
}
