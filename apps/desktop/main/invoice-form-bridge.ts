import { DocumentRefSchema, DurableRunScopeSchema, InvoiceFormDraftSchema, InvoiceFormLineOriginsSchema, InvoiceFormTargetSchema, RunScopeSchema, WorkspaceContextSchema } from '@flowmate/contracts';
import type { DesktopInvoiceFormInspection, DesktopInvoiceFormWorkspace, InvoiceFormBridgeRequest, InvoiceFormTarget, RunSnapshot } from '@flowmate/contracts';
import { z } from 'zod';

export type InvoiceFormOwner = { frame: object; contents: object; epoch: number };
const id = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
export const invoiceFormInspectionSchema = z.object({ formInstanceId: z.string().min(1).max(128), revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  dirty: z.boolean(), valid: z.boolean(), basis: z.object({ sessionId: id.nullable(), documentRef: DocumentRefSchema,
    jobId: id, candidateId: id, candidateSequence: id }).strict(), draft: InvoiceFormDraftSchema,
  lineOrigins: InvoiceFormLineOriginsSchema.optional() }).strict().refine(form => form.lineOrigins === undefined || form.lineOrigins.length === form.draft.lines.length);
export function checkedInvoiceFormInspection(binding: InvoiceFormTargetBinding & { currentRevision: number }, raw: unknown,
  owner: InvoiceFormOwner): DesktopInvoiceFormInspection | null {
  const parsed = invoiceFormInspectionSchema.safeParse(raw);
  if (!parsed.success || !binding.valid || binding.frame !== owner.frame || binding.contents !== owner.contents || binding.epoch !== owner.epoch) return null;
  const form = parsed.data;
  return form.valid && form.formInstanceId === binding.target.formInstanceId && form.revision === binding.currentRevision && form.dirty === binding.dirty
    && form.basis.sessionId === (binding.personal?.sessionId ?? binding.workspace.sessionId) && form.basis.jobId === binding.workspace.jobId
    && form.basis.documentRef.id === binding.workspace.documentRef?.id && form.basis.documentRef.version === binding.workspace.documentRef?.version
    && form.basis.candidateId === binding.workspace.candidateRef?.id && form.basis.candidateSequence === binding.workspace.candidateRef?.sequence ? form : null;
}
export type InvoiceFormTargetBinding = InvoiceFormOwner & {
  purpose: 'fill' | 'edit' | 'personal-fill'; workspace: DesktopInvoiceFormWorkspace; target: InvoiceFormTarget; valid: boolean; dirty: boolean;
  personal?: { workId: number; itemId: number; sessionId: number };
  runId: number | null; pendingFill: boolean;
};

export function observePersonalInvoiceForm(binding: InvoiceFormTargetBinding & { currentRevision: number; mutationPending?: boolean },
  work: { workId: number; itemId: number }, owner: InvoiceFormOwner): import('@flowmate/contracts').PersonalInvoiceFormObservation | null {
  if (!binding.valid || binding.dirty || binding.mutationPending || binding.purpose !== 'personal-fill' || !binding.personal
    || binding.personal.workId !== work.workId || binding.personal.itemId !== work.itemId || binding.frame !== owner.frame
    || binding.contents !== owner.contents || binding.epoch !== owner.epoch || binding.target.expectedRevision !== binding.currentRevision
    || !binding.workspace.candidateRef) return null;
  return { candidateId: binding.workspace.candidateRef.id, candidateSequence: binding.workspace.candidateRef.sequence, target: binding.target };
}

