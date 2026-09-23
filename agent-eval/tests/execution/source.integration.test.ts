import { mkdtempSync } from '../../../tests/support/resources.ts';
import { expect, test } from 'bun:test';
import { mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { codeIdentity } from '../../src/execution/source.ts';
import { hash as contentHash } from '../../src/datasets/local.ts';
test('source snapshot reconstructs dirty and untracked execution code without environment files', () => {
    const root = mkdtempSync(join(tmpdir(), 'flowmate-source-'));
    const git = (...args: string[]) => execFileSync('git', args, { cwd: root, stdio: 'pipe' });
    try {
        git('init');
        mkdirSync(join(root, 'packages/core/src'), { recursive: true });
        writeFileSync(join(root, 'packages/core/src/main.ts'), 'export const result = 1;\n');
        writeFileSync(join(root, '.gitignore'), '.env\n.env.*\nsource-snapshot.json\n');
        git('add', '.');
        git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-m', 'test baseline');
        const dirty = 'export const result = 2;\n';
        writeFileSync(join(root, 'packages/core/src/main.ts'), dirty);
        writeFileSync(join(root, 'packages/core/src/new.ts'), 'export const added = true;\n');
        writeFileSync(join(root, '.env'), 'SECRET_DO_NOT_SNAPSHOT=private-value');
        writeFileSync(join(root, 'packages/core/src/.env.local'), 'NESTED_SECRET=private-value');
        const destination = join(root, 'source-snapshot.json');
        const identity = codeIdentity(root, destination);
        const snapshot = JSON.parse(readFileSync(destination, 'utf8'));
        writeFileSync(join(root, 'packages/core/src/main.ts'), 'later contents');
        const entry = snapshot.files.find((file: any) => file.path === 'packages/core/src/main.ts');
        expect(Buffer.from(entry.contentBase64, 'base64').toString('utf8')).toBe(dirty);
        expect(snapshot.files.some((file: any) => file.path.endsWith('/new.ts'))).toBe(true);
        expect(JSON.stringify(snapshot)).not.toContain('private-value');
        expect(snapshot.files.some((file: any) => file.path.includes('.env'))).toBe(false);
        expect(snapshot.workspaceHash).toBe(identity.workspaceHash);
        expect(contentHash(snapshot.files.map((file: any) => [file.path, file.hash]))).toBe(identity.workspaceHash);
        expect(codeIdentity(root).workspaceHash).not.toBe(identity.workspaceHash);
        expect(identity.dirty).toBe(true);
    }
    finally {
        rmSync(root, { recursive: true, force: true });
    }
}, 30000);
