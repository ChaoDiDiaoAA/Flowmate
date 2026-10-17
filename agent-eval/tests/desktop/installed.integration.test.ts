import { expect, it } from 'bun:test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Readable } from 'node:stream';
import { createInterface } from 'node:readline';
import { mkdtempSync, deferCleanup } from '../../../tests/support/resources.ts';

it('explicitly starts a dynamically imported Worker and closes without creating an Execution', async () => {
  const root = mkdtempSync(join(tmpdir(), 'flowmate-worker-entry-')), sessionId = crypto.randomUUID(), messageId = crypto.randomUUID();
  const worker = new URL('../../src/desktop/worker.ts', import.meta.url).href;
  const child = Bun.spawn([process.execPath, '--no-env-file', '-e',
    `const worker=await import(${JSON.stringify(worker)}); await worker.startEvaluationWorker(process.argv.slice(1));`,
    '--', '--repo', root, '--session-id', sessionId], { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe', env: {} });
  deferCleanup(async () => { if (child.exitCode === null) child.kill(); await child.exited; });
  const reader = createInterface({ input: Readable.from(child.stdout), crlfDelay: Infinity });
  let ready = false, closed = false;
  try {
    for await (const line of reader) {
      const frame = JSON.parse(line);
      if (frame.type === 'ready') {
        expect(frame).toEqual({ version: 1, type: 'ready', sessionId }); ready = true;
        child.stdin.write(JSON.stringify({ version: 1, sessionId, messageId, type: 'shutdown', input: {} }) + '\n');
      } else if (frame.type === 'response') {
        expect(frame).toMatchObject({ version: 1, sessionId, messageId, operation: 'shutdown', result: { ok: true, data: { closed: true, stopped: true } } });
        closed = true; child.stdin.end();
      } else throw Error('Unexpected Worker frame');
    }
  } finally { reader.close(); child.stdin.end(); }
  const code = await child.exited, stderr = await new Response(child.stderr).text();
  expect({ code, stderr }).toEqual({ code: 0, stderr: '' }); expect(ready).toBe(true); expect(closed).toBe(true);
  expect(existsSync(join(root, 'agent-eval/runs'))).toBe(false);
}, 15_000);
