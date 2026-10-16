import { expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseEvaluationWorkerOutput, type EvaluationWorkerOutput } from '../../agent-eval/src/desktop/protocol.ts';
import { fixtureRepo } from '../../agent-eval/tests/support/fixtures.ts';

test('an invalid evaluation root exits the real Worker without waiting for its parent to close stdin', async () => {
  const missing = join(fixtureRepo, 'missing-worker-' + randomUUID());
  const child = spawn(process.execPath, ['--no-env-file', 'agent-eval/src/desktop/worker.ts', '--repo', missing, '--session-id', 'synthetic-invalid-root'],
    { cwd: resolve(import.meta.dir, '../..'), env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, PI_OFFLINE: '1' }, windowsHide: true, stdio: 'pipe' });
  let stdout = '', stderr = '', timer: ReturnType<typeof setTimeout> | undefined;
  child.stdout.on('data', bytes => { stdout += String(bytes); }); child.stderr.on('data', bytes => { stderr += String(bytes); });
  const exited = once(child, 'close');
  try {
    const [code] = await Promise.race([exited, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(Error('Invalid evaluation root left the Worker input open.')), 10000);
    })]);
    expect(code).toBe(1); expect(stdout).toBe(''); expect(stderr).toContain('Worker startup or shutdown failed.');
    expect(existsSync(missing)).toBe(false);
  } finally { clearTimeout(timer); if (child.exitCode === null && child.signalCode === null) { child.kill(); await exited; } }
});

test('the fixed real Bun Worker previews locally, rejects secret-bearing control messages and exits only after shutdown', async () => {
  const root = resolve(import.meta.dir, '../..');
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP, TMP: process.env.TMP,
    USERPROFILE: process.env.USERPROFILE, HOME: process.env.HOME, PI_OFFLINE: '1' };
  const child = spawn(process.execPath, ['--no-env-file', 'agent-eval/src/desktop/worker.ts', '--repo', fixtureRepo, '--session-id', 'synthetic-worker'],
    { cwd: root, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  const frames: EvaluationWorkerOutput[] = [], waiting: Array<(value: EvaluationWorkerOutput | null) => void> = [];
  let stderr = '', ended = false;
  child.stderr.on('data', chunk => { stderr += String(chunk); });
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  lines.on('line', line => {
    const value = parseEvaluationWorkerOutput(JSON.parse(line)); if (!value) return;
    const waiter = waiting.shift(); if (waiter) waiter(value); else frames.push(value);
  });
  const exited = new Promise<number | null>(done => child.once('exit', code => { ended = true; for (const waiter of waiting.splice(0)) waiter(null); done(code); }));
  const next = () => frames.length ? Promise.resolve(frames.shift()!) : ended ? Promise.resolve(null)
    : new Promise<EvaluationWorkerOutput | null>(done => { waiting.push(done); });
  const send = (message: Record<string, unknown>) => child.stdin.write(JSON.stringify({ version: 1, sessionId: 'synthetic-worker', ...message }) + '\n');
  try {
    expect(await next()).toEqual({ version: 1, type: 'ready', sessionId: 'synthetic-worker' });
    send({ type: 'query_evaluation_control', messageId: 'control-1', input: {} });
    expect(await next()).toMatchObject({ type: 'response', messageId: 'control-1', operation: 'query_evaluation_control',
      result: { ok: true, data: { state: 'idle', executionIds: [] } } });
    send({ type: 'preview_evaluation', messageId: 'preview-1', input: { datasetId: 'facility-test', selection: 'smoke', repeat: 1, judge: 'off', configuration: {} },
      settings: { revision: 0, agent: null, judge: null, credentials: { agent: 'missing', judge: 'missing' } } });
    expect(await next()).toMatchObject({ type: 'response', messageId: 'preview-1', result: { ok: true, data: { ready: false, plan: { total: 2 } } } });
    expect(existsSync(join(fixtureRepo, 'agent-eval/runs'))).toBe(false);
    send({ type: 'query_evaluation_control', messageId: 'invalid-1', input: {}, apiKey: 'synthetic-never-log-key' });
    expect(await next()).toMatchObject({ type: 'protocol-error', error: { code: 'evaluation_protocol_invalid' } });
    expect(stderr).not.toContain('synthetic-never-log-key');
    send({ type: 'shutdown', messageId: 'shutdown-1', input: {} });
    expect(await next()).toMatchObject({ type: 'response', messageId: 'shutdown-1', result: { ok: true, data: { closed: true, stopped: true } } });
    expect(await exited).toBe(0);
  } finally { lines.close(); if (!ended) { child.kill(); await exited; } }
});
