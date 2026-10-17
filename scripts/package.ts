import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getToolPath } from '@earendil-works/pi-coding-agent';
import { PACKAGED_MIGRATIONS, PACKAGED_NATIVE_TOOLS, PackagedReleaseSchema, resolveRuntimeLayout, type PackagedRelease } from '../packages/shared/src/runtime-layout.ts';

const entries = [['apps/host/main.ts', 'host.js'], ['agent-eval/src/desktop/worker.ts', 'evaluation-worker.js'],
  ['apps/maintenance/main.ts', 'maintenance.js']] as const;
const versions = { '@earendil-works/pi-ai': '0.85.1', '@earendil-works/pi-coding-agent': '0.85.1',
  '@earendil-works/pi-tui': '0.85.1', '@tintinweb/pi-subagents': '0.19.0', zod: '3.25.76',
  electron: '44.4.5', 'electron-builder': '26.15.3' };

function copyTree(source: string, destination: string, allowed: (path: string) => boolean = () => true): void {
  const stat = lstatSync(source);
  if (stat.isSymbolicLink()) throw Error('packaging_asset_link');
  if (stat.isDirectory()) {
    mkdirSync(destination, { recursive: true });
    for (const name of readdirSync(source).sort()) copyTree(join(source, name), join(destination, name), allowed);
  } else if (stat.isFile() && allowed(source)) {
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, readFileSync(source), { flag: 'wx' });
  } else if (!stat.isFile()) throw Error('packaging_asset_invalid');
}

function files(root: string, directory = root): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    if (entry.isSymbolicLink()) throw Error('packaging_asset_link');
    const path = join(directory, entry.name);
    return entry.isDirectory() ? files(root, path) : [relative(root, path).replaceAll('\\', '/')];
  }).sort();
}

function requireEntries(repository: string): void {
  if (entries.some(([entry]) => !existsSync(join(repository, entry)))) throw Error('packaging_entry_missing');
}

function launcher(worker: boolean): string {
  return `import {isAbsolute,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('..',import.meta.url));
const index=process.argv.indexOf('${worker ? '--repo' : '--user-data-root'}');
const data=index<0?null:process.argv[index+1];
try {
  if(!data||!isAbsolute(data))throw Error('installation_runtime_invalid');
  const allowed=new Set(['PATH','Path','SystemRoot','SYSTEMROOT','COMSPEC','PATHEXT','TEMP','TMP','WINDIR','HOME','USERPROFILE','LOCALAPPDATA','APPDATA','FLOWMATE_DESKTOP_VERSION','PI_OFFLINE']);
  for(const name of Object.keys(process.env))if(!allowed.has(name))delete process.env[name];
  process.env.PI_PACKAGE_DIR=join(root,'sdk');
  process.env.PI_CODING_AGENT_DIR=join(data,'runtime');
  const runtimeFlag=process.argv.indexOf('--runtime-root');
  if(runtimeFlag>=0) {
    if(process.argv.filter(value=>value==='--runtime-root').length!==1||resolve(process.argv[runtimeFlag+1]??'')!==resolve(root))throw Error('installation_runtime_invalid');
  } else process.argv.push('--runtime-root',resolve(root));
  ${worker ? "const worker=await import('./evaluation-worker.js');\n  if(typeof worker.startEvaluationWorker!=='function')throw Error('installation_dependency_missing');\n  await worker.startEvaluationWorker(process.argv.slice(2));" : "await import('./host.js');"}
} catch {process.stderr.write('[Flowmate] installation_runtime_invalid\\n');process.exitCode=1;}
`;
}

