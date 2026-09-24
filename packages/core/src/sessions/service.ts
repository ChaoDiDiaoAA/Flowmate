import { ok } from '@flowmate/contracts';
import type {
  AgentPort,
  CreateSessionRequest,
  DbId,
  NormalizedListSessionsRequest,
  Result,
  RuntimeState,
  SessionAvailability,
  SessionPage,
  SessionSnapshot,
} from '@flowmate/contracts';
import type { SessionRepository, SessionRow } from '../storage/repositories.ts';

export class SessionService {
  public constructor(
    private readonly repository: SessionRepository,
    private readonly agent: AgentPort,
    private readonly runtimeState: () => RuntimeState,
    private readonly now: () => string,
  ) {}

  public async create(request: CreateSessionRequest): Promise<Result<SessionSnapshot>> {
    const native = this.agent.createSession();
    if (!native.ok) return native;
    const row = this.repository.create({ nativeSessionId: native.data.nativeSessionId, title: request.title ?? 'New Session', at: this.now() });
    if (!row.ok) {
      try { await this.agent.releaseSession(native.data.nativeSessionId); } catch { /* preserve the failed DB insert */ }
      return row;
    }
    return ok(this.project(row.data));
  }

  public get(sessionId: DbId) {
    const row = this.repository.get(sessionId);
    return row.ok ? ok(this.project(row.data)) : row;
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
    let boundModel: SessionSnapshot['boundModel'] = null;
    if (row.status === 'archived') availability = 'archived';
    else {
      try {
        const inspected = this.agent.inspect(row.nativeSessionId);
        availability = activeRunId !== null || inspected.availability === 'busy' ? 'busy'
          : inspected.availability === 'ready' ? 'ready'
            : inspected.availability === 'unusable' ? 'unusable' : 'history-unavailable';
        boundModel = inspected.boundModel;
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
      activeRunId,
      boundModel,
    };
  }
}
