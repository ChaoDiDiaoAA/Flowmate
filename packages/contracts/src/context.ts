import { z } from 'zod';
import { RunCompactionEvidenceSchema } from './compaction.ts';
import type { RunCompactionEvidence } from './compaction.ts';
import { AppErrorSchema } from './runtime.ts';
import type { AppError, Result } from './runtime.ts';
import { CONTEXT_ERROR_FACTS } from './errors.ts';
export { CONTEXT_ERROR_FACTS } from './errors.ts';
import { DocumentRefSchema, InvoiceIssueSchema, ParsedBlockSchema, SourceRefSchema, StoredInvoiceFieldSchema,
  invoiceHeaderFields, invoiceLineFields, MAX_INVOICE_BLOCKS_PER_PAGE, MAX_INVOICE_LINES, MAX_INVOICE_PAGES } from './invoice.ts';
import { WorkspaceContextSchema, WorkspaceInputSchema, WorkspaceSelectionSchema } from './workspace.ts';
import { WorkingDirectorySchema } from './schemas.ts';

const id = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const nonnegative = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const opaqueId = z.string().min(1).max(256);
const time = z.string().datetime().refine(value => Number.isFinite(Date.parse(value))
  && new Date(value).toISOString().slice(0, 19) === value.slice(0, 19),
  'Expected a valid UTC fact time.');
const goalMode = z.enum(['answer', 'save-candidate', 'fill-form']);
const encoder = new TextEncoder();
const textBytes = (value: string) => encoder.encode(value).byteLength;
const jsonBytes = (value: unknown) => textBytes(JSON.stringify(value));
const userText = z.string().refine(value => value.trim().length > 0 && textBytes(value) <= 65000, 'Input text exceeds its UTF-8 budget.');
const report = (context: z.RefinementCtx, message: string) => context.addIssue({ code: 'custom', message });
const unique = (values: readonly unknown[]) => new Set(values.map(value => JSON.stringify(value))).size === values.length;
const fieldPath = z.string().max(256).refine(value => {
  const header = /^fields\.([A-Za-z]+)$/.exec(value);
  if (header) return invoiceHeaderFields.some(name => name === header[1]);
  const line = /^lines\.(0|[1-9]\d*)\.([A-Za-z]+)$/.exec(value);
  return !!line && Number(line[1]) < MAX_INVOICE_LINES && invoiceLineFields.some(name => name === line[2]);
}, 'Unregistered candidate field path.');

