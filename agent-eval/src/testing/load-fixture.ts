import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inside } from '../dataset-loader/local.ts';

export const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');

export function assertSafeFixtureName(name: string): string {
    if (typeof name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name))
        throw new Error(`Unsafe fixture name: ${JSON.stringify(name)}`);
    return name;
}

export function fixturePath(name: string, ext = 'json', root = FIXTURES_DIR): string {
    return inside(root, `${assertSafeFixtureName(name)}.${assertSafeFixtureName(ext)}`);
}

export function loadFixtureText(name: string, ext = 'json', root = FIXTURES_DIR): string {
    return readFileSync(fixturePath(name, ext, root), 'utf8');
}

export function loadFixture<T = unknown>(name: string, root = FIXTURES_DIR): T {
    const path = fixturePath(name, 'json', root), text = readFileSync(path, 'utf8');
    try { return JSON.parse(text) as T; }
    catch (cause) { throw new Error(`Invalid JSON fixture: ${path}`, { cause }); }
}
