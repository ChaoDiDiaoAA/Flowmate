import { expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { PersonalDesktopActions } from '../../apps/desktop/renderer/src/personal-desktop-actions.tsx';
import * as desktopUi from '../../apps/desktop/renderer/src/personal-desktop-actions.tsx';

test('window selection requires a separate user action and explains the external app boundary', () => {
  const component = Reflect.get(desktopUi, 'PersonalDesktopWindow');
  expect(typeof component).toBe('function');
  if (typeof component !== 'function') return;
  const html = renderToStaticMarkup(createElement(component, { workId: 7, itemId: 71, disabled: false, hostEpoch: 1 }));
  expect(html).toContain('Find desktop windows');
  expect(html).toContain('Select this window');
  expect(html).toContain('money');
});

test('a desktop approval shows the exact target and action and does not offer a decision for uncertain input', () => {
  const base = { proposalId: 9, workId: 7, itemId: 71, proposalToolCallId: 14,
    target: { connectionId: '84c2bb96-6c56-48e0-aab0-f49f059cb1ba', window: { id: 42, app: 'Invoice', title: 'Draft <A>' }, element: '[3] Submit' },
    action: { kind: 'type_text' as const, observationId: '84c2bb96-6c56-48e0-aab0-f49f059cb1ba', elementIndex: 3, text: '113.00' },
    status: 'waiting' as const, canDecide: true, canReject: true, executionToolCallId: null,
    createdAt: '2026-11-06T00:00:00.000Z', updatedAt: '2026-11-06T00:00:00.000Z' };
  const html = renderToStaticMarkup(createElement(PersonalDesktopActions, { actions: [base], disabled: false, onDecision: () => {}, onDiscard: () => {} }));
  expect(html).toContain('Invoice'); expect(html).toContain('Draft &lt;A&gt;'); expect(html).toContain('[3] Submit');
  expect(html).toContain('Window ID: 42');
  expect(html).toContain('113.00'); expect(html).toContain('clipboard'); expect(html).toContain('Approve and continue');
  const unknown = renderToStaticMarkup(createElement(PersonalDesktopActions, { actions: [{ ...base, status: 'unknown',
    canDecide: false, canReject: false, executionToolCallId: 15 }], disabled: false, onDecision: () => {}, onDiscard: () => {} }));
  expect(unknown).toContain('may already have happened'); expect(unknown).not.toContain('Approve and continue');
  const stale = renderToStaticMarkup(createElement(PersonalDesktopActions, { actions: [{ ...base, canDecide: false, canReject: true }],
    disabled: false, onDecision: () => {}, onDiscard: () => {} }));
  expect(stale).toContain('Discard outdated request'); expect(stale).not.toContain('Approve and continue');
  const approved = renderToStaticMarkup(createElement(PersonalDesktopActions, { actions: [{ ...base, status: 'approved',
    canDecide: false, canReject: false }], disabled: false, onDecision: () => {}, onDiscard: () => {} }));
  expect(approved).toContain('Discard approval');
});
