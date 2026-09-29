import { z } from 'zod';

const idSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const pageSchema = z.number().int().min(1).max(20);
const pageOrNullSchema = pageSchema.nullable();
const limitSchema = z.number().int().min(1).max(50);
const blockIdSchema = z.string().regex(/^b[1-9]\d{0,3}$/);
const decimalTextSchema = z.string().regex(/^-?(0|[1-9][0-9]{0,17})(\.[0-9]{1,6})?$/);

export const DocumentRefSchema = z.object({
  id: idSchema,
  version: z.string().min(1).max(512),
}).strict();
export type DocumentRef = z.infer<typeof DocumentRefSchema>;

export const SourceRefSchema = z.object({
  documentId: idSchema,
  version: z.string().min(1).max(512),
  artifactId: idSchema,
  page: pageSchema,
  blockId: blockIdSchema.nullable(),
  quote: z.string().min(1).max(1024).nullable(),
}).strict();
export type SourceRef = z.infer<typeof SourceRefSchema>;

export const ParsedBlockSchema = z.object({
  id: blockIdSchema,
  kind: z.enum(['text', 'table', 'image']),
  text: z.string().max(65_536),
  sourceIndex: z.number().int().min(0).max(1_999),
  sourceType: z.string().min(1).max(128),
  bbox: z.tuple([
    z.number().finite(), z.number().finite(), z.number().finite(), z.number().finite(),
  ]).nullable(),
}).strict();
export type ParsedBlock = z.infer<typeof ParsedBlockSchema>;

export const ValueStateSchema = z.enum(['present', 'missing', 'ambiguous', 'unreadable', 'not_applicable']);
export type ValueState = z.infer<typeof ValueStateSchema>;

export const InvoiceFieldSchema = z.object({
  raw: z.string().max(1024).nullable(),
  normalized: z.string().max(1024).nullable(),
  state: ValueStateSchema,
  alternatives: z.array(z.string().max(1024)).max(5),
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
  lines: z.array(invoiceLineSchema).max(200),
  notes: z.array(z.string().max(1024)).max(20),
}).strict();
export type CandidateDraft = z.infer<typeof CandidateDraftSchema>;

export const CheckResultSchema = z.object({
  rule: z.string().min(1).max(128),
  version: z.literal('1'),
  status: z.enum(['passed', 'failed', 'not_evaluable', 'not_applicable']),
  fieldPaths: z.array(z.string().max(256)).max(32),
  actual: z.string().max(1024).nullable(),
  expected: z.string().max(1024).nullable(),
  difference: z.string().max(1024).nullable(),
  tolerance: z.string().max(1024).nullable(),
  reason: z.string().max(1024).nullable(),
}).strict();
export type CheckResult = z.infer<typeof CheckResultSchema>;

export const InvoiceIssueSchema = z.object({
  code: z.string().min(1).max(128),
  severity: z.enum(['warning', 'error']),
  origin: z.enum(['rule', 'model']),
  fieldPaths: z.array(z.string().max(256)).max(32),
  message: z.string().min(1).max(1024),
  rule: z.string().max(128).nullable(),
}).strict();
export type InvoiceIssue = z.infer<typeof InvoiceIssueSchema>;

export const CandidateReceiptSchema = z.object({
  candidateId: idSchema,
  jobId: idSchema,
  sequence: idSchema,
  issueCount: z.number().int().min(0).max(20_000),
  checks: z.array(CheckResultSchema).max(1_000),
}).strict();
export type CandidateReceipt = z.infer<typeof CandidateReceiptSchema>;

const pageRequestInput = {
  documentId: idSchema,
  page: pageOrNullSchema,
  afterBlockId: blockIdSchema.nullable(),
  limit: limitSchema,
};

const pageIndexSchema = z.object({
  documentRef: DocumentRefSchema,
  parsedArtifactId: idSchema,
  pageCount: z.number().int().min(1).max(20),
  pages: z.array(z.object({
    page: pageSchema,
    blockCount: z.number().int().min(0).max(2_000),
    tableCount: z.number().int().min(0).max(2_000),
  }).strict()).max(20),
}).strict();

