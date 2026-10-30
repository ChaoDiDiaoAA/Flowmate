import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { appError, fail, type Result } from '@flowmate/contracts';
import { runServiceAction, type ServiceActionReport } from '../packages/shared/src/service-management.ts';
import { ServiceInstallationSchema } from '../packages/shared/src/service-layout.ts';

export async function runServiceCli(argv: readonly string[]): Promise<Result<ServiceActionReport>> {
  try {
    const args = parseArgs({ args: [...argv], strict: true, allowPositionals: true,
      options: { 'installation-file': { type: 'string' } } });
    const file = args.values['installation-file'];
    if (args.positionals.length !== 1 || !file || !isAbsolute(file)
      || argv.filter(value => value === '--installation-file' || value.startsWith('--installation-file=')).length !== 1) throw Error();
    const stat = lstatSync(file);
    if (basename(file) !== 'service-installation.json' || !stat.isFile() || stat.isSymbolicLink()
      || stat.size > 16384 || realpathSync(file) !== file) throw Error();
    const installation = ServiceInstallationSchema.safeParse(JSON.parse(readFileSync(file, 'utf8')));
    if (!installation.success) throw Error();
    const entry = fileURLToPath(import.meta.url), root = resolve(dirname(entry), '..');
    const packaged = entry === join(root, 'apps/service-manager.js');
    const source = entry === join(root, 'scripts/service.ts') && !existsSync(join(root, 'release.json'))
      && existsSync(join(root, 'apps/service/main.ts')) && existsSync(join(root, 'scripts/package.ts'))
      && existsSync(join(root, 'package.json')) && JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).name === 'flowmate';
    if (!packaged && !source)
      return fail(appError('service_manager_entry_invalid', 'runtime', 'Use the original installed manager or the explicit Flowmate source entry.'));
    const runtimeRoot = packaged ? root : installation.data.runtimeRoot;
    if (runtimeRoot !== installation.data.runtimeRoot)
      return fail(appError('service_installation_incompatible', 'runtime', 'The manager belongs to another installed release.'));
    return await runServiceAction({ action: args.positionals[0], installationFile: file, runtimeRoot });
  } catch { return fail(appError('service_management_arguments_invalid', 'input',
    'Expected install, start, stop, status or uninstall with one original absolute --installation-file.')); }
}

if (import.meta.main) {
  const result = await runServiceCli(process.argv.slice(2));
  process.stdout.write(JSON.stringify({ version: 1, result }) + '\n');
  if (!result.ok) process.exitCode = 1;
}
