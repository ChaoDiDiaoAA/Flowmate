import { _electron as electron, type ElectronApplication, type Page } from 'playwright';
import { expect, test as it } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { cleanupResources, closeDesktopFixture, createHttpProvider, Database, mkdtemp } from '../support/resources.ts';
import type { RuntimeEventsSubscriptionRequest } from '@flowmate/contracts';

it.afterEach(cleanupResources);
it.setTimeout(90_000);

const repository = resolve(import.meta.dirname, '../..');
const electronPath = join(repository, 'node_modules/electron/dist/electron.exe');
type Fault = 'late-ack' | 'corrupt-ack' | 'wake-send-throw';
type Command = { pid: number; type: string; requestId: string; ownerToken?: string; subscriptionId?: string; runId?: number };
type Receipt = { pid: number; requestId: string; ok: boolean; errorCode?: string };
type MainTrace = {
  hosts: number[]; commands: Command[]; receipts: Receipt[];
  target: Command | null; originalOpen: { ok: boolean; subscriptionId?: string } | null;
  withheld: number; corrupted: number; releasedLate: number;
  hostWakes: Array<{ pid: number; subscriptionId: string; runId: number; sequence: number }>;
  sendThrows: Array<{ subscriptionId: string; runId: number; sequence: number }>;
};
type MainFaultGate = {
  arm(fault: Fault, subscriptionId?: string): void;
  releaseLate(): void;
  snapshot(): MainTrace;
};

// Install only in the already-ready Main test process. Every IPC handler and
// the actual Bun Host stay intact; the original pipe/timer/lease remain in use.
const mainFaultInstaller = String.raw`
const trace = { hosts: [], commands: [], receipts: [], target: null, originalOpen: null,
  withheld: 0, corrupted: 0, releasedLate: 0, hostWakes: [], sendThrows: [] };
let armed = null;
const late = [];
globalThis.flowmateMainFaultGate = {
  arm(fault, subscriptionId) { armed = { fault, subscriptionId }; },
  releaseLate() { for (const held of late.splice(0)) {
    Reflect.apply(held.emit, held.stdout, ['data', held.line]); trace.releasedLate++;
  } },
  snapshot() { return JSON.parse(JSON.stringify(trace)); },
};
  trace.hosts.push(child.pid);
  const commands = new Map();
  const write = child.stdin.write;
  child.stdin.write = function(...values) {
    try {
      const input = JSON.parse(String(values[0]));
      if (['subscribe_runtime_events', 'unsubscribe_runtime_events', 'query_runtime_events',
        'submit_session_input', 'call_provider', 'cancel_run'].includes(input.type)) {
        const command = { pid: child.pid, type: input.type, requestId: input.requestId,
          ...(input.ownerToken ? { ownerToken: input.ownerToken } : {}),
          ...(input.subscriptionId ? { subscriptionId: input.subscriptionId } : {}),
          ...(input.input?.runId ? { runId: input.input.runId } : {}) };
        trace.commands.push(command); commands.set(input.requestId, command);
        if (input.type === 'subscribe_runtime_events' && armed && armed.fault !== 'wake-send-throw') {
          trace.target = command; command.fault = armed.fault; armed = null;
        }
      }
    } catch { /* Forward even malformed bytes unchanged to the original protocol. */ }
    return Reflect.apply(write, child.stdin, values);
  };
  const emit = child.stdout.emit;
  let buffered = Buffer.alloc(0);
  child.stdout.emit = function(event, ...values) {
    if (event !== 'data' || !Buffer.isBuffer(values[0])) return Reflect.apply(emit, this, [event, ...values]);
    buffered = Buffer.concat([buffered, values[0]]);
    const forward = [];
    for (let newline = buffered.indexOf(10); newline !== -1; newline = buffered.indexOf(10)) {
      let line = buffered.subarray(0, newline + 1); buffered = buffered.subarray(newline + 1);
      let withheld = false;
      try {
        const output = JSON.parse(line.toString('utf8'));
        if (output.type === 'event' && output.event?.type === 'runtime_events_available')
          trace.hostWakes.push({ pid: child.pid, ...output.event });
        const command = output.type === 'response' ? commands.get(output.requestId) : null;
        if (command) trace.receipts.push({ pid: child.pid, requestId: output.requestId,
          ok: output.value?.ok === true, ...(output.value?.error ? { errorCode: output.value.error.code } : {}) });
        if (command?.fault) {
          trace.originalOpen = { ok: output.value?.ok === true, subscriptionId: output.value?.data?.subscriptionId };
          const fault = command.fault; delete command.fault;
          if (fault === 'late-ack') {
            trace.withheld++; late.push({ emit, stdout: child.stdout, line }); withheld = true;
          } else {
            output.value.data.subscriptionId = '00000000-0000-4000-8000-000000000000';
            line = Buffer.from(JSON.stringify(output) + '\n'); trace.corrupted++;
          }
        }
      } catch { /* The real parser retains responsibility for unexpected output. */ }
      if (!withheld) forward.push(line);
    }
    return forward.length ? Reflect.apply(emit, this, [event, Buffer.concat(forward), ...values.slice(1)]) : true;
  };
  const send = contents.send;
  contents.send = function(channel, ...values) {
    const wake = values[0];
    if (armed?.fault === 'wake-send-throw' && channel === 'flowmate:event'
      && wake?.type === 'runtime_events_available' && wake.subscriptionId === armed.subscriptionId) {
      armed = null; trace.sendThrows.push({ subscriptionId: wake.subscriptionId, runId: wake.runId, sequence: wake.sequence });
      throw new Error('Controlled Main IPC wake delivery failure');
    }
    return Reflect.apply(send, this, [channel, ...values]);
  };
`;

