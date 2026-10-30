import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createInterface } from 'node:readline';
import { ServiceClient } from '../../apps/desktop/main/service-client.ts';
import type { InvoiceFormApplicationReceipt } from '@flowmate/contracts';
import { defaultProductSettings } from '../../packages/core/src/configuration/settings.ts';
import type { ServiceInstallation } from '../../packages/shared/src/service-layout.ts';
import { cleanupResources, deferCleanup, mkdtempSync, waitFor } from '../support/resources.ts';

const at = '2026-10-29T00:00:00.000Z';
const receipt = { operation: 'continueWork', workId: 7, requestId: 'original-continue', revision: 4, receivedAt: at,
  execution: { kind: 'queued', authorizationAccepted: true, attempt: { attemptId: 21, runId: null, runtimeLinked: false }, relation: 'new' } };
const form = { operation: 'query', runId: 1, sessionId: 1, toolCallId: 9, nativeToolCallId: 'call-9',
  documentRef: { id: 1, version: 'original' }, jobId: 1, candidateId: 2, candidateSequence: 1,
  target: { formInstanceId: 'original-form', expectedRevision: 0 } };
type CapturedPacket = { type: string; input?: { limit?: unknown; requestId?: unknown }; receipt?: { observedAt?: unknown } };

async function fixture(mode = 'valid') {
  const root = mkdtempSync(join(tmpdir(), 'flowmate-service-client-'));
  const installationId = randomUUID(), releaseId = randomUUID();
  const installation: ServiceInstallation = { version: 1, installationId, releaseId,
    serviceName: 'FlowmateRuntime' + installationId.replaceAll('-', ''), ownerSid: 'S-1-5-21-100-200-300-1001', runtimeRoot: root, dataRoot: root };
  const pipe = `\\\\.\\pipe\\Flowmate-${installationId}`;
  const entry = join(root, 'owner.mjs'), journal = join(root, 'received.jsonl');
  writeFileSync(journal, '');
  writeFileSync(entry, `
    import {createServer} from 'node:net'; import {createInterface} from 'node:readline';
    import {appendFileSync} from 'node:fs'; import {randomUUID} from 'node:crypto';
    const installation=${JSON.stringify(installation)}, mode=${JSON.stringify(mode)}, journal=${JSON.stringify(journal)};
    const receipt=${JSON.stringify(receipt)}, form=${JSON.stringify(form)}, sockets=new Set(), heldState=[], credentialOperations=new Map(),drainReports=new Map();let activeOperationId=null;
    createInterface({input:process.stdin}).on('line',line=>{if(line==='state')for(const release of heldState.splice(0))release();
      if(line==='stopped')for(const[id,report]of drainReports)drainReports.set(id,{...report,stopped:true,pendingAdmissions:[],pending:[]})});
    const state={version:1,ready:true,host:'ready',appVersion:'0.1.0',userDataPath:installation.dataRoot};
    if(mode==='wrong-root')state.userDataPath=installation.dataRoot+'-other';
    const send=(socket,value)=>{if(!socket.destroyed)socket.write(JSON.stringify(value)+'\\n')};
    const server=createServer(socket=>{
      let connectionId='',drains=0;
      sockets.add(socket); socket.on('error',()=>{}); socket.on('close',()=>sockets.delete(socket));
      const input=createInterface({input:socket}); input.on('line',line=>{
        const command=JSON.parse(line); appendFileSync(journal,JSON.stringify(command)+'\\n');
        if(command.type==='service_connect') {
          let reply={...command,type:'service_ready',connectionId:randomUUID()};
          connectionId=reply.connectionId;
          if(mode==='version')reply.protocolVersion=2;
          if(mode==='data')reply.dataVersion=22;
          if(mode==='release')reply.releaseId=randomUUID();
          if(mode==='installation')reply.installationId=randomUUID();
          if(mode==='extra')reply.nativeHandle='private';
          if(mode==='failure')reply={version:1,type:'service_error',result:{ok:false,error:{code:'PRIVATE_PATH',category:'runtime',retryable:false,message:'PRIVATE_PATH'}}};
          send(socket,reply); return;
        }
        const response=(value,extra={})=>send(socket,{version:1,type:'response',requestId:command.requestId,value,...extra});
        if(['service_prepare_activation','service_query_activation','service_activate'].includes(command.type)){
          if(command.type==='service_activate')activeOperationId=command.input.operationId;
          const data={installationId:installation.installationId,operationId:command.input.operationId,
            ...(command.type==='service_prepare_activation'?{settingsRevision:command.input.expectedSettingsRevision,ready:true}:{active:activeOperationId===command.input.operationId})};
          if(mode==='foreign-activation-installation')data.installationId=randomUUID();
          if(mode==='foreign-activation-operation')data.operationId=randomUUID();
          if(mode==='foreign-activation-revision')data.settingsRevision++;
          if(mode==='extra-activation')data.nativeHandle='forbidden';
          response({ok:true,data});return;
        }
        if(command.type==='service_prepare_disconnect'){
          drains++;const data={connectionId:mode==='foreign-drain'?randomUUID():connectionId,stopped:drains>1,
            pendingAdmissions:[],pending:drains>1?[]:[{kind:'run',runId:1,sessionId:1}],errors:[],...(mode==='extra-drain'?{nativeHandle:'forbidden'}:{})};
          drainReports.set(connectionId,data);if(mode==='lost-drain')setTimeout(()=>response({ok:true,data}),150);else response({ok:true,data});return;
        }
        if(command.type==='service_query_disconnect'){
          const data=drainReports.get(command.input.connectionId);
          response(data?{ok:true,data:mode==='foreign-query'?{...data,connectionId:randomUUID()}:data}
            :{ok:false,error:{code:'service_connection_unknown',category:'runtime',message:'The original connection is unavailable.',retryable:true}});return;
        }
        if(command.type==='service_credentials_status'){response({ok:true,data:{installationId:installation.installationId,settingsRevision:0,models:[]}});return;}
        if(command.type==='service_credentials_prepare'||command.type==='service_settings_save'){
          const input=command.input, saved=command.type==='service_settings_save';
          const data={version:1,installationId:installation.installationId,operationId:input.operationId,kind:saved?'settings':'migration',
            phase:saved?'committed':'prepared',expectedSettingsRevision:saved?input.settings.revision:input.expectedSettingsRevision,
            settingsRevision:saved?input.settings.revision+1:input.expectedSettingsRevision,
            models:saved?[]:input.credentials.map(entry=>({modelId:entry.modelId,credentialRef:entry.credentialRef,state:entry.value===null?'missing':'prepared'})),
            settings:saved?{...input.settings,revision:input.settings.revision+1}:null,error:null};
          if(saved&&input.credentialUpdate){
            const target=data.settings.models.find(model=>model.id===input.credentialUpdate.modelId);
            target.credentialRef='published-credential-reference';
            data.models=[{modelId:target.id,credentialRef:target.credentialRef,state:'published'}];
          }
          if(saved&&mode==='foreign-settings-revision'){data.expectedSettingsRevision+=99;data.settingsRevision+=99;data.settings.revision+=99;}
          if(saved&&mode==='foreign-settings-model')data.models[0].modelId='other-model';
          if(saved&&mode==='foreign-settings-reference')data.models[0].credentialRef='other-credential-reference';
          credentialOperations.set(input.operationId,data);
          if(mode==='foreign-private')data.operationId=randomUUID();
          if(mode==='extra-private')data.nativeHandle='forbidden';
          if(mode==='slow-private'){setTimeout(()=>response({ok:true,data}),150);return;}
          response({ok:true,data});return;
        }
        if(command.type==='service_credentials_commit'){
          const data=credentialOperations.get(command.input.operationId);data.phase='committed';
          data.models=data.models.map(entry=>({...entry,state:entry.state==='missing'?'missing':'published'}));response({ok:true,data});return;
        }
        if(command.type==='service_credentials_query_operation'){response({ok:true,data:credentialOperations.get(command.input.operationId)??null});return;}
        if(command.type==='invoice_form_response')return;
        if(command.requestId==='bad-utf8'){socket.write(Buffer.from([0xc3,0x28,0x0a]));return;}
        if(command.requestId==='truncated'){socket.end('{"version":1');return;}
        if(command.requestId==='overflow'){socket.write('x'.repeat(14*1024*1024+64*1024+1));return;}
        if(command.requestId==='credential'){send(socket,{version:1,type:'credential_request',requestId:'private',operation:'read',credentialRef:'synthetic'});return;}
        if(command.requestId==='form'){send(socket,{version:1,type:'invoice_form_request',requestId:'original-bridge',request:form});response({ok:true,data:state});return;}
        if(command.requestId==='wrong-version'){response({ok:true,data:state},{version:2});return;}
        if(command.requestId==='wrong-root'){response({ok:true,data:{...state,userDataPath:installation.dataRoot+'-other'}});return;}
        if(command.requestId==='drift-root'){send(socket,{version:1,type:'event',event:{type:'host_state',state:{...state,userDataPath:installation.dataRoot+'-other'}}});response({ok:true,data:state});return;}
        if(command.type==='read_document_original'){response({ok:true,data:{documentRef:{id:1,version:'original'},mimeType:'image/png',base64:'a'.repeat(14*1024*1024)}});return;}
        if(command.type==='get_state') {if(mode==='held-state')heldState.push(()=>response({ok:true,data:state}));else response({ok:true,data:state}); return;}
        if(command.type==='query_runtime_events') {
          if(command.requestId==='wake')for(const event of [{type:'runtime_events_available',subscriptionId:'owned',runId:1,sequence:1},
            {type:'runtime_events_available',subscriptionId:'owned',runId:1,sequence:2,nativeHandle:'forbidden'}])send(socket,{version:1,type:'event',event});
          const page={runId:1,sessionId:null,highWatermark:0,availableRange:null,coverage:'none',items:[],nextCursor:{runId:1,lastPersistedSequence:0},hasMore:false,nextAvailableAfterSequence:null};
          response({ok:true,data:page});return;
        }
        if(command.type==='unsubscribe_runtime_events'){response({ok:true});return;}
        let value={ok:true,data:receipt};
        if(command.requestId==='foreign')value={ok:true,data:{...receipt,requestId:'foreign-original'}};
        if(command.requestId==='extra-value')value.extra=true;
        if(command.requestId==='delayed'){setTimeout(()=>response(value),150);return;}
        response(value,command.requestId==='extra-envelope'?{extra:true}:{});
      });
    });
    server.listen(${JSON.stringify(pipe)},()=>process.stdout.write('listening\\n'));
    process.stdin.on('end',()=>{for(const socket of sockets)socket.destroy();server.close()});process.stdin.resume();
  `);
  const node = process.execPath;
  if (!node) throw Error('Node.js is required for the desktop service transport fixture.');
  const child = spawn(node, [entry], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  let stderr = ''; child.stderr.on('data', chunk => { stderr += chunk.toString(); });
  const stdout = createInterface({ input: child.stdout });
  const listening = await Promise.race([once(stdout, 'line'), once(child, 'exit').then(() => { throw Error(stderr || 'owner exited before listening'); })]);
  assert.equal(listening[0], 'listening');
  deferCleanup(async () => {
    if (child.exitCode === null && child.signalCode === null) { const exited = once(child, 'exit'); child.stdin.end(); await exited; }
    stdout.close();
  });
  const client = new ServiceClient(); deferCleanup(() => client.disconnect());
  return { client, installation, child, packets: (): CapturedPacket[] => readFileSync(journal, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) };
}

const continued = { type: 'invoice_work_continue' as const, input: { workId: 7, requestId: 'original-continue', expectedRevision: 3, expectedAttemptId: null } };

if (process.versions.bun) {
  const { it } = await import('bun:test');
  it('P18 ServiceClient runs real named-pipe regressions in the desktop Node runtime', async () => {
    const node = Bun.which('node'); assert.ok(node);
    const child = spawn(node, ['--import', 'tsx', '--test', '--test-reporter=tap', fileURLToPath(import.meta.url)], {
      cwd: fileURLToPath(new URL('../..', import.meta.url)), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', chunk => { output += chunk.toString(); });
    child.stderr.on('data', chunk => { output += chunk.toString(); });
    const [code] = await once(child, 'close'); assert.equal(code, 0, output);
    assert.match(output, /# tests 12/); assert.match(output, /# pass 12/);
  }, 20_000);

  it('P18 Node ServiceClient reconnects the actual safe-pipe ServiceOwner to one original Durable work receipt without model replay', async () => {
    const { packageOwnerFixture, installOwnerFixture, spawnOwnerFixture, removeOwnerFixture, waitOwner } = await import('../service/owner-fixture.ts');
    const { createCredentialStore } = await import('../../packages/shared/src/secure-credential-store.ts');
    const { createServiceSecureStorage } = await import('../../packages/shared/src/service-secure-storage.ts');
    const { defaultProductSettings } = await import('../../packages/core/src/configuration/settings.ts');
    const packaged = await packageOwnerFixture();
    let installation: ServiceInstallation | undefined, owner: Awaited<ReturnType<typeof spawnOwnerFixture>> | undefined;
    let worker: ReturnType<typeof spawn> | undefined, workerClosed: Promise<unknown[]> | undefined;
    let release!: () => void, modelRequests = 0;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
      assert.equal(request.headers.get('authorization'), 'Bearer service-client-synthetic-key');
      await request.json(); modelRequests++; await gate;
      const chunk = { id: 'service-client-local', object: 'chat.completion.chunk', created: 1, model: 'service-client-local-model',
        choices: [{ index: 0, delta: { role: 'assistant', content: 'Review the original invoice evidence before accepting.' }, finish_reason: 'stop' }] };
      return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } });
    } });
    try {
      installation = await installOwnerFixture(packaged.runtimeRoot, false);
      const ref = '291071d2ec4f48bd969cd5e31d634e94', credentialFile = join(installation.dataRoot, 'security/service-credentials', ref + '.json');
      const saved = await createCredentialStore(credentialFile, createServiceSecureStorage(installation.ownerSid))
        .write(JSON.stringify({ type: 'api_key', key: 'service-client-synthetic-key' }));
      assert.equal(saved.ok, true); assert.ok(!readFileSync(credentialFile, 'utf8').includes('service-client-synthetic-key'));
      owner = await spawnOwnerFixture(installation);
      const profile = { id: 'service-client-local', name: 'Service client local', credentialRef: ref, kind: 'custom', providerId: null,
        baseUrl: `http://127.0.0.1:${server.port}/v1`, model: 'service-client-local-model', api: 'openai-completions',
        contextWindow: 64000, maxTokens: 8192, reasoning: false };
      const settings = { ...defaultProductSettings(), models: [profile], defaultModelId: profile.id };
      const entry = join(installation.dataRoot, 'desktop-client.mjs');
      writeFileSync(entry, `
        import assert from 'node:assert/strict'; import {randomUUID} from 'node:crypto'; import {once} from 'node:events';
        import {createInterface} from 'node:readline'; import {readFileSync,writeFileSync} from 'node:fs';
        import {ServiceClient} from ${JSON.stringify(new URL('../../apps/desktop/main/service-client.ts', import.meta.url).href)};
        import * as P from ${JSON.stringify(new URL('../../packages/contracts/src/personal-agent.ts', import.meta.url).href)};
        const installation=JSON.parse(readFileSync(${JSON.stringify(join(installation.dataRoot, 'service-installation.json'))},'utf8'));
        const client=new ServiceClient(), control=createInterface({input:process.stdin});
        const need=result=>{assert.equal(result.ok,true,JSON.stringify(result));return result.data};
        const send=value=>process.stdout.write(JSON.stringify(value)+'\\n');
        try {
          assert.equal((await client.connect({...installation,releaseId:randomUUID()})).ok,false);
          const connected=need(await client.connect(installation)); assert.equal(connected.ready,true); assert.equal(connected.userDataPath,installation.dataRoot);
          need(await client.request({type:'save_settings',settings:${JSON.stringify(settings)}}));
          const original=P.PersonalAgentSnapshotSchema.parse(need(await client.request({type:'personal_agent_get',input:{}})));
          const agent=P.PersonalAgentSnapshotSchema.parse(need(await client.request({type:'personal_agent_update',input:{
            personalAgentId:original.personalAgentId,expectedRevision:original.revision,configuration:{...original.configuration,
              modelId:${JSON.stringify(profile.id)},resources:{prompt:null,enabledSkills:[]},extensions:{enabledExtensions:[]},tools:['read_invoice_document']}}})));
          const sourceText='Controlled ServiceClient invoice total 113.00';
          const document=need(await client.request({type:'import_prepared_invoice_material',input:{
            contract:'flowmate-prepared-invoice/v1',sample:'service-client-controlled',sourceText,
            original:{name:'source.md',base64:Buffer.from(sourceText).toString('base64')},
            pages:[{page:1,blocks:[{id:'b1',kind:'text',text:sourceText,sourceIndex:0,sourceType:'prepared-text',bbox:null}]}]}}));
          const input={personalAgentId:agent.personalAgentId,expectedAgentRevision:agent.revision,requestId:'client-original-create',
            goal:'Organize the original controlled invoice.',documents:[document.documentRef]};
          const created=P.InvoiceWorkCreateReceiptSchema.parse(need(await client.request({type:'invoice_work_create',input})));
          const activation={installationId:installation.installationId,operationId:randomUUID()}, currentSettings=need(await client.request({type:'get_state'})).settings;
          const pending={...installation,activationOperationId:activation.operationId,activationSettingsRevision:currentSettings.revision};
          writeFileSync(${JSON.stringify(join(installation.dataRoot, 'service-installation.json'))},JSON.stringify(pending));
          need(await client.prepareCredentialMigration({...activation,expectedSettingsRevision:currentSettings.revision,
            credentials:[{modelId:${JSON.stringify(profile.id)},credentialRef:${JSON.stringify(ref)},value:'service-client-synthetic-key'}]}));
          need(await client.commitCredentialMigration(activation));
          assert.deepEqual(need(await client.queryActivation(activation)),{...activation,active:false});
          assert.deepEqual(need(await client.prepareActivation({...activation,expectedSettingsRevision:currentSettings.revision})),
            {...activation,settingsRevision:currentSettings.revision,ready:true});
          assert.deepEqual(need(await client.queryActivation(activation)),{...activation,active:false});
          const activationPermit=once(control,'line');send({type:'activation-prepared',workId:created.workId});
          const[permission]=await activationPermit;assert.equal(permission,'activate');
          writeFileSync(${JSON.stringify(join(installation.dataRoot, 'service-installation.json'))},JSON.stringify({...pending,enabled:true}));
          assert.deepEqual(need(await client.activateService(activation)),{...activation,active:true});
          assert.deepEqual(need(await client.queryActivation(activation)),{...activation,active:true});
          const proceed=once(control,'line');
          send({type:'created',workId:created.workId,attemptId:created.execution.attempt?.attemptId});
          const [action]=await proceed; assert.equal(action,'disconnect');
          const epoch=client.connectionEpoch; client.disconnect(); assert.equal(client.state,null); assert.ok(client.connectionEpoch>epoch);
          need(await client.connect(installation));
          const query={type:'invoice_work_query_operation',input:{operation:'create',personalAgentId:agent.personalAgentId,requestId:input.requestId}};
          assert.deepEqual(need(await client.request(query)),created);
          const work=P.InvoiceWorkGetResultSchema.parse(need(await client.request({type:'invoice_work_get',input:{view:'work',workId:created.workId,limit:10}})));
          assert.equal(work.work.workId,created.workId); assert.equal(work.work.status,'open');
          send({type:'reconnected',workId:created.workId});
          let tasks;
          const deadline=Date.now()+15000;
          do {
            tasks=P.PersonalTaskListResultSchema.parse(need(await client.request({type:'personal_task_list',input:{workId:created.workId,limit:10}})));
            if(tasks.items.some(task=>task.attempt.attemptId===created.execution.attempt?.attemptId&&task.runStatus==='completed'&&task.stoppedAt!==null))break;
            await new Promise(resolve=>setTimeout(resolve,30));
          }while(Date.now()<deadline);
          assert.equal(tasks.items.length,1); assert.equal(tasks.items[0].attempt.attemptId,created.execution.attempt.attemptId);
          assert.equal(tasks.items[0].runStatus,'completed'); assert.notEqual(tasks.items[0].stoppedAt,null);
          assert.deepEqual(need(await client.request(query)),created);
          const current=need(await client.request({type:'get_state'})), credentialStatus=need(await client.getCredentialStatus());
          assert.equal(credentialStatus.settingsRevision,current.settings.revision);assert.equal(credentialStatus.models[0].status,'configured');
          const keyOperation={installationId:installation.installationId,operationId:randomUUID(),settings:current.settings,
            credentialUpdate:{modelId:${JSON.stringify(profile.id)},apiKey:'synthetic-node-replacement-key'}};
          const saved=need(await client.saveServiceSettings(keyOperation));assert.equal(saved.phase,'committed');
          assert.equal(saved.settings.revision,current.settings.revision+1);assert.notEqual(saved.settings.models[0].credentialRef,current.settings.models[0].credentialRef);
          const later=need(await client.saveServiceSettings({installationId:installation.installationId,operationId:randomUUID(),
            settings:{...saved.settings,profile:{...saved.settings.profile,displayName:'Later profile'}}}));
          assert.equal(later.settings.revision,saved.settings.revision+1);
          assert.deepEqual(need(await client.queryCredentialOperation({installationId:installation.installationId,operationId:keyOperation.operationId})),saved);
          assert.deepEqual(need(await client.queryActivation(activation)),{...activation,active:true});
          assert.deepEqual(need(await client.activateService(activation)),{...activation,active:true});
          const drain=need(await client.prepareDisconnect());assert.equal(drain.connectionId,client.serverConnectionId);assert.equal(drain.stopped,true);
          assert.equal(client.isConnected,true);assert.deepEqual(need(await client.request(query)),created);
          send({type:'complete',workId:created.workId,attemptId:created.execution.attempt.attemptId,requestId:input.requestId});
        }finally{client.disconnect();control.close();process.stdin.destroy()}
      `);
      const node = Bun.which('node'); assert.ok(node);
      worker = spawn(node, ['--import', 'tsx', entry], { cwd: fileURLToPath(new URL('../..', import.meta.url)), windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'] });
      workerClosed = once(worker, 'close');
      const messages: Array<{ type: string; workId?: number; attemptId?: number; requestId?: string }> = [];
      let stderr = '';
      worker.stderr!.on('data', chunk => { stderr += chunk.toString(); });
      const output = createInterface({ input: worker.stdout! }); output.on('line', line => { messages.push(JSON.parse(line)); });
      await waitOwner(() => messages.some(message => message.type === 'activation-prepared') || worker!.exitCode !== null, () => stderr);
      assert.equal(worker.exitCode, null, stderr); assert.equal(modelRequests, 0);
      worker.stdin!.write('activate\n');
      await waitOwner(() => modelRequests === 1 && messages.some(message => message.type === 'created') || worker!.exitCode !== null, () => stderr);
      assert.equal(worker.exitCode, null, stderr); assert.equal(modelRequests, 1);
      worker.stdin!.write('disconnect\n');
      await waitOwner(() => messages.some(message => message.type === 'reconnected') || worker!.exitCode !== null, () => stderr);
      assert.equal(worker.exitCode, null, stderr); assert.equal(owner.child.exitCode, null); assert.equal(modelRequests, 1);
      release(); const [code] = await workerClosed; assert.equal(code, 0, stderr);
      const complete = messages.find(message => message.type === 'complete'), created = messages.find(message => message.type === 'created');
      assert.ok(complete); assert.equal(complete.workId, created?.workId); assert.equal(complete.attemptId, created?.attemptId);
      assert.equal(complete.requestId, 'client-original-create'); assert.equal(modelRequests, 1);
      assert.equal(owner.child.exitCode, null); assert.ok(!owner.stderr().includes('service-client-synthetic-key'));
      output.close();
    } finally {
      release();
      if (worker && worker.exitCode === null && worker.signalCode === null) { worker.kill(); await workerClosed; }
      if (owner && owner.child.exitCode === null) {
        assert.deepEqual(await owner.close(), { ok: true, data: { stopped: true, closed: true, errors: [] } });
        assert.equal(await owner.child.exited, 0);
      }
      server.stop(true);
      if (installation) removeOwnerFixture(installation.dataRoot);
      removeOwnerFixture(packaged.root);
    }
  }, 90_000);
} else {
  const { it, afterEach } = await import('node:test');
  afterEach(cleanupResources);

  it('handshakes before actual Host state and disconnects without stopping the owner', async () => {
    const f = await fixture(), connected = await f.client.connect(f.installation);
    assert.equal(connected.ok, true); assert.equal(f.client.state?.ready, true); assert.equal(f.client.state?.host, 'ready');
    assert.deepEqual(f.packets().slice(0, 2).map(packet => packet.type), ['service_connect', 'get_state']);
    assert.deepEqual(f.packets()[0], { version: 1, type: 'service_connect', installationId: f.installation.installationId,
      releaseId: f.installation.releaseId, protocolVersion: 1, dataVersion: 21 });
    assert.deepEqual(await f.client.request(continued), { ok: true, data: receipt });
    const epoch = f.client.connectionEpoch;
    f.client.disconnect();
    assert.equal(f.client.isConnected, false); assert.equal(f.client.state, null); assert.ok(f.client.connectionEpoch > epoch);
    assert.equal((await f.client.connect(f.installation)).ok, true);
    assert.deepEqual(await f.client.request({ type: 'invoice_work_query_operation', input: {
      operation: 'continueWork', workId: 7, requestId: 'original-continue' } }), { ok: true, data: receipt });
    assert.equal(f.packets().some(packet => packet.type === 'close'), false); assert.equal(f.child.exitCode, null);
  });

  it('rejects foreign versions, release, installation, extra fields and unsafe handshake failures before get_state', async () => {
    for (const mode of ['version', 'data', 'release', 'installation', 'extra', 'failure']) {
      const f = await fixture(mode), result = await f.client.connect(f.installation, 1000);
      assert.equal(result.ok, false); assert.ok(!JSON.stringify(result).includes('PRIVATE_PATH'));
      assert.deepEqual(f.packets().map(packet => packet.type), ['service_connect']);
      assert.equal(f.client.isConnected, false); assert.equal(f.client.state, null);
    }
  });

  it('binds every Host state to the captured canonical installation data root before allowing writes', async () => {
    const wrong = await fixture('wrong-root');
    assert.equal((await wrong.client.connect(wrong.installation)).ok, false);
    assert.equal(wrong.client.state, null); assert.equal(wrong.client.isConnected, false);
    assert.deepEqual(wrong.packets().map(packet => packet.type), ['service_connect', 'get_state']);
    const valid = await fixture('held-state'), options = { ...valid.installation }, expectedRoot = options.dataRoot;
    const connecting = valid.client.connect(options);
    options.dataRoot += '-mutated-after-connect';
    await waitFor(async () => valid.packets().some(packet => packet.type === 'get_state'));
    assert.equal(valid.client.isConnected, false);
    await assert.rejects(valid.client.request({ type: 'save_settings', settings: {} }), /host_not_writable/);
    valid.child.stdin.write('state\n');
    assert.equal((await connecting).ok, true); assert.equal(valid.client.state?.userDataPath, expectedRoot);
    assert.equal(valid.packets().some(packet => packet.type === 'save_settings'), false);
    for (const requestId of ['wrong-root', 'drift-root']) {
      const f = await fixture(); assert.equal((await f.client.connect(f.installation)).ok, true);
      await assert.rejects(f.client.request({ type: 'get_state', requestId }), /host_protocol_invalid/);
      assert.equal(f.client.state, null); assert.equal(f.client.isConnected, false);
    }
    const invalid = await fixture();
    assert.equal((await invalid.client.connect({ ...invalid.installation, dataRoot: invalid.installation.dataRoot + '\\.' })).ok, false);
    assert.deepEqual(invalid.packets(), []);
  });

  it('keeps a drain with unconfirmed foreground open and validates its original connection before an explicit disconnect', async () => {
    const f = await fixture(); assert.equal((await f.client.connect(f.installation)).ok, true);
    const pending = await f.client.prepareDisconnect(); assert.equal(pending.ok, true);
    if (!pending.ok) throw Error('drain_missing');
    assert.equal(pending.data.stopped, false); assert.deepEqual(pending.data.pending, [{ kind: 'run', runId: 1, sessionId: 1 }]);
    assert.equal(f.client.isConnected, true);
    const stopped = await f.client.prepareDisconnect(); assert.equal(stopped.ok, true);
    if (!stopped.ok) throw Error('drain_missing');
    assert.equal(stopped.data.stopped, true); assert.equal(f.client.isConnected, true);
    await f.client.request({ type: 'get_state' });
    for (const mode of ['foreign-drain', 'extra-drain']) {
      const other = await fixture(mode); assert.equal((await other.client.connect(other.installation)).ok, true);
      assert.equal((await other.client.prepareDisconnect()).ok, false); assert.equal(other.client.isConnected, true);
    }
  });

  it('queries only the original unconfirmed connection after a lost drain response and reconnect', async () => {
    const f = await fixture('lost-drain'); assert.equal((await f.client.connect(f.installation)).ok, true);
    const originalId = f.client.serverConnectionId; assert.ok(originalId);
    assert.equal((await f.client.prepareDisconnect(30)).ok, false);
    f.client.disconnect(); assert.equal(f.client.serverConnectionId, null); assert.equal(f.client.lastServerConnectionId, originalId);
    assert.equal((await f.client.connect(f.installation)).ok, true); assert.notEqual(f.client.serverConnectionId, originalId);
    assert.equal(f.client.lastServerConnectionId, originalId);
    const original = await f.client.queryDisconnect(originalId); assert.equal(original.ok, true);
    if (!original.ok) throw Error('original_scope_missing');
    assert.equal(original.data.connectionId, originalId); assert.equal(original.data.stopped, false);
    await f.client.prepareDisconnect(); const replacement = await f.client.prepareDisconnect();
    assert.equal(replacement.ok, true); if (!replacement.ok) throw Error('replacement_scope_missing'); assert.equal(replacement.data.stopped, true);
    const stillOriginal = await f.client.queryDisconnect(originalId); assert.equal(stillOriginal.ok, true);
    if (!stillOriginal.ok) throw Error('original_scope_missing'); assert.equal(stillOriginal.data.stopped, false);
    f.child.stdin.write('stopped\n');
    let stopped = false;
    await waitFor(async () => { const result = await f.client.queryDisconnect(originalId); stopped = result.ok && result.data.stopped; return stopped; });
    assert.equal(stopped, true);
    assert.equal((await f.client.queryDisconnect(randomUUID())).ok, false);
    assert.equal(f.packets().filter(packet => packet.type === 'service_prepare_disconnect').length, 3);
  });

  it('binds private credential receipts to their original installation, operation and model without retrying unknown writes', async () => {
    const f = await fixture(); assert.equal((await f.client.connect(f.installation)).ok, true);
    const request = { installationId: f.installation.installationId, operationId: randomUUID(), expectedSettingsRevision: 0,
      credentials: [{ modelId: 'current-model', credentialRef: 'original-credential-reference', value: 'synthetic-private-key' }] };
    const key = { installationId: request.installationId, operationId: request.operationId };
    const status = await f.client.getCredentialStatus(); assert.equal(status.ok, true);
    const prepared = await f.client.prepareCredentialMigration(request); assert.equal(prepared.ok, true);
    const committed = await f.client.commitCredentialMigration(key); assert.equal(committed.ok, true);
    assert.deepEqual(await f.client.queryCredentialOperation(key), committed);
    const saved = await f.client.saveServiceSettings({ ...key, operationId: randomUUID(), settings: defaultProductSettings(at) });
    assert.equal(saved.ok, true);
    const settings = { ...defaultProductSettings(at), models: [{ id: 'current-model', name: 'Current model',
      credentialRef: 'original-credential-reference', kind: 'custom' as const, providerId: null,
      baseUrl: 'http://127.0.0.1:1/v1', model: 'current-model', api: 'openai-completions',
      contextWindow: 64000, maxTokens: 8192, reasoning: false }], defaultModelId: 'current-model' };
    const update = { modelId: 'current-model', apiKey: 'synthetic-updated-private-key' };
    assert.equal((await f.client.saveServiceSettings({ ...key, operationId: randomUUID(), settings, credentialUpdate: update })).ok, true);
    const mismatches: boolean[] = [];
    for (const mode of ['foreign-settings-revision', 'foreign-settings-model', 'foreign-settings-reference']) {
      const other = await fixture(mode); assert.equal((await other.client.connect(other.installation)).ok, true);
      const result = await other.client.saveServiceSettings({ installationId: other.installation.installationId,
        operationId: randomUUID(), settings, credentialUpdate: update });
      mismatches.push(result.ok);
      if (!result.ok) assert.equal(result.error.code, 'host_protocol_invalid');
      assert.equal(other.packets().filter(packet => packet.type === 'service_settings_save').length, 1);
    }
    assert.deepEqual(mismatches, [false, false, false]);
    const before = f.packets().length;
    assert.equal((await f.client.prepareCredentialMigration({ ...request, installationId: randomUUID() })).ok, false);
    assert.equal(f.packets().length, before);
    for (const mode of ['foreign-private', 'extra-private']) {
      const other = await fixture(mode); assert.equal((await other.client.connect(other.installation)).ok, true);
      assert.equal((await other.client.prepareCredentialMigration({ ...request, installationId: other.installation.installationId })).ok, false);
    }
    const slow = await fixture('slow-private'); assert.equal((await slow.client.connect(slow.installation)).ok, true);
    const original = { ...request, installationId: slow.installation.installationId };
    const unknown = await slow.client.prepareCredentialMigration(original, 30);
    assert.equal(unknown.ok, false); if (unknown.ok) throw Error('unknown_expected');
    assert.equal(unknown.error.code, 'operation_result_unknown');
    const found = await slow.client.queryCredentialOperation({ installationId: original.installationId, operationId: original.operationId });
    assert.equal(found.ok, true); if (!found.ok) throw Error('receipt_missing');
    assert.equal(found.data?.operationId, original.operationId);
    assert.equal(slow.packets().filter(packet => packet.type === 'service_credentials_prepare').length, 1);
    const submittedSettings = defaultProductSettings(at);
    const pendingSave = slow.client.saveServiceSettings({ installationId: slow.installation.installationId,
      operationId: randomUUID(), settings: submittedSettings });
    submittedSettings.revision = 99;
    const originalSave = await pendingSave;
    assert.equal(originalSave.ok, true);
    if (!originalSave.ok) throw Error('original_settings_receipt_missing');
    assert.equal(originalSave.data.expectedSettingsRevision, 0);
  });

  it('prepares and queries only the original activation facts with strict operation and revision binding', async () => {
    const f = await fixture(); assert.equal((await f.client.connect(f.installation)).ok, true);
    const input = { installationId: f.installation.installationId, operationId: randomUUID(), expectedSettingsRevision: 4 };
    assert.deepEqual(await f.client.prepareActivation(input), { ok: true, data: { installationId: input.installationId,
      operationId: input.operationId, settingsRevision: 4, ready: true } });
    const key = { installationId: input.installationId, operationId: input.operationId };
    assert.deepEqual(await f.client.queryActivation(key), { ok: true, data: { ...key, active: false } });
    assert.deepEqual(await f.client.activateService(key), { ok: true, data: { ...key, active: true } });
    assert.deepEqual(await f.client.queryActivation(key), { ok: true, data: { ...key, active: true } });
    assert.deepEqual(f.packets().slice(2).map(packet => packet.type), ['service_prepare_activation', 'service_query_activation',
      'service_activate', 'service_query_activation']);
    const before = f.packets().length;
    assert.equal((await f.client.prepareActivation({ ...input, installationId: randomUUID() })).ok, false);
    assert.equal(f.packets().length, before);
    for (const mode of ['foreign-activation-installation', 'foreign-activation-operation', 'foreign-activation-revision', 'extra-activation']) {
      const other = await fixture(mode); assert.equal((await other.client.connect(other.installation)).ok, true);
      assert.equal((await other.client.prepareActivation({ ...input, installationId: other.installation.installationId })).ok, false);
    }
  });

  it('reuses strict result ownership checks and normalizes requests before sending', async () => {
    const f = await fixture(); assert.equal((await f.client.connect(f.installation)).ok, true);
    for (const requestId of ['foreign', 'extra-value', 'extra-envelope'])
      await assert.rejects(f.client.request({ ...continued, requestId }), /host_protocol_invalid/);
    const page = await Reflect.apply(f.client.request, f.client, [{ type: 'query_runtime_events', ownerToken: 'renderer-owner', input: {
      runId: 1, sessionId: null, cursor: { runId: 1, lastPersistedSequence: 0 } } }]);
    assert.equal(page.ok, true); assert.equal(f.packets().at(-1)?.input?.limit, 50);
    const wakes: unknown[] = [];
    const unsubscribe = f.client.subscribe(() => { throw Error('subscriber failure'); });
    f.client.subscribe(event => wakes.push(event));
    await f.client.request({ type: 'query_runtime_events', requestId: 'wake', ownerToken: 'renderer-owner',
      input: { runId: 1, sessionId: null, cursor: { runId: 1, lastPersistedSequence: 0 }, limit: 10 } });
    unsubscribe();
    assert.deepEqual(wakes, [{ type: 'runtime_events_available', subscriptionId: 'owned', runId: 1, sequence: 1 }]);
    await assert.rejects(Reflect.apply(f.client.request, f.client, [{ ...continued, input: { ...continued.input, nativeHandle: 'forged' } }]), /host_protocol_invalid/);
    await assert.rejects(Reflect.apply(f.client.request, f.client, [{ type: 'close' }]), /service_command_forbidden/);
    await assert.rejects(Reflect.apply(f.client.request, f.client, [{ type: 'credential_response', value: { ok: false } }]), /service_command_forbidden/);
    await assert.rejects(f.client.request({ type: 'save_settings', settings: { value: 'x'.repeat(1_100_000) } }), /host_protocol_invalid/);
    assert.equal(f.packets().filter(packet => packet.type === 'invoice_work_continue').length, 3);
  });

  it('rejects invalid UTF-8, overflowing frames, credential routing and wrong transport versions', async () => {
    for (const requestId of ['bad-utf8', 'truncated', 'overflow', 'credential', 'wrong-version']) {
      const f = await fixture(); assert.equal((await f.client.connect(f.installation)).ok, true);
      await assert.rejects(f.client.request({ type: 'get_state', requestId }, 2000), /host_protocol_invalid/);
      assert.equal(f.client.isConnected, false);
      assert.equal(f.packets().some(packet => packet.type === 'credential_response'), false);
    }
  });

  it('retains original business IDs after unknown writes and binds subscription cleanup to the original socket', async () => {
    const f = await fixture(); assert.equal((await f.client.connect(f.installation)).ok, true);
    const cleanup = f.client.captureRuntimeSubscriptionCleanup('old-owner', 'old-subscription');
    await assert.rejects(f.client.request({ ...continued, requestId: 'delayed' }, 30), /host_request_timeout/);
    await new Promise(resolve => setTimeout(resolve, 200));
    assert.deepEqual(await f.client.request(continued), { ok: true, data: receipt });
    cleanup();
    await waitFor(async () => f.packets().some(packet => packet.type === 'unsubscribe_runtime_events'));
    f.client.disconnect(); assert.equal((await f.client.connect(f.installation)).ok, true);
    cleanup(); await f.client.request({ type: 'get_state' });
    assert.equal(f.packets().filter(packet => packet.type === 'unsubscribe_runtime_events').length, 1);
    assert.deepEqual(f.packets().filter(packet => packet.type === 'invoice_work_continue').map(packet => packet.input?.requestId),
      ['original-continue', 'original-continue']);
  });

  it('never applies a late original form receipt to a replacement connection', async () => {
    const f = await fixture(); let resolveReceipt!: (value: InvoiceFormApplicationReceipt) => void;
    f.client.setInvoiceFormHandler(() => new Promise(resolve => { resolveReceipt = resolve; }));
    assert.equal((await f.client.connect(f.installation)).ok, true);
    await f.client.request({ type: 'get_state', requestId: 'form' });
    await waitFor(async () => typeof resolveReceipt === 'function');
    f.client.disconnect(); assert.equal((await f.client.connect(f.installation)).ok, true);
    resolveReceipt({ runId: 1, toolCallId: 9, formInstanceId: 'original-form', candidateId: 2, candidateSequence: 1, observedAt: at, outcome: 'unknown' });
    await f.client.request({ type: 'get_state' });
    assert.equal(f.packets().some(packet => packet.type === 'invoice_form_response'), false);
    f.client.setInvoiceFormHandler(async () => ({ runId: 1, toolCallId: 9, formInstanceId: 'original-form', candidateId: 999,
      candidateSequence: 1, observedAt: at, outcome: 'applied', appliedRevision: 1, appliedAt: at }));
    await f.client.request({ type: 'get_state', requestId: 'form' });
    await waitFor(async () => f.packets().some(packet => packet.type === 'invoice_form_response'));
    assert.deepEqual(f.packets().find(packet => packet.type === 'invoice_form_response'), { version: 1, type: 'invoice_form_response',
      requestId: 'original-bridge', receipt: { runId: 1, toolCallId: 9, formInstanceId: 'original-form', candidateId: 2,
        candidateSequence: 1, observedAt: f.packets().find(packet => packet.type === 'invoice_form_response')?.receipt?.observedAt, outcome: 'unknown' } });
  });

  it('accepts existing 14 MiB invoice originals within the bounded service reply envelope', async () => {
    const f = await fixture(); assert.equal((await f.client.connect(f.installation)).ok, true);
    const result = await f.client.request({ type: 'read_document_original', documentId: 1, page: 1 }) as {
      ok: true; data: { documentRef: { id: number; version: string }; mimeType: string; base64: string } };
    assert.equal(result.ok, true); assert.equal(result.data.base64.length, 14 * 1024 * 1024);
    assert.deepEqual(result.data.documentRef, { id: 1, version: 'original' });
  });
}
