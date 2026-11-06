import { randomUUID } from 'node:crypto';
import { appError, fail, parseDesktopBridgeResult, type DesktopBridgeRequest, type DesktopBridgeResult } from '@flowmate/contracts';

export type DesktopBridgeOutput = { version: 1; type: 'desktop_request'; requestId: string; request: DesktopBridgeRequest }
  | { version: 1; type: 'desktop_cancel'; requestId: string };

export function createDesktopBridge(send: (output: DesktopBridgeOutput) => void | Promise<void>) {
  const pending = new Map<string, { request: DesktopBridgeRequest; finish(result: DesktopBridgeResult): void; cancel(): void }>();
  let closed = false;
  const unavailable = () => fail(appError('desktop_unavailable', 'runtime', 'The authorized interactive desktop is unavailable.', true));
  const notify = (output: DesktopBridgeOutput) => { try { void Promise.resolve(send(output)).catch(() => {}); } catch { /* The receiver may have disconnected. */ } };
  return {
    request: (request: DesktopBridgeRequest, signal: AbortSignal): Promise<DesktopBridgeResult> => {
      if (closed || signal.aborted) return Promise.resolve(unavailable());
      const requestId = randomUUID();
      return new Promise(resolve => {
        const finish = (result: DesktopBridgeResult) => {
          if (!pending.delete(requestId)) return;
          clearTimeout(timer); signal.removeEventListener('abort', cancel); resolve(result);
        };
        const cancel = () => { notify({ version: 1, type: 'desktop_cancel', requestId }); finish(unavailable()); };
        const timer = setTimeout(cancel, 8500);
        pending.set(requestId, { request, finish, cancel });
        signal.addEventListener('abort', cancel, { once: true });
        notify({ version: 1, type: 'desktop_request', requestId, request });
        if (signal.aborted) cancel();
      });
    },
    receive: (requestId: string, result: unknown) => {
      const original = pending.get(requestId); if (!original) return false;
      original.finish(parseDesktopBridgeResult(original.request, result) ?? unavailable()); return true;
    },
    close: () => { closed = true; for (const value of [...pending.values()]) value.cancel(); },
  };
}
