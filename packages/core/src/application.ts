import type { InputDefinitions } from './prompt-templates.ts';
import { parsePersonalAgentCommand, parsePersonalAgentHostResult, matchesPersonalAgentResponse,
  personalAgentHostFailure, type PersonalAgentCommandType } from '../../contracts/src/personal-agent-commands.ts';
import { PersonalTaskIdentitySchema, type PersonalAgentApi, type InvoiceWorksApi, type PersonalTasksApi } from '../../contracts/src/personal-agent.ts';
import { ResearchSessionRequestSchema, ResearchSessionResultSchema, ResearchPageRequestSchema, ResearchEvidenceRequestSchema,
  PreparedInvoiceMaterialSchema, InvoiceSaveReplayRequestSchema } from '@flowmate/contracts';
import { isDeepStrictEqual } from 'node:util';
import {
  appError,
  fail,
  normalizeAgentRunRequest,
  normalizeProviderRequest,
  normalizeCreateSessionRequest,
  normalizeRenameSessionRequest,
  normalizeSessionId,
  normalizeListSessionsRequest,
  normalizeSessionRunsRequest,
  normalizeSessionMessagesRequest,
  invoiceToolSchemas,
  RunToolCallsRequestSchema,
  RunToolCallRequestSchema,
  RuntimeToolViewSchema,
  RuntimeToolPageSchema,
  ToolEvidenceRequestSchema, ToolEvidencePageSchema, ToolCallSnapshotSchema,
  ContextSnapshotsResultSchema,
  ContextSnapshotResultSchema,
  ContextRequestsResultSchema,
  normalizeSessionCompactionRequest,
  normalizeSessionCompactionQuery,
  normalizeSessionCompactionCancel,
  ok,
  SessionExtensionQuerySchema, SessionExtensionResultSchema, RunExtensionQuerySchema, RunExtensionResultSchema,
  ExtensionCommandRequestSchema, ExtensionCommandResultSchema, ExtensionDisposeRequestSchema, ExtensionDisposeResultSchema,
  FrozenExtensionsSchema, ExtensionAssemblyEvidenceSchema,
  AssemblySelectionSnapshotSchema, EMPTY_EXTENSION_SELECTION, ExtensionCatalogResultSchema, ExtensionSelectionRequestSchema, ExtensionSelectionResponseSchema,
  EMPTY_RESOURCE_SELECTION, ResourceSelectionRequestSchema, ResourceFileRequestSchema,
  ResourceSelectionResultSchema, ResourceCatalogResultSchema, ResourceFileResultSchema, ResourceSelectionResponseSchema,
  RunResourceQuerySchema, RunResourceFileRequestSchema, RunResourceResultSchema, FrozenResourcesSchema,
  CancelSubagentRequestSchema, SubagentCancelReceiptSchema, ListSubagentsRequestSchema, QuerySubagentRequestSchema,
  SubagentPageResultSchema, SubagentDetailResultSchema,
} from '@flowmate/contracts';
import type {
  AgentControl,
  AgentRunRequest,
  Application,
  CandidateRepository,
  CloseReport,
  DbId,
  ListSessionsRequest,
  NormalizedAgentRunRequest,
  ProviderControl,
  ProviderOutcome,
  ProviderRequest,
  PromptTraceBuffer,
  Result,
  RunAccepted,
  RunSnapshot,
  RuntimeState,
  SessionPage,
  SessionRunsPage,
  SessionRunsRequest,
  SessionSnapshot,
  NativeToolAvailability,
  ToolCallSnapshot,
  RuntimeToolView,
} from '@flowmate/contracts';
import type { BusinessEventRepository, DocumentRepository, JobRepository, RunRepository, ToolCallRepository } from './storage/repositories.ts';
import type { EventService } from './events/service.ts';
import type { SessionService } from './sessions/service.ts';
import type { WorkspaceService } from './workspace/service.ts';
import type { JobService } from './jobs/service.ts';
import type { InvoiceFormService } from './tools/invoice-form.ts';
import type { InvoiceEditService } from './invoice-edit/service.ts';
import type { ContextService } from './context/service.ts';
import type { ContextRepository } from './context/repository.ts';
import type { z } from 'zod';
import type { createResourceService } from './skill-hub/index.ts';
import type { ResourceSelectionRequest, ResourceSelectionResult, AssemblySelectionSnapshot, ExtensionSelectionRequest, ExtensionSelectionResult } from '@flowmate/contracts';
import type { ExtensionService } from './extensions/service.ts';
import type { ResearchRepository } from './research/repository.ts';
import { ResearchTasksResultSchema, ResearchTaskResultSchema, ResearchPlanResultSchema, ResearchSourceResultSchema,
  ResearchClaimResultSchema, ResearchReportResultSchema, ResearchSourcesResultSchema, ResearchClaimsResultSchema, ResearchReportsResultSchema,
  ResearchPlanRequestSchema, ResearchSourceRequestSchema, ResearchClaimRequestSchema, ResearchReportRequestSchema,
  ResearchSourcesRequestSchema, ResearchClaimsRequestSchema, CreateResearchTaskSchema, ImportResearchMaterialSchema,
  ResearchMaterialResultSchema, ResearchMaterialsResultSchema } from '@flowmate/contracts';

export interface RuntimeServicePort {
  compactSession: Application['compactSession'];
  querySessionCompaction: Application['querySessionCompaction'];
  cancelSessionCompaction: Application['cancelSessionCompaction'];
  callProvider(
    request: ProviderRequest,
    control?: ProviderControl,
  ): Promise<Result<ProviderOutcome>>;
  start(request: NormalizedAgentRunRequest, control?: AgentControl): Promise<Result<RunAccepted>>;
  queryNativeTools?(): Result<readonly NativeToolAvailability[]>;
  cancel(runId: DbId): Result<{ runId: DbId; accepted: boolean }> | Promise<Result<{ runId: DbId; accepted: boolean }>>;
  cancelSubagent?(request: import('@flowmate/contracts').CancelSubagentRequest): Result<import('@flowmate/contracts').SubagentCancelReceipt>
    | Promise<Result<import('@flowmate/contracts').SubagentCancelReceipt>>;
  revokeDocumentUse(documentId: DbId): Promise<Result<{ affectedSessionIds: DbId[]; stopRequested: boolean }>>;
  state(): RuntimeState;
  close(): Promise<CloseReport>;
}

export type RunQueryPort = {
  get(...input: Parameters<RunRepository['get']>): ReturnType<RunRepository['get']> | Promise<ReturnType<RunRepository['get']>>;
  listBySession?: (...input: Parameters<RunRepository['listBySession']>) => ReturnType<RunRepository['listBySession']> | Promise<ReturnType<RunRepository['listBySession']>>;
  listSubagents?: (...input: Parameters<RunRepository['listSubagents']>) => ReturnType<RunRepository['listSubagents']> | Promise<ReturnType<RunRepository['listSubagents']>>;
  querySubagent?: (...input: Parameters<RunRepository['querySubagent']>) => ReturnType<RunRepository['querySubagent']> | Promise<ReturnType<RunRepository['querySubagent']>>;
};

export type DisposeResources = () => Promise<CloseReport>;
type ResourceService = ReturnType<typeof createResourceService>;
type ResourceQueryPort = { [K in 'catalog' | 'readFile' | 'verifyFrozen' | 'readFrozenFile' | 'validateSelection']:
  (...input: Parameters<ResourceService[K]>) => ReturnType<ResourceService[K]> | Promise<ReturnType<ResourceService[K]>> };
