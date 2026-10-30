import { expect, test } from 'bun:test';
import { setImmediate } from 'node:timers/promises';
import * as reads from '../../../packages/core/src/research/read-tools.ts';

test('research acquisition shares two slots, releases failures and removes cancelled waiters', async () => {
  const run = reads.createResearchReadQueue();
  let active = 0, peak = 0;
  const releases: Array<() => void> = [];
  const work = async () => {
    active++; peak = Math.max(peak, active);
    try { await new Promise<void>(resolve => releases.push(resolve)); } finally { active--; }
  };
  const signal = new AbortController().signal;
  const first = run(1, { signal, nativeToolCallId: 'one' }, work);
  const second = run(1, { signal, nativeToolCallId: 'two' }, work);
  const third = run(1, { signal, nativeToolCallId: 'three' }, work);
  const cancel = new AbortController();
  const fourth = run(1, { signal: cancel.signal, nativeToolCallId: 'four' }, work).catch(error => error.error.code);
  await setImmediate();
  expect(active).toBe(2);
  cancel.abort();
  expect(await fourth).toBe('agent_cancelled');
  releases.shift()!(); await setImmediate();
  expect(active).toBe(2);
  for (const release of releases.splice(0)) release();
  await Promise.all([first, second, third]);
  expect(peak).toBe(2);
  await expect(run(1, { signal, nativeToolCallId: 'failure' }, async () => { throw Error('read failed'); })).rejects.toThrow('read failed');
  expect(await run(1, { signal, nativeToolCallId: 'next' }, async () => 'next')).toBe('next');
});
