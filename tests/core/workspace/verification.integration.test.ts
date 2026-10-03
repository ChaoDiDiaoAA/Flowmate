import { describe, expect, it } from 'bun:test';
import { createWorkspaceVerifier, requireValidWorkspace } from '../../../packages/core/src/workspace/verification.ts';
import { appError, fail, invoiceLineFields } from '@flowmate/contracts';
import { makeSelectedCandidate } from '../../support/selected-candidate.ts';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

function parsedFixture(f: ReturnType<typeof makeSelectedCandidate>, pages: Array<{ page: number; blocks: Array<{ id: string }> }>) {
  const bytes = Buffer.from(JSON.stringify({ formatVersion: 2, pages: pages.map(page => ({ ...page,
    blocks: page.blocks.map(block => ({ ...block, kind: 'text', text: 'Controlled source', sourceIndex: 0, sourceType: 'synthetic', bbox: null })) })),
    completeness: { status: 'complete', checks: [], warnings: [] } }));
  writeFileSync(join(f.root, 'artifacts', '2', 'parsed.json'), bytes);
  const artifact = f.documents.getArtifact(2), document = f.documents.get(1);
  if (!artifact.ok || !document.ok) throw new Error('fixture_material_missing');
  f.db.query('UPDATE artifacts SET bytes=?,metadata_json=? WHERE id=2').run(bytes.length,
    JSON.stringify({ ...artifact.data.metadata, files: [{ relativePath: 'parsed.json', bytes: bytes.length, mimeType: 'application/json' }] }));
  const metadata = f.db.query('SELECT metadata_json FROM documents WHERE id=1').get() as { metadata_json: string };
  f.db.query('UPDATE documents SET metadata_json=? WHERE id=1').run(JSON.stringify({ ...JSON.parse(metadata.metadata_json), pageCount: pages.length }));
}

