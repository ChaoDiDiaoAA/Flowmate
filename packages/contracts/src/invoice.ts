import { z } from 'zod';

// 发票契约的固定业务边界；Schema 与跨层读写共同使用，不是 Run 配置。
export const MAX_INVOICE_PAGES = 20;
export const MAX_INVOICE_BLOCKS_PER_PAGE = 2_000;
export const MAX_INVOICE_VERSION_CHARS = 512;
export const MAX_INVOICE_FIELD_CHARS = 1_024;
export const MAX_INVOICE_LINES = 200;
export const MAX_INVOICE_NOTES = 20;
export const MAX_INVOICE_NOTE_CHARS = 1_024;
export const MAX_INVOICE_CHECKS = 1_000;
export const MAX_INVOICE_ISSUES = 1_000;
export const MAX_INVOICE_TOOL_PAGE_SIZE = 50;
export const MAX_INVOICE_QUOTE_CHARS = 1_024;
export const MAX_INVOICE_SEARCH_EXCERPT_CHARS = 512;
export const MAX_INVOICE_TABLE_PREVIEW_CHARS = 256;
// JSON 序列化后的差异值边界，与候选原字段字符上限分别计量。
export const MAX_INVOICE_DIFF_VALUE_CHARS = 1_024;

const idSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const pageSchema = z.number().int().min(1).max(MAX_INVOICE_PAGES);
const pageOrNullSchema = pageSchema.nullable();
const limitSchema = z.number().int().min(1).max(MAX_INVOICE_TOOL_PAGE_SIZE);
const blockIdSchema = z.string().regex(/^b[1-9]\d{0,3}$/);
const decimalTextSchema = z.string().regex(/^-?(0|[1-9][0-9]{0,17})(\.[0-9]{1,6})?$/);

export const DocumentRefSchema = z.object({
  id: idSchema,
  version: z.string().min(1).max(MAX_INVOICE_VERSION_CHARS),
}).strict();
export type DocumentRef = z.infer<typeof DocumentRefSchema>;

export const SourceRefSchema = z.object({
  documentId: idSchema,
  version: z.string().min(1).max(MAX_INVOICE_VERSION_CHARS),
  artifactId: idSchema,
  page: pageSchema,
  blockId: blockIdSchema.nullable(),
  quote: z.string().min(1).max(MAX_INVOICE_QUOTE_CHARS).nullable(),
}).strict();
export type SourceRef = z.infer<typeof SourceRefSchema>;

export const ParsedBlockSchema = z.object({
  id: blockIdSchema,
  kind: z.enum(['text', 'table', 'image']),
  text: z.string().max(65_536),
  sourceIndex: z.number().int().min(0).max(MAX_INVOICE_BLOCKS_PER_PAGE - 1),
  sourceType: z.string().min(1).max(128),
  bbox: z.tuple([
    z.number().finite(), z.number().finite(), z.number().finite(), z.number().finite(),
  ]).nullable(),
}).strict();
export type ParsedBlock = z.infer<typeof ParsedBlockSchema>;

export const PreparedInvoiceMaterialSchema = z.object({
  contract: z.literal('flowmate-prepared-invoice/v1'), sample: z.string().regex(/^[a-z0-9][a-z0-9-]{0,127}$/),
  original: z.object({ name: z.enum(['source.md', 'original.pdf']),
    base64: z.string().min(4).max(13_981_016).regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/) }).strict(),
  sourceText: z.string().min(1).max(2_097_152),
  pages: z.array(z.object({ page: pageSchema, blocks: z.array(ParsedBlockSchema).min(1).max(MAX_INVOICE_BLOCKS_PER_PAGE) }).strict()).min(1).max(MAX_INVOICE_PAGES)
}).strict().superRefine((input, context) => {
  if (new TextEncoder().encode(input.sourceText).length > 2_097_152 || input.pages.some((page, index) => page.page !== index + 1
    || page.blocks.some((block, row) => block.id !== 'b' + (row + 1) || block.sourceIndex !== row || block.kind !== 'text'
      || block.sourceType !== 'prepared-text' || !block.text.trim() || !input.sourceText.includes(block.text))))
    context.addIssue({ code: 'custom', message: 'Prepared pages must retain sequential source blocks from the frozen text.' });
});
export type PreparedInvoiceMaterial = z.infer<typeof PreparedInvoiceMaterialSchema>;

