import { mkdtempSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { packageOwnerFixture, spawnOwnerFixture, removeOwnerFixture } from '../service/owner-fixture.ts';
import { prepareServiceInstallation, readServiceInstallation } from '../../packages/shared/src/service-layout.ts';

const packaged = await packageOwnerFixture(), dataRoot = mkdtempSync(join(tmpdir(), 'flowmate-activation-data-'));
let owner: Awaited<ReturnType<typeof spawnOwnerFixture>> | undefined;
const pipe = '\\\\.\\pipe\\FlowmateActivationFixture-' + randomUUID();
try {
  const prepared = await prepareServiceInstallation({ runtimeRoot: packaged.runtimeRoot, dataRoot }); if (!prepared.ok) throw Error(prepared.error.code);
  const server = createServer(socket => {
    socket.on('error', () => {}); const lines = createInterface({ input: socket });
    lines.on('line', async line => {
      try {
        const command = JSON.parse(line); if (command.type !== 'start') throw Error('fixture_command_invalid');
        if (!owner) {
          const current = await readServiceInstallation({ installationFile: join(dataRoot, 'service-installation.json'), runtimeRoot: packaged.runtimeRoot });
          if (!current.ok) throw Error(current.error.code); owner = await spawnOwnerFixture(current.data);
        }
        process.stdout.write(JSON.stringify({ type: 'fixture_start', pid: owner.child.pid }) + '\n');
        socket.end(JSON.stringify({ version: 1, result: { ok: true, data: { installationId: prepared.data.installationId,
          serviceName: prepared.data.serviceName, action: 'start', wrapperExitCode: 0, observedState: 'not-stopped',
          controllerReleased: null, productReadyVerified: false, productStopVerified: false } } }) + '\n');
      } catch { socket.end(JSON.stringify({ version: 1, result: { ok: false, error: { code: 'fixture_start_failed', category: 'runtime', retryable: false, message: 'The isolated standby owner did not start.' } } }) + '\n'); }
    });
  });
  await new Promise<void>(resolve => server.listen(pipe, resolve));
  const proxy = join(packaged.root, 'manager-proxy.ts');
  writeFileSync(proxy, `import {createConnection} from 'node:net';import{createInterface}from'node:readline';
    if(process.argv.includes('--manual-wait')){process.stdout.write(JSON.stringify({version:1,result:{ok:false,error:{code:'service_elevation_required',category:'runtime',retryable:false,message:'Install and start the prepared service from an elevated console. No elevation was requested.'}}})+'\\n');process.exit(1);}
    const socket=createConnection(${JSON.stringify(pipe)});socket.on('error',()=>{process.exitCode=1;});
    socket.on('connect',()=>socket.write(JSON.stringify({type:'start'})+'\\n'));
    createInterface({input:socket}).once('line',line=>{const value=JSON.parse(line);process.stdout.write(line+'\\n');if(!value.result.ok)process.exitCode=1;socket.end();});
  `);
  process.stdout.write(JSON.stringify({ type: 'ready', installation: prepared.data, proxy }) + '\n');
  const input = createInterface({ input: process.stdin });
  for await (const line of input) if (line === 'close') {
    if (owner) { const closed = await owner.close(); if (!closed || !(closed as { ok: boolean }).ok
      || !(closed as { data: { closed: boolean; stopped: boolean } }).data.closed || !(closed as { data: { stopped: boolean } }).data.stopped) throw Error('fixture_stop_unconfirmed'); await owner.child.exited; owner = undefined; }
    server.close(); input.close(); process.stdin.destroy(); break;
  }
} finally {
  if (owner) { const result = await owner.close(); if (!(result as { ok: boolean }).ok || !(result as { data: { closed: boolean } }).data.closed) throw Error('fixture_stop_unconfirmed'); await owner.child.exited; }
  removeOwnerFixture(dataRoot); removeOwnerFixture(packaged.root);
}
