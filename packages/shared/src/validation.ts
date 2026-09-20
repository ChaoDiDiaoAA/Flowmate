import { ProductError } from '../../contracts/src/errors.ts';

export function requireSha256(value: string, field: string): string {
  if (!/^[0-9a-f]{64}$/.test(value)) {
    throw new ProductError({
      version: 'error/v1',
      errorId: crypto.randomUUID(),
      code: 'INPUT_SCHEMA_INVALID',
      category: 'input',
      source: { component: 'contracts', operation: 'validate' },
      safeMessage: `${field} must be a lowercase SHA-256 digest`,
      impactScope: 'call',
      recoveryAction: 'correct_input',
      correlation: {},
    });
  }
  return value;
}

export function validateId(value: string, field: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value)) {
    throw new ProductError({
      version: 'error/v1', errorId: crypto.randomUUID(), code: 'INPUT_SCHEMA_INVALID', category: 'input',
      source: { component: 'contracts', operation: 'validate' }, safeMessage: `${field} has an invalid format`,
      impactScope: 'call', recoveryAction: 'correct_input', correlation: {},
    });
  }
  return value;
}

export function validatePurpose(value: string): 'development' | 'regression' {
  if (value !== 'development' && value !== 'regression') throw new Error('invalid purpose');
  return value;
}
