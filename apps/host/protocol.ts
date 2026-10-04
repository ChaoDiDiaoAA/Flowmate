import { z } from 'zod';
import type { AgentRunEvent, DesktopState, ModelAuthNotice, ModelAuthPrompt } from '@flowmate/contracts';
import { InvoiceFormApplicationReceiptSchema, InvoiceFormTargetSchema, SessionInputQuerySchema,
  SessionInputsRequestSchema, SetSessionStatusRequestSchema, BranchSessionRequestSchema,
  SessionMessagesRequestSchema, WorkingDirectorySchema, WorkspaceExpectationSchema, SaveInvoiceCandidateRequestSchema,
  AcceptInvoiceCandidateRequestSchema, RejectInvoiceCandidateRequestSchema, ExportInvoiceCandidateRequestSchema,
  InvoiceCandidateOperationQuerySchema, RuntimeRequestOverridesSchema, RUNTIME_CONFIG,
  RuntimeEventsQuerySchema, RuntimeEventsSubscriptionRequestSchema, RuntimeSubscriptionIdSchema,
  RunToolCallsRequestSchema, RunToolCallRequestSchema, RuntimeEventsReadResultSchema, RuntimeSubscriptionResultSchema,
  RuntimeSubscriptionReleaseResultSchema, RuntimeToolPageResultSchema, RuntimeToolResultSchema,
  WorkspaceUpdateRequestSchema, WorkspaceSnapshotSchema, WorkspaceRestoreResultSchema, AppErrorSchema, invoiceToolSchemas,
  ContextSnapshotsRequestSchema, ContextSnapshotRequestSchema, ContextRequestsRequestSchema,
  ContextSnapshotsResultSchema, ContextSnapshotResultSchema, ContextRequestsResultSchema } from '@flowmate/contracts';
import type { InvoiceFormBridgeRequest } from '@flowmate/contracts';

const requestId = z.string().min(1).max(128);
const ownerToken = z.string().min(1).max(256);
const modelId = z.string().regex(/^[a-zA-Z0-9._-]{1,64}$/);
const dbId = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const pageLimit = z.number().int().min(1).max(100);
const sessionTitle = z.string().trim().min(1).refine((value) => [...value].length <= 120 && new TextEncoder().encode(value).byteLength <= 480);
const credentialRef = z.string().regex(/^[a-zA-Z0-9_-]{16,80}$/);
const boundedText = z.string().refine((value) => new TextEncoder().encode(value).byteLength <= 65_536);
const inputText = z.string().refine(value => value.trim().length > 0 && new TextEncoder().encode(value).byteLength <= 65_000);
export const DesktopSessionInputRequestSchema = z.discriminatedUnion('mode', [
  z.object({ sessionId: dbId, clientSequence: dbId, mode: z.literal('prompt'), text: inputText, modelId,
    goalMode: z.enum(['answer', 'save-candidate']).default('answer'), workspace: WorkspaceExpectationSchema.optional(),
    workingDirectory: WorkingDirectorySchema.optional(), ...RuntimeRequestOverridesSchema.shape,
  }).strict(),
  z.object({ sessionId: dbId, clientSequence: dbId, mode: z.literal('steer'), runId: dbId, text: inputText,
    workspace: WorkspaceExpectationSchema.optional() }).strict(),
  z.object({ sessionId: dbId, clientSequence: dbId, mode: z.literal('followUp'), runId: dbId, text: inputText,
    workspace: WorkspaceExpectationSchema.optional() }).strict(),
]).superRefine((input, ctx) => {
  if (input.workspace && input.workspace.sessionId !== input.sessionId)
    ctx.addIssue({ code: 'custom', message: 'Workspace must refer to the same Session.' });
  if (input.mode === 'prompt' && input.workingDirectory !== undefined && input.workspace === undefined)
    ctx.addIssue({ code: 'custom', message: 'Working directory requires a Workspace Run.' });
  if (input.mode === 'prompt' && input.goalMode === 'save-candidate' && (!input.workspace?.documentRef || !input.workspace.jobId))
    ctx.addIssue({ code: 'custom', message: 'Invoice context and processing task are required.' });
});
export const InvoiceFormRunInputSchema = z.object({ modelId, clientSequence: dbId,
  target: InvoiceFormTargetSchema, workspace: WorkspaceExpectationSchema, ...RuntimeRequestOverridesSchema.shape,
}).strict().refine(value => value.workspace.documentRef !== null && value.workspace.jobId !== null
  && value.workspace.candidateRef !== null, 'Fill requires a selected candidate.');