export type ProductApplicationOptions = {
  personal?: { agent: PersonalAgentApi; works: InvoiceWorksApi; tasks: PersonalTasksApi; close?: () => Promise<Result<void>> };
  research?: {
    listMaterials(...input: Parameters<ResearchRepository['listMaterials']>): ReturnType<ResearchRepository['listMaterials']> | Promise<ReturnType<ResearchRepository['listMaterials']>>;
    create(...input: Parameters<ResearchRepository['create']>): ReturnType<ResearchRepository['create']> | Promise<ReturnType<ResearchRepository['create']>>;
    get(...input: Parameters<ResearchRepository['get']>): ReturnType<ResearchRepository['get']> | Promise<ReturnType<ResearchRepository['get']>>;
    forSession(...input: Parameters<ResearchRepository['forSession']>): ReturnType<ResearchRepository['forSession']> | Promise<ReturnType<ResearchRepository['forSession']>>;
    list(...input: Parameters<ResearchRepository['list']>): ReturnType<ResearchRepository['list']> | Promise<ReturnType<ResearchRepository['list']>>;
    getPlan(...input: Parameters<ResearchRepository['getPlan']>): ReturnType<ResearchRepository['getPlan']> | Promise<ReturnType<ResearchRepository['getPlan']>>;
    getSource(...input: Parameters<ResearchRepository['getSource']>): ReturnType<ResearchRepository['getSource']> | Promise<ReturnType<ResearchRepository['getSource']>>;
    getClaim(...input: Parameters<ResearchRepository['getClaim']>): ReturnType<ResearchRepository['getClaim']> | Promise<ReturnType<ResearchRepository['getClaim']>>;
    getReport(...input: Parameters<ResearchRepository['getReport']>): ReturnType<ResearchRepository['getReport']> | Promise<ReturnType<ResearchRepository['getReport']>>;
    listSources(...input: Parameters<ResearchRepository['listSources']>): ReturnType<ResearchRepository['listSources']> | Promise<ReturnType<ResearchRepository['listSources']>>;
    listClaims(...input: Parameters<ResearchRepository['listClaims']>): ReturnType<ResearchRepository['listClaims']> | Promise<ReturnType<ResearchRepository['listClaims']>>;
    listReports(...input: Parameters<ResearchRepository['listReports']>): ReturnType<ResearchRepository['listReports']> | Promise<ReturnType<ResearchRepository['listReports']>>;
  };
  queryResearchEvidence?: (input: import('zod').z.input<typeof import('@flowmate/contracts').ResearchEvidenceRequestSchema>) => Result<import('zod').z.infer<typeof import('@flowmate/contracts').ResearchEvidenceSchema>> | Promise<Result<import('zod').z.infer<typeof import('@flowmate/contracts').ResearchEvidenceSchema>>>;
  exportResearchReport?: (input: import('zod').z.infer<typeof import('@flowmate/contracts').ResearchReportRequestSchema>) => Result<import('@flowmate/contracts').ResearchExport> | Promise<Result<import('@flowmate/contracts').ResearchExport>>;
  importResearchMaterial?: (input: import('@flowmate/contracts').ImportResearchMaterialRequest) => Result<import('@flowmate/contracts').ResearchMaterial> | Promise<Result<import('@flowmate/contracts').ResearchMaterial>>;
  inputDefinitions?: InputDefinitions;
  resources?: ResourceQueryPort;
  extensions?: ExtensionService;
  resourceDefaults?: () => Result<AssemblySelectionSnapshot | ResourceSelectionResult>;
  saveExtensionSelection?: (input: ExtensionSelectionRequest) => Promise<Result<ExtensionSelectionResult>>;
  saveResourceSelection?: (input: ResourceSelectionRequest) => Promise<Result<ResourceSelectionResult>>;
  documents: {
    list(...input: Parameters<DocumentRepository['list']>): ReturnType<DocumentRepository['list']> | Promise<ReturnType<DocumentRepository['list']>>;
    get(...input: Parameters<DocumentRepository['get']>): ReturnType<DocumentRepository['get']> | Promise<ReturnType<DocumentRepository['get']>>;
  };
  jobs: {
    list(...input: Parameters<JobRepository['list']>): ReturnType<JobRepository['list']> | Promise<ReturnType<JobRepository['list']>>;
    get(...input: Parameters<JobRepository['get']>): ReturnType<JobRepository['get']> | Promise<ReturnType<JobRepository['get']>>;
  };
  candidates: {
    listByJob(...input: Parameters<CandidateRepository['listByJob']>): ReturnType<CandidateRepository['listByJob']> | Promise<ReturnType<CandidateRepository['listByJob']>>;
    readByJob(...input: Parameters<CandidateRepository['readByJob']>): ReturnType<CandidateRepository['readByJob']> | Promise<ReturnType<CandidateRepository['readByJob']>>;
  };
  events: { list(...input: Parameters<BusinessEventRepository['list']>):
    ReturnType<BusinessEventRepository['list']> | Promise<ReturnType<BusinessEventRepository['list']>> };
  runtimeEvents?: EventService;
  toolCalls?: {
    list(...input: Parameters<ToolCallRepository['list']>): ReturnType<ToolCallRepository['list']> | Promise<ReturnType<ToolCallRepository['list']>>;
    getById(...input: Parameters<ToolCallRepository['getById']>): ReturnType<ToolCallRepository['getById']> | Promise<ReturnType<ToolCallRepository['getById']>>;
  } & Partial<{
    request(...input: Parameters<ToolCallRepository['request']>): ReturnType<ToolCallRepository['request']> | Promise<ReturnType<ToolCallRepository['request']>>;
    fixArguments(...input: Parameters<ToolCallRepository['fixArguments']>): ReturnType<ToolCallRepository['fixArguments']> | Promise<ReturnType<ToolCallRepository['fixArguments']>>;
  }>;
  contextService?: Pick<ContextService, 'listContextSnapshots' | 'queryContextSnapshot' | 'listContextRequests'>;
  contextRepository?: { readResourceEvidence(...input: Parameters<ContextRepository['readResourceEvidence']>):
    ReturnType<ContextRepository['readResourceEvidence']> | Promise<ReturnType<ContextRepository['readResourceEvidence']>> };
  invoiceForms?: Pick<InvoiceFormService, 'query'>;
  invoiceEdits?: Pick<InvoiceEditService, 'save' | 'accept' | 'reject' | 'export' | 'readExport' | 'queryOperation'>;
  importInvoiceMaterial: (sourceDirectory: string) => Promise<Result<import('@flowmate/contracts').DocumentSnapshot>>;
  importPreparedInvoiceMaterial: (input: import('@flowmate/contracts').PreparedInvoiceMaterial) => Promise<Result<import('@flowmate/contracts').DocumentSnapshot>>;
  hideDocument?: (documentId: DbId) => Result<{ documentId: DbId; affectedChatCount: number }> | Promise<Result<{ documentId: DbId; affectedChatCount: number }>>;
  readDocumentPage: (input: import('@flowmate/contracts').InvoiceToolInput<'read_invoice_document'>) => Result<import('@flowmate/contracts').InvoiceToolOutput<'read_invoice_document'>> | Promise<Result<import('@flowmate/contracts').InvoiceToolOutput<'read_invoice_document'>>>;
  listDocumentPages: (input: import('@flowmate/contracts').InvoiceToolInput<'list_invoice_pages'>) => Result<import('@flowmate/contracts').InvoiceToolOutput<'list_invoice_pages'>> | Promise<Result<import('@flowmate/contracts').InvoiceToolOutput<'list_invoice_pages'>>>;
  readDocumentOriginal: (documentId: DbId, page: number) => Result<import('@flowmate/contracts').DocumentOriginalImage> | Promise<Result<import('@flowmate/contracts').DocumentOriginalImage>>;
};

/**
 * Public Application is deliberately a thin boundary. It delegates lifecycle
 * decisions to RuntimeService and facts to the repository; it does not know
 * about Cases, Langfuse, fixtures, or Pi SDK event types.
 */
