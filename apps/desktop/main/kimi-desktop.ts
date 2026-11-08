import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { appError, fail, ok, DesktopActionTargetSchema, type DesktopActionProposal, type DesktopActionTarget, type DesktopBridgeRequest,
  type DesktopBridgeResult, type Result } from '@flowmate/contracts';

type Window = DesktopActionTarget['window'];
type Owner = { workId: number; itemId: number; workspaceId?: string };
export function isOwnDesktopWindow(id: number, handles: readonly Buffer[]): boolean {
  return handles.some(handle => handle.length < 4 || (handle.length >= 8 ? handle.readBigUInt64LE() : BigInt(handle.readUInt32LE())) === BigInt(id));
}
type KimiApi = {
  listWindows(signal: AbortSignal): Promise<Window[]>;
  observe(window: Window, signal: AbortSignal): Promise<{ protected: true }
    | { window: Window; tree: string; focused: string | null; truncated?: boolean }>;
  click(window: Window, index: number, signal: AbortSignal): Promise<void>;
  setValue(window: Window, index: number, value: string, signal: AbortSignal): Promise<void>;
  typeText(window: Window, value: string, signal: AbortSignal): Promise<void>;
  close(): Promise<void>;
};
const unavailable = () => fail(appError('desktop_unavailable', 'runtime', 'The interactive desktop is unavailable.'));

