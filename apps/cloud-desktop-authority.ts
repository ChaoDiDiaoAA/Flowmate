import { appError, CloudChildReportRequestSchema, CloudChildReportSchema, CloudProgressRequestSchema, CloudResourceManifestSchema, CloudResourceReceiptSchema, CloudWorkspaceIdSchema, DurableSubagentRunOutputSchema, fail, ok,
  type DocumentRef, type ResourceSelection, type Result } from '@flowmate/contracts';
import { PersonalAgentCommandSchema, type PersonalAgentCommand } from '../packages/contracts/src/personal-agent-commands.ts';
import type { DbHandle, SqlDatabaseStore } from '../packages/core/src/storage/database.ts';
import type { CloudProgressHub } from './cloud-progress.ts';

const denied = () => fail(appError('cloud_workspace_forbidden', 'input', 'The requested cloud Work or material is not in this workspace.'));

export function createCloudProgressReader(database: Pick<DbHandle, 'read'>, rawWorkspaceId: string, hub: CloudProgressHub) {
  const workspaceId = CloudWorkspaceIdSchema.parse(rawWorkspaceId);
  return async (raw: unknown, signal?: AbortSignal) => {
    const parsed = CloudProgressRequestSchema.safeParse(raw); if (!parsed.success) return denied();
    const input = parsed.data;
    const authorized = () => database.read(scope => !!scope.db.query(`SELECT w.id FROM invoice_works w JOIN sessions s ON s.id=w.session_id
      WHERE w.id=? AND w.session_id=? AND s.cloud_workspace_id=? AND s.durable_runtime_id!='local'`).get(input.workId, input.sessionId, workspaceId));
    try {
      if (!await authorized()) return denied();
      const result = await hub.wait(input, signal); if (!result.ok) return result;
      return await authorized() ? result : denied();
    } catch { return fail(appError('cloud_progress_unavailable', 'storage', 'Cloud progress could not be authorized.', true)); }
  };
}

export function createCloudChildReportReader(database: Pick<DbHandle, 'read'>, rawWorkspaceId: string) {
  const workspaceId = CloudWorkspaceIdSchema.parse(rawWorkspaceId);
  return async (raw: unknown) => {
    const parsed = CloudChildReportRequestSchema.safeParse(raw); if (!parsed.success) return denied();
    const input = parsed.data;
    try { return await database.read(scope => {
      const parent = scope.db.query<{ run_id: number; durable_runtime_id: string }, [number, number, number, string]>(`SELECT a.run_id,s.durable_runtime_id
        FROM invoice_works w JOIN invoice_work_attempts a ON a.work_id=w.id JOIN sessions s ON s.id=w.session_id
        WHERE w.id=? AND w.session_id=? AND a.id=? AND s.cloud_workspace_id=? AND s.durable_runtime_id!='local'`)
        .get(input.workId, input.sessionId, input.attemptId, workspaceId);
      const run = scope.runs.get(input.childRunId), origin = scope.toolCalls.getById(input.originToolCallId);
      if (!parent || !run.ok || run.data.kind !== 'subagent' || !('runtimeKind' in run.data) || run.data.runtimeKind !== 'durable'
        || run.data.parentRunId !== parent.run_id || run.data.originToolCallId !== input.originToolCallId
        || run.data.scope.workId !== input.workId || run.data.scope.attemptId !== input.attemptId
        || !origin.ok || origin.data.runId !== parent.run_id || origin.data.sessionId !== input.sessionId || origin.data.toolName !== 'Agent') return denied();
      const childSession = scope.sessions.get(run.data.sessionId);
      if (!childSession.ok || childSession.data.runtimeKind !== 'durable' || childSession.data.cloudWorkspaceId !== workspaceId
        || childSession.data.durableRuntimeId !== parent.durable_runtime_id) return denied();
      const output = run.data.output === null ? null : DurableSubagentRunOutputSchema.parse(run.data.output);
      return ok(CloudChildReportSchema.parse({ ...input, output }));
    }); } catch { return fail(appError('storage_read_failed', 'storage', 'The original child report could not be read.', true)); }
  };
}

