import { parseInputDefinitionCommand, isInputDefinitionHostCommand, parseInputDefinitionHostResult, matchesInputDefinitionResponse, inputDefinitionHostFailure } from '../../../packages/contracts/src/input-commands.ts';
import { parsePersonalAgentCommand, isPersonalAgentHostCommand, parsePersonalAgentHostResult, matchesPersonalAgentResponse, personalAgentHostFailure } from '../../../packages/contracts/src/personal-agent-commands.ts';
import { contextBridge, ipcRenderer } from 'electron';
import { z } from 'zod';
import { EvaluationWorkflowRequestSchema, EvaluationWorkflowResultSchema } from '../../../packages/contracts/src/evaluation-workflow.ts';
import { parseResearchCommand, parseResearchHostResult, matchesResearchResponse, researchHostFailure, isResearchHostCommand } from '../../../packages/contracts/src/research-commands.ts';
import { appError, fail } from '../../../packages/contracts/src/errors.ts';
import { parseResourceCommand, parseResourceHostResult, matchesResourceResponse, resourceHostFailure } from '../../../packages/contracts/src/resources.ts';
import { parseExtensionCommand, parseExtensionHostResult, matchesExtensionResponse, extensionHostFailure, isExtensionHostCommand } from '../../../packages/contracts/src/extensions.ts';
import { parseSubagentCommand, parseSubagentHostResult, matchesSubagentResponse, subagentHostFailure, isSubagentHostCommand } from '../../../packages/contracts/src/subagents.ts';
import type { Result } from '@flowmate/contracts';
import type { DesktopBridge, DesktopEvent, ProductSettings, ProviderTestRequest } from '@flowmate/contracts';
import { DiagnosticsResultSchema, DiagnosticsExportResultSchema } from '../../../packages/contracts/src/diagnostics.ts';
import { parseEvaluationCommand, parseEvaluationResponse, matchesEvaluationResponse, EvaluationEventSchema,
  type EvaluationOutput, type EvaluationInput, type EvaluationResponseType } from '../../../packages/contracts/src/evaluation.ts';
import { BackgroundServiceStateSchema, BackgroundServiceConnectRequestSchema, BackgroundServiceDisconnectRequestSchema,
  BackgroundServicePrepareRequestSchema, BackgroundServicePreparationSchema, BackgroundServiceEnableRequestSchema,
  BackgroundServiceActivationQuerySchema, BackgroundServiceActivationViewSchema,
  type BackgroundServiceState } from '../../../packages/contracts/src/background-service.ts';
import { AppErrorSchema } from '../../../packages/contracts/src/runtime.ts';

async function invokeBackgroundService(type: 'get-service-state' | 'connect-service' | 'disconnect-service', input?: unknown): Promise<Result<BackgroundServiceState>> {
  const parsed = type === 'get-service-state' ? input === undefined : (type === 'connect-service'
    ? BackgroundServiceConnectRequestSchema : BackgroundServiceDisconnectRequestSchema).safeParse(input).success;
  if (!parsed) return fail(appError('input_invalid', 'input', 'The background service request is invalid.'));
  try {
    const raw: unknown = await ipcRenderer.invoke(`flowmate:${type}`, ...(input === undefined ? [] : [input]));
    if (!raw || typeof raw !== 'object' || !('ok' in raw)) throw Error('invalid_service_response');
    if (raw.ok === false && 'error' in raw) {
      if (Object.keys(raw).some(key => !['ok', 'error'].includes(key))) throw Error('invalid_service_response');
      const error = AppErrorSchema.safeParse(raw.error); if (error.success) return fail(error.data);
    }
    if (Object.keys(raw).some(key => !['ok', 'data'].includes(key))) throw Error('invalid_service_response');
    const value = raw.ok === true && 'data' in raw ? BackgroundServiceStateSchema.safeParse(raw.data) : null;
    if (value?.success && (type === 'get-service-state' || value.data.installationId === (input as { installationId: string }).installationId)) return { ok: true, data: value.data };
  } catch { /* Only a bounded, verified service projection crosses the preload. */ }
  return fail(appError('service_state_unavailable', 'runtime', 'The background service state could not be confirmed.', true));
}

