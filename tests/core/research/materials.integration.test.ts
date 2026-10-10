import { expect, it } from 'bun:test';
import { join } from 'node:path';
import { writeFileSync, readdirSync } from 'node:fs';
import { researchFixture, researchNeed as need, researchPlan } from '../../support/research.ts';
import { deferCleanup } from '../../support/resources.ts';

it('keeps the selected invoice workspace separate and cannot read its document without explicit research selection', async () => {
  const f = await researchFixture((_request, index) => index === 1
    ? { tool: 'read_research_local', args: { artifactId: null, documentId: f.task.sourcePolicy.documentIds[0] }, id: 'unselected-invoice' }
    : { text: 'The invoice is outside this research scope.' }, undefined, { parsedDocument: 'Private invoice data.' });
  const invoiceSession = need(await f.app.createSession({ title: 'Invoice session' }));
  let workspace = need(await f.app.readWorkspace());
  workspace = need(await f.app.updateWorkspace({ expectedRevision: workspace.revision, change: { kind: 'session', sessionId: invoiceSession.sessionId } }));
  workspace = need(await f.app.updateWorkspace({ expectedRevision: workspace.revision, change: { kind: 'document', documentId: f.task.sourcePolicy.documentIds[0]! } }));
  const session = need(await f.app.createSession({ title: 'Independent research' }));
  const task = need(await f.app.createResearchTask({ sessionId: session.sessionId, title: 'No selected invoice', sourcePolicy: researchPlan.sourcePolicy }));
  await f.run({ ...f.request(1), sessionId: session.sessionId, research: { researchId: task.researchId, phase: 'planning', plan: null } });
  expect(need(await f.app.listResearchSources({ researchId: task.researchId })).items).toEqual([]);
  expect(JSON.stringify(f.requests.at(-1)!.messages)).toContain('research_source_denied');
  expect(JSON.stringify(f.requests.at(-1)!.messages)).not.toContain('Private invoice data.');
  expect(need(await f.app.readWorkspace())).toEqual(workspace);
});

it('reads an explicitly selected parsed document and revokes its ongoing research Session', async () => {
  let entered!: () => void, release!: () => void;
  const requested = new Promise<void>(resolve => { entered = resolve; }), held = new Promise<void>(resolve => { release = resolve; });
  deferCleanup(() => release());
  const f = await researchFixture(async (_request, index) => {
    if (index === 1) return { tool: 'read_research_local', args: { artifactId: null, documentId: f.task.sourcePolicy.documentIds[0] }, id: 'parsed-source' };
    entered(); await held; return { text: 'Late response.' };
  }, undefined, { parsedDocument: 'A selected parsed policy requires local deployment.' });
  const started = await f.start(f.request(1)); const accepted = need(started.accepted); await requested;
  const sources = need(await f.app.listResearchSources({ researchId: f.task.researchId })).items;
  expect(sources).toHaveLength(1); expect(sources[0]!.kind).toBe('document');
  expect(JSON.stringify(f.requests[1]!.messages)).toContain('A selected parsed policy requires local deployment.');
  expect(need(await f.app.revokeDocumentUse(f.task.sourcePolicy.documentIds[0]!)))
    .toMatchObject({ affectedSessionIds: [f.session.sessionId], stopRequested: true });
  expect((await started.completion).result).toMatchObject({ ok: true, data: { status: 'cancelled', stopped: true } });
  expect(await f.app.submitInput(f.request(2))).toMatchObject({ ok: false, error: { code: 'session_scope_revoked' } });
  expect(need(await f.app.queryResearchTask(f.task.researchId)).currentRunId).toBe(accepted.runId);
  expect(need(await f.app.listResearchSources({ researchId: f.task.researchId })).items).toEqual(sources);
  release();
});

