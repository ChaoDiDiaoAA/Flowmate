import { _electron as electron } from 'playwright';
import { expect, test } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { ServiceClient } from '../../apps/desktop/main/service-client.ts';
import { ServiceInstallationSchema } from '../../packages/shared/src/service-layout.ts';
import { CandidateDraftSchema, HostDiagnosticsSchema, InvoiceWorkWorkingContextSchema, PersonalHistoryPageSchema, type DocumentSnapshot, type ProductSettings, type Result } from '@flowmate/contracts';
import * as P from '../../packages/contracts/src/personal-agent.ts';
import { closeDesktopFixture, createHttpProvider } from '../support/resources.ts';
import { createSystemCommitFault, type ChildTerminalFaultIdentity, type CommitFaultIdentity, type CommitFaultMode } from './service-commit-fault-fixture.ts';

test.describe.configure({ mode: 'serial' });

const repository = resolve(import.meta.dirname, '../..');
function need<T>(value: Result<T>): T { if (!value.ok) throw Error(value.error.code); return value.data; }
function environment() {
  const env: Record<string, string> = {};
  for (const key of ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'COMSPEC', 'PATHEXT', 'TEMP', 'TMP',
    'WINDIR', 'USERPROFILE', 'HOME', 'LOCALAPPDATA', 'APPDATA']) if (process.env[key]) env[key] = process.env[key]!;
  return env;
}
function originalTestInstallation() {
  if (process.env.FLOWMATE_WINDOWS_SERVICE_AUTHORIZED !== '1') throw Error('windows_service_acceptance_unrun_authorization');
  const root = process.env.FLOWMATE_WINDOWS_SERVICE_ACCEPTANCE_ROOT;
  const file = process.env.FLOWMATE_WINDOWS_SERVICE_INSTALLATION_FILE;
  if (!root || resolve(root) !== root || dirname(root) !== realpathSync(tmpdir())
    || !basename(root).startsWith('flowmate-service-acceptance-') || lstatSync(root).isSymbolicLink() || realpathSync(root) !== root
    || file !== join(root, 'data/service-installation.json') || lstatSync(file).isSymbolicLink() || realpathSync(file) !== file)
    throw Error('windows_service_acceptance_unrun_identity');
  const installation = ServiceInstallationSchema.parse(JSON.parse(readFileSync(file, 'utf8')));
  if (installation.ownerSid !== process.env.FLOWMATE_WINDOWS_SERVICE_ACCEPTANCE_SID
    || installation.dataRoot !== join(root, 'data') || installation.runtimeRoot !== join(root, 'resources/flowmate-runtime'))
    throw Error('windows_service_acceptance_unrun_identity');
  return { root, file, installation };
}

