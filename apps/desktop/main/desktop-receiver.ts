import { appError, fail, DesktopBridgeRequestSchema, parseDesktopBridgeResult, type DesktopBridgeRequest, type DesktopBridgeResult } from '@flowmate/contracts';

export function createDesktopReceiver(handler: (request: DesktopBridgeRequest, signal: AbortSignal) => Promise<DesktopBridgeResult>,
  send: (id: string, result: DesktopBridgeResult) => void) {
  const pending = new Map<string, AbortController>(); let closed = false;
  const unavailable = () => fail(appError('desktop_unavailable', 'runtime', 'The authorized interactive desktop is unavailable.', true));
  return {
    request: (id: string, raw: unknown) => {
      const request = DesktopBridgeRequestSchema.safeParse(raw);
      if (closed || typeof id !== 'string' || !id || id.length > 128 || pending.has(id) || !request.success) return false;
      const controller = new AbortController(); pending.set(id, controller);
      void Promise.resolve().then(() => handler(request.data, controller.signal)).catch(unavailable).then(value => {
        if (closed || controller.signal.aborted || pending.get(id) !== controller) return;
        pending.delete(id);
        try { send(id, parseDesktopBridgeResult(request.data, value) ?? unavailable()); } catch { /* The original connection has gone away. */ }
      });
      return true;
    },
    cancel: (id: string) => { const controller = pending.get(id); if (controller) { pending.delete(id); controller.abort(); } },
    close: () => { closed = true; for (const controller of pending.values()) controller.abort(); pending.clear(); },
  };
}
