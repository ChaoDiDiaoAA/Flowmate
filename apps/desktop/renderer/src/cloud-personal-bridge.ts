import { appError, CloudMaterialReceiptSchema, CloudWorkspaceIdSchema, fail, ok, type CloudDesktopApi, type DesktopBridge,
  type DocumentRef, type Result } from '@flowmate/contracts';
import { matchesPersonalAgentResponse, parsePersonalAgentCommand, parsePersonalAgentHostResult,
  personalAgentHostFailure } from '../../../../packages/contracts/src/personal-agent-commands.ts';
import { capturePersonalWrite, type PersonalWriteCommand } from './personal-state.ts';

/** Persisted upload identities are resolved before the cloud Work command is fixed. */
export async function prepareCloudPersonalWrite(cloud: Pick<CloudDesktopApi, 'upload'>, rawWorkspaceId: string,
  command: PersonalWriteCommand): Promise<Result<PersonalWriteCommand>> {
  const workspace = CloudWorkspaceIdSchema.safeParse(rawWorkspaceId);
  if (!workspace.success) return fail(appError('input_invalid', 'input', 'The cloud workspace is invalid.'));
  const original = structuredClone(command);
  const refs = original.type === 'invoice_work_create' && !original.input.source ? original.input.documents
    : original.type === 'invoice_work_supplement' ? original.input.materials : [];
  const uploaded: DocumentRef[] = [];
  for (const documentRef of refs) {
    const result = await cloud.upload({ workspaceId: workspace.data, documentRef }); if (!result.ok) return result;
    const receipt = CloudMaterialReceiptSchema.safeParse(result.data);
    if (!receipt.success || receipt.data.workspaceId !== workspace.data || receipt.data.sourceDocumentRef.id !== documentRef.id
      || receipt.data.sourceDocumentRef.version !== documentRef.version)
      return fail(appError('operation_result_unknown', 'runtime', 'The original cloud material receipt is unavailable.', true));
    uploaded.push(receipt.data.cloudDocumentRef);
  }
  const raw = original.type === 'invoice_work_create' && !original.input.source ? { ...original, input: { ...original.input, documents: uploaded } }
    : original.type === 'invoice_work_supplement' ? { ...original, input: { ...original.input, materials: uploaded } } : original;
  const prepared = capturePersonalWrite(raw);
  return prepared ? ok(prepared) : fail(appError('source_invalid', 'input', 'The uploaded invoice references are inconsistent.'));
}

/** The same Personal Agent UI can only address the explicitly selected cloud workspace. */
export function createCloudPersonalBridge(cloud: Pick<CloudDesktopApi, 'request'>, rawWorkspaceId: string):
Pick<DesktopBridge, 'personalAgent' | 'invoiceWorks' | 'personalTasks'> {
  const workspaceId = CloudWorkspaceIdSchema.parse(rawWorkspaceId);
  async function call<T>(raw: unknown): Promise<Result<T>> {
    const command = parsePersonalAgentCommand(raw);
    if (!command) return fail(appError('input_invalid', 'input', 'The cloud Personal Agent request is invalid.'));
    try {
      const result = await cloud.request({ workspaceId, command });
      const checked = parsePersonalAgentHostResult(command.type, result);
      if (checked && matchesPersonalAgentResponse(command, checked)) return checked as Result<T>;
    } catch { /* Preserve the original operation for receipt recovery. */ }
    return personalAgentHostFailure(command.type) as Result<T>;
  }
  return {
    personalAgent: { get: () => call({ type: 'personal_agent_get', input: {} }),
      update: input => call({ type: 'personal_agent_update', input }), openConversation: input => call({ type: 'personal_agent_open_conversation', input }) },
    invoiceWorks: { create: input => call({ type: 'invoice_work_create', input }), list: input => call({ type: 'invoice_work_list', input }),
      get: input => call({ type: 'invoice_work_get', input }), supplement: input => call({ type: 'invoice_work_supplement', input }),
      disposeItem: input => call({ type: 'invoice_work_dispose_item', input }), continueWork: input => call({ type: 'invoice_work_continue', input }),
      cancelWork: input => call({ type: 'invoice_work_cancel', input }), queryOperation: input => call({ type: 'invoice_work_query_operation', input }),
      listDesktopActions: input => call({ type: 'invoice_work_desktop_list', input }), decideDesktopAction: input => call({ type: 'invoice_work_desktop_decide', input }),
      rebindDesktopAction: input => call({ type: 'invoice_work_desktop_rebind', input }),
      discardDesktopAction: input => call({ type: 'invoice_work_desktop_discard', input }),
      queryDesktopDecision: input => call({ type: 'invoice_work_desktop_query_decision', input }),
      listBrowserReads: input => call({ type: 'invoice_work_browser_list', input }), decideBrowserRead: input => call({ type: 'invoice_work_browser_decide', input }),
      rebindBrowserRead: input => call({ type: 'invoice_work_browser_rebind', input }),
      revokeBrowserRead: input => call({ type: 'invoice_work_browser_revoke', input }), queryBrowserDecision: input => call({ type: 'invoice_work_browser_query_decision', input }),
      timeline: input => call({ type: 'invoice_work_timeline', input }) },
    personalTasks: { list: input => call({ type: 'personal_task_list', input }), get: input => call({ type: 'personal_task_get', input }),
      stop: input => call({ type: 'personal_task_stop', input }), history: input => call({ type: 'personal_task_history', input }),
      historyEntry: input => call({ type: 'personal_task_history_entry', input }) },
  };
}
