import { isDeepStrictEqual } from 'node:util';
import type { Wake } from '@earendil-works/pi-durable';
import { appError, fail, ok, type AppError, type CloudRuntimeBinding, type Result } from '@flowmate/contracts';
import type { CloudRuntimeSession, CloudRuntimeWake } from './cloud-runtime-storage.ts';

type Lane = { binding: CloudRuntimeBinding; session: CloudRuntimeSession; revision: number | null; wake: CloudRuntimeWake | null;
  ready: Promise<Result<void>>; writes: Promise<void>; firing: boolean; initializing: boolean; pendingWake?: Wake; error?: AppError };
const unavailable = () => fail(appError('cloud_wake_unavailable', 'runtime', 'The original cloud wake could not be confirmed.', true));

/** One timer covers the next saved wake across Sessions; each due attempt is reauthorized by its caller. */
export class CloudWakeScheduler {
  private readonly lanes = new Map<string, Lane>();
  private readonly running = new Set<Promise<void>>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private closing: Promise<Result<void>> | undefined;

  constructor(private readonly resume: (binding: CloudRuntimeBinding, attemptId: number) => Promise<Result<void>>) {}

  register(binding: CloudRuntimeBinding, session: CloudRuntimeSession): Promise<Result<void>> {
    if (this.closing) return Promise.resolve(unavailable());
    const original = this.lanes.get(binding.cloudRuntimeId);
    if (original) return original.session === session && isDeepStrictEqual(original.binding, binding) ? original.ready : Promise.resolve(unavailable());
    const lane: Lane = { binding: structuredClone(binding), session, revision: null, wake: null,
      ready: Promise.resolve(ok(undefined)), writes: Promise.resolve(), firing: false, initializing: true };
    this.lanes.set(binding.cloudRuntimeId, lane);
    lane.ready = (async () => {
      const saved = await session.readWake();
      if (!saved.ok) { lane.error = saved.error; return saved; }
      lane.wake = saved.data; lane.revision = saved.data?.revision ?? null; lane.initializing = false;
      const pending = lane.pendingWake; lane.pendingWake = undefined;
      if (pending && lane.revision !== null) {
        this.observe(binding, pending); await lane.writes;
        if (lane.error) return fail(lane.error);
      }
      this.schedule(); return ok(undefined);
    })().catch(unavailable);
    return lane.ready;
  }

  async arm(binding: CloudRuntimeBinding, session: CloudRuntimeSession, input: { attemptId: number; requestId?: string }): Promise<Result<void>> {
    const ready = await this.register(binding, session); if (!ready.ok) return ready;
    const lane = this.lanes.get(binding.cloudRuntimeId)!;
    const operation = lane.writes.then(async () => {
      if (this.closing) return unavailable();
      const saved = await session.armWake(input); if (!saved.ok) { lane.error = saved.error; return saved; }
      lane.revision = saved.data;
      const wake = await session.readWake(); if (!wake.ok) { lane.error = wake.error; return wake; }
      lane.error = undefined; lane.wake = wake.data; this.schedule(); return ok(undefined);
    }).catch(() => { const error = appError('cloud_wake_unavailable', 'runtime', 'The original cloud wake could not be confirmed.', true);
      lane.error = error; return fail(error); });
    lane.writes = operation.then(() => undefined);
    return operation;
  }

  observe(binding: CloudRuntimeBinding, wake: Wake): void {
    const lane = this.lanes.get(binding.cloudRuntimeId), revision = lane?.revision;
    if (this.closing || !lane || !isDeepStrictEqual(lane.binding, binding)) return;
    if (lane.initializing) { lane.pendingWake = { active: wake.active, ...(wake.at === undefined ? {} : { at: wake.at }) }; return; }
    if (revision === null || revision === undefined) return;
    const captured = { revision, active: wake.active, ...(wake.at === undefined ? {} : { at: wake.at }) };
    lane.writes = lane.writes.then(async () => {
      const saved = await lane.session.recordWake(captured);
      if (!saved.ok) { lane.error = saved.error; return; }
      if (saved.data) {
        const latest = await lane.session.readWake();
        if (!latest.ok) { lane.error = latest.error; return; }
        lane.wake = latest.data; this.schedule();
      }
    }).catch(() => { lane.error = appError('cloud_wake_unavailable', 'runtime', 'The native wake could not be confirmed.', true); });
  }

  private schedule(): void {
    if (this.closing) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    const due = [...this.lanes.values()].flatMap(lane => !lane.firing && !lane.error && lane.wake?.at !== null
      && lane.wake?.at !== undefined && !lane.wake.blocked ? [lane.wake.at] : []);
    if (due.length) this.timer = setTimeout(() => { this.timer = undefined; this.fire(); },
      Math.max(0, Math.min(2_147_483_647, Math.min(...due) - Date.now())));
  }

  private fire(): void {
    if (this.closing) return;
    const now = Date.now();
    for (const lane of this.lanes.values()) {
      const original = lane.wake;
      if (lane.firing || lane.error || !original || original.blocked || original.at === null || original.at > now) continue;
      lane.firing = true;
      const operation = (async () => {
        let result: Result<void>;
        try { result = await this.resume(structuredClone(lane.binding), original.attemptId); } catch { result = unavailable(); }
        if (this.closing) return;
        const retry = !result.ok && (result.error.retryable || result.error.code === 'provider_model_configuration_unavailable');
        const saved = await lane.session.finishWake({ revision: original.revision, at: original.at!,
          nextAt: retry ? Math.max(Date.now() + 1000, original.at! + 1) : null, blocked: !result.ok && !retry });
        if (!saved.ok) { lane.error = saved.error; return; }
        const current = await lane.session.readWake();
        if (!current.ok) { lane.error = current.error; return; }
        lane.wake = current.data; lane.revision = current.data?.revision ?? null;
      })().catch(() => { lane.error = appError('cloud_wake_unavailable', 'runtime', 'The original wake could not be completed.', true); })
        .finally(() => { lane.firing = false; this.running.delete(operation); this.schedule(); });
      this.running.add(operation);
    }
    this.schedule();
  }

  close(): Promise<Result<void>> {
    this.closing ??= (async () => {
      if (this.timer) clearTimeout(this.timer);
      await Promise.allSettled([...this.lanes.values()].map(async lane => { await lane.ready; await lane.writes; }));
      await Promise.allSettled([...this.running]);
      return ok(undefined);
    })(); return this.closing;
  }
}
