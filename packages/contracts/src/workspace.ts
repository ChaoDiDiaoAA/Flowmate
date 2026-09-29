import type { CandidateDraft, DocumentRef, InvoiceIssue } from './invoice.ts';
import type { DbId } from './runtime.ts';
import { CandidateDraftSchema, DocumentRefSchema, InvoiceIssueSchema } from './invoice.ts';
import { z } from 'zod';

const idSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);

export type WorkspaceView = 'original' | 'parsed' | 'candidate';
export type GoalMode = 'answer' | 'save-candidate';

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
  selection: null;
}>;

export type WorkspaceChange =
  | { kind: 'document'; documentId: DbId | null }
  | { kind: 'job'; jobId: DbId }
  | { kind: 'session'; sessionId: DbId | null }
  | { kind: 'view'; view: WorkspaceView };

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
]);

export type WorkspaceSnapshot = {
  documentRef: DocumentRef | null;
  jobId: DbId | null;
  sessionId: DbId | null;
  candidateRef: { id: DbId; sequence: number } | null;
  activeView: WorkspaceView;
  selection: null;
  revision: number;
  updatedAt: string;
  invalidReferences: readonly string[];
  nextTaskSequence: DbId;
};

export type WorkspaceInput = {
  documentRef: DocumentRef | null;
  job: { id: DbId; goal: string } | null;
  candidate: {
    id: DbId;
    sequence: number;
    fields: CandidateDraft['fields'];
    lines: CandidateDraft['lines'];
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
  selection: z.null(),
}).strict();

export const WorkspaceInputSchema = z.object({
  documentRef: DocumentRefSchema.nullable(),
  job: z.object({ id: idSchema, goal: z.string().min(1) }).strict().nullable(),
  candidate: z.object({
    id: idSchema,
    sequence: idSchema,
    fields: CandidateDraftSchema.shape.fields,
    lines: CandidateDraftSchema.shape.lines,
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
