import { expect, test } from 'bun:test';
import { safeChildEnvironment } from '../../apps/desktop/main/host-client.ts';

test('Evaluation receives OS paths without ambient provider credentials while business Host behavior is preserved', () => {
  const old = process.env.SYNTHETIC_API_KEY; process.env.SYNTHETIC_API_KEY = 'synthetic-ambient-key';
  try {
    expect(safeChildEnvironment().SYNTHETIC_API_KEY).toBe('synthetic-ambient-key');
    expect(safeChildEnvironment(false).SYNTHETIC_API_KEY).toBeUndefined();
    expect(safeChildEnvironment(false).PI_OFFLINE).toBe('1');
    expect(safeChildEnvironment(false).PATH).toBe(process.env.PATH);
  } finally { if (old === undefined) delete process.env.SYNTHETIC_API_KEY; else process.env.SYNTHETIC_API_KEY = old; }
});
