import { z } from 'zod';
import { CloudRuntimeIdSchema, CloudWorkspaceIdSchema } from './durable-runtime.ts';
import { DocumentRefSchema, MAX_INVOICE_PAGES } from './invoice.ts';
import { AppErrorSchema, type Result } from './runtime.ts';
import { appError, fail } from './errors.ts';

export const CLOUD_MATERIAL_CHUNK_BYTES = 256 * 1024;
const file = z.object({ kind: z.enum(['original', 'parsed']), name: z.enum(['original.jpg', 'original.png', 'original.pdf', 'source.md',
  'parsed.json', 'raw-content.json', 'raw-pages.json', 'source.json', 'source.txt']), mimeType: z.string().min(1).max(128),
  bytes: z.number().int().min(1).max(10 * 1024 * 1024) }).strict();
export const CloudMaterialManifestSchema = z.object({ version: z.literal(1), workspaceId: CloudWorkspaceIdSchema, uploadId: CloudRuntimeIdSchema,
  sourceDocumentRef: DocumentRefSchema, sourceKey: z.string().min(1).max(128), sourceRecordId: z.string().min(1).max(512),
  sourceVersion: z.string().min(1).max(512), originalName: z.enum(['original.jpg', 'original.png', 'original.pdf', 'source.md']),
  metadata: z.object({ version: z.literal(2), sampleId: z.string().max(512).optional(), pageCount: z.number().int().min(1).max(MAX_INVOICE_PAGES),
    warnings: z.array(z.string().max(2048)).max(100), allowedUsesClaim: z.array(z.string().max(2048)).max(100),
    licenseVerification: z.string().min(1).max(128), unavailableReason: z.null() }).strict(),
  files: z.array(file).min(2).max(6) }).strict().refine(value => value.sourceVersion === value.sourceDocumentRef.version
    && value.files.reduce((sum, item) => sum + item.bytes, 0) <= 32 * 1024 * 1024
    && new Set(value.files.map(item => `${item.kind}:${item.name}`)).size === value.files.length
    && value.files.filter(item => item.kind === 'original').length === 1
    && value.files.some(item => item.kind === 'original' && item.name === value.originalName)
    && value.files.some(item => item.kind === 'parsed' && item.name === 'parsed.json'), 'The original material manifest is inconsistent.');
export type CloudMaterialManifest = z.infer<typeof CloudMaterialManifestSchema>;
export const CloudMaterialChunkSchema = z.object({ workspaceId: CloudWorkspaceIdSchema, uploadId: CloudRuntimeIdSchema,
  kind: z.enum(['original', 'parsed']), name: file.shape.name, offset: z.number().int().nonnegative().max(32 * 1024 * 1024),
  base64: z.string().min(1).max(349_528) }).strict();
export const CloudMaterialReceiptSchema = z.object({ workspaceId: CloudWorkspaceIdSchema, uploadId: CloudRuntimeIdSchema,
  sourceDocumentRef: DocumentRefSchema, cloudDocumentRef: DocumentRefSchema }).strict();
export type CloudMaterialReceipt = z.infer<typeof CloudMaterialReceiptSchema>;
export const CloudMaterialKeySchema = z.object({ workspaceId: CloudWorkspaceIdSchema, uploadId: CloudRuntimeIdSchema }).strict();
export const CloudMaterialStatusSchema = CloudMaterialKeySchema.extend({ status: z.enum(['receiving', 'completed']),
  receipt: CloudMaterialReceiptSchema.nullable(), files: z.array(z.object({ kind: file.shape.kind, name: file.shape.name,
    offset: z.number().int().nonnegative().max(10 * 1024 * 1024) }).strict()).min(2).max(6) }).strict();
export type CloudMaterialStatus = z.infer<typeof CloudMaterialStatusSchema>;

export const CloudMaterialExportPrepareSchema = z.object({ workspaceId: CloudWorkspaceIdSchema, documentRef: DocumentRefSchema }).strict();
export const CloudMaterialExportChunkSchema = CloudMaterialChunkSchema.omit({ base64: true });
const exportCommands = [
  z.object({ type: z.literal('cloud_material_export_prepare'), input: CloudMaterialExportPrepareSchema }).strict(),
  z.object({ type: z.literal('cloud_material_export_chunk'), input: CloudMaterialExportChunkSchema }).strict(),
  z.object({ type: z.literal('cloud_material_export_complete'), input: CloudMaterialReceiptSchema }).strict(),
] as const;
export const CloudMaterialExportCommandSchema = z.discriminatedUnion('type', exportCommands);
export type CloudMaterialExportCommand = z.infer<typeof CloudMaterialExportCommandSchema>;
export function cloudMaterialExportHostCommandSchemas(envelope: { version: z.ZodLiteral<1>; requestId: z.ZodString }) {
  return exportCommands.map(schema => schema.extend(envelope));
}
export function isCloudMaterialExportHostCommand(type: string): type is CloudMaterialExportCommand['type'] {
  return exportCommands.some(schema => schema.shape.type.value === type);
}
export function parseCloudMaterialExportResult(command: CloudMaterialExportCommand, value: unknown): Result<unknown> | null {
  const schema = command.type === 'cloud_material_export_prepare' ? z.object({ manifest: CloudMaterialManifestSchema,
    receipt: CloudMaterialReceiptSchema.nullable() }).strict() : command.type === 'cloud_material_export_chunk' ? CloudMaterialChunkSchema : CloudMaterialReceiptSchema;
  const result = z.discriminatedUnion('ok', [z.object({ ok: z.literal(true), data: schema }).strict(),
    z.object({ ok: z.literal(false), error: AppErrorSchema }).strict()]).safeParse(value);
  if (!result.success) return null;
  if (!result.data.ok) {
    const error = result.data.error;
    if (error.runId !== undefined || error.sessionId !== undefined || error.toolCallId !== undefined) return null;
    return fail(appError(error.code, error.category, 'The local material operation could not be completed.', error.retryable));
  }
  const data = result.data.data;
  if (command.type === 'cloud_material_export_prepare') {
    if (!('manifest' in data)) return null;
    const manifest = data.manifest, receipt = data.receipt;
    if (manifest.workspaceId !== command.input.workspaceId || manifest.sourceDocumentRef.id !== command.input.documentRef.id
      || manifest.sourceDocumentRef.version !== command.input.documentRef.version || receipt &&
      (receipt.workspaceId !== manifest.workspaceId || receipt.uploadId !== manifest.uploadId
        || receipt.sourceDocumentRef.id !== manifest.sourceDocumentRef.id || receipt.sourceDocumentRef.version !== manifest.sourceDocumentRef.version)) return null;
  } else if (command.type === 'cloud_material_export_chunk') {
    if (!('base64' in data) || data.workspaceId !== command.input.workspaceId || data.uploadId !== command.input.uploadId
      || data.kind !== command.input.kind || data.name !== command.input.name || data.offset !== command.input.offset) return null;
  } else {
    if (!('cloudDocumentRef' in data) || data.workspaceId !== command.input.workspaceId || data.uploadId !== command.input.uploadId
      || data.sourceDocumentRef.id !== command.input.sourceDocumentRef.id || data.sourceDocumentRef.version !== command.input.sourceDocumentRef.version
      || data.cloudDocumentRef.id !== command.input.cloudDocumentRef.id || data.cloudDocumentRef.version !== command.input.cloudDocumentRef.version) return null;
  }
  return { ok: true, data };
}