export const ValueStateSchema = z.enum(['present', 'missing', 'ambiguous', 'unreadable', 'not_applicable']);
export type ValueState = z.infer<typeof ValueStateSchema>;

export const InvoiceFieldSchema = z.object({
  raw: z.string().max(MAX_INVOICE_FIELD_CHARS).nullable(),
  normalized: z.string().max(MAX_INVOICE_FIELD_CHARS).nullable(),
  state: ValueStateSchema,
  alternatives: z.array(z.string().max(MAX_INVOICE_FIELD_CHARS)).max(5),
  sources: z.array(SourceRefSchema).max(8),
}).strict();
export type InvoiceField = z.infer<typeof InvoiceFieldSchema>;

const invoiceLineSchema = z.object({
  description: InvoiceFieldSchema,
  quantity: InvoiceFieldSchema,
  unit: InvoiceFieldSchema,
  unitPrice: InvoiceFieldSchema,
  netAmount: InvoiceFieldSchema,
  taxRate: InvoiceFieldSchema,
  taxAmount: InvoiceFieldSchema,
  totalAmount: InvoiceFieldSchema,
}).strict();

export const CandidateDraftSchema = z.object({
  fields: z.object({
    invoiceNumber: InvoiceFieldSchema,
    issueDate: InvoiceFieldSchema,
    sellerName: InvoiceFieldSchema,
    sellerTaxId: InvoiceFieldSchema,
    buyerName: InvoiceFieldSchema,
    buyerTaxId: InvoiceFieldSchema,
    currency: InvoiceFieldSchema,
    netAmount: InvoiceFieldSchema,
    taxAmount: InvoiceFieldSchema,
    totalAmount: InvoiceFieldSchema,
  }).strict(),
  lines: z.array(invoiceLineSchema).max(MAX_INVOICE_LINES),
  notes: z.array(z.string().max(MAX_INVOICE_NOTE_CHARS)).max(MAX_INVOICE_NOTES),
}).strict();
export type CandidateDraft = z.infer<typeof CandidateDraftSchema>;
// Model write inputs stay strict; provenance is accepted only by stored read projections.
export const StoredInvoiceFieldSchema = InvoiceFieldSchema.extend({
  valueOrigin: z.literal('user-provided').optional(),
}).strict().refine(field => field.valueOrigin !== 'user-provided' || field.sources.length === 0,
  'User-provided values cannot claim document sources.');
export type StoredInvoiceField = z.infer<typeof StoredInvoiceFieldSchema>;
export const StoredCandidateDraftSchema = CandidateDraftSchema.extend({
  fields: z.object({
    invoiceNumber: StoredInvoiceFieldSchema,
    issueDate: StoredInvoiceFieldSchema,
    sellerName: StoredInvoiceFieldSchema,
    sellerTaxId: StoredInvoiceFieldSchema,
    buyerName: StoredInvoiceFieldSchema,
    buyerTaxId: StoredInvoiceFieldSchema,
    currency: StoredInvoiceFieldSchema,
    netAmount: StoredInvoiceFieldSchema,
    taxAmount: StoredInvoiceFieldSchema,
    totalAmount: StoredInvoiceFieldSchema,
  }).strict(),
  lines: z.array(z.object({
    description: StoredInvoiceFieldSchema,
    quantity: StoredInvoiceFieldSchema,
    unit: StoredInvoiceFieldSchema,
    unitPrice: StoredInvoiceFieldSchema,
    netAmount: StoredInvoiceFieldSchema,
    taxRate: StoredInvoiceFieldSchema,
    taxAmount: StoredInvoiceFieldSchema,
    totalAmount: StoredInvoiceFieldSchema,
  }).strict()).max(MAX_INVOICE_LINES),
}).strict();
export type StoredCandidateDraft = z.infer<typeof StoredCandidateDraftSchema>;

