import { expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { ok, INVOICE_CHAT_GOAL } from '@flowmate/contracts';
import { researchFixture, researchNeed as need } from '../../support/research.ts';

it('injects current research layers into requests without appending page snapshots to native user history', async () => {
  const f = await researchFixture(() => ({ text: 'Research response.' }));
  const first = await f.run(f.request(1));
  expect(first.terminal.result.ok).toBe(true);
  const second = await f.run({ ...f.request(2), text: 'Now compare the evidence dates.' });
  expect(second.terminal.result.ok).toBe(true);
  const snapshots = need(await f.app.listContextSnapshots({ sessionId: f.session.sessionId }));
  const snapshot = need(await f.app.queryContextSnapshot({ sessionId: f.session.sessionId,
    runId: second.accepted.runId, snapshotId: snapshots.items[0]!.id }));
  need(await f.app.close());
  const db = new Database(f.paths.databaseFile, { readonly: true });
  try {
    const users = (db.query('SELECT entry_json FROM session_native_entries WHERE session_id=? ORDER BY sequence')
      .all(f.session.sessionId) as { entry_json: string }[]).map(row => JSON.parse(row.entry_json))
      .filter(entry => entry.type === 'message' && entry.message.role === 'user');
    expect(users.map(entry => entry.message.content)).toEqual([
      [{ type: 'text', text: 'Compare the deployment options.' }],
      [{ type: 'text', text: 'Now compare the evidence dates.' }],
    ]);
    expect(JSON.stringify(f.requests[1])).toContain('Current Flowmate request context');
    expect(snapshot.snapshot.json).toMatchObject({ layers: { version: 1 } });
  } finally { db.close(); }
});

it('keeps a conversation without invoice material free of the default invoice task goal', async () => {
  const f = await researchFixture(() => ({ text: 'General conversation response.' }));
  const session = need(await f.app.createSession({ title: 'General conversation' }));
  await f.run({ sessionId: session.sessionId, clientSequence: 1, mode: 'prompt', config: f.config,
    text: 'Explain how context layers work.', focus: { page: 'chats' } });
  expect(JSON.stringify(f.requests[0])).not.toContain(INVOICE_CHAT_GOAL);
  expect(JSON.stringify(f.requests[0])).toContain('Current Flowmate request context');
});

it('captures focus and preferences once per Run and rejects a foreign research focus', async () => {
  let preference = 'Prefer evidence dates.';
  const f = await researchFixture((_request, index) => {
    if (index === 1) {
      preference = 'Prefer explicit conflicts.';
      return { tool: 'read_research_local', id: 'preference-read', args: { artifactId: f.task.sourcePolicy.artifactIds[0], documentId: null } };
    }
    return { text: 'Preference fixture response.' };
  }, undefined, { material: 'Local policy.', researchPreferences: () => ok({ text: preference, revision: preference.includes('dates') ? 1 : 2 }) });
  const focus = { page: 'research' as const, researchId: f.task.researchId };
  await f.run({ ...f.request(1), focus });
  expect(JSON.stringify(f.requests[0])).toContain('Prefer evidence dates.');
  expect(JSON.stringify(f.requests[1])).toContain('Prefer evidence dates.');
  expect(JSON.stringify(f.requests[1])).not.toContain('Prefer explicit conflicts.');
  await f.run({ ...f.request(2), focus });
  expect(JSON.stringify(f.requests[2])).toContain('Prefer explicit conflicts.');
  const before = f.requests.length;
  expect(await f.app.submitInput({ ...f.request(3), focus: { page: 'research', researchId: f.task.researchId + 1 } }))
    .toMatchObject({ ok: false, error: { code: 'research_identity_conflict' } });
  expect(f.requests).toHaveLength(before);
});
