import { describe, expect, it, mock } from 'bun:test';
import { main } from '../../apps/cli/main.ts';
import type { Application } from '../../packages/contracts/src/runtime.ts';

function app(): Application {
  return {
    callProvider: mock(),
    queryRun: mock(async () => ({ ok: true as const, data: { runId: 4, status: 'failed' } as never })),
    close: mock(async () => ({ ok: true as const, data: { stopped: true, closed: true, errors: [] } })),
  };
}

describe('CLI main dispatch', () => {
  it('dispatches provider query and closes the injected Application', async () => {
    const application = app();
    const io = { out: mock(), err: mock(), signal: new AbortController().signal };

    const code = await main(['provider', 'query', '--run-id', '4'], io, { application });

    expect(code).toBe(0);
    expect(application.queryRun).toHaveBeenCalledWith(4);
    expect(application.close).toHaveBeenCalledTimes(1);
  });

  it('rejects unknown commands with a usage error', async () => {
    const io = { out: mock(), err: mock(), signal: new AbortController().signal };
    const code = await main(['provider', 'unknown'], io, { application: app() });

    expect(code).toBe(2);
    expect(io.err).toHaveBeenCalledWith(expect.stringContaining('usage'));
  });
});
