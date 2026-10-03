import type { AppError, ErrorCategory, Result } from './runtime.ts';
import type { ContextSafeErrorCode } from './context.ts';

export const CONTEXT_ERROR_FACTS: Readonly<Partial<Record<ContextSafeErrorCode, readonly [AppError['category'], boolean]>>> = {
  context_evidence_too_large: ['runtime', false], context_binding_unknown: ['runtime', false],
  context_binding_conflict: ['runtime', false], context_payload_mismatch: ['runtime', false],
  context_snapshot_not_found: ['input', false], provider_transport_error: ['provider', false], internal_error: ['internal', false],
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
