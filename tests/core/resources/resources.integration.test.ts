import { openTestDatabase } from '../../support/database.ts';
import { describe, expect, it } from 'bun:test';
import { mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadSkillsFromDir } from '@earendil-works/pi-coding-agent';
import { InMemoryCredentialStore } from '@earendil-works/pi-ai';
import { createApplication } from '../../../apps/composition.ts';
import { resolveProductPaths } from '../../../packages/shared/src/paths.ts';
import * as core from '../../../packages/core/src/index.ts';
import * as pi from '../../../packages/runtime-pi/src/index.ts';
import { canonicalResourceManifest, EMPTY_RESOURCE_SELECTION, ResourceManifestSchema, ResourceRefSchema, FrozenResourcesSchema, ok } from '../../../packages/contracts/src/index.ts';
import type { ResourceDependency, ResourceSelection, ToolDefinition, AgentRunEvent, RunScope, Result } from '../../../packages/contracts/src/index.ts';
import { mkdtempSync, createHttpProvider, deferCleanup } from '../../support/resources.ts';

const tools = ['read', 'read_invoice_evidence', 'check_invoice_sources', 'normalize_invoice_values', 'validate_invoice_candidate'];
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'flowmate-resources-'));
  const resourceRoot = join(root, 'author'), bundleRoot = join(root, 'bundles');
  mkdirSync(resourceRoot);
  const storagePaths = resolveProductPaths(join(root, 'storage')); if (!storagePaths.ok) throw new Error(storagePaths.error.code);
  const storage = openTestDatabase(storagePaths.data); if (!storage.ok) throw new Error(storage.error.code);
  deferCleanup(() => storage.data.close()); const contents = storage.data.contents;
  function pack(kind: 'prompt' | 'skill', id = 'invoice', version = 'v1', body?: string, requires: ResourceDependency[] = []) {
    const dir = join(resourceRoot, kind === 'prompt' ? 'prompts' : 'skills', id);
    mkdirSync(join(dir, 'references'), { recursive: true });
    const bodyFile = kind === 'prompt' ? 'prompt.md' : 'SKILL.md';
    const bodyText = body ?? (kind === 'prompt' ? '核对发票字段，不补造缺失值。' : `---\nname: ${id}\ndescription: 发票字段整理\ndisable-model-invocation: false\n---\n请读取 references/field-rules.md。`);
    const texts = { [bodyFile]: bodyText, 'references/field-rules.md': '发票😀字段：缺失不等于零。' };
    const manifest = ResourceManifestSchema.parse({ schemaVersion: 2, kind, id, version, bodyFile,
      keywords: ['发票'], requires, files: Object.entries(texts).map(([path, text]) => ({ path,
        bytes: Buffer.byteLength(text) })) });
    for (const [path, text] of Object.entries(texts)) writeFileSync(join(dir, path), text);
    writeFileSync(join(dir, 'resource.json'), JSON.stringify(manifest));
    const ref = ResourceRefSchema.parse({ kind, id, version });
    return { dir, ref, manifest, bodyText, texts };
  }
  const inspect = Reflect.get(pi, 'inspectNativeResources');
  const create = Reflect.get(core, 'createResourceService');
  const service = () => {
    expect(typeof inspect).toBe('function'); expect(typeof create).toBe('function');
    return create({ resourceRoot, bundleRoot, contents, registeredToolNames: tools, inspectNativeResources: inspect });
  };
  return { root, resourceRoot, bundleRoot, pack, service, inspect, contents, storage: storage.data };
}

