import { expect, test } from 'bun:test';
import { parseOptions } from '../../src/cli.ts';
import { main } from '../../src/cli.ts';
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
