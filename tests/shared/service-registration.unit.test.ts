import { expect, it } from 'bun:test';

const serviceName = 'FlowmateRuntime460cf30da05e4a2cb31e2e7db6cae0ad';
const binaryPath = 'C:\\Flowmate Old\\resources\\flowmate-runtime\\service\\FlowmateRuntime.exe';
const accountName = 'TESTPC\\original-owner', accountSid = 'S-1-5-21-1000-1001-1002-1003';

// Native bindings stay inside this isolated process; no test can fall through to an actual SCM or account lookup.
const fixture = String.raw`
  import assert from 'node:assert/strict';
  import {win32} from 'node:path';
  import {spyOn} from 'bun:test';
  const request=await new Response(Bun.stdin.stream()).json();let input=request.cases[0],stats;
  Object.defineProperty(process,'platform',{value:'win32',configurable:true});
  Object.defineProperty(process,'arch',{value:'x64',configurable:true});
  const identity=await import(request.identity),slash=String.fromCharCode(92),zero=String.fromCharCode(0),directory='C:'+slash+'Windows'+slash+'System32';
  spyOn(identity,'windowsSystemDirectory').mockImplementation(async()=>{stats.directoryCalls++;if(input.mode==='directory-fails')throw Error('synthetic-private-password');return directory});
  let lastError=0,queryCalls=0,lookupCalls=0;
  const address=0x10000000,ascii=0x20000000n;
  const ptr=value=>{assert.ok(ArrayBuffer.isView(value));return input.mode==='invalid-base'?NaN:address;};
  const bindings={ptr,CString:function(value){assert.equal(BigInt(value),ascii);return{toString(){return input.accountSid}}},
    dlopen(file,definitions){
      stats.libraries.push(file);
      assert.ok(file===win32.join(directory,'kernel32.dll')||file===win32.join(directory,'advapi32.dll'));
      if(file.endsWith('kernel32.dll'))return{symbols:{GetLastError(){return lastError},LocalFree(value){assert.equal(BigInt(value),ascii);stats.freed++;return input.mode==='free-fails'?ascii:0n}},
        close(){stats.closedLibraries.push(file);if(input.mode==='kernel-close-fails')throw Error('synthetic-private-password')}};
      if(input.mode==='security-load-fails')throw Error('synthetic-private-password');
      assert.deepEqual(Object.keys(definitions).sort(),['CloseServiceHandle','ConvertSidToStringSidA','LookupAccountNameW','OpenSCManagerW','OpenServiceW','QueryServiceConfigW'].sort());
      return{symbols:{
        OpenSCManagerW(machine,database,access){assert.equal(machine,null);assert.equal(database,null);assert.equal(access,1);stats.actions.push('manager');if(input.mode==='manager-denied'){lastError=5;return 0n}return 8n},
        OpenServiceW(manager,name,access){assert.equal(BigInt(manager),8n);assert.equal(Buffer.from(name).toString('utf16le'),input.serviceName+zero);assert.equal(access,1);stats.actions.push('open');
          if(['missing','service-denied','deleting'].includes(input.mode)){lastError=input.mode==='missing'?1060:input.mode==='deleting'?1072:5;return 0n}return 9n},
        QueryServiceConfigW(handle,buffer,size,needed){assert.equal(BigInt(handle),9n);stats.actions.push('query');queryCalls++;
          const binary=Buffer.from((input.imagePath??'"'+input.binaryPath+'"')+zero,'utf16le'),account=Buffer.from(input.accountName+zero,'utf16le'),required=64+binary.length+account.length;
          if(buffer===null){assert.equal(size,0);needed[0]=input.mode==='query-small'?32:input.mode==='query-large'?8193:required;lastError=input.mode==='query-denied'?5:122;return input.mode==='query-probe-success'?1:0}
          assert.equal(queryCalls,2);assert.ok(size>=required&&size<=8192);assert.equal(size,buffer.byteLength);
          if(input.mode==='query-grew'){needed[0]=size+8;lastError=122;return 0}if(input.mode==='query-throws')throw Error('synthetic-private-password');
          const bytes=new Uint8Array(buffer.buffer,buffer.byteOffset,buffer.byteLength),view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
          bytes.fill(0);view.setUint32(0,input.mode==='driver'?1:16,true);view.setBigUint64(16,BigInt(address+64),true);view.setBigUint64(48,BigInt(address+64+binary.length),true);
          bytes.set(binary,64);bytes.set(account,64+binary.length);
          if(input.mode==='pointer-before')view.setBigUint64(16,BigInt(address-2),true);
          if(input.mode==='pointer-header')view.setBigUint64(16,BigInt(address+16),true);
          if(input.mode==='pointer-outside')view.setBigUint64(16,BigInt(address+size),true);
          if(input.mode==='pointer-odd')view.setBigUint64(16,BigInt(address+65),true);
          if(input.mode==='unterminated'){view.setBigUint64(16,BigInt(address+size-2),true);bytes.fill(255,size-2)}
          if(input.mode==='null-account')view.setBigUint64(48,0n,true);
          if(input.mode==='empty-account')view.setUint16(64+binary.length,0,true);
          return 1;},
        LookupAccountNameW(system,name,sid,sidLength,domain,domainLength,use){assert.equal(system,null);const expected=input.accountName.toLowerCase()==='localsystem'?'NT AUTHORITY'+slash+'SYSTEM':input.accountName;
          assert.equal(Buffer.from(name).toString('utf16le'),expected+zero);stats.actions.push('lookup');lookupCalls++;
          if(sid===null){assert.equal(sidLength[0],0);assert.equal(domain,null);assert.equal(domainLength[0],0);sidLength[0]=input.mode==='sid-small'?1:input.mode==='sid-large'?69:28;
            domainLength[0]=input.mode==='domain-large'?32769:7;lastError=input.mode==='unmapped'?1332:122;return input.mode==='lookup-probe-success'?1:0}
          assert.equal(lookupCalls,2);assert.ok(sidLength[0]>=28);assert.ok(domainLength[0]>=7);
          if(input.mode==='lookup-grew'){lastError=122;sidLength[0]=64;return 0}
          sidLength[0]=input.mode==='sid-output-large'?100:28;domainLength[0]=input.mode==='domain-output-large'?100:6;use[0]=input.mode==='group'?2:input.accountSid==='S-1-5-18'?5:1;return 1;},
        ConvertSidToStringSidA(sid,text){assert.ok(ArrayBuffer.isView(sid));stats.actions.push('sid');if(input.mode!=='null-sid-text')text[0]=ascii;return input.mode==='sid-convert-fails'?0:1},
        CloseServiceHandle(handle){stats.actions.push('close:'+handle);if(input.mode==='service-close-throws'&&BigInt(handle)===9n)throw Error('synthetic-private-password');return input.mode==='manager-close-fails'&&BigInt(handle)===8n?0:1},
      },close(){stats.closedLibraries.push(file);if(input.mode==='security-close-fails')throw Error('synthetic-private-password')}};
    }};
  const ffi=await import('bun:ffi');
  const loader=spyOn(ffi,'dlopen').mockImplementation(bindings.dlopen),memory=spyOn(ffi,'ptr').mockImplementation(bindings.ptr),strings=spyOn(ffi,'CString').mockImplementation(bindings.CString);
  const bound=await import('bun:ffi');
  assert.equal(bound.dlopen,loader,'Native DLL loading must be intercepted before calling the reader');
  assert.equal(bound.ptr,memory);assert.equal(bound.CString,strings);
  const api=await import(request.module),outputs=[];
  for(const value of request.cases){input=value;stats={directoryCalls:0,libraries:[],closedLibraries:[],actions:[],freed:0};lastError=0;queryCalls=0;lookupCalls=0;
    Object.defineProperty(process,'platform',{value:input.mode==='unsupported'?'linux':'win32',configurable:true});
    assert.equal((await import('bun:ffi')).dlopen,loader);
    const result=await api.readServiceRegistration(input.serviceName);outputs.push({result,stats});}
  process.stdout.write(JSON.stringify(outputs));
`;

