import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CandidateDraftSchema, DurableRunConfigSnapshotSchema, DurableWorkBudgetSchema, INVOICE_REVIEW_TOOL_NAMES,
  PersonalAgentConfigurationSchema, type PersonalAgentConfiguration, type ProductToolContext, type ProviderConfig, type Result, type UsageRecord } from '@flowmate/contracts';
import { createFileStore } from '../../packages/core/src/storage/file-store.ts';
import { createToolExecutor } from '../../packages/core/src/tools/executor.ts';
import { resolveInvoiceWorkToolScope } from '../../packages/core/src/personal-agent/tool-scope.ts';
import { createDocumentService } from '@flowmate/data';
import { createInvoiceTools } from '@flowmate/employee-invoice';
import { buildInvoiceWorkContext } from '../../packages/runtime-durable/src/context.ts';
import { openTestDatabase } from './database.ts';
import { mkdtempSync } from './resources.ts';

function need<T>(result: Result<T>): T { if (!result.ok) throw Error(`${result.error.code}: ${result.error.message}`); return result.data; }
const requireRuntime = createRequire(new URL('../../packages/runtime-durable/package.json', import.meta.url));
const installedVersion = (name: string): string => JSON.parse(readFileSync(requireRuntime.resolve(`${name}/package.json`), 'utf8')).version;
const sdk = { durable: installedVersion('@earendil-works/pi-durable'), ai: installedVersion('@earendil-works/pi-ai'),
  chord: installedVersion('@earendil-works/chord') };

