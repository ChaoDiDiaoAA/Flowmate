import type { AppError, ErrorCategory, Result } from './runtime.ts';
import type { ContextSafeErrorCode } from './context.ts';

export const SUBAGENT_ERROR_CODES = ['subagent_origin_invalid', 'subagent_identity_conflict', 'subagent_role_denied',
  'subagent_tool_denied', 'subagent_busy', 'subagent_depth_exceeded', 'subagent_foreground_required',
  'subagent_execution_failed', 'subagent_stop_unconfirmed', 'subagent_persist_failed'] as const;

export const CONTEXT_ERROR_FACTS: Readonly<Partial<Record<ContextSafeErrorCode, readonly [AppError['category'], boolean]>>> = {
  resource_manifest_invalid: ['input', false], resource_name_conflict: ['input', false],
  resource_version_changed: ['input', false], resource_dependency_missing: ['input', false],
  resource_required_unavailable: ['input', false], resource_content_too_large: ['input', false],
  resource_file_unavailable: ['input', false], resource_bundle_unavailable: ['storage', true],
  resource_expansion_mismatch: ['runtime', false], resource_evidence_conflict: ['runtime', false],
  resource_evidence_write_failed: ['storage', true], config_revision_conflict: ['input', true],
  config_settings_write_failed: ['storage', true],
  compaction_unavailable: ['runtime', false], compaction_not_needed: ['runtime', false],
  compaction_failed: ['runtime', false], compaction_cancelled: ['runtime', false],
  compaction_timeout: ['runtime', false], compaction_capacity_exceeded: ['runtime', false],
  context_evidence_too_large: ['runtime', false], context_binding_unknown: ['runtime', false],
  context_binding_conflict: ['runtime', false], context_payload_mismatch: ['runtime', false],
  context_snapshot_not_found: ['input', false], provider_transport_error: ['provider', false], internal_error: ['internal', false],
  subagent_origin_invalid: ['runtime', false], subagent_identity_conflict: ['runtime', false],
  subagent_role_denied: ['tool', false], subagent_tool_denied: ['tool', false], subagent_busy: ['runtime', true],
  subagent_depth_exceeded: ['runtime', false], subagent_foreground_required: ['runtime', false],
  subagent_execution_failed: ['runtime', false], subagent_stop_unconfirmed: ['runtime', true], subagent_persist_failed: ['storage', true],
};

export function appError(
  code: string,
  category: ErrorCategory,
  message: string,
  retryable = false,
  runId?: number,
  sessionId?: number,
  toolCallId?: string,
): AppError {
  return {
    code, category, message, retryable,
    ...(runId === undefined ? {} : { runId }),
    ...(sessionId === undefined ? {} : { sessionId }),
    ...(toolCallId === undefined ? {} : { toolCallId }),
  };
}

export function ok<T>(data: T): Result<T> {
  return { ok: true, data };
}

export function fail<T = never>(error: AppError, runId?: number): Result<T> {
  return { ok: false, error, ...(runId === undefined ? {} : { runId }) };
}