const documentRef = z.object({ id: dbId, version: z.string().min(1).max(512) }).strict();
const pageInput = z.object({ beforeId: dbId.optional(), limit: pageLimit.optional() }).strict();

const hostCommandSchema = z.discriminatedUnion('type', [
  z.object({ version: z.literal(1), requestId, type: z.literal('query_runtime_events'), ownerToken, input: RuntimeEventsQuerySchema }).strict(),
  z.object({ version: z.literal(1), requestId, type: z.literal('list_context_snapshots'), input: ContextSnapshotsRequestSchema }).strict(),
  z.object({ version: z.literal(1), requestId, type: z.literal('query_context_snapshot'), input: ContextSnapshotRequestSchema }).strict(),
  z.object({ version: z.literal(1), requestId, type: z.literal('list_context_requests'), input: ContextRequestsRequestSchema }).strict(),
  z.object({ version: z.literal(1), requestId, type: z.literal('subscribe_runtime_events'), ownerToken,
    subscriptionId: RuntimeSubscriptionIdSchema, input: RuntimeEventsSubscriptionRequestSchema }).strict(),
  z.object({ version: z.literal(1), requestId, type: z.literal('unsubscribe_runtime_events'), ownerToken, subscriptionId: RuntimeSubscriptionIdSchema }).strict(),
  z.object({ version: z.literal(1), requestId, type: z.literal('list_run_tool_calls'), input: RunToolCallsRequestSchema }).strict(),
  z.object({ version: z.literal(1), requestId, type: z.literal('query_run_tool_call'), input: RunToolCallRequestSchema }).strict(),
  z.object({ version: z.literal(1), requestId, type: z.literal('submit_session_input'), input: DesktopSessionInputRequestSchema,
    expectedSettingsRevision: dbId.optional(), expectedCredentialRef: credentialRef.optional() }).strict(),
  z.object({ version: z.literal(1), requestId, type: z.literal('list_session_inputs'), input: SessionInputsRequestSchema }).strict(),
  z.object({ version: z.literal(1), requestId, type: z.literal('set_session_status'), input: SetSessionStatusRequestSchema }).strict(),
  z.object({ version: z.literal(1), requestId, type: z.literal('branch_session'), input: BranchSessionRequestSchema }).strict(),
  z.object({ version: z.literal(1), requestId, type: z.literal('save_invoice_candidate'), input: SaveInvoiceCandidateRequestSchema }).strict(),
  z.object({ version: z.literal(1), requestId, type: z.literal('accept_invoice_candidate'), input: AcceptInvoiceCandidateRequestSchema }).strict(),
  z.object({ version: z.literal(1), requestId, type: z.literal('reject_invoice_candidate'), input: RejectInvoiceCandidateRequestSchema }).strict(),
  z.object({ version: z.literal(1), requestId, type: z.literal('export_invoice_candidate'), input: ExportInvoiceCandidateRequestSchema }).strict(),
  z.object({ version: z.literal(1), requestId, type: z.literal('query_invoice_candidate_operation'), input: InvoiceCandidateOperationQuerySchema }).strict(),
  z.object({ version: z.literal(1), requestId, type: z.literal('get_state') }).strict(),
  z.object({ version: z.literal(1), requestId, type: z.literal('credential_response'),
    value: z.object({ ok: z.boolean(), credential: z.unknown().optional() }).strict() }).strict(),
  z.object({ version: z.literal(1), requestId, type: z.literal('invoice_form_response'),
    receipt: InvoiceFormApplicationReceiptSchema }).strict(),
  z.object({ version: z.literal(1), requestId, type: z.literal('submit_invoice_form_input'), input: InvoiceFormRunInputSchema,
    expectedSettingsRevision: dbId, expectedCredentialRef: credentialRef }).strict(),
  z.object({ version: z.literal(1), requestId, type: z.literal('query_session_input'), input: SessionInputQuerySchema }).strict(),
  z.object({ version: z.literal(1), requestId, type: z.literal('query_invoice_form_application'),
    input: z.object({ runId: dbId, toolCallId: dbId }).strict() }).strict(),
  z.object({ version: z.literal(1), requestId, type: z.literal('list_model_catalog'),
    providerId: z.string().min(1).max(128).optional(), refresh: z.boolean() }).strict(),
  z.object({ version: z.literal(1), requestId, type: z.literal('login_model'), modelId,
    authType: z.enum(['api_key', 'oauth']) }).strict(),
  z.object({ version: z.literal(1), requestId, type: z.literal('logout_model'), modelId }).strict(),
  z.object({ version: z.literal(1), requestId, type: z.literal('auth_reply'), loginRequestId: requestId,
    promptId: requestId, value: z.string().max(8192).nullable() }).strict(),
  z.object({ version: z.literal(1), requestId, type: z.literal('cancel_login'), loginRequestId: requestId }).strict(),
  z.object({ version: z.literal(1), requestId, type: z.literal('save_settings'), settings: z.unknown() }).strict(),
  z.object({
    version: z.literal(1), requestId, type: z.literal('call_provider'),
    input: z.object({
      goal: z.string().min(1).max(4096), text: z.string().max(65_536), modelId,
      timeoutMs: z.number().int().min(RUNTIME_CONFIG.ranges.providerTestTimeoutMs.min).max(RUNTIME_CONFIG.ranges.providerTestTimeoutMs.max).optional(),
    }).strict(),
  }).strict(),
  z.object({ version: z.literal(1), requestId, type: z.literal('cancel_provider'), targetRequestId: requestId }).strict(),
  z.object({ version: z.literal(1), requestId, type: z.literal('query_run'), runId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER) }).strict(),
  z.object({ version: z.literal(1), requestId, type: z.literal('read_workspace') }).strict(),
  z.object({ version: z.literal(1), requestId, type: z.literal('restore_workspace') }).strict(),
  z.object({ version: z.literal(1), requestId, type: z.literal('update_workspace'), input: WorkspaceUpdateRequestSchema }).strict(),
  z.object({ version: z.literal(1), requestId, type: z.literal('start_task'), input: z.object({
    clientSequence: dbId, expectedRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), documentRef, goal: z.string().max(4096),
  }).strict() }).strict(),
  z.object({ version: z.literal(1), requestId, type: z.literal('query_task_operation'), clientSequence: dbId }).strict(),
  z.object({ version: z.literal(1), requestId, type: z.literal('select_candidate'), input: z.object({
    jobId: dbId, candidateId: dbId, expectedCandidateId: dbId.nullable(), expectedRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  }).strict() }).strict(),
  z.object({ version: z.literal(1), requestId, type: z.literal('list_documents'), input: pageInput }).strict(),
  z.object({ version: z.literal(1), requestId, type: z.literal('query_document'), documentId: dbId }).strict(),
  z.object({ version: z.literal(1), requestId, type: z.literal('hide_document'), documentId: dbId }).strict(),
  z.object({ version: z.literal(1), requestId, type: z.literal('list_jobs'), input: pageInput.extend({ documentId: dbId.optional() }) }).strict(),
  z.object({ version: z.literal(1), requestId, type: z.literal('query_job'), jobId: dbId }).strict(),
  z.object({ version: z.literal(1), requestId, type: z.literal('hide_job'), jobId: dbId }).strict(),
  z.object({ version: z.literal(1), requestId, type: z.literal('list_job_candidates'), input: z.object({
    jobId: dbId, beforeSequence: dbId.nullable().optional(), limit: pageLimit.optional(),
  }).strict() }).strict(),
  z.object({ version: z.literal(1), requestId, type: z.literal('query_job_candidate'), input: z.object({ jobId: dbId, candidateId: dbId }).strict() }).strict(),
  z.object({ version: z.literal(1), requestId, type: z.literal('list_activity'), input: z.union([
    pageInput.extend({ jobId: dbId }), pageInput.extend({ documentId: dbId }),
  ]) }).strict(),
  z.object({ version: z.literal(1), requestId, type: z.literal('import_invoice_material'), sourceDirectory: z.string().min(1).max(4096) }).strict(),
  z.object({ version: z.literal(1), requestId, type: z.literal('read_document_page'), input: invoiceToolSchemas.read_invoice_document.input }).strict(),
  z.object({ version: z.literal(1), requestId, type: z.literal('list_document_pages'), input: invoiceToolSchemas.list_invoice_pages.input }).strict(),
  z.object({ version: z.literal(1), requestId, type: z.literal('read_document_original'), documentId: dbId, page: z.literal(1) }).strict(),
  z.object({ version: z.literal(1), requestId, type: z.literal('revoke_document_use'), documentId: dbId }).strict(),
  z.object({ version: z.literal(1), requestId, type: z.literal('create_session'), input: z.object({ title: sessionTitle.optional() }).strict() }).strict(),
  z.object({ version: z.literal(1), requestId, type: z.literal('query_native_tools') }).strict(),
  z.object({ version: z.literal(1), requestId, type: z.literal('rename_session'), input: z.object({ sessionId: dbId, title: sessionTitle }).strict() }).strict(),
  z.object({ version: z.literal(1), requestId, type: z.literal('delete_session'), sessionId: dbId }).strict(),
  z.object({
    version: z.literal(1), requestId, type: z.literal('list_sessions'),
    input: z.object({
      limit: pageLimit.optional(),
      before: z.object({ updatedAt: z.string().datetime({ offset: true }), sessionId: dbId }).strict().optional(),
    }).strict(),
  }).strict(),
  z.object({ version: z.literal(1), requestId, type: z.literal('query_session'), sessionId: dbId }).strict(),
  z.object({ version: z.literal(1), requestId, type: z.literal('list_session_messages'), input: SessionMessagesRequestSchema }).strict(),
  z.object({
    version: z.literal(1), requestId, type: z.literal('list_session_runs'),
    input: z.object({ sessionId: dbId, beforeRunId: dbId.optional(), limit: pageLimit.optional() }).strict(),
  }).strict(),
  z.object({ version: z.literal(1), requestId, type: z.literal('query_prompt_trace'), runId: dbId, callSequence: dbId.optional() }).strict(),
  z.object({
    version: z.literal(1), requestId, type: z.literal('start_run'),
    input: z.object({
      sessionId: dbId,
      text: boundedText,
      modelId,
      workspace: z.object({
        revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), documentRef: documentRef.nullable(), jobId: dbId.nullable(),
        candidateRef: z.object({ id: dbId, sequence: dbId }).strict().nullable(), sessionId: dbId,
      }).strict().optional(),
      goalMode: z.enum(['answer', 'save-candidate']),
      workingDirectory: WorkingDirectorySchema.optional(),
      ...RuntimeRequestOverridesSchema.shape,
    }).strict().superRefine((input, ctx) => {
      if (input.workingDirectory !== undefined && input.workspace === undefined)
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Working directory requires a Workspace Run.' });
      if (input.goalMode === 'save-candidate' && (!input.workspace?.documentRef || !input.workspace.jobId))
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Invoice context and processing task are required.' });
    }),
    expectedSettingsRevision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    expectedCredentialRef: credentialRef,
  }).strict(),
  z.object({ version: z.literal(1), requestId, type: z.literal('cancel_run'), runId: dbId }).strict(),
  z.object({ version: z.literal(1), requestId, type: z.literal('query_runtime_state') }).strict(),
  z.object({ version: z.literal(1), requestId, type: z.literal('close') }).strict(),
]).superRefine((command, ctx) => {
  if (command.type !== 'submit_session_input') return;
  const hasSettings = command.expectedSettingsRevision !== undefined;
  const hasCredential = command.expectedCredentialRef !== undefined;
  if (command.input.mode === 'prompt' ? hasSettings !== hasCredential : hasSettings || hasCredential)
    ctx.addIssue({ code: 'custom', message: 'Only initial inputs carry model preparation references.' });
});

