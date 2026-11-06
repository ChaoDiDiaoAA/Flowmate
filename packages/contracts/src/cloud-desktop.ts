import { z } from 'zod';
import { CloudWorkspaceIdSchema } from './durable-runtime.ts';
import { CloudMaterialChunkSchema, CloudMaterialKeySchema, CloudMaterialManifestSchema, CloudMaterialReceiptSchema,
  CloudMaterialStatusSchema } from './cloud-material.ts';
import { CloudResourceChunkSchema, CloudResourceKeySchema, CloudResourceManifestSchema, CloudResourceReceiptSchema,
  CloudResourceStatusSchema } from './cloud-resource.ts';
import { AcceptInvoiceCandidateRequestSchema, DocumentRefSchema, invoiceToolSchemas, RejectInvoiceCandidateRequestSchema, SaveInvoiceCandidateRequestSchema } from './invoice.ts';
import { ContextReferenceSchema } from './context.ts';
import { ResourceRefSchema } from './resources.ts';
import { CloudRuntimeRetryReceiptSchema, CloudRuntimeRetryRequestSchema, CloudRuntimeStatusRequestSchema, CloudRuntimeStatusSchema } from './cloud-native-result.ts';
import { DurableSubagentRunOutputSchema } from './durable-run.ts';
import { CloudQueueControlQuerySchema, CloudQueueControlSchema, CloudQueueOwnerSchema, CloudQueueReceiptSchema, CloudQueueViewSchema, matchesCloudQueueReceipt } from './cloud-queue.ts';
import { AppErrorSchema, type Result } from './runtime.ts';
import { appError, fail, ok } from './errors.ts';
import { DesktopBridgeRequestSchema, DesktopBridgeResultSchema } from './desktop-actions.ts';
import { PersonalAgentCommandSchema, matchesPersonalAgentResponse, parsePersonalAgentHostResult,
  personalAgentHostFailure } from './personal-agent-commands.ts';

export const CLOUD_DESKTOP_MAX_IN_FLIGHT = 32;
export const CLOUD_DESKTOP_RESERVED_CONTROL = 2;
export const CLOUD_DESKTOP_MAX_TRANSPORT_REQUESTS = 4096;

export const CloudMaterialCommandSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('cloud_material_begin'), input: CloudMaterialManifestSchema }).strict(),
  z.object({ type: z.literal('cloud_material_append'), input: CloudMaterialChunkSchema }).strict(),
  z.object({ type: z.literal('cloud_material_status'), input: CloudMaterialKeySchema }).strict(),
  z.object({ type: z.literal('cloud_material_finish'), input: CloudMaterialKeySchema }).strict(),
]);
export type CloudMaterialCommand = z.infer<typeof CloudMaterialCommandSchema>;
export const CloudResourceCommandSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('cloud_resource_begin'), input: CloudResourceManifestSchema }).strict(),
  z.object({ type: z.literal('cloud_resource_append'), input: CloudResourceChunkSchema }).strict(),
  z.object({ type: z.literal('cloud_resource_status'), input: CloudResourceKeySchema }).strict(),
  z.object({ type: z.literal('cloud_resource_finish'), input: CloudResourceKeySchema }).strict(),
]);
export type CloudResourceCommand = z.infer<typeof CloudResourceCommandSchema>;
export const CloudQueueDesktopCommandSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('cloud_queue_read'), input: CloudQueueOwnerSchema }).strict(),
  z.object({ type: z.literal('cloud_queue_control'), input: CloudQueueControlSchema }).strict(),
  z.object({ type: z.literal('cloud_queue_query_control'), input: CloudQueueControlQuerySchema }).strict(),
]);
export type CloudQueueDesktopCommand = z.infer<typeof CloudQueueDesktopCommandSchema>;
export const CloudDeliveryDesktopCommandSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('cloud_delivery_status'), input: CloudRuntimeStatusRequestSchema }).strict(),
  z.object({ type: z.literal('cloud_delivery_retry'), input: CloudRuntimeRetryRequestSchema }).strict(),
]);
export type CloudDeliveryDesktopCommand = z.infer<typeof CloudDeliveryDesktopCommandSchema>;
export const CloudChildReportRequestSchema = CloudQueueOwnerSchema.extend({ childRunId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  originToolCallId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER) }).strict();
export const CloudChildReportSchema = CloudChildReportRequestSchema.extend({ output: DurableSubagentRunOutputSchema.nullable() }).strict()
  .refine(value => value.output === null || value.output.durable.workId === value.workId && value.output.durable.attemptId === value.attemptId
    && value.output.subagent.originToolCallId === value.originToolCallId);