// The local form sends values, never evidence or model field metadata.
export const invoiceHeaderFields = ['invoiceNumber', 'issueDate', 'sellerName', 'sellerTaxId', 'buyerName',
  'buyerTaxId', 'currency', 'netAmount', 'taxAmount', 'totalAmount'] as const;
export const invoiceLineFields = ['description', 'quantity', 'unit', 'unitPrice', 'netAmount', 'taxRate',
  'taxAmount', 'totalAmount'] as const;
export const InvoiceCandidateFieldPathSchema = z.string().max(256).refine(path => {
  const header = /^fields\.([A-Za-z]+)$/.exec(path);
  if (header) return invoiceHeaderFields.some(name => name === header[1]);
  const line = /^lines\.(0|[1-9]\d*)\.([A-Za-z]+)$/.exec(path);
  return !!line && Number(line[1]) < MAX_INVOICE_LINES && invoiceLineFields.some(name => name === line[2]);
}, 'Unregistered candidate field path.');
export const InvoiceCandidateChildReportReferenceSchema = z.object({
  childRunId: idSchema, fieldPath: InvoiceCandidateFieldPathSchema,
  sourceRefs: z.array(SourceRefSchema).max(50), inputIds: z.array(idSchema).max(64),
}).strict().refine(value => value.sourceRefs.length + value.inputIds.length > 0, 'An adopted report needs original evidence references.');
export type InvoiceCandidateChildReportReference = z.infer<typeof InvoiceCandidateChildReportReferenceSchema>;
const formHeaderShape = Object.fromEntries(invoiceHeaderFields.map(name => [name, z.string().max(MAX_INVOICE_FIELD_CHARS)])) as {
  [Name in typeof invoiceHeaderFields[number]]: z.ZodString;
};
const formLineShape = Object.fromEntries(invoiceLineFields.map(name => [name, z.string().max(MAX_INVOICE_FIELD_CHARS)])) as {
  [Name in typeof invoiceLineFields[number]]: z.ZodString;
};
export const InvoiceFormDraftSchema = z.object({ fields: z.object(formHeaderShape).strict(),
  lines: z.array(z.object(formLineShape).strict()).max(MAX_INVOICE_LINES),
  notes: z.array(z.string().max(MAX_INVOICE_NOTE_CHARS)).max(MAX_INVOICE_NOTES) }).strict();
export type InvoiceFormDraft = z.infer<typeof InvoiceFormDraftSchema>;

export function isLegalInvoiceNormalizedValue(name: string, value: string): boolean {
  if (['netAmount', 'taxAmount', 'totalAmount', 'quantity', 'unitPrice', 'taxRate'].includes(name)) return decimalTextSchema.safeParse(value).success;
  if (name === 'currency') return /^[A-Z]{3}$/.test(value);
  if (name === 'issueDate') {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
    if (!match) return false;
    const year = Number(match[1]), month = Number(match[2]), day = Number(match[3]);
    if (year < 1 || month < 1 || month > 12) return false;
    const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    return day >= 1 && day <= [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1]!;
  }
  return value.trim().length > 0;
}
export function invoiceFieldDisplayValue(name: string, field: StoredInvoiceField): string {
  if (field.state === 'missing' || field.state === 'not_applicable') return '';
  return field.state === 'present' && field.normalized !== null && isLegalInvoiceNormalizedValue(name, field.normalized)
    ? field.normalized : field.raw ?? '';
}

const invoiceOperationShape = { operationRef: z.string().min(1).max(256), jobId: idSchema,
  expectedCandidateId: idSchema, expectedRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER) };
export const InvoiceFormLineOriginsSchema = z.array(z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable())
  .max(MAX_INVOICE_LINES).refine(origins => new Set(origins.filter(origin => origin !== null)).size === origins.filter(origin => origin !== null).length,
    'An original line cannot be reused twice.');
export type InvoiceFormLineOrigins = z.infer<typeof InvoiceFormLineOriginsSchema>;
export const SaveInvoiceCandidateRequestSchema = z.object({ ...invoiceOperationShape,
  basedOnCandidateId: idSchema, draft: InvoiceFormDraftSchema, lineOrigins: InvoiceFormLineOriginsSchema.optional() }).strict()
  .refine(input => input.lineOrigins === undefined || input.lineOrigins.length === input.draft.lines.length, 'Line origins must match the draft.');
