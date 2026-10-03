import type { StoredCandidateDraft, DocumentRef, InvoiceIssue } from './invoice.ts';
import type { DbId } from './runtime.ts';
import { StoredCandidateDraftSchema, DocumentRefSchema, InvoiceIssueSchema, invoiceHeaderFields, invoiceLineFields,
  MAX_INVOICE_LINES, MAX_INVOICE_PAGES } from './invoice.ts';
import { z } from 'zod';

const idSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);

export type WorkspaceView = 'original' | 'parsed' | 'candidate';
export type GoalMode = 'answer' | 'save-candidate' | 'fill-form';

const candidateFieldPath = z.string().max(256).refine(path => {
  const header = /^fields\.([A-Za-z]+)$/.exec(path);
  if (header) return invoiceHeaderFields.some(name => name === header[1]);
  const line = /^lines\.(0|[1-9]\d*)\.([A-Za-z]+)$/.exec(path);
  return !!line && Number(line[1]) < MAX_INVOICE_LINES && invoiceLineFields.some(name => name === line[2]);
}, 'Unregistered candidate field path.');
const selectionBase = { formatVersion: z.literal(1), targetId: idSchema };
export const WorkspaceSelectionSchema = z.union([
  z.object({ ...selectionBase, kind: z.literal('field'), target: z.literal('document'),
    targetVersion: DocumentRefSchema.shape.version, fieldPath: z.string().min(1).max(256) }).strict(),
  z.object({ ...selectionBase, kind: z.literal('field'), target: z.literal('candidate'),
    targetVersion: idSchema, fieldPath: candidateFieldPath }).strict(),
  z.object({ ...selectionBase, kind: z.literal('line'), target: z.literal('candidate'),
    targetVersion: idSchema, lineIndex: z.number().int().min(0).max(MAX_INVOICE_LINES - 1) }).strict(),
  z.object({ ...selectionBase, kind: z.literal('source'), target: z.literal('document'),
    targetVersion: DocumentRefSchema.shape.version, artifactId: idSchema,
    page: z.number().int().min(1).max(MAX_INVOICE_PAGES).optional(),
    block: z.string().regex(/^b[1-9]\d{0,3}$/).optional() }).strict()
    .refine(value => value.page !== undefined || value.block !== undefined, 'A source location is required.'),
]);
export type WorkspaceSelection = Readonly<z.infer<typeof WorkspaceSelectionSchema>>;

export type WorkspaceExpectation = {
  revision: number;
  documentRef: DocumentRef | null;
  jobId: DbId | null;
  candidateRef: { id: DbId; sequence: number } | null;
  sessionId: DbId;
};

export type WorkspaceContext = Readonly<WorkspaceExpectation & {
  formatVersion: 1;
  activeView: WorkspaceView;
  selection: WorkspaceSelection | null;
}>;

export type WorkspaceChange =
  | { kind: 'document'; documentId: DbId | null }
  | { kind: 'job'; jobId: DbId }
  | { kind: 'session'; sessionId: DbId | null }
  | { kind: 'view'; view: WorkspaceView }
  | { kind: 'selection'; selection: WorkspaceSelection | null };

export const WorkspaceExpectationSchema = z.object({
  revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  documentRef: DocumentRefSchema.nullable(),
  jobId: idSchema.nullable(),
  candidateRef: z.object({ id: idSchema, sequence: idSchema }).strict().nullable(),
  sessionId: idSchema,
}).strict();

export const WorkspaceChangeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('document'), documentId: idSchema.nullable() }).strict(),
  z.object({ kind: z.literal('job'), jobId: idSchema }).strict(),
  z.object({ kind: z.literal('session'), sessionId: idSchema.nullable() }).strict(),
  z.object({ kind: z.literal('view'), view: z.enum(['original', 'parsed', 'candidate']) }).strict(),
  z.object({ kind: z.literal('selection'), selection: WorkspaceSelectionSchema.nullable() }).strict(),
]);

export const WorkspaceUpdateRequestSchema = z.object({
  expectedRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), change: WorkspaceChangeSchema,
}).strict();

export type WorkspaceSnapshot = {
  documentRef: DocumentRef | null;
  jobId: DbId | null;
  sessionId: DbId | null;
  candidateRef: { id: DbId; sequence: number } | null;
  activeView: WorkspaceView;
  selection: WorkspaceSelection | null;
  revision: number;
  updatedAt: string;
  invalidReferences: readonly string[];
  nextTaskSequence: DbId;
};

