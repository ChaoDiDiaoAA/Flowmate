import { z } from 'zod';
import { DocumentRefSchema, InvoiceCandidateChildReportReferenceSchema } from './invoice.ts';
import { WorkspaceExpectationSchema } from './workspace.ts';
import type { Result } from './runtime.ts';

const id = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
export const MAX_INVOICE_WORK_TIMELINE_PAGE_BYTES = 262_144;
export const InvoiceWorkTimelineSourceKindSchema = z.enum(['work', 'operation', 'item', 'todo', 'attempt', 'business_event', 'run', 'tool_call']);
export const InvoiceWorkTimelineKindSchema = z.enum(['work_created', 'work_continued', 'supplement_received', 'work_cancelled',
  'work_completed', 'item_disposed', 'todo_created', 'todo_superseded', 'attempt_created', 'attempt_stop_requested', 'attempt_stopped',
  'candidate_generated', 'candidate_edited', 'candidate_accepted', 'candidate_rejected', 'candidate_exported', 'run_created',
  'run_started', 'run_completed', 'run_failed', 'run_cancelled', 'run_stop_requested', 'run_stop_confirmed',
  'child_result_recorded', 'child_result_returned', 'child_result_consumed', 'delegation_stop_confirmed']);
export const InvoiceWorkTimelineCursorSchema = z.object({ occurredAt: z.string().datetime({ offset: true }),
  sourceKind: InvoiceWorkTimelineSourceKindSchema, sourceId: id, kind: InvoiceWorkTimelineKindSchema }).strict();
export type InvoiceWorkTimelineCursor = z.infer<typeof InvoiceWorkTimelineCursorSchema>;
/** Positive means a is later in the descending live-facts feed. */
export function compareInvoiceWorkTimelineCursor(a: InvoiceWorkTimelineCursor, b: InvoiceWorkTimelineCursor): number {
  const time = Date.parse(a.occurredAt) - Date.parse(b.occurredAt);
  if (time) return time;
  if (a.sourceKind !== b.sourceKind) return a.sourceKind > b.sourceKind ? 1 : -1;
  if (a.sourceId !== b.sourceId) return a.sourceId - b.sourceId;
  return a.kind === b.kind ? 0 : a.kind > b.kind ? 1 : -1;
}
export const InvoiceWorkTimelineRequestSchema = z.object({ workId: id, before: InvoiceWorkTimelineCursorSchema.optional(),
  limit: z.number().int().min(1).max(100).default(50) }).strict();
export type InvoiceWorkTimelineRequest = z.input<typeof InvoiceWorkTimelineRequestSchema>;
export const InvoiceWorkTimelineRefsSchema = z.object({ operationId: id.optional(), requestId: z.string().min(1).max(128).optional(),
  operationRef: z.string().min(1).max(512).optional(), todoId: id.optional(), inputId: id.optional(), attemptId: id.optional(),
  runId: id.optional(), parentRunId: id.optional(), childRunId: id.optional(), originToolCallId: id.optional(), toolCallId: id.optional(),
  jobId: id.optional(), candidateRef: WorkspaceExpectationSchema.shape.candidateRef.unwrap().optional(), documentRef: DocumentRefSchema.optional(),
  artifactId: id.optional(), nativeEntryId: id.optional(), nativeModelTaskId: id.optional(),
  childReportRefs: z.array(InvoiceCandidateChildReportReferenceSchema).max(50).optional() }).strict();
export const InvoiceWorkTimelineEntrySchema = InvoiceWorkTimelineCursorSchema.extend({ key: z.string().min(1).max(256),
  workId: id, itemId: id.nullable(), summary: z.string().refine(text => new TextEncoder().encode(text).byteLength <= 1024),
  refs: InvoiceWorkTimelineRefsSchema, evidence: z.object({ resultRecorded: z.boolean(), returnedToParent: z.boolean(),
    parentConsumed: z.boolean(), stopConfirmed: z.boolean() }).strict(),
}).strict().refine(value => value.key === JSON.stringify([value.sourceKind, value.sourceId, value.kind])
  && (!value.evidence.parentConsumed || value.evidence.returnedToParent)
  && (!value.evidence.returnedToParent || value.evidence.resultRecorded), 'Evidence needs its original fact and key.');
export type InvoiceWorkTimelineEntry = z.infer<typeof InvoiceWorkTimelineEntrySchema>;
export const InvoiceWorkTimelinePageSchema = z.object({ workId: id, semantics: z.literal('live-facts'),
  entries: z.array(InvoiceWorkTimelineEntrySchema).max(100), nextBefore: InvoiceWorkTimelineCursorSchema.nullable(),
}).strict().refine(value => new Set(value.entries.map(entry => entry.key)).size === value.entries.length
  && value.entries.every((entry, index) => entry.workId === value.workId
  && (index === 0 || compareInvoiceWorkTimelineCursor(value.entries[index - 1]!, entry) > 0))
  && (value.nextBefore === null || value.entries.length > 0 && compareInvoiceWorkTimelineCursor(value.nextBefore, value.entries.at(-1)!) === 0),
  'Timeline ownership, order or continuation disagrees.')
  .refine(value => new TextEncoder().encode(JSON.stringify(value)).byteLength <= MAX_INVOICE_WORK_TIMELINE_PAGE_BYTES);
export type InvoiceWorkTimelinePage = z.infer<typeof InvoiceWorkTimelinePageSchema>;
export interface InvoiceWorkTimelineApi { timeline(input: InvoiceWorkTimelineRequest): Promise<Result<InvoiceWorkTimelinePage>>; }
