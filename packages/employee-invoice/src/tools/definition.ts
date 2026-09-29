import type { Result } from '@flowmate/contracts';

export function unwrap<T>(result: Result<T>): T {
  if (!result.ok) throw result.error;
  return result.data;
}