export type SaveInvoiceCandidateRequest = z.infer<typeof SaveInvoiceCandidateRequestSchema>;
export const AcceptInvoiceCandidateRequestSchema = z.object({ ...invoiceOperationShape,
  candidateId: idSchema, dirty: z.literal(false) }).strict();
export type AcceptInvoiceCandidateRequest = z.infer<typeof AcceptInvoiceCandidateRequestSchema>;
export const RejectInvoiceCandidateRequestSchema = z.object({ ...invoiceOperationShape,
  candidateId: idSchema, reason: z.string().trim().min(1).max(256) }).strict();
export type RejectInvoiceCandidateRequest = z.infer<typeof RejectInvoiceCandidateRequestSchema>;
export const ExportInvoiceCandidateRequestSchema = z.object({ operationRef: z.string().min(1).max(256),
  candidateId: idSchema, format: z.enum(['json', 'csv', 'markdown']) }).strict();
export type ExportInvoiceCandidateRequest = z.infer<typeof ExportInvoiceCandidateRequestSchema>;
export function invoiceExportName(candidate: { jobId: number; sequence: number }, format: ExportInvoiceCandidateRequest['format']): string {
  return `outputs/invoice-${candidate.jobId}-result-${candidate.sequence}.${format === 'markdown' ? 'md' : format}`;
}
export type SaveInvoiceCandidateResponse = { changed: boolean; candidate: import('./activity.ts').CandidateSnapshot;
  workspace: import('./workspace.ts').WorkspaceSnapshot };
export type InvoiceCandidateDecisionResponse = { candidate: import('./activity.ts').CandidateSnapshot;
  job: import('./workspace.ts').JobSnapshot; workspace: import('./workspace.ts').WorkspaceSnapshot };
export type InvoiceExportReference = { artifactId: number; candidateId: number; format: ExportInvoiceCandidateRequest['format'];
  relativePath: string; bytes: number; createdAt: string };
export const InvoiceExportReadRequestSchema = ExportInvoiceCandidateRequestSchema.extend({
  offset: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), limit: z.number().int().min(1).max(32_768),
});
export type InvoiceExportReadRequest = z.infer<typeof InvoiceExportReadRequestSchema>;
export const InvoiceExportPageSchema = z.object({ artifactId: idSchema, candidateId: idSchema,
  format: ExportInvoiceCandidateRequestSchema.shape.format, relativePath: z.string().min(1).max(1024),
  bytes: z.number().int().positive().max(10 * 1024 * 1024), offset: z.number().int().nonnegative(),
  chunkBase64: z.string().min(1).max(43_692).regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/][AQgw]==|[A-Za-z0-9+/]{2}[AEIMQUYcgkosw048]=)?$/),
  nextOffset: z.number().int().positive().nullable(),
}).strict().refine(page => {
  const padding = page.chunkBase64.endsWith('==') ? 2 : page.chunkBase64.endsWith('=') ? 1 : 0;
  const length = page.chunkBase64.length * 3 / 4 - padding;
  const end = page.offset + length;
  return length > 0 && length <= 32_768 && end <= page.bytes
    && page.nextOffset === (end === page.bytes ? null : end);
});
export type InvoiceExportPage = z.infer<typeof InvoiceExportPageSchema>;
export const InvoiceCandidateOperationQuerySchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('save'), request: SaveInvoiceCandidateRequestSchema }).strict(),
  z.object({ kind: z.literal('accept'), request: AcceptInvoiceCandidateRequestSchema }).strict(),
  z.object({ kind: z.literal('reject'), request: RejectInvoiceCandidateRequestSchema }).strict(),
  z.object({ kind: z.literal('export'), request: ExportInvoiceCandidateRequestSchema }).strict(),
]);
export type InvoiceCandidateOperationQuery = z.infer<typeof InvoiceCandidateOperationQuerySchema>;
export type InvoiceCandidateOperationResult = SaveInvoiceCandidateResponse | InvoiceCandidateDecisionResponse | InvoiceExportReference | null;
const maxCandidateFieldPaths = invoiceHeaderFields.length + invoiceLineFields.length * MAX_INVOICE_LINES;

