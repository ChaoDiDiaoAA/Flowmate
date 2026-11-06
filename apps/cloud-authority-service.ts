import { appError, CloudWorkspaceIdSchema, fail, ok, type CloudQueuePort, type CloudRuntimeDeliveryPort, type DocumentOriginalImage, type DocumentRef, type DurableRuntimePort, type InvoiceToolInput, type InvoiceToolOutput, type Result,
  type WorkspaceMaterialInspection } from '@flowmate/contracts';
import type { PersonalAgentCommand } from '../packages/contracts/src/personal-agent-commands.ts';
import { CloudModelAttempts } from '../packages/core/src/personal-agent/cloud-model-attempts.ts';
import type { DbHandle, SqlDatabaseStore } from '../packages/core/src/storage/database.ts';
import type { InvoiceEditServiceOptions } from '../packages/core/src/invoice-edit/service.ts';
import type { WorkspaceVerifier } from '../packages/core/src/workspace/verification.ts';
import type { createFileStore } from '../packages/core/src/storage/file-store.ts';
import { CloudRuntimeToolsSchema, createCloudAuthorityRpcHandler, type CloudAuthorityCallbacks } from './cloud-authority-rpc.ts';
import { CloudDeepSeekProxy } from './cloud-deepseek-proxy.ts';
import { createCloudChildReportReader, createCloudDesktopAuthorizer, createCloudProgressReader } from './cloud-desktop-authority.ts';
import { CloudProgressHub } from './cloud-progress.ts';
import { createCloudDesktopHandler } from './cloud-desktop-gateway.ts';
import { CloudMaterialUpload } from './cloud-material-upload.ts';
import { listenCloudModelSocket } from './cloud-model-socket.ts';
import { CloudNativeResultReceiver } from './cloud-native-result-receiver.ts';
import { CloudQueueAuthority } from './cloud-queue-authority.ts';
import { CloudDesktopReview } from './cloud-desktop-review.ts';
import { CloudResourceUpload } from './cloud-resource-upload.ts';
import { CloudDeliveryAuthority } from './cloud-delivery-authority.ts';
import { createCloudRuntimeAuthorizer } from './cloud-runtime-authority.ts';
import { listenCloudUnixRpc } from './cloud-unix-rpc.ts';
import type { CloudDesktopRelay } from './cloud-desktop-relay.ts';
import type { PersonalAgentRuntime } from './personal-agent.ts';

type Options = { workspaceId: string; database: DbHandle; personal: PersonalAgentRuntime; runtime: DurableRuntimePort & { queue?: CloudQueuePort; delivery?: CloudRuntimeDeliveryPort };
  files: Pick<ReturnType<typeof createFileStore>, 'publish' | 'read'>;
  inspect(ref: DocumentRef, scope: SqlDatabaseStore): Result<WorkspaceMaterialInspection>;
  now(): string; readApiKey(): string | undefined | Promise<string | undefined>;
  readOriginal?(documentId: number, page: number): Promise<Result<DocumentOriginalImage>>;
  readPage?(input: InvoiceToolInput<'read_invoice_document'>): Promise<Result<InvoiceToolOutput<'read_invoice_document'>>>;
  verifyWorkspace?: WorkspaceVerifier; validateCandidate?: InvoiceEditServiceOptions['validate'];
  resourceRoot?: string; importedResourceRoot?: string;
  desktopSocket: string; authoritySocket: string; modelSocket: string;
  desktopRelay?: CloudDesktopRelay;
  fetch?: (url: string, init: RequestInit) => Promise<Response> };

