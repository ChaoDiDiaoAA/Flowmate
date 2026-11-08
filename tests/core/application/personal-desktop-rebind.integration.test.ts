import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { appError, fail, ok, PersonalAgentConfigurationSchema, type InvoiceWorkWorkingContext,
  type ProductPaths, type ProviderConfig, type Result } from '@flowmate/contracts';
import { createFileStore } from '@flowmate/core';
import { createApplication } from '../../../apps/composition.ts';
import { openTestDatabase } from '../../support/database.ts';
import { deferCleanup, mkdtempSync, waitFor } from '../../support/resources.ts';

function need<T>(result: Result<T>): T { if (!result.ok) throw Error(`${result.error.code}: ${result.error.message}`); return result.data; }

test('an approved original desktop task waits for explicit reconfirmation of the same action after reconnect', async () => {
  const root = mkdtempSync(join(tmpdir(), 'flowmate-desktop-work-'));
  const paths: ProductPaths = { root, databaseFile: join(root, 'data/app.sqlite'), artifactsDir: join(root, 'artifacts'),
    runtimeDir: join(root, 'runtime'), logsDir: join(root, 'logs'), outputsDir: join(root, 'outputs') };
  const database = need(openTestDatabase(paths)), files = createFileStore(paths, database), at = new Date().toISOString();
  const published = need(await files.publish({ sourceKey: 'desktop-test', sourceRecordId: '1', sourceVersion: 'v1', at,
    original: { kind: 'original', primaryName: 'original.pdf', files: [{ name: 'original.pdf', bytes: Buffer.from('synthetic invoice'), mimeType: 'application/pdf' }] },
    parsed: { kind: 'parsed', primaryName: 'parsed.json', files: [{ name: 'parsed.json', mimeType: 'application/json',
      bytes: Buffer.from(JSON.stringify({ formatVersion: 2, pages: [{ page: 1, blocks: [] }], completeness: { status: 'complete', checks: [], warnings: [] } })) }] } }));
  const document = need(await database.transaction(scope => scope.documents.register({ documentId: published.documentId,
    sourceKey: 'desktop-test', sourceRecordId: '1', version: 'v1', originalArtifact: { ...published.original, kind: 'original' },
    parsedArtifact: { ...published.parsed, kind: 'parsed' }, status: 'available', createdAt: at, updatedAt: at,
    metadata: { version: 2, pageCount: 1, warnings: [], allowedUsesClaim: ['Synthetic desktop test'], licenseVerification: 'not_verified', unavailableReason: null } })));
  await database.close();
  const action = { kind: 'click' as const, observationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', elementIndex: 3 };
  const target = { connectionId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', window: { id: 42, app: 'Controlled', title: 'Draft' }, element: '[3] Save' };
  const nextAction = { ...action, observationId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' };
  const nextTarget = { ...target, connectionId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd' };
  const wire: Array<{ messages: Array<{ role: string; content?: string }> }> = [];
  const server = Bun.serve({ port: 0, fetch: async request => {
    const body = await request.json() as { messages: Array<{ role: string; content?: string }> }; wire.push(body);
    const context = JSON.parse(body.messages.find(message => message.role === 'user')!.content!) as InvoiceWorkWorkingContext;
    const proposed = !body.messages.some(message => message.role === 'tool') && context.actions.tools.includes('desktop_propose_action');
    const delta = proposed ? { role: 'assistant', tool_calls: [{ index: 0, id: 'desktop-original', type: 'function',
      function: { name: 'desktop_propose_action', arguments: JSON.stringify(action) } }] } : { role: 'assistant', content: 'Review complete.' };
    return new Response(`data: ${JSON.stringify({ id: `desktop-${wire.length}`, object: 'chat.completion.chunk', created: 1,
      model: 'desktop-model', choices: [{ index: 0, delta, finish_reason: proposed ? 'tool_calls' : 'stop' }] })}\n\ndata: [DONE]\n\n`,
    { headers: { 'content-type': 'text/event-stream' } });
  } });
  deferCleanup(() => server.stop(true));
  const provider: ProviderConfig = { version: 1, name: 'desktop-model', revision: 1, modelRef: { provider: 'desktop-test', model: 'desktop-model' },
    credentialRef: 'controlled-key-ref', native: { authPath: join(root, 'unused.json'), modelsPath: null },
    connection: { api: 'openai-completions', baseUrl: `http://127.0.0.1:${server.port}/v1`, contextWindow: 64000, maxTokens: 8192, reasoning: false },
    parameters: { maxRetries: 0, maxRetryDelayMs: 1000 } };
  const configuration = PersonalAgentConfigurationSchema.parse({ modelId: 'desktop-model', thinkingLevel: 'off',
    tools: ['desktop_propose_action', 'desktop_execute_approved'], resources: { prompt: null, enabledSkills: [] },
    extensions: { enabledExtensions: [] }, workingDirectory: null, preferences: '' });
  let connection = 1, changed = false, dispatched = 0;
  const application = need(await createApplication({ paths,
    provider: { prepare: async () => fail(appError('unused', 'provider', 'Unused.')), close: async () => ({ stopped: true, closed: true, errors: [] }) },
    personalAgent: { defaultConfiguration: configuration, resolveConfiguration: () => ok(provider), readApiKey: () => 'synthetic-key',
      desktop: { listWindows: async () => ok([target.window]), observe: async () => ok({ observationId: nextAction.observationId,
        window: target.window, tree: changed ? '[3] Different' : '[3] Save', truncated: false }),
        resolveTarget: async input => connection === 0 ? fail(appError('desktop_unavailable', 'runtime', 'Disconnected.', true))
          : connection === 1 && input.observationId === action.observationId ? ok(target)
          : connection === 2 && input.observationId === nextAction.observationId ? ok(changed ? { ...nextTarget, element: '[3] Different' } : nextTarget)
          : fail(appError('desktop_target_changed', 'runtime', 'Observation expired.')),
        dispatch: async (input, current) => { expect(input).toEqual(nextAction); expect(current).toEqual(nextTarget); dispatched++; return ok(undefined); } } } }));
  deferCleanup(() => application.close());
  const agent = need(await application.personalAgent.get());
  const created = need(await application.invoiceWorks.create({ personalAgentId: agent.personalAgentId, expectedAgentRevision: agent.revision,
    requestId: 'desktop-work-create', goal: 'Review the controlled invoice.', documents: [document.documentRef] }));
  const work = need(await application.invoiceWorks.get({ view: 'work', workId: created.workId, limit: 1 }));
  if (work.view !== 'work' || !work.items[0]) throw Error('Missing invoice item.');
  const itemId = work.items[0].itemId;
  if (!created.execution.authorizationAccepted) need(await application.invoiceWorks.continueWork({ workId: created.workId,
    expectedRevision: work.work.revision, expectedAttemptId: work.work.execution.attempt?.attemptId ?? null, requestId: 'desktop-initial-continue' }));
  await waitFor(async () => { const result = await application.invoiceWorks.listDesktopActions({ workId: created.workId, itemId });
    return result.ok && result.data.items[0]?.canDecide === true; }, 15000);
  const proposal = need(await application.invoiceWorks.listDesktopActions({ workId: created.workId, itemId })).items[0]!;
  expect(proposal.resumeOriginal).toBe(true);
  const current = need(await application.invoiceWorks.get({ view: 'work', workId: created.workId, limit: 1 }));
  connection = 0;
  need(await application.invoiceWorks.decideDesktopAction({ workId: created.workId, itemId, proposalId: proposal.proposalId,
    expectedRevision: current.work.revision, requestId: 'desktop-approved', decision: 'approve', confirmedAction: action, confirmedTarget: target }));
  await Bun.sleep(5500); expect(dispatched).toBe(0);
  connection = 2; await Bun.sleep(5500); expect(dispatched).toBe(0);
  const input = { workId: created.workId, itemId, proposalId: proposal.proposalId, confirmedAction: action, confirmedTarget: target };
  changed = true; expect(await application.invoiceWorks.rebindDesktopAction(input)).toMatchObject({ ok: false });
  expect(dispatched).toBe(0); changed = false;
  expect(await application.invoiceWorks.rebindDesktopAction({ ...input, resume: true })).toMatchObject({ ok: false });
  need(await application.invoiceWorks.rebindDesktopAction(input));
  await Bun.sleep(5500); expect(dispatched).toBe(0);
  need(await application.invoiceWorks.rebindDesktopAction({ ...input, resume: true }));
  await waitFor(async () => dispatched === 1 && wire.length >= 2, 15000);
  expect(dispatched).toBe(1);
  expect(need(await application.invoiceWorks.listDesktopActions({ workId: created.workId, itemId })).items[0]).toMatchObject({ status: 'dispatched' });
  expect(wire).toHaveLength(2);
  expect(await application.close()).toMatchObject({ ok: true, data: { closed: true, stopped: true } });
}, 35000);