export const CloudChildReportCommandSchema = z.object({ type: z.literal('cloud_child_report'), input: CloudChildReportRequestSchema }).strict();
export type CloudChildReportCommand = z.infer<typeof CloudChildReportCommandSchema>;
const progressId = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
export const CloudProgressCursorSchema = z.object({ generation: z.string().uuid(), sequence: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER) }).strict();
export const CloudProgressRequestSchema = z.object({ workId: progressId, sessionId: progressId, cursor: CloudProgressCursorSchema.nullable() }).strict();
export const CloudProgressFragmentSchema = z.object({ attemptId: progressId, requestId: z.string().min(1).max(128), modelAttemptId: z.string().uuid(),
  text: z.string().min(1).refine(value => new TextEncoder().encode(value).byteLength <= 1024) }).strict();
export const CloudProgressEventSchema = z.object({ workId: progressId, sessionId: progressId, cursor: CloudProgressCursorSchema,
  changed: z.boolean(), resync: z.boolean(), snapshotChanged: z.boolean().default(false), fragments: z.array(CloudProgressFragmentSchema).max(64).default([]),
  runtimeGeneration: z.string().uuid().nullable(),
  observationRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable() }).strict()
  .refine(value => (value.runtimeGeneration === null) === (value.observationRevision === null)
    && (!value.resync || value.fragments.length === 0));
export const CloudProgressCommandSchema = z.object({ type: z.literal('cloud_progress_wait'), input: CloudProgressRequestSchema }).strict();
export type CloudProgressCommand = z.infer<typeof CloudProgressCommandSchema>;
export type CloudProgressRequest = z.infer<typeof CloudProgressRequestSchema>;
export type CloudProgressEvent = z.infer<typeof CloudProgressEventSchema>;
const reviewId = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
function validImageBase64(value: string): boolean {
  if (value.length === 0 || value.length % 4 !== 0) return false;
  const end = value.length - 4;
  for (let offset = 0; offset < end; offset += 32_768)
    if (!/^[A-Za-z0-9+/]+$/.test(value.slice(offset, Math.min(end, offset + 32_768)))) return false;
  return /^(?:[A-Za-z0-9+/]{4}|[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)$/.test(value.slice(end));
}
export const CloudReviewTargetSchema = z.object({ workId: reviewId, itemId: reviewId, documentRef: DocumentRefSchema }).strict();
export const CloudReviewOriginalRequestSchema = CloudReviewTargetSchema.extend({ page: z.literal(1) }).strict();
export const CloudReviewPageRequestSchema = CloudReviewTargetSchema.extend(invoiceToolSchemas.read_invoice_document.input.omit({ documentId: true }).shape).strict();
export const CloudReviewPageReceiptSchema = z.object({ workId: reviewId, itemId: reviewId, page: invoiceToolSchemas.read_invoice_document.output }).strict();
export const CloudReviewCandidateRequestSchema = CloudReviewTargetSchema.extend({ jobId: reviewId, candidateId: reviewId }).strict();
export const CloudReviewCandidateReceiptSchema = z.object({ workId: reviewId, itemId: reviewId,
  status: z.enum(['generated', 'accepted', 'rejected']), createdAt: z.string().datetime({ offset: true }),
  context: ContextReferenceSchema.nullable(), detail: invoiceToolSchemas.get_invoice_candidate.output }).strict();
export const CloudReviewOpenReceiptSchema = CloudReviewCandidateRequestSchema.extend({ sequence: reviewId,
  workspaceRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER) }).strict();
export const CloudReviewAcceptRequestSchema = CloudReviewTargetSchema.extend({ request: AcceptInvoiceCandidateRequestSchema }).strict();
export const CloudReviewAcceptReceiptSchema = CloudReviewTargetSchema.extend({ jobId: reviewId, candidateId: reviewId,
  sequence: reviewId, status: z.literal('accepted') }).strict();