/** Explicit product codes used by admission, execution and saved Input evidence. SDK text is never a code. */
export const CONTEXT_SAFE_ERROR_CODES = [
  'context_evidence_too_large', 'context_binding_unknown', 'context_binding_conflict', 'context_payload_mismatch',
  'context_snapshot_not_found', 'provider_transport_error', 'internal_error',
  'input_invalid', 'input_too_large', 'input_unavailable', 'input_admission_closed', 'input_delivery_unknown',
  'input_not_consumed', 'input_processing_unconfirmed', 'operation_cancelled', 'operation_result_unknown',
  'state_conflict', 'storage_corrupt', 'storage_read_failed', 'storage_write_failed', 'run_not_found', 'run_state_invalid',
  'runtime_busy', 'runtime_interrupted', 'runtime_not_started', 'runtime_shutdown', 'runtime_unusable', 'model_access_revocation_failed',
  'session_not_found', 'session_busy', 'session_archived', 'session_scope_revoked', 'session_history_invalid',
  'session_history_unavailable', 'session_input_unavailable', 'session_branch_unavailable', 'session_delete_in_progress',
  'session_delete_incomplete', 'workspace_unavailable', 'selection_invalid', 'source_invalid', 'artifact_unavailable',
  'document_version_conflict', 'agent_auth_source_unknown', 'agent_cancelled', 'agent_cleanup_failed', 'agent_close_failed',
  'agent_config_invalid', 'agent_content_limit', 'agent_context_limit', 'agent_execution_failed', 'agent_execution_invalid',
  'agent_goal_not_met', 'agent_image_history_blocked', 'agent_incomplete_response', 'agent_input_unavailable',
  'agent_mechanical_check_failed', 'agent_model_call_budget', 'agent_model_image_unsupported', 'agent_model_switch_failed', 'agent_output_limit',
  'agent_port_closed', 'agent_runtime_error', 'agent_runtime_init_failed', 'agent_session_busy', 'agent_session_init_failed',
  'agent_session_missing', 'agent_session_unavailable', 'agent_session_unusable', 'agent_stop_unconfirmed', 'agent_timeout',
  'agent_unavailable', 'agent_unbound_execution', 'agent_unexpected_continuation', 'agent_unexpected_tool_call', 'provider_auth_failed', 'provider_cancelled',
  'provider_close_failed', 'provider_error', 'provider_incomplete_response', 'provider_model_limits_missing',
  'provider_model_not_found', 'provider_network_error', 'provider_rate_limited', 'provider_request_rejected',
  'provider_runtime_error', 'provider_runtime_init_failed', 'provider_stop_unconfirmed', 'provider_stream_interrupted',
  'provider_timeout', 'stop_not_confirmed', 'stop_unconfirmed', 'tool_access_denied', 'tool_execution_failed',
  'tool_execution_not_started', 'tool_execution_unconfirmed', 'tool_feedback_conflict', 'tool_invalid_input',
  'tool_not_found', 'tool_result_too_large', 'tool_runtime_unavailable', 'tool_sdk_after_failed', 'config_settings_invalid',
  'compaction_unavailable', 'compaction_not_needed', 'compaction_failed', 'compaction_cancelled',
  'compaction_timeout', 'compaction_capacity_exceeded',
] as const;
export const ContextSafeErrorCodeSchema = z.enum(CONTEXT_SAFE_ERROR_CODES);
export type ContextSafeErrorCode = z.infer<typeof ContextSafeErrorCodeSchema>;
function checkErrorFacts(error: { code: ContextSafeErrorCode; category: AppError['category']; retryable: boolean }, context: z.RefinementCtx) {
  const facts = CONTEXT_ERROR_FACTS[error.code];
  if (facts && (error.category !== facts[0] || error.retryable !== facts[1])) report(context, 'Context error facts disagree with its registered code.');
}
export const ContextInputErrorSchema = z.object({ code: ContextSafeErrorCodeSchema,
  category: AppErrorSchema.shape.category, retryable: z.boolean() }).strict().superRefine(checkErrorFacts);
export const ContextErrorSchema = AppErrorSchema.extend({ code: ContextSafeErrorCodeSchema }).strict().superRefine(checkErrorFacts);

export const ContextReferenceSchema = z.object({ snapshotId: id, requestSequence: id }).strict().readonly();
export type ContextReference = z.infer<typeof ContextReferenceSchema>;
export const ContextCandidateValueSchema = z.object({ fieldPath, value: StoredInvoiceFieldSchema }).strict().readonly();
export type ContextCandidateValue = z.infer<typeof ContextCandidateValueSchema>;
export const ContextWindowSchema = z.object({ start: nonnegative, end: id, text: z.string().min(1) }).strict()
  .refine(value => value.end > value.start && value.text.length === value.end - value.start, 'Invalid window interval.').readonly();
