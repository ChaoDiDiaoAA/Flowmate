import { expect, test } from 'bun:test';
import { ok } from '@flowmate/contracts';
import { createToolExecutor } from '../../../packages/core/src/tools/executor.ts';
import { invoiceWorkToolsFixture } from '../../support/invoice-work-tools.ts';

test('an unapproved invoice phase exposes only the browser read request tool', async () => {
  const f = await invoiceWorkToolsFixture({ configuration: { modelId: null, thinkingLevel: 'off',
    tools: ['browser_request_read', 'browser_read_approved'], resources: { prompt: null, enabledSkills: [] },
    extensions: { enabledExtensions: [] }, workingDirectory: null, preferences: '' } });
  expect(f.product.scope.allowedTools).toEqual(['browser_request_read']);
  const saved = await f.database.read(scope => scope.invoiceWorkContexts.get({ workId: f.created.workId,
    attemptId: f.attemptId, requestId: f.phase.requestId }));
  expect(saved.ok).toBe(true);
  if (saved.ok) expect(saved.data?.context.actions.tools).toEqual(['browser_request_read']);
});

test('a browser request records the selected target without reading page content', async () => {
  const at = '2026-11-06T00:00:00.000Z';
  const f = await invoiceWorkToolsFixture({ at, configuration: { modelId: null, thinkingLevel: 'off',
    tools: ['browser_request_read', 'browser_read_approved'], resources: { prompt: null, enabledSkills: [] },
    extensions: { enabledExtensions: [] }, workingDirectory: null, preferences: '' } });
  const target = { connectionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    bindingId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', origin: 'https://example.test' };
  const module = await import('../../../packages/core/src/personal-agent/browser-tools.ts').catch(() => null);
  expect(module).not.toBeNull(); if (!module) return;
  let resolved = 0;
  const tool = module.createBrowserRequestTool({ database: f.database, now: () => at,
    resolveTarget: async context => { resolved++; expect(context.scope.invoiceWork?.itemId).toBe(f.itemId); return ok(target); } });
  const executor = createToolExecutor({ database: f.database, definitions: [tool], now: () => at });
  const result = await executor.execute('browser_request_read', {}, { ...f.product, nativeToolCallId: 'durable-task:browser-request',
    signal: new AbortController().signal });
  expect(result.result).toMatchObject({ status: 'succeeded', data: { proposalId: expect.any(Number) } });
  expect(resolved).toBe(1);
  const rows = await f.database.read(scope => scope.db.query('SELECT status,target_json FROM invoice_work_browser_reads').all());
  expect(rows).toEqual([{ status: 'waiting', target_json: JSON.stringify(target) }]);
});

test('the product browser adapter sends only the original owner and approved target to the desktop', async () => {
  const f = await invoiceWorkToolsFixture({ configuration: { modelId: null, thinkingLevel: 'off',
    tools: ['browser_request_read', 'browser_read_approved'], resources: { prompt: null, enabledSkills: [] },
    extensions: { enabledExtensions: [] }, workingDirectory: null, preferences: '' } });
  const target = { connectionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', bindingId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', origin: 'https://example.test' };
  const page = { url: 'https://example.test/page', title: 'Invoice', text: 'page', truncated: false };
  const requests: unknown[] = [];
  const module = await import('../../../apps/browser-bridge.ts').catch(() => null);
  expect(module).not.toBeNull(); if (!module) return;
  const bridge = module.createBrowserBridge(async request => { requests.push(request);
    return request.kind === 'browser_target' ? ok({ kind: 'browser_target', target }) : ok({ kind: 'browser_read', page }); });
  const signal = new AbortController().signal;
  expect(await bridge.resolveTarget(f.product, signal)).toEqual(ok(target));
  expect(await bridge.read(target, f.product, signal, 3)).toEqual(ok(page));
  expect(requests).toEqual([{ kind: 'browser_target', workId: f.created.workId, itemId: f.itemId },
    { kind: 'browser_read', workId: f.created.workId, itemId: f.itemId, target, proposalId: 3 }]);
});
