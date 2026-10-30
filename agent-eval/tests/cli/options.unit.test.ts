import { expect, test } from 'bun:test';
import { parseOptions } from '../../src/cli.ts';
import { main } from '../../src/cli.ts';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, unlinkSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
async function offlineMain(args: string[]) {
    const key = process.env.LANGFUSE_PUBLIC_KEY;
    process.env.LANGFUSE_PUBLIC_KEY = '';
    try {
        await main(args);
    }
    finally {
        if (key === undefined)
            delete process.env.LANGFUSE_PUBLIC_KEY;
        else
            process.env.LANGFUSE_PUBLIC_KEY = key;
    }
}
test('retired sync cannot initialize a platform write', async () => {
    await expect(offlineMain(['sync'])).rejects.toThrow('retired');
});

test('retired review apply directs to explicit import without initializing a platform', async () => {
    await expect(offlineMain(['review', 'apply', '--backend', 'langfuse', '--execution-id', 'unit'])).rejects.toThrow('review import');
});
test('publish source options are mutually exclusive before a runtime starts', async () => {
    await expect(offlineMain(['dataset', 'publish', '--dataset', 'flowmate/llm-provider'])).rejects.toThrow('retired');
    await expect(offlineMain(['dataset', 'publish', '--dataset', 'flowmate/llm-provider', '--file', 'absent.json', '--dir', 'absent'])).rejects.toThrow('retired');
});
test('CLI rejects unknown, repeated and missing parameters before starting a runtime', () => {
    expect(() => parseOptions(['--versoin', 'x'], ['--version'])).toThrow('Unknown');
    expect(() => parseOptions(['--version'], ['--version'])).toThrow('Missing');
    expect(() => parseOptions(['--version', 'x', '--version', 'y'], ['--version'])).toThrow('Duplicate');
    expect(parseOptions(['--dry-run', '--dataset', 'd'], ['--dataset'], ['--dry-run'])).toEqual({ '--dry-run': true, '--dataset': 'd' });
});
test('stage and mode interfaces fail explicitly before paid behavior', async () => {
    for (const args of [['run', '--stage', 'P1'], ['run', '--mode', 'live']])
        await expect(main(args)).rejects.toThrow('已取消');
});
test('calibration CLI requires its exact subcommand, independent-reference directory and new execution identity',async()=>{
    for(const args of [['judge','accept'],['judge','calibrate'],['judge','calibrate','--dir','missing'],
        ['judge','calibrate','--backend','langfuse'],['judge','calibrate','--dir','a','--dir','b']])
        await expect(main(args)).rejects.toThrow();
});

test('trials rejects retired, missing, duplicate and invalid counts before dataset or model preparation', async () => {
    const originalFetch=globalThis.fetch;let requests=0;
    globalThis.fetch=Object.assign(async()=>{requests++;throw Error('Network forbidden in CLI parameter tests');},originalFetch);
    try {
    await expect(main(['run', '--dataset', 'absent', '--repeat', '5'])).rejects.toThrow('--trials');
    for (const value of ['0', '-1', '1.5', '21', 'abc', 'Infinity'])
        await expect(main(['run', '--dataset', 'absent', '--trials', value])).rejects.toThrow('1–20');
    await expect(main(['run', '--trials'])).rejects.toThrow('Missing');
    await expect(main(['run', '--trials', '2', '--trials', '3'])).rejects.toThrow('Duplicate');
    for (const value of ['1', '5', '20'])
        await expect(main(['run', '--dataset', 'absent', '--trials', value])).rejects.toThrow('不存在');
    expect(requests).toBe(0);
    } finally { globalThis.fetch=originalFetch; }
});

test('Smoke and Full shortcuts reject Trial overrides before any paid preparation', () => {
    const guardDirectory=mkdtempSync(join(tmpdir(),'flowmate-cli-offline-')),guard=join(guardDirectory,'guard.mjs');
    writeFileSync(guard,"import { Socket } from 'node:net'; globalThis.fetch=()=>{throw Error('Network forbidden');}; Socket.prototype.connect=function(){throw Error('Network forbidden');};");
    try {
    for (const script of ['eval:smoke', 'eval:full']) for (const trials of ['0', '2']) {
        const child = spawnSync(process.execPath, ['--no-env-file', 'run', script, '--trials', trials], {
            cwd: new URL('../../../', import.meta.url), encoding: 'utf8', timeout: 15000,
            env:{...process.env,NODE_OPTIONS:'--import='+pathToFileURL(guard).href} });
        expect(child.error).toBeUndefined();
        expect(child.status).toBe(1);
        expect(child.stderr).toContain('Unknown argument');
        expect(child.stderr).not.toContain('Network forbidden');
        expect(child.stdout).toBe('');
    }
    } finally { unlinkSync(guard);rmdirSync(guardDirectory); }
}, 65000);
