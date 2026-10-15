// Produce real Core/SDK catalog states in an owned fixture; Electron supplies the transport boundary.
import { cpSync, mkdirSync, readFileSync, readdirSync, writeFileSync, appendFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';
import { Database } from 'bun:sqlite';
import { createManagedFileContents } from '../../packages/core/src/storage/managed-file-contents.ts';
import { createResourceService } from '../../packages/core/src/resources/service.ts';
import { inspectNativeResources } from '../../packages/runtime-pi/src/index.ts';
import type { ResourceSelection } from '@flowmate/contracts';

const root = process.argv[2]; assert(root);
const db = new Database(':memory:');
db.exec('CREATE TABLE managed_file_contents(owner_kind TEXT,owner_id TEXT,relative_path TEXT,content BLOB,PRIMARY KEY(owner_kind,owner_id,relative_path))');
const contents = createManagedFileContents(db);
const resourceRoot = join(root, 'author');
cpSync(resolve(import.meta.dir, '../../resources'), resourceRoot, { recursive: true });
for (const [id, name] of [['ui-no-requirements', 'ui-no-requirements'],
  ['ui-name-mismatch', 'ui-skill-with-a-long-mismatched-name-preserved-for-accessibility']]) {
  const directory = join(resourceRoot, 'skills', id!); mkdirSync(directory);
  const text = `---\nname: ${name}\ndescription: A controlled skill with no declared dependencies.\n---\nNo requirements.\n`;
  writeFileSync(join(directory, 'SKILL.md'), text);
  writeFileSync(join(directory, 'resource.json'), JSON.stringify({ schemaVersion: 2, kind: 'skill', id, version: 'v1',
    bodyFile: 'SKILL.md', keywords: [], requires: [], files: [{ path: 'SKILL.md', bytes: Buffer.byteLength(text) }] }));
}
const allTools = readdirSync(join(resourceRoot, 'skills')).flatMap(id => JSON.parse(readFileSync(join(resourceRoot, 'skills', id, 'resource.json'), 'utf8'))
  .requires.filter((item: { kind: string }) => item.kind === 'tool').map((item: { name: string }) => item.name));
const catalog = (tools: string[], selection: ResourceSelection) => {
  const result = createResourceService({ resourceRoot, contents, bundleRoot: join(root, 'bundles'), registeredToolNames: tools, inspectNativeResources })
    .catalog({ revision: 0, selection });
  assert(result.ok); return result.data;
};
const full = catalog(allTools, { prompt: null, enabledSkills: [] });
const invoice = full.items.find(item => item.ref.kind === 'skill' && item.ref.id === 'invoice'); assert(invoice);
const selection = { prompt: null, enabledSkills: [invoice.ref] };
const partial = catalog(['read'], selection), zero = catalog([], selection);
appendFileSync(join(resourceRoot, 'skills', 'invoice-source-audit', 'SKILL.md'), '\nChanged fixture file.\n');
const invalid = catalog(allTools, selection);
assert.equal(partial.items.find(item => item.ref.id === 'invoice' && item.ref.kind === 'skill')?.dependencyChecks.filter(check => check.available).length, 1);
assert.equal(zero.items.find(item => item.ref.id === 'invoice' && item.ref.kind === 'skill')?.available, false);
assert.equal(invalid.items.find(item => item.ref.id === 'invoice-source-audit')?.available, false);
const invoiceDirectory = join(resourceRoot, 'skills', 'invoice');
const updatedText = readFileSync(join(invoiceDirectory, 'SKILL.md'), 'utf8').replace(/^description:.*$/m, 'description: 同一名称的新介绍不应套用旧译文。');
writeFileSync(join(invoiceDirectory, 'SKILL.md'), updatedText);
const updatedManifest = JSON.parse(readFileSync(join(invoiceDirectory, 'resource.json'), 'utf8'));
updatedManifest.files = updatedManifest.files.map((file: { path: string }) => file.path === 'SKILL.md'
  ? { ...file, bytes: Buffer.byteLength(updatedText) } : file);
updatedManifest.version = 'v2';
writeFileSync(join(invoiceDirectory, 'resource.json'), JSON.stringify(updatedManifest));
const updated = catalog(allTools, { prompt: null, enabledSkills: [] });
console.log(JSON.stringify({ full, partial, zero, invalid, updated }));