export const ContextFragmentSchema = z.object({
  documentRef: DocumentRefSchema, artifactId: id, page: z.number().int().min(1).max(MAX_INVOICE_PAGES),
  blockId: z.string().regex(/^b[1-9]\d{0,3}$/),
  reasons: z.array(z.enum(['selection', 'candidate-source', 'selected-page', 'document-prefix'])).min(1).max(4).readonly(),
  sources: z.array(SourceRefSchema).max(8 * (invoiceHeaderFields.length + MAX_INVOICE_LINES * invoiceLineFields.length) + 1).readonly(),
  windows: z.array(ContextWindowSchema).max(4096).readonly(), originalBytes: nonnegative,
  includedBytes: nonnegative.max(4096), truncated: z.boolean(),
}).strict().superRefine((value, context) => {
  if (!unique(value.reasons) || !unique(value.sources)) report(context, 'Fragment reasons and sources must be unique.');
  if (value.windows.reduce((sum, window) => sum + textBytes(window.text), 0) !== value.includedBytes
    || value.includedBytes > value.originalBytes) report(context, 'Fragment UTF-8 byte facts disagree.');
  if (value.windows.some((window, index) => index > 0 && window.start < value.windows[index - 1]!.end))
    report(context, 'Windows must be ordered and disjoint.');
  if (value.sources.some(source => source.documentId !== value.documentRef.id || source.version !== value.documentRef.version
    || source.artifactId !== value.artifactId || source.page !== value.page || source.blockId !== null && source.blockId !== value.blockId))
    report(context, 'Fragment source locators disagree.');
}).readonly();
export type ContextFragment = z.infer<typeof ContextFragmentSchema>;
export const ContextGapSchema = z.object({
  code: z.enum(['no-business-material', 'candidate_fields_omitted', 'source_window_omitted',
    'document_fragments_omitted', 'issues_omitted', 'source_has_no_text']),
  fieldPaths: z.array(fieldPath).max(invoiceHeaderFields.length + MAX_INVOICE_LINES * invoiceLineFields.length).readonly(),
  source: SourceRefSchema.nullable(), omittedCount: nonnegative,
}).strict().refine(value => unique(value.fieldPaths), 'Gap paths must be unique.').readonly();
export type ContextGap = z.infer<typeof ContextGapSchema>;
const candidateSchema = z.object({ id, sequence: id, origin: z.enum(['model', 'human_edit']),
  statusAtSelection: z.enum(['generated', 'accepted', 'rejected']),
  values: z.array(ContextCandidateValueSchema).max(invoiceHeaderFields.length + MAX_INVOICE_LINES * invoiceLineFields.length).readonly(),
}).strict().refine(value => unique(value.values.map(item => item.fieldPath)), 'Candidate paths must be unique.');
export const ContextProjectionSchema = z.object({ taskGoal: z.string().nullable(), candidate: candidateSchema.nullable(),
  fragments: z.array(ContextFragmentSchema).max(32).readonly(), issues: z.array(InvoiceIssueSchema).max(20).readonly(),
  gaps: z.array(ContextGapSchema).max(invoiceHeaderFields.length + MAX_INVOICE_LINES * invoiceLineFields.length + 33).readonly(),
}).strict().superRefine((value, context) => {
  if (!unique(value.fragments.map(item => [item.documentRef.id, item.documentRef.version, item.artifactId, item.page, item.blockId])))
    report(context, 'Fragment locators must be unique.');
  if (!unique(value.gaps.map(item => [item.code, item.source]))) report(context, 'Equivalent gaps must be aggregated.');
  if (jsonBytes(value) > 65536) report(context, 'Projection exceeds 65536 UTF-8 bytes.');
}).readonly();
export type ContextProjection = z.infer<typeof ContextProjectionSchema>;
export const ContextBudgetsSchema = z.object({ projectionBytes: z.literal(65536), fragmentBytes: z.literal(4096),
  fragments: z.literal(32), issueCount: z.literal(20), snapshotBytes: z.literal(262144) }).strict();
const publicJsonShape = { version: z.literal(1), policyVersion: z.literal('p8-context-v1'), text: userText, goalMode,
  workspaceContext: WorkspaceContextSchema.nullable(), resourcePolicy: z.literal('none'),
  modelProjection: ContextProjectionSchema, budgets: ContextBudgetsSchema };
function checkProjectionMode(value: { goalMode: string; modelProjection: ContextProjection }, context: z.RefinementCtx) {
  if (value.goalMode === 'fill-form' && (value.modelProjection.candidate === null
    || value.modelProjection.candidate.values.length !== 0 || value.modelProjection.fragments.length !== 0))
    report(context, 'Fill snapshots contain references rather than a candidate body.');
}
export const ContextSnapshotJsonSchema = z.object({ ...publicJsonShape, workingDirectory: WorkingDirectorySchema.nullable(),
  allowedDocumentIds: z.array(id).max(64).readonly(), allowedArtifactIds: z.array(id).max(128).readonly(),
}).strict().superRefine((value, context) => {
  checkProjectionMode(value, context);
  if (!unique(value.allowedDocumentIds) || !unique(value.allowedArtifactIds)) report(context, 'Context allowlists must be unique.');
  if (jsonBytes(value) > 262144) report(context, 'Snapshot JSON exceeds 262144 UTF-8 bytes.');
}).readonly();
export type ContextSnapshotJson = z.infer<typeof ContextSnapshotJsonSchema>;
const snapshotIdentity = { id, sessionId: id, runId: id, jobId: id.nullable(), sequence: id, createdAt: time };
export const ContextSnapshotSchema = z.object({ ...snapshotIdentity, json: ContextSnapshotJsonSchema }).strict()
  .refine(value => value.json.workspaceContext === null || value.json.workspaceContext.sessionId === value.sessionId
    && value.json.workspaceContext.jobId === value.jobId, 'Snapshot and frozen Workspace identity disagree.').readonly();
