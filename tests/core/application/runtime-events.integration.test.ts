import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'bun:test';
import { createApplication } from '../../../apps/composition.ts';
import { deferCleanup, mkdtempSync } from '../../support/resources.ts';
import { appError, fail, RuntimeEventsReadResultSchema, RuntimeToolPageResultSchema } from '@flowmate/contracts';
import type { ProviderPort, ProviderRequest } from '@flowmate/contracts';

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'flowmate-p6-application-'));
  let requests = 0;
  const provider: ProviderPort = {
    async prepare() { requests++; return fail(appError('fixture_auth_rejected', 'provider', 'Controlled rejection.')); },
    async close() { return { stopped: true, closed: true, errors: [] }; },
  };
  const made = await createApplication({ paths: { root, databaseFile: join(root, 'data', 'app.sqlite'),
    logsDir: join(root, 'logs'), artifactsDir: join(root, 'artifacts'), outputsDir: join(root, 'outputs'),
    runtimeDir: join(root, 'runtime') }, provider, logger: { write() {}, async close() {} } });
  if (!made.ok) throw new Error(made.error.code);
  deferCleanup(() => made.data.close());
  const request: ProviderRequest = { goal: 'Observe controlled rejection', text: 'No network',
    timeoutMs: 1000, stopGraceMs: 100, config: { version: 1, name: 'fixture', revision: 1,
      modelRef: { provider: 'fixture', model: 'controlled' }, native: { authPath: join(root, 'unused-auth.json'), modelsPath: null },
      parameters: { maxRetries: 0, maxRetryDelayMs: 2000 } } };
  const outcome = await made.data.callProvider(request);
  if (!outcome.ok) throw new Error(outcome.error.code);
  return { app: made.data, runId: outcome.data.runId, requests: () => requests };
}

describe('P6 Application readonly event and tool assembly', () => {
  it('uses the assembled SQL event service and observes without executing another request', async () => {
    const f = await fixture();
    const input = { runId: f.runId, sessionId: null, cursor: { runId: f.runId, lastPersistedSequence: 0 } };
    const first = await f.app.queryRuntimeEvents(input);
    expect(first).toMatchObject({ ok: true, data: { runId: f.runId, sessionId: null } });
    expect(RuntimeEventsReadResultSchema.safeParse(first).success).toBe(true);
    const subscribed = await f.app.subscribeRuntimeEvents(input, () => {});
    expect(subscribed.ok).toBe(true);
    if (!subscribed.ok) return;
    expect(typeof subscribed.data.unsubscribe).toBe('function');
    expect(subscribed.data.runId).toBe(f.runId);
    subscribed.data.unsubscribe(); subscribed.data.unsubscribe();
    expect(await f.app.queryRuntimeEvents(input)).toEqual(first);
    expect(f.requests()).toBe(1);
    await f.app.close();
    expect(await f.app.subscribeRuntimeEvents(input, () => {})).toMatchObject({ ok: false,
      error: { code: 'event_subscription_invalid', category: 'input', retryable: false } });
  });

  it('returns an empty tool page for a real Provider Run and rejects mismatched ownership', async () => {
    const f = await fixture();
    const page = await f.app.listRunToolCalls({ runId: f.runId, sessionId: null });
    expect(page).toEqual({ ok: true, data: { items: [], nextBeforeId: null } });
    expect(RuntimeToolPageResultSchema.safeParse(page).success).toBe(true);
    expect(await f.app.listRunToolCalls({ runId: f.runId, sessionId: 99 })).toMatchObject({ ok: false,
      error: { code: 'state_conflict', category: 'runtime', retryable: false } });
    expect(await f.app.queryRunToolCall({ runId: f.runId, sessionId: 99, toolCallId: 1 })).toMatchObject({ ok: false,
      error: { code: 'state_conflict' } });
    expect(await f.app.listRunToolCalls({ runId: 999, sessionId: null })).toMatchObject({ ok: false,
      error: { code: 'run_not_found' } });
    expect(f.requests()).toBe(1);
  });
});
