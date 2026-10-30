import { expect, test } from 'bun:test';
import { Type, type Context } from '@earendil-works/pi-ai';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ok, PersonalAgentConfigurationSchema, type ProviderConfig, type ResourceRef, type Result } from '@flowmate/contracts';
import type { InvoiceWorkWorkingContext } from '../../packages/contracts/src/personal-context.ts';
import { createDurableModels } from '../../packages/runtime-durable/src/models.ts';
import { buildInvoiceWorkContext } from '../../packages/runtime-durable/src/context.ts';
import { prepareInvoiceWorkInstructions } from '../../packages/core/src/personal-agent/instructions.ts';
import { InvoiceWorkPhaseContextService } from '../../packages/core/src/personal-agent/phase-context.ts';
import { createResourceService } from '../../packages/core/src/skill-hub/index.ts';
import { inspectNativeResources } from '../../packages/runtime-pi/src/resources/loader.ts';
import type { SqlDatabaseStore } from '../../packages/core/src/storage/database.ts';
import { openTestDatabase } from '../support/database.ts';
import { mkdtempSync } from '../support/resources.ts';

const at = '2026-10-29T00:00:00.000Z';
const configuration: ProviderConfig = { version: 1, name: 'instructions-model', revision: 3,
  modelRef: { provider: 'instructions-controlled', model: 'selected-model' }, native: { authPath: 'unused-auth.json', modelsPath: null },
  connection: { api: 'openai-completions', baseUrl: 'http://127.0.0.1:1/v1', contextWindow: 96_000, maxTokens: 4_096 },
  parameters: { maxRetries: 0, maxRetryDelayMs: 1000 } };
function need<T>(result: Result<T>): T { if (!result.ok) throw Error(result.error.code); return result.data; }
function workingContext(): InvoiceWorkWorkingContext {
  return { version: 1, runtimeKind: 'durable', inputUse: 'phase-bound-only',
    work: { workId: 7, personalAgentId: 1, sessionId: 70, goal: 'Review the selected invoices.', status: 'open',
      counts: { total: 2, unresolved: 2, accepted: 0, rejected: 0, excluded: 0 } },
    phase: { phaseId: 61, attemptId: 21, requestId: 'phase-instructions', basis: { contextSnapshotId: null,
      inputIds: [], documentRefs: [{ id: 11, version: 'v1' }], configurationRevision: 3, itemRevision: 2 } },
    item: { workId: 7, itemId: 71, revision: 2, documentRef: { id: 11, version: 'v1' }, jobId: 91,
      candidateRef: null, disposition: 'unresolved', decision: null, disposedAt: null, todoCount: 0, latestInputId: null, updatedAt: at },
    userInputs: [], historicalInputReferences: [], confirmedBusinessReferences: [], todos: [], conflicts: [], modelReports: [],
    actions: { authorizesExecution: false, tools: ['read_invoice_document'], available: [],
      remainingBudget: { modelCalls: 2, toolCalls: 4, toolFeedbackBytes: 4096, timeoutMs: 30000, childSlots: 1 } },
    waitingReason: null, evidenceRefs: [] };
}
function instructions() {
  return { version: 1 as const, role: 'invoice-master' as const, provenance: 'phase-instructions' as const,
    preferences: 'ORIGINAL-PREFERENCE: Reply in Chinese.',
    resources: { bundleId: '25ce3187-8d4b-4d80-8819-ed21ca797bdb',
      prompt: { ref: { kind: 'prompt' as const, id: 'invoice', version: 'v2' }, path: 'prompt.md' as const, text: 'SELECTED-PROMPT-V2: Read original invoice evidence.' },
      skills: [{ ref: { kind: 'skill' as const, id: 'invoice-check', version: 'v3' }, path: 'SKILL.md' as const, text: 'SELECTED-SKILL-V3: Explain unresolved conflicts.' }] } };
}
type WireRequest = { messages: Array<{ role: string; content: string }>; tools?: Array<{ function: { name: string } }> };
function response() {
  return new Response(`data: ${JSON.stringify({ id: 'instructions-response', object: 'chat.completion.chunk', created: 1,
    model: 'selected-model', choices: [{ index: 0, delta: { role: 'assistant', content: 'Checked.' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`,
  { headers: { 'content-type': 'text/event-stream' } });
}
function nativeContext(): Context {
  return { messages: [{ role: 'system', content: 'PRIVATE-PARENT-SYSTEM', sections: { other: 'PRIVATE-OTHER-TICKET-SECTION' }, timestamp: 1,
    toolsAdded: [{ name: 'read_invoice_document', description: 'Read the selected invoice.', parameters: Type.Object({ documentId: Type.Integer() }) }] },
  { role: 'user', content: 'PRIVATE-OTHER-TICKET-HISTORY', timestamp: 2 }] };
}

