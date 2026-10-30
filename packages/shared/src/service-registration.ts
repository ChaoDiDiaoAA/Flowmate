import { win32 } from 'node:path';
import { appError, fail, ok, type Result } from '@flowmate/contracts';
import { windowsSystemDirectory } from './windows-identity.ts';

export type ServiceRegistration = Readonly<{ serviceName: string; binaryPath: string; accountName: string; accountSid: string }>;
const unavailable = () => fail(appError('service_registration_unavailable', 'runtime', 'The original Windows service registration could not be verified.'));

function wrapperPath(value: string): string {
  // WinSW 2.12 Install passes its own quoted ExecutablePath to CreateService, without child arguments.
  const match = /^"([^"\x00-\x1f]+)"$/.exec(value), path = match?.[1];
  if (!path || !/^(?:[A-Za-z]:\\|\\\\[^\\]+\\[^\\]+\\)/.test(path) || win32.normalize(path) !== path
    || win32.basename(path).toLowerCase() !== 'flowmateruntime.exe') throw Error('service_registration_unavailable');
  return path;
}

function configurationText(buffer: BigUint64Array, base: number, member: number): string {
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength), offset = view.getBigUint64(member, true) - BigInt(base);
  if (offset < 64n || offset % 2n !== 0n || offset + 2n > BigInt(buffer.byteLength)) throw Error('service_registration_unavailable');
  const start = Number(offset);
  for (let end = start; end + 2 <= buffer.byteLength; end += 2) {
    if (view.getUint16(end, true) === 0) {
      const value = Buffer.from(buffer.buffer, buffer.byteOffset + start, end - start).toString('utf16le');
      if (!value || /[\x00-\x1f]/.test(value)) throw Error('service_registration_unavailable');
      return value;
    }
  }
  throw Error('service_registration_unavailable');
}

/** Registered next-start configuration only; this does not identify a running process or prove product readiness/stop. */
export async function readServiceRegistration(serviceName: string): Promise<Result<ServiceRegistration | null>> {
  if (typeof serviceName !== 'string' || !/^FlowmateRuntime[0-9a-fA-F]{32}$/.test(serviceName))
    return fail(appError('service_registration_name_invalid', 'input', 'Expected the original Flowmate installation service name.'));
  if (process.platform !== 'win32' || process.arch !== 'x64' || !process.versions.bun || typeof Bun === 'undefined') return unavailable();
  try {
    const directory = await windowsSystemDirectory(), { CString, dlopen, ptr } = await import('bun:ffi');
    const kernel = dlopen(win32.join(directory, 'kernel32.dll'), {
      GetLastError: { args: [], returns: 'u32' }, LocalFree: { args: ['u64'], returns: 'u64' },
    });
    try {
      const security = dlopen(win32.join(directory, 'advapi32.dll'), {
        OpenSCManagerW: { args: ['ptr', 'ptr', 'u32'], returns: 'u64' },
        OpenServiceW: { args: ['u64', 'ptr', 'u32'], returns: 'u64' },
        QueryServiceConfigW: { args: ['u64', 'ptr', 'u32', 'ptr'], returns: 'i32' },
        CloseServiceHandle: { args: ['u64'], returns: 'i32' },
        LookupAccountNameW: { args: ['ptr', 'ptr', 'ptr', 'ptr', 'ptr', 'ptr', 'ptr'], returns: 'i32' },
        ConvertSidToStringSidA: { args: ['ptr', 'ptr'], returns: 'i32' },
      });
      let manager = 0n, service = 0n;
      const sidText = new BigUint64Array(1);
      try {
        manager = BigInt(security.symbols.OpenSCManagerW(null, null, 1)); // SC_MANAGER_CONNECT
        if (manager === 0n) throw Error('service_registration_unavailable');
        service = BigInt(security.symbols.OpenServiceW(manager, Buffer.from(serviceName + '\0', 'utf16le'), 1)); // SERVICE_QUERY_CONFIG
        if (service === 0n) {
          if (kernel.symbols.GetLastError() === 1060) return ok(null);
          throw Error('service_registration_unavailable');
        }
        const needed = new Uint32Array(1);
        if (security.symbols.QueryServiceConfigW(service, null, 0, needed) || kernel.symbols.GetLastError() !== 122
          || needed[0]! < 68 || needed[0]! > 8192) throw Error('service_registration_unavailable');
        const configuration = new BigUint64Array(Math.ceil(needed[0]! / 8));
        new Uint8Array(configuration.buffer).fill(255);
        if (!security.symbols.QueryServiceConfigW(service, configuration, configuration.byteLength, needed)) throw Error('service_registration_unavailable');
        const base = ptr(configuration);
        if (!Number.isSafeInteger(base) || base <= 0 || new DataView(configuration.buffer).getUint32(0, true) !== 16)
          throw Error('service_registration_unavailable');
        // QUERY_SERVICE_CONFIGW x64: binary path at 16, service account at 48, fixed structure size 64.
        const binaryPath = wrapperPath(configurationText(configuration, base, 16)), accountName = configurationText(configuration, base, 48);
        const lookupName = Buffer.from((accountName.toLowerCase() === 'localsystem' ? 'NT AUTHORITY\\SYSTEM' : accountName) + '\0', 'utf16le');
        const sidLength = new Uint32Array(1), domainLength = new Uint32Array(1), use = new Uint32Array(1);
        if (security.symbols.LookupAccountNameW(null, lookupName, null, sidLength, null, domainLength, use)
          || kernel.symbols.GetLastError() !== 122 || sidLength[0]! < 8 || sidLength[0]! > 68 || domainLength[0]! > 32768)
          throw Error('service_registration_unavailable');
        const sid = new BigUint64Array(Math.ceil(sidLength[0]! / 8)), domain = new Uint16Array(Math.max(1, domainLength[0]!));
        sidLength[0] = sid.byteLength; domainLength[0] = domain.length;
        if (!security.symbols.LookupAccountNameW(null, lookupName, sid, sidLength, domain, domainLength, use)
          || sidLength[0]! < 8 || sidLength[0]! > sid.byteLength || domainLength[0]! >= domain.length
          || !security.symbols.ConvertSidToStringSidA(sid, sidText) || sidText[0] === 0n) throw Error('service_registration_unavailable');
        const accountSid = new CString(sidText[0]).toString();
        if (accountSid.length > 184 || !/^S-1-\d+(?:-\d+)+$/.test(accountSid)
          || use[0] !== 1 && !['S-1-5-18', 'S-1-5-19', 'S-1-5-20'].includes(accountSid)) throw Error('service_registration_unavailable');
        return ok({ serviceName, binaryPath, accountName, accountSid });
      } finally {
        let releaseFailed = false;
        try { if (sidText[0] !== 0n && BigInt(kernel.symbols.LocalFree(sidText[0])) !== 0n) releaseFailed = true; } catch { releaseFailed = true; }
        try { if (service !== 0n && !security.symbols.CloseServiceHandle(service)) releaseFailed = true; } catch { releaseFailed = true; }
        try { if (manager !== 0n && !security.symbols.CloseServiceHandle(manager)) releaseFailed = true; } catch { releaseFailed = true; }
        try { security.close(); } catch { releaseFailed = true; }
        if (releaseFailed) throw Error('service_registration_unavailable');
      }
    } finally { kernel.close(); }
  } catch { return unavailable(); }
}