it('imports selected UTF-8 text once and reads it through the actual planning tool without network access', async () => {
  const text = '# Local constraints\nKeep confidential data on the device. 本地约束';
  let artifactId = 0;
  const policy = { web: false, domains: [], artifactIds: [] as number[], documentIds: [] };
  const f = await researchFixture((_request, index) => index === 1 ? { tool: 'read_research_local', args: { artifactId, documentId: null }, id: 'read-local' }
    : index === 2 ? { tool: 'save_research_plan', args: { ...researchPlan, sourcePolicy: policy }, id: 'plan' } : { text: 'Local constraints read. Confirm the saved plan.' });
  const importMaterial = Reflect.get(f.app, 'importResearchMaterial'); expect(importMaterial).toBeFunction();
  const input = { title: 'Local constraints.md', format: 'markdown' as const, text };
  const material = need<any>(await importMaterial(input)); artifactId = material.artifactId; policy.artifactIds = [artifactId];
  expect(await importMaterial(input)).toEqual({ ok: true, data: material });
  const session = need(await f.app.createSession({ title: 'Local research' }));
  const task = need(await f.app.createResearchTask({ sessionId: session.sessionId, title: 'Local research', sourcePolicy: policy }));
  await f.run({ ...f.request(1), sessionId: session.sessionId, research: { researchId: task.researchId, phase: 'planning', plan: null } });
  const sources = need(await f.app.listResearchSources({ researchId: task.researchId })).items;
  expect(sources).toHaveLength(1); expect(sources[0]!.artifactId).toBe(artifactId); expect(sources[0]!.kind).toBe('local');
  expect(JSON.stringify(f.requests[1]!.messages)).toContain('Keep confidential data on the device.');
  expect(need(await f.app.queryResearchTask(task.researchId)).status).toBe('awaiting_confirmation');
  for (const request of f.requests) expect(request.tools?.map(tool => tool.function.name)).not.toContain('search_research_sources');
});

it('rejects nonexistent or unavailable materials before creating a research task', async () => {
  const f = await researchFixture(() => ({ text: 'Unused' }));
  const session = need(await f.app.createSession({ title: 'Invalid material selection' }));
  expect(await f.app.createResearchTask({ sessionId: session.sessionId, title: 'Invalid', sourcePolicy: {
    web: false, domains: [], artifactIds: [999999], documentIds: [],
  } })).toMatchObject({ ok: false });
});

it('rejects a same-length tampered material and an unselected material without publishing evidence', async () => {
  let selected = 0, unselected = 0;
  const f = await researchFixture((_request, index) => index <= 2
    ? { tool: 'read_research_local', args: { artifactId: index === 1 ? selected : unselected, documentId: null }, id: `read-${index}` }
    : { text: 'The selected source is changed and the other is not authorized.' });
  selected = need(await f.app.importResearchMaterial({ title: 'Selected.txt', format: 'text', text: 'Original' })).artifactId;
  unselected = need(await f.app.importResearchMaterial({ title: 'Private.txt', format: 'text', text: 'Private!' })).artifactId;
  const session = need(await f.app.createSession({ title: 'Selected sources' }));
  const task = need(await f.app.createResearchTask({ sessionId: session.sessionId, title: 'Scope check', sourcePolicy: {
    web: false, domains: [], artifactIds: [selected], documentIds: [],
  } }));
  writeFileSync(join(f.paths.artifactsDir, String(selected), 'source.txt'), 'Tampered');
  expect(await f.app.importResearchMaterial({ title: 'Selected.txt', format: 'text', text: 'Original' })).toMatchObject({ ok: false });
  await f.run({ ...f.request(1), sessionId: session.sessionId, research: { researchId: task.researchId, phase: 'planning', plan: null } });
  expect(need(await f.app.listResearchSources({ researchId: task.researchId })).items).toEqual([]);
  const feedback = JSON.stringify(f.requests.at(-1)!.messages);
  expect(feedback).toContain('research_source_unavailable'); expect(feedback).toContain('research_source_denied');
});

it('preserves a published source file but records no source success when its database registration fails', async () => {
  let artifactId = 0;
  const f = await researchFixture((_request, index) => index === 1
    ? { tool: 'read_research_local', args: { artifactId, documentId: null }, id: 'read-failed-save' }
    : { text: 'Source registration failed.' }, db => db.run("CREATE TRIGGER fail_source BEFORE INSERT ON research_sources BEGIN SELECT RAISE(ABORT, 'fixture_source_save'); END"));
  artifactId = need(await f.app.importResearchMaterial({ title: 'Source.txt', format: 'text', text: 'Evidence body' })).artifactId;
  const session = need(await f.app.createSession({ title: 'Save failure' }));
  const task = need(await f.app.createResearchTask({ sessionId: session.sessionId, title: 'Failure', sourcePolicy: {
    web: false, domains: [], artifactIds: [artifactId], documentIds: [],
  } }));
  const failed = await f.run({ ...f.request(1), sessionId: session.sessionId, research: { researchId: task.researchId, phase: 'planning', plan: null } });
  expect(need(await f.app.listResearchSources({ researchId: task.researchId })).items).toEqual([]);
  expect(readdirSync(join(f.paths.artifactsDir, 'research', String(task.researchId)))).toHaveLength(1);
  expect(need(await f.app.listRunToolCalls({ runId: failed.accepted.runId, sessionId: session.sessionId })).items)
    .toMatchObject([{ toolName: 'read_research_local', status: 'failed', errorCode: 'research_write_failed' }]);
});