describe('Workspace selection verifies actual source and saved candidate', () => {
  it('checks a registered missing header field, actual row bounds, and reserved document fields', () => {
    const fixture = makeSelectedCandidate();
    const candidate = fixture.candidates.readByJob({ jobId: fixture.jobId, candidateId: fixture.candidateId });
    expect(candidate.ok).toBe(true);
    if (!candidate.ok) return;
    const saved = candidate.data.candidate;
    const input = { documentRef: { id: 1, version: 'v1' }, jobId: fixture.jobId,
      candidateRef: { id: fixture.candidateId, sequence: 1 }, candidate: { id: fixture.candidateId, sequence: 1,
        fields: saved.fields, lines: saved.lines, issues: saved.issues } };
    expect(fixture.verify({ ...input, selection: { formatVersion: 1, kind: 'field', target: 'candidate',
      targetId: fixture.candidateId, targetVersion: 1, fieldPath: 'fields.taxAmount' } })).toMatchObject({ ok: true, data: { invalidReferences: [] } });
    expect(fixture.verify({ ...input, selection: { formatVersion: 1, kind: 'line', target: 'candidate',
      targetId: fixture.candidateId, targetVersion: 1, lineIndex: 0 } })).toMatchObject({ ok: true, data: { invalidReferences: ['selection_location_missing'] } });
    expect(fixture.verify({ ...input, selection: { formatVersion: 1, kind: 'field', target: 'document',
      targetId: 1, targetVersion: 'v1', fieldPath: 'taxAmount' } })).toMatchObject({ ok: true, data: { invalidReferences: ['selection_unsupported'] } });
  });

  it('checks parsed artifact and page/block locations rather than accepting shape alone', () => {
    const fixture = makeSelectedCandidate();
    const input = { documentRef: { id: 1, version: 'v1' }, jobId: null, candidateRef: null, candidate: null };
    const source = { formatVersion: 1 as const, kind: 'source' as const, target: 'document' as const, targetId: 1,
      targetVersion: 'v1', artifactId: 2, page: 1, block: 'b1' };
    expect(fixture.verify({ ...input, selection: source })).toMatchObject({ ok: true, data: { invalidReferences: [] } });
    expect(fixture.verify({ ...input, selection: { ...source, artifactId: 1 } })).toMatchObject({ ok: true, data: { invalidReferences: ['selection_target_mismatch'] } });
    expect(fixture.verify({ ...input, selection: { ...source, block: 'b2' } })).toMatchObject({ ok: true, data: { invalidReferences: ['selection_location_missing'] } });
    expect(fixture.verify({ ...input, selection: { ...source, page: 2 } })).toMatchObject({ ok: true, data: { invalidReferences: ['selection_location_missing'] } });
  });

  it('diagnostic ok cannot authorize and a transient inspection stays an error', () => {
    const verify = createWorkspaceVerifier({ inspectMaterial: () => fail(appError('input_unavailable', 'input', 'Transient fixture.', true)) });
    expect(verify({ documentRef: { id: 1, version: 'v1' }, jobId: null, candidateRef: null, candidate: null, selection: null }))
      .toMatchObject({ ok: false, error: { code: 'input_unavailable' } });
    expect(requireValidWorkspace({ invalidReferences: ['selection_location_missing'], material: null }))
      .toMatchObject({ ok: false, error: { code: 'selection_invalid' } });
    expect(requireValidWorkspace({ invalidReferences: ['artifact_missing_or_invalid'], material: null }))
      .toMatchObject({ ok: false, error: { code: 'input_unavailable' } });
  });

  it('selects actual saved line fields even with missing values, and rejects false paths and other versions', () => {
    const f = makeSelectedCandidate();
    f.db.query('UPDATE invoice_candidates SET lines_json=? WHERE id=?').run(JSON.stringify({ version: 1,
      items: [Object.fromEntries(invoiceLineFields.map(name => [name, { raw: null, normalized: null, state: 'missing', alternatives: [], sources: [] }]))] }), f.candidateId);
    const saved = f.candidates.readByJob({ jobId: f.jobId, candidateId: f.candidateId });
    if (!saved.ok) throw new Error(saved.error.code);
    const input = { documentRef: { id: 1, version: 'v1' }, jobId: f.jobId, candidateRef: { id: f.candidateId, sequence: 1 },
      candidate: { id: f.candidateId, sequence: 1, fields: saved.data.candidate.fields, lines: saved.data.candidate.lines, issues: saved.data.candidate.issues } };
    const field = { formatVersion: 1 as const, kind: 'field' as const, target: 'candidate' as const, targetId: f.candidateId, targetVersion: 1, fieldPath: 'lines.0.taxAmount' };
    expect(f.verify({ ...input, selection: field })).toMatchObject({ ok: true, data: { invalidReferences: [] } });
    expect(f.verify({ ...input, selection: { ...field, fieldPath: 'lines.1.taxAmount' } })).toMatchObject({ ok: true, data: { invalidReferences: ['selection_location_missing'] } });
    expect(f.verify({ ...input, selection: { ...field, fieldPath: 'metadata.taxAmount' } })).toMatchObject({ ok: true, data: { invalidReferences: ['selection_unsupported'] } });
    expect(f.verify({ ...input, selection: { ...field, targetVersion: 2 } })).toMatchObject({ ok: true, data: { invalidReferences: ['selection_version_mismatch'] } });
    expect(f.verify({ ...input, selection: { ...field, targetId: f.candidateId + 1 } })).toMatchObject({ ok: true, data: { invalidReferences: ['selection_target_mismatch'] } });
  });

  it('requires page/block together to identify the same source, and block-only to be globally unique', () => {
    const f = makeSelectedCandidate();
    parsedFixture(f, [{ page: 1, blocks: [{ id: 'b1' }, { id: 'b2' }] }, { page: 2, blocks: [{ id: 'b1' }, { id: 'b3' }] }]);
    const input = { documentRef: { id: 1, version: 'v1' }, jobId: null, candidateRef: null, candidate: null };
    const source = { formatVersion: 1 as const, kind: 'source' as const, target: 'document' as const, targetId: 1, targetVersion: 'v1', artifactId: 2 };
    expect(f.verify({ ...input, selection: { ...source, block: 'b1' } })).toMatchObject({ ok: true, data: { invalidReferences: ['selection_location_missing'] } });
    expect(f.verify({ ...input, selection: { ...source, page: 2, block: 'b1' } })).toMatchObject({ ok: true, data: { invalidReferences: [] } });
    expect(f.verify({ ...input, selection: { ...source, page: 2, block: 'b2' } })).toMatchObject({ ok: true, data: { invalidReferences: ['selection_location_missing'] } });
    expect(f.verify({ ...input, selection: { ...source, block: 'b3' } })).toMatchObject({ ok: true, data: { invalidReferences: [] } });
  });

  it.each(['page', 'block'] as const)('duplicate %s identity is invalid material instead of a first-match location', duplicate => {
    const f = makeSelectedCandidate();
    parsedFixture(f, duplicate === 'page' ? [{ page: 1, blocks: [{ id: 'b1' }] }, { page: 1, blocks: [{ id: 'b2' }] }]
      : [{ page: 1, blocks: [{ id: 'b1' }, { id: 'b1' }] }]);
    expect(f.verify({ documentRef: { id: 1, version: 'v1' }, jobId: null, candidateRef: null, candidate: null, selection: null }))
      .toMatchObject({ ok: true, data: { material: { kind: 'invalid', reason: 'artifact_missing_or_invalid' }, invalidReferences: ['artifact_missing_or_invalid'] } });
  });
});
