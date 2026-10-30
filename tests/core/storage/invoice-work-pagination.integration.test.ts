import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PersonalAgentConfigurationSchema, type DocumentRef, type InvoiceWorkGetRequest, type Result } from '@flowmate/contracts';
import type { InvoiceWorkTodoDefinition } from '../../../packages/core/src/personal-agent/repository.ts';
import type { SqlDatabaseStore } from '../../../packages/core/src/storage/database.ts';
import { openTestDatabase } from '../../support/database.ts';
import { mkdtempSync } from '../../support/resources.ts';

const at = '2026-10-29T00:00:00.000Z';
function need<T>(result: Result<T>): T { if (!result.ok) throw Error(`${result.error.code}: ${result.error.message}`); return result.data; }

function registerDocument(scope: SqlDatabaseStore, documentId: number): DocumentRef {
  const originalId = documentId * 2 - 1, parsedId = documentId * 2;
  const metadata = { version: 1 as const, sourceKey: 'work-pagination', sourceRecordId: `invoice-${documentId}`, sourceVersion: 'v1' };
  need(scope.documents.register({ documentId, sourceKey: metadata.sourceKey, sourceRecordId: metadata.sourceRecordId, version: 'v1',
    originalArtifact: { artifactId: originalId, kind: 'original', relativePath: `artifacts/${originalId}/source.md`, bytes: 1,
      mimeType: 'text/markdown', metadata: { ...metadata, files: [{ relativePath: 'source.md', bytes: 1, mimeType: 'text/markdown' }] }, createdAt: at },
    parsedArtifact: { artifactId: parsedId, kind: 'parsed', relativePath: `artifacts/${parsedId}/parsed.json`, bytes: 1,
      mimeType: 'application/json', metadata: { ...metadata, files: [{ relativePath: 'parsed.json', bytes: 1, mimeType: 'application/json' }] }, createdAt: at },
    status: 'available', metadata: { version: 2, pageCount: 1, warnings: [], allowedUsesClaim: ['Controlled pagination records'],
      licenseVerification: 'not_verified', unavailableReason: null }, createdAt: at, updatedAt: at }));
  return { id: documentId, version: 'v1' };
}

async function fixture(memberCount = 1) {
  const root = mkdtempSync(join(tmpdir(), 'flowmate-invoice-work-pagination-'));
  const database = need(openTestDatabase({ root, databaseFile: join(root, 'data/app.sqlite'), artifactsDir: join(root, 'artifacts'),
    outputsDir: join(root, 'outputs'), logsDir: join(root, 'logs'), runtimeDir: join(root, 'runtime') }));
  const seeded = await database.transaction(scope => ({
    agent: need(scope.personalAgents.ensureDefault(PersonalAgentConfigurationSchema.parse({ modelId: null, thinkingLevel: 'off',
      resources: { prompt: null, enabledSkills: [] }, extensions: { enabledExtensions: [] }, tools: [], workingDirectory: null, preferences: '' }), at)),
    documents: Array.from({ length: memberCount }, (_, index) => registerDocument(scope, index + 1)),
  }));
  const create = (requestId: string, goal = 'Review the fixed invoices.') => database.transaction(scope => scope.invoiceWorks.create({
    personalAgentId: seeded.agent.personalAgentId, expectedAgentRevision: seeded.agent.revision, requestId, goal,
    documents: seeded.documents }, { at, admission: { kind: 'queued' } }));
  return { database, ...seeded, create };
}

test('large legal Work goals paginate list by UTF-8 bytes without losing or repeating Works', async () => {
  const f = await fixture(), goal = 'g'.repeat(22_000), expected: number[] = [];
  for (let index = 0; index < 15; index++) expected.push(need(await f.create(`large-goal-${index}`, goal)).workId);
  const seen: number[] = []; let beforeId: number | undefined;
  for (let pageNumber = 0; pageNumber < 15; pageNumber++) {
    const page = need(await f.database.read(scope => scope.invoiceWorks.list({ personalAgentId: f.agent.personalAgentId,
      limit: 100, ...(beforeId === undefined ? {} : { beforeId }) })));
    expect(Buffer.byteLength(JSON.stringify(page), 'utf8')).toBeLessThanOrEqual(262_144);
    expect(page.items.length).toBeGreaterThan(0);
    expect(page.items.every(item => item.goal === goal)).toBe(true);
    if (pageNumber === 0) expect(page.items.length).toBeLessThan(15);
    seen.push(...page.items.map(item => item.workId));
    if (page.nextBeforeId === null) { beforeId = undefined; break; }
    expect(page.nextBeforeId).toBe(page.items.at(-1)!.workId);
    beforeId = page.nextBeforeId;
  }
  expect(beforeId).toBeUndefined();
  expect(seen).toEqual([...expected].reverse());
});