export type HostCommand = z.infer<typeof hostCommandSchema>;

export type HostReady = {
  version: 1;
  type: 'ready';
  state: Partial<Omit<DesktopState, 'modelCredentials'>> & Pick<DesktopState, 'version' | 'ready' | 'host' | 'appVersion' | 'userDataPath'>;
};

export type HostResponse = { version: 1; type: 'response'; requestId: string; value: unknown };
export type HostCredentialRequest = { version: 1; type: 'credential_request'; requestId: string;
  credentialRef: string; operation: 'read' | 'write' | 'delete'; credential?: unknown };
export type HostInvoiceFormRequest = { version: 1; type: 'invoice_form_request'; requestId: string; request: InvoiceFormBridgeRequest };

export type HostEvent = {
  version: 1;
  type: 'event';
  event:
    | { type: 'provider_observation'; requestId: string; runId: number; sequence: number; observation: string; at: string; data: Readonly<Record<string, unknown>> }
    | { type: 'provider_finished'; requestId: string; runId: number; result: unknown }
    | { type: 'host_state'; state: Partial<Omit<DesktopState, 'modelCredentials'>> & Pick<DesktopState, 'version' | 'ready' | 'host' | 'appVersion' | 'userDataPath'> }
    | { type: 'model_auth_notice'; requestId: string; notice: ModelAuthNotice }
    | { type: 'model_auth_prompt'; requestId: string; promptId: string; prompt: ModelAuthPrompt }
    | { type: 'agent_run_event'; requestId: string; value: AgentRunEvent }
    | import('@flowmate/contracts').RuntimeEventsWake;
};

