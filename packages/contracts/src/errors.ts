import type { AppError, ErrorCategory, Result } from './runtime.ts';

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
