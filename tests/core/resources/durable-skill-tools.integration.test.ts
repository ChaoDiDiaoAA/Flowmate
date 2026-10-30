import { expect, test } from 'bun:test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DurableRunConfigSnapshotSchema, DurableWorkBudgetSchema, PersonalAgentConfigurationSchema, ReadSkillResourceOutputSchema,
  SKILL_RESOURCE_TOOL_NAMES, type ProductToolContext, type ResourceRef, type Result, type UsageRecord } from '@flowmate/contracts';
import { listSkillResources, readSkillResource } from '@flowmate/employee-invoice';
import { createResourceService } from '../../../packages/core/src/skill-hub/index.ts';
import { prepareInvoiceWorkInstructions } from '../../../packages/core/src/personal-agent/instructions.ts';
import { resolveInvoiceWorkToolScope } from '../../../packages/core/src/personal-agent/tool-scope.ts';
import { createToolExecutor } from '../../../packages/core/src/tools/executor.ts';
import { buildInvoiceWorkContext } from '../../../packages/runtime-durable/src/context.ts';
import { inspectNativeResources } from '../../../packages/runtime-pi/src/resources/loader.ts';
import { openTestDatabase } from '../../support/database.ts';
import { mkdtempSync } from '../../support/resources.ts';

const at = '2026-10-29T00:00:00.000Z';
function need<T>(result: Result<T>): T { if (!result.ok) throw Error(`${result.error.code}: ${result.error.message}`); return result.data; }

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'flowmate-durable-skill-tools-'));
  const paths = { root, databaseFile: join(root, 'data/app.sqlite'), artifactsDir: join(root, 'artifacts'),
    runtimeDir: join(root, 'runtime'), logsDir: join(root, 'logs'), outputsDir: join(root, 'outputs') };
  const database = need(openTestDatabase(paths)), resourceRoot = join(root, 'author'), bundleRoot = join(root, 'bundles');
  const guide = '原字段😀'.repeat(1800);
  function pack(id: string, version: string): ResourceRef {
    const directory = join(resourceRoot, 'skills', id);
    mkdirSync(join(directory, 'references'), { recursive: true });
    const files = { 'SKILL.md': `---\nname: ${id}\ndescription: Read original invoice fields\n---\nOriginal ${version} Skill.`,
      'references/guide.md': guide };
    for (const [path, text] of Object.entries(files)) writeFileSync(join(directory, path), text);
    writeFileSync(join(directory, 'resource.json'), JSON.stringify({ schemaVersion: 2, kind: 'skill', id, version,
      bodyFile: 'SKILL.md', keywords: [], requires: SKILL_RESOURCE_TOOL_NAMES.map(name => ({ kind: 'tool', name })),
      files: Object.entries(files).map(([path, text]) => ({ path, bytes: Buffer.byteLength(text) })) }));
    return { kind: 'skill', id, version };
  }
  const selected = pack('invoice-check', 'v3'); pack('unselected-private', 'v1');
  const configuration = PersonalAgentConfigurationSchema.parse({ modelId: null, thinkingLevel: 'off', tools: SKILL_RESOURCE_TOOL_NAMES,
    resources: { prompt: null, enabledSkills: [selected] }, extensions: { enabledExtensions: [] }, workingDirectory: null, preferences: '' });
  const resources = createResourceService({ resourceRoot, bundleRoot, registeredToolNames: configuration.tools, inspectNativeResources });
  const seeded = await database.transaction(scope => {
    const agent = need(scope.personalAgents.ensureDefault(configuration, at)), metadata = {
      version: 1 as const, sourceKey: 'durable-skill-tools', sourceRecordId: 'invoice-1', sourceVersion: 'v1' };
    need(scope.documents.register({ documentId: 1, sourceKey: metadata.sourceKey, sourceRecordId: metadata.sourceRecordId, version: 'v1',
      originalArtifact: { artifactId: 1, kind: 'original', relativePath: 'artifacts/1/original.pdf', bytes: 1, mimeType: 'application/pdf',
        metadata: { ...metadata, files: [{ relativePath: 'original.pdf', bytes: 1, mimeType: 'application/pdf' }] }, createdAt: at },
      parsedArtifact: { artifactId: 2, kind: 'parsed', relativePath: 'artifacts/2/parsed.json', bytes: 1, mimeType: 'application/json',
        metadata: { ...metadata, files: [{ relativePath: 'parsed.json', bytes: 1, mimeType: 'application/json' }] }, createdAt: at },
      status: 'available', metadata: { version: 2, pageCount: 1, warnings: [], allowedUsesClaim: ['Controlled resource tool fixture'],
        licenseVerification: 'not_verified', unavailableReason: null }, createdAt: at, updatedAt: at }));
    const work = need(scope.invoiceWorks.create({ personalAgentId: agent.personalAgentId, expectedAgentRevision: agent.revision,
      requestId: 'original-work', goal: 'Review the selected invoice.', documents: [{ id: 1, version: 'v1' }] }, { at, admission: { kind: 'ready' } }));
    const attemptId = work.execution.attempt!.attemptId, view = need(scope.invoiceWorks.get({ view: 'work', workId: work.workId }));
    if (view.view !== 'work' || !view.items[0]) throw Error('Missing original invoice.');
    const item = view.items[0];
    need(scope.invoiceWorks.prepareItemJob({ workId: work.workId, itemId: item.itemId, expectedRevision: item.revision, at }));
    const budget = DurableWorkBudgetSchema.parse(JSON.parse(scope.db.query<{ budget_json: string }, [number]>(
      'SELECT budget_json FROM invoice_works WHERE id=?').get(work.workId)!.budget_json));
    const dependencies = JSON.parse(readFileSync(new URL('../../../packages/runtime-durable/package.json', import.meta.url), 'utf8')).dependencies;
    const config = DurableRunConfigSnapshotSchema.parse({ version: 3, runtimeKind: 'durable', name: 'Owned resource tool Run', revision: 1,
      requestedModel: { provider: 'controlled', model: 'offline' }, resolvedModel: null, api: null, endpoint: null,
      sdk: { durable: dependencies['@earendil-works/pi-durable'], ai: dependencies['@earendil-works/pi-ai'], chord: dependencies['@earendil-works/chord'] },
      parameters: { maxRetries: 0, maxRetryDelayMs: 1000 }, ...budget,
      durable: { workId: work.workId, attemptId, configurationRevision: agent.revision },
      resources: configuration.resources, extensions: configuration.extensions, workingDirectory: null });
    const usage: UsageRecord = { version: 1, source: 'not-requested', reason: 'controlled-resource-tools', sdkValues: null,
      attempts: 0, attemptsComplete: true, costSource: null, updatedAt: at };
    const runId = need(scope.runs.createDurable({ workId: work.workId, attemptId, config,
      input: { version: 1, goal: view.work.goal, text: view.work.goal, messageTimestamp: Date.parse(at) }, usage,
      cleanup: { version: 1, stopped: false, stopReason: null, errors: [], lateObservationRequired: false }, createdAt: at }));
    need(scope.runs.start(runId, config, at));
    const current = need(scope.invoiceWorks.get({ view: 'item', workId: work.workId, itemId: item.itemId }));
    if (current.view !== 'item') throw Error('Missing current invoice.');
    const phase = need(scope.invoiceWorks.freezePhase({ workId: work.workId, attemptId, itemId: item.itemId, requestId: 'original-phase', kind: 'prompt',
      basis: { contextSnapshotId: null, inputIds: [], documentRefs: [item.documentRef], configurationRevision: agent.revision,
        itemRevision: current.item.revision }, at }));
    const frozen = need(resources.freeze({ selection: configuration.resources, settingsRevision: agent.revision,
      activeToolNames: configuration.tools, requiredSkill: selected }, scope.contents));
    if (!frozen) throw Error('Missing selected Skill bundle.');
    const instructions = need(prepareInvoiceWorkInstructions({ configuration, resources: frozen,
      readFrozenFile: (bundle, file) => resources.readFrozenFile(bundle, file, scope.contents) }));
    const context = need(buildInvoiceWorkContext(need(scope.invoiceWorks.readContextInput({ workId: work.workId, attemptId,
      requestId: phase.requestId, remainingBudget: { modelCalls: 2, toolCalls: 8, toolFeedbackBytes: 65536, timeoutMs: 30000, childSlots: 1 } }))));
    need(scope.invoiceWorkContexts.save({ context: { ...context, instructions }, at }));
    const product: ProductToolContext = { runId, sessionId: work.sessionId, scope: need(resolveInvoiceWorkToolScope(scope.db, {
      runId, sessionId: work.sessionId, workId: work.workId, attemptId, requestId: phase.requestId })).scope };
    return { agent, work, attemptId, runId, phase, product, frozen };
  });
  const definitions = [listSkillResources((input, context) => database.read(scope => resources.listSkillResources(input, context, scope))),
    readSkillResource((input, context) => database.read(scope => resources.readSkillResource(input, context, scope)))];
  const executor = createToolExecutor({ database, definitions, now: () => at });
  const execute = (name: string, args: unknown, nativeToolCallId: string) => executor.execute(name, args,
    { ...seeded.product, nativeToolCallId, signal: new AbortController().signal });
  return { database, paths, root, resources, selected, configuration, guide, pack, execute, ...seeded };
}