test.each([false, true])('official driver receives frozen phase instructions as system and only the current ticket as data (simple=%s)', async simple => {
  const saved = Object.assign(workingContext(), { instructions: instructions() }), requests: WireRequest[] = [];
  const prepared = need(await createDurableModels(configuration, { readApiKey: () => 'synthetic-key',
    verifyModelUse: () => ok(undefined), reserveModelRequest: () => ok(undefined),
    readWorkingContext: () => ok({ workingContext: saved, messages: [] }), fetch: async (_input, init) => {
      if (typeof init?.body !== 'string') throw Error('Missing official driver body.');
      requests.push(JSON.parse(init.body)); return response();
    } }));
  const model = prepared.models.getModel(prepared.modelRef.provider, prepared.modelRef.modelId);
  if (!model) throw Error('Missing selected model.');
  const result = await (simple ? prepared.models.completeSimple(model, nativeContext()) : prepared.models.complete(model, nativeContext()));
  expect(result.stopReason).toBe('stop'); expect(requests).toHaveLength(1);
  const sent = requests[0]!, system = sent.messages.find(message => message.role === 'system')?.content;
  expect(system).toContain('Invoice Master'); expect(system).toContain('ORIGINAL-PREFERENCE');
  expect(system).toContain('SELECTED-PROMPT-V2'); expect(system).toContain('SELECTED-SKILL-V3');
  expect(system).toContain('authorizesExecution'); expect(system).toContain('human');
  const data = JSON.parse(sent.messages.find(message => message.role === 'user')!.content);
  expect(data.item.itemId).toBe(71); expect(data.instructions).toBeUndefined();
  expect(data.actions.authorizesExecution).toBe(false);
  expect(sent.tools?.map(tool => tool.function.name)).toEqual(['read_invoice_document']);
  expect(JSON.stringify(sent)).not.toContain('PRIVATE-');
});

test.each(['invalid-role', 'oversized-body', 'wrong-resource-kind'] as const)('invalid frozen instructions %s dispatch no HTTP request', async reason => {
  const original = instructions();
  const invalid = reason === 'invalid-role' ? { ...original, role: 'unrestricted' }
    : reason === 'oversized-body' ? { ...original, resources: { ...original.resources, prompt: { ...original.resources.prompt, text: '票'.repeat(22_000) } } }
    : { ...original, resources: { ...original.resources, prompt: { ...original.resources.prompt, ref: { kind: 'skill', id: 'invoice', version: 'v2' } } } };
  const saved = Object.assign(workingContext(), { instructions: invalid }); let requests = 0, charged = 0;
  const prepared = need(await createDurableModels(configuration, { readApiKey: () => 'synthetic-key',
    verifyModelUse: () => ok(undefined), reserveModelRequest: () => { charged++; return ok(undefined); },
    readWorkingContext: () => ok({ workingContext: saved, messages: [] }), fetch: async () => { requests++; return response(); } }));
  const model = prepared.models.getModel(prepared.modelRef.provider, prepared.modelRef.modelId);
  if (!model) throw Error('Missing selected model.');
  expect((await prepared.models.completeSimple(model, nativeContext())).stopReason).toBe('error');
  expect(requests).toBe(0); expect(charged).toBe(0);
});