export type ContextSnapshot = z.infer<typeof ContextSnapshotSchema>;
export const ContextBuildRequestSchema = z.object({ runId: id, sessionId: id, jobId: id.nullable(), text: userText, goalMode,
  workspaceContext: WorkspaceContextSchema.nullable(), workspaceInput: WorkspaceInputSchema.nullable(),
  allowedDocumentIds: z.array(id).max(64).readonly(), allowedArtifactIds: z.array(id).max(128).readonly(),
  workingDirectory: WorkingDirectorySchema.nullable(), createdAt: time,
}).strict().superRefine((value, context) => {
  if (value.workspaceContext && (value.workspaceContext.sessionId !== value.sessionId || value.workspaceContext.jobId !== value.jobId))
    report(context, 'Build and frozen Workspace identity disagree.');
  if (!unique(value.allowedDocumentIds) || !unique(value.allowedArtifactIds)) report(context, 'Build allowlists must be unique.');
}).readonly();
export type ContextBuildRequest = z.infer<typeof ContextBuildRequestSchema>;
export const ContextBuildResultSchema = z.object({ snapshot: ContextSnapshotSchema, promptText: z.string().min(1) }).strict().readonly();
export type ContextBuildResult = z.infer<typeof ContextBuildResultSchema>;
export const ContextMaterialRequestSchema = z.object({ documentRef: DocumentRefSchema,
  allowedDocumentIds: z.array(id).max(64).readonly(), allowedArtifactIds: z.array(id).max(128).readonly() }).strict().readonly();
const documentSchema = z.object({ documentRef: DocumentRefSchema, displayName: z.string(), isHidden: z.boolean(),
  status: z.enum(['available', 'unavailable']), pageCount: z.number().int().min(1).max(MAX_INVOICE_PAGES),
  originalArtifactId: id, parsedArtifactId: id, warnings: z.array(z.string()), unavailableReason: z.string().nullable(),
  createdAt: time, updatedAt: time }).strict();
export const ContextParsedMaterialSchema = z.object({ document: documentSchema,
  parsed: z.object({ formatVersion: z.literal(2), pages: z.array(z.object({
    page: z.number().int().min(1).max(MAX_INVOICE_PAGES), blocks: z.array(ParsedBlockSchema).max(MAX_INVOICE_BLOCKS_PER_PAGE).readonly(),
  }).strict()).max(MAX_INVOICE_PAGES).readonly(),
  completeness: z.object({ status: z.literal('complete'), checks: z.array(z.string()), warnings: z.array(z.string()) }).strict(),
  }).strict(),
}).strict().readonly();
export type ContextParsedMaterial = z.infer<typeof ContextParsedMaterialSchema>;
export interface ContextMaterialPort { inspectParsed(input: z.infer<typeof ContextMaterialRequestSchema>): Result<ContextParsedMaterial> }

export const NativeInputContextBindingSchema = z.object({ originRunId: id.nullable(), inputId: id.nullable(),
  nativeEntryId: opaqueId, snapshotId: id.nullable() }).strict()
  .refine(value => value.inputId === null ? value.snapshotId === null : value.originRunId !== null,
    'Input identity requires its Run; a pre-ledger entry has no snapshot.').readonly();
export type NativeInputContextBinding = z.infer<typeof NativeInputContextBindingSchema>;
export type NativeContextBindingSeed = NativeInputContextBinding;
export const NativeToolResultContextBindingSchema = z.object({ nativeToolCallId: opaqueId, toolCallId: id.nullable(),
  originRunId: id.nullable(), context: ContextReferenceSchema.nullable() }).strict()
  .refine(value => (value.toolCallId === null) === (value.originRunId === null)
    && (value.context === null || value.toolCallId !== null), 'Tool result identity and context are inconsistent.').readonly();
