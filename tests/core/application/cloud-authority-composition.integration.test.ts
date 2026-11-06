import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { Database } from 'bun:sqlite';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { appError, fail, CloudProgressEventSchema, CloudRuntimeStatusSchema, CloudQueueReceiptSchema, CloudQueueViewSchema, CloudReviewCandidateReceiptSchema, CloudReviewOpenReceiptSchema, InvoiceWorkCreateReceiptSchema, InvoiceWorkGetResultSchema, PersonalAgentConfigurationSchema, PersonalAgentSnapshotSchema,
  PersonalTaskGetResultSchema, type ProviderConfig, type Result } from '@flowmate/contracts';
import { createApplication } from '../../../apps/composition.ts';
import type { PersonalAgentRuntime } from '../../../apps/personal-agent.ts';
import type { CloudMaterialExport } from '../../../apps/cloud-material-export.ts';
import type { CloudResourceExport } from '../../../apps/cloud-resource-export.ts';
import { createCloudAuthorityCallbacksClient } from '../../../apps/cloud-authority-rpc.ts';
import { createCloudRuntimeRpcClient } from '../../../apps/cloud-runtime-rpc.ts';
import { runCloudDesktopBridge } from '../../../apps/cloud-desktop-bridge.ts';
import { CloudSshSession } from '../../../apps/desktop/main/cloud-ssh-session.ts';
import { uploadCloudMaterial } from '../../../apps/desktop/main/cloud-material-transfer.ts';
import { uploadCloudResource } from '../../../apps/desktop/main/cloud-resource-transfer.ts';
import { callCloudUnixRpc } from '../../../apps/cloud-unix-rpc.ts';
import { deferCleanup, mkdtempSync, waitFor } from '../../support/resources.ts';
import { invoiceWorkCandidateDraft } from '../../support/invoice-work-tools.ts';

function need<T>(result: Result<T>): T { if (!result.ok) throw Error(result.error.code); return result.data; }
const bundled = process.env.FLOWMATE_CLOUD_TEST_BUNDLE;
const entry = (name: 'authority' | 'runtime') => bundled ? join(bundled, `cloud-${name}-main.js`)
  : new URL(`../../../apps/cloud-${name}-main.ts`, import.meta.url).pathname;
const resourceRoot = () => bundled ? join(bundled, 'resources') : new URL('../../../resources/', import.meta.url).pathname.replace(/\/$/, '');

