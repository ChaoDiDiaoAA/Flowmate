import { describe, expect, it } from 'bun:test';
import type { ZodTypeAny } from 'zod';
import * as contracts from '../../packages/contracts/src/index.ts';

// Reflect keeps the first RED a missing product capability, rather than an import/setup error.
const schema = (name: string): ZodTypeAny | undefined => Reflect.get(contracts, name);
const hash = 'a'.repeat(64);
const skill = { kind: 'skill', id: 'invoice', version: 'v1', contentHash: hash };
const prompt = { ...skill, kind: 'prompt' };
const manifest = { schemaVersion: 1, kind: 'skill', id: 'invoice', version: 'v1', bodyFile: 'SKILL.md',
  keywords: ['发票'], requires: [{ kind: 'tool', name: 'read' }],
  files: [{ path: 'SKILL.md', bytes: 128, sha256: hash }] };
const at = '2026-10-05T12:00:00.000Z';
const frozen = { version: 1, policyVersion: 'p11-resources-v1', settingsRevision: 1, bundleHash: hash,
  bundleDirectory: 'D:/runtime/resource-bundles/' + hash,
  prompt: null, manifests: [{ ref: skill, manifest }], selectedSkills: [skill], discoveredSkills: [skill], excludedSkills: [] };

describe('P11 resource trust contracts', () => {
  it('limits dedicated Skill tools to names and registered relative files rather than model-supplied owners', () => {
    expect(schema('ListSkillResourcesInputSchema')?.safeParse({ skill: 'invoice' }).success).toBe(true);
    expect(schema('ReadSkillResourceInputSchema')?.safeParse({ skill: 'invoice', path: 'references/guide.md', offset: 0, limit: 4 }).success).toBe(true);
    for (const change of [{ runId: 1 }, { sessionId: 1 }, { version: 'v1' }, { contentHash: hash }, { skill: '../invoice' }])
      expect(schema('ListSkillResourcesInputSchema')?.safeParse({ skill: 'invoice', ...change }).success).toBe(false);
    for (const change of [{ path: '../secret' }, { path: 'C:/secret' }, { path: 'x:stream' }, { path: 'CON.txt' },
      { offset: -1 }, { limit: 3 }, { limit: 16385 }, { runId: 1 }])
      expect(schema('ReadSkillResourceInputSchema')?.safeParse({ skill: 'invoice', path: 'SKILL.md', ...change }).success).toBe(false);
    const list = { ref: skill, bundleHash: hash, files: manifest.files };
    expect(schema('ListSkillResourcesOutputSchema')?.safeParse(list).success).toBe(true);
    expect(schema('ListSkillResourcesOutputSchema')?.safeParse({ ...list, files: [...manifest.files, ...manifest.files] }).success).toBe(false);
    expect(schema('ReadSkillResourceOutputSchema')?.safeParse({ ref: skill, bundleHash: hash, path: 'SKILL.md', sha256: hash,
      offset: 0, text: '规则', totalBytes: 6, nextOffset: null }).success).toBe(true);
  });

  it('strict-ref-and-manifest accepts bounded identities and rejects path aliases or invented fields', () => {
    expect(schema('ResourceRefSchema')?.safeParse(skill).success).toBe(true);
    for (const change of [{ id: '..' }, { version: 'CON' }, { contentHash: 'A'.repeat(64) }, { keywords: ['invented'] }])
      expect(schema('ResourceRefSchema')?.safeParse({ ...skill, ...change }).success).toBe(false);
    expect(schema('ResourceManifestSchema')?.safeParse(manifest).success).toBe(true);
    for (const path of ['../SKILL.md', 'C:/secret', 'references/../../secret', 'references/CON.txt', 'x:stream', 'x\\y', 'x.'])
      expect(schema('ResourceManifestSchema')?.safeParse({ ...manifest, files: [...manifest.files, { path, bytes: 1, sha256: hash }] }).success).toBe(false);
    for (const change of [{ bodyFile: 'prompt.md' }, { files: [] }, { files: [{ ...manifest.files[0], bytes: 65537 }] },
      { files: [...manifest.files, { path: 'skill.md', bytes: 1, sha256: hash }] },
      { requires: [...manifest.requires, ...manifest.requires] }, { keywords: ['duplicate', 'duplicate'] }])
      expect(schema('ResourceManifestSchema')?.safeParse({ ...manifest, ...change }).success).toBe(false);
  });

  it('requires one enabled version per Skill and an exact discovered/excluded partition', () => {
    expect(schema('ResourceSelectionSchema')?.safeParse({ prompt, enabledSkills: [skill] }).success).toBe(true);
    expect(schema('ResourceSelectionSchema')?.safeParse({ prompt, enabledSkills: [skill, { ...skill, version: 'v2' }] }).success).toBe(false);
    expect(schema('FrozenResourcesSchema')?.safeParse(frozen).success).toBe(true);
    expect(schema('FrozenResourcesSchema')?.safeParse({ ...frozen, discoveredSkills: [{ ...skill, contentHash: 'b'.repeat(64) }] }).success).toBe(false);
    expect(schema('FrozenResourcesSchema')?.safeParse({ ...frozen, discoveredSkills: [], excludedSkills: [] }).success).toBe(false);
  });

  it('canonicalizes manifest ordering without changing content or discarding metadata', () => {
    const canonical = Reflect.get(contracts, 'canonicalResourceManifest');
    expect(canonical?.(contracts.ResourceManifestSchema.parse({ ...manifest, keywords: ['税额', '发票'] }))).toBe(
      '{"schemaVersion":1,"kind":"skill","id":"invoice","version":"v1","bodyFile":"SKILL.md","keywords":["发票","税额"],"requires":[{"kind":"tool","name":"read"}],"files":[{"path":"SKILL.md","bytes":128,"sha256":"' + hash + '"}]}');
  });

  it('legacy-resource-omission-is-preserved while resource policy requires its binding', () => {
    const json = { version: 1, policyVersion: 'p8-context-v1', text: 'original request', goalMode: 'answer',
      workspaceContext: null, workingDirectory: null, allowedDocumentIds: [], allowedArtifactIds: [], resourcePolicy: 'none',
      modelProjection: { taskGoal: null, candidate: null, fragments: [], issues: [], gaps: [] },
      budgets: { projectionBytes: 65536, fragmentBytes: 4096, fragments: 32, issueCount: 20, snapshotBytes: 262144 } };
    const old = contracts.ContextSnapshotJsonSchema.parse(json);
    expect(Object.hasOwn(old, 'resourceBinding')).toBe(false);
    expect(contracts.ContextSnapshotJsonSchema.safeParse({ ...json, resourcePolicy: 'p11-resources-v1' }).success).toBe(false);
    expect(contracts.ContextSnapshotJsonSchema.safeParse({ ...json, resourcePolicy: 'p11-resources-v1',
      resourceBinding: { bundleHash: hash, requiredSkill: skill } }).success).toBe(true);
    expect(contracts.ContextSnapshotJsonSchema.safeParse({ ...json, resourceBinding: { bundleHash: hash, requiredSkill: null } }).success).toBe(false);
    const input = { version: 2, text: 'original', promptText: 'frozen', workspaceContext: null, workspaceInput: null,
      allowedDocumentIds: [], allowedArtifactIds: [] };
    expect(Object.hasOwn(contracts.SessionInputContentV2Schema.parse(input), 'resourceBinding')).toBe(false);
    expect(contracts.SessionInputContentV2Schema.safeParse({ ...input, resourceBinding: { bundleHash: hash, requiredSkill: skill } }).success).toBe(true);
    const oldJournal = contracts.ContextObservationsSchema.parse({ version: 1, requests: [] });
    expect(Object.hasOwn(oldJournal, 'resources')).toBe(false);
    expect(contracts.NativeContextObservationsSchema.safeParse({ version: 1, requests: [],
      resources: { version: 1, expansions: [], reads: [], requests: [] } }).success).toBe(true);
  });

  it('rejects duplicate receipts and a claim that a derived source proves body inclusion', () => {
    const expansion = { inputId: 1, nativeEntryId: 'user-1', skill, bundleHash: hash, expandedTextHash: hash, at };
    const journal = { version: 1, expansions: [expansion], reads: [], requests: [] };
    expect(schema('ResourceEvidenceJournalSchema')?.safeParse(journal).success).toBe(true);
    expect(schema('ResourceEvidenceJournalSchema')?.safeParse({ ...journal, expansions: [expansion, expansion] }).success).toBe(false);
    const check = { ref: skill, nativeEntryId: 'summary-1', path: null, scope: 'derived-source', expectedTextHash: null,
      sdkInclusion: 'unknown', wireInclusion: 'unknown', reason: 'derived-source-only' };
    expect(schema('ResourceContentEvidenceSchema')?.safeParse(check).success).toBe(true);
    expect(schema('ResourceContentEvidenceSchema')?.safeParse({ ...check, sdkInclusion: 'confirmed' }).success).toBe(false);
    for (const patch of [{ expectedTextHash: hash }, { sdkInclusion: 'not-included' }, { wireInclusion: 'not-included' }, { nativeEntryId: null }, { reason: 'unrelated' }])
      expect(schema('ResourceContentEvidenceSchema')?.safeParse({ ...check, ...patch }).success).toBe(false);
    const request = { purpose: 'compaction', callSequence: 1, compactionOperationId: 'summary-1', bundleHash: null,
      referencedBundleHashes: [hash], systemPromptHash: hash, inputIds: [1], toolCallIds: [], contentChecks: [check], at };
    expect(schema('ResourceRequestEvidenceSchema')?.safeParse(request).success).toBe(true);
    expect(schema('ResourceRequestEvidenceSchema')?.safeParse({ ...request, compactionOperationId: null }).success).toBe(false);
  });

  it('bounds text pages and rejects absolute, aliased or mid-contract invalid queries', () => {
    expect(schema('ResourceFileRequestSchema')?.safeParse({ ref: skill, path: 'references/字段.md', offset: 0, limit: 4 }).success).toBe(true);
    for (const change of [{ path: '../secret' }, { offset: -1 }, { limit: 3 }, { limit: 16385 }, { offset: 0.5 }])
      expect(schema('ResourceFileRequestSchema')?.safeParse({ ref: skill, path: 'SKILL.md', ...change }).success).toBe(false);
    expect(schema('RunResourceQuerySchema')?.safeParse({ sessionId: 1, runId: 2, absolutePath: 'D:/secret' }).success).toBe(false);
  });
});