test('the original Windows service owns Session 0, survives desktop exit and resumes the same interrupted Work', async () => {
  const target = originalTestInstallation(), saved = target.installation;
  const bun = join(saved.runtimeRoot, 'bin/bun.exe'), manager = join(saved.runtimeRoot, 'apps/service-manager.js');
  const client = new ServiceClient();
  let app: Awaited<ReturnType<typeof electron.launch>> | null = null, failure: Error | undefined, requests = 0, release = () => {};
  type ModelBody = { model: string; messages: Array<{ role: string; content: string }> };
  type Reply = { text: string; tool?: { name: string; arguments: unknown } };
  let scenario: ((body: ModelBody) => Promise<Reply>) | null = null, releaseScenario = () => {};
  const provider = await createHttpProvider(async request => {
    expect(request.headers.get('authorization')).toBe('Bearer windows-service-synthetic-key');
    const body = await request.json() as ModelBody; requests++;
    if (scenario) {
      const sequence = requests, value = await scenario(body);
      const delta = value.tool ? { role: 'assistant', content: value.text, tool_calls: [{ index: 0,
        id: 'windows-service-scenario-call-' + sequence, type: 'function',
        function: { name: value.tool.name, arguments: JSON.stringify(value.tool.arguments) } }] } : { role: 'assistant', content: value.text };
      return new Response('data: ' + JSON.stringify({ id: 'windows-service-scenario-response-' + sequence,
        object: 'chat.completion.chunk', created: 1, model: body.model,
        choices: [{ index: 0, delta, finish_reason: value.tool ? 'tool_calls' : 'stop' }] })
        + '\n\ndata: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
    }
    await new Promise<void>(resolveHeld => { release = resolveHeld; request.signal.addEventListener('abort', () => resolveHeld(), { once: true }); });
    return new Response('data: ' + JSON.stringify({ id: 'windows-service-local', object: 'chat.completion.chunk', created: 1,
      model: 'windows-service-local', choices: [{ index: 0, delta: { role: 'assistant',
        content: 'The original invoice needs explicit human clarification.' }, finish_reason: 'stop' }] }) + '\n\ndata: [DONE]\n\n',
    { headers: { 'content-type': 'text/event-stream' } });
  });
  function manage(action: 'stop' | 'start') {
    const output = execFileSync(bun, ['--no-env-file', manager, action, '--installation-file', target.file],
      { cwd: saved.runtimeRoot, env: environment(), windowsHide: true, timeout: 90_000, maxBuffer: 65_536, encoding: 'utf8' });
    const packet = z.object({ version: z.literal(1), result: z.object({ ok: z.literal(true), data: z.object({
      installationId: z.literal(saved.installationId), serviceName: z.literal(saved.serviceName), action: z.literal(action),
      wrapperExitCode: z.literal(0), observedState: z.enum(['stopped', 'not-stopped']), controllerReleased: z.boolean().nullable(),
      productReadyVerified: z.literal(false), productStopVerified: z.literal(false),
    }).strict() }).strict() }).strict().parse(JSON.parse(output));
    expect(packet.result.data.observedState).toBe(action === 'stop' ? 'stopped' : 'not-stopped');
  }
  async function connect() {
    await expect.poll(async () => client.isConnected || (await client.connect(saved, 1500)).ok, { timeout: 30_000 }).toBe(true);
  }
  async function launch() {
    return electron.launch({ executablePath: join(repository, 'node_modules/electron/dist/electron.exe'),
      args: [join(repository, 'out/main/index.js')], env: { ...environment(), FLOWMATE_TEST_MODE: '1',
        FLOWMATE_TEST_USER_DATA_ROOT: saved.dataRoot }, timeout: 30_000 });
  }
  async function originalSessionZero() {
    const system = process.env.FLOWMATE_WINDOWS_SERVICE_SYSTEM_DIRECTORY;
    if (!system || !existsSync(join(system, 'WindowsPowerShell/v1.0/powershell.exe'))) throw Error('windows_service_session_probe_unavailable');
    const script = [
      '$ErrorActionPreference="Stop"; $ProgressPreference="SilentlyContinue"',
      '$svc=Get-CimInstance Win32_Service -Filter ("Name="+[char]39+$env:FLOWMATE_PROBE_SERVICE+[char]39)',
      'if($null -eq $svc -or $svc.ProcessId -le 0){throw "original_service_process_missing"}',
      '$name=$svc.StartName; if($name -eq "LocalSystem"){$name="NT AUTHORITY\\SYSTEM"}',
      '$sid=([System.Security.Principal.NTAccount]::new($name)).Translate([System.Security.Principal.SecurityIdentifier]).Value',
      '$wrapper=Get-Process -Id $svc.ProcessId -ErrorAction Stop',
      '$children=@(Get-CimInstance Win32_Process -Filter ("ParentProcessId="+$svc.ProcessId) | Where-Object { $_.ExecutablePath -eq $env:FLOWMATE_PROBE_BUN -and $_.CommandLine.Contains($env:FLOWMATE_PROBE_ENTRY) -and $_.CommandLine.Contains($env:FLOWMATE_PROBE_INSTALLATION)})',
      'if($children.Count -ne 1){throw "original_service_child_missing"}',
      '$child=Get-Process -Id $children[0].ProcessId -ErrorAction Stop',
      '[pscustomobject]@{ownerSid=$sid;wrapperSession=$wrapper.SessionId;childSession=$child.SessionId}|ConvertTo-Json -Compress',
    ].join('\n');
    const output = execFileSync(join(system, 'WindowsPowerShell/v1.0/powershell.exe'),
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], { env: { ...environment(),
        FLOWMATE_PROBE_SERVICE: saved.serviceName, FLOWMATE_PROBE_BUN: bun,
        FLOWMATE_PROBE_ENTRY: join(saved.runtimeRoot, 'apps/service.js'), FLOWMATE_PROBE_INSTALLATION: target.file },
        windowsHide: true, timeout: 15_000, maxBuffer: 65_536, encoding: 'utf8' });
    expect(JSON.parse(output)).toEqual({ ownerSid: saved.ownerSid, wrapperSession: 0, childSession: 0 });
  }
  try {
    app = await launch(); let page = await app.firstWindow();
    expect(need(await page.evaluate(() => window.flowmate.getState())).backgroundService?.state).toBe('disabled');
    need(await page.evaluate(async baseUrl => { const current = await window.flowmate.getState(); if (!current.ok) return current;
      return window.flowmate.saveSettings({ ...current.data.settings, models: [{ id: 'windows-service-local',
        name: 'Windows service local', credentialRef: 'windows_service_original_ref', kind: 'custom', providerId: null,
        baseUrl, model: 'windows-service-local', api: 'openai-completions', contextWindow: 64000, maxTokens: 8192,
        reasoning: false }], defaultModelId: 'windows-service-local' }, { modelId: 'windows-service-local',
        apiKey: 'windows-service-synthetic-key' }); }, 'http://127.0.0.1:' + provider.port + '/v1'));
    need(await page.evaluate(() => window.flowmate.backgroundService.prepare({})));
    const current = need(await page.evaluate(() => window.flowmate.getState()));
    const activated = need(await page.evaluate(input => window.flowmate.backgroundService.enable(input),
      { installationId: saved.installationId, operationId: crypto.randomUUID(), expectedSettingsRevision: current.settings.revision }));
    expect(activated).toMatchObject({ active: true, credentialsPublished: true, enabled: true, error: null });
    await connect(); await originalSessionZero(); expect(requests).toBe(0);
    const document = need(await client.request({ type: 'import_prepared_invoice_material', input: {
      contract: 'flowmate-prepared-invoice/v1', sample: 'windows-service-controlled', sourceText: 'Total 113.00',
      original: { name: 'source.md', base64: Buffer.from('Total 113.00').toString('base64') },
      pages: [{ page: 1, blocks: [{ id: 'b1', kind: 'text', text: 'Total 113.00', sourceIndex: 0,
        sourceType: 'prepared-text', bbox: null }] }],
    } }) as Result<DocumentSnapshot>);
    const original = need(await page.evaluate(() => window.flowmate.personalAgent.get()));
    need(await page.evaluate(input => window.flowmate.personalAgent.update(input), { personalAgentId: original.personalAgentId,
      expectedRevision: original.revision, configuration: { ...original.configuration, modelId: 'windows-service-local',
        tools: ['read_invoice_document'], resources: { prompt: null, enabledSkills: [] } } }));
    const agent = need(await page.evaluate(() => window.flowmate.personalAgent.get()));
    const request = { personalAgentId: agent.personalAgentId, expectedAgentRevision: agent.revision,
      requestId: 'windows-service-original-create', goal: 'Retain the original invoice until explicit human disposition.',
      documents: [document.documentRef] };
    const created = need(await page.evaluate(input => window.flowmate.invoiceWorks.create(input), request));
    await expect.poll(() => requests).toBe(1);
    await closeDesktopFixture(app, saved.dataRoot); app = null;
    await originalSessionZero(); expect(requests).toBe(1);
    release();
    await expect.poll(async () => {
      const tasks = await client.request({ type: 'personal_task_list', input: { workId: created.workId, limit: 10 } }) as Result<{
        items: Array<{ runStatus: string | null; stoppedAt: string | null }> }>;
      return tasks.ok && tasks.data.items.some(task => task.runStatus === 'completed' && task.stoppedAt !== null);
    }, { timeout: 30_000 }).toBe(true);
    const beforeRestart = need(await client.request({ type: 'invoice_work_query_operation', input: { operation: 'create',
      personalAgentId: agent.personalAgentId, requestId: request.requestId } }) as Result<typeof created | null>);
    expect(beforeRestart).toEqual(created);
    const interruptedRequest = { ...request, requestId: 'windows-service-original-interrupted' };
    const interrupted = need(await client.request({ type: 'invoice_work_create', input: interruptedRequest }) as Result<typeof created>);
    await expect.poll(() => requests).toBe(2);
    const attempt = interrupted.execution.attempt; expect(attempt).not.toBeNull();
    manage('stop'); client.disconnect();
    manage('start'); await connect(); await originalSessionZero();
    await expect.poll(() => requests).toBe(3); release();
    await expect.poll(async () => {
      const tasks = await client.request({ type: 'personal_task_list', input: { workId: interrupted.workId, limit: 10 } }) as Result<{
        items: Array<{ attempt: { attemptId: number }; runStatus: string | null; stoppedAt: string | null }> }>;
      return tasks.ok && tasks.data.items.some(task => task.attempt.attemptId === attempt?.attemptId
        && task.runStatus === 'completed' && task.stoppedAt !== null);
    }, { timeout: 30_000 }).toBe(true);
    app = await launch(); page = await app.firstWindow();
    expect(need(await page.evaluate(input => window.flowmate.invoiceWorks.queryOperation(input),
      { operation: 'create' as const, personalAgentId: agent.personalAgentId, requestId: request.requestId }))).toEqual(beforeRestart);
    expect(need(await page.evaluate(input => window.flowmate.invoiceWorks.queryOperation(input),
      { operation: 'create' as const, personalAgentId: agent.personalAgentId, requestId: interruptedRequest.requestId }))).toEqual(interrupted);
    expect(requests).toBe(3);
    await closeDesktopFixture(app, saved.dataRoot); app = null;

    async function rpc<T>(command: Parameters<ServiceClient['request']>[0]): Promise<T> {
      return need(await client.request(command) as Result<T>);
    }
    const selected = await rpc<{ settings: ProductSettings }>({ type: 'get_state' });
    const profile = selected.settings.models.find(model => model.id === 'windows-service-local');
    if (!profile) throw Error('The original controlled service model is unavailable.');
    need(await client.saveServiceSettings({ installationId: saved.installationId, operationId: crypto.randomUUID(), settings: {
      ...selected.settings, models: [...selected.settings.models, { ...profile, id: 'windows-service-missing',
        name: 'Controlled missing service key', credentialRef: 'windows_service_missing_original_ref' }],
    } }));
    async function useModel(modelId: string, tools: string[]) {
      const current = P.PersonalAgentSnapshotSchema.parse(await rpc({ type: 'personal_agent_get', input: {} }));
      return P.PersonalAgentSnapshotSchema.parse(await rpc({ type: 'personal_agent_update', input: {
        personalAgentId: current.personalAgentId, expectedRevision: current.revision,
        configuration: { ...current.configuration, modelId, tools, resources: { prompt: null, enabledSkills: [] },
          extensions: { enabledExtensions: [] }, preferences: '' },
      } }));
    }
    async function createWork(requestId: string, goal: string) {
      const current = P.PersonalAgentSnapshotSchema.parse(await rpc({ type: 'personal_agent_get', input: {} }));
      return P.InvoiceWorkCreateReceiptSchema.parse(await rpc({ type: 'invoice_work_create', input: {
        personalAgentId: current.personalAgentId, expectedAgentRevision: current.revision, requestId, goal, documents: [document.documentRef],
      } }));
    }
    function identity(receipt: P.InvoiceWorkCreateReceipt) {
      if (!('attempt' in receipt.execution) || !receipt.execution.attempt) throw Error('The original service attempt is unavailable.');
      return { workId: receipt.workId, attemptId: receipt.execution.attempt.attemptId };
    }
    async function task(receipt: P.InvoiceWorkCreateReceipt) {
      return P.PersonalTaskGetResultSchema.parse(await rpc({ type: 'personal_task_get', input: { ...identity(receipt), limit: 20 } }));
    }
    async function work(receipt: P.InvoiceWorkCreateReceipt) {
      const value = P.InvoiceWorkGetResultSchema.parse(await rpc({ type: 'invoice_work_get', input: {
        view: 'work', workId: receipt.workId, limit: 20,
      } }));
      if (value.view !== 'work') throw Error('Expected the original service Work view.'); return value;
    }
    async function finished(receipt: P.InvoiceWorkCreateReceipt) {
      await expect.poll(async () => (await task(receipt)).task.stoppedAt !== null, { timeout: 30_000 }).toBe(true);
      return task(receipt);
    }
    async function originalReceipt(receipt: P.InvoiceWorkCreateReceipt) {
      return rpc({ type: 'invoice_work_query_operation', input: { operation: 'create',
        personalAgentId: receipt.personalAgentId, requestId: receipt.requestId } });
    }
    async function restart() {
      manage('stop'); client.disconnect();
      manage('start'); await connect(); await originalSessionZero();
    }
    const context = (body: ModelBody) => InvoiceWorkWorkingContextSchema.parse(
      JSON.parse(body.messages.filter(message => message.role === 'user').at(-1)!.content));

    await test.step('queued Work survives the original service restart and receives its first native admission from the same receipt', async () => {
      await useModel('windows-service-local', ['read_invoice_document']);
      const held = Promise.withResolvers<void>(); releaseScenario = () => held.resolve();
      scenario = async body => {
        if (context(body).work.goal === 'C09 retained active root') await held.promise;
        return { text: 'Retain the original invoice for explicit human review.' };
      };
      const before = requests;
      const active = await createWork('windows-service-queue-active', 'C09 retained active root');
      await expect.poll(() => requests).toBe(before + 1);
      const queued = await createWork('windows-service-original-queue', 'C09 first admission after an occupied root');
      expect(queued.execution).toMatchObject({ kind: 'queued', authorizationAccepted: true });
      const activeTask = await task(active), queuedTask = await task(queued);
      expect(queuedTask.task).toMatchObject({ queued: true, attempt: { runId: null, runtimeLinked: false } });
      const empty = await rpc<{ entries: unknown[] }>({ type: 'personal_task_history', input: { target: { workId: queued.workId }, limit: 100 } });
      expect(empty.entries).toEqual([]); expect(requests).toBe(before + 1);
      await restart();
      await expect.poll(() => requests).toBe(before + 2);
      for (let index = 0; index < 3; index++) {
        expect(await originalReceipt(active)).toEqual(active); expect(await originalReceipt(queued)).toEqual(queued);
        expect((await task(active)).task.attempt).toEqual(activeTask.task.attempt);
        expect((await task(queued)).task).toEqual(queuedTask.task);
      }
      expect(requests).toBe(before + 2);
      held.resolve(); await finished(active); const admitted = await finished(queued);
      expect(admitted.task.attempt.attemptId).toBe(queuedTask.task.attempt.attemptId);
      expect(admitted.task.attempt.runId).not.toBeNull(); expect(admitted.task.attempt.runtimeLinked).toBe(true);
      expect(await originalReceipt(queued)).toEqual(queued); expect(requests).toBe(before + 3);
      // This is first admission from a persisted queue, not a pause around native commit.
    });

    await test.step('real Master and child results, delivery and model consumption survive an original service restart without replacement identities', async () => {
      await useModel('windows-service-local', ['Agent', 'read_invoice_document']);
      const report = 'C09_CHILD_REPORT: original total 113.00 remains subject to human review.';
      scenario = async body => {
        const original = context(body), ordinal = body.messages.filter(message => message.role === 'tool').length;
        if (original.delegation) {
          if (ordinal === 0) return { text: '', tool: { name: 'read_invoice_document', arguments: {
            documentId: document.documentRef.id, page: 1, afterBlockId: null, limit: 10,
          } } };
          return { text: report };
        }
        if (ordinal === 0) return { text: '', tool: { name: 'Agent', arguments: { subagent_type: 'invoice-evidence-checker',
          run_in_background: false, description: 'Check the original controlled service invoice',
          prompt: 'Verify the original invoice total with read-only evidence and report uncertainty.' } } };
        expect(body.messages.some(message => message.role === 'tool' && message.content.includes(report))).toBe(true);
        return { text: 'The original child report is retained for explicit human review.' };
      };
      const before = requests, parent = await createWork('windows-service-parent-child', 'C09 retain original child evidence');
      const result = await finished(parent);
      expect(result.children).toHaveLength(1);
      const child = result.children[0]!;
      expect(child).toMatchObject({ runStatus: 'completed', resultRecorded: true, stopConfirmed: true,
        delivery: { state: 'message_observed' }, parentModelReceivedAt: expect.any(String) });
      const childRun = await rpc({ type: 'query_run', runId: child.childRunId });
      expect(childRun).toMatchObject({ runId: child.childRunId, kind: 'subagent', runtimeKind: 'durable',
        parentRunId: result.task.attempt.runId, originToolCallId: child.originToolCallId });
      const history = await rpc({ type: 'personal_task_history', input: { target: { workId: parent.workId, childRunId: child.childRunId }, limit: 100 } });
      const timeline = await rpc({ type: 'invoice_work_timeline', input: { workId: parent.workId, limit: 100 } });
      expect(requests).toBe(before + 4);
      await restart();
      expect(await task(parent)).toEqual(result); expect(await originalReceipt(parent)).toEqual(parent);
      expect(await rpc({ type: 'query_run', runId: child.childRunId })).toEqual(childRun);
      expect(await rpc({ type: 'personal_task_history', input: { target: { workId: parent.workId, childRunId: child.childRunId }, limit: 100 } })).toEqual(history);
      expect(await rpc({ type: 'invoice_work_timeline', input: { workId: parent.workId, limit: 100 } })).toEqual(timeline);
      expect((await work(parent)).work).toMatchObject({ status: 'open', counts: { accepted: 0, unresolved: 1 } });
      expect(requests).toBe(before + 4);
      // Completed child facts do not establish recovery from a child whose actual stop is unknown.
    });

    await test.step('one original service classifies mixed saved Work and resumes only the already authorized active and queued attempts', async () => {
      await useModel('windows-service-local', ['read_invoice_document', 'save_invoice_candidate']);
      let held = Promise.withResolvers<void>(); releaseScenario = () => held.resolve();
      scenario = async body => {
        const original = context(body), goal = original.work.goal;
        if (goal === 'C09 stopped original' || goal === 'C09 active original') await held.promise;
        if (goal === 'C09 human review' && body.messages.every(message => message.role !== 'tool')) {
          const missing = { raw: null, normalized: null, state: 'missing', alternatives: [], sources: [] };
          const candidate = CandidateDraftSchema.parse({ fields: {
            ...Object.fromEntries(['invoiceNumber', 'issueDate', 'sellerName', 'sellerTaxId', 'buyerName', 'buyerTaxId',
              'currency', 'netAmount', 'taxAmount'].map(name => [name, missing])),
            totalAmount: { raw: '113.00', normalized: '113.00', state: 'present', alternatives: [], sources: [{
              documentId: document.documentRef.id, version: document.documentRef.version,
              artifactId: document.parsedArtifactId, page: 1, blockId: 'b1', quote: '113.00',
            }] },
          }, lines: [], notes: [] });
          return { text: '', tool: { name: 'save_invoice_candidate', arguments: { documentId: document.documentRef.id, candidate } } };
        }
        return { text: 'The original invoice needs an explicit human decision.' };
      };
      const review = await createWork('windows-service-mixed-review', 'C09 human review'); await finished(review);
      expect((await work(review)).items[0]!.candidateRef).not.toBeNull();
      const stoppedBefore = requests, stopped = await createWork('windows-service-mixed-stopped', 'C09 stopped original');
      await expect.poll(() => requests).toBe(stoppedBefore + 1);
      await rpc({ type: 'personal_task_stop', input: { ...identity(stopped),
        expectedRevision: (await work(stopped)).work.revision, requestId: 'windows-service-mixed-stop' } });
      held.resolve(); await finished(stopped);
      const cancelled = await createWork('windows-service-mixed-cancelled', 'C09 cancelled original'); await finished(cancelled);
      await rpc({ type: 'invoice_work_cancel', input: { workId: cancelled.workId,
        expectedRevision: (await work(cancelled)).work.revision, requestId: 'windows-service-mixed-cancel' } });
      await useModel('windows-service-missing', ['read_invoice_document']);
      const blocked = await createWork('windows-service-mixed-blocked', 'C09 missing original credential');
      expect(blocked.execution).toMatchObject({ kind: 'blocked', authorizationAccepted: false, reason: { code: 'model_credential_missing' } });
      await useModel('windows-service-local', ['read_invoice_document', 'save_invoice_candidate']);
      held = Promise.withResolvers<void>();
      const activeBefore = requests, active = await createWork('windows-service-mixed-active', 'C09 active original');
      await expect.poll(() => requests).toBe(activeBefore + 1);
      const queued = await createWork('windows-service-mixed-queued', 'C09 queued original');
      expect(queued.execution).toMatchObject({ kind: 'queued', authorizationAccepted: true });
      const stable = await Promise.all([work(review), work(stopped), work(cancelled), work(blocked)]);
      const activeTask = await task(active), queuedTask = await task(queued), before = requests;
      await restart(); await expect.poll(() => requests).toBe(before + 1);
      for (let index = 0; index < 3; index++) {
        expect(await Promise.all([work(review), work(stopped), work(cancelled), work(blocked)])).toEqual(stable);
        expect((await task(active)).task.attempt).toEqual(activeTask.task.attempt);
        expect((await task(queued)).task).toEqual(queuedTask.task);
        expect(await originalReceipt(blocked)).toEqual(blocked);
      }
      expect(stable[0]!.work).toMatchObject({ status: 'open', execution: { requiresContinue: false, runStatus: 'completed' } });
      expect(stable[1]!.work).toMatchObject({ status: 'open', execution: { requiresContinue: true } });
      expect(stable[2]!.work.status).toBe('cancelled');
      expect(stable[3]!.work).toMatchObject({ status: 'open', execution: { attempt: null } });
      expect(requests).toBe(before + 1);
      held.resolve(); await finished(active); await finished(queued); expect(requests).toBe(before + 2);
    });
  } catch (cause) { failure = cause instanceof Error ? cause : new Error(String(cause)); }
  finally {
    release(); releaseScenario(); client.disconnect();
    try { if (app) await closeDesktopFixture(app, saved.dataRoot, failure); }
    finally { await provider.stop(); }
  }
  if (failure) throw failure;
});

