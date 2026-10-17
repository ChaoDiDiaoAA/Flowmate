import { expect, test, spyOn } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { once } from 'node:events';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { HostClient } from '../../apps/desktop/main/host-client.ts';
import { registerSecrets } from '../../agent-eval/src/execution/evidence-safety.ts';
import { mkdtempSync, waitFor } from '../support/resources.ts';

test('retains only bounded current-child diagnostic codes across UTF-8, secret and old-process chunks', async () => {
  const root = mkdtempSync(join(tmpdir(), 'flowmate-stderr-'));
  mkdirSync(join(root, 'apps/host'), { recursive: true });
  writeFileSync(join(root, 'apps/host/main.ts'), `
    import {createInterface} from 'node:readline';
    process.stdout.write(JSON.stringify({version:1,type:'ready',state:{version:1,ready:true,host:'ready',userDataPath:'synthetic'}})+'\\n');
    const reader=createInterface({input:process.stdin});
    reader.on('line',async line=>{const command=JSON.parse(line);
      const unicode=Buffer.from('未知 SDK PRIVATE-BODY\\n');process.stderr.write(unicode.subarray(0,2));process.stderr.write(unicode.subarray(2));
      process.stderr.write('[Flowmate] runtime_');process.stderr.write('lock_failed\\n');
      process.stderr.write('x'.repeat(20000)+'[Flowmate] host_exited\\n');
      process.stderr.write('[Flowmate] installation_runtime_invalid\\n'.repeat(1024));
      await new Promise(done=>process.stderr.write('[Flowmate] maintenance_restore_failed\\n',done));
      process.stdout.write(JSON.stringify({version:1,type:'response',requestId:command.requestId,value:{ok:true}})+'\\n');
    });reader.on('close',()=>process.exit(0));
  `);
  registerSecrets(['runtime_lock_failed']);
  const client = new HostClient(), output: string[] = [];
  const stderr = spyOn(process.stderr, 'write').mockImplementation((value: string | Uint8Array) => { output.push(String(value)); return true; });
  let child: ChildProcessWithoutNullStreams | null = null, replacement: ChildProcessWithoutNullStreams | null = null;
  try {
    expect(await client.start(root, '0.1.0', root)).toMatchObject({ ok: true });
    child = Reflect.get(client, 'child'); if (!child) throw Error('Owned child missing');
    await client.request({ type: 'get_state' });
    await waitFor(async () => client.diagnosticsStderr.tail.endsWith('[Flowmate] maintenance_restore_failed\n'));
    const snapshot = client.diagnosticsStderr;
    expect(Buffer.byteLength(snapshot.tail)).toBeLessThanOrEqual(16384); expect(snapshot.truncated).toBe(true);
    expect(snapshot.tail).not.toContain('runtime_lock_failed'); expect(snapshot.tail).not.toContain('PRIVATE-BODY');
    expect(output.join('')).not.toContain('PRIVATE-BODY');
    const packets: Buffer[] = [], emit = child.stderr.emit;
    child.stderr.emit = function(event: string | symbol, ...args: unknown[]) {
      if (event === 'data' && Buffer.isBuffer(args[0])) { packets.push(Buffer.from(args[0])); return true; }
      return Reflect.apply(emit, this, [event, ...args]);
    };
    await client.request({ type: 'get_state' });
    const exited = once(child, 'exit'); child.stdin.end(); await exited;
    expect(await client.start(root, '0.1.0', root)).toMatchObject({ ok: true });
    replacement = Reflect.get(client, 'child');
    for (const packet of packets) Reflect.apply(emit, child.stderr, ['data', packet]);
    expect(client.diagnosticsStderr).toEqual({ tail: '', truncated: false });
  } finally {
    stderr.mockRestore();
    for (const processChild of [child, replacement]) if (processChild && processChild.exitCode === null && processChild.signalCode === null) {
      const exited = once(processChild, 'exit'); processChild.stdin.end(); await exited;
    }
  }
}, 15_000);
