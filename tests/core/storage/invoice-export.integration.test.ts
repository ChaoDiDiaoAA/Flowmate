import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'bun:test';
import type { Result } from '@flowmate/contracts';
import { makeSelectedCandidate } from '../../support/selected-candidate.ts';
import { createInvoiceEditService, formatInvoiceExport } from '../../../packages/core/src/invoice-edit/service.ts';
import { createFileStore } from '../../../packages/core/src/storage/file-store.ts';

function required<T>(result: Result<T>): T { if (!result.ok) throw new Error(result.error.code); return result.data; }
function fixture() {
  const store = makeSelectedCandidate();
  const paths = { root: store.root, databaseFile: join(store.root,'data','flowmate.sqlite'), artifactsDir: join(store.root,'artifacts'),
    logsDir: join(store.root,'logs'), outputsDir: join(store.root,'outputs'), runtimeDir: join(store.root,'runtime') };
  const files = createFileStore(paths, store.documents);
  const edits = createInvoiceEditService({ candidates: store.candidates, files, now: () => store.stamp,
    validate: () => ({ ok: true, data: { checks: [], issues: [] } }) });
  return { ...store, edits, files };
}

describe('accepted invoice export', () => {
  it('checks actual managed bytes on original queries without repairing missing or corrupted files', () => {
    const store = fixture();
    required(store.edits.accept({ operationRef: 'accept-query', jobId: store.jobId, candidateId: store.candidateId,
      expectedCandidateId: store.candidateId, expectedRevision: store.selectedWorkspace.revision, dirty: false }));
    const request = { operationRef: 'export-query', candidateId: store.candidateId, format: 'json' as const };
    const reference = required(store.edits.export(request));
    const path = join(store.root, reference.relativePath);
    const bytes = readFileSync(path);
    expect(required(store.edits.queryOperation({ kind: 'export', request }))).toEqual(reference);
    const facts = store.db.query('SELECT * FROM business_events').all();
    const altered = Buffer.from(bytes); altered[0] = altered[0] === 123 ? 91 : 123;
    writeFileSync(path, altered);
    expect(store.edits.queryOperation({ kind: 'export', request })).toMatchObject({ ok: false, error: { code: 'artifact_unavailable' } });
    expect(readFileSync(path)).toEqual(altered);
    unlinkSync(path);
    expect(store.edits.queryOperation({ kind: 'export', request })).toMatchObject({ ok: false, error: { code: 'artifact_unavailable' } });
    expect(store.edits.export(request)).toMatchObject({ ok: false, error: { code: 'artifact_unavailable' } });
    expect(store.db.query('SELECT * FROM business_events').all()).toEqual(facts);
    expect(required(store.jobs.get(store.jobId)).acceptedCandidateId).toBe(store.candidateId);
  });
  it('publishes accepted-only deterministic JSON and recovers an orphan after registration failure', () => {
    const store = fixture(); const request = { operationRef: 'export-once', candidateId: store.candidateId, format: 'json' };
    expect(store.edits.export(request)).toMatchObject({ ok: false, error: { code: 'state_conflict' } });
    required(store.edits.accept({ operationRef: 'accept-export', jobId: store.jobId, candidateId: store.candidateId,
      expectedCandidateId: store.candidateId, expectedRevision: store.selectedWorkspace.revision, dirty: false }));
    store.db.exec("CREATE TRIGGER reject_export BEFORE INSERT ON business_events WHEN NEW.type='candidate_exported' BEGIN SELECT RAISE(ABORT,'export-injected'); END");
    expect(store.edits.export(request)).toMatchObject({ ok: false, error: { code: 'storage_write_failed' } });
    const path = join(store.root,'outputs',`invoice-${store.jobId}-result-1.json`);
    const firstBytes = readFileSync(path);
    expect(JSON.parse(firstBytes.toString())).toMatchObject({ candidateId: store.candidateId, status: 'accepted', origin: 'model', basedOnCandidateId: null });
    expect(store.db.query("SELECT COUNT(*) AS count FROM artifacts WHERE kind='export'").get()).toEqual({ count: 0 });
    store.db.exec('DROP TRIGGER reject_export');
    const exported = required(store.edits.export(request));
    expect(readFileSync(path)).toEqual(firstBytes);
    expect(required(store.edits.export(request))).toEqual(exported);
    expect(store.edits.export({ ...request, format: 'csv' })).toMatchObject({ ok: false, error: { code: 'state_conflict' } });
    writeFileSync(path, 'modified');
    expect(store.edits.export(request)).toMatchObject({ ok: false, error: { code: 'artifact_unavailable' } });
    expect(readFileSync(path,'utf8')).toBe('modified');
  });

  it('keeps CSV growth linear for 200 lines, protects formulas and makes human provenance readable', () => {
    const store = fixture();
    const candidate = required(store.candidates.readByJob({ jobId: store.jobId, candidateId: store.candidateId })).candidate;
    const user = (text: string) => ({ raw: text, normalized: text, state: 'present' as const, alternatives: [], sources: [], valueOrigin: 'user-provided' as const });
    candidate.origin = 'human_edit'; candidate.basedOnCandidateId = 99; candidate.runId = null; candidate.toolCallId = null;
    candidate.fields.invoiceNumber = user('=SUM(A1)'); candidate.fields.totalAmount = user('999999999999999999.123456');
    const line = { description: user('<script>bad</script>'), quantity: user('1'), unit: user('each'), unitPrice: user('1.000001'),
      netAmount: user('1.000001'), taxRate: user('0'), taxAmount: user('0'), totalAmount: user('1.000001') };
    candidate.lines = Array.from({ length: 100 }, () => structuredClone(line));
    candidate.notes = ['One global note'];
    const first = formatInvoiceExport(candidate, { id: 1, version: 'v1' }, 'csv');
    candidate.lines = Array.from({ length: 200 }, () => structuredClone(line));
    const second = formatInvoiceExport(candidate, { id: 1, version: 'v1' }, 'csv');
    expect(second.length).toBeLessThan(first.length * 3);
    expect(second).toContain("\"'=SUM(A1)\"");
    expect(second).toContain('999999999999999999.123456');
    expect(second.match(/One global note/g)).toHaveLength(1);
    expect(second).toContain('headerMetadata'); expect(second).toContain('lineMetadata');
    const markdown = formatInvoiceExport(candidate, { id: 1, version: 'v1' }, 'markdown');
    expect(markdown).toContain('Origin: human_edit'); expect(markdown).toContain('Basis candidate: 99');
    expect(markdown).toContain('user-provided'); expect(markdown).toContain('```json');
    expect(markdown).toContain('\\<script\\>bad\\</script\\>');
    const noLines = formatInvoiceExport({ ...candidate, lines: [] }, { id: 1, version: 'v1' }, 'csv');
    expect(noLines.split('\r\n').filter(Boolean)).toHaveLength(2);
  });

  it('rejects a foreign filename and damaged artifact provenance instead of returning a false reference', () => {
    const store = fixture();
    required(store.edits.accept({ operationRef: 'accept-path', jobId: store.jobId, candidateId: store.candidateId,
      expectedCandidateId: store.candidateId, expectedRevision: store.selectedWorkspace.revision, dirty: false }));
    const input = { operationRef: 'foreign-path', candidateId: store.candidateId, format: 'json' as const,
      relativePath: 'outputs/invoice-999-result-999.json', bytes: 1, at: store.stamp };
    expect(store.candidates.registerExport(input)).toMatchObject({ ok: false, error: { code: 'state_conflict' } });
    const request = { operationRef: 'export-path', candidateId: store.candidateId, format: 'json' };
    const exported = required(store.edits.export(request));
    store.db.query("UPDATE artifacts SET metadata_json=json_set(metadata_json,'$.basedOnCandidateId',999) WHERE id=?").run(exported.artifactId);
    expect(store.candidates.findExport({ ...request, format: 'json' })).toMatchObject({ ok: false, error: { code: 'storage_corrupt' } });
  });
});
