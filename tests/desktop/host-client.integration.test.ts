import { once } from 'node:events';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { expect, it } from 'bun:test';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { Database } from 'bun:sqlite';
import { SessionMessageViewSchema } from '@flowmate/contracts';
import type { SessionMessagesPage, SessionMessageView, Result } from '@flowmate/contracts';
import { mkdtemp } from '../support/resources.ts';
import { HostClient, safeChildEnvironment } from '../../apps/desktop/main/host-client.ts';

it('passes Pi provider ambient auth to Host without Judge or platform credentials', () => {
  const previous = { deepseek: process.env.DEEPSEEK_API_KEY, judge: process.env.FLOWMATE_JUDGE_API_KEY,
    langfuse: process.env.LANGFUSE_SECRET_KEY };
  try {
    process.env.DEEPSEEK_API_KEY = 'ambient-fixture';
    process.env.FLOWMATE_JUDGE_API_KEY = 'judge-fixture';
    process.env.LANGFUSE_SECRET_KEY = 'platform-fixture';
    const env = safeChildEnvironment();
    expect(env.DEEPSEEK_API_KEY).toBe('ambient-fixture');
    expect(env.FLOWMATE_JUDGE_API_KEY).toBeUndefined();
    expect(env.LANGFUSE_SECRET_KEY).toBeUndefined();
  } finally {
    for (const [name, value] of Object.entries({ DEEPSEEK_API_KEY: previous.deepseek,
      FLOWMATE_JUDGE_API_KEY: previous.judge, LANGFUSE_SECRET_KEY: previous.langfuse })) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
  }
});

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

it('uses Pi native API-key login and returns the credential to the protected Main store', async () => {
  const repoRoot = resolve(import.meta.dir, '../..');
  const userDataRoot = await mkdtemp(join(tmpdir(), 'flowmate-host-pi-login-'));
  const client = new HostClient();
  let stored: unknown;
  client.setCredentialHandler(async (request) => {
    if (request.operation === 'read') return { ok: true, ...(stored === undefined ? {} : { credential: stored }) };
    if (request.operation === 'write') { stored = request.credential; return { ok: true }; }
    stored = undefined;
    return { ok: true };
  });
  const unsubscribe = client.subscribe((event) => {
    if (event.type === 'model_auth_prompt') void client.request({ type: 'auth_reply',
      loginRequestId: event.requestId, promptId: event.promptId, value: 'synthetic-pi-key' });
  });
  try {
    const started = await client.start(userDataRoot, '0.1.0', repoRoot);
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    const settings = { version: 2 as const, revision: 0, profile: { displayName: 'Login test', theme: 'system' as const },
      models: [{ id: 'pi-deepseek', credentialRef: 'login_credential_reference_1', name: 'DeepSeek',
        kind: 'catalog' as const, providerId: 'deepseek', baseUrl: '', model: 'deepseek-v4-flash',
        api: '', contextWindow: null, maxTokens: null, reasoning: false }],
      defaultModelId: 'pi-deepseek', updatedAt: '2026-09-29T00:00:00.000Z' };
    expect(await client.request({ type: 'save_settings', settings })).toMatchObject({ ok: true });
    expect(await client.request({ type: 'login_model', requestId: 'pi-login-1', modelId: 'pi-deepseek', authType: 'api_key' }, 30_000))
      .toMatchObject({ ok: true, data: { configured: true } });
    expect(stored).toEqual({ type: 'api_key', key: 'synthetic-pi-key' });
    expect(await client.request({ type: 'logout_model', modelId: 'pi-deepseek' })).toMatchObject({ ok: true });
    expect(stored).toBeUndefined();
  } finally {
    unsubscribe();
    await client.close();
  }
});

