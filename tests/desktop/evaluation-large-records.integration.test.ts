import { expect, test } from 'bun:test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync } from '../support/resources.ts';
import { createCurationService } from '../../agent-eval/src/curation/index.ts';
import { readTrace, traceFile } from '../../agent-eval/src/curation/store.ts';
import { EvaluationClient } from '../../apps/desktop/main/evaluation-client.ts';

const repository = resolve(import.meta.dirname, '../..');
const traceId = '00000000-0000-4000-8000-000000000031', candidateId = '00000000-0000-4000-8000-000000000032';
const large = ' 原始中文输入\n' + 'x'.repeat(5 * 1024 * 1024) + '\n 原始结尾 ';
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'evaluation-large-record-')), curation = createCurationService(root);
  curation.saveTrace({ id: traceId, revision: 1, source: { kind: 'product', runId: '1', productRoot: root }, entry: 'chats',
    startedAt: '2026-10-28T00:00:00.000Z', endedAt: '2026-10-28T00:00:01.000Z', input: { prompt: large },
    output: 'Original response', status: 'completed', complete: true, gaps: [], configuration: {}, events: [], facts: {}, materials: [] });
  curation.saveCandidate({ id: candidateId, revision: 1, kind: 'bad', traceRef: { id: traceId, revision: 1 },
    sourceLabels: ['controlled-frame-test'], reason: 'Controlled incomplete draft, not an approved benchmark', review: { originalMaterial: large } });
  writeFileSync(join(root, 'agent-eval/baselines.json'), JSON.stringify({ contract: 'flowmate-baselines/v1', records: [{ contract: 'flowmate-baseline/v1', id: 'controlled-baseline',
    createdAt: '2026-10-28T00:00:00.000Z', experimentId: 'controlled-experiment', armId: 'control', executionIds: ['controlled-execution'],
    plan: {}, conditions: [{ runtimeSource: { files: [{ path: 'controlled.ts', content: large }] } }], evidenceKind: 'controlled' }] }));
  return root;
}

for (const action of ['trace.list', 'candidate.list', 'baseline.list'] as const) test('real Worker bounds ' + action + ' while preserving large originals', async () => {
  const root = fixture(), client = new EvaluationClient(repository, root);
  try {
    const reply = await client.workflow({ action });
    expect(reply).toMatchObject({ ok: true, data: { action, data: { page: { total: 1, complete: true } } } });
    expect(Buffer.byteLength(JSON.stringify(reply))).toBeLessThan(1024 * 1024);
    expect(readFileSync(traceFile(root, traceId), 'utf8')).toContain(large.replaceAll('\n', '\\n'));
  } finally { expect(await client.close()).toMatchObject({ ok: true, data: { closed: true, stopped: true } }); }
}, 30_000);

test('real Worker reads every original character with stable chunk identity and rejects a changed source', async () => {
  const root = fixture(), client = new EvaluationClient(repository, root);
  try {
    const file = traceFile(root, traceId), original = readFileSync(file, 'utf8');
    let text = '', offset = 0, viewId: string | undefined;
    do {
      const reply = await client.workflow({ action: 'record.read', kind: 'trace', id: traceId, part: 'record', offset, limit: 32000, ...(viewId ? { viewId } : {}) });
      expect(reply.ok).toBe(true); if (!reply.ok || reply.data.action !== 'record.read') throw Error('Original chunk unavailable');
      const chunk = reply.data.data.record; expect(Buffer.byteLength(JSON.stringify(reply))).toBeLessThan(1024 * 1024);
      viewId ??= chunk.viewId; expect(chunk.viewId).toBe(viewId); expect(chunk.redacted).toBe(false);
      text += chunk.text; offset = chunk.page.nextOffset ?? -1;
    } while (offset !== -1);
    expect(text).toBe(original); expect(JSON.parse(text).input.prompt).toBe(large);
    writeFileSync(file, original.replace('Original response', 'Changed response'));
    expect(await client.workflow({ action: 'record.read', kind: 'trace', id: traceId, part: 'record', viewId, offset: 32000 }))
      .toMatchObject({ ok: false });
    expect(await client.workflow({ action: 'record.read', kind: 'trace', id: '../private', part: 'record' }))
      .toMatchObject({ ok: false, error: { code: 'input_invalid' } });
  } finally { await client.close(); }
}, 60_000);

test('summary pagination remains bound to its collection and never turns a page into an exhaustive list', async () => {
  const root = fixture(), client = new EvaluationClient(repository, root), curation = createCurationService(root);
  const original = readTrace(root, traceId);
  const secondId = '00000000-0000-4000-8000-000000000039';
  curation.saveTrace({ ...original, id: secondId, input: { prompt: 'Second original task' } });
  try {
    const first = await client.workflow({ action: 'trace.list', limit: 1 });
    if (!first.ok || first.data.action !== 'trace.list' || !first.data.data.viewId) throw Error('First summary page unavailable');
    expect(first.data.data.items.map(item => item.id)).toEqual([traceId]);
    expect(first.data.data.page).toMatchObject({ total: 2, complete: false, nextOffset: 1 });
    const next = await client.workflow({ action: 'trace.list', offset: 1, limit: 1, viewId: first.data.data.viewId });
    expect(next).toMatchObject({ ok: true, data: { data: { items: [{ id: secondId }], page: { total: 2, complete: true } } } });
    curation.saveTrace({ ...original, id: '00000000-0000-4000-8000-000000000040', input: { prompt: 'Later task' } });
    expect(await client.workflow({ action: 'trace.list', offset: 1, limit: 1, viewId: first.data.data.viewId })).toMatchObject({ ok: false });
  } finally { await client.close(); }
}, 30_000);
