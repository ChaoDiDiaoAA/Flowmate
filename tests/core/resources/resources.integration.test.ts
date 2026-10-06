import { describe, expect, it } from 'bun:test';
import { mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadSkillsFromDir } from '@earendil-works/pi-coding-agent';
import { InMemoryCredentialStore } from '@earendil-works/pi-ai';
import { createApplication } from '../../../apps/composition.ts';
import { resolveProductPaths } from '../../../packages/shared/src/paths.ts';
import * as core from '../../../packages/core/src/index.ts';
import * as pi from '../../../packages/runtime-pi/src/index.ts';
import { canonicalResourceManifest, EMPTY_RESOURCE_SELECTION, ResourceManifestSchema, ResourceRefSchema, FrozenResourcesSchema, ok } from '../../../packages/contracts/src/index.ts';
import type { ResourceDependency, ResourceSelection } from '../../../packages/contracts/src/index.ts';
import { mkdtempSync, createHttpProvider, deferCleanup } from '../../support/resources.ts';

const digest = (text: string | Buffer) => createHash('sha256').update(text).digest('hex');
const tools = ['read', 'read_invoice_evidence', 'check_invoice_sources', 'normalize_invoice_values', 'validate_invoice_candidate'];
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'flowmate-resources-'));
  const resourceRoot = join(root, 'author'), bundleRoot = join(root, 'bundles');
  mkdirSync(resourceRoot);
  function pack(kind: 'prompt' | 'skill', id = 'invoice', version = 'v1', body?: string, requires: ResourceDependency[] = []) {
    const dir = join(resourceRoot, kind === 'prompt' ? 'prompts' : 'skills', id, version);
    mkdirSync(join(dir, 'references'), { recursive: true });
    const bodyFile = kind === 'prompt' ? 'prompt.md' : 'SKILL.md';
    const bodyText = body ?? (kind === 'prompt' ? '核对发票字段，不补造缺失值。' : `---\nname: ${id}\ndescription: 发票字段整理\ndisable-model-invocation: false\n---\n请读取 references/field-rules.md。`);
    const texts = { [bodyFile]: bodyText, 'references/field-rules.md': '发票😀字段：缺失不等于零。' };
    const manifest = ResourceManifestSchema.parse({ schemaVersion: 1, kind, id, version, bodyFile,
      keywords: ['发票'], requires, files: Object.entries(texts).map(([path, text]) => ({ path,
        bytes: Buffer.byteLength(text), sha256: digest(text) })) });
    for (const [path, text] of Object.entries(texts)) writeFileSync(join(dir, path), text);
    writeFileSync(join(dir, 'resource.json'), JSON.stringify(manifest));
    const ref = ResourceRefSchema.parse({ kind, id, version, contentHash: digest(canonicalResourceManifest(manifest)) });
    return { dir, ref, manifest, bodyText, texts };
  }
  const inspect = Reflect.get(pi, 'inspectNativeResources');
  const create = Reflect.get(core, 'createResourceService');
  const service = () => {
    expect(typeof inspect).toBe('function'); expect(typeof create).toBe('function');
    return create({ resourceRoot, bundleRoot, registeredToolNames: tools, inspectNativeResources: inspect });
  };
  return { root, resourceRoot, bundleRoot, pack, service, inspect };
}

describe('P11 real resource files and native discovery', () => {
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
    writeFileSync(join(f.bundleRoot, frozen.data.bundleHash, 'skills', 'invoice', 'v1', 'SKILL.md'), 'corrupt frozen copy');
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

  it('reuses one content bundle across revisions without rewriting admission metadata or corrupt published content', () => {
    const f = fixture(), skill = f.pack('skill'), hub = f.service(), selection = { prompt: null, enabledSkills: [skill.ref] };
    const first = hub.freeze({ selection, settingsRevision: 1, activeToolNames: tools, requiredSkill: null });
    expect(first.ok && first.data).toBeTruthy(); if (!first.ok || !first.data) throw new Error('missing first bundle');
    const path = join(f.bundleRoot, first.data.bundleHash, 'bundle.json'), bytes = readFileSync(path, 'utf8');
    expect(bytes).not.toContain('settingsRevision'); expect(bytes).not.toContain('selectedSkills');
    expect(hub.freeze({ selection, settingsRevision: 2, activeToolNames: tools, requiredSkill: null })).toMatchObject({ ok: true,
      data: { bundleHash: first.data.bundleHash, settingsRevision: 2 } });
    expect(readFileSync(path, 'utf8')).toBe(bytes);
    writeFileSync(path, '{}');
    expect(hub.freeze({ selection, settingsRevision: 3, activeToolNames: tools, requiredSkill: null })).toMatchObject({ ok: false,
      error: { code: 'resource_bundle_unavailable' } });
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
    const bundleDirectory = join(f.bundleRoot, frozen.data.bundleHash);
    writeFileSync(join(bundleDirectory, 'skills/invoice/v1/resource.json'), '{}');
    expect(hub.verifyFrozen(frozen.data)).toMatchObject({ ok: false, error: { code: 'resource_bundle_unavailable' } });
    expect(pi.createRunResourceLoader({ fixedSystemPrompt: 'fixed', frozen: frozen.data, bundleDirectory })).toMatchObject({ ok: false,
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
        resourceBinding: { bundleHash: fixed.data.bundleHash, requiredSkill: null } } } } });
      const snapshots = await app.listContextSnapshots({ sessionId: session.data.sessionId, runId: accepted.data.runId });
      if (!snapshots.ok || !snapshots.data.items[0]) throw new Error('new Input has no Context');
      expect(await app.queryContextSnapshot({ sessionId: session.data.sessionId, runId: accepted.data.runId, snapshotId: snapshots.data.items[0].id }))
        .toMatchObject({ ok: true, data: { snapshot: { json: { resourcePolicy: 'p11-resources-v1',
          resourceBinding: { bundleHash: fixed.data.bundleHash, requiredSkill: null } } } } });
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
      writeFileSync(join(paths.data.runtimeDir, 'resource-bundles', fixed.data.bundleHash, 'bundle.json'), '{}');
      expect(await query(owner)).toMatchObject({ ok: true, data: { gap: 'bundle-unavailable', frozen: fixed.data } });
      expect(await read({ ...owner, ref: prompt.ref, path: 'prompt.md' })).toMatchObject({ ok: false,
        error: { code: 'resource_bundle_unavailable' } });
    } finally { await done; }
    expect(requests).toBeLessThanOrEqual(1); // This admission check does not claim model adherence or successful resource assembly.
  });
});
