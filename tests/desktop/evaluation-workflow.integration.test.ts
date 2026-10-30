import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { EvaluationClient } from '../../apps/desktop/main/evaluation-client.ts';
import { mkdtempSync } from '../support/resources.ts';
import { createCurationService } from '../../agent-eval/src/curation/index.ts';
import { readTraceState, traceFile } from '../../agent-eval/src/curation/store.ts';

const repository = resolve(import.meta.dir, '../..');

test('the desktop workflow persists independent opt-in switches through the real Worker without executing models', async () => {
  const root = mkdtempSync(join(tmpdir(), 'evaluation-workflow-'));
  const config = join(root, 'agent-eval/configs'); mkdirSync(config, { recursive: true });
  writeFileSync(join(config, '.env'), [
    'FLOWMATE_EVAL_AGENT_BASE_URL=https://synthetic.invalid/v1',
    'FLOWMATE_EVAL_AGENT_MODEL=synthetic-agent', 'FLOWMATE_EVAL_AGENT_API_KEY=synthetic-private-agent-key',
    'FLOWMATE_JUDGE_PROVIDER=codex-cli', 'JUDGE_MODEL=gpt-6.1-terra',
    'MINING_PROVIDER=codex-cli', 'MINING_MODEL=gpt-6-luna',
  ].join('\n'));
  const client = new EvaluationClient(repository, root);
  try {
    expect(Reflect.get(client, 'workflow')).toBeFunction();
    const initial = await client.workflow({ action: 'settings.get' });
    expect(initial).toMatchObject({ ok: true, data: { action: 'settings.get', exitCode: 0,
      data: { settings: { capture: false, upload: false, mining: false } } } });
    expect(JSON.stringify(initial)).not.toContain('synthetic-private-agent-key');
    const saved = await client.workflow({ action: 'settings.save', settings: { capture: true, upload: false, mining: false } });
    expect(saved).toMatchObject({ ok: true, data: { exitCode: 0, data: { settings: { capture: true, upload: false, mining: false } } } });
    expect(await client.workflow({ action: 'settings.get' })).toMatchObject({ ok: true,
      data: { data: { settings: { capture: true, upload: false, mining: false } } } });
    expect(existsSync(join(root, 'agent-eval/runs'))).toBe(false);
    expect(existsSync(join(root, 'agent-eval/traces'))).toBe(false);
    expect(readFileSync(join(config, '.env'), 'utf8')).toContain('synthetic-private-agent-key');
  } finally { expect(await client.close()).toMatchObject({ ok: true, data: { closed: true, stopped: true } }); }
});

test('malformed workflow actions are rejected before starting the Worker', async () => {
  const root = mkdtempSync(join(tmpdir(), 'evaluation-workflow-input-'));
  const client = new EvaluationClient(repository, root);
  try {
    expect(Reflect.get(client, 'workflow')).toBeFunction();
    expect(await client.workflow({ action: 'settings.save', settings: { capture: true } }))
      .toMatchObject({ ok: false, error: { code: 'input_invalid' } });
    expect(Reflect.get(client, 'child')).toBeNull();
    expect(existsSync(join(root, 'agent-eval'))).toBe(false);
  } finally { await client.close(); }
});

test('captured Trace processing runs in the fixed Worker without a renderer and reuses its recorded operations', async () => {
  const root = mkdtempSync(join(tmpdir(), 'evaluation-capture-process-'));
  const traceId = '00000000-0000-4000-8000-000000000002';
  createCurationService(root).saveTrace({ id: traceId, revision: 1, source: { kind: 'product', runId: 'synthetic-run' }, entry: 'chats',
    startedAt: '2026-10-28T00:00:00.000Z', endedAt: '2026-10-28T00:00:01.000Z', input: { prompt: 'Original input' },
    output: 'Original output', status: 'completed', complete: true, gaps: [], configuration: {}, events: [], facts: {}, materials: [] });
  const client = new EvaluationClient(repository, root);
  try {
    await client.workflow({ action: 'settings.save', settings: { capture: true, upload: true, mining: false } });
    expect(Reflect.get(client, 'enqueueTrace')).toBeFunction();
    client.enqueueTrace(traceId);
    const processing = () => readTraceState(root, traceId).operations.processing?.['1'];
    for (let attempt = 0; attempt < 50 && processing() === undefined; attempt++) await new Promise(done => setTimeout(done, 20));
    expect(processing()).toBeDefined(); expect(traceFile(root, traceId)).toMatch(/Trace-.+\.json$/);
    const first = processing(); client.enqueueTrace(traceId);
    const state = await client.workflow({ action: 'settings.get' });
    expect(state).toMatchObject({ ok: true, data: { data: { settings: { upload: true, mining: false } } } });
    expect(processing()).toEqual(first);
    expect(existsSync(join(root, 'agent-eval/src/datasets/gold-candidates'))).toBe(false);
  } finally { expect(await client.close()).toMatchObject({ ok: true, data: { closed: true, stopped: true } }); }
});
