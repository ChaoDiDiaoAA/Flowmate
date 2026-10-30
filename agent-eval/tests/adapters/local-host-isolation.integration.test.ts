import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync } from '../../../tests/support/resources.ts';
import { prepareLocalHost } from '../../src/adapters/local-host.ts';

const repository = resolve(import.meta.dir, '../../..');
test('production Subject Host excludes evaluator datasets, curation and answer dictionaries', async () => {
    const trial = mkdtempSync(join(tmpdir(), 'flowmate-production-host-isolation-'));
    const local = prepareLocalHost(repository, trial);
    const actualBundle = readFileSync(join(local.runtimeRoot, 'apps/host.js'), 'utf8');
    expect(/\bgoldByCaseId\s*=/.test(actualBundle)).toBe(false);
    expect(actualBundle.includes('agent-eval/src/datasets/gold.ts')).toBe(false);
    const built = await Bun.build({ entrypoints: [join(repository, 'apps/host/main.ts')], target: 'bun', format: 'esm',
        splitting: false, sourcemap: 'none', metafile: true });
    expect(built.success).toBe(true); if (!built.success) throw Error('Production Host build failed');
    const inputs = Object.keys(built.metafile?.inputs ?? {}).map(file => file.replaceAll('\\', '/'));
    expect(inputs.length).toBeGreaterThan(0);
    expect(inputs.filter(file => /(?:^|\/)agent-eval\/src\/(?:datasets|curation)\//.test(file))).toEqual([]);
    expect(inputs.filter(file => /(?:^|\/)agent-eval\/src\/desktop\/workflow\.ts$/.test(file))).toEqual([]);
    const memoryBundle = await built.outputs[0]!.text();
    expect(/\bgoldByCaseId\s*=/.test(memoryBundle)).toBe(false);
    expect(local.manifest.files).toContain('apps/host.js');
    expect(local.launch.args[local.launch.args.indexOf('--evaluation-trial-root') + 1]).toBe(trial);
}, 30_000);