function cleanEnvironment(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'COMSPEC', 'PATHEXT', 'TEMP', 'TMP',
    'WINDIR', 'USERPROFILE', 'HOME', 'LOCALAPPDATA', 'APPDATA']) if (process.env[key]) env[key] = process.env[key]!;
  return env;
}

async function fixture() {
  const userData = await mkdtemp(join(tmpdir(), 'flowmate-p6-main-fault-'));
  const seeded = spawnSync('bun', ['--no-env-file', '--eval', `
    import { openDatabase } from './packages/core/src/index.ts';
    import { resolveProductPaths } from './packages/shared/src/index.ts';
    const paths = resolveProductPaths(${JSON.stringify(userData)});
    if (!paths.ok) throw new Error(paths.error.code);
    const opened = openDatabase(paths.data); if (!opened.ok) throw new Error(opened.error.code);
    const at = '2026-10-03T00:00:00.000Z';
    const created = opened.data.runs.create({ goal: 'Main observation fixture',
      input: { version: 1, goal: 'Main observation fixture', text: 'No model execution', messageTimestamp: Date.parse(at) },
      config: { version: 1, name: 'Offline fixture', revision: 1,
        requestedModel: { provider: 'fixture', model: 'offline' }, resolvedModel: { provider: 'fixture', model: 'offline' },
        api: 'openai-completions', endpoint: null, sdk: { codingAgent: '0.85.1', ai: '0.85.1' },
        parameters: { maxRetries: 0, maxRetryDelayMs: 2000 }, limits: { timeoutMs: 1000, stopGraceMs: 1000 },
        native: { authSource: 'unknown', modelsSelection: null } },
      usage: { version: 1, source: 'unknown', reason: 'Offline fixture', sdkValues: null, attempts: null,
        attemptsComplete: false, costSource: null, updatedAt: at },
      cleanup: { version: 1, stopped: false, stopReason: null, lateObservationRequired: false, errors: [] }, createdAt: at });
    if (!created.ok) throw new Error(created.error.code);
    const saved = opened.data.runs.get(created.data); if (!saved.ok) throw new Error(saved.error.code);
    const endedAt = '2026-10-03T00:00:01.000Z';
    const finished = opened.data.runs.finish(created.data, { status: 'failed', output: null,
      error: { code: 'fixture_not_executed', category: 'provider', message: 'Offline observation fixture.', retryable: false },
      usage: saved.data.usage, tokens: saved.data.tokens,
      cleanup: { version: 1, stopped: true, stopReason: 'not-executed', lateObservationRequired: false, errors: [] },
      endedAt, stoppedAt: endedAt, durationMs: null });
    if (!finished.ok || !finished.data) throw new Error('Offline fixture terminal was not committed.');
    opened.data.close();
    console.log(JSON.stringify({ runId: created.data }));
  `], { cwd: repository, env: cleanEnvironment(), windowsHide: true, encoding: 'utf8' });
  expect(seeded.status, seeded.stderr).toBe(0);
  const { runId } = JSON.parse(seeded.stdout.trim()) as { runId: number };
  const app = await electron.launch({ executablePath: electronPath, args: [join(repository, 'out/main/index.js')],
    env: { ...cleanEnvironment(), FLOWMATE_TEST_MODE: '1', FLOWMATE_TEST_USER_DATA_ROOT: userData }, timeout: 30_000 });
  try {
    const page = await app.firstWindow();
    await page.getByRole('button', { name: 'Invoices', exact: true }).click(); await page.getByRole('heading', { name: 'Invoices', exact: true }).waitFor({ timeout: 20_000 });
    await app.evaluate(({ BrowserWindow }, { ownedRoot, installer }) => {
      const handles = (process as typeof process & { _getActiveHandles(): unknown[] })._getActiveHandles();
      const children = handles.filter(value => value && typeof value === 'object' && 'spawnargs' in value
        && Array.isArray(value.spawnargs) && value.spawnargs.includes('apps/host/main.ts') && value.spawnargs.includes(ownedRoot));
      if (children.length !== 1) throw new Error('Expected exactly one actual Host for the isolated fixture.');
      const child = children[0] as import('node:child_process').ChildProcessWithoutNullStreams;
      const contents = BrowserWindow.getAllWindows()[0]?.webContents;
      if (!child.stdin || !child.stdout || !contents) throw new Error('The actual Host pipe or Main window was not found.');
      new Function('child', 'contents', installer)(child, contents);
    }, { ownedRoot: userData, installer: mainFaultInstaller });
    const trace = await mainTrace(app);
    expect(trace.hosts).toHaveLength(1);
    expect(await page.evaluate(() => window.flowmate.queryRuntimeState())).toMatchObject({ ok: true, data: { active: null } });
    return { app, page, userData, input: { runId, sessionId: null, cursor: { runId, lastPersistedSequence: 0 } } satisfies RuntimeEventsSubscriptionRequest };
  } catch (error) {
    const failure = error instanceof Error ? error : new Error(String(error));
    await closeDesktopFixture(app, userData, failure); throw failure;
  }
}

