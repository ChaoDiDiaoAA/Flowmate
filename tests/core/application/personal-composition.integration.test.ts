import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from 'bun:sqlite';
import { createApplication } from '../../../apps/composition.ts';
import { createFileStore } from '@flowmate/core';
import { appError, fail, ok, PersonalAgentConfigurationSchema, type InvoiceWorkWorkingContext,
  type ProductPaths, type ProviderConfig, type Result } from '@flowmate/contracts';
import { openTestDatabase } from '../../support/database.ts';
import { deferCleanup, mkdtempSync, waitFor } from '../../support/resources.ts';
import { invoiceWorkCandidateDraft } from '../../support/invoice-work-tools.ts';

function need<T>(result: Result<T>): T { if (!result.ok) throw Error(`${result.error.code}: ${result.error.message}`); return result.data; }

test('the formal Application runs fixed invoice work through Durable and the original tools, then reopens without new intent', async () => {
  const root = mkdtempSync(join(tmpdir(), 'flowmate-personal-composition-'));
  const paths: ProductPaths = { root, databaseFile: join(root, 'data/app.sqlite'), artifactsDir: join(root, 'artifacts'),
    runtimeDir: join(root, 'runtime'), logsDir: join(root, 'logs'), outputsDir: join(root, 'outputs') };
  const database = need(openTestDatabase(paths)), files = createFileStore(paths, database);
  const documentRefs: Array<{ id: number; version: string }> = [], parsedIds = new Map<number, number>();
  for (let index = 1; index <= 2; index++) {
    const at = new Date().toISOString(), sourceRecordId = String(index);
    const published = need(await files.publish({ sourceKey: 'personal-composition', sourceRecordId, sourceVersion: 'v1', at,
      original: { kind: 'original', primaryName: 'original.pdf', files: [{ name: 'original.pdf', bytes: Buffer.from('Controlled original invoice'), mimeType: 'application/pdf' }] },
      parsed: { kind: 'parsed', primaryName: 'parsed.json', files: [{ name: 'parsed.json', mimeType: 'application/json',
        bytes: Buffer.from(JSON.stringify({ formatVersion: 2, pages: [{ page: 1, blocks: [{ id: 'b1', kind: 'text', text: 'Total 113.00',
          sourceIndex: 0, sourceType: 'synthetic', bbox: null }] }], completeness: { status: 'complete', checks: [], warnings: [] } })) }] } }));
    const document = need(await database.transaction(scope => scope.documents.register({ documentId: published.documentId,
      sourceKey: 'personal-composition', sourceRecordId, version: 'v1', originalArtifact: { ...published.original, kind: 'original' },
      parsedArtifact: { ...published.parsed, kind: 'parsed' }, status: 'available', createdAt: at, updatedAt: at,
      metadata: { version: 2, pageCount: 1, warnings: [], allowedUsesClaim: ['Controlled formal assembly'],
        licenseVerification: 'not_verified', unavailableReason: null } })));
    documentRefs.push(document.documentRef); parsedIds.set(document.documentRef.id, document.parsedArtifactId);
  }
  await database.close();

  const wire: Array<{ messages: Array<{ role: string; content: string }> }> = [];
  const contexts: InvoiceWorkWorkingContext[] = [];
  const server = Bun.serve({ port: 0, fetch: async request => {
    const body = await request.json() as typeof wire[number]; wire.push(body);
    const context = JSON.parse(body.messages.find(message => message.role === 'user')!.content) as InvoiceWorkWorkingContext;
    contexts.push(context);
    const documentId = context.item.documentRef.id, ordinal = body.messages.filter(message => message.role === 'tool').length;
    const candidate = invoiceWorkCandidateDraft();
    candidate.fields.totalAmount.sources = [{ documentId, version: 'v1', artifactId: parsedIds.get(documentId)!, page: 1, blockId: 'b1', quote: 'Total 113.00' }];
    const tool = ordinal === 0 ? { name: 'list_skill_resources', arguments: { skill: 'invoice-source-audit' } }
      : ordinal === 1 ? { name: 'read_skill_resource', arguments: { skill: 'invoice-source-audit', path: 'references/guide.md', offset: 0, limit: 4096 } }
      : ordinal === 2 ? { name: 'read_invoice_document', arguments: { documentId, page: 1, afterBlockId: null, limit: 10 } }
      : ordinal === 3 ? { name: 'save_invoice_candidate', arguments: { documentId, candidate } } : null;
    const delta = tool ? { role: 'assistant', tool_calls: [{ index: 0, id: `formal-wire-${wire.length}`, type: 'function',
      function: { name: tool.name, arguments: JSON.stringify(tool.arguments) } }] } : { role: 'assistant', content: 'Ready for human review.' };
    return new Response(`data: ${JSON.stringify({ id: `formal-model-${wire.length}`, object: 'chat.completion.chunk', created: 1,
      model: 'formal-local-model', choices: [{ index: 0, delta, finish_reason: tool ? 'tool_calls' : 'stop' }] })}\n\ndata: [DONE]\n\n`,
    { headers: { 'content-type': 'text/event-stream' } });
  } });
  deferCleanup(() => server.stop(true));
  const provider: ProviderConfig = { version: 1, name: 'formal-local', revision: 3,
    modelRef: { provider: 'controlled-formal', model: 'formal-local-model' }, credentialRef: 'controlled-local-key-ref',
    native: { authPath: join(root, 'unused-auth.json'), modelsPath: null },
    connection: { api: 'openai-completions', baseUrl: `http://127.0.0.1:${server.port}/v1`, contextWindow: 64000, maxTokens: 8192, reasoning: false },
    parameters: { maxRetries: 0, maxRetryDelayMs: 1000 } };
  const configuration = PersonalAgentConfigurationSchema.parse({ modelId: 'formal-local', thinkingLevel: 'off',
    resources: { prompt: { kind: 'prompt', id: 'invoice', version: 'v1' }, enabledSkills: [{ kind: 'skill', id: 'invoice-source-audit', version: 'v1' }] },
    extensions: { enabledExtensions: [] }, tools: ['list_skill_resources', 'read_skill_resource', 'read_invoice_evidence',
      'check_invoice_sources', 'read_invoice_document', 'save_invoice_candidate'],
    workingDirectory: null, preferences: '请逐票保留证据，候选必须交人工复核。' });
  const errors: string[] = []; let credentialReads = 0, legacyCalls = 0;
  const options: Parameters<typeof createApplication>[0] = { paths,
    logger: { write: event => { if (event.level === 'error') errors.push(event.code ?? event.event); }, close: async () => undefined },
    provider: { prepare: async () => { legacyCalls++; return fail(appError('unexpected_legacy_model', 'provider', 'The legacy model must not execute.')); },
      close: async () => ({ stopped: true, closed: true, errors: [] }) },
    personalAgent: { defaultConfiguration: configuration, resolveConfiguration: () => ok(provider),
      readApiKey: () => { credentialReads++; return 'controlled-formal-key'; } } };
  let application = need(await createApplication(options));
  deferCleanup(() => application.close());
  const workspace = need(await application.readWorkspace()), agent = need(await application.personalAgent.get());
  expect(wire).toHaveLength(0); expect(credentialReads).toBe(0);
  const input = { personalAgentId: agent.personalAgentId, expectedAgentRevision: agent.revision,
    requestId: 'formal-create', goal: '持续整理这两张发票，交由人工复核。', documents: documentRefs };
  const receipt = need(await application.invoiceWorks.create(input));
  expect(receipt.execution).toMatchObject({ kind: 'accepted', authorizationAccepted: true });
  if (!('attempt' in receipt.execution) || !receipt.execution.attempt) throw Error('Expected an accepted original attempt.');
  const attemptId = receipt.execution.attempt.attemptId;
  await waitFor(async () => need(await application.personalTasks.get({ workId: receipt.workId, attemptId })).task.stoppedAt !== null, 15_000);
  const page = need(await application.invoiceWorks.get({ view: 'work', workId: receipt.workId }));
  if (page.view !== 'work') throw Error('Expected fixed invoice members.');
  expect(page.items.map(item => item.documentRef)).toEqual(documentRefs);
  expect(page.items.every(item => item.candidateRef !== null && item.disposition === 'unresolved')).toBe(true);
  expect(page.work).toMatchObject({ status: 'open', execution: { runStatus: 'completed', requiresContinue: false } });
  expect(contexts.map(context => context.item.documentRef.id)).toEqual(documentRefs.flatMap(ref => Array(5).fill(ref.id)));
  const prompt = readFileSync(new URL('../../../resources/prompts/invoice/prompt.md', import.meta.url), 'utf8');
  const skill = readFileSync(new URL('../../../resources/skills/invoice-source-audit/SKILL.md', import.meta.url), 'utf8');
  const guide = readFileSync(new URL('../../../resources/skills/invoice-source-audit/references/guide.md', import.meta.url), 'utf8');
  for (const body of wire) {
    const system = body.messages.find(message => message.role === 'system')?.content ?? '';
    const instructions = JSON.parse(system.split('Frozen phase instructions:\n').at(-1)!);
    expect(instructions).toMatchObject({ preferences: configuration.preferences, resources: {
      prompt: { ref: configuration.resources.prompt, text: prompt }, skills: [{ ref: configuration.resources.enabledSkills[0], text: skill }],
    } });
    expect(body.messages.filter(message => message.role === 'user')).toHaveLength(1);
  }
  expect(wire.filter(body => body.messages.some(message => message.role === 'tool' && message.content.includes('references/guide.md')))).toHaveLength(8);
  expect(wire.at(-1)!.messages.some(message => message.role === 'tool' && message.content.includes(JSON.stringify(guide).slice(1, -1)))).toBe(true);
  expect(need(await application.readWorkspace())).toEqual(workspace); expect(legacyCalls).toBe(0);
  expect(need(await application.invoiceWorks.create(input))).toEqual(receipt);
  const before = { requests: wire.length, credentialReads };
  need(await application.invoiceWorks.queryOperation({ operation: 'create', personalAgentId: agent.personalAgentId, requestId: input.requestId }));
  need(await application.personalAgent.openConversation({ workId: receipt.workId }));
  need(await application.personalTasks.list({ workId: receipt.workId }));
  expect({ requests: wire.length, credentialReads }).toEqual(before);
  expect(await application.close()).toMatchObject({ ok: true, data: { closed: true, stopped: true } });
  application = need(await createApplication(options));
  const restored = need(await application.invoiceWorks.get({ view: 'work', workId: receipt.workId }));
  expect(restored).toEqual(page); expect({ requests: wire.length, credentialReads }).toEqual(before);
  expect(need(await application.createSession({ title: 'Ordinary chat' }))).toMatchObject({ runtimeKind: 'agent_session' });
  expect(await application.close()).toMatchObject({ ok: true, data: { closed: true, stopped: true } });
  expect(errors).toEqual([]);
  const audit = new Database(paths.databaseFile, { readonly: true });
  try {
    expect(audit.query('SELECT status, job_id FROM runs').all()).toEqual([{ status: 'completed', job_id: null }]);
    expect(audit.query('SELECT count(*) count FROM invoice_candidates').get()).toEqual({ count: 2 });
    expect(audit.query('SELECT count(*) count FROM invoice_work_model_bindings').get()).toEqual({ count: 1 });
    expect(audit.query('SELECT count(*) count FROM invoice_work_context_snapshots').get()).toEqual({ count: 2 });
    expect(audit.query('SELECT count(*) count FROM invoice_work_phases WHERE consumed_at IS NOT NULL AND closed_at IS NOT NULL').get()).toEqual({ count: 2 });
  } finally { audit.close(); }
}, 30_000);
