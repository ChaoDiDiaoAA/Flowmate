import { expect, test } from 'bun:test';
import { ok, type Result } from '@flowmate/contracts';
import { createToolExecutor } from '../../../packages/core/src/tools/executor.ts';
import { createDesktopProposalTool, createDesktopReadTools } from '../../../packages/core/src/personal-agent/desktop-tools.ts';
import { invoiceWorkToolsFixture } from '../../support/invoice-work-tools.ts';

const at = '2026-11-06T00:00:00.000Z';
const proposal = { kind: 'click', observationId: '84c2bb96-6c56-48e0-aab0-f49f059cb1ba', elementIndex: 3 } as const;
const target = { connectionId: 'b46d9019-f9b0-4cbc-8ccb-a0dd2187a1aa',
  window: { id: 42, app: 'Invoice example', title: 'Draft invoice' }, element: '[3] Submit' };
function need<T>(result: Result<T>): T { if (!result.ok) throw Error(result.error.code); return result.data; }

test('Durable desktop reads use the current invoice scope and return bounded observation data', async () => {
  const f = await invoiceWorkToolsFixture({ at, configuration: { modelId: 'desktop-model', thinkingLevel: 'off',
    tools: ['desktop_list_windows', 'desktop_observe_window'], resources: { prompt: null, enabledSkills: [] }, extensions: { enabledExtensions: [] },
    workingDirectory: null, preferences: '' } });
  const seen: string[] = [];
  const definitions = createDesktopReadTools({
    listWindows: async context => { seen.push(`list:${context.scope.invoiceWork?.itemId}`); return ok([target.window]); },
    observe: async context => { seen.push(`observe:${context.scope.invoiceWork?.itemId}`); return ok({
      observationId: proposal.observationId, window: target.window, tree: '[3] Submit', truncated: false }); },
  });
  const executor = createToolExecutor({ database: f.database, definitions, now: () => at });
  const context = { ...f.product, signal: new AbortController().signal };
  expect((await executor.execute('desktop_list_windows', {}, { ...context, nativeToolCallId: 'durable-task:211' })).result)
    .toMatchObject({ status: 'succeeded', data: { windows: [target.window] } });
  expect((await executor.execute('desktop_observe_window', {}, { ...context, nativeToolCallId: 'durable-task:212' })).result)
    .toMatchObject({ status: 'succeeded', data: { observationId: proposal.observationId, tree: '[3] Submit' } });
  expect(seen).toEqual([`list:${f.itemId}`, `observe:${f.itemId}`]);
});

test('a Durable desktop proposal records the observed target without dispatching input', async () => {
  const f = await invoiceWorkToolsFixture({ at, configuration: { modelId: 'desktop-model', thinkingLevel: 'off',
    tools: ['desktop_propose_action'], resources: { prompt: null, enabledSkills: [] }, extensions: { enabledExtensions: [] },
    workingDirectory: null, preferences: '' } });
  let observations = 0;
  const tool = createDesktopProposalTool({ database: f.database, now: () => at,
    resolveTarget: async (input, context) => { observations++; expect(input).toEqual(proposal);
      expect(context.scope.invoiceWork).toMatchObject({ workId: f.created.workId, itemId: f.itemId }); return ok(target); } });
  const executor = createToolExecutor({ database: f.database, definitions: [tool], now: () => at });
  const result = await executor.execute('desktop_propose_action', proposal,
    { ...f.product, nativeToolCallId: 'durable-task:201', signal: new AbortController().signal });
  expect(result.result).toMatchObject({ status: 'succeeded', data: { proposalId: expect.any(Number) } });
  const saved = need(await f.database.read(scope => scope.invoiceWorkDesktopActions.list({ workId: f.created.workId, itemId: f.itemId })));
  expect(saved.items).toHaveLength(1);
  expect(saved.items[0]).toMatchObject({ status: 'waiting', canDecide: false, target, action: proposal });
  expect(observations).toBe(1);
});

test('cancelling while a desktop target is being resolved does not save an approval request', async () => {
  const f = await invoiceWorkToolsFixture({ at, configuration: { modelId: 'desktop-model', thinkingLevel: 'off',
    tools: ['desktop_propose_action'], resources: { prompt: null, enabledSkills: [] }, extensions: { enabledExtensions: [] },
    workingDirectory: null, preferences: '' } });
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<Result<typeof target>>();
  const tool = createDesktopProposalTool({ database: f.database, now: () => at,
    resolveTarget: async () => { entered.resolve(); return release.promise; } });
  const executor = createToolExecutor({ database: f.database, definitions: [tool], now: () => at });
  const controller = new AbortController();
  const pending = executor.execute('desktop_propose_action', proposal,
    { ...f.product, nativeToolCallId: 'durable-task:202', signal: controller.signal });
  await entered.promise; controller.abort(); release.resolve(ok(target));
  expect((await pending).result.status).not.toBe('succeeded');
  expect(need(await f.database.read(scope => scope.invoiceWorkDesktopActions.list({ workId: f.created.workId, itemId: f.itemId }))).items).toEqual([]);
});