export const CheckResultSchema = z.object({
  rule: z.string().min(1).max(128),
  version: z.literal('1'),
  status: z.enum(['passed', 'failed', 'not_evaluable', 'not_applicable']),
  fieldPaths: z.array(z.string().max(256)).max(maxCandidateFieldPaths),
  actual: z.string().max(1_024).nullable(),
  expected: z.string().max(1_024).nullable(),
  difference: z.string().max(1_024).nullable(),
  tolerance: z.string().max(1_024).nullable(),
  reason: z.string().max(1_024).nullable(),
}).strict();
export type CheckResult = z.infer<typeof CheckResultSchema>;

export const InvoiceIssueSchema = z.object({
  code: z.string().min(1).max(128),
  severity: z.enum(['warning', 'error']),
  origin: z.enum(['rule', 'model']),
  fieldPaths: z.array(z.string().max(256)).max(maxCandidateFieldPaths),
  message: z.string().min(1).max(1_024),
  rule: z.string().max(128).nullable(),
}).strict();
export type InvoiceIssue = z.infer<typeof InvoiceIssueSchema>;

export const CandidateReceiptSchema = z.object({
  candidateId: idSchema,
  jobId: idSchema,
  sequence: idSchema,
  issueCount: z.number().int().min(0).max(20_000),
  checks: z.array(CheckResultSchema).max(MAX_INVOICE_CHECKS),
}).strict();
export type CandidateReceipt = z.infer<typeof CandidateReceiptSchema>;

export const FillInvoiceFormInputSchema = z.object({ candidateId: idSchema }).strict();
export type FillInvoiceFormInput = z.infer<typeof FillInvoiceFormInputSchema>;
export const FillInvoiceFormOutputSchema = z.object({
  candidateId: idSchema, candidateSequence: idSchema, applied: z.literal(true),
}).strict();
export type FillInvoiceFormOutput = Readonly<z.infer<typeof FillInvoiceFormOutputSchema>>;
export const InvoiceFormTargetSchema = z.object({
  formInstanceId: z.string().min(1).max(128),
  expectedRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
}).strict();
export type InvoiceFormTarget = Readonly<z.infer<typeof InvoiceFormTargetSchema>>;
const invoiceFormReceiptIdentity = {
  runId: idSchema,
  toolCallId: idSchema,
  formInstanceId: InvoiceFormTargetSchema.shape.formInstanceId,
  candidateId: idSchema,
  candidateSequence: idSchema,
  observedAt: z.string().datetime(),
};
export const InvoiceFormApplicationReceiptSchema = z.discriminatedUnion('outcome', [
  z.object({ ...invoiceFormReceiptIdentity, outcome: z.literal('applied'),
    appliedRevision: idSchema, appliedAt: z.string().datetime() }).strict(),
  z.object({ ...invoiceFormReceiptIdentity, outcome: z.literal('not_applied'),
    reason: z.string().min(1).max(128) }).strict(),
  z.object({ ...invoiceFormReceiptIdentity, outcome: z.literal('unknown') }).strict(),
]);
export type InvoiceFormApplicationReceipt = Readonly<z.infer<typeof InvoiceFormApplicationReceiptSchema>>;
const invoiceFormCallIdentity = {
  runId: idSchema, sessionId: idSchema, toolCallId: idSchema,
  nativeToolCallId: z.string().min(1).max(256), documentRef: DocumentRefSchema, jobId: idSchema,
  candidateId: idSchema, candidateSequence: idSchema, target: InvoiceFormTargetSchema,
};
export const InvoiceFormBridgeRequestSchema = z.discriminatedUnion('operation', [
  z.object({ ...invoiceFormCallIdentity, operation: z.literal('apply'), candidate: StoredCandidateDraftSchema }).strict(),
  z.object({ ...invoiceFormCallIdentity, operation: z.literal('query') }).strict(),
]);
export type InvoiceFormBridgeRequest = Readonly<z.infer<typeof InvoiceFormBridgeRequestSchema>>;