export type NativeToolResultContextBinding = z.infer<typeof NativeToolResultContextBindingSchema>;
export const NativeDerivedContextBindingSchema = z.object({ nativeEntryId: opaqueId, originSessionId: id,
  entryType: z.enum(['message', 'custom_message', 'compaction', 'branch_summary']),
  messageRole: z.enum(['bashExecution', 'custom', 'compactionSummary', 'branchSummary']),
  contextMessageIndex: nonnegative, referenceEntryIds: z.array(opaqueId).readonly(),
}).strict().superRefine((value, context) => {
  const expected = { custom_message: 'custom', compaction: 'compactionSummary', branch_summary: 'branchSummary' };
  if (value.entryType !== 'message' && expected[value.entryType] !== value.messageRole)
    report(context, 'Derived entry and message role disagree.');
  if (!unique(value.referenceEntryIds) || value.entryType !== 'compaction' && value.referenceEntryIds.includes('root'))
    report(context, 'References contain actual unique entry IDs; only compaction may reference an entry named root.');
}).readonly();
export type NativeDerivedContextBinding = z.infer<typeof NativeDerivedContextBindingSchema>;
const requestBindingShape = { runId: id, sessionId: id, nativeSessionId: opaqueId,
  requestSequence: id, callSequence: id, inputId: id, snapshotId: id,
  includedBindings: z.array(NativeInputContextBindingSchema).max(512).readonly(),
  includedToolResults: z.array(NativeToolResultContextBindingSchema).max(512).readonly(),
};
function checkRequestBinding(value: z.infer<z.ZodObject<typeof requestBindingShape>> & {
  includedNativeContexts?: readonly NativeDerivedContextBinding[] | null }, context: z.RefinementCtx) {
  const primary = [...value.includedBindings].reverse().find(item => item.originRunId === value.runId && item.snapshotId !== null);
  if (primary ? primary.inputId !== value.inputId || primary.snapshotId !== value.snapshotId
    : !value.includedNativeContexts?.some(source => source.entryType === 'compaction'))
    report(context, 'Primary binding requires the last current Run source or a committed compaction proof.');
  if (value.callSequence !== value.requestSequence) report(context, 'Call and logical request sequences disagree.');
  if (value.includedBindings.length + value.includedToolResults.length + (value.includedNativeContexts?.length ?? 0) > 512)
    report(context, 'Combined request provenance exceeds 512 entries.');
  if (value.includedNativeContexts && !unique(value.includedNativeContexts.map(item => item.contextMessageIndex)))
    report(context, 'Derived context positions must be unique.');
}
export const LegacyRequestContextBindingSchema = z.object(requestBindingShape).strict().superRefine(checkRequestBinding).readonly();
export const RequestContextBindingSchema = z.object({ ...requestBindingShape,
  includedNativeContexts: z.array(NativeDerivedContextBindingSchema).max(512).readonly(),
}).strict().superRefine(checkRequestBinding).readonly();
export type RequestContextBinding = z.infer<typeof RequestContextBindingSchema>;
export const PublicRequestContextBindingSchema = z.object({ ...requestBindingShape,
  includedNativeContexts: z.array(NativeDerivedContextBindingSchema).max(512).readonly().nullable(),
}).strict().superRefine(checkRequestBinding).readonly();
export type PublicRequestContextBinding = z.infer<typeof PublicRequestContextBindingSchema>;
export const ContextEvidenceReasonSchema = z.enum(['payload_codec_unavailable', 'fetch_unavailable', 'body_unavailable']);
export type ContextEvidenceReason = z.infer<typeof ContextEvidenceReasonSchema>;
const inclusionShape = { inclusion: z.enum(['confirmed', 'unavailable']), reason: ContextEvidenceReasonSchema.nullable() };
function checkInclusion(value: { inclusion: string; reason: string | null }, context: z.RefinementCtx) {
  if ((value.inclusion === 'confirmed') !== (value.reason === null)) report(context, 'Inclusion requires an explicit and consistent evidence reason.');
}
export const ContextSdkPayloadEvidenceSchema = z.object({ observedAt: time.nullable(), ...inclusionShape }).strict()
  .superRefine((value, context) => {
    checkInclusion(value, context);
    if (value.inclusion === 'confirmed' && value.observedAt === null) report(context, 'Confirmed payload requires observation time.');
  });