export function matchesInvoiceFormTarget(binding: InvoiceFormTargetBinding, request: InvoiceFormBridgeRequest,
  owner: InvoiceFormOwner, current?: DesktopInvoiceFormWorkspace): boolean {
  const personal = binding.purpose === 'personal-fill' && binding.personal && request.invoiceWork
    && binding.personal.workId === request.invoiceWork.workId && binding.personal.itemId === request.invoiceWork.itemId
    && binding.personal.sessionId === request.sessionId;
  const foreground = binding.purpose === 'fill' && !request.invoiceWork && binding.workspace.sessionId === request.sessionId;
  return binding.valid && !!(personal || foreground)
    && (!current || binding.workspace.revision === current.revision && binding.workspace.sessionId === current.sessionId
      && binding.workspace.jobId === current.jobId && binding.workspace.documentRef?.id === current.documentRef?.id
      && binding.workspace.documentRef?.version === current.documentRef?.version && binding.workspace.candidateRef?.id === current.candidateRef?.id
      && binding.workspace.candidateRef?.sequence === current.candidateRef?.sequence)
    && binding.frame === owner.frame && binding.contents === owner.contents && binding.epoch === owner.epoch
    && binding.target.formInstanceId === request.target.formInstanceId
    && binding.target.expectedRevision === request.target.expectedRevision
    && binding.workspace.jobId === request.jobId
    && binding.workspace.documentRef?.id === request.documentRef.id
    && binding.workspace.documentRef?.version === request.documentRef.version
    && binding.workspace.candidateRef?.id === request.candidateId
    && binding.workspace.candidateRef?.sequence === request.candidateSequence;
}

export function matchesInvoiceFormRun(binding: InvoiceFormTargetBinding, request: InvoiceFormBridgeRequest,
  run: Pick<RunSnapshot, 'kind' | 'runId' | 'sessionId' | 'jobId' | 'config' | 'scope' | 'status' | 'cancelRequestedAt'>): boolean {
  if (request.invoiceWork) {
    const scope = DurableRunScopeSchema.safeParse(run.scope);
    const config = z.object({ runtimeKind: z.literal('durable'), durable: z.object({ workId: id, attemptId: id }).passthrough() }).passthrough().safeParse(run.config);
    return binding.purpose === 'personal-fill' && binding.personal?.workId === request.invoiceWork.workId
      && binding.personal.itemId === request.invoiceWork.itemId && binding.personal.sessionId === request.sessionId
      && run.kind === 'agent' && run.runId === request.runId && run.sessionId === request.sessionId && run.jobId === null
      && (binding.runId === null ? binding.pendingFill : binding.runId === run.runId)
      && scope.success && scope.data.workId === request.invoiceWork.workId && scope.data.attemptId === request.invoiceWork.attemptId
      && scope.data.allowedTools.includes('personal_fill_invoice_form') && config.success
      && config.data.durable.workId === request.invoiceWork.workId && config.data.durable.attemptId === request.invoiceWork.attemptId
      && (request.operation === 'query' || run.cancelRequestedAt === null && run.status === 'running');
  }
  if (run.kind !== 'agent' || run.runId !== request.runId || run.sessionId !== request.sessionId || run.jobId !== request.jobId
    || binding.runId !== null && binding.runId !== run.runId || binding.runId === null && !binding.pendingFill
    || run.config.goalMode !== 'fill-form') return false;
  const target = InvoiceFormTargetSchema.safeParse(run.config.formTarget);
  const context = WorkspaceContextSchema.safeParse(run.config.workspaceContext);
  const scope = RunScopeSchema.safeParse(run.scope);
  if (!target.success || !context.success || !scope.success) return false;
  return target.data.formInstanceId === binding.target.formInstanceId && target.data.expectedRevision === binding.target.expectedRevision
    && context.data.revision === binding.workspace.revision && context.data.sessionId === binding.workspace.sessionId
    && context.data.jobId === binding.workspace.jobId && context.data.documentRef?.id === binding.workspace.documentRef?.id
    && context.data.documentRef?.version === binding.workspace.documentRef?.version
    && context.data.candidateRef?.id === binding.workspace.candidateRef?.id
    && context.data.candidateRef?.sequence === binding.workspace.candidateRef?.sequence
    && scope.data.allowedTools.length === 1 && scope.data.allowedTools[0] === 'fill_invoice_form'
    && scope.data.allowedDocumentIds.includes(request.documentRef.id)
    && (request.operation === 'query' || run.cancelRequestedAt === null && (run.status === 'created' || run.status === 'running'));
}
