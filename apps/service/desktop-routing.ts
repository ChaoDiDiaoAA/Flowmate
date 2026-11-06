import { appError, fail, parseDesktopBridgeResult, type DesktopBridgeRequest, type DesktopBridgeResult } from '@flowmate/contracts';

type Owner = { workId: number; itemId: number };
export function createDesktopRouting<Client extends object>(available: (client: Client) => boolean) {
  const bindings = new Map<string, Client>(), pending = new Map<string, { client: Client; request: DesktopBridgeRequest }>();
  let desktopClient: Client | null = null;
  const key = (owner: Owner) => `${owner.workId}:${owner.itemId}`;
  return {
    bind: (client: Client, owner: Owner) => {
      if (!available(client) || desktopClient !== null && desktopClient !== client) return false;
      desktopClient = client; bindings.set(key(owner), client); return true;
    },
    recipient: (owner: Owner): Client | null => {
      const client = bindings.get(key(owner)); return client && available(client) ? client : null;
    },
    remember: (id: string, client: Client, request: DesktopBridgeRequest) => {
      if (!available(client) || bindings.get(key(request)) !== client || pending.has(id)) return false;
      pending.set(id, { client, request }); return true;
    },
    receive: (id: string, client: Client, value: unknown): DesktopBridgeResult | null => {
      const original = pending.get(id); if (!original || original.client !== client) return null;
      pending.delete(id);
      return parseDesktopBridgeResult(original.request, value)
        ?? fail(appError('desktop_unavailable', 'runtime', 'The original desktop response is invalid.'));
    },
    cancel: (id: string): Client | null => {
      const original = pending.get(id); if (!original) return null;
      pending.delete(id); return original.client;
    },
    disconnect: (client: Client): string[] => {
      for (const [id, owner] of bindings) if (owner === client) bindings.delete(id);
      if (desktopClient === client) desktopClient = null;
      const ids: string[] = [];
      for (const [id, request] of pending) if (request.client === client) { pending.delete(id); ids.push(id); }
      return ids;
    },
  };
}
