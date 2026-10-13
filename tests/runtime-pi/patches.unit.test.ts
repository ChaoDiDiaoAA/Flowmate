import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

test('frozen installs preserve the SDK exports and managed subagent patch identity', () => {
    const root = new URL('../../', import.meta.url);
    const dependencies = JSON.parse(readFileSync(new URL('package.json', root), 'utf8')).patchedDependencies;
    const locked = readFileSync(new URL('bun.lock', root), 'utf8');
    const expected = {
        '@tintinweb/pi-subagents@0.19.0': 'patches/@tintinweb%2Fpi-subagents@0.19.0.patch',
        '@earendil-works/pi-coding-agent@0.85.1': 'patches/@earendil-works%2Fpi-coding-agent@0.85.1.patch'
    };
    expect(dependencies).toEqual(expected);
    for (const [name, path] of Object.entries(expected)) {
        expect(locked).toContain(`"${name}": "${path}"`);
        const bytes = readFileSync(fileURLToPath(root) + path);
        expect(bytes.length).toBeGreaterThan(0);
        if (name.startsWith('@tintinweb/')) {
            const manifest = JSON.parse(readFileSync(new URL('resources/extensions/subagents-v1.json', root), 'utf8'));
            expect(createHash('sha256').update(bytes).digest('hex')).toBe(manifest.patchHash);
        }
    }
});