export const ContextTransportEvidenceSchema = z.object({ attempt: id.max(2), preparedAt: time, enteredAt: time.nullable(),
  responseAt: time.nullable(), responseStatus: z.number().int().min(100).max(599).nullable(),
  transportErrorCode: ContextSafeErrorCodeSchema.nullable(), nativeRequestId: opaqueId.nullable(),
  wireInclusion: inclusionShape.inclusion, wireReason: inclusionShape.reason,
}).strict().superRefine((value, context) => {
  checkInclusion({ inclusion: value.wireInclusion, reason: value.wireReason }, context);
  if ((value.responseAt === null) !== (value.responseStatus === null) || value.nativeRequestId !== null && value.responseAt === null
    || value.transportErrorCode !== null && value.responseAt !== null) report(context, 'Response and transport failure facts are inconsistent.');
}).readonly();
export type ContextTransportEvidence = z.infer<typeof ContextTransportEvidenceSchema>;
export const ContextApiSchema = z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/);
const requestEvidenceShape = { api: ContextApiSchema, boundAt: time,
  sdkPayload: ContextSdkPayloadEvidenceSchema.nullable(), transport: z.enum(['observed-fetch', 'not-observable']),
  attempts: z.array(ContextTransportEvidenceSchema).max(2).readonly(),
};
function checkRequestEvidence(value: z.infer<z.ZodObject<typeof requestEvidenceShape>>, context: z.RefinementCtx) {
  if (value.transport === 'not-observable' && value.attempts.length !== 0) report(context, 'Unobserved transport cannot invent fetch attempts.');
  if (value.attempts.some((item, index) => item.attempt !== index + 1)) report(context, 'Attempt sequences must be continuous.');
}
export const ContextRequestEvidenceSchema = z.object({ binding: RequestContextBindingSchema, ...requestEvidenceShape })
  .strict().superRefine(checkRequestEvidence).readonly();
export type ContextRequestEvidence = z.infer<typeof ContextRequestEvidenceSchema>;
export const LegacyContextRequestEvidenceSchema = z.object({ binding: LegacyRequestContextBindingSchema, ...requestEvidenceShape })
  .strict().superRefine(checkRequestEvidence).readonly();
export const PublicContextRequestEvidenceSchema = z.object({ binding: PublicRequestContextBindingSchema, ...requestEvidenceShape })
  .strict().superRefine(checkRequestEvidence).readonly();
export type PublicContextRequestEvidence = z.infer<typeof PublicContextRequestEvidenceSchema>;
function checkObservations(value: { requests: readonly { binding: { requestSequence: number; runId: number; sessionId: number; nativeSessionId: string } }[];
  compactions?: readonly RunCompactionEvidence[] }, context: z.RefinementCtx) {
  if (value.requests.some((item, index) => item.binding.requestSequence !== index + 1)) report(context, 'Journal requests must start at one and be continuous.');
  const first = value.requests[0]?.binding;
  if (first && value.requests.some(item => item.binding.runId !== first.runId || item.binding.sessionId !== first.sessionId
    || item.binding.nativeSessionId !== first.nativeSessionId)) report(context, 'Journal requests must belong to one native Run and Session.');
  const summaryOwner = value.compactions?.[0];
  const owner = first ?? summaryOwner;
  if (owner && value.compactions?.some(item => item.runId !== owner.runId || item.sessionId !== owner.sessionId
    || item.nativeSessionId !== owner.nativeSessionId)) report(context, 'Summary evidence must retain the journal owner.');
  if (value.compactions && !unique(value.compactions.map(item => item.operationId)))
    report(context, 'Compaction operations must be unique within the journal.');
  const callIndices = value.compactions?.flatMap(item => item.calls.map(call => call.modelCallIndex));
  if (callIndices && !unique(callIndices)) report(context, 'Summary model calls cannot be counted twice.');
  if (jsonBytes(value) > 4194304) report(context, 'Journal exceeds 4 MiB.');
}
// Legacy storage parsing preserves field omission and original serialization; it never backfills proof.
const storedObservations = z.object({ version: z.literal(1), requests: z.array(z.union([
  ContextRequestEvidenceSchema, LegacyContextRequestEvidenceSchema,
])).max(64).readonly(), compactions: z.array(z.lazy(() => RunCompactionEvidenceSchema)).max(64).readonly().optional()
}).strict().superRefine(checkObservations).readonly();
export const ContextObservationsSchema = z.unknown().superRefine((raw, context) => {
  const parsed = storedObservations.safeParse(raw);
  if (!parsed.success) for (const error of parsed.error.issues) context.addIssue(error);
}).transform(raw => raw as z.output<typeof storedObservations>);
export type ContextObservations = z.infer<typeof ContextObservationsSchema>;
export const NativeContextObservationsSchema = z.object({ version: z.literal(1),
  requests: z.array(ContextRequestEvidenceSchema).max(64).readonly(),
  compactions: z.array(z.lazy(() => RunCompactionEvidenceSchema)).max(64).readonly().optional()
}).strict().superRefine(checkObservations).readonly();
export const PublicContextObservationsSchema = z.object({ version: z.literal(1),
  requests: z.array(PublicContextRequestEvidenceSchema).max(64).readonly(),
  compactions: z.array(z.lazy(() => RunCompactionEvidenceSchema)).max(64).readonly().optional()
}).strict().superRefine(checkObservations).readonly();
export type PublicContextObservations = z.infer<typeof PublicContextObservationsSchema>;
export function readContextObservations(raw: unknown, historyPolicyVersion?: 'p9-native-history-v1'): Result<PublicContextObservations> {
  const parsed = (historyPolicyVersion === 'p9-native-history-v1' ? NativeContextObservationsSchema : ContextObservationsSchema).safeParse(raw);
  if (!parsed.success) return { ok: false, error: { code: 'context_binding_unknown', category: 'runtime',
    message: 'Stored native context evidence is invalid or was not collected.', retryable: false } };
  const projected = PublicContextObservationsSchema.safeParse({ ...parsed.data, requests: parsed.data.requests.map(request => ({
    ...request, binding: { ...request.binding, includedNativeContexts: 'includedNativeContexts' in request.binding
      ? request.binding.includedNativeContexts : null },
  })) });
  return projected.success ? { ok: true, data: projected.data } : { ok: false, error: { code: 'context_binding_unknown', category: 'runtime',
    message: 'Public native context evidence is invalid.', retryable: false } };
}
export const ContextEvidenceUpdateSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('sdk-payload'), at: time, ...inclusionShape }).strict(),
  z.object({ kind: z.literal('attempt-prepared'), evidence: ContextTransportEvidenceSchema }).strict(),
  z.object({ kind: z.literal('attempt-entered'), attempt: id.max(2), at: time }).strict(),
  z.object({ kind: z.literal('response'), attempt: id.max(2), at: time,
    status: z.number().int().min(100).max(599), nativeRequestId: opaqueId.nullable() }).strict(),
  z.object({ kind: z.literal('transport-failed'), attempt: id.max(2), at: time, code: ContextSafeErrorCodeSchema }).strict(),
]).superRefine((value, context) => { if (value.kind === 'sdk-payload') checkInclusion(value, context); }).readonly();
export type ContextEvidenceUpdate = z.infer<typeof ContextEvidenceUpdateSchema>;
export type ContextHooks = {
  compaction?: (value: RunCompactionEvidence) => Result<void>;
  resolveToolResult(input: Readonly<{ sessionId: number; nativeToolCallId: string }>): Result<NativeToolResultContextBinding>;
  bind(input: Readonly<{ binding: RequestContextBinding; api: string; transport: ContextRequestEvidence['transport']; at: string }>): Result<void>;
  record(binding: RequestContextBinding, update: ContextEvidenceUpdate): Result<void>;
};

