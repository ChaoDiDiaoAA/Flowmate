import { expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { resolveProductPaths } from '@flowmate/shared';
import { openDatabase, createFileStore } from '../../../packages/core/src/index.ts';
import { createApplication } from '../../../apps/composition.ts';
import { mkdtempSync } from '../../support/resources.ts';
import { defaultProductSettings } from '../../../packages/core/src/configuration/settings.ts';
import { backupLegacyStore } from '../../../packages/core/src/storage/migration-020.ts';

function legacyStore() {
  const root = mkdtempSync(join(tmpdir(), 'flowmate-upgrade-direct-'));
  const result = resolveProductPaths(root); if (!result.ok) throw new Error(result.error.code);
  const paths = result.data;
  mkdirSync(dirname(paths.databaseFile), { recursive: true });
  const db = new Database(paths.databaseFile);
  db.exec('PRAGMA foreign_keys=ON');
  const directory = join(import.meta.dir, '../../../packages/core/src/storage/migrations');
  for (const file of readdirSync(directory).filter(file => /^(?:00[1-9]|01\d)_/.test(file)).sort()) {
    const version = Number(file.slice(0, 3)), sql = readFileSync(join(directory, file), 'utf8');
    if (version === 17) db.exec('PRAGMA foreign_keys=OFF; PRAGMA legacy_alter_table=ON');
    for (const statement of sql.split(/^\s*-- statement\s*$/m).filter(value => value.trim())) db.exec(statement);
    if (db.inTransaction) db.exec('COMMIT');
    if (version === 10 || version === 17) db.exec('PRAGMA foreign_keys=ON; PRAGMA legacy_alter_table=OFF');
  }
  return { root, paths, db };
}

it('creates the direct-content schema and preserves immutable original bytes across reads and restarts', () => {
  const root = mkdtempSync(join(tmpdir(), 'flowmate-direct-content-'));
  const resolved = resolveProductPaths(root); if (!resolved.ok) throw new Error(resolved.error.code);
  const opened = openDatabase(resolved.data); expect(opened.ok).toBe(true); if (!opened.ok) throw new Error(opened.error.code);
  const owner = { ownerKind: 'artifact', ownerId: '1', relativePath: 'original.txt' };
  const original = Uint8Array.from([1, 2, 3]);
  try {
    expect(opened.data.db.query('SELECT max(version) AS version FROM schema_migrations').get()).toEqual({ version: 20 });
    expect(opened.data.db.query("SELECT name FROM pragma_table_info('session_inputs') WHERE name='request_hash'").get()).toBeNull();
    expect(opened.data.db.query("SELECT name FROM pragma_table_info('tool_calls') WHERE name='evidence_revision'").get()).toEqual({ name: 'evidence_revision' });
    opened.data.contents.remember(owner, original);
    original[0] = 9;
    const first = opened.data.contents.read(owner); expect(first).toEqual(Uint8Array.from([1, 2, 3]));
    if (!first) throw new Error('Missing original managed bytes');
    first[1] = 9;
    expect(opened.data.contents.read(owner)).toEqual(Uint8Array.from([1, 2, 3]));
    expect(() => opened.data.contents.remember(owner, Uint8Array.from([1, 2, 3]))).not.toThrow();
    expect(() => opened.data.contents.remember(owner, Uint8Array.from([3, 2, 1]))).toThrow('managed_file_content_conflict');
    expect(() => opened.data.db.query('UPDATE managed_file_contents SET content=? WHERE owner_kind=? AND owner_id=? AND relative_path=?')
      .run(Uint8Array.from([3, 2, 1]), owner.ownerKind, owner.ownerId, owner.relativePath)).toThrow();
  } finally { opened.data.close(); }
  const restarted = openDatabase(resolved.data); expect(restarted.ok).toBe(true); if (!restarted.ok) throw new Error(restarted.error.code);
  try { expect(restarted.data.contents.read(owner)).toEqual(Uint8Array.from([1, 2, 3])); }
  finally { restarted.data.close(); }
});

it('backs up a v19 store and preserves IDs and native text while exposing unverified legacy files as unavailable', () => {
  const f = legacyStore(), at = '2026-10-01T00:00:00.000Z';
  const original = Buffer.from('ORIGINAL'), parsed = Buffer.from('{}');
  const legacyDigest = 'a'.repeat(64);
  for (const [id, kind, name, data, mimeType] of [[1, 'original', 'original.png', original, 'image/png'], [2, 'parsed', 'parsed.json', parsed, 'application/json']] as const) {
    mkdirSync(join(f.root, 'artifacts', String(id)), { recursive: true });
    writeFileSync(join(f.root, 'artifacts', String(id), name), data);
    const metadata = { version: 1, sourceKey: 'legacy', sourceRecordId: 'invoice', sourceVersion: 'legacy-version',
      files: [{ relativePath: name, bytes: data.length, mimeType, sha256: legacyDigest }] };
    f.db.query('INSERT INTO artifacts(id,kind,relative_path,bytes,mime_type,metadata_json,created_at) VALUES(?,?,?,?,?,?,?)')
      .run(id, kind, `artifacts/${id}/${name}`, data.length, mimeType, JSON.stringify(metadata), at);
    writeFileSync(join(f.root, 'artifacts', String(id), 'publish.json'), JSON.stringify({ ...metadata, kind,
      files: [{ name, bytes: data.length, mimeType, sha256: legacyDigest }] }));
  }
  f.db.query('INSERT INTO documents(id,source_key,source_record_id,version,original_artifact_id,parsed_artifact_id,status,metadata_json,created_at,updated_at) VALUES(1,?,?,?,?,?,?,?,?,?)')
    .run('legacy', 'invoice', 'legacy-version', 1, 2, 'available', JSON.stringify({ version: 2, sampleId: '000001', pageCount: 1,
      warnings: [], allowedUsesClaim: [], licenseVerification: 'not_verified', unavailableReason: null }), at, at);
  const header = SessionManager.inMemory(f.root).getHeader();
  if (!header) throw new Error('Missing native session header');
  const entry = { id: 'user-1', parentId: null, type: 'message', timestamp: at,
    message: { role: 'user', content: 'Keep literal contentHash and sha256 in this user text.', timestamp: 1 } };
  const entryText = JSON.stringify(entry);
  f.db.query('INSERT INTO sessions(id,native_session_id,title,created_at,updated_at) VALUES(1,?,?,?,?)').run(header.id, 'Legacy chat', at, at);
  f.db.query('INSERT INTO session_native_history(session_id,storage_version,header_json,leaf_id,entry_count,unusable) VALUES(1,1,?,?,1,0)').run(JSON.stringify(header), entry.id);
  f.db.query('INSERT INTO session_native_entries(session_id,sequence,entry_id,entry_json) VALUES(1,0,?,?)').run(entry.id, entryText);
  const settings = JSON.stringify({ ...defaultProductSettings(), version: 5, revision: 3 });
  writeFileSync(join(f.root, 'data', 'settings.json'), settings);
  mkdirSync(join(f.root, 'security', 'credentials'), { recursive: true });
  writeFileSync(join(f.root, 'security', 'credentials', 'legacy-encrypted.json'), '{"version":1,"ciphertext":"encrypted"}');
  f.db.close();
  const opened = openDatabase(f.paths); expect(opened.ok).toBe(true); if (!opened.ok) throw new Error(opened.error.code);
  try {
    const document = opened.data.documents.get(1);
    expect(document).toMatchObject({ ok: true, data: { documentRef: { id: 1, version: 'legacy-version' }, status: 'unavailable', unavailableReason: expect.stringContaining('Re-import') } });
    expect(opened.data.db.query('SELECT entry_json FROM session_native_entries').get()).toEqual({ entry_json: entryText });
    expect(opened.data.db.query('SELECT unusable FROM session_native_history').get()).toEqual({ unusable: 0 });
    expect(opened.data.db.query('SELECT count(*) AS count FROM managed_file_contents').get()).toEqual({ count: 0 });
    const artifact = opened.data.documents.getArtifact(1); if (!artifact.ok) throw new Error(artifact.error.code);
    expect(createFileStore(f.paths, opened.data.documents).read(artifact.data)).toMatchObject({ ok: false });
    expect(readFileSync(join(f.root, 'artifacts', '1', 'original.png'))).toEqual(original);
    expect(readFileSync(join(f.root, 'artifacts', '1', 'publish.json'), 'utf8')).not.toContain('sha256');
    const backups = readdirSync(join(f.root, 'data')).filter(name => name.startsWith('pre-v20-'));
    expect(backups).toHaveLength(1);
    const backupRoot = join(f.root, 'data', backups[0]!);
    expect(readFileSync(join(backupRoot, 'settings.json'), 'utf8')).toBe(settings);
    expect(readFileSync(join(backupRoot, 'security', 'credentials', 'legacy-encrypted.json'), 'utf8')).toContain('encrypted');
    expect(readFileSync(join(backupRoot, 'artifacts', '1', 'publish.json'), 'utf8')).toContain(legacyDigest);
    const old = new Database(join(backupRoot, 'app.sqlite'), { readonly: true });
    try { expect(old.query('SELECT max(version) AS version FROM schema_migrations').get()).toEqual({ version: 19 }); }
    finally { old.close(); }
  } finally { opened.data.close(); }
  const restarted = openDatabase(f.paths); expect(restarted.ok).toBe(true); if (restarted.ok) restarted.data.close();
  expect(readdirSync(join(f.root, 'data')).filter(name => name.startsWith('pre-v20-'))).toHaveLength(1);
});

it('retains original Run resource facts under an opaque bundle ID and exposes a gap without trusting legacy disk content', async () => {
  const f = legacyStore(), at = '2026-10-01T00:00:00.000Z', header = SessionManager.inMemory(f.root).getHeader();
  if (!header) throw new Error('Missing native session header');
  f.db.query('INSERT INTO sessions(id,native_session_id,title,created_at,updated_at) VALUES(1,?,?,?,?)').run(header.id, 'Legacy resources', at, at);
  f.db.query('INSERT INTO session_native_history(session_id,storage_version,header_json,leaf_id,entry_count,unusable) VALUES(1,1,?,NULL,0,0)').run(JSON.stringify(header));
  const legacyRef = { kind: 'prompt', id: 'invoice', version: 'v1', contentHash: 'a'.repeat(64) };
  const resources = { version: 1, policyVersion: 'p11-resources-v1', settingsRevision: 7, bundleHash: 'b'.repeat(64),
    bundleDirectory: join(f.paths.runtimeDir, 'resource-bundles', 'b'.repeat(64)), prompt: legacyRef,
    selectedSkills: [], discoveredSkills: [], excludedSkills: [], manifests: [{ ref: legacyRef, manifest: {
      schemaVersion: 1, kind: 'prompt', id: 'invoice', version: 'v1', bodyFile: 'prompt.md', keywords: [], requires: [],
      files: [{ path: 'prompt.md', bytes: 1, sha256: 'c'.repeat(64) }] } }] };
  const config = { version: 1, name: 'Legacy resource facts', revision: 1, requestedModel: { provider: 'fixture', model: 'offline' },
    resolvedModel: { provider: 'fixture', model: 'offline' }, api: 'openai-completions', endpoint: null,
    sdk: { codingAgent: '0.85.1', ai: '0.85.1' }, parameters: { maxRetries: 0, maxRetryDelayMs: 2000 },
    limits: { timeoutMs: 60000, stopGraceMs: 5000 }, native: { authSource: 'pi-native', modelsSelection: null }, resources,
    agent: { policyVersion: 'p2-invoice-chat-v1', nativeSessionId: header.id, systemPrompt: 'Legacy instructions', thinkingLevel: 'off',
      resourcePolicy: 'p11-resources-v1', historyPolicy: 'memory-only', maxContextBytes: 524288, maxOutputBytes: 262144,
      maxAssistantContentBytes: 524288, maxModelCalls: 1, sessionRetry: false } };
  f.db.query(`INSERT INTO runs(id,kind,session_id,scope_json,status,goal,input_json,config_json,output_json,cleanup_json,usage_json,created_at,ended_at,stopped_at)
    VALUES(1,'agent',1,?,'completed','Legacy question',?,?,?,?,?,?,?,?)`).run(JSON.stringify({ version: 1, mode: 'chat-text', toolNames: [], resourcePaths: [] }),
      JSON.stringify({ version: 1, goal: 'Legacy question', text: 'Original question', messageTimestamp: 1 }), JSON.stringify(config),
      JSON.stringify({ version: 1, text: 'Original answer', partial: false, stopReason: 'stop', responseId: 'r1', responseModel: 'offline', nativeOutcomeHash: 'd'.repeat(64), agent: { nativeSessionId: header.id, turnCount: 1, modelCallCount: 1 } }),
      JSON.stringify({ version: 1, stopped: true, stopReason: 'native-stop', errors: [], lateObservationRequired: false }),
      JSON.stringify({ version: 1, source: 'unknown', reason: 'legacy', sdkValues: null, attempts: 1, attemptsComplete: true, costSource: null, updatedAt: at }), at, at, at);
  const sourceText = 'Original research source', oldSourcePath = `artifacts/research/1/${'e'.repeat(64)}.txt`;
  f.db.query('INSERT INTO artifacts(id,kind,relative_path,bytes,mime_type,metadata_json,created_at) VALUES(1,?,?,?,?,?,?)')
    .run('original', 'artifacts/1/source.txt', Buffer.byteLength(sourceText), 'text/plain', JSON.stringify({ version: 1, sourceKey: 'research-local-v1', sourceRecordId: 'Original source', sourceVersion: 'legacy-source',
      files: [{ relativePath: 'source.txt', bytes: Buffer.byteLength(sourceText), mimeType: 'text/plain', sha256: 'e'.repeat(64) }] }), at);
  f.db.query('INSERT INTO research_tasks(id,session_id,title,source_policy_json,created_at,updated_at) VALUES(1,1,?,?,?,?)')
    .run('Legacy research', JSON.stringify({ web: false, domains: [], artifactIds: [1], documentIds: [] }), at, at);
  f.db.query('INSERT INTO tool_calls(id,run_id,session_id,native_tool_call_id,tool_name,tool_version,effect,args_json,status,result_json,delivery_json,cleanup_json,requested_at,started_at,ended_at,stopped_at) VALUES(1,1,1,?,?,?,?,?,?,?,?,?,?,?,?,?)')
    .run('source-tool', 'read_research_local', 'v1', 'READ', '{}', 'succeeded', JSON.stringify({ ok: true, data: {} }), '{}', '{}', at, at, at, at);
  f.db.query('INSERT INTO research_sources(id,research_id,run_id,tool_call_id,artifact_id,body_json,created_at) VALUES(1,1,1,1,1,?,?)')
    .run(JSON.stringify({ kind: 'local', address: 'artifact:1', title: 'Original source', artifactId: 1, documentId: null, fetchedAt: at,
      publishedAt: null, relativePath: oldSourcePath, bytes: Buffer.byteLength(sourceText), characters: sourceText.length, truncated: false, contentHash: 'e'.repeat(64) }), at);
  mkdirSync(join(f.root, 'artifacts', 'research', '1'), { recursive: true }); writeFileSync(join(f.root, oldSourcePath), sourceText);
  f.db.close();
  const created = await createApplication({ paths: f.paths }); expect(created.ok).toBe(true); if (!created.ok) throw new Error(created.error.code);
  let id: string;
  try {
    const view = await created.data.queryRunResources({ sessionId: 1, runId: 1 });
    expect(view).toMatchObject({ ok: true, data: { frozen: { version: 2, settingsRevision: 7, prompt: { kind: 'prompt', id: 'invoice', version: 'v1' } }, evidence: null, gap: 'bundle-unavailable' } });
    if (!view.ok || !view.data.frozen) throw new Error('Missing original resource facts');
    id = view.data.frozen.bundleId; expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(await created.data.readRunResourceFile({ sessionId: 1, runId: 1, ref: view.data.frozen.prompt!, path: 'prompt.md' })).toMatchObject({ ok: false });
    expect(await created.data.querySession(1)).toMatchObject({ ok: true, data: { availability: 'unusable' } });
    expect(await created.data.queryResearchEvidence({ researchId: 1, sourceSnapshotId: 1 })).toMatchObject({ ok: false, error: { code: 'research_evidence_incomplete', message: expect.stringContaining('historical source') } });
  } finally { await created.data.close(); }
  const reopened = openDatabase(f.paths); expect(reopened.ok).toBe(true); if (!reopened.ok) throw new Error(reopened.error.code);
  try { const run = reopened.data.runs.get(1); if (!run.ok) throw new Error(run.error.code);
    expect((run.data.config.resources as { bundleId: string }).bundleId).toBe(id!);
    expect(run.data.output).not.toHaveProperty('nativeOutcomeHash');
    expect(reopened.data.research.listSources({ researchId: 1, limit: 10 })).toMatchObject({ ok: true, data: { items: [{ sourceSnapshotId: 1, toolCallId: 1, relativePath: 'artifacts/research/1/source-1.txt', verificationGap: 'legacy-original-unavailable' }] } });
    expect(readFileSync(join(f.root, 'artifacts', 'research', '1', 'source-1.txt'), 'utf8')).toBe(sourceText);
    const backupName = readdirSync(join(f.root, 'data')).find(name => name.startsWith('pre-v20-')); if (!backupName) throw new Error('Missing legacy backup');
    expect(readFileSync(join(f.root, 'data', backupName, oldSourcePath), 'utf8')).toBe(sourceText);
    expect(reopened.data.db.query('SELECT count(*) AS count FROM managed_file_contents').get()).toEqual({ count: 0 }); }
  finally { reopened.data.close(); }
});

it('reimports a legacy research material with the same title and text while preserving its visible verification gap', async () => {
  const f = legacyStore(), at = '2026-10-01T00:00:00.000Z', text = 'Original research facts';
  mkdirSync(join(f.root, 'artifacts', '1'), { recursive: true }); writeFileSync(join(f.root, 'artifacts', '1', 'source.txt'), text);
  f.db.query('INSERT INTO artifacts(id,kind,relative_path,bytes,mime_type,metadata_json,created_at) VALUES(1,?,?,?,?,?,?)')
    .run('original', 'artifacts/1/source.txt', Buffer.byteLength(text), 'text/plain', JSON.stringify({ version: 1, sourceKey: 'research-local-v1', sourceRecordId: 'Original source', sourceVersion: 'legacy-source',
      files: [{ relativePath: 'source.txt', bytes: Buffer.byteLength(text), mimeType: 'text/plain', sha256: 'a'.repeat(64) }] }), at);
  f.db.close();
  const created = await createApplication({ paths: f.paths }); expect(created.ok).toBe(true); if (!created.ok) throw new Error(created.error.code);
  let artifactId = 0;
  try {
    const imported = await created.data.importResearchMaterial({ title: 'Original source', format: 'text', text });
    expect(imported).toMatchObject({ ok: true, data: { title: 'Original source', format: 'text' } }); if (!imported.ok) throw new Error(imported.error.code);
    expect(imported.data.artifactId).not.toBe(1); expect(imported.data).not.toHaveProperty('verificationGap'); artifactId = imported.data.artifactId;
  } finally { await created.data.close(); }
  const reopened = openDatabase(f.paths); expect(reopened.ok).toBe(true); if (!reopened.ok) throw new Error(reopened.error.code);
  try {
    expect(reopened.data.research.listMaterials({ limit: 10 })).toMatchObject({ ok: true, data: { items: [{ artifactId }, { artifactId: 1, verificationGap: 'legacy-original-unavailable' }] } });
    const current = reopened.data.documents.getArtifact(artifactId); if (!current.ok) throw new Error(current.error.code);
    expect(createFileStore(f.paths, reopened.data.documents).read(current.data)).toEqual({ ok: true, data: new Uint8Array(Buffer.from(text)) });
    const old = reopened.data.documents.getArtifact(1); if (!old.ok) throw new Error(old.error.code);
    expect(createFileStore(f.paths, reopened.data.documents).read(old.data)).toMatchObject({ ok: false, error: { code: 'artifact_unavailable' } });
  } finally { reopened.data.close(); }
});

it('reimports a prepared invoice as a new verified version while retaining the unavailable legacy document', async () => {
  const f = legacyStore(), at = '2026-10-01T00:00:00.000Z', sourceText = 'Invoice total 123.00';
  for (const [id, kind, name, bytes, mimeType] of [[1, 'original', 'source.md', Buffer.from(sourceText), 'text/markdown'], [2, 'parsed', 'parsed.json', Buffer.from('{}'), 'application/json']] as const) {
    mkdirSync(join(f.root, 'artifacts', String(id)), { recursive: true }); writeFileSync(join(f.root, 'artifacts', String(id), name), bytes);
    f.db.query('INSERT INTO artifacts(id,kind,relative_path,bytes,mime_type,metadata_json,created_at) VALUES(?,?,?,?,?,?,?)')
      .run(id, kind, `artifacts/${id}/${name}`, bytes.length, mimeType, JSON.stringify({ version: 1, sourceKey: 'prepared-invoice', sourceRecordId: 'old-prepared', sourceVersion: 'legacy-version',
        files: [{ relativePath: name, bytes: bytes.length, mimeType, sha256: 'a'.repeat(64) }] }), at);
  }
  f.db.query('INSERT INTO documents(id,source_key,source_record_id,version,original_artifact_id,parsed_artifact_id,status,metadata_json,created_at,updated_at) VALUES(1,?,?,?,?,?,?,?,?,?)')
    .run('prepared-invoice', 'old-prepared', 'legacy-version', 1, 2, 'available', JSON.stringify({ version: 2, pageCount: 1, warnings: [], allowedUsesClaim: [], licenseVerification: 'caller-supplied', unavailableReason: null }), at, at);
  f.db.close();
  const created = await createApplication({ paths: f.paths }); expect(created.ok).toBe(true); if (!created.ok) throw new Error(created.error.code);
  let documentId = 0;
  try {
    const imported = await created.data.importPreparedInvoiceMaterial({ contract: 'flowmate-prepared-invoice/v1', sample: 'old-prepared', sourceText,
      original: { name: 'source.md', base64: Buffer.from(sourceText).toString('base64') },
      pages: [{ page: 1, blocks: [{ id: 'b1', kind: 'text', text: sourceText, sourceIndex: 0, sourceType: 'prepared-text', bbox: null }] }] });
    expect(imported).toMatchObject({ ok: true, data: { status: 'available' } }); if (!imported.ok) throw new Error(imported.error.code);
    expect(imported.data.documentRef.id).not.toBe(1); expect(imported.data.documentRef.version).not.toBe('legacy-version'); documentId = imported.data.documentRef.id;
  } finally { await created.data.close(); }
  const reopened = openDatabase(f.paths); expect(reopened.ok).toBe(true); if (!reopened.ok) throw new Error(reopened.error.code);
  try {
    expect(reopened.data.documents.get(1)).toMatchObject({ ok: true, data: { documentRef: { id: 1, version: 'legacy-version' }, status: 'unavailable', unavailableReason: expect.stringContaining('Re-import') } });
    const current = reopened.data.documents.get(documentId); if (!current.ok) throw new Error(current.error.code);
    const artifact = reopened.data.documents.getArtifact(current.data.originalArtifactId); if (!artifact.ok) throw new Error(artifact.error.code);
    expect(createFileStore(f.paths, reopened.data.documents).read(artifact.data)).toEqual({ ok: true, data: new Uint8Array(Buffer.from(sourceText)) });
  } finally { reopened.data.close(); }
});

it('rolls back SQL and restores earlier file rewrites when a later legacy manifest is invalid', () => {
  const f = legacyStore(), at = '2026-10-01T00:00:00.000Z';
  const originals = [JSON.stringify({ version: 1, files: [{ name: 'source.md', bytes: 1, mimeType: 'text/markdown', sha256: 'a'.repeat(64) }] }), '{broken'];
  for (const id of [1, 2]) {
    const metadata = JSON.stringify({ version: 1, sourceKey: 'legacy', sourceRecordId: String(id), sourceVersion: 'v1', files: [{ relativePath: 'source.md', bytes: 1, mimeType: 'text/markdown', sha256: 'a'.repeat(64) }] });
    f.db.query('INSERT INTO artifacts(id,kind,relative_path,bytes,mime_type,metadata_json,created_at) VALUES(?,?,?,?,?,?,?)').run(id, 'original', `artifacts/${id}/source.md`, 1, 'text/markdown', metadata, at);
    mkdirSync(join(f.root, 'artifacts', String(id)), { recursive: true });
    writeFileSync(join(f.root, 'artifacts', String(id), 'publish.json'), originals[id - 1]!);
  }
  f.db.close();
  expect(openDatabase(f.paths)).toMatchObject({ ok: false });
  const db = new Database(f.paths.databaseFile, { readonly: true });
  try { expect(db.query('SELECT max(version) AS version FROM schema_migrations').get()).toEqual({ version: 19 });
    expect(db.query("SELECT name FROM pragma_table_info('session_inputs') WHERE name='request_hash'").get()).toEqual({ name: 'request_hash' }); }
  finally { db.close(); }
  for (const id of [1, 2]) expect(readFileSync(join(f.root, 'artifacts', String(id), 'publish.json'), 'utf8')).toBe(originals[id - 1]);
  expect(readdirSync(join(f.root, 'data')).filter(name => name.startsWith('pre-v20-'))).toHaveLength(1);
});


it('backs up a shared legacy source once and restores both unverified copies on rollback', () => {
  const f = legacyStore(), old = 'artifacts/research/1/old-shared-source.txt';
  mkdirSync(join(f.root, 'artifacts/research/1'), { recursive: true });
  writeFileSync(join(f.root, old), 'Shared original body');
  const backup = backupLegacyStore(f.db, f.paths);
  try {
    backup.copyUnverified(old, 'artifacts/research/1/source-1.txt');
    backup.copyUnverified(old, 'artifacts/research/1/source-2.txt');
    expect(readFileSync(join(f.root, 'artifacts/research/1/source-1.txt'), 'utf8')).toBe('Shared original body');
    expect(readFileSync(join(f.root, 'artifacts/research/1/source-2.txt'), 'utf8')).toBe('Shared original body');
    backup.restore();
    expect(readdirSync(join(f.root, 'artifacts/research/1'))).toEqual(['old-shared-source.txt']);
    expect(readFileSync(join(backup.directory, old), 'utf8')).toBe('Shared original body');
  } finally { f.db.close(); }
});

it('restores original settings and credential references when the final v20 foreign-key check rejects an upgrade', () => {
  const f = legacyStore(), at = '2026-10-01T00:00:00.000Z';
  const settings = JSON.stringify({ ...defaultProductSettings(), version: 5, models: [{ id: 'old-model',
    credentialRef: 'original_model_credential', name: 'Old model', kind: 'catalog', providerId: 'openai', model: 'model',
    baseUrl: '', api: '', contextWindow: null, maxTokens: null, reasoning: false }], defaultModelId: 'old-model' });
  writeFileSync(join(f.root, 'data/settings.json'), settings);
  f.db.exec('PRAGMA foreign_keys=OFF');
  f.db.query('INSERT INTO documents(id,source_key,source_record_id,version,original_artifact_id,parsed_artifact_id,status,metadata_json,created_at,updated_at) VALUES(1,?,?,?,?,?,?,?,?,?)')
    .run('legacy', 'broken-owner', 'v1', 99, 100, 'available', JSON.stringify({ version: 2, pageCount: 1, warnings: [], allowedUsesClaim: [], licenseVerification: 'unknown', unavailableReason: null }), at, at);
  f.db.close();
  expect(openDatabase(f.paths)).toMatchObject({ ok: false });
  expect(readFileSync(join(f.root, 'data/settings.json'), 'utf8')).toBe(settings);
  const db = new Database(f.paths.databaseFile, { readonly: true });
  try { expect(db.query('SELECT max(version) AS version FROM schema_migrations').get()).toEqual({ version: 19 }); }
  finally { db.close(); }
});