const pageRequestInput = {
  documentId: idSchema,
  page: pageOrNullSchema,
  afterBlockId: blockIdSchema.nullable(),
  limit: limitSchema,
};

const pageIndexSchema = z.object({
  documentRef: DocumentRefSchema,
  parsedArtifactId: idSchema,
  pageCount: z.number().int().min(1).max(MAX_INVOICE_PAGES),
  pages: z.array(z.object({
    page: pageSchema,
    blockCount: z.number().int().min(0).max(MAX_INVOICE_BLOCKS_PER_PAGE),
    tableCount: z.number().int().min(0).max(MAX_INVOICE_BLOCKS_PER_PAGE),
  }).strict()).max(MAX_INVOICE_PAGES),
}).strict();

const documentPageSchema = z.object({
  documentRef: DocumentRefSchema,
  parsedArtifactId: idSchema,
  page: pageSchema,
  pageCount: z.number().int().min(1).max(MAX_INVOICE_PAGES),
  blocks: z.array(ParsedBlockSchema.extend({ source: SourceRefSchema }).strict()).max(MAX_INVOICE_TOOL_PAGE_SIZE),
  nextAfterBlockId: blockIdSchema.nullable(),
  completePage: z.boolean(),
}).strict();

const searchPageSchema = z.object({
  documentRef: DocumentRefSchema,
  parsedArtifactId: idSchema,
  query: z.string().min(1).max(128),
  matches: z.array(z.object({
    page: pageSchema,
    blockId: blockIdSchema,
    kind: z.enum(['text', 'table', 'image']),
    excerpt: z.string().min(1).max(MAX_INVOICE_SEARCH_EXCERPT_CHARS),
    source: SourceRefSchema,
  }).strict()).max(MAX_INVOICE_TOOL_PAGE_SIZE),
  nextAfterBlockId: blockIdSchema.nullable(),
  complete: z.boolean(),
}).strict();

const tableIndexSchema = z.object({
  documentRef: DocumentRefSchema,
  parsedArtifactId: idSchema,
  tables: z.array(z.object({
    page: pageSchema,
    blockId: blockIdSchema,
    sourceType: z.string().min(1).max(128),
    textLength: z.number().int().min(0).max(65_536),
    preview: z.string().max(MAX_INVOICE_TABLE_PREVIEW_CHARS),
    source: SourceRefSchema,
  }).strict()).max(MAX_INVOICE_TOOL_PAGE_SIZE),
  nextAfterBlockId: blockIdSchema.nullable(),
  complete: z.boolean(),
}).strict();

const evidenceResultSchema = z.object({
  kind: z.literal('parsed'), source: SourceRefSchema,
  text: z.string().max(65_536), sourceType: z.string().min(1).max(128),
}).strict();

const sourceChecksSchema = z.object({
  documentRef: DocumentRefSchema,
  results: z.array(z.object({
    index: z.number().int().min(0).max(49),
    status: z.enum(['valid', 'invalid']),
    code: z.enum([
      'parsed_quote_matched', 'reference_mismatch', 'block_not_found',
      'quote_mismatch',
    ]),
  }).strict()).min(1).max(50),
}).strict();

const normalizedValuesSchema = z.object({
  items: z.array(z.object({
    index: z.number().int().min(0).max(49),
    kind: z.enum(['decimal', 'date', 'currency']),
    raw: z.string().min(1).max(1_024),
    status: z.enum(['normalized', 'ambiguous', 'unsupported']),
    value: z.string().max(128).nullable(),
    alternatives: z.array(z.string().max(128)).max(2),
    reason: z.string().max(128).nullable(),
  }).strict()).min(1).max(50),
}).strict();

const amountCalculationSchema = z.union([
  z.object({ operation: z.literal('sum'), values: z.array(decimalTextSchema).min(1).max(200), scale: z.number().int().min(0).max(6).nullable() }).strict(),
  z.object({ operation: z.literal('product'), quantity: decimalTextSchema, unitPrice: decimalTextSchema, scale: z.number().int().min(0).max(6).nullable() }).strict(),
  z.object({ operation: z.literal('tax'), netAmount: decimalTextSchema, taxRate: decimalTextSchema, scale: z.number().int().min(0).max(6).nullable() }).strict(),
]);

