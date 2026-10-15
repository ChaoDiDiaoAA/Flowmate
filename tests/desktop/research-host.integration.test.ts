import { defaultProductSettings } from '@flowmate/core';
import { expect, it } from 'bun:test';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { HostClient } from '../../apps/desktop/main/host-client.ts';
import { parseResearchHostResult, matchesResearchResponse } from '../../packages/contracts/src/research-commands.ts';
import { mkdtempSync, deferCleanup, waitFor } from '../support/resources.ts';
import { once } from 'node:events';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';

it('research imports, task lists and restored reads cross the actual Host without execution', async () => {
  const root = mkdtempSync(join(tmpdir(), 'flowmate-research-host-')), client = new HostClient();
  expect(await client.start(root, '0.1.0', resolve(import.meta.dir, '../..'))).toMatchObject({ ok: true, data: { ready: true } });
  try {
    const session = await client.request({ type: 'create_session', input: { title: 'Host research' } }) as any;
    expect(session.ok).toBe(true);
    expect(await client.request({ type: 'query_research_for_session', input: { sessionId: session.data.sessionId } })).toEqual({ ok: true, data: null });
    const material = await client.request({ type: 'import_research_material', input: { title: 'Team policy', format: 'text', text: 'Local deployments only.' } }) as any;
    expect(material.ok).toBe(true);
    expect(await client.request({ type: 'import_research_material', input: { title: 'Team policy', format: 'text', text: 'Local deployments only.' } })).toEqual(material);
    const revised = await client.request({ type: 'import_research_material', input: { title: 'Team policy', format: 'text', text: 'Remote deployments allowed.' } }) as any;
    expect(revised.ok).toBe(true); expect(revised.data.artifactId).not.toBe(material.data.artifactId);
    expect(await client.request({ type: 'import_research_material', input: { title: 'Team policy', format: 'text', text: 'Local deployments only.' } })).toEqual(material);
    const created = await client.request({ type: 'create_research_task', input: { sessionId: session.data.sessionId, title: 'Deployment research',
      sourcePolicy: { web: false, domains: [], artifactIds: [material.data.artifactId], documentIds: [] } } }) as any;
    expect(created.ok).toBe(true);
    expect(await client.request({ type: 'query_research_for_session', input: { sessionId: session.data.sessionId } })).toEqual(created);
    const command = { type: 'query_research_task' as const, input: { researchId: created.data.researchId } };
    const result = parseResearchHostResult(command.type, await client.request(command));
    expect(result).toEqual(created); expect(matchesResearchResponse(command, result)).toBe(true);
    expect(matchesResearchResponse({ ...command, input: { researchId: created.data.researchId + 1 } }, result)).toBe(false);
    expect(await client.request({ type: 'query_research_evidence', input: { researchId: created.data.researchId, sourceSnapshotId: 999 } })).toMatchObject({ ok: false });
    expect(await client.request({ type: 'query_runtime_state' })).toMatchObject({ ok: true, data: { active: null, blocked: false } });
  } finally { expect(await client.close()).toMatchObject({ ok: true }); }
});

it('recovers an interrupted research Run after an actual Host crash without replaying the model request', async () => {
  const root = mkdtempSync(join(tmpdir(), 'flowmate-research-crash-')), client = new HostClient();
  let requests = 0, release!: () => void;
  const held = new Promise<void>(resolveHeld => { release = resolveHeld; });
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch() {
    requests++; await held; return new Response('data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
  } });
  deferCleanup(() => { release(); server.stop(true); });
  client.setCredentialHandler(async () => ({ ok: true, credential: { type: 'api_key', key: 'synthetic-research-crash-key' } }));
  expect(await client.start(root, '0.1.0', resolve(import.meta.dir, '../..'))).toMatchObject({ ok: true });
  let failure: unknown, stage = 'configure';
  try {
    expect(await client.request({ type: 'save_settings', settings: {
      ...defaultProductSettings(), version: 6, revision: 0, profile: { displayName: 'Research crash fixture', theme: 'system' },
      models: [{ id: 'research-crash', credentialRef: '00000000000000000000000000000029', name: 'Research fixture', kind: 'custom', providerId: null,
        baseUrl: `http://127.0.0.1:${server.port}/v1`, model: 'research-crash', api: 'openai-completions', contextWindow: 64000, maxTokens: 4096, reasoning: false }],
      defaultModelId: 'research-crash', updatedAt: '2026-10-10T00:00:00.000Z' } })).toMatchObject({ ok: true });
    const session = await client.request({ type: 'create_session', input: { title: 'Interrupted research' } }) as any;
    const task = await client.request({ type: 'create_research_task', input: { sessionId: session.data.sessionId, title: 'Local research',
      sourcePolicy: { web: false, domains: [], artifactIds: [], documentIds: [] } } }) as any;
    expect(task.ok).toBe(true);
    const accepted = await client.request({ type: 'submit_session_input', input: { sessionId: session.data.sessionId, clientSequence: 1,
      mode: 'prompt', goalMode: 'answer', text: 'Plan this research.', modelId: 'research-crash', research: { researchId: task.data.researchId, phase: 'planning', plan: null } },
      expectedSettingsRevision: 1, expectedCredentialRef: '00000000000000000000000000000029' }) as any;
    expect(accepted.ok).toBe(true); await waitFor(async () => requests === 1);
    stage = 'crash';
    const child = Reflect.get(client, 'child') as ChildProcessWithoutNullStreams;
    const exited = once(child, 'exit'); child.kill(); await exited;
    // Production ownership lease expires after 15s; recovery must respect it.
    await new Promise(resolveWait => setTimeout(resolveWait, 15500));
    stage = 'restart';
    expect(await client.start(root, '0.1.0', resolve(import.meta.dir, '../..'))).toMatchObject({ ok: true, data: { ready: true } });
    stage = 'read recovered task';
    expect(await client.request({ type: 'query_research_task', input: { researchId: task.data.researchId } }))
      .toMatchObject({ ok: true, data: { status: 'interrupted', currentPlanId: null, currentRunId: accepted.data.runId } });
    stage = 'read recovered run';
    expect(await client.request({ type: 'query_run', runId: accepted.data.runId }))
      .toMatchObject({ ok: true, data: { status: 'failed', stoppedAt: null, error: { code: 'runtime_interrupted' } } });
    stage = 'read recovered sources';
    expect(await client.request({ type: 'list_research_sources', input: { researchId: task.data.researchId } }))
      .toMatchObject({ ok: true, data: { items: [] } });
    expect(requests).toBe(1);
  } catch (error) { failure = error; throw new Error(`${stage}: ${String(error)}`, { cause: error }); }
  finally { release(); const closed = await client.close(); if (!failure) expect(closed).toMatchObject({ ok: true }); }
}, 45000);
