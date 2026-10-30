import { createInputDefinitions } from '../packages/core/src/prompt-templates.ts';
import { createPersonalAgentRuntime, type PersonalAgentRuntime, type PersonalAgentRuntimeOptions } from './personal-agent.ts';
import { parseFrontmatter, loadPromptTemplates, expandPromptTemplate } from '@flowmate/runtime-pi';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { existsSync, renameSync, rmSync } from 'node:fs';
import { readProductSettings } from '../packages/core/src/configuration/settings.ts';
import { writeSynced } from '../packages/core/src/skill-hub/resources.ts';
import { prepareStoreUpgrade } from '../packages/core/src/storage/maintenance.ts';
import type { PackagedRelease } from '@flowmate/shared';
import { readResearchEvidence, exportResearchReport } from '@flowmate/core';
import { ResearchEvidenceRequestSchema } from '@flowmate/contracts';
import { createFileStore, createInvoiceEditService, createInvoiceFormService, createJobService, createToolExecutor, createWorkspaceService, createWorkspaceVerifier, makeApplication,
  ContextService, RuntimeService, SessionService, openDatabase, createResourceService, createExtensionService, createSubagentTool, createResearchPlanTool, createResearchReadTools, createResearchSynthesisTools } from '@flowmate/core';
import { createDocumentService } from '@flowmate/data';
import { createInvoiceTools, fillInvoiceForm, listSkillResources, readSkillResource, projectInvoiceDocumentPage, validateHumanInvoiceCandidate } from '@flowmate/employee-invoice';
import { createPromptTraceBuffer, createRuntimeLogBuffer, createProductTraceRecorder } from '@flowmate/logging';
import type { ModelTraceObservation, TraceBundle, RunSnapshot, ToolCallSnapshot, RuntimeEvent } from '@flowmate/contracts';
import { PiAgentAdapter, PiProviderAdapter, createNativeTools, inspectNativeResources, PI_SDK_VERSION } from '@flowmate/runtime-pi';
import { acquireProductControllerLock } from '@flowmate/shared';
import { appError, fail, ok } from '@flowmate/contracts';
import type { Application, ProductPaths, PromptTraceBuffer, ResearchMaterial, Result, RuntimeRequestOverrides, RuntimeStrategyPolicy } from '@flowmate/contracts';
import type { StoredArtifact } from '../packages/core/src/storage/repositories.ts';
import type { AgentPort, InvoiceFormApplicationReceipt, InvoiceFormBridgeRequest, ProviderPort, ToolDefinition } from '@flowmate/contracts';
import type { SafeLogger } from '@flowmate/shared';

export type ApplicationOptions = {
  personalAgent?: Pick<PersonalAgentRuntimeOptions, 'resolveConfiguration' | 'readApiKey' | 'defaultConfiguration'> & {
    onReady?: (control: Pick<PersonalAgentRuntime, 'start' | 'conditionsChanged'>) => void;
  };
  installedRelease?: PackagedRelease;
  resourceRoot?: string;
  resourceDefaults?: () => Result<import('@flowmate/contracts').AssemblySelectionSnapshot | import('@flowmate/contracts').ResourceSelectionResult>;
  saveExtensionSelection?: (request: import('@flowmate/contracts').ExtensionSelectionRequest) => Promise<Result<import('@flowmate/contracts').ExtensionSelectionResult>>;
  saveResourceSelection?: (request: import('@flowmate/contracts').ResourceSelectionRequest) => Promise<Result<import('@flowmate/contracts').ResourceSelectionResult>>;
  paths: ProductPaths;
  invoiceSourceRoot?: string;
  extensionEvaluationProfile?: import('@flowmate/contracts').ExtensionEvaluationProfile;
  caseEvaluationFaultProfile?: import('@flowmate/contracts').CaseEvaluationFaultProfile;
  provider?: ProviderPort;
  agent?: AgentPort;
  agentFactory?: (tools: readonly ToolDefinition<any, any>[], resourceContents: Pick<import('@flowmate/contracts').ManagedFileContents, 'read'> | undefined,
    observeModel?: (value: ModelTraceObservation) => void) => AgentPort;
  traceCapture?: { workspaceRoot: string; enabled(): boolean; secrets?(): readonly string[]; onComplete?(trace: TraceBundle): void };
  systemPromptOverride?: string;
  thinkingLevelOverride?: import('../packages/contracts/src/runtime-evaluation.ts').EvaluationAgentOverrides['reasoning'];
  promptTrace?: PromptTraceBuffer;
  logger?: SafeLogger;
  runtimeDefaults?: () => Result<RuntimeRequestOverrides>;
  runtimePolicy?: RuntimeStrategyPolicy;
  sampleSource?: 'production' | 'test' | 'evaluation';
  toolDefinitions?: (definitions: readonly ToolDefinition<any, any>[]) => readonly ToolDefinition<any, any>[];
  invoiceFormBridge?: (request: InvoiceFormBridgeRequest, signal: AbortSignal) => Promise<InvoiceFormApplicationReceipt>;
  observeCompaction?: (value: import('@flowmate/contracts').CompactionObservation) => void;
};

