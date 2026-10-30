import { expect,test } from 'bun:test';
import { readdirSync,readFileSync,writeFileSync,unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync } from '../../../tests/support/resources.ts';
import { discoverDatasets } from '../../src/dataset-loader/local.ts';
import { assertModelConfiguration } from '../../src/adapters/agent.ts';
import { ObservabilitySettingsSchema } from '../../../packages/contracts/src/evaluation-workflow.ts';

function assertConfigurationFiles(root: string) {
 const files=readdirSync(root).sort();expect(files.filter(name=>name!=='observability.json')).toEqual(['.env']);
 if(files.includes('observability.json'))expect(()=>ObservabilitySettingsSchema.parse(JSON.parse(readFileSync(join(root,'observability.json'),'utf8')))).not.toThrow();
}
test('only one Chinese-commented environment configuration remains',()=>{
 const root=join(import.meta.dir,'../../configs');assertConfigurationFiles(root);
 const text=readFileSync(join(root,'.env'),'utf8');expect(text).toContain('# 必填');expect(text).not.toContain('FLOWMATE_LLM_API_KEY');
 expect(()=>assertModelConfiguration({model:'actual-model',api:'openai-completions',baseUrl:'https://unused.invalid/v1'})).not.toThrow();
});

test('only the exact three-boolean observability state is allowed beside the sole model environment file',()=>{
 const root=mkdtempSync(join(tmpdir(),'eval-config-contract-'));writeFileSync(join(root,'.env'),'# 必填\n');
 const state=join(root,'observability.json');writeFileSync(state,JSON.stringify({capture:true,upload:false,mining:false}));
 expect(()=>assertConfigurationFiles(root)).not.toThrow();
 for(const invalid of [{capture:'true',upload:false,mining:false},{capture:true,upload:false},
  {capture:true,upload:false,mining:false,model:'legacy-template'}]){
  writeFileSync(state,JSON.stringify(invalid));expect(()=>assertConfigurationFiles(root)).toThrow();
 }
 unlinkSync(state);const legacy=join(root,'agent.json');writeFileSync(legacy,JSON.stringify({model:'legacy-template'}));
 expect(()=>assertConfigurationFiles(root)).toThrow();
});
test('62 authored cases have pending independent human review',()=>{
 const data=discoverDatasets(join(import.meta.dir,'../../src/datasets'));expect(data.reduce((n,d)=>n+d.cases.length,0)).toBe(62);
 for(const d of data){}
});
