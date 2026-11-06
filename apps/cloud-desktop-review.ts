import { appError, CloudReviewAcceptReceiptSchema, CloudReviewAcceptRequestSchema, CloudReviewCandidateReceiptSchema, CloudReviewCandidateRequestSchema,
  CloudReviewOpenReceiptSchema, CloudReviewOriginalReceiptSchema, CloudReviewOriginalRequestSchema, CloudReviewPageReceiptSchema, CloudReviewPageRequestSchema,
  CloudReviewRejectReceiptSchema, CloudReviewRejectRequestSchema, CloudReviewSaveReceiptSchema, CloudReviewSaveRequestSchema,
  CloudReviewTargetSchema, CloudWorkspaceIdSchema, fail, ok, parseCloudDesktopResult,
  type DocumentOriginalImage, type InvoiceToolInput, type InvoiceToolOutput, type Result } from '@flowmate/contracts';
import type { DbHandle, SqlDatabaseStore } from '../packages/core/src/storage/database.ts';
import type { InvoiceEditServiceOptions } from '../packages/core/src/invoice-edit/service.ts';
import type { WorkspaceVerifier } from '../packages/core/src/workspace/verification.ts';

type Target = import('zod').z.infer<typeof CloudReviewTargetSchema>;
const denied = () => fail(appError('cloud_workspace_forbidden', 'input', 'The original Work invoice is unavailable.'));