async function resourceFixture(promptPrefix = '') {
  const root = mkdtempSync(join(tmpdir(), 'flowmate-phase-instructions-'));
  const database = need(openTestDatabase({ root, databaseFile: join(root, 'data/app.sqlite'), artifactsDir: join(root, 'artifacts'),
    runtimeDir: join(root, 'runtime'), logsDir: join(root, 'logs'), outputsDir: join(root, 'outputs') }));
  const resourceRoot = join(root, 'author');
  function pack(kind: 'prompt' | 'skill', id: string, version: string, text: string, requires: Array<{ kind: 'tool'; name: string }> = []): ResourceRef {
    const directory = join(resourceRoot, kind === 'prompt' ? 'prompts' : 'skills', id), bodyFile = kind === 'prompt' ? 'prompt.md' : 'SKILL.md';
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, bodyFile), text);
    writeFileSync(join(directory, 'resource.json'), JSON.stringify({ schemaVersion: 2, kind, id, version, bodyFile, keywords: [], requires,
      files: [{ path: bodyFile, bytes: new TextEncoder().encode(text).byteLength }] }));
    return { kind, id, version };
  }
  const promptText = `${promptPrefix}ORIGINAL-PROMPT-V2:${'发票😀'.repeat(3000)}:PROMPT-END`, skillText = '---\nname: invoice-check\ndescription: Check invoice evidence\n---\nORIGINAL-SKILL-V3';
  const prompt = pack('prompt', 'invoice', 'v2', promptText), skill = pack('skill', 'invoice-check', 'v3', skillText);
  pack('prompt', 'unselected-global', 'v99', 'PRIVATE-UNSELECTED-GLOBAL-PROMPT');
  const original = PersonalAgentConfigurationSchema.parse({ modelId: null, thinkingLevel: 'off',
    resources: { prompt, enabledSkills: [skill] }, extensions: { enabledExtensions: [] }, tools: ['read_invoice_document'],
    workingDirectory: null, preferences: 'ORIGINAL-PREFERENCE: Reply in Chinese.' });
  const resources = createResourceService({ resourceRoot, bundleRoot: join(root, 'bundles'),
    registeredToolNames: original.tools, inspectNativeResources });
  const seeded = await database.transaction(scope => {
    const agent = need(scope.personalAgents.ensureDefault(original, at)), metadata = { version: 1 as const,
      sourceKey: 'instruction-fixture', sourceRecordId: 'invoice-1', sourceVersion: 'v1' };
    need(scope.documents.register({ documentId: 1, sourceKey: metadata.sourceKey, sourceRecordId: metadata.sourceRecordId, version: 'v1',
      originalArtifact: { artifactId: 1, kind: 'original', relativePath: 'artifacts/1/original.pdf', bytes: 1, mimeType: 'application/pdf',
        metadata: { ...metadata, files: [{ relativePath: 'original.pdf', bytes: 1, mimeType: 'application/pdf' }] }, createdAt: at },
      parsedArtifact: { artifactId: 2, kind: 'parsed', relativePath: 'artifacts/2/parsed.json', bytes: 1, mimeType: 'application/json',
        metadata: { ...metadata, files: [{ relativePath: 'parsed.json', bytes: 1, mimeType: 'application/json' }] }, createdAt: at },
      status: 'available', metadata: { version: 2, pageCount: 1, warnings: [], allowedUsesClaim: ['Controlled phase instruction fixture'],
        licenseVerification: 'not_verified', unavailableReason: null }, createdAt: at, updatedAt: at }));
    const receipt = need(scope.invoiceWorks.create({ personalAgentId: agent.personalAgentId, expectedAgentRevision: agent.revision,
      requestId: 'instruction-work', goal: 'Review the selected invoice.', documents: [{ id: 1, version: 'v1' }] }, { at, admission: { kind: 'ready' } }));
    const view = need(scope.invoiceWorks.get({ view: 'work', workId: receipt.workId, limit: 100 }));
    if (view.view !== 'work' || !view.items[0] || !view.work.execution.attempt) throw Error('Missing phase owner.');
    return { agent, work: view.work, item: view.items[0] };
  });
  const request = { workId: seeded.work.workId, attemptId: seeded.work.execution.attempt!.attemptId, itemId: seeded.item.itemId,
    requestId: 'instruction-phase', kind: 'prompt' as const, basis: { contextSnapshotId: null, configurationRevision: seeded.agent.revision,
      itemRevision: seeded.item.revision, documentRefs: [seeded.item.documentRef], inputIds: [] },
    remainingBudget: { modelCalls: 2, toolCalls: 4, toolFeedbackBytes: 4096, timeoutMs: 30000, childSlots: 1 } };
  function prepare(scope: SqlDatabaseStore) {
    const row = scope.db.query<{ configuration_json: string }, [number]>('SELECT configuration_json FROM invoice_works WHERE id=?').get(request.workId)!;
    const configuration = PersonalAgentConfigurationSchema.parse(JSON.parse(row.configuration_json));
    const frozen = resources.freeze({ selection: configuration.resources, settingsRevision: seeded.agent.revision,
      activeToolNames: configuration.tools, requiredSkill: null }, scope.contents);
    if (!frozen.ok) return frozen;
    return prepareInvoiceWorkInstructions({ configuration, resources: frozen.data,
      readFrozenFile: (bundle, file) => resources.readFrozenFile(bundle, file, scope.contents) });
  }
  return { database, resources, root, pack, original, promptText, skillText, request, prepare, ...seeded };
}

