import {test,expect,spyOn} from 'bun:test';
import {mkdirSync,writeFileSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {main} from '../../src/cli.ts';
import {productAgent, createProductAgent} from '../../src/adapters/agent.ts';
import {readReport,comparison} from '../../src/reports/store.ts';
import {fixtureRepo} from '../support/fixtures.ts';
import {manifest} from '../fixtures/minimal-dataset.ts';
import {createHttpProvider} from '../../../tests/support/resources.ts';
import { judgeResponse } from '../support/judge-response.ts';

test('local CLI readiness does not require a Docker engine or image', () => {
 const originalPath=process.env.PATH;process.env.PATH='';
 try { expect(createProductAgent(fixtureRepo,'synthetic-local-only').readiness()).toMatchObject({ready:true}); }
 finally { if(originalPath===undefined)delete process.env.PATH;else process.env.PATH=originalPath; }
});

test('production readiness reports the missing Agent credential independently of Judge configuration',()=>{
 const original=process.env.FLOWMATE_EVAL_AGENT_API_KEY,generic=process.env.FLOWMATE_LLM_API_KEY;
 process.env.FLOWMATE_EVAL_AGENT_API_KEY='';process.env.FLOWMATE_LLM_API_KEY='synthetic-generic-key';
 try{expect(productAgent.readiness()).toMatchObject({ready:false});expect(productAgent.readiness().reason).toContain('FLOWMATE_EVAL_AGENT_API_KEY');}
 finally{if(original===undefined)delete process.env.FLOWMATE_EVAL_AGENT_API_KEY;else process.env.FLOWMATE_EVAL_AGENT_API_KEY=original;if(generic===undefined)delete process.env.FLOWMATE_LLM_API_KEY;else process.env.FLOWMATE_LLM_API_KEY=generic;}
});

test('default CLI runs only independent synthetic data through local Host, one independent Judge and saved report comparison',async()=>{
 let agentCalls=0,judgeCalls=0;
 const server=await createHttpProvider(async request=>{
  const body=await request.json() as any;
  if(new URL(request.url).pathname.startsWith('/judge/')){
   judgeCalls++;expect(request.headers.get('authorization')).toBe('Bearer synthetic-public-judge');expect(body.max_completion_tokens).toBe(32768);expect(body).not.toHaveProperty('temperature');
   return judgeResponse({model:'llama-3.3-70b-versatile',choices:[{finish_reason:'stop',message:{content:JSON.stringify({score:1,reason:'Independent synthetic reference matches.'})}}],usage:{prompt_tokens:10,completion_tokens:5}});
  }
  agentCalls++;expect(request.headers.get('authorization')).toBe('Bearer synthetic-public-agent');
  const chunk=(delta:unknown,finish:string|null)=>'data: '+JSON.stringify({id:'synthetic-cli',model:'scripted-agent',choices:[{index:0,delta,finish_reason:finish}],...(finish?{usage:{prompt_tokens:10,completion_tokens:5,total_tokens:15}}:{})})+'\n\n';
  return new Response(chunk({role:'assistant',content:'The synthetic answer is 42.'},null)+chunk({},'stop')+'data: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}});
 },'0.0.0.0');
 const values={FLOWMATE_EVAL_AGENT_API_KEY:'synthetic-public-agent',FLOWMATE_EVAL_AGENT_MODEL:'deepseek-v4-flash',
  FLOWMATE_EVAL_AGENT_API:'openai-completions',FLOWMATE_EVAL_AGENT_BASE_URL:`http://127.0.0.1:${server.port}/agent`,FLOWMATE_JUDGE_API:'openai-completions',FLOWMATE_JUDGE_PROVIDER:'openai-compatible',FLOWMATE_JUDGE_MODEL:'llama-3.3-70b-versatile',
  FLOWMATE_JUDGE_BASE_URL:`http://127.0.0.1:${server.port}/judge`,FLOWMATE_JUDGE_API_KEY:'synthetic-public-judge',FLOWMATE_JUDGE_MAX_TOKENS:'256'};
 const saved=Object.fromEntries(Object.keys(values).map(k=>[k,process.env[k]])),originalCode=process.exitCode,output=spyOn(console,'log').mockImplementation(()=>{});
 Object.assign(process.env,values);
 const folder=join(fixtureRepo,'agent-eval/src/datasets/public-synthetic');mkdirSync(join(folder,'cases'),{recursive:true});
 writeFileSync(join(folder,'dataset.json'),JSON.stringify({...manifest,id:'public-synthetic',members:['cases/synthetic.json'],smoke:['synthetic'],scoring:{...manifest.scoring,judges:[{id:'answer-relevance',required:true}]}}));
 writeFileSync(join(folder,'cases/synthetic.json'),JSON.stringify({id:'synthetic',version:1,name:'Independent synthetic engineering',category:'engineering',tags:['synthetic'],requires:['agent'],
  input:{prompt:'State the independent synthetic answer 42.',materials:[]},expected:{success:['Answer exactly from the synthetic request.'],failure:['Invent a different answer.'],
   checks:[{metric:'fact-check',required:true,evidence:'answer',path:[],equals:'The synthetic answer is 42.'}]},review:{status:'pending'}}));
 try{
  expect(productAgent.readiness().ready).toBe(true);
  await main(['run','--dataset','public-synthetic','--execution-id','public-synthetic-a','--judge','required','--backend','local'],fixtureRepo);
  const file=join(fixtureRepo,'agent-eval/runs/public-synthetic-a/report.json'),report=readReport(file);
  if(report.trials[0]!.status!=='PASS')throw new Error(JSON.stringify({reason:report.trials[0]!.reason,error:report.trials[0]!.execution?.error,scores:report.trials[0]!.scores}));
  expect(report.trials[0]!.status).toBe('PASS');expect(report.trials[0]!.judgeCalls).toHaveLength(1);
  expect(report.trials[0]!.execution!.evidence.environment!.present).toBe(true);expect(report.executionComplete).toBe(true);
  expect(comparison(report,readReport(file))).toBeDefined();await main(['compare','--left','public-synthetic-a','--right','public-synthetic-a'],fixtureRepo);
  expect(agentCalls).toBe(1);expect(judgeCalls).toBe(1);expect(process.exitCode).toBe(0);
  await expect(main(['run','--dataset','public-synthetic','--model','REPLACE_WITH_AGENT_MODEL','--execution-id','unfilled-model','--judge','required'],fixtureRepo)).rejects.toThrow('FLOWMATE_EVAL_AGENT_MODEL');
  expect(existsSync(join(fixtureRepo,'agent-eval/runs/unfilled-model'))).toBe(false);expect(agentCalls).toBe(1);expect(judgeCalls).toBe(1);
 }finally{output.mockRestore();process.exitCode=originalCode;for(const[k,v]of Object.entries(saved))if(v===undefined)delete process.env[k];else process.env[k]=v;await server.stop();}
},90000);
