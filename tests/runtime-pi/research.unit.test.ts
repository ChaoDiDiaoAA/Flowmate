import { expect, it } from 'bun:test';
import { validateToolArguments } from '@earendil-works/pi-ai';
import { z } from 'zod';
import { ResearchPlanToolInputSchema, ResearchClaimBodySchema } from '@flowmate/contracts';
import { toPiParameters } from '../../packages/runtime-pi/src/schema.ts';
import { toPiTool } from '../../packages/runtime-pi/src/tools.ts';

it('exposes a strict boolean research permission to SDK validation without coercion', () => {
  const tool = { name: 'research_permission', description: 'Permission', parameters: toPiParameters(z.object({ web: z.boolean() }).strict()) };
  expect(validateToolArguments(tool, { name: tool.name, arguments: { web: true } } as never)).toEqual({ web: true });
  const adapted = toPiTool({ name: tool.name, version: '1', label: tool.name, description: tool.description,
    inputSchema: z.object({ web: z.boolean() }).strict(), outputSchema: z.boolean(), effect: 'PURE', executionMode: 'parallel',
    execute: async input => input.web }, async () => ({ content: [], details: null }));
  expect(() => adapted.prepareArguments?.({ web: 'true' })).toThrow('Invalid arguments');
  expect(() => toPiParameters(z.object({ web: z.coerce.boolean() }).strict())).toThrow('tool_schema_unsupported');
  expect(() => toPiParameters(ResearchPlanToolInputSchema)).not.toThrow();
});

it('parameter diagnostics explain UTF-16 and required fields without echoing the quote',()=>{
  const tool=toPiTool({name:'save_research_claim',version:'p15-v1',description:'Save claim',inputSchema:ResearchClaimBodySchema,
    outputSchema:z.unknown(),effect:'LOCAL_WRITE',executionMode:'sequential',execute:async()=>null},async()=>({content:[],details:null}));
  const quote='PRIVATE_MATERIAL_DO_NOT_ECHO';
  const raw={questionId:'q',text:'A claim.',dependencies:[],evidence:[{relation:'supports',ref:{researchId:1,planId:1,revision:1,runId:1,
    toolCallId:1,sourceSnapshotId:1,locator:{start:0,end:2,quote}}}],verification:{status:'insufficient',reasons:['No conclusion.']}};
  let message='';try{tool.prepareArguments?.(raw);}catch(error){message=String(error);}
  expect(message).toContain('UTF-16');expect(message).not.toContain(quote);expect(message.length).toBeLessThan(4096);
  const {verification:_,...missing}=raw;
  try{tool.prepareArguments?.(missing);}catch(error){message=String(error);}
  expect(message).toContain('verification');expect(message).toContain('expected');expect(message).toContain('allowedKeys');
});
