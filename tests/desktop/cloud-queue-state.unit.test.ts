import { expect, test } from 'bun:test';
import { readCloudQueueControl, saveCloudQueueControl } from '../../apps/desktop/renderer/src/cloud-queue-state.ts';

test('a queue control keeps its original target and request in its own cloud workspace', () => {
  const values = new Map<string, string>(), storage = { getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); } };
  const workspace = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', other = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const control = { workId: 3, sessionId: 4, attemptId: 5, controlRequestId: 'original-control', expectedVersion: 2,
    action: { kind: 'edit' as const, submissionId: 6, content: 'Check the original total.' } };
  expect(saveCloudQueueControl(storage, workspace, control)).toBe(true);
  expect(readCloudQueueControl(storage, workspace)).toEqual({ ok: true, data: control });
  expect(readCloudQueueControl(storage, other)).toEqual({ ok: true, data: null });
  expect(saveCloudQueueControl(storage, workspace, { ...control, action: { kind: 'cancel', submissionId: 0 } })).toBe(false);
  expect(readCloudQueueControl(storage, workspace)).toEqual({ ok: true, data: control });
});
