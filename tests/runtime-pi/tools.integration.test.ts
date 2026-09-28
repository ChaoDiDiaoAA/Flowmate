import { describe, expect, it } from 'bun:test';
import { validateToolArguments } from '@earendil-works/pi-ai';
import { CandidateDraftSchema, INVOICE_TOOL_NAMES, invoiceToolSchemas } from '../../packages/contracts/src/invoice.ts';
import { z } from 'zod';

const converterPromise: Promise<{ toPiParameters: (schema: z.ZodTypeAny) => unknown } | null> = import(
  ['..', '..', 'packages', 'runtime-pi', 'src', 'schema.ts'].join('/')
).catch(() => null);

const field = { raw: null, normalized: null, state: 'missing', alternatives: [], sources: [] };
const candidate = {
  fields: Object.fromEntries([
    'invoiceNumber', 'issueDate', 'sellerName', 'sellerTaxId', 'buyerName',
    'buyerTaxId', 'currency', 'netAmount', 'taxAmount', 'totalAmount',
  ].map((name) => [name, field])),
  lines: [],
  notes: [],
};

const examples: Record<(typeof INVOICE_TOOL_NAMES)[number], unknown> = {
  list_invoice_pages: { documentId: 1 },
  read_invoice_document: { documentId: 1, page: 1, afterBlockId: null, limit: 10 },
  search_invoice_document: { documentId: 1, query: 'Tax', page: null, afterBlockId: null, limit: 10 },
  list_invoice_tables: { documentId: 1, page: null, afterBlockId: null, limit: 10 },
  read_invoice_evidence: { documentId: 1, page: 1, kind: 'original', blockId: null },
  check_invoice_sources: { documentId: 1, sources: [{ documentId: 1, version: 'v1', artifactId: 2, page: 1, blockId: 'b1', quote: 'Invoice' }] },
  normalize_invoice_values: { items: [{ kind: 'date', raw: '01/02/2026' }] },
  calculate_invoice_amounts: { operation: 'sum', values: ['0.1', '0.2'], scale: 2 },
  validate_invoice_candidate: { documentId: 1, candidate },
  list_invoice_candidates: { beforeSequence: null, limit: 20 },
  get_invoice_candidate: { candidateId: 2 },
  compare_invoice_candidates: { leftCandidateId: 2, rightCandidateId: 3, afterPath: null, limit: 20 },
  save_invoice_candidate: { documentId: 1, candidate },
};

describe('Pi argument schema conversion', () => {
  it('preserves all supported strict Zod constraints through the installed Pi validator', async () => {
    const converter = await converterPromise;
    expect(converter).not.toBeNull();
    if (!converter) return;

    for (const name of INVOICE_TOOL_NAMES) {
      const schema = invoiceToolSchemas[name].input;
      const parameters = converter.toPiParameters(schema);
      const piTool = { name, description: name, parameters } as Parameters<typeof validateToolArguments>[0];
      const valid = examples[name];
      expect(schema.safeParse(valid).success).toBe(true);
      expect(validateToolArguments(piTool, { name, arguments: structuredClone(valid) } as never)).toEqual(valid);

      const invalid = { ...(valid as Record<string, unknown>), untrustedExtra: true };
      expect(schema.safeParse(invalid).success).toBe(false);
      expect(() => validateToolArguments(piTool, { name, arguments: invalid } as never)).toThrow();
    }
  });

  it('refuses defaults, coercion, effects and unsupported checks instead of weakening schemas', async () => {
    const converter = await converterPromise;
    expect(converter).not.toBeNull();
    if (!converter) return;

    expect(() => converter.toPiParameters(z.object({ id: z.number().default(1) }).strict()))
      .toThrow('tool_schema_unsupported');
    expect(() => converter.toPiParameters(z.object({ id: z.coerce.number() }).strict()))
      .toThrow('tool_schema_unsupported');
    expect(() => converter.toPiParameters(z.object({ id: z.string().transform(Number) }).strict()))
      .toThrow('tool_schema_unsupported');
    expect(() => converter.toPiParameters(z.object({ id: z.string().email() }).strict()))
      .toThrow('tool_schema_unsupported');
  });
});
