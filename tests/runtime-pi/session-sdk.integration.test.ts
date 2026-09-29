import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'bun:test';
import { InMemoryCredentialStore, InMemoryModelsStore, Type } from '@earendil-works/pi-ai';
import {
  createAgentSession,
  createExtensionRuntime,
  defineTool,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type ToolDefinition as PiExtensionToolDefinition,
  type ResourceLoader,
} from '@earendil-works/pi-coding-agent';

const providerId = 'flowmate-p2-fixture';
const modelId = 'flowmate-p2-agent-model';
const endpoint = 'https://fixture.invalid/v1';
const extensionMarker = '__flowmate_p2_probe_extension_loaded__';

type FixtureRequest = {
  model?: string;
  messages?: Array<{ role: string; content?: unknown }>;
  tools?: unknown[];
};

type CapturedRequest = {
  url: string;
  body: FixtureRequest;
};

type FetchMode = 'success' | 'error' | 'wait-for-abort';

type RequestedToolCall = { id: string; name: string; arguments: unknown };

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function findPackageVersion(entryPath: string, expectedName: string): string {
  let directory = dirname(entryPath);
  while (true) {
    const packagePath = join(directory, 'package.json');
    if (existsSync(packagePath)) {
      const candidate = JSON.parse(readFileSync(packagePath, 'utf8')) as { name?: string; version?: string };
      if (candidate.name === expectedName && candidate.version) return candidate.version;
    }
    const parent = dirname(directory);
    if (parent === directory) throw new Error(`package root not found: ${expectedName}`);
    directory = parent;
  }
}

function packageEntry(packageName: string): string {
  return fileURLToPath(import.meta.resolve(packageName));
}

function responseChunk(delta: Record<string, unknown>, finishReason: string | null = null): string {
  return `data: ${JSON.stringify({
    id: 'flowmate-fixture-response',
    object: 'chat.completion.chunk',
    created: 1,
    model: modelId,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  })}\n\n`;
}