test.skipIf(process.platform !== 'linux')('the product owner starts and closes independent Authority endpoints', async () => {
  const root = mkdtempSync(join(tmpdir(), 'flowmate-authority-composition-'));
  const paths = { root, databaseFile: join(root, 'data/app.sqlite'), artifactsDir: join(root, 'artifacts'),
    runtimeDir: join(root, 'runtime'), logsDir: join(root, 'logs'), outputsDir: join(root, 'outputs') };
  const workspaceId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const desktopSocket = join(root, 'desktop.sock'), authoritySocket = join(root, 'authority.sock'),
    modelSocket = join(root, 'model.sock'), runtimeSocket = join(root, 'runtime.sock');
  const configuration = PersonalAgentConfigurationSchema.parse({ modelId: null, thinkingLevel: 'off', tools: [],
    resources: { prompt: null, enabledSkills: [] }, extensions: { enabledExtensions: [] }, workingDirectory: null, preferences: '' });
  const app = need(await createApplication({ paths, personalAgent: { defaultConfiguration: configuration,
    resolveConfiguration: () => fail(appError('model_unavailable', 'input', 'Not configured.')), readApiKey: () => undefined },
    cloudAuthority: { workspaceId, desktopSocket, authoritySocket, modelSocket, runtimeSocket, readApiKey: () => undefined } }));
  const command = { version: 1, workspaceId, requestId: '11111111-1111-4111-8111-111111111111',
    command: { type: 'personal_agent_get', input: {} } };
  try {
    expect(await callCloudUnixRpc(desktopSocket, command)).toMatchObject({ ok: true, data: { ok: true, data: { runtimeKind: 'durable' } } });
    expect(await callCloudUnixRpc(desktopSocket, { ...command, workspaceId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' }))
      .toMatchObject({ ok: true, data: { ok: false } });
  } finally { expect(await app.close()).toMatchObject({ ok: true, data: { closed: true, stopped: true } }); }
  expect(await callCloudUnixRpc(desktopSocket, command)).toMatchObject({ ok: false });
}, 30_000);

test.skipIf(process.platform !== 'linux')('Authority process reads a private systemd-style credential and starts only scoped sockets', async () => {
  const root = mkdtempSync(join(tmpdir(), 'flowmate-authority-cli-')), credentials = mkdtempSync(join(tmpdir(), 'flowmate-credentials-'));
  const desktopSocket = join(root, 'desktop.sock'), authoritySocket = join(root, 'authority.sock'), modelSocket = join(root, 'model.sock');
  const config = join(root, 'authority-config.json'), workspaceId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  writeFileSync(join(credentials, 'deepseek-api-key'), 'synthetic-process-secret\n', { mode: 0o600 });
  writeFileSync(config, JSON.stringify({ version: 1, productRoot: root, resourceRoot: resourceRoot(),
    workspaceId, desktopSocket, authoritySocket, modelSocket, runtimeSocket: join(root, 'runtime.sock'),
    model: { id: 'controlled-deepseek', name: 'deepseek-chat', contextWindow: 64000, maxTokens: 8192, reasoning: false } }));
  const executable = entry('authority');
  const child = spawn(process.execPath, ['--no-env-file', executable, config], { stdio: ['ignore', 'pipe', 'pipe'],
    env: { PATH: process.env.PATH ?? '', CREDENTIALS_DIRECTORY: credentials }, windowsHide: true });
  let output = ''; child.stdout.on('data', part => { output += part.toString(); }); child.stderr.on('data', part => { output += part.toString(); });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
  deferCleanup(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM'); });
  try {
    await waitFor(async () => { if (child.exitCode !== null) throw Error(`Authority exited: ${output}`); return existsSync(desktopSocket); }, 10_000);
    const result = await callCloudUnixRpc(desktopSocket, { version: 1, workspaceId, requestId: '11111111-1111-4111-8111-111111111111',
      command: { type: 'personal_agent_get', input: {} } });
    expect(result).toMatchObject({ ok: true, data: { ok: true, data: { configuration: { modelId: 'controlled-deepseek' } } } });
  } finally {
    child.kill('SIGTERM');
    expect(await Promise.race([exited, new Promise(resolve => setTimeout(() => resolve({ code: null, signal: 'timeout' }), 10_000))]))
      .toEqual({ code: 0, signal: null });
  }
  expect(output).not.toContain('synthetic-process-secret');
}, 30_000);

test.skipIf(process.platform !== 'linux')('Authority refuses a readable credential or a non-private product root before opening sockets', async () => {
  const root = mkdtempSync(join(tmpdir(), 'flowmate-authority-permissions-')), credentials = mkdtempSync(join(tmpdir(), 'flowmate-credentials-')),
    sockets = mkdtempSync(join(tmpdir(), 'flowmate-authority-sockets-'));
  const key = join(credentials, 'deepseek-api-key'), config = join(root, 'authority-config.json'), desktopSocket = join(sockets, 'desktop.sock');
  writeFileSync(key, 'synthetic-process-secret', { mode: 0o644 });
  writeFileSync(config, JSON.stringify({ version: 1, productRoot: root, resourceRoot: resourceRoot(),
    workspaceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', desktopSocket, authoritySocket: join(sockets, 'authority.sock'),
    modelSocket: join(sockets, 'model.sock'), runtimeSocket: join(sockets, 'runtime.sock'),
    model: { id: 'controlled-deepseek', name: 'deepseek-chat', contextWindow: 64000, maxTokens: 8192, reasoning: false } }));
  const executable = entry('authority');
  const launch = () => Bun.spawn([process.execPath, '--no-env-file', executable, config], { stdout: 'pipe', stderr: 'pipe',
    env: { PATH: process.env.PATH ?? '', CREDENTIALS_DIRECTORY: credentials } });
  try {
    const insecureKey = launch(); expect(await insecureKey.exited).toBe(1); expect(existsSync(desktopSocket)).toBe(false);
    chmodSync(key, 0o600); chmodSync(root, 0o755);
    const insecureRoot = launch();
    const outcome = await Promise.race([insecureRoot.exited, new Promise<'running'>(resolve => setTimeout(() => resolve('running'), 3000))]);
    if (outcome === 'running') { insecureRoot.kill('SIGTERM'); await insecureRoot.exited; }
    expect(outcome).toBe(1); expect(existsSync(desktopSocket)).toBe(false);
    expect(await new Response(insecureRoot.stderr).text()).not.toContain('synthetic-process-secret');
  } finally { chmodSync(root, 0o700); }
}, 30_000);

test.skipIf(process.platform !== 'linux')('the assembled Authority transfers an invoice and runs its original cloud Work through Runtime and the model proxy', async () => {
  const authorityRoot = mkdtempSync(join(tmpdir(), 'flowmate-authority-e2e-'));
  const runtimeRoot = mkdtempSync(join(tmpdir(), 'flowmate-runtime-e2e-'));
  const localRoot = mkdtempSync(join(tmpdir(), 'flowmate-local-e2e-'));
  const paths = (root: string) => ({ root, databaseFile: join(root, 'data/app.sqlite'), artifactsDir: join(root, 'artifacts'),
    runtimeDir: join(root, 'runtime'), logsDir: join(root, 'logs'), outputsDir: join(root, 'outputs') });
  const workspaceId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', desktopSocket = join(authorityRoot, 'desktop.sock'),
    authoritySocket = join(authorityRoot, 'authority.sock'), modelSocket = join(authorityRoot, 'model.sock'),
    runtimeSocket = join(runtimeRoot, 'runtime.sock');
  const config: ProviderConfig = { version: 1, name: 'controlled-cloud', revision: 1,
    modelRef: { provider: 'deepseek', model: 'deepseek-fixture' }, native: { authPath: 'unused', modelsPath: null },
    connection: { api: 'openai-completions', baseUrl: 'https://api.deepseek.com', contextWindow: 64000, maxTokens: 8192 },
    parameters: { maxRetries: 0, maxRetryDelayMs: 1000 } };
  const configuration = PersonalAgentConfigurationSchema.parse({ modelId: 'cloud-model', thinkingLevel: 'off', tools: ['save_invoice_candidate'],
    resources: { prompt: null, enabledSkills: [] }, extensions: { enabledExtensions: [] }, workingDirectory: null, preferences: '' });
  const wire: Array<{ url: string; authorization: string | null }> = [], errors: string[] = [], payloads: string[] = [];
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const steerText = 'Steer: check the original total.', followupText = 'Follow-up: keep the source unchanged.';
  const promptText = 'Controlled cloud prompt: preserve the original invoice evidence.', skillText = 'Controlled cloud skill: check the original source.';
  let promptSeen = false, skillSeen = false;
  let cloudDocumentId = 0, cloudParsedArtifactId = 0, cloudDocumentVersion = '';
  let control: PersonalAgentRuntime | undefined, localExport: CloudMaterialExport | undefined;
  const authority = need(await createApplication({ paths: paths(authorityRoot), logger: { write: event => {
    if (event.level === 'error') errors.push(event.code ?? event.event); }, close: async () => undefined },
    personalAgent: { defaultConfiguration: configuration, resolveConfiguration: () => ({ ok: true, data: config }),
      readApiKey: () => 'synthetic-key', onReady: value => { control = value as PersonalAgentRuntime; } },
    cloudAuthority: { workspaceId, desktopSocket, authoritySocket, modelSocket, runtimeSocket, readApiKey: () => 'synthetic-key',
      fetch: async (url, init) => {
        wire.push({ url, authorization: new Headers(init.headers).get('authorization') });
        if (typeof init.body === 'string') payloads.push(init.body);
        if (wire.length === 1) { entered.resolve(); await release.promise; }
        if (wire.length === 1) return new Response('Controlled retryable failure.', { status: 503 });
        if (typeof init.body === 'string' && init.body.includes(promptText)) promptSeen = true;
        if (typeof init.body === 'string' && init.body.includes(skillText)) skillSeen = true;
        const candidate = invoiceWorkCandidateDraft();
        candidate.fields.totalAmount.sources = [{ documentId: cloudDocumentId, version: cloudDocumentVersion, artifactId: cloudParsedArtifactId,
          page: 1, blockId: 'b1', quote: 'Controlled invoice total 113.00' }];
        const tool = wire.length === 2;
        const chunk = { id: 'controlled-cloud', object: 'chat.completion.chunk', created: 1, model: 'deepseek-fixture',
          choices: [{ index: 0, delta: tool ? { role: 'assistant', tool_calls: [{ index: 0, id: 'controlled-save', type: 'function',
            function: { name: 'save_invoice_candidate', arguments: JSON.stringify({ documentId: cloudDocumentId, candidate }) } }] }
            : { role: 'assistant', content: 'The original invoice needs human review.' }, finish_reason: tool ? 'tool_calls' : 'stop' }] };
        return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } });
      } } }));
  if (!control?.cloudAuthority) throw Error('Cloud Authority callbacks were not assembled.');
  deferCleanup(() => authority.close());
  const tools = need(await createCloudAuthorityCallbacksClient(authoritySocket).runtimeTools());
  expect(tools.map(tool => tool.name)).toContain('Agent');
  const runtimeConfig = join(runtimeRoot, 'runtime-config.json');
  writeFileSync(runtimeConfig, JSON.stringify({ version: 1, root: runtimeRoot, runtimeSocketPath: runtimeSocket,
    authoritySocketPath: authoritySocket, modelSocketPath: modelSocket }));
  const executable = entry('runtime');
  let runtimeError = '';
  const launchRuntime = () => {
    const child = spawn(process.execPath, ['--no-env-file', executable, runtimeConfig], { stdio: ['ignore', 'pipe', 'pipe'],
      env: { PATH: process.env.PATH ?? '' }, windowsHide: true });
    child.stderr.on('data', data => { runtimeError += data.toString(); }); child.stdout.resume();
    return { child, exited: new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve =>
      child.once('exit', (code, signal) => resolve({ code, signal }))) };
  };
  let launched = launchRuntime(), runtime = launched.child, exited = launched.exited;
  deferCleanup(() => { if (runtime.exitCode === null && runtime.signalCode === null) runtime.kill('SIGTERM'); });
  await waitFor(async () => { if (runtime.exitCode !== null) throw Error(`Runtime exited: ${runtimeError}`); return existsSync(runtimeSocket); }, 10_000);
  need(await control.start());
  const localResourceRoot = join(localRoot, 'selected-resources'), resourceDirectory = join(localResourceRoot, 'prompts', 'cloud-controlled');
  mkdirSync(resourceDirectory, { recursive: true });
  const ref = { kind: 'prompt' as const, id: 'cloud-controlled', version: 'v1' }, prompt = Buffer.from(promptText);
  const manifest = { schemaVersion: 2, ...ref, bodyFile: 'prompt.md', keywords: [], requires: [], files: [{ path: 'prompt.md', bytes: prompt.length }] };
  const manifestBytes = Buffer.from(JSON.stringify(manifest, null, 2) + '\n');
  writeFileSync(join(resourceDirectory, 'resource.json'), manifestBytes); writeFileSync(join(resourceDirectory, 'prompt.md'), prompt);
  const skill = { kind: 'skill' as const, id: 'cloud-audit', version: 'v1' }, skillDirectory = join(localResourceRoot, 'skills', skill.id);
  mkdirSync(join(skillDirectory, 'references'), { recursive: true });
  const skillBody = Buffer.from(`---\nname: ${skill.id}\ndescription: Controlled invoice audit\n---\n${skillText}`), supporting = Buffer.from('Original supporting instructions.');
  writeFileSync(join(skillDirectory, 'resource.json'), JSON.stringify({ schemaVersion: 2, ...skill, bodyFile: 'SKILL.md', keywords: [],
    requires: [{ kind: 'tool', name: 'save_invoice_candidate' }], files: [{ path: 'SKILL.md', bytes: skillBody.length },
      { path: 'references/note.md', bytes: supporting.length }] }));
  writeFileSync(join(skillDirectory, 'SKILL.md'), skillBody); writeFileSync(join(skillDirectory, 'references/note.md'), supporting);
  let resourceExport: CloudResourceExport | undefined;
  const local = need(await createApplication({ paths: paths(localRoot), resourceRoot: localResourceRoot,
    onCloudMaterialReady: value => { localExport = value; }, onCloudResourceReady: value => { resourceExport = value; } }));
  if (!localExport) throw Error('Local material owner was not assembled.');
  if (!resourceExport) throw Error('Local resource owner was not assembled.');
  const source = 'Controlled invoice total 113.00';
  const document = need(await local.importPreparedInvoiceMaterial({ contract: 'flowmate-prepared-invoice/v1', sample: 'cloud-e2e', sourceText: source,
    original: { name: 'source.md', base64: Buffer.from(source).toString('base64') },
    pages: [{ page: 1, blocks: [{ id: 'b1', kind: 'text', text: source, sourceIndex: 0, sourceType: 'prepared-text', bbox: null }] }] }));
  const stdin = new PassThrough(), stdout = new PassThrough(), stderr = new PassThrough();
  const child = Object.assign(new EventEmitter(), { stdin, stdout, stderr, kill: () => { stdin.end(); return true; } });
  const bridgeAbort = new AbortController();
  const bridge = runCloudDesktopBridge(stdin, stdout, envelope => callCloudUnixRpc(desktopSocket, envelope,
    AbortSignal.any([bridgeAbort.signal, AbortSignal.timeout(envelope.command.type === 'cloud_progress_wait' ? 90_000 : 30_000)])));
  bridge.then(() => child.emit('close', 0, null));
  const desktop = new CloudSshSession(child as unknown as ChildProcessWithoutNullStreams, workspaceId);
  let originalSession = 0, originalAttempt = 0, failure: unknown;
  try {
    const material = need(await uploadCloudMaterial({ workspaceId, documentRef: document.documentRef }, localExport, desktop));
    const resource = need(await uploadCloudResource({ workspaceId, ref }, resourceExport, desktop));
    expect(resource.ref).toEqual(ref);
    expect(readFileSync(join(authorityRoot, 'data/cloud-resources/prompts/cloud-controlled/v1/resource.json')).equals(manifestBytes)).toBe(true);
    expect(readFileSync(join(authorityRoot, 'data/cloud-resources/prompts/cloud-controlled/v1/prompt.md')).equals(prompt)).toBe(true);
    cloudDocumentId = material.cloudDocumentRef.id;
    cloudDocumentVersion = material.cloudDocumentRef.version;
    cloudParsedArtifactId = need(await authority.queryDocument(cloudDocumentId)).parsedArtifactId;
    const originalAgent = PersonalAgentSnapshotSchema.parse(need(await desktop.request({ type: 'personal_agent_get', input: {} })));
    const updated = { personalAgentId: originalAgent.personalAgentId, expectedRevision: originalAgent.revision,
      configuration: { ...originalAgent.configuration, resources: { prompt: ref, enabledSkills: [skill] } } };
    expect(await desktop.request({ type: 'personal_agent_update', input: updated })).toMatchObject({ ok: false });
    expect(need(await uploadCloudResource({ workspaceId, ref: skill }, resourceExport, desktop)).ref).toEqual(skill);
    expect(readFileSync(join(authorityRoot, 'data/cloud-resources/skills/cloud-audit/v1/references/note.md')).equals(supporting)).toBe(true);
    expect(await desktop.request({ type: 'personal_agent_update', input: { ...updated,
      configuration: { ...updated.configuration, tools: [] } } })).toMatchObject({ ok: false });
    const agent = PersonalAgentSnapshotSchema.parse(need(await desktop.request({ type: 'personal_agent_update', input: {
      personalAgentId: originalAgent.personalAgentId, expectedRevision: originalAgent.revision,
      configuration: updated.configuration } })));
    const created = InvoiceWorkCreateReceiptSchema.parse(need(await desktop.request({ type: 'invoice_work_create', input: {
      personalAgentId: agent.personalAgentId, expectedAgentRevision: agent.revision, requestId: 'original-cloud-work',
      goal: 'Review the original controlled invoice.', documents: [material.cloudDocumentRef] } })));
    const attemptId = created.execution.attempt?.attemptId; if (!attemptId) throw Error(`Cloud Work was not admitted: ${JSON.stringify(created.execution)}`);
    originalSession = created.sessionId; originalAttempt = attemptId;
    try { await waitFor(async () => wire.length > 0, 10_000); }
    catch { throw Error(JSON.stringify({ errors, runtimeError, created, observed: await desktop.request({ type: 'personal_task_get', input: {
      workId: created.workId, attemptId, limit: 10 } }) })); }
    const queueOwner = { workId: created.workId, sessionId: created.sessionId, attemptId };
    const progressOwner = { workId: created.workId, sessionId: created.sessionId };
    const firstProgress = CloudProgressEventSchema.parse(need(await desktop.request({ type: 'cloud_progress_wait', input: { ...progressOwner, cursor: null } })));
    expect(firstProgress.resync).toBe(true);
    expect(await desktop.request({ type: 'cloud_progress_wait', input: { ...progressOwner, sessionId: created.sessionId + 100, cursor: null } })).toMatchObject({ ok: false });
    const queue = CloudQueueViewSchema.parse(need(await desktop.request({ type: 'cloud_queue_read', input: queueOwner })));
    if (!queue.activePhaseRequestId) throw Error('The active original invoice phase is unavailable.');
    const steer = { ...queueOwner, controlRequestId: 'cloud-e2e-steer', expectedVersion: queue.version,
      action: { kind: 'enqueue' as const, phaseRequestId: queue.activePhaseRequestId, mode: 'steer' as const, content: steerText } };
    const steerReceipt = CloudQueueReceiptSchema.parse(need(await desktop.request({ type: 'cloud_queue_control', input: steer })));
    expect(steerReceipt).toMatchObject({ status: 'applied', submissionId: expect.any(Number) });
    expect(need(await desktop.request({ type: 'cloud_queue_control', input: steer }))).toEqual(steerReceipt);
    const followup = { ...queueOwner, controlRequestId: 'cloud-e2e-followup', expectedVersion: steerReceipt.version,
      action: { kind: 'enqueue' as const, phaseRequestId: queue.activePhaseRequestId, mode: 'followUp' as const, content: followupText } };
    expect(need(await desktop.request({ type: 'cloud_queue_control', input: followup }))).toMatchObject({ status: 'applied', submissionId: expect.any(Number) });
    const runtimeClient = createCloudRuntimeRpcClient(runtimeSocket);
    try { expect(await runtimeClient.resumeAttempt(queueOwner)).toEqual({ ok: true, data: undefined }); }
    finally { need(await runtimeClient.close()); }
    const nextProgress = desktop.request({ type: 'cloud_progress_wait', input: { ...progressOwner, cursor: firstProgress.cursor } }, 45_000);
    release.resolve();
    if (process.env.FLOWMATE_CLOUD_TEST_KILL_AFTER_503 === '1') {
      await new Promise(resolve => setTimeout(resolve, 500)); expect(wire).toHaveLength(1);
      runtime.kill('SIGKILL'); expect(await exited).toMatchObject({ signal: 'SIGKILL' });
      await new Promise(resolve => setTimeout(resolve, 20_000));
      launched = launchRuntime(); runtime = launched.child; exited = launched.exited;
      await waitFor(async () => { if (runtime.exitCode !== null) throw Error(`Runtime recovery failed: ${runtimeError}`);
        return (await callCloudUnixRpc(runtimeSocket, { version: 1, method: 'unknown', input: {} })).ok; }, 10_000);
    }
    const changed = CloudProgressEventSchema.parse(need(await nextProgress));
    expect(changed).toMatchObject({ ...progressOwner, changed: true, observationRevision: expect.any(Number) });
    let live = changed, streamed = live.fragments.map(fragment => fragment.text).join('');
    for (let index = 0; index < 10 && !streamed.includes('original invoice needs human review'); index++) {
      live = CloudProgressEventSchema.parse(need(await desktop.request({ type: 'cloud_progress_wait', input: { ...progressOwner, cursor: live.cursor } }, 12_000)));
      if (live.resync) streamed = ''; else streamed += live.fragments.map(fragment => fragment.text).join('');
    }
    expect(streamed).toContain('original invoice needs human review');
    expect(live.fragments.every(fragment => fragment.attemptId === attemptId && fragment.requestId === queue.activePhaseRequestId)).toBe(true);
    const status = CloudRuntimeStatusSchema.parse(need(await desktop.request({ type: 'cloud_delivery_status', input: { ...queueOwner, limit: 10 } })));
    expect(status.observationRevision).toBeGreaterThan(0);
    expect(status.native.conversationId).toBeGreaterThan(0);
    expect(status.native.tasks.length).toBeGreaterThan(0); expect(status.native.submissions.length).toBeGreaterThan(0);
    const work = InvoiceWorkGetResultSchema.parse(need(await desktop.request({ type: 'invoice_work_get', input: { view: 'work', workId: created.workId, limit: 10 } })));
    if (work.view !== 'work' || !work.items[0]) throw Error('The uploaded cloud invoice item is unavailable.');
    const page = need(await desktop.request({ type: 'cloud_review_page', input: { workId: created.workId, itemId: work.items[0].itemId,
      documentRef: material.cloudDocumentRef, page: 1, afterBlockId: null, limit: 10 } }));
    expect(page).toMatchObject({ workId: created.workId, itemId: work.items[0].itemId, page: {
      documentRef: material.cloudDocumentRef, blocks: [{ id: 'b1', text: source, source: { version: material.cloudDocumentRef.version } }] } });
    let task: ReturnType<typeof PersonalTaskGetResultSchema.parse> | undefined;
    await waitFor(async () => {
      const value = await desktop.request({ type: 'personal_task_get', input: { workId: created.workId, attemptId, limit: 10 } });
      if (!value.ok) return false;
      task = PersonalTaskGetResultSchema.parse(value.data); return task.task.stoppedAt !== null;
    }, 20_000);
    expect(task?.task.runStatus).toBe('completed');
    const finished = InvoiceWorkGetResultSchema.parse(need(await desktop.request({ type: 'invoice_work_get', input: { view: 'work', workId: created.workId, limit: 10 } })));
    if (finished.view !== 'work' || !finished.items[0]?.jobId || !finished.items[0].candidateRef) throw Error('The original candidate was not saved.');
    const selected = finished.items[0], target = { workId: created.workId, itemId: selected.itemId, documentRef: selected.documentRef };
    const candidate = CloudReviewCandidateReceiptSchema.parse(need(await desktop.request({ type: 'cloud_review_candidate', input: {
      ...target, jobId: selected.jobId!, candidateId: selected.candidateRef!.id } })));
    expect(candidate.detail.candidate.fields.totalAmount.normalized).toBe('113.00');
    const opened = CloudReviewOpenReceiptSchema.parse(need(await desktop.request({ type: 'cloud_review_open', input: {
      ...target, jobId: selected.jobId!, candidateId: selected.candidateRef!.id } })));
    const acceptRequest = { operationRef: 'cloud-e2e-accept', jobId: opened.jobId, expectedCandidateId: opened.candidateId,
      candidateId: opened.candidateId, expectedRevision: opened.workspaceRevision, dirty: false as const };
    const accepted = need(await desktop.request({ type: 'cloud_review_accept', input: { ...target, request: acceptRequest } }));
    expect(accepted).toMatchObject({ candidateId: opened.candidateId, sequence: opened.sequence, status: 'accepted' });
    expect(need(await desktop.request({ type: 'cloud_review_query_accept', input: { ...target, request: acceptRequest } }))).toEqual(accepted);
    expect(need(await desktop.request({ type: 'invoice_work_dispose_item', input: { workId: created.workId, itemId: selected.itemId,
      requestId: 'cloud-e2e-attach', expectedRevision: finished.work.revision,
      decision: { kind: 'accepted', candidateRef: { id: opened.candidateId, sequence: opened.sequence }, acceptRequest } } })))
      .toMatchObject({ disposition: 'accepted' });
    expect(wire).toEqual(Array.from({ length: 4 }, () => ({ url: 'https://api.deepseek.com/chat/completions', authorization: 'Bearer synthetic-key' })));
    expect(payloads.some(value => value.includes(steerText))).toBe(true);
    expect(payloads.some(value => value.includes(followupText))).toBe(true);
    const contexts = payloads.map(value => {
      const body = JSON.parse(value) as { messages: Array<{ role: string; content: string }> };
      return JSON.parse(body.messages.find(message => message.role === 'user')!.content);
    });
    expect(contexts[0].queueInstructions).toBeUndefined();
    expect(contexts[1].queueInstructions).toBeUndefined();
    expect(contexts[2].queueInstructions).toMatchObject([{ provenance: 'user-provided', controlRequestId: steer.controlRequestId, content: steerText }]);
    expect(contexts[3].queueInstructions).toMatchObject([{ controlRequestId: steer.controlRequestId, content: steerText },
      { controlRequestId: followup.controlRequestId, content: followupText }]);
    expect(contexts.every(value => value.item.documentRef.id === material.cloudDocumentRef.id
      && value.item.documentRef.version === material.cloudDocumentRef.version
      && JSON.stringify(value.actions.tools) === JSON.stringify(contexts[0].actions.tools))).toBe(true);
    expect(promptSeen).toBe(true); expect(skillSeen).toBe(true);
    if (process.env.FLOWMATE_CLOUD_TEST_KILL_AFTER_503 === '1') expect(errors.every(code => code === 'cloud_transport_result_unknown')).toBe(true);
    else expect(errors).toEqual([]);
  } catch (error) { failure = error; throw error; } finally {
    release.resolve();
    if (failure) bridgeAbort.abort();
    const desktopClosed = await desktop.close(), bridgeClosed = await bridge;
    if (!failure) { expect(desktopClosed).toMatchObject({ ok: true }); expect(bridgeClosed).toMatchObject({ ok: true }); }
    runtime.kill('SIGTERM');
    const stopped = await Promise.race([exited, new Promise(resolve => setTimeout(() => resolve({ code: null, signal: 'timeout' }), 10_000))]);
    if (!failure) expect(stopped).toEqual({ code: 0, signal: null });
    const authorityClosed = await authority.close(), localClosed = await local.close();
    if (!failure) { expect(authorityClosed).toMatchObject({ ok: true, data: { closed: true } }); expect(localClosed).toMatchObject({ ok: true, data: { closed: true } }); }
  }
  const product = new Database(join(authorityRoot, 'data/app.sqlite'), { readonly: true });
  const row = product.query<{ durable_runtime_id: string }, [number]>('SELECT durable_runtime_id FROM sessions WHERE id=?').get(originalSession);
  const modelAttempts = product.query<{ native_task_id: number; transport_ordinal: number; http_status: number }, []>(
    'SELECT native_task_id,transport_ordinal,http_status FROM cloud_model_attempts ORDER BY rowid').all();
  expect(modelAttempts.map(value => [value.transport_ordinal, value.http_status])).toEqual([[0, 503], [1, 200], [0, 200], [0, 200]]);
  expect(modelAttempts[0]!.native_task_id).toBe(modelAttempts[1]!.native_task_id);
  product.close(); if (!row) throw Error('The original cloud Session is missing.');
  const native = new Database(join(runtimeRoot, 'sessions', row.durable_runtime_id, 'runtime.sqlite'), { readonly: true });
  try { expect(native.query('SELECT attempt_id FROM flowmate_cloud_wake WHERE singleton=1').get()).toEqual({ attempt_id: originalAttempt }); }
  finally { native.close(); }
}, 90_000);
