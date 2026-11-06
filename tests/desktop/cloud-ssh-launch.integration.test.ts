import { expect, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildCloudSshLaunch } from '../../apps/desktop/main/cloud-ssh-launch.ts';
import { mkdtempSync } from '../support/resources.ts';

const windows = test.skipIf(process.platform !== 'win32');
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'Flowmate SSH 测试 '));
  const privateKeyPath = join(root, 'client key'), knownHostsPath = join(root, 'known hosts');
  writeFileSync(privateKeyPath, 'synthetic key'); writeFileSync(knownHostsPath, 'synthetic known hosts');
  return { host: 'example.invalid', port: 22, username: 'flowmate-bridge', privateKeyPath, knownHostsPath };
}

windows('the Windows OpenSSH launch uses strict pinned-host, noninteractive public-key options without a remote command', () => {
  const target = fixture(), result = buildCloudSshLaunch(target);
  expect(result.ok).toBe(true); if (!result.ok) throw Error(result.error.code);
  expect(result.data.executable.toLowerCase()).toBe(join(process.env.SystemRoot!, 'System32', 'OpenSSH', 'ssh.exe').toLowerCase());
  expect(result.data.args.slice(-2)).toEqual(['--', target.host]);
  const child = spawnSync(result.data.executable, ['-G', ...result.data.args], { encoding: 'utf8', windowsHide: true,
    env: { SystemRoot: process.env.SystemRoot!, USERPROFILE: process.env.USERPROFILE!, PATH: process.env.PATH!, ProgramData: process.env.ProgramData! } });
  expect(child.status).toBe(0);
  for (const setting of ['batchmode yes', 'passwordauthentication no', 'kbdinteractiveauthentication no',
    'identitiesonly yes', 'clearallforwardings yes', 'stricthostkeychecking true', 'updatehostkeys false'])
    expect(child.stdout.toLowerCase().split(/\r?\n/)).toContain(setting);
  expect(child.stdout).toContain(`userknownhostsfile ${target.knownHostsPath}`);
  expect(child.stdout).toContain(`identityfile ${target.privateKeyPath}`);
});

windows('cloud SSH rejects root, command-like hosts, invalid ports and untrusted or incomplete key paths', () => {
  const target = fixture();
  for (const change of [{ username: 'root' }, { host: '-oProxyCommand=bad' }, { host: 'example.invalid\nOther' },
    { port: 0 }, { port: 65536 }, { privateKeyPath: 'relative-key' }, { knownHostsPath: join(tmpdir(), 'missing-known-hosts') },
    { password: 'must-not-be-accepted' }])
    expect(buildCloudSshLaunch({ ...target, ...change }).ok).toBe(false);
});
