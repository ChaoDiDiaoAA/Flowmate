import { appError, CloudDesktopConnectionSchema, fail, ok, type CloudDesktopConnection, type Result } from '@flowmate/contracts';

export const CLOUD_CONNECTION_KEY = 'flowmate.personal-agent.cloud-connection.v1';
export function readCloudConnection(storage: Pick<Storage, 'getItem'>): Result<CloudDesktopConnection | null> {
  try {
    const raw = storage.getItem(CLOUD_CONNECTION_KEY); if (raw === null) return ok(null);
    if (new TextEncoder().encode(raw).byteLength > 16_384) throw Error('cloud_connection_too_large');
    return ok(CloudDesktopConnectionSchema.parse(JSON.parse(raw)));
  } catch { return fail(appError('cloud_connection_unavailable', 'storage', 'The saved cloud connection could not be verified.', true)); }
}
export function saveCloudConnection(storage: Pick<Storage, 'setItem'>, raw: unknown): boolean {
  try {
    const profile = CloudDesktopConnectionSchema.parse(raw), value = JSON.stringify(profile);
    if (new TextEncoder().encode(value).byteLength > 16_384) return false;
    storage.setItem(CLOUD_CONNECTION_KEY, value); return true;
  } catch { return false; }
}