export const CloudReviewSaveRequestSchema = CloudReviewTargetSchema.extend({ request: SaveInvoiceCandidateRequestSchema }).strict();
export const CloudReviewSaveReceiptSchema = CloudReviewTargetSchema.extend({ jobId: reviewId, candidateId: reviewId,
  sequence: reviewId, changed: z.boolean() }).strict();
export const CloudReviewRejectRequestSchema = CloudReviewTargetSchema.extend({ request: RejectInvoiceCandidateRequestSchema }).strict();
export const CloudReviewRejectReceiptSchema = CloudReviewTargetSchema.extend({ jobId: reviewId, candidateId: reviewId,
  sequence: reviewId, status: z.literal('rejected') }).strict();
export const CloudReviewOriginalReceiptSchema = CloudReviewOriginalRequestSchema.omit({ page: true }).extend({
  mimeType: z.enum(['image/jpeg', 'image/png']), base64: z.string().min(1).max(14 * 1024 * 1024)
    .refine(validImageBase64) }).strict();
export const CloudReviewCommandSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('cloud_review_original'), input: CloudReviewOriginalRequestSchema }).strict(),
  z.object({ type: z.literal('cloud_review_page'), input: CloudReviewPageRequestSchema }).strict(),
  z.object({ type: z.literal('cloud_review_candidate'), input: CloudReviewCandidateRequestSchema }).strict(),
  z.object({ type: z.literal('cloud_review_open'), input: CloudReviewCandidateRequestSchema }).strict(),
  z.object({ type: z.literal('cloud_review_accept'), input: CloudReviewAcceptRequestSchema }).strict(),
  z.object({ type: z.literal('cloud_review_query_accept'), input: CloudReviewAcceptRequestSchema }).strict(),
  z.object({ type: z.literal('cloud_review_save'), input: CloudReviewSaveRequestSchema }).strict(),
  z.object({ type: z.literal('cloud_review_query_save'), input: CloudReviewSaveRequestSchema }).strict(),
  z.object({ type: z.literal('cloud_review_reject'), input: CloudReviewRejectRequestSchema }).strict(),
  z.object({ type: z.literal('cloud_review_query_reject'), input: CloudReviewRejectRequestSchema }).strict(),
]);
export type CloudReviewCommand = z.infer<typeof CloudReviewCommandSchema>;
export const CloudDesktopTargetSchema = z.object({ host: z.string().min(1).max(253), port: z.number().int().min(1).max(65535),
  username: z.string().regex(/^[a-z_][a-z0-9_-]{0,31}$/).refine(value => value !== 'root'),
  privateKeyPath: z.string().min(1).max(4096), knownHostsPath: z.string().min(1).max(4096) }).strict();
