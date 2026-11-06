import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { callCloudUnixRpc } from '../../apps/cloud-unix-rpc.ts';
import { deferCleanup, mkdtempSync, waitFor } from '../support/resources.ts';

test.skipIf(process.platform !== 'linux')('the Linux package starts both isolated service processes without including local plans', async () => {
  const root = mkdtempSync(join(tmpdir(), 'flowmate-cloud-package-')), output = join(root, 'bundle');
  const repo = resolve(import.meta.dir, '../..'), script = join(repo, 'scripts/package-cloud.ts');
  const build = Bun.spawn([process.execPath, '--no-env-file', script, output], { cwd: repo, stdout: 'pipe', stderr: 'pipe' });
  const [code, stderr] = await Promise.all([build.exited, new Response(build.stderr).text()]);
  expect({ code, stderr }).toEqual({ code: 0, stderr: '' });
  expect(existsSync(join(output, 'docs'))).toBe(false);
  expect(existsSync(join(output, 'resources/service'))).toBe(false);
  const authorityUnit = join(output, 'deployment/flowmate-authority.service'), runtimeUnit = join(output, 'deployment/flowmate-runtime.service');
  expect(existsSync(authorityUnit) && existsSync(runtimeUnit) && existsSync(join(output, 'deployment/flowmate.conf'))).toBe(true);
  const analyzer = Bun.which('systemd-analyze');
  if (analyzer) {
    const verify = Bun.spawn([analyzer, 'verify', authorityUnit, runtimeUnit], { stdout: 'pipe', stderr: 'pipe' });
    const [verified, diagnostics] = await Promise.all([verify.exited, new Response(verify.stderr).text()]);
    expect({ verified, diagnostics }).toEqual({ verified: 0, diagnostics: '' });
  }
  const repeated = Bun.spawn([process.execPath, '--no-env-file', script, output], { cwd: repo, stdout: 'ignore', stderr: 'ignore' });
  expect(await repeated.exited).toBe(1);
  const exercise = Bun.spawn([process.execPath, 'test', join(repo, 'tests/core/application/cloud-authority-composition.integration.test.ts'),
    '-t', 'assembled Authority transfers'], { cwd: repo, stdout: 'pipe', stderr: 'pipe',
    env: { PATH: process.env.PATH ?? '', FLOWMATE_CLOUD_TEST_BUNDLE: output, FLOWMATE_CLOUD_TEST_KILL_AFTER_503: '1' } });
  const [exerciseCode, exerciseOut, exerciseError] = await Promise.all([exercise.exited, new Response(exercise.stdout).text(), new Response(exercise.stderr).text()]);
  if (exerciseCode !== 0) throw Error(`Packaged Runtime exercise failed: ${exerciseOut}\n${exerciseError}`);
  const authorityRoot = join(root, 'authority'), runtimeRoot = join(root, 'runtime'), credentials = join(root, 'credentials');
  for (const path of [authorityRoot, runtimeRoot, credentials]) mkdirSync(path, { mode: 0o700 });
  writeFileSync(join(credentials, 'deepseek-api-key'), 'synthetic-package-key', { mode: 0o600 });
  const workspaceId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', desktopSocket = join(root, 'desktop.sock'),
    authoritySocket = join(root, 'authority.sock'), modelSocket = join(root, 'model.sock'), runtimeSocket = join(root, 'runtime.sock');
  const authorityConfig = join(root, 'authority.json'), runtimeConfig = join(root, 'runtime.json');
  writeFileSync(authorityConfig, JSON.stringify({ version: 1, productRoot: authorityRoot, resourceRoot: join(output, 'resources'), workspaceId,
    desktopSocket, authoritySocket, modelSocket, runtimeSocket,
    model: { id: 'packaged-deepseek', name: 'deepseek-chat', contextWindow: 64000, maxTokens: 8192, reasoning: false } }));
  writeFileSync(runtimeConfig, JSON.stringify({ version: 1, root: runtimeRoot, runtimeSocketPath: runtimeSocket,
    authoritySocketPath: authoritySocket, modelSocketPath: modelSocket }));
  const authority = spawn(process.execPath, ['--no-env-file', join(output, 'cloud-authority-main.js'), authorityConfig],
    { cwd: output, stdio: ['ignore', 'pipe', 'pipe'], env: { PATH: process.env.PATH ?? '', CREDENTIALS_DIRECTORY: credentials } });
  let authorityError = ''; authority.stdout.resume(); authority.stderr.on('data', value => { authorityError += value.toString(); });
  const authorityExit = new Promise<number | null>(done => authority.once('exit', code => done(code)));
  deferCleanup(() => { if (authority.exitCode === null && authority.signalCode === null) authority.kill('SIGTERM'); });
  let runtime: ReturnType<typeof spawn> | undefined;
  try {
    await waitFor(async () => { if (authority.exitCode !== null) throw Error(`Authority failed: ${authorityError}`); return existsSync(desktopSocket); }, 12_000);
    expect(await callCloudUnixRpc(desktopSocket, { version: 1, workspaceId, requestId: '11111111-1111-4111-8111-111111111111',
      command: { type: 'personal_agent_get', input: {} } })).toMatchObject({ ok: true, data: { ok: true } });
    runtime = spawn(process.execPath, ['--no-env-file', join(output, 'cloud-runtime-main.js'), runtimeConfig],
      { cwd: output, stdio: ['ignore', 'pipe', 'pipe'], env: { PATH: process.env.PATH ?? '' } });
    let runtimeError = ''; runtime.stdout?.resume(); runtime.stderr?.on('data', value => { runtimeError += value.toString(); });
    const runtimeExit = new Promise<number | null>(done => runtime!.once('exit', code => done(code)));
    deferCleanup(() => { if (runtime && runtime.exitCode === null && runtime.signalCode === null) runtime.kill('SIGTERM'); });
    await waitFor(async () => { if (runtime!.exitCode !== null) throw Error(`Runtime failed: ${runtimeError}`); return existsSync(runtimeSocket); }, 12_000);
    runtime.kill('SIGKILL'); await runtimeExit;
    await new Promise(resolve => setTimeout(resolve, 20_000));
    runtime = spawn(process.execPath, ['--no-env-file', join(output, 'cloud-runtime-main.js'), runtimeConfig],
      { cwd: output, stdio: ['ignore', 'pipe', 'pipe'], env: { PATH: process.env.PATH ?? '' } });
    runtime.stdout?.resume(); runtime.stderr?.on('data', value => { runtimeError += value.toString(); });
    const recoveredExit = new Promise<number | null>(done => runtime!.once('exit', code => done(code)));
    await waitFor(async () => {
      if (runtime!.exitCode !== null) throw Error(`Runtime recovery failed: ${runtimeError}`);
      return (await callCloudUnixRpc(runtimeSocket, { version: 1, method: 'unknown', input: {} })).ok;
    }, 12_000);
    runtime.kill('SIGTERM'); expect(await recoveredExit).toBe(0);
  } finally { authority.kill('SIGTERM'); expect(await authorityExit).toBe(0); }
  expect(authorityError).not.toContain('synthetic-package-key');
}, 120_000);
