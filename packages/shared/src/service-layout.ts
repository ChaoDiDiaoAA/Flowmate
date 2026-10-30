import { randomUUID } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { link, open, rm } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { z } from 'zod';
import { appError, fail, ok, type Result } from '@flowmate/contracts';
import { resolveRuntimeLayout, type RuntimeLayout } from './runtime-layout.ts';
import { readCurrentWindowsSid, readCurrentWindowsAccount, windowsSystemDirectory } from './windows-identity.ts';

const installationName = 'service-installation.json';
const absolutePath = z.string().min(1).max(32767).refine(value => isAbsolute(value) && resolve(value) === value
  && !/[\x00-\x1f%"<>|?*]/.test(value)); // WinSW expands %variables% even inside absolute paths.
const ownerSid = z.string().regex(/^S-1-\d+(?:-\d+)+$/).refine(value => !['S-1-5-18', 'S-1-5-19', 'S-1-5-20'].includes(value));
export const ServiceInstallationSchema = z.object({ version: z.literal(1), installationId: z.string().uuid(),
  serviceName: z.string(), ownerSid, runtimeRoot: absolutePath, dataRoot: absolutePath, releaseId: z.string().uuid(),
  enabled: z.boolean().optional(), activationOperationId: z.string().uuid().nullable().optional(),
  activationSettingsRevision: z.number().int().nonnegative().safe().nullable().optional(),
}).strict().refine(value => value.serviceName === 'FlowmateRuntime' + value.installationId.replaceAll('-', ''), 'Service identity must use its saved installation UUID.')
  .refine(value => value.enabled !== true || value.activationOperationId != null, 'An enabled service must reference its explicit activation operation.')
  .refine(value => value.activationSettingsRevision === undefined || value.activationSettingsRevision === null
    || value.activationOperationId !== undefined && value.activationOperationId !== null, 'An activation revision requires its original operation.');
export type ServiceInstallation = z.infer<typeof ServiceInstallationSchema>;
export type ServiceRuntimeLayout = { runtime: RuntimeLayout; serviceEntry: string; wrapperExecutable: string; templateFile: string };
export type PublishedServiceConfiguration = { installation: ServiceInstallation; wrapperExecutable: string; configurationFile: string; workingDirectory: string };
export type DesktopServiceSelection = { kind: 'legacy'; installation: ServiceInstallation | null }
  | { kind: 'service' | 'pending'; installation: ServiceInstallation };
const error = (code: string, message: string) => fail(appError(code, 'runtime', message));

/** Node-safe selection only; the service verifies the Windows account before opening its product owner. */
export function readDesktopServiceSelection(input: { dataRoot: string; runtimeRoot?: string; releaseId?: string }): Result<DesktopServiceSelection> {
  try {
    if (!isAbsolute(input.dataRoot) || resolve(input.dataRoot) !== input.dataRoot
      || existsSync(input.dataRoot) && realpathSync(input.dataRoot) !== input.dataRoot)
      return error('service_installation_invalid', 'The desktop data root is invalid.');
    const file = join(input.dataRoot, installationName);
    if (!existsSync(file)) return ok({ kind: 'legacy', installation: null });
    const stat = lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16384 || realpathSync(file) !== file)
      return error('service_installation_invalid', 'The original service selection is invalid.');
    const parsed = ServiceInstallationSchema.safeParse(JSON.parse(readFileSync(file, 'utf8')));
    if (!parsed.success || parsed.data.dataRoot !== input.dataRoot)
      return error('service_installation_invalid', 'The saved service selection does not match this desktop.');
    const installation = parsed.data;
    if (installation.enabled !== true && installation.activationOperationId == null)
      return ok({ kind: 'legacy', installation });
    if (input.runtimeRoot !== undefined && input.runtimeRoot !== installation.runtimeRoot
      || input.releaseId !== undefined && input.releaseId !== installation.releaseId)
      return error('service_installation_incompatible', 'The selected service belongs to another installed release.');
    const runtime = resolveRuntimeLayout({ isPackaged: true, appPath: join(dirname(installation.runtimeRoot), 'app.asar'),
      resourcesPath: dirname(installation.runtimeRoot), userDataRoot: input.dataRoot });
    if (!runtime.ok) return runtime;
    if (runtime.data.runtimeRoot !== installation.runtimeRoot || !runtime.data.release?.service
      || runtime.data.release.releaseId !== installation.releaseId)
      return error('service_installation_incompatible', 'The selected service runtime is incompatible.');
    return ok({ kind: installation.enabled === true ? 'service' : 'pending', installation });
  } catch { return error('service_installation_invalid', 'The original service selection could not be read.'); }
}

async function fileVersion(file: string): Promise<string> {
  const { dlopen, ptr } = await import('bun:ffi');
  const library = dlopen(join(await windowsSystemDirectory(), 'version.dll'), {
    GetFileVersionInfoSizeW: { args: ['ptr', 'ptr'], returns: 'u32' },
    GetFileVersionInfoW: { args: ['ptr', 'u32', 'u32', 'ptr'], returns: 'i32' },
    VerQueryValueW: { args: ['ptr', 'ptr', 'ptr', 'ptr'], returns: 'i32' },
  });
  try {
    const name = Buffer.from(file + '\0', 'utf16le'), ignored = new Uint32Array(1);
    const size = library.symbols.GetFileVersionInfoSizeW(name, ignored);
    if (!size || size > 1024 * 1024) throw Error('service_binary_version_unavailable');
    const data = new Uint8Array(size), address = new BigUint64Array(1), length = new Uint32Array(1);
    if (!library.symbols.GetFileVersionInfoW(name, 0, size, data)
      || !library.symbols.VerQueryValueW(data, Buffer.from('\\\0', 'utf16le'), address, length)) throw Error('service_binary_version_unavailable');
    const offset = Number(address[0]) - Number(ptr(data));
    if (offset < 0 || length[0]! < 52 || offset + 52 > data.length) throw Error('service_binary_version_unavailable');
    const view = new DataView(data.buffer, data.byteOffset + offset, 52);
    if (view.getUint32(0, true) !== 0xfeef04bd) throw Error('service_binary_version_unavailable');
    const high = view.getUint32(8, true), low = view.getUint32(12, true);
    return `${high >>> 16}.${high & 65535}.${low >>> 16}.${low & 65535}`;
  } finally { library.close(); }
}

/** Read-only version inspection; never invokes the wrapper's SCM commands or its logger. */
export async function validateWinSwExecutable(file: string): Promise<Result<void>> {
  try {
    if (!absolutePath.safeParse(file).success || lstatSync(file).isSymbolicLink() || !lstatSync(file).isFile()
      || await fileVersion(file) !== '2.12.0.0'
      || !readFileSync(file).includes(Buffer.from('.NETFramework,Version=v4.6.1')))
      return error('service_wrapper_version_invalid', 'WinSW 2.12.0 for .NET Framework 4.6.1 is required.');
    return ok(undefined);
  } catch { return error('service_wrapper_version_invalid', 'The fixed WinSW executable could not be verified.'); }
}

async function frameworkAvailable(): Promise<boolean> {
  const { dlopen } = await import('bun:ffi');
  const library = dlopen(join(await windowsSystemDirectory(), 'advapi32.dll'), {
    RegGetValueW: { args: ['u64', 'ptr', 'ptr', 'u32', 'ptr', 'ptr', 'ptr'], returns: 'i32' },
  });
  try {
    const release = new Uint32Array(1), size = new Uint32Array([4]);
    const status = library.symbols.RegGetValueW(0xffffffff80000002n,
      Buffer.from('SOFTWARE\\Microsoft\\NET Framework Setup\\NDP\\v4\\Full\0', 'utf16le'),
      Buffer.from('Release\0', 'utf16le'), 0x10010, null, release, size);
    return status === 0 && size[0] === 4 && release[0]! >= 394254;
  } finally { library.close(); }
}

export async function resolveServiceRuntime(input: { runtimeRoot: string; dataRoot: string }): Promise<Result<ServiceRuntimeLayout>> {
  if (!absolutePath.safeParse(input.runtimeRoot).success || !absolutePath.safeParse(input.dataRoot).success)
    return error('service_installation_invalid', 'Service paths must be explicit, absolute installation and data paths.');
  try {
    if (realpathSync(input.runtimeRoot) !== input.runtimeRoot || realpathSync(input.dataRoot) !== input.dataRoot)
      return error('service_installation_invalid', 'Service paths must refer to their original trusted directories.');
    const runtime = resolveRuntimeLayout({ isPackaged: true, appPath: join(dirname(input.runtimeRoot), 'app.asar'),
      resourcesPath: dirname(input.runtimeRoot), userDataRoot: input.dataRoot });
    if (!runtime.ok) return runtime;
    if (runtime.data.runtimeRoot !== input.runtimeRoot || !runtime.data.release?.service)
      return error('service_assets_missing', 'This installed release does not include the required service assets.');
    if (!await frameworkAvailable()) return error('service_framework_unavailable', '.NET Framework 4.6.1 or later is required.');
    if (await fileVersion(runtime.data.bunExecutable) !== `${runtime.data.release.bunVersion}.0`)
      return error('service_bun_version_invalid', 'The installed Bun executable must match its declared supported release version.');
    const wrapperExecutable = join(input.runtimeRoot, 'service/FlowmateRuntime.exe');
    const wrapper = await validateWinSwExecutable(wrapperExecutable); if (!wrapper.ok) return wrapper;
    return ok({ runtime: runtime.data, wrapperExecutable, serviceEntry: join(input.runtimeRoot, 'apps/service.js'),
      templateFile: join(input.runtimeRoot, 'resources/service/FlowmateRuntime.xml') });
  } catch { return error('service_prerequisite_unavailable', 'The original service runtime prerequisites could not be verified.'); }
}

export async function readServiceInstallation(input: { installationFile: string; runtimeRoot: string }): Promise<Result<ServiceInstallation>> {
  try {
    if (!absolutePath.safeParse(input.installationFile).success || !absolutePath.safeParse(input.runtimeRoot).success)
      return error('service_installation_invalid', 'An explicit installation record and runtime root are required.');
    if (!existsSync(input.installationFile)) return error('service_installation_missing', 'The saved service installation does not exist.');
    const file = lstatSync(input.installationFile);
    if (!file.isFile() || file.isSymbolicLink() || file.size > 16384 || realpathSync(input.installationFile) !== input.installationFile)
      return error('service_installation_invalid', 'The original installation record is invalid.');
    const parsed = ServiceInstallationSchema.safeParse(JSON.parse(readFileSync(input.installationFile, 'utf8')));
    if (!parsed.success || parsed.data.runtimeRoot !== input.runtimeRoot || join(parsed.data.dataRoot, installationName) !== input.installationFile)
      return error('service_installation_invalid', 'The saved installation identity or paths do not match.');
    const identity = await readCurrentWindowsSid(); if (!identity.ok) return identity;
    if (identity.data !== parsed.data.ownerSid) return error('service_account_mismatch', 'The process account is not the saved service owner.');
    const runtime = await resolveServiceRuntime(parsed.data); if (!runtime.ok) return runtime;
    if (runtime.data.runtime.release?.releaseId !== parsed.data.releaseId)
      return error('service_installation_incompatible', 'The installed release differs from the saved service installation.');
    return ok(parsed.data);
  } catch { return error('service_installation_invalid', 'The saved service installation could not be verified.'); }
}

/** Explicit preparation only: no database, wrapper copy, service registration, or process launch. */
export async function prepareServiceInstallation(input: { runtimeRoot: string; dataRoot: string }): Promise<Result<ServiceInstallation>> {
  const runtime = await resolveServiceRuntime(input); if (!runtime.ok) return runtime;
  const identity = await readCurrentWindowsSid(); if (!identity.ok) return identity;
  if (!ownerSid.safeParse(identity.data).success) return error('service_account_mismatch', 'A Windows user account must own the service installation.');
  const installationFile = join(input.dataRoot, installationName);
  if (existsSync(installationFile)) return readServiceInstallation({ installationFile, runtimeRoot: input.runtimeRoot });
  const installationId = randomUUID();
  const value: ServiceInstallation = { version: 1, installationId, serviceName: 'FlowmateRuntime' + installationId.replaceAll('-', ''),
    ownerSid: identity.data, runtimeRoot: input.runtimeRoot, dataRoot: input.dataRoot, releaseId: runtime.data.runtime.release!.releaseId,
    enabled: false, activationOperationId: null };
  try { writeFileSync(installationFile, JSON.stringify(value, null, 2), { flag: 'wx' }); return ok(value); }
  catch (cause) {
    if (cause instanceof Error && 'code' in cause && cause.code === 'EEXIST') return readServiceInstallation({ installationFile, runtimeRoot: input.runtimeRoot });
    return error('service_installation_write_failed', 'The installation record could not be saved. Existing records were retained.');
  }
}

export async function renderServiceConfiguration(value: ServiceInstallation): Promise<Result<string>> {
  const captured = ServiceInstallationSchema.safeParse(value);
  if (!captured.success) return error('service_installation_invalid', 'The original service installation is invalid.');
  value = captured.data;
  const verified = await readServiceInstallation({ installationFile: join(value.dataRoot, installationName), runtimeRoot: value.runtimeRoot });
  if (!verified.ok) return verified;
  if (JSON.stringify(verified.data) !== JSON.stringify(value)) return error('service_installation_invalid', 'The original installation record changed.');
  try {
    const account = await readCurrentWindowsAccount(); if (!account.ok) return account;
    if (account.data.sid !== value.ownerSid) return error('service_account_mismatch', 'The process account is not the saved service owner.');
    if ([account.data.domain, account.data.user].some(part => !part.trim() || part.length > 256 || /[\x00-\x1f%\\/]/.test(part)))
      return error('service_account_unavailable', 'The recorded owner account cannot be represented by this service configuration.');
    const values: Record<string, string> = { SERVICE_NAME: value.serviceName, BUN_EXECUTABLE: join(value.runtimeRoot, 'bin/bun.exe'),
      SERVICE_ENTRY: join(value.runtimeRoot, 'apps/service.js'), INSTALLATION_FILE: join(value.dataRoot, installationName),
      RUNTIME_ROOT: value.runtimeRoot, LOG_DIRECTORY: join(value.dataRoot, 'logs/service'),
      SERVICE_DOMAIN: account.data.domain, SERVICE_USER: account.data.user };
    const xml = readFileSync(join(value.runtimeRoot, 'resources/service/FlowmateRuntime.xml'), 'utf8');
    const escape = (text: string) => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');
    if (Object.keys(values).some(key => !xml.includes('{{' + key + '}}')) || !xml.includes('<allowservicelogon>false</allowservicelogon>')
      || /<password|<download|<interactive|LocalSystem/i.test(xml)) return error('service_configuration_invalid', 'The fixed service XML is invalid.');
    const rendered = xml.replace(/\{\{([A-Z_]+)\}\}/g, (_, key: string) => escape(values[key] ?? '{{' + key + '}}'));
    return rendered.includes('{{') ? error('service_configuration_invalid', 'The service XML has an unknown placeholder.') : ok(rendered);
  } catch { return error('service_configuration_invalid', 'The fixed service XML could not be rendered.'); }
}

function configurationFile(installation: ServiceInstallation): string {
  const directory = join(installation.runtimeRoot, 'service'), stat = lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(directory) !== directory) throw Error('service_configuration_invalid');
  return join(directory, 'FlowmateRuntime.xml');
}

