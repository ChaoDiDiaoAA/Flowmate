import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { appError, CloudProgressEventSchema, CloudProgressFragmentSchema, CloudProgressRequestSchema, CloudRuntimeNoticeSchema, fail, ok,
  type CloudProgressRequest, type CloudRuntimeNotice } from '@flowmate/contracts';

type Fragment = z.infer<typeof CloudProgressFragmentSchema>;
type Session = { generation: string; sequence: number; notice: CloudRuntimeNotice | null;
  events: Array<{ sequence: number; fragment: Fragment | null }>; waiters: Set<() => void> };
const sourceSchema = z.object({ workId: z.number().int().positive().safe(), sessionId: z.number().int().positive().safe(),
  attemptId: z.number().int().positive().safe(), requestId: z.string().min(1).max(128), modelAttemptId: z.string().uuid() }).strict();
const unavailable = () => fail(appError('cloud_progress_unavailable', 'runtime', 'Cloud progress is unavailable.', true));

/** Temporary notices and text are bounded; clients recover saved facts from the authoritative snapshot. */
export class CloudProgressHub {
  private readonly sessions = new Map<string, Session>();
  private waiting = 0;
  private closed = false;
  constructor(private readonly waitMs = 55_000) {}
  private session(workId: number, sessionId: number): Session | null {
    const key = JSON.stringify([workId, sessionId]), existing = this.sessions.get(key);
    if (existing) { this.sessions.delete(key); this.sessions.set(key, existing); return existing; }
    if (this.sessions.size >= 256) {
      const removable = [...this.sessions].find(([, value]) => value.waiters.size === 0);
      if (!removable) return null; this.sessions.delete(removable[0]);
    }
    const created: Session = { generation: randomUUID(), sequence: 0, notice: null, events: [], waiters: new Set<() => void>() };
    this.sessions.set(key, created); return created;
  }
  private emit(session: Session, fragment: Fragment | null): void {
    if (session.sequence === Number.MAX_SAFE_INTEGER) { session.generation = randomUUID(); session.sequence = 0; session.events = []; }
    session.events.push({ sequence: ++session.sequence, fragment });
    if (session.events.length > 64) session.events.shift();
    for (const done of [...session.waiters]) done();
  }
  private reset(session: Session): void { session.generation = randomUUID(); session.sequence = 0; session.events = []; }
  publish(raw: CloudRuntimeNotice): void {
    const parsed = CloudRuntimeNoticeSchema.safeParse(raw); if (this.closed || !parsed.success) return;
    const notice = parsed.data, session = this.session(notice.workId, notice.sessionId); if (!session) return;
    if (session.notice?.runtimeGeneration === notice.runtimeGeneration && session.notice.observationRevision >= notice.observationRevision) return;
    if (session.notice && session.notice.runtimeGeneration !== notice.runtimeGeneration
      || !session.notice && session.events.some(event => event.fragment !== null)) this.reset(session);
    session.notice = notice; this.emit(session, null);
  }
  publishText(raw: z.infer<typeof sourceSchema>, text: string): void {
    const parsed = sourceSchema.safeParse(raw); if (this.closed || !parsed.success || !text) return;
    const { workId, sessionId, ...source } = parsed.data, session = this.session(workId, sessionId); if (!session) return;
    let part = '', size = 0;
    for (const character of text) {
      const length = Buffer.byteLength(character, 'utf8');
      if (size + length > 1024) { this.emit(session, CloudProgressFragmentSchema.parse({ ...source, text: part })); part = ''; size = 0; }
      part += character; size += length;
    }
    if (part) this.emit(session, CloudProgressFragmentSchema.parse({ ...source, text: part }));
  }
  discardText(raw: { workId: number; sessionId: number }): void {
    if (this.closed) return;
    const session = this.session(raw.workId, raw.sessionId); if (!session) return;
    this.reset(session);
    for (const done of [...session.waiters]) done();
  }
  async wait(raw: CloudProgressRequest, signal?: AbortSignal) {
    const parsed = CloudProgressRequestSchema.safeParse(raw); if (this.closed || !parsed.success || signal?.aborted) return unavailable();
    const input = parsed.data, session = this.session(input.workId, input.sessionId); if (!session) return unavailable();
    const response = () => {
      const cursor = input.cursor, changed = cursor !== null && (cursor.generation !== session.generation || cursor.sequence !== session.sequence);
      const resync = cursor === null || cursor.generation !== session.generation || cursor.sequence > session.sequence
        || cursor.sequence < session.sequence - session.events.length;
      const events = resync || !cursor ? [] : session.events.filter(value => value.sequence > cursor.sequence);
      return ok(CloudProgressEventSchema.parse({ workId: input.workId, sessionId: input.sessionId,
        cursor: { generation: session.generation, sequence: session.sequence }, changed, resync, snapshotChanged: events.some(value => value.fragment === null),
        fragments: events.flatMap(value => value.fragment ? [value.fragment] : []),
        runtimeGeneration: session.notice?.runtimeGeneration ?? null, observationRevision: session.notice?.observationRevision ?? null }));
    };
    if (!input.cursor || input.cursor.generation !== session.generation || input.cursor.sequence !== session.sequence) return response();
    if (this.waiting >= 32) return unavailable();
    this.waiting++;
    await new Promise<void>(resolve => {
      let timer: ReturnType<typeof setTimeout>;
      const done = () => { clearTimeout(timer); session.waiters.delete(done); signal?.removeEventListener('abort', done); resolve(); };
      timer = setTimeout(done, this.waitMs); session.waiters.add(done); signal?.addEventListener('abort', done, { once: true });
      if (signal?.aborted) done();
    });
    this.waiting--;
    return this.closed || signal?.aborted ? unavailable() : response();
  }
  close(): void { this.closed = true; for (const session of this.sessions.values()) for (const done of [...session.waiters]) done(); }
}