export function makeApplication(
  runtime: RuntimeServicePort,
  runs: RunQueryPort,
  dispose: DisposeResources,
  sessions?: SessionService,
  promptTrace?: PromptTraceBuffer,
  workspace?: WorkspaceService,
  jobs?: JobService,
  products?: ProductApplicationOptions,
  maxRunIdAtBoot = 0,
): Application {
  let closeInFlight: Promise<Result<CloseReport>> | null = null;
  let finalCloseResult: Result<CloseReport> | null = null;
  let closing = false;
  const closeErrors = new Map<string, ReturnType<typeof appError>>();
  const personalUnavailable = () => fail(appError('personal_agent_unavailable', 'runtime', 'Personal Agent is unavailable.'));
  const personalCommand = async <I, T>(type: PersonalAgentCommandType, raw: I,
    invoke: (input: I) => Promise<Result<T>> | undefined): Promise<Result<T>> => {
    const command = parsePersonalAgentCommand({ type, input: raw });
    if (!command) return fail(appError('input_invalid', 'input', 'The Personal Agent request is invalid.'));
    if (!products?.personal) return personalUnavailable();
    if (closing && ['personal_agent_update', 'invoice_work_create', 'invoice_work_supplement', 'invoice_work_dispose_item',
      'invoice_work_continue', 'invoice_work_cancel', 'personal_task_stop'].includes(type))
      return fail(appError('runtime_closing', 'runtime', 'The product runtime is closing.'));
    try {
      const result = parsePersonalAgentHostResult(type, await invoke(command.input as I));
      return result && matchesPersonalAgentResponse(command, result) ? result as Result<T> : personalAgentHostFailure(type);
    } catch { return personalAgentHostFailure(type); }
  };
  const resourceDefaults = (): Result<AssemblySelectionSnapshot> => {
    try {
      const value = products?.resourceDefaults?.() ?? ok({ revision: 0, selection: EMPTY_RESOURCE_SELECTION });
      if (!value.ok) return value;
      const parsed = AssemblySelectionSnapshotSchema.safeParse(value.data);
      return parsed.success ? ok(parsed.data) : fail(appError('config_settings_invalid', 'input', 'Resource configuration is invalid.'));
    } catch { return fail(appError('config_settings_invalid', 'input', 'Resource configuration is unavailable.')); }
  };
  const readRunTool = async ({ runId, sessionId, toolCallId }: import('@flowmate/contracts').RunToolCallRequest): Promise<Result<ToolCallSnapshot>> => {
    if (!products?.toolCalls) return fail(appError('tool_calls_unavailable', 'storage', 'Run 工具查询尚未组装。', true));
    const run = await runs.get(runId);
    if (!run.ok) return run;
    if (run.data.kind === 'provider' || run.data.sessionId !== sessionId)
      return fail(appError('state_conflict', 'runtime', 'Run and Session do not match.', false, runId));
    const call = await products.toolCalls.getById(toolCallId);
    if (!call.ok) return call;
    return call.data.runId === runId && call.data.sessionId === sessionId ? call
      : fail(appError('state_conflict', 'runtime', 'Tool call does not belong to this Run.', false, runId));
  };
  return {
    personalAgent: {
      get: () => personalCommand('personal_agent_get', {}, () => products?.personal?.agent.get()),
      update: raw => personalCommand('personal_agent_update', raw, input => products?.personal?.agent.update(input)),
      openConversation: raw => personalCommand('personal_agent_open_conversation', raw, input => products?.personal?.agent.openConversation(input)),
    },
    invoiceWorks: {
      create: raw => personalCommand('invoice_work_create', raw, input => products?.personal?.works.create(input)),
      list: raw => personalCommand('invoice_work_list', raw, input => products?.personal?.works.list(input)),
      get: raw => personalCommand('invoice_work_get', raw, input => products?.personal?.works.get(input)),
      supplement: raw => personalCommand('invoice_work_supplement', raw, input => products?.personal?.works.supplement(input)),
      disposeItem: raw => personalCommand('invoice_work_dispose_item', raw, input => products?.personal?.works.disposeItem(input)),
      continueWork: raw => personalCommand('invoice_work_continue', raw, input => products?.personal?.works.continueWork(input)),
      cancelWork: raw => personalCommand('invoice_work_cancel', raw, input => products?.personal?.works.cancelWork(input)),
      queryOperation: raw => personalCommand('invoice_work_query_operation', raw, input => products?.personal?.works.queryOperation(input)),
      timeline: raw => personalCommand('invoice_work_timeline', raw, input => products?.personal?.works.timeline(input)),
    },
    personalTasks: {
      list: raw => personalCommand('personal_task_list', raw, input => products?.personal?.tasks.list(input)),
      get: raw => personalCommand('personal_task_get', raw, input => products?.personal?.tasks.get(input)),
      stop: raw => personalCommand('personal_task_stop', raw, input => products?.personal?.tasks.stop(input)),
      history: raw => personalCommand('personal_task_history', raw, input => products?.personal?.tasks.history(input)),
      historyEntry: raw => personalCommand('personal_task_history_entry', raw, input => products?.personal?.tasks.historyEntry(input)),
      resume: async raw => {
        const input = PersonalTaskIdentitySchema.safeParse(raw);
        if (!input.success) return fail(appError('input_invalid', 'input', 'The personal task identity is invalid.'));
        if (!products?.personal) return personalUnavailable();
        if (closing) return fail(appError('runtime_closing', 'runtime', 'The product runtime is closing.'));
        try { return await products.personal.tasks.resume(input.data); }
        catch { return fail(appError('durable_resume_failed', 'runtime', 'The original personal task could not be resumed.', true)); }
      },
    },
    replayInvoiceSave: async raw => {
      const parsed = InvoiceSaveReplayRequestSchema.safeParse(raw);
      if (!parsed.success) return fail(appError('input_invalid', 'input', 'Original save identity is invalid.'));
      const input = parsed.data, original = await readRunTool(input), repository = products?.toolCalls;
      if (!original.ok) return original;
      const call = original.data;
      const receipt = invoiceToolSchemas.save_invoice_candidate.output.safeParse(call.result?.data);
      if (call.toolName !== 'save_invoice_candidate' || call.status !== 'succeeded' || !receipt.success ||
          call.result?.committedCandidateId !== receipt.data.candidateId || call.nativeToolCallId !== input.nativeToolCallId || !isDeepStrictEqual(call.args.raw, input.rawArguments) || !isDeepStrictEqual(call.args.final, input.arguments))
        return fail(appError('state_conflict', 'runtime', 'Original successful save could not be verified.'));
      if (!repository?.request || !repository.fixArguments) return fail(appError('tool_calls_unavailable', 'storage', 'Original save replay is unavailable.'));
      // Re-enter the same idempotency checks as ToolExecutor, without admitting a new logical save.
      const requested = await repository.request({ runId: input.runId, sessionId: input.sessionId, nativeToolCallId: input.nativeToolCallId,
        toolName: call.toolName, toolVersion: call.toolVersion, effect: call.effect, context: call.context,
        rawArguments: input.rawArguments, requestedAt: call.requestedAt });
      if (!requested.ok) return requested;
      const fixed = await repository.fixArguments({ toolCallId: call.toolCallId, finalArguments: input.arguments });
      if (!fixed.ok) return fixed;
      return ok({ runId: input.runId, sessionId: input.sessionId, toolCallId: call.toolCallId,
        nativeToolCallId: input.nativeToolCallId, receipt: receipt.data, created: false as const });
    },
    importResearchMaterial: async raw => {
      const parsed = ImportResearchMaterialSchema.safeParse(raw);
      return parsed.success ? contextRead(ResearchMaterialResultSchema, async () => await products?.importResearchMaterial?.(parsed.data))
        : fail(appError('input_invalid', 'input', 'Selected research material is invalid.'));
    },
    listResearchMaterials: async (input = {}) => {
      const parsed = ResearchPageRequestSchema.safeParse(input);
      return parsed.success ? contextRead(ResearchMaterialsResultSchema, async () => await products?.research?.listMaterials(parsed.data))
        : fail(appError('input_invalid', 'input', 'Research material list is invalid.'));
    },
    createResearchTask: async raw => {
      const parsed = CreateResearchTaskSchema.safeParse(raw);
      if (!parsed.success) return fail(appError('input_invalid', 'input', 'Research task parameters are invalid.'));
      const request = { ...parsed.data, at: new Date().toISOString() };
      return contextRead(ResearchTaskResultSchema, async () => await products?.research?.create(request));
    },
    listResearchTasks: async (input = {}) => {
      const parsed = ResearchPageRequestSchema.safeParse(input);
      return parsed.success ? contextRead(ResearchTasksResultSchema, async () => await products?.research?.list(parsed.data))
        : fail(appError('input_invalid', 'input', 'Research task list is invalid.'));
    },
    queryResearchTask: async id => isDbId(id)
      ? contextRead(ResearchTaskResultSchema, async () => await products?.research?.get(id))
      : fail(appError('input_invalid', 'input', 'Research task ID is invalid.')),
    queryResearchForSession: async input => {
      const parsed = ResearchSessionRequestSchema.safeParse(input);
      return parsed.success ? contextRead(ResearchSessionResultSchema, async () => await products?.research?.forSession(parsed.data.sessionId))
        : fail(appError('input_invalid', 'input', 'Research Session query is invalid.'));
    },
    queryResearchPlan: async input => {
      const parsed = ResearchPlanRequestSchema.safeParse(input);
      return parsed.success ? contextRead(ResearchPlanResultSchema, async () => await products?.research?.getPlan(parsed.data))
        : fail(appError('input_invalid', 'input', 'Research plan query is invalid.'));
    },
    queryResearchSource: async input => {
      const parsed = ResearchSourceRequestSchema.safeParse(input);
      return parsed.success ? contextRead(ResearchSourceResultSchema, async () => await products?.research?.getSource(parsed.data))
        : fail(appError('input_invalid', 'input', 'Research source query is invalid.'));
    },
    queryResearchClaim: async input => {
      const parsed = ResearchClaimRequestSchema.safeParse(input);
      return parsed.success ? contextRead(ResearchClaimResultSchema, async () => await products?.research?.getClaim(parsed.data))
        : fail(appError('input_invalid', 'input', 'Research Claim query is invalid.'));
    },
    queryResearchReport: async input => {
      const parsed = ResearchReportRequestSchema.safeParse(input);
      return parsed.success ? contextRead(ResearchReportResultSchema, async () => await products?.research?.getReport(parsed.data))
        : fail(appError('input_invalid', 'input', 'Research report query is invalid.'));
    },
    listResearchSources: async input => {
      const parsed = ResearchSourcesRequestSchema.safeParse(input);
      return parsed.success ? contextRead(ResearchSourcesResultSchema, async () => await products?.research?.listSources(parsed.data))
        : fail(appError('input_invalid', 'input', 'Research source list is invalid.'));
    },
    listResearchClaims: async input => {
      const parsed = ResearchClaimsRequestSchema.safeParse(input);
      return parsed.success ? contextRead(ResearchClaimsResultSchema, async () => await products?.research?.listClaims(parsed.data))
        : fail(appError('input_invalid', 'input', 'Research Claim list is invalid.'));
    },
    listResearchReports: async input => {
      const parsed = ResearchSourcesRequestSchema.safeParse(input);
      return parsed.success ? contextRead(ResearchReportsResultSchema, async () => await products?.research?.listReports(parsed.data))
        : fail(appError('input_invalid', 'input', 'Research report list is invalid.'));
    },
    queryResearchEvidence: async input => {
      const parsed = ResearchEvidenceRequestSchema.safeParse(input);
      return parsed.success ? await products?.queryResearchEvidence?.(parsed.data) ?? fail(appError('research_unavailable', 'storage', 'Research evidence is unavailable.'))
        : fail(appError('input_invalid', 'input', 'Evidence request is invalid.'));
    },
    exportResearchReport: async input => {
      const parsed = ResearchReportRequestSchema.safeParse(input);
      return parsed.success ? await products?.exportResearchReport?.(parsed.data) ?? fail(appError('research_unavailable', 'storage', 'Research export is unavailable.'))
        : fail(appError('input_invalid', 'input', 'Report export request is invalid.'));
    },
    listSubagentDefinitions: async () => products?.inputDefinitions?.listSubagentDefinitions() ?? fail(appError('input_invalid', 'input', 'Role directory is unavailable.')),
    getSubagentDefinition: async raw => products?.inputDefinitions?.getSubagentDefinition(raw) ?? fail(appError('input_invalid', 'input', 'Role directory is unavailable.')),
    saveSubagentDefinition: async raw => products?.inputDefinitions?.saveSubagentDefinition(raw) ?? fail(appError('input_invalid', 'input', 'Role directory is unavailable.')),
    async listInputCommands(request = {}) {
      const definitions = products?.inputDefinitions?.commands(); if (!definitions?.ok) return definitions ?? fail(appError('input_invalid','input','Input definitions are unavailable.'));
      const resources = await this.listResources(); if (!resources.ok) return resources;
      const extensions = await this.listExtensions(); if (!extensions.ok) return extensions;
      let actual: string[] = [];
      if (request.sessionId) { const loaded = await this.querySessionExtensions({ sessionId: request.sessionId });
        if (!loaded.ok) return loaded; actual = loaded.data.instances.filter(item => item.state === 'active').flatMap(item => [...item.registeredCommands]); }
      const subagents = extensions.data.items.find(item => item.ref.id === 'subagents');
      const enabled = (item: import('@flowmate/contracts').ExtensionCatalogItem) => extensions.data.selection.enabledExtensions.some(ref => ref.id === item.ref.id && ref.version === item.ref.version);
      const canDelegate = !!subagents && enabled(subagents) && subagents.compatibility.available;
      return ok([...resources.data.items.filter(item => item.ref.kind === 'skill').map(item => ({ group: 'Skills' as const,
        name: item.ref.id, text: '/skill:'+item.ref.id+' ', description: item.description, available: item.enabled && item.available,
        reason: item.enabled && item.available ? null : 'Skill is disabled or has unmet requirements.', assembled: false })),
        ...definitions.data.map(item => ({ ...item, available: item.available && canDelegate,
          reason: canDelegate ? item.reason : 'Enable the compatible subagents plugin first.', assembled: actual.includes('subagent') })),
        ...extensions.data.items.flatMap(item => (item.manifest.commands as readonly string[]).filter(name => name !== 'subagent').map(name => ({ group: 'Extension Commands' as const,
          name, text: '/'+name+' ', description: item.ref.id, available: enabled(item) && item.compatibility.available,
          reason: enabled(item) && item.compatibility.available ? null : 'Plugin is disabled or unavailable.', assembled: actual.includes(name) }))) ]);
    },
    listSubagents: async raw => {
      const parsed = ListSubagentsRequestSchema.safeParse(raw);
      if (!parsed.success) return fail(appError('input_invalid', 'input', 'Child list parameters are invalid.'));
      const parent = await runs.get(parsed.data.parentRunId); if (!parent.ok) return parent;
      if (parent.data.kind !== 'agent' || parent.data.sessionId !== parsed.data.parentSessionId)
        return fail(appError('subagent_identity_conflict', 'runtime', 'The parent does not belong to this Session.'));
      return contextRead(SubagentPageResultSchema, () => runs.listSubagents?.({ parentRunId: parsed.data.parentRunId,
        ...(parsed.data.beforeRunId === undefined ? {} : { beforeRunId: parsed.data.beforeRunId }), limit: parsed.data.limit }));
    },
    querySubagent: async raw => {
      const parsed = QuerySubagentRequestSchema.safeParse(raw);
      if (!parsed.success) return fail(appError('input_invalid', 'input', 'Child detail parameters are invalid.'));
      const parent = await runs.get(parsed.data.parentRunId); if (!parent.ok) return parent;
      if (parent.data.kind !== 'agent' || parent.data.sessionId !== parsed.data.parentSessionId)
        return fail(appError('subagent_identity_conflict', 'runtime', 'The parent does not belong to this Session.'));
      return contextRead(SubagentDetailResultSchema, () => runs.querySubagent?.(parsed.data));
    },
    querySessionExtensions: async raw => {
      const parsed = SessionExtensionQuerySchema.safeParse(raw);
      if (!parsed.success) return fail(appError('input_invalid', 'input', 'Session extension query is invalid.'));
      const result = await sessions?.queryExtensions(parsed.data);
      return contextRead(SessionExtensionResultSchema, () => result);
    },
    queryRunExtensions: async raw => {
      const parsed = RunExtensionQuerySchema.safeParse(raw);
      if (!parsed.success) return fail(appError('input_invalid', 'input', 'Run extension query is invalid.'));
      return contextRead(RunExtensionResultSchema, async () => {
        const saved = await runs.get(parsed.data.runId); if (!saved.ok) return saved;
        if (saved.data.kind === 'provider' || saved.data.sessionId !== parsed.data.sessionId)
          return fail(appError('state_conflict', 'input', 'Run does not belong to this Session.'));
        const config = saved.data.config;
        return ok({ ...parsed.data, frozen: config.extensions === undefined ? null : FrozenExtensionsSchema.parse(config.extensions),
          assembly: config.extensionAssembly === undefined ? null : ExtensionAssemblyEvidenceSchema.parse(config.extensionAssembly) });
      });
    },
    executeExtensionCommand: async raw => {
      const parsed = ExtensionCommandRequestSchema.safeParse(raw);
      if (!parsed.success) return fail(appError('input_invalid', 'input', 'Extension command is invalid.'));
      const result = await sessions?.executeExtensionCommand(parsed.data);
      return contextRead(ExtensionCommandResultSchema, () => result);
    },
    disposeSessionExtensions: async raw => {
      const parsed = ExtensionDisposeRequestSchema.safeParse(raw);
      if (!parsed.success) return fail(appError('input_invalid', 'input', 'Extension disposal request is invalid.'));
      const result = await sessions?.disposeSessionExtensions(parsed.data);
      return contextRead(ExtensionDisposeResultSchema, () => result);
    },
    listExtensions: async () => contextRead(ExtensionCatalogResultSchema, () => {
      const settings = resourceDefaults(); if (!settings.ok) return settings;
      const items = products?.extensions?.list(); if (!items) return fail(appError('extension_config_invalid', 'input', 'Extension directory is unavailable.'));
      return items.ok ? ok({ revision: settings.data.revision, selection: settings.data.extensions, items: items.data }) : items;
    }),
    updateExtensionSelection: async raw => {
      const parsed = ExtensionSelectionRequestSchema.safeParse(raw);
      if (!parsed.success) return fail(appError('extension_config_invalid', 'input', 'Extension selection is invalid.'));
      if (!products?.saveExtensionSelection) return fail(appError('config_settings_write_failed', 'storage', 'Extension selection is read-only in this application.', true));
      try {
        const saved = ExtensionSelectionResponseSchema.safeParse(await products.saveExtensionSelection(parsed.data));
        return saved.success ? saved.data : fail(appError('config_settings_write_failed', 'storage', 'Extension save result could not be verified.', true));
      } catch { return fail(appError('config_settings_write_failed', 'storage', 'Extension save could not be confirmed.', true)); }
    },
    validateExtensionSelection: selection => products?.extensions?.validateSelection(selection)
      ?? fail(appError('extension_config_invalid', 'input', 'Extension directory is unavailable.')),
    queryRunResources: async raw => {
      const parsed = RunResourceQuerySchema.safeParse(raw);
      if (!parsed.success) return fail(appError('input_invalid', 'input', 'Run resource query is invalid.'));
      return contextRead(RunResourceResultSchema, async () => {
        const request = parsed.data, saved = await runs.get(request.runId);
        if (!saved.ok) return saved;
        if (saved.data.kind === 'provider' || saved.data.sessionId !== request.sessionId)
          return fail(appError('state_conflict', 'input', 'Run does not belong to this Session.'));
        const frozen = saved.data.config.resources === undefined ? null : FrozenResourcesSchema.parse(saved.data.config.resources);
        const evidence = await products?.contextRepository?.readResourceEvidence(request);
        if (!evidence) return fail(appError('resource_evidence_write_failed', 'storage', 'Resource journal query is unavailable.', true));
        if (!evidence.ok) return evidence;
        const verified = frozen ? await products?.resources?.verifyFrozen(frozen) : ok(undefined);
        return ok({ ...request, frozen, evidence: evidence.data, gap: frozen && (!verified || !verified.ok)
          ? 'bundle-unavailable' as const : evidence.data === null ? 'legacy-not-collected' as const : null });
      });
    },
    readRunResourceFile: async raw => {
      const parsed = RunResourceFileRequestSchema.safeParse(raw);
      if (!parsed.success) return fail(appError('input_invalid', 'input', 'Run resource file query is invalid.'));
      return contextRead(ResourceFileResultSchema, async () => {
        const { sessionId, runId, ...file } = parsed.data, saved = await runs.get(runId);
        if (!saved.ok) return saved;
        if (saved.data.kind === 'provider' || saved.data.sessionId !== sessionId)
          return fail(appError('state_conflict', 'input', 'Run does not belong to this Session.'));
        if (saved.data.config.resources === undefined) return fail(appError('resource_required_unavailable', 'input', 'This Run has no fixed resource bundle.'));
        return products?.resources?.readFrozenFile(FrozenResourcesSchema.parse(saved.data.config.resources), file);
      });
    },
    listResources: async () => contextRead(ResourceCatalogResultSchema, () => {
      const settings = resourceDefaults();
      return settings.ok ? products?.resources?.catalog({ ...settings.data, availableExtensions: settings.data.extensions.enabledExtensions }) : settings;
    }),
    readResourceFile: async raw => {
      const parsed = ResourceFileRequestSchema.safeParse(raw);
      if (!parsed.success) return fail(appError('input_invalid', 'input', 'Resource file query is invalid.'));
      return contextRead(ResourceFileResultSchema, () => {
        const settings = resourceDefaults();
        return settings.ok ? products?.resources?.readFile(parsed.data, settings.data.selection, settings.data.extensions.enabledExtensions) : settings;
      });
    },
    updateResourceSelection: async raw => {
      const parsed = ResourceSelectionRequestSchema.safeParse(raw);
      if (!parsed.success) return fail(appError('input_invalid', 'input', 'Resource selection is invalid.'));
      if (!products?.saveResourceSelection) return fail(appError('config_settings_write_failed', 'storage', 'Resource selection is read-only in this application.', true));
      try {
        const saved = ResourceSelectionResponseSchema.safeParse(await products.saveResourceSelection(parsed.data));
        return saved.success ? saved.data : fail(appError('config_settings_write_failed', 'storage', 'Resource save result could not be verified.', true));
      } catch { return fail(appError('config_settings_write_failed', 'storage', 'Resource selection save could not be confirmed.', true)); }
    },
    validateResourceSelection: async (selection, extensions = EMPTY_EXTENSION_SELECTION) => await products?.resources?.validateSelection(selection, extensions.enabledExtensions)
      ?? fail(appError('resource_required_unavailable', 'input', 'Resource service is unavailable.')),
    compactSession: async (raw, control) => {
      const request = normalizeSessionCompactionRequest(raw);
      return request.ok ? runtime.compactSession(request.data, control) : request;
    },
    querySessionCompaction: async raw => {
      const request = normalizeSessionCompactionQuery(raw);
      return request.ok ? runtime.querySessionCompaction(request.data) : request;
    },
    cancelSessionCompaction: async raw => {
      const request = normalizeSessionCompactionCancel(raw);
      return request.ok ? runtime.cancelSessionCompaction(request.data) : request;
    },
    callProvider: async (raw, control) => {
      const normalized = normalizeProviderRequest(raw);
      return normalized.ok ? runtime.callProvider(normalized.data, control) : normalized;
    },
    queryRun: async (runId) => isDbId(runId) ? await runs.get(runId) : fail(appError('input_invalid', 'input', 'Run ID 无效。')),
    listContextSnapshots: async input => contextRead(ContextSnapshotsResultSchema, () => products?.contextService?.listContextSnapshots(input)),
    queryContextSnapshot: async input => contextRead(ContextSnapshotResultSchema, () => products?.contextService?.queryContextSnapshot(input)),
    listContextRequests: async input => contextRead(ContextRequestsResultSchema, () => products?.contextService?.listContextRequests(input)),
    queryRuntimeEvents: async input => products?.runtimeEvents?.query(input) ?? ({ ok: false,
      error: appError('runtime_events_unavailable', 'runtime', 'Runtime 事件服务尚未组装。', true), context: null }),
    subscribeRuntimeEvents: async (input, listener) => products?.runtimeEvents?.subscribe(input, listener)
      ?? fail(appError('runtime_events_unavailable', 'runtime', 'Runtime 事件服务尚未组装。', true)),
    listRunToolCalls: async raw => {
      if (!products?.toolCalls) return fail(appError('tool_calls_unavailable', 'storage', 'Run 工具查询尚未组装。', true));
      const parsed = RunToolCallsRequestSchema.safeParse(raw);
      if (!parsed.success) return fail(appError('input_invalid', 'input', 'Run tool query is invalid.'));
      const { runId, sessionId, beforeId, limit } = parsed.data;
      const run = await runs.get(runId);
      if (!run.ok) return run;
      if ((run.data.kind === 'provider' ? null : run.data.sessionId) !== sessionId)
        return fail(appError('state_conflict', 'runtime', 'Run and Session do not match.', false, runId));
      if (run.data.kind === 'provider') return ok({ items: [], nextBeforeId: null });
      const calls = await products.toolCalls.list({ runId, ...(beforeId === undefined ? {} : { beforeId }), limit });
      if (!calls.ok) return calls;
      try {
        if (calls.data.items.some(call => call.runId !== runId || call.sessionId !== sessionId)) throw new Error('ownership');
        return ok(RuntimeToolPageSchema.parse({ items: calls.data.items.map(toolView), nextBeforeId: calls.data.nextBeforeId }));
      } catch { return fail(appError('storage_corrupt', 'storage', 'Run tools could not be projected.')); }
    },
    queryRunToolCall: async raw => {
      if (!products?.toolCalls) return fail(appError('tool_calls_unavailable', 'storage', 'Run 工具查询尚未组装。', true));
      const parsed = RunToolCallRequestSchema.safeParse(raw);
      if (!parsed.success) return fail(appError('input_invalid', 'input', 'Run tool query is invalid.'));
      const call = await readRunTool(parsed.data);
      if (!call.ok) return call;
      try { return ok(toolView(call.data)); }
      catch { return fail(appError('storage_corrupt', 'storage', 'Run tool could not be projected.')); }
    },
    queryRunToolEvidence: async raw => {
      if (!products?.toolCalls) return fail(appError('tool_calls_unavailable', 'storage', 'Run 工具查询尚未组装。', true));
      const parsed = ToolEvidenceRequestSchema.safeParse(raw);
      if (!parsed.success) return fail(appError('input_invalid', 'input', 'Tool evidence query is invalid.'));
      try {
        const input = parsed.data, call = await readRunTool(input);
        if (!call.ok) return call;
        const bytes = Buffer.from(JSON.stringify(ToolCallSnapshotSchema.parse(call.data)));
        const evidenceRevision = call.data.evidenceRevision ?? 0;
        if (input.expectedRevision !== undefined && input.expectedRevision !== evidenceRevision)
          return fail(appError('state_conflict', 'runtime', 'Tool evidence changed. Reload the original ToolCall.', false, input.runId));
        if (input.offset >= bytes.length || (bytes[input.offset]! & 0xc0) === 0x80)
          return fail(appError('input_invalid', 'input', 'Tool evidence offset is outside a UTF-8 boundary.'));
        let end = Math.min(bytes.length, input.offset + input.limit);
        while (end < bytes.length && (bytes[end]! & 0xc0) === 0x80) end--;
        return ok(ToolEvidencePageSchema.parse({ version: 2, runId: input.runId, sessionId: input.sessionId, toolCallId: input.toolCallId,
          evidenceRevision, bytes: bytes.length, offset: input.offset, chunk: bytes.subarray(input.offset, end).toString('utf8'),
          nextOffset: end === bytes.length ? null : end }));
      } catch { return fail(appError('storage_corrupt', 'storage', 'Original tool evidence could not be read.')); }
    },
    createSession: async (raw = {}) => {
      const normalized = normalizeCreateSessionRequest(raw);
      return normalized.ok ? sessions?.create(normalized.data) ?? fail(sessionServiceUnavailable()) : normalized;
    },
    queryNativeTools: async () => runtime.queryNativeTools?.()
      ?? fail(appError('tool_runtime_unavailable', 'runtime', 'Native tools are unavailable.')),
    renameSession: async (raw) => {
      const normalized = normalizeRenameSessionRequest(raw);
      return normalized.ok ? sessions?.rename(normalized.data) ?? fail(sessionServiceUnavailable()) : normalized;
    },
    deleteSession: async (raw) => {
      const normalized = normalizeSessionId(raw);
      if (!normalized.ok) return normalized;
      const deleted = await (sessions?.deleteSession(normalized.data) ?? Promise.resolve(fail(sessionServiceUnavailable())));
      if (deleted.ok && deleted.data.disposition === 'permanent') {
        try { promptTrace?.clearSession(deleted.data.deletedSessionId); } catch { /* deletion is already committed */ }
      }
      return deleted;
    },
    listSessions: async (raw?: ListSessionsRequest) => {
      const normalized = normalizeListSessionsRequest(raw);
      return normalized.ok ? sessions?.list(normalized.data) ?? fail(sessionServiceUnavailable()) : normalized;
    },
    querySession: async (sessionId) => {
      if (!isDbId(sessionId)) return fail(appError('input_invalid', 'input', 'Session ID 无效。'));
      return sessions?.get(sessionId) ?? fail(sessionServiceUnavailable());
    },
    listSessionRuns: async (raw: SessionRunsRequest) => {
      const normalized = normalizeSessionRunsRequest(raw);
      if (!normalized.ok) return normalized;
      if (!runs.listBySession) return fail(appError('session_runs_unavailable', 'storage', 'Session Run 仓储尚未组装。'));
      return await runs.listBySession(normalized.data);
    },
    listSessionMessages: async (raw) => {
      const normalized = normalizeSessionMessagesRequest(raw);
      return normalized.ok ? sessions?.listMessages(normalized.data) ?? fail(sessionServiceUnavailable()) : normalized;
    },
    queryPromptTrace: async (runId, callSequence) => {
      if (!isDbId(runId) || (callSequence !== undefined && !isDbId(callSequence))) {
        return fail(appError('input_invalid', 'input', 'Prompt Trace 查询参数无效。'));
      }
      const run = await runs.get(runId);
      if (!run.ok) return run;
      if (run.data.kind === 'provider') return ok({ availability: 'not-collected', calls: [], droppedCalls: null });
      if (!promptTrace) return ok({ availability: 'not-collected', calls: [], droppedCalls: null });
      let result;
      try { result = promptTrace.query(runId, callSequence); }
      catch { return ok({ availability: 'source-unavailable', calls: [], droppedCalls: null }); }
      if (result.availability === 'not-started') {
        const agent = run.data.output?.agent;
        const calls = agent && typeof agent === 'object' && 'modelCallCount' in agent ? agent.modelCallCount : undefined;
        if (calls === 0) return ok(result);
        if (runId <= maxRunIdAtBoot) {
          return ok({ availability: 'process-exited', calls: [], droppedCalls: null });
        }
      }
      return ok(result);
    },
    startRun: async (raw: AgentRunRequest, control?: AgentControl) => {
      const normalized = normalizeAgentRunRequest(raw);
      return normalized.ok ? runtime.start(normalized.data, control) : normalized;
    },
    submitInput: async (raw, control) => sessions?.submitInput(raw, control) ?? fail(sessionServiceUnavailable()),
    querySessionInput: async (request) => sessions?.queryInput(request) ?? fail(sessionServiceUnavailable()),
    listSessionInputs: async request => sessions?.listInputs(request) ?? fail(sessionServiceUnavailable()),
    setSessionStatus: async request => sessions?.setStatus(request) ?? fail(sessionServiceUnavailable()),
    branchSession: async request => sessions?.branch(request) ?? fail(sessionServiceUnavailable()),
    forkSession: async request => sessions?.forkSession(request) ?? fail(sessionServiceUnavailable()),
    querySessionHistory: async request => sessions?.querySessionHistory(request) ?? fail(sessionServiceUnavailable()),
    querySessionHistoryEntry: async request => sessions?.querySessionHistoryEntry(request) ?? fail(sessionServiceUnavailable()),
    queryInvoiceFormApplication: async (request) => products?.invoiceForms?.query(request)
      ?? fail(appError('form_bridge_unavailable', 'runtime', 'The controlled invoice form is unavailable.')),
    saveInvoiceCandidate: async request => products?.invoiceEdits?.save(request)
      ?? fail(appError('invoice_edit_unavailable', 'runtime', 'Invoice editing is unavailable.')),
    acceptInvoiceCandidate: async request => products?.invoiceEdits?.accept(request)
      ?? fail(appError('invoice_edit_unavailable', 'runtime', 'Invoice acceptance is unavailable.')),
    rejectInvoiceCandidate: async request => products?.invoiceEdits?.reject(request)
      ?? fail(appError('invoice_edit_unavailable', 'runtime', 'Invoice rejection is unavailable.')),
    exportInvoiceCandidate: async request => products?.invoiceEdits?.export(request)
      ?? fail(appError('invoice_edit_unavailable', 'runtime', 'Invoice export is unavailable.')),
    readInvoiceExport: async request => products?.invoiceEdits?.readExport(request)
      ?? fail(appError('invoice_edit_unavailable', 'runtime', 'Invoice export is unavailable.')),
    queryInvoiceCandidateOperation: async request => products?.invoiceEdits?.queryOperation(request)
      ?? fail(appError('invoice_edit_unavailable', 'runtime', 'Invoice operation lookup is unavailable.')),
    readWorkspace: async () => workspace?.read() ?? fail(appError('workspace_unavailable', 'storage', 'Workspace 服务尚未组装。', true)),
    restoreWorkspace: async () => workspace?.restore() ?? fail(appError('workspace_unavailable', 'storage', 'Workspace 服务尚未组装。', true)),
    updateWorkspace: async (raw) => workspace?.update(raw) ?? fail(appError('workspace_unavailable', 'storage', 'Workspace 服务尚未组装。', true)),
    startTask: async (raw) => jobs?.create(raw) ?? fail(appError('job_service_unavailable', 'storage', 'Job 服务尚未组装。', true)),
    queryTaskOperation: async (clientSequence) => jobs?.queryOperation(clientSequence)
      ?? fail(appError('job_service_unavailable', 'storage', 'Job 服务尚未组装。', true)),
    selectCandidate: async (raw) => workspace?.selectCandidate(raw)
      ?? fail(appError('workspace_unavailable', 'storage', '候选选择服务尚未组装。', true)),
    listDocuments: async (raw = {}) => {
      const page = normalizePageRequest(raw);
      return !page.ok ? page : products?.documents.list(page.data)
        ?? fail(appError('document_service_unavailable', 'storage', 'Document 查询尚未组装。', true));
    },
    queryDocument: async (documentId) => Number.isSafeInteger(documentId) && documentId > 0
      ? products?.documents.get(documentId) ?? fail(appError('document_service_unavailable', 'storage', 'Document 查询尚未组装。', true))
      : fail(appError('input_invalid', 'input', 'Document ID 无效。')),
    hideDocument: async (documentId) => Number.isSafeInteger(documentId) && documentId > 0
      ? products?.hideDocument?.(documentId)
        ?? fail(appError('document_service_unavailable', 'storage', 'Invoice removal is unavailable.', true))
      : fail(appError('input_invalid', 'input', 'Invoice reference is invalid.')),
    listJobs: async (raw = {}) => {
      const page = normalizePageRequest(raw, ['documentId']);
      if (!page.ok) return page;
      const request = raw && typeof raw === 'object' && 'documentId' in raw
        ? { ...page.data, documentId: (raw as { documentId?: number }).documentId } : page.data;
      if ('documentId' in request && request.documentId !== undefined && (!Number.isSafeInteger(request.documentId) || request.documentId < 1)) {
        return fail(appError('input_invalid', 'input', 'Document ID 无效。'));
      }
      return await products?.jobs.list(request) ?? fail(appError('job_service_unavailable', 'storage', 'Job 查询尚未组装。', true));
    },
    queryJob: async (jobId) => Number.isSafeInteger(jobId) && jobId > 0
      ? await products?.jobs.get(jobId) ?? fail(appError('job_service_unavailable', 'storage', 'Job 查询尚未组装。', true))
      : fail(appError('input_invalid', 'input', 'Job ID 无效。')),
    hideJob: async (jobId) => jobs?.hide(jobId)
      ?? fail(appError('job_service_unavailable', 'storage', 'Processing service is unavailable.', true)),
    listJobCandidates: async (raw) => {
      if (!raw || typeof raw !== 'object' || !Number.isSafeInteger(raw.jobId) || raw.jobId < 1
        || raw.beforeSequence !== undefined && raw.beforeSequence !== null && (!Number.isSafeInteger(raw.beforeSequence) || raw.beforeSequence < 1)
        || raw.limit !== undefined && (!Number.isSafeInteger(raw.limit) || raw.limit < 1 || raw.limit > 100)
        || Object.keys(raw).some((key) => !['jobId', 'beforeSequence', 'limit'].includes(key))) {
        return fail(appError('input_invalid', 'input', 'Candidate 分页参数无效。'));
      }
      return await products?.candidates.listByJob({ jobId: raw.jobId, beforeSequence: raw.beforeSequence ?? null, limit: raw.limit ?? 50 })
        ?? fail(appError('candidate_service_unavailable', 'storage', 'Candidate 查询尚未组装。', true));
    },
    queryJobCandidate: async (raw) => {
      if (!raw || typeof raw !== 'object' || !Number.isSafeInteger(raw.jobId) || raw.jobId < 1
        || !Number.isSafeInteger(raw.candidateId) || raw.candidateId < 1
        || Object.keys(raw).some((key) => !['jobId', 'candidateId'].includes(key))) {
        return fail(appError('input_invalid', 'input', 'Candidate 查询参数无效。'));
      }
      return await products?.candidates.readByJob({ jobId: raw.jobId, candidateId: raw.candidateId })
        ?? fail(appError('candidate_service_unavailable', 'storage', 'Candidate 查询尚未组装。', true));
    },
    listActivity: async (raw) => {
      const page = normalizePageRequest(raw, ['jobId', 'documentId']);
      if (!page.ok) return page;
      if (!raw || typeof raw !== 'object' || (('jobId' in raw) === ('documentId' in raw))) {
        return fail(appError('input_invalid', 'input', 'Activity 必须按一个 Job 或 Document 查询。'));
      }
      const record = raw as Record<string, unknown>;
      const hasJob = 'jobId' in record;
      const id = hasJob ? record.jobId : record.documentId;
      if (typeof id !== 'number' || !Number.isSafeInteger(id) || id < 1) return fail(appError('input_invalid', 'input', 'Activity 所属 ID 无效。'));
      const filter = hasJob ? { jobId: id } : { documentId: id };
      return await products?.events.list({ ...page.data, ...filter })
        ?? fail(appError('activity_service_unavailable', 'storage', 'Activity 查询尚未组装。', true));
    },
    importInvoiceMaterial: async (sourceDirectory) => {
      if (typeof sourceDirectory !== 'string' || !sourceDirectory.trim() || new TextEncoder().encode(sourceDirectory).byteLength > 4096) {
        return fail(appError('input_invalid', 'input', '正式材料目录无效。'));
      }
      return products?.importInvoiceMaterial(sourceDirectory)
        ?? fail(appError('document_service_unavailable', 'storage', 'Document 导入尚未组装。', true));
    },
    importPreparedInvoiceMaterial: async raw => {
      const input = PreparedInvoiceMaterialSchema.safeParse(raw);
      return !input.success ? fail(appError('input_invalid', 'input', 'Prepared invoice material is invalid.'))
        : products?.importPreparedInvoiceMaterial(input.data)
          ?? fail(appError('document_service_unavailable', 'storage', 'Document 导入尚未组装。', true));
    },
    listDocumentPages: async raw => {
      const input = invoiceToolSchemas.list_invoice_pages.input.safeParse(raw);
      return !input.success ? fail(appError('input_invalid', 'input', 'Parsed page query is invalid.'))
        : products?.listDocumentPages(input.data) ?? fail(appError('document_service_unavailable', 'storage', 'Parsed page listing is unavailable.', true));
    },
    readDocumentPage: async (raw) => {
      const input = invoiceToolSchemas.read_invoice_document.input.safeParse(raw);
      if (!input.success) return fail(appError('input_invalid', 'input', 'Document 页面参数无效。'));
      return products?.readDocumentPage(input.data)
        ?? fail(appError('document_service_unavailable', 'storage', 'Document 页面查询尚未组装。', true));
    },
    readDocumentOriginal: async (documentId, page) => Number.isSafeInteger(documentId) && documentId > 0 && page === 1
      ? products?.readDocumentOriginal(documentId, page)
        ?? fail(appError('document_service_unavailable', 'storage', 'Document 原图查询尚未组装。', true))
      : fail(appError('input_invalid', 'input', 'Document 原图参数无效。')),
    revokeDocumentUse: async (documentId) => isDbId(documentId)
      ? runtime.revokeDocumentUse(documentId)
      : fail(appError('input_invalid', 'input', 'Document ID 无效。')),
    cancelRun: async (runId) => {
      if (!isDbId(runId)) return fail(appError('input_invalid', 'input', 'Run ID 无效。'));
      return runtime.cancel(runId);
    },
    cancelSubagent: async (request) => {
      const input = CancelSubagentRequestSchema.safeParse(request);
      if (!input.success) return fail(appError('input_invalid', 'input', 'Child cancellation parameters are invalid.'));
      const result = await runtime.cancelSubagent?.(input.data)
        ?? fail(appError('subagent_origin_invalid', 'runtime', 'Child execution management is unavailable.'));
      if (!result.ok) return result;
      const receipt = SubagentCancelReceiptSchema.safeParse(result.data);
      return receipt.success ? ok(receipt.data) : fail(appError('internal_error', 'internal', 'Child cancellation receipt is invalid.'));
    },
    queryRuntimeState: async () => {
      try { return ok(runtime.state()); }
      catch { return fail(appError('runtime_state_unavailable', 'runtime', 'Runtime 状态当前不可读取。', true)); }
    },
    close: () => {
      if (finalCloseResult) return Promise.resolve(finalCloseResult);
      if (closeInFlight) return closeInFlight;
      closeInFlight = closeOnce().then((result) => {
        if (!result.ok) {
          closeErrors.set(result.error.code, result.error);
          return ok({ stopped: false, closed: false, errors: [...closeErrors.values()] });
        }
        for (const error of result.data.errors) closeErrors.set(error.code, error);
        const complete = ok({ ...result.data, errors: [...closeErrors.values()] });
        if (complete.ok && complete.data.closed) finalCloseResult = complete;
        return complete;
      }).finally(() => { closeInFlight = null; });
      return closeInFlight;
    },
  };

  async function closeOnce(): Promise<Result<CloseReport>> {
    closing = true;
    // Quiesce background admission before foreground release can notify its saved queue.
    const personalClosing = (async (): Promise<Result<void>> => {
      try { return await products?.personal?.close?.() ?? ok(undefined); }
      catch { return fail(appError('personal_agent_close_failed', 'runtime', 'Personal Agent stop could not be confirmed.', true)); }
    })();
    let runtimeReport: CloseReport;
    try {
      runtimeReport = await runtime.close();
    } catch {
      runtimeReport = { stopped: false, closed: false, errors: [appError('runtime_close_failed', 'runtime', '运行资源关闭失败。', true)] };
    }
    const personalReport = await personalClosing;

    let resourceReport: CloseReport;
    if (!personalReport.ok) {
      resourceReport = { stopped: false, closed: false, errors: [personalReport.error] };
    } else if (!runtimeReport.stopped) {
      resourceReport = { stopped: false, closed: false, errors: [] };
    } else {
      try {
        resourceReport = await dispose();
      } catch {
        resourceReport = { stopped: true, closed: false, errors: [appError('storage_close_failed', 'storage', '持久化资源关闭失败。', true)] };
      }
    }

    const report: CloseReport = {
      stopped: runtimeReport.stopped && resourceReport.stopped,
      closed: runtimeReport.closed && resourceReport.closed,
      errors: [...runtimeReport.errors, ...resourceReport.errors],
    };
    return ok(report);
  }
}