it('rejects Pi requests without a local API key even when environment or OAuth credentials exist', async () => {
  const repoRoot = resolve(import.meta.dir, '../..');
  const userDataRoot = await mkdtemp(join(tmpdir(), 'flowmate-host-local-key-'));
  const client = new HostClient();
  let stored: { type: string; key?: string; access?: string; refresh?: string; expires?: number } | undefined;
  client.setCredentialHandler(async (request) => request.operation === 'read'
    ? { ok: true, ...(stored ? { credential: stored } : {}) } : { ok: false });
  const previousKey = process.env.DEEPSEEK_API_KEY;
  process.env.DEEPSEEK_API_KEY = 'synthetic-ambient-key';
  try {
    const started = await client.start(userDataRoot, '0.1.0', repoRoot);
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    const profile = { id: 'pi-deepseek', credentialRef: 'local_key_credential_ref_1234', name: 'DeepSeek',
      kind: 'catalog' as const, providerId: 'deepseek', baseUrl: '', model: 'deepseek-v4-flash',
      api: '', contextWindow: null, maxTokens: null, reasoning: false };
    const settings = { version: 2 as const, revision: 0,
      profile: { displayName: 'Local key test', theme: 'system' as const }, models: [profile],
      defaultModelId: profile.id, updatedAt: '2026-09-30T00:00:00.000Z' };
    const saved = await client.request({ type: 'save_settings', settings }) as { ok: boolean; data?: { revision: number } };
    expect(saved).toMatchObject({ ok: true, data: { revision: 1 } });
    const created = await client.request({ type: 'create_session', requestId: 'local-key-session', input: {} }) as {
      ok: boolean; data?: { sessionId: number } };
    expect(created.ok).toBe(true);
    if (!created.data) return;
    const call = () => client.request({ type: 'call_provider', requestId: crypto.randomUUID(),
      input: { goal: 'Check', text: 'OK', modelId: profile.id } });
    const run = () => client.request({ type: 'start_run', requestId: crypto.randomUUID(),
      input: { sessionId: created.data!.sessionId, text: 'Check', modelId: profile.id, goalMode: 'answer' },
      expectedSettingsRevision: 1, expectedCredentialRef: profile.credentialRef });
    expect(await call()).toMatchObject({ ok: false, error: { code: 'model_credential_missing' } });
    expect(await run()).toMatchObject({ ok: false, error: { code: 'model_credential_missing' } });
    stored = { type: 'oauth', access: 'old-access', refresh: 'old-refresh', expires: Date.now() + 60_000 };
    expect(await call()).toMatchObject({ ok: false, error: { code: 'model_credential_missing' } });
    expect(await run()).toMatchObject({ ok: false, error: { code: 'model_credential_missing' } });
    stored = { type: 'api_key', key: 'synthetic-local-key' };
    const unsupported = await client.request({ type: 'save_settings', settings: {
      ...settings, revision: 1, models: [{ ...profile, providerId: 'openai-codex' }],
    } });
    expect(unsupported).toMatchObject({ ok: true });
    expect(await call()).toMatchObject({ ok: false, error: { code: 'model_api_key_unsupported' } });
    expect(await client.request({ type: 'list_session_runs', input: { sessionId: created.data.sessionId, limit: 10 } }))
      .toMatchObject({ ok: true, data: { items: [] } });
  } finally {
    if (previousKey === undefined) delete process.env.DEEPSEEK_API_KEY;
    else process.env.DEEPSEEK_API_KEY = previousKey;
    await client.close();
  }
});

