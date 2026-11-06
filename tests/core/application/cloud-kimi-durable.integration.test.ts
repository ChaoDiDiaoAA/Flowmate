import { expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { appError, fail, ok, InvoiceWorkGetResultSchema, PersonalAgentConfigurationSchema, PersonalAgentSnapshotSchema,
  type DesktopActionView, type ProductPaths, type ProviderConfig, type Result } from '@flowmate/contracts';
import { createApplication } from '../../../apps/composition.ts';
import type { PersonalAgentRuntime } from '../../../apps/personal-agent.ts';
import type { CloudMaterialExport } from '../../../apps/cloud-material-export.ts';
import { runCloudDesktopBridge } from '../../../apps/cloud-desktop-bridge.ts';
import { callCloudUnixRpc } from '../../../apps/cloud-unix-rpc.ts';
import { CloudSshSession } from '../../../apps/desktop/main/cloud-ssh-session.ts';
import { CloudDesktopController } from '../../../apps/desktop/main/cloud-desktop-controller.ts';
import { createKimiDesktop, handleKimiDesktopRequest } from '../../../apps/desktop/main/kimi-desktop.ts';
import { uploadCloudMaterial } from '../../../apps/desktop/main/cloud-material-transfer.ts';
import { deferCleanup, mkdtempSync, waitFor } from '../../support/resources.ts';

function need<T>(result: Result<T>): T { if (!result.ok) throw Error(`${result.error.code}: ${result.error.message}`); return result.data; }
function paths(root: string): ProductPaths { return { root, databaseFile: join(root, 'data/app.sqlite'), artifactsDir: join(root, 'artifacts'),
  runtimeDir: join(root, 'runtime'), logsDir: join(root, 'logs'), outputsDir: join(root, 'outputs') }; }

test.skipIf(process.platform !== 'linux')('cloud Durable controls only the locally approved desktop action through the real cloud transport', async () => {
  const authorityRoot = mkdtempSync(join(tmpdir(), 'flowmate-cloud-kimi-authority-'));
  const runtimeRoot = mkdtempSync(join(tmpdir(), 'flowmate-cloud-kimi-runtime-'));
  const localRoot = mkdtempSync(join(tmpdir(), 'flowmate-cloud-kimi-local-'));
  const workspaceId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', desktopSocket = join(authorityRoot, 'desktop.sock'),
    authoritySocket = join(authorityRoot, 'authority.sock'), modelSocket = join(authorityRoot, 'model.sock'), runtimeSocket = join(runtimeRoot, 'runtime.sock');
  const configuration = PersonalAgentConfigurationSchema.parse({ modelId: 'cloud-model', thinkingLevel: 'off',
    tools: ['desktop_list_windows', 'desktop_observe_window', 'desktop_propose_action', 'desktop_execute_approved'],
    resources: { prompt: null, enabledSkills: [] }, extensions: { enabledExtensions: [] }, workingDirectory: null, preferences: '' });
  const provider: ProviderConfig = { version: 1, name: 'controlled-cloud', revision: 1,
    modelRef: { provider: 'deepseek', model: 'deepseek-fixture' }, native: { authPath: 'unused', modelsPath: null },
    connection: { api: 'openai-completions', baseUrl: 'https://api.deepseek.com', contextWindow: 64000, maxTokens: 8192 },
    parameters: { maxRetries: 0, maxRetryDelayMs: 1000 } };
  const gate = Promise.withResolvers<void>(); let calls = 0, modelError = '';
  let control: PersonalAgentRuntime | undefined, localExport: CloudMaterialExport | undefined;
  const authority = need(await createApplication({ paths: paths(authorityRoot), personalAgent: { defaultConfiguration: configuration,
    resolveConfiguration: () => ok(provider), readApiKey: () => 'synthetic-key', onReady: value => { control = value as PersonalAgentRuntime; } },
    cloudAuthority: { workspaceId, desktopSocket, authoritySocket, modelSocket, runtimeSocket, readApiKey: () => 'synthetic-key',
      fetch: async (_url, init) => {
        const body = JSON.parse(String(init.body)) as { messages: Array<{ role: string; content: string }> };
        const context = JSON.parse(body.messages.find(message => message.role === 'user')!.content) as { phase: { basis: { desktopProposalId?: number } } };
        const results = body.messages.filter(message => message.role === 'tool').map(message => String(message.content));
        let name = '', args: unknown = {};
        if (context.phase.basis.desktopProposalId && results.some(value => value.includes('"outcome":"dispatched"'))) name = '';
        else if (context.phase.basis.desktopProposalId) { name = 'desktop_execute_approved'; args = { proposalId: context.phase.basis.desktopProposalId }; }
        else if (!results.length) { await gate.promise; name = 'desktop_observe_window'; }
        else {
          const observed = JSON.parse(results.at(-1)!) as { data?: { observationId?: string } };
          if (!observed.data?.observationId) { modelError = results.at(-1)!; throw Error(modelError); }
          name = 'desktop_propose_action'; args = { kind: 'set_value', observationId: observed.data.observationId, elementIndex: 3, value: '113.00' };
        }
        calls++;
        const delta = name ? { role: 'assistant', tool_calls: [{ index: 0, id: `cloud-kimi-${calls}`, type: 'function',
          function: { name, arguments: JSON.stringify(args) } }] } : { role: 'assistant', content: 'The dispatched input needs human review.' };
        return new Response(`data: ${JSON.stringify({ id: `cloud-kimi-response-${calls}`, object: 'chat.completion.chunk', created: 1,
          model: 'deepseek-fixture', choices: [{ index: 0, delta, finish_reason: name ? 'tool_calls' : 'stop' }] })}\n\ndata: [DONE]\n\n`,
        { headers: { 'content-type': 'text/event-stream' } });
      } } }));
  if (!control) throw Error('Cloud Authority is unavailable.');
  deferCleanup(() => authority.close());
  const runtimeConfig = join(runtimeRoot, 'runtime.json');
  writeFileSync(runtimeConfig, JSON.stringify({ version: 1, root: runtimeRoot, runtimeSocketPath: runtimeSocket,
    authoritySocketPath: authoritySocket, modelSocketPath: modelSocket }));
  const runtimeEntry = process.env.FLOWMATE_CLOUD_TEST_BUNDLE ? join(process.env.FLOWMATE_CLOUD_TEST_BUNDLE, 'cloud-runtime-main.js')
    : new URL('../../../apps/cloud-runtime-main.ts', import.meta.url).pathname;
  const runtime = spawn(process.execPath, ['--no-env-file', runtimeEntry, runtimeConfig],
    { stdio: ['ignore', 'pipe', 'pipe'], env: { PATH: process.env.PATH ?? '' } });
  let runtimeError = ''; runtime.stderr.on('data', value => { runtimeError += value.toString(); }); runtime.stdout.resume();
  const exited = new Promise<void>(resolve => runtime.once('close', () => resolve()));
  deferCleanup(() => { if (runtime.exitCode === null && runtime.signalCode === null) runtime.kill('SIGTERM'); });
  const local = need(await createApplication({ paths: paths(localRoot), onCloudMaterialReady: value => { localExport = value; } }));
  deferCleanup(() => local.close());
  if (!localExport) throw Error('Local material export is unavailable.');
  const document = need(await local.importPreparedInvoiceMaterial({ contract: 'flowmate-prepared-invoice/v1', sample: 'cloud-kimi', sourceText: 'Total 113.00',
    original: { name: 'source.md', base64: Buffer.from('Total 113.00').toString('base64') },
    pages: [{ page: 1, blocks: [{ id: 'b1', kind: 'text', text: 'Total 113.00', sourceIndex: 0, sourceType: 'prepared-text', bbox: null }] }] }));
  const stdin = new PassThrough(), stdout = new PassThrough(), stderr = new PassThrough();
  const child = Object.assign(new EventEmitter(), { stdin, stdout, stderr, kill: () => { stdin.end(); return true; } });
  const transport = runCloudDesktopBridge(stdin, stdout, envelope => callCloudUnixRpc(desktopSocket, envelope));
  void transport.then(() => child.emit('close', 0, null));
  const session = new CloudSshSession(child as unknown as ChildProcessWithoutNullStreams, workspaceId);
  const window = { id: 42, app: 'Controlled', title: 'Sample' }; let value = '0.00';
  const desktop = createKimiDesktop({ listWindows: async () => [window], observe: async () => ({ window, tree: '[3] Edit Sample amount', focused: null }),
    click: async () => {}, setValue: async (_window, _index, text) => { value = text; }, typeText: async () => {}, close: async () => {} });
  const controller = new CloudDesktopController({ connect: async () => ok(session), upload: (input, connection) => uploadCloudMaterial(input, localExport!, connection),
    desktop: {
      verify: async (cloud, action, signal) => {
        const result = await desktop.resolveTarget({ workspaceId: cloud, workId: action.workId, itemId: action.itemId }, action.action, signal);
        return result.ok && isDeepStrictEqual(result.data, action.target) ? ok(undefined) : fail(appError('desktop_target_changed', 'runtime', 'Target changed.'));
      },
      execute: (cloud, request, signal) => handleKimiDesktopRequest(desktop,
        { workspaceId: cloud, workId: request.workId, itemId: request.itemId }, request, signal),
    } });
  try {
    await waitFor(async () => { if (runtime.exitCode !== null) throw Error(runtimeError); return existsSync(runtimeSocket); }, 15_000);
    need(await control.start());
    need(await controller.connect({ workspaceId, target: { host: '127.0.0.1', port: 22, username: 'flowmate', privateKeyPath: '/test/key', knownHostsPath: '/test/hosts' } }));
    const material = need(await controller.upload({ workspaceId, documentRef: document.documentRef }));
    const agent = PersonalAgentSnapshotSchema.parse(need(await controller.request({ workspaceId, command: { type: 'personal_agent_get', input: {} } })));
    const created = need(await controller.request({ workspaceId, command: { type: 'invoice_work_create', input: { personalAgentId: agent.personalAgentId,
      expectedAgentRevision: agent.revision, requestId: 'cloud-kimi-work', goal: 'Fill the controlled sample for review.', documents: [material.cloudDocumentRef] } } })) as { workId: number };
    const page = InvoiceWorkGetResultSchema.parse(need(await controller.request({ workspaceId, command: { type: 'invoice_work_get',
      input: { view: 'work', workId: created.workId, limit: 10 } } })));
    if (page.view !== 'work' || !page.items[0]) throw Error('Cloud invoice is unavailable.');
    const owner = { workspaceId, workId: created.workId, itemId: page.items[0].itemId };
    need(await desktop.listWindows(new AbortController().signal)); need(await desktop.select(owner, window, new AbortController().signal));
    gate.resolve();
    await waitFor(async () => { const result = await controller.request({ workspaceId, command: { type: 'invoice_work_desktop_list',
      input: { workId: owner.workId, itemId: owner.itemId, limit: 10 } } });
      return result.ok && !!(result.data as { items: Array<{ canDecide: boolean }> }).items[0]?.canDecide; }, 20_000);
    expect(value).toBe('0.00');
    const current = InvoiceWorkGetResultSchema.parse(need(await controller.request({ workspaceId, command: { type: 'invoice_work_get',
      input: { view: 'work', workId: owner.workId, limit: 1 } } })));
    const actions = need(await controller.request({ workspaceId, command: { type: 'invoice_work_desktop_list',
      input: { workId: owner.workId, itemId: owner.itemId, limit: 10 } } })) as { items: DesktopActionView[] };
    const approved = need(await controller.request({ workspaceId, command: { type: 'invoice_work_desktop_decide', input: { workId: owner.workId,
      itemId: owner.itemId, proposalId: actions.items[0]!.proposalId, expectedRevision: current.work.revision, requestId: 'cloud-kimi-approve', decision: 'approve',
      confirmedAction: actions.items[0]!.action, confirmedTarget: actions.items[0]!.target } } })) as { revision: number };
    need(await controller.request({ workspaceId, command: { type: 'invoice_work_continue', input: { workId: owner.workId, expectedRevision: approved.revision,
      expectedAttemptId: current.work.execution.attempt?.attemptId ?? null, requestId: 'cloud-kimi-continue' } } }));
    await waitFor(async () => value === '113.00', 20_000);
    expect(value).toBe('113.00');
  } catch (error) { throw Error(`${String(error)}; model=${modelError}; runtime=${runtimeError}`); }
  finally {
    gate.resolve(); await controller.close(); await desktop.close(); await local.close(); await authority.close();
    if (runtime.exitCode === null && runtime.signalCode === null) runtime.kill('SIGTERM'); await exited;
  }
}, 90_000);
