import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { appError, CloudDesktopRelayEventSchema, DesktopActionViewSchema, fail, ok, parseCloudDesktopResult, parseDesktopBridgeResult,
  type DesktopActionView, type DesktopBridgeRequest, type DesktopBridgeResult, type Result } from '@flowmate/contracts';

type Session = { request(command: unknown, timeoutMs?: number): Promise<Result<unknown>> };
type Options = { execute(request: DesktopBridgeRequest, signal: AbortSignal): Promise<DesktopBridgeResult>;
  verify(action: DesktopActionView, signal: AbortSignal): Promise<Result<void>> };
const unavailable = () => fail(appError('desktop_unavailable', 'runtime', 'The original interactive desktop is unavailable.', true));
const key = (workId: number, itemId: number, proposalId: number) => `${workId}:${itemId}:${proposalId}`;

/** Cloud input remains gated by a matching approval on this desktop connection. */
export class CloudKimiBridge {
  private readonly connectionId = randomUUID();
  private readonly approvals = new Map<string, DesktopActionView>();
  private readonly pending = new Map<string, AbortController>();
  private readonly tasks = new Set<Promise<void>>();
  private running = false;
  private loop: Promise<void> | null = null;
  constructor(private readonly session: Session, readonly workspaceId: string, private readonly options: Options) {}
  isReady(): boolean { return this.running; }

  async start(): Promise<Result<void>> {
    if (this.running || this.loop) return unavailable();
    const command = { type: 'cloud_desktop_attach' as const, input: { connectionId: this.connectionId } };
    const result = parseCloudDesktopResult(command, await this.session.request(command));
    if (!result?.ok) return unavailable();
    this.running = true; this.loop = this.pump(); return ok(undefined);
  }

  async approve(raw: DesktopActionView): Promise<Result<void>> {
    const parsed = DesktopActionViewSchema.safeParse(raw);
    if (!this.running || !parsed.success || !parsed.data.canDecide || parsed.data.status !== 'waiting') return unavailable();
    const action = parsed.data, checked = await this.options.verify(action, new AbortController().signal);
    if (!checked.ok || !this.running) return checked.ok ? unavailable() : checked;
    this.approvals.set(key(action.workId, action.itemId, action.proposalId), structuredClone(action));
    return ok(undefined);
  }

  revoke(workId: number, itemId: number, proposalId: number): void { this.approvals.delete(key(workId, itemId, proposalId)); }

  private async pump(): Promise<void> {
    try {
      while (this.running) {
        const command = { type: 'cloud_desktop_next' as const, input: { connectionId: this.connectionId } };
        const result = parseCloudDesktopResult(command, await this.session.request(command, 20_000));
        if (!this.running) break;
        const event = result?.ok ? z.object({ connectionId: z.string().uuid(), event: CloudDesktopRelayEventSchema.nullable() }).strict().safeParse(result.data) : null;
        if (!event?.success) break;
        if (!event.data.event) continue;
        if (event.data.event.kind === 'cancel') { this.pending.get(event.data.event.id)?.abort(); continue; }
        const { id, request } = event.data.event, controller = new AbortController();
        this.pending.set(id, controller);
        let task: Promise<void>;
        task = this.execute(request, controller.signal).then(async value => {
          if (!this.running || controller.signal.aborted) return;
          const reply = { type: 'cloud_desktop_reply' as const, input: { connectionId: this.connectionId, id, result: value } };
          await this.session.request(reply, 5000);
        }).catch(() => {}).finally(() => { this.pending.delete(id); this.tasks.delete(task); });
        this.tasks.add(task);
      }
    } catch { /* The original cloud connection is unavailable. */ }
    this.running = false; this.approvals.clear(); for (const pending of this.pending.values()) pending.abort();
  }

  private async execute(request: DesktopBridgeRequest, signal: AbortSignal): Promise<DesktopBridgeResult> {
    if (!this.running || signal.aborted || request.kind === 'form') return unavailable();
    if (request.kind === 'dispatch') {
      if (request.proposalId === undefined) return unavailable();
      const id = key(request.workId, request.itemId, request.proposalId), approval = this.approvals.get(id);
      if (!approval || !isDeepStrictEqual(approval.action, request.action) || !isDeepStrictEqual(approval.target, request.target)) return unavailable();
      this.approvals.delete(id);
    }
    try { return parseDesktopBridgeResult(request, await this.options.execute(request, signal)) ?? unavailable(); }
    catch { return unavailable(); }
  }

  async close(): Promise<void> {
    this.running = false; this.approvals.clear(); for (const pending of this.pending.values()) pending.abort();
    try { await this.session.request({ type: 'cloud_desktop_detach', input: { connectionId: this.connectionId } }, 2000); } catch { /* The cloud connection may already be gone. */ }
    await this.loop; await Promise.allSettled([...this.tasks]);
  }
}
