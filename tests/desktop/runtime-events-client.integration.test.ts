import { expect, it } from 'bun:test';
import { once } from 'node:events';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp } from '../support/resources.ts';
import { HostClient } from '../../apps/desktop/main/host-client.ts';

const publicInput = { runId: 1, sessionId: null, cursor: { runId: 1, lastPersistedSequence: 0 } };
const request = (client: HostClient, command: unknown, timeout?: number): Promise<unknown> => Reflect.apply(client.request, client, [command, timeout]);
async function prepareProtocolFixture(body: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'flowmate-p6-wire-'));
  mkdirSync(join(root, 'apps', 'host'), { recursive: true });
  writeFileSync(join(root, 'apps', 'host', 'main.ts'), [
    "import {createInterface} from 'node:readline'; import {appendFileSync,createWriteStream} from 'node:fs'; const stdout=createWriteStream('',{fd:1,autoClose:false});",
    `const journal=${JSON.stringify(join(root, 'journal.jsonl'))};`,
    "const context={runId:1,sessionId:null,highWatermark:0,availableRange:null,coverage:'none'};",
    "const page={...context,items:[],nextCursor:{runId:1,lastPersistedSequence:0},hasMore:false,nextAvailableAfterSequence:null};",
    "const tool={toolCallId:9,runId:1,sessionId:1,toolName:'safe',status:'requested',requestedAt:'2026-10-03T00:00:00.000Z',startedAt:null,endedAt:null,stoppedAt:null,committedCandidateId:null,errorCode:null,stopped:null,deliveryState:'not_attempted',formApplicationOutcome:null,context:null};",
    "const response=(command,value)=>{ appendFileSync(journal,JSON.stringify({trace:'response',type:command.type,runId:command.input?.runId})+'\\n'); return stdout.write(JSON.stringify({version:1,type:'response',requestId:command.requestId,value})+'\\n'); };",
    "stdout.write(JSON.stringify({version:1,type:'ready',state:{version:1,ready:true,host:'ready',userDataPath:'synthetic'}})+'\\n');",
    `const input=createInterface({input:process.stdin}); input.on('line',line=>{const command=JSON.parse(line); ${body} });`,
    "input.on('close',()=>process.exit(0));",
  ].join('\n'));
  return root;
}
async function protocolFixture(body: string) {
  const root = await prepareProtocolFixture(body);
  const client = new HostClient();
  expect(await client.start(root, '0.1.0', root)).toMatchObject({ ok: true });
  const child = (client as unknown as { child: ChildProcessWithoutNullStreams }).child;
  const close = async () => { if (child.exitCode === null) { const exited = once(child, 'exit'); child.stdin.end(); await exited; } };
  return { client, child, root, close };
}
async function rejectsProtocol(client: HostClient, command: unknown): Promise<void> {
  let message: string | null = null;
  try { await request(client, command); }
  catch (error) { message = error instanceof Error ? error.message : String(error); }
  expect(message).toBe('host_protocol_invalid');
}

it('P6 HostClient accepts all five strict results and rejects foreign pages, gaps without context, oversized errors and raw tools', async () => {
  const fixture = await protocolFixture(`
if(command.type==='query_runtime_events') {
 const id=command.input.runId;
 response(command,id===1?{ok:true,data:page}:id===2?{ok:true,data:page}:id===3?{ok:true,data:{...page,runId:3,nextCursor:{runId:3,lastPersistedSequence:1}}}:id===4?{ok:false,error:{code:'event_gap',category:'storage',message:'gap',retryable:false},context:null}:id===5?{ok:false,error:{code:'storage_read_failed',category:'storage',message:'x'.repeat(262144),retryable:true},context:null}:id===7?{ok:true,data:{...page,runId:7,nextCursor:{runId:7,lastPersistedSequence:0}}}:id===8?{ok:true,data:{...page,runId:8,highWatermark:1,availableRange:{fromSequence:1,toSequence:1},coverage:'partial',nextCursor:{runId:8,lastPersistedSequence:0}}}:{ok:false,error:{code:'storage_read_failed',category:'storage',message:'missing context',retryable:true}});
} else if(command.type==='subscribe_runtime_events') response(command,{ok:true,data:{...context,subscriptionId:command.subscriptionId,...(command.subscriptionId==='extra'?{ownerToken:'forged'}:{})}});
else if(command.type==='unsubscribe_runtime_events') response(command,command.subscriptionId==='bad-ack'?{ok:true,data:null}:{ok:true});
else if(command.type==='list_run_tool_calls') response(command,{ok:true,data:{items:command.input.sessionId===null?[]:[{...tool,...(command.input.runId===2?{rawArguments:{secret:'synthetic'}}:{})}],nextBeforeId:null}});
else if(command.type==='query_run_tool_call') response(command,{ok:true,data:tool});
`);
  const { client } = fixture;
  try {
    expect(await request(client, { type: 'query_runtime_events', ownerToken: 'wire', input: publicInput })).toMatchObject({ ok: true });
    expect(await request(client, { type: 'subscribe_runtime_events', ownerToken: 'wire', subscriptionId: 'valid', input: publicInput }))
      .toMatchObject({ ok: true, data: { subscriptionId: 'valid' } });
    expect(await request(client, { type: 'unsubscribe_runtime_events', ownerToken: 'wire', subscriptionId: 'valid' })).toEqual({ ok: true, data: undefined });
    expect(await request(client, { type: 'list_run_tool_calls', input: { runId: 1, sessionId: null } })).toEqual({ ok: true, data: { items: [], nextBeforeId: null } });
    expect(await request(client, { type: 'query_run_tool_call', input: { runId: 1, sessionId: 1, toolCallId: 9 } })).toMatchObject({ ok: true, data: { toolCallId: 9 } });
    for (const runId of [2, 3, 4, 5, 6]) await rejectsProtocol(client, { type: 'query_runtime_events', ownerToken: 'wire',
      input: { ...publicInput, runId, cursor: { runId, lastPersistedSequence: 0 } } });
    await rejectsProtocol(client, { type: 'query_runtime_events', ownerToken: 'wire', input: { ...publicInput, runId: 7,
      cursor: { runId: 7, lastPersistedSequence: 0 }, throughSequence: 1 } });
    await rejectsProtocol(client, { type: 'query_runtime_events', ownerToken: 'wire', input: { ...publicInput, runId: 8,
      cursor: { runId: 8, lastPersistedSequence: 0 } } });
    await rejectsProtocol(client, { type: 'subscribe_runtime_events', ownerToken: 'wire', subscriptionId: 'extra', input: publicInput });
    await rejectsProtocol(client, { type: 'unsubscribe_runtime_events', ownerToken: 'wire', subscriptionId: 'bad-ack' });
    await rejectsProtocol(client, { type: 'list_run_tool_calls', input: { runId: 2, sessionId: 1 } });
    await rejectsProtocol(client, { type: 'query_run_tool_call', input: { runId: 2, sessionId: 1, toolCallId: 9 } });
    // Defaults are normalized before the Host call, and public-owner forgery never reaches it.
    await rejectsProtocol(client, { type: 'query_runtime_events', ownerToken: 'wire', input: { ...publicInput, ownerToken: 'forged' } });
  } finally { await fixture.close(); }
}, 15_000);