async function invokeServiceActivation<T>(type: 'prepare-service' | 'enable-service' | 'query-service-activation', input: unknown,
  response: z.ZodType<T>): Promise<Result<T>> {
  const request = (type === 'prepare-service' ? BackgroundServicePrepareRequestSchema : type === 'enable-service'
    ? BackgroundServiceEnableRequestSchema : BackgroundServiceActivationQuerySchema).safeParse(input);
  if (!request.success) return fail(appError('input_invalid', 'input', 'The service activation request is invalid.'));
  try {
    const raw = z.discriminatedUnion('ok', [z.object({ ok: z.literal(true), data: z.unknown() }).strict(),
      z.object({ ok: z.literal(false), error: AppErrorSchema }).strict()]).safeParse(await ipcRenderer.invoke(`flowmate:${type}`, request.data));
    if (raw.success) {
      if (!raw.data.ok) return fail(raw.data.error);
      const checked = response.safeParse(raw.data.data);
      if (checked.success) {
        const value = checked.data;
        if (type === 'prepare-service' || value && typeof value === 'object' && 'installationId' in value && 'operationId' in value
          && 'installationId' in request.data && 'operationId' in request.data && value.installationId === request.data.installationId
          && value.operationId === request.data.operationId && (type !== 'enable-service' || !('accepted' in value) || !value.accepted
            || 'expectedSettingsRevision' in value && 'expectedSettingsRevision' in request.data && value.expectedSettingsRevision === request.data.expectedSettingsRevision))
          return { ok: true, data: checked.data };
      }
    }
  } catch { /* Keep the original caller ID; a lost reply does not authorize another operation. */ }
  return fail(appError('service_activation_result_unknown', 'runtime', 'The original service activation response could not be confirmed. Query its saved operation ID.', true));
}

async function invokeEvaluation<K extends EvaluationResponseType>(type: K, input: EvaluationInput<K>): Promise<Result<EvaluationOutput<K>>> {
  const command = parseEvaluationCommand({ type, input });
  if (!command) return fail(appError('input_invalid', 'input', '评测请求无效。'));
  try {
    const result = parseEvaluationResponse(type, await ipcRenderer.invoke(`flowmate:${type.replaceAll('_', '-')}`, command.input));
    return result && matchesEvaluationResponse(command, result) ? result : fail(appError('evaluation_protocol_invalid', 'runtime', '评测回复不属于原请求。', true));
  } catch { return fail(appError('evaluation_response_unknown', 'runtime', '评测回复未知，请查询原请求。', true)); }
}

async function invokeAssembly<T>(type: string, input?: unknown): Promise<Result<T>> {
  const extension = isExtensionHostCommand(type);
  const [parse, result, matches, failure] = isPersonalAgentHostCommand(type)
    ? [parsePersonalAgentCommand, parsePersonalAgentHostResult, matchesPersonalAgentResponse, personalAgentHostFailure] : isResearchHostCommand(type)
    ? [parseResearchCommand, parseResearchHostResult, matchesResearchResponse, researchHostFailure] : isInputDefinitionHostCommand(type)
    ? [parseInputDefinitionCommand, parseInputDefinitionHostResult, matchesInputDefinitionResponse, inputDefinitionHostFailure]
    : isSubagentHostCommand(type)
    ? [parseSubagentCommand, parseSubagentHostResult, matchesSubagentResponse, subagentHostFailure]
    : extension ? [parseExtensionCommand, parseExtensionHostResult, matchesExtensionResponse, extensionHostFailure]
      : [parseResourceCommand, parseResourceHostResult, matchesResourceResponse, resourceHostFailure];
  const command = parse({ type, ...(input === undefined ? {} : { input }) });
  if (!command) return fail(appError('input_invalid', 'input', 'Resource request is invalid.'));
  try {
    const checked = result(type, await ipcRenderer.invoke(`flowmate:${type.replaceAll('_', '-')}`, input));
    if (!checked || !matches(command, checked)) return fail(appError('host_protocol_invalid', 'runtime', 'Resource response could not be verified.'));
    return checked as Result<T>;
  } catch { return failure(type) as Result<T>; }
}

