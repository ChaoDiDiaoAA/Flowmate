import { expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

test('frozen installs declare the existing managed plugin and Prompt export patches inside the repository', () => {
    const root = new URL('../../', import.meta.url);
    const dependencies = JSON.parse(readFileSync(new URL('package.json', root), 'utf8')).patchedDependencies;
    const locked = readFileSync(new URL('bun.lock', root), 'utf8');
    expect(dependencies).toEqual({
        '@earendil-works/pi-coding-agent@0.85.1': 'patches/@earendil-works%2Fpi-coding-agent@0.85.1.patch',
        '@tintinweb/pi-subagents@0.19.0': 'patches/@tintinweb%2Fpi-subagents@0.19.0.patch',
    });
    for (const path of Object.values(dependencies) as string[]) {
        expect(existsSync(join(fileURLToPath(root), path))).toBe(true);
        expect(locked).toContain(JSON.stringify(path));
    }
});
