import { z } from 'zod';
import * as R from './research.ts';

export const researchOperations = {
  import_research_material: ['importResearchMaterial', R.ImportResearchMaterialSchema, R.ResearchMaterialResultSchema],
  list_research_materials: ['listResearchMaterials', R.ResearchPageRequestSchema, R.ResearchMaterialsResultSchema],
  create_research_task: ['createResearchTask', R.CreateResearchTaskSchema, R.ResearchTaskResultSchema],
  list_research_tasks: ['listResearchTasks', R.ResearchPageRequestSchema, R.ResearchTasksResultSchema],
  query_research_task: ['queryResearchTask', z.object({ researchId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER) }).strict(), R.ResearchTaskResultSchema],
  query_research_for_session: ['queryResearchForSession', R.ResearchSessionRequestSchema, R.ResearchSessionResultSchema],
  query_research_plan: ['queryResearchPlan', R.ResearchPlanRequestSchema, R.ResearchPlanResultSchema],
  query_research_source: ['queryResearchSource', R.ResearchSourceRequestSchema, R.ResearchSourceResultSchema],
  query_research_evidence: ['queryResearchEvidence', R.ResearchEvidenceRequestSchema, R.ResearchEvidenceResultSchema],
  query_research_claim: ['queryResearchClaim', R.ResearchClaimRequestSchema, R.ResearchClaimResultSchema],
  query_research_report: ['queryResearchReport', R.ResearchReportRequestSchema, R.ResearchReportResultSchema],
  list_research_sources: ['listResearchSources', R.ResearchSourcesRequestSchema, R.ResearchSourcesResultSchema],
  list_research_claims: ['listResearchClaims', R.ResearchClaimsRequestSchema, R.ResearchClaimsResultSchema],
  list_research_reports: ['listResearchReports', R.ResearchSourcesRequestSchema, R.ResearchReportsResultSchema],
  export_research_report: ['exportResearchReport', R.ResearchReportRequestSchema, R.ResearchExportResultSchema],
} as const;
export type ResearchCommandType = keyof typeof researchOperations;
export function isResearchHostCommand(type: string): type is ResearchCommandType { return Object.hasOwn(researchOperations, type); }
export function parseResearchCommand(value: unknown) {
  const envelope = z.object({ type: z.string(), input: z.unknown() }).strict().safeParse(value);
  if (!envelope.success || !isResearchHostCommand(envelope.data.type)) return null;
  const input = researchOperations[envelope.data.type][1].safeParse(envelope.data.input);
  return input.success ? { type: envelope.data.type, input: input.data } : null;
}
export function parseResearchHostResult(type: string, value: unknown) {
  if (!isResearchHostCommand(type)) return null;
  const parsed = researchOperations[type][2].safeParse(value);
  if (!parsed.success) return null;
  return parsed.data.ok ? parsed.data : { ...parsed.data, error: { ...parsed.data.error,
    message: 'The research operation could not be completed. Refresh the saved task before trying again.' } };
}
export function matchesResearchResponse(command: { type: string; input?: unknown }, value: unknown): boolean {
  const captured = parseResearchCommand({ type: command.type, input: command.input }), result = parseResearchHostResult(command.type, value);
  if (!captured || !result) return false;
  if (!result.ok) return true;
  if (result.data === null) return command.type === 'query_research_for_session';
  const input = captured.input as Record<string, unknown>, data = result.data as Record<string, unknown>;
  if (input.researchId !== undefined && data.researchId !== undefined && data.researchId !== input.researchId) return false;
  for (const key of ['planId', 'sourceSnapshotId', 'claimId', 'reportId'])
    if (input[key] !== undefined && data[key] !== undefined && data[key] !== input[key]) return false;
  if ('source' in data) {
    const source = data.source as R.SourceSnapshot, excerpt = data.excerpt as { start: number };
    if (source.researchId !== input.researchId || source.sourceSnapshotId !== input.sourceSnapshotId || excerpt.start !== (input.offset ?? 0)) return false;
  }
  if (Array.isArray(data.items) && input.researchId !== undefined && data.items.some(item => item.researchId !== input.researchId
    || input.planId !== undefined && item.planId !== input.planId)) return false;
  if (command.type === 'create_research_task' && data.sessionId !== input.sessionId) return false;
  if (command.type === 'query_research_for_session' && data.sessionId !== input.sessionId) return false;
  return true;
}
export function researchHostFailure(type: string) {
  const write = type === 'import_research_material' || type === 'create_research_task';
  return { ok: false as const, error: { code: write ? 'operation_result_unknown' : 'storage_read_failed',
    category: write ? 'runtime' as const : 'storage' as const, retryable: true,
    message: write ? 'The result is unknown. Refresh saved research before retrying.' : 'Research could not be read. Refresh to retry.' } };
}
