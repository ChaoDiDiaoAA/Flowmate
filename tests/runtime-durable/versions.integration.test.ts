import { expect, test } from 'bun:test';
import { createRequire } from 'node:module';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { mkdtemp } from '../support/resources.ts';

test('official SDK version facts are embedded in a standalone Bun bundle outside the development tree', async () => {
  const requireRuntime = createRequire(new URL('../../packages/runtime-durable/package.json', import.meta.url));
  const versions: Record<string, string> = {};
  for (const [key, name] of [['durable', 'pi-durable'], ['ai', 'pi-ai'], ['chord', 'chord']])
    versions[key!] = JSON.parse(await readFile(requireRuntime.resolve(`@earendil-works/${name}/package.json`), 'utf8')).version;
  const source = await import('../../packages/runtime-durable/src/versions.ts');
  expect(versions).toEqual(source.DURABLE_SDK_VERSIONS);
  const root = await mkdtemp(join(tmpdir(), 'flowmate-bundled-sdk-versions-'));
  try {
    const built = await Bun.build({ entrypoints: [fileURLToPath(new URL('../../packages/runtime-durable/src/versions.ts', import.meta.url))],
      outdir: root, target: 'bun', format: 'esm', minify: true });
    expect(built.success).toBe(true); expect(built.outputs).toHaveLength(1);
    const bundled = await import(pathToFileURL(built.outputs[0]!.path).href);
    expect(bundled.DURABLE_SDK_VERSIONS).toEqual(versions);
  } finally { await rm(root, { recursive: true, force: true }); }
});