function mainTrace(app: ElectronApplication): Promise<MainTrace> {
  return app.evaluate(() => (globalThis as typeof globalThis & { flowmateMainFaultGate: MainFaultGate }).flowmateMainFaultGate.snapshot());
}

async function arm(app: ElectronApplication, fault: Fault, subscriptionId?: string) {
  await app.evaluate((_electron, input) => (globalThis as typeof globalThis & { flowmateMainFaultGate: MainFaultGate })
    .flowmateMainFaultGate.arm(input.fault, input.subscriptionId), { fault, subscriptionId });
}

async function assertCapacity(page: Page, input: RuntimeEventsSubscriptionRequest) {
  const ids: string[] = [];
  try {
    for (let count = 0; count < 8; count++) {
      const opened = await page.evaluate(value => window.flowmate.subscribeRuntimeEvents(value), input);
      expect(opened).toMatchObject({ ok: true, data: { runId: input.runId, sessionId: input.sessionId } });
      if (!opened.ok) throw new Error(opened.error.code);
      ids.push(opened.data.subscriptionId);
      expect(await page.evaluate(value => window.flowmate.queryRuntimeEvents(value), { ...input, subscriptionId: opened.data.subscriptionId }))
        .toMatchObject({ ok: true, data: { runId: input.runId, sessionId: input.sessionId } });
    }
    expect(new Set(ids).size).toBe(8);
    expect(await page.evaluate(value => window.flowmate.subscribeRuntimeEvents(value), input))
      .toMatchObject({ ok: false, error: { code: 'event_subscription_limit' } });
  } finally {
    for (const id of ids) expect(await page.evaluate(value => window.flowmate.unsubscribeRuntimeEvents(value), id)).toMatchObject({ ok: true });
  }
}

async function assertOriginalCleanup(app: ElectronApplication, target: Command) {
  await expect.poll(async () => {
    const trace = await mainTrace(app);
    const cleanup = trace.commands.filter(command => command.type === 'unsubscribe_runtime_events' && command.subscriptionId === target.subscriptionId);
    return cleanup.length === 1 && trace.receipts.some(receipt => receipt.requestId === cleanup[0]!.requestId && receipt.ok);
  }).toBe(true);
  const trace = await mainTrace(app);
  expect(trace.commands.filter(command => command.type === 'unsubscribe_runtime_events' && command.subscriptionId === target.subscriptionId))
    .toEqual([expect.objectContaining({ pid: target.pid, ownerToken: target.ownerToken, subscriptionId: target.subscriptionId })]);
  expect(trace.hosts).toEqual([target.pid]);
}

