import { chmodSync, constants, copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DURABLE_SDK_VERSIONS } from '@flowmate/runtime-durable';

const repository = fileURLToPath(new URL('..', import.meta.url));
const assets = ['prompts', 'skills', 'prompt-templates', 'subagents', 'extensions'] as const;

function copyTree(source: string, target: string): void {
  const item = lstatSync(source);
  if (item.isSymbolicLink()) throw Error('package_symlink_invalid');
  if (item.isDirectory()) {
    mkdirSync(target);
    for (const name of readdirSync(source)) copyTree(join(source, name), join(target, name));
  } else if (item.isFile()) { copyFileSync(source, target, constants.COPYFILE_EXCL); chmodSync(target, 0o644); }
  else throw Error('package_source_invalid');
}

/** Output must be a new directory; local plans, credentials and Windows service files are never inputs. */
export async function packageCloud(output: string): Promise<boolean> {
  if (process.platform !== 'linux' || process.arch !== 'x64' || Bun.version !== '1.4.4' || !isAbsolute(output)
    || resolve(output) !== output || existsSync(output)) return false;
  try {
    const parent = dirname(output), info = lstatSync(parent);
    if (!info.isDirectory() || info.isSymbolicLink() || realpathSync(parent) !== parent) return false;
    const product = JSON.parse(readFileSync(join(repository, 'package.json'), 'utf8')) as { version?: unknown };
    if (typeof product.version !== 'string' || !product.version || Object.values(DURABLE_SDK_VERSIONS).some(value => value !== '1.4.0')) return false;
    mkdirSync(output);
    const built = await Bun.build({ entrypoints: ['cloud-authority-main', 'cloud-runtime-main', 'cloud-desktop-bridge', 'cloud-openviking-bridge']
      .map(name => join(repository, 'apps', `${name}.ts`)), outdir: output, target: 'bun' });
    if (!built.success) return false;
    copyTree(join(repository, 'packages/core/src/storage/migrations'), join(output, 'migrations'));
    const resources = join(output, 'resources'); mkdirSync(resources);
    for (const name of assets) copyTree(join(repository, 'resources', name), join(resources, name));
    copyTree(join(repository, 'deploy/cloud'), join(output, 'deployment'));
    writeFileSync(join(output, 'manifest.json'), JSON.stringify({ version: 1, productVersion: product.version,
      bunVersion: Bun.version, sdk: DURABLE_SDK_VERSIONS }) + '\n', { flag: 'wx' });
    return true;
  } catch { return false; }
}

if (import.meta.main) {
  const result = process.argv.length === 3 && await packageCloud(process.argv[2]!).catch(() => false);
  if (!result) { process.stderr.write('[Flowmate] cloud_package_failed\n'); process.exitCode = 1; }
}