it('wires the real Host Agent path, rejects stale model state after credential lookup and continues native history per Session', async () => {
  const repoRoot = resolve(import.meta.dir, '../..');
  const userDataRoot = await mkdtemp(join(tmpdir(), 'flowmate-host-agent-'));
  const requestBodies: Array<{ body: { messages?: Array<{ role: string; content?: unknown }>; tools?: unknown[] }; authorization: string | null }> = [];
  const replies = ['发票 INV-2048，价税合计 1060 元。', '上文发票的价税合计是 1060 元。'];
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      requestBodies.push({ body: await request.json(), authorization: request.headers.get('authorization') });
      const content = replies[requestBodies.length - 1] ?? 'fixture reply';
      const chunk = (delta: Record<string, unknown>, finishReason: string | null = null) =>
        `data: ${JSON.stringify({ id: `host-agent-${requestBodies.length}`, object: 'chat.completion.chunk', created: 1, model: 'host-agent-fixture', choices: [{ index: 0, delta, finish_reason: finishReason }] })}\n\n`;
      return new Response(`${chunk({ role: 'assistant', content })}${chunk({}, 'stop')}data: [DONE]\n\n`, {
        headers: { 'content-type': 'text/event-stream' },
      });
    },
  });
  const client = new HostClient();
  const finished: Array<{ runId: number; result: unknown }> = [];
  const credentialRequests: string[] = [];
  client.setCredentialHandler(async (request) => {
    credentialRequests.push(request.operation);
    return request.operation === 'read'
      ? { ok: true, credential: { type: 'api_key', key: 'synthetic-host-agent-key' } }
      : { ok: false };
  });
  client.subscribe((event) => {
    if (event.type === 'agent_run_event' && event.value.type === 'run_finished') {
      finished.push({ runId: event.value.runId, result: event.value.result });
    }
  });
  try {
    const started = await client.start(userDataRoot, '0.1.0', repoRoot);
    expect(started.ok).toBe(true);
    if (!started.ok) return;

    const profile = { id: 'fixture-model', credentialRef: 'credential_reference_1234', name: 'Fixture', kind: 'custom' as const,
      providerId: null, baseUrl: `http://127.0.0.1:${server.port}/v1`, model: 'host-agent-fixture', api: 'openai-completions',
      contextWindow: 64_000, maxTokens: 16_384, reasoning: false };
    const initialSettings = {
      version: 2 as const,
      revision: 0,
      profile: { displayName: 'Host Agent Test', theme: 'system' as const },
      models: [profile],
      defaultModelId: 'fixture-model',
      updatedAt: '2026-09-24T00:00:00.000Z',
    };
    const saved = await client.request({
      type: 'save_settings',
      settings: initialSettings,
    }) as { ok: boolean; data?: { revision: number } };
    expect(saved).toMatchObject({ ok: true, data: { revision: 1 } });

    const createCommand = { type: 'create_session' as const, requestId: 'primary-session-create', input: {} };
    const created = await client.request(createCommand) as { ok: boolean; data?: { sessionId: number } };
    expect(created.ok).toBe(true);
    if (!created.ok || !created.data) return;
    const workspaceBound = await client.request({
      type: 'update_workspace', requestId: 'bind-primary-session',
      input: { expectedRevision: 0, change: { kind: 'session', sessionId: created.data.sessionId } },
    }) as { ok: boolean; data?: { revision: number; sessionId: number } };
    expect(workspaceBound).toMatchObject({ ok: true, data: { revision: 1, sessionId: created.data.sessionId } });
    const workspace = { revision: 1, documentRef: null, jobId: null, candidateRef: null, sessionId: created.data.sessionId };
    const duplicateCreate = await client.request(createCommand) as { ok: boolean; error?: { code: string } };
    expect(duplicateCreate).toMatchObject({ ok: false, error: { code: 'request_duplicate' } });
    expect(await client.request({ type: 'list_sessions', input: { limit: 10 } })).toMatchObject({ ok: true, data: { items: [{ sessionId: created.data.sessionId }] } });
    expect(requestBodies).toHaveLength(0);
    expect(await client.request({ type: 'query_runtime_state' })).toMatchObject({ ok: true, data: { active: null } });

    // Model the Main-process race: it read revision 1, yielded while reading the
    // protected credential, and settings advanced before start_run reached Host.
    const updated = await client.request({
      type: 'save_settings',
      settings: { ...initialSettings, revision: 1, models: [{ ...profile, name: 'Changed during credential lookup' }] },
    }) as { ok: boolean; data?: { revision: number } };
    expect(updated).toMatchObject({ ok: true, data: { revision: 2 } });

    const stale = await client.request({
      type: 'start_run', requestId: 'stale-agent-run',
      input: { sessionId: created.data.sessionId, text: 'stale config must not dispatch', modelId: 'fixture-model', workspace, goalMode: 'answer' },
      expectedSettingsRevision: saved.data?.revision ?? 1, expectedCredentialRef: 'credential_reference_1234',
    }) as { ok: boolean; error?: { code: string } };
    expect(stale).toMatchObject({ ok: false, error: { code: 'state_conflict' } });
    expect(requestBodies).toHaveLength(0);

    const firstPending = client.request({
      type: 'start_run', requestId: 'first-agent-run',
      input: { sessionId: created.data.sessionId, text: '發票摘要：號碼 INV-2048，價稅合計 1060 元，日期缺失。', modelId: 'fixture-model', workspace, goalMode: 'answer' },
      expectedSettingsRevision: updated.data?.revision ?? 2, expectedCredentialRef: 'credential_reference_1234',
    }, 30_000) as Promise<{ ok: boolean; data?: { runId: number; sessionId: number } }>;
    const first = await firstPending;
    expect(first).toMatchObject({ ok: true, data: { runId: 1, sessionId: created.data.sessionId } });
    await waitFor(() => finished.some((event) => event.runId === 1));
    const duplicateStart = await client.request({
      type: 'start_run', requestId: 'first-agent-run',
      input: { sessionId: created.data.sessionId, text: 'must not replay a completed Run', modelId: 'fixture-model', workspace, goalMode: 'answer' },
      expectedSettingsRevision: updated.data?.revision ?? 2, expectedCredentialRef: 'credential_reference_1234',
    }) as { ok: boolean; error?: { code: string } };
    expect(duplicateStart).toMatchObject({ ok: false, error: { code: 'request_duplicate' } });
    expect(requestBodies).toHaveLength(1);

    const second = await client.request({
      type: 'start_run', requestId: 'follow-up-agent-run',
      input: { sessionId: created.data.sessionId, text: '剛才那張發票的價稅合計是多少？', modelId: 'fixture-model', workspace, goalMode: 'answer' },
      expectedSettingsRevision: updated.data?.revision ?? 2, expectedCredentialRef: 'credential_reference_1234',
    }) as { ok: boolean; data?: { runId: number; sessionId: number } };
    expect(second).toMatchObject({ ok: true, data: { runId: 2, sessionId: created.data.sessionId } });
    await waitFor(() => finished.some((event) => event.runId === 2));

    expect(finished.map((event) => event.runId)).toEqual([1, 2]);
    expect(finished[0].result).toMatchObject({ ok: true, data: { status: 'completed', text: replies[0] } });
    expect(finished[1].result).toMatchObject({ ok: true, data: { status: 'completed', text: replies[1] } });
    expect(requestBodies).toHaveLength(2);
    expect(requestBodies.every(({ authorization }) => authorization === 'Bearer synthetic-host-agent-key')).toBe(true);
    expect(credentialRequests).toContain('read');
    expect(requestBodies.map(({ body }) => (body.tools ?? []).map((tool) =>
      (tool as { function?: { name?: string } }).function?.name).sort())).toEqual([
      ['calculate_invoice_amounts', 'normalize_invoice_values'],
      ['calculate_invoice_amounts', 'normalize_invoice_values'],
    ]);
    expect(JSON.stringify(requestBodies[0].body.messages)).toContain('INV-2048');
    expect(JSON.stringify(requestBodies[1].body.messages)).toContain('INV-2048');
    expect(JSON.stringify(requestBodies[1].body.messages)).toContain(replies[0]);
    expect(JSON.stringify(requestBodies[1].body.messages)).toContain('價稅合計是多少');

    const trace = await client.request({ type: 'query_prompt_trace', runId: 2, callSequence: 1 }) as {
      ok: boolean;
      data?: { availability: string; droppedCalls: number | null; calls: Array<{ runId: number; sessionId: number; callSequence: number; state: string; entries: Array<{ event: string; summary: string }> }> };
    };
    expect(trace).toMatchObject({ ok: true, data: { availability: 'available', calls: [{ runId: 2, sessionId: created.data.sessionId, callSequence: 1, state: 'ended' }] } });
    expect(trace.data?.calls[0].entries.map((entry) => entry.event)).toContain('model_request');
    expect(trace.data?.calls[0].entries.map((entry) => entry.event)).toContain('native_terminal');
    const traceText = JSON.stringify(trace.data);
    expect(traceText).not.toContain('Invoice summary');
    expect(traceText).not.toContain(replies[1]);

    const runs = await client.request({ type: 'list_session_runs', input: { sessionId: created.data.sessionId, limit: 10 } });
    expect(runs).toMatchObject({ ok: true, data: { items: [
      { runId: 2, kind: 'agent', status: 'completed', sessionId: created.data.sessionId },
      { runId: 1, kind: 'agent', status: 'completed', sessionId: created.data.sessionId },
    ] } });

    const renamed = await client.request({ type: 'rename_session', requestId: 'rename-primary-session',
      input: { sessionId: created.data.sessionId, title: 'Renamed invoice session' } });
    expect(renamed).toMatchObject({ ok: true, data: { sessionId: created.data.sessionId, title: 'Renamed invoice session' } });
    const other = await client.request({ type: 'create_session', requestId: 'other-session-create', input: { title: 'Other Session' } }) as { ok: boolean; data?: { sessionId: number } };
    expect(other.ok).toBe(true);
    if (!other.data) return;
    const deleted = await client.request({ type: 'delete_session', requestId: 'delete-other-session', sessionId: other.data.sessionId });
    expect(deleted).toEqual({ ok: true, data: { deletedSessionId: other.data.sessionId, disposition: 'permanent' } });
    expect(await client.request({ type: 'query_session', sessionId: created.data.sessionId })).toMatchObject({ ok: true, data: { sessionId: created.data.sessionId } });
    expect(await client.request({ type: 'query_session', sessionId: other.data.sessionId })).toMatchObject({ ok: false, error: { code: 'session_not_found' } });
    expect(await client.request({ type: 'query_run', runId: 1 })).toMatchObject({ ok: true, data: { kind: 'agent', sessionId: created.data.sessionId } });
    expect(await client.request({ type: 'query_prompt_trace', runId: 2, callSequence: 1 })).toMatchObject({ ok: true, data: { availability: 'available' } });
    expect(await client.request({ type: 'list_sessions', input: { limit: 10 } })).toMatchObject({ ok: true, data: { items: [{ sessionId: created.data.sessionId }] } });
  } finally {
    const child = (client as unknown as { child: ChildProcessWithoutNullStreams }).child;
    await client.close();
    if (child && child.exitCode === null) {
      child.kill();
      await Promise.race([once(child, 'exit'), new Promise((resolveExit) => setTimeout(resolveExit, 1_000))]);
    }
    server.stop(true);
  }
}, 30_000);