/** Build-time only. A caller supplies a new owned destination; no product data is read. */
export async function buildRuntime(repository: string, destination: string): Promise<PackagedRelease> {
  repository = realpathSync(repository);
  requireEntries(repository);
  if (process.platform !== 'win32' || process.arch !== 'x64' || Bun.version !== '1.4.0') throw Error('packaging_runtime_version_invalid');
  if (!isAbsolute(destination) || basename(destination) !== 'flowmate-runtime' || existsSync(destination)) throw Error('packaging_destination_invalid');
  const metadata = JSON.parse(readFileSync(join(repository, 'package.json'), 'utf8'));
  for (const [name, version] of Object.entries(versions)) {
    const installed = JSON.parse(readFileSync(join(repository, 'node_modules', name, 'package.json'), 'utf8'));
    if (installed.version !== version || (metadata.dependencies?.[name] ?? metadata.devDependencies?.[name]) !== version)
      throw Error('packaging_dependency_version_invalid');
  }
  const migrations = join(repository, 'packages/core/src/storage/migrations');
  if (readdirSync(migrations).sort().join('\n') !== [...PACKAGED_MIGRATIONS].sort().join('\n')) throw Error('packaging_schema_mismatch');
  const nativeTools = new Map<string, string>();
  for (const name of ['rg', 'fd'] as const) {
    const tool = getToolPath(name), path = tool && (isAbsolute(tool) ? tool : Bun.which(tool));
    if (!path || !lstatSync(path).isFile() || lstatSync(path).isSymbolicLink()) throw Error('packaging_native_tool_missing');
    const version = execFileSync(path, ['--version'], { encoding: 'utf8', timeout: 5000, windowsHide: true }).split(/\s+/)[1];
    if (version !== PACKAGED_NATIVE_TOOLS[name].version) throw Error('packaging_native_tool_version_invalid');
    nativeTools.set(name, path);
  }
  mkdirSync(join(destination, 'apps'), { recursive: true });
  const inputs = new Set<string>();
  const sdk = realpathSync(join(repository, 'node_modules/@earendil-works/pi-coding-agent'));
  for (const [entry, name] of [...entries, [join(sdk, 'dist/utils/image-resize-worker.js'), 'image-resize-worker.js']]) {
    const built = await Bun.build({ entrypoints: [isAbsolute(entry) ? entry : join(repository, entry)],
      outdir: join(destination, 'apps'), target: 'bun', format: 'esm', splitting: false, sourcemap: 'none', env: 'disable',
      naming: { entry: name, chunk: '[name].js', asset: '[name].[ext]' }, metafile: true });
    if (!built.success || built.outputs.length !== 1 || built.outputs[0]!.kind !== 'entry-point') throw Error('packaging_bundle_failed');
    for (const path of Object.keys(built.metafile?.inputs ?? {})) inputs.add(resolve(repository, path));
  }
  for (const [name, target, format] of [['main', 'node', 'esm'], ['preload', 'node', 'cjs'], ['renderer', 'browser', 'esm']] as const) {
    const built = await Bun.build({ entrypoints: [join(repository, 'agent-eval/src/adapters/fill-controls', name + '.ts')],
      outdir: join(destination, 'apps/fill-controls'), target, format, external: ['electron'], splitting: false,
      sourcemap: 'none', env: 'disable', naming: { entry: name + (format === 'cjs' ? '.cjs' : '.mjs') }, metafile: true });
    if (!built.success || built.outputs.length !== 1) throw Error('packaging_controls_build_failed');
    for (const path of Object.keys(built.metafile?.inputs ?? {})) inputs.add(resolve(repository, path));
  }
  copyTree(join(repository, 'agent-eval/src/adapters/fill-controls/index.html'), join(destination, 'apps/fill-controls/index.html'));
  copyTree(process.execPath, join(destination, 'bin/bun.exe'));
  copyTree(join(repository, 'licenses/bun-1.4.0.LICENSE.md'), join(destination, 'licenses/bun@1.4.0/LICENSE.md'));
  for (const [name, path] of nativeTools) {
    const tool = PACKAGED_NATIVE_TOOLS[name as keyof typeof PACKAGED_NATIVE_TOOLS];
    copyTree(path, join(destination, 'bin', name + '.exe'));
    copyTree(join(repository, 'licenses', `${tool.name}-${tool.version}.LICENSE-MIT`),
      join(destination, 'licenses', `${tool.name}@${tool.version}`, 'LICENSE-MIT'));
  }
  copyTree(realpathSync(join(repository, 'node_modules/@silvia-odwyer/photon-node/photon_rs_bg.wasm')),
    join(destination, 'bin/photon_rs_bg.wasm'));
  copyTree(realpathSync(join(repository, 'node_modules/@earendil-works/pi-tui/native/win32/prebuilds/win32-x64')),
    join(destination, 'native/win32/prebuilds/win32-x64'));
  copyTree(migrations, join(destination, 'apps/migrations'));
  copyTree(join(repository, 'resources'), join(destination, 'resources'), path => /\.(md|json)$/.test(path));
  copyTree(join(sdk, 'package.json'), join(destination, 'sdk/package.json'));
  copyTree(join(sdk, 'README.md'), join(destination, 'sdk/README.md'));
  copyTree(join(sdk, 'docs'), join(destination, 'sdk/docs'));
  copyTree(join(sdk, 'dist'), join(destination, 'sdk/dist'), path => !/\.(?:map|ts)$/.test(path));
  writeFileSync(join(destination, 'apps/start-host.js'), launcher(false), { flag: 'wx' });
  writeFileSync(join(destination, 'apps/start-evaluation.js'), launcher(true), { flag: 'wx' });

  const packages = new Map<string, { name: string; version: string; license: unknown }>();
  for (const input of inputs) {
    let directory = dirname(input);
    while (directory !== dirname(directory) && directory !== repository) {
      const manifest = join(directory, 'package.json');
      if (existsSync(manifest)) {
        const data = JSON.parse(readFileSync(manifest, 'utf8'));
        if (data.name && !data.name.startsWith('@flowmate/')) {
          packages.set(directory, { name: data.name, version: data.version, license: data.license ?? null }); break;
        }
      }
      directory = dirname(directory);
    }
  }
  for (const [directory, data] of packages) {
    const target = join(destination, 'licenses', `${data.name.replaceAll('/', '+')}@${data.version}`);
    for (const name of readdirSync(directory).filter(name => /^(?:licen[sc]e|copying|notice)(?:\.|$)/i.test(name))) {
      const source = join(directory, name), copy = join(target, name);
      if (!lstatSync(source).isFile()) continue;
      if (existsSync(copy)) {
        if (!readFileSync(source).equals(readFileSync(copy))) throw Error('packaging_license_conflict');
      } else copyTree(source, copy);
    }
    if (['@earendil-works/pi-ai', '@earendil-works/pi-agent-core', '@earendil-works/pi-coding-agent',
      '@earendil-works/pi-tui', '@earendil-works/pi-telemetry'].includes(data.name)
      && data.version === '0.85.1' && !existsSync(join(target, 'LICENSE')))
      copyTree(join(repository, 'licenses/pi-0.85.1.LICENSE'), join(target, 'LICENSE'));
  }
  mkdirSync(join(destination, 'licenses'), { recursive: true });
  writeFileSync(join(destination, 'licenses/third-party.json'), JSON.stringify([...packages.values(),
    { name: 'bun', version: Bun.version, license: 'MIT; bundled dependencies have separate notices in LICENSE.md' },
    ...Object.values(PACKAGED_NATIVE_TOOLS).map(tool => ({ ...tool, license: 'MIT' }))], null, 2), { flag: 'wx' });
  const release = PackagedReleaseSchema.parse({ version: 1, releaseId: randomUUID(), productVersion: metadata.version,
    platform: 'win32', arch: 'x64', bunVersion: Bun.version, electronVersion: versions.electron,
    sdkVersion: versions['@earendil-works/pi-coding-agent'], pluginVersion: versions['@tintinweb/pi-subagents'],
    schemaVersion: 20, settingsVersion: 7, files: files(destination) });
  writeFileSync(join(destination, 'release.json'), JSON.stringify(release, null, 2), { flag: 'wx' });
  const layout = resolveRuntimeLayout({ isPackaged: true, appPath: join(dirname(destination), 'app/app.asar'),
    resourcesPath: dirname(destination), userDataRoot: join(dirname(dirname(destination)), 'package-validation-data') });
  if (!layout.ok) throw Error(layout.error.code);
  return release;
}

