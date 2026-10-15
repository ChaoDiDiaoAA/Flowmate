import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

test('frozen installs do not reference removed local patches', () => {
    const root = new URL('../../', import.meta.url);
    const dependencies = JSON.parse(readFileSync(new URL('package.json', root), 'utf8')).patchedDependencies;
    const locked = readFileSync(new URL('bun.lock', root), 'utf8');
    expect(dependencies).toBeUndefined();
    expect(locked).not.toContain('patches/@earendil-works%2Fpi-coding-agent@0.85.1.patch');
    expect(locked).not.toContain('patches/@tintinweb%2Fpi-subagents@0.19.0.patch');
});