test('real phase instructions retain original preferences and selected bundle bodies after defaults change and reach the official driver', async () => {
  const fixture = await resourceFixture(); let preparations = 0;
  const service = new InvoiceWorkPhaseContextService({ database: fixture.database, now: () => at, buildContext: buildInvoiceWorkContext,
    prepareInstructions: (_input, scope) => { preparations++; return fixture.prepare(scope); } });
  const saved = need(await service.freeze(fixture.request));
  expect(saved.context.instructions?.resources?.prompt?.text).toBe(fixture.promptText);
  expect(saved.context.instructions?.resources?.skills[0]?.text).toBe(fixture.skillText);
  const replacement = PersonalAgentConfigurationSchema.parse({ ...fixture.original, preferences: 'NEW-DEFAULT-PREFERENCE',
    resources: { prompt: null, enabledSkills: [] } });
  need(await fixture.database.transaction(scope => scope.personalAgents.update({ personalAgentId: fixture.agent.personalAgentId,
    expectedRevision: fixture.agent.revision, configuration: replacement, at })));
  expect(need(await service.freeze(fixture.request))).toEqual(saved); expect(preparations).toBe(1);
  const current = need(await service.get({ workId: fixture.request.workId, sessionId: fixture.work.sessionId,
    attemptId: fixture.request.attemptId, requestId: fixture.request.requestId }));
  const requests: WireRequest[] = [];
  const prepared = need(await createDurableModels(configuration, { readApiKey: () => 'synthetic-key',
    verifyModelUse: () => ok(undefined), reserveModelRequest: () => ok(undefined), readWorkingContext: () => ok({ workingContext: current, messages: [] }),
    fetch: async (_input, init) => { requests.push(JSON.parse(String(init?.body))); return response(); } }));
  const model = prepared.models.getModel(prepared.modelRef.provider, prepared.modelRef.modelId)!;
  expect((await prepared.models.completeSimple(model, nativeContext())).stopReason).toBe('stop');
  const payload = JSON.stringify(requests);
  expect(payload).toContain('ORIGINAL-PREFERENCE'); expect(payload).toContain('ORIGINAL-PROMPT-V2');
  expect(payload).toContain('PROMPT-END'); expect(payload).toContain('ORIGINAL-SKILL-V3');
  expect(payload).not.toContain('NEW-DEFAULT-PREFERENCE'); expect(payload).not.toContain('PRIVATE-');
});

test.each(['preferences', 'resource-version', 'resource-body', 'resource-bundle', 'missing-instructions'] as const)(
  'raw context cannot replace original configuration or resource facts: %s', async reason => {
    const fixture = await resourceFixture();
    const result = await fixture.database.transaction(scope => {
      const { remainingBudget, ...phase } = fixture.request;
      need(scope.invoiceWorks.freezePhase({ ...phase, at }));
      const context = need(buildInvoiceWorkContext(need(scope.invoiceWorks.readContextInput({ workId: phase.workId,
        attemptId: phase.attemptId, requestId: phase.requestId, remainingBudget }))));
      const original = need(fixture.prepare(scope)), resources = original.resources!, prompt = resources.prompt!;
      const instructions = reason === 'preferences' ? { ...original, preferences: 'Unrelated current defaults' }
        : reason === 'resource-version' ? { ...original, resources: { ...resources, prompt: { ...prompt, ref: { ...prompt.ref, version: 'v99' } } } }
          : reason === 'resource-body' ? { ...original, resources: { ...resources, prompt: { ...prompt, text: 'Invented original prompt' } } }
            : reason === 'resource-bundle' ? { ...original, resources: { ...resources, bundleId: '25ce3187-8d4b-4d80-8819-ed21ca797bdb' } } : original;
      return scope.invoiceWorkContexts.save({ context: reason === 'missing-instructions' ? context : { ...context, instructions }, at });
    });
    expect(result).toMatchObject({ ok: false, error: { code: 'source_invalid' } });
  });

test('selected resources with unavailable requirements remain unavailable and do not become instructions', async () => {
  const fixture = await resourceFixture(), ref = fixture.pack('skill', 'needs-network', 'v1',
    '---\nname: needs-network\ndescription: Requires a tool outside this phase\n---\nPRIVATE-NETWORK-SKILL', [{ kind: 'tool', name: 'unavailable-network-tool' }]);
  const config = PersonalAgentConfigurationSchema.parse({ ...fixture.original, resources: { prompt: null, enabledSkills: [ref] } });
  const result = await fixture.database.transaction(scope => {
    const frozen = need(fixture.resources.freeze({ selection: config.resources, settingsRevision: 0,
      activeToolNames: config.tools, requiredSkill: null }, scope.contents));
    return prepareInvoiceWorkInstructions({ configuration: config, resources: frozen,
      readFrozenFile: (bundle, file) => fixture.resources.readFrozenFile(bundle, file, scope.contents) });
  });
  expect(result).toMatchObject({ ok: false, error: { code: 'resource_required_unavailable' } });
});

test('instruction reads preserve the existing resource reader UTF-8 BOM behavior', async () => {
  const fixture = await resourceFixture('\ufeff');
  const service = new InvoiceWorkPhaseContextService({ database: fixture.database, now: () => at, buildContext: buildInvoiceWorkContext,
    prepareInstructions: (_input, scope) => fixture.prepare(scope) });
  const saved = need(await service.freeze(fixture.request));
  expect(saved.context.instructions?.resources?.prompt?.text).toBe(fixture.promptText);
});