/** Review reads only the invoice version owned by the selected cloud Work item. */
export class CloudDesktopReview {
  private readonly workspaceId: string;
  constructor(private readonly options: { database: Pick<DbHandle, 'read' | 'transaction'>; workspaceId: string;
    readOriginal(documentId: number, page: number): Promise<Result<DocumentOriginalImage>>;
    readPage?(input: InvoiceToolInput<'read_invoice_document'>): Promise<Result<InvoiceToolOutput<'read_invoice_document'>>>;
    now?(): string; verifyWorkspace?: WorkspaceVerifier; validateCandidate?: InvoiceEditServiceOptions['validate'] }) {
    this.workspaceId = CloudWorkspaceIdSchema.parse(options.workspaceId);
  }
  private lookup(scope: SqlDatabaseStore, input: Target & { jobId?: number }) {
    const found = scope.invoiceWorks.get({ view: 'item', workId: input.workId, itemId: input.itemId });
    if (!found.ok || found.data.view !== 'item' || found.data.item.documentRef.id !== input.documentRef.id
      || found.data.item.documentRef.version !== input.documentRef.version
      || input.jobId !== undefined && found.data.item.jobId !== input.jobId) return denied();
    const session = scope.sessions.get(found.data.work.sessionId), document = scope.documents.get(input.documentRef.id);
    if (!session.ok || session.data.runtimeKind !== 'durable' || session.data.durableRuntimeId === 'local'
      || session.data.cloudWorkspaceId !== this.workspaceId || !document.ok || document.data.status !== 'available'
      || document.data.isHidden || document.data.documentRef.version !== input.documentRef.version) return denied();
    return ok(found.data);
  }
  private async authorize(input: Target & { jobId?: number }): Promise<Result<void>> {
    try {
      return await this.options.database.read(scope => {
        const result = this.lookup(scope, input); return result.ok ? ok(undefined) : result;
      });
    } catch { return fail(appError('cloud_authorization_unavailable', 'storage', 'The cloud invoice permission could not be verified.', true)); }
  }
  async original(raw: unknown): Promise<Result<import('zod').z.infer<typeof CloudReviewOriginalReceiptSchema>>> {
    const parsed = CloudReviewOriginalRequestSchema.safeParse(raw); if (!parsed.success) return denied();
    const input = parsed.data, allowed = await this.authorize(input); if (!allowed.ok) return allowed;
    let image: Result<DocumentOriginalImage>;
    try { image = await this.options.readOriginal(input.documentRef.id, input.page); }
    catch { return fail(appError('storage_read_failed', 'storage', 'The original invoice could not be read.', true)); }
    if (!image.ok) return image;
    const checked = CloudReviewOriginalReceiptSchema.safeParse({ workId: input.workId, itemId: input.itemId, ...image.data });
    if (!checked.success || checked.data.documentRef.id !== input.documentRef.id || checked.data.documentRef.version !== input.documentRef.version)
      return fail(appError('source_invalid', 'storage', 'The original invoice response did not match its selected version.'));
    const current = await this.authorize(input); return current.ok ? ok(checked.data) : current;
  }
  async page(raw: unknown): Promise<Result<import('zod').z.infer<typeof CloudReviewPageReceiptSchema>>> {
    const parsed = CloudReviewPageRequestSchema.safeParse(raw); if (!parsed.success) return denied();
    const input = parsed.data, allowed = await this.authorize(input); if (!allowed.ok) return allowed;
    if (!this.options.readPage) return fail(appError('storage_read_failed', 'storage', 'The parsed invoice page is unavailable.', true));
    let result: Result<InvoiceToolOutput<'read_invoice_document'>>;
    try { result = await this.options.readPage({ documentId: input.documentRef.id, page: input.page, afterBlockId: input.afterBlockId, limit: input.limit }); }
    catch { return fail(appError('storage_read_failed', 'storage', 'The parsed invoice page could not be read.', true)); }
    if (!result.ok) return result;
    const receipt = { workId: input.workId, itemId: input.itemId, page: result.data };
    const verified = parseCloudDesktopResult({ type: 'cloud_review_page', input }, ok(receipt));
    if (!verified?.ok) return fail(appError('source_invalid', 'storage', 'The parsed invoice response did not match its selected version.'));
    const current = await this.authorize(input); return current.ok ? ok(CloudReviewPageReceiptSchema.parse(verified.data)) : current;
  }
  async candidate(raw: unknown): Promise<Result<import('zod').z.infer<typeof CloudReviewCandidateReceiptSchema>>> {
    const parsed = CloudReviewCandidateRequestSchema.safeParse(raw); if (!parsed.success) return denied();
    const input = parsed.data, allowed = await this.authorize(input); if (!allowed.ok) return allowed;
    try {
      const result = await this.options.database.read(scope => scope.candidates.readByJob({ jobId: input.jobId, candidateId: input.candidateId }));
      if (!result.ok) return result;
      const saved = result.data.candidate;
      const receipt = { workId: input.workId, itemId: input.itemId, status: saved.status, createdAt: saved.createdAt, context: saved.context,
        detail: { candidateId: saved.candidateId, runId: saved.runId, origin: saved.origin, basedOnCandidateId: saved.basedOnCandidateId,
          sequence: saved.sequence, issueCount: saved.issueCount, jobId: saved.jobId, documentRef: result.data.documentRef,
          toolCallId: saved.toolCallId, candidate: { fields: saved.fields, lines: saved.lines, notes: saved.notes }, checks: saved.checks, issues: saved.issues } };
      const verified = parseCloudDesktopResult({ type: 'cloud_review_candidate', input }, ok(receipt));
      if (!verified?.ok) return fail(appError('source_invalid', 'storage', 'The candidate does not match the original Work invoice.'));
      const current = await this.authorize(input); return current.ok ? ok(CloudReviewCandidateReceiptSchema.parse(verified.data)) : current;
    } catch { return fail(appError('storage_read_failed', 'storage', 'The original cloud candidate could not be read.', true)); }
  }
  private async write<T>(action: (scope: SqlDatabaseStore) => Result<T>): Promise<Result<T>> {
    let rejected: Extract<Result<never>, { ok: false }> | undefined;
    try {
      return await this.options.database.transaction(scope => {
        const result = action(scope); if (!result.ok) { rejected = result; throw Error('cloud_review_rejected'); }
        return result;
      });
    } catch { return rejected ?? fail(appError('storage_write_failed', 'storage', 'The original cloud review could not be saved.', true)); }
  }
  async open(raw: unknown): Promise<Result<import('zod').z.infer<typeof CloudReviewOpenReceiptSchema>>> {
    const parsed = CloudReviewCandidateRequestSchema.safeParse(raw); if (!parsed.success) return denied();
    if (!this.options.now || !this.options.verifyWorkspace) return fail(appError('cloud_review_unavailable', 'runtime', 'Cloud review is unavailable.', true));
    const input = parsed.data, at = this.options.now(), verify = this.options.verifyWorkspace;
    return this.write(scope => {
      const found = this.lookup(scope, input); if (!found.ok) return found;
      if (found.data.work.status !== 'open' || found.data.item.disposition !== 'unresolved') return denied();
      const job = scope.jobs.get(input.jobId), candidate = scope.candidates.readByJob({ jobId: input.jobId, candidateId: input.candidateId });
      if (!job.ok) return job; if (!candidate.ok) return candidate;
      if (job.data.currentCandidateId !== input.candidateId || candidate.data.documentRef.id !== input.documentRef.id
        || candidate.data.documentRef.version !== input.documentRef.version) return fail(appError('state_conflict', 'input', 'The original candidate changed.', true));
      const workspace = scope.workspace.read(at, value => verify(value, scope)); if (!workspace.ok) return workspace;
      const selected = scope.workspace.update({ expectedRevision: workspace.data.revision, change: { kind: 'job', jobId: input.jobId }, at },
        value => verify(value, scope));
      if (!selected.ok) return selected;
      if (selected.data.jobId !== input.jobId || selected.data.candidateRef?.id !== input.candidateId
        || selected.data.candidateRef.sequence !== candidate.data.candidate.sequence) return fail(appError('state_conflict', 'input', 'The original candidate selection changed.', true));
      return ok(CloudReviewOpenReceiptSchema.parse({ ...input, sequence: candidate.data.candidate.sequence, workspaceRevision: selected.data.revision }));
    });
  }
  private async acceptance(raw: unknown, query: boolean): Promise<Result<import('zod').z.infer<typeof CloudReviewAcceptReceiptSchema> | null>> {
    const parsed = CloudReviewAcceptRequestSchema.safeParse(raw); if (!parsed.success) return denied();
    if (!this.options.now || !this.options.validateCandidate) return fail(appError('cloud_review_unavailable', 'runtime', 'Cloud review is unavailable.', true));
    const input = parsed.data, at = this.options.now(), validate = this.options.validateCandidate;
    return this.write(scope => {
      const found = this.lookup(scope, { ...input, jobId: input.request.jobId }); if (!found.ok) return found;
      const original = scope.candidates.queryOperation({ kind: 'accept', request: input.request, at }); if (!original.ok) return original;
      if (query && original.data === null) return ok(null);
      if (!original.data && (found.data.work.status !== 'open' || found.data.item.disposition !== 'unresolved')) return denied();
      const accepted = original.data ? ok(original.data) : scope.candidates.accept({ ...input.request, at,
        validate: (draft, ref) => validate(draft, ref, scope) });
      if (!accepted.ok) return accepted;
      const value = accepted.data;
      if (!value || !('candidate' in value) || !('job' in value) || value.candidate.status !== 'accepted'
        || value.job.jobId !== input.request.jobId || value.job.acceptedCandidateId !== input.request.candidateId
        || value.job.documentRef.id !== input.documentRef.id || value.job.documentRef.version !== input.documentRef.version)
        return fail(appError('source_invalid', 'storage', 'The original acceptance does not belong to this Work invoice.'));
      return ok(CloudReviewAcceptReceiptSchema.parse({ workId: input.workId, itemId: input.itemId, documentRef: input.documentRef,
        jobId: value.job.jobId, candidateId: value.candidate.candidateId, sequence: value.candidate.sequence, status: 'accepted' }));
    });
  }
  async accept(raw: unknown) { return this.acceptance(raw, false); }
  async queryAccept(raw: unknown) { return this.acceptance(raw, true); }
  private async saving(raw: unknown, query: boolean): Promise<Result<import('zod').z.infer<typeof CloudReviewSaveReceiptSchema> | null>> {
    const parsed = CloudReviewSaveRequestSchema.safeParse(raw); if (!parsed.success) return denied();
    if (!this.options.now || !this.options.validateCandidate) return fail(appError('cloud_review_unavailable', 'runtime', 'Cloud review is unavailable.', true));
    const input = parsed.data, at = this.options.now(), validate = this.options.validateCandidate;
    return this.write(scope => {
      const found = this.lookup(scope, { ...input, jobId: input.request.jobId }); if (!found.ok) return found;
      const original = scope.candidates.queryOperation({ kind: 'save', request: input.request, at }); if (!original.ok) return original;
      if (query && original.data === null) return ok(null);
      if (!original.data && (found.data.work.status !== 'open' || found.data.item.disposition !== 'unresolved')) return denied();
      const saved = original.data ? ok(original.data) : scope.candidates.saveHuman({ ...input.request, at,
        validate: (draft, ref) => validate(draft, ref, scope) });
      if (!saved.ok) return saved;
      const value = saved.data;
      if (!value || !('candidate' in value) || !('changed' in value) || value.candidate.jobId !== input.request.jobId)
        return fail(appError('source_invalid', 'storage', 'The original edit does not belong to this Work invoice.'));
      const candidate = scope.candidates.readByJob({ jobId: input.request.jobId, candidateId: value.candidate.candidateId });
      if (!candidate.ok || candidate.data.documentRef.id !== input.documentRef.id || candidate.data.documentRef.version !== input.documentRef.version)
        return fail(appError('source_invalid', 'storage', 'The original edit has a different invoice version.'));
      return ok(CloudReviewSaveReceiptSchema.parse({ workId: input.workId, itemId: input.itemId, documentRef: input.documentRef,
        jobId: input.request.jobId, candidateId: value.candidate.candidateId, sequence: value.candidate.sequence, changed: value.changed }));
    });
  }
  async save(raw: unknown) { return this.saving(raw, false); }
  async querySave(raw: unknown) { return this.saving(raw, true); }
  private async rejection(raw: unknown, query: boolean): Promise<Result<import('zod').z.infer<typeof CloudReviewRejectReceiptSchema> | null>> {
    const parsed = CloudReviewRejectRequestSchema.safeParse(raw); if (!parsed.success) return denied();
    if (!this.options.now) return fail(appError('cloud_review_unavailable', 'runtime', 'Cloud review is unavailable.', true));
    const input = parsed.data, at = this.options.now();
    return this.write(scope => {
      const found = this.lookup(scope, { ...input, jobId: input.request.jobId }); if (!found.ok) return found;
      const original = scope.candidates.queryOperation({ kind: 'reject', request: input.request, at }); if (!original.ok) return original;
      if (query && original.data === null) return ok(null);
      if (!original.data && (found.data.work.status !== 'open' || found.data.item.disposition !== 'unresolved')) return denied();
      const rejected = original.data ? ok(original.data) : scope.candidates.reject({ ...input.request, at });
      if (!rejected.ok) return rejected;
      const value = rejected.data;
      if (!value || !('candidate' in value) || !('job' in value) || !original.data && value.candidate.status !== 'rejected'
        || value.job.jobId !== input.request.jobId || value.candidate.candidateId !== input.request.candidateId
        || value.job.documentRef.id !== input.documentRef.id || value.job.documentRef.version !== input.documentRef.version)
        return fail(appError('source_invalid', 'storage', 'The original rejection does not belong to this Work invoice.'));
      return ok(CloudReviewRejectReceiptSchema.parse({ workId: input.workId, itemId: input.itemId, documentRef: input.documentRef,
        jobId: value.job.jobId, candidateId: value.candidate.candidateId, sequence: value.candidate.sequence, status: 'rejected' }));
    });
  }
  async reject(raw: unknown) { return this.rejection(raw, false); }
  async queryReject(raw: unknown) { return this.rejection(raw, true); }
}