export function createKimiDesktop(api: KimiApi, lock?: <T>(signal: AbortSignal, operation: (valid: () => boolean) => Promise<Result<T>>) => Promise<Result<T>>) {
  const connectionId = randomUUID();
  const selections = new Map<string, Window>();
  const observations = new Map<string, { owner: Owner; window: Window; tree: string }>();
  let available: Window[] = [], closed = false, queue: Promise<unknown> = Promise.resolve();
  const key = (owner: Owner) => JSON.stringify([owner.workspaceId ?? null, owner.workId, owner.itemId]);
  const run = <T>(signal: AbortSignal, operation: (valid: () => boolean) => Promise<Result<T>>): Promise<Result<T>> => {
    const next = queue.then(async () => {
      if (closed || signal.aborted) return unavailable();
      const checked = async (valid: () => boolean) => {
        try { return await operation(valid); }
        catch (error) { return error instanceof Error && error.message === 'computer_use_busy'
          ? fail(appError('computer_use_busy', 'runtime', 'Another KimiCU session owns desktop input. Wait until it is available.', true)) : unavailable(); }
      };
      try { return await (lock ? lock(signal, checked) : checked(() => !signal.aborted)); } catch { return unavailable(); }
    });
    queue = next.then(() => undefined, () => undefined);
    return next;
  };
  const element = (tree: string, index: number) => {
    const matches = tree.split('\n').map(line => line.trim()).filter(line => line.startsWith(`[${index}]`)
      && (line.length === String(index).length + 2 || /\s/.test(line[String(index).length + 2]!)));
    return matches.length === 1 && matches[0]!.length <= 4096 ? matches[0] : undefined;
  };
  const resolve = (owner: Owner, action: DesktopActionProposal): Result<DesktopActionTarget> => {
    const observed = observations.get(action.observationId), selected = selections.get(key(owner));
    if (observed && !isDeepStrictEqual(observed.owner, owner)) return unavailable();
    if (!observed || !selected || !isDeepStrictEqual(observed.window, selected))
      return fail(appError('desktop_target_changed', 'runtime', 'The original desktop observation is no longer current.'));
    const line = element(observed.tree, action.elementIndex);
    if (!line) return fail(appError('desktop_target_changed', 'runtime', 'The observed control is unavailable.'));
    return ok({ connectionId, window: selected, element: line });
  };
  const forgetObservations = (owner: Owner) => {
    for (const [id, value] of observations) if (isDeepStrictEqual(value.owner, owner)) observations.delete(id);
  };
  const protectedWindow = (owner: Owner, code = 'desktop_protected_content') => {
    forgetObservations(owner);
    return fail(appError(code, 'runtime', 'This window contains a protected field. Ask the user to handle it manually in the original application.'));
  };
  const revoke = (owner: Owner) => {
    selections.delete(key(owner));
    forgetObservations(owner);
  };
  return {
    listWindows: (signal: AbortSignal): Promise<Result<Window[]>> => run(signal, async valid => {
      const windows = await api.listWindows(signal);
      if (closed || !valid()) return unavailable();
      available = windows.slice(0, 100).map(value => DesktopActionTargetSchema.shape.window.parse(value));
      return ok(available);
    }),
    selectedWindows: (owner: Owner, signal: AbortSignal): Promise<Result<Window[]>> => run(signal, async valid => {
      const selected = selections.get(key(owner)); if (!selected) return unavailable();
      const current = await api.listWindows(signal);
      if (closed || !valid() || !isDeepStrictEqual(selections.get(key(owner)), selected)
        || !current.some(value => isDeepStrictEqual(value, selected))) return unavailable();
      return ok([selected]);
    }),
    select: (owner: Owner, window: Window, signal: AbortSignal): Promise<Result<void>> => run(signal, async valid => {
      if (!available.some(value => isDeepStrictEqual(value, window))) return unavailable();
      const current = await api.listWindows(signal);
      if (closed || !valid() || !current.some(value => isDeepStrictEqual(value, window))) return unavailable();
      revoke(owner); selections.set(key(owner), window);
      return ok(undefined);
    }),
    observe: (owner: Owner, signal: AbortSignal): Promise<Result<{ observationId: string; window: Window; tree: string; truncated: boolean }>> => run(signal, async valid => {
      const selected = selections.get(key(owner)); if (!selected) return unavailable();
      const state = await api.observe(selected, signal);
      if ('protected' in state) return protectedWindow(owner);
      if (closed || !valid() || !isDeepStrictEqual(selections.get(key(owner)), selected)
        || !isDeepStrictEqual(selected, state.window) || typeof state.tree !== 'string' || !state.tree) return unavailable();
      const lines: string[] = []; let bytes = 0, truncated = state.truncated === true;
      for (const line of state.tree.split('\n')) {
        const size = Buffer.byteLength(line, 'utf8') + 1; if (bytes + size > 22000) { truncated = true; break; }
        lines.push(line); bytes += size;
      }
      const tree = lines.join('\n'), observationId = randomUUID();
      if (!tree) return unavailable();
      observations.set(observationId, { owner: { ...owner }, window: selected, tree });
      if (observations.size > 100) observations.delete(observations.keys().next().value!);
      return ok({ observationId, window: selected, tree, truncated });
    }),
    resolveTarget: (owner: Owner, action: DesktopActionProposal, signal: AbortSignal): Promise<Result<DesktopActionTarget>> =>
      run(signal, async valid => {
        const original = resolve(owner, action); if (!original.ok) return original;
        const current = await api.observe(original.data.window, signal);
        if ('protected' in current) return protectedWindow(owner, 'desktop_target_changed');
        const stillAuthorized = resolve(owner, action);
        if (closed || !valid() || !stillAuthorized.ok || !isDeepStrictEqual(stillAuthorized.data, original.data)
          || !isDeepStrictEqual(current.window, original.data.window) || element(current.tree, action.elementIndex) !== original.data.element)
          return fail(appError('desktop_target_changed', 'runtime', 'The observed desktop target changed; observe it again.'));
        return original;
      }),
    dispatch: (owner: Owner, action: DesktopActionProposal, target: DesktopActionTarget, signal: AbortSignal): Promise<Result<void>> => run(signal, async valid => {
      const original = resolve(owner, action);
      if (!original.ok || !isDeepStrictEqual(original.data, target)) return unavailable();
      const current = await api.observe(target.window, signal);
      if ('protected' in current) return protectedWindow(owner);
      const stillAuthorized = resolve(owner, action);
      if (closed || !valid() || !stillAuthorized.ok || !isDeepStrictEqual(stillAuthorized.data, target)
        || !isDeepStrictEqual(current.window, target.window) || element(current.tree, action.elementIndex) !== target.element)
        return fail(appError('desktop_target_changed', 'runtime', 'The approved desktop target changed; observe it again.'));
      if (action.kind === 'click') await api.click(target.window, action.elementIndex, signal);
      else if (action.kind === 'set_value') await api.setValue(target.window, action.elementIndex, action.value, signal);
      else {
        const focused = current.focused?.replace(/^Focused:\s*/, '').trim();
        const matching = current.tree.split('\n').map(line => line.trim()).filter(line => /^\[\d+\]/.test(line)
          && line.replace(/^\[\d+\]\s*/, '').trim() === focused);
        if (current.truncated || !focused || focused !== target.element.replace(/^\[\d+\]\s*/, '').trim() || matching.length !== 1)
          return fail(appError('desktop_focus_unconfirmed', 'runtime', 'The approved control is not confirmed as focused.'));
        await api.typeText(target.window, action.text, signal);
      }
      return ok(undefined);
    }),
    revoke,
    close: async () => { closed = true; selections.clear(); observations.clear(); await queue; await api.close(); },
  };
}

export async function handleKimiDesktopRequest(desktop: ReturnType<typeof createKimiDesktop>, owner: Owner,
  request: DesktopBridgeRequest, signal: AbortSignal): Promise<DesktopBridgeResult> {
  if (owner.workId !== request.workId || owner.itemId !== request.itemId || request.kind === 'form') return unavailable();
  if (request.kind === 'list') { const result = await desktop.selectedWindows(owner, signal); return result.ok ? ok({ kind: 'list', windows: result.data }) : result; }
  if (request.kind === 'observe') { const result = await desktop.observe(owner, signal); return result.ok ? ok({ kind: 'observe', ...result.data }) : result; }
  if (request.kind === 'resolve') { const result = await desktop.resolveTarget(owner, request.action, signal); return result.ok ? ok({ kind: 'resolve', target: result.data }) : result; }
  if (request.kind === 'dispatch') { const result = await desktop.dispatch(owner, request.action, request.target, signal); return result.ok ? ok({ kind: 'dispatch' }) : result; }
  return unavailable();
}