export type HostOutput = HostReady | HostResponse | HostEvent | HostCredentialRequest | HostInvoiceFormRequest;

export function parseHostCommand(value: unknown): HostCommand | null {
  const parsed = hostCommandSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

const runtimeResultSchemas = {
  query_runtime_events: RuntimeEventsReadResultSchema,
  subscribe_runtime_events: RuntimeSubscriptionResultSchema,
  unsubscribe_runtime_events: RuntimeSubscriptionReleaseResultSchema,
  list_run_tool_calls: RuntimeToolPageResultSchema,
  query_run_tool_call: RuntimeToolResultSchema,
};

const contextResultSchemas = {
  list_context_snapshots: ContextSnapshotsResultSchema,
  query_context_snapshot: ContextSnapshotResultSchema,
  list_context_requests: ContextRequestsResultSchema,
};
export function isContextHostCommand(type: string): type is keyof typeof contextResultSchemas {
  return Object.hasOwn(contextResultSchemas, type);
}
export function parseContextHostResult(type: string, value: unknown) {
  if (!isContextHostCommand(type)) return null;
  const parsed = contextResultSchemas[type].safeParse(value);
  return parsed.success ? parsed.data : null;
}
export function contextHostFailure() {
  return { ok: false as const, error: { code: 'internal_error' as const, category: 'internal' as const,
    message: 'Context query could not be completed.', retryable: false } };
}
/** Strict result schemas know their own rows; the captured command supplies original ownership and cursor. */
export function matchesContextResponse(command: HostCommand, value: unknown): boolean {
  if (command.type !== 'list_context_snapshots' && command.type !== 'query_context_snapshot' && command.type !== 'list_context_requests') return false;
  const result = parseContextHostResult(command.type, value);
  if (!result) return false;
  const input = command.input;
  if (!result.ok) {
    const runId = 'runId' in input ? input.runId : undefined;
    return (result.error.sessionId === undefined || result.error.sessionId === input.sessionId)
      && (result.runId === undefined || runId !== undefined && result.runId === runId)
      && (result.error.runId === undefined || runId !== undefined && result.error.runId === runId);
  }
  const data = result.data;
  if (command.type === 'query_context_snapshot') return 'snapshot' in data && data.snapshot.id === command.input.snapshotId
    && data.snapshot.sessionId === command.input.sessionId && data.snapshot.runId === command.input.runId
    && data.input.sessionId === command.input.sessionId && data.input.runId === command.input.runId;
  if (command.type === 'list_context_snapshots') return 'nextBeforeId' in data && data.sessionId === command.input.sessionId
    && data.runId === (command.input.runId ?? null) && data.items.length <= command.input.limit
    && data.items.every(item => command.input.beforeId === undefined || item.id < command.input.beforeId);
  return 'collection' in data && data.sessionId === command.input.sessionId && data.runId === command.input.runId
    && data.items.length <= command.input.limit
    && data.items.every(item => command.input.beforeRequestSequence === undefined || item.binding.requestSequence < command.input.beforeRequestSequence);
}
export function isRuntimeHostCommand(type: string): type is keyof typeof runtimeResultSchemas {
  return Object.hasOwn(runtimeResultSchemas, type);
}
export function parseRuntimeHostResult(type: string, value: unknown): unknown | null {
  if (!isRuntimeHostCommand(type)) return null;
  const parsed = runtimeResultSchemas[type].safeParse(value);
  return parsed.success ? parsed.data : null;
}

const workspaceResultSchemas = {
  read_workspace: WorkspaceSnapshotSchema,
  update_workspace: WorkspaceSnapshotSchema,
  restore_workspace: WorkspaceRestoreResultSchema,
  list_document_pages: invoiceToolSchemas.list_invoice_pages.output,
};
export function isWorkspaceHostCommand(type: string): type is keyof typeof workspaceResultSchemas {
  return Object.hasOwn(workspaceResultSchemas, type);
}
export function parseWorkspaceHostResult(type: string, value: unknown): unknown | null {
  if (!isWorkspaceHostCommand(type)) return null;
  const parsed = z.union([z.object({ ok: z.literal(true), data: workspaceResultSchemas[type] }).strict(),
    z.object({ ok: z.literal(false), error: AppErrorSchema }).strict()]).safeParse(value);
  return parsed.success ? parsed.data : null;
}