const amountCalculationResultSchema = z.object({
  operation: z.enum(['sum', 'product', 'tax']),
  exact: z.string().min(1).max(128),
  rounded: z.string().max(128).nullable(),
  scale: z.number().int().min(0).max(6).nullable(),
  rounding: z.literal('half_away_from_zero').nullable(),
}).strict();

const candidateValidationSchema = z.object({
  documentRef: DocumentRefSchema,
  saveable: z.boolean(),
  violations: z.array(z.object({
    code: z.string().min(1).max(128),
    fieldPaths: z.array(z.string().max(256)).max(maxCandidateFieldPaths),
  }).strict()).max(1_000),
  checks: z.array(CheckResultSchema).max(MAX_INVOICE_CHECKS),
  issues: z.array(InvoiceIssueSchema).max(MAX_INVOICE_ISSUES),
}).strict();

const candidateSummarySchema = z.object({
  candidateId: idSchema,
  runId: idSchema.nullable(),
  origin: z.enum(['model', 'human_edit']).optional(),
  basedOnCandidateId: idSchema.nullable().optional(),
  sequence: idSchema,
  issueCount: z.number().int().min(0).max(20_000),
}).strict();

function validCandidateOrigin(candidate: z.infer<typeof candidateSummarySchema>): boolean {
  return candidate.origin === 'human_edit'
    ? candidate.runId === null && candidate.basedOnCandidateId != null
      && candidate.basedOnCandidateId !== candidate.candidateId
    : candidate.runId !== null && candidate.basedOnCandidateId == null;
}

const candidateIndexSchema = z.object({
  jobId: idSchema,
  candidates: z.array(candidateSummarySchema.refine(validCandidateOrigin, 'Invalid candidate provenance.')).max(MAX_INVOICE_TOOL_PAGE_SIZE),
  nextBeforeSequence: idSchema.nullable(),
}).strict();

const candidateDetailSchema = z.object({
  ...candidateSummarySchema.shape,
  jobId: idSchema,
  documentRef: DocumentRefSchema,
  toolCallId: idSchema.nullable(),
  candidate: StoredCandidateDraftSchema,
  checks: z.array(CheckResultSchema).max(MAX_INVOICE_CHECKS),
  issues: z.array(InvoiceIssueSchema).max(MAX_INVOICE_ISSUES),
}).strict().refine((candidate) => validCandidateOrigin(candidate)
  && (candidate.origin === 'human_edit'
    ? candidate.toolCallId === null
    : candidate.toolCallId !== null && CandidateDraftSchema.safeParse(candidate.candidate).success),
  'Invalid candidate provenance.');

const candidateDiffPageSchema = z.object({
  jobId: idSchema,
  leftCandidateId: idSchema,
  rightCandidateId: idSchema,
  differences: z.array(z.object({
    path: z.string().min(1).max(512),
    kind: z.enum(['added', 'removed', 'changed']),
    left: z.string().max(MAX_INVOICE_DIFF_VALUE_CHARS).nullable(),
    right: z.string().max(MAX_INVOICE_DIFF_VALUE_CHARS).nullable(),
  }).strict()).max(MAX_INVOICE_TOOL_PAGE_SIZE),
  nextAfterPath: z.string().min(1).max(512).nullable(),
  complete: z.boolean(),
}).strict();

const readPageInputSchema = z.object({
  documentId: idSchema,
  page: pageSchema,
  afterBlockId: blockIdSchema.nullable(),
  limit: limitSchema,
}).strict();

const listBlocksInputSchema = z.object(pageRequestInput).strict();

