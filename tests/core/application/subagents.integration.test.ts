import { expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { InMemoryCredentialStore } from '@earendil-works/pi-ai';
import { Type } from '@sinclair/typebox';
import { join, resolve } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { ContextErrorSchema, ToolExecutionFailure, appError, fail, ok } from '@flowmate/contracts';
import type { AgentRunEvent, Result, ProviderConfig } from '@flowmate/contracts';
import { createApplication } from '../../../apps/composition.ts';
import { resolveProductPaths } from '../../../packages/shared/src/paths.ts';
import { PiAgentAdapter } from '../../../packages/runtime-pi/src/session.ts';
import { HostClient } from '../../../apps/desktop/main/host-client.ts';
import { createHttpProvider, deferCleanup, mkdtempSync } from '../../support/resources.ts';

function need<T>(result: Result<T>): T { if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`); return result.data; }

async function fixture(delegate: boolean, options: { allTools?: boolean; maxModelCalls?: number; maxToolCalls?: number;
  reuseNativeId?: boolean; lateTool?: boolean; resources?: boolean; switchWorkspace?: boolean;
  cancel?: 'parent' | 'child'; hang?: boolean;
  historyFault?: 'child-before-request' | 'child-final' | 'parent-feedback'; childRetry?: boolean;
  duplicateDelegate?: boolean; delegateFault?: 'return' | 'parent-http'; secondDelegate?: boolean;
  cancelAfterChild?: boolean; deniedChildTool?: 'write' | 'Agent'; hungTool?: boolean; delegateTimeout?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'flowmate-p13-business-')), paths = need(resolveProductPaths(join(root, 'product')));
  const sourceRoot = join(root, 'source'), source = join(sourceRoot, '000001'); mkdirSync(source, { recursive: true });
  const files = { 'original.png': Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/a54AAAAASUVORK5CYII=', 'base64'),
    'content.json': Buffer.from(JSON.stringify([{ type: 'text', text: 'Total 113.00', bbox: [0, 0, 1, 1], page_idx: 0 }])),
    'pages.json': Buffer.from(JSON.stringify([{ pageNumber: 1, text: 'Total 113.00', blockCount: 1 }])) };
  for (const [name, bytes] of Object.entries(files)) writeFileSync(join(source, name), bytes);
  writeFileSync(join(source, 'metadata.json'), JSON.stringify({ schemaVersion: 1, sampleId: '000001', datasetId: 'voxel51-hq-invoice-ocr',
    sourceRecordId: 'p13-local', datasetRevision: 'p13-controlled', qualityStatus: 'complete', allowedUsesClaim: ['local test'], licenseVerification: 'not_verified',
    files: Object.entries(files).map(([path, bytes]) => ({ path, bytes: bytes.length })) }));
  mkdirSync(paths.runtimeDir, { recursive: true });
  writeFileSync(join(paths.runtimeDir, 'subagent-source.txt'), 'Controlled native source 113.00');
  const payloads: any[] = [], observed: any[] = [];
  const outcomes: { runId: number; outcome: import('@flowmate/contracts').AgentNativeOutcome }[] = [];
  const cancellations: unknown[] = [];
  const duplicateResults: Promise<unknown>[] = [], conflicts: unknown[] = [];
  let releaseHttp!: () => void;
  const heldHttp = new Promise<void>(resolve => releaseHttp = resolve);
  let injectedExecutions = 0;
  let docId = 0, rootSessionId = 0, injectedFaults = 0, adapter!: PiAgentAdapter, app!: import('@flowmate/contracts').Application;
  let parentRequests = 0, childRequests = 0, childCalls: { name: string; args: unknown }[] = [];
  let retried = false;
  const server = await createHttpProvider(async request => {
    const payload = await request.json(); payloads.push(payload);
    const childRequest = payload.messages[0]?.content.startsWith('Verify invoice evidence');
    if (childRequest && options.childRetry && !retried) { retried = true; return new Response('Controlled retryable response', { status: 503 }); }
    const call = (name: string, args: unknown, id: string) => ({ role: 'assistant', tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] });
    const ordinal = childRequest ? ++childRequests : ++parentRequests;
    if (!childRequest && ordinal === 2 && options.delegateFault === 'parent-http') return new Response('Controlled lost parent response', { status: 503 });
    if (!childRequest && ordinal === 2 && options.cancelAfterChild) cancellations.push(await app.cancelRun(1));
    if (childRequest && ordinal === 1 && options.switchWorkspace) {
      const workspace = need(await app.readWorkspace());
      need(await app.updateWorkspace({ expectedRevision: workspace.revision, change: { kind: 'document', documentId: null } }));
    }
    const requested = childRequest ? childCalls[ordinal - 1] : undefined;
    const delta = !delegate ? { role: 'assistant', content: 'No delegation needed.' }
      : !childRequest && (ordinal === 1 || ordinal === 2 && options.secondDelegate) ? call('Agent', { prompt: 'Verify total from native and invoice sources.', description: 'Check invoice total', subagent_type: 'invoice-evidence-checker' }, ordinal === 1 ? 'parent-delegate' : 'parent-delegate-2')
      : requested ? call(requested.name, requested.args, options.reuseNativeId && ordinal === 1 ? 'parent-delegate' : `child-${requested.name}`)
      : { role: 'assistant', content: childRequest ? 'Child verified total 113.00 from both sources.' : 'Parent received the child findings.' };
    if (childRequest) {
      const records = Reflect.get(adapter, 'sessions') as Map<string, any>;
      const child = [...records.values()].find(record => record.active?.runId !== 1 && record.active);
      const childRun = child ? need(await app.queryRun(child.active.runId)) : null;
      observed.push(childRun ? { run: childRun, seed: child.recoverySeed, receipt: child.receipt,
        detail: await app.querySubagent({ parentRunId: childRun.kind === 'subagent' ? childRun.parentRunId : 1,
          parentSessionId: rootSessionId, childRunId: childRun.runId }) } : null);
      if (ordinal === 1 && options.duplicateDelegate) {
        const parent = records.get(need(await app.querySession(rootSessionId)).nativeSessionId)!;
        const captured = parent.delegations.get('parent-delegate');
        const tool = parent.session.extensionRunner.getAllRegisteredTools().find((entry: any) => entry.definition.name === 'Agent').definition;
        duplicateResults.push(tool.execute(...captured.call.nativeArguments));
        const args = [...captured.call.nativeArguments]; args[1] = { ...args[1], prompt: 'Conflicting replacement' };
        try { await tool.execute(...args); } catch (error) { conflicts.push(error); }
      }
      if (child && ordinal === 1 && options.cancel) {
        const run = observed.at(-1).run;
        cancellations.push(options.cancel === 'parent' ? await app.cancelRun(run.parentRunId)
          : await app.cancelSubagent({ parentRunId: run.parentRunId, childRunId: run.runId }));
        if (options.hang) await heldHttp;
      }
    }
    const chunk = (delta: unknown, finish: string | null) => `data: ${JSON.stringify({ id: 'p13', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
    return new Response(chunk(delta, null) + chunk({}, 'tool_calls' in delta ? 'tool_calls' : 'stop') + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
  }); deferCleanup(() => server.stop());
  let refs: import('@flowmate/contracts').ExtensionRef[] = [];
  let selection: import('@flowmate/contracts').ResourceSelection = { prompt: null, enabledSkills: [] };
  app = need(await createApplication({ paths, invoiceSourceRoot: sourceRoot, resourceRoot: resolve(import.meta.dir, '../../../resources'),
    resourceDefaults: () => ok({ revision: 1, selection, extensions: { enabledExtensions: refs } }),
    toolDefinitions: definitions => definitions.map(tool => !options.hungTool || tool.name !== 'read_invoice_document' ? tool : { ...tool,
      execute: async (...args) => {
        const result = await tool.execute(...args);
        const run = need(await app.queryRun(args[2].runId));
        if (run.kind === 'subagent') { if (!options.delegateTimeout) cancellations.push(await app.cancelSubagent({ parentRunId: run.parentRunId, childRunId: run.runId })); await heldHttp; }
        return result;
      } }),
    agentFactory: tools => {
      adapter = new PiAgentAdapter({ cwd: paths.runtimeDir, agentDir: paths.runtimeDir, tools,
        ...(options.hang ? { fetch: (request, init) => globalThis.fetch(request, { ...init, signal: undefined }) } : {}),
        credentials: new InMemoryCredentialStore(), runtimeApiKey: 'p13-loopback-only', sessionSetup: session => {
          if (options.lateTool && session.systemPrompt.startsWith('Verify invoice evidence')) session.subscribe(event => {
            if (event.type === 'turn_end') session.agent.state.tools.push({ name: 'write', label: 'write', description: 'Injected write',
              parameters: Type.Object({}), execute: async () => { injectedExecutions++; return { content: [], details: {} }; } });
          });
        } });
      const bind = adapter.bindSubagents.bind(adapter);
      const invoke = adapter.invokeSubagent.bind(adapter);
      adapter.invokeSubagent = async (...args) => {
        const result = await invoke(...args);
        if (options.delegateFault === 'return') throw new ToolExecutionFailure(appError('subagent_execution_failed', 'runtime', 'Controlled post-plugin return failure.'), result);
        return result;
      };
      adapter.bindSubagents = callbacks => bind({ ...callbacks, finish: (runId, outcome) => {
        outcomes.push({ runId, outcome }); return callbacks.finish(runId, outcome);
      } });
      const watch = adapter.watchSession.bind(adapter);
      adapter.watchSession = (nativeId, commit, seed, save) => watch(nativeId, commit, seed, write => {
        const child = seed.sessionId !== rootSessionId;
        const matches = write.history.entries.slice(write.expected.entryCount).some(entry => {
          if (entry.type !== 'message' || !entry.message || typeof entry.message !== 'object') return false;
          const role = Reflect.get(entry.message, 'role');
          return options.historyFault === 'child-before-request' && child && role === 'user'
            || options.historyFault === 'child-final' && child && role === 'assistant' && Reflect.get(entry.message, 'stopReason') === 'stop'
            || options.historyFault === 'parent-feedback' && !child && role === 'toolResult' && Reflect.get(entry.message, 'toolName') === 'Agent';
        });
        if (matches) { injectedFaults++; return fail(appError('storage_write_failed', 'storage', 'Controlled necessary history failure.', true)); }
        return save(write);
      });
      return adapter;
    } })); deferCleanup(() => app.close());
  const releaseHung = async () => {
    const records = Reflect.get(adapter, 'sessions') as Map<string, any>;
    const pending = [...records.values()].flatMap(record => [...record.delegations?.values() ?? []].map((call: any) => call.promise));
    releaseHttp(); await Promise.allSettled(pending);
  };
  if (options.hang || options.hungTool) deferCleanup(releaseHung);
  refs = need(await app.listExtensions()).items.map(item => item.ref);
  if (options.resources) {
    const refs = need(await app.listResources()).items.map(item => item.ref);
    selection = { prompt: refs.find(ref => ref.kind === 'prompt')!, enabledSkills: refs.filter(ref => ref.kind === 'skill') };
  }
  const doc = need(await app.importInvoiceMaterial(source)), session = need(await app.createSession()); docId = doc.documentRef.id;
  rootSessionId = session.sessionId;
  const file = join(paths.runtimeDir, 'subagent-source.txt');
  childCalls = [{ name: 'read', args: { path: file } }, { name: 'read_invoice_document', args: { documentId: docId, page: 1, afterBlockId: null, limit: 10 } }];
  if (options.allTools) childCalls.push(
    { name: 'grep', args: { pattern: '113', path: paths.runtimeDir } },
    { name: 'find', args: { pattern: '*.txt', path: paths.runtimeDir } }, { name: 'ls', args: { path: paths.runtimeDir } },
    { name: 'list_invoice_pages', args: { documentId: docId } },
    { name: 'search_invoice_document', args: { documentId: docId, query: 'Total', page: null, afterBlockId: null, limit: 10 } },
    { name: 'list_invoice_tables', args: { documentId: docId, page: 1, afterBlockId: null, limit: 10 } },
    { name: 'read_invoice_evidence', args: { documentId: docId, page: 1, kind: 'parsed', blockId: 'b1' } },
    { name: 'check_invoice_sources', args: { documentId: docId, sources: [{ documentId: docId, version: doc.documentRef.version, artifactId: doc.parsedArtifactId, page: 1, blockId: 'b1', quote: 'Total 113.00' }] } });
  if (options.deniedChildTool) childCalls = [{ name: options.deniedChildTool, args: options.deniedChildTool === 'write'
    ? { path: file, content: 'Forbidden replacement' } : { prompt: 'Nested task', description: 'Forbidden nested', subagent_type: 'invoice-evidence-checker' } }];
  let current = need(await app.updateWorkspace({ expectedRevision: 0, change: { kind: 'session', sessionId: session.sessionId } }));
  current = need(await app.updateWorkspace({ expectedRevision: current.revision, change: { kind: 'document', documentId: docId } }));
  current = need(await app.startTask({ clientSequence: 1, expectedRevision: current.revision, documentRef: doc.documentRef, goal: 'Verify invoice total' })).workspace;
  const config: ProviderConfig = { version: 1, name: 'P13', revision: 1, modelRef: { provider: 'p13', model: 'p13' },
    native: { authPath: join(root, 'auth.json'), modelsPath: null }, connection: { baseUrl: `http://127.0.0.1:${server.port}/v1`, api: 'openai-completions', contextWindow: 64000, maxTokens: 16000 }, parameters: { maxRetries: options.childRetry ? 1 : 0, maxRetryDelayMs: 100 } };
  let finish!: (event: Extract<AgentRunEvent, { type: 'run_finished' }>) => void;
  const done = new Promise<Extract<AgentRunEvent, { type: 'run_finished' }>>(resolve => finish = resolve);
  const executionStarted = performance.now();
  const accepted = need(await app.submitInput({ sessionId: session.sessionId, clientSequence: 1, mode: 'prompt', text: 'Verify invoice total', config,
    ...(options.hang || options.hungTool ? { stopGraceMs: 100 } : {}),
    ...(options.delegateTimeout ? { timeoutMs: 4000 } : {}),
    ...(options.resources ? { requiredSkill: selection.enabledSkills[0] } : {}),
    ...(options.maxModelCalls || options.maxToolCalls || options.delegateTimeout ? { budget: { ...(options.maxModelCalls ? { maxModelCalls: options.maxModelCalls } : {}),
      ...(options.delegateTimeout ? { toolTimeoutMs: 500 } : {}),
      ...(options.maxToolCalls ? { maxToolCalls: options.maxToolCalls } : {}) } } : {}),
    workspace: { revision: current.revision, sessionId: session.sessionId, documentRef: current.documentRef, jobId: current.jobId, candidateRef: current.candidateRef } },
  { onEvent: event => { if (event.type === 'run_finished') finish(event); } }));
  const terminal = await done;
  return { app, adapter, paths, payloads, observed, session, accepted, terminal, childCalls, injectedExecutions, cancellations, releaseHung, outcomes, injectedFaults, duplicateResults, conflicts,
    elapsedMs: performance.now() - executionStarted };
}

it('[F13-12/21] original Agent tool timeout closes a hung child within its grace without waiting for root timeout', async () => {
  const f = await fixture(true, { hungTool: true, delegateTimeout: true });
  expect(f.cancellations).toHaveLength(0); expect(f.elapsedMs).toBeLessThan(2500);
  expect(need(await f.app.queryRuntimeState()).blocked).toBe(true);
  const child = need(await f.app.querySubagent({ parentRunId: f.accepted.runId, parentSessionId: f.session.sessionId,
    childRunId: need(await f.app.listSubagents({ parentRunId: f.accepted.runId, parentSessionId: f.session.sessionId })).items[0]!.childRunId }));
  expect(child).toMatchObject({ status: 'failed', stopConfirmed: false, cancelRequestedAt: null });
  expect(need(await f.app.queryRun(f.accepted.runId)).status).toBe('failed');
  await f.releaseHung();
});

it('[F13-15] repeats the genuine in-flight registered Agent with its original ticket, rejects conflicts and creates one child', async () => {
  const f = await fixture(true, { duplicateDelegate: true });
  const results = await Promise.all(f.duplicateResults); expect(results).toHaveLength(1);
  expect(f.conflicts).toMatchObject([{ code: 'subagent_identity_conflict' }]);
  expect(f.outcomes).toHaveLength(1); expect(f.payloads).toHaveLength(5);
  expect(need(await f.app.listSubagents({ parentRunId: f.accepted.runId, parentSessionId: f.session.sessionId })).items).toHaveLength(1);
});

it('[F13-08/15] a different original call starts a fresh child after the prior foreground slot is safely committed', async () => {
  const f = await fixture(true, { secondDelegate: true });
  const children = need(await f.app.listSubagents({ parentRunId: f.accepted.runId, parentSessionId: f.session.sessionId })).items;
  expect(children).toHaveLength(2); expect(new Set(children.map(child => child.childSessionId)).size).toBe(2);
  expect(children.map(child => child.status)).toEqual(['completed', 'completed']); expect(f.outcomes).toHaveLength(2); expect(f.payloads).toHaveLength(7);
});

it('[F13-08/14] completed children release native adapter records while their committed histories remain readable', async () => {
  const f = await fixture(true, { secondDelegate: true });
  const records = Reflect.get(f.adapter, 'sessions') as Map<string, unknown>;
  expect([...records.keys()]).toEqual([f.session.nativeSessionId]);
  const children = need(await f.app.listSubagents({ parentRunId: f.accepted.runId, parentSessionId: f.session.sessionId })).items;
  for (const child of children) {
    const history = need(await f.app.querySessionHistory({ sessionId: child.childSessionId }));
    expect(history.items.length).toBeGreaterThan(0);
  }
  expect((await f.adapter.releaseSession(f.session.nativeSessionId)).closed).toBe(true);
  expect(records.size).toBe(0);
});

for (const delegateFault of ['return', 'parent-http'] as const) {
  it(`[F13-16/17] preserves the real completed child and original feedback through ${delegateFault} failure`, async () => {
    const f = await fixture(true, { delegateFault });
    const child = need(await f.app.querySubagent({ parentRunId: f.accepted.runId, parentSessionId: f.session.sessionId,
      childRunId: need(await f.app.listSubagents({ parentRunId: f.accepted.runId, parentSessionId: f.session.sessionId })).items[0]!.childRunId }));
    expect(child.status).toBe('completed'); expect(child.output?.text).toContain('Child verified total');
    expect(child.delivery.state).toBe('request_observed'); expect(f.payloads).toHaveLength(5); expect(f.outcomes).toHaveLength(1);
    expect(need(await f.app.queryRun(f.accepted.runId)).status).toBe(delegateFault === 'return' ? 'completed' : 'failed');
    expect(f.payloads.at(-1).messages.some((message: any) => message.role === 'tool' && message.tool_call_id === 'parent-delegate')).toBe(true);
  });
}

it('[F13-19] a committed child completion survives later root cancellation', async () => {
  const f = await fixture(true, { cancelAfterChild: true });
  expect(need(await f.app.queryRun(f.accepted.runId)).status).toBe('cancelled');
  const children = need(await f.app.listSubagents({ parentRunId: f.accepted.runId, parentSessionId: f.session.sessionId })).items;
  expect(children).toMatchObject([{ status: 'completed', cancelRequestedAt: null }]); expect(f.payloads).toHaveLength(5);
});

for (const deniedChildTool of ['write', 'Agent'] as const) {
  it(`[F13-06/27] a real child cannot execute unregistered ${deniedChildTool}`, async () => {
    const f = await fixture(true, { deniedChildTool });
    expect(f.outcomes).toHaveLength(1); expect(f.observed).toHaveLength(2);
    expect(f.payloads.filter(payload => payload.messages[0]?.content.startsWith('Verify invoice evidence'))[1].messages)
      .toContainEqual(expect.objectContaining({ role: 'tool', content: expect.stringContaining(`Tool ${deniedChildTool} not found`) }));
    expect(await Bun.file(join(f.paths.runtimeDir, 'subagent-source.txt')).text()).toBe('Controlled native source 113.00');
    expect(need(await f.app.listSubagents({ parentRunId: f.accepted.runId, parentSessionId: f.session.sessionId })).items).toHaveLength(1);
  });
}

it('[F13-21] a real child read tool ignoring abort keeps stopping unknown and blocks new roots', async () => {
  const f = await fixture(true, { hungTool: true });
  expect(need(await f.app.queryRun(f.accepted.runId)).status).toBe('failed');
  const child = need(await f.app.querySubagent({ parentRunId: f.accepted.runId, parentSessionId: f.session.sessionId,
    childRunId: need(await f.app.listSubagents({ parentRunId: f.accepted.runId, parentSessionId: f.session.sessionId })).items[0]!.childRunId }));
  expect(child).toMatchObject({ status: 'failed', stopConfirmed: false }); expect(need(await f.app.queryRuntimeState()).blocked).toBe(true);
  const saved = child; await f.releaseHung();
  expect(need(await f.app.querySubagent({ parentRunId: f.accepted.runId, parentSessionId: f.session.sessionId, childRunId: child.childRunId })).status).toBe(saved.status);
});

it('[F13-25] the child detail remains readable during each actual in-flight child model request', async () => {
  const f = await fixture(true);
  expect(f.observed).toHaveLength(3);
  for (const observed of f.observed) expect(observed.detail).toMatchObject({ ok: true, data: { status: 'running', stopConfirmed: false } });
});

for (const maxModelCalls of [12, 5]) {
  it(`[F13-12] attributes actual SDK HTTP retry to the child and counts it in shared budget ${maxModelCalls}`, async () => {
    const f = await fixture(true, { childRetry: true, maxModelCalls });
    const root = need(await f.app.queryRun(f.accepted.runId));
    const child = need(await f.app.querySubagent({ parentRunId: root.runId, parentSessionId: f.session.sessionId,
      childRunId: need(await f.app.listSubagents({ parentRunId: root.runId, parentSessionId: f.session.sessionId })).items[0]!.childRunId }));
    expect(root.status).toBe('completed'); expect(root.usage.attempts).toBe(2);
    expect(f.payloads).toHaveLength(maxModelCalls === 12 ? 6 : 5);
    expect(child.usage.attempts).toBe(maxModelCalls === 12 ? 4 : 3);
    expect(child.status).toBe(maxModelCalls === 12 ? 'completed' : 'failed');
    expect(f.payloads.at(-1).messages.some((message: any) => message.role === 'tool' && message.tool_call_id === 'parent-delegate')).toBe(true);
    expect(need(await f.app.queryRuntimeState()).blocked).toBe(false);
  });
}

for (const historyFault of ['child-before-request', 'child-final', 'parent-feedback'] as const) {
  it(`[F13-16/22/23] keeps saved prefixes and blocks further dispatch after ${historyFault} history failure`, async () => {
    const f = await fixture(true, { historyFault }); expect(f.injectedFaults).toBe(1);
    const root = need(await f.app.queryRun(f.accepted.runId!));
    const page = need(await f.app.listSubagents({ parentRunId: root.runId, parentSessionId: f.session.sessionId }));
    expect(page.items).toHaveLength(1); const child = need(await f.app.querySubagent({ parentRunId: root.runId, parentSessionId: f.session.sessionId, childRunId: page.items[0]!.childRunId }));
    expect(root.status).toBe('failed'); expect(need(await f.app.queryRuntimeState()).blocked).toBe(true);
    expect(f.payloads.filter(payload => !payload.messages[0]?.content.startsWith('Verify invoice evidence'))).toHaveLength(1);
    expect(f.payloads.filter(payload => payload.messages[0]?.content.startsWith('Verify invoice evidence'))).toHaveLength(historyFault === 'child-before-request' ? 0 : 3);
    expect(child.status).toBe(historyFault === 'parent-feedback' ? 'completed' : 'failed');
    expect(child.delivery.state).not.toBe('request_observed');
    expect((Reflect.get(f.adapter, 'sessions') as Map<string, unknown>).has(child.childNativeSessionId)).toBe(historyFault !== 'parent-feedback');
    if (historyFault !== 'parent-feedback') { expect(child.historyUsable).toBe(false);
      if (historyFault === 'child-before-request') expect(child.output?.text ?? '').toBe('');
      else expect(child.output?.partial).toBe(true);
    }
    else expect(child.output?.text).toContain('Child verified total');
    const saved = need(await f.app.querySessionHistory({ sessionId: child.childSessionId }));
    expect(saved.items.some(entry => entry.preview.includes('Child verified total'))).toBe(historyFault === 'parent-feedback');
  });
}

it('[F13-01/02] actual registered extension with no Agent call starts zero children', async () => {
  const f = await fixture(false);
  expect(f.terminal.result).toMatchObject({ ok: true, data: { status: 'completed' } });
  expect(f.payloads).toHaveLength(1); expect(f.observed).toHaveLength(0);
  expect(need(f.adapter.inspectExtensions(f.session.nativeSessionId)).instances.map(item => item.ref.id)).toEqual(['invoice-assist', 'subagents']);
  need(await f.app.close());
  const sql = new Database(f.paths.databaseFile, { readonly: true });
  try {
    expect(sql.query("SELECT count(*) AS n FROM runs WHERE kind='subagent'").get()).toEqual({ n: 0 });
    expect(sql.query('SELECT count(*) AS n FROM sessions').get()).toEqual({ n: 1 });
  } finally { sql.close(); }
});

it('[F13-03/05/10/14/15] real plugin child uses its own frozen identity and existing tools; raw result enters the next parent request', async () => {
  const f = await fixture(true);
  expect(f.terminal.result).toMatchObject({ ok: true, data: { status: 'completed' } });
  expect(f.payloads).toHaveLength(5);
  expect(f.observed).toHaveLength(3);
  for (const child of f.observed) expect(child).toMatchObject({ run: { kind: 'subagent', status: 'running', parentRunId: f.accepted.runId }, receipt: { commitRevision: expect.any(Number) } });
  expect(f.observed[0].run.config.limits.timeoutMs).toBeLessThanOrEqual(10000);
  need(await f.app.close());
  const sql = new Database(f.paths.databaseFile, { readonly: true });
  try {
    const child = sql.query("SELECT * FROM runs WHERE kind='subagent'").get() as any;
    expect(child.status).toBe('completed'); expect(child.session_id).not.toBe(f.session.sessionId);
    expect(child.plugin_agent_id).toBeString(); expect(child.origin_tool_call_id).toBeNumber();
    expect(sql.query('SELECT tool_name,status FROM tool_calls WHERE run_id=? ORDER BY id').all(child.id)).toEqual([
      { tool_name: 'read', status: 'succeeded' }, { tool_name: 'read_invoice_document', status: 'succeeded' }]);
    expect(sql.query('SELECT tool_name,status FROM tool_calls WHERE run_id=?').all(f.accepted.runId)).toEqual([{ tool_name: 'Agent', status: 'succeeded' }]);
    expect(JSON.stringify(f.payloads[4].messages)).toContain('Child verified total 113.00 from both sources.');
    expect(f.payloads[1].tools.map((item: any) => item.function.name)).not.toContain('Agent');
    expect(f.payloads[1].tools.map((item: any) => item.function.name)).not.toContain('write');
  } finally { sql.close(); }
});

it('[F13-05/07/10] all ten existing read-only definitions really execute with child ownership', async () => {
  const f = await fixture(true, { allTools: true });
  expect(f.terminal.result).toMatchObject({ ok: true, data: { status: 'completed' } });
  expect(f.payloads).toHaveLength(13);
  need(await f.app.close());
  const sql = new Database(f.paths.databaseFile, { readonly: true });
  try {
    const calls = sql.query("SELECT tool_name,status,effect FROM tool_calls WHERE run_id=(SELECT id FROM runs WHERE kind='subagent') ORDER BY id").all();
    expect(calls).toEqual(f.childCalls.map(call => ({ tool_name: call.name, status: 'succeeded', effect: 'READ' })));
    expect(sql.query("SELECT count(*) AS n FROM session_inputs WHERE processing_status='completed'").get()).toEqual({ n: 2 });
    expect(sql.query('PRAGMA foreign_key_check').all()).toEqual([]);
  } finally { sql.close(); }
});

it('[F13-12/15] root budget reserves the next parent request and preserves a failed child as failed Agent feedback', async () => {
  const f = await fixture(true, { maxModelCalls: 3 });
  expect(f.terminal.result).toMatchObject({ ok: true, data: { status: 'completed' } });
  expect(f.payloads).toHaveLength(3);
  need(await f.app.close());
  const sql = new Database(f.paths.databaseFile, { readonly: true });
  try {
    const child = sql.query("SELECT status,error_json FROM runs WHERE kind='subagent'").get() as any;
    expect(child.status).toBe('failed'); expect(JSON.parse(child.error_json)).toMatchObject({ code: 'agent_model_call_budget' });
    const call = sql.query("SELECT status,result_json FROM tool_calls WHERE tool_name='Agent'").get() as any;
    expect(call.status).toBe('failed');
    expect(JSON.parse(call.result_json)).toMatchObject({ status: 'failed', data: { details: { status: 'error' } } });
    const history = sql.query('SELECT entry_json FROM session_native_entries WHERE session_id=?').all(f.session.sessionId) as { entry_json: string }[];
    expect(history.map(entry => JSON.parse(entry.entry_json)).some(entry => entry.message?.role === 'toolResult' && entry.message.toolName === 'Agent' && entry.message.isError === true)).toBe(true);
  } finally { sql.close(); }
});

it('[F13-10/12] same native tool ID in different Sessions consumes distinct shared tool capacity', async () => {
  const f = await fixture(true, { maxToolCalls: 2, reuseNativeId: true });
  expect(f.terminal.result).toMatchObject({ ok: true, data: { status: 'completed' } });
  need(await f.app.close());
  const sql = new Database(f.paths.databaseFile, { readonly: true });
  try {
    expect(sql.query('SELECT tool_name,native_tool_call_id,status FROM tool_calls ORDER BY id').all()).toEqual([
      { tool_name: 'Agent', native_tool_call_id: 'parent-delegate', status: 'failed' },
      { tool_name: 'read', native_tool_call_id: 'parent-delegate', status: 'succeeded' }]);
    const child = sql.query("SELECT error_json FROM runs WHERE kind='subagent'").get() as any;
    expect(JSON.parse(child.error_json)).toMatchObject({ code: 'tool_budget_exceeded' });
  } finally { sql.close(); }
});

it('[F13-07/08] an actual late tool added to the SDK active set blocks the next child request', async () => {
  const f = await fixture(true, { lateTool: true });
  expect(f.terminal.result).toMatchObject({ ok: true, data: { status: 'completed' } });
  expect(f.injectedExecutions).toBe(0);
  expect(f.observed).toHaveLength(1);
  expect(f.payloads).toHaveLength(3);
  expect(f.outcomes[0]!.outcome.error).toMatchObject({ code: 'subagent_tool_denied', category: 'tool', retryable: false });
  expect(ContextErrorSchema.safeParse(f.outcomes[0]!.outcome.error).success).toBe(true);
  need(await f.app.close());
});

it('[F13-04/09/27] child uses frozen parent material after Workspace changes and owns its independent input resource binding', async () => {
  const f = await fixture(true, { resources: true, switchWorkspace: true });
  expect(f.terminal.result).toMatchObject({ ok: true, data: { status: 'completed' } });
  expect(f.payloads).toHaveLength(5);
  expect(f.observed[0].run.scope.allowedDocumentIds).toEqual([1]);
  expect(need(await f.app.readWorkspace()).documentRef).toBeNull();
  need(await f.app.close());
  const sql = new Database(f.paths.databaseFile, { readonly: true });
  try {
    const inputs = sql.query('SELECT content_json,processing_status FROM session_inputs ORDER BY id').all() as any[];
    expect(inputs.map(row => row.processing_status)).toEqual(['completed', 'completed']);
    expect(JSON.parse(inputs[0].content_json).resourceBinding.requiredSkill).not.toBeNull();
    expect(JSON.parse(inputs[1].content_json).resourceBinding.requiredSkill).toBeNull();
    expect(JSON.stringify(f.payloads[1].messages)).toContain('Total 113.00');
  } finally { sql.close(); }
});

it('[F13-19/20] cancelling only the real child saves cancellation while its parent receives the error and continues', async () => {
  const f = await fixture(true, { cancel: 'child' });
  expect(f.cancellations).toMatchObject([{ ok: true, data: { accepted: true, cancelRequestedAt: expect.any(String) } }]);
  expect(f.terminal.result).toMatchObject({ ok: true, data: { status: 'completed' } });
  expect(f.payloads).toHaveLength(3);
  const child = f.observed[0].run;
  expect([...(Reflect.get(f.adapter, 'sessions') as Map<string, unknown>).keys()]).toEqual([f.session.nativeSessionId]);
  expect(await f.app.cancelSubagent({ parentRunId: f.accepted.runId, childRunId: child.runId })).toMatchObject({
    ok: true, data: { accepted: false, cancelRequestedAt: expect.any(String) } });
  need(await f.app.close());
  const sql = new Database(f.paths.databaseFile, { readonly: true });
  try {
    const row = sql.query("SELECT status,cancel_requested_at,stopped_at FROM runs WHERE kind='subagent'").get() as any;
    expect(row).toMatchObject({ status: 'cancelled', cancel_requested_at: expect.any(String), stopped_at: expect.any(String) });
    expect(sql.query("SELECT status FROM tool_calls WHERE tool_name='Agent'").get()).toEqual({ status: 'failed' });
    expect(sql.query('PRAGMA foreign_key_check').all()).toEqual([]);
  } finally { sql.close(); }
});

it('[F13-19] root cancellation stops and commits the child before its own terminal', async () => {
  const f = await fixture(true, { cancel: 'parent' });
  expect(f.cancellations).toMatchObject([{ ok: true, data: { accepted: true } }]);
  expect(f.terminal.result).toMatchObject({ ok: true, data: { status: 'cancelled', stopped: true } });
  expect(f.payloads).toHaveLength(2);
  need(await f.app.close());
  const sql = new Database(f.paths.databaseFile, { readonly: true });
  try {
    const rows = sql.query('SELECT kind,status,cancel_requested_at,stopped_at FROM runs ORDER BY id').all() as any[];
    expect(rows.map(row => row.status)).toEqual(['cancelled', 'cancelled']);
    expect(rows[1].cancel_requested_at).toBe(rows[0].cancel_requested_at);
    expect(rows.every(row => row.stopped_at !== null)).toBe(true);
  } finally { sql.close(); }
});

it('[F13-20/21] a real child transport ignoring abort exhausts one grace window and retains both failed terminals after a late reply', async () => {
  const f = await fixture(true, { cancel: 'parent', hang: true });
  const childRunId = f.observed[0].run.runId;
  expect(f.terminal.result).toMatchObject({ ok: true, data: { status: 'failed', stopped: false } });
  expect(need(await f.app.queryRun(childRunId))).toMatchObject({ status: 'failed', stoppedAt: null, output: null });
  expect(need(await f.app.queryRun(f.accepted.runId))).toMatchObject({ status: 'failed', stoppedAt: null });
  expect(need(await f.app.listRunToolCalls({ runId: f.accepted.runId, sessionId: f.session.sessionId })).items)
    .toMatchObject([{ toolName: 'Agent', status: 'failed', stopped: false, errorCode: 'stop_not_confirmed' }]);
  expect(need(await f.app.queryRuntimeState())).toMatchObject({ blocked: true });
  expect(need(await f.app.close())).toMatchObject({ stopped: false, closed: false });
  await f.releaseHung();
  expect(need(await f.app.queryRun(childRunId))).toMatchObject({ status: 'failed', stoppedAt: null, output: null });
  expect(need(await f.app.queryRun(f.accepted.runId))).toMatchObject({ status: 'failed', stoppedAt: null });
  expect(f.payloads).toHaveLength(2);
});

it('[F13-21] cancelling a hung child closes its parent within the same grace instead of awaiting the full tool deadline', async () => {
  const started = performance.now();
  const f = await fixture(true, { cancel: 'child', hang: true });
  expect(performance.now() - started).toBeLessThan(2500);
  expect(f.terminal.result).toMatchObject({ ok: true, data: { status: 'failed', stopped: false } });
  expect(need(await f.app.queryRun(f.observed[0].run.runId))).toMatchObject({ status: 'failed', stoppedAt: null });
  expect(need(await f.app.queryRuntimeState())).toMatchObject({ blocked: true });
  await f.releaseHung();
  expect(f.payloads).toHaveLength(2);
});

it('[F13-11/25] public child queries return the saved owner, original delivery and own history without starting more execution', async () => {
  const f = await fixture(true), owner = { parentRunId: f.accepted.runId, parentSessionId: f.session.sessionId };
  const page = need(await f.app.listSubagents({ ...owner, limit: 1 }));
  expect(page.items).toHaveLength(1); expect(page.nextBeforeRunId).toBeNull();
  const child = page.items[0]!;
  const detail = need(await f.app.querySubagent({ ...owner, childRunId: child.childRunId }));
  expect(detail).toMatchObject({ ...child, description: 'Check invoice total', status: 'completed', stopConfirmed: true,
    historyUsable: true, output: { text: 'Child verified total 113.00 from both sources.' }, delivery: { state: 'request_observed' } });
  expect(detail.scope.allowedTools).toHaveLength(10);
  expect(need(await f.app.listSubagents({ ...owner, beforeRunId: child.childRunId }))).toEqual({ items: [], nextBeforeRunId: null, totals: page.totals });
  expect(await f.app.querySubagent({ ...owner, parentSessionId: child.childSessionId, childRunId: child.childRunId }))
    .toMatchObject({ ok: false, error: { code: 'subagent_identity_conflict' } });
  expect(await f.app.listSubagents({ ...owner, limit: 101 })).toMatchObject({ ok: false, error: { code: 'input_invalid' } });
  expect(await f.app.cancelSubagent({ parentRunId: child.childRunId, childRunId: child.childRunId }))
    .toMatchObject({ ok: false, error: { code: 'subagent_identity_conflict' } });
  expect(await f.app.cancelSubagent({ ...owner, childRunId: child.childRunId } as any))
    .toMatchObject({ ok: false, error: { code: 'input_invalid' } });
  expect(need(await f.app.listSessions()).items.map(item => item.sessionId)).toEqual([f.session.sessionId]);
  expect(f.payloads).toHaveLength(5);
});

it('[F13-24/25] a new real Host reads the independently saved child history and original feedback with zero replay', async () => {
  const f = await fixture(true);
  need(await f.app.close());
  const client = new HostClient();
  need(await client.start(f.paths.root, '0.1.0', resolve(import.meta.dir, '../../..')));
  try {
    const input = { parentRunId: f.accepted.runId, parentSessionId: f.session.sessionId };
    const page = need(await client.request({ type: 'list_subagents', input: { ...input, limit: 20 } }) as Result<import('@flowmate/contracts').SubagentPage>);
    expect(page.items).toHaveLength(1);
    const child = page.items[0]!;
    expect(await client.request({ type: 'query_subagent', input: { ...input, childRunId: child.childRunId } }))
      .toMatchObject({ ok: true, data: { ...child, historyUsable: true, stopConfirmed: true, delivery: { state: 'request_observed' } } });
    expect(await client.request({ type: 'cancel_subagent', input: { parentRunId: input.parentRunId, childRunId: child.childRunId } }))
      .toMatchObject({ ok: true, data: { accepted: false, cancelRequestedAt: null } });
    expect(await client.request({ type: 'query_subagent', input: { ...input, childRunId: f.accepted.runId } }))
      .toMatchObject({ ok: false, error: { code: 'subagent_identity_conflict' } });
    expect(await client.request({ type: 'query_runtime_state' })).toMatchObject({ ok: true, data: { active: null, blocked: false } });
    expect(f.payloads).toHaveLength(5);
  } finally { need(await client.close()); }
});

it('[F13-11/15/20] original completion may repeat but conflicting or foreign callbacks cannot change its saved facts', async () => {
  const f = await fixture(true), first = f.outcomes[0]!;
  const callbacks = Reflect.get(f.adapter, 'subagentCallbacks') as import('@flowmate/contracts').SubagentCallbacks;
  const before = need(await f.app.queryRun(first.runId));
  const readEvents = () => Promise.all([f.accepted.runId, first.runId].map(async runId => need(await f.app.queryRuntimeEvents({
    runId, sessionId: runId === first.runId ? before.sessionId : f.session.sessionId,
    cursor: { runId, lastPersistedSequence: 0 }, limit: 100 }))));
  const originalEvents = await readEvents();
  for (const page of originalEvents) {
    expect(page.hasMore).toBe(false);
    expect(page.items.map(event => event.sequence)).toEqual(page.items.map((_, index) => index + 1));
    expect(page.items.filter(event => event.type === 'run_completed')).toHaveLength(1);
  }
  expect(await callbacks.finish(first.runId, first.outcome)).toEqual({ ok: true, data: undefined });
  expect(await callbacks.finish(first.runId, { ...first.outcome, text: 'Late replacement' }))
    .toMatchObject({ ok: false, error: { code: 'subagent_identity_conflict' } });
  expect(await callbacks.finish(first.runId, { ...first.outcome, agent: { ...first.outcome.agent, nativeSessionId: f.session.nativeSessionId } }))
    .toMatchObject({ ok: false, error: { code: 'subagent_identity_conflict' } });
  expect(await callbacks.finish(f.accepted.runId, first.outcome)).toMatchObject({ ok: false, error: { code: 'subagent_identity_conflict' } });
  expect(f.adapter.requestSubagentStop({ childRunId: first.runId, childNativeSessionId: f.session.nativeSessionId,
    pluginAgentId: before.kind === 'subagent' ? before.pluginAgentId : '' }))
    .toMatchObject({ ok: false, error: { code: 'subagent_identity_conflict' } });
  expect(need(await f.app.queryRun(first.runId))).toEqual(before);
  expect(await readEvents()).toEqual(originalEvents);
  expect(f.payloads).toHaveLength(5);
});
