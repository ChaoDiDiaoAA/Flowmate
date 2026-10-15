import { expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { createRunRepository } from '../../../packages/core/src/storage/repositories.ts';
import { InMemoryCredentialStore } from '@earendil-works/pi-ai';
import { cpSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { ok } from '@flowmate/contracts';
import type { Result, ExtensionRef, AgentRunEvent, ProviderConfig } from '@flowmate/contracts';
import { createApplication } from '../../../apps/composition.ts';
import { PiAgentAdapter } from '../../../packages/runtime-pi/src/session.ts';
import { resolveProductPaths } from '../../../packages/shared/src/paths.ts';
import { createHttpProvider, deferCleanup, mkdtempSync } from '../../support/resources.ts';
const need = <T>(value: Result<T>): T => { if (!value.ok) throw Error(value.error.code+': '+value.error.message); return value.data; };

it('routes native Command and Markdown Template inputs through bound receipts and actual Agent calls, once', async () => {
  const root = mkdtempSync(join(tmpdir(), 'flowmate-triggers-')), paths = need(resolveProductPaths(join(root,'product')));
  const resourceRoot = join(root,'resources'); cpSync(resolve(import.meta.dir,'../../../resources'),resourceRoot,{recursive:true});
  mkdirSync(join(resourceRoot,'prompt-templates'),{recursive:true});
  writeFileSync(join(resourceRoot,'prompt-templates','analysis.md'), '---\ndescription: Independent analysis\n---\nCall Agent with subagent_type=general-analyst and run_in_background=false for this task: $1');
  const payloads: any[] = []; let noDelegate = false;
  const server = await createHttpProvider(async request => {
    const payload = await request.json(); payloads.push(payload);
    const child = payload.messages[0]?.content.startsWith('Analyze the task');
    const last = payload.messages.at(-1);
    const delta = !child && last.role === 'user' && !noDelegate ? { role:'assistant', tool_calls:[{ index:0,id:'delegate-'+payloads.length,
      type:'function',function:{name:'Agent',arguments:JSON.stringify({subagent_type:'general-analyst',description:'Independent task',prompt:'Analyze independently',run_in_background:false})}}] }
      : {role:'assistant',content: child ? 'Actual child finding.' : 'Verified summary.'};
    const chunk = (value: object, finish: string | null) => `data: ${JSON.stringify({id:'trigger',choices:[{index:0,delta:value,finish_reason:finish}]})}\n\n`;
    return new Response(chunk(delta,null)+chunk({},'tool_calls' in delta ? 'tool_calls':'stop')+'data: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}});
  }); deferCleanup(()=>server.stop());
  let extensions: ExtensionRef[] = [];
  const app = need(await createApplication({paths,resourceRoot,
    resourceDefaults:()=>ok({revision:1,selection:{prompt:null,enabledSkills:[]},extensions:{enabledExtensions:extensions}}),
    agentFactory:(tools,resourceContents)=>new PiAgentAdapter({cwd:paths.runtimeDir,agentDir:paths.runtimeDir,tools,resourceContents,credentials:new InMemoryCredentialStore(),runtimeApiKey:'controlled-only'})}));
  deferCleanup(()=>app.close()); extensions=need(await app.listExtensions()).items.filter(item=>item.ref.id==='subagents').map(item=>item.ref);
  const session=need(await app.createSession());
  const config: ProviderConfig={version:1,name:'trigger',revision:1,modelRef:{provider:'trigger',model:'trigger'},native:{authPath:join(root,'auth.json'),modelsPath:null},
    connection:{baseUrl:`http://127.0.0.1:${server.port}/v1`,api:'openai-completions',contextWindow:64000,maxTokens:16000},parameters:{maxRetries:0,maxRetryDelayMs:100}};
  let sequence=0;
  async function submit(text: string) {
    let finish!: (event: Extract<AgentRunEvent,{type:'run_finished'}>)=>void;
    const done=new Promise<Extract<AgentRunEvent,{type:'run_finished'}>>(resolve=>finish=resolve);
    const request={sessionId:session.sessionId,clientSequence:++sequence,mode:'prompt' as const,text,config,timeoutMs:10000,budget:{maxModelCalls:4,maxToolCalls:4}};
    const accepted=need(await app.submitInput(request,{onEvent:event=>{if(event.type==='run_finished')finish(event);}}));
    const terminal=await done;
    return {accepted,terminal,request};
  }
  const first=await submit('/subagent   general-analyst Check this argument');
  expect(need(first.terminal.result).status).toBe('completed');
  const run=need(await app.queryRun(first.accepted.runId));
  expect(run.config.inputCommandReceipt).toMatchObject({inputId:first.accepted.inputId,runId:first.accepted.runId,sessionId:session.sessionId,role:'general-analyst'});
  expect(JSON.stringify(payloads[0].messages.at(-1).content)).toContain('Delegate the following task');
  const requests=payloads.length;
  expect(await app.submitInput(first.request)).toEqual({ok:true,data:first.accepted}); expect(payloads).toHaveLength(requests);
  const second=await submit('/analysis "quoted task"');
  expect(need(second.terminal.result).status).toBe('completed');
  const secondRun=need(await app.queryRun(second.accepted.runId));
  expect(secondRun.config.inputDefinitions).toMatchObject({command:{kind:'template',originalText:'/analysis "quoted task"',expandedText:'Call Agent with subagent_type=general-analyst and run_in_background=false for this task: quoted task'}});
  expect(need(await app.listSubagents({parentRunId:second.accepted.runId,parentSessionId:session.sessionId})).items).toHaveLength(1);
  noDelegate=true; const missing=await submit('/subagent general-analyst Must actually delegate');
  expect(need(await app.querySessionInput({sessionId:session.sessionId,clientSequence:missing.request.clientSequence})).input).toMatchObject({processingStatus:'failed',error:{code:'agent_goal_not_met'}});
  const before=payloads.length;
  expect(await app.submitInput({...first.request,clientSequence:++sequence,text:'/unknown task'})).toMatchObject({ok:false,error:{code:'input_invalid'}});
  expect(await app.submitInput({...first.request,clientSequence:++sequence,text:'/subagent invoice-evidence-checker Inspect evidence'})).toMatchObject({ok:false,error:{code:'subagent_tool_denied'}});
  expect(payloads).toHaveLength(before);
  need(await app.close());
  const db = new Database(paths.databaseFile), savedRuns = createRunRepository(db);
  try {
    const original = JSON.stringify(run.config);
    for (const changed of [{ inputId: second.accepted.inputId }, { nativeSessionId: 'foreign-native-session' },
      { instanceId: '3e527b22-bbad-441b-a958-6a43d80e1207' }]) {
      db.query('UPDATE runs SET config_json=? WHERE id=?').run(JSON.stringify({ ...run.config,
        inputCommandReceipt: { ...(run.config.inputCommandReceipt as object), ...changed } }), first.accepted.runId);
      expect(savedRuns.get(first.accepted.runId).ok).toBe(false);
    }
    db.query('UPDATE runs SET config_json=? WHERE id=?').run(original, first.accepted.runId);
    expect(savedRuns.get(first.accepted.runId).ok).toBe(true);
  } finally { db.close(); }
  expect(payloads).toHaveLength(before);
});
