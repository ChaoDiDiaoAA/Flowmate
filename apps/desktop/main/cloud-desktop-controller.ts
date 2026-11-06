import { isDeepStrictEqual } from 'node:util';
import { appError, CloudDesktopConnectionSchema, CloudDesktopRequestSchema, CloudDesktopUploadResourceSchema, CloudDesktopUploadSchema, CloudDesktopWorkspaceSchema,
  CloudMaterialReceiptSchema, CloudResourceReceiptSchema, cloudDesktopFailure, fail, ok, parseCloudDesktopResult, type CloudDesktopTarget,
  type CloudMaterialReceipt, type CloudResourceReceipt, type DocumentRef, type ResourceRef, type Result } from '@flowmate/contracts';
import type { CloudSshSession } from './cloud-ssh-session.ts';
import { CloudKimiBridge } from './cloud-kimi-bridge.ts';
import type { BrowserReadView, DesktopActionView, DesktopBridgeRequest, DesktopBridgeResult } from '@flowmate/contracts';

type Session = Pick<CloudSshSession, 'request' | 'close'>;
type Options = { connect(target: CloudDesktopTarget, workspaceId: string): Promise<Result<Session>>;
  onDisconnected?(workspaceId: string): void;
  upload(input: { workspaceId: string; documentRef: DocumentRef }, session: Session): Promise<Result<CloudMaterialReceipt>>;
  uploadResource?(input: { workspaceId: string; ref: ResourceRef }, session: Session): Promise<Result<CloudResourceReceipt>>;
  desktop?: { execute(workspaceId: string, request: DesktopBridgeRequest, signal: AbortSignal): Promise<DesktopBridgeResult>;
    verify(workspaceId: string, action: DesktopActionView, signal: AbortSignal): Promise<Result<void>>;
    verifyBrowser?(workspaceId: string, read: BrowserReadView, signal: AbortSignal): Promise<Result<void>> } };
const invalid = () => fail(appError('input_invalid', 'input', 'The cloud workspace request is invalid.'));
const unavailable = () => fail(appError('cloud_workspace_unavailable', 'runtime', 'The selected cloud workspace is not connected.', true));
const unknownUpload = () => fail(appError('operation_result_unknown', 'runtime', 'The original material upload result is unknown.', true));

/** Owns only a desktop transport; closing it never stops the cloud Work. */
export class CloudDesktopController {
  private current: { workspaceId: string; session: Session; desktop?: CloudKimiBridge } | null = null;
  private connecting: Promise<Result<{ workspaceId: string }>> | null = null;
  private disconnecting: Promise<Result<void>> | null = null;
  private shutdownConnection: Result<void> | null = null;
  private stopped = false;
  constructor(private readonly options: Options) {}

  async state(): Promise<Result<{ workspaceId: string | null; desktopReady?: boolean }>> {
    if (this.shutdownConnection && !this.shutdownConnection.ok) return this.shutdownConnection;
    return ok({ workspaceId: this.current?.workspaceId ?? null,
      ...(this.current && this.options.desktop ? { desktopReady: this.current.desktop?.isReady() === true } : {}) });
  }

  connect(raw: unknown): Promise<Result<{ workspaceId: string }>> {
    const parsed = CloudDesktopConnectionSchema.safeParse(raw); if (!parsed.success) return Promise.resolve(invalid());
    if (this.stopped || this.current || this.connecting || this.disconnecting || this.shutdownConnection && !this.shutdownConnection.ok)
      return Promise.resolve(unavailable());
    const input = structuredClone(parsed.data);
    const pending = (async (): Promise<Result<{ workspaceId: string }>> => {
      let result: Result<Session>;
      try { result = await this.options.connect(input.target, input.workspaceId); } catch { return unavailable(); }
      if (!result.ok) return result;
      if (this.stopped) {
        this.shutdownConnection = await result.data.close().catch(() => unavailable());
        return unavailable();
      }
      let desktop = this.options.desktop ? new CloudKimiBridge(result.data, input.workspaceId, {
        execute: (request, signal) => this.options.desktop!.execute(input.workspaceId, request, signal),
        verify: (action, signal) => this.options.desktop!.verify(input.workspaceId, action, signal),
        ...(this.options.desktop.verifyBrowser ? { verifyBrowser: (read: BrowserReadView, signal: AbortSignal) => this.options.desktop!.verifyBrowser!(input.workspaceId, read, signal) } : {}),
        onClosed: () => this.options.onDisconnected?.(input.workspaceId),
      }) : undefined;
      if (desktop) {
        const started = await desktop.start().catch(() => unavailable());
        if (!started.ok) { await desktop.close(); desktop = undefined; }
        if (this.stopped) {
          await desktop?.close(); this.shutdownConnection = await result.data.close().catch(() => unavailable()); return unavailable();
        }
      }
      this.current = { workspaceId: input.workspaceId, session: result.data, ...(desktop ? { desktop } : {}) };
      return ok({ workspaceId: input.workspaceId });
    })().finally(() => { if (this.connecting === pending) this.connecting = null; });
    this.connecting = pending; return pending;
  }