describe('P11 real resource files and native discovery', () => {
  it('constructs without root contents and requires explicit current originals for nonempty resource operations', async () => {
    const f = fixture(), skill = f.pack('skill'), selection = { prompt: null, enabledSkills: [skill.ref] };
    const hub = core.createResourceService({ resourceRoot: f.resourceRoot, bundleRoot: f.bundleRoot,
      registeredToolNames: tools, inspectNativeResources: pi.inspectNativeResources });
    expect(hub.catalog({ revision: 1, selection })).toMatchObject({ ok: false, error: { code: 'resource_bundle_unavailable' } });
    expect(hub.freeze({ selection: EMPTY_RESOURCE_SELECTION, settingsRevision: 1, activeToolNames: tools, requiredSkill: null }))
      .toEqual({ ok: true, data: null });
    const frozen = await f.storage.read(scope => hub.freeze({ selection, settingsRevision: 1,
      activeToolNames: tools, requiredSkill: skill.ref }, scope.contents));
    if (!frozen.ok || !frozen.data) throw Error('The explicit current contents did not freeze the bundle.');
    const fixed = frozen.data;
    expect(hub.verifyFrozen(fixed)).toMatchObject({ ok: false, error: { code: 'resource_bundle_unavailable' } });
    expect(await f.storage.read(scope => hub.verifyFrozen(fixed, scope.contents))).toEqual({ ok: true, data: undefined });
    expect(await f.storage.read(scope => hub.readFrozenFile(fixed, { ref: skill.ref, path: 'SKILL.md' }, scope.contents)))
      .toMatchObject({ ok: true, data: { text: skill.bodyText } });
  });
  for (const operation of ['validate', 'author', 'frozen'] as const) {
    it(`uses current owner contents for ${operation} resource queries after the default scope expires`, async () => {
      const f = fixture(), skill = f.pack('skill');
      const selection = { prompt: null, enabledSkills: [skill.ref] };
      const hub = await f.storage.read(scope => core.createResourceService({ resourceRoot: f.resourceRoot,
        bundleRoot: f.bundleRoot, contents: scope.contents, registeredToolNames: tools, inspectNativeResources: pi.inspectNativeResources }));
      const frozen = await f.storage.read(scope => hub.freeze({ selection, settingsRevision: 1,
        activeToolNames: tools, requiredSkill: skill.ref }, scope.contents));
      if (!frozen.ok || !frozen.data) throw new Error('Expected an owned resource bundle.');
      const fixed = frozen.data, file = { ref: skill.ref, path: 'SKILL.md' };
      const result = await f.storage.read((scope): Result<unknown> => operation === 'validate'
        ? hub.validateSelection(selection, [], scope.contents)
        : operation === 'author' ? hub.readFile(file, selection, [], scope.contents)
          : hub.readFrozenFile(fixed, file, scope.contents));
      expect(result.ok).toBe(true);
      if (operation !== 'validate') expect(result).toMatchObject({ ok: true, data: { text: expect.stringContaining('发票字段整理') } });
    });
  }
  it('uses current SQL contents for admission and reuses its frozen combination after default contents expire', async () => {
    const f = fixture(), prompt = f.pack('prompt'), skill = f.pack('skill');
    const selection = { prompt: prompt.ref, enabledSkills: [skill.ref] };
    const hub = await f.storage.read(scope => core.createResourceService({ resourceRoot: f.resourceRoot, bundleRoot: f.bundleRoot,
      contents: scope.contents, registeredToolNames: tools, inspectNativeResources: pi.inspectNativeResources }));
    const catalog = await f.storage.read(scope => hub.catalog({ revision: 1, selection }, scope.contents));
    expect(catalog).toMatchObject({ ok: true, data: { diagnostics: [], items: [
      { ref: prompt.ref, available: true }, { ref: skill.ref, available: true },
    ] } });
    const rows = () => f.storage.read(scope => scope.db.query('SELECT owner_kind,owner_id,relative_path,content FROM managed_file_contents ORDER BY owner_kind,owner_id,relative_path').all());
    expect(await rows()).toHaveLength(6);
    const freeze = (revision: number) => f.storage.read(scope => {
      const result = hub.freeze({ selection, settingsRevision: revision, activeToolNames: tools, requiredSkill: skill.ref }, scope.contents);
      expect(scope.db.inTransaction).toBe(false);
      return result;
    });
    const first = await freeze(1);
    expect(first.ok && first.data).toBeTruthy(); if (!first.ok || !first.data) throw new Error('Expected the first scoped bundle.');
    const before = await rows(); expect(before).toHaveLength(13);
    const path = join(first.data.bundleDirectory, 'bundle.json'), original = readFileSync(path);
    const second = await freeze(2);
    expect(second.ok && second.data).toBeTruthy(); if (!second.ok || !second.data) throw new Error('Expected the reused scoped bundle.');
    expect(second.data.bundleId).toBe(first.data.bundleId);
    expect(second.data.settingsRevision).toBe(2);
    expect(readFileSync(path)).toEqual(original);
    expect(await rows()).toEqual(before);
    const frozen = second.data;
    expect(await f.storage.read(scope => hub.verifyFrozen(frozen, scope.contents))).toEqual(ok(undefined));
    expect(hub.verifyFrozen(frozen)).toMatchObject({ ok: false, error: { code: 'resource_bundle_unavailable' } });
    const changed = Buffer.from(original); changed[changed.length - 1] = changed[changed.length - 1] === 32 ? 10 : 32;
    writeFileSync(path, changed);
    expect(await f.storage.read(scope => hub.verifyFrozen(frozen, scope.contents)))
      .toMatchObject({ ok: false, error: { code: 'resource_bundle_unavailable' } });
    expect(await freeze(3)).toMatchObject({ ok: false, error: { code: 'resource_bundle_unavailable' } });
    expect(await rows()).toEqual(before);
  });

  it('freezes a readiness index and injects scope-specific missing dependencies without exposing excluded bodies', () => {
    const f = fixture(), ready = f.pack('skill', 'ready', 'v1', undefined, [{ kind: 'tool', name: 'read' }]),
      missing = f.pack('skill', 'missing', 'v1', undefined, [{ kind: 'tool', name: 'write' }]);
    const frozen = f.service().freeze({ settingsRevision: 1, selection: { prompt: null, enabledSkills: [ready.ref, missing.ref] },
      activeToolNames: ['read'], requiredSkill: null });
    expect(frozen.ok).toBe(true); if (!frozen.ok || !frozen.data) throw new Error('missing frozen resources');
    const loader = pi.createRunResourceLoader({ contents: f.contents, fixedSystemPrompt: 'review', frozen: frozen.data,
      bundleDirectory: frozen.data.bundleDirectory, activeToolNames: ['read'] });
    expect(loader.ok).toBe(true); if (!loader.ok) throw new Error(loader.error.code);
    const text = loader.data.getAppendSystemPrompt().join('\n');
    expect(text).toContain('ready:'); expect(text).toContain('Ready (1/1 capabilities)');
    expect(text).toContain('missing:'); expect(text).toContain('Partial (0/1 capabilities)'); expect(text).toContain('write');
    expect(loader.data.getSkills().skills.map(skill => skill.name)).toEqual(['ready']);
    expect(loader.data.bodyFor(missing.ref)).toBeNull();
    const child = pi.createRunResourceLoader({ contents: f.contents, fixedSystemPrompt: 'child', frozen: frozen.data,
      bundleDirectory: frozen.data.bundleDirectory, activeToolNames: [], visibleSkillRefs: [] });
    expect(child.ok).toBe(true); if (!child.ok) throw new Error(child.error.code);
    expect(child.data.getSkills().skills).toEqual([]);
    expect(child.data.getAppendSystemPrompt().join('\n')).toContain('Partial (0/1 capabilities)');
    if (!frozen.data.skillIndex) throw Error('Missing fixed readiness index');
    const changed = { ...frozen.data, skillIndex: { entries: frozen.data.skillIndex.entries.map(entry => ({ ...entry, description: 'Changed index' })) } };
    expect(f.service().verifyFrozen(changed).ok).toBe(false);
    expect(pi.createRunResourceLoader({ contents: f.contents, fixedSystemPrompt: 'review', frozen: changed,
      bundleDirectory: frozen.data.bundleDirectory, activeToolNames: ['read'] }).ok).toBe(false);
  });
  it('rejects a combined native Skill index and readiness section larger than 16 KiB', () => {
    const f = fixture(), refs = Array.from({ length: 18 }, (_, index) => f.pack('skill', `sop-${index}`, 'v1',
      `---\nname: sop-${index}\ndescription: ${'a'.repeat(1000)}\n---\nRead this SOP only when needed.`).ref);
    const frozen = f.service().freeze({ settingsRevision: 1, selection: { prompt: null, enabledSkills: refs },
      activeToolNames: ['read'], requiredSkill: null });
    if (!frozen.ok || !frozen.data) throw Error('Expected valid packages before runtime index validation');
    expect(pi.createRunResourceLoader({ contents: f.contents, fixedSystemPrompt: 'review', frozen: frozen.data,
      bundleDirectory: frozen.data.bundleDirectory, activeToolNames: ['read'] })).toMatchObject({ ok: false,
      error: { code: 'resource_bundle_unavailable' } });
  });
  // Observe the existing 30s Run budget and cleanup; cancellation still must finish within 3s.
  it.each(['invoice-party-role-review', 'invoice-date-currency-review', 'invoice-line-calculation-review', 'invoice-candidate-issue-triage', 'invoice-review-handoff', 'all-five', 'all-five-budget', 'all-five-cancel'])
    ('delivers the new invoice Skill index and frozen files through the real Provider and dedicated tools: %s', async id => {
    const root = mkdtempSync(join(tmpdir(), 'flowmate-five-skill-run-'));
    const paths = resolveProductPaths(join(root, 'product')); if (!paths.ok) throw new Error(paths.error.code);
    const sourceRoot = join(root, 'source'), source = join(sourceRoot, '000001'); mkdirSync(source, { recursive: true });
    const files = { 'original.png': Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/a54AAAAASUVORK5CYII=', 'base64'),
      'content.json': Buffer.from(JSON.stringify([{ type: 'text', text: 'Total 113.00', bbox: [0, 0, 1, 1], page_idx: 0 }])),
      'pages.json': Buffer.from(JSON.stringify([{ pageNumber: 1, text: 'Total 113.00', blockCount: 1 }])) };
    for (const [name, bytes] of Object.entries(files)) writeFileSync(join(source, name), bytes);
    writeFileSync(join(source, 'metadata.json'), JSON.stringify({ schemaVersion: 1, sampleId: '000001', datasetId: 'voxel51-hq-invoice-ocr',
      sourceRecordId: 'sken-local', datasetRevision: 'sken-controlled', qualityStatus: 'complete', allowedUsesClaim: ['local test'], licenseVerification: 'not_verified',
      files: Object.entries(files).map(([path, bytes]) => ({ path, bytes: bytes.length })) }));
    const ids = ['invoice-party-role-review', 'invoice-date-currency-review', 'invoice-line-calculation-review', 'invoice-candidate-issue-triage', 'invoice-review-handoff'];
    const requested = id.startsWith('all-five') ? ids : [id];
    const calls = requested.flatMap(skill => [{ name: 'list_skill_resources', args: { skill } },
      { name: 'read_skill_resource', args: { skill, path: 'SKILL.md' } }, { name: 'read_skill_resource', args: { skill, path: 'references/guide.md' } }]);
    const payloads: Array<{ messages: Array<{ role: string; content: string }> }> = [];
    let entered!: () => void;
    const secondRequest = new Promise<void>(resolve => { entered = resolve; });
    const server = await createHttpProvider(async request => {
      payloads.push(await request.json() as (typeof payloads)[number]);
      if (id === 'all-five-cancel' && payloads.length === 2) {
        entered();
        await new Promise<void>(resolve => {
          if (request.signal.aborted) resolve(); else request.signal.addEventListener('abort', () => resolve(), { once: true });
        });
      }
      const toolCalls = payloads.length === 1;
      const delta = toolCalls ? { role: 'assistant', tool_calls: calls.map((call, index) => ({ index, id: `sken-${index}`,
        type: 'function', function: { name: call.name, arguments: JSON.stringify(call.args) } })) } : { role: 'assistant', content: '五份指导已读取。' };
      const chunk = (value: unknown, finish: string | null) => 'data: ' + JSON.stringify({ id: 'sken', choices: [{ index: 0, delta: value, finish_reason: finish }] }) + '\n\n';
      return new Response(chunk(delta, null) + chunk({}, toolCalls ? 'tool_calls' : 'stop') + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
    }); deferCleanup(() => server.stop());
    let selection: ResourceSelection = EMPTY_RESOURCE_SELECTION;
    const created = await createApplication({ paths: paths.data, invoiceSourceRoot: sourceRoot,
      resourceDefaults: () => ok({ revision: 1, selection }),
      agentFactory: tools => new pi.PiAgentAdapter({ cwd: paths.data.runtimeDir, agentDir: paths.data.runtimeDir, tools,
        credentials: new InMemoryCredentialStore(), runtimeApiKey: 'controlled-sken-key' }) });
    if (!created.ok) throw new Error(created.error.code); const app = created.data; deferCleanup(() => app.close());
    const catalog = await app.listResources(); if (!catalog.ok) throw new Error(catalog.error.code);
    const skills = catalog.data.items.filter(item => item.ref.kind === 'skill' && ids.includes(item.ref.id)); expect(skills).toHaveLength(5);
    selection = { prompt: null, enabledSkills: skills.map(item => item.ref) };
    const doc = await app.importInvoiceMaterial(source); if (!doc.ok) throw new Error(doc.error.code);
    const session = await app.createSession(); if (!session.ok) throw new Error(session.error.code);
    const before = await app.readWorkspace(); if (!before.ok) throw new Error(before.error.code);
    const sessionWorkspace = await app.updateWorkspace({ expectedRevision: before.data.revision, change: { kind: 'session', sessionId: session.data.sessionId } });
    if (!sessionWorkspace.ok) throw new Error(sessionWorkspace.error.code);
    const documentWorkspace = await app.updateWorkspace({ expectedRevision: sessionWorkspace.data.revision, change: { kind: 'document', documentId: doc.data.documentRef.id } });
    if (!documentWorkspace.ok) throw new Error(documentWorkspace.error.code);
    const task = await app.startTask({ clientSequence: 1, expectedRevision: documentWorkspace.data.revision, documentRef: doc.data.documentRef, goal: 'Inspect five review guides' });
    if (!task.ok) throw new Error(task.error.code);
    const workspace = await app.readWorkspace(); if (!workspace.ok) throw new Error(workspace.error.code);
    let finish!: (event: Extract<AgentRunEvent, { type: 'run_finished' }>) => void;
    const done = new Promise<Extract<AgentRunEvent, { type: 'run_finished' }>>(resolve => { finish = resolve; });
    const accepted = await app.submitInput({ sessionId: session.data.sessionId, clientSequence: 1, mode: 'prompt', text: '读取这五份复核指导，不修改候选。',
      timeoutMs: 30000, budget: { maxToolCalls: id === 'all-five-budget' ? 14 : 20, maxModelCalls: 3 }, workspace: { revision: workspace.data.revision, sessionId: session.data.sessionId,
        documentRef: workspace.data.documentRef, jobId: workspace.data.jobId, candidateRef: workspace.data.candidateRef },
      config: { version: 1, name: 'SKEN controlled', revision: 1, modelRef: { provider: 'sken', model: 'sken' }, native: { authPath: join(root, 'empty.json'), modelsPath: null },
        connection: { baseUrl: `http://127.0.0.1:${server.port}/v1`, api: 'openai-completions', contextWindow: 64000, maxTokens: 16384 }, parameters: { maxRetries: 0, maxRetryDelayMs: 100 } } },
      { onEvent: event => { if (event.type === 'run_finished') finish(event); } });
    if (!accepted.ok) throw new Error(accepted.error.code);
    const started = performance.now();
    if (id === 'all-five-cancel') {
      await secondRequest;
      const cancelling = performance.now();
      expect(await app.cancelRun(accepted.data.runId)).toMatchObject({ ok: true });
      expect((await done).result).toMatchObject({ ok: true, data: { status: 'cancelled', stopped: true } });
      expect(performance.now() - cancelling).toBeLessThan(3000);
      expect(payloads).toHaveLength(2);
      return;
    }
    const ended = await done;
    expect(performance.now() - started).toBeLessThan(30000);
    if (id === 'all-five-budget') {
      expect(ended.result).toMatchObject({ ok: true, data: { status: 'failed', stopped: true, error: { code: 'tool_budget_exceeded' } } });
      expect(payloads).toHaveLength(1);
      return;
    }
    expect(ended.result).toMatchObject({ ok: true, data: { status: 'completed' } }); expect(payloads).toHaveLength(2);
    const view = await app.queryRunResources({ sessionId: session.data.sessionId, runId: accepted.data.runId }); if (!view.ok) throw new Error(view.error.code);
    const system = payloads[0]!.messages.find(message => message.role === 'system')!.content;
    for (const indexed of ids) expect(system.split(`<name>${indexed}</name>`)).toHaveLength(2);
    expect(view.data.evidence?.requests[0]?.contentChecks.filter(check => check.scope === 'skill-readiness'))
      .toHaveLength(ids.length);
    expect(view.data.evidence?.requests[0]?.contentChecks.filter(check => check.scope === 'skill-readiness')
      .every(check => check.sdkInclusion === 'confirmed' && check.wireInclusion === 'confirmed' && check.expectedText !== null)).toBe(true);
    for (const id of requested) for (const path of ['SKILL.md', 'references/guide.md']) {
        const text = readFileSync(join(import.meta.dir, '../../../resources/skills', id, path), 'utf8');
        expect(system).not.toContain(text);
        expect(payloads[1]!.messages.filter(message => message.role === 'tool').some(message => message.content.includes(JSON.stringify(text).slice(1, -1)))).toBe(true);
        expect(view.data.evidence?.reads).toContainEqual(expect.objectContaining({ ref: expect.objectContaining({ id }), path, operation: 'read_skill_resource', fullBody: true }));
      }
    expect(view.data.evidence?.reads.filter(read => read.operation === 'list_skill_resources')).toHaveLength(requested.length * 2);
    expect(view.data.evidence?.reads.every(read => read.nativeEntryId !== null)).toBe(true);
    const run = await app.queryRun(accepted.data.runId); if (!run.ok || run.data.kind !== 'agent' || !('allowedTools' in run.data.scope)) throw new Error('Missing owned invoice Run');
    expect(run.data.scope.allowedTools).toContain('read_skill_resource');
    expect(view.data.frozen?.discoveredSkills.map(ref => ref.id).sort()).toEqual([...ids].sort());
  }, 45000);

  it('loads the shipped seventeen flat Skills with real SDK metadata and excludes write-dependent SOPs from READ and Fill scopes', async () => {
    const root = mkdtempSync(join(tmpdir(), 'flowmate-shipped-skills-'));
    const paths = resolveProductPaths(root); if (!paths.ok) throw new Error(paths.error.code);
    let definitions: readonly ToolDefinition<any, any>[] = [];
    const created = await createApplication({ paths: paths.data, toolDefinitions: tools => { definitions = tools; return tools; } });
    if (!created.ok) throw new Error(created.error.code); deferCleanup(() => created.data.close());
    const catalog = await created.data.listResources(); if (!catalog.ok) throw new Error(catalog.error.code);
    const skills = catalog.data.items.filter(item => item.ref.kind === 'skill');
    expect(skills.map(item => item.ref.id)).toEqual(['deep-research', 'invoice', 'invoice-amount-reconciliation', 'invoice-candidate-comparison',
      'invoice-candidate-issue-triage', 'invoice-candidate-save', 'invoice-conflict-review', 'invoice-date-currency-review',
      'invoice-evidence-discovery', 'invoice-form-readiness-review', 'invoice-header-extraction', 'invoice-line-calculation-review',
      'invoice-line-item-extraction', 'invoice-missing-info-review', 'invoice-party-role-review', 'invoice-review-handoff', 'invoice-source-audit']);
    for (const skill of skills) expect(skill).toMatchObject({ available: true, enabled: false, diagnostics: [],
      bodyFile: 'SKILL.md', disableModelInvocation: skill.ref.id === 'invoice-candidate-save' });
    await created.data.close();
    const storage = openTestDatabase(paths.data); if (!storage.ok) throw new Error(storage.error.code);
    deferCleanup(() => storage.data.close());
    const service = core.createResourceService({ contents: storage.data.contents, resourceRoot: join(import.meta.dir, '../../../resources'),
      bundleRoot: join(root, 'library-bundles'), registeredToolNames: definitions.map(tool => tool.name), inspectNativeResources: pi.inspectNativeResources });
    const selection = { prompt: null, enabledSkills: skills.map(item => item.ref) };
    const frozen = service.freeze({ selection, settingsRevision: 1, activeToolNames: definitions.map(tool => tool.name), requiredSkill: null });
    expect(frozen.ok && frozen.data?.discoveredSkills).toEqual(selection.enabledSkills);
    if (!frozen.ok || !frozen.data) throw new Error('shipped library unavailable');
    const all = pi.createRunResourceLoader({ contents: storage.data.contents, fixedSystemPrompt: 'Invoice review', frozen: frozen.data,
      bundleDirectory: frozen.data.bundleDirectory, activeToolNames: definitions.map(tool => tool.name) });
    if (!all.ok) throw new Error(all.error.code);
    for (const [id, count] of [['invoice-party-role-review', 5], ['invoice-date-currency-review', 5],
      ['invoice-line-calculation-review', 7], ['invoice-candidate-issue-triage', 5], ['invoice-review-handoff', 5]] as const) {
      const skill = skills.find(item => item.ref.id === id)!;
      expect(skill.dependencyChecks).toHaveLength(count);
      expect(skill.dependencyChecks.every(check => check.available)).toBe(true);
      expect(all.data.getSkills().skills.find(item => item.name === id)?.description).toBe(skill.description);
      expect(skill.description).not.toMatch(/[\u3400-\u9fff]/);
      for (const path of ['SKILL.md', 'references/guide.md']) {
        const read = service.readFrozenFile(frozen.data, { ref: skill.ref, path });
        if (!read.ok) throw new Error(read.error.code);
        expect(read.data.text).toBe(readFileSync(join(import.meta.dir, '../../../resources/skills', id, path), 'utf8'));
      }
    }
    const visible = core.visibleFrozenSkills(frozen.data, definitions.filter(tool => tool.effect === 'READ').map(tool => tool.name));
    expect(visible.map(ref => ref.id)).toContain('invoice-source-audit');
    expect(visible.map(ref => ref.id)).not.toContain('invoice-candidate-save');
    expect(core.visibleFrozenSkills(frozen.data, ['fill_invoice_form'])).toEqual([]);
    const loaderInput = { contents: storage.data.contents, fixedSystemPrompt: 'Read-only Skill context', frozen: frozen.data, bundleDirectory: frozen.data.bundleDirectory,
      activeToolNames: ['list_skill_resources', 'read_skill_resource'], visibleSkillRefs: visible };
    const loader = pi.createRunResourceLoader(loaderInput);
    expect(loader.ok && loader.data.getSkills().skills.map(skill => skill.name)).toEqual(visible.map(ref => ref.id));
    if (!loader.ok) throw new Error(loader.error.code);
    const hidden = frozen.data.discoveredSkills.find(ref => ref.id === 'invoice-candidate-save')!;
    expect(loader.data.bodyFor(hidden)).toBeNull();
    writeFileSync(join(frozen.data.bundleDirectory, 'skills', hidden.id, hidden.version, 'SKILL.md'), 'Changed hidden frozen file');
    expect(pi.createRunResourceLoader(loaderInput)).toMatchObject({ ok: false, error: { code: 'resource_bundle_unavailable' } });
  });

  it('dedicated tools resolve the owned active Run and read its frozen Skill instead of the current author package', async () => {
    const f = fixture(), skill = f.pack('skill');
    const binary = Buffer.from([0xff, 0xfe, 0x00]);
    const controls = Buffer.from([0x00, 0x01, 0x02, 0x03, 0x00, 0x00]);
    const whitespace = Buffer.from('中文\ttext\r\n');
    skill.manifest = ResourceManifestSchema.parse({ ...skill.manifest, files: [...skill.manifest.files,
      { path: 'references/binary.bin', bytes: binary.length },
      { path: 'references/controls.bin', bytes: controls.length },
      { path: 'references/text.txt', bytes: whitespace.length }] });
    writeFileSync(join(skill.dir, 'references/binary.bin'), binary);
    writeFileSync(join(skill.dir, 'references/controls.bin'), controls);
    writeFileSync(join(skill.dir, 'references/text.txt'), whitespace);
    writeFileSync(join(skill.dir, 'resource.json'), JSON.stringify(skill.manifest));
    const paths = resolveProductPaths(join(f.root, 'owned-product')); if (!paths.ok) throw new Error(paths.error.code);
    let entered!: () => void, release!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; }), barrier = new Promise<void>(resolve => { release = resolve; });
    const server = await createHttpProvider(async () => { entered(); await barrier;
      return new Response('data: ' + JSON.stringify({ id: 'owned-skill', choices: [{ index: 0, delta: { role: 'assistant', content: 'Done' }, finish_reason: 'stop' }] })
        + '\n\ndata: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } }); });
    deferCleanup(async () => { release(); await server.stop(); });
    let definitions: readonly ToolDefinition<any, any>[] = [];
    const created = await createApplication({ paths: paths.data, resourceRoot: f.resourceRoot,
      resourceDefaults: () => ok({ revision: 1, selection: { prompt: null, enabledSkills: [skill.ref] } }),
      toolDefinitions: tools => { definitions = tools; return tools; },
      agentFactory: tools => new pi.PiAgentAdapter({ cwd: paths.data.runtimeDir, agentDir: paths.data.runtimeDir, tools,
        credentials: new InMemoryCredentialStore(), runtimeApiKey: 'owned-skill-key' }) });
    if (!created.ok) throw new Error(created.error.code); const app = created.data;
    deferCleanup(async () => { release(); await app.close(); });
    const list = definitions.find(tool => tool.name === 'list_skill_resources'), read = definitions.find(tool => tool.name === 'read_skill_resource');
    expect(list).toBeDefined(); expect(read).toBeDefined(); if (!list || !read) return;
    const session = await app.createSession({ title: 'Owned Skill' }); if (!session.ok) throw new Error(session.error.code);
    const workspace = await app.readWorkspace(); if (!workspace.ok) throw new Error(workspace.error.code);
    const selected = await app.updateWorkspace({ expectedRevision: workspace.data.revision, change: { kind: 'session', sessionId: session.data.sessionId } });
    if (!selected.ok) throw new Error(selected.error.code);
    let finish!: (event: AgentRunEvent & { type: 'run_finished' }) => void;
    const done = new Promise<AgentRunEvent & { type: 'run_finished' }>(resolve => { finish = resolve; });
    const accepted = await app.submitInput({ sessionId: session.data.sessionId, clientSequence: 1, mode: 'prompt', text: 'Inspect the SOP',
      workspace: { revision: selected.data.revision, sessionId: session.data.sessionId, documentRef: null, jobId: null, candidateRef: null },
      config: { version: 1, name: 'P11 tools', revision: 1, modelRef: { provider: 'p11', model: 'p11' },
        native: { authPath: join(f.root, 'empty.json'), modelsPath: null },
        connection: { baseUrl: `http://127.0.0.1:${server.port}/v1`, api: 'openai-completions', contextWindow: 64000, maxTokens: 16384 },
        parameters: { maxRetries: 0, maxRetryDelayMs: 100 } } }, { onEvent: event => { if (event.type === 'run_finished') finish(event); } });
    if (!accepted.ok) throw new Error(accepted.error.code);
    try {
      await Promise.race([started, done.then(event => { throw new Error(`Run stopped before the controlled request: ${JSON.stringify(event.result)}`); })]);
      const run = await app.queryRun(accepted.data.runId); if (!run.ok || run.data.kind !== 'agent') throw new Error('missing Agent owner');
      const context = { sessionId: run.data.sessionId, runId: run.data.runId, scope: run.data.scope as RunScope };
      const call = { nativeToolCallId: 'owned-skill-read', signal: new AbortController().signal };
      writeFileSync(join(skill.dir, 'SKILL.md'), 'New unverified author text');
      expect(await list.execute({ skill: 'invoice' }, call, context)).toEqual({ ref: skill.ref,
        bundleId: FrozenResourcesSchema.parse(run.data.config.resources).bundleId,
        files: [...skill.manifest.files].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0) });
      expect(await read.execute({ skill: 'invoice', path: 'SKILL.md' }, call, context)).toMatchObject({ ref: skill.ref, text: skill.bodyText,
        offset: 0, nextOffset: null, totalBytes: Buffer.byteLength(skill.bodyText) });
      await expect(read.execute({ skill: 'invoice', path: 'resource.json' }, call, context)).rejects.toMatchObject({ code: 'resource_file_unavailable' });
      await expect(read.execute({ skill: 'invoice', path: 'references/binary.bin' }, call, context)).rejects.toMatchObject({ code: 'resource_file_unavailable' });
      await expect(read.execute({ skill: 'invoice', path: 'references/controls.bin' }, call, context)).rejects.toMatchObject({ code: 'resource_file_unavailable' });
      expect(await read.execute({ skill: 'invoice', path: 'references/text.txt' }, call, context)).toMatchObject({ text: whitespace.toString() });
      await expect(list.execute({ skill: 'missing' }, call, context)).rejects.toMatchObject({ code: 'resource_required_unavailable' });
      await expect(list.execute({ skill: 'invoice' }, call, { ...context, sessionId: context.sessionId + 1 })).rejects.toMatchObject({ code: 'resource_required_unavailable' });
      await expect(read.execute({ skill: 'invoice', path: 'SKILL.md' }, call, { ...context, scope: { ...context.scope, allowedTools: [] } })).rejects.toMatchObject({ code: 'resource_required_unavailable' });
      await expect(read.execute({ skill: 'invoice', path: 'references/field-rules.md', offset: 1, limit: 4 }, call, context)).rejects.toMatchObject({ code: 'resource_file_unavailable' });
      const abort = new AbortController(); abort.abort();
      await expect(list.execute({ skill: 'invoice' }, { ...call, signal: abort.signal }, context)).rejects.toMatchObject({ code: 'tool_cancelled' });
    } finally { release(); await done; }
  });

  it('indexes a flat author Skill and preserves older frozen versions when the current package is replaced', () => {
    const f = fixture(), first = f.pack('skill'), hub = f.service();
    const frozen = hub.freeze({ selection: { prompt: null, enabledSkills: [first.ref] }, settingsRevision: 1,
      activeToolNames: tools, requiredSkill: first.ref });
    expect(frozen.ok && frozen.data?.discoveredSkills).toEqual([first.ref]);
    if (!frozen.ok || !frozen.data) throw new Error('missing original frozen version');
    const next = f.pack('skill', 'invoice', 'v2', '---\nname: invoice\ndescription: updated SOP\n---\nNew author body');
    expect(hub.catalog({ revision: 2, selection: EMPTY_RESOURCE_SELECTION })).toMatchObject({ ok: true,
      data: { items: [{ ref: next.ref }] } });
    expect(hub.readFrozenFile(frozen.data, { ref: first.ref, path: 'SKILL.md' })).toMatchObject({ ok: true,
      data: { ref: first.ref, text: first.bodyText } });
    expect(hub.freeze({ selection: { prompt: null, enabledSkills: [first.ref] }, settingsRevision: 2,
      activeToolNames: tools, requiredSkill: first.ref })).toMatchObject({ ok: false,
      error: { code: 'resource_required_unavailable' } });
    const nested = join(f.resourceRoot, 'skills', 'nested', 'v1');
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(nested, 'resource.json'), JSON.stringify({ ...first.manifest, id: 'nested' }));
    expect(hub.catalog({ revision: 2, selection: EMPTY_RESOURCE_SELECTION })).toMatchObject({ ok: true,
      data: { diagnostics: [expect.objectContaining({ resourceId: 'nested' })], items: [{ ref: next.ref }] } });
  });

  it('reports each declared dependency without letting partial readiness bypass admission', () => {
    const f = fixture(), skill = f.pack('skill', 'partial', 'v1', undefined,
      [{ kind: 'tool', name: 'read' }, { kind: 'tool', name: 'missing_tool' }, { kind: 'extension', id: 'missing', version: 'v1' }]);
    const hub = f.service(), selection = { prompt: null, enabledSkills: [skill.ref] };
    const catalog = hub.catalog({ revision: 1, selection });
    expect(catalog).toMatchObject({ ok: true, data: { items: [{ enabled: true, available: false, dependencyChecks: [
      { dependency: { kind: 'tool', name: 'read' }, available: true, reason: null },
      { dependency: { kind: 'tool', name: 'missing_tool' }, available: false, reason: expect.any(String) },
      { dependency: { kind: 'extension', id: 'missing' }, available: false, reason: expect.any(String) },
    ] }] } });
    expect(hub.validateSelection(selection).ok).toBe(false);
    expect(hub.freeze({ selection, settingsRevision: 1, activeToolNames: tools, requiredSkill: skill.ref }).ok).toBe(false);
    const empty = f.pack('skill', 'plain');
    expect(hub.catalog({ revision: 1, selection: EMPTY_RESOURCE_SELECTION })).toMatchObject({ ok: true,
      data: { items: expect.arrayContaining([expect.objectContaining({ ref: empty.ref, available: true, dependencyChecks: [] })]) } });
  });

  it('native-discovery-on-explicit-roots preserves native fields and exposes SDK warnings without discovering neighbours', () => {
    const f = fixture();
    const selected = f.pack('skill');
    f.pack('skill', 'neighbour');
    mkdirSync(join(f.root, '.pi', 'skills', 'global'), { recursive: true });
    writeFileSync(join(f.root, '.pi', 'skills', 'global', 'SKILL.md'), '---\nname: global\ndescription: global\n---\nsecret');
    expect(typeof f.inspect).toBe('function');
    expect(f.inspect({ versionDirectory: selected.dir, manifest: selected.manifest })).toMatchObject({ ok: true,
      data: { name: 'invoice', description: '发票字段整理', disableModelInvocation: false, diagnostics: [] } });
    const warning = f.pack('skill', 'BadName', 'v1', '---\nname: BadName\ndescription: still returned by SDK\n---\nbody');
    expect(loadSkillsFromDir({ dir: warning.dir, source: 'path' }).skills).toHaveLength(1);
    expect(f.inspect({ versionDirectory: warning.dir, manifest: warning.manifest })).toMatchObject({ ok: true,
      data: { name: 'BadName', diagnostics: [{ code: 'resource_manifest_invalid' }] } });
    const explicit = f.pack('skill', 'explicit', 'v1', '---\nname: explicit\ndescription: explicit only\ndisable-model-invocation: true\n---\nbody');
    expect(f.inspect({ versionDirectory: explicit.dir, manifest: explicit.manifest })).toMatchObject({ ok: true,
      data: { name: 'explicit', disableModelInvocation: true } });
  });

  it('discovers, validates dependencies and restricts management reading to enabled Skills with bounded UTF-8 pages', () => {
    const f = fixture(), prompt = f.pack('prompt'), skill = f.pack('skill', 'invoice', 'v1', undefined, [{ kind: 'tool', name: 'read' }]);
    const hub = f.service(), selection = { prompt: prompt.ref, enabledSkills: [skill.ref] };
    expect(hub.validateSelection(selection)).toEqual({ ok: true, data: undefined });
    expect(hub.catalog({ revision: 4, selection })).toMatchObject({ ok: true, data: { settingsRevision: 4,
      items: [{ ref: prompt.ref, available: true, enabled: true, files: prompt.manifest.files }, { ref: skill.ref, available: true, enabled: true, files: skill.manifest.files }] } });
    expect(hub.readFile({ ref: skill.ref, path: 'SKILL.md' }, EMPTY_RESOURCE_SELECTION)).toMatchObject({ ok: false,
      error: { code: 'resource_required_unavailable' } });
    expect(hub.readFile({ ref: prompt.ref, path: 'prompt.md' }, EMPTY_RESOURCE_SELECTION).ok).toBe(true);
    const request = { ref: skill.ref, path: 'references/field-rules.md', limit: 4 };
    let offset = 0, text = '';
    while (true) {
      const page = hub.readFile({ ...request, offset }, selection);
      expect(page.ok).toBe(true); if (!page.ok) throw new Error(page.error.code);
      expect(Buffer.byteLength(page.data.text)).toBeLessThanOrEqual(4); text += page.data.text;
      if (page.data.nextOffset === null) break;
      expect(page.data.nextOffset).toBeGreaterThan(offset); offset = page.data.nextOffset;
    }
    expect(text).toBe(skill.texts['references/field-rules.md']);
    expect(hub.readFile({ ...request, offset: 1 }, selection).ok).toBe(false);
    expect(hub.readFile({ ...request, path: '../secret' }, selection).ok).toBe(false);
    expect(hub.readFile({ ...request, offset: 999 }, selection).ok).toBe(false);
  });

  it('fixed-bundle-does-not-follow-author-edit and rechecks a selected or required version before later runs', () => {
    const f = fixture(), prompt = f.pack('prompt'), skill = f.pack('skill');
    const hub = f.service(), selection = { prompt: prompt.ref, enabledSkills: [skill.ref] };
    const frozen = hub.freeze({ selection, settingsRevision: 1, activeToolNames: tools, requiredSkill: skill.ref });
    expect(frozen.ok && frozen.data).toBeTruthy(); if (!frozen.ok || !frozen.data) throw new Error('missing fixed bundle');
    writeFileSync(join(skill.dir, 'SKILL.md'), 'changed without a version');
    expect(hub.verifyFrozen(frozen.data).ok).toBe(true);
    expect(hub.readFrozenFile(frozen.data, { ref: skill.ref, path: 'SKILL.md' })).toMatchObject({ ok: true,
      data: { text: skill.bodyText } });
    expect(hub.freeze({ selection, settingsRevision: 2, activeToolNames: tools, requiredSkill: skill.ref })).toMatchObject({ ok: false,
      error: { code: 'resource_version_changed' } });
    expect(hub.freeze({ selection, settingsRevision: 2, activeToolNames: tools, requiredSkill: null })).toMatchObject({ ok: true,
      data: { prompt: prompt.ref, discoveredSkills: [], excludedSkills: [{ ref: skill.ref, code: 'resource_version_changed' }] } });
    writeFileSync(join(f.bundleRoot, frozen.data.bundleId, 'skills', 'invoice', 'v1', 'SKILL.md'), 'corrupt frozen copy');
    expect(hub.verifyFrozen(frozen.data)).toMatchObject({ ok: false, error: { code: 'resource_bundle_unavailable' } });
  });

  it('keeps bad manifests and warnings visible, excludes optional failures and rejects missing dependencies', () => {
    const f = fixture();
    const warning = f.pack('skill', 'BadName');
    const missing = f.pack('skill', 'missing', 'v1', undefined, [{ kind: 'tool', name: 'never_registered' }]);
    const broken = f.pack('prompt', 'broken'); writeFileSync(join(broken.dir, 'resource.json'), '{broken');
    const hub = f.service();
    const catalog = hub.catalog({ revision: 0, selection: EMPTY_RESOURCE_SELECTION });
    expect(catalog.ok).toBe(true); if (!catalog.ok) throw new Error(catalog.error.code);
    expect(catalog.data.diagnostics).toContainEqual(expect.objectContaining({ resourceId: 'broken', code: 'resource_manifest_invalid' }));
    expect(catalog.data.items.find(item => item.ref.id === warning.ref.id)?.available).toBe(false);
    expect(catalog.data.items.find(item => item.ref.id === missing.ref.id)?.diagnostics).toContainEqual(expect.objectContaining({ code: 'resource_dependency_missing' }));
    const selection: ResourceSelection = { prompt: null, enabledSkills: [missing.ref] };
    expect(hub.validateSelection(selection).ok).toBe(false);
    expect(hub.freeze({ selection, settingsRevision: 0, activeToolNames: tools, requiredSkill: null })).toMatchObject({ ok: true,
      data: { discoveredSkills: [], excludedSkills: [{ ref: missing.ref, code: 'resource_dependency_missing' }] } });
    expect(hub.freeze({ selection, settingsRevision: 0, activeToolNames: tools, requiredSkill: missing.ref }).ok).toBe(false);
  });

  it('diagnoses an unavailable resource group without blocking a valid unrelated Skill', () => {
    const f = fixture(), skill = f.pack('skill'), hub = f.service();
    writeFileSync(join(f.resourceRoot, 'prompts'), 'not a resource directory');
    const selection = { prompt: null, enabledSkills: [skill.ref] };
    expect(hub.catalog({ revision: 0, selection })).toMatchObject({ ok: true,
      data: { diagnostics: [{ code: 'resource_file_unavailable' }], items: [expect.objectContaining({ ref: skill.ref, available: true })] } });
    expect(hub.validateSelection(selection)).toEqual({ ok: true, data: undefined });
    expect(hub.freeze({ selection, settingsRevision: 0, activeToolNames: tools, requiredSkill: skill.ref })).toMatchObject({ ok: true,
      data: { discoveredSkills: [skill.ref] } });
  });

  it('reuses an unchanged bundle without rewriting earlier metadata and rejects changed original bytes', () => {
    const f = fixture(), skill = f.pack('skill'), hub = f.service(), selection = { prompt: null, enabledSkills: [skill.ref] };
    const first = hub.freeze({ selection, settingsRevision: 1, activeToolNames: tools, requiredSkill: null });
    expect(first.ok && first.data).toBeTruthy(); if (!first.ok || !first.data) throw new Error('missing first bundle');
    const path = join(f.bundleRoot, first.data.bundleId, 'bundle.json'), bytes = readFileSync(path, 'utf8');
    expect(bytes).not.toContain('settingsRevision'); expect(bytes).not.toContain('selectedSkills');
    const second = hub.freeze({ selection, settingsRevision: 2, activeToolNames: tools, requiredSkill: null });
    expect(second.ok && second.data).toBeTruthy(); if (!second.ok || !second.data) throw new Error('missing second bundle');
    expect(second.data.bundleId).toBe(first.data.bundleId);
    expect(second.data.settingsRevision).toBe(2);
    expect(readFileSync(path, 'utf8')).toBe(bytes);
    writeFileSync(path, '{}');
    expect(hub.verifyFrozen(first.data)).toMatchObject({ ok: false, error: { code: 'resource_bundle_unavailable' } });
    expect(hub.verifyFrozen(second.data).ok).toBe(false);
    expect(hub.freeze({ selection, settingsRevision: 3, activeToolNames: tools, requiredSkill: null })).toMatchObject({ ok: false, error: { code: 'resource_bundle_unavailable' } });
    expect(readFileSync(path, 'utf8')).toBe('{}');
  });

  it('retains immutable manifest metadata in the original Run resource facts and can clear selections without author availability', () => {
    const f = fixture(), skill = f.pack('skill'), hub = f.service(), selection = { prompt: null, enabledSkills: [skill.ref] };
    const frozen = hub.freeze({ selection, settingsRevision: 1, activeToolNames: tools, requiredSkill: null });
    expect(frozen.ok && frozen.data).toBeTruthy(); if (!frozen.ok || !frozen.data) throw new Error('missing frozen resources');
    expect(Reflect.get(frozen.data, 'manifests')).toEqual([{ ref: skill.ref, manifest: skill.manifest }]);
    expect(hub.validateSelection({ prompt: { ...skill.ref, kind: 'prompt', version: 'missing' }, enabledSkills: [skill.ref] }).ok).toBe(false);
    renameSync(f.resourceRoot, join(f.root, 'author-unavailable'));
    expect(hub.validateSelection(EMPTY_RESOURCE_SELECTION)).toEqual(ok(undefined));
  });

  it('keeps no-selection legacy execution empty and checks current Run tools without auto enabling dependencies', () => {
    const f = fixture(), skill = f.pack('skill', 'invoice', 'v1', undefined, [{ kind: 'tool', name: 'read' }]), hub = f.service();
    expect(hub.freeze({ selection: EMPTY_RESOURCE_SELECTION, settingsRevision: 0, activeToolNames: [], requiredSkill: null })).toEqual({ ok: true, data: null });
    const selection = { prompt: null, enabledSkills: [skill.ref] };
    expect(hub.freeze({ selection, settingsRevision: 0, activeToolNames: [], requiredSkill: null })).toMatchObject({ ok: true,
      data: { discoveredSkills: [], excludedSkills: [{ ref: skill.ref, code: 'resource_dependency_missing' }] } });
    expect(hub.freeze({ selection, settingsRevision: 0, activeToolNames: [], requiredSkill: skill.ref }).ok).toBe(false);
    expect(hub.freeze({ selection: EMPTY_RESOURCE_SELECTION, settingsRevision: 0, activeToolNames: tools, requiredSkill: skill.ref }).ok).toBe(false);
  });

  it('rejects changed copied manifests in Core and the real Pi loader, and intersects tool scope with registered tools', () => {
    const f = fixture(), skill = f.pack('skill'), hub = f.service(), selection = { prompt: null, enabledSkills: [skill.ref] };
    const frozen = hub.freeze({ selection, settingsRevision: 0, activeToolNames: tools, requiredSkill: skill.ref });
    if (!frozen.ok || !frozen.data) throw new Error('missing fixed bundle');
    const bundleDirectory = join(f.bundleRoot, frozen.data.bundleId);
    writeFileSync(join(bundleDirectory, 'skills/invoice/v1/resource.json'), '{}');
    expect(hub.verifyFrozen(frozen.data)).toMatchObject({ ok: false, error: { code: 'resource_bundle_unavailable' } });
    expect(pi.createRunResourceLoader({ contents: f.contents, fixedSystemPrompt: 'fixed', frozen: frozen.data, bundleDirectory })).toMatchObject({ ok: false,
      error: { code: 'resource_bundle_unavailable' } });
    const unregistered = f.pack('skill', 'unregistered', 'v1', undefined, [{ kind: 'tool', name: 'never_registered' }]);
    expect(hub.freeze({ selection: { prompt: null, enabledSkills: [unregistered.ref] }, settingsRevision: 0,
      activeToolNames: [...tools, 'never_registered'], requiredSkill: unregistered.ref })).toMatchObject({ ok: false, error: { code: 'resource_dependency_missing' } });
  });

  it('old-key-after-resource-change retains the original Run/Input/Context', async () => {
    const f = fixture(), prompt = f.pack('prompt');
    let selection: ResourceSelection = { prompt: prompt.ref, enabledSkills: [] }, revision = 3, requests = 0;
    const paths = resolveProductPaths(join(f.root, 'product')); if (!paths.ok) throw new Error(paths.error.code);
    const provider = await createHttpProvider(() => {
      requests++;
      const chunk = (delta: unknown, finish: string | null) => 'data: ' + JSON.stringify({ id: 'p11-fixed',
        choices: [{ index: 0, delta, finish_reason: finish }] }) + '\n\n';
      return new Response(chunk({ role: 'assistant', content: '缺失值已保留。' }, null) + chunk({}, 'stop') + 'data: [DONE]\n\n',
        { headers: { 'content-type': 'text/event-stream' } });
    });
    deferCleanup(() => provider.stop());
    const created = await createApplication({ paths: paths.data, resourceRoot: f.resourceRoot,
      resourceDefaults: () => ok({ revision, selection }),
      agentFactory: definitions => new pi.PiAgentAdapter({ cwd: paths.data.runtimeDir, agentDir: paths.data.runtimeDir, tools: definitions,
        credentials: new InMemoryCredentialStore(), runtimeApiKey: 'controlled-p11-key' }) });
    if (!created.ok) throw new Error(created.error.code);
    const app = created.data; deferCleanup(() => app.close());
    const session = await app.createSession({ title: 'Fixed resource admission' }); if (!session.ok) throw new Error(session.error.code);
    const request = { sessionId: session.data.sessionId, clientSequence: 1, mode: 'prompt' as const, text: '整理当前提供的字段。',
      config: { version: 1 as const, name: 'P11 loopback', revision: 1, modelRef: { provider: 'p11-fixture', model: 'p11' },
        native: { authPath: join(f.root, 'unused-auth.json'), modelsPath: null },
        connection: { baseUrl: `http://127.0.0.1:${provider.port}/v1`, api: 'openai-completions', contextWindow: 64000, maxTokens: 16384 },
        parameters: { maxRetries: 0, maxRetryDelayMs: 100 } } };
    let finished!: () => void; const done = new Promise<void>(resolve => { finished = resolve; });
    const accepted = await app.submitInput(request, { onEvent: event => { if (event.type === 'run_finished') finished(); } });
    expect(accepted.ok).toBe(true); if (!accepted.ok) throw new Error(accepted.error.code);
    try {
      const run = await app.queryRun(accepted.data.runId); expect(run.ok).toBe(true); if (!run.ok) throw new Error(run.error.code);
      const fixed = FrozenResourcesSchema.safeParse(run.data.config.resources);
      expect(fixed.success).toBe(true); if (!fixed.success) throw new Error('new Run has no fixed resource contract');
      expect(fixed.data.settingsRevision).toBe(3); expect(fixed.data.prompt).toEqual(prompt.ref);
      const input = await app.querySessionInput({ sessionId: session.data.sessionId, inputId: accepted.data.inputId });
      expect(input).toMatchObject({ ok: true, data: { input: { content: { version: 2, text: request.text, promptText: request.text,
        resourceBinding: { bundleId: fixed.data.bundleId, requiredSkill: null } } } } });
      const snapshots = await app.listContextSnapshots({ sessionId: session.data.sessionId, runId: accepted.data.runId });
      if (!snapshots.ok || !snapshots.data.items[0]) throw new Error('new Input has no Context');
      expect(await app.queryContextSnapshot({ sessionId: session.data.sessionId, runId: accepted.data.runId, snapshotId: snapshots.data.items[0].id }))
        .toMatchObject({ ok: true, data: { snapshot: { json: { resourcePolicy: 'p11-resources-v1',
          resourceBinding: { bundleId: fixed.data.bundleId, requiredSkill: null } } } } });
      const next = f.pack('prompt', 'invoice', 'v2'); selection = { prompt: next.ref, enabledSkills: [] }; revision = 4;
      expect(await app.submitInput(request)).toEqual(accepted);
      expect(await app.submitInput({ ...request, text: 'changed original intent' })).toMatchObject({ ok: false, error: { code: 'state_conflict' } });
      const query = Reflect.get(app, 'queryRunResources'), read = Reflect.get(app, 'readRunResourceFile');
      expect(typeof query).toBe('function'); expect(typeof read).toBe('function');
      if (typeof query !== 'function' || typeof read !== 'function') throw new Error('Frozen resource queries are not connected');
      const owner = { sessionId: accepted.data.sessionId, runId: accepted.data.runId };
      expect(await query(owner)).toMatchObject({ ok: true, data: { ...owner, frozen: fixed.data,
        evidence: { version: 1, expansions: [], reads: [], requests: [] }, gap: null } });
      writeFileSync(join(prompt.dir, 'prompt.md'), 'author text replaced after admission');
      expect(await read({ ...owner, ref: prompt.ref, path: 'prompt.md' })).toMatchObject({ ok: true,
        data: { text: prompt.bodyText } });
      expect((await query({ ...owner, sessionId: owner.sessionId + 1 })).ok).toBe(false);
      writeFileSync(join(paths.data.runtimeDir, 'resource-bundles', fixed.data.bundleId, 'bundle.json'), '{}');
      expect(await query(owner)).toMatchObject({ ok: true, data: { gap: 'bundle-unavailable', frozen: fixed.data } });
      expect(await read({ ...owner, ref: prompt.ref, path: 'prompt.md' })).toMatchObject({ ok: false,
        error: { code: 'resource_bundle_unavailable' } });
    } finally { await done; }
    expect(requests).toBeLessThanOrEqual(1); // This admission check does not claim model adherence or successful resource assembly.
  });
});
