import { describe, expect, it } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { mkdtemp } from '../support/resources.ts';
import { createCredentialStore } from '../../packages/shared/src/secure-credential-store.ts';
import { createServiceSecureStorage, readCurrentWindowsSid } from '../../packages/shared/src/index.ts';
import * as windowsIdentity from '../../packages/shared/src/windows-identity.ts';

describe.skipIf(process.platform !== 'win32' || process.arch !== 'x64')('service CurrentUser credentials', () => {
  async function currentSid() {
    const result = await readCurrentWindowsSid();
    if (!result.ok) throw new Error(result.error.code);
    expect(result.data).toMatch(/^S-1-\d+(?:-\d+)+$/);
    return result.data;
  }

  it('resolves only the original current process user and returns its nonsecret domain and account name', async () => {
    expect(typeof windowsIdentity.readCurrentWindowsAccount).toBe('function');
    const account = await windowsIdentity.readCurrentWindowsAccount();
    expect(account.ok).toBe(true); if (!account.ok) throw Error(account.error.code);
    expect(account.data.sid).toBe(await currentSid());
    expect(account.data.user.toLowerCase()).toBe(userInfo().username.toLowerCase());
    expect(account.data.domain.length).toBeGreaterThan(0);
    expect(Object.keys(account.data).sort()).toEqual(['domain', 'sid', 'user']);
    const elevation = await windowsIdentity.readCurrentWindowsElevation();
    expect(elevation.ok).toBe(true); if (!elevation.ok) throw Error(elevation.error.code);
    expect(typeof elevation.data).toBe('boolean');
  });

  it('round trips Unicode through real Windows protection and the existing ciphertext store without Electron', async () => {
    expect(process.versions.electron).toBeUndefined();
    const root = await mkdtemp(join(tmpdir(), 'flowmate-service-credential-'));
    const file = join(root, 'key.json');
    const storage = createServiceSecureStorage(await currentSid());
    expect(await storage.isAvailable()).toBe(true);
    const plaintext = 'synthetic-service-凭据-😀\u0000end';
    const store = createCredentialStore(file, storage);
    expect(await store.write(plaintext)).toEqual({ ok: true, data: undefined });
    expect(await readFile(file, 'utf8')).not.toContain(plaintext);
    expect(await store.read()).toEqual({ ok: true, data: plaintext });
    expect(await storage.decrypt(await storage.encrypt(plaintext))).toEqual({ plaintext, shouldReEncrypt: false });
  });

  it('decrypts the same synthetic credential in a fresh same-user Bun process', async () => {
    const ownerSid = await currentSid();
    const account = await windowsIdentity.readCurrentWindowsAccount(); if (!account.ok) throw Error(account.error.code);
    const ciphertext = await createServiceSecureStorage(ownerSid).encrypt('synthetic-service-process-key');
    const child = Bun.spawn([process.execPath, '--no-env-file', '--eval', `
      const input = await new Response(Bun.stdin.stream()).json();
      const { createServiceSecureStorage, readCurrentWindowsSid } = await import(input.module);
      const identity = await readCurrentWindowsSid();
      const { readCurrentWindowsAccount } = await import(input.identityModule);
      const account = await readCurrentWindowsAccount();
      const result = await createServiceSecureStorage(input.ownerSid).decrypt(Buffer.from(input.ciphertext, 'base64'));
      process.stdout.write(JSON.stringify({ sameIdentity: identity.ok && identity.data === input.ownerSid,
        sameAccount: account.ok && JSON.stringify(account.data) === JSON.stringify(input.account),
        decrypted: result.plaintext === input.expected, electron: Boolean(process.versions.electron) }));
    `], { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe', env: {} });
    child.stdin.write(JSON.stringify({ module: new URL('../../packages/shared/src/index.ts', import.meta.url).href,
      identityModule: new URL('../../packages/shared/src/windows-identity.ts', import.meta.url).href, account: account.data,
      ownerSid, ciphertext: Buffer.from(ciphertext).toString('base64'), expected: 'synthetic-service-process-key' }));
    child.stdin.end();
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect({ code, stderr }).toEqual({ code: 0, stderr: '' });
    expect(JSON.parse(stdout)).toEqual({ sameIdentity: true, sameAccount: true, decrypted: true, electron: false });
  });

  it('rejects unmapped and non-user account results and releases the real token, SID allocation and libraries', async () => {
    const child = Bun.spawn([process.execPath, '--no-env-file', '--eval', `
      const input=await new Response(Bun.stdin.stream()).json(),ffi={...await import('bun:ffi')},{mock}=await import('bun:test');
      const stats={opened:0,closed:0,tokens:0,handlesClosed:0,sids:0,freed:0,lookups:0};let mode='unmapped',lastError=null;
      mock.module('bun:ffi',()=>({...ffi,dlopen:(file,definitions)=>{
        const library=ffi.dlopen(file,definitions),symbols={...library.symbols};stats.opened++;
        for(const name of ['OpenProcessToken','CloseHandle','ConvertSidToStringSidA','LocalFree'])if(symbols[name]){
          const call=symbols[name];symbols[name]=(...args)=>{const result=call(...args);
            if(name==='OpenProcessToken'&&result)stats.tokens++;
            if(name==='CloseHandle')stats.handlesClosed++;
            if(name==='ConvertSidToStringSidA'&&result)stats.sids++;
            if(name==='LocalFree')stats.freed++;return result;};
        }
        if(symbols.GetLastError){const call=symbols.GetLastError;symbols.GetLastError=()=>lastError??call()}
        if(symbols.LookupAccountSidW){const call=symbols.LookupAccountSidW;symbols.LookupAccountSidW=(...args)=>{
          stats.lookups++;if(mode==='unmapped'){lastError=1332;return 0}
          const result=call(...args);if(result)args[6][0]=2;return result;
        }}
        return {...library,symbols,close:()=>{stats.closed++;library.close()}};
      }}));
      const api=await import(input.module),sid=await api.readCurrentWindowsSid(),elevation=await api.readCurrentWindowsElevation(),sidDidNotLookup=stats.lookups===0;
      const unmapped=await api.readCurrentWindowsAccount();mode='non_user';lastError=null;
      const nonUser=await api.readCurrentWindowsAccount();
      process.stdout.write(JSON.stringify({sidOk:sid.ok,elevationOk:elevation.ok&&typeof elevation.data==='boolean',sidDidNotLookup,unmapped,nonUser,stats}));
    `], { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe', env: {} });
    child.stdin.write(JSON.stringify({ module: new URL('../../packages/shared/src/windows-identity.ts', import.meta.url).href })); child.stdin.end();
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect({ code, stderr }).toEqual({ code: 0, stderr: '' });
    const output: { sidOk: boolean; elevationOk: boolean; sidDidNotLookup: boolean; unmapped: { ok: boolean; error: { code: string } };
      nonUser: { ok: boolean; error: { code: string } }; stats: Record<'opened' | 'closed' | 'tokens' | 'handlesClosed' | 'sids' | 'freed' | 'lookups', number> } = JSON.parse(stdout);
    expect(output.sidOk).toBe(true); expect(output.elevationOk).toBe(true); expect(output.sidDidNotLookup).toBe(true);
    for (const value of [output.unmapped, output.nonUser]) expect(value).toMatchObject({ ok: false, error: { code: 'windows_identity_unavailable' } });
    expect(output.stats.tokens).toBe(4); expect(output.stats.handlesClosed).toBe(output.stats.tokens);
    expect(output.stats.freed).toBe(output.stats.sids); expect(output.stats.closed).toBe(output.stats.opened);
    expect(output.stats.lookups).toBeGreaterThan(0);
  });

  it('refuses another owner SID before encrypting or decrypting', async () => {
    const ciphertext = await createServiceSecureStorage(await currentSid()).encrypt('synthetic-owner-key');
    const storage = createServiceSecureStorage('S-1-0-0');
    expect(await storage.isAvailable()).toBe(false);
    await expect(storage.encrypt('synthetic-owner-key')).rejects.toThrow('service_account_mismatch');
    await expect(storage.decrypt(ciphertext)).rejects.toThrow('service_account_mismatch');
  });

  it('rejects corrupted ciphertext without replacing the original stored credential', async () => {
    const root = await mkdtemp(join(tmpdir(), 'flowmate-service-corrupt-'));
    const file = join(root, 'key.json');
    const storage = createServiceSecureStorage(await currentSid());
    const store = createCredentialStore(file, storage);
    expect((await store.write('synthetic-corruption-key')).ok).toBe(true);
    const original = await readFile(file, 'utf8');
    const ciphertext = Buffer.from(JSON.parse(original).ciphertext, 'base64');
    ciphertext[ciphertext.length - 1]! ^= 0xff;
    await expect(storage.decrypt(ciphertext)).rejects.toThrow('service_credential_decrypt_failed');
    await expect(storage.decrypt(new Uint8Array())).rejects.toThrow('service_credential_decrypt_failed');
    expect(await readFile(file, 'utf8')).toBe(original);
    expect(await store.read()).toEqual({ ok: true, data: 'synthetic-corruption-key' });
  });
});

it('keeps shared exports loadable in Node without loading the Bun-only native module', async () => {
  const node = Bun.which('node');
  expect(node).not.toBeNull();
  const module = new URL('../../packages/shared/src/index.ts', import.meta.url).href;
  const child = Bun.spawn([node!, '--import', 'tsx', '--input-type=module', '--eval', `
    const { createServiceSecureStorage, readCurrentWindowsSid } = await import(${JSON.stringify(module)});
    const identity = await readCurrentWindowsSid();
    const { readCurrentWindowsAccount, readCurrentWindowsElevation } = await import(${JSON.stringify(new URL('../../packages/shared/src/windows-identity.ts', import.meta.url).href)});
    const account = await readCurrentWindowsAccount();
    const elevation = await readCurrentWindowsElevation();
    process.stdout.write(JSON.stringify({ identityAvailable: identity.ok,
      accountAvailable: account.ok,
      elevationAvailable: elevation.ok,
      storageAvailable: await createServiceSecureStorage('S-1-0-0').isAvailable() }));
  `], { stdout: 'pipe', stderr: 'pipe', env: {} });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect({ code, stderr }).toEqual({ code: 0, stderr: '' });
  expect(JSON.parse(stdout)).toEqual({ identityAvailable: false, accountAvailable: false, elevationAvailable: false, storageAvailable: false });
});

it('reports unavailable and refuses plaintext fallback outside the supported Windows runtime', async () => {
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')!;
  try {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    const root = await mkdtemp(join(tmpdir(), 'flowmate-service-unavailable-'));
    const storage = createServiceSecureStorage('S-1-0-0');
    expect(await storage.isAvailable()).toBe(false);
    const identity = await readCurrentWindowsSid();
    expect(identity.ok).toBe(false);
    expect((await windowsIdentity.readCurrentWindowsAccount()).ok).toBe(false);
    expect((await windowsIdentity.readCurrentWindowsElevation()).ok).toBe(false);
    const store = createCredentialStore(join(root, 'key.json'), storage);
    const saved = await store.write('synthetic-unavailable-key');
    expect(saved.ok).toBe(false);
    if (!saved.ok) expect(saved.error.code).toBe('credential_storage_unavailable');
    await expect(readFile(join(root, 'key.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  } finally { Object.defineProperty(process, 'platform', descriptor); }
});
