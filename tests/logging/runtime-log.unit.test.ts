import { expect, test } from 'bun:test';
import * as logging from '@flowmate/logging';

test('runtime diagnostics retain at most 256 whitelisted records and count eviction and invalid events', async () => {
  expect(logging.createRuntimeLogBuffer).toBeFunction();
  const log = logging.createRuntimeLogBuffer(), at = '2026-10-17T00:00:00.000Z';
  for (let index = 1; index <= 257; index++) log.write({ at, level: 'info', component: 'runtime', event: 'run_saved', runId: index });
  const snapshot = log.snapshot();
  expect(snapshot.entries).toHaveLength(256); expect(snapshot.entries[0]!.runId).toBe(2); expect(snapshot.dropped).toBe(1);
  log.write({ at, level: 'error', component: 'runtime', event: 'raw prompt with spaces' });
  log.write({ at, level: 'error', component: '../secrets', event: 'failed' });
  log.write({ at, level: 'error', component: 'runtime', event: 'failed', code: 'x'.repeat(129) });
  expect(log.snapshot().dropped).toBe(4);
  Reflect.set(snapshot.entries[0]!, 'event', 'mutated');
  expect(log.snapshot().entries[0]!.event).toBe('run_saved');
  const extra = { at, level: 'info' as const, component: 'main', event: 'ready', details: 'PRIVATE PROMPT' };
  log.write(extra); expect(JSON.stringify(log.snapshot())).not.toContain('PRIVATE PROMPT');
  await log.close(); await log.close(); log.write(extra);
  expect(log.snapshot().entries).toHaveLength(256); expect(log.snapshot().dropped).toBe(5);
  expect(logging.createRuntimeLogBuffer().snapshot()).toEqual({ entries: [], dropped: 0 });
});
