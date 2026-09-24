import { mkdtempSync } from '../support/resources.ts';
import { afterEach, expect, test } from 'bun:test';
import { PassThrough } from 'node:stream';
import { createInterface } from 'node:readline';
import { writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from '../../apps/cli/main.ts';
import type { Application, ProviderRequest, ProviderOutcome, Result } from '@flowmate/contracts';

const cleanup: Array<() => void> = [];
afterEach(() => { for (const close of cleanup.splice(0)) close(); });

const completed = (text: string): Result<ProviderOutcome> => ({ ok: true, data: {
  runId: 1, status: 'completed', text, error: null, stopped: true, cleanupErrors: [],
} });
const cancelled = (): Result<ProviderOutcome> => ({ ok: true, data: {
  runId: 1, status: 'cancelled', text: '', error: null, stopped: true, cleanupErrors: [],
} });

async function until(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 1000;
  while (!check() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
  expect(check()).toBe(true);
}

function harness(call: Application['callProvider'] = async (request) => completed(`回复：${request.goal}`)) {
  const dir = mkdtempSync(join(tmpdir(), 'flowmate-chat-test-'));
  const config = join(dir, 'provider.json');
  writeFileSync(config, JSON.stringify({ version: 1, name: 'test', revision: 1, modelRef: { provider: 'test', model: 'test' },
    native: { authPath: join(dir, 'auth.json'), modelsPath: null }, parameters: { maxRetries: 0, maxRetryDelayMs: 100 } }));
  const input = new PassThrough();
  const terminal = createInterface({ input, output: new PassThrough(), terminal: false });
  const messages: string[] = [], errors: string[] = [], requests: ProviderRequest[] = [];
  let closed = 0;
  const application = {
    async callProvider(request: ProviderRequest, control: Parameters<Application['callProvider']>[1]) { requests.push(request); return call(request, control); },
    async queryRun() { throw new Error('not used'); },
    async close() { closed++; return { ok: true, data: { stopped: true, closed: true, errors: [] } }; },
  } as unknown as Application;
  cleanup.push(() => { terminal.close(); input.destroy(); rmSync(dir, { recursive: true, force: true }); });
  const external = new AbortController();
  const done = main(['provider', 'chat', '--config', config], {
    out: (s) => messages.push(s), err: (s) => errors.push(s), signal: external.signal,
  }, { application, chatTerminal: terminal });
  return { input, terminal, messages, errors, requests, done, external, closed: () => closed };
}

test('interactive command accepts repeated questions, prints replies and keeps P1 requests independent', async () => {
  const h = harness();
  await until(() => h.messages.some((s) => s.includes('P1')));
  h.input.write('\n/help\n/not-a-command\n');
  expect(h.requests).toHaveLength(0);
  h.input.write('你好\n');
  await until(() => h.messages.some((s) => s.includes('回复：你好')));
  h.input.write('第二个问题\n');
  await until(() => h.messages.some((s) => s.includes('回复：第二个问题')));
  expect(h.requests.map((r) => [r.goal, r.text])).toEqual([['你好', ''], ['第二个问题', '']]);
  h.input.write('/exit\n');
  expect(await h.done).toBe(0);
  expect(h.closed()).toBe(1);
});

test('does not present a Flowmate output-token budget in the interactive command', async () => {
  const h = harness(async () => completed('回复'));
  await until(() => h.messages.some((s) => s.includes('P1')));
  h.input.write('你好\n');
  await until(() => h.messages.some((s) => s.includes('LLM >')));
  expect(h.messages.some((s) => s.includes('输出预算'))).toBe(false);
  h.input.write('/exit\n');
  expect(await h.done).toBe(0);
});

test('cancel aborts only the active request, rejects overlapping questions, then allows another question', async () => {
  let first = true;
  let aborted = false;
  const h = harness(async (_request, control) => {
    if (!first) return completed('取消后可继续');
    first = false;
    return new Promise((resolve) => control!.signal!.addEventListener('abort', () => { aborted = true; resolve(cancelled()); }, { once: true }));
  });
  await until(() => h.messages.some((s) => s.includes('P1')));
  h.input.write('等待回复\n');
  await until(() => h.requests.length === 1);
  h.input.write('不应并发\n/cancel\n');
  await until(() => aborted && h.messages.some((s) => s.includes('cancelled')));
  expect(h.requests).toHaveLength(1);
  h.input.write('继续\n');
  await until(() => h.messages.some((s) => s.includes('取消后可继续')));
  h.input.write('/exit\n');
  expect(await h.done).toBe(0);
});

test('EOF aborts an in-flight call and waits for it before closing the Application', async () => {
  let release: ((value: Result<ProviderOutcome>) => void) | undefined;
  let signal: AbortSignal | undefined;
  const h = harness(async (_request, control) => { signal = control?.signal; return new Promise((resolve) => { release = resolve; }); });
  await until(() => h.messages.some((s) => s.includes('P1')));
  h.input.write('等待\n');
  await until(() => release !== undefined);
  h.input.end();
  await until(() => signal?.aborted === true);
  expect(h.closed()).toBe(0);
  release!(cancelled());
  expect(await h.done).toBe(0);
  expect(h.closed()).toBe(1);
});

test('Ctrl+C cancels while busy, and exits while idle', async () => {
  const h = harness(async (_request, control) => new Promise((resolve) => {
    control!.signal!.addEventListener('abort', () => resolve(cancelled()), { once: true });
  }));
  await until(() => h.messages.some((s) => s.includes('P1')));
  h.input.write('等待\n');
  await until(() => h.requests.length === 1);
  h.terminal.emit('SIGINT');
  await until(() => h.messages.some((s) => s.includes('cancelled')));
  expect(h.closed()).toBe(0);
  h.terminal.emit('SIGINT');
  expect(await h.done).toBe(0);
});

test('provider failure is visible and the next prompt can still succeed', async () => {
  let first = true;
  const h = harness(async () => {
    if (first) { first = false; return { ok: false, error: { code: 'provider_auth_failed', category: 'provider', message: '认证失败', retryable: false } }; }
    return completed('下一次成功');
  });
  await until(() => h.messages.some((s) => s.includes('P1')));
  h.input.write('第一次\n');
  await until(() => h.errors.some((s) => s.includes('provider_auth_failed')));
  h.input.write('第二次\n');
  await until(() => h.messages.some((s) => s.includes('下一次成功')));
  h.input.write('/exit\n');
  expect(await h.done).toBe(0);
});

test('unconfirmed stop closes the chat instead of allowing another request', async () => {
  const h = harness(async () => ({ ok: true, data: { runId: 1, status: 'failed', text: '',
    error: null, stopped: false, cleanupErrors: [] } }));
  await until(() => h.messages.some((s) => s.includes('P1')));
  h.input.write('测试停止失败\n');
  expect(await h.done).toBe(2);
  expect(h.closed()).toBe(1);
  expect(h.errors.some((s) => s.includes('runtime_cleanup_required'))).toBe(true);
});

test('unexpected SDK exception is not printed and the Application is closed', async () => {
  const h = harness(async () => { throw new Error('Authorization: secret-test-value'); });
  await until(() => h.messages.some((s) => s.includes('P1')));
  h.input.write('测试异常\n');
  expect(await h.done).toBe(2);
  expect(h.closed()).toBe(1);
  expect(h.errors.join('\n')).toContain('internal_error');
  expect(h.errors.join('\n')).not.toContain('secret-test-value');
});

test('an external shutdown signal cancels the request before closing', async () => {
  const h = harness(async (_request, control) => new Promise((resolve) => {
    control!.signal!.addEventListener('abort', () => resolve(cancelled()), { once: true });
  }));
  await until(() => h.messages.some((s) => s.includes('P1')));
  h.input.write('等待\n');
  await until(() => h.requests.length === 1);
  h.external.abort();
  expect(await h.done).toBe(0);
  expect(h.closed()).toBe(1);
});