it('queries real Pi messages through Host across tool delivery, model changes, Session isolation and restart', async () => {
  const repoRoot = resolve(import.meta.dir, '../..');
  const userDataRoot = await mkdtemp(join(tmpdir(), 'flowmate-host-p4-messages-'));
  type WireMessage = { role: string; content?: unknown; tool_call_id?: string };
  const requests: Array<{ model: string; messages: WireMessage[] }> = [];
  const callId = 'call-p4-host-1';
  const args = { operation: 'tax', netAmount: '100', taxRate: '13', scale: 2 };
  const reply = '精确税额是 13.00 元。';
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    const body = await request.json() as typeof requests[number];
    requests.push(body);
    const chunk = (delta: Record<string, unknown>, finishReason: string | null = null) =>
      `data: ${JSON.stringify({ id: `p4-host-${requests.length}`, object: 'chat.completion.chunk', created: 1,
        model: body.model, choices: [{ index: 0, delta, finish_reason: finishReason }] })}\n\n`;
    const stream = requests.length === 1
      ? `${chunk({ role: 'assistant', tool_calls: [{ index: 0, id: callId, type: 'function',
        function: { name: 'calculate_invoice_amounts', arguments: JSON.stringify(args) } }] })}${chunk({}, 'tool_calls')}`
      : `${chunk({ role: 'assistant', content: reply })}${chunk({}, 'stop')}`;
    return new Response(`${stream}data: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } });
  } });
  const clients: HostClient[] = [];
  const finished: Array<{ runId: number; result: unknown }> = [];
  const upserts: Array<{ runId: number; sessionId: number; message: SessionMessageView }> = [];
  const credentials: string[] = [];
  const newClient = () => {
    const client = new HostClient();
    clients.push(client);
    client.setCredentialHandler(async (request) => {
      credentials.push(request.operation);
      return request.operation === 'read' ? { ok: true, credential: { type: 'api_key', key: 'synthetic-p4-host-key' } } : { ok: false };
    });
    client.subscribe((event) => {
      if (event.type !== 'agent_run_event') return;
      if (event.value.type === 'run_finished') finished.push({ runId: event.value.runId, result: event.value.result });
      if (event.value.type === 'message_upsert') upserts.push({ runId: event.value.runId, sessionId: event.value.sessionId, message: event.value.message });
    });
    return client;
  };
  const client = newClient();
  try {
    expect((await client.start(userDataRoot, '0.1.0', repoRoot)).ok).toBe(true);
    const created = await client.request({ type: 'create_session', requestId: 'p4-primary', input: { title: 'Tax discussion' } }) as Result<{ sessionId: number }>;
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const sessionId = created.data.sessionId;
    expect(await client.request({ type: 'list_session_messages', input: { sessionId, limit: 20 } }))
      .toMatchObject({ ok: true, data: { items: [], leafId: null, entryCount: 0 } });
    const profile = { id: 'p4-model-a', credentialRef: 'p4_host_credential_ref_a', name: 'P4 A', kind: 'custom' as const,
      providerId: null, baseUrl: `http://127.0.0.1:${server.port}/v1`, model: 'host-p4-model-a', api: 'openai-completions',
      contextWindow: 64_000, maxTokens: 16_384, reasoning: false };
    const alternate = { ...profile, id: 'p4-model-b', credentialRef: 'p4_host_credential_ref_b', name: 'P4 B', model: 'host-p4-model-b' };
    expect(await client.request({ type: 'save_settings', settings: { version: 2, revision: 0,
      profile: { displayName: 'P4 messages', theme: 'system' }, models: [profile, alternate], defaultModelId: profile.id,
      updatedAt: '2026-09-30T00:00:00.000Z' } })).toMatchObject({ ok: true, data: { revision: 1 } });
    expect(await client.request({ type: 'update_workspace', requestId: 'p4-bind-primary',
      input: { expectedRevision: 0, change: { kind: 'session', sessionId } } })).toMatchObject({ ok: true, data: { revision: 1 } });
    const workspace = { revision: 1, documentRef: null, jobId: null, candidateRef: null, sessionId };
    const firstText = '请计算 100 元按 13% 税率的税额，记住这是 P4_PRIMARY_ONLY。';
    const first = await client.request({ type: 'start_run', requestId: 'p4-run-first',
      input: { sessionId, text: firstText, modelId: profile.id, workspace, goalMode: 'answer' },
      expectedSettingsRevision: 1, expectedCredentialRef: profile.credentialRef }) as Result<{ runId: number }>;
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    await waitFor(() => finished.some((event) => event.runId === first.data.runId));
    expect(finished.find((event) => event.runId === first.data.runId)?.result).toMatchObject({ ok: true, data: { status: 'completed', text: reply } });
    expect(requests).toHaveLength(2);
    const toolWire = requests[1]!.messages.find((message) => message.role === 'tool');
    expect(toolWire?.tool_call_id).toBe(callId);
    expect(JSON.parse(String(toolWire?.content))).toMatchObject({ operation: 'tax', exact: '13', rounded: '13.00', scale: 2 });
    const firstPage = await client.request({ type: 'list_session_messages', input: { sessionId, limit: 100 } }) as Result<SessionMessagesPage>;
    expect(firstPage.ok).toBe(true);
    if (!firstPage.ok) return;
    expect(firstPage.data.items.map((message) => message.role)).toEqual(['user', 'assistant', 'toolResult', 'assistant']);
    expect(firstPage.data.items.every((message) => message.runId === first.data.runId && message.entryId !== null && message.liveOrdinal !== null
      && message.phase === 'ended' && message.persistence === 'saved' && SessionMessageViewSchema.safeParse(message).success)).toBe(true);
    expect(firstPage.data.items[0]).toMatchObject({ textOrigin: 'product-input', blocks: [{ type: 'text', text: firstText }] });
    expect(firstPage.data.items[1]).toMatchObject({ blocks: [{ type: 'toolCall', id: callId, name: 'calculate_invoice_amounts' }] });
    expect(firstPage.data.items[2]).toMatchObject({ toolCallId: callId, toolName: 'calculate_invoice_amounts', isError: false });
    const firstSaved = upserts.filter((event) => event.runId === first.data.runId && event.message.persistence === 'saved');
    expect(new Set(firstSaved.map((event) => event.message.entryId)).size).toBe(4);
    for (const message of firstPage.data.items) expect(firstSaved).toContainEqual({ runId: first.data.runId, sessionId, message });
    const noQueryRequests = requests.length;
    const noQueryCredentials = credentials.length;
    expect(await client.request({ type: 'list_session_messages', input: { sessionId, limit: 100 } })).toEqual(firstPage);
    expect(requests).toHaveLength(noQueryRequests);
    expect(credentials).toHaveLength(noQueryCredentials);

    const secondText = '为什么这个税额是 13 元？沿用上一轮记忆回答。';
    const second = await client.request({ type: 'start_run', requestId: 'p4-run-switch-model',
      input: { sessionId, text: secondText, modelId: alternate.id, workspace, goalMode: 'answer' },
      expectedSettingsRevision: 1, expectedCredentialRef: alternate.credentialRef }) as Result<{ runId: number }>;
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    await waitFor(() => finished.some((event) => event.runId === second.data.runId));
    expect(requests).toHaveLength(3);
    expect(requests[2]!.model).toBe(alternate.model);
    expect(JSON.stringify(requests[2]!.messages)).toContain('P4_PRIMARY_ONLY');
    expect(JSON.stringify(requests[2]!.messages)).toContain(reply);
    expect(requests[2]!.messages.filter((message) => message.role === 'user')).toHaveLength(2);
    expect(requests[2]!.messages.filter((message) => message.role === 'tool')).toHaveLength(1);
    expect(await client.request({ type: 'query_run', runId: second.data.runId })).toMatchObject({ ok: true,
      data: { config: { requestedModel: { model: alternate.model }, resolvedModel: { model: alternate.model } } } });
    const all = await client.request({ type: 'list_session_messages', input: { sessionId, limit: 100 } }) as Result<SessionMessagesPage>;
    expect(all.ok).toBe(true);
    if (!all.ok) return;
    expect(all.data.items).toHaveLength(6);
    expect(all.data.items.slice(0, 4)).toEqual(firstPage.data.items);
    expect(all.data.items.slice(4).map((message) => message.runId)).toEqual([second.data.runId, second.data.runId]);
    const recent = await client.request({ type: 'list_session_messages', input: { sessionId, limit: 2 } }) as Result<SessionMessagesPage>;
    expect(recent.ok).toBe(true);
    if (!recent.ok) return;
    expect(recent.data.items).toEqual(all.data.items.slice(4));
    expect(recent.data.nextBeforeEntryId).toBe(recent.data.items[0]!.entryId);
    const older = await client.request({ type: 'list_session_messages', input: { sessionId,
      beforeEntryId: recent.data.nextBeforeEntryId!, limit: 100 } }) as Result<SessionMessagesPage>;
    expect(older).toMatchObject({ ok: true, data: { items: firstPage.data.items, nextBeforeEntryId: null } });

    const other = await client.request({ type: 'create_session', requestId: 'p4-other', input: { title: 'Other tax discussion' } }) as Result<{ sessionId: number }>;
    expect(other.ok).toBe(true);
    if (!other.ok) return;
    expect(await client.request({ type: 'update_workspace', requestId: 'p4-bind-other',
      input: { expectedRevision: 1, change: { kind: 'session', sessionId: other.data.sessionId } } })).toMatchObject({ ok: true, data: { revision: 2 } });
    const isolated = await client.request({ type: 'start_run', requestId: 'p4-run-other', input: { sessionId: other.data.sessionId,
      text: 'P4_OTHER_ONLY 独立对话', modelId: alternate.id, workspace: { ...workspace, revision: 2, sessionId: other.data.sessionId }, goalMode: 'answer' },
      expectedSettingsRevision: 1, expectedCredentialRef: alternate.credentialRef }) as Result<{ runId: number }>;
    expect(isolated.ok).toBe(true);
    if (!isolated.ok) return;
    await waitFor(() => finished.some((event) => event.runId === isolated.data.runId));
    expect(requests).toHaveLength(4);
    expect(JSON.stringify(requests[3]!.messages)).not.toContain('P4_PRIMARY_ONLY');
    expect(requests[3]!.messages.filter((message) => message.role === 'user')).toHaveLength(1);
    const otherPage = await client.request({ type: 'list_session_messages', input: { sessionId: other.data.sessionId, limit: 100 } }) as Result<SessionMessagesPage>;
    expect(otherPage).toMatchObject({ ok: true, data: { items: [{ role: 'user', runId: isolated.data.runId }, { role: 'assistant', runId: isolated.data.runId }] } });
    expect(await client.request({ type: 'list_session_messages', input: { sessionId, limit: 100 } })).toEqual(all);

    expect(await client.close()).toMatchObject({ ok: true, data: { closed: true } });
    const databaseFile = join(userDataRoot, 'data', 'app.sqlite');
    const savedDb = new Database(databaseFile, { readonly: true });
    const savedRows = savedDb.query('SELECT session_id,sequence,entry_id,entry_json,run_id FROM session_native_entries ORDER BY session_id,sequence').all();
    const savedHeads = savedDb.query('SELECT * FROM session_native_history ORDER BY session_id').all();
    expect(savedDb.query('SELECT native_tool_call_id,status,delivery_json FROM tool_calls').all()).toEqual([{ native_tool_call_id: callId, status: 'succeeded',
      delivery_json: expect.stringContaining('"state":"request_observed"') }]);
    expect(savedDb.query('SELECT COUNT(*) AS count FROM tool_calls').get()).toEqual({ count: 1 });
    expect(savedDb.query('SELECT entry_id FROM session_native_entries WHERE run_id=? AND json_extract(entry_json,\'$.type\')=\'message\' ORDER BY sequence')
      .all(first.data.runId)).toEqual(firstPage.data.items.map((message) => ({ entry_id: message.entryId })));
    expect(savedDb.query('PRAGMA foreign_key_check').all()).toEqual([]);
    savedDb.close();
    const restarted = newClient();
    expect((await restarted.start(userDataRoot, '0.1.0', repoRoot)).ok).toBe(true);
    const beforeRead = { requests: requests.length, credentials: credentials.length, events: upserts.length };
    const recovered = await restarted.request({ type: 'list_session_messages', input: { sessionId, limit: 100 } }) as Result<SessionMessagesPage>;
    expect(recovered.ok).toBe(true);
    if (!recovered.ok) return;
    expect(recovered.data.items).toEqual(all.data.items.map((message) => ({ ...message, liveOrdinal: null })));
    expect(recovered.data.leafId).toBe(all.data.leafId);
    expect(recovered.data.session).toMatchObject({ availability: 'ready', historyState: 'recoverable' });
    expect(await restarted.request({ type: 'list_session_messages', input: { sessionId: other.data.sessionId, limit: 100 } }))
      .toMatchObject({ ok: true, data: { items: [{ runId: isolated.data.runId, liveOrdinal: null }, { runId: isolated.data.runId, liveOrdinal: null }] } });
    expect({ requests: requests.length, credentials: credentials.length, events: upserts.length }).toEqual(beforeRead);
    expect(await restarted.close()).toMatchObject({ ok: true, data: { closed: true } });
    const unchanged = new Database(databaseFile, { readonly: true });
    try {
      expect(unchanged.query('SELECT session_id,sequence,entry_id,entry_json,run_id FROM session_native_entries ORDER BY session_id,sequence').all()).toEqual(savedRows);
      expect(unchanged.query('SELECT * FROM session_native_history ORDER BY session_id').all()).toEqual(savedHeads);
      expect(unchanged.query('SELECT COUNT(*) AS count FROM tool_calls').get()).toEqual({ count: 1 });
    } finally { unchanged.close(); }
    const resumed = newClient();
    expect((await resumed.start(userDataRoot, '0.1.0', repoRoot)).ok).toBe(true);
    expect(await resumed.request({ type: 'update_workspace', requestId: 'p4-restore-workspace',
      input: { expectedRevision: 2, change: { kind: 'session', sessionId } } })).toMatchObject({ ok: true, data: { revision: 3 } });
    const resumedRun = await resumed.request({ type: 'start_run', requestId: 'p4-resumed-run', input: { sessionId,
      text: '恢复后再解释 P4_RESUME_ONLY。', modelId: alternate.id, workspace: { ...workspace, revision: 3 }, goalMode: 'answer' },
      expectedSettingsRevision: 1, expectedCredentialRef: alternate.credentialRef }) as Result<{ runId: number }>;
    expect(resumedRun.ok).toBe(true);
    if (!resumedRun.ok) return;
    await waitFor(() => finished.some((event) => event.runId === resumedRun.data.runId));
    expect(finished.find((event) => event.runId === resumedRun.data.runId)?.result).toMatchObject({ ok: true, data: { status: 'completed' } });
    expect(requests).toHaveLength(5);
    expect(JSON.stringify(requests[4]!.messages)).toContain('P4_PRIMARY_ONLY');
    expect(JSON.stringify(requests[4]!.messages)).not.toContain('P4_OTHER_ONLY');
    expect(JSON.stringify(requests[4]!.messages)).toContain('P4_RESUME_ONLY');
    expect(requests[4]!.messages.filter((message) => message.role === 'tool')).toHaveLength(1);
    expect(requests[4]!.messages.filter((message) => message.role === 'user')).toHaveLength(3);
    const resumedPage = await resumed.request({ type: 'list_session_messages', input: { sessionId, limit: 100 } }) as Result<SessionMessagesPage>;
    expect(resumedPage.ok).toBe(true);
    if (!resumedPage.ok) return;
    expect(resumedPage.data.items.slice(0, 6)).toEqual(all.data.items.map((message) => ({ ...message, liveOrdinal: null })));
    expect(resumedPage.data.items.slice(6).map((message) => [message.runId, message.liveOrdinal])).toEqual([
      [resumedRun.data.runId, 1], [resumedRun.data.runId, 2],
    ]);
    expect(await resumed.close()).toMatchObject({ ok: true, data: { closed: true } });
  } finally {
    for (const active of clients) await active.close();
    server.stop(true);
  }
}, 30_000);

async function waitFor(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!check() && Date.now() < deadline) await new Promise((resolveWait) => setTimeout(resolveWait, 10));
  expect(check()).toBe(true);
}
