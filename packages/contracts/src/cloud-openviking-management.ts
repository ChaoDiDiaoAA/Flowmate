import { z } from 'zod';
import { CLOUD_MATERIAL_CHUNK_BYTES } from './cloud-material.ts';
import { CloudDesktopConnectionSchema } from './cloud-desktop.ts';
import { CloudWorkspaceIdSchema } from './durable-runtime.ts';
import { AppErrorSchema, type Result } from './runtime.ts';
import {
  OpenVikingManagementRequestSchema, OpenVikingManagementRoleSchema, OpenVikingManagementTaskIdSchema,
} from './openviking-management.ts';

export const CLOUD_OPENVIKING_CHUNK_BYTES = CLOUD_MATERIAL_CHUNK_BYTES;
export const CLOUD_OPENVIKING_FILE_LIMIT = 256 * 1024 * 1024;
export const CLOUD_OPENVIKING_REQUEST_LIMIT = 1_100_000;
export const CLOUD_OPENVIKING_RESPONSE_LIMIT = 2 * 1024 * 1024;
const id = z.string().uuid();
const accountName = OpenVikingManagementTaskIdSchema;
export const CloudOpenVikingFileNameSchema = z.string().min(1).max(255).refine(name =>
  name !== '.' && name !== '..' && !/[\\/:\x00-\x1f\x7f]/.test(name));
const bytes = z.number().int().min(0).max(CLOUD_OPENVIKING_FILE_LIMIT);
const offset = bytes.refine(value => value % CLOUD_OPENVIKING_CHUNK_BYTES === 0);
const base64 = z.string().min(4).max(Math.ceil(CLOUD_OPENVIKING_CHUNK_BYTES / 3) * 4)
  .regex(/^[A-Za-z0-9+/]+={0,2}$/);
const operation = z.object({ operationId: id }).strict();
const upload = operation.extend({ uploadId: id });
export const CloudOpenVikingUploadManifestSchema = upload.extend({ name: CloudOpenVikingFileNameSchema, bytes });
export const CloudOpenVikingUploadStatusSchema = CloudOpenVikingUploadManifestSchema.extend({ offset: bytes, finished: z.boolean() });
export const CloudOpenVikingDownloadStatusSchema = operation.extend({ name: CloudOpenVikingFileNameSchema, bytes });
export const CloudOpenVikingDownloadChunkSchema = CloudOpenVikingDownloadStatusSchema.extend({ offset, base64 });
export const CloudOpenVikingManagementIdentitySchema = z.discriminatedUnion('role', [
  z.object({ workspaceId: CloudWorkspaceIdSchema, role: z.literal('P'), accountId: accountName, userId: accountName, peerId: accountName }).strict(),
  z.object({ workspaceId: CloudWorkspaceIdSchema, role: z.literal('A'), accountId: accountName, userId: accountName, peerId: z.null() }).strict(),
  z.object({ workspaceId: CloudWorkspaceIdSchema, role: z.literal('S'), accountId: z.null(), userId: z.null(), peerId: z.null() }).strict(),
]);
export const CloudOpenVikingManagementTargetSchema = CloudDesktopConnectionSchema.extend({
  kind: z.literal('cloud'), role: OpenVikingManagementRoleSchema,
}).strict();
export const CloudOpenVikingManagementExecuteInputSchema = operation.extend({
  request: OpenVikingManagementRequestSchema, uploadId: id.optional(),
  output: z.literal(true).optional(), privateOptions: z.record(z.unknown()).optional(),
});
export type CloudOpenVikingManagementExecuteInput = z.infer<typeof CloudOpenVikingManagementExecuteInputSchema>;
export const CloudOpenVikingManagementOutcomeSchema = z.object({
  state: z.enum(['unknown', 'accepted', 'running', 'confirmed', 'verified', 'completed', 'failed', 'cancelled']),
}).strict();
export const CloudOpenVikingManagementCommandSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('info') }).strict(),
  z.object({ type: z.literal('execute'), input: CloudOpenVikingManagementExecuteInputSchema }).strict(),
  z.object({ type: z.literal('outcome'), input: operation.extend({
    request: OpenVikingManagementRequestSchema, taskId: OpenVikingManagementTaskIdSchema.optional(),
  }) }).strict(),
  z.object({ type: z.literal('upload_begin'), input: CloudOpenVikingUploadManifestSchema }).strict(),
  z.object({ type: z.literal('upload_append'), input: upload.extend({ offset, base64 }) }).strict(),
  z.object({ type: z.literal('upload_status'), input: upload }).strict(),
  z.object({ type: z.literal('upload_finish'), input: upload }).strict(),
  z.object({ type: z.literal('upload_release'), input: upload }).strict(),
  z.object({ type: z.literal('download_status'), input: operation }).strict(),
  z.object({ type: z.literal('download_read'), input: operation.extend({ offset }) }).strict(),
  z.object({ type: z.literal('download_release'), input: operation }).strict(),
]);
export type CloudOpenVikingManagementCommand = z.infer<typeof CloudOpenVikingManagementCommandSchema>;
export type CloudOpenVikingTransferCommand = Exclude<CloudOpenVikingManagementCommand, { type: 'info' | 'execute' | 'outcome' }>;
export const CloudOpenVikingManagementEnvelopeSchema = z.object({
  version: z.literal(1), workspaceId: CloudWorkspaceIdSchema, requestId: id, command: CloudOpenVikingManagementCommandSchema,
}).strict();
const response = z.object({
  version: z.literal(1), requestId: id,
  result: z.discriminatedUnion('ok', [
    z.object({ ok: z.literal(true), data: z.unknown().optional() }).strict(),
    z.object({ ok: z.literal(false), error: AppErrorSchema }).strict(),
  ]),
}).strict();
export function parseCloudOpenVikingManagementResult(raw: unknown, requestId: string): Result<unknown> | null {
  const parsed = response.safeParse(raw);
  if (!parsed.success || parsed.data.requestId !== requestId) return null;
  const result = parsed.data.result;
  return result.ok ? { ok: true, data: result.data } : result;
}
