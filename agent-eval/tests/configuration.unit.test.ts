import { test, expect } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { judgeConfig } from '../src/scoring/judges/client.ts';
import { langfuseConfig } from '../src/configuration.ts';
import { scanEvidence } from '../src/execution/evidence-safety.ts';

test('one Chinese-commented env file configures Judge and Langfuse; process environment wins',()=>{
 const root=mkdtempSync(join(tmpdir(),'eval-env-'));try {
  mkdirSync(join(root,'agent-eval/configs'),{recursive:true});
  writeFileSync(join(root,'agent-eval/configs/.env'),'# 中文用途\nFLOWMATE_JUDGE_PROVIDER=openai-compatible\nFLOWMATE_JUDGE_MODEL=file-model\nFLOWMATE_JUDGE_BASE_URL=https://unused.invalid/v1\nFLOWMATE_JUDGE_API_KEY=fake-judge-secret\nLANGFUSE_BASE_URL=https://unused.invalid\nLANGFUSE_PUBLIC_KEY=fake-public\nLANGFUSE_SECRET_KEY=fake-secret\n');
  const judge=judgeConfig({FLOWMATE_JUDGE_MODEL:'process-model',FLOWMATE_JUDGE_TEMPERATURE:'0.8',FLOWMATE_JUDGE_MAX_TOKENS:'256'},root);
  expect(judge).toMatchObject({model:'process-model',api:'openai-completions',timeoutMs:180000});
  expect(judge).not.toHaveProperty('temperature');expect(judge).not.toHaveProperty('maxTokens');
  expect(langfuseConfig(root,{}).publicKey).toBe('fake-public');
  expect(scanEvidence('fake-secret').value).toBe('[REDACTED]');
  expect(()=>judgeConfig({FLOWMATE_JUDGE_BASE_URL:'https://private:credential@invalid/'},root)).toThrow();
 }finally {rmSync(root,{recursive:true,force:true});}
});

test('the Node CLI entrypoint ignores root dotenv values and keeps explicit process precedence',()=>{
 const root=mkdtempSync(join(tmpdir(),'eval-cli-env-'));try{
  const directory=join(root,'agent-eval/src'),entry=join(directory,'cli.ts');mkdirSync(directory,{recursive:true});mkdirSync(join(root,'agent-eval/configs'));
  const source=resolve(import.meta.dir,'../src/cli.ts');
  const copied=readFileSync(source,'utf8').replace(/from '(\.[^']+)'/g,(_,specifier)=>`from '${new URL(specifier,pathToFileURL(source)).href}'`);
  writeFileSync(entry,copied+`\nprocess.on('beforeExit',()=>console.log('ENTRYPOINT_CONFIG='+JSON.stringify({model:judgeConfig(process.env,repoRoot)?.model,agent:process.env.FLOWMATE_LLM_API_KEY?'present':'absent'})));\n`);
  const settings=(model:string)=>`FLOWMATE_JUDGE_PROVIDER=openai-compatible\nFLOWMATE_JUDGE_MODEL=${model}\nFLOWMATE_JUDGE_BASE_URL=https://unused.invalid/v1\nFLOWMATE_JUDGE_API_KEY=synthetic-judge-key\n`;
  writeFileSync(join(root,'.env'),settings('obsolete-root-model')+'FLOWMATE_LLM_API_KEY=synthetic-root-agent-key\n');
  writeFileSync(join(root,'agent-eval/configs/.env'),settings('approved-model'));
  const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>!/^FLOWMATE_(JUDGE_|LLM_API_KEY$)|^LANGFUSE_/.test(key)));
  const loader=pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href;
  const run=(extra:NodeJS.ProcessEnv={})=>{
   const output=execFileSync('node',['--import',loader,entry,'--help'],{cwd:root,env:{...env,...extra},encoding:'utf8',windowsHide:true,timeout:15000});
   return JSON.parse(output.split('\n').find(line=>line.startsWith('ENTRYPOINT_CONFIG='))!.slice('ENTRYPOINT_CONFIG='.length));
  };
  expect(run()).toEqual({model:'approved-model',agent:'absent'});
  expect(run({FLOWMATE_JUDGE_MODEL:'explicit-model'})).toEqual({model:'explicit-model',agent:'absent'});
  writeFileSync(join(root,'package.json'),JSON.stringify({scripts:{eval:`node --import "${loader}" "${entry}"`}}));
  const output=execFileSync('bun',['run','eval','--','--help'],{cwd:root,env,encoding:'utf8',windowsHide:true,timeout:15000});
  expect(JSON.parse(output.split('\n').find(line=>line.startsWith('ENTRYPOINT_CONFIG='))!.slice('ENTRYPOINT_CONFIG='.length))).toEqual({model:'approved-model',agent:'absent'});
 }finally{rmSync(root,{recursive:true,force:true});}
},30000);
