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
  client.subscribe((event) => {
    if (event.type === 'agent_run_event' && event.value.type === 'run_finished') {
      finished.push({ runId: event.value.runId, result: event.value.result });
    }
  });
  try {
    const started = await client.start(userDataRoot, '0.1.0', repoRoot);
    expect(started.ok).toBe(true);
    if (!started.ok) return;

    const profile = { id: 'fixture-model', credentialRef: 'credential_reference_1234', name: 'Fixture', baseUrl: `http://127.0.0.1:${server.port}/v1`, model: 'host-agent-fixture', api: 'openai-completions' as const };
    const initialSettings = {
      version: 1 as const,
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
      apiKey: 'synthetic-host-agent-key', expectedSettingsRevision: saved.data?.revision ?? 1, expectedCredentialRef: 'credential_reference_1234',
    }) as { ok: boolean; error?: { code: string } };
    expect(stale).toMatchObject({ ok: false, error: { code: 'state_conflict' } });
    expect(requestBodies).toHaveLength(0);

    const firstPending = client.request({
      type: 'start_run', requestId: 'first-agent-run',
      input: { sessionId: created.data.sessionId, text: '發票摘要：號碼 INV-2048，價稅合計 1060 元，日期缺失。', modelId: 'fixture-model', workspace, goalMode: 'answer' },
      apiKey: 'synthetic-host-agent-key', expectedSettingsRevision: updated.data?.revision ?? 2, expectedCredentialRef: 'credential_reference_1234',
    }, 30_000) as Promise<{ ok: boolean; data?: { runId: number; sessionId: number } }>;
    const first = await firstPending;
    expect(first).toMatchObject({ ok: true, data: { runId: 1, sessionId: created.data.sessionId } });
    await waitFor(() => finished.some((event) => event.runId === 1));
    const duplicateStart = await client.request({
      type: 'start_run', requestId: 'first-agent-run',
      input: { sessionId: created.data.sessionId, text: 'must not replay a completed Run', modelId: 'fixture-model', workspace, goalMode: 'answer' },
      apiKey: 'synthetic-host-agent-key', expectedSettingsRevision: updated.data?.revision ?? 2, expectedCredentialRef: 'credential_reference_1234',
    }) as { ok: boolean; error?: { code: string } };
    expect(duplicateStart).toMatchObject({ ok: false, error: { code: 'request_duplicate' } });
    expect(requestBodies).toHaveLength(1);

    const second = await client.request({
      type: 'start_run', requestId: 'follow-up-agent-run',
      input: { sessionId: created.data.sessionId, text: '剛才那張發票的價稅合計是多少？', modelId: 'fixture-model', workspace, goalMode: 'answer' },
      apiKey: 'synthetic-host-agent-key', expectedSettingsRevision: updated.data?.revision ?? 2, expectedCredentialRef: 'credential_reference_1234',
    }) as { ok: boolean; data?: { runId: number; sessionId: number } };
    expect(second).toMatchObject({ ok: true, data: { runId: 2, sessionId: created.data.sessionId } });
    await waitFor(() => finished.some((event) => event.runId === 2));

    expect(finished.map((event) => event.runId)).toEqual([1, 2]);
    expect(finished[0].result).toMatchObject({ ok: true, data: { status: 'completed', text: replies[0] } });
    expect(finished[1].result).toMatchObject({ ok: true, data: { status: 'completed', text: replies[1] } });
    expect(requestBodies).toHaveLength(2);
    expect(requestBodies.every(({ authorization }) => authorization === 'Bearer synthetic-host-agent-key')).toBe(true);
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
    expect(deleted).toEqual({ ok: true, data: { deletedSessionId: other.data.sessionId } });
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

async function waitFor(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!check() && Date.now() < deadline) await new Promise((resolveWait) => setTimeout(resolveWait, 10));
  expect(check()).toBe(true);
}
