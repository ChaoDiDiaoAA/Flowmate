import { appError, fail, SaveInvoiceCandidateRequestSchema, AcceptInvoiceCandidateRequestSchema,
  RejectInvoiceCandidateRequestSchema, ExportInvoiceCandidateRequestSchema, invoiceHeaderFields, invoiceLineFields } from '@flowmate/contracts';
import type { CandidateSnapshot, DocumentRef, ExportInvoiceCandidateRequest, InvoiceExportReference, Result,
  SaveInvoiceCandidateResponse, InvoiceCandidateDecisionResponse } from '@flowmate/contracts';
import { InvoiceCandidateOperationQuerySchema, InvoiceExportReadRequestSchema } from '@flowmate/contracts';
import type { InvoiceExportPage } from '@flowmate/contracts';
import type { InvoiceCandidateOperationResult } from '@flowmate/contracts';
import type { InvoiceEditRepository, ValidateHumanInvoice } from '../storage/repositories.ts';
import type { FileStore } from '../storage/file-store.ts';

export type InvoiceEditServiceOptions = { candidates: InvoiceEditRepository; validate: ValidateHumanInvoice;
  files: Pick<FileStore, 'publishInvoiceExport' | 'readInvoiceExport'>; now: () => string };

export class InvoiceEditService {
  public constructor(private readonly options: InvoiceEditServiceOptions) {}
  public save(raw: unknown): Result<SaveInvoiceCandidateResponse> {
    const parsed = SaveInvoiceCandidateRequestSchema.safeParse(raw);
    return parsed.success ? this.options.candidates.saveHuman({ ...parsed.data, at: this.options.now(), validate: this.options.validate })
      : fail(appError('input_invalid', 'input', '人工表单参数无效。'));
  }
  public accept(raw: unknown): Result<InvoiceCandidateDecisionResponse> {
    const parsed = AcceptInvoiceCandidateRequestSchema.safeParse(raw);
    return parsed.success ? this.options.candidates.accept({ ...parsed.data, at: this.options.now(), validate: this.options.validate })
      : fail(appError('input_invalid', 'input', '接受参数无效。'));
  }
  public queryOperation(raw: unknown): Result<InvoiceCandidateOperationResult> {
    const parsed = InvoiceCandidateOperationQuerySchema.safeParse(raw);
    if (!parsed.success) return fail(appError('input_invalid', 'input', '操作查询参数无效。'));
    const result = this.options.candidates.queryOperation({ ...parsed.data, at: this.options.now() });
    if (!result.ok || parsed.data.kind !== 'export' || result.data === null) return result;
    const read = this.options.files.readInvoiceExport(result.data as InvoiceExportReference);
    return read.ok ? result : read;
  }
  public reject(raw: unknown): Result<InvoiceCandidateDecisionResponse> {
    const parsed = RejectInvoiceCandidateRequestSchema.safeParse(raw);
    return parsed.success ? this.options.candidates.reject({ ...parsed.data, at: this.options.now() })
      : fail(appError('input_invalid', 'input', '拒绝参数无效。'));
  }
  public export(raw: unknown): Result<InvoiceExportReference> {
    const parsed = ExportInvoiceCandidateRequestSchema.safeParse(raw);
    if (!parsed.success) return fail(appError('input_invalid', 'input', '导出参数无效。'));
    const input = parsed.data;
    const prior = this.options.candidates.findExport(input);
    if (!prior.ok) return prior;
    if (prior.data) {
      const read = this.options.files.readInvoiceExport(prior.data);
      return read.ok ? { ok: true, data: prior.data } : read;
    }
    const saved = this.options.candidates.readAccepted(input.candidateId);
    if (!saved.ok) return saved;
    const bytes = Buffer.from(formatInvoiceExport(saved.data.candidate, saved.data.documentRef, input.format), 'utf8');
    const published = this.options.files.publishInvoiceExport({ candidateId: saved.data.candidate.candidateId,
      jobId: saved.data.candidate.jobId, sequence: saved.data.candidate.sequence, format: input.format, bytes });
    if (!published.ok) return published;
    return this.options.candidates.registerExport({ ...input, ...published.data, at: this.options.now() });
  }
  public readExport(raw: unknown): Result<InvoiceExportPage> {
    const parsed = InvoiceExportReadRequestSchema.safeParse(raw);
    if (!parsed.success) return fail(appError('input_invalid', 'input', 'Export read parameters are invalid.'));
    const { offset, limit, ...request } = parsed.data;
    const prior = this.options.candidates.findExport(request);
    if (!prior.ok) return prior;
    if (!prior.data) return fail(appError('artifact_unavailable', 'storage', 'The original export operation is unavailable.'));
    const read = this.options.files.readInvoiceExport(prior.data);
    if (!read.ok) return read;
    if (offset >= read.data.byteLength) return fail(appError('input_invalid', 'input', 'Export byte cursor is out of range.'));
    const end = Math.min(offset + limit, read.data.byteLength);
    return { ok: true, data: { artifactId: prior.data.artifactId, candidateId: prior.data.candidateId,
      format: prior.data.format, relativePath: prior.data.relativePath, bytes: read.data.byteLength, offset,
      chunkBase64: Buffer.from(read.data.subarray(offset, end)).toString('base64'),
      nextOffset: end === read.data.byteLength ? null : end } };
  }
}
export function createInvoiceEditService(options: InvoiceEditServiceOptions): InvoiceEditService { return new InvoiceEditService(options); }