function toolView(call: ToolCallSnapshot): RuntimeToolView {
  return RuntimeToolViewSchema.parse({ toolCallId: call.toolCallId, runId: call.runId, sessionId: call.sessionId,
    toolName: call.toolName, status: call.status, requestedAt: call.requestedAt, startedAt: call.startedAt,
    endedAt: call.endedAt, stoppedAt: call.stoppedAt, committedCandidateId: call.result?.committedCandidateId ?? null,
    errorCode: call.result && call.result.status !== 'succeeded' ? call.result.error.code : null,
    stopped: typeof call.cleanup.stopped === 'boolean' ? call.cleanup.stopped : null,
    deliveryState: call.delivery.state, formApplicationOutcome: call.formApplication?.outcome ?? null,
    context: call.context === null ? null : { snapshotId: call.context.snapshotId, requestSequence: call.context.requestSequence } });
}

async function contextRead<T>(schema: z.ZodType<Result<T>>, read: () => Result<T> | Promise<Result<T> | undefined> | undefined): Promise<Result<T>> {
  try {
    const parsed = schema.safeParse(await read());
    if (parsed.success) return parsed.data;
  } catch { /* Only the fixed public failure crosses this boundary. */ }
  return fail(appError('internal_error', 'internal', 'Context query could not be completed.'));
}

function normalizePageRequest(value: unknown, allowedExtra: readonly string[] = []): Result<{ beforeId?: number; limit: number }> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some((key) => !['beforeId', 'limit', ...allowedExtra].includes(key))) {
    return fail(appError('input_invalid', 'input', '分页参数无效。'));
  }
  const record = value as { beforeId?: unknown; limit?: unknown };
  if (record.beforeId !== undefined && (!Number.isSafeInteger(record.beforeId) || Number(record.beforeId) < 1)
    || record.limit !== undefined && (!Number.isSafeInteger(record.limit) || Number(record.limit) < 1 || Number(record.limit) > 100)) {
    return fail(appError('input_invalid', 'input', '分页参数无效。'));
  }
  return { ok: true, data: { ...(record.beforeId === undefined ? {} : { beforeId: Number(record.beforeId) }), limit: Number(record.limit ?? 50) } };
}

function isDbId(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

function sessionServiceUnavailable() {
  return appError('session_service_unavailable', 'runtime', 'Agent Session 服务尚未组装。', true);
}
