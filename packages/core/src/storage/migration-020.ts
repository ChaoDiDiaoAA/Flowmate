import type { Database } from 'bun:sqlite';
import { constants, copyFileSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import type { ProductPaths } from '@flowmate/contracts';
import { ResourceExpansionEvidenceSchema } from '@flowmate/contracts';
import { safePath, bytes, decoder } from '../skill-hub/resources.ts';
import { validateProductSettings } from '../configuration/settings.ts';
import { writeSynced } from '../skill-hub/resources.ts';

type RecordValue = Record<string, any>;
const object = (value: unknown): RecordValue | null => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as RecordValue : null;
const array = (value: unknown): any[] => Array.isArray(value) ? value : [];

export function backupLegacyStore(db: Database, paths: ProductPaths) {
  db.exec('BEGIN EXCLUSIVE; COMMIT');
  const directory = join(dirname(paths.databaseFile), `pre-v20-${randomUUID()}`);
  mkdirSync(directory, { mode: 0o700 });
  copyFileSync(paths.databaseFile, join(directory, 'app.sqlite'), constants.COPYFILE_EXCL);
  const changedFiles: Array<{ path: string; backup: string }> = [];
  const copiedFiles: string[] = [];
  const backups = new Map<string, string>();
  function copy(relativePath: string): string | null {
    const saved = backups.get(relativePath); if (saved) return saved;
    if (!existsSync(join(paths.root, relativePath))) return null;
    const path = safePath(paths.root, relativePath), backup = join(directory, relativePath === 'data/settings.json' ? 'settings.json' : relativePath);
    mkdirSync(dirname(backup), { recursive: true });
    copyFileSync(path, backup, constants.COPYFILE_EXCL);
    backups.set(relativePath, backup);
    return backup;
  }
  copy('data/settings.json');
  const credentials = join(paths.root, 'security', 'credentials');
  if (existsSync(credentials)) for (const name of readdirSync(credentials)) {
    if (/^[a-zA-Z0-9_-]{1,128}\.json$/.test(name)) copy(`security/credentials/${name}`);
  }
  return { directory,
    copyUnverified(previousPath: string, nextPath: string) {
      if (!existsSync(join(paths.root, previousPath))) return;
      const source = safePath(paths.root, previousPath), content = bytes(source, 2_000_000);
      copy(previousPath);
      const target = join(paths.root, nextPath);
      if (existsSync(target)) {
        if (!bytes(safePath(paths.root, nextPath), 2_000_000).equals(content)) throw new Error('legacy_source_destination_conflict');
        return;
      }
      writeFileSync(target, content, { flag: 'wx', mode: 0o600 }); copiedFiles.push(nextPath);
    },
    rewrite(relativePath: string, text: string) {
      const backup = copy(relativePath); if (!backup) return;
      const path = safePath(paths.root, relativePath), temporary = `${path}.upgrade-${randomUUID()}.tmp`;
      try {
        writeSynced(temporary, text);
        renameSync(temporary, path); changedFiles.push({ path, backup });
      } finally { if (existsSync(temporary)) rmSync(temporary); }
    },
    restore() {
      for (const file of copiedFiles) rmSync(safePath(paths.root, file));
      for (const file of changedFiles.reverse()) copyFileSync(file.backup, file.path);
    },
  };
}
export type LegacyStoreBackup = ReturnType<typeof backupLegacyStore>;

/** Only product-owned JSON fields are upgraded; native history and user content are retained verbatim. */
export function migrateLegacyMetadata(db: Database, paths: ProductPaths, backup: LegacyStoreBackup | null): void {
  const triggers = db.query("SELECT name,sql FROM sqlite_master WHERE type='trigger' AND sql IS NOT NULL").all() as Array<{ name: string; sql: string }>;
  for (const trigger of triggers) db.exec(`DROP TRIGGER "${trigger.name.replaceAll('"', '""')}"`);
  const bundles = new Map<string, string>(), blockedSessions = new Set<number>();
  const bundleId = (old: unknown) => {
    if (typeof old !== 'string' || old.length === 0) throw new Error('legacy_bundle_identity_invalid');
    let id = bundles.get(old); if (!id) { id = randomUUID(); bundles.set(old, id); } return id;
  };
  const ref = (value: unknown) => { const item = object(value); if (item) { delete item.contentHash; delete item.manifestHash; } return value; };
  const command = (value: unknown) => { const item = object(value); if (item) { delete item.sourceHash; delete item.expandedHash; } return value; };
  const binding = (value: unknown) => {
    const item = object(value); if (!item) return value;
    if (item.bundleHash !== undefined) { item.bundleId = bundleId(item.bundleHash); delete item.bundleHash; }
    ref(item.requiredSkill); return value;
  };
  const manifest = (value: unknown) => {
    const item = object(value); if (!item) return value;
    item.schemaVersion = 2; delete item.patchHash;
    for (const file of array(item.files)) if (object(file)) delete file.sha256;
    for (const dependency of array(item.requires)) ref(dependency);
    return value;
  };
  const definitions = (value: unknown) => {
    const item = object(value); if (!item) return value;
    delete item.hash;
    for (const role of array(item.roles)) if (object(role)) delete role.hash;
    for (const template of array(item.templates)) if (object(template)) delete template.hash;
    command(item.command); return value;
  };
  const resource = (value: unknown) => {
    const item = object(value); if (!item) return value;
    if (item.bundleHash !== undefined) { item.bundleId = bundleId(item.bundleHash); delete item.bundleHash; }
    item.version = 2;
    item.bundleDirectory = join(paths.runtimeDir, 'resource-bundles', item.bundleId);
    ref(item.prompt);
    for (const name of ['selectedSkills', 'discoveredSkills']) for (const selected of array(item[name])) ref(selected);
    for (const excluded of array(item.excludedSkills)) ref(excluded.ref);
    for (const included of array(item.manifests)) { ref(included.ref); manifest(included.manifest); }
    if (object(item.skillIndex)) {
      delete item.skillIndex.hash;
      for (const entry of array(item.skillIndex.entries)) { ref(entry.ref); for (const check of array(entry.checks)) ref(check.dependency); }
    }
    return value;
  };
  const extensions = (value: unknown) => {
    const item = object(value); if (!item) return value;
    for (const selected of array(item.selected)) ref(selected);
    for (const included of array(item.included)) { ref(included.ref); manifest(included.manifest); }
    for (const excluded of array(item.excluded)) ref(excluded.ref);
    return value;
  };
  const content = (value: unknown) => {
    const item = object(value); if (!item) return value;
    binding(item.resourceBinding); command(item.inputCommand); delete item.desktopRequestHash;
    if (item.requestIdentityVersion !== undefined && item.requestIdentityVersion !== 1) { delete item.requestIdentityVersion; delete item.originalBudgetOverrides; }
    return value;
  };
  function update(table: string, column: string, convert: (value: any, row: any) => any, where = '') {
    const rows = db.query(`SELECT * FROM ${table}${where}`).all() as any[];
    for (const row of rows) {
      if (row[column] === null) continue;
      const parsed = JSON.parse(row[column]), before = JSON.stringify(parsed), after = JSON.stringify(convert(parsed, row));
      if (after !== before) db.query(`UPDATE ${table} SET ${column}=? WHERE id=?`).run(after, row.id);
    }
  }
  update('runs', 'config_json', (value, row) => {
    if (!object(value)) return value;
    if (object(value.resources)) { resource(value.resources); if (row.session_id !== null) blockedSessions.add(row.session_id); }
    extensions(value.extensions); definitions(value.inputDefinitions);
    for (const instance of array(value.extensionAssembly?.instances)) ref(instance.ref);
    if (object(value.subagent?.definition)) delete value.subagent.definition.hash;
    if (object(value.inputCommandReceipt)) {
      delete value.inputCommandReceipt.originalHash;
      const original = value.inputDefinitions?.command?.originalText;
      if (typeof original === 'string') value.inputCommandReceipt.originalText = original;
      else { delete value.inputCommandReceipt; if (row.session_id !== null) blockedSessions.add(row.session_id); }
    }
    return value;
  });
  update('runs', 'output_json', value => { if (object(value)) delete value.nativeOutcomeHash; return value; });
  update('session_inputs', 'content_json', value => content(value));
  update('context_snapshots', 'snapshot_json', value => {
    if (object(value)) { binding(value.resourceBinding); command(value.inputCommand); } return value;
  });
  update('runs', 'context_observations_json', (value, row) => {
    if (!object(value?.resources)) return value;
    const expansions: unknown[] = [];
    for (const receipt of array(value.resources.expansions)) {
      const input = db.query('SELECT native_entry_id FROM session_inputs WHERE id=? AND run_id=? AND session_id=?')
        .get(receipt.inputId, row.id, row.session_id) as { native_entry_id: string | null } | null;
      if (!input || input.native_entry_id !== receipt.nativeEntryId) continue;
      const saved = db.query('SELECT entry_json FROM session_native_entries WHERE session_id=? AND entry_id=?').get(row.session_id, receipt.nativeEntryId) as { entry_json: string } | null;
      const entry = saved ? JSON.parse(saved.entry_json) : null;
      if (entry?.type !== 'message' || entry.message?.role !== 'user') continue;
      const text = typeof entry.message.content === 'string' ? entry.message.content : array(entry.message.content).filter(part => part.type === 'text').map(part => part.text).join('\n');
      const next: RecordValue = { ...receipt, skill: ref(receipt.skill), bundleId: bundleId(receipt.bundleHash), expandedText: text };
      delete next.bundleHash; delete next.expandedTextHash;
      const parsed = ResourceExpansionEvidenceSchema.safeParse(next); if (parsed.success) expansions.push(parsed.data);
    }
    // Hash-only read and request proofs have no recoverable original bytes.
    if (expansions.length) value.resources = { version: 1, expansions, reads: [], requests: [] };
    else delete value.resources;
    return value;
  });
  update('artifacts', 'metadata_json', (value, row) => {
    if (!object(value)) return value;
    delete value.sha256;
    if (row.kind === 'export') { delete value.requestHash; value.requestFacts = null; }
    else if (value.sourceKey === 'research-local-v1') value.verificationGap = 'legacy-original-unavailable';
    for (const file of array(value.files)) if (object(file)) delete file.sha256;
    if (backup && row.kind !== 'export') for (const name of ['publish.json', 'manifest.json']) {
      const relativePath = `artifacts/${row.id}/${name}`;
      if (!existsSync(join(paths.root, relativePath))) continue;
      const path = safePath(paths.root, relativePath), statText = decoder.decode(bytes(path, 65536));
      const saved = JSON.parse(statText); if (!object(saved) || !Array.isArray(saved.files)) throw new Error('legacy_manifest_invalid');
      for (const file of saved.files) if (object(file)) delete file.sha256;
      const converted = JSON.stringify(saved); if (converted !== statText) backup.rewrite(relativePath, converted);
    }
    return value;
  });
  update('documents', 'metadata_json', (value, row) => {
    const reason = 'Legacy file content has no preserved original bytes. Re-import this document to use it again.';
    value.unavailableReason = reason;
    db.query("UPDATE documents SET status='unavailable' WHERE id=?").run(row.id);
    return value;
  });
  update('invoice_candidates', 'fields_json', value => {
    if (object(value) && Object.hasOwn(value, 'editRequestHash')) { delete value.editRequestHash; value.editRequestFacts = null; } return value;
  });
  update('business_events', 'safe_summary', value => {
    if (object(value) && Object.hasOwn(value, 'requestHash')) { delete value.requestHash; value.requestFacts = null; } return value;
  }, " WHERE type IN ('candidate_edited','candidate_accepted','candidate_rejected','candidate_exported') AND json_valid(safe_summary)");
  update('research_sources', 'body_json', (value, row) => {
    if (!object(value)) return value;
    delete value.contentHash; value.verificationGap = 'legacy-original-unavailable';
    const path = `artifacts/research/${row.research_id}/source-${row.tool_call_id}.txt`;
    if (value.relativePath !== path) {
      const prefix = `artifacts/research/${row.research_id}/`;
      // Recognize the historical path format without using its name as content evidence.
      if (typeof value.relativePath !== 'string' || !value.relativePath.startsWith(prefix)
        || !/^[a-f0-9]{64}\.txt$/.test(value.relativePath.slice(prefix.length))) throw new Error('legacy_source_path_invalid');
      backup?.copyUnverified(value.relativePath, path); value.relativePath = path;
    }
    return value;
  });
  update('tool_calls', 'result_json', (value, row) => {
    if (['list_skill_resources', 'read_skill_resource'].includes(row.tool_name) && object(value.data)) {
      const data = value.data; ref(data.ref);
      if (data.bundleHash !== undefined) { data.bundleId = bundleId(data.bundleHash); delete data.bundleHash; }
      delete data.sha256; for (const file of array(data.files)) if (object(file)) delete file.sha256;
    }
    return value;
  });
  for (const sessionId of blockedSessions) db.query('UPDATE session_native_history SET unusable=1 WHERE session_id=?').run(sessionId);
  if (backup && existsSync(join(paths.root, 'data', 'settings.json'))) {
    const settings = JSON.parse(decoder.decode(bytes(safePath(paths.root, 'data/settings.json'), 1024 * 1024)));
    if (settings.version !== 6) {
      const upgraded = validateProductSettings(settings);
      if (!upgraded.ok) throw new Error('legacy_settings_invalid');
      backup.rewrite('data/settings.json', `${JSON.stringify(upgraded.data, null, 2)}\n`);
    }
  }
  for (const trigger of triggers) db.exec(trigger.sql);
}
