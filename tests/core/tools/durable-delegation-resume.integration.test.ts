import { expect, test } from 'bun:test';
import { DelegateArgsSchema, INVOICE_REVIEW_TOOL_NAMES, NativeToolOutputSchema, PersonalAgentConfigurationSchema,
  ok, type Result, type ToolDefinition } from '@flowmate/contracts';
import { createToolExecutor } from '../../../packages/core/src/tools/executor.ts';
import { invoiceWorkToolsFixture } from '../../support/invoice-work-tools.ts';

const at = '2026-10-29T00:00:00.000Z';
function need<T>(result: Result<T>): T { if (!result.ok) throw Error(result.error.code); return result.data; }

test('only the original running Agent resumes with its fixed arguments and execution-only native control', async () => {
  const f = await invoiceWorkToolsFixture({ configuration: PersonalAgentConfigurationSchema.parse({ modelId: 'controlled', thinkingLevel: 'off',
    tools: [...INVOICE_REVIEW_TOOL_NAMES, 'Agent'], resources: { prompt: null, enabledSkills: [] }, extensions: { enabledExtensions: [] },
    workingDirectory: null, preferences: '' }) });
  let executions = 0;
  const definition: ToolDefinition<any, any> = { name: 'Agent', version: '1', description: 'Controlled original delegation',
    effect: 'READ', executionMode: 'parallel', inputSchema: DelegateArgsSchema, outputSchema: NativeToolOutputSchema,
    execute: async (args, call) => { executions++; expect(args.prompt).toBe('Verify the original invoice total');
      expect(call.nativeDelegate).toBeDefined(); return { content: [{ type: 'text', text: 'Original child recovered.' }] }; } };
  const args = { prompt: 'Verify the original invoice total', description: 'Original check', subagent_type: 'invoice-evidence-checker', run_in_background: false };
  const nativeToolCallId = 'durable-task:17';
  const original = await f.database.transaction(scope => {
    const requested = need(scope.toolCalls.request({ runId: f.runId, sessionId: f.created.sessionId, nativeToolCallId,
      toolName: 'Agent', toolVersion: '1', effect: 'READ', invoiceWorkScope: f.product.scope, rawArguments: args, context: null, requestedAt: at }));
    need(scope.toolCalls.fixArguments({ toolCallId: requested.toolCallId, finalArguments: args }));
    return need(scope.toolCalls.start({ toolCallId: requested.toolCallId, startedAt: at }));
  });
  const executor = createToolExecutor({ database: f.database, definitions: [definition], now: () => at });
  const context = { ...f.product, nativeToolCallId, signal: new AbortController().signal,
    nativeDelegate: async () => ok(null as never) };
  const recovered = await executor.resumeDelegation(context);
  expect(recovered).toMatchObject({ fatal: false, call: { toolCallId: original.toolCallId, startedAt: at }, result: { status: 'succeeded' } });
  expect(await executor.resumeDelegation(context)).toMatchObject({ call: { toolCallId: original.toolCallId }, result: recovered.result });
  expect(executions).toBe(1);
  expect(await f.database.read(scope => scope.db.query('SELECT COUNT(*) count FROM tool_calls').get())).toEqual({ count: 1 });
  const read = await f.execute('read_invoice_document', { documentId: 1, page: 1, afterBlockId: null, limit: 10 }, 'read-not-delegation');
  expect(await executor.resumeDelegation({ ...f.product, nativeToolCallId: 'read-not-delegation', signal: context.signal }))
    .toMatchObject({ fatal: true, result: { status: 'failed', error: { code: 'subagent_origin_invalid' } } });
  expect(read.result.status).toBe('succeeded');
});
