import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { appError, DesktopBridgeRequestSchema, fail, ok, parseDesktopBridgeResult, type DesktopBridgeRequest, type DesktopBridgeResult } from '@flowmate/contracts';

type Event = { kind: 'request'; id: string; request: DesktopBridgeRequest } | { kind: 'cancel'; id: string };
type Pending = { request: DesktopBridgeRequest; delivered: boolean; signal: AbortSignal; abort: () => void;
  resolve: (value: DesktopBridgeResult) => void };
const unavailable = () => fail(appError('desktop_unavailable', 'runtime', 'The original interactive desktop is unavailable.', true));
const validId = (value: string) => z.string().uuid().safeParse(value).success;

/** One authenticated desktop receives each cloud request at most once. */
export class CloudDesktopRelay {
  private connection: { id: string; lastSeen: number; wake?: () => void } | null = null;
  private readonly pending = new Map<string, Pending>();
  private readonly cancellations: string[] = [];
  private closed = false;

  attach(connectionId: string) {
    if (this.closed || !validId(connectionId)) return unavailable();
    if (this.connection && this.connection.id !== connectionId) {
      if (Date.now() - this.connection.lastSeen < 45_000) return unavailable();
      this.detach(this.connection.id);
    }
    this.connection ??= { id: connectionId, lastSeen: Date.now() };
    this.connection.lastSeen = Date.now();
    return ok({ connectionId });
  }

  request(raw: DesktopBridgeRequest, signal: AbortSignal): Promise<DesktopBridgeResult> {
    const parsed = DesktopBridgeRequestSchema.safeParse(raw), connection = this.connection;
    if (this.closed || !connection || Date.now() - connection.lastSeen >= 45_000 || signal.aborted || !parsed.success
      || parsed.data.kind === 'dispatch' && parsed.data.proposalId === undefined || this.pending.size >= 32) return Promise.resolve(unavailable());
    const request = structuredClone(parsed.data), id = randomUUID();
    return new Promise(resolve => {
      const abort = () => {
        const original = this.pending.get(id); if (!original) return;
        this.pending.delete(id); signal.removeEventListener('abort', abort);
        if (original.delivered) this.cancellations.push(id);
        resolve(unavailable()); this.connection?.wake?.();
      };
      this.pending.set(id, { request, delivered: false, signal, abort, resolve });
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort(); else connection.wake?.();
    });
  }

  async next(connectionId: string, signal: AbortSignal) {
    const connection = this.connection;
    if (this.closed || !connection || connection.id !== connectionId || signal.aborted || connection.wake) return unavailable();
    connection.lastSeen = Date.now();
    const take = (): Event | null => {
      const cancelled = this.cancellations.shift(); if (cancelled) return { kind: 'cancel', id: cancelled };
      for (const [id, value] of this.pending) if (!value.delivered) {
        value.delivered = true; return { kind: 'request', id, request: structuredClone(value.request) };
      }
      return null;
    };
    let event = take();
    if (!event) {
      await new Promise<void>(resolve => {
        const done = () => { clearTimeout(timer); if (connection.wake === done) delete connection.wake; signal.removeEventListener('abort', done); resolve(); };
        const timer = setTimeout(done, 15_000); connection.wake = done;
        signal.addEventListener('abort', done, { once: true }); if (signal.aborted) done();
      });
      if (this.closed || this.connection !== connection || signal.aborted) return unavailable();
      connection.lastSeen = Date.now(); event = take();
    }
    return ok({ connectionId, event });
  }

  reply(connectionId: string, id: string, raw: unknown) {
    const original = this.pending.get(id);
    if (this.closed || this.connection?.id !== connectionId || !original || !original.delivered) return unavailable();
    const result = parseDesktopBridgeResult(original.request, raw); if (!result) return unavailable();
    this.pending.delete(id); original.signal.removeEventListener('abort', original.abort); original.resolve(result);
    return ok({ connectionId });
  }

  detach(connectionId: string) {
    if (this.connection?.id !== connectionId) return unavailable();
    const original = this.connection; this.connection = null; original.wake?.();
    for (const value of this.pending.values()) { value.signal.removeEventListener('abort', value.abort); value.resolve(unavailable()); }
    this.pending.clear(); this.cancellations.length = 0;
    return ok({ connectionId });
  }

  close(): void { if (this.connection) this.detach(this.connection.id); this.closed = true; }
}