export const CloudDesktopConnectionSchema = z.object({ workspaceId: CloudWorkspaceIdSchema, target: CloudDesktopTargetSchema }).strict();
export const CloudDesktopWorkspaceSchema = z.object({ workspaceId: CloudWorkspaceIdSchema }).strict();
export const CloudDesktopStateSchema = z.object({ workspaceId: CloudWorkspaceIdSchema.nullable(), desktopReady: z.boolean().optional() }).strict();
const cloudDesktopConnection = z.object({ connectionId: z.string().uuid() }).strict();
export const CloudDesktopRelayCommandSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('cloud_desktop_attach'), input: cloudDesktopConnection }).strict(),
  z.object({ type: z.literal('cloud_desktop_next'), input: cloudDesktopConnection }).strict(),
  z.object({ type: z.literal('cloud_desktop_detach'), input: cloudDesktopConnection }).strict(),
  z.object({ type: z.literal('cloud_desktop_reply'), input: cloudDesktopConnection.extend({ id: z.string().uuid(), result: DesktopBridgeResultSchema }).strict() }).strict(),
]);
export type CloudDesktopRelayCommand = z.infer<typeof CloudDesktopRelayCommandSchema>;
export const CloudDesktopRelayEventSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('request'), id: z.string().uuid(), request: DesktopBridgeRequestSchema }).strict(),
  z.object({ kind: z.literal('cancel'), id: z.string().uuid() }).strict(),
]);
export const CloudDesktopUserCommandSchema = z.union([PersonalAgentCommandSchema, CloudQueueDesktopCommandSchema, CloudDeliveryDesktopCommandSchema, CloudChildReportCommandSchema, CloudProgressCommandSchema, CloudReviewCommandSchema]);
export const CloudDesktopRequestSchema = CloudDesktopWorkspaceSchema.extend({ command: CloudDesktopUserCommandSchema }).strict();
export const CloudDesktopUploadSchema = CloudDesktopWorkspaceSchema.extend({ documentRef: DocumentRefSchema }).strict();
export const CloudDesktopUploadResourceSchema = CloudDesktopWorkspaceSchema.extend({ ref: ResourceRefSchema }).strict();
export type CloudDesktopTarget = z.infer<typeof CloudDesktopTargetSchema>;
export type CloudDesktopConnection = z.infer<typeof CloudDesktopConnectionSchema>;
export type CloudDesktopUserCommand = z.infer<typeof CloudDesktopUserCommandSchema>;
export type CloudDesktopApi = {
  state(): Promise<Result<z.infer<typeof CloudDesktopStateSchema>>>;
  connect(input: CloudDesktopConnection): Promise<Result<{ workspaceId: string }>>;
  disconnect(input: z.infer<typeof CloudDesktopWorkspaceSchema>): Promise<Result<void>>;
  request(input: z.infer<typeof CloudDesktopRequestSchema>): Promise<Result<unknown>>;
  upload(input: z.infer<typeof CloudDesktopUploadSchema>): Promise<Result<z.infer<typeof CloudMaterialReceiptSchema>>>;
  uploadResource(input: z.infer<typeof CloudDesktopUploadResourceSchema>): Promise<Result<z.infer<typeof CloudResourceReceiptSchema>>>;
};
export const CloudDesktopCommandSchema = z.union([PersonalAgentCommandSchema, CloudMaterialCommandSchema, CloudResourceCommandSchema, CloudQueueDesktopCommandSchema, CloudDeliveryDesktopCommandSchema, CloudChildReportCommandSchema, CloudProgressCommandSchema, CloudReviewCommandSchema, CloudDesktopRelayCommandSchema]);
export type CloudDesktopCommand = z.infer<typeof CloudDesktopCommandSchema>;
export function isCloudDesktopRelayCommand(command: CloudDesktopCommand): command is CloudDesktopRelayCommand {
  return command.type.startsWith('cloud_desktop_');
}
export function isCloudMaterialCommand(command: CloudDesktopCommand): command is CloudMaterialCommand {
  return command.type.startsWith('cloud_material_');
}
export function isCloudResourceCommand(command: CloudDesktopCommand): command is CloudResourceCommand {
  return command.type.startsWith('cloud_resource_');
}
export function isCloudQueueCommand(command: CloudDesktopCommand): command is CloudQueueDesktopCommand {
  return command.type.startsWith('cloud_queue_');
}
export function isCloudReviewCommand(command: CloudDesktopCommand): command is CloudReviewCommand {
  return command.type.startsWith('cloud_review_');
}
export function isCloudDeliveryCommand(command: CloudDesktopCommand): command is CloudDeliveryDesktopCommand {
  return command.type === 'cloud_delivery_status' || command.type === 'cloud_delivery_retry';
}
export function isCloudChildReportCommand(command: CloudDesktopCommand): command is CloudChildReportCommand { return command.type === 'cloud_child_report'; }
export function isCloudProgressCommand(command: CloudDesktopCommand): command is CloudProgressCommand { return command.type === 'cloud_progress_wait'; }
export const CloudDesktopEnvelopeSchema = z.object({ version: z.literal(1), workspaceId: CloudWorkspaceIdSchema,
  requestId: z.string().uuid(), command: CloudDesktopCommandSchema }).strict().refine(value =>
  (!(isCloudMaterialCommand(value.command) || isCloudResourceCommand(value.command)) || value.command.input.workspaceId === value.workspaceId)
    && (value.command.type !== 'personal_agent_update' || value.command.input.configuration.workingDirectory === null),
  'Cloud Personal Agent configuration cannot use a desktop working directory.');
export type CloudDesktopEnvelope = z.infer<typeof CloudDesktopEnvelopeSchema>;