type Case = { mode?: string; serviceName?: unknown; binaryPath?: string; imagePath?: string; accountName?: string; accountSid?: string };
type Output = { result: unknown; stats: { directoryCalls: number; libraries: string[]; closedLibraries: string[]; actions: string[]; freed: number } };
async function readCases(cases: Case[]): Promise<Output[]> {
  const child = Bun.spawn([process.execPath, '--no-env-file', '--eval', fixture], { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe', env: {}, timeout: 10_000 });
  child.stdin.write(JSON.stringify({ module: new URL('../../packages/shared/src/service-registration.ts', import.meta.url).href,
    identity: new URL('../../packages/shared/src/windows-identity.ts', import.meta.url).href,
    cases: cases.map(value => ({ serviceName, binaryPath, accountName, accountSid, ...value })) })); child.stdin.end();
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect({ code, stderr }).toEqual({ code: 0, stderr: '' });
  return JSON.parse(stdout) as Output[];
}

it('reads only the exact named SCM registration, resolves its actual account SID and releases every native resource', async () => {
  const [output] = await readCases([{}]); if (!output) throw Error('Missing controlled result.');
  expect(output.result).toEqual({ ok: true, data: { serviceName, binaryPath, accountName, accountSid } });
  expect(output.stats.actions).toEqual(['manager', 'open', 'query', 'query', 'lookup', 'lookup', 'sid', 'close:9', 'close:8']);
  expect(output.stats.freed).toBe(1);
  expect(output.stats.closedLibraries).toEqual([...output.stats.libraries].reverse());
}, 15_000);

it('returns absence only for explicit OpenService 1060 and refuses invalid input before native loading', async () => {
  const cases: Case[] = [{ mode: 'missing' }, { mode: 'service-denied' }, { mode: 'deleting' }, { mode: 'manager-denied' }, { mode: 'unsupported' },
    ...['Spooler', serviceName + ' install', serviceName + '\0', serviceName + '\n', 'FlowmateRuntime', null, 7].map(serviceName => ({ serviceName }))];
  const results = await readCases(cases);
  expect(results[0]!.result).toEqual({ ok: true, data: null });
  expect(results[0]!.stats.actions).toEqual(['manager', 'open', 'close:8']);
  for (const result of results.slice(1)) expect(result.result).toMatchObject({ ok: false });
  for (const result of results.slice(4)) { expect(result.stats.libraries).toEqual([]); expect(result.stats.directoryCalls).toBe(0); }
}, 15_000);

it('rejects unknown buffer, pointer, SID and release facts without leaking raw command arguments or skipping remaining cleanup', async () => {
  const modes = ['directory-fails', 'security-load-fails', 'query-probe-success', 'query-denied', 'query-small', 'query-large', 'query-grew', 'query-throws',
    'driver', 'invalid-base', 'pointer-before', 'pointer-header', 'pointer-outside', 'pointer-odd', 'unterminated', 'null-account', 'empty-account',
    'unmapped', 'lookup-probe-success', 'sid-small', 'sid-large', 'domain-large', 'lookup-grew', 'sid-output-large', 'domain-output-large', 'group',
    'null-sid-text', 'sid-convert-fails', 'free-fails', 'service-close-throws', 'manager-close-fails', 'security-close-fails', 'kernel-close-fails'];
  const cases: Case[] = [...modes.map(mode => ({ mode })), { imagePath: '"' + binaryPath + '" --password=synthetic-private-password' },
    { imagePath: binaryPath }, { imagePath: '".\\FlowmateRuntime.exe"' }, { imagePath: '"C:\\unrelated.exe"' }, { accountSid: 'synthetic-private-password' }];
  const results = await readCases(cases);
  for (const [index, result] of results.entries()) {
    expect(result.result, JSON.stringify(cases[index])).toMatchObject({ ok: false, error: { code: 'service_registration_unavailable' } });
    expect(JSON.stringify(result.result)).not.toContain('synthetic-private-password');
    if (result.stats.actions.includes('open')) expect(result.stats.actions).toContain('close:8');
    if (result.stats.actions.includes('query')) expect(result.stats.actions).toContain('close:9');
    expect(result.stats.closedLibraries).toEqual(modes[index] === 'security-load-fails' ? result.stats.libraries.slice(0, 1) : [...result.stats.libraries].reverse());
  }
}, 15_000);

it('retains Unicode path/account identity and resolves the documented LocalSystem registration alias', async () => {
  const path = 'C:\\Flowmate 中文\\service\\FlowmateRuntime.exe';
  const results = await readCases([{ binaryPath: path, accountName: 'TESTPC\\原账户' }, { accountName: 'LocalSystem', accountSid: 'S-1-5-18' }]);
  expect(results[0]!.result).toEqual({ ok: true, data: { serviceName, binaryPath: path, accountName: 'TESTPC\\原账户', accountSid } });
  expect(results[1]!.result).toEqual({ ok: true, data: { serviceName, binaryPath, accountName: 'LocalSystem', accountSid: 'S-1-5-18' } });
}, 15_000);

it('keeps the shared export loadable in Node and refuses native reading before loading Bun FFI', async () => {
  const node = Bun.which('node'); if (!node) throw Error('The existing Node runtime is unavailable.');
  const child = Bun.spawn([node, '--import', 'tsx', '--input-type=module', '--eval', `
    const api=await import(${JSON.stringify(new URL('../../packages/shared/src/index.ts', import.meta.url).href)});
    const result=await api.readServiceRegistration(${JSON.stringify(serviceName)});
    process.stdout.write(JSON.stringify({available:typeof api.readServiceRegistration==='function',result}));
  `], { stdout: 'pipe', stderr: 'pipe', env: {}, timeout: 10_000 });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect({ code, stderr }).toEqual({ code: 0, stderr: '' });
  expect(JSON.parse(stdout)).toMatchObject({ available: true, result: { ok: false, error: { code: 'service_registration_unavailable' } } });
}, 15_000);
