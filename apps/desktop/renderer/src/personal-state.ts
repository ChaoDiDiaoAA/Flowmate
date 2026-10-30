import { z } from 'zod';
import { appError, fail, ok, AcceptInvoiceCandidateRequestSchema, DocumentRefSchema, InvoiceWorkCreateRequestSchema,
  WorkspaceExpectationSchema, type DesktopBridge, type InvoiceWorkOperationReceipt, type PersonalTaskStopReceipt,
  type InvoiceWorkExecutionDecision, type InvoiceWorkQueryOperationRequest, type Result } from '@flowmate/contracts';
import { parsePersonalAgentCommand, matchesPersonalAgentResponse, type PersonalAgentCommand } from '../../../../packages/contracts/src/personal-agent-commands.ts';

const writeTypes = new Set<string>(['invoice_work_create', 'invoice_work_continue', 'invoice_work_supplement',
  'invoice_work_dispose_item', 'invoice_work_cancel', 'personal_task_stop']);
export type PersonalWriteCommand = Extract<PersonalAgentCommand, { type: 'invoice_work_create' | 'invoice_work_continue'
  | 'invoice_work_supplement' | 'invoice_work_dispose_item' | 'invoice_work_cancel' | 'personal_task_stop' }>;
export type PersonalWriteReceipt = InvoiceWorkOperationReceipt | PersonalTaskStopReceipt;
export type PersonalWriteBridge = { invoiceWorks: Pick<DesktopBridge['invoiceWorks'], 'create' | 'continueWork' | 'supplement'
  | 'disposeItem' | 'cancelWork' | 'queryOperation'>; personalTasks: Pick<DesktopBridge['personalTasks'], 'stop' | 'get'> };
function isWrite(command: PersonalAgentCommand): command is PersonalWriteCommand { return writeTypes.has(command.type); }
export function capturePersonalWrite(raw: unknown): PersonalWriteCommand | null {
  const command = parsePersonalAgentCommand(raw);
  return command && isWrite(command) ? structuredClone(command) : null;
}
export function personalOperationQuery(command: PersonalWriteCommand): InvoiceWorkQueryOperationRequest
  | { workId: number; attemptId: number; stopRequestId: string; limit: 1 } {
  const input = command.input;
  switch (command.type) {
    case 'invoice_work_create': return { operation: 'create' as const, personalAgentId: command.input.personalAgentId, requestId: input.requestId };
    case 'invoice_work_continue': return { operation: 'continueWork' as const, workId: command.input.workId, requestId: input.requestId };
    case 'invoice_work_supplement': return { operation: 'supplement' as const, workId: command.input.workId, requestId: input.requestId };
    case 'invoice_work_dispose_item': return { operation: 'disposeItem' as const, workId: command.input.workId, requestId: input.requestId };
    case 'invoice_work_cancel': return { operation: 'cancelWork' as const, workId: command.input.workId, requestId: input.requestId };
    case 'personal_task_stop': return { workId: command.input.workId, attemptId: command.input.attemptId, stopRequestId: input.requestId, limit: 1 };
  }
}
const unknownReceipt = () => fail(appError('operation_result_unknown', 'runtime', 'The original receipt is unknown. Check the saved request before retrying.', true));
export async function executePersonalWrite(bridge: PersonalWriteBridge, command: PersonalWriteCommand): Promise<Result<PersonalWriteReceipt>> {
  try {
    let result: Result<PersonalWriteReceipt>;
    switch (command.type) {
      case 'invoice_work_create': result = await bridge.invoiceWorks.create(command.input); break;
      case 'invoice_work_continue': result = await bridge.invoiceWorks.continueWork(command.input); break;
      case 'invoice_work_supplement': result = await bridge.invoiceWorks.supplement(command.input); break;
      case 'invoice_work_dispose_item': result = await bridge.invoiceWorks.disposeItem(command.input); break;
      case 'invoice_work_cancel': result = await bridge.invoiceWorks.cancelWork(command.input); break;
      case 'personal_task_stop': result = await bridge.personalTasks.stop(command.input); break;
    }
    return matchesPersonalAgentResponse(command, result) ? result : unknownReceipt();
  } catch { return unknownReceipt(); }
}
export async function recoverPersonalWrite(bridge: PersonalWriteBridge, command: PersonalWriteCommand): Promise<Result<PersonalWriteReceipt | null>> {
  try {
    const query = personalOperationQuery(command);
    if ('stopRequestId' in query) {
      const result = await bridge.personalTasks.get(query); if (!result.ok) return result;
      const receipt = result.data.stopReceipt;
      return receipt === null || matchesPersonalAgentResponse(command, ok(receipt)) ? ok(receipt) : unknownReceipt();
    }
    const result = await bridge.invoiceWorks.queryOperation(query); if (!result.ok) return result;
    return result.data === null || matchesPersonalAgentResponse(command, result) ? result : unknownReceipt();
  } catch { return unknownReceipt(); }
}