it('P6 HostClient accepts only strict wake hints and ignores malformed transport objects', async () => {
  const fixture = await protocolFixture(`
stdout.write('null\\n'+JSON.stringify({version:1,type:'event'})+'\\n');
for(const event of [{type:'runtime_events_available',subscriptionId:'valid',runId:1,sequence:1},{type:'runtime_events_available',subscriptionId:'valid',runId:1,sequence:2,payload:{secret:'synthetic'}},{type:'runtime_events_available',subscriptionId:'',runId:1,sequence:3}]) stdout.write(JSON.stringify({version:1,type:'event',event})+'\\n');
response(command,{ok:true,data:page});
`);
  const wakes: unknown[] = [];
  fixture.client.subscribe(event => wakes.push(event));
  try {
    expect(await request(fixture.client, { type: 'query_runtime_events', ownerToken: 'wire', input: publicInput })).toMatchObject({ ok: true });
    expect(wakes).toEqual([{ type: 'runtime_events_available', subscriptionId: 'valid', runId: 1, sequence: 1 }]);
  } finally { await fixture.close(); }
}, 15_000);

it('P6 HostClient releases a timed-out late open only on its captured original live connection after replacement', async () => {
  const first = await protocolFixture(`
appendFileSync(journal,JSON.stringify(command)+'\\n');
if(command.type==='subscribe_runtime_events') setTimeout(()=>response(command,{ok:true,data:{...context,subscriptionId:command.subscriptionId}}),250);
else if(command.type==='unsubscribe_runtime_events') response(command,{ok:true});
`);
  // The replacement needs this script, not a third unused live Host beside the two under test.
  const secondRoot = await prepareProtocolFixture("appendFileSync(journal,JSON.stringify(command)+'\\n'); response(command,{ok:true});");
  const subscriptionId = 'captured-before-open', ownerToken = 'old-owner';
  const cleanup = first.client.captureRuntimeSubscriptionCleanup(ownerToken, subscriptionId);
  first.client.setConnectionChangeHandler(cleanup);
  try {
    await expect(request(first.client, { type: 'subscribe_runtime_events', ownerToken, subscriptionId, input: publicInput }, 100))
      .rejects.toThrow('host_request_timeout');
    // Start creates a replacement; the cleanup callback executes before that child is installed.
    expect(await first.client.start(secondRoot, '0.1.0', secondRoot)).toMatchObject({ ok: true });
    cleanup();
    await new Promise(resolveDelay => setTimeout(resolveDelay, 300));
    const originalCommands = readFileSync(join(first.root, 'journal.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line)).filter(command => !command.trace);
    expect(originalCommands.filter(command => command.type === 'unsubscribe_runtime_events')).toHaveLength(2);
    expect(originalCommands.filter(command => command.type === 'unsubscribe_runtime_events').every(command => command.ownerToken === ownerToken && command.subscriptionId === subscriptionId)).toBe(true);
    // The replacement journal exists only after a deliberate command; captured cleanup never touched it.
    expect(await request(first.client, { type: 'unsubscribe_runtime_events', ownerToken: 'new-owner', subscriptionId: 'new-id' })).toEqual({ ok: true, data: undefined });
    const replacementCommands = readFileSync(join(secondRoot, 'journal.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line)).filter(command => !command.trace);
    expect(replacementCommands).toHaveLength(1);
    expect(replacementCommands[0]).toMatchObject({ ownerToken: 'new-owner', subscriptionId: 'new-id' });
  } finally {
    await first.close();
    const current = (first.client as unknown as { child: ChildProcessWithoutNullStreams }).child;
    if (current.exitCode === null) { const exited = once(current, 'exit'); current.stdin.end(); await exited; }
  }
}, 15_000);