export const INVOICE_REVIEW_TOOL_NAMES = [
  'list_invoice_pages',
  'read_invoice_document',
  'search_invoice_document',
  'list_invoice_tables',
  'read_invoice_evidence',
  'check_invoice_sources',
  'normalize_invoice_values',
  'calculate_invoice_amounts',
  'validate_invoice_candidate',
  'list_invoice_candidates',
  'get_invoice_candidate',
  'compare_invoice_candidates',
  'save_invoice_candidate',
] as const;
export const INVOICE_TOOL_NAMES = [...INVOICE_REVIEW_TOOL_NAMES, 'fill_invoice_form'] as const;

export const invoiceToolSchemas = {
  list_invoice_pages: {
    input: z.object({ documentId: idSchema }).strict(), output: pageIndexSchema,
  },
  read_invoice_document: { input: readPageInputSchema, output: documentPageSchema },
  search_invoice_document: {
    input: z.object({
      documentId: idSchema,
      query: z.string().min(1).max(128),
      page: pageOrNullSchema,
      afterBlockId: blockIdSchema.nullable(),
      limit: limitSchema,
    }).strict(),
    output: searchPageSchema,
  },
  list_invoice_tables: { input: listBlocksInputSchema, output: tableIndexSchema },
  read_invoice_evidence: {
    input: z.object({
      documentId: idSchema, page: pageSchema,
      kind: z.literal('parsed'), blockId: blockIdSchema,
    }).strict(),
    output: evidenceResultSchema,
  },
  check_invoice_sources: {
    input: z.object({ documentId: idSchema, sources: z.array(SourceRefSchema).min(1).max(50) }).strict(),
    output: sourceChecksSchema,
  },
  normalize_invoice_values: {
    input: z.object({
      items: z.array(z.object({
        kind: z.enum(['decimal', 'date', 'currency']), raw: z.string().min(1).max(1_024),
      }).strict()).min(1).max(50),
    }).strict(),
    output: normalizedValuesSchema,
  },
  calculate_invoice_amounts: { input: amountCalculationSchema, output: amountCalculationResultSchema },
  validate_invoice_candidate: {
    input: z.object({ documentId: idSchema, candidate: CandidateDraftSchema }).strict(),
    output: candidateValidationSchema,
  },
  list_invoice_candidates: {
    input: z.object({ beforeSequence: idSchema.nullable(), limit: limitSchema }).strict(),
    output: candidateIndexSchema,
  },
  get_invoice_candidate: { input: z.object({ candidateId: idSchema }).strict(), output: candidateDetailSchema },
  compare_invoice_candidates: {
    input: z.object({
      leftCandidateId: idSchema, rightCandidateId: idSchema,
      afterPath: z.string().min(1).max(512).nullable(), limit: limitSchema,
    }).strict(),
    output: candidateDiffPageSchema,
  },
  save_invoice_candidate: {
    input: z.object({ documentId: idSchema, candidate: CandidateDraftSchema,
      childReportRefs: z.array(InvoiceCandidateChildReportReferenceSchema).min(1).max(50).optional() }).strict(),
    output: CandidateReceiptSchema,
  },
  fill_invoice_form: { input: FillInvoiceFormInputSchema, output: FillInvoiceFormOutputSchema },
} as const;

export type InvoiceToolName = typeof INVOICE_TOOL_NAMES[number];
export const InvoiceSaveReplayRequestSchema = z.object({
  runId: idSchema, sessionId: idSchema, toolCallId: idSchema,
  nativeToolCallId: z.string().min(1).max(256),
  rawArguments: invoiceToolSchemas.save_invoice_candidate.input,
  arguments: invoiceToolSchemas.save_invoice_candidate.input,
}).strict();
export type InvoiceSaveReplayRequest = z.infer<typeof InvoiceSaveReplayRequestSchema>;
export const InvoiceSaveReplayReceiptSchema = InvoiceSaveReplayRequestSchema.pick({
  runId: true, sessionId: true, toolCallId: true, nativeToolCallId: true,
}).extend({ receipt: CandidateReceiptSchema, created: z.literal(false) }).strict();
export type InvoiceToolInput<Name extends InvoiceToolName> = z.infer<typeof invoiceToolSchemas[Name]['input']>;
export type InvoiceToolOutput<Name extends InvoiceToolName> = z.infer<typeof invoiceToolSchemas[Name]['output']>;
