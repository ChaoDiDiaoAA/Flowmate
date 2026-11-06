import { lstatSync, realpathSync } from 'node:fs';
import { isIP } from 'node:net';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { appError, CloudDesktopTargetSchema, fail, ok, type CloudDesktopTarget, type Result } from '@flowmate/contracts';

export type CloudSshTarget = CloudDesktopTarget;

function validHost(host: string): boolean {
  if (isIP(host)) return true;
  if (/^[0-9.]+$/.test(host)) return false;
  return host.split('.').every(label => label.length > 0 && label.length <= 63
    && /^[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?$/.test(label));
}
function trustedFile(path: string): boolean {
  if (!isAbsolute(path) || !/^[a-zA-Z]:[\\/]/.test(path) || /[%$\x00-\x1f\x7f]/.test(path) || path.slice(2).includes(':')) return false;
  try {
    const file = resolve(path), item = lstatSync(file);
    return item.isFile() && !item.isSymbolicLink() && relative(file, realpathSync(file)) === '';
  } catch { return false; }
}

/** Build an argv for the system OpenSSH client; no password or remote command is accepted. */
export function buildCloudSshLaunch(raw: unknown): Result<{ executable: string; args: readonly string[] }> {
  const target = CloudDesktopTargetSchema.safeParse(raw);
  if (process.platform !== 'win32' || !target.success || !validHost(target.data.host)
    || !trustedFile(target.data.privateKeyPath) || !trustedFile(target.data.knownHostsPath))
    return fail(appError('input_invalid', 'input', 'Cloud SSH configuration is invalid.'));
  try {
    const root = process.env.SystemRoot;
    if (!root || !isAbsolute(root)) throw Error('system_root_unavailable');
    const executable = join(realpathSync(root), 'System32', 'OpenSSH', 'ssh.exe'), file = lstatSync(executable);
    if (!file.isFile() || file.isSymbolicLink() || relative(executable, realpathSync(executable)) !== '') throw Error('ssh_unavailable');
    const { host, port, username, privateKeyPath, knownHostsPath } = target.data;
    return ok({ executable, args: ['-T', '-F', 'none', '-o', 'BatchMode=yes', '-o', 'PasswordAuthentication=no',
      '-o', 'KbdInteractiveAuthentication=no', '-o', 'PreferredAuthentications=publickey', '-o', 'IdentitiesOnly=yes',
      '-o', 'StrictHostKeyChecking=yes', '-o', `UserKnownHostsFile=${knownHostsPath}`, '-o', 'GlobalKnownHostsFile=none',
      '-o', 'UpdateHostKeys=no', '-o', 'ClearAllForwardings=yes', '-o', 'ForwardAgent=no', '-o', 'ForwardX11=no',
      '-o', 'PermitLocalCommand=no', '-o', 'ProxyCommand=none', '-o', 'ControlMaster=no', '-o', 'ConnectTimeout=10',
      '-i', privateKeyPath, '-l', username, '-p', String(port), '--', host] });
  } catch { return fail(appError('cloud_ssh_unavailable', 'runtime', 'The Windows OpenSSH client is unavailable.', true)); }
}
