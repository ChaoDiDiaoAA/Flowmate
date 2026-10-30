import { expect, it } from 'bun:test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createProductCommandDispatcher } from '../../apps/host/dispatch.ts';
import { mkdtemp } from '../support/resources.ts';
import type { HostOutput } from '../../apps/host/protocol.ts';

it('imports the product dispatcher without consuming argv, redirecting console or creating a data root', async () => {
  const root = await mkdtemp(join(tmpdir(), 'flowmate-service-dispatch-import-'));
  const child = Bun.spawn([process.execPath, '--no-env-file', '--eval', `
    process.argv.push('--user-data-root', ${JSON.stringify(root)});
    const original = console.log;
    const api = await import(${JSON.stringify(new URL('../../apps/host/dispatch.ts', import.meta.url).href)});
    process.stdout.write(JSON.stringify({ factory: typeof api.createProductCommandDispatcher,
      consolePreserved: console.log === original }));
  `], { env: {}, stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect({ code, stderr }).toEqual({ code: 0, stderr: '' });
  expect(JSON.parse(stdout)).toEqual({ factory: 'function', consolePreserved: true });
  expect(existsSync(join(root, 'data/app.sqlite'))).toBe(false);
}, 15_000);

it('rejects an invalid installed runtime before creating the product database and reports one startup failure', async () => {
  const root = await mkdtemp(join(tmpdir(), 'flowmate-service-dispatch-invalid-'));
  const outputs: HostOutput[] = [];
  const result = await createProductCommandDispatcher({ userDataRoot: root, invoiceSourceRoot: root,
    runtimeRoot: join(root, 'missing-runtime'), send: async output => { outputs.push(output); } });
  expect(result).toMatchObject({ ok: false, error: { code: 'installation_runtime_invalid' } });
  expect(outputs).toHaveLength(1);
  expect(outputs[0]).toMatchObject({ type: 'ready', state: { ready: false, host: 'error', userDataPath: root } });
  expect(existsSync(join(root, 'data/app.sqlite'))).toBe(false);
});