  disconnect(raw: unknown): Promise<Result<void>> {
    const parsed = CloudDesktopWorkspaceSchema.safeParse(raw); if (!parsed.success) return Promise.resolve(invalid());
    const current = this.current;
    if (!current || current.workspaceId !== parsed.data.workspaceId || this.disconnecting) return Promise.resolve(unavailable());
    this.current = null;
    const pending = Promise.resolve().then(async () => { await current.desktop?.close(); return current.session.close(); }).catch(() => unavailable()).then(result => {
      if (!result.ok) this.shutdownConnection = result;
      return result;
    })
      .finally(() => { if (this.disconnecting === pending) this.disconnecting = null; });
    this.disconnecting = pending; return pending;
  }

  async request(raw: unknown): Promise<Result<unknown>> {
    const parsed = CloudDesktopRequestSchema.safeParse(raw); if (!parsed.success) return invalid();
    const input = structuredClone(parsed.data), current = this.current;
    if (!current || current.workspaceId !== input.workspaceId) return unavailable();
    try {
      if (input.command.type === 'invoice_work_cancel' || input.command.type === 'personal_task_stop')
        current.desktop?.revokeBrowserWork(input.command.input.workId);
      if (input.command.type === 'invoice_work_dispose_item')
        current.desktop?.revokeBrowserWork(input.command.input.workId, input.command.input.itemId);
      if (input.command.type === 'invoice_work_browser_decide' && input.command.input.decision === 'approve') {
        if (!current.desktop) return unavailable();
        const original = input.command.input;
        const query = { type: 'invoice_work_browser_list' as const, input: { workId: original.workId, itemId: original.itemId,
          ...(original.proposalId > 1 ? { afterProposalId: original.proposalId - 1 } : {}), limit: 1 } };
        const listed = parseCloudDesktopResult(query, await current.session.request(query));
        if (!listed?.ok || this.current !== current || !listed.data || typeof listed.data !== 'object' || !('items' in listed.data)
          || !Array.isArray(listed.data.items)) return unavailable();
        const read = listed.data.items[0] as BrowserReadView | undefined;
        if (!read || read.proposalId !== original.proposalId || read.workId !== original.workId || read.itemId !== original.itemId
          || !original.confirmedTarget || !isDeepStrictEqual(read.target, original.confirmedTarget)) return unavailable();
        const approved = await current.desktop.approveBrowser(read); if (!approved.ok || this.current !== current) return approved.ok ? unavailable() : approved;
      }
      if (input.command.type === 'invoice_work_browser_decide' && input.command.input.decision === 'reject'
        || input.command.type === 'invoice_work_browser_revoke')
        current.desktop?.revokeBrowser(input.command.input.workId, input.command.input.itemId, input.command.input.proposalId);
      if (input.command.type === 'invoice_work_desktop_decide' && input.command.input.decision === 'approve') {
        if (!current.desktop) return unavailable();
        const original = input.command.input;
        const query = { type: 'invoice_work_desktop_list' as const, input: { workId: original.workId, itemId: original.itemId,
          ...(original.proposalId > 1 ? { afterProposalId: original.proposalId - 1 } : {}), limit: 1 } };
        const listed = parseCloudDesktopResult(query, await current.session.request(query));
        if (!listed?.ok || this.current !== current || !listed.data || typeof listed.data !== 'object' || !('items' in listed.data)
          || !Array.isArray(listed.data.items)) return unavailable();
        const action = listed.data.items[0] as DesktopActionView | undefined;
        if (!action || action.proposalId !== original.proposalId || action.workId !== original.workId || action.itemId !== original.itemId) return unavailable();
        if (!original.confirmedAction || !original.confirmedTarget || !isDeepStrictEqual(action.action, original.confirmedAction)
          || !isDeepStrictEqual(action.target, original.confirmedTarget))
          return fail(appError('state_conflict', 'input', 'The displayed desktop action changed; observe and confirm it again.'));
        const approved = await current.desktop.approve(action); if (!approved.ok || this.current !== current) return approved.ok ? unavailable() : approved;
      }
      if (input.command.type === 'invoice_work_desktop_decide' && input.command.input.decision === 'reject'
        || input.command.type === 'invoice_work_desktop_discard')
        current.desktop?.revoke(input.command.input.workId, input.command.input.itemId, input.command.input.proposalId);
      const result = await current.session.request(input.command, input.command.type === 'cloud_progress_wait' ? 90_000 : undefined);
      const checked = this.current === current ? parseCloudDesktopResult(input.command, result) ?? cloudDesktopFailure(input.command)
        : cloudDesktopFailure(input.command);
      if (!checked.ok && checked.error.code !== 'operation_result_unknown' && input.command.type === 'invoice_work_desktop_decide'
        && input.command.input.decision === 'approve') current.desktop?.revoke(input.command.input.workId, input.command.input.itemId, input.command.input.proposalId);
      if (!checked.ok && checked.error.code !== 'operation_result_unknown' && input.command.type === 'invoice_work_browser_decide'
        && input.command.input.decision === 'approve') current.desktop?.revokeBrowser(input.command.input.workId, input.command.input.itemId, input.command.input.proposalId);
      return checked;
    } catch { return cloudDesktopFailure(input.command); }
  }

