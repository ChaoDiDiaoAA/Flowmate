import type { Id } from './foundation.ts';

export interface ErrorDescriptor {
  version: 'error/v1';
  errorId: Id;
  code: string;
  category: string;
  source: { component: string; operation: string };
  safeMessage: string;
  impactScope: 'call' | 'step' | 'run' | 'job' | 'workspace' | 'host' | 'instance';
  recoveryAction:
    | 'correct_input'
    | 'retry_read'
    | 'query_action'
    | 'reauthorize'
    | 'resume_run'
    | 'manual_review'
    | 'none';
  correlation: {
    requestId?: Id;
    instanceId?: Id;
    workspaceId?: Id;
    documentId?: Id;
    artifactId?: Id;
  };
  diagnosticRef?: string;
}

export class ProductError extends Error {
  readonly descriptor: ErrorDescriptor;

  constructor(descriptor: ErrorDescriptor, options?: ErrorOptions) {
    super(descriptor.safeMessage, options);
    this.name = 'ProductError';
    this.descriptor = descriptor;
  }
}

export function productError(
  input: Omit<ErrorDescriptor, 'version' | 'errorId'> & { errorId?: Id },
  options?: ErrorOptions,
): ProductError {
  return new ProductError(
    {
      ...input,
      version: 'error/v1',
      errorId: input.errorId ?? crypto.randomUUID(),
    },
    options,
  );
}

export function isProductError(error: unknown): error is ProductError {
  return error instanceof ProductError;
}