test('Durable Skill tools use the original selected phase bundle after author and Personal Agent defaults change', async () => {
  const f = await fixture(), newer = f.pack('invoice-check', 'v4');
  need(await f.database.transaction(scope => scope.personalAgents.update({ personalAgentId: f.agent.personalAgentId,
    expectedRevision: f.agent.revision, configuration: { ...f.configuration, resources: { prompt: null, enabledSkills: [newer] } }, at })));
  const listed = await f.execute('list_skill_resources', { skill: 'invoice-check' }, 'list-original-skill');
  expect(listed.result).toMatchObject({ status: 'succeeded', data: { ref: { id: 'invoice-check', version: 'v3' }, bundleId: f.frozen.bundleId,
    files: [{ path: 'SKILL.md' }, { path: 'references/guide.md', bytes: 23400 }] } });
  expect(await f.execute('read_skill_resource', { skill: 'invoice-check', path: 'SKILL.md' }, 'read-original-body'))
    .toMatchObject({ result: { status: 'succeeded', data: { ref: { version: 'v3' }, text: expect.stringContaining('Original v3 Skill.'), nextOffset: null } } });
  const first = await f.execute('read_skill_resource', { skill: 'invoice-check', path: 'references/guide.md' }, 'read-original-guide-1');
  expect(first.result.status).toBe('succeeded');
  if (first.result.status !== 'succeeded') throw Error(first.result.error.code);
  const page = ReadSkillResourceOutputSchema.parse(first.result.data);
  expect(page.nextOffset).toBeGreaterThan(0); expect(page.nextOffset).toBeLessThanOrEqual(16384); expect(page.totalBytes).toBe(23400);
  const second = await f.execute('read_skill_resource', { skill: 'invoice-check', path: 'references/guide.md', offset: page.nextOffset }, 'read-original-guide-2');
  expect(second.result).toMatchObject({ status: 'succeeded', data: { nextOffset: null, totalBytes: 23400 } });
  if (second.result.status !== 'succeeded') throw Error(second.result.error.code);
  expect(page.text + ReadSkillResourceOutputSchema.parse(second.result.data).text).toBe(f.guide);
  expect(await f.database.read(scope => scope.db.query('SELECT COUNT(*) count FROM tool_calls').get())).toEqual({ count: 4 });
  expect(need(await f.database.read(scope => scope.runs.get(f.runId)))).toMatchObject({ scope: { version: 4 }, jobId: null });
  await f.database.close();
  const reopened = need(openTestDatabase(f.paths));
  expect(await reopened.read(scope => f.resources.readSkillResource({ skill: 'invoice-check', path: 'SKILL.md' }, f.product, scope)))
    .toMatchObject({ ok: true, data: { ref: { version: 'v3' }, bundleId: f.frozen.bundleId } });
});

