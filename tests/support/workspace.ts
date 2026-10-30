import { readManagedArtifact, createWorkspaceVerifier } from '@flowmate/core';
import type { DocumentRepository } from '../../packages/core/src/storage/repositories.ts';
import { createDocumentService } from '../../packages/data/src/documents.ts';
import { dirname, join } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import type { Database } from 'bun:sqlite';

/** Domain fixtures use the same managed files and pure inspection as production. */
export function createTestWorkspaceVerifier(store: { documents: DocumentRepository; db: Database }, root = dirname(dirname(store.db.filename))) {
  const paths = { root, databaseFile: join(root, 'data', 'app.sqlite'), logsDir: join(root, 'logs'),
    artifactsDir: join(root, 'artifacts'), outputsDir: join(root, 'outputs'), runtimeDir: join(root, 'runtime') };
  const current = { repository: store.documents,
    files: { read: (artifact: Parameters<typeof readManagedArtifact>[1], name?: string) => readManagedArtifact(paths, artifact, name, store.documents.contents!) } };
  const documents = createDocumentService({ paths, files: { async publish() { throw Error('Workspace component inspection cannot import documents.'); } },
    transaction: async operation => store.db.transaction(() => operation(current)).immediate(),
    allowedSourceRoot: join(root, 'source'), now: () => '2026-10-03T00:00:00.000Z' });
  return createWorkspaceVerifier({ inspectMaterial: (ref, scope) => documents.inspectForWorkspace(ref, scope ? {
    repository: scope.documents, files: { read: (artifact, name) => readManagedArtifact(paths, artifact, name, scope.contents) },
  } : current) });
}

/** Explicitly replace historical synthetic bytes with managed material for domain admission tests. */
export function prepareTestWorkspaceVerifier(store: { documents: DocumentRepository; db: Database }, root = dirname(dirname(store.db.filename))) {
  const rows = store.db.query('SELECT id,source_key,source_record_id,version,original_artifact_id,parsed_artifact_id,metadata_json FROM documents').all() as Array<{
    id: number; source_key: string; source_record_id: string; version: string; original_artifact_id: number; parsed_artifact_id: number; metadata_json: string }>;
  mkdirSync(join(root, 'artifacts'), { recursive: true });
  const original = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=', 'base64');
  for (const row of rows) {
    const pageCount = (JSON.parse(row.metadata_json) as { pageCount: number }).pageCount;
    const parsed = Buffer.from(JSON.stringify({ formatVersion: 2, pages: Array.from({ length: pageCount }, (_, index) => ({ page: index + 1,
      blocks: [{ id: `b${index + 1}`, kind: 'text', text: 'Total 113.00', sourceIndex: index, sourceType: 'synthetic', bbox: null }] })),
      completeness: { status: 'complete', checks: [], warnings: [] } }));
    for (const artifact of [{ id: row.original_artifact_id, file: 'original.png', mime: 'image/png', bytes: original },
      { id: row.parsed_artifact_id, file: 'parsed.json', mime: 'application/json', bytes: parsed }]) {
      mkdirSync(join(root, 'artifacts', String(artifact.id)), { recursive: true });
      writeFileSync(join(root, 'artifacts', String(artifact.id), artifact.file), artifact.bytes);
      store.documents.contents!.remember({ ownerKind: 'artifact', ownerId: String(artifact.id), relativePath: artifact.file }, artifact.bytes);
      const metadata = { version: 1, sourceKey: row.source_key, sourceRecordId: row.source_record_id, sourceVersion: row.version,
        files: [{ relativePath: artifact.file, bytes: artifact.bytes.byteLength, mimeType: artifact.mime }] };
      store.db.query('UPDATE artifacts SET relative_path=?,bytes=?,mime_type=?,metadata_json=? WHERE id=?')
        .run(`artifacts/${artifact.id}/${artifact.file}`, artifact.bytes.byteLength, artifact.mime, JSON.stringify(metadata), artifact.id);
    }
  }
  return createTestWorkspaceVerifier(store, root);
}
