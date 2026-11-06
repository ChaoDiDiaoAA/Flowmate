import { z } from 'zod';
import { appError, CloudQueueControlSchema, CloudWorkspaceIdSchema, fail, ok, type CloudQueueControl, type Result } from '@flowmate/contracts';

const saved = z.object({ version: z.literal(1), control: CloudQueueControlSchema }).strict();
const key = (workspaceId: string) => `flowmate.personal-agent.cloud-queue.v1.${CloudWorkspaceIdSchema.parse(workspaceId)}`;
export function readCloudQueueControl(storage: Pick<Storage, 'getItem'>, workspaceId: string): Result<CloudQueueControl | null> {
  try {
    const raw = storage.getItem(key(workspaceId)); if (raw === null) return ok(null);
    if (new TextEncoder().encode(raw).byteLength > 262_144) throw Error('cloud_queue_draft_too_large');
    return ok(saved.parse(JSON.parse(raw)).control);
  } catch { return fail(appError('cloud_queue_draft_unavailable', 'storage', 'The original queue control could not be read.', true)); }
}
export function saveCloudQueueControl(storage: Pick<Storage, 'setItem'>, workspaceId: string, raw: unknown): boolean {
  try {
    const value = JSON.stringify(saved.parse({ version: 1, control: raw }));
    if (new TextEncoder().encode(value).byteLength > 262_144) return false;
    storage.setItem(key(workspaceId), value); return true;
  } catch { return false; }
}
export function clearCloudQueueControl(storage: Pick<Storage, 'removeItem'>, workspaceId: string): boolean {
  try { storage.removeItem(key(workspaceId)); return true; } catch { return false; }
}