for (const fault of ['late-ack', 'corrupt-ack'] as const) {
  it(`P6 real Main releases the original Host registration after ${fault}`, async () => {
    const { app, page, userData, input } = await fixture();
    let failure: Error | undefined;
    try {
      await assertCapacity(page, input);
      await arm(app, fault);
      const started = performance.now();
      const opening = page.evaluate(value => window.flowmate.subscribeRuntimeEvents(value), input);
      await expect.poll(async () => (await mainTrace(app)).originalOpen).toMatchObject({ ok: true });
      const result = await opening;
      expect(result).toMatchObject({ ok: false, error: { code: 'host_protocol_invalid', retryable: true } });
      if (fault === 'late-ack') expect(performance.now() - started).toBeGreaterThanOrEqual(9_500);
      const trace = await mainTrace(app), target = trace.target;
      expect(target).not.toBeNull(); if (!target) throw new Error('The real subscribe command was not observed.');
      expect(trace.originalOpen?.subscriptionId).toBe(target.subscriptionId);
      expect(trace.withheld).toBe(fault === 'late-ack' ? 1 : 0);
      expect(trace.corrupted).toBe(fault === 'corrupt-ack' ? 1 : 0);
      await assertOriginalCleanup(app, target);
      if (fault === 'late-ack') {
        await app.evaluate(() => (globalThis as typeof globalThis & { flowmateMainFaultGate: MainFaultGate }).flowmateMainFaultGate.releaseLate());
        expect((await mainTrace(app)).releasedLate).toBe(1);
      }
      expect(await page.evaluate(value => window.flowmate.queryRuntimeEvents(value), { ...input, subscriptionId: target.subscriptionId }))
        .toMatchObject({ ok: false, error: { code: 'event_subscription_invalid' } });
      await assertCapacity(page, input);
      await assertOriginalCleanup(app, target);
      expect((await mainTrace(app)).commands.filter(command => ['submit_session_input', 'call_provider', 'cancel_run'].includes(command.type))).toEqual([]);
      expect(await page.evaluate(() => window.flowmate.queryRuntimeState())).toMatchObject({ ok: true, data: { active: null } });
      const evidence = await mainTrace(app);
      expect([...new Set(evidence.commands.filter(command => command.type === 'subscribe_runtime_events').map(command => command.ownerToken))])
        .toEqual([target.ownerToken]);
      await it.info().attach('actual-main-host-fault-trace', { body: Buffer.from(JSON.stringify(evidence, null, 2)), contentType: 'application/json' });
    } catch (error) { failure = error instanceof Error ? error : new Error(String(error)); throw failure; }
    finally { await closeDesktopFixture(app, userData, failure); }
    const db = new Database(join(userData, 'data/app.sqlite'), { readonly: true });
    try {
      expect(db.query('SELECT count(*) AS count FROM runs').get()).toEqual({ count: 1 });
      expect(db.query('SELECT count(*) AS count FROM session_inputs').get()).toEqual({ count: 0 });
      expect(db.query('SELECT count(*) AS count FROM tool_calls').get()).toEqual({ count: 0 });
    } finally { db.close(); }
  });
}

