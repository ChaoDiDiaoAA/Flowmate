import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { appError, BrowserReadViewSchema, CloudDesktopRelayEventSchema, DesktopActionViewSchema, fail, ok, parseCloudDesktopResult, parseDesktopBridgeResult,
  type BrowserReadView, type DesktopActionView, type DesktopBridgeRequest, type DesktopBridgeResult, type Result } from '@flowmate/contracts';

type Session = { request(command: unknown, timeoutMs?: number): Promise<Result<unknown>> };
type Options = { execute(request: DesktopBridgeRequest, signal: AbortSignal): Promise<DesktopBridgeResult>;
  verify(action: DesktopActionView, signal: AbortSignal): Promise<Result<void>>;
  verifyBrowser?(read: BrowserReadView, signal: AbortSignal): Promise<Result<void>>;
  onClosed?(): void };
const unavailable = () => fail(appError('desktop_unavailable', 'runtime', 'The original interactive desktop is unavailable.', true));
const key = (workId: number, itemId: number, proposalId: number) => `${workId}:${itemId}:${proposalId}`;

/** Cloud input remains gated by a matching approval on this desktop connection. */
export class CloudKimiBridge {
  private readonly connectionId = randomUUID();
  private readonly approvals = new Map<string, DesktopActionView>();
  private readonly browserApprovals = new Map<string, BrowserReadView>();
  private readonly browserPending = new Map<string, AbortController>();
  private readonly browserChecks = new Map<string, AbortController>();
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

  async approveBrowser(raw: BrowserReadView): Promise<Result<void>> {
    const parsed = BrowserReadViewSchema.safeParse(raw);
    if (!this.running || !this.options.verifyBrowser || !parsed.success || !parsed.data.canDecide || parsed.data.status !== 'waiting') return unavailable();
    const read = parsed.data, id = key(read.workId, read.itemId, read.proposalId);
    if (this.browserPending.has(id) || this.browserChecks.has(id)) return unavailable();
    const controller = new AbortController(); this.browserChecks.set(id, controller);
    try {
      const checked = await this.options.verifyBrowser(read, controller.signal);
      if (!checked.ok || !this.running || controller.signal.aborted) return checked.ok ? unavailable() : checked;
      this.browserApprovals.set(id, structuredClone(read)); return ok(undefined);
    } catch { return unavailable(); }
    finally { if (this.browserChecks.get(id) === controller) this.browserChecks.delete(id); }
  }

  revokeBrowser(workId: number, itemId: number, proposalId: number): void {
    const id = key(workId, itemId, proposalId); this.browserApprovals.delete(id);
    this.browserChecks.get(id)?.abort(); this.browserPending.get(id)?.abort();
  }

  revokeBrowserWork(workId: number, itemId?: number): void {
    const prefix = itemId === undefined ? `${workId}:` : `${workId}:${itemId}:`;
    for (const id of this.browserApprovals.keys()) if (id.startsWith(prefix)) this.browserApprovals.delete(id);
    for (const [id, check] of this.browserChecks) if (id.startsWith(prefix)) check.abort();
    for (const [id, pending] of this.browserPending) if (id.startsWith(prefix)) pending.abort();
  }

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
    this.running = false; this.approvals.clear(); this.browserApprovals.clear();
    for (const check of this.browserChecks.values()) check.abort();
    for (const pending of this.browserPending.values()) pending.abort();
    for (const pending of this.pending.values()) pending.abort();
    try { this.options.onClosed?.(); } catch { /* Disconnection has already revoked the bridge. */ }
  }

  private async execute(request: DesktopBridgeRequest, signal: AbortSignal): Promise<DesktopBridgeResult> {
    if (!this.running || signal.aborted || request.kind === 'form') return unavailable();
    if (request.kind === 'dispatch') {
      if (request.proposalId === undefined) return unavailable();
      const id = key(request.workId, request.itemId, request.proposalId), approval = this.approvals.get(id);
      if (!approval || !isDeepStrictEqual(approval.action, request.action) || !isDeepStrictEqual(approval.target, request.target)) return unavailable();
      this.approvals.delete(id);
    }
    if (request.kind === 'browser_read') {
      const id = key(request.workId, request.itemId, request.proposalId), approval = this.browserApprovals.get(id);
      if (!approval || !isDeepStrictEqual(approval.target, request.target) || this.browserPending.has(id)) return unavailable();
      this.browserApprovals.delete(id);
      const controller = new AbortController(); this.browserPending.set(id, controller);
      try {
        const result = await this.options.execute(request, AbortSignal.any([signal, controller.signal]));
        return !this.running || signal.aborted || controller.signal.aborted ? unavailable() : parseDesktopBridgeResult(request, result) ?? unavailable();
      } catch { return unavailable(); }
      finally { this.browserPending.delete(id); }
    }
    try { return parseDesktopBridgeResult(request, await this.options.execute(request, signal)) ?? unavailable(); }
    catch { return unavailable(); }
  }

  async close(): Promise<void> {
    this.running = false; this.approvals.clear(); this.browserApprovals.clear();
    for (const check of this.browserChecks.values()) check.abort();
    for (const pending of this.browserPending.values()) pending.abort();
    for (const pending of this.pending.values()) pending.abort();
    try { await this.session.request({ type: 'cloud_desktop_detach', input: { connectionId: this.connectionId } }, 2000); } catch { /* The cloud connection may already be gone. */ }
    await this.loop; await Promise.allSettled([...this.tasks]);
  }
}