test.each(['wrong-session', 'wrong-phase', 'changed-scope', 'tool-removed', 'closed-phase'] as const)(
  'Durable resource reads reject an unowned or inactive original phase: %s', async reason => {
    const f = await fixture();
    let context = f.product;
    if (reason === 'wrong-session') context = { ...context, sessionId: context.sessionId + 999 };
    if (reason === 'wrong-phase') context = { ...context, scope: { ...context.scope,
      invoiceWork: { ...context.scope.invoiceWork!, phaseId: f.phase.phaseId + 999 } } };
    if (reason === 'changed-scope') context = { ...context, scope: { ...context.scope, allowedArtifactIds: [] } };
    if (reason === 'tool-removed') context = { ...context, scope: { ...context.scope, allowedTools: ['list_skill_resources'] } };
    if (reason === 'closed-phase') await f.database.transaction(scope => {
      scope.db.query('UPDATE invoice_work_phases SET closed_at=? WHERE id=?').run(at, f.phase.phaseId);
    });
    expect((await f.database.read(scope => f.resources.readSkillResource({ skill: 'invoice-check', path: 'SKILL.md' }, context, scope))).ok).toBe(false);
  });

test('Durable resource tools reject unselected Skills, undeclared files and invalid UTF-8 page boundaries', async () => {
  const f = await fixture();
  expect(await f.database.read(scope => f.resources.listSkillResources({ skill: 'unselected-private' }, f.product, scope)))
    .toMatchObject({ ok: false, error: { code: 'resource_required_unavailable' } });
  for (const request of [{ skill: 'invoice-check', path: 'unlisted.md' },
    { skill: 'invoice-check', path: '../unselected-private/SKILL.md' },
    { skill: 'invoice-check', path: 'references/guide.md', offset: 1 }]) {
    expect((await f.database.read(scope => f.resources.readSkillResource(request, f.product, scope))).ok).toBe(false);
  }
});

test.each(['bundle-id', 'original-bytes', 'published-file'] as const)(
  'Durable resource tools do not substitute missing or changed original bundle facts: %s', async reason => {
    const f = await fixture();
    if (reason === 'bundle-id') {
      const path = join(f.frozen.bundleDirectory, 'bundle.json'), bundle = JSON.parse(readFileSync(path, 'utf8'));
      bundle.bundleId = '25ce3187-8d4b-4d80-8819-ed21ca797bdb';
      writeFileSync(path, JSON.stringify(bundle));
    }
    if (reason === 'original-bytes') await f.database.transaction(scope => {
      scope.db.query("DELETE FROM managed_file_contents WHERE owner_kind='resource-bundle' AND owner_id=? AND relative_path='bundle.json'").run(f.frozen.bundleId);
    });
    if (reason === 'published-file') writeFileSync(join(f.frozen.bundleDirectory, 'skills/invoice-check/v3/references/guide.md'), 'unregistered replacement');
    expect((await f.database.read(scope => f.resources.listSkillResources({ skill: 'invoice-check' }, f.product, scope))).ok).toBe(false);
    expect((await f.database.read(scope => f.resources.readSkillResource({ skill: 'invoice-check', path: 'references/guide.md' }, f.product, scope))).ok).toBe(false);
  });
