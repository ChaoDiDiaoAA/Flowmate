import { expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { PersonalConfiguration } from '../../apps/desktop/renderer/src/personal-configuration.tsx';

test('a browser approval shows its Work, origin, data flow and single-read decision', async () => {
  const module = await import('../../apps/desktop/renderer/src/personal-browser-actions.tsx').catch(() => null);
  expect(module).not.toBeNull(); if (!module) return;
  const at = '2026-11-06T00:00:00.000Z';
  const read = { proposalId: 3, workId: 1, itemId: 2, proposalToolCallId: 4, status: 'waiting' as const,
    target: { connectionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', bindingId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', origin: 'https://example.test' },
    canDecide: true, canReject: true, canRevoke: false, executionToolCallId: null, createdAt: at, updatedAt: at };
  const html = renderToStaticMarkup(createElement(module.PersonalBrowserReads, { reads: [read], cloud: true,
    disabled: false, onDecision: () => {}, onRevoke: () => {} }));
  expect(html).toContain('https://example.test');
  expect(html).toContain('Work 1'); expect(html).toContain('item 2');
  expect(html).toContain('Flowmate Cloud Work 1 Item 2');
  expect(html).toContain('cloud'); expect(html).toContain('model');
  expect(html).toContain('Approve one read'); expect(html).toContain('Reject read');
});

test('browser page reading is one default-off setting instead of two separately selectable tools', () => {
  const configuration = { modelId: null, thinkingLevel: 'off' as const, tools: [], resources: { prompt: null, enabledSkills: [] },
    extensions: { enabledExtensions: [] }, workingDirectory: null, preferences: '' };
  const html = renderToStaticMarkup(createElement(PersonalConfiguration, { ready: true, hostEpoch: 1, disabled: false, models: [],
    configuration: { revision: 0, value: configuration }, onChange: () => {}, onSave: () => {}, onReload: () => {}, onModels: () => {} }));
  expect(html).toContain('Enable browser page reading');
  expect(html).not.toContain('Enable Personal Agent tool browser_request_read');
  expect(html).not.toContain('Enable Personal Agent tool browser_read_approved');
});