export async function createApplication(options: ApplicationOptions): Promise<Result<Application>> {
  const lock = await acquireProductControllerLock(options.paths);
  if (!lock.ok) return lock;
  if (options.installedRelease) {
    const prepared = await prepareStoreUpgrade(options.paths, options.installedRelease);
    if (!prepared.ok) { await lock.data.release(); return prepared; }
  }
  const database = openDatabase(options.paths);
  if (!database.ok) {
    await lock.data.release();
    return database;
  }
  const installedSettings = options.installedRelease ? await readProductSettings(join(options.paths.root, 'data/settings.json')) : null;
  if (installedSettings && !installedSettings.ok) {
    await database.data.close(); await lock.data.release(); return installedSettings;
  }
  let logger: SafeLogger;
  try {
    logger = options.logger ?? createRuntimeLogBuffer();
  } catch {
    try { await database.data.close(); } catch { /* preserve logger initialization failure */ }
    await lock.data.release();
    return { ok: false, error: appError('logger_init_failed', 'runtime', '运行日志初始化失败。', true) };
  }
  const promptTrace = options.promptTrace ?? createPromptTraceBuffer();
  const traceRecorder = options.traceCapture ? createProductTraceRecorder({ ...options.traceCapture, productRoot: options.paths.root }) : undefined;
  const observeModel = traceRecorder ? (value: ModelTraceObservation) => traceRecorder.observeModel(value) : undefined;
  let loggerClosed = false;
  let databaseClosed = false;
  const now = () => new Date().toISOString();
  const files = createFileStore(options.paths, database.data);
  const documents = createDocumentService({ paths: options.paths,
    allowedSourceRoot: options.invoiceSourceRoot ?? resolve(process.cwd(), 'data', 'invoices', 'agent-input'),
    files, now,
    transaction: operation => database.data.transaction(scope => operation({ repository: scope.documents,
      files: { read: (artifact, name) => files.read(artifact, name, scope.contents) } })),
  });
  const workspaceVerifier = createWorkspaceVerifier({ inspectMaterial: (ref, scope) => scope ? documents.inspectForWorkspace(ref, {
    repository: scope.documents, files: { read: (artifact, name) => files.read(artifact, name, scope.contents) },
  }) : fail(appError('storage_read_failed', 'storage', 'The current Workspace material scope is unavailable.', true)) });
  const contextService = new ContextService({ store: database.data,
    materials: { inspectParsed: (input, scope) => documents.inspectParsedForContext(input, {
      repository: scope.documents, files: { read: (artifact, name) => files.read(artifact, name, scope.contents) },
    }) } });
  const invoiceEdits = createInvoiceEditService({ database: database.data, files,
    validate: (draft, ref, scope) => validateHumanInvoiceCandidate(draft, ref, {
      readParsedForWorkspace: id => documents.readParsedForWorkspace(id, { repository: scope.documents,
        files: { read: (artifact, name) => files.read(artifact, name, scope.contents) } }),
    }), now });
  const native = createNativeTools({
    getWorkingDirectory: context => database.data.read(scope => scope.toolCalls.getNativeWorkingDirectory(context))
      .catch(() => fail(appError('storage_read_failed', 'storage', 'The owned native working directory could not be read.', true))),
  });
  const invoiceForms = options.invoiceFormBridge ? createInvoiceFormService({ database: database.data,
    bridge: options.invoiceFormBridge, now }) : undefined;
  let agent: import('@flowmate/contracts').AgentPort;
  const researchReads = createResearchReadTools({ database: database.data, files, now,
    readDocument: async (id, context) => {
      const loaded = await database.data.transaction(scope => documents.readParsedForRun(id, context, {
        repository: scope.documents, files: { read: (artifact, name) => files.read(artifact, name, scope.contents) },
      })).catch(() => fail(appError('storage_read_failed', 'storage', 'Research document could not be read.', true)));
      return loaded.ok ? ok({ text: loaded.data.parsed.pages.map(page => `[Page ${page.page}]\n${page.blocks.map(block => block.text).join('\n')}`).join('\n\n'),
        artifactId: loaded.data.document.parsedArtifactId, title: `Document ${id}` }) : loaded;
    } });
  const researchSynthesis = createResearchSynthesisTools({ database: database.data, files, now });
  const assembled = [createResearchPlanTool(database.data, now), ...researchReads, ...researchSynthesis, ...createInvoiceTools({
    documents: { readParsedForRun: (id, context) => database.data.transaction(scope => documents.readParsedForRun(id, context, {
      repository: scope.documents, files: { read: (artifact, name) => files.read(artifact, name, scope.contents) },
    })).catch(() => fail(appError('storage_read_failed', 'storage', 'Invoice material could not be read.', true))) },
    documentRepository: { get: id => database.data.read(scope => scope.documents.get(id))
      .catch(() => fail(appError('storage_read_failed', 'storage', 'Invoice metadata could not be read.', true))) },
    candidates: {
      save: (input, call) => database.data.transaction(scope => {
        if (call.signal.aborted) return fail(appError('agent_cancelled', 'runtime', 'The run was cancelled; no candidate was saved.', false,
          input.runId, input.sessionId, call.nativeToolCallId));
        if (call.deadlineAt !== undefined && performance.now() >= call.deadlineAt)
          return fail(appError('tool_timeout', 'tool', 'The tool deadline elapsed; no candidate was saved.', true,
            input.runId, input.sessionId, call.nativeToolCallId));
        return scope.candidates.save(input);
      })
        .catch(() => fail(appError('storage_write_failed', 'storage', 'Invoice candidate could not be saved.', true))),
      listForRun: input => database.data.read(scope => scope.candidates.listForRun(input))
        .catch(() => fail(appError('storage_read_failed', 'storage', 'Invoice candidates could not be read.', true))),
      readForRun: input => database.data.read(scope => scope.candidates.readForRun(input))
        .catch(() => fail(appError('storage_read_failed', 'storage', 'Invoice candidate could not be read.', true))),
    }, now }), listSkillResources((input, context) => database.data.read(scope => resources.listSkillResources(input, context, scope))
      .catch(() => fail(appError('storage_read_failed', 'storage', 'Owned Skill metadata could not be read.', true)))),
    readSkillResource((input, context) => database.data.read(scope => resources.readSkillResource(input, context, scope))
      .catch(() => fail(appError('storage_read_failed', 'storage', 'Owned Skill resource could not be read.', true)))),
    ...(invoiceForms ? [fillInvoiceForm(invoiceForms)] : []), createSubagentTool(() => agent), ...native.definitions];
  const definitions = Object.freeze([...(options.toolDefinitions?.(assembled) ?? assembled)]);
  const unavailableTools = new Set(native.availability.filter(item => !item.available).map(item => item.name as string));
  const resources = createResourceService({ resourceRoot: options.resourceRoot ?? fileURLToPath(new URL('../resources/', import.meta.url)),
    bundleRoot: join(options.paths.runtimeDir, 'resource-bundles'),
    registeredToolNames: definitions.filter(tool => !unavailableTools.has(tool.name)).map(tool => tool.name), inspectNativeResources,
  });
  const extensions = createExtensionService({ resourceRoot: options.resourceRoot ?? fileURLToPath(new URL('../resources/', import.meta.url)),
    sdkVersion: PI_SDK_VERSION, registeredTools: definitions, evaluationProfile: options.extensionEvaluationProfile });
  const inputDefinitions = createInputDefinitions({ resourceRoot: options.resourceRoot ?? fileURLToPath(new URL('../resources/', import.meta.url)),
    runtimeRoot: options.paths.runtimeDir, tools: assembled, parseFrontmatter, loadPromptTemplates, expandPromptTemplate });
  const toolExecutor = createToolExecutor({ definitions, database: database.data,
    caseFaultProfile:options.caseEvaluationFaultProfile,
    strategyPolicy: options.runtimePolicy, sampleSource: options.sampleSource,
    now,
    monotonicNow: () => performance.now() });
  const provider = options.provider ?? new PiProviderAdapter();
  // RuntimeService supplies the Run-owned resource snapshot to prepare.
  agent = options.agentFactory?.(definitions, undefined, observeModel) ?? options.agent ?? new PiAgentAdapter({ cwd: options.paths.runtimeDir, agentDir: options.paths.runtimeDir, promptTrace, observeModel,
    resourceBundleRoot: join(options.paths.runtimeDir, 'resource-bundles'),
    tools: definitions });
  let sessionService: SessionService;
  let personalRuntime: PersonalAgentRuntime | undefined;
  const runtime = new RuntimeService({
    database: database.data,
    recoveryError: database.data.recoveryError,
    workspaceVerifier,
    contextService,
    resources,
    extensions,
    resourceDefaults: options.resourceDefaults,
    inputDefinitions,
    isSessionManaging: sessionId => sessionService?.isManaging(sessionId) ?? false,
    provider,
    agent,
    runtimeDefaults: options.runtimeDefaults,
    systemPromptOverride: options.systemPromptOverride,
    thinkingLevelOverride: options.thinkingLevelOverride,
    observeCompaction: value => {
      try { traceRecorder?.observeCompaction(value, now()); }
      catch { try { logger.write({ at: now(), component: 'evaluation', level: 'warn', event: 'evaluation_compaction_trace_failed' }); } catch { /* Capture cannot affect native saving. */ } }
      options.observeCompaction?.(value);
    },
    onAdmissionChanged: () => personalRuntime?.conditionsChanged(),
    runtimePolicy: options.runtimePolicy, sampleSource: options.sampleSource,
    log: logger,
    now,
    monotonicNow: () => performance.now(),
    tools: toolExecutor,
    nativeTools: { runtimeDir: options.paths.runtimeDir,
      availability: native.availability.filter(item => definitions.some(definition => definition.name === item.name)) },
  });
  sessionService = new SessionService(agent, () => runtime.state(), now, database.data, (request, submission, control) => runtime.start(request, control, submission),
    request => runtime.appendInput(request), (sessionId, intent, repository) => runtime.verifySessionMutation(sessionId, intent, repository));
  const workspaceService = createWorkspaceService(database.data, now, workspaceVerifier);
  const jobService = createJobService(database.data, now);
  if (options.personalAgent) {
    const personal = await createPersonalAgentRuntime({ ...options.personalAgent, database: database.data, definitions,
      now, runtimeDefaults: options.runtimeDefaults, resourceRoot: options.resourceRoot ?? fileURLToPath(new URL('../resources/', import.meta.url)),
      bundleRoot: join(options.paths.runtimeDir, 'resource-bundles'),
      foregroundBusy: () => { const state = runtime.state(); return state.active !== null || state.blocked; },
      onError: error => { logger.write({ at: now(), level: 'error', component: 'personal_agent', event: 'coordination_failed', code: error.code }); },
    });
    if (!personal.ok) {
      await runtime.close(); await database.data.close(); await logger.close(); await lock.data.release(); return personal;
    }
    personalRuntime = personal.data;
  }
  const pendingTraces = new Set<number>();
  let traceFlushScheduled = false;
  let traceFlush = Promise.resolve();
  const flushTraces = async () => {
    traceFlushScheduled = false;
    if (!traceRecorder || databaseClosed) return;
    const pending = [...pendingTraces]; pendingTraces.clear();
    if (!pending.length) return;
    try {
      const captures = await database.data.read(scope => {
        const captures: Parameters<typeof traceRecorder.complete>[0][] = [];
        const roots = new Set<number>();
        for (const runId of pending) {
          const current = scope.runs.get(runId);
          if (!current.ok) continue;
          const loaded = current.data.kind === 'subagent' ? scope.runs.get(current.data.parentRunId) : current;
          if (!loaded.ok || loaded.data.kind !== 'agent' || !loaded.data.endedAt || roots.has(loaded.data.runId)) continue;
          const run = loaded.data, children: RunSnapshot[] = [], tools: ToolCallSnapshot[] = [], events: RuntimeEvent[] = [], gaps: string[] = [];
          roots.add(run.runId);
          let beforeRunId: number | undefined;
          do {
            const page = scope.runs.listSubagents({ parentRunId: run.runId, beforeRunId, limit: 100 });
            if (!page.ok) { gaps.push('children-read-failed'); break; }
            for (const item of page.data.items) { const child = scope.runs.get(item.childRunId);
              if (child.ok) children.push(child.data); else gaps.push('child-read-failed:' + item.childRunId); }
            beforeRunId = page.data.nextBeforeRunId ?? undefined;
          } while (beforeRunId !== undefined);
          for (const current of [run, ...children]) {
            let beforeId: number | undefined;
            do {
              const page = scope.toolCalls.list({ runId: current.runId, beforeId, limit: 100 });
              if (!page.ok) { gaps.push('tools-read-failed:' + current.runId); break; }
              tools.push(...page.data.items); beforeId = page.data.nextBeforeId ?? undefined;
            } while (beforeId !== undefined);
            let cursor = { runId: current.runId, lastPersistedSequence: 0 }, hasMore = true;
            while (hasMore) {
              const page = scope.runtimeEventStore.query({ runId: current.runId, sessionId: current.sessionId, cursor, limit: 100 });
              if (!page.ok) { gaps.push('events-read-failed:' + current.runId); break; }
              if (page.data.coverage !== 'from-created') gaps.push('events-incomplete:' + current.runId);
              events.push(...page.data.items); cursor = page.data.nextCursor; hasMore = page.data.hasMore;
            }
          }
          const inputs = scope.sessionInputs.forRun(run.runId), research = scope.research.bindingForRun(run.runId);
          if (!inputs.ok) gaps.push('inputs-read-failed');
          if (!research.ok) gaps.push('research-binding-read-failed');
          const turns = inputs.ok ? inputs.data.filter(item => item.status === 'consumed')
            .sort((a, b) => (a.dispatchedAt ?? a.createdAt).localeCompare(b.dispatchedAt ?? b.createdAt) || a.inputId - b.inputId).slice(1).map(item => ({
            id: 'input-' + item.inputId, role: 'user' as const, content: item.content.text, mode: item.mode })) : undefined;
          const invoice = inputs.ok && inputs.data.some(item => item.content.version === 2 && item.content.workspaceInput !== null);
          captures.push({ run, children, tools, events, ...(turns?.length ? { turns } : {}), gaps,
            entry: research.ok && research.data ? 'research' : invoice ? 'invoices' : 'chats' });
        }
        return captures;
      });
      for (const capture of captures) traceRecorder.complete(capture);
    } catch { try { logger.write({ at: now(), component: 'evaluation', level: 'warn', event: 'evaluation_trace_failed' }); }
      catch { /* capture observers cannot interrupt an authorized run */ } }
  };
  const detachTrace = traceRecorder ? await database.data.read(scope => scope.runtimeEventStore.onCommitted(refs => {
    if (!options.traceCapture?.enabled()) return;
    for (const ref of refs) pendingTraces.add(ref.runId);
    if (!traceFlushScheduled) { traceFlushScheduled = true; traceFlush = traceFlush.then(flushTraces); }
  })) : undefined;
  const application = makeApplication(runtime, {
    get: runId => database.data.read(scope => scope.runs.get(runId))
      .catch(() => fail(appError('storage_read_failed', 'storage', 'Run query could not be completed.', true))),
    listBySession: input => database.data.read(scope => scope.runs.listBySession(input))
      .catch(() => fail(appError('storage_read_failed', 'storage', 'Session Runs could not be read.', true))),
    listSubagents: input => database.data.read(scope => scope.runs.listSubagents(input))
      .catch(() => fail(appError('storage_read_failed', 'storage', 'Child Runs could not be listed.', true))),
    querySubagent: input => database.data.read(scope => scope.runs.querySubagent(input))
      .catch(() => fail(appError('storage_read_failed', 'storage', 'Child Run could not be read.', true))),
  }, async () => {
    const errors = [];
    detachTrace?.(); await traceFlush; await flushTraces();
    personalRuntime = undefined;
    if (!loggerClosed) {
      try { await logger.close(); loggerClosed = true; } catch { errors.push(appError('logger_close_failed', 'runtime', '日志资源关闭失败。', true)); }
    }
    if (!databaseClosed) {
      try { await database.data.close(); databaseClosed = true; } catch { errors.push(appError('database_close_failed', 'storage', '数据库资源关闭失败。', true)); }
    }
    let lockReleased = false;
    if (loggerClosed && databaseClosed) {
      const released = await lock.data.release();
      lockReleased = released.ok;
      if (!released.ok) errors.push(released.error);
    }
    return { stopped: true, closed: loggerClosed && databaseClosed && lockReleased, errors };
  }, sessionService, promptTrace, workspaceService, jobService, {
    personal: personalRuntime ? { ...personalRuntime.personal, close: personalRuntime.close } : undefined,
    resources: {
      catalog: input => database.data.read(scope => resources.catalog(input, scope.contents))
        .catch(() => fail(appError('storage_read_failed', 'storage', 'Resources could not be listed.', true))),
      readFile: (input, selection, extensions) => database.data.read(scope => resources.readFile(input, selection, extensions, scope.contents))
        .catch(() => fail(appError('storage_read_failed', 'storage', 'Resource content could not be read.', true))),
      verifyFrozen: fixed => database.data.read(scope => resources.verifyFrozen(fixed, scope.contents))
        .catch(() => fail(appError('storage_read_failed', 'storage', 'Original resources could not be verified.', true))),
      readFrozenFile: (fixed, input) => database.data.read(scope => resources.readFrozenFile(fixed, input, scope.contents))
        .catch(() => fail(appError('storage_read_failed', 'storage', 'Original resource content could not be read.', true))),
      validateSelection: (selection, extensions) => database.data.read(scope => resources.validateSelection(selection, extensions, scope.contents))
        .catch(() => fail(appError('storage_read_failed', 'storage', 'Resource selection could not be verified.', true))),
    },
    extensions,
    resourceDefaults: options.resourceDefaults,
    inputDefinitions,
    saveResourceSelection: options.saveResourceSelection,
    saveExtensionSelection: options.saveExtensionSelection,
    documents: {
      list: input => database.data.read(scope => scope.documents.list(input))
        .catch(() => fail(appError('storage_read_failed', 'storage', 'Documents could not be listed.', true))),
      get: id => database.data.read(scope => scope.documents.get(id))
        .catch(() => fail(appError('storage_read_failed', 'storage', 'Document could not be read.', true))),
    },
    jobs: {
      list: input => database.data.read(scope => scope.jobs.list(input))
        .catch(() => fail(appError('storage_read_failed', 'storage', 'Jobs could not be listed.', true))),
      get: id => database.data.read(scope => scope.jobs.get(id))
        .catch(() => fail(appError('storage_read_failed', 'storage', 'Job could not be read.', true))),
    },
    research: {
      create: async input => {
        let rejected: Result<never> | undefined;
        try { return await database.data.transaction(scope => {
          const value = scope.research.create(input);
          if (!value.ok) { rejected = value; throw Error('research_create_rejected'); }
          return value;
        }); } catch { return rejected ?? fail(appError('research_write_failed', 'storage', 'Research creation could not be confirmed.', true)); }
      },
      listMaterials: input => database.data.read(scope => scope.research.listMaterials(input))
        .catch(() => fail(appError('research_read_failed', 'storage', 'Research materials could not be read.', true))),
      get: id => database.data.read(scope => scope.research.get(id))
        .catch(() => fail(appError('research_read_failed', 'storage', 'Research task could not be read.', true))),
      forSession: id => database.data.read(scope => scope.research.forSession(id))
        .catch(() => fail(appError('research_read_failed', 'storage', 'Session research could not be read.', true))),
      list: input => database.data.read(scope => scope.research.list(input))
        .catch(() => fail(appError('research_read_failed', 'storage', 'Research tasks could not be read.', true))),
      getPlan: input => database.data.read(scope => scope.research.getPlan(input))
        .catch(() => fail(appError('research_read_failed', 'storage', 'Research plan could not be read.', true))),
      getSource: input => database.data.read(scope => scope.research.getSource(input))
        .catch(() => fail(appError('research_read_failed', 'storage', 'Research source could not be read.', true))),
      getClaim: input => database.data.read(scope => scope.research.getClaim(input))
        .catch(() => fail(appError('research_read_failed', 'storage', 'Research Claim could not be read.', true))),
      getReport: input => database.data.read(scope => scope.research.getReport(input))
        .catch(() => fail(appError('research_read_failed', 'storage', 'Research report could not be read.', true))),
      listSources: input => database.data.read(scope => scope.research.listSources(input))
        .catch(() => fail(appError('research_read_failed', 'storage', 'Research sources could not be read.', true))),
      listClaims: input => database.data.read(scope => scope.research.listClaims(input))
        .catch(() => fail(appError('research_read_failed', 'storage', 'Research Claims could not be read.', true))),
      listReports: input => database.data.read(scope => scope.research.listReports(input))
        .catch(() => fail(appError('research_read_failed', 'storage', 'Research reports could not be read.', true))),
    },
    exportResearchReport: async input => await exportResearchReport({ database: database.data, files }, input),
    queryResearchEvidence: async input => {
      const parsed = ResearchEvidenceRequestSchema.safeParse(input);
      if (!parsed.success) return fail(appError('input_invalid', 'input', 'Evidence request is invalid.'));
      const task = await database.data.read(scope => scope.research.get(parsed.data.researchId))
        .catch(() => fail(appError('research_read_failed', 'storage', 'Research policy could not be read.', true)));
      return task.ok ? await readResearchEvidence({ database: database.data, files }, parsed.data, task.data.sourcePolicy) : task;
    },
    importResearchMaterial: async input => await files.publishResearchMaterial({ ...input, at: now() }, {
      findExisting: async (): Promise<Result<ResearchMaterial | null>> => {
        const found = await database.data.read(scope => {
          const materials = scope.research.findMaterials({ title: input.title, format: input.format });
          if (!materials.ok) return materials;
          const entries: Array<{ material: ResearchMaterial; artifact: StoredArtifact; name: string; original: Uint8Array | null }> = [];
          for (const material of materials.data) {
            if (material.verificationGap === 'legacy-original-unavailable') continue;
            const artifact = scope.documents.getArtifact(material.artifactId); if (!artifact.ok) return artifact;
            const name = material.format === 'markdown' ? 'source.md' : 'source.txt';
            entries.push({ material, artifact: artifact.data, name, original: scope.contents.read({ ownerKind: 'artifact',
              ownerId: String(material.artifactId), relativePath: name }) });
          }
          return ok(entries);
        }).catch(() => fail(appError('research_read_failed', 'storage', 'Research material originals could not be read.', true)));
        if (!found.ok) return found;
        const content = Buffer.from(input.text, 'utf8');
        for (const entry of found.data) {
          const body = files.read(entry.artifact, undefined, { read: owner => owner.ownerKind === 'artifact'
            && owner.ownerId === String(entry.material.artifactId) && owner.relativePath === entry.name ? entry.original : null });
          if (!body.ok) return body;
          if (Buffer.from(body.data).equals(content)) return ok(entry.material);
        }
        return ok(null);
      },
      register: async published => {
        let rejected: Result<never> | undefined;
        try { return await database.data.transaction(scope => {
          const value = scope.research.registerMaterial(published);
          if (!value.ok) { rejected = value; throw Error('research_material_rejected'); }
          return value;
        }); } catch { return rejected ?? fail(appError('research_write_failed', 'storage', 'Research material registration could not be confirmed.', true)); }
      },
    }),
    candidates: {
      listByJob: input => database.data.read(scope => scope.candidates.listByJob(input))
        .catch(() => fail(appError('storage_read_failed', 'storage', 'Job candidates could not be listed.', true))),
      readByJob: input => database.data.read(scope => scope.candidates.readByJob(input))
        .catch(() => fail(appError('storage_read_failed', 'storage', 'Job candidate could not be read.', true))),
    },
    events: { list: input => database.data.read(scope => scope.businessEvents.list(input))
      .catch(() => fail(appError('storage_read_failed', 'storage', 'Activity could not be read.', true))) },
    runtimeEvents: database.data.runtimeEvents,
    toolCalls: {
      list: input => database.data.read(scope => scope.toolCalls.list(input))
        .catch(() => fail(appError('storage_read_failed', 'storage', 'Tool calls could not be listed.', true))),
      getById: id => database.data.read(scope => scope.toolCalls.getById(id))
        .catch(() => fail(appError('storage_read_failed', 'storage', 'Tool call could not be read.', true))),
      request: input => database.data.transaction(scope => scope.toolCalls.request(input))
        .catch(() => fail(appError('storage_write_failed', 'storage', 'Original tool request could not be confirmed.', true))),
      fixArguments: input => database.data.transaction(scope => scope.toolCalls.fixArguments(input))
        .catch(() => fail(appError('storage_write_failed', 'storage', 'Original tool arguments could not be confirmed.', true))),
    },
    contextService,
    contextRepository: { readResourceEvidence: input => database.data.read(scope => scope.context.readResourceEvidence(input))
      .catch(() => fail(appError('storage_read_failed', 'storage', 'Resource evidence could not be read.', true))) },
    ...(invoiceForms ? { invoiceForms } : {}),
    invoiceEdits,
    importInvoiceMaterial: (sourceDirectory) => documents.importVoxel51({ sourceDirectory }),
    importPreparedInvoiceMaterial: (input) => documents.importPrepared(input),
    hideDocument: (documentId) => database.data.transaction(scope => scope.documents.hide(documentId, now()))
      .catch(() => fail(appError('storage_write_failed', 'storage', 'Document removal could not be saved.', true))),
    listDocumentPages: (input) => database.data.transaction(scope => {
      const loaded = documents.readParsedForWorkspace(input.documentId, { repository: scope.documents,
        files: { read: (artifact, name) => files.read(artifact, name, scope.contents) } });
      return loaded.ok ? ok({ documentRef: loaded.data.document.documentRef,
        parsedArtifactId: loaded.data.document.parsedArtifactId, pageCount: loaded.data.parsed.pages.length,
        pages: loaded.data.parsed.pages.map(page => ({ page: page.page, blockCount: page.blocks.length,
          tableCount: page.blocks.filter(block => block.kind === 'table').length })) }) : loaded;
    }).catch(() => fail(appError('storage_read_failed', 'storage', 'Document pages could not be read.', true))),
    readDocumentPage: (input) => database.data.transaction(scope => {
      const loaded = documents.readParsedForWorkspace(input.documentId, { repository: scope.documents,
        files: { read: (artifact, name) => files.read(artifact, name, scope.contents) } });
      return loaded.ok ? projectInvoiceDocumentPage(input, loaded.data) : loaded;
    }).catch(() => fail(appError('storage_read_failed', 'storage', 'Document page could not be read.', true))),
    readDocumentOriginal: async (documentId, page) => {
      const image = await documents.readOriginalForWorkspace(documentId, page);
      return image.ok ? ok({ documentRef: image.data.documentRef, mimeType: image.data.mimeType,
        base64: Buffer.from(image.data.bytes).toString('base64') }) : image;
    },
  }, database.data.maxRunIdAtBoot);
  if (options.installedRelease && installedSettings?.ok) {
    const write = (name: string, value: unknown) => {
      const target = join(options.paths.root, 'data', name), temporary = `${target}.${randomUUID()}.tmp`;
      try { writeSynced(temporary, `${JSON.stringify(value, null, 2)}\n`); renameSync(temporary, target); }
      finally { if (existsSync(temporary)) rmSync(temporary); }
    };
    try {
      if (!existsSync(join(options.paths.root, 'data/settings.json'))) write('settings.json', installedSettings.data);
      write('installed-release.json', { version: 1, releaseId: options.installedRelease.releaseId,
        productVersion: options.installedRelease.productVersion, schemaVersion: 21, settingsVersion: 7 });
    } catch {
      await application.close();
      return fail(appError('maintenance_release_record_failed', 'storage', 'The installed release could not be recorded; original data and backups were retained.', true));
    }
  }
  if (personalRuntime) {
    if (options.personalAgent?.onReady) options.personalAgent.onReady(personalRuntime);
    else {
      const started = await personalRuntime.start();
      if (!started.ok) { await application.close(); return started; }
    }
  }
  return ok(application);
}