export function cloudDesktopFailure(command: CloudDesktopCommand): Extract<Result<never>, { ok: false }> {
  if (isCloudDesktopRelayCommand(command)) return { ok: false, error: appError('desktop_unavailable', 'runtime', 'The original interactive desktop is unavailable.', true) };
  if (isCloudProgressCommand(command)) return { ok: false, error: appError('cloud_progress_unavailable', 'runtime', 'Cloud progress is unavailable.', true) };
  if (isCloudChildReportCommand(command)) return { ok: false, error: appError('storage_read_failed', 'storage', 'The original child report could not be read.', true) };
  if (isCloudDeliveryCommand(command)) {
    const write = command.type === 'cloud_delivery_retry';
    return { ok: false, error: appError(write ? 'operation_result_unknown' : 'storage_read_failed', write ? 'runtime' : 'storage',
      write ? 'The original result retry could not be confirmed.' : 'The original result delivery could not be read.', true) };
  }
  if (isCloudReviewCommand(command)) {
    const write = command.type === 'cloud_review_open' || command.type === 'cloud_review_accept'
      || command.type === 'cloud_review_save' || command.type === 'cloud_review_reject';
    return { ok: false, error: appError(write ? 'operation_result_unknown' : 'storage_read_failed', write ? 'runtime' : 'storage',
      write ? 'The original cloud review operation could not be confirmed.' : 'The original cloud invoice could not be read.', true) };
  }
  if (isCloudQueueCommand(command)) {
    const write = command.type === 'cloud_queue_control';
    return { ok: false, error: appError(write ? 'operation_result_unknown' : 'storage_read_failed', write ? 'runtime' : 'storage',
      write ? 'The queue control result is unknown. Query the original control.' : 'The original queue could not be read.', true) };
  }
  if (isCloudResourceCommand(command)) {
    const write = command.type !== 'cloud_resource_status';
    return { ok: false, error: appError(write ? 'operation_result_unknown' : 'storage_read_failed', write ? 'runtime' : 'storage',
      write ? 'The original resource upload result is unknown.' : 'The original resource upload could not be read.', true) };
  }
  if (!isCloudMaterialCommand(command)) return personalAgentHostFailure(command.type);
  const write = command.type !== 'cloud_material_status';
  return { ok: false, error: appError(write ? 'operation_result_unknown' : 'storage_read_failed', write ? 'runtime' : 'storage',
    write ? 'The upload result is unknown. Query the original upload before retrying.' : 'The upload progress could not be read.', true) };
}