function successResponse(): Response {
  return new Response([
    responseChunk({ role: 'assistant', content: 'fixture answer' }),
    responseChunk({}, 'stop'),
    'data: [DONE]\n\n',
  ].join(''), {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

function toolCallsResponse(calls: RequestedToolCall[]): Response {
  const toolCalls = calls.map((call, index) => ({
    index,
    id: call.id,
    type: 'function',
    function: { name: call.name, arguments: JSON.stringify(call.arguments) },
  }));
  return new Response([
    responseChunk({ role: 'assistant', tool_calls: toolCalls }),
    responseChunk({}, 'tool_calls'),
    'data: [DONE]\n\n',
  ].join(''), {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

function makeFetchHarness(onRequest?: (signal: AbortSignal | null) => void) {
  const requests: CapturedRequest[] = [];
  const responses: Response[] = [];
  let nextMode: FetchMode = 'success';
  const fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = input instanceof Request ? input.clone() : new Request(input, init);
    const url = new URL(request.url);
    if (url.hostname !== 'fixture.invalid') throw new Error(`unexpected non-fixture request: ${url.hostname}`);
    const body = await request.json() as FixtureRequest;
    requests.push({ url: request.url, body });
    const mode = nextMode;
    nextMode = 'success';
    onRequest?.(init?.signal ?? request.signal);

    if (mode === 'error') {
      return new Response(JSON.stringify({ error: { message: 'controlled fixture error' } }), {
        status: 503,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (mode === 'wait-for-abort') {
      const signal = init?.signal ?? request.signal;
      return await new Promise<Response>((_resolve, reject) => {
        const abort = () => reject(new DOMException('Fixture request aborted', 'AbortError'));
        if (signal.aborted) abort();
        else signal.addEventListener('abort', abort, { once: true });
      });
    }
    return responses.shift() ?? successResponse();
  };

  return {
    fetch,
    requests,
    setNextMode(mode: FetchMode) { nextMode = mode; },
    queueToolCalls(calls: RequestedToolCall[]) { responses.push(toolCallsResponse(calls)); },
  };
}

async function fileList(root: string): Promise<string[]> {
  const files: string[] = [];
  async function visit(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else files.push(relative(root, path).replaceAll('\\', '/'));
    }
  }
  await visit(root);
  return files.sort();
}

async function createFixtureRuntime() {
  const credentials = new InMemoryCredentialStore();
  const runtime = await ModelRuntime.create({
    credentials,
    modelsPath: null,
    modelsStore: new InMemoryModelsStore(),
    allowModelNetwork: false,
    refreshOnCreate: false,
  });
  runtime.registerProvider(providerId, {
    baseUrl: endpoint,
    api: 'openai-completions',
    models: [{
      id: modelId,
      name: modelId,
      api: 'openai-completions',
      baseUrl: endpoint,
      reasoning: false,
      input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 32768,
      maxTokens: 8192,
    }],
  });
  await runtime.setRuntimeApiKey(providerId, 'fixture-only-key');
  const model = runtime.getModel(providerId, modelId);
  if (!model) throw new Error('fixture model registration failed');
  return { runtime, model };
}

function createEmptyResourceLoader(systemPrompt: string): ResourceLoader {
  return {
    getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => systemPrompt,
    getSystemPromptSource: () => undefined,
    getAppendSystemPrompt: () => [],
    getAppendSystemPromptSources: () => [],
    extendResources: () => { throw new Error('p2_resources_disabled'); },
    reload: async () => {},
  };
}

async function createFixtureSession(
  cwd: string,
  agentDir: string,
  runtime: ModelRuntime,
  model: NonNullable<ReturnType<ModelRuntime['getModel']>>,
  toolOptions: { tools: string[]; customTools: PiExtensionToolDefinition[] } = { tools: [], customTools: [] },
) {
  const manager = SessionManager.inMemory(cwd);
  const settingsManager = SettingsManager.inMemory({
    compaction: { enabled: false },
    retry: { enabled: false, maxRetries: 0, baseDelayMs: 1, provider: { maxRetries: 0, maxRetryDelayMs: 1 } },
    transport: 'sse',
    enableSkillCommands: false,
    defaultTools: [],
    packages: [],
    extensions: [],
    skills: [],
    prompts: [],
    themes: [],
  });
  const { session } = await createAgentSession({
    cwd,
    agentDir,
    modelRuntime: runtime,
    model,
    sessionManager: manager,
    settingsManager,
    resourceLoader: createEmptyResourceLoader('You are a controlled Flowmate SDK fixture.'),
    tools: toolOptions.tools,
    customTools: toolOptions.customTools,
    thinkingLevel: 'off',
  });
  return { session, manager, settingsManager };
}

async function createTempWorkspace() {
  const root = await mkdtemp(join(tmpdir(), 'flowmate-p2-session-sdk-'));
  const cwd = join(root, 'project');
  const agentDir = join(root, 'agent');
  await mkdir(cwd, { recursive: true });
  await mkdir(agentDir, { recursive: true });
  return { root, cwd, agentDir };
}

describe('Pi 0.85.1 AgentSession contract', () => {
  it('uses the pinned SDK and the installed transitive agent-core version', () => {
    const rootPackage = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as {
      dependencies: Record<string, string>;
    };
    const codingAgentEntry = packageEntry('@earendil-works/pi-coding-agent');
    const aiEntry = packageEntry('@earendil-works/pi-ai');
    const coreEntry = join(
      dirname(dirname(dirname(codingAgentEntry))),
      'pi-agent-core',
      'dist',
      'index.js',
    );

    expect(rootPackage.dependencies['@earendil-works/pi-coding-agent']).toBe('0.85.1');
    expect(rootPackage.dependencies['@earendil-works/pi-ai']).toBe('0.85.1');
    expect(findPackageVersion(codingAgentEntry, '@earendil-works/pi-coding-agent')).toBe('0.85.1');
    expect(findPackageVersion(aiEntry, '@earendil-works/pi-ai')).toBe('0.85.1');
    expect(findPackageVersion(coreEntry, '@earendil-works/pi-agent-core')).toBe('0.85.1');
    expect(typeof createAgentSession).toBe('function');
  });

  it('validates prepared custom-tool input, preserves execution modes, orders results, and awaits listeners', async () => {
    const originalFetch = globalThis.fetch;
    const harness = makeFetchHarness();
    Reflect.set(globalThis, 'fetch', harness.fetch);
    const workspace = await createTempWorkspace();
    const parallelCallsStarted = deferred<void>();
    const secondParallelCallEnded = deferred<void>();
    const releaseFirstParallel = deferred<void>();
    const releaseSecondParallel = deferred<void>();
    const mixedReadStarted = deferred<void>();
    const mixedWriteStarted = deferred<void>();
    const releaseMixedRead = deferred<void>();
    const releaseMixedWrite = deferred<void>();
    const agentEndStarted = deferred<void>();
    const releaseAgentEnd = deferred<void>();
    const parallelValues: number[] = [];
    const mixedOrder: string[] = [];
    const executionEnds: { callId: string; isError: boolean; text: string }[] = [];
    const resultMessageOrder: string[] = [];
    let preparationCount = 0;
    let blockNextAgentEnd = true;
    let session: Awaited<ReturnType<typeof createFixtureSession>>['session'] | undefined;

    const preparedTool = defineTool({
      name: 'probe_prepared',
      label: 'Prepared probe',
      description: 'Controlled tool used to inspect the installed SDK boundary.',
      parameters: Type.Object({ value: Type.Integer() }, { additionalProperties: false }),
      executionMode: 'parallel',
      prepareArguments(raw: unknown) {
        preparationCount++;
        const value = (raw as { rawValue?: string }).rawValue;
        return { value: Number(value) };
      },
      async execute(_toolCallId, params) {
        if (params.value < 3) {
          parallelValues.push(params.value);
          if (parallelValues.length === 2) parallelCallsStarted.resolve();
          await (params.value === 1 ? releaseFirstParallel.promise : releaseSecondParallel.promise);
        } else {
          mixedOrder.push('read');
          mixedReadStarted.resolve();
          await releaseMixedRead.promise;
        }
        return { content: [{ type: 'text', text: `prepared:${params.value}` }], details: { value: params.value }, isError: true };
      },
    });
    const sequentialTool = defineTool({
      name: 'probe_sequential',
      label: 'Sequential probe',
      description: 'Controlled sequential tool used to inspect the installed SDK boundary.',
      parameters: Type.Object({ value: Type.Integer() }, { additionalProperties: false }),
      executionMode: 'sequential',
      async execute(_toolCallId, params) {
        mixedOrder.push('write');
        mixedWriteStarted.resolve();
        await releaseMixedWrite.promise;
        return { content: [{ type: 'text', text: `sequential:${params.value}` }], details: { value: params.value } };
      },
    });
    const failingTool = defineTool({
      name: 'probe_failure',
      label: 'Failure probe',
      description: 'Controlled failing tool used to inspect native error conversion.',
      parameters: Type.Object({ value: Type.Integer() }, { additionalProperties: false }),
      executionMode: 'parallel',
      async execute() { throw new Error('controlled-safe-failure'); },
    });

    try {
      const fixture = await createFixtureRuntime();
      const created = await createFixtureSession(workspace.cwd, workspace.agentDir, fixture.runtime, fixture.model, {
        tools: ['probe_prepared', 'probe_sequential', 'probe_failure'],
        customTools: [preparedTool, sequentialTool, failingTool],
      });
      session = created.session;
      session.agent.toolExecution = 'parallel';
      expect(session.getActiveToolNames()).toEqual(['probe_prepared', 'probe_sequential', 'probe_failure']);
      expect(session.agent.state.tools.map((tool) => [tool.name, tool.executionMode])).toEqual([
        ['probe_prepared', 'parallel'], ['probe_sequential', 'sequential'], ['probe_failure', 'parallel'],
      ]);

      session.agent.subscribe(async (event) => {
        if (event.type === 'tool_execution_end') {
          executionEnds.push({
            callId: event.toolCallId,
            isError: event.isError,
            text: event.result.content
              .filter((part: { type: string; text?: string }) => part.type === 'text')
              .map((part: { type: string; text?: string }) => part.text ?? '').join(''),
          });
          if (event.toolCallId === 'parallel-2') secondParallelCallEnded.resolve();
        }
        if (event.type === 'message_end' && event.message.role === 'toolResult') {
          resultMessageOrder.push(event.message.toolCallId);
        }
        if (event.type === 'agent_end' && blockNextAgentEnd) {
          blockNextAgentEnd = false;
          agentEndStarted.resolve();
          await releaseAgentEnd.promise;
        }
      });

      harness.queueToolCalls([
        { id: 'parallel-1', name: 'probe_prepared', arguments: { rawValue: '1' } },
        { id: 'parallel-2', name: 'probe_prepared', arguments: { rawValue: '2' } },
      ]);
      let firstPromptSettled = false;
      const firstPrompt = session.prompt('Run the two controlled probes.', { expandPromptTemplates: false })
        .then(() => { firstPromptSettled = true; });
      await parallelCallsStarted.promise;
      expect(parallelValues).toEqual([1, 2]);
      releaseSecondParallel.resolve();
      await secondParallelCallEnded.promise;
      expect(executionEnds.map((entry) => entry.callId)).toEqual(['parallel-2']);
      expect(resultMessageOrder).toEqual([]);
      releaseFirstParallel.resolve();
      await agentEndStarted.promise;
      expect(executionEnds.map((entry) => [entry.callId, entry.isError])).toEqual([
        ['parallel-2', false], ['parallel-1', false],
      ]);
      expect(resultMessageOrder).toEqual(['parallel-1', 'parallel-2']);
      expect(executionEnds.every((entry) => entry.text.startsWith('prepared:'))).toBe(true);
      expect(preparationCount).toBe(2);
      expect(session.isIdle).toBe(false);
      expect(firstPromptSettled).toBe(false);
      releaseAgentEnd.resolve();
      await firstPrompt;
      expect(session.isIdle).toBe(true);

      harness.queueToolCalls([
        { id: 'mixed-read', name: 'probe_prepared', arguments: { rawValue: '3' } },
        { id: 'mixed-write', name: 'probe_sequential', arguments: { value: 4 } },
      ]);
      const mixedPrompt = session.prompt('Run a mixed batch.', { expandPromptTemplates: false });
      await mixedReadStarted.promise;
      expect(mixedOrder).toEqual(['read']);
      releaseMixedRead.resolve();
      await mixedWriteStarted.promise;
      expect(mixedOrder).toEqual(['read', 'write']);
      releaseMixedWrite.resolve();
      await mixedPrompt;

      harness.queueToolCalls([{ id: 'native-error', name: 'probe_failure', arguments: { value: 5 } }]);
      await session.prompt('Run a failing probe.', { expandPromptTemplates: false });
      expect(executionEnds.at(-1)).toMatchObject({ callId: 'native-error', isError: true, text: 'controlled-safe-failure' });
      expect(harness.requests).toHaveLength(6);
    } finally {
      if (session && !session.isIdle) await session.abort();
      session?.dispose();
      Reflect.set(globalThis, 'fetch', originalFetch);
      await rm(workspace.root, { recursive: true, force: true });
    }
  });

  it('keeps in-memory histories isolated and sends no default tools or discovered resources', async () => {
    const originalFetch = globalThis.fetch;
    const harness = makeFetchHarness();
    Reflect.set(globalThis, 'fetch', harness.fetch);
    const workspace = await createTempWorkspace();
    const oldExtensionMarker = (globalThis as Record<string, unknown>)[extensionMarker];
    delete (globalThis as Record<string, unknown>)[extensionMarker];
    let sessionA: Awaited<ReturnType<typeof createFixtureSession>>['session'] | undefined;
    let sessionB: Awaited<ReturnType<typeof createFixtureSession>>['session'] | undefined;

    try {
      await writeFile(join(workspace.cwd, 'AGENTS.md'), 'AGENT_DISCOVERY_MARKER');
      await mkdir(join(workspace.cwd, '.pi', 'skills', 'fixture'), { recursive: true });
      await writeFile(join(workspace.cwd, '.pi', 'skills', 'fixture', 'SKILL.md'), 'SKILL_DISCOVERY_MARKER');
      await mkdir(join(workspace.cwd, '.pi', 'extensions'), { recursive: true });
      await writeFile(join(workspace.cwd, '.pi', 'extensions', 'probe.mjs'),
        `export default function register() { globalThis.${extensionMarker} = true; }`);
      await mkdir(workspace.agentDir, { recursive: true });
      await writeFile(join(workspace.agentDir, 'settings.json'), JSON.stringify({ defaultTools: ['read'], compaction: { enabled: true } }));

      const fixture = await createFixtureRuntime();
      const filesBefore = await fileList(workspace.root);
      const a = await createFixtureSession(workspace.cwd, workspace.agentDir, fixture.runtime, fixture.model);
      const b = await createFixtureSession(workspace.cwd, workspace.agentDir, fixture.runtime, fixture.model);
      sessionA = a.session;
      sessionB = b.session;

      expect(harness.requests).toHaveLength(0);
      expect(a.manager.getSessionId()).not.toBe(b.manager.getSessionId());
      expect(a.session.sessionFile).toBeUndefined();
      expect(b.session.sessionFile).toBeUndefined();
      expect(a.session.getActiveToolNames()).toEqual([]);
      expect(b.session.getActiveToolNames()).toEqual([]);
      expect(a.settingsManager.getGlobalSettings().compaction?.enabled).toBe(false);
      expect(a.settingsManager.getGlobalSettings().retry?.enabled).toBe(false);
      expect(a.settingsManager.getGlobalSettings().retry?.provider?.maxRetries).toBe(0);
      expect(await fileList(workspace.root)).toEqual(filesBefore);

      const eventsA: string[] = [];
      const eventsB: string[] = [];
      a.session.subscribe((event) => eventsA.push(event.type));
      b.session.subscribe((event) => eventsB.push(event.type));
      await a.session.prompt('INVOICE_A_MARKER: invoice INV-2048, total 125.00 CNY.', { expandPromptTemplates: false });
      await a.session.prompt('What was the invoice number?', { expandPromptTemplates: false });
      await b.session.prompt('INVOICE_B_MARKER: invoice INV-9001, total 80.00 CNY.', { expandPromptTemplates: false });

      expect(harness.requests).toHaveLength(3);
      expect(harness.requests.map(({ body }) => (body.messages ?? []).filter((message) => message.role !== 'system').length))
        .toEqual([1, 3, 1]);
      expect(JSON.stringify(harness.requests[1].body)).toContain('INVOICE_A_MARKER');
      expect(JSON.stringify(harness.requests[2].body)).not.toContain('INVOICE_A_MARKER');
      expect(harness.requests.every(({ url }) => url.startsWith(endpoint))).toBe(true);
      expect(harness.requests.every(({ body }) => (body.tools ?? []).length === 0)).toBe(true);
      expect(JSON.stringify(harness.requests)).not.toContain('AGENT_DISCOVERY_MARKER');
      expect(JSON.stringify(harness.requests)).not.toContain('SKILL_DISCOVERY_MARKER');
      expect((globalThis as Record<string, unknown>)[extensionMarker]).toBeUndefined();
      expect(eventsA.filter((type) => type === 'agent_start')).toHaveLength(2);
      expect(eventsA.filter((type) => type === 'turn_start')).toHaveLength(2);
      expect(eventsA.filter((type) => type === 'agent_settled')).toHaveLength(2);
      expect(eventsB).toContain('message_start');
      expect(eventsB).toContain('message_end');
      expect(eventsB).toContain('agent_end');
      expect(eventsB).toContain('agent_settled');

      harness.setNextMode('error');
      await b.session.prompt('TRIGGER_NO_AUTOMATIC_RETRY', { expandPromptTemplates: false });
      expect(harness.requests).toHaveLength(4);
      expect(eventsB).not.toContain('auto_retry_start');
      expect(await fileList(workspace.root)).toEqual(filesBefore);
      expect((await fileList(workspace.root)).some((path) => path.endsWith('.jsonl'))).toBe(false);
    } finally {
      if (sessionA && !sessionA.isIdle) await sessionA.abort();
      if (sessionB && !sessionB.isIdle) await sessionB.abort();
      sessionA?.dispose();
      sessionB?.dispose();
      Reflect.set(globalThis, 'fetch', originalFetch);
      if (oldExtensionMarker === undefined) delete (globalThis as Record<string, unknown>)[extensionMarker];
      else (globalThis as Record<string, unknown>)[extensionMarker] = oldExtensionMarker;
      await rm(workspace.root, { recursive: true, force: true });
    }
  });

  it('shows that abort can return while AgentSession prompt is still in preflight', async () => {
    const originalFetch = globalThis.fetch;
    const preflightEntered = deferred<void>();
    const continuePreflight = deferred<void>();
    const requestEntered = deferred<void>();
    const harness = makeFetchHarness(() => requestEntered.resolve());
    Reflect.set(globalThis, 'fetch', harness.fetch);
    const workspace = await createTempWorkspace();
    let session: Awaited<ReturnType<typeof createFixtureSession>>['session'] | undefined;
    let runtime: ModelRuntime | undefined;

    try {
      const fixture = await createFixtureRuntime();
      runtime = fixture.runtime;
      const created = await createFixtureSession(workspace.cwd, workspace.agentDir, fixture.runtime, fixture.model);
      session = created.session;
      const originalHasConfiguredAuth = fixture.runtime.hasConfiguredAuth.bind(fixture.runtime);
      const originalCheckAuth = fixture.runtime.checkAuth.bind(fixture.runtime);
      fixture.runtime.hasConfiguredAuth = () => false;
      fixture.runtime.checkAuth = async (provider, options) => {
        preflightEntered.resolve();
        await continuePreflight.promise;
        return originalCheckAuth(provider, options);
      };

      const prompt = created.session.prompt('PREFLIGHT_CANCEL_MARKER', { expandPromptTemplates: false });
      await preflightEntered.promise;
      await created.session.abort();
      expect(created.session.isIdle).toBe(true);
      expect(harness.requests).toHaveLength(0);

      continuePreflight.resolve();
      await prompt;
      await requestEntered.promise;
      expect(harness.requests).toHaveLength(1);
      expect(created.session.state.messages.at(-1)).toMatchObject({ stopReason: 'stop' });
      expect(created.session.isIdle).toBe(true);

      fixture.runtime.hasConfiguredAuth = originalHasConfiguredAuth;
      fixture.runtime.checkAuth = originalCheckAuth;
    } finally {
      if (session && !session.isIdle) await session.abort();
      session?.dispose();
      Reflect.set(globalThis, 'fetch', originalFetch);
      await rm(workspace.root, { recursive: true, force: true });
    }
  });

  it('waits for a streaming request to abort and for the prompt to settle', async () => {
    const originalFetch = globalThis.fetch;
    const requestEntered = deferred<AbortSignal | null>();
    const harness = makeFetchHarness((signal) => requestEntered.resolve(signal));
    Reflect.set(globalThis, 'fetch', harness.fetch);
    const workspace = await createTempWorkspace();
    const events: string[] = [];
    let session: Awaited<ReturnType<typeof createFixtureSession>>['session'] | undefined;

    try {
      const fixture = await createFixtureRuntime();
      const created = await createFixtureSession(workspace.cwd, workspace.agentDir, fixture.runtime, fixture.model);
      session = created.session;
      created.session.subscribe((event) => events.push(event.type));
      harness.setNextMode('wait-for-abort');
      const prompt = created.session.prompt('CANCEL_DURING_STREAM', { expandPromptTemplates: false });
      const signal = await requestEntered.promise;

      await created.session.abort();
      await prompt;

      expect(signal?.aborted).toBe(true);
      expect(created.session.isIdle).toBe(true);
      expect(created.session.state.messages.at(-1)).toMatchObject({ stopReason: 'aborted' });
      expect(events.filter((type) => type === 'agent_settled')).toHaveLength(1);
    } finally {
      if (session && !session.isIdle) await session.abort();
      session?.dispose();
      Reflect.set(globalThis, 'fetch', originalFetch);
      await rm(workspace.root, { recursive: true, force: true });
    }
  });
});