/** Pure verification of the original side-by-side configuration; no wrapper invocation or repair. */
export async function readPublishedServiceConfiguration(value: ServiceInstallation): Promise<Result<PublishedServiceConfiguration>> {
  const captured = ServiceInstallationSchema.safeParse(value);
  if (!captured.success) return error('service_installation_invalid', 'The original service installation is invalid.');
  const installation = captured.data, rendered = await renderServiceConfiguration(installation); if (!rendered.ok) return rendered;
  try {
    const file = configurationFile(installation);
    if (!existsSync(file)) return error('service_configuration_missing', 'The original service configuration has not been published.');
    const stat = lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 262144 || realpathSync(file) !== file
      || !readFileSync(file).equals(Buffer.from(rendered.data)))
      return error('service_configuration_conflict', 'The existing service configuration does not match this installation. It was retained.');
    return ok({ installation, wrapperExecutable: join(installation.runtimeRoot, 'service/FlowmateRuntime.exe'),
      configurationFile: file, workingDirectory: join(installation.runtimeRoot, 'service') });
  } catch { return error('service_configuration_invalid', 'The original service configuration could not be verified.'); }
}

/** Publish once beside the pinned wrapper; never replace another installation's configuration. */
export async function publishServiceConfiguration(value: ServiceInstallation): Promise<Result<PublishedServiceConfiguration>> {
  const captured = ServiceInstallationSchema.safeParse(value);
  if (!captured.success) return error('service_installation_invalid', 'The original service installation is invalid.');
  const installation = captured.data, rendered = await renderServiceConfiguration(installation); if (!rendered.ok) return rendered;
  let temporary: string | undefined, handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    const file = configurationFile(installation);
    if (existsSync(file)) return readPublishedServiceConfiguration(installation);
    if (Buffer.byteLength(rendered.data) > 262144) throw Error('service_configuration_invalid');
    temporary = file + '.' + randomUUID() + '.tmp';
    handle = await open(temporary, 'wx', 0o600); await handle.writeFile(rendered.data); await handle.sync();
    await handle.close(); handle = undefined;
    // A no-replace link publishes complete bytes atomically, including against another manager process.
    try { await link(temporary, file); }
    catch (cause) { if (!cause || typeof cause !== 'object' || !('code' in cause) || cause.code !== 'EEXIST') throw cause; }
    return readPublishedServiceConfiguration(installation);
  } catch { return error('service_configuration_publish_failed', 'The service configuration was not confirmed. Existing files were retained.'); }
  finally {
    try { await handle?.close(); } catch { /* Preserve the publication result. */ }
    if (temporary) try { await rm(temporary, { force: true }); } catch { /* Only this invocation's unpublished temporary path is eligible. */ }
  }
}