/** Validate every returned identity against the command before it crosses either transport boundary. */
export function parseCloudDesktopResult(command: CloudDesktopCommand, value: unknown): Result<unknown> | null {
  if (isCloudDesktopRelayCommand(command)) {
    const schema = command.type === 'cloud_desktop_next' ? cloudDesktopConnection.extend({ event: CloudDesktopRelayEventSchema.nullable() }).strict() : cloudDesktopConnection;
    const parsed = z.discriminatedUnion('ok', [z.object({ ok: z.literal(true), data: schema }).strict(),
      z.object({ ok: z.literal(false), error: AppErrorSchema }).strict()]).safeParse(value);
    if (!parsed.success) return null;
    if (!parsed.data.ok) return cloudDesktopFailure(command);
    return parsed.data.data.connectionId === command.input.connectionId ? ok(parsed.data.data) : null;
  }
  if (isCloudProgressCommand(command)) {
    const parsed = z.discriminatedUnion('ok', [z.object({ ok: z.literal(true), data: CloudProgressEventSchema }).strict(),
      z.object({ ok: z.literal(false), error: AppErrorSchema }).strict()]).safeParse(value);
    if (!parsed.success) return null;
    if (!parsed.data.ok) return fail(appError(parsed.data.error.code, parsed.data.error.category, 'Cloud progress is unavailable.', parsed.data.error.retryable));
    const data = parsed.data.data, cursor = command.input.cursor;
    if (data.workId !== command.input.workId || data.sessionId !== command.input.sessionId) return null;
    if (!data.resync && (!cursor || data.cursor.generation !== cursor.generation || data.cursor.sequence < cursor.sequence
      || data.changed !== (data.cursor.sequence > cursor.sequence))) return null;
    return { ok: true, data };
  }
  if (isCloudChildReportCommand(command)) {
    const parsed = z.discriminatedUnion('ok', [z.object({ ok: z.literal(true), data: CloudChildReportSchema }).strict(),
      z.object({ ok: z.literal(false), error: AppErrorSchema }).strict()]).safeParse(value);
    if (!parsed.success) return null;
    if (!parsed.data.ok) return fail(appError(parsed.data.error.code, parsed.data.error.category, 'The original child report could not be read.', parsed.data.error.retryable));
    const data = parsed.data.data, input = command.input;
    return data.workId === input.workId && data.sessionId === input.sessionId && data.attemptId === input.attemptId
      && data.childRunId === input.childRunId && data.originToolCallId === input.originToolCallId ? { ok: true, data } : null;
  }
  if (isCloudDeliveryCommand(command)) {
    const schema = command.type === 'cloud_delivery_status' ? CloudRuntimeStatusSchema : CloudRuntimeRetryReceiptSchema;
    const parsed = z.discriminatedUnion('ok', [z.object({ ok: z.literal(true), data: schema }).strict(),
      z.object({ ok: z.literal(false), error: AppErrorSchema }).strict()]).safeParse(value);
    if (!parsed.success) return null;
    if (!parsed.data.ok) {
      const error = parsed.data.error;
      return error.runId === undefined && error.sessionId === undefined && error.toolCallId === undefined
        ? fail(appError(error.code, error.category, 'The cloud result delivery operation could not be completed.', error.retryable)) : null;
    }
    const input = command.input, data = parsed.data.data;
    if (data.workId !== input.workId || data.sessionId !== input.sessionId || data.attemptId !== input.attemptId) return null;
    if (command.type === 'cloud_delivery_retry') return 'requestId' in data && data.requestId === command.input.requestId
      && data.nativeSubmissionId === command.input.nativeSubmissionId ? { ok: true, data } : null;
    return 'results' in data && data.results.items.length <= command.input.limit && (command.input.afterSubmissionId === undefined
      || data.results.items.every(item => item.nativeSubmissionId > command.input.afterSubmissionId!)) ? { ok: true, data } : null;
  }
  if (isCloudReviewCommand(command)) {
    const parsed = z.discriminatedUnion('ok', [z.object({ ok: z.literal(true), data: z.unknown() }).strict(),
      z.object({ ok: z.literal(false), error: AppErrorSchema }).strict()]).safeParse(value);
    if (!parsed.success) return null;
    if (!parsed.data.ok) {
      const error = parsed.data.error;
      return error.runId === undefined && error.sessionId === undefined && error.toolCallId === undefined
        ? fail(appError(error.code, error.category, 'The original cloud invoice could not be read.', error.retryable)) : null;
    }
    if (command.type === 'cloud_review_open') {
      const opened = CloudReviewOpenReceiptSchema.safeParse(parsed.data.data); if (!opened.success) return null;
      const input = command.input, data = opened.data;
      return data.workId === input.workId && data.itemId === input.itemId && data.jobId === input.jobId
        && data.candidateId === input.candidateId && data.documentRef.id === input.documentRef.id
        && data.documentRef.version === input.documentRef.version ? { ok: true, data } : null;
    }
    if (command.type === 'cloud_review_reject' || command.type === 'cloud_review_query_reject') {
      if (parsed.data.data === null && command.type === 'cloud_review_query_reject') return { ok: true, data: null };
      const receipt = CloudReviewRejectReceiptSchema.safeParse(parsed.data.data); if (!receipt.success) return null;
      const input = command.input, data = receipt.data;
      return data.workId === input.workId && data.itemId === input.itemId && data.jobId === input.request.jobId
        && data.candidateId === input.request.candidateId && data.documentRef.id === input.documentRef.id
        && data.documentRef.version === input.documentRef.version ? { ok: true, data } : null;
    }
    if (command.type === 'cloud_review_save' || command.type === 'cloud_review_query_save') {
      if (parsed.data.data === null && command.type === 'cloud_review_query_save') return { ok: true, data: null };
      const receipt = CloudReviewSaveReceiptSchema.safeParse(parsed.data.data); if (!receipt.success) return null;
      const input = command.input, data = receipt.data;
      return data.workId === input.workId && data.itemId === input.itemId && data.jobId === input.request.jobId
        && data.documentRef.id === input.documentRef.id && data.documentRef.version === input.documentRef.version
        && (data.changed ? data.candidateId !== input.request.basedOnCandidateId : data.candidateId === input.request.basedOnCandidateId)
        ? { ok: true, data } : null;
    }
    if (command.type === 'cloud_review_accept' || command.type === 'cloud_review_query_accept') {
      if (parsed.data.data === null && command.type === 'cloud_review_query_accept') return { ok: true, data: null };
      const receipt = CloudReviewAcceptReceiptSchema.safeParse(parsed.data.data); if (!receipt.success) return null;
      const input = command.input, data = receipt.data;
      return data.workId === input.workId && data.itemId === input.itemId && data.jobId === input.request.jobId
        && data.candidateId === input.request.candidateId && data.documentRef.id === input.documentRef.id
        && data.documentRef.version === input.documentRef.version ? { ok: true, data } : null;
    }
    if (command.type === 'cloud_review_candidate') {
      const candidate = CloudReviewCandidateReceiptSchema.safeParse(parsed.data.data); if (!candidate.success) return null;
      const input = command.input, data = candidate.data, detail = data.detail;
      return data.workId === input.workId && data.itemId === input.itemId && detail.jobId === input.jobId
        && detail.candidateId === input.candidateId && detail.documentRef.id === input.documentRef.id
        && detail.documentRef.version === input.documentRef.version ? { ok: true, data } : null;
    }
    if (command.type === 'cloud_review_page') {
      const page = CloudReviewPageReceiptSchema.safeParse(parsed.data.data); if (!page.success) return null;
      const input = command.input, data = page.data, content = data.page;
      return data.workId === input.workId && data.itemId === input.itemId && content.documentRef.id === input.documentRef.id
        && content.documentRef.version === input.documentRef.version && content.page === input.page && content.blocks.length <= input.limit
        && content.blocks.every(block => block.source.documentId === input.documentRef.id && block.source.version === input.documentRef.version
          && block.source.artifactId === content.parsedArtifactId && block.source.page === content.page && block.source.blockId === block.id)
        ? { ok: true, data } : null;
    }
    const original = CloudReviewOriginalReceiptSchema.safeParse(parsed.data.data); if (!original.success) return null;
    const input = command.input, data = original.data;
    return data.workId === input.workId && data.itemId === input.itemId && data.documentRef.id === input.documentRef.id
      && data.documentRef.version === input.documentRef.version ? { ok: true, data } : null;
  }
  if (isCloudQueueCommand(command)) {
    const schema = command.type === 'cloud_queue_read' ? CloudQueueViewSchema
      : command.type === 'cloud_queue_control' ? CloudQueueReceiptSchema : CloudQueueReceiptSchema.nullable();
    const parsed = z.discriminatedUnion('ok', [z.object({ ok: z.literal(true), data: schema }).strict(),
      z.object({ ok: z.literal(false), error: AppErrorSchema }).strict()]).safeParse(value);
    if (!parsed.success) return null;
    if (!parsed.data.ok) {
      const error = parsed.data.error;
      return error.runId === undefined && error.sessionId === undefined && error.toolCallId === undefined
        ? fail(appError(error.code, error.category, 'The cloud queue operation could not be completed.', error.retryable)) : null;
    }
    const data = parsed.data.data;
    if (data === null) return command.type === 'cloud_queue_query_control' ? { ok: true, data: null } : null;
    if (data.workId !== command.input.workId || data.sessionId !== command.input.sessionId || data.attemptId !== command.input.attemptId) return null;
    if (command.type === 'cloud_queue_read') return 'items' in data && new Set(data.items.map(item => item.submissionId)).size === data.items.length
      ? { ok: true, data } : null;
    if (!('controlRequestId' in data) || data.controlRequestId !== command.input.controlRequestId
      || command.type === 'cloud_queue_control' && !matchesCloudQueueReceipt(command.input, data)) return null;
    return { ok: true, data };
  }
  if (isCloudResourceCommand(command)) {
    const schema = command.type === 'cloud_resource_begin' ? z.object({ status: z.enum(['receiving', 'completed']),
      receipt: CloudResourceReceiptSchema.nullable() }).strict() : command.type === 'cloud_resource_status' ? CloudResourceStatusSchema
      : command.type === 'cloud_resource_finish' ? CloudResourceReceiptSchema : z.undefined();
    const parsed = z.discriminatedUnion('ok', [z.object({ ok: z.literal(true), data: schema }).strict(),
      z.object({ ok: z.literal(false), error: AppErrorSchema }).strict()]).safeParse(value);
    if (!parsed.success) return null;
    if (!parsed.data.ok) {
      const error = parsed.data.error;
      return error.runId === undefined && error.sessionId === undefined && error.toolCallId === undefined
        ? fail(appError(error.code, error.category, 'The cloud resource operation could not be completed.', error.retryable)) : null;
    }
    const data = parsed.data.data, input = command.input;
    if (command.type === 'cloud_resource_append') return { ok: true, data };
    if (!data || typeof data !== 'object') return null;
    if (command.type === 'cloud_resource_finish') {
      const receipt = CloudResourceReceiptSchema.safeParse(data);
      return receipt.success && receipt.data.workspaceId === input.workspaceId && receipt.data.uploadId === input.uploadId ? { ok: true, data } : null;
    }
    if (command.type === 'cloud_resource_status') {
      const status = CloudResourceStatusSchema.safeParse(data);
      if (!status.success || status.data.workspaceId !== input.workspaceId || status.data.uploadId !== input.uploadId
        || new Set(status.data.files.map(file => file.path)).size !== status.data.files.length) return null;
      const receipt = status.data.receipt;
      return (status.data.status === 'completed') === (receipt !== null) && (!receipt || receipt.workspaceId === input.workspaceId
        && receipt.uploadId === input.uploadId) ? { ok: true, data } : null;
    }
    if (!('status' in data) || !('receipt' in data)) return null;
    const receipt = data.receipt;
    return (data.status === 'completed') === (receipt !== null) && (!receipt || receipt.workspaceId === input.workspaceId
      && receipt.uploadId === input.uploadId && command.type === 'cloud_resource_begin' && receipt.ref.kind === command.input.ref.kind
      && receipt.ref.id === command.input.ref.id && receipt.ref.version === command.input.ref.version) ? { ok: true, data } : null;
  }
  if (!isCloudMaterialCommand(command)) {
    const parsed = parsePersonalAgentHostResult(command.type, value);
    return parsed && matchesPersonalAgentResponse(command, parsed) ? parsed : null;
  }
  const dataSchema = command.type === 'cloud_material_begin' ? z.object({ status: z.enum(['receiving', 'completed']),
    receipt: CloudMaterialReceiptSchema.nullable() }).strict() : command.type === 'cloud_material_status' ? CloudMaterialStatusSchema
      : command.type === 'cloud_material_finish' ? CloudMaterialReceiptSchema : z.undefined();
  const parsed = z.discriminatedUnion('ok', [z.object({ ok: z.literal(true), data: dataSchema }).strict(),
    z.object({ ok: z.literal(false), error: AppErrorSchema }).strict()]).safeParse(value);
  if (!parsed.success) return null;
  if (!parsed.data.ok) {
    const error = parsed.data.error;
    if (error.runId !== undefined || error.sessionId !== undefined || error.toolCallId !== undefined) return null;
    return fail(appError(error.code, error.category, 'The cloud material operation could not be completed.', error.retryable));
  }
  const data = parsed.data.data;
  const success = { ok: true as const, data };
  if (command.type === 'cloud_material_append') return success;
  if (!data || typeof data !== 'object') return null;
  const identity = command.input;
  if (command.type === 'cloud_material_finish') {
    const receipt = CloudMaterialReceiptSchema.safeParse(data);
    return receipt.success && receipt.data.workspaceId === identity.workspaceId && receipt.data.uploadId === identity.uploadId ? success : null;
  }
  if (command.type === 'cloud_material_status') {
    const status = CloudMaterialStatusSchema.safeParse(data);
    if (!status.success || status.data.workspaceId !== identity.workspaceId || status.data.uploadId !== identity.uploadId
      || new Set(status.data.files.map(file => `${file.kind}:${file.name}`)).size !== status.data.files.length) return null;
    const receipt = status.data.receipt;
    return (status.data.status === 'completed') === (receipt !== null)
      && (!receipt || receipt.workspaceId === identity.workspaceId && receipt.uploadId === identity.uploadId) ? success : null;
  }
  if (!('status' in data) || !('receipt' in data)) return null;
  const receipt = data.receipt;
  return (data.status === 'completed') === (receipt !== null) && (!receipt ||
    receipt.workspaceId === identity.workspaceId && receipt.uploadId === identity.uploadId
      && receipt.sourceDocumentRef.id === command.input.sourceDocumentRef.id
      && receipt.sourceDocumentRef.version === command.input.sourceDocumentRef.version) ? success : null;
}
