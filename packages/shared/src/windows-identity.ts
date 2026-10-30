import { join } from 'node:path';
import { appError, fail, ok, type Result } from '@flowmate/contracts';

// kernel32 is a Windows KnownDLL; resolve other system libraries without a cwd/PATH search.
export async function windowsSystemDirectory(): Promise<string> {
  if (process.platform !== 'win32' || process.arch !== 'x64' || !process.versions.bun)
    throw new Error('windows_identity_unavailable');
  const { dlopen } = await import('bun:ffi');
  const kernel = dlopen('kernel32.dll', { GetSystemDirectoryW: { args: ['ptr', 'u32'], returns: 'u32' } });
  try {
    const directory = new Uint16Array(32768);
    const length = kernel.symbols.GetSystemDirectoryW(directory, directory.length);
    if (!length || length >= directory.length) throw new Error('windows_identity_unavailable');
    return Buffer.from(directory.buffer, 0, length * 2).toString('utf16le');
  } finally { kernel.close(); }
}

type WindowsAccount = { sid: string; domain: string; user: string };
function readIdentity(kind: 'sid'): Promise<Result<string>>;
function readIdentity(kind: 'account'): Promise<Result<WindowsAccount>>;
function readIdentity(kind: 'elevation'): Promise<Result<boolean>>;
async function readIdentity(kind: 'sid' | 'account' | 'elevation'): Promise<Result<string | WindowsAccount | boolean>> {
  try {
    const directory = await windowsSystemDirectory();
    const { CString, dlopen } = await import('bun:ffi');
    const kernel = dlopen(join(directory, 'kernel32.dll'), {
      GetCurrentProcess: { args: [], returns: 'u64' },
      GetLastError: { args: [], returns: 'u32' },
      CloseHandle: { args: ['u64'], returns: 'i32' },
      LocalFree: { args: ['u64'], returns: 'u64' },
    });
    try {
      const security = dlopen(join(directory, 'advapi32.dll'), {
        OpenProcessToken: { args: ['u64', 'u32', 'ptr'], returns: 'i32' },
        GetTokenInformation: { args: ['u64', 'u32', 'ptr', 'u32', 'ptr'], returns: 'i32' },
        ConvertSidToStringSidA: { args: ['ptr', 'ptr'], returns: 'i32' },
        LookupAccountSidW: { args: ['ptr', 'ptr', 'ptr', 'ptr', 'ptr', 'ptr', 'ptr'], returns: 'i32' },
      });
      const token = new BigUint64Array(1), text = new BigUint64Array(1);
      try {
        if (!security.symbols.OpenProcessToken(kernel.symbols.GetCurrentProcess(), 8, token))
          throw new Error('windows_identity_unavailable');
        if (kind === 'elevation') {
          const elevation = new Uint32Array(1), length = new Uint32Array(1);
          if (!security.symbols.GetTokenInformation(token[0]!, 20, elevation, elevation.byteLength, length) || length[0] !== elevation.byteLength)
            throw new Error('windows_identity_unavailable');
          return ok(elevation[0] !== 0);
        }
        const length = new Uint32Array(1);
        if (security.symbols.GetTokenInformation(token[0]!, 1, null, 0, length)
          || kernel.symbols.GetLastError() !== 122 || length[0]! < 16 || length[0]! > 65536)
          throw new Error('windows_identity_unavailable');
        const user = new BigUint64Array(Math.ceil(length[0]! / 8));
        if (!security.symbols.GetTokenInformation(token[0]!, 1, user, user.byteLength, length)
          || !user[0] || !security.symbols.ConvertSidToStringSidA(user[0], text) || !text[0])
          throw new Error('windows_identity_unavailable');
        const sid = new CString(text[0]).toString();
        if (!/^S-1-\d+(?:-\d+)+$/.test(sid)) throw new Error('windows_identity_unavailable');
        if (kind === 'sid') return ok(sid);
        const nameLength = new Uint32Array(1), domainLength = new Uint32Array(1), use = new Uint32Array(1);
        if (security.symbols.LookupAccountSidW(null, user[0], null, nameLength, null, domainLength, use)
          || kernel.symbols.GetLastError() !== 122 || nameLength[0]! < 1 || nameLength[0]! > 32768
          || domainLength[0]! < 1 || domainLength[0]! > 32768) throw new Error('windows_identity_unavailable');
        const name = new Uint16Array(nameLength[0]!), domain = new Uint16Array(domainLength[0]!);
        if (!security.symbols.LookupAccountSidW(null, user[0], name, nameLength, domain, domainLength, use)
          || use[0] !== 1 || nameLength[0]! < 1 || nameLength[0]! >= name.length || domainLength[0]! >= domain.length)
          throw new Error('windows_identity_unavailable');
        return ok({ sid, domain: Buffer.from(domain.buffer, 0, domainLength[0]! * 2).toString('utf16le'),
          user: Buffer.from(name.buffer, 0, nameLength[0]! * 2).toString('utf16le') });
      } finally {
        if (text[0]) kernel.symbols.LocalFree(text[0]);
        if (token[0]) kernel.symbols.CloseHandle(token[0]);
        security.close();
      }
    } finally { kernel.close(); }
  } catch {
    return fail(appError('windows_identity_unavailable', 'runtime', 'The current Windows account could not be verified.'));
  }
}

/** The original process account, without resolving a name or reading its elevation. */
export async function readCurrentWindowsSid(): Promise<Result<string>> { return readIdentity('sid'); }

/** Names come from the same TokenUser SID; callers cannot select another account. */
export async function readCurrentWindowsAccount(): Promise<Result<WindowsAccount>> { return readIdentity('account'); }

/** Read-only TokenElevation; this never prompts for UAC or changes the process token. */
export async function readCurrentWindowsElevation(): Promise<Result<boolean>> { return readIdentity('elevation'); }
