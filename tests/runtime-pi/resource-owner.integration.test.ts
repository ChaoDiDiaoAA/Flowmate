import { expect, spyOn, test } from 'bun:test';
import { InMemoryCredentialStore } from '@earendil-works/pi-ai';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import * as bootstrap from '../../packages/core/src/storage/bootstrap.ts';
import { ok } from '@flowmate/contracts';
import type { AgentRunEvent, ExtensionRef, FrozenResources, ManagedFileContents, Result } from '@flowmate/contracts';
import { testDatabase, type TestDbHandle } from '../support/database.ts';
import { createApplication } from '../../apps/composition.ts';
import { PiAgentAdapter } from '../../packages/runtime-pi/src/session.ts';
import { createHttpProvider, deferCleanup, mkdtempSync } from '../support/resources.ts';

function need<T>(result: Result<T>): T { if (!result.ok) throw Error(result.error.code); return result.data; }
function response(delta: object, finish: string) {
  const chunk = (value: object, reason: string | null) => `data: ${JSON.stringify({ id: 'owner-snapshot', choices: [{ index: 0, delta: value, finish_reason: reason }] })}\n\n`;
  return new Response(chunk(delta, null) + chunk({}, finish) + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
}

async function fixture(mode: 'cold' | 'read' | 'read_skill_resource' | 'child') {
  const root = mkdtempSync(join(tmpdir(), 'flowmate-resource-owner-')), resourceRoot = join(root, 'author');
  const skillDirectory = join(resourceRoot, 'skills/invoice'); mkdirSync(skillDirectory, { recursive: true });
  const skillText = '---\nname: invoice\ndescription: Controlled invoice skill\n---\nOriginal invoice procedure.';
  writeFileSync(join(skillDirectory, 'SKILL.md'), skillText);
  writeFileSync(join(skillDirectory, 'resource.json'), JSON.stringify({ schemaVersion: 2, kind: 'skill', id: 'invoice', version: 'v1',
    bodyFile: 'SKILL.md', keywords: ['invoice'], requires: [], files: [{ path: 'SKILL.md', bytes: Buffer.byteLength(skillText) }] }));
  if (mode === 'child') {
    mkdirSync(join(resourceRoot, 'extensions'), { recursive: true }); mkdirSync(join(resourceRoot, 'subagents'));
    writeFileSync(join(resourceRoot, 'extensions/subagents-v1.json'), readFileSync(new URL('../../resources/extensions/subagents-v1.json', import.meta.url)));
    writeFileSync(join(resourceRoot, 'extensions/invoice-v1.json'), readFileSync(new URL('../../resources/extensions/invoice-v1.json', import.meta.url)));
    writeFileSync(join(resourceRoot, 'subagents/general-analyst.md'), readFileSync(new URL('../../resources/subagents/general-analyst.md', import.meta.url)));
  }
  const paths = { root: join(root, 'product'), databaseFile: join(root, 'product/data/app.sqlite'),
    artifactsDir: join(root, 'product/artifacts'), runtimeDir: join(root, 'product/runtime'),
    logsDir: join(root, 'product/logs'), outputsDir: join(root, 'product/outputs') };
  let database: TestDbHandle | undefined, frozen: FrozenResources | undefined, snapshot: Pick<ManagedFileContents, 'read'> | undefined;
  let expired = mode === 'cold', rootReads = 0, requests = 0, parentRequests = 0, childRequests = 0;
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  let holding: Promise<void> | undefined;
  const server = await createHttpProvider(async request => {
    requests++; const body = await request.text();
    if (mode === 'child' && body.includes('Analyze the task')) { childRequests++; return response({ role: 'assistant', content: 'Independent child finding.' }, 'stop'); }
    if (++parentRequests > 1 || mode === 'cold') return response({ role: 'assistant', content: 'Verified answer.' }, 'stop');
    expired = true;
    const name = mode === 'child' ? 'Agent' : mode;
    if (!frozen) throw Error('Prepared resources were not captured.');
    const args = mode === 'child' ? { subagent_type: 'general-analyst', prompt: 'Analyze this task independently.', description: 'Independent check', run_in_background: false }
      : mode === 'read' ? { path: join(frozen.bundleDirectory, 'skills/invoice/v1/SKILL.md') }
        : { skill: 'invoice', path: 'SKILL.md' };
    return response({ role: 'assistant', tool_calls: [{ index: 0, id: 'owner-resource-call', type: 'function',
      function: { name, arguments: JSON.stringify(args) } }] }, 'tool_calls');
  }); deferCleanup(() => server.stop());
  let extensions: ExtensionRef[] = [];
  const original = bootstrap.bootstrapDatabase, opening = spyOn(bootstrap, 'bootstrapDatabase').mockImplementation(input => {
    const value = original(input); if (value.ok) database = testDatabase(value.data); return value;
  });
  let app;
  try { app = need(await createApplication({ paths, resourceRoot,
    resourceDefaults: () => ok({ revision: 1, selection: { prompt: null, enabledSkills: [{ kind: 'skill', id: 'invoice', version: 'v1' }] },
      extensions: { enabledExtensions: extensions } }),
    agentFactory: tools => {
      const adapter = new PiAgentAdapter({ tools, cwd: paths.runtimeDir, agentDir: paths.runtimeDir,
        credentials: new InMemoryCredentialStore(), runtimeApiKey: 'controlled-resource-owner',
        resourceContents: { read(owner) { rootReads++; if (expired || !database) throw Error('Expired root contents'); return database.contents.read(owner); } } });
      const prepare = adapter.prepare.bind(adapter);
      adapter.prepare = async (...input) => {
        frozen = input[4]?.resources; snapshot = input[4]?.resourceContents;
        if (mode === 'cold') {
          if (!database) throw Error('The actual database owner was not captured.');
          holding = database.transaction(async () => { entered.resolve(); await release.promise; });
          await entered.promise;
        }
        return prepare(...input);
      };
      return adapter;
    }, logger: { write() {}, async close() {} } })); }
  finally { opening.mockRestore(); }
  deferCleanup(async () => { release.resolve(); await holding; await app.close(); });
  if (mode === 'child') extensions = need(await app.listExtensions()).items.filter(item => item.ref.id === 'subagents').map(item => item.ref);
  const session = need(await app.createSession({ title: 'Resource owner' })), before = need(await app.readWorkspace());
  const workspace = need(await app.updateWorkspace({ expectedRevision: before.revision, change: { kind: 'session', sessionId: session.sessionId } }));
  const done = Promise.withResolvers<Extract<AgentRunEvent, { type: 'run_finished' }>>();
  const start = () => app.submitInput({ sessionId: session.sessionId, clientSequence: 1, mode: 'prompt', text: 'Use the fixed resource.',
    workspace: { revision: workspace.revision, sessionId: session.sessionId, documentRef: null, jobId: null, candidateRef: null },
    config: { version: 1, name: 'Snapshot owner', revision: 1, modelRef: { provider: 'owner-snapshot', model: 'owner-snapshot' },
      native: { authPath: join(root, 'absent-auth.json'), modelsPath: null },
      connection: { baseUrl: `http://127.0.0.1:${server.port}/v1`, api: 'openai-completions', contextWindow: 64000, maxTokens: 8192 },
      parameters: { maxRetries: 0, maxRetryDelayMs: 100 } }, budget: { maxModelCalls: 6, maxToolCalls: 6 } },
    { onEvent(event) { if (event.type === 'run_finished') done.resolve(event); } });
  return { app, session, start, done, entered, release, holding: () => holding, snapshot: () => snapshot,
    frozen: () => frozen, requests: () => requests, childRequests: () => childRequests, rootReads: () => rootReads };
}

test('cold Pi preparation uses independent owner snapshot bytes while another owner transaction is held', async () => {
  const f = await fixture('cold'); need(await f.start());
  try {
    await f.entered.promise;
    expect(f.requests()).toBe(0);
    const snapshot = f.snapshot(), frozen = f.frozen(); expect(snapshot).toBeDefined(); expect(frozen).toBeDefined();
    if (!snapshot || !frozen) throw Error('The current bundle snapshot was not provided.');
    const owner = { ownerKind: 'resource-bundle', ownerId: frozen.bundleId, relativePath: 'bundle.json' };
    const first = snapshot.read(owner); expect(first?.[0]).toBe(123); if (!first) throw Error('Missing original bundle bytes');
    first[0] = 91; expect(snapshot.read(owner)?.[0]).toBe(123);
    expect(snapshot.read({ ...owner, ownerId: 'another-bundle' })).toBeNull();
    expect(snapshot.read({ ...owner, relativePath: 'unlisted.txt' })).toBeNull();
    f.release.resolve(); await f.holding();
    expect((await f.done.promise).result).toMatchObject({ ok: true, data: { status: 'completed' } });
    expect(f.rootReads()).toBe(0);
  } finally { f.release.resolve(); await f.holding(); await f.done.promise; }
});

test.each(['read', 'read_skill_resource'] as const)('actual SDK %s feedback uses its prepared snapshot after root contents expire', async mode => {
  const f = await fixture(mode), accepted = need(await f.start());
  expect((await f.done.promise).result).toMatchObject({ ok: true, data: { status: 'completed' } });
  const owner = { sessionId: f.session.sessionId, runId: accepted.runId };
  expect(need(await f.app.queryRunResources(owner)).evidence?.reads).toContainEqual(expect.objectContaining({ operation: mode }));
  expect(f.requests()).toBe(2); expect(f.rootReads()).toBe(0);
});

test('actual SDK child inherits only its parent bundle snapshot after root contents expire', async () => {
  const f = await fixture('child'), accepted = need(await f.start());
  expect((await f.done.promise).result).toMatchObject({ ok: true, data: { status: 'completed' } });
  expect(need(await f.app.listSubagents({ parentRunId: accepted.runId, parentSessionId: f.session.sessionId })).items)
    .toMatchObject([{ status: 'completed', stoppedAt: expect.any(String) }]);
  expect(f.childRequests()).toBe(1); expect(f.requests()).toBe(3); expect(f.rootReads()).toBe(0);
});
