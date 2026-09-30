import { expect, it } from 'bun:test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { cpSync, existsSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { mkdtemp } from '../support/resources.ts';

for (const failure of ['unconfirmed-close', 'startup-failure'] as const) it(`dev rejects ${failure} and releases its launcher resources`, async () => {
  const repo = resolve(import.meta.dir, '../..');
  const root = await mkdtemp(join(tmpdir(), 'flowmate-dev-protocol-'));
  for (const path of ['apps', 'packages', 'scripts', 'package.json', 'electron.vite.config.ts'])
    cpSync(join(repo, path), join(root, path), { recursive: true });
  symlinkSync(join(repo, 'node_modules'), join(root, 'node_modules'), 'junction');
  const mainFile = join(root, 'apps/desktop/main/index.ts');
  const source = readFileSync(mainFile, 'utf8');
  if (failure === 'unconfirmed-close') {
    // The real Main and Host still close. Reject their reply, then inject an unrelated success.
    const notice = 'closed: closed.ok && closed.data.closed, stopped: closed.ok && closed.data.stopped });';
    expect(source).toContain(notice);
    writeFileSync(mainFile, source.replace(notice, "closed: false, stopped: false });\n  await sendDevelopmentNotice({ version: 1, type: 'flowmate_dev_closed', requestId: 'another-request', closed: true, stopped: true });"));
  } else {
    const afterReady = 'appVersion = readProductVersion(appRoot);';
    expect(source).toContain(afterReady);
    writeFileSync(mainFile, source.replace(afterReady, "throw new Error('Injected Main startup failure');"));
  }
  const userData = join(root, 'user-data');
  const env: Record<string, string> = {};
  for (const name of ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'COMSPEC', 'PATHEXT', 'TEMP', 'TMP', 'WINDIR', 'USERPROFILE', 'HOME', 'APPDATA', 'LOCALAPPDATA'])
    if (process.env[name]) env[name] = process.env[name];
  Object.assign(env, { FLOWMATE_TEST_MODE: '1', FLOWMATE_TEST_USER_DATA_ROOT: userData });
  const child = spawn('node', ['--import', 'tsx', 'scripts/dev.ts'], { cwd: root, env, windowsHide: true, stdio: 'pipe' });
  const exited = once(child, 'exit');
  let output = '';
  child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString(); });
  child.stderr.on('data', (chunk: Buffer) => { output += chunk.toString(); });
  const waitFor = async (condition: () => boolean) => {
    for (let attempt = 0; attempt < 1_000; attempt += 1) {
      if (condition()) return;
      if (child.exitCode !== null || child.signalCode !== null) throw new Error(`Dev exited unexpectedly: ${output}`);
      await new Promise((resolveWait) => setTimeout(resolveWait, 25));
    }
    throw new Error(`Dev condition was not reached: ${output}`);
  };
  try {
    if (failure === 'unconfirmed-close') {
      await waitFor(() => output.includes('[Flowmate dev] Ready '));
      const preloadFile = join(root, 'apps/desktop/preload/index.ts');
      writeFileSync(preloadFile, `${readFileSync(preloadFile, 'utf8')}\n// Exercise the controlled restart.\n`);
    }
    const [code, signal] = await exited;
    expect(existsSync(join(userData, 'data', 'app.sqlite.lock'))).toBe(false);
    expect(code).toBe(1);
    expect(signal).toBeNull();
    if (failure === 'unconfirmed-close') {
      expect(output).toContain('Desktop shutdown was not confirmed; restart is blocked.');
      expect(output.match(/\[Flowmate dev\] Ready /g)).toHaveLength(1);
      expect(output).toContain('Desktop exited without confirmed cleanup.');
    } else {
      expect(output).toContain('[Flowmate dev] Host startup failed.');
      expect(output).not.toContain('[Flowmate dev] Ready ');
      expect(existsSync(join(userData, 'data', 'app.sqlite'))).toBe(false);
    }
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.stdin.end();
      await Promise.race([exited, new Promise((resolveWait) => setTimeout(resolveWait, 5_000))]);
      if (child.exitCode === null && child.signalCode === null) { child.kill(); await exited; }
    }
  }
}, 25_000);
