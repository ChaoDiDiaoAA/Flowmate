import { compact as sdkCompact, VERSION, type AgentSession, type AgentSessionEvent, type CompactionResult } from '@earendil-works/pi-coding-agent';
import { appError, fail, ok } from '@flowmate/contracts';
import type { CompactionReason, Result } from '@flowmate/contracts';

export type NativeSummaryScope = Readonly<{
  reason: CompactionReason;
  preparation: Parameters<typeof sdkCompact>[0];
  signal: AbortSignal;
}>;
type Hooks = {
  withSummary<T>(scope: NativeSummaryScope, run: () => Promise<T>): Promise<T>;
  onGenerated(result: CompactionResult): void;
  onAppend(entryId: string): void;
  beforeAuto?(input: { reason: 'threshold' | 'overflow'; willRetry: boolean }): Result<void>;
  afterAuto(input: { reason: 'threshold' | 'overflow'; willRetry: boolean; sdkWantsContinue: boolean }): Result<void>;
  onEvent(event: AgentSessionEvent): void;
};
type NativeDefault = (
  preparation: Parameters<typeof sdkCompact>[0], model: Parameters<typeof sdkCompact>[1],
  apiKey: Parameters<typeof sdkCompact>[2], headers: Parameters<typeof sdkCompact>[3],
  instructions: Parameters<typeof sdkCompact>[4], signal: AbortSignal,
  env: Parameters<typeof sdkCompact>[8], reason: CompactionReason,
) => Promise<CompactionResult>;
type NativeAuto = (reason: 'threshold' | 'overflow', willRetry: boolean) => Promise<boolean>;
const installed = new WeakSet<AgentSession>();

/** Locked Pi 0.85.1 compatibility seam; real signature and behavior are exercised before enabling auto. */
export function installNativeCompactionBridge(session: AgentSession, hooks: Hooks): Result<{ dispose(): void }> {
  // Private access is confined to this checked seam; preparation types come from the public root API.
  const native = session as unknown as { _runDefaultCompaction: NativeDefault; _runAutoCompaction: NativeAuto };
  const manager = session.sessionManager;
  if (VERSION !== '0.85.1' || installed.has(session)
    || typeof native._runDefaultCompaction !== 'function' || native._runDefaultCompaction.length !== 8
    || typeof native._runAutoCompaction !== 'function' || native._runAutoCompaction.length !== 2
    || typeof manager.appendCompaction !== 'function')
    return fail(appError('compaction_unavailable', 'runtime', 'The fixed native compaction interface is incompatible.'));
  const originalDefault = native._runDefaultCompaction, originalAuto = native._runAutoCompaction;
  const originalAppend = manager.appendCompaction;
  const wrappedDefault: NativeDefault = function(preparation, model, apiKey, headers, instructions, signal, env, reason) {
    return hooks.withSummary({ reason, preparation, signal }, async () => {
      const result = await originalDefault.call(session, preparation, model, apiKey, headers, instructions, signal, env, reason);
      hooks.onGenerated(result); // Necessary verification runs before SDK append, with failure propagation.
      return result;
    });
  };
  const wrappedAuto: NativeAuto = async function(reason, willRetry) {
    const admitted = hooks.beforeAuto?.({ reason, willRetry });
    if (admitted && !admitted.ok) throw admitted.error;
    let sdkWantsContinue: boolean;
    try { sdkWantsContinue = await originalAuto.call(session, reason, willRetry); }
    catch (error) {
      const qualified = hooks.afterAuto({ reason, willRetry, sdkWantsContinue: false });
      throw qualified.ok ? error : qualified.error;
    }
    const qualified = hooks.afterAuto({ reason, willRetry, sdkWantsContinue });
    if (!qualified.ok) throw qualified.error;
    return sdkWantsContinue;
  };
  const wrappedAppend: typeof manager.appendCompaction = function(...args) {
    const id = originalAppend.apply(manager, args); // Existing _persist is the only SQL writer.
    hooks.onAppend(id); // This ID is the actual append result, never a summary-text match.
    return id;
  };
  native._runDefaultCompaction = wrappedDefault;
  native._runAutoCompaction = wrappedAuto;
  manager.appendCompaction = wrappedAppend;
  const unsubscribe = session.subscribe(event => hooks.onEvent(event));
  installed.add(session);
  let disposed = false;
  return ok({ dispose() {
    if (disposed) return;
    disposed = true;
    unsubscribe();
    if (native._runDefaultCompaction === wrappedDefault) native._runDefaultCompaction = originalDefault;
    if (native._runAutoCompaction === wrappedAuto) native._runAutoCompaction = originalAuto;
    if (manager.appendCompaction === wrappedAppend) manager.appendCompaction = originalAppend;
    installed.delete(session);
  } });
}
