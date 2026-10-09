import { describe, expect, it, spyOn } from 'bun:test';
import * as fsPromises from 'node:fs/promises';
import { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync, existsSync, readFileSync, renameSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { tmpdir, homedir } from 'node:os';
import { InMemoryCredentialStore } from '@earendil-works/pi-ai';
import { formatSkillsForPrompt, createReadToolDefinition, type AgentSession } from '@earendil-works/pi-coding-agent';
import { canonicalResourceManifest, ResourceManifestSchema, ResourceRefSchema, INVOICE_TOOLS_SYSTEM_PROMPT, ok } from '@flowmate/contracts';
import type { AgentRunEvent, ResourceSelection, Result } from '@flowmate/contracts';
import { createApplication } from '../../apps/composition.ts';
import { resolveProductPaths } from '../../packages/shared/src/paths.ts';
import * as pi from '../../packages/runtime-pi/src/index.ts';
import { createResourceService } from '../../packages/core/src/resources/service.ts';
import { readProductSettings, saveProductSettings, defaultProductSettings } from '../../packages/core/src/configuration/settings.ts';
import { checkResourcePayload, checkResourceWire } from '../../packages/runtime-pi/src/context-evidence.ts';
import { verifyManagedReadOutput, verifySkillToolOutput } from '../../packages/runtime-pi/src/resources/loader.ts';
import { createHttpProvider, deferCleanup, mkdtempSync } from '../support/resources.ts';

const hash = (text: string) => createHash('sha256').update(text).digest('hex');
function need<T>(value: Result<T>): T { if (!value.ok) throw new Error(value.error.code); return value.data; }
function packs(prefix = 'flowmate-p11-sdk-') {
  const root = mkdtempSync(join(tmpdir(), prefix)), resourceRoot = join(root, 'author'); mkdirSync(resourceRoot);
  const paths = need(resolveProductPaths(join(root, 'product'))), bundleRoot = join(paths.runtimeDir, 'resource-bundles');
  function pack(kind: 'prompt' | 'skill', version = 'v1', disabled = false, extraFiles: Array<{ path: string; text: string }> = []) {
    const dir = join(resourceRoot, kind === 'prompt' ? 'prompts' : 'skills', 'invoice'); mkdirSync(dir, { recursive: true });
    const text = kind === 'prompt' ? `Business invoice constraints ${version}.` : `---\nname: invoice\ndescription: Invoice fields ${version}\ndisable-model-invocation: ${disabled}\n---\nInvoice SOP ${version}.`;
    const path = kind === 'prompt' ? 'prompt.md' : 'SKILL.md';
    const files = [{ path, text }, ...extraFiles];
    const manifest = ResourceManifestSchema.parse({ schemaVersion: 1, kind, id: 'invoice', version, bodyFile: path,
      keywords: ['invoice'], requires: [], files: files.map(file => ({ path: file.path, bytes: Buffer.byteLength(file.text), sha256: hash(file.text) })) });
    for (const file of files) { mkdirSync(dirname(join(dir, file.path)), { recursive: true }); writeFileSync(join(dir, file.path), file.text); }
    writeFileSync(join(dir, 'resource.json'), JSON.stringify(manifest));
    return { ref: ResourceRefSchema.parse({ kind, id: 'invoice', version, contentHash: hash(canonicalResourceManifest(manifest)) }), dir, text };
  }
  const hub = createResourceService({ resourceRoot, bundleRoot, registeredToolNames: ['read'], inspectNativeResources: pi.inspectNativeResources });
  return { root, paths, resourceRoot, bundleRoot, pack, hub };
}
function reply() {
  const chunk = (delta: unknown, finish: string | null) => `data: ${JSON.stringify({ id: 'p11', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
  return new Response(chunk({ role: 'assistant', content: 'Controlled answer.' }, null) + chunk({}, 'stop') + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
}
function toolReply(calls: Array<{ name: string; args: unknown }>) {
  const chunk = (delta: unknown, finish: string | null) => `data: ${JSON.stringify({ id: 'p11-tools', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
  return new Response(chunk({ role: 'assistant', tool_calls: calls.map((call, index) => ({ index, id: `p11-read-${index}`,
    type: 'function', function: { name: call.name, arguments: JSON.stringify(call.args) } })) }, null)
    + chunk({}, 'tool_calls') + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
}
function responsesReply() {
  const item = { id: 'p11-message', type: 'message', role: 'assistant', status: 'completed',
    content: [{ type: 'output_text', text: 'Controlled answer.', annotations: [] }] };
  const events = [{ type: 'response.created', response: { id: 'p11-response' } },
    { type: 'response.output_item.added', output_index: 0, item: { ...item, content: [] } },
    { type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: 'Controlled answer.' },
    { type: 'response.output_item.done', output_index: 0, item },
    { type: 'response.completed', response: { id: 'p11-response', status: 'completed', output: [item],
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } }];
  return new Response(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
}

describe('P11 controlled native resources', () => {
  it('rejects altered structured pages and foreign ownership before SDK evidence', () => {
    const controls = '\u0000\u0001\u0002\u0003\u0000\u0000';
    const f = packs(), skill = f.pack('skill', 'v1', false, [{ path: 'references/guide.md', text: '中文 reference' },
      { path: 'references/controls.bin', text: controls }]);
    const frozen = need(f.hub.freeze({ selection: { prompt: null, enabledSkills: [skill.ref] }, settingsRevision: 1, activeToolNames: ['read'], requiredSkill: null }))!;
    const loader = need(pi.createRunResourceLoader({ fixedSystemPrompt: 'Skill test', frozen, bundleDirectory: frozen.bundleDirectory,
      activeToolNames: ['list_skill_resources', 'read_skill_resource'] }));
    const args = { skill: 'invoice', path: 'references/guide.md', limit: 6 };
    const page = { ...need(f.hub.readFrozenFile(frozen, { path: args.path, limit: args.limit, ref: skill.ref })), bundleHash: frozen.bundleHash };
    expect(verifySkillToolOutput(frozen, loader, 'read_skill_resource', args, page)).toMatchObject({ ok: true, data: [{ fullBody: false, text: '中文 reference' }] });
    for (const changed of [{ text: 'different' }, { path: 'SKILL.md' }, { offset: 3 }, { nextOffset: null }, { totalBytes: 6 },
      { bundleHash: 'f'.repeat(64) }, { ref: { ...skill.ref, version: 'v2' } }])
      expect(verifySkillToolOutput(frozen, loader, 'read_skill_resource', args, { ...page, ...changed })).toMatchObject({ ok: false, error: { code: 'resource_evidence_conflict' } });
    expect(verifySkillToolOutput(frozen, loader, 'read_skill_resource', { ...args, sessionId: 1 }, page).ok).toBe(false);
    expect(verifySkillToolOutput(frozen, loader, 'read_skill_resource', { skill: 'invoice', path: 'references/controls.bin' },
      { ref: skill.ref, bundleHash: frozen.bundleHash, path: 'references/controls.bin', sha256: hash(controls),
        offset: 0, text: controls, nextOffset: null, totalBytes: Buffer.byteLength(controls) }))
      .toMatchObject({ ok: false, error: { code: 'resource_evidence_conflict' } });
    const files = [...frozen.manifests[0]!.manifest.files].sort((a, b) => a.path < b.path ? -1 : 1);
    expect(verifySkillToolOutput(frozen, loader, 'list_skill_resources', { skill: 'invoice' }, { ref: skill.ref, bundleHash: frozen.bundleHash, files })).toMatchObject({ ok: true });
    expect(verifySkillToolOutput(frozen, loader, 'list_skill_resources', { skill: 'invoice' }, { ref: skill.ref, bundleHash: frozen.bundleHash, files: files.slice(0, 1) }).ok).toBe(false);
  });
  it.each([false, true])('uses the dedicated Skill tools without native readers and preserves owned receipts (receipt fault=%s)', async receiptFault => {
    const f = packs(), marker = join(f.root, 'skill-script-executed');
    const guide = '中文 reference stays frozen.', script = `throw new Error(${JSON.stringify(marker)});`;
    const skill = f.pack('skill', 'v1', false, [{ path: 'references/guide.md', text: guide }, { path: 'scripts/check.ts', text: script }]);
    const payloads: Array<{ messages: Array<{ role: string; content: string }>; tools: Array<{ function: { name: string } }> }> = [];
    const server = await createHttpProvider(async request => {
      payloads.push(await request.json() as (typeof payloads)[number]);
      return payloads.length === 1 ? toolReply([
        { name: 'list_skill_resources', args: { skill: 'invoice' } },
        { name: 'read_skill_resource', args: { skill: 'invoice', path: 'SKILL.md' } },
        { name: 'read_skill_resource', args: { skill: 'invoice', path: 'references/guide.md', limit: 6 } },
        { name: 'read_skill_resource', args: { skill: 'invoice', path: 'scripts/check.ts' } },
      ]) : reply();
    }); deferCleanup(() => server.stop());
    const open = () => createApplication({ paths: f.paths, resourceRoot: f.resourceRoot,
      resourceDefaults: () => ok({ revision: 1, selection: { prompt: null, enabledSkills: [skill.ref] } }),
      toolDefinitions: definitions => definitions.filter(tool => !['read', 'grep', 'find', 'ls', 'edit', 'write', 'bash', 'powershell'].includes(tool.name)),
      agentFactory: definitions => new pi.PiAgentAdapter({ cwd: f.paths.runtimeDir, agentDir: f.paths.runtimeDir,
        tools: definitions,
        credentials: new InMemoryCredentialStore(), runtimeApiKey: 'p11-loopback' }) });
    let app = need(await open()); deferCleanup(() => app.close());
    const session = need(await app.createSession({ title: 'Dedicated Skill reading' }));
    const w = need(await app.readWorkspace()); need(await app.updateWorkspace({ expectedRevision: w.revision, change: { kind: 'session', sessionId: session.sessionId } }));
    const workspace = need(await app.readWorkspace());
    if (receiptFault) {
      need(await app.close());
      const db = new Database(f.paths.databaseFile);
      try { db.exec(`CREATE TRIGGER p11_receipt_fault BEFORE UPDATE OF context_observations_json ON runs
        WHEN NEW.context_observations_json LIKE '%"operation":"list_skill_resources"%'
        BEGIN SELECT RAISE(ABORT,'controlled receipt fault'); END;`); } finally { db.close(); }
      app = need(await open());
    }
    let finish!: (event: AgentRunEvent & { type: 'run_finished' }) => void;
    const done = new Promise<AgentRunEvent & { type: 'run_finished' }>(resolve => { finish = resolve; });
    const accepted = need(await app.submitInput({ sessionId: session.sessionId, clientSequence: 1, mode: 'prompt', text: 'Inspect the registered Skill files.',
      workspace: { revision: workspace.revision, sessionId: session.sessionId, documentRef: null, jobId: null, candidateRef: null },
      config: { version: 1, name: 'P11 dedicated', revision: 1, modelRef: { provider: 'p11', model: 'p11' }, native: { authPath: join(f.root, 'empty-auth.json'), modelsPath: null },
        connection: { baseUrl: `http://127.0.0.1:${server.port}/v1`, api: 'openai-completions', contextWindow: 64000, maxTokens: 16384 }, parameters: { maxRetries: 0, maxRetryDelayMs: 100 } } },
      { onEvent: event => { if (event.type === 'run_finished') finish(event); } }));
    const ended = await done;
    if (!payloads.length) throw new Error(JSON.stringify(ended));
    expect(payloads[0]!.messages.find(message => message.role === 'system')!.content.match(/<name>invoice<\/name>/g)).toHaveLength(1);
    expect(payloads[0]!.messages.find(message => message.role === 'system')!.content).toContain('read_skill_resource');
    const userText = JSON.stringify(payloads[0]!.messages.find(message => message.role === 'user')!.content);
    expect(userText).toContain('Inspect the registered Skill files.');
    expect(userText).toContain('workspaceContext');
    expect(payloads[0]!.tools.map(tool => tool.function.name)).toContain('list_skill_resources');
    expect(payloads[0]!.tools.map(tool => tool.function.name)).not.toContain('read');
    expect(existsSync(marker)).toBe(false);
    if (receiptFault) {
      expect(ended.result).toMatchObject({ ok: true, data: { status: 'failed' } });
      expect(payloads).toHaveLength(1); return;
    }
    expect(ended.result).toMatchObject({ ok: true, data: { status: 'completed' } });
    const view = need(await app.queryRunResources({ sessionId: session.sessionId, runId: accepted.runId }));
    expect(payloads).toHaveLength(2);
    expect(view.evidence?.reads).toHaveLength(6);
    expect(view.evidence?.reads.filter(read => read.operation === 'list_skill_resources').every(read => read.fullBody === false)).toBe(true);
    expect(view.evidence?.reads.find(read => read.operation === 'read_skill_resource' && read.path === 'SKILL.md')).toMatchObject({ fullBody: true });
    expect(view.evidence?.reads.find(read => read.operation === 'read_skill_resource' && read.path === 'references/guide.md')).toMatchObject({ fullBody: false });
    expect(view.evidence?.reads.every(read => read.nativeEntryId !== null)).toBe(true);
    expect(view.evidence?.requests[0]!.contentChecks).toContainEqual(expect.objectContaining({ scope: 'skill-index', sdkInclusion: 'confirmed', wireInclusion: 'confirmed' }));
    expect(view.evidence?.requests[1]!.contentChecks).toContainEqual(expect.objectContaining({ scope: 'tool-output', sdkInclusion: 'confirmed', wireInclusion: 'confirmed' }));
  });
  it('classifies the path spellings accepted by the actual installed native read tool', async () => {
    const f = packs('flowmate p11-sdk-'), extra = { path: 'references/note.md', text: 'Pinned reference text.' }, skill = f.pack('skill', 'v1', false, [extra]);
    const frozen = need(f.hub.freeze({ selection: { prompt: null, enabledSkills: [skill.ref] }, settingsRevision: 1, activeToolNames: ['read'], requiredSkill: null }))!;
    const loader = need(pi.createRunResourceLoader({ fixedSystemPrompt: INVOICE_TOOLS_SYSTEM_PROMPT, frozen, bundleDirectory: frozen.bundleDirectory }));
    const path = join(frozen.bundleDirectory, 'skills', 'invoice', 'v1', extra.path), slash = path.replaceAll('\\', '/');
    const paths = ['@' + path, pathToFileURL(path).href, relative(f.paths.runtimeDir, path), path.replace('flowmate p11', 'flowmate\u202fp11')];
    const homePath = relative(homedir(), path); if (!/^[a-z]:/i.test(homePath)) paths.push('~/' + homePath.replaceAll('\\', '/'));
    if (process.platform === 'win32') {
      const drive = slash.slice(0, 1).toLowerCase(), rest = slash.slice(3); paths.push(`/${drive}/${rest}`, `/mnt/${drive}/${rest}`, `/cygdrive/${drive}/${rest}`);
    }
    const read = createReadToolDefinition(f.paths.runtimeDir);
    for (const accepted of paths) {
      const result = await read.execute('path-spelling', { path: accepted }, undefined, undefined, undefined as never);
      expect(result.content).toEqual([{ type: 'text', text: extra.text }]);
      expect(loader.filesForOperation(accepted, f.paths.runtimeDir, 'read')).toEqual([{ ref: skill.ref, path: extra.path,
        fileHash: hash(extra.text), text: extra.text, relativePath: '' }]);
    }
  });
  it('retains only published content on failed admission, revalidates after restart and uses an explicitly saved older version without replay', async () => {
    const f = packs(), older = f.pack('skill', 'v1', true), selected = f.pack('skill', 'v2', true), payloads: unknown[] = [];
    const settingsFile = join(f.paths.root, 'data', 'settings.json');
    let settings = need(await saveProductSettings(settingsFile, { ...defaultProductSettings(), resources: { prompt: null, enabledSkills: [selected.ref] } }));
    const server = await createHttpProvider(async request => { payloads.push(await request.json()); return reply(); }); deferCleanup(() => server.stop());
    const open = () => createApplication({ paths: f.paths, resourceRoot: f.resourceRoot,
      resourceDefaults: () => ok({ revision: settings.revision, selection: settings.resources! }),
      agentFactory: definitions => new pi.PiAgentAdapter({ cwd: f.paths.runtimeDir, agentDir: f.paths.runtimeDir, tools: definitions,
        credentials: new InMemoryCredentialStore(), runtimeApiKey: 'p11-loopback' }) });
    let app = need(await open()); deferCleanup(() => app.close());
    const session = need(await app.createSession({ title: 'Explicit resource fallback' })); need(await app.close());
    const dbFile = f.paths.databaseFile;
    let db = new Database(dbFile); db.exec("CREATE TRIGGER p11_admission_fault BEFORE INSERT ON runs BEGIN SELECT RAISE(ABORT,'controlled admission fault'); END;"); db.close();
    app = need(await open());
    const request = { sessionId: session.sessionId, clientSequence: 1, mode: 'prompt' as const, text: 'Use the explicitly fixed SOP', requiredSkill: selected.ref,
      config: { version: 1 as const, name: 'P11 restart', revision: 1, modelRef: { provider: 'p11', model: 'p11' }, native: { authPath: join(f.root, 'empty-auth.json'), modelsPath: null },
        connection: { baseUrl: `http://127.0.0.1:${server.port}/v1`, api: 'openai-completions', contextWindow: 64000, maxTokens: 16384 }, parameters: { maxRetries: 0, maxRetryDelayMs: 100 } } };
    expect(await app.submitInput(request)).toMatchObject({ ok: false, error: { code: 'storage_write_failed' } });
    expect(need(await app.querySessionInput({ sessionId: session.sessionId, clientSequence: 1 })).input).toBeNull(); expect(payloads).toHaveLength(0);
    const publishedHash = hash(JSON.stringify([selected.ref])), bundle = join(f.bundleRoot, publishedHash, 'bundle.json'), originalBundle = readFileSync(bundle, 'utf8');
    const fixed = { version: 1 as const, policyVersion: 'p11-resources-v1' as const, bundleHash: publishedHash, settingsRevision: settings.revision,
      bundleDirectory: join(f.bundleRoot, publishedHash), manifests: JSON.parse(originalBundle).resources,
      prompt: null, selectedSkills: [selected.ref], discoveredSkills: [selected.ref], excludedSkills: [] };
    expect(need(f.hub.verifyFrozen(fixed))).toBeUndefined(); need(await app.close());
    db = new Database(dbFile); expect(db.query('SELECT count(*) AS n FROM runs').get()).toEqual({ n: 0 }); db.exec('DROP TRIGGER p11_admission_fault'); db.close();
    app = need(await open());
    const execute = async (input: typeof request) => {
      let finish!: (event: AgentRunEvent & { type: 'run_finished' }) => void;
      const done = new Promise<AgentRunEvent & { type: 'run_finished' }>(resolve => { finish = resolve; });
      const accepted = need(await app.submitInput(input, { onEvent: event => { if (event.type === 'run_finished') finish(event); } }));
      expect((await done).result).toMatchObject({ ok: true, data: { status: 'completed' } }); return accepted;
    };
    const accepted = await execute(request), owner = { sessionId: session.sessionId, runId: accepted.runId };
    const oldEvidence = need(await app.queryRunResources(owner)); const oldHistory = need(await app.querySessionHistory({ sessionId: session.sessionId }));
    expect(readFileSync(bundle, 'utf8')).toBe(originalBundle); expect(payloads).toHaveLength(1);
    need(await app.close()); renameSync(selected.dir, join(f.root, 'unavailable-v2'));
    settings = need(await readProductSettings(settingsFile)); app = need(await open());
    expect(need(await app.listResources()).diagnostics).toContainEqual(expect.objectContaining({ resourceId: 'invoice', version: 'v2', code: 'resource_required_unavailable' }));
    expect(need(await app.queryRunResources(owner))).toEqual(oldEvidence); expect(need(await app.querySessionHistory({ sessionId: session.sessionId }))).toEqual(oldHistory);
    expect(await app.submitInput(request)).toEqual({ ok: true, data: accepted });
    expect(await app.submitInput({ ...request, clientSequence: 2 })).toMatchObject({ ok: false, error: { code: 'resource_required_unavailable' } }); expect(payloads).toHaveLength(1);
    f.pack('skill', 'v1', true); // Restore the prior author package before explicitly selecting it.
    const fallback = { prompt: null, enabledSkills: [older.ref] }; need(app.validateResourceSelection(fallback));
    settings = need(await saveProductSettings(settingsFile, { ...settings, resources: fallback }));
    const later = await execute({ ...request, clientSequence: 2, requiredSkill: older.ref });
    expect(need(await app.queryRunResources({ sessionId: session.sessionId, runId: later.runId })).frozen?.discoveredSkills).toEqual([older.ref]);
    expect(need(await app.queryRunResources(owner))).toEqual(oldEvidence); expect(payloads).toHaveLength(2);
    expect(JSON.stringify(payloads[1])).toContain('Invoice SOP v1.');
  });
  it('records the native automatic summary independently and retains only derived resource provenance afterwards', async () => {
    const f = packs(), skill = f.pack('skill', 'v1', true), payloads: unknown[] = [];
    const server = await createHttpProvider(async request => {
      const payload = await request.json(); payloads.push(payload);
      if (payloads.length !== 1) return reply();
      const path = join(f.bundleRoot, need(f.hub.freeze({ selection: { prompt: null, enabledSkills: [skill.ref] }, settingsRevision: 1,
        activeToolNames: ['read'], requiredSkill: skill.ref }))!.bundleHash, 'skills', 'invoice', 'v1', 'SKILL.md');
      const response = toolReply([{ name: 'read', args: { path } }]);
      const text = (await response.text()).replace('"role":"assistant"', `"role":"assistant","content":${JSON.stringify('x'.repeat(100000))}`)
        .replace('data: [DONE]', 'data: ' + JSON.stringify({ choices: [], usage: { prompt_tokens: 50000, completion_tokens: 1, total_tokens: 50001 } }) + '\n\ndata: [DONE]');
      return new Response(text, { headers: response.headers });
    }); deferCleanup(() => server.stop());
    const app = need(await createApplication({ paths: f.paths, resourceRoot: f.resourceRoot,
      resourceDefaults: () => ok({ revision: 1, selection: { prompt: null, enabledSkills: [skill.ref] } }),
      agentFactory: definitions => new pi.PiAgentAdapter({ cwd: f.paths.runtimeDir, agentDir: f.paths.runtimeDir, tools: definitions,
        credentials: new InMemoryCredentialStore(), runtimeApiKey: 'p11-loopback' }) })); deferCleanup(() => app.close());
    const session = need(await app.createSession({ title: 'Resource auto summary' }));
    const w = need(await app.readWorkspace()); need(await app.updateWorkspace({ expectedRevision: w.revision, change: { kind: 'session', sessionId: session.sessionId } }));
    const workspace = need(await app.readWorkspace()); let finish!: (event: AgentRunEvent & { type: 'run_finished' }) => void;
    const done = new Promise<AgentRunEvent & { type: 'run_finished' }>(resolve => { finish = resolve; });
    const accepted = need(await app.submitInput({ sessionId: session.sessionId, clientSequence: 1, mode: 'prompt', text: '/skill:invoice Read this SOP.',
      workspace: { revision: workspace.revision, sessionId: session.sessionId, documentRef: null, jobId: null, candidateRef: null },
      config: { version: 1, name: 'P11 summary', revision: 1, modelRef: { provider: 'p11', model: 'p11' }, native: { authPath: join(f.root, 'empty-auth.json'), modelsPath: null },
        connection: { baseUrl: `http://127.0.0.1:${server.port}/v1`, api: 'openai-completions', contextWindow: 64000, maxTokens: 16384 },
        parameters: { maxRetries: 0, maxRetryDelayMs: 100 } } }, { onEvent: event => { if (event.type === 'run_finished') finish(event); } }));
    expect((await done).result).toMatchObject({ ok: true, data: { status: 'completed' } });
    const view = need(await app.queryRunResources({ sessionId: session.sessionId, runId: accepted.runId }));
    expect(payloads).toHaveLength(3);
    expect(view.evidence?.requests.map(request => [request.purpose, request.callSequence])).toEqual([['answer', 1], ['compaction', 2], ['answer', 2]]);
    expect(view.evidence?.requests.find(request => request.purpose === 'compaction')).toMatchObject({ bundleHash: null,
      compactionOperationId: expect.any(String), contentChecks: expect.arrayContaining([expect.objectContaining({ ref: skill.ref,
        scope: 'expanded-body', sdkInclusion: 'confirmed', wireInclusion: 'confirmed' })]) });
    expect(view.evidence?.requests.at(-1)?.contentChecks).toContainEqual(expect.objectContaining({ scope: 'derived-source',
      ref: skill.ref, expectedTextHash: null, sdkInclusion: 'unknown', wireInclusion: 'unknown', reason: 'derived-source-only' }));
  });
  it.each([false, true])('retains actual read and prior-summary provenance after repeated native compaction (explicit=%s)', async explicit => {
    const f = packs(), skill = f.pack('skill', 'v1', true), payloads: unknown[] = [];
    let answers = 0; const natives: AgentSession[] = [];
    const server = await createHttpProvider(async request => {
      const payload = await request.json() as { messages: Array<{ role: string; content: string }> }; payloads.push(payload);
      if (payload.messages.some(message => message.role === 'system' && message.content.startsWith('You are a context summarization assistant.'))) return reply();
      answers++;
      if (answers > 2) return reply();
      const path = join(f.bundleRoot, need(f.hub.freeze({ selection: { prompt: null, enabledSkills: [skill.ref] }, settingsRevision: 1,
        activeToolNames: ['read'], requiredSkill: skill.ref }))!.bundleHash, 'skills', 'invoice', 'v1', 'SKILL.md');
      const response = answers === 1 ? toolReply([{ name: 'read', args: { path } }]) : reply();
      const text = (await response.text()).replace('"role":"assistant"', `"role":"assistant","content":${JSON.stringify('x'.repeat(100000))}`)
        .replace('Controlled answer.', 'y'.repeat(100000))
        .replace('data: [DONE]', 'data: ' + JSON.stringify({ choices: [], usage: { prompt_tokens: 50000, completion_tokens: 1, total_tokens: 50001 } }) + '\n\ndata: [DONE]');
      return new Response(text, { headers: response.headers });
    }); deferCleanup(() => server.stop());
    const app = need(await createApplication({ paths: f.paths, resourceRoot: f.resourceRoot,
      resourceDefaults: () => ok({ revision: 1, selection: { prompt: null, enabledSkills: [skill.ref] } }),
      agentFactory: definitions => new pi.PiAgentAdapter({ cwd: f.paths.runtimeDir, agentDir: f.paths.runtimeDir, tools: definitions,
        credentials: new InMemoryCredentialStore(), runtimeApiKey: 'p11-loopback', sessionSetup: session => { natives.push(session); } }) })); deferCleanup(() => app.close());
    const session = need(await app.createSession({ title: 'Resource auto summary' }));
    const w = need(await app.readWorkspace()); need(await app.updateWorkspace({ expectedRevision: w.revision, change: { kind: 'session', sessionId: session.sessionId } }));
    const workspace = need(await app.readWorkspace()); let finish!: (event: AgentRunEvent & { type: 'run_finished' }) => void;
    const done = new Promise<AgentRunEvent & { type: 'run_finished' }>(resolve => { finish = resolve; });
    const accepted = need(await app.submitInput({ sessionId: session.sessionId, clientSequence: 1, mode: 'prompt', text: explicit ? '/skill:invoice Read this SOP.' : 'Read this SOP through the tool.',
      workspace: { revision: workspace.revision, sessionId: session.sessionId, documentRef: null, jobId: null, candidateRef: null },
      config: { version: 1, name: 'P11 summary', revision: 1, modelRef: { provider: 'p11', model: 'p11' }, native: { authPath: join(f.root, 'empty-auth.json'), modelsPath: null },
        connection: { baseUrl: `http://127.0.0.1:${server.port}/v1`, api: 'openai-completions', contextWindow: 48000, maxTokens: 16384 },
        parameters: { maxRetries: 0, maxRetryDelayMs: 100 } } }, { onEvent: event => { if (event.type === 'run_finished') finish(event); } }));
    expect((await done).result).toMatchObject({ ok: true, data: { status: 'completed' } });
    const view = need(await app.queryRunResources({ sessionId: session.sessionId, runId: accepted.runId }));
    expect(natives.at(-1)!.sessionManager.getBranch().filter(entry => entry.type === 'compaction')).toHaveLength(2);
    expect(view.evidence?.reads).toHaveLength(1);
    const nextDone = new Promise<AgentRunEvent & { type: 'run_finished' }>(resolve => { finish = resolve; });
    const next = need(await app.submitInput({ sessionId: session.sessionId, clientSequence: 2, mode: 'prompt', text: 'Continue from the previous summary.',
      workspace: { revision: workspace.revision, sessionId: session.sessionId, documentRef: null, jobId: null, candidateRef: null },
      config: { version: 1, name: 'P11 summary', revision: 1, modelRef: { provider: 'p11', model: 'p11' }, native: { authPath: join(f.root, 'empty-auth.json'), modelsPath: null },
        connection: { baseUrl: `http://127.0.0.1:${server.port}/v1`, api: 'openai-completions', contextWindow: 48000, maxTokens: 16384 },
        parameters: { maxRetries: 0, maxRetryDelayMs: 100 } } }, { onEvent: event => { if (event.type === 'run_finished') finish(event); } }));
    expect((await nextDone).result).toMatchObject({ ok: true, data: { status: 'completed' } });
    const nextView = need(await app.queryRunResources({ sessionId: session.sessionId, runId: next.runId }));
    expect(view.evidence?.requests.filter(request => request.purpose === 'compaction').at(-1)?.contentChecks).toContainEqual(expect.objectContaining({ ref: skill.ref, scope: 'tool-output', sdkInclusion: 'confirmed', wireInclusion: 'confirmed' }));
    if (explicit) expect(view.evidence?.requests.filter(request => request.purpose === 'compaction').at(-1)?.contentChecks).toContainEqual(expect.objectContaining({
      ref: skill.ref, scope: 'derived-source', expectedTextHash: null, sdkInclusion: 'unknown', wireInclusion: 'unknown', reason: 'derived-source-only' }));
    expect(nextView.evidence?.requests.at(-1)?.contentChecks).toContainEqual(expect.objectContaining({ ref: skill.ref, scope: 'derived-source', expectedTextHash: null }));
  });
  it.each([false, true])('records real native full/partial reads and exact enumeration against the original tool and request (aliases=%s)', async aliases => {
    const f = packs(), marker = join(f.root, 'script-executed');
    const scriptText = `import {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'executed');`;
    const skill = f.pack('skill', 'v1', false, [{ path: 'scripts/check.ts', text: scriptText },
      { path: 'not-SKILL.md', text: 'Only overlapping marker mentions SKILL.md and scripts/check.ts.' }]);
    const payloads: Array<{ messages: Array<{ role: string; content: string }> }> = [];
    const server = await createHttpProvider(async request => {
      const payload = await request.json() as (typeof payloads)[number]; payloads.push(payload);
      if (payloads.length !== 1) return reply();
      const path = payload.messages.find(message => message.role === 'system')!.content.match(/<location>([^<]+)<\/location>/)![1]!;
      return payloads.length === 1 ? toolReply([{ name: 'read', args: { path: aliases ? '@' + path : path } },
        { name: 'read', args: { path: aliases ? pathToFileURL(path).href : path, offset: 2, limit: 1 } },
        { name: 'ls', args: { path: aliases ? '@' + dirname(path) : dirname(path) } },
        { name: 'find', args: { path: dirname(path), pattern: 'not-SKILL.md' } },
        { name: 'grep', args: { path: dirname(path), pattern: 'Only overlapping marker' } },
        { name: 'read', args: { path: join(dirname(path), 'scripts/check.ts') } }]) : reply();
    }); deferCleanup(() => server.stop());
    let selection: ResourceSelection = { prompt: null, enabledSkills: [skill.ref] };
    const open = () => createApplication({ paths: f.paths, resourceRoot: f.resourceRoot,
      resourceDefaults: () => ok({ revision: 1, selection }),
      agentFactory: definitions => new pi.PiAgentAdapter({ cwd: f.paths.runtimeDir, agentDir: f.paths.runtimeDir, tools: definitions,
        credentials: new InMemoryCredentialStore(), runtimeApiKey: 'p11-loopback' }) });
    let app = need(await open()); deferCleanup(() => app.close());
    const session = need(await app.createSession({ title: 'Real resource read' }));
    const w = need(await app.readWorkspace()); need(await app.updateWorkspace({ expectedRevision: w.revision, change: { kind: 'session', sessionId: session.sessionId } }));
    const workspace = need(await app.readWorkspace());
    let finish!: (event: AgentRunEvent & { type: 'run_finished' }) => void;
    const done = new Promise<AgentRunEvent & { type: 'run_finished' }>(resolve => { finish = resolve; });
    const accepted = need(await app.submitInput({ sessionId: session.sessionId, clientSequence: 1, mode: 'prompt', text: 'Read the fixed SOP.',
      workspace: { revision: workspace.revision, sessionId: session.sessionId, documentRef: null, jobId: null, candidateRef: null },
      config: { version: 1, name: 'P11 read', revision: 1, modelRef: { provider: 'p11', model: 'p11' }, native: { authPath: join(f.root, 'empty-auth.json'), modelsPath: null },
        connection: { baseUrl: `http://127.0.0.1:${server.port}/v1`, api: 'openai-completions', contextWindow: 64000, maxTokens: 16384 },
        parameters: { maxRetries: 0, maxRetryDelayMs: 100 } } }, { onEvent: event => { if (event.type === 'run_finished') finish(event); } }));
    expect((await done).result).toMatchObject({ ok: true, data: { status: 'completed' } });
    const view = need(await app.queryRunResources({ sessionId: session.sessionId, runId: accepted.runId }));
    expect(view.evidence?.reads).toHaveLength(7);
    expect(view.evidence?.reads).toEqual(expect.arrayContaining([
      expect.objectContaining({ operation: 'read', nativeToolCallId: 'p11-read-0', ref: skill.ref, fullBody: true, nativeEntryId: expect.any(String) }),
      expect.objectContaining({ operation: 'read', nativeToolCallId: 'p11-read-1', ref: skill.ref, fullBody: false }),
      expect.objectContaining({ operation: 'ls', ref: skill.ref, fullBody: false }),
      expect.objectContaining({ operation: 'find', ref: skill.ref, fullBody: false }),
      expect.objectContaining({ operation: 'grep', ref: skill.ref, fullBody: false }),
      expect.objectContaining({ operation: 'read', path: 'scripts/check.ts', fullBody: true }),
    ]));
    expect(view.evidence?.reads.filter(item => item.operation === 'find').map(item => item.path)).toEqual(['not-SKILL.md']);
    expect(view.evidence?.reads.filter(item => item.operation === 'grep').map(item => item.path)).toEqual(['not-SKILL.md']);
    expect(view.evidence?.requests[1]?.contentChecks.filter(check => check.scope === 'tool-output'))
      .toHaveLength(7);
    expect(view.evidence?.requests[1]?.contentChecks.filter(check => check.scope === 'tool-output').every(check =>
      check.sdkInclusion === 'confirmed' && check.wireInclusion === 'confirmed')).toBe(true);
    expect(payloads).toHaveLength(2);
    expect(existsSync(marker)).toBe(false);
    need(await app.close()); app = need(await open()); selection = { prompt: null, enabledSkills: [] };
    const restoredDone = new Promise<AgentRunEvent & { type: 'run_finished' }>(resolve => { finish = resolve; });
    const restoredRun = need(await app.submitInput({ sessionId: session.sessionId, clientSequence: 2, mode: 'prompt', text: 'Use the previous tool results.',
      config: { version: 1, name: 'P11 read', revision: 1, modelRef: { provider: 'p11', model: 'p11' }, native: { authPath: join(f.root, 'empty-auth.json'), modelsPath: null },
        connection: { baseUrl: `http://127.0.0.1:${server.port}/v1`, api: 'openai-completions', contextWindow: 64000, maxTokens: 16384 },
        parameters: { maxRetries: 0, maxRetryDelayMs: 100 } } }, { onEvent: event => { if (event.type === 'run_finished') finish(event); } }));
    expect((await restoredDone).result).toMatchObject({ ok: true, data: { status: 'completed' } });
    const restoredView = need(await app.queryRunResources({ sessionId: session.sessionId, runId: restoredRun.runId }));
    expect(restoredView.frozen).toBeNull();
    expect(restoredView.evidence?.reads).toEqual([]);
    expect(restoredView.evidence?.requests[0]?.referencedBundleHashes).toEqual([view.frozen!.bundleHash]);
    expect(restoredView.evidence?.requests[0]?.contentChecks.filter(check => check.scope === 'tool-output')).toHaveLength(7);
    expect(payloads).toHaveLength(3);
    need(await app.close());
    const originalDb = new Database(f.paths.databaseFile);
    const original = originalDb.query<{ context_observations_json: string }, [number]>('SELECT context_observations_json FROM runs WHERE id=?').get(accepted.runId)!.context_observations_json;
    originalDb.close();
    for (const fault of ['read-owner', 'request-owner', 'request-content', 'partial-file-hash', 'partial-file-path', 'partial-other-file', 'original-tool-target'] as const) {
      const db = new Database(f.paths.databaseFile), changed = JSON.parse(original);
      const partial = changed.resources.reads.find((item: { nativeToolCallId: string }) => item.nativeToolCallId === 'p11-read-1');
      const toolArgs = db.query<{ args_json: string }, [number]>('SELECT args_json FROM tool_calls WHERE id=?').get(partial.toolCallId)!.args_json;
      if (fault === 'read-owner') changed.resources.reads[0].nativeToolCallId = 'another-tool';
      if (fault === 'request-owner') changed.resources.requests[1].inputIds = [999999];
      if (fault === 'request-content') changed.resources.requests[1].contentChecks.find((item: { scope: string }) => item.scope === 'tool-output').expectedTextHash = 'b'.repeat(64);
      if (fault === 'partial-file-hash') partial.fileHash = 'b'.repeat(64);
      if (fault === 'partial-file-path') partial.path = 'never-registered.txt';
      if (fault === 'partial-other-file') { partial.path = 'not-SKILL.md'; partial.fileHash = hash('Only overlapping marker mentions SKILL.md and scripts/check.ts.'); }
      if (fault === 'partial-file-path' || fault === 'partial-other-file')
        for (const check of changed.resources.requests[1].contentChecks) if (check.nativeEntryId === partial.nativeEntryId && check.scope === 'tool-output') check.path = partial.path;
      if (fault === 'original-tool-target') { const forged = JSON.parse(toolArgs); forged.final = { ...forged.final, path: join(f.root, 'unrelated-file.txt') };
        db.query('UPDATE tool_calls SET args_json=? WHERE id=?').run(JSON.stringify(forged), partial.toolCallId); }
      db.query('UPDATE runs SET context_observations_json=? WHERE id=?').run(JSON.stringify(changed), accepted.runId); db.close();
      app = need(await open());
      expect((await app.queryRunResources({ sessionId: session.sessionId, runId: accepted.runId })).ok).toBe(false);
      need(await app.close());
      if (fault === 'original-tool-target') { const restore = new Database(f.paths.databaseFile); restore.query('UPDATE tool_calls SET args_json=? WHERE id=?').run(toolArgs, partial.toolCallId); restore.close(); }
    }
    const restored = new Database(f.paths.databaseFile);
    restored.query('UPDATE runs SET context_observations_json=? WHERE id=?').run(original, accepted.runId); restored.close(); app = need(await open());
    expect(need(await app.queryRunResources({ sessionId: session.sessionId, runId: accepted.runId })).evidence).toEqual(view.evidence);
    expect(payloads).toHaveLength(3);
  });
  it('accepts this installed native read tool byte and line truncation without treating it as full text', async () => {
    const f = packs(), files = [{ path: 'references/long.txt', text: 'z'.repeat(60 * 1024) },
      { path: 'references/lines.txt', text: 'line\n'.repeat(2100) }, { path: 'references/bytes.txt', text: ('字'.repeat(500) + '\n').repeat(40) }];
    const skill = f.pack('skill', 'v1', false, files), read = createReadToolDefinition(skill.dir);
    for (const file of files) {
      const args = { path: join(skill.dir, file.path) }, result = await read.execute('native-truncation', args, undefined, undefined, undefined as never);
      const text = result.content.filter(block => block.type === 'text').map(block => block.text).join('\n');
      const managed = { ref: skill.ref, path: file.path, fileHash: hash(file.text), text: file.text, relativePath: file.path };
      expect(verifyManagedReadOutput(managed, args, text)).toEqual({ ok: true, data: undefined }); expect(text).not.toBe(file.text);
      expect(verifyManagedReadOutput(managed, args, text + 'unrelated')).toMatchObject({ ok: false, error: { code: 'resource_version_changed' } });
    }
  });
  it.each([{ partial: false, alias: 'plain' }, { partial: true, alias: 'plain' }, { partial: false, alias: 'at' }, { partial: true, alias: 'url' }])
  ('refuses actual changed read output even when the fixed file is restored before post-read validation (%j)', async ({ partial, alias }) => {
    const f = packs(), skill = f.pack('skill'), payloads: unknown[] = []; let reads = 0;
    const actualRead = fsPromises.readFile;
    // Forward every native encoding overload unchanged; only the registered file's read window is intercepted.
    const interceptedRead = spyOn(fsPromises, 'readFile').mockImplementation((async (...args: Parameters<typeof fsPromises.readFile>) => {
      const [path] = args;
      if (typeof path !== 'string' || !path.startsWith(f.bundleRoot) || !path.endsWith('SKILL.md')) return actualRead(...args);
      reads++; const original = readFileSync(path); writeFileSync(path, original.toString('utf8').replace('Invoice SOP', 'Changed SOP'));
      try { return await actualRead(...args); } finally { writeFileSync(path, original); }
    }) as typeof fsPromises.readFile); deferCleanup(() => interceptedRead.mockRestore());
    const server = await createHttpProvider(async request => {
      const payload = await request.json() as { messages: Array<{ role: string; content: string }> }; payloads.push(payload);
      if (payloads.length > 1) return reply();
      const path = payload.messages.find(message => message.role === 'system')!.content.match(/<location>([^<]+)<\/location>/)![1]!;
      return toolReply([{ name: 'read', args: { path: alias === 'at' ? '@' + path : alias === 'url' ? pathToFileURL(path).href : path,
        ...(partial ? { offset: 6, limit: 1 } : {}) } }]);
    }); deferCleanup(() => server.stop());
    const app = need(await createApplication({ paths: f.paths, resourceRoot: f.resourceRoot,
      resourceDefaults: () => ok({ revision: 1, selection: { prompt: null, enabledSkills: [skill.ref] } }),
      agentFactory: definitions => new pi.PiAgentAdapter({ cwd: f.paths.runtimeDir, agentDir: f.paths.runtimeDir, tools: definitions,
        credentials: new InMemoryCredentialStore(), runtimeApiKey: 'p11-loopback' }) })); deferCleanup(() => app.close());
    const session = need(await app.createSession({ title: 'Changed actual read' })), original = need(await app.readWorkspace());
    const workspace = need(await app.updateWorkspace({ expectedRevision: original.revision, change: { kind: 'session', sessionId: session.sessionId } }));
    let finish!: (event: AgentRunEvent & { type: 'run_finished' }) => void;
    const done = new Promise<AgentRunEvent & { type: 'run_finished' }>(resolve => { finish = resolve; });
    const accepted = need(await app.submitInput({ sessionId: session.sessionId, clientSequence: 1, mode: 'prompt', text: 'Read fixed SOP',
      workspace: { revision: workspace.revision, sessionId: session.sessionId, documentRef: null, jobId: null, candidateRef: null },
      config: { version: 1, name: 'P11 read fault', revision: 1, modelRef: { provider: 'p11', model: 'p11' }, native: { authPath: join(f.root, 'empty-auth.json'), modelsPath: null },
        connection: { baseUrl: `http://127.0.0.1:${server.port}/v1`, api: 'openai-completions', contextWindow: 64000, maxTokens: 16384 }, parameters: { maxRetries: 0, maxRetryDelayMs: 100 } } },
      { onEvent: event => { if (event.type === 'run_finished') finish(event); } }));
    expect((await done).result).toMatchObject({ ok: true, data: { status: 'failed', stopped: true, error: { code: 'resource_version_changed' } } });
    const owner = { sessionId: session.sessionId, runId: accepted.runId };
    expect(need(await app.queryRunResources(owner)).evidence?.reads).toEqual([]);
    expect(need(await app.listRunToolCalls(owner)).items).toEqual([expect.objectContaining({ toolName: 'read', status: 'succeeded' })]);
    expect([reads, payloads.length]).toEqual([1, 1]);
  });
  it.each(['openai-completions', 'openai-responses'] as const)('commits actual explicit expansion with the original Input and safely projects it after native release: %s', async api => {
    const f = packs(), skill = f.pack('skill', 'v1', true), payloads: unknown[] = [];
    const server = await createHttpProvider(async request => { payloads.push(await request.json()); return api === 'openai-responses' ? responsesReply() : reply(); }); deferCleanup(() => server.stop());
    let adapter!: pi.PiAgentAdapter;
    let selection: ResourceSelection = { prompt: null, enabledSkills: [skill.ref] };
    const open = () => createApplication({ paths: f.paths, resourceRoot: f.resourceRoot,
      resourceDefaults: () => ok({ revision: 1, selection }),
      agentFactory: definitions => adapter = new pi.PiAgentAdapter({ cwd: f.paths.runtimeDir, agentDir: f.paths.runtimeDir, tools: definitions,
        credentials: new InMemoryCredentialStore(), runtimeApiKey: 'p11-loopback' }) });
    let app = need(await open()); deferCleanup(() => app.close());
    const session = need(await app.createSession({ title: 'Explicit Skill' })), text = '/skill:invoice Explain missing values.';
    let finish!: (value: AgentRunEvent & { type: 'run_finished' }) => void;
    const done = new Promise<AgentRunEvent & { type: 'run_finished' }>(resolve => { finish = resolve; });
    const accepted = need(await app.submitInput({ sessionId: session.sessionId, clientSequence: 1, mode: 'prompt', text,
      config: { version: 1, name: 'P11 explicit', revision: 1, modelRef: { provider: 'p11', model: 'p11' },
        native: { authPath: join(f.root, 'empty-auth.json'), modelsPath: null },
        connection: { baseUrl: `http://127.0.0.1:${server.port}/v1`, api, contextWindow: 64000, maxTokens: 16384 },
        parameters: { maxRetries: 0, maxRetryDelayMs: 100 } } }, { onEvent: event => { if (event.type === 'run_finished') finish(event); } }));
    expect((await done).result).toMatchObject({ ok: true, data: { status: 'completed' } });
    expect(payloads).toHaveLength(1); expect(JSON.stringify(payloads[0])).toContain('Invoice SOP v1.');
    const input = need(await app.querySessionInput({ sessionId: session.sessionId, inputId: accepted.inputId })).input!;
    expect(input.content).toMatchObject({ text, promptText: text, resourceBinding: { requiredSkill: skill.ref } });
    const resources = need(await app.queryRunResources({ sessionId: session.sessionId, runId: accepted.runId }));
    expect(resources.evidence?.expansions).toContainEqual(expect.objectContaining({ inputId: accepted.inputId,
      nativeEntryId: input.nativeEntryId, skill: skill.ref, bundleHash: resources.frozen!.bundleHash }));
    expect(resources.evidence?.requests).toContainEqual(expect.objectContaining({ purpose: 'answer', inputIds: [accepted.inputId],
      contentChecks: expect.arrayContaining([expect.objectContaining({ ref: skill.ref, scope: 'expanded-body',
        nativeEntryId: input.nativeEntryId, sdkInclusion: 'confirmed', wireInclusion: 'confirmed' })]) }));
    expect(need(await app.listRunToolCalls({ sessionId: session.sessionId, runId: accepted.runId })).items).toEqual([]);
    const messages = need(await app.listSessionMessages({ sessionId: session.sessionId })).items;
    expect(messages.find(message => message.role === 'user')).toMatchObject({ textOrigin: 'product-input', blocks: [{ type: 'text', text }] });
    expect((await adapter.releaseSession(session.nativeSessionId)).closed).toBe(true);
    expect(need(await app.listSessionMessages({ sessionId: session.sessionId })).items).toEqual(messages.map(message => ({ ...message, liveOrdinal: null })));
    need(await app.close()); app = need(await open());
    selection = { prompt: null, enabledSkills: [] };
    const nextDone = new Promise<AgentRunEvent & { type: 'run_finished' }>(resolve => { finish = resolve; });
    const next = need(await app.submitInput({ sessionId: session.sessionId, clientSequence: 2, mode: 'prompt', text: 'Use the saved conversation.',
      config: { version: 1, name: 'P11 explicit', revision: 1, modelRef: { provider: 'p11', model: 'p11' },
        native: { authPath: join(f.root, 'empty-auth.json'), modelsPath: null },
        connection: { baseUrl: `http://127.0.0.1:${server.port}/v1`, api, contextWindow: 64000, maxTokens: 16384 },
        parameters: { maxRetries: 0, maxRetryDelayMs: 100 } } }, { onEvent: event => { if (event.type === 'run_finished') finish(event); } }));
    expect((await nextDone).result).toMatchObject({ ok: true, data: { status: 'completed' } });
    const restoredResources = need(await app.queryRunResources({ sessionId: session.sessionId, runId: next.runId }));
    expect(restoredResources.frozen).toBeNull();
    expect(restoredResources.evidence?.requests[0]).toMatchObject({ bundleHash: null, referencedBundleHashes: [resources.frozen!.bundleHash],
      contentChecks: expect.arrayContaining([expect.objectContaining({ ref: skill.ref, nativeEntryId: input.nativeEntryId,
        scope: 'expanded-body', sdkInclusion: 'confirmed', wireInclusion: 'confirmed' })]) });
    expect(restoredResources.evidence?.expansions).toEqual([]); expect(payloads).toHaveLength(2);
    const allMessages = need(await app.listSessionMessages({ sessionId: session.sessionId })).items;
    need(await app.close());
    const db = new Database(f.paths.databaseFile);
    const row = db.query<{ context_observations_json: string }, [number]>('SELECT context_observations_json FROM runs WHERE id=?').get(accepted.runId)!;
    const changed = JSON.parse(row.context_observations_json); changed.resources.expansions[0].expandedTextHash = 'b'.repeat(64);
    db.query('UPDATE runs SET context_observations_json=? WHERE id=?').run(JSON.stringify(changed), accepted.runId);
    db.close(); app = need(await open());
    expect((await app.listSessionMessages({ sessionId: session.sessionId })).ok).toBe(false);
    expect((await app.queryRunResources({ sessionId: session.sessionId, runId: accepted.runId })).ok).toBe(false);
    need(await app.close());
    const repair = new Database(f.paths.databaseFile);
    repair.query('UPDATE runs SET context_observations_json=? WHERE id=?').run(row.context_observations_json, accepted.runId);
    repair.close(); app = need(await open());
    expect(need(await app.listSessionMessages({ sessionId: session.sessionId })).items).toEqual(allMessages.map(message => ({ ...message, liveOrdinal: null })));

  });
  it('keeps unavailable codecs and opaque bodies unknown and ignores assistant echoes or other tool identities', async () => {
    const expected = [{ role: 'system' as const, text: 'fixed body' }, { role: 'tool' as const, text: 'SOP output', toolCallId: 'original-tool' }];
    const wrong = { messages: [{ role: 'assistant', content: 'fixed body' }, { role: 'tool', tool_call_id: 'different-tool', content: 'SOP output' }] };
    expect(checkResourcePayload('openai-completions', wrong, expected).map(fact => fact.inclusion)).toEqual(['not-included', 'not-included']);
    expect(checkResourcePayload('google-generative-ai', wrong, expected)).toEqual(expected.map(() => ({ inclusion: 'unknown', reason: 'payload_codec_unavailable' })));
    expect(await checkResourceWire('openai-completions', 'http://127.0.0.1', { body: new Blob([JSON.stringify(wrong)]) }, expected))
      .toEqual(expected.map(() => ({ inclusion: 'unknown', reason: 'body_unavailable' })));
  });
  it.each(['sdk-read-fallback', 'journal-transaction-fault', 'journal-request-fault'] as const)('blocks explicit continuation without HTTP and preserves only committed facts: %s', async fault => {
    const f = packs(), skill = f.pack('skill', 'v1', true); let requests = 0, attemptedRead = false;
    const server = await createHttpProvider(() => { requests++; return reply(); }); deferCleanup(() => server.stop());
    const open = () => createApplication({ paths: f.paths, resourceRoot: f.resourceRoot,
      resourceDefaults: () => ok({ revision: 1, selection: { prompt: null, enabledSkills: [skill.ref] } }),
      agentFactory: definitions => new pi.PiAgentAdapter({ cwd: f.paths.runtimeDir, agentDir: f.paths.runtimeDir, tools: definitions,
        credentials: new InMemoryCredentialStore(), runtimeApiKey: 'p11-loopback', sessionSetup: sdk => {
          if (fault !== 'sdk-read-fallback') return;
          const prompt = sdk.prompt.bind(sdk);
          sdk.prompt = async (text, options) => {
            const native = sdk.resourceLoader.getSkills().skills[0]!, path = native.filePath;
            native.filePath = join(f.root, 'missing-SKILL.md'); attemptedRead = true;
            try { return await prompt(text, options); } finally { native.filePath = path; }
          };
        } }) });
    let app = need(await open()); deferCleanup(() => app.close());
    if (fault !== 'sdk-read-fallback') {
      need(await app.close()); const db = new Database(f.paths.databaseFile);
      const field = fault === 'journal-transaction-fault' ? 'expansions' : 'requests';
      db.exec(`CREATE TRIGGER p11_evidence_fault BEFORE UPDATE OF context_observations_json ON runs WHEN json_array_length(NEW.context_observations_json,'$.resources.${field}')>0 BEGIN SELECT RAISE(ABORT,'P11 evidence fault'); END;`);
      db.close(); app = need(await open());
    }
    const session = need(await app.createSession({ title: 'Explicit failure' }));
    let finish!: (value: AgentRunEvent & { type: 'run_finished' }) => void;
    const done = new Promise<AgentRunEvent & { type: 'run_finished' }>(resolve => { finish = resolve; });
    const accepted = need(await app.submitInput({ sessionId: session.sessionId, clientSequence: 1, mode: 'prompt', text: 'Explain missing values.', requiredSkill: skill.ref,
      config: { version: 1, name: 'P11 failure', revision: 1, modelRef: { provider: 'p11', model: 'p11' },
        native: { authPath: join(f.root, 'empty-auth.json'), modelsPath: null },
        connection: { baseUrl: `http://127.0.0.1:${server.port}/v1`, api: 'openai-completions', contextWindow: 64000, maxTokens: 16384 }, parameters: { maxRetries: 0, maxRetryDelayMs: 100 } } },
      { onEvent: event => { if (event.type === 'run_finished') finish(event); } }));
    const result = (await done).result; expect(result).toMatchObject({ ok: true, data: { status: 'failed' } });
    expect(requests).toBe(0); expect(attemptedRead).toBe(fault === 'sdk-read-fallback');
    const resourceView = need(await app.queryRunResources({ sessionId: session.sessionId, runId: accepted.runId }));
    expect(resourceView.evidence?.expansions).toHaveLength(fault === 'journal-request-fault' ? 1 : 0);
    expect(resourceView.evidence?.requests).toEqual([]);
    if (fault === 'journal-request-fault') expect(result).toMatchObject({ data: { error: { code: 'resource_evidence_write_failed' } } });
    expect(need(await app.listRunToolCalls({ sessionId: session.sessionId, runId: accepted.runId })).items).toEqual([]);
    await app.close();
    const db = new Database(f.paths.databaseFile); deferCleanup(() => db.close());
    expect(db.query<{ native_entry_id: string | null; status: string }, [number]>('SELECT native_entry_id,status FROM session_inputs WHERE id=?').get(accepted.inputId))
      .toMatchObject({ native_entry_id: fault === 'journal-request-fault' ? expect.any(String) : null });
    expect(db.query<{ count: number }, [number]>("SELECT COUNT(*) AS count FROM session_native_entries WHERE session_id=? AND json_extract(entry_json,'$.message.role')='user'").get(session.sessionId)?.count).toBe(fault === 'journal-request-fault' ? 1 : 0);
    if (fault !== 'sdk-read-fallback') db.exec('DROP TRIGGER p11_evidence_fault');
  });
  it('stops after an actual native read when its necessary receipt fails, preserving one tool result without another HTTP request', async () => {
    const f = packs(), skill = f.pack('skill'); let requests = 0;
    const server = await createHttpProvider(async request => { requests++; const payload = await request.json() as { messages: Array<{ role: string; content: string }> };
      const path = payload.messages.find(message => message.role === 'system')!.content.match(/<location>([^<]+)<\/location>/)![1]!;
      return toolReply([{ name: 'read', args: { path } }]); }); deferCleanup(() => server.stop());
    const open = () => createApplication({ paths: f.paths, resourceRoot: f.resourceRoot,
      resourceDefaults: () => ok({ revision: 1, selection: { prompt: null, enabledSkills: [skill.ref] } }),
      agentFactory: definitions => new pi.PiAgentAdapter({ cwd: f.paths.runtimeDir, agentDir: f.paths.runtimeDir, tools: definitions,
        credentials: new InMemoryCredentialStore(), runtimeApiKey: 'p11-loopback' }) });
    let app = need(await open()); deferCleanup(() => app.close()); need(await app.close());
    const db = new Database(f.paths.databaseFile); db.exec("CREATE TRIGGER p11_read_failure BEFORE UPDATE OF context_observations_json ON runs WHEN json_array_length(NEW.context_observations_json,'$.resources.reads')>0 BEGIN SELECT RAISE(ABORT,'P11 read receipt failure'); END;"); db.close(); app = need(await open());
    const session = need(await app.createSession({ title: 'Read receipt failure' })); const original = need(await app.readWorkspace());
    const workspace = need(await app.updateWorkspace({ expectedRevision: original.revision, change: { kind: 'session', sessionId: session.sessionId } }));
    let finish!: (event: AgentRunEvent & { type: 'run_finished' }) => void;
    const done = new Promise<AgentRunEvent & { type: 'run_finished' }>(resolve => { finish = resolve; });
    const first = need(await app.submitInput({ sessionId: session.sessionId, clientSequence: 1, mode: 'prompt', text: 'Read fixed SOP',
      workspace: { revision: workspace.revision, sessionId: session.sessionId, documentRef: null, jobId: null, candidateRef: null },
      config: { version: 1, name: 'P11 fault', revision: 1, modelRef: { provider: 'p11', model: 'p11' }, native: { authPath: join(f.root, 'empty-auth.json'), modelsPath: null },
        connection: { baseUrl: `http://127.0.0.1:${server.port}/v1`, api: 'openai-completions', contextWindow: 64000, maxTokens: 16384 }, parameters: { maxRetries: 0, maxRetryDelayMs: 100 } } },
      { onEvent: event => { if (event.type === 'run_finished') finish(event); } }));
    expect((await done).result).toMatchObject({ ok: true, data: { status: 'failed', stopped: true, error: { code: 'resource_evidence_write_failed' } } });
    const owner = { sessionId: session.sessionId, runId: first.runId };
    expect(need(await app.listRunToolCalls(owner)).items).toEqual([expect.objectContaining({ toolName: 'read', status: 'succeeded' })]);
    expect(need(await app.queryRunResources(owner)).evidence?.reads).toEqual([]);
    expect(need(await app.queryRunResources(owner)).evidence?.requests).toHaveLength(1);
    expect(requests).toBe(1); need(await app.close()); app = need(await open());
    expect(need(await app.listRunToolCalls(owner)).items).toHaveLength(1); expect(requests).toBe(1);
  });

  it.each(['steer', 'followUp', 'cancel', 'steer-fallback', 'followUp-fallback'] as const)('keeps queued %s bound to the original Run after configuration changes and respects cancellation', async mode => {
    const f = packs(), firstSkill = f.pack('skill', 'v1', true);
    let selection: ResourceSelection = { prompt: null, enabledSkills: [firstSkill.ref] }, revision = 1;
    let entered!: () => void, release!: () => void;
    const firstEntered = new Promise<void>(resolve => { entered = resolve; }), barrier = new Promise<void>(resolve => { release = resolve; });
    const payloads: Array<{ messages: Array<{ role: string; content: string }> }> = [];
    const server = await createHttpProvider(async request => { payloads.push(await request.json()); if (payloads.length === 1) { entered(); await barrier; } return reply(); });
    deferCleanup(async () => { release(); await server.stop(); });
    const inputMode = mode === 'cancel' || mode === 'followUp-fallback' ? 'followUp' : mode === 'steer-fallback' ? 'steer' : mode;
    let native!: AgentSession, attemptedExpansion = 0;
    const app = need(await createApplication({ paths: f.paths, resourceRoot: f.resourceRoot, resourceDefaults: () => ok({ revision, selection }),
      agentFactory: definitions => new pi.PiAgentAdapter({ cwd: f.paths.runtimeDir, agentDir: f.paths.runtimeDir, tools: definitions,
        credentials: new InMemoryCredentialStore(), runtimeApiKey: 'p11-loopback', sessionSetup: session => {
          native = session;
          if (!mode.endsWith('-fallback')) return;
          const original = session[inputMode].bind(session);
          session[inputMode] = async (text, images) => {
            const skill = session.resourceLoader.getSkills().skills[0]!, old = skill.filePath;
            skill.filePath = join(f.root, 'missing-native-skill.md'); attemptedExpansion++;
            try { return await original(text, images); } finally { skill.filePath = old; }
          };
        } }) })); deferCleanup(() => app.close());
    const session = need(await app.createSession({ title: `Queued resource ${mode}` }));
    const config = { version: 1 as const, name: 'P11 queue', revision: 1, modelRef: { provider: 'p11', model: 'p11' }, native: { authPath: join(f.root, 'empty-auth.json'), modelsPath: null },
      connection: { baseUrl: `http://127.0.0.1:${server.port}/v1`, api: 'openai-completions', contextWindow: 64000, maxTokens: 16384 }, parameters: { maxRetries: 0, maxRetryDelayMs: 100 } };
    let finish!: (event: AgentRunEvent & { type: 'run_finished' }) => void;
    const done = new Promise<AgentRunEvent & { type: 'run_finished' }>(resolve => { finish = resolve; });
    const first = need(await app.submitInput({ sessionId: session.sessionId, clientSequence: 1, mode: 'prompt', text: 'Initial request', config }, { onEvent: event => { if (event.type === 'run_finished') finish(event); } }));
    try {
      await firstEntered;
      const nextSkill = f.pack('skill', 'v2', true);
      selection = { prompt: null, enabledSkills: [nextSkill.ref] }; revision = 2;
      const request = { sessionId: session.sessionId, runId: first.runId, clientSequence: 2, mode: inputMode, text: `Queued ${mode} original text`, requiredSkill: firstSkill.ref };
      const submitted = await app.submitInput(request);
      expect(payloads).toHaveLength(1);
      if (mode.endsWith('-fallback')) {
        expect(submitted).toMatchObject({ ok: false, error: { code: 'resource_expansion_mismatch' } });
        release(); expect((await done).result).toMatchObject({ ok: true, data: { status: 'failed', stopped: true, error: { code: 'resource_expansion_mismatch' } } });
        const owner = { sessionId: session.sessionId, runId: first.runId };
        expect(need(await app.querySessionInput({ sessionId: session.sessionId, clientSequence: 2 })).input)
          .toMatchObject({ status: 'failed', nativeEntryId: null });
        expect(need(await app.queryRunResources(owner)).evidence?.expansions).toEqual([]);
        expect(need(await app.listRunToolCalls(owner)).items).toEqual([]); expect(payloads).toHaveLength(1); expect(attemptedExpansion).toBe(1);
        expect(native.getSteeringMessages()).toEqual([]); expect(native.getFollowUpMessages()).toEqual([]);
        expect(native.agent.hasQueuedMessages()).toBe(false); expect(native.isStreaming).toBe(false);
        return;
      }
      const queued = need(submitted); expect(need(await app.submitInput(request))).toEqual(queued);
      expect(await app.submitInput({ ...request, clientSequence: 3, requiredSkill: nextSkill.ref })).toMatchObject({ ok: false, error: { code: 'resource_required_unavailable' } });
      if (mode === 'cancel') {
        expect(await app.cancelRun(first.runId)).toMatchObject({ ok: true }); release();
        expect((await done).result).toMatchObject({ ok: true, data: { status: 'cancelled', stopped: true } });
        const owner = { sessionId: session.sessionId, runId: first.runId };
        expect(need(await app.querySessionInput({ sessionId: session.sessionId, inputId: queued.inputId })).input).toMatchObject({ status: 'cancelled', nativeEntryId: null });
        expect(need(await app.queryRunResources(owner)).evidence?.expansions).toEqual([]);
        expect(need(await app.listRunToolCalls(owner)).items).toEqual([]); expect(payloads).toHaveLength(1);
        return;
      }
      release();
      expect((await done).result).toMatchObject({ ok: true, data: { status: 'completed' } });
      const view = need(await app.queryRunResources({ sessionId: session.sessionId, runId: first.runId }));
      expect(view.frozen?.discoveredSkills).toEqual([firstSkill.ref]); expect(view.evidence?.expansions).toEqual([expect.objectContaining({ inputId: queued.inputId, skill: firstSkill.ref })]);
      expect(payloads).toHaveLength(2); expect(JSON.stringify(payloads[1].messages.filter(message => message.role === 'user').at(-1)?.content)).toContain('Invoice SOP v1.');
      expect(JSON.stringify(payloads[1])).not.toContain('Invoice SOP v2.');
      expect(need(await app.querySessionInput({ sessionId: session.sessionId, inputId: queued.inputId })).input?.content.text).toBe(request.text);
      const nextDone = new Promise<AgentRunEvent & { type: 'run_finished' }>(resolve => { finish = resolve; });
      const next = need(await app.submitInput({ sessionId: session.sessionId, clientSequence: 3, mode: 'prompt', text: 'New Run Skill', requiredSkill: nextSkill.ref, config }, { onEvent: event => { if (event.type === 'run_finished') finish(event); } }));
      expect((await nextDone).result).toMatchObject({ ok: true, data: { status: 'completed' } });
      expect(need(await app.queryRunResources({ sessionId: session.sessionId, runId: next.runId })).evidence?.expansions).toEqual([expect.objectContaining({ skill: nextSkill.ref })]);
      expect(payloads).toHaveLength(3); expect(JSON.stringify(payloads[2].messages.filter(message => message.role === 'user').at(-1)?.content)).toContain('Invoice SOP v2.');
      expect(need(await app.submitInput(request))).toEqual(queued); expect(payloads).toHaveLength(3);
    } finally { release(); }
  });

  it('keeps all unrelated resource collections empty and uses the native short index', () => {
    const f = packs(), prompt = f.pack('prompt'), skill = f.pack('skill');
    const frozen = need(f.hub.freeze({ selection: { prompt: prompt.ref, enabledSkills: [skill.ref] }, settingsRevision: 1,
      activeToolNames: ['read'], requiredSkill: null })); if (!frozen) throw new Error('No frozen bundle');
    const create = Reflect.get(pi, 'createRunResourceLoader'); expect(typeof create).toBe('function');
    if (typeof create !== 'function') throw new Error('Controlled resource loader missing');
    const loader = need<import('@earendil-works/pi-coding-agent').ResourceLoader>(create({ fixedSystemPrompt: INVOICE_TOOLS_SYSTEM_PROMPT,
      frozen, bundleDirectory: join(f.bundleRoot, frozen.bundleHash) }));
    expect(loader.getSystemPrompt()).toBe(INVOICE_TOOLS_SYSTEM_PROMPT);
    expect(loader.getAppendSystemPrompt()).toEqual([prompt.text, expect.stringContaining('readiness: Ready (0/0 capabilities); No requirements')]);
    expect(loader.getSkills().skills.map(item => item.name)).toEqual(['invoice']);
    expect(formatSkillsForPrompt(loader.getSkills().skills, 'read')).toContain('Invoice fields v1');
    expect(loader.getPrompts()).toEqual({ prompts: [], diagnostics: [] }); expect(loader.getAgentsFiles()).toEqual({ agentsFiles: [] });
    expect(loader.getThemes()).toEqual({ themes: [], diagnostics: [] }); expect(loader.getExtensions().extensions).toEqual([]);
    expect(() => loader.extendResources({ skillPaths: [] })).toThrow();
    writeFileSync(join(f.bundleRoot, frozen.bundleHash, 'skills', 'invoice', 'v1', 'SKILL.md'), skill.text + ' altered');
    expect(create({ fixedSystemPrompt: INVOICE_TOOLS_SYSTEM_PROMPT, frozen, bundleDirectory: join(f.bundleRoot, frozen.bundleHash) }))
      .toMatchObject({ ok: false, error: { code: 'resource_bundle_unavailable' } });
  });

  it('rebuilds the idle native Session for a changed resource key, with one system assembly and no history replay', async () => {
    const f = packs(), prompt = f.pack('prompt'), skill = f.pack('skill');
    let selection: ResourceSelection = { prompt: prompt.ref, enabledSkills: [skill.ref] }, revision = 1;
    const payloads: Array<{ messages: Array<{ role: string; content: string }> }> = [], sessions: AgentSession[] = [];
    const server = await createHttpProvider(async request => { payloads.push(await request.json()); return reply(); }); deferCleanup(() => server.stop());
    const app = need(await createApplication({ paths: f.paths, resourceRoot: f.resourceRoot, resourceDefaults: () => ok({ revision, selection }),
      agentFactory: definitions => new pi.PiAgentAdapter({ cwd: f.paths.runtimeDir, agentDir: f.paths.runtimeDir, tools: definitions,
        credentials: new InMemoryCredentialStore(), runtimeApiKey: 'p11-loopback', sessionSetup: session => { sessions.push(session); } }) }));
    deferCleanup(() => app.close());
    const session = need(await app.createSession({ title: 'P11 cache' }));
    const current = need(await app.readWorkspace()); need(await app.updateWorkspace({ expectedRevision: current.revision, change: { kind: 'session', sessionId: session.sessionId } }));
    const config = { version: 1 as const, name: 'P11 loopback', revision: 1, modelRef: { provider: 'p11', model: 'p11' },
      native: { authPath: join(f.root, 'empty-auth.json'), modelsPath: null },
      connection: { baseUrl: `http://127.0.0.1:${server.port}/v1`, api: 'openai-completions', contextWindow: 64000, maxTokens: 16384 }, parameters: { maxRetries: 0, maxRetryDelayMs: 100 } };
    for (let index = 1; index <= 3; index++) {
      if (index === 2) { selection = { prompt: f.pack('prompt', 'v2').ref, enabledSkills: [f.pack('skill', 'v2', true).ref] }; revision = 2; }
      let finish!: (value: AgentRunEvent & { type: 'run_finished' }) => void;
      const done = new Promise<AgentRunEvent & { type: 'run_finished' }>(resolve => { finish = resolve; });
      const workspace = need(await app.readWorkspace());
      const accepted = need(await app.submitInput({ sessionId: session.sessionId, clientSequence: index, mode: 'prompt', text: `Input ${index}`, config,
        workingDirectory: f.paths.runtimeDir,
        workspace: { revision: workspace.revision, sessionId: session.sessionId, documentRef: null, jobId: null, candidateRef: null } },
        { onEvent: event => { if (event.type === 'run_finished') finish(event); } }));
      expect((await done).result).toMatchObject({ ok: true, data: { status: 'completed' } });
      const saved = need(await app.queryRun(accepted.runId)); expect(saved.config.agent).toMatchObject({ nativeSessionId: session.nativeSessionId, resourcePolicy: 'p11-resources-v1' });
      const system = payloads.at(-1)!.messages.find(message => message.role === 'system')!.content;
      expect(system.split(INVOICE_TOOLS_SYSTEM_PROMPT)).toHaveLength(2);
      expect(system.split(`Business invoice constraints ${index === 1 ? 'v1' : 'v2'}.`)).toHaveLength(2);
      expect(system).not.toContain('Invoice SOP');
      const resources = need(await app.queryRunResources({ sessionId: session.sessionId, runId: accepted.runId }));
      expect(resources.evidence!.requests[0]!.systemPromptHash).toBe(hash(system));
      expect(resources.evidence!.requests[0]!.contentChecks).toContainEqual(expect.objectContaining({ scope: 'business-prompt', sdkInclusion: 'confirmed', wireInclusion: 'confirmed' }));
      expect(resources.evidence!.requests[0]!.contentChecks.filter(check => check.scope === 'skill-index')).toHaveLength(index === 1 ? 1 : 0);
      expect(system.includes('Invoice fields v1')).toBe(index === 1);
      expect(system.includes('Invoice fields v2')).toBe(index !== 1);
      expect(payloads.at(-1)!.messages.filter(message => message.role === 'user')).toHaveLength(index);
      expect(need(await app.listSessionMessages({ sessionId: session.sessionId })).items.filter(message => message.role === 'user')).toHaveLength(index);
    }
    expect(payloads).toHaveLength(3); expect(sessions).toHaveLength(2); expect(sessions[0]).not.toBe(sessions[1]);
  });
});
