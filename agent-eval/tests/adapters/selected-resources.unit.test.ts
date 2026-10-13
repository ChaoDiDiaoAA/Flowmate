import { expect, test } from 'bun:test';
import { mkdirSync, writeFileSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync } from '../../../tests/support/resources.ts';
import { readSelectedResources } from '../../src/adapters/selected-resources.ts';
import { canonicalResourceManifest, ResourceManifestSchema } from '../../../packages/contracts/src/resources.ts';
import { hash } from '../../src/dataset-loader/local.ts';

test('resource transfer verifies selected identity and exact bytes and excludes undeclared neighbors', () => {
    const root = mkdtempSync(join(tmpdir(), 'eval-declared-bytes-')), pkg = join(root, 'controlled'); mkdirSync(pkg);
    const body = 'Independent synthetic resource';
    const manifest = ResourceManifestSchema.parse({ schemaVersion: 1, kind: 'skill', id: 'controlled', version: 'v1', bodyFile: 'SKILL.md', keywords: [], requires: [], files: [{ path: 'SKILL.md', bytes: Buffer.byteLength(body), sha256: hash(body) }] });
    writeFileSync(join(pkg, 'resource.json'), JSON.stringify(manifest)); writeFileSync(join(pkg, 'SKILL.md'), body); writeFileSync(join(pkg, 'gold.json'), 'PRIVATE');
    const ref = { kind: 'skill' as const, id: 'controlled', version: 'v1', contentHash: hash(canonicalResourceManifest(manifest)) }, selection = { prompt: null, enabledSkills: [ref] };
    expect(readSelectedResources(root, selection)[0]!.files.map(f => f.path)).toEqual(['resource.json', 'SKILL.md']);
    expect(readSelectedResources(root, { prompt: null, enabledSkills: [] })).toEqual([]);
    expect(() => readSelectedResources(root, { ...selection, enabledSkills: [{ ...ref, contentHash: 'a'.repeat(64) }] })).toThrow('identity');
    writeFileSync(join(pkg, 'SKILL.md'), 'Changed resource'); expect(() => readSelectedResources(root, selection)).toThrow('bytes changed');
    const linked = join(root, 'linked'); symlinkSync(pkg, linked, 'junction');
    expect(() => readSelectedResources(root, { ...selection, enabledSkills: [{ ...ref, id: 'linked' }] })).toThrow('links');
});