const limit = z.number().int().min(1).max(20).default(20);
export const ContextSnapshotsRequestSchema = z.object({ sessionId: id, runId: id.optional(), beforeId: id.optional(), limit }).strict();
export type ContextSnapshotsRequest = z.input<typeof ContextSnapshotsRequestSchema>;
export const ContextSnapshotRequestSchema = z.object({ sessionId: id, runId: id, snapshotId: id }).strict();
export type ContextSnapshotRequest = z.infer<typeof ContextSnapshotRequestSchema>;
export const ContextRequestsRequestSchema = z.object({ sessionId: id, runId: id, beforeRequestSequence: id.optional(), limit }).strict();
export type ContextRequestsRequest = z.input<typeof ContextRequestsRequestSchema>;
export const ContextSnapshotSummarySchema = z.object({ ...snapshotIdentity, inputId: id,
  mode: z.enum(['prompt', 'steer', 'followUp']), documentRef: DocumentRefSchema.nullable(),
  candidateRef: z.object({ id, sequence: id }).strict().nullable(), selection: WorkspaceSelectionSchema.nullable(),
  fragmentCount: nonnegative.max(32), gapCount: nonnegative,
}).strict().readonly();
export type ContextSnapshotSummary = z.infer<typeof ContextSnapshotSummarySchema>;
export const ContextSnapshotsPageSchema = z.object({ sessionId: id, runId: id.nullable(),
  items: z.array(ContextSnapshotSummarySchema).max(20).readonly(), nextBeforeId: id.nullable() }).strict()
  .superRefine((value, context) => {
    if (value.items.some((item, index) => item.sessionId !== value.sessionId || value.runId !== null && item.runId !== value.runId
      || index > 0 && item.id >= value.items[index - 1]!.id)) report(context, 'Snapshot page identity or order is inconsistent.');
    if (value.nextBeforeId !== null && value.nextBeforeId !== value.items.at(-1)?.id) report(context, 'Snapshot cursor must be its last delivered item.');
  });