for (const mode of ['native-input', 'phase-link'] as const satisfies readonly CommitFaultMode[]) {
  test(mode === 'native-input'
    ? 'the original Windows service recovers the saved phase after its first native input commit is rejected'
    : 'the original Windows service recovers the native input after its first product phase link is rejected', async () => {
    const target = originalTestInstallation(), saved = target.installation, client = new ServiceClient();
    expect(saved.enabled).toBe(true);
    const modelId = 'windows-service-commit-' + mode, goal = 'C09 original ' + mode + ' target';
    const held = Promise.withResolvers<void>();
    let releaseBlocker = false;
    const wires: Array<z.infer<typeof InvoiceWorkWorkingContextSchema>> = [];
    const provider = await createHttpProvider(async request => {
      expect(request.headers.get('authorization')).toBe('Bearer windows-service-commit-synthetic-key');
      const body = await request.json() as { model: string; messages: Array<{ role: string; content: string }> };
      expect(body.model).toBe(modelId);
      const context = InvoiceWorkWorkingContextSchema.parse(JSON.parse(body.messages.filter(message => message.role === 'user').at(-1)!.content));
      wires.push(context);
      if (context.work.goal !== goal && !releaseBlocker) await held.promise;
      return new Response('data: ' + JSON.stringify({ id: 'c09-commit-response-' + wires.length,
        object: 'chat.completion.chunk', created: 1, model: modelId, choices: [{ index: 0,
          delta: { role: 'assistant', content: 'This original invoice needs explicit human clarification.' }, finish_reason: 'stop' }] })
        + '\n\ndata: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
    });
    async function rpc<T>(command: Parameters<ServiceClient['request']>[0]): Promise<T> {
      return need(await client.request(command) as Result<T>);
    }
    function manage(action: 'start' | 'status') {
      const output = execFileSync(join(saved.runtimeRoot, 'bin/bun.exe'),
        ['--no-env-file', join(saved.runtimeRoot, 'apps/service-manager.js'), action, '--installation-file', target.file],
        { cwd: saved.runtimeRoot, env: environment(), windowsHide: true, timeout: 90_000, maxBuffer: 65_536, encoding: 'utf8' });
      const packet = z.object({ version: z.literal(1), result: z.object({ ok: z.literal(true), data: z.object({
        installationId: z.literal(saved.installationId), serviceName: z.literal(saved.serviceName), action: z.literal(action),
        wrapperExitCode: z.literal(0), observedState: z.enum(['stopped', 'not-stopped']), controllerReleased: z.null(),
        productReadyVerified: z.literal(false), productStopVerified: z.literal(false),
      }).strict() }).strict() }).strict().parse(JSON.parse(output));
      if (action === 'start') expect(packet.result.data.observedState).toBe('not-stopped');
      return packet.result.data;
    }
    async function connect() {
      await expect.poll(async () => client.isConnected || (await client.connect(saved, 1500)).ok, { timeout: 30_000 }).toBe(true);
    }
    async function start() { client.disconnect(); manage('start'); await connect(); }
    const task = async (identity: { workId: number; attemptId: number }) =>
      P.PersonalTaskGetResultSchema.parse(await rpc({ type: 'personal_task_get', input: { ...identity, limit: 20 } }));
    try {
      if (manage('status').observedState === 'stopped') manage('start');
      await connect();
      const state = await rpc<{ settings: ProductSettings }>({ type: 'get_state' });
      need(await client.saveServiceSettings({ installationId: saved.installationId, operationId: crypto.randomUUID(),
        settings: { ...state.settings, models: [...state.settings.models, { id: modelId, name: 'C09 exact commit ' + mode,
          credentialRef: 'windows_service_commit_' + mode.replace('-', '_'), kind: 'custom', providerId: null,
          baseUrl: 'http://127.0.0.1:' + provider.port + '/v1', model: modelId, api: 'openai-completions',
          contextWindow: 64000, maxTokens: 8192, reasoning: false }] },
        credentialUpdate: { modelId, apiKey: 'windows-service-commit-synthetic-key' } }));
      const before = P.PersonalAgentSnapshotSchema.parse(await rpc({ type: 'personal_agent_get', input: {} }));
      const agent = P.PersonalAgentSnapshotSchema.parse(await rpc({ type: 'personal_agent_update', input: {
        personalAgentId: before.personalAgentId, expectedRevision: before.revision, configuration: { ...before.configuration,
          modelId, tools: ['read_invoice_document'], resources: { prompt: null, enabledSkills: [] },
          extensions: { enabledExtensions: [] }, preferences: '' },
      } }));
      const document = await rpc<DocumentSnapshot>({ type: 'import_prepared_invoice_material', input: {
        contract: 'flowmate-prepared-invoice/v1', sample: 'windows-service-exact-commit-' + mode, sourceText: 'Total 113.00',
        original: { name: 'source.md', base64: Buffer.from('Total 113.00').toString('base64') },
        pages: [{ page: 1, blocks: [{ id: 'b1', kind: 'text', text: 'Total 113.00', sourceIndex: 0,
          sourceType: 'prepared-text', bbox: null }] }],
      } });
      async function create(requestId: string, workGoal: string) {
        return P.InvoiceWorkCreateReceiptSchema.parse(await rpc({ type: 'invoice_work_create', input: {
          personalAgentId: agent.personalAgentId, expectedAgentRevision: agent.revision, requestId, goal: workGoal,
          documents: [document.documentRef],
        } }));
      }
      const blocker = await create('c09-commit-' + mode + '-blocker', 'C09 controlled quota holder ' + mode);
      await expect.poll(() => wires.length, { timeout: 30_000 }).toBe(1);
      const created = await create('c09-commit-' + mode + '-target', goal);
      expect(created.execution).toMatchObject({ kind: 'queued', authorizationAccepted: true });
      if (!created.execution.attempt) throw Error('The queued original commit-fault attempt is unavailable.');
      const work = P.InvoiceWorkGetResultSchema.parse(await rpc({ type: 'invoice_work_get',
        input: { view: 'work', workId: created.workId, limit: 20 } }));
      if (work.view !== 'work' || work.items.length !== 1) throw Error('Expected the original single-item Work.');
      const identity: CommitFaultIdentity = { workId: created.workId, sessionId: created.sessionId,
        attemptId: created.execution.attempt.attemptId, itemId: work.items[0]!.itemId, createRequestId: created.requestId };
      const fault = createSystemCommitFault(mode);
      const armed = fault.arm(identity);
      expect(armed).toMatchObject({ triggerPresent: true, controllerReleased: true, phases: [], contexts: [],
        nativeInputs: [], inputEntries: [], bindings: [], receipt: created, attemptCount: 1, createCount: 1,
        sessionConversationId: null, runId: null, stopRequestedAt: null, stoppedAt: null });
      releaseBlocker = true; held.resolve();
      await start();
      // The trigger fixes the exact commit boundary; this poll observes its structured failure, not a timing window.
      await expect.poll(async () => HostDiagnosticsSchema.parse(await rpc({ type: 'query_diagnostics' })).entries.some(entry =>
        entry.component === 'personal_agent' && entry.event === 'coordination_failed'
        && entry.code === (mode === 'native-input' ? 'durable_runtime_failed' : 'storage_write_failed')),
      { timeout: 30_000 }).toBe(true);
      const gap = fault.inspect(identity);
      expect(gap).toMatchObject({ triggerPresent: true, controllerReleased: true, receipt: created,
        attemptCount: 1, createCount: 1, sessionConversationId: null, stopRequestedAt: null, stoppedAt: null });
      expect(gap.runId).not.toBeNull();
      expect(gap.phases).toHaveLength(1); expect(gap.contexts).toHaveLength(1); expect(gap.bindings).toHaveLength(1);
      const phase = gap.phases[0]!, context = gap.contexts[0]!, binding = gap.bindings[0]!;
      const originalKey = JSON.stringify([identity.attemptId, phase.request_id]);
      expect(phase).toMatchObject({ native_conversation_id: null, native_submission_id: null, closed_at: null });
      expect(context.phase_id).toBe(phase.id);
      expect(InvoiceWorkWorkingContextSchema.parse(JSON.parse(context.context_json))).toMatchObject({
        work: { workId: identity.workId, sessionId: identity.sessionId },
        phase: { phaseId: phase.id, attemptId: identity.attemptId, requestId: phase.request_id, basis: JSON.parse(phase.basis_json) },
        item: { itemId: identity.itemId },
      });
      expect(binding.request_key).toBe(originalKey);
      expect(gap.nativeInputs).toHaveLength(mode === 'native-input' ? 0 : 1);
      if (mode === 'native-input') {
        expect(gap.inputEntries).toHaveLength(0);
        expect(wires.filter(value => value.work.workId === identity.workId)).toHaveLength(0);
      } else {
        const native = gap.nativeInputs[0]!;
        expect(native.conversation_id).toBe(binding.conversation_id);
        expect(JSON.parse(native.request_id)).toBe(originalKey);
        expect(JSON.parse(native.record)).toMatchObject({ type: 'input', requestId: originalKey,
          conversationId: binding.conversation_id });
      }
      // Clearing is deliberately outside finally: unconfirmed stop/lease/facts preserve the exact fault for inspection.
      expect(fault.clear(identity)).toMatchObject({ triggerPresent: false, controllerReleased: true });
      await start();
      await expect.poll(async () => (await task(identity)).task.stoppedAt, { timeout: 30_000 }).not.toBeNull();
      const recoveredTask = (await task(identity)).task;
      expect(recoveredTask).toMatchObject({ attempt: { attemptId: identity.attemptId, runId: gap.runId },
        runStatus: 'completed', stopRequestedAt: null });
      expect(await rpc({ type: 'invoice_work_query_operation', input: { operation: 'create',
        personalAgentId: created.personalAgentId, requestId: created.requestId } })).toEqual(created);
      const recovered = fault.inspect(identity);
      expect(recovered).toMatchObject({ triggerPresent: false, controllerReleased: true, receipt: created,
        attemptCount: 1, createCount: 1, runId: gap.runId, stopRequestedAt: null, stoppedAt: recoveredTask.stoppedAt });
      expect(recovered.phases).toHaveLength(1); expect(recovered.contexts).toEqual(gap.contexts);
      expect(recovered.phases[0]).toMatchObject({ id: phase.id, request_id: phase.request_id, basis_json: phase.basis_json,
        native_conversation_id: binding.conversation_id });
      expect(recovered.phases[0]!.closed_at).not.toBeNull();
      expect(recovered.nativeInputs).toHaveLength(1); expect(recovered.inputEntries).toHaveLength(1);
      const native = recovered.nativeInputs[0]!;
      expect(native.conversation_id).toBe(binding.conversation_id);
      expect(JSON.parse(native.request_id)).toBe(originalKey);
      expect(recovered.phases[0]!.native_submission_id).toBe(native.id);
      expect(recovered.sessionConversationId).toBe(binding.conversation_id);
      if (mode === 'phase-link') expect(native.id).toBe(gap.nativeInputs[0]!.id);
      expect(JSON.parse(recovered.inputEntries[0]!.binding_json)).toMatchObject({ workId: identity.workId,
        sessionId: identity.sessionId, attemptId: identity.attemptId, requestId: phase.request_id });
      const { instructions: _instructions, ...originalContext } = JSON.parse(context.context_json);
      const delivered = wires.filter(value => value.work.workId === identity.workId);
      expect(delivered.length).toBeGreaterThan(0);
      for (const value of delivered) expect(value).toEqual(originalContext);
      expect(blocker.workId).not.toBe(created.workId);
    } finally {
      releaseBlocker = true; held.resolve(); client.disconnect(); await provider.stop();
    }
  });
}

type BoundaryBody = { model: string; messages: Array<{ role: string; content: string }> };
type BoundaryContext = z.infer<typeof InvoiceWorkWorkingContextSchema>;
type BoundaryReply = { text: string; tool?: { name: string; arguments: unknown } };
async function controlledCommitBoundary(mode: 'child-terminal' | 'candidate-feedback', tools: string[],
  respond: (body: BoundaryBody, context: BoundaryContext) => Promise<BoundaryReply>) {
  const target = originalTestInstallation(), saved = target.installation, client = new ServiceClient();
  expect(saved.enabled).toBe(true);
  const modelId = 'windows-service-' + mode, wires: BoundaryContext[] = [];
  const provider = await createHttpProvider(async request => {
    expect(request.headers.get('authorization')).toBe('Bearer windows-service-boundary-synthetic-key');
    const body = await request.json() as BoundaryBody;
    expect(body.model).toBe(modelId);
    const context = InvoiceWorkWorkingContextSchema.parse(JSON.parse(body.messages.filter(message => message.role === 'user').at(-1)!.content));
    wires.push(context);
    const reply = await respond(body, context), sequence = wires.length;
    const delta = reply.tool ? { role: 'assistant', content: reply.text, tool_calls: [{ index: 0,
      id: 'c09-boundary-call-' + sequence, type: 'function',
      function: { name: reply.tool.name, arguments: JSON.stringify(reply.tool.arguments) } }] } : { role: 'assistant', content: reply.text };
    return new Response('data: ' + JSON.stringify({ id: 'c09-boundary-response-' + sequence,
      object: 'chat.completion.chunk', created: 1, model: modelId,
      choices: [{ index: 0, delta, finish_reason: reply.tool ? 'tool_calls' : 'stop' }] }) + '\n\ndata: [DONE]\n\n',
    { headers: { 'content-type': 'text/event-stream' } });
  });
  const rpc = async <T>(command: Parameters<ServiceClient['request']>[0]): Promise<T> => need(await client.request(command) as Result<T>);
  function manage(action: 'start' | 'status') {
    const output = execFileSync(join(saved.runtimeRoot, 'bin/bun.exe'),
      ['--no-env-file', join(saved.runtimeRoot, 'apps/service-manager.js'), action, '--installation-file', target.file],
      { cwd: saved.runtimeRoot, env: environment(), windowsHide: true, timeout: 90_000, maxBuffer: 65_536, encoding: 'utf8' });
    const packet = z.object({ version: z.literal(1), result: z.object({ ok: z.literal(true), data: z.object({
      installationId: z.literal(saved.installationId), serviceName: z.literal(saved.serviceName), action: z.literal(action),
      wrapperExitCode: z.literal(0), observedState: z.enum(['stopped', 'not-stopped']), controllerReleased: z.null(),
      productReadyVerified: z.literal(false), productStopVerified: z.literal(false),
    }).strict() }).strict() }).strict().parse(JSON.parse(output));
    if (action === 'start') expect(packet.result.data.observedState).toBe('not-stopped');
    return packet.result.data;
  }
  async function connect() {
    await expect.poll(async () => client.isConnected || (await client.connect(saved, 1500)).ok, { timeout: 30_000 }).toBe(true);
  }
  const close = async () => { client.disconnect(); await provider.stop(); };
  const work = async (receipt: P.InvoiceWorkCreateReceipt) => {
    const current = P.InvoiceWorkGetResultSchema.parse(await rpc({ type: 'invoice_work_get',
      input: { view: 'work', workId: receipt.workId, limit: 20 } }));
    if (current.view !== 'work') throw Error('Expected the original boundary Work.'); return current;
  };
  const identity = async (receipt: P.InvoiceWorkCreateReceipt): Promise<CommitFaultIdentity> => {
    if (!receipt.execution.attempt) throw Error('The original boundary attempt is unavailable.');
    const current = await work(receipt);
    if (current.items.length !== 1) throw Error('Expected the original single-item boundary Work.');
    return { workId: receipt.workId, attemptId: receipt.execution.attempt.attemptId, sessionId: receipt.sessionId,
      itemId: current.items[0]!.itemId, createRequestId: receipt.requestId };
  };
  async function task(receipt: P.InvoiceWorkCreateReceipt, stopRequestId?: string) {
    if (!receipt.execution.attempt) throw Error('The original boundary attempt is unavailable.');
    return P.PersonalTaskGetResultSchema.parse(await rpc({ type: 'personal_task_get', input: { workId: receipt.workId,
      attemptId: receipt.execution.attempt.attemptId, ...(stopRequestId ? { stopRequestId } : {}), limit: 20 } }));
  }
  try {
    if (manage('status').observedState === 'stopped') manage('start');
    await connect();
    const state = await rpc<{ settings: ProductSettings }>({ type: 'get_state' });
    need(await client.saveServiceSettings({ installationId: saved.installationId, operationId: crypto.randomUUID(),
      settings: { ...state.settings, models: [...state.settings.models, { id: modelId, name: 'C09 exact ' + mode,
        credentialRef: 'windows_service_' + mode.replace('-', '_'), kind: 'custom', providerId: null,
        baseUrl: 'http://127.0.0.1:' + provider.port + '/v1', model: modelId, api: 'openai-completions',
        contextWindow: 64000, maxTokens: 8192, reasoning: false }] },
      credentialUpdate: { modelId, apiKey: 'windows-service-boundary-synthetic-key' } }));
    const previous = P.PersonalAgentSnapshotSchema.parse(await rpc({ type: 'personal_agent_get', input: {} }));
    const agent = P.PersonalAgentSnapshotSchema.parse(await rpc({ type: 'personal_agent_update', input: {
      personalAgentId: previous.personalAgentId, expectedRevision: previous.revision, configuration: { ...previous.configuration,
        modelId, tools, resources: { prompt: null, enabledSkills: [] }, extensions: { enabledExtensions: [] }, preferences: '' },
    } }));
    const document = await rpc<DocumentSnapshot>({ type: 'import_prepared_invoice_material', input: {
      contract: 'flowmate-prepared-invoice/v1', sample: 'windows-service-' + mode, sourceText: 'Total 113.00',
      original: { name: 'source.md', base64: Buffer.from('Total 113.00').toString('base64') },
      pages: [{ page: 1, blocks: [{ id: 'b1', kind: 'text', text: 'Total 113.00', sourceIndex: 0, sourceType: 'prepared-text', bbox: null }] }],
    } });
    return { rpc, client, document, wires, identity, work, task, close,
      fault: createSystemCommitFault(mode),
      async start() { client.disconnect(); manage('start'); await connect(); },
      async create(requestId: string, goal: string) {
        return P.InvoiceWorkCreateReceiptSchema.parse(await rpc({ type: 'invoice_work_create', input: {
          personalAgentId: agent.personalAgentId, expectedAgentRevision: agent.revision, requestId, goal, documents: [document.documentRef],
        } }));
      },
      async finished(receipt: P.InvoiceWorkCreateReceipt) {
        await expect.poll(async () => (await task(receipt)).task.stoppedAt, { timeout: 30_000 }).not.toBeNull();
        return task(receipt);
      },
    };
  } catch (error) { await close(); throw error; }
}

test('the original Windows service retains an unknown child stop and its queued Work until the same native child Task can commit its aborted terminal state', async () => {
  const held = Promise.withResolvers<void>(), parentGoal = 'C09 original child terminal boundary', queuedGoal = 'C09 queued behind unknown child stop';
  const f = await controlledCommitBoundary('child-terminal', ['Agent', 'read_invoice_document'], async (body, context) => {
    if (context.delegation) { await held.promise; return { text: 'The original child was still active.' }; }
    if (context.work.goal === parentGoal && body.messages.every(message => message.role !== 'tool'))
      return { text: '', tool: { name: 'Agent', arguments: { subagent_type: 'invoice-evidence-checker', run_in_background: false,
        description: 'Retain the original active child', prompt: 'Read only the original invoice and retain its evidence uncertainty.' } } };
    return { text: 'The original invoice needs explicit human clarification.' };
  });
  try {
    const parent = await f.create('c09-child-terminal-parent', parentGoal);
    await expect.poll(() => f.wires.filter(value => value.delegation).length, { timeout: 30_000 }).toBe(1);
    const before = await f.task(parent); expect(before.children).toHaveLength(1);
    const child = before.children[0]!, wire = f.wires.find(value => value.delegation)!.delegation!;
    expect(child).toMatchObject({ childRunId: wire.childRunId, originToolCallId: wire.originToolCallId, runStatus: 'running', stopConfirmed: false });
    expect(await f.rpc({ type: 'query_run', runId: child.childRunId })).toMatchObject({ runId: child.childRunId,
      sessionId: wire.childSessionId, parentRunId: before.task.attempt.runId, originToolCallId: child.originToolCallId, stoppedAt: null });
    const queued = await f.create('c09-child-terminal-queued', queuedGoal);
    expect(queued.execution).toMatchObject({ kind: 'queued', authorizationAccepted: true });
    if (!queued.execution.attempt) throw Error('The original queued child-stop successor is unavailable.');
    const identity: ChildTerminalFaultIdentity = { ...await f.identity(parent), childRunId: child.childRunId,
      childSessionId: wire.childSessionId, originToolCallId: child.originToolCallId, queuedWorkId: queued.workId,
      queuedAttemptId: queued.execution.attempt.attemptId, queuedSessionId: queued.sessionId,
      queuedCreateRequestId: queued.requestId, stopRequestId: 'c09-original-child-stop' };
    const armed = f.fault.arm(identity);
    expect(armed.childTasks).toHaveLength(1); expect(armed.childTasks[0]).toMatchObject({ status: 'pending', abort_requested: 0 });
    expect(armed).toMatchObject({ triggerPresent: true, receipt: parent, stopReceipt: null, stoppedAt: null,
      queued: { receipt: queued, run_id: null, phaseCount: 0, inputCount: 0 } });
    const childrenBefore = f.wires.filter(value => value.delegation).length;
    await f.start();
    await expect.poll(() => f.wires.filter(value => value.delegation).length, { timeout: 30_000 }).toBe(childrenBefore + 1);
    const healthy = PersonalHistoryPageSchema.parse(await f.rpc({ type: 'personal_task_history',
      input: { target: { workId: parent.workId }, limit: 100 } }));
    expect(healthy.owner).toMatchObject({ workId: parent.workId, sessionId: parent.sessionId, childRunId: null });
    expect(healthy.entries.some(entry => entry.kind === 'flowmate.input')).toBe(true);
    const diagnosticBaseline = HostDiagnosticsSchema.parse(await f.rpc({ type: 'query_diagnostics' }));
    const stop = P.PersonalTaskStopReceiptSchema.parse(await f.rpc({ type: 'personal_task_stop', input: {
      workId: parent.workId, attemptId: identity.attemptId, expectedRevision: (await f.work(parent)).work.revision, requestId: identity.stopRequestId,
    } }));
    expect(stop).toMatchObject({ accepted: true, stopConfirmed: false, stoppedAt: null });
    let nativeFailureCode = '';
    await expect.poll(async () => {
      const value = await f.client.request({ type: 'personal_task_history', input: { target: { workId: parent.workId }, limit: 100 } }) as Result<unknown>;
      nativeFailureCode = value.ok ? 'healthy' : value.error.code; return nativeFailureCode;
    }, { timeout: 30_000 }).toMatch(/^(durable_runtime_failed|durable_runtime_closed)$/);
    await expect.poll(async () => HostDiagnosticsSchema.parse(await f.rpc({ type: 'query_diagnostics' })).entries.some(entry =>
      entry.component === 'personal_agent' && entry.event === 'coordination_failed'
      && ['durable_runtime_failed', 'durable_runtime_closed'].includes(entry.code ?? '')
      && !diagnosticBaseline.entries.some(prior => isDeepStrictEqual(prior, entry))), { timeout: 30_000 }).toBe(true);
    for (let query = 0; query < 3; query++) {
      const unknown = await f.task(parent, identity.stopRequestId);
      expect(unknown.stopReceipt).toEqual(stop); expect(unknown.task.stoppedAt).toBeNull();
      expect(unknown.children[0]).toMatchObject({ childRunId: child.childRunId, stopConfirmed: false, stoppedAt: null });
      expect((await f.task(queued)).task).toMatchObject({ attempt: { attemptId: identity.queuedAttemptId, runId: null }, queued: true, stoppedAt: null });
      expect((await f.work(parent)).work).toMatchObject({ status: 'open', execution: { stopUnconfirmed: true } });
    }
    expect(f.wires.filter(value => value.work.workId === queued.workId)).toHaveLength(0);
    const gap = f.fault.inspect(identity);
    expect(gap).toMatchObject({ triggerPresent: true, stopReceipt: stop, stoppedAt: null, runId: before.task.attempt.runId,
      queued: { receipt: queued, run_id: null, phaseCount: 0, inputCount: 0 } });
    expect(gap.stopRequestedAt).toBe(stop.receivedAt);
    expect(gap.childTasks).toHaveLength(1);
    expect(gap.childTasks[0]).toMatchObject({ id: armed.childTasks[0]!.id, conversation_id: armed.childTasks[0]!.conversation_id, abort_requested: 1 });
    expect(['pending', 'running', 'waiting', 'sleeping']).toContain(gap.childTasks[0]!.status);
    expect(gap.phases[0]!.closed_at).toBeNull();
    for (const run of gap.runs) { expect(run.stopped_at).toBeNull(); expect(JSON.parse(run.cleanup_json).stopped).toBe(false); }
    console.info('Original system child controlled storage failure: ' + JSON.stringify({ workId: parent.workId, attemptId: identity.attemptId,
      nativeTaskId: gap.childTasks[0]!.id, healthyHistoryWorkId: healthy.owner.workId, nativeFailureCode,
      nativeFailureBeforeManagementStop: true, rawSqlError: 'not-exposed' }));
    const callsBeforeRecovery = f.wires.filter(value => value.delegation).length;
    expect(f.fault.clear(identity)).toMatchObject({ triggerPresent: false, stopReceipt: stop, stoppedAt: null });
    await f.start();
    const ended = await f.finished(parent), admitted = await f.finished(queued);
    expect(ended.task).toMatchObject({ attempt: before.task.attempt, runStatus: 'cancelled', stopRequestedAt: stop.receivedAt });
    expect(ended.children).toHaveLength(1);
    expect(ended.children[0]).toMatchObject({ childRunId: child.childRunId, originToolCallId: child.originToolCallId,
      runStatus: 'cancelled', stopConfirmed: true, stoppedAt: expect.any(String) });
    expect((await f.task(parent, identity.stopRequestId)).stopReceipt).toEqual(stop);
    expect(admitted.task).toMatchObject({ attempt: { attemptId: identity.queuedAttemptId }, runStatus: 'completed' });
    expect(admitted.task.attempt.runId).not.toBeNull();
    expect((await f.work(parent)).work).toMatchObject({ status: 'open', counts: { unresolved: 1 } });
    expect(f.wires.filter(value => value.delegation)).toHaveLength(callsBeforeRecovery);
    const recovered = f.fault.inspect(identity), native = recovered.childTasks[0]!;
    expect(recovered).toMatchObject({ triggerPresent: false, receipt: parent, stopReceipt: stop, attemptCount: 1, createCount: 1,
      runId: before.task.attempt.runId, stoppedAt: ended.task.stoppedAt, queued: { receipt: queued, run_id: admitted.task.attempt.runId } });
    expect(native).toMatchObject({ id: armed.childTasks[0]!.id, conversation_id: armed.childTasks[0]!.conversation_id,
      status: 'terminal', abort_requested: 1 });
    expect(JSON.parse(native.record).state.outcome.status).toBe('aborted');
    expect(recovered.phases[0]).toMatchObject({ id: gap.phases[0]!.id, native_submission_id: gap.phases[0]!.native_submission_id });
    expect(recovered.contexts).toEqual(gap.contexts);
    for (const run of recovered.runs) { expect(run.stopped_at).not.toBeNull(); expect(JSON.parse(run.cleanup_json).stopped).toBe(true); }
  } finally { held.resolve(); await f.close(); }
});

test('the original Windows service recovers one committed Candidate and its original ToolCall Task into one native feedback Entry without repeating the business write', async () => {
  const held = Promise.withResolvers<void>(), goal = 'C09 original candidate feedback boundary';
  const candidateResponse = Promise.withResolvers<void>();
  let releaseBlocker = false, document: DocumentSnapshot;
  const f = await controlledCommitBoundary('candidate-feedback', ['read_invoice_document', 'save_invoice_candidate'], async (body, context) => {
    if (context.work.goal !== goal) { if (!releaseBlocker) await held.promise; return { text: 'The original quota holder needs human review.' }; }
    if (body.messages.every(message => message.role !== 'tool')) {
      await candidateResponse.promise;
      const missing = { raw: null, normalized: null, state: 'missing', alternatives: [], sources: [] };
      const candidate = CandidateDraftSchema.parse({ fields: {
        ...Object.fromEntries(['invoiceNumber', 'issueDate', 'sellerName', 'sellerTaxId', 'buyerName', 'buyerTaxId',
          'currency', 'netAmount', 'taxAmount'].map(name => [name, missing])),
        totalAmount: { raw: '113.00', normalized: '113.00', state: 'present', alternatives: [], sources: [{
          documentId: document.documentRef.id, version: document.documentRef.version,
          artifactId: document.parsedArtifactId, page: 1, blockId: 'b1', quote: '113.00',
        }] },
      }, lines: [], notes: [] });
      return { text: '', tool: { name: 'save_invoice_candidate', arguments: { documentId: document.documentRef.id, candidate } } };
    }
    expect(body.messages.some(message => message.role === 'tool' && message.content.includes('candidateId'))).toBe(true);
    return { text: 'The original committed candidate is retained for explicit human disposition.' };
  });
  document = f.document;
  try {
    await f.create('c09-candidate-feedback-blocker', 'C09 controlled candidate quota holder');
    await expect.poll(() => f.wires.length, { timeout: 30_000 }).toBe(1);
    const created = await f.create('c09-candidate-feedback-target', goal);
    expect(created.execution).toMatchObject({ kind: 'queued', authorizationAccepted: true });
    const identity = await f.identity(created);
    expect(f.fault.arm(identity)).toMatchObject({ triggerPresent: true, phases: [], contexts: [], candidates: [], tools: [], feedbackEntries: [] });
    releaseBlocker = true; held.resolve(); await f.start();
    await expect.poll(() => f.wires.filter(value => value.work.workId === created.workId).length, { timeout: 30_000 }).toBe(1);
    const healthy = PersonalHistoryPageSchema.parse(await f.rpc({ type: 'personal_task_history',
      input: { target: { workId: created.workId }, limit: 100 } }));
    expect(healthy.owner).toMatchObject({ workId: created.workId, sessionId: created.sessionId, childRunId: null });
    expect(healthy.entries.some(entry => entry.kind === 'flowmate.input')).toBe(true);
    const diagnosticBaseline = HostDiagnosticsSchema.parse(await f.rpc({ type: 'query_diagnostics' }));
    candidateResponse.resolve();
    await expect.poll(async () => (await f.work(created)).items[0]!.candidateRef, { timeout: 30_000 }).not.toBeNull();
    let nativeFailureCode = '';
    await expect.poll(async () => {
      const value = await f.client.request({ type: 'personal_task_history', input: { target: { workId: created.workId }, limit: 100 } }) as Result<unknown>;
      nativeFailureCode = value.ok ? 'healthy' : value.error.code; return nativeFailureCode;
    }, { timeout: 30_000 }).toMatch(/^(durable_runtime_failed|durable_runtime_closed)$/);
    await expect.poll(async () => HostDiagnosticsSchema.parse(await f.rpc({ type: 'query_diagnostics' })).entries.some(entry =>
      entry.component === 'personal_agent' && entry.event === 'coordination_failed'
      && ['durable_runtime_failed', 'durable_runtime_closed'].includes(entry.code ?? '')
      && !diagnosticBaseline.entries.some(prior => isDeepStrictEqual(prior, entry))), { timeout: 30_000 }).toBe(true);
    const gap = f.fault.inspect(identity);
    expect(gap).toMatchObject({ triggerPresent: true, receipt: created, attemptCount: 1, createCount: 1,
      stopRequestedAt: null, stoppedAt: null, feedbackEntries: [] });
    expect(gap.candidates).toHaveLength(1); expect(gap.candidateEvents).toHaveLength(1);
    expect(gap.tools).toHaveLength(1); expect(gap.toolTasks).toHaveLength(1);
    const candidate = gap.candidates[0]!, tool = gap.tools[0]!, nativeTask = gap.toolTasks[0]!;
    expect(candidate).toMatchObject({ tool_call_id: tool.id, run_id: gap.runId, status: 'generated' });
    expect(gap.candidateEvents[0]).toMatchObject({ candidate_id: candidate.id, job_id: candidate.job_id, run_id: candidate.run_id,
      operation_ref: 'tool-call-id:' + tool.id });
    expect(tool).toMatchObject({ tool_name: 'save_invoice_candidate', status: 'succeeded', native_tool_call_id: 'durable-task:' + nativeTask.id,
      feedback_native_entry_id: null, feedback_bytes: null, parent_received_model_task_id: null, parent_received_at: null });
    expect(JSON.parse(tool.args_json).raw).toMatchObject({ documentId: document.documentRef.id });
    expect(['pending', 'running', 'waiting', 'sleeping']).toContain(nativeTask.status);
    expect(gap.phases[0]!.closed_at).toBeNull();
    console.info('Original system Candidate controlled storage failure: ' + JSON.stringify({ workId: created.workId, attemptId: identity.attemptId,
      candidateId: candidate.id, toolCallId: tool.id, nativeTaskId: nativeTask.id, healthyHistoryWorkId: healthy.owner.workId,
      nativeFailureCode, nativeFailureBeforeManagementStop: true, rawSqlError: 'not-exposed' }));
    expect(f.fault.clear(identity)).toMatchObject({ triggerPresent: false, candidates: gap.candidates, feedbackEntries: [] });
    await f.start();
    const completed = await f.finished(created);
    expect(completed.task).toMatchObject({ attempt: { attemptId: identity.attemptId, runId: gap.runId }, runStatus: 'completed' });
    expect((await f.work(created)).items[0]!.candidateRef).toEqual({ id: candidate.id, sequence: candidate.sequence });
    expect(await f.rpc({ type: 'invoice_work_query_operation', input: { operation: 'create',
      personalAgentId: created.personalAgentId, requestId: created.requestId } })).toEqual(created);
    const recovered = f.fault.inspect(identity);
    expect(recovered).toMatchObject({ triggerPresent: false, receipt: created, attemptCount: 1, createCount: 1,
      runId: gap.runId, stoppedAt: completed.task.stoppedAt, candidates: gap.candidates, candidateEvents: gap.candidateEvents });
    expect(recovered.tools).toHaveLength(1); expect(recovered.toolTasks).toHaveLength(1); expect(recovered.feedbackEntries).toHaveLength(1);
    const originalTool = recovered.tools[0]!, entry = recovered.feedbackEntries[0]!, entryRecord = JSON.parse(entry.record);
    expect(originalTool).toMatchObject({ id: tool.id, native_tool_call_id: tool.native_tool_call_id, args_json: tool.args_json, result_json: tool.result_json,
      feedback_native_entry_id: entry.id, feedback_bytes: Buffer.byteLength(JSON.stringify(entryRecord.model[0]), 'utf8'),
      parent_received_model_task_id: expect.any(Number), parent_received_at: expect.any(String) });
    expect(recovered.toolTasks[0]).toMatchObject({ id: nativeTask.id, conversation_id: nativeTask.conversation_id, status: 'terminal' });
    expect(JSON.parse(recovered.toolTasks[0]!.record).state.outcome.status).toBe('completed');
    expect(entryRecord).toMatchObject({ kind: 'pi.tool-result', byTaskId: nativeTask.id, conversationId: nativeTask.conversation_id,
      model: [{ role: 'toolResult', toolCallId: JSON.parse(nativeTask.record).input.callId, toolName: 'save_invoice_candidate', isError: false }] });
    const savedResult = JSON.parse(tool.result_json!);
    expect(entryRecord.model[0].details).toEqual({ status: savedResult.status, data: savedResult.data });
    expect(recovered.contexts).toEqual(gap.contexts);
    expect(recovered.phases[0]).toMatchObject({ id: gap.phases[0]!.id, native_submission_id: gap.phases[0]!.native_submission_id });
    expect(recovered.phases[0]!.closed_at).not.toBeNull();
    expect(f.wires.filter(value => value.work.workId === created.workId)).toHaveLength(2);
  } finally { releaseBlocker = true; held.resolve(); candidateResponse.resolve(); await f.close(); }
});
