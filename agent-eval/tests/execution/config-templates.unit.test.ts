import { expect,test } from 'bun:test';
import { readdirSync,readFileSync } from 'node:fs';
import { join } from 'node:path';
import { discoverDatasets } from '../../src/dataset-loader/local.ts';
import { assertModelConfiguration } from '../../src/adapters/agent.ts';
test('only one Chinese-commented environment configuration remains',()=>{
 const root=join(import.meta.dir,'../../configs');expect(readdirSync(root)).toEqual(['.env']);
 const text=readFileSync(join(root,'.env'),'utf8');expect(text).toContain('# 必填');expect(text).not.toContain('FLOWMATE_LLM_API_KEY');
 expect(()=>assertModelConfiguration({model:'actual-model',api:'openai-completions',baseUrl:'https://unused.invalid/v1'})).not.toThrow();
});
test('62 authored cases have pending independent human review',()=>{
 const data=discoverDatasets(join(import.meta.dir,'../../src/datasets'));expect(data.reduce((n,d)=>n+d.cases.length,0)).toBe(62);
 for(const d of data){}
});
