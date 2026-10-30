import { afterEach, expect, it, spyOn } from 'bun:test';
import * as ffi from 'bun:ffi';
import { copyFileSync, existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { PACKAGED_REQUIRED_FILES } from '../../packages/shared/src/runtime-layout.ts';
import { prepareServiceInstallation } from '../../packages/shared/src/service-layout.ts';
import { cleanupResources, mkdtempSync } from '../support/resources.ts';

afterEach(cleanupResources);
const windows = process.platform === 'win32' && process.arch === 'x64' ? it : it.skip;

windows.each([{ name: 'missing', status: 2, release: 0 }, { name: 'below 4.6.1', status: 0, release: 394253 }])
('refuses a %s .NET installation before saving service identity, opening SQLite or invoking any wrapper', async value => {
  const root = mkdtempSync(join(tmpdir(), 'flowmate-dotnet-')), runtimeRoot = join(root, 'resources/flowmate-runtime');
  const dataRoot = join(root, 'data-root'); mkdirSync(dataRoot);
  const files = [...PACKAGED_REQUIRED_FILES, 'apps/service.js', 'apps/service-manager.js', 'service/FlowmateRuntime.exe',
    'resources/service/FlowmateRuntime.xml', 'licenses/winsw@2.12.0/LICENSE.txt', 'resources/prompts/invoice/prompt.md'];
  for (const file of files) {
    const target = join(runtimeRoot, file); mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, file === 'sdk/package.json' ? JSON.stringify({ version: '1.4.0' }) : 'Controlled prerequisite asset.');
  }
  copyFileSync(process.execPath, join(runtimeRoot, 'bin/bun.exe'));
  copyFileSync(resolve(import.meta.dir, '../../resources/service/WinSW.NET461.exe'), join(runtimeRoot, 'service/FlowmateRuntime.exe'));
  copyFileSync(resolve(import.meta.dir, '../../resources/service/FlowmateRuntime.xml'), join(runtimeRoot, 'resources/service/FlowmateRuntime.xml'));
  writeFileSync(join(runtimeRoot, 'release.json'), JSON.stringify({ version: 1,
    releaseId: 'e591bd4b-a830-442f-8523-b111f9385980', productVersion: '0.1.0', platform: 'win32', arch: 'x64',
    bunVersion: '1.4.4', electronVersion: '44.4.5', sdkVersion: '1.4.0', pluginVersion: '0.19.0',
    schemaVersion: 22, settingsVersion: 7, service: { wrapperVersion: '2.12.0', framework: 'net461' }, files }));
  const before = readdirSync(dataRoot), native = ffi.dlopen;
  let reads = 0, closes = 0, versionReads = 0;
  const unexpectedNative: string[] = [];
  const processGuard = spyOn(Bun, 'spawn').mockImplementation(() => { throw Error('A prerequisite check cannot invoke a process.'); });
  const intercept = <Fns extends Record<string, ffi.FFIFunction>>(file: Parameters<typeof ffi.dlopen>[0], definitions: Fns): ffi.Library<Fns> => {
    const names = Object.keys(definitions);
    if (basename(String(file)).toLowerCase() === 'advapi32.dll' && names.length === 1 && names[0] === 'RegGetValueW') {
      return { symbols: { RegGetValueW: (...args: unknown[]) => {
        const data = args[5], size = args[6];
        if (!(data instanceof Uint32Array) || !(size instanceof Uint32Array)) throw Error('Expected the original registry output buffers.');
        reads++; data[0] = value.release; size[0] = 4; return value.status;
      } }, close() { closes++; } } as unknown as ffi.Library<Fns>;
    }
    const library = basename(String(file)).toLowerCase();
    if (library === 'kernel32.dll' && names.length === 1 && names[0] === 'GetSystemDirectoryW') return native(file, definitions);
    if (library === 'version.dll') versionReads++;
    unexpectedNative.push(library + ':' + names.join(','));
    throw Error('Unexpected native binding during the controlled prerequisite check.');
  };
  const loader = spyOn(ffi, 'dlopen').mockImplementation(intercept);
  try {
    expect(Object.is((await import('bun:ffi')).dlopen, loader)).toBe(true);
    expect(Object.is(Bun.spawn, processGuard)).toBe(true);
    expect(await prepareServiceInstallation({ runtimeRoot, dataRoot })).toMatchObject({ ok: false,
      error: { code: 'service_framework_unavailable' } });
    expect(reads).toBe(1); expect(closes).toBe(1); expect(versionReads).toBe(0);
    expect(unexpectedNative).toEqual([]);
    expect(processGuard).not.toHaveBeenCalled();
    expect(existsSync(join(dataRoot, 'service-installation.json'))).toBe(false);
    expect(existsSync(join(dataRoot, 'data/app.sqlite'))).toBe(false);
    expect(existsSync(join(runtimeRoot, 'service/FlowmateRuntime.xml'))).toBe(false);
    expect(readdirSync(dataRoot)).toEqual(before);
  } finally { loader.mockRestore(); processGuard.mockRestore(); }
});