/** A desktop may address only Works and uploaded document versions owned by its workspace. */
export function createCloudDesktopAuthorizer(database: Pick<DbHandle, 'read'>, rawWorkspaceId: string):
  (command: PersonalAgentCommand) => Promise<Result<void>> {
  const workspaceId = CloudWorkspaceIdSchema.parse(rawWorkspaceId);
  return async raw => {
    const parsed = PersonalAgentCommandSchema.safeParse(raw); if (!parsed.success) return denied();
    try {
      return await database.read(scope => {
        const work = (workId: number) => scope.db.query(`SELECT w.id FROM invoice_works w JOIN sessions s ON s.id=w.session_id
          WHERE w.id=? AND s.durable_runtime_id!='local' AND s.cloud_workspace_id=?`).get(workId, workspaceId) !== null;
        const documents = (refs: readonly DocumentRef[]) => refs.every(ref => scope.db.query(`SELECT d.id FROM cloud_workspace_documents m
          JOIN documents d ON d.id=m.document_id AND d.version=m.document_version
          WHERE m.workspace_id=? AND m.document_id=? AND m.document_version=? AND d.status='available' AND d.hidden_at IS NULL`)
          .get(workspaceId, ref.id, ref.version) !== null);
        const resources = (selection: ResourceSelection) => [...(selection.prompt ? [selection.prompt] : []), ...selection.enabledSkills]
          .every(ref => {
            const rows = scope.db.query<{ upload_id: string; manifest_json: string; receipt_json: string }, [string, string, string, string]>(
              `SELECT r.upload_id,u.manifest_json,u.receipt_json FROM cloud_workspace_resources r JOIN cloud_resource_uploads u
                ON u.workspace_id=r.workspace_id AND u.upload_id=r.upload_id AND u.state='completed'
                WHERE r.workspace_id=? AND r.kind=? AND r.resource_id=? AND r.resource_version=?`)
              .all(workspaceId, ref.kind, ref.id, ref.version);
            return rows.some(row => {
              const receipt = CloudResourceReceiptSchema.safeParse(JSON.parse(row.receipt_json));
              const manifest = CloudResourceManifestSchema.safeParse(JSON.parse(row.manifest_json));
              return receipt.success && manifest.success && receipt.data.workspaceId === workspaceId && receipt.data.uploadId === row.upload_id
                && manifest.data.workspaceId === workspaceId && manifest.data.uploadId === row.upload_id
                && receipt.data.ref.kind === ref.kind && receipt.data.ref.id === ref.id && receipt.data.ref.version === ref.version
                && manifest.data.ref.kind === ref.kind && manifest.data.ref.id === ref.id && manifest.data.ref.version === ref.version;
            });
          });
        const command = parsed.data;
        switch (command.type) {
          case 'personal_agent_get': case 'invoice_work_list': return ok(undefined);
          case 'personal_agent_update': return command.input.configuration.workingDirectory === null && resources(command.input.configuration.resources) ? ok(undefined) : denied();
          case 'invoice_work_create': {
            const agent = scope.personalAgents.getDefault();
            return agent.ok && agent.data?.personalAgentId === command.input.personalAgentId && resources(agent.data.configuration.resources)
              && documents(command.input.documents) && (!command.input.source || work(command.input.source.workId)) ? ok(undefined) : denied();
          }
          case 'invoice_work_query_operation': return command.input.operation === 'create' || work(command.input.workId) ? ok(undefined) : denied();
          case 'personal_task_history': case 'personal_task_history_entry': return work(command.input.target.workId) ? ok(undefined) : denied();
          case 'invoice_work_supplement': return work(command.input.workId) && documents(command.input.materials) ? ok(undefined) : denied();
          case 'personal_agent_open_conversation': case 'invoice_work_get': case 'invoice_work_dispose_item': case 'invoice_work_continue':
          case 'invoice_work_cancel': case 'personal_task_list': case 'personal_task_get': case 'personal_task_stop': case 'invoice_work_timeline':
            return work(command.input.workId) ? ok(undefined) : denied();
        }
      });
    } catch { return fail(appError('cloud_authorization_unavailable', 'storage', 'The workspace authorization could not be verified.', true)); }
  };
}
