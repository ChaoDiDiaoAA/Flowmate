import { expect, it } from 'bun:test';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { Database } from 'bun:sqlite';
import { HostClient } from '../../apps/desktop/main/host-client.ts';
import { parseInputDefinitionHostResult } from '@flowmate/contracts';
import { mkdtempSync } from '../support/resources.ts';

it('runs all four definition APIs through the actual Host without Runs, Inputs, tools or model work', async () => {
  const root=mkdtempSync(join(tmpdir(),'flowmate-definition-host-')), client=new HostClient();
  expect(await client.start(root,'0.1.0',resolve(import.meta.dir,'../..'))).toMatchObject({ok:true});
  try {
    const listed=parseInputDefinitionHostResult('list_subagent_definitions',await client.request({type:'list_subagent_definitions',input:{}}));
    expect(listed?.ok).toBe(true);
    const commands=parseInputDefinitionHostResult('list_input_commands',await client.request({type:'list_input_commands',input:{}}));
    expect(commands?.ok && commands.data).toEqual(expect.arrayContaining([expect.objectContaining({group:'Skills',text:'/skill:invoice '}),
      expect.objectContaining({group:'Subagents',text:'/subagent general-analyst ',available:false}),
      expect.objectContaining({group:'Prompt Templates',name:'parallel-invoice-review'}), expect.objectContaining({group:'Extension Commands',name:'invoice-assist'})]));
    const input={id:'custom-reviewer',expectedHash:null,content:'---\nname: custom-reviewer\ndescription: Independent review\ntools: []\n---\nReview the assigned question and return findings.'};
    const saved=parseInputDefinitionHostResult('save_subagent_definition',await client.request({type:'save_subagent_definition',input}));
    expect(saved).toMatchObject({ok:true,data:{id:input.id,source:'user',tools:[]}});
    expect(await client.request({type:'get_subagent_definition',input:{id:input.id}})).toEqual(saved);
    expect(await client.request({type:'save_subagent_definition',input})).toMatchObject({ok:false});
  } finally { expect(await client.close()).toMatchObject({ok:true,data:{closed:true,stopped:true}}); }
  const db=new Database(join(root,'data/app.sqlite'),{readonly:true});
  try { for (const table of ['runs','session_inputs','tool_calls']) expect(db.query(`SELECT count(*) AS count FROM ${table}`).get()).toEqual({count:0});
    expect(db.query('SELECT max(version) AS version FROM schema_migrations').get()).toEqual({version:19}); }
  finally { db.close(); }
});