test('large legal final decisions paginate fixed members by UTF-8 bytes and stable item cursors', async () => {
  const f = await fixture(50), created = need(await f.create('large-final-decisions'));
  const original = need(await f.database.read(scope => scope.invoiceWorks.get({ view: 'work', workId: created.workId, limit: 100 })));
  if (original.view !== 'work') throw Error('Expected the original fixed member page.');
  expect(original.items).toHaveLength(50);
  const reason = '票'.repeat(2048); let revision = created.revision;
  for (const item of original.items) {
    const disposed = need(await f.database.transaction(scope => scope.invoiceWorks.disposeItem({ workId: created.workId,
      itemId: item.itemId, requestId: `large-rejection-${item.itemId}`, expectedRevision: revision,
      decision: { kind: 'rejected', reason } }, { at })));
    revision = disposed.revision;
  }
  const seen: number[] = []; let afterItemId: number | undefined;
  for (let pageNumber = 0; pageNumber < 50; pageNumber++) {
    const request: InvoiceWorkGetRequest = { view: 'work', workId: created.workId, limit: 100,
      ...(afterItemId === undefined ? {} : { afterItemId }) };
    const result = await f.database.read(scope => scope.invoiceWorks.get(request)), page = need(result);
    if (page.view !== 'work') throw Error('Expected a fixed member page.');
    expect(Buffer.byteLength(JSON.stringify(page), 'utf8')).toBeLessThanOrEqual(262_144);
    expect(page.items.length).toBeGreaterThan(0);
    expect(page.work).toMatchObject({ status: 'completed', counts: { total: 50, unresolved: 0, rejected: 50 } });
    expect(page.items.every(item => item.disposition === 'rejected' && item.decision?.kind === 'rejected'
      && item.decision.reason === reason)).toBe(true);
    expect(await f.database.read(scope => scope.invoiceWorks.get(request))).toEqual(result);
    if (pageNumber === 0) expect(page.items.length).toBeLessThan(50);
    seen.push(...page.items.map(item => item.itemId));
    if (page.nextAfterItemId === null) { afterItemId = undefined; break; }
    expect(page.nextAfterItemId).toBe(page.items.at(-1)!.itemId);
    afterItemId = page.nextAfterItemId;
  }
  expect(afterItemId).toBeUndefined();
  expect(seen).toEqual(original.items.map(item => item.itemId));
  expect(await f.database.read(scope => scope.db.query('SELECT COUNT(*) AS count FROM runs').get())).toEqual({ count: 0 });
});

test('large legal rule Todos paginate one item by UTF-8 bytes without losing original Todo identities', async () => {
  const f = await fixture(), created = need(await f.create('large-rule-todos'));
  const original = need(await f.database.read(scope => scope.invoiceWorks.get({ view: 'work', workId: created.workId, limit: 100 })));
  if (original.view !== 'work' || !original.items[0]) throw Error('Expected the original fixed invoice item.');
  const item = original.items[0];
  const definitions: InvoiceWorkTodoDefinition[] = Array.from({ length: 20 }, () => ({ actor: 'system', fieldPath: null,
    problem: '问'.repeat(2048), needed: '需'.repeat(2048), satisfiedBy: '足'.repeat(2048), action: 'review',
    basis: { origin: 'rule', documentRefs: [item.documentRef], sourceRefs: [], inputIds: [], candidateRef: null } }));
  const todos = need(await f.database.transaction(scope => scope.invoiceWorks.replaceTodos({ workId: created.workId,
    itemId: item.itemId, expectedRevision: item.revision, todos: definitions, at })));
  expect(todos).toHaveLength(20);
  const seen: number[] = []; let afterTodoId: number | undefined;
  for (let pageNumber = 0; pageNumber < 20; pageNumber++) {
    const request: InvoiceWorkGetRequest = { view: 'item', workId: created.workId, itemId: item.itemId, limit: 100,
      ...(afterTodoId === undefined ? {} : { afterTodoId }) };
    const result = await f.database.read(scope => scope.invoiceWorks.get(request)), page = need(result);
    if (page.view !== 'item') throw Error('Expected the original invoice Todo page.');
    expect(Buffer.byteLength(JSON.stringify(page), 'utf8')).toBeLessThanOrEqual(262_144);
    expect(page.todos.length).toBeGreaterThan(0);
    expect(page.item).toMatchObject({ itemId: item.itemId, todoCount: 20, disposition: 'unresolved' });
    expect(page.todos.every(todo => todo.applicable && todo.problem === definitions[0]!.problem
      && todo.needed === definitions[0]!.needed && todo.satisfiedBy === definitions[0]!.satisfiedBy)).toBe(true);
    expect(await f.database.read(scope => scope.invoiceWorks.get(request))).toEqual(result);
    if (pageNumber === 0) expect(page.todos.length).toBeLessThan(20);
    seen.push(...page.todos.map(todo => todo.todoId));
    if (page.nextAfterTodoId === null) { afterTodoId = undefined; break; }
    expect(page.nextAfterTodoId).toBe(page.todos.at(-1)!.todoId);
    afterTodoId = page.nextAfterTodoId;
  }
  expect(afterTodoId).toBeUndefined();
  expect(seen).toEqual(todos.map(todo => todo.todoId));
  expect(await f.database.read(scope => scope.db.query('SELECT COUNT(*) AS count FROM tool_calls').get())).toEqual({ count: 0 });
});
