import { expect, test } from 'bun:test';
import { mkdirSync, writeFileSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync } from '../../../tests/support/resources.ts';
import { readSelectedResources } from '../../src/adapters/selected-resources.ts';
import { ResourceManifestSchema } from '../../../packages/contracts/src/resources.ts';

test('resource transfer verifies selected identity and exact bytes and excludes undeclared neighbors', () => {
    const root = mkdtempSync(join(tmpdir(), 'eval-declared-bytes-')), pkg = join(root, 'controlled'); mkdirSync(pkg);
    const body = 'Independent synthetic resource';
    const manifest = ResourceManifestSchema.parse({ schemaVersion: 2, kind: 'skill', id: 'controlled', version: 'v1', bodyFile: 'SKILL.md', keywords: [], requires: [], files: [{ path: 'SKILL.md', bytes: Buffer.byteLength(body) }] });
    writeFileSync(join(pkg, 'resource.json'), JSON.stringify(manifest)); writeFileSync(join(pkg, 'SKILL.md'), body); writeFileSync(join(pkg, 'gold.json'), 'PRIVATE');
    const ref = { kind: 'skill' as const, id: 'controlled', version: 'v1' }, selection = { prompt: null, enabledSkills: [ref] };
    expect(readSelectedResources(root, selection)[0]!.files.map(f => f.path)).toEqual(['resource.json', 'SKILL.md']);
    expect(readSelectedResources(root, { prompt: null, enabledSkills: [] })).toEqual([]);
    expect(() => readSelectedResources(root, { ...selection, enabledSkills: [{ ...ref,version:'different' }] })).toThrow('identity');
    writeFileSync(join(pkg, 'SKILL.md'), 'Changed resource'); expect(() => readSelectedResources(root, selection)).toThrow('bytes changed');
    const linked = join(root, 'linked'); symlinkSync(pkg, linked, 'junction');
    expect(() => readSelectedResources(root, { ...selection, enabledSkills: [{ ...ref, id: 'linked' }] })).toThrow('links');
});
