import { once } from 'node:events';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { expect, it } from 'bun:test';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp } from '../support/resources.ts';
import { HostClient } from '../../apps/desktop/main/host-client.ts';

it('turns a Host stdin EPIPE into rejected pending requests instead of an uncaught main-process error', async () => {
  const repoRoot = resolve(import.meta.dir, '../..');
  const userDataRoot = await mkdtemp(join(tmpdir(), 'flowmate-host-client-epipe-'));
  const client = new HostClient();
  const started = await client.start(userDataRoot, '0.1.0', repoRoot);
  const child = (client as unknown as { child: ChildProcessWithoutNullStreams }).child;
  try {
    expect(started.ok).toBe(true);
    if (!started.ok) return;

    const exited = once(child, 'exit');
    const pending = client.request({ type: 'get_state' }, 2_000);
    const pipeError = Object.assign(new Error('write EPIPE'), { code: 'EPIPE' });
    child.stdin.destroy(pipeError);

    await expect(pending).rejects.toThrow('host_write_failed');
    await Promise.race([exited, new Promise((resolveExit) => setTimeout(resolveExit, 5_000))]);
  } finally {
    if (child && child.exitCode === null) {
      child.kill();
      await Promise.race([once(child, 'exit'), new Promise((resolveExit) => setTimeout(resolveExit, 1_000))]);
    }
  }
});
