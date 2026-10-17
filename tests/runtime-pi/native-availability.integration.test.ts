import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync } from '../support/resources.ts';

test('the product SDK patch resolves fixed bundled tools before an old writable SDK cache', async () => {
  const root = mkdtempSync(join(tmpdir(), 'flowmate-bundled-tools-')), sdk = join(root, 'release/sdk'), cache = join(root, 'old-cache');
  for (const directory of [join(root, 'release/bin'), join(cache, 'bin')]) {
    mkdirSync(directory, { recursive: true });
    for (const tool of ['rg', 'fd']) writeFileSync(join(directory, tool + '.exe'), 'Resolution fixture, never executed');
  }
  mkdirSync(sdk);
  const entry = new URL('../../node_modules/@earendil-works/pi-coding-agent/dist/utils/tools-manager.js', import.meta.url).href;
  const child = Bun.spawn([process.execPath, '--no-env-file', '-e',
    `const {getToolPath}=await import(${JSON.stringify(entry)}); process.stdout.write(JSON.stringify({rg:getToolPath('rg'),fd:getToolPath('fd')}));`],
    { cwd: root, env: { PATH: '', SystemRoot: process.env.SystemRoot, PI_PACKAGE_DIR: sdk,
      PI_CODING_AGENT_DIR: cache, PI_OFFLINE: '1' }, stdout: 'pipe', stderr: 'pipe' });
  const output = await new Response(child.stdout).text(), error = await new Response(child.stderr).text();
  expect(await child.exited).toBe(0); expect(error).toBe('');
  expect(JSON.parse(output)).toEqual({ rg: join(root, 'release/bin/rg.exe'), fd: join(root, 'release/bin/fd.exe') });
});

test('reports missing actual SDK command dependencies without downloading tools or using development PATH', async () => {
  const root = mkdtempSync(join(tmpdir(), 'flowmate-native-availability-'));
  const entry = new URL('../../packages/runtime-pi/src/native-tools.ts', import.meta.url).href;
  const child = Bun.spawn([process.execPath, '--no-env-file', '-e',
    `const {createNativeTools}=await import(${JSON.stringify(entry)}); const tools=createNativeTools({getWorkingDirectory:()=>({ok:true,data:process.cwd()})}); process.stdout.write(JSON.stringify(tools.availability));`],
    { cwd: root, env: { PATH: '', SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP, TMP: process.env.TMP,
      PI_CODING_AGENT_DIR: join(root, 'pi'), PI_OFFLINE: '1' }, stdout: 'pipe', stderr: 'pipe' });
  const output = await new Response(child.stdout).text(), error = await new Response(child.stderr).text();
  expect(await child.exited).toBe(0); expect(error).toBe('');
  const tools = JSON.parse(output);
  for (const name of ['grep', 'find', 'bash', 'powershell']) expect(tools.find((tool: { name: string }) => tool.name === name))
    .toMatchObject({ available: false, reason: expect.any(String) });
  for (const name of ['read', 'ls', 'edit', 'write']) expect(tools.find((tool: { name: string }) => tool.name === name)).toMatchObject({ available: true, reason: null });
  expect(existsSync(join(root, 'pi/bin'))).toBe(false);
}, 15_000);
