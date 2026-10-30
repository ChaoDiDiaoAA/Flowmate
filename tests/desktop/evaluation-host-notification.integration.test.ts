import { expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { HostClient } from '../../apps/desktop/main/host-client.ts';
import { mkdtempSync } from '../support/resources.ts';

test('Host capture notifications require a valid identity and explicit workspace and never leak into renderer events', async () => {
  const root = mkdtempSync(join(tmpdir(), 'evaluation-capture-notification-'));
  mkdirSync(join(root, 'apps/host'), { recursive: true });
  writeFileSync(join(root, 'apps/host/main.ts'), `
    import { createInterface } from 'node:readline';
    import { createWriteStream } from 'node:fs';
    const output = createWriteStream('', {fd:1,autoClose:false});
    const send = value => output.write(JSON.stringify(value)+'\\n');
    send({version:1,type:'ready',state:{version:1,ready:true,host:'ready',userDataPath:'synthetic'}});
    createInterface({input:process.stdin}).on('line', line => {
      const command=JSON.parse(line);
      if(command.type==='close') { output.write(JSON.stringify({version:1,type:'response',requestId:command.requestId,
        value:{ok:true,data:{closed:true,stopped:true,errors:[]}}})+'\\n',()=>process.exit(0)); return; }
      for(const trace of [
        {traceId:'invalid',workspaceRoot:${JSON.stringify(root)}},
        {traceId:'00000000-0000-4000-8000-000000000001',workspaceRoot:'relative'},
        {traceId:'00000000-0000-4000-8000-000000000001',workspaceRoot:${JSON.stringify(root)}}
      ]) send({version:1,type:'evaluation_trace_available',...trace});
      send({version:1,type:'response',requestId:command.requestId,value:{args:process.argv.slice(2)}});
    });
  `);
  const client = new HostClient(), captured: unknown[] = [], events: unknown[] = [];
  try {
    expect(Reflect.get(client, 'setEvaluationTraceHandler')).toBeFunction();
    client.setEvaluationTraceHandler(value => { captured.push(value); }); client.subscribe(value => events.push(value));
    expect(await client.start(root, '0.1.0', root, join(root, 'data'), undefined, root)).toMatchObject({ ok: true });
    expect(await client.request({ type: 'get_state' })).toEqual({ args: ['--user-data-root', root,
      '--invoice-source-root', join(root, 'data'), '--evaluation-workspace-root', root] });
    expect(captured).toEqual([{ traceId: '00000000-0000-4000-8000-000000000001', workspaceRoot: root }]);
    expect(events).toEqual([]);
  } finally { await client.close(); }
});