export const WorkspaceSnapshotSchema = z.object({
  documentRef: DocumentRefSchema.nullable(), jobId: idSchema.nullable(), sessionId: idSchema.nullable(),
  candidateRef: z.object({ id: idSchema, sequence: idSchema }).strict().nullable(),
  activeView: z.enum(['original', 'parsed', 'candidate']), selection: WorkspaceSelectionSchema.nullable(),
  revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), updatedAt: z.string().datetime(),
  invalidReferences: z.array(z.string().min(1)), nextTaskSequence: idSchema,
}).strict();
export type WorkspaceRestoreResult = { workspace: WorkspaceSnapshot; clearedReferences: readonly string[] };
export const WorkspaceRestoreResultSchema = z.object({ workspace: WorkspaceSnapshotSchema,
  clearedReferences: z.array(z.string().min(1)) }).strict();

export type WorkspaceInput = {
  documentRef: DocumentRef | null;
  job: { id: DbId; goal: string } | null;
  candidate: {
    id: DbId;
    sequence: number;
    fields: StoredCandidateDraft['fields'];
    lines: StoredCandidateDraft['lines'];
    issues: InvoiceIssue[];
  } | null;
};

export const WorkspaceContextSchema = z.object({
  formatVersion: z.literal(1),
  revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  documentRef: DocumentRefSchema.nullable(),
  jobId: idSchema.nullable(),
  candidateRef: z.object({ id: idSchema, sequence: idSchema }).strict().nullable(),
  sessionId: idSchema,
  activeView: z.enum(['original', 'parsed', 'candidate']),
  selection: WorkspaceSelectionSchema.nullable(),
}).strict();
// Content version 1 predates locator support and remains a null-only historical format.
export const LegacyWorkspaceContextSchema = WorkspaceContextSchema.extend({ selection: z.null() });

export const WorkspaceInputSchema = z.object({
  documentRef: DocumentRefSchema.nullable(),
  job: z.object({ id: idSchema, goal: z.string().min(1) }).strict().nullable(),
  candidate: z.object({
    id: idSchema,
    sequence: idSchema,
    fields: StoredCandidateDraftSchema.shape.fields,
    lines: StoredCandidateDraftSchema.shape.lines,
    issues: z.array(InvoiceIssueSchema).max(1_000),
  }).strict().nullable(),
}).strict();

export type PageRequest = { beforeId?: DbId; limit?: number };
export type NormalizedPageRequest = { beforeId?: DbId; limit: number };
export type Page<T> = { items: T[]; nextBeforeId: DbId | null };

export type JobStatus = 'pending' | 'running' | 'waiting' | 'completed' | 'failed' | 'cancelled';

export type DocumentSnapshot = {
  documentRef: DocumentRef;
  displayName: string;
  isHidden: boolean;
  status: 'available' | 'unavailable';
  pageCount: number;
  originalArtifactId: DbId;
  parsedArtifactId: DbId;
  warnings: string[];
  unavailableReason: string | null;
  createdAt: string;
  updatedAt: string;
};
export type DocumentOriginalImage = { documentRef: DocumentRef; mimeType: 'image/jpeg' | 'image/png'; base64: string };
export type WorkspaceMaterialInspection =
  | { kind: 'valid'; document: DocumentSnapshot; pages: readonly { page: number; blockIds: readonly string[] }[] }
  | { kind: 'invalid'; reason: string };

export type JobPageRequest = PageRequest & { documentId?: DbId };
export type CandidateJobPageRequest = { jobId: DbId; beforeSequence?: DbId; limit?: number };
export type CandidateJobPage = { items: import('./activity.ts').CandidateSummary[]; nextBeforeSequence: DbId | null };
export type CandidateJobDetail = { documentRef: DocumentRef; candidate: import('./activity.ts').CandidateSnapshot };

export type JobSnapshot = {
  jobId: DbId;
  documentRef: DocumentRef;
  goal: string;
  status: JobStatus;
  reason: string | null;
  currentCandidateId: DbId | null;
  acceptedCandidateId: DbId | null;
  createdAt: string;
  updatedAt: string;
};

export type StartTaskRequest = {
  clientSequence: DbId;
  expectedRevision: number;
  documentRef: DocumentRef;
  goal: string;
};

export const StartTaskRequestSchema = z.object({
  clientSequence: idSchema,
  expectedRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  documentRef: DocumentRefSchema,
  goal: z.string().max(4096),
}).strict();

export type TaskOperation = { job: JobSnapshot; workspace: WorkspaceSnapshot };

export type SelectCandidateRequest = {
  jobId: DbId;
  candidateId: DbId;
  expectedCandidateId: DbId | null;
  expectedRevision: number;
};
export const SelectCandidateRequestSchema = z.object({
  jobId: idSchema,
  candidateId: idSchema,
  expectedCandidateId: idSchema.nullable(),
  expectedRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
}).strict();
export type CandidateSelection = { jobId: DbId; candidateId: DbId; workspace: WorkspaceSnapshot };
