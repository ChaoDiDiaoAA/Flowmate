import { createHash } from 'node:crypto';

export function sha256Bytes(value: Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

export function sha256Text(value: string): string {
  return sha256Bytes(new TextEncoder().encode(value));
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value && typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const child = (value as Record<string, unknown>)[key];
      if (child !== undefined) result[key] = sortJson(child);
    }
    return result;
  }
  if (typeof value === 'number' && (!Number.isFinite(value) || !Number.isSafeInteger(value))) {
    throw new TypeError('canonical JSON only accepts finite safe integers');
  }
  if (typeof value === 'bigint' || typeof value === 'undefined') throw new TypeError('unsupported canonical JSON value');
  return value;
}

export function sha256Canonical(value: unknown): string {
  return sha256Text(canonicalJson(value));
}

export function nowUtc(): string {
  return new Date().toISOString();
}
