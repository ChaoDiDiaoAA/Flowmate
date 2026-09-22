import { readFile } from 'node:fs/promises';
import { normalizeProviderConfig } from '@flowmate/contracts';
import { appError, fail } from '@flowmate/contracts';
import type { ProviderConfig, Result } from '@flowmate/contracts';

export async function loadProviderConfig(file: string): Promise<Result<ProviderConfig>> {
  let raw: string;
  try {
    raw = await readFile(file, 'utf8');
  } catch {
    return fail(appError('config_read_failed', 'input', 'Provider 配置文件不可读。'));
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return fail(appError('config_invalid', 'input', 'Provider 配置不是有效 JSON。'));
  }
  return normalizeProviderConfig(parsed);
}