export async function invoiceWorkToolsFixture(options: { at?: string; provider?: ProviderConfig; configuration?: PersonalAgentConfiguration;
  maxToolFeedbackBytes?: number } = {}) {
  const at = options.at ?? '2026-10-29T00:00:00.000Z';
  const root = mkdtempSync(join(tmpdir(), 'flowmate-invoice-work-tools-'));
  const paths = { root, databaseFile: join(root, 'data/app.sqlite'), artifactsDir: join(root, 'artifacts'),
    runtimeDir: join(root, 'runtime'), logsDir: join(root, 'logs'), outputsDir: join(root, 'outputs') };
  const database = need(openTestDatabase(paths));
  const configuration = PersonalAgentConfigurationSchema.parse(options.configuration ?? { modelId: options.provider?.name ?? null, thinkingLevel: 'off', tools: INVOICE_REVIEW_TOOL_NAMES,
    resources: { prompt: null, enabledSkills: [] }, extensions: { enabledExtensions: [] }, workingDirectory: null, preferences: '' });
  const created = await database.transaction(scope => {
    const agent = need(scope.personalAgents.ensureDefault(configuration, at));
    for (const documentId of [1, 2]) {
      const originalId = documentId * 2 - 1, parsedId = documentId * 2;
      const original = Buffer.from('original controlled invoice');
      const parsed = Buffer.from(JSON.stringify({ formatVersion: 2, pages: [{ page: 1,
        blocks: [{ id: 'b1', kind: 'text', text: 'Total 113.00', sourceIndex: 0, sourceType: 'synthetic', bbox: null }] }],
        completeness: { status: 'complete', checks: [], warnings: [] } }));
      for (const [id, name, content] of [[originalId, 'original.pdf', original], [parsedId, 'parsed.json', parsed]] as const) {
        mkdirSync(join(paths.artifactsDir, String(id)), { recursive: true });
        writeFileSync(join(paths.artifactsDir, String(id), name), content);
        scope.contents.remember({ ownerKind: 'artifact', ownerId: String(id), relativePath: name }, content);
      }
      const metadata = { version: 1 as const, sourceKey: 'work-tools', sourceRecordId: String(documentId), sourceVersion: 'v1' };
      need(scope.documents.register({ documentId, sourceKey: metadata.sourceKey, sourceRecordId: metadata.sourceRecordId, version: 'v1',
        originalArtifact: { artifactId: originalId, kind: 'original', relativePath: `artifacts/${originalId}/original.pdf`, bytes: original.length,
          mimeType: 'application/pdf', metadata: { ...metadata, files: [{ relativePath: 'original.pdf', bytes: original.length, mimeType: 'application/pdf' }] }, createdAt: at },
        parsedArtifact: { artifactId: parsedId, kind: 'parsed', relativePath: `artifacts/${parsedId}/parsed.json`, bytes: parsed.length,
          mimeType: 'application/json', metadata: { ...metadata, files: [{ relativePath: 'parsed.json', bytes: parsed.length, mimeType: 'application/json' }] }, createdAt: at },
        status: 'available', metadata: { version: 2, pageCount: 1, warnings: [], allowedUsesClaim: ['Controlled business tool test'],
          licenseVerification: 'not_verified', unavailableReason: null }, createdAt: at, updatedAt: at }));
    }
    return need(scope.invoiceWorks.create({ personalAgentId: agent.personalAgentId, expectedAgentRevision: agent.revision,
      requestId: 'create-work-tools', goal: 'Prepare candidates for the fixed invoices.', documents: [{ id: 1, version: 'v1' }, { id: 2, version: 'v1' }] },
    { at, admission: { kind: 'ready' } }));
  });
  if (!('attempt' in created.execution) || !created.execution.attempt) throw Error('Expected the real admitted attempt.');
  if (options.maxToolFeedbackBytes !== undefined) await database.transaction(scope => scope.db.query(
    "UPDATE invoice_works SET budget_json=json_set(budget_json,'$.runtimeBudget.maxToolFeedbackBytes',?) WHERE id=?")
    .run(options.maxToolFeedbackBytes!, created.workId));
  const attemptId = created.execution.attempt.attemptId;
  const admitted = await database.transaction(scope => {
    const view = need(scope.invoiceWorks.get({ view: 'work', workId: created.workId }));
    if (view.view !== 'work' || !view.items[0]) throw Error('Expected real fixed members.');
    const itemId = view.items[0].itemId;
    const job = need(scope.invoiceWorks.prepareItemJob({ workId: created.workId, itemId, expectedRevision: view.items[0].revision, at }));
    const budget = DurableWorkBudgetSchema.parse(JSON.parse(scope.db.query<{ budget_json: string }, [number]>(
      'SELECT budget_json FROM invoice_works WHERE id=?').get(created.workId)!.budget_json));
    const config = DurableRunConfigSnapshotSchema.parse({ version: 3, runtimeKind: 'durable', name: options.provider?.name ?? 'Original durable invoice tool Run',
      revision: options.provider?.revision ?? 1, requestedModel: options.provider?.modelRef ?? { provider: 'controlled', model: 'offline' },
      resolvedModel: null, api: options.provider?.connection?.api ?? null, endpoint: options.provider?.connection?.baseUrl ?? null, sdk,
      parameters: options.provider?.parameters ?? { maxRetries: 0, maxRetryDelayMs: 1000 }, ...budget,
      durable: { workId: created.workId, attemptId, configurationRevision: 0 }, resources: configuration.resources,
      extensions: configuration.extensions, workingDirectory: null });
    const usage: UsageRecord = { version: 1, source: 'not-requested', reason: 'controlled-business-tools', sdkValues: null,
      attempts: 0, attemptsComplete: true, costSource: null, updatedAt: at };
    const runId = need(scope.runs.createDurable({ workId: created.workId, attemptId,
      input: { version: 1, goal: view.work.goal, text: view.work.goal, messageTimestamp: Date.parse(at) }, config, usage,
      cleanup: { version: 1, stopped: false, stopReason: null, errors: [], lateObservationRequired: false }, createdAt: at }));
    need(scope.runs.start(runId, config, at));
    const current = need(scope.invoiceWorks.get({ view: 'item', workId: created.workId, itemId }));
    if (current.view !== 'item') throw Error('Expected the owned item.');
    const phase = need(scope.invoiceWorks.freezePhase({ workId: created.workId, attemptId, itemId, requestId: 'invoice-phase-1', kind: 'prompt',
      basis: { contextSnapshotId: null, inputIds: [], documentRefs: [current.item.documentRef], configurationRevision: 0,
        itemRevision: current.item.revision }, at }));
    const context = need(buildInvoiceWorkContext(need(scope.invoiceWorks.readContextInput({ workId: created.workId, attemptId,
      requestId: phase.requestId, remainingBudget: { modelCalls: 12, toolCalls: 24,
        toolFeedbackBytes: Math.min(65536, budget.runtimeBudget.maxToolFeedbackBytes), timeoutMs: 30000, childSlots: 1 } }))));
    need(scope.invoiceWorkContexts.save({ context, at }));
    return { runId, itemId, jobId: job.jobId, phase, config };
  });
  const files = createFileStore(paths, database), documents = createDocumentService({ paths, files, allowedSourceRoot: root, now: () => at,
    transaction: operation => database.transaction(scope => operation({ repository: scope.documents,
      files: { read: (artifact, name) => files.read(artifact, name, scope.contents) } })) });
  const definitions = createInvoiceTools({
    documents: { readParsedForRun: (id, context) => database.read(scope => documents.readParsedForRun(id, context, {
      repository: scope.documents, files: { read: (artifact, name) => files.read(artifact, name, scope.contents) } })) },
    documentRepository: { get: id => database.read(scope => scope.documents.get(id)) },
    candidates: { save: input => database.transaction(scope => scope.candidates.save(input)),
      listForRun: input => database.read(scope => scope.candidates.listForRun(input)),
      readForRun: input => database.read(scope => scope.candidates.readForRun(input)) }, now: () => at });
  const executor = createToolExecutor({ database, definitions, now: () => at });
  const product: ProductToolContext = { runId: admitted.runId, sessionId: created.sessionId,
    scope: need(await database.read(scope => resolveInvoiceWorkToolScope(scope.db, { runId: admitted.runId, sessionId: created.sessionId,
      workId: created.workId, attemptId, requestId: admitted.phase.requestId }))).scope };
  const execute = (name: string, args: unknown, nativeToolCallId: string) => executor.execute(name, args,
    { ...product, nativeToolCallId, signal: new AbortController().signal });
  return { database, paths, created, attemptId, ...admitted, product, executor, execute, definitions, configuration };
}

export function invoiceWorkCandidateDraft() {
  const missing = { raw: null, normalized: null, state: 'missing', alternatives: [], sources: [] };
  return CandidateDraftSchema.parse({ fields: { ...Object.fromEntries(['invoiceNumber', 'issueDate', 'sellerName', 'sellerTaxId',
    'buyerName', 'buyerTaxId', 'currency', 'netAmount', 'taxAmount'].map(name => [name, missing])),
  totalAmount: { raw: '113.00', normalized: '113.00', state: 'present', alternatives: [],
    sources: [{ documentId: 1, version: 'v1', artifactId: 2, page: 1, blockId: 'b1', quote: 'Total 113.00' }] } }, lines: [], notes: [] });
}