function fieldValue(value: CandidateSnapshot['fields'][typeof invoiceHeaderFields[number]]): string {
  return value.normalized ?? value.raw ?? '';
}
function csvCell(value: string): string {
  const safe = /^[\s]*[=+@-]/.test(value) ? `'${value}` : value;
  return `"${safe.replaceAll('"', '""')}"`;
}
function markdownCell(value: string): string {
  return value.replace(/[\\`*_{}\[\]()<>#|]/g, '\\$&').replace(/\r?\n/g, '<br>');
}
export function formatInvoiceExport(candidate: CandidateSnapshot, documentRef: DocumentRef, format: ExportInvoiceCandidateRequest['format']): string {
  const record = { formatVersion: 1, documentRef, ...candidate, origin: candidate.origin ?? 'model',
    basedOnCandidateId: candidate.basedOnCandidateId ?? null };
  if (format === 'json') return `${JSON.stringify(record, null, 2)}\n`;
  // CSV protocol v1 repeats the fixed header evidence, includes only this row's
  // line evidence, and writes global notes/checks/issues on the first row.
  if (format === 'csv') {
    const names = ['formatVersion', 'candidateId', 'jobId', 'sequence', 'origin', 'basedOnCandidateId',
      ...invoiceHeaderFields, ...invoiceLineFields.map(name => `line.${name}`), 'documentRef', 'headerMetadata',
      'lineMetadata', 'notes', 'checks', 'issues'];
    const header = invoiceHeaderFields.map(name => fieldValue(candidate.fields[name]));
    const lines = candidate.lines.length ? candidate.lines : [null];
    return [names.map(csvCell).join(','), ...lines.map((line, index) => ['1', String(candidate.candidateId), String(candidate.jobId),
      String(candidate.sequence), candidate.origin ?? 'model', candidate.basedOnCandidateId === undefined || candidate.basedOnCandidateId === null ? '' : String(candidate.basedOnCandidateId),
      ...header, ...invoiceLineFields.map(name => line === null ? '' : fieldValue(line[name])), JSON.stringify(documentRef),
      JSON.stringify(candidate.fields), line === null ? '' : JSON.stringify(line), index === 0 ? JSON.stringify(candidate.notes) : '',
      index === 0 ? JSON.stringify(candidate.checks) : '', index === 0 ? JSON.stringify(candidate.issues) : '']
      .map(csvCell).join(','))].join('\r\n') + '\r\n';
  }
  const provenance = (field: CandidateSnapshot['fields'][typeof invoiceHeaderFields[number]]) =>
    field.valueOrigin === 'user-provided' ? 'user-provided' : field.sources.length ? `${field.sources.length} document source(s)` : 'no document source';
  return `# Invoice result\n\nOrigin: ${candidate.origin ?? 'model'}\n\nBasis candidate: ${candidate.basedOnCandidateId ?? 'none'}\n\n`
    + `| Field | Value | Provenance |\n| --- | --- | --- |\n${invoiceHeaderFields.map(name =>
    `| ${name} | ${markdownCell(fieldValue(candidate.fields[name]))} | ${provenance(candidate.fields[name])} |`).join('\n')}\n\n`
    + `| ${invoiceLineFields.join(' | ')} |\n| ${invoiceLineFields.map(() => '---').join(' | ')} |\n`
    + candidate.lines.map(line => `| ${invoiceLineFields.map(name => markdownCell(fieldValue(line[name]))).join(' | ')} |`).join('\n')
    + `\n\nNotes: ${candidate.notes.map(markdownCell).join('; ')}\n\nIssues\n\n`
    + (candidate.issues.length ? candidate.issues.map(issue => `- ${markdownCell(issue.code)} (${issue.severity}): ${markdownCell(issue.message)}`).join('\n') : 'None')
    + `\n\nComplete field evidence (raw, normalized, state, alternatives and sources)\n\n\`\`\`json\n${JSON.stringify(record, null, 2)}\n\`\`\`\n`;
}
