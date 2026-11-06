import { z } from 'zod';
import { CloudRuntimeIdSchema, CloudWorkspaceIdSchema } from './durable-runtime.ts';
import { RESOURCE_LIMITS, ResourceFilePathSchema, ResourceManifestSchema, ResourceRefSchema } from './resources.ts';
import { AppErrorSchema, type Result } from './runtime.ts';
import { appError, fail } from './errors.ts';

export const CLOUD_RESOURCE_CHUNK_BYTES = 256 * 1024;
export const CloudResourceKeySchema = z.object({ workspaceId: CloudWorkspaceIdSchema, uploadId: CloudRuntimeIdSchema }).strict();
export const CloudResourceManifestSchema = CloudResourceKeySchema.extend({ version: z.literal(1), ref: ResourceRefSchema,
  manifest: ResourceManifestSchema, manifestBase64: z.string().min(4).max(Math.ceil(RESOURCE_LIMITS.manifestBytes / 3) * 4) }).strict()
  .refine(value => value.ref.kind === value.manifest.kind && value.ref.id === value.manifest.id && value.ref.version === value.manifest.version
    && new TextEncoder().encode(JSON.stringify(value)).byteLength <= 1_000_000, 'Resource identity or manifest exceeds its original boundary.');
export type CloudResourceManifest = z.infer<typeof CloudResourceManifestSchema>;
export const CloudResourceChunkSchema = CloudResourceKeySchema.extend({ path: ResourceFilePathSchema,
  offset: z.number().int().nonnegative().max(RESOURCE_LIMITS.fileBytes), base64: z.string().min(4).max(Math.ceil(CLOUD_RESOURCE_CHUNK_BYTES / 3) * 4) }).strict();
export const CloudResourceReceiptSchema = CloudResourceKeySchema.extend({ ref: ResourceRefSchema }).strict();
export type CloudResourceReceipt = z.infer<typeof CloudResourceReceiptSchema>;
export const CloudResourceStatusSchema = CloudResourceKeySchema.extend({ status: z.enum(['receiving', 'completed']),
  receipt: CloudResourceReceiptSchema.nullable(), files: z.array(z.object({ path: ResourceFilePathSchema,
    offset: z.number().int().nonnegative().max(RESOURCE_LIMITS.fileBytes) }).strict()).min(1).max(RESOURCE_LIMITS.files) }).strict();
export const CloudResourceExportPrepareSchema = z.object({ workspaceId: CloudWorkspaceIdSchema, ref: ResourceRefSchema }).strict();
export const CloudResourceExportChunkSchema = CloudResourceChunkSchema.omit({ base64: true });
const exportCommands = [
  z.object({ type: z.literal('cloud_resource_export_prepare'), input: CloudResourceExportPrepareSchema }).strict(),
  z.object({ type: z.literal('cloud_resource_export_chunk'), input: CloudResourceExportChunkSchema }).strict(),
  z.object({ type: z.literal('cloud_resource_export_complete'), input: CloudResourceReceiptSchema }).strict(),
] as const;
export const CloudResourceExportCommandSchema = z.discriminatedUnion('type', exportCommands);
export type CloudResourceExportCommand = z.infer<typeof CloudResourceExportCommandSchema>;
export function cloudResourceExportHostCommandSchemas(envelope: { version: z.ZodLiteral<1>; requestId: z.ZodString }) {
  return exportCommands.map(schema => schema.extend(envelope));
}
export function isCloudResourceExportHostCommand(type: string): type is CloudResourceExportCommand['type'] {
  return exportCommands.some(schema => schema.shape.type.value === type);
}
const sameRef = (a: z.infer<typeof ResourceRefSchema>, b: z.infer<typeof ResourceRefSchema>) => a.kind === b.kind && a.id === b.id && a.version === b.version;
export function parseCloudResourceExportResult(command: CloudResourceExportCommand, value: unknown): Result<unknown> | null {
  const data = command.type === 'cloud_resource_export_prepare' ? z.object({ manifest: CloudResourceManifestSchema,
    receipt: CloudResourceReceiptSchema.nullable() }).strict() : command.type === 'cloud_resource_export_chunk' ? CloudResourceChunkSchema : CloudResourceReceiptSchema;
  const result = z.discriminatedUnion('ok', [z.object({ ok: z.literal(true), data }).strict(),
    z.object({ ok: z.literal(false), error: AppErrorSchema }).strict()]).safeParse(value);
  if (!result.success) return null;
  if (!result.data.ok) {
    const error = result.data.error;
    return error.runId === undefined && error.sessionId === undefined && error.toolCallId === undefined
      ? fail(appError(error.code, error.category, 'The local resource operation could not be completed.', error.retryable)) : null;
  }
  const output = result.data.data;
  if (command.type === 'cloud_resource_export_prepare') {
    if (!('manifest' in output)) return null;
    const { manifest, receipt } = output;
    if (manifest.workspaceId !== command.input.workspaceId || !sameRef(manifest.ref, command.input.ref)
      || receipt && (receipt.workspaceId !== manifest.workspaceId || receipt.uploadId !== manifest.uploadId || !sameRef(receipt.ref, manifest.ref))) return null;
  } else if (command.type === 'cloud_resource_export_chunk') {
    if (!('base64' in output) || output.workspaceId !== command.input.workspaceId || output.uploadId !== command.input.uploadId
      || output.path !== command.input.path || output.offset !== command.input.offset) return null;
  } else if (!('ref' in output) || output.workspaceId !== command.input.workspaceId || output.uploadId !== command.input.uploadId
    || !sameRef(output.ref, command.input.ref)) return null;
  return { ok: true, data: output };
}