/** Runs only under the existing product owner; each socket carries a separate limited protocol. */
export async function startCloudAuthorityEndpoints(options: Options): Promise<Result<{ stopDesktop(): Promise<Result<void>>; close(): Promise<Result<void>> }>> {
  const workspace = CloudWorkspaceIdSchema.safeParse(options.workspaceId), cloud = options.personal.cloudAuthority;
  if (!workspace.success || !cloud || cloud.workspaceId !== workspace.data || !CloudRuntimeToolsSchema.safeParse(cloud.tools).success
    || new Set([options.desktopSocket, options.authoritySocket, options.modelSocket]).size !== 3)
    return fail(appError('input_invalid', 'input', 'The cloud Authority configuration is invalid.'));
  const ledger = new CloudModelAttempts(options.database, cloud.governor, options.now);
  const progress = new CloudProgressHub();
  const recovered = await ledger.recoverSending(); if (!recovered.ok) return recovered;
  const originalAuthorize = createCloudRuntimeAuthorizer(options.database);
  const forbidden = () => fail(appError('cloud_workspace_forbidden', 'runtime', 'The original cloud workspace is unavailable.'));
  const authorizeRuntime: typeof originalAuthorize = async (operation, request) => {
    const grant = await originalAuthorize(operation, request);
    return !grant.ok ? grant : grant.data.binding.workspaceId === workspace.data ? grant : forbidden();
  };
  const guard = async <T>(owner: { workId: number; sessionId: number }, action: () => Promise<Result<T>>): Promise<Result<T>> => {
    const grant = await authorizeRuntime('queryHistory', { workId: owner.workId, sessionId: owner.sessionId });
    return grant.ok ? action() : grant;
  };
  const source = cloud.callbacks, child = source.subagents, compact = source.compactions;
  const callbacks: CloudAuthorityCallbacks = {
    readWorkingContext: input => guard(input, () => source.readWorkingContext(input)),
    verifyQueueInputs: input => guard(input, () => source.verifyQueueInputs ? source.verifyQueueInputs(input) : Promise.resolve(forbidden())),
    verifyWorkingContext: input => guard(input, () => source.verifyWorkingContext(input)),
    verifyModelUse: input => guard(input, () => source.verifyModelUse(input)),
    verifySchedulingUse: (input, pending) => guard(input, () => source.verifySchedulingUse(input, pending)),
    executeTool: input => guard(input, () => source.executeTool(input)),
    readToolResult: input => guard(input, () => source.readToolResult(input)),
    onToolFeedback: input => guard(input, () => source.onToolFeedback(input)),
    subagents: child ? { readPlan: input => guard(input, () => child.readPlan(input)), verify: input => guard(input, () => child.verify(input)),
      adopt: input => guard(input, () => child.adopt(input)), reserveModelRequest: input => guard(input, () => child.reserveModelRequest(input)),
      onParentConsumed: input => guard(input, () => child.onParentConsumed(input)) } : undefined,
    compactions: compact ? { readPlan: input => guard(input, () => compact.readPlan(input)), verify: input => guard(input, () => compact.verify(input)),
      reserveModelRequest: input => guard(input, () => compact.reserveModelRequest(input)) } : undefined,
  };
  const receiver = new CloudNativeResultReceiver(options.database, options.runtime, options.now);
  const missingQueue = () => fail(appError('cloud_queue_unavailable', 'runtime', 'The original native queue is unavailable.', true));
  const queue = new CloudQueueAuthority({ database: options.database, workspaceId: workspace.data,
    runtime: options.runtime.queue ?? { read: async () => missingQueue(), apply: async () => missingQueue(), queryControl: async () => missingQueue() },
    now: options.now, onChanged: () => options.personal.conditionsChanged(), authorize: (input, view, scope) => {
      if (input.action.kind === 'enqueue') return scope.db.query(`SELECT id FROM invoice_work_phases WHERE work_id=? AND attempt_id=?
        AND request_id=? AND native_submission_id IS NOT NULL AND closed_at IS NULL`).get(input.workId, input.attemptId, input.action.phaseRequestId)
        ? ok(undefined) : fail(appError('source_invalid', 'input', 'The original invoice phase is unavailable.'));
      const ids = input.action.kind === 'reorder' ? input.action.submissionIds : [input.action.submissionId];
      for (const id of ids) if (!view.items.some(item => item.submissionId === id))
        return fail(appError('source_invalid', 'input', 'The original queue input is not authorized for this Work.'));
      return ok(undefined);
    } });
  cloud.attachQueue(queue);
  const proxy = new CloudDeepSeekProxy({ ledger, readApiKey: options.readApiKey, fetch: options.fetch,
    onText: (request, text) => progress.publishText({ workId: request.workId, sessionId: request.sessionId, attemptId: request.attemptId,
      requestId: request.requestId, modelAttemptId: request.modelAttemptId }, text),
    onTextGap: request => progress.discardText({ workId: request.workId, sessionId: request.sessionId }) });
  const material = new CloudMaterialUpload({ database: options.database, files: options.files, inspect: options.inspect, now: options.now });
  const review = options.readOriginal ? new CloudDesktopReview({ database: options.database, workspaceId: workspace.data,
    readOriginal: options.readOriginal, readPage: options.readPage, now: options.now,
    verifyWorkspace: options.verifyWorkspace, validateCandidate: options.validateCandidate }) : undefined;
  const resources = options.resourceRoot && options.importedResourceRoot ? new CloudResourceUpload({ database: options.database,
    resourceRoot: options.resourceRoot, importedResourceRoot: options.importedResourceRoot, now: options.now }) : undefined;
  const delivery = options.runtime.delivery ? new CloudDeliveryAuthority({ database: options.database, workspaceId: workspace.data, runtime: options.runtime.delivery }) : undefined;
  const dispatch = async (command: PersonalAgentCommand): Promise<unknown> => {
    const { agent, works, tasks } = options.personal.personal;
    switch (command.type) {
      case 'personal_agent_get': return agent.get();
      case 'personal_agent_update': return agent.update(command.input);
      case 'personal_agent_open_conversation': return agent.openConversation(command.input);
      case 'invoice_work_create': return works.create(command.input);
      case 'invoice_work_list': return works.list(command.input);
      case 'invoice_work_get': return works.get(command.input);
      case 'invoice_work_supplement': return works.supplement(command.input);
      case 'invoice_work_dispose_item': return works.disposeItem(command.input);
      case 'invoice_work_continue': return works.continueWork(command.input);
      case 'invoice_work_cancel': return works.cancelWork(command.input);
      case 'invoice_work_query_operation': return works.queryOperation(command.input);
      case 'invoice_work_desktop_list': return works.listDesktopActions(command.input);
      case 'invoice_work_desktop_decide': return works.decideDesktopAction(command.input);
      case 'invoice_work_desktop_discard': return works.discardDesktopAction(command.input);
      case 'invoice_work_desktop_query_decision': return works.queryDesktopDecision(command.input);
      case 'personal_task_list': return tasks.list(command.input);
      case 'personal_task_get': return tasks.get(command.input);
      case 'personal_task_stop': return tasks.stop(command.input);
      case 'personal_task_history': return tasks.history(command.input);
      case 'personal_task_history_entry': return tasks.historyEntry(command.input);
      case 'invoice_work_timeline': return works.timeline(command.input);
    }
  };
  const authority = await listenCloudUnixRpc({ socketPath: options.authoritySocket, allowStaleSocket: true,
    handle: createCloudAuthorityRpcHandler(authorizeRuntime, callbacks, async notice => { progress.publish(notice); options.personal.conditionsChanged(); return ok(undefined); },
      async event => {
        if (event.workspaceId !== workspace.data) return forbidden();
        const receipt = await receiver.receive(event);
        if (receipt.ok) options.personal.conditionsChanged();
        return receipt;
      }, cloud.tools) });
  if (!authority.ok) return authority;
  const model = await listenCloudModelSocket({ socketPath: options.modelSocket, proxy, allowStaleSocket: true, prepare: async input => {
    if (input.workspaceId !== workspace.data) return forbidden();
    const grant = await authorizeRuntime('observeSubmission', { workId: input.workId, sessionId: input.sessionId,
      attemptId: input.attemptId, requestId: input.requestId });
    if (!grant.ok) return grant;
    if (grant.data.binding.cloudRuntimeId !== input.cloudRuntimeId) return forbidden();
    const phase = await cloud.reconcilePhase({ workId: input.workId, sessionId: input.sessionId, attemptId: input.attemptId, requestId: input.requestId });
    return !phase.ok ? phase : phase.data ? ok(undefined)
      : fail(appError('source_invalid', 'runtime', 'The original model phase could not be reconciled.'));
  } });
  if (!model.ok) { const closed = await authority.data.close(); return closed.ok ? model : closed; }
  const desktop = await listenCloudUnixRpc({ socketPath: options.desktopSocket, allowStaleSocket: true,
    handle: createCloudDesktopHandler({ workspaceId: workspace.data, authorize: createCloudDesktopAuthorizer(options.database, workspace.data), dispatch, material, resources, queue, review, delivery,
      desktopRelay: options.desktopRelay,
      childReport: createCloudChildReportReader(options.database, workspace.data), progress: createCloudProgressReader(options.database, workspace.data, progress) }) });
  if (!desktop.ok) { const modelClosed = await model.data.close(), authorityClosed = await authority.data.close();
    return !modelClosed.ok ? modelClosed : !authorityClosed.ok ? authorityClosed : desktop; }
  let desktopClosing: Promise<Result<void>> | undefined, closing: Promise<Result<void>> | undefined;
  const stopDesktop = () => { progress.close(); options.desktopRelay?.close(); return desktopClosing ??= desktop.data.close(); };
  return ok({ stopDesktop, close() {
    closing ??= (async () => {
      const first = await stopDesktop(), second = await model.data.close(), third = await authority.data.close();
      return !first.ok ? first : !second.ok ? second : third;
    })(); return closing;
  } });
}