  async upload(raw: unknown): Promise<Result<CloudMaterialReceipt>> {
    const parsed = CloudDesktopUploadSchema.safeParse(raw); if (!parsed.success) return invalid();
    const input = structuredClone(parsed.data), current = this.current;
    if (!current || current.workspaceId !== input.workspaceId) return unavailable();
    try {
      const result = await this.options.upload(input, current.session);
      if (this.current !== current) return unknownUpload();
      if (!result.ok) return result;
      const checked = CloudMaterialReceiptSchema.safeParse(result.data);
      return checked.success && checked.data.workspaceId === input.workspaceId && checked.data.sourceDocumentRef.id === input.documentRef.id
        && checked.data.sourceDocumentRef.version === input.documentRef.version ? ok(checked.data) : unknownUpload();
    } catch { return unknownUpload(); }
  }
  async uploadResource(raw: unknown): Promise<Result<CloudResourceReceipt>> {
    const parsed = CloudDesktopUploadResourceSchema.safeParse(raw); if (!parsed.success) return invalid();
    const input = structuredClone(parsed.data), current = this.current;
    if (!current || current.workspaceId !== input.workspaceId || !this.options.uploadResource) return unavailable();
    const unknown = () => fail(appError('operation_result_unknown', 'runtime', 'The original resource upload result is unknown.', true));
    try {
      const result = await this.options.uploadResource(input, current.session);
      if (this.current !== current) return unknown();
      if (!result.ok) return result;
      const checked = CloudResourceReceiptSchema.safeParse(result.data);
      return checked.success && checked.data.workspaceId === input.workspaceId && checked.data.ref.kind === input.ref.kind
        && checked.data.ref.id === input.ref.id && checked.data.ref.version === input.ref.version ? ok(checked.data) : unknown();
    } catch { return unknown(); }
  }

  async close(): Promise<Result<void>> {
    this.stopped = true;
    if (this.connecting) await this.connecting;
    if (this.shutdownConnection) return this.shutdownConnection;
    if (this.current) return this.disconnect({ workspaceId: this.current.workspaceId });
    return this.disconnecting ? await this.disconnecting : ok(undefined);
  }
}
