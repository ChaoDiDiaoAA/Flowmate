import { expect, test } from 'bun:test';
import * as contracts from '../../packages/contracts/src/index.ts';

const target = { connectionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  bindingId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', origin: 'https://example.test' };

test('browser targets are exact web origins without paths or credentials', () => {
  const schema = contracts.BrowserTargetSchema;
  expect(schema).toBeDefined(); if (!schema) return;
  expect(schema.safeParse(target).success).toBe(true);
  for (const origin of ['https://example.test/path', 'https://user:pass@example.test', 'file:///tmp/a', 'https://example.test:443'])
    expect(schema.safeParse({ ...target, origin }).success).toBe(false);
  expect(schema.safeParse({ ...target, tabId: 3 }).success).toBe(false);
});

test('page results carry bounded text and an explicit truncation flag', () => {
  const schema = contracts.BrowserPageSchema;
  expect(schema).toBeDefined(); if (!schema) return;
  const page = { url: 'https://example.test/a', title: 'Invoice', text: '字'.repeat(7333), truncated: true };
  expect(schema.safeParse(page).success).toBe(true);
  expect(schema.safeParse({ ...page, text: '字'.repeat(7334) }).success).toBe(false);
  expect(schema.safeParse({ ...page, truncated: undefined }).success).toBe(false);
  expect(schema.safeParse({ ...page, url: 'file:///tmp/invoice' }).success).toBe(false);
  expect(schema.safeParse({ ...page, url: 'https://user:pass@example.test/a' }).success).toBe(false);
});

test('a browser read approval binds the exact displayed target', () => {
  const schema = contracts.BrowserReadDecisionRequestSchema;
  expect(schema).toBeDefined(); if (!schema) return;
  const request = { workId: 1, itemId: 2, proposalId: 3, expectedRevision: 4, requestId: 'decision-1', decision: 'approve', confirmedTarget: target };
  expect(schema.safeParse(request).success).toBe(true);
  expect(schema.safeParse({ ...request, confirmedTarget: undefined }).success).toBe(false);
  expect(schema.safeParse({ ...request, targetUrl: 'https://other.test' }).success).toBe(false);
  expect(schema.safeParse({ ...request, decision: 'reject', confirmedTarget: undefined }).success).toBe(true);
});

test('browser tool input cannot include a URL, tab or script', () => {
  const schema = contracts.BrowserToolInputSchema;
  expect(schema).toBeDefined(); if (!schema) return;
  expect(schema.safeParse({}).success).toBe(true);
  for (const input of [{ url: 'https://example.test' }, { tabId: 3 }, { code: '1+1' }, { proposalId: 7 }])
    expect(schema.safeParse(input).success).toBe(false);
});

test('only a user selection may provide a bounded web URL', () => {
  const schema = contracts.BrowserSelectionSchema;
  expect(schema).toBeDefined(); if (!schema) return;
  const request = { workId: 1, itemId: 2, url: 'https://example.test/report' };
  expect(schema.safeParse(request).success).toBe(true);
  for (const url of ['file:///tmp/a', 'https://name:secret@example.test/a', 'javascript:alert(1)'])
    expect(schema.safeParse({ ...request, url }).success).toBe(false);
  expect(schema.safeParse({ ...request, tabId: 3 }).success).toBe(false);
});

test('browser read views expose only valid approval and execution states', () => {
  const schema = contracts.BrowserReadViewSchema;
  expect(schema).toBeDefined(); if (!schema) return;
  const view = { proposalId: 3, workId: 1, itemId: 2, proposalToolCallId: 4, target, status: 'waiting',
    canDecide: true, canReject: true, canRevoke: false, executionToolCallId: null,
    createdAt: '2026-11-06T00:00:00.000Z', updatedAt: '2026-11-06T00:00:00.000Z' };
  expect(schema.safeParse(view).success).toBe(true);
  expect(schema.safeParse({ ...view, status: 'claimed', canDecide: false, canReject: false, canRevoke: true, executionToolCallId: 5 }).success).toBe(true);
  expect(schema.safeParse({ ...view, status: 'completed', executionToolCallId: null }).success).toBe(false);
  expect(schema.safeParse({ ...view, status: 'approved', canDecide: true }).success).toBe(false);
});

test('desktop bridge accepts only fixed browser targets and checks the returned page origin', () => {
  const request = { kind: 'browser_read', workId: 1, itemId: 2, proposalId: 3, target } as const;
  expect(contracts.DesktopBridgeRequestSchema.safeParse(request).success).toBe(true);
  for (const extra of [{ tabId: 3 }, { code: '1+1' }, { url: 'https://example.test' }, { port: 10086 }])
    expect(contracts.DesktopBridgeRequestSchema.safeParse({ ...request, ...extra }).success).toBe(false);
  const response = { ok: true, data: { kind: 'browser_read', page: { url: 'https://example.test/a', title: 'Example', text: 'page', truncated: false } } } as const;
  expect(contracts.parseDesktopBridgeResult(request, response)).toEqual(response);
  expect(contracts.parseDesktopBridgeResult(request, { ...response, data: { ...response.data,
    page: { ...response.data.page, url: 'https://outside.test/private' } } })).toBeNull();
});
