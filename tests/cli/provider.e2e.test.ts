import { mkdtempSync } from '../support/resources.ts';
import { test, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const repo = resolve(import.meta.dir, '../..');
// Actual CLI process and application/SDK/SQLite; only the HTTP model service is controlled.
for (const fails of [false, true]) test(`CLI persists ${fails ? 'failure' : 'success'} and a second process queries it`, async () => {
  const root = mkdtempSync(join(tmpdir(), 'flowmate-cli-e2e-'));
  const requests: unknown[] = [];
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    expect(new URL(request.url).pathname).toBe('/v1/chat/completions');
    requests.push(await request.json());
    if (fails) return Response.json({ error: { message: 'Controlled authentication failure' } }, { status: 401 });
    const chunks = [{ choices: [{ index: 0, delta: { content: 'Controlled process result' }, finish_reason: null }] },
      { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 4, completion_tokens: 3, total_tokens: 7 } }];
    return new Response(chunks.map(c => `data: ${JSON.stringify({ id: 'e2e', object: 'chat.completion.chunk', model: 'controlled-model', ...c })}\n\n`).join('') + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
  } });
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? '', SystemRoot: process.env.SystemRoot ?? 'C:\\Windows', TEMP: root, TMP: root,
    APPDATA: root, HOME: root, USERPROFILE: root, NO_PROXY: '127.0.0.1,localhost',
    FLOWMATE_LLM_BASE_URL: `http://127.0.0.1:${server.port}/v1`, FLOWMATE_LLM_MODEL: 'controlled-model',
    FLOWMATE_LLM_API_KEY: 'synthetic-e2e-only', FLOWMATE_LLM_API: 'openai-completions'
  };
  const children: ReturnType<typeof Bun.spawn>[] = [];
  async function cli(args: string[]) {
    const child = Bun.spawn([process.execPath, '--no-env-file', 'run', 'apps/cli/main.ts', ...args], { cwd: repo, env, stdout: 'pipe', stderr: 'pipe' });
    children.push(child);
    const timer = setTimeout(() => child.kill(), 15000);
    try {
      const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      return { code, out, err };
    } finally { clearTimeout(timer); }
  }
  try {
    const input = join(root, 'input.txt');
    writeFileSync(input, 'Synthetic material only.');
    const call = await cli(['provider', 'call', '--input', input, '--goal', 'Explain the supplied material.', '--timeout-ms', '10000']);
    expect(call.code, call.err).toBe(fails ? 1 : 0);
    expect(requests).toHaveLength(1);
    const runId = /runId=(\d+)/.exec(call.out)?.[1];
    expect(runId).toBeDefined();
    const file = join(root, 'Flowmate/data/app.sqlite');
    expect(existsSync(file)).toBe(true);
    const db = new Database(file, { readonly: true });
    try { expect(db.query('SELECT status FROM runs WHERE id = ?').get(Number(runId))).toEqual({ status: fails ? 'failed' : 'completed' }); }
    finally { db.close(); }
    const query = await cli(['provider', 'query', '--run-id', runId!]);
    expect(query.code, query.err).toBe(0);
    expect(query.out).toContain(`status=${fails ? 'failed' : 'completed'}`);
    expect(fails ? query.err : query.out).toContain(fails ? 'provider_auth_failed' : 'Controlled process result');
    expect(requests).toHaveLength(1); // query must not call a model
    expect(call.out + call.err + query.out + query.err).not.toContain('synthetic-e2e-only');
  } finally {
    for (const child of children) { if (child.exitCode === null) child.kill(); await child.exited; }
    server.stop(true);
    rmSync(root, { recursive: true, force: true });
  }
  expect(existsSync(root)).toBe(false);
}, 40000);
