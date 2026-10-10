import { expect, it } from 'bun:test';
import { validateToolArguments } from '@earendil-works/pi-ai';
import { z } from 'zod';
import { ResearchPlanToolInputSchema } from '@flowmate/contracts';
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