export type ContextSnapshotsPage = z.infer<typeof ContextSnapshotsPageSchema>;
export const PublicContextSnapshotJsonSchema = z.object({ ...publicJsonShape, hasWorkingDirectory: z.boolean() }).strict()
  .superRefine((value, context) => {
    checkProjectionMode(value, context);
    if (jsonBytes(value) > 262144) report(context, 'Public snapshot JSON exceeds 262144 UTF-8 bytes.');
  }).readonly();
export type PublicContextSnapshotJson = z.infer<typeof PublicContextSnapshotJsonSchema>;
export const PublicContextSnapshotSchema = z.object({ ...snapshotIdentity, json: PublicContextSnapshotJsonSchema }).strict()
  .refine(value => value.json.workspaceContext === null || value.json.workspaceContext.sessionId === value.sessionId
    && value.json.workspaceContext.jobId === value.jobId, 'Public snapshot and frozen Workspace identity disagree.').readonly();
export type PublicContextSnapshot = z.infer<typeof PublicContextSnapshotSchema>;
export const ContextInputEvidenceSchema = z.object({ inputId: id, sessionId: id, clientSequence: id,
  mode: z.enum(['prompt', 'steer', 'followUp']), goalMode, runId: id.nullable(),
  status: z.enum(['queued', 'consumed', 'failed', 'cancelled', 'delivery_unknown']),
  processingStatus: z.enum(['pending', 'completed', 'failed', 'cancelled']), nativeEntryId: opaqueId.nullable(),
  resultEntryId: opaqueId.nullable(), dispatchedAt: time.nullable(), createdAt: time, updatedAt: time,
  error: ContextInputErrorSchema.nullable(),
}).strict().refine(value => (value.status === 'consumed') === (value.nativeEntryId !== null)
  && (value.resultEntryId === null || value.status === 'consumed')
  && (value.processingStatus !== 'completed' || value.status === 'consumed'), 'Input evidence contradicts its native status.');
export type ContextInputEvidence = z.infer<typeof ContextInputEvidenceSchema>;
export const ContextSnapshotDetailSchema = z.object({ snapshot: PublicContextSnapshotSchema, input: ContextInputEvidenceSchema }).strict()
  .refine(value => value.input.sessionId === value.snapshot.sessionId && value.input.runId === value.snapshot.runId,
    'Detail Input must belong to its snapshot Run and Session.');
export type ContextSnapshotDetail = z.infer<typeof ContextSnapshotDetailSchema>;
export const ContextRequestsPageSchema = z.object({ sessionId: id, runId: id, collection: z.enum(['not-collected', 'collected']),
  items: z.array(PublicContextRequestEvidenceSchema).max(20).readonly(), nextBeforeRequestSequence: id.nullable() }).strict()
  .superRefine((value, context) => {
    if (value.collection === 'not-collected' && (value.items.length !== 0 || value.nextBeforeRequestSequence !== null))
      report(context, 'Uncollected requests cannot contain invented evidence.');
    if (value.items.some((item, index) => item.binding.sessionId !== value.sessionId || item.binding.runId !== value.runId
      || index > 0 && item.binding.requestSequence >= value.items[index - 1]!.binding.requestSequence))
      report(context, 'Request page identity or order is inconsistent.');
    if (value.nextBeforeRequestSequence !== null && value.nextBeforeRequestSequence !== value.items.at(-1)?.binding.requestSequence)
      report(context, 'Request cursor must be its last delivered item.');
  });
export type ContextRequestsPage = z.infer<typeof ContextRequestsPageSchema>;
function resultSchema<T extends z.ZodTypeAny>(data: T, maximumBytes: number) {
  return z.discriminatedUnion('ok', [z.object({ ok: z.literal(true), data }).strict(),
    z.object({ ok: z.literal(false), error: ContextErrorSchema, runId: id.optional() }).strict()])
    .refine(value => !value.ok || jsonBytes(value) <= maximumBytes, 'Complete Context Result exceeds its UTF-8 budget.');
}
export const ContextSnapshotsResultSchema = resultSchema(ContextSnapshotsPageSchema, 131072);
export const ContextSnapshotResultSchema = resultSchema(ContextSnapshotDetailSchema, 524288);
export const ContextRequestsResultSchema = resultSchema(ContextRequestsPageSchema, 1048576);