const documentPageSchema = z.object({
  documentRef: DocumentRefSchema,
  parsedArtifactId: idSchema,
  page: pageSchema,
  pageCount: z.number().int().min(1).max(20),
  blocks: z.array(ParsedBlockSchema.extend({ source: SourceRefSchema }).strict()).max(50),
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
    excerpt: z.string().min(1).max(512),
    source: SourceRefSchema,
  }).strict()).max(50),
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
    preview: z.string().max(256),
    source: SourceRefSchema,
  }).strict()).max(50),
  nextAfterBlockId: blockIdSchema.nullable(),
  complete: z.boolean(),
}).strict();

const evidenceResultSchema = z.union([
  z.object({
    kind: z.literal('parsed'), source: SourceRefSchema,
    text: z.string().max(65_536), sourceType: z.string().min(1).max(128),
  }).strict(),
  z.object({
    kind: z.literal('original'), source: SourceRefSchema,
    mimeType: z.enum(['image/jpeg', 'image/png']),
    bytes: z.number().int().positive().max(2 * 1024 * 1024),
  }).strict(),
]);

const sourceChecksSchema = z.object({
  documentRef: DocumentRefSchema,
  results: z.array(z.object({
    index: z.number().int().min(0).max(49),
    status: z.enum(['valid', 'invalid', 'unverified']),
    code: z.enum([
      'parsed_quote_matched', 'reference_mismatch', 'block_not_found',
      'quote_mismatch', 'original_not_delivered', 'visual_truth_unverified',
    ]),
  }).strict()).min(1).max(50),
}).strict();

const normalizedValuesSchema = z.object({
  items: z.array(z.object({
    index: z.number().int().min(0).max(49),
    kind: z.enum(['decimal', 'date', 'currency']),
    raw: z.string().min(1).max(1024),
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
    fieldPaths: z.array(z.string().max(256)).max(32),
  }).strict()).max(1_000),
  checks: z.array(CheckResultSchema).max(1_000),
  issues: z.array(InvoiceIssueSchema).max(1_000),
}).strict();

const candidateSummarySchema = z.object({
  candidateId: idSchema,
  runId: idSchema,
  sequence: idSchema,
  issueCount: z.number().int().min(0).max(20_000),
}).strict();

const candidateIndexSchema = z.object({
  jobId: idSchema,
  candidates: z.array(candidateSummarySchema).max(50),
  nextBeforeSequence: idSchema.nullable(),
}).strict();

const candidateDetailSchema = z.object({
  ...candidateSummarySchema.shape,
  jobId: idSchema,
  documentRef: DocumentRefSchema,
  toolCallId: idSchema,
  candidate: CandidateDraftSchema,
  checks: z.array(CheckResultSchema).max(1_000),
  issues: z.array(InvoiceIssueSchema).max(1_000),
}).strict();

const candidateDiffPageSchema = z.object({
  jobId: idSchema,
  leftCandidateId: idSchema,
  rightCandidateId: idSchema,
  differences: z.array(z.object({
    path: z.string().min(1).max(512),
    kind: z.enum(['added', 'removed', 'changed']),
    left: z.string().max(1024).nullable(),
    right: z.string().max(1024).nullable(),
  }).strict()).max(50),
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

export const INVOICE_TOOL_NAMES = [
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
      kind: z.enum(['parsed', 'original']), blockId: blockIdSchema.nullable(),
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
        kind: z.enum(['decimal', 'date', 'currency']), raw: z.string().min(1).max(1024),
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
    input: z.object({ documentId: idSchema, candidate: CandidateDraftSchema }).strict(),
    output: CandidateReceiptSchema,
  },
} as const;

export type InvoiceToolName = typeof INVOICE_TOOL_NAMES[number];
export type InvoiceToolInput<Name extends InvoiceToolName> = z.infer<typeof invoiceToolSchemas[Name]['input']>;
export type InvoiceToolOutput<Name extends InvoiceToolName> = z.infer<typeof invoiceToolSchemas[Name]['output']>;