const id = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
export const PersonalReviewTargetSchema = z.object({ workId: id, itemId: id, documentRef: DocumentRefSchema,
  jobId: id.nullable(), candidateRef: WorkspaceExpectationSchema.shape.candidateRef }).strict();
export type PersonalReviewTarget = z.infer<typeof PersonalReviewTargetSchema>;
const personalDraftSchema = z.object({ version: z.literal(1), selectedWorkId: id.nullable(), goal: z.string().max(22000),
  documents: z.array(DocumentRefSchema), source: InvoiceWorkCreateRequestSchema.innerType().shape.source,
  supplements: z.record(z.string().max(128), z.object({ text: z.string().max(22000), materials: z.array(DocumentRefSchema) }).strict()),
  pending: z.custom<PersonalWriteCommand>(value => capturePersonalWrite(value) !== null).nullable(),
  review: z.object({ target: PersonalReviewTargetSchema, acceptRequest: AcceptInvoiceCandidateRequestSchema.nullable() }).strict().nullable(),
}).strict();
export type PersonalDraft = z.infer<typeof personalDraftSchema>;
export function emptyPersonalDraft(): PersonalDraft { return { version: 1, selectedWorkId: null, goal: '', documents: [], supplements: {}, pending: null, review: null }; }
export const PERSONAL_DRAFT_KEY = 'flowmate.personal-agent.draft.v1';
export function readPersonalDraft(storage: Pick<Storage, 'getItem'>): Result<PersonalDraft> {
  try {
    const raw = storage.getItem(PERSONAL_DRAFT_KEY); if (raw === null) return ok(emptyPersonalDraft());
    if (new TextEncoder().encode(raw).byteLength > 4 * 1024 * 1024) throw Error('draft_too_large');
    const draft = personalDraftSchema.safeParse(JSON.parse(raw));
    if (!draft.success) throw Error('draft_invalid');
    return ok({ ...draft.data, pending: draft.data.pending === null ? null : capturePersonalWrite(draft.data.pending) });
  } catch { return fail(appError('personal_draft_unavailable', 'storage', 'The saved Personal Agent draft could not be verified. It has not been replaced.', true)); }
}
export function savePersonalDraft(storage: Pick<Storage, 'setItem'>, draft: PersonalDraft): boolean {
  try {
    const parsed = personalDraftSchema.safeParse(draft); if (!parsed.success) return false;
    const raw = JSON.stringify(parsed.data); if (new TextEncoder().encode(raw).byteLength > 4 * 1024 * 1024) return false;
    storage.setItem(PERSONAL_DRAFT_KEY, raw); return true;
  } catch { return false; }
}
export function executionDecisionText(value: InvoiceWorkExecutionDecision): string {
  switch (value.kind) {
    case 'accepted': return `Execution authorized; attempt ${value.attempt.attemptId} admitted. This is not a completion receipt.`;
    case 'queued': return `Execution authorized; attempt ${value.attempt.attemptId} is queued.`;
    case 'pending-boundary': return `Input saved and execution authorized for the next valid phase boundary of attempt ${value.attempt.attemptId}.`;
    case 'existing': return `The original attempt ${value.attempt.attemptId} already exists. No second execution was created.`;
    case 'waiting': return `Saved; no new execution authorization. ${value.reason}`;
    case 'blocked': return `Saved; execution is blocked. ${value.reason.message}`;
  }
}
export function personalReceiptText(value: PersonalWriteReceipt): string {
  if (!('operation' in value)) return value.stopConfirmed ? 'The original attempt has stopped.' : 'Stop requested. Actual execution stop is not yet confirmed.';
  if (value.operation === 'cancelWork') return 'The Work is cancelled. Check its task for actual stop confirmation.';
  if (value.operation === 'disposeItem') return `Invoice disposition saved: ${value.disposition}.`;
  return (value.operation === 'supplement' ? 'Supplement saved. ' : 'Original request saved. ') + executionDecisionText(value.execution);
}