it('P6 real Main releases a subscription when its actual IPC wake delivery throws', async () => {
  const { app, page, userData, input } = await fixture();
  let failure: Error | undefined;
  let requests = 0;
  let complete: (() => void) | undefined;
  const server = await createHttpProvider(() => {
    requests++;
    const frame = (delta: unknown, finish_reason: string | null) => `data: ${JSON.stringify({ id: 'p6-main-wake',
      choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
    return new Response(new ReadableStream<Uint8Array>({ start(controller) {
      controller.enqueue(new TextEncoder().encode(frame({ role: 'assistant', content: 'Controlled Main wake' }, null)));
      complete = () => { controller.enqueue(new TextEncoder().encode(`${frame({}, 'stop')}data: [DONE]\n\n`)); controller.close(); };
    } }), { headers: { 'content-type': 'text/event-stream' } });
  });
  try {
    await assertCapacity(page, input);
    expect(await page.evaluate(async baseUrl => {
      const state = await window.flowmate.getState(); if (!state.ok) return state;
      return window.flowmate.saveSettings({ ...state.data.settings, models: [{ id: 'main-wake', credentialRef: '00000000000000000000000000000032',
        name: 'Controlled Main wake', kind: 'custom', providerId: null, baseUrl, model: 'main-wake', api: 'openai-completions',
        contextWindow: 64_000, maxTokens: 16_384, reasoning: false }], defaultModelId: 'main-wake' },
      { modelId: 'main-wake', apiKey: 'synthetic-p6-main-key' });
    }, `http://127.0.0.1:${server.port}/v1`)).toMatchObject({ ok: true });
    const session = await page.evaluate(() => window.flowmate.createSession({ title: 'Actual Main wake' }));
    expect(session).toMatchObject({ ok: true }); if (!session.ok) throw new Error(session.error.code);
    const workspace = await page.evaluate(async sessionId => {
      const current = await window.flowmate.readWorkspace(); if (!current.ok) return current;
      return window.flowmate.updateWorkspace({ expectedRevision: current.data.revision, change: { kind: 'session', sessionId } });
    }, session.data.sessionId);
    expect(workspace).toMatchObject({ ok: true }); if (!workspace.ok) throw new Error(workspace.error.code);
    const accepted = await page.evaluate(value => window.flowmate.submitInput({ sessionId: value.sessionId, clientSequence: 1,
      mode: 'prompt', goalMode: 'answer', modelId: 'main-wake', text: 'Create one actual persisted wake.',
      workspace: { revision: value.workspace.revision, documentRef: value.workspace.documentRef,
        jobId: value.workspace.jobId, candidateRef: value.workspace.candidateRef, sessionId: value.sessionId } }),
    { sessionId: session.data.sessionId, workspace: workspace.data });
    expect(accepted, JSON.stringify(accepted)).toMatchObject({ ok: true }); if (!accepted.ok) throw new Error(accepted.error.code);
    const activeInput = { runId: accepted.data.runId, sessionId: session.data.sessionId,
      cursor: { runId: accepted.data.runId, lastPersistedSequence: 0 } };
    const opened = await page.evaluate(value => window.flowmate.subscribeRuntimeEvents(value), activeInput);
    expect(opened).toMatchObject({ ok: true }); if (!opened.ok) throw new Error(opened.error.code);
    const target = (await mainTrace(app)).commands.find(command => command.type === 'subscribe_runtime_events'
      && command.subscriptionId === opened.data.subscriptionId);
    expect(target).toBeDefined(); if (!target) throw new Error('The actual Host subscribe was not observed.');
    await arm(app, 'wake-send-throw', opened.data.subscriptionId);
    await expect.poll(() => complete !== undefined).toBe(true);
    complete!(); complete = undefined;
    await expect.poll(async () => (await mainTrace(app)).sendThrows.length).toBe(1);
    await assertOriginalCleanup(app, target);
    const trace = await mainTrace(app);
    expect(trace.hostWakes).toEqual(expect.arrayContaining([expect.objectContaining({ pid: target.pid, ...trace.sendThrows[0]! })]));
    expect(await page.evaluate(value => window.flowmate.queryRuntimeEvents(value), { ...activeInput, subscriptionId: opened.data.subscriptionId }))
      .toMatchObject({ ok: false, error: { code: 'event_subscription_invalid' } });
    await expect.poll(async () => await page.evaluate(() => window.flowmate.queryRuntimeState())).toMatchObject({ ok: true, data: { active: null } });
    await expect.poll(async () => {
      const trace = await mainTrace(app);
      const released = new Set(trace.commands.filter(command => command.type === 'unsubscribe_runtime_events').map(command => command.subscriptionId));
      return trace.commands.filter(command => command.type === 'subscribe_runtime_events' && !released.has(command.subscriptionId)).length;
    }).toBe(0);
    await assertCapacity(page, input);
    await assertOriginalCleanup(app, target);
    expect(requests).toBe(1);
    const evidence = await mainTrace(app);
    expect(evidence.commands.filter(command => command.type === 'cancel_run')).toEqual([]);
    expect([...new Set(evidence.commands.filter(command => command.type === 'subscribe_runtime_events').map(command => command.ownerToken))])
      .toEqual([target.ownerToken]);
    await it.info().attach('actual-main-host-wake-fault-trace', { body: Buffer.from(JSON.stringify({ ...evidence, providerRequests: requests }, null, 2)),
      contentType: 'application/json' });
  } catch (error) { failure = error instanceof Error ? error : new Error(String(error)); throw failure; }
  finally { complete?.(); await server.stop(); await closeDesktopFixture(app, userData, failure); }
});

it('T08 real Electron exposes all three Context queries through Main and Preload', async () => {
  const {app,page,userData}=await fixture();let failure:Error|undefined;
  try {
    expect(await page.evaluate(()=>({ snapshots:typeof window.flowmate.listContextSnapshots,
      detail:typeof window.flowmate.queryContextSnapshot,requests:typeof window.flowmate.listContextRequests })))
      .toEqual({snapshots:'function',detail:'function',requests:'function'});
    const session=await page.evaluate(()=>window.flowmate.createSession({title:'Empty Context query'}));
    if(!session.ok)throw new Error(session.error.code);
    expect(await page.evaluate(sessionId=>window.flowmate.listContextSnapshots({sessionId}),session.data.sessionId))
      .toMatchObject({ok:true,data:{sessionId:session.data.sessionId,runId:null,items:[],nextBeforeId:null}});
    expect(await page.evaluate(sessionId=>window.flowmate.queryContextSnapshot({sessionId,runId:1,snapshotId:999}),session.data.sessionId))
      .toMatchObject({ok:false,error:{code:'state_conflict',category:'runtime',retryable:false}});
    expect(await page.evaluate(sessionId=>window.flowmate.listContextRequests({sessionId,runId:1}),session.data.sessionId))
      .toMatchObject({ok:false,error:{code:'state_conflict',category:'runtime',retryable:false}});
  }catch(error){failure=error instanceof Error?error:new Error(String(error));throw failure;}
  finally{await closeDesktopFixture(app,userData,failure);}
});

it('T08 real Main preserves original Context evidence and rejects trust, malformed receipts and closing without replay', async () => {
  const {app,page,userData}=await fixture();let failure:Error|undefined,requests=0;
  const server=await createHttpProvider(()=>{requests++;
    const chunk=(delta:unknown,finish_reason:string|null)=>'data: '+JSON.stringify({id:'t08-original-response',choices:[{index:0,delta,finish_reason}]})+'\n\n';
    return new Response(chunk({role:'assistant',content:'Original Context answer'},null)+chunk({},'stop')+'data: [DONE]\n\n',
      {headers:{'content-type':'text/event-stream'}});
  });
  try {
    expect(await page.evaluate(async baseUrl=>{
      const state=await window.flowmate.getState();if(!state.ok)return state;
      return window.flowmate.saveSettings({...state.data.settings,models:[{id:'t08-main',credentialRef:'00000000000000000000000000000033',name:'T08 Main',kind:'custom',providerId:null,
        baseUrl,model:'t08-main',api:'openai-completions',contextWindow:64000,maxTokens:16384,reasoning:false}],defaultModelId:'t08-main'},
        {modelId:'t08-main',apiKey:'synthetic-t08-main-key'});
    },`http://127.0.0.1:${server.port}/v1`)).toMatchObject({ok:true});
    const session=await page.evaluate(()=>window.flowmate.createSession({title:'Original Context'}));if(!session.ok)throw new Error(session.error.code);
    const workspace=await page.evaluate(async sessionId=>{
      const current=await window.flowmate.readWorkspace();if(!current.ok)return current;
      return window.flowmate.updateWorkspace({expectedRevision:current.data.revision,change:{kind:'session',sessionId}});
    },session.data.sessionId);if(!workspace.ok)throw new Error(workspace.error.code);
    const accepted=await page.evaluate(({sessionId,workspace})=>window.flowmate.submitInput({sessionId,clientSequence:1,mode:'prompt',goalMode:'answer',modelId:'t08-main',
      text:'User text C:/user/receipt.txt',workspace:{revision:workspace.revision,documentRef:workspace.documentRef,jobId:workspace.jobId,candidateRef:workspace.candidateRef,sessionId}}),
      {sessionId:session.data.sessionId,workspace:workspace.data});
    if(!accepted.ok)throw new Error(accepted.error.code);
    await expect.poll(()=>page.evaluate(()=>window.flowmate.queryRuntimeState())).toMatchObject({ok:true,data:{active:null}});
    const input={sessionId:session.data.sessionId,runId:accepted.data.runId};
    const snapshots=await page.evaluate(value=>window.flowmate.listContextSnapshots(value),input);
    expect(snapshots).toMatchObject({ok:true,data:{...input,items:[{inputId:accepted.data.inputId,mode:'prompt'}]}});
    if(!snapshots.ok||!snapshots.data.items[0])throw new Error('Missing actual snapshot');
    const detailInput={...input,snapshotId:snapshots.data.items[0].id};
    const detail=await page.evaluate(value=>window.flowmate.queryContextSnapshot(value),detailInput);
    expect(detail).toMatchObject({ok:true,data:{snapshot:{id:detailInput.snapshotId,json:{text:'User text C:/user/receipt.txt',hasWorkingDirectory:true}},
      input:{inputId:accepted.data.inputId,status:'consumed',processingStatus:'completed'}}});
    expect(JSON.stringify(detail)).not.toContain(userData);
    const evidence=await page.evaluate(value=>window.flowmate.listContextRequests(value),input);
    expect(evidence).toMatchObject({ok:true,data:{...input,collection:'collected',items:[{binding:{...input,inputId:accepted.data.inputId,snapshotId:detailInput.snapshotId},
      sdkPayload:{inclusion:'confirmed'},attempts:[{attempt:1,responseStatus:200,nativeRequestId:null}]}]}});
    expect(requests).toBe(1);
    const baseline=(await mainTrace(app)).commands.length;
    // The live Main handlers, child pipe and Preload remain intact. Only the next actual reply bytes or close write are controlled.
    await app.evaluate((_electron,root)=>{
      const handles=(process as typeof process & {_getActiveHandles():unknown[]})._getActiveHandles();
      const child=handles.find(value=>value&&typeof value==='object'&&'spawnargs'in value&&Array.isArray(value.spawnargs)&&value.spawnargs.includes(root)
        &&value.spawnargs.includes('apps/host/main.ts')) as import('node:child_process').ChildProcessWithoutNullStreams|undefined;
      if(!child?.stdin||!child.stdout)throw new Error('Actual owned Host missing');
      const types=new Map<string,string>(),trace:{type:string;requestId:string}[]=[];let fault:string|null=null,hold=false;
      let held:unknown[]|null=null;const write=child.stdin.write,emit=child.stdout.emit;let bytes=Buffer.alloc(0);
      child.stdin.write=function(chunk:unknown,encodingOrCallback?:BufferEncoding|((error:Error|null|undefined)=>void),callback?:(error:Error|null|undefined)=>void){
        const args=[chunk,encodingOrCallback,callback];
        const command=JSON.parse(String(chunk));types.set(command.requestId,command.type);
        if(command.type.includes('context'))trace.push({type:command.type,requestId:command.requestId});
        if(command.type==='close'&&hold){held=args;return true;}
        return Reflect.apply(write,this,args);
      };
      child.stdout.emit=function(event:string,...values:unknown[]){
        if(event!=='data'||!Buffer.isBuffer(values[0]))return Reflect.apply(emit,this,[event,...values]);
        bytes=Buffer.concat([bytes,values[0]]);const forward:Buffer[]=[];
        for(let newline=bytes.indexOf(10);newline!==-1;newline=bytes.indexOf(10)){
          let line=bytes.subarray(0,newline+1);bytes=bytes.subarray(newline+1);const packet=JSON.parse(line.toString());
          if(packet.type==='response'&&types.get(packet.requestId)?.includes('context')&&fault){
            if(fault==='owner'){if(packet.value.data.snapshot){packet.value.data.snapshot.id=999999;}else packet.value.data.sessionId=999999;}
            else packet.value={ok:false,error:{code:'host_command_failed',category:'runtime',retryable:true,message:'private/raw/SDK exception'}};
            line=Buffer.from(JSON.stringify(packet)+'\n');fault=null;
          } forward.push(line);
        }return forward.length?Reflect.apply(emit,this,[event,Buffer.concat(forward),...values.slice(1)]):true;
      };
      Reflect.set(globalThis,'t08ContextGate',{arm(value:string){fault=value;},snapshot(){return {trace,held:held!==null};},
        holdClose(){hold=true;},releaseClose(){hold=false;if(held){Reflect.apply(write,child.stdin,held);held=null;}}});
    },userData);
    for(const kind of ['snapshots','detail','requests'] as const){
      const query=()=>page.evaluate(async({kind,input,detailInput})=>kind==='snapshots'?window.flowmate.listContextSnapshots(input)
        :kind==='detail'?window.flowmate.queryContextSnapshot(detailInput):window.flowmate.listContextRequests(input),{kind,input,detailInput});
      for(const fault of ['owner','unsafe-error']){
        await app.evaluate((_electron,value)=>Reflect.get(globalThis,'t08ContextGate').arm(value),fault);
        expect(await query()).toEqual({ok:false,error:{code:'internal_error',category:'internal',retryable:false,message:'Context query could not be completed.'}});
      }
      const trusted=await app.evaluate(async({ipcMain,BrowserWindow},{kind,input,detailInput})=>{
        const channel=kind==='snapshots'?'flowmate:list-context-snapshots':kind==='detail'?'flowmate:query-context-snapshot':'flowmate:list-context-requests';
        const handlers=(ipcMain as unknown as {_invokeHandlers:Map<string,(event:unknown,input:unknown)=>Promise<unknown>>})._invokeHandlers;
        const main=BrowserWindow.getAllWindows()[0]!,other=new BrowserWindow({show:false});await other.loadURL('about:blank');
        try{return {wrongSender:await handlers.get(channel)!({sender:other.webContents,senderFrame:other.webContents.mainFrame},kind==='detail'?detailInput:input),
          wrongFrame:await handlers.get(channel)!({sender:main.webContents,senderFrame:other.webContents.mainFrame},kind==='detail'?detailInput:input)};}
        finally{other.destroy();}
      },{kind,input,detailInput});
      for(const result of Object.values(trusted))expect(result).toEqual({ok:false,error:{code:'internal_error',category:'internal',retryable:false,message:'Context query could not be completed.'}});
      expect(await query()).toEqual(kind==='snapshots'?snapshots:kind==='detail'?detail:evidence);
    }
    expect(await page.evaluate(async input=>window.flowmate.listContextRequests({...input,limit:21}),input))
      .toMatchObject({ok:false,error:{code:'input_invalid',category:'input',retryable:false}});
    const originalUrl=page.url();await page.goto('data:text/html,<title>untrusted url</title>');
    for(const result of await page.evaluate(async({input,detailInput})=>[await window.flowmate.listContextSnapshots(input),
      await window.flowmate.queryContextSnapshot(detailInput),await window.flowmate.listContextRequests(input)],{input,detailInput}))
      expect(result).toEqual({ok:false,error:{code:'internal_error',category:'internal',retryable:false,message:'Context query could not be completed.'}});
    await page.goto(originalUrl);await page.getByRole('button',{name:'Invoices',exact:true}).click();await page.getByRole('heading',{name:'Invoices',exact:true}).waitFor();
    expect(requests).toBe(1);
    const queryTrace=await app.evaluate(()=>Reflect.get(globalThis,'t08ContextGate').snapshot().trace);
    expect(queryTrace).toHaveLength(9);
    expect([...new Set(queryTrace.map((command:{type:string})=>command.type))].sort())
      .toEqual(['list_context_requests','list_context_snapshots','query_context_snapshot']);
    expect((await mainTrace(app)).commands.slice(baseline).filter(command=>['submit_session_input','call_provider','cancel_run'].includes(command.type))).toEqual([]);
    await app.evaluate(({app})=>{Reflect.get(globalThis,'t08ContextGate').holdClose();app.emit('before-quit',{preventDefault(){}});});
    await expect.poll(()=>app.evaluate(()=>Reflect.get(globalThis,'t08ContextGate').snapshot().held)).toBe(true);
    for(const result of await page.evaluate(async({input,detailInput})=>[await window.flowmate.listContextSnapshots(input),
      await window.flowmate.queryContextSnapshot(detailInput),await window.flowmate.listContextRequests(input)],{input,detailInput}))
      expect(result).toMatchObject({ok:false,error:{code:'runtime_busy',category:'runtime',retryable:false}});
    expect(requests).toBe(1);
    expect(await app.evaluate(()=>Reflect.get(globalThis,'t08ContextGate').snapshot().trace)).toEqual(queryTrace);
    await it.info().attach('t08-actual-main-context-trace',{body:Buffer.from(JSON.stringify(await app.evaluate(()=>Reflect.get(globalThis,'t08ContextGate').snapshot()))),contentType:'application/json'});
  }catch(error){failure=error instanceof Error?error:new Error(String(error));throw failure;}
  finally{
    await app.evaluate(()=>Reflect.get(globalThis,'t08ContextGate')?.releaseClose()).catch(()=>{});
    await server.stop();await closeDesktopFixture(app,userData,failure);
  }
  const db=new Database(join(userData,'data/app.sqlite'),{readonly:true});
  try{expect(db.query('SELECT COUNT(*) AS count FROM context_snapshots').get()).toEqual({count:1});
    expect(db.query('SELECT COUNT(*) AS count FROM session_inputs').get()).toEqual({count:1});
    expect(db.query('SELECT COUNT(*) AS count FROM tool_calls').get()).toEqual({count:0});}
  finally{db.close();}
});