async function packageDesktop(mode: 'dir' | 'nsis'): Promise<void> {
  const repository = realpathSync(fileURLToPath(new URL('..', import.meta.url)));
  requireEntries(repository);
  const stage = join(repository, 'out/package-stage');
  const output = join(repository, 'out');
  if (existsSync(output) && realpathSync(output) !== output) throw Error('packaging_destination_invalid');
  if (existsSync(stage) && realpathSync(stage) !== stage) throw Error('packaging_destination_invalid');
  if (relative(repository, resolve(stage)).replaceAll('\\', '/') !== 'out/package-stage') throw Error('packaging_destination_invalid');
  rmSync(stage, { recursive: true, force: true });
  mkdirSync(stage, { recursive: true });
  const env: Record<string, string> = {};
  for (const name of ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'COMSPEC', 'PATHEXT', 'TEMP', 'TMP', 'WINDIR',
    'HOME', 'USERPROFILE', 'LOCALAPPDATA', 'APPDATA']) if (process.env[name]) env[name] = process.env[name]!;
  const desktop = Bun.spawn([process.execPath, '--no-env-file', 'run', 'build:desktop'], { cwd: repository, env, stdout: 'inherit', stderr: 'inherit' });
  if (await desktop.exited !== 0) throw Error('packaging_desktop_build_failed');
  const app = join(stage, 'app');
  for (const component of ['main', 'preload', 'renderer']) copyTree(join(repository, 'out', component), join(app, 'out', component));
  const scan = new Bun.Transpiler({ loader: 'js' });
  for (const file of files(app).filter(path => /^out\/(?:main|preload)\/.+\.js$/.test(path))) {
    for (const dependency of scan.scanImports(readFileSync(join(app, file), 'utf8'))) {
      const path = dependency.path;
      if (path.startsWith('./') || path.startsWith('../')) {
        const target = resolve(dirname(join(app, file)), path), local = relative(app, target);
        if (isAbsolute(local) || local.startsWith('..') || !existsSync(target)) throw Error('packaging_desktop_dependency_missing');
        continue;
      }
      if (!path.startsWith('node:') && !builtinModules.includes(path) && path !== 'electron' && path !== 'zod')
        throw Error('packaging_desktop_dependency_missing');
    }
  }
  const metadata = JSON.parse(readFileSync(join(repository, 'package.json'), 'utf8'));
  writeFileSync(join(app, 'package.json'), JSON.stringify({ name: 'flowmate-desktop', version: metadata.version,
    private: true, type: 'module', main: 'out/main/index.js', dependencies: { zod: versions.zod } }, null, 2));
  copyTree(realpathSync(join(repository, 'node_modules/zod')), join(app, 'node_modules/zod'));
  await buildRuntime(repository, join(stage, 'flowmate-runtime'));
  const node = Bun.which('node'); if (!node) throw Error('packaging_node_missing');
  const electronDist = join(repository, 'node_modules/electron/dist');
  if (!existsSync(join(electronDist, 'electron.exe'))) {
    const install = Bun.spawn([process.execPath, join(repository, 'node_modules/electron/install.js')],
      { cwd: repository, env, stdout: 'inherit', stderr: 'inherit' });
    if (await install.exited !== 0) throw Error('packaging_electron_install_failed');
  }
  if (readFileSync(join(electronDist, 'version'), 'utf8').trim().replace(/^v/, '') !== versions.electron)
    throw Error('packaging_runtime_version_invalid');
  const builder = Bun.spawn([node, join(repository, 'node_modules/electron-builder/cli.js'), '--config',
    join(repository, 'electron-builder.yml'), '--win', ...(mode === 'dir' ? ['--dir'] : ['nsis']), '--x64', '--publish', 'never'],
    { cwd: repository, env, stdout: 'inherit', stderr: 'inherit' });
  if (await builder.exited !== 0) throw Error('packaging_builder_failed');
}

if (import.meta.main) {
  const mode = process.argv[2];
  if (mode !== 'dir' && mode !== 'nsis') { process.stderr.write('Usage: bun run scripts/package.ts dir|nsis\n'); process.exitCode = 2; }
  else try { await packageDesktop(mode); }
    catch (error) {
      const code = error instanceof Error && /^(?:packaging|installation)_[a-z_]+$/.test(error.message) ? error.message : 'packaging_failed';
      process.stderr.write(`[Flowmate] ${code}\n`); process.exitCode = 1;
    }
}
