import { describe, expect, test } from 'bun:test';
import { ResourceRefSchema, ResourceManifestSchema, ResourceBundleManifestSchema,
  SaveSubagentDefinitionSchema, ToolEvidencePageSchema, ToolEvidenceRequestSchema,
  RuntimeStrategyPolicySchema, InvoiceExportPageSchema } from '../../packages/contracts/src/index.ts';

describe('business identities and direct-content contracts', () => {
  const ref = { kind: 'skill', id: 'invoice', version: 'v1' };
  const manifest = { schemaVersion: 2, ...ref, bodyFile: 'SKILL.md', keywords: [], requires: [],
    files: [{ path: 'SKILL.md', bytes: 4 }] };
  test('accepts an explicit resource version and a separate bundle identity', () => {
    expect(ResourceRefSchema.safeParse(ref).success).toBe(true);
    expect(ResourceManifestSchema.safeParse(manifest).success).toBe(true);
    expect(ResourceBundleManifestSchema.safeParse({ version: 2,
      bundleId: '12345678-1234-4123-8123-123456789abc', resources: [{ ref, manifest }],
      files: [{ ref, path: 'SKILL.md', bytes: 4 }] }).success).toBe(true);
    expect(ResourceRefSchema.safeParse({ ...ref, contentHash: 'legacy' }).success).toBe(false);
  });
  test('role editing carries the actual original content for conflict detection', () => {
    expect(SaveSubagentDefinitionSchema.safeParse({ id: 'reviewer', expectedContent: 'original', content: 'edited' }).success).toBe(true);
    expect(SaveSubagentDefinitionSchema.safeParse({ id: 'reviewer', expectedContent: null, content: 'new' }).success).toBe(true);
  });
  test('evidence pagination is pinned to an explicit record revision', () => {
    const owner = { runId: 1, sessionId: 1, toolCallId: 1 };
    expect(ToolEvidenceRequestSchema.safeParse({ ...owner, offset: 4, expectedRevision: 3 }).success).toBe(true);
    expect(ToolEvidenceRequestSchema.safeParse({ ...owner, offset: 4 }).success).toBe(false);
    expect(ToolEvidencePageSchema.safeParse({ version: 2, ...owner, evidenceRevision: 3,
      bytes: 4, offset: 0, chunk: 'test', nextOffset: null }).success).toBe(true);
  });
  test('runtime policy accepts controls and rejects pre-injected snapshots', () => {
    const controls = { budgetAwareness: true, statistics: false, experience: true };
    expect(RuntimeStrategyPolicySchema.safeParse(controls).success).toBe(true);
    expect(RuntimeStrategyPolicySchema.safeParse({ ...controls, frozenStrategy: { version: 'runtime-v1', sampleSource: 'product',
      calibration: { sourceCutoffToolCallId: 0, groups: [] },
      experience: { version: 1, modelKey: 'm', promptVersion: 'p', taskType: 't', items: [] } } }).success).toBe(false);
  });
  test('export pages reject noncanonical bytes and broken cursors', () => {
    const page = { artifactId: 1, candidateId: 1, format: 'json', relativePath: 'outputs/invoice-1-result-1.json',
      bytes: 2, offset: 0, chunkBase64: 'YQ==', nextOffset: 1 };
    expect(InvoiceExportPageSchema.safeParse(page).success).toBe(true);
    expect(InvoiceExportPageSchema.safeParse({ ...page, chunkBase64: 'YR==' }).success).toBe(false);
    expect(InvoiceExportPageSchema.safeParse({ ...page, nextOffset: null }).success).toBe(false);
    expect(InvoiceExportPageSchema.safeParse({ ...page, offset: 2, nextOffset: 3 }).success).toBe(false);
  });
});