const bridge: DesktopBridge = {
  async runEvaluationWorkflow(input) {
    const request = EvaluationWorkflowRequestSchema.safeParse(input);
    if (!request.success) return fail(appError('input_invalid', 'input', '评测闭环请求无效。'));
    try {
      const result = z.discriminatedUnion('ok', [z.object({ ok: z.literal(true), data: EvaluationWorkflowResultSchema }).strict(),
        z.object({ ok: z.literal(false), error: AppErrorSchema }).strict()]).safeParse(await ipcRenderer.invoke('flowmate:evaluation-workflow', request.data));
      if (!result.success || result.data.ok && result.data.data.action !== request.data.action)
        return fail(appError('evaluation_protocol_invalid', 'runtime', '评测闭环回复不属于原请求。', true));
      return result.data;
    } catch { return fail(appError('evaluation_response_unknown', 'runtime', '评测闭环回复未知，请查询原记录。', true)); }
  },
  backgroundService: { getServiceState: (...args: unknown[]) => args.length ? Promise.resolve(fail(appError('input_invalid', 'input', 'Service state takes no arguments.')))
      : invokeBackgroundService('get-service-state'),
    connect: input => invokeBackgroundService('connect-service', input), disconnect: input => invokeBackgroundService('disconnect-service', input),
    prepare: input => invokeServiceActivation('prepare-service', input, BackgroundServicePreparationSchema),
    enable: input => invokeServiceActivation('enable-service', input, BackgroundServiceActivationViewSchema),
    queryActivation: input => invokeServiceActivation('query-service-activation', input, BackgroundServiceActivationViewSchema) },
  personalAgent: { get: () => invokeAssembly('personal_agent_get', {}), update: input => invokeAssembly('personal_agent_update', input),
    openConversation: input => invokeAssembly('personal_agent_open_conversation', input) },
  invoiceWorks: { create: input => invokeAssembly('invoice_work_create', input), list: input => invokeAssembly('invoice_work_list', input),
    get: input => invokeAssembly('invoice_work_get', input), supplement: input => invokeAssembly('invoice_work_supplement', input),
    disposeItem: input => invokeAssembly('invoice_work_dispose_item', input), continueWork: input => invokeAssembly('invoice_work_continue', input),
    cancelWork: input => invokeAssembly('invoice_work_cancel', input), queryOperation: input => invokeAssembly('invoice_work_query_operation', input),
    timeline: input => invokeAssembly('invoice_work_timeline', input) },
  personalTasks: { list: input => invokeAssembly('personal_task_list', input), get: input => invokeAssembly('personal_task_get', input),
    stop: input => invokeAssembly('personal_task_stop', input), history: input => invokeAssembly('personal_task_history', input),
    historyEntry: input => invokeAssembly('personal_task_history_entry', input) },
  restartHost: (...args: unknown[]) => args.length ? Promise.resolve(fail(appError('input_invalid', 'input', 'Recheck takes no arguments.'))) : ipcRenderer.invoke('flowmate:restart-host'),
  async queryDiagnostics(...args: unknown[]) {
    if (args.length) return fail(appError('input_invalid', 'input', 'Diagnostics takes no arguments.'));
    try { const result = DiagnosticsResultSchema.safeParse(await ipcRenderer.invoke('flowmate:query-diagnostics'));
      return result.success ? result.data : fail(appError('diagnostics_unavailable', 'runtime', 'Diagnostics response is invalid.')); }
    catch { return fail(appError('diagnostics_unavailable', 'runtime', 'Diagnostics could not be collected.')); }
  },
  async exportDiagnostics(...args: unknown[]) {
    if (args.length) return fail(appError('input_invalid', 'input', 'Diagnostics export takes no arguments.'));
    try { const result = DiagnosticsExportResultSchema.safeParse(await ipcRenderer.invoke('flowmate:export-diagnostics'));
      return result.success ? result.data : fail(appError('diagnostics_export_failed', 'runtime', 'Diagnostics export response is invalid.')); }
    catch { return fail(appError('diagnostics_export_failed', 'runtime', 'Diagnostics could not be exported.')); }
  },
  queryEvaluationCatalog: input => invokeEvaluation('query_evaluation_catalog', input),
  addEvaluationFeedback: input => invokeEvaluation('add_evaluation_feedback', input),
  queryEvaluationFeedback: input => invokeEvaluation('query_evaluation_feedback', input),
  exportEvaluation: input => invokeEvaluation('export_evaluation', input),
  listEvaluationExecutions: (input = {}) => invokeEvaluation('list_evaluation_executions', input),
  queryEvaluationResult: input => invokeEvaluation('query_evaluation_result', input),
  compareEvaluation: input => invokeEvaluation('compare_evaluation', input),
  previewEvaluation: input => invokeEvaluation('preview_evaluation', input),
  startEvaluation: input => invokeEvaluation('start_evaluation', input),
  queryEvaluationControl: (input = {}) => invokeEvaluation('query_evaluation_control', input),
  cancelEvaluation: input => invokeEvaluation('cancel_evaluation', input),
  saveEvaluationSettings: input => invokeEvaluation('save_evaluation_settings', input),
  importResearchMaterial: input => invokeAssembly('import_research_material', input),
  listResearchMaterials: input => invokeAssembly('list_research_materials', input ?? {}),
  createResearchTask: input => invokeAssembly('create_research_task', input),
  listResearchTasks: input => invokeAssembly('list_research_tasks', input ?? {}),
  queryResearchTask: researchId => invokeAssembly('query_research_task', { researchId }),
  queryResearchForSession: input => invokeAssembly('query_research_for_session', input),
  queryResearchPlan: input => invokeAssembly('query_research_plan', input),
  queryResearchSource: input => invokeAssembly('query_research_source', input),
  queryResearchEvidence: input => invokeAssembly('query_research_evidence', input),
  queryResearchClaim: input => invokeAssembly('query_research_claim', input),
  queryResearchReport: input => invokeAssembly('query_research_report', input),
  listResearchSources: input => invokeAssembly('list_research_sources', input),
  listResearchClaims: input => invokeAssembly('list_research_claims', input),
  listResearchReports: input => invokeAssembly('list_research_reports', input),
  exportResearchReport: input => invokeAssembly('export_research_report', input),
  saveResearchExport: input => ipcRenderer.invoke('flowmate:save-research-export', input),
  listInputCommands: input => invokeAssembly('list_input_commands', input ?? {}),
  listSubagentDefinitions: () => invokeAssembly('list_subagent_definitions', {}),
  getSubagentDefinition: input => invokeAssembly('get_subagent_definition', input),
  saveSubagentDefinition: input => invokeAssembly('save_subagent_definition', input),
  listSubagents: input => invokeAssembly('list_subagents', input),
  querySubagent: input => invokeAssembly('query_subagent', input),
  cancelSubagent: input => invokeAssembly('cancel_subagent', input),
  listExtensions: () => invokeAssembly('list_extensions'),
  updateExtensionSelection: input => invokeAssembly('update_extension_selection', input),
  querySessionExtensions: input => invokeAssembly('query_session_extensions', input),
  queryRunExtensions: input => invokeAssembly('query_run_extensions', input),
  executeExtensionCommand: input => invokeAssembly('execute_extension_command', input),
  disposeSessionExtensions: input => invokeAssembly('dispose_session_extensions', input),
  listResources: () => invokeAssembly('list_resources'),
  readResourceFile: input => invokeAssembly('read_resource_file', input),
  updateResourceSelection: input => invokeAssembly('update_resource_selection', input),
  queryRunResources: input => invokeAssembly('query_run_resources', input),
  readRunResourceFile: input => invokeAssembly('read_run_resource_file', input),
  getState: () => ipcRenderer.invoke('flowmate:get-state'),
  listModelCatalog: (providerId, refresh = false) => ipcRenderer.invoke('flowmate:list-model-catalog', providerId, refresh),
  loginModel: (modelId, authType, requestId) => ipcRenderer.invoke('flowmate:login-model', modelId, authType, requestId),
  logoutModel: (modelId) => ipcRenderer.invoke('flowmate:logout-model', modelId),
  replyModelAuth: (requestId, promptId, value) => ipcRenderer.invoke('flowmate:reply-model-auth', requestId, promptId, value),
  cancelModelAuth: (requestId) => ipcRenderer.invoke('flowmate:cancel-model-auth', requestId),
  saveSettings: (settings: ProductSettings, credentialUpdate?: { modelId: string; apiKey: string }) =>
    ipcRenderer.invoke('flowmate:save-settings', settings, credentialUpdate),
  callProvider: (input: ProviderTestRequest) => ipcRenderer.invoke('flowmate:call-provider', input),
  cancelProvider: (requestId: string) => ipcRenderer.invoke('flowmate:cancel-provider', requestId),
  createSession: (request = {}) => ipcRenderer.invoke('flowmate:create-session', request),
  queryNativeTools: () => ipcRenderer.invoke('flowmate:query-native-tools'),
  chooseWorkingDirectory: () => ipcRenderer.invoke('flowmate:choose-working-directory'),
  renameSession: (request) => ipcRenderer.invoke('flowmate:rename-session', request),
  deleteSession: (sessionId) => ipcRenderer.invoke('flowmate:delete-session', sessionId),
  listSessions: (request = {}) => ipcRenderer.invoke('flowmate:list-sessions', request),
  querySession: (sessionId) => ipcRenderer.invoke('flowmate:query-session', sessionId),
  listSessionRuns: (request) => ipcRenderer.invoke('flowmate:list-session-runs', request),
  listSessionMessages: (request) => ipcRenderer.invoke('flowmate:list-session-messages', request),
  queryPromptTrace: (runId, callSequence) => ipcRenderer.invoke('flowmate:query-prompt-trace', runId, callSequence),
  startRun: (input) => ipcRenderer.invoke('flowmate:start-run', input),
  submitInput: input => ipcRenderer.invoke('flowmate:submit-input', input),
  listSessionInputs: input => ipcRenderer.invoke('flowmate:list-session-inputs', input),
  setSessionStatus: input => ipcRenderer.invoke('flowmate:set-session-status', input),
  branchSession: input => ipcRenderer.invoke('flowmate:branch-session', input),
  querySessionHistory: input => ipcRenderer.invoke('flowmate:query-session-history', input),
  querySessionHistoryEntry: input => ipcRenderer.invoke('flowmate:query-session-history-entry', input),
  forkSession: input => ipcRenderer.invoke('flowmate:fork-session', input),
  registerInvoiceFormTarget: input => ipcRenderer.invoke('flowmate:register-invoice-form-target', input),
  invalidateInvoiceFormTarget: id => ipcRenderer.invoke('flowmate:invalidate-invoice-form-target', id),
  setInvoiceFormDirty: (id, dirty, revision) => ipcRenderer.invoke('flowmate:set-invoice-form-dirty', id, dirty, revision),
  saveInvoiceCandidate: input => ipcRenderer.invoke('flowmate:save-invoice-candidate', input),
  acceptInvoiceCandidate: input => ipcRenderer.invoke('flowmate:accept-invoice-candidate', input),
  rejectInvoiceCandidate: input => ipcRenderer.invoke('flowmate:reject-invoice-candidate', input),
  exportInvoiceCandidate: input => ipcRenderer.invoke('flowmate:export-invoice-candidate', input),
  saveInvoiceExport: input => ipcRenderer.invoke('flowmate:save-invoice-export', input),
  queryInvoiceCandidateOperation: input => ipcRenderer.invoke('flowmate:query-invoice-candidate-operation', input),
  replyInvoiceFormInspect: (id, value) => ipcRenderer.invoke('flowmate:reply-invoice-form-inspect', id, value),
  onInvoiceFormInspect(listener) {
    const handler = (_event: Electron.IpcRendererEvent, value: { requestId: string; formInstanceId: string }) => listener(value.requestId, value.formInstanceId);
    ipcRenderer.on('flowmate:invoice-form-inspect', handler);
    return () => ipcRenderer.removeListener('flowmate:invoice-form-inspect', handler);
  },
  onInvoiceFormInspectFinished(listener) {
    const handler = (_event: Electron.IpcRendererEvent, value?: { unknownOperation?: import('@flowmate/contracts').InvoiceCandidateOperationQuery }) => listener(value?.unknownOperation);
    ipcRenderer.on('flowmate:invoice-form-inspect-finished', handler);
    return () => ipcRenderer.removeListener('flowmate:invoice-form-inspect-finished', handler);
  },
  startInvoiceFormRun: input => ipcRenderer.invoke('flowmate:start-invoice-form-run', input),
  querySessionInput: input => ipcRenderer.invoke('flowmate:query-session-input', input),
  queryInvoiceFormApplication: input => ipcRenderer.invoke('flowmate:query-invoice-form-application', input),
  replyInvoiceFormRequest: (id, receipt) => ipcRenderer.invoke('flowmate:reply-invoice-form-request', id, receipt),
  onInvoiceFormRequest(listener) {
    const handler = (_event: Electron.IpcRendererEvent, value: { requestId: string; request: import('@flowmate/contracts').InvoiceFormBridgeRequest }) => listener(value.requestId, value.request);
    ipcRenderer.on('flowmate:invoice-form-request', handler);
    return () => ipcRenderer.removeListener('flowmate:invoice-form-request', handler);
  },
  cancelRun: (runId) => ipcRenderer.invoke('flowmate:cancel-run', runId),
  queryRuntimeState: () => ipcRenderer.invoke('flowmate:query-runtime-state'),
  queryRun: (runId: number) => ipcRenderer.invoke('flowmate:query-run', runId),
  queryRuntimeEvents: input => ipcRenderer.invoke('flowmate:query-runtime-events', input),
  subscribeRuntimeEvents: input => ipcRenderer.invoke('flowmate:subscribe-runtime-events', input),
  unsubscribeRuntimeEvents: subscriptionId => ipcRenderer.invoke('flowmate:unsubscribe-runtime-events', subscriptionId),
  listRunToolCalls: input => ipcRenderer.invoke('flowmate:list-run-tool-calls', input),
  queryRunToolCall: input => ipcRenderer.invoke('flowmate:query-run-tool-call', input),
  listContextSnapshots: input => ipcRenderer.invoke('flowmate:list-context-snapshots', input),
  queryContextSnapshot: input => ipcRenderer.invoke('flowmate:query-context-snapshot', input),
  listContextRequests: input => ipcRenderer.invoke('flowmate:list-context-requests', input),
  compactSession: input => ipcRenderer.invoke('flowmate:compact-session', input),
  querySessionCompaction: input => ipcRenderer.invoke('flowmate:query-session-compaction', input),
  cancelSessionCompaction: input => ipcRenderer.invoke('flowmate:cancel-session-compaction', input),
  readWorkspace: () => ipcRenderer.invoke('flowmate:read-workspace'),
  restoreWorkspace: () => ipcRenderer.invoke('flowmate:restore-workspace'),
  updateWorkspace: (input) => ipcRenderer.invoke('flowmate:update-workspace', input),
  startTask: (input) => ipcRenderer.invoke('flowmate:start-task', input),
  queryTaskOperation: (sequence) => ipcRenderer.invoke('flowmate:query-task-operation', sequence),
  selectCandidate: (input) => ipcRenderer.invoke('flowmate:select-candidate', input),
  listDocuments: (request = {}) => ipcRenderer.invoke('flowmate:list-documents', request),
  queryDocument: (documentId) => ipcRenderer.invoke('flowmate:query-document', documentId),
  hideDocument: (documentId) => ipcRenderer.invoke('flowmate:hide-document', documentId),
  listJobs: (request = {}) => ipcRenderer.invoke('flowmate:list-jobs', request),
  queryJob: (jobId) => ipcRenderer.invoke('flowmate:query-job', jobId),
  hideJob: (jobId) => ipcRenderer.invoke('flowmate:hide-job', jobId),
  listJobCandidates: (request) => ipcRenderer.invoke('flowmate:list-job-candidates', request),
  queryJobCandidate: (request) => ipcRenderer.invoke('flowmate:query-job-candidate', request),
  listActivity: (request) => ipcRenderer.invoke('flowmate:list-activity', request),
  chooseAndImportInvoice: () => ipcRenderer.invoke('flowmate:choose-and-import-invoice'),
  readDocumentPage: (input) => ipcRenderer.invoke('flowmate:read-document-page', input),
  listDocumentPages: input => ipcRenderer.invoke('flowmate:list-document-pages', input),
  readDocumentOriginal: (documentId, page) => ipcRenderer.invoke('flowmate:read-document-original', documentId, page),
  revokeDocumentUse: (documentId) => ipcRenderer.invoke('flowmate:revoke-document-use', documentId),
  subscribe(listener: (event: DesktopEvent) => void) {
    const handler = (_event: Electron.IpcRendererEvent, value: DesktopEvent) => {
      if (!value || typeof value !== 'object') return;
      if (value.type === 'evaluation_event') {
        const parsed = EvaluationEventSchema.safeParse(value.value);
        if (!parsed.success || Object.keys(value).some(key => key !== 'type' && key !== 'value')) return;
        listener({ type: 'evaluation_event', value: parsed.data }); return;
      }
      listener(value);
    };
    ipcRenderer.on('flowmate:event', handler);
    void ipcRenderer.invoke('flowmate:subscribe');
    return () => {
      ipcRenderer.removeListener('flowmate:event', handler);
      void ipcRenderer.invoke('flowmate:unsubscribe');
    };
  },
};

contextBridge.exposeInMainWorld('flowmate', bridge);
