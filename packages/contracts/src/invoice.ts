import { z } from "zod";
import { EvidenceRefSchema, FieldValueSchema, SchemaVersionSchema } from "./common.js";

const DecimalTextSchema = z.string().regex(/^-?\d+(\.\d+)?$/, "must be a decimal string");
const DateTextSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "must be ISO date text");

export const ParsedBlockSchema = z.object({
  id: z.string().min(1),
  kind: z.enum(["text", "table"]),
  text: z.string(),
  evidence: EvidenceRefSchema,
}).strict();

export const ParsedDocumentSchema = z.object({
  schemaVersion: SchemaVersionSchema,
  sampleId: z.string().min(1),
  sourceId: z.string().min(1),
  original: z.object({ assetId: z.string().min(1), sha256: z.string().regex(/^[a-f0-9]{64}$/), mediaType: z.string().min(1) }).strict(),
  parser: z.object({ name: z.string().min(1), version: z.string().min(1) }).strict(),
  blocks: z.array(ParsedBlockSchema).min(1),
}).strict();
export type ParsedDocument = z.infer<typeof ParsedDocumentSchema>;

const InvoiceFieldsSchema = z.object({
  invoiceNumber: FieldValueSchema,
  invoiceDate: FieldValueSchema,
  sellerName: FieldValueSchema,
  sellerTaxId: FieldValueSchema,
  buyerName: FieldValueSchema,
  buyerTaxId: FieldValueSchema,
  currency: FieldValueSchema,
  netAmount: FieldValueSchema,
  taxAmount: FieldValueSchema,
  totalAmount: FieldValueSchema,
}).strict();

const InvoiceLineSchema = z.object({
  description: FieldValueSchema,
  quantity: FieldValueSchema,
  unitPrice: FieldValueSchema,
  netAmount: FieldValueSchema,
  taxAmount: FieldValueSchema,
}).strict();

export const InvoiceCandidateSchema = z.object({
  schemaVersion: SchemaVersionSchema,
  sampleId: z.string().min(1),
  fields: InvoiceFieldsSchema,
  lines: z.array(InvoiceLineSchema),
}).strict().superRefine((value, ctx) => {
  const decimalPaths = [
    ["fields", "netAmount"], ["fields", "taxAmount"], ["fields", "totalAmount"],
  ] as const;
  for (const path of decimalPaths) {
    const field = value.fields[path[1]];
    if (field.normalized !== null && !DecimalTextSchema.safeParse(field.normalized).success) {
      ctx.addIssue({ code: "custom", path: [...path], message: "amount normalized value must be decimal text" });
    }
  }
  value.lines.forEach((line, index) => {
    for (const key of ["quantity", "unitPrice", "netAmount", "taxAmount"] as const) {
      const field = line[key];
      if (field.normalized !== null && !DecimalTextSchema.safeParse(field.normalized).success) {
        ctx.addIssue({ code: "custom", path: ["lines", index, key], message: "amount normalized value must be decimal text" });
      }
    }
  });
  const date = value.fields.invoiceDate.normalized;
  if (date !== null && !DateTextSchema.safeParse(date).success) {
    ctx.addIssue({ code: "custom", path: ["fields", "invoiceDate", "normalized"], message: "date normalized value must be ISO date text" });
  }
});
export type InvoiceCandidate = z.infer<typeof InvoiceCandidateSchema>;

const emptyField = (): z.input<typeof FieldValueSchema> => ({ raw: null, normalized: null, status: "missing", evidence: [] });
const presentField = (value: string, assetId: string, blockId: string): z.input<typeof FieldValueSchema> => ({
  raw: value, normalized: value, status: "present", evidence: [{ assetId, blockId, page: 1, quote: value, bbox: null }],
});

export function makeParsedDocument(): ParsedDocument {
  const assetId = "asset-syn-001";
  return {
    schemaVersion: "1",
    sampleId: "SYN-001",
    sourceId: "synthetic-p0",
    original: { assetId, sha256: "1".repeat(64), mediaType: "text/plain" },
    parser: { name: "synthetic", version: "1" },
    blocks: [{ id: "b1", kind: "text", text: "Invoice No: SYN-001", evidence: { assetId, blockId: "b1", page: 1, quote: "Invoice No: SYN-001", bbox: null } }],
  };
}

export function makeInvoiceCandidate(): InvoiceCandidate {
  const assetId = "asset-syn-001";
  return InvoiceCandidateSchema.parse({
    schemaVersion: "1",
    sampleId: "SYN-001",
    fields: {
      invoiceNumber: presentField("SYN-001", assetId, "b1"),
      invoiceDate: presentField("2026-09-01", assetId, "b2"),
      sellerName: presentField("Example Seller", assetId, "b3"),
      sellerTaxId: emptyField(),
      buyerName: presentField("Example Buyer", assetId, "b4"),
      buyerTaxId: emptyField(),
      currency: emptyField(),
      netAmount: presentField("100.00", assetId, "b5"),
      taxAmount: presentField("10.00", assetId, "b6"),
      totalAmount: presentField("110.00", assetId, "b7"),
    },
    lines: [],
  });
}
