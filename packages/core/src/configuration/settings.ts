import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { z } from 'zod';
import { appError, fail, ok, RuntimeRequestOverridesSchema, ResourceSelectionSchema, EMPTY_RESOURCE_SELECTION } from '@flowmate/contracts';
import type { ProductSettings, Result } from '@flowmate/contracts';

const modelSchema = z.object({
  id: z.string().regex(/^[a-zA-Z0-9._-]{1,64}$/),
  credentialRef: z.string().regex(/^[a-zA-Z0-9_-]{16,80}$/),
  name: z.string().trim().min(1).max(128),
  kind: z.enum(['catalog', 'custom', 'legacy']),
  providerId: z.string().trim().min(1).max(128).nullable(),
  baseUrl: z.string().max(2048),
  model: z.string().trim().min(1).max(128),
  api: z.string().max(80),
  contextWindow: z.number().int().positive().nullable(),
  maxTokens: z.number().int().positive().nullable(),
  reasoning: z.boolean(),
}).strict().refine((model) => {
  if (model.kind === 'catalog') return model.providerId !== null && model.baseUrl === '' && model.api === ''
    && model.contextWindow === null && model.maxTokens === null;
  if (model.providerId !== null || !model.api) return false;
  if (model.kind === 'custom' && (model.contextWindow === null || model.maxTokens === null)) return false;
  if (model.kind === 'legacy' && (model.contextWindow !== null || model.maxTokens !== null)) return false;
  try {
    const url = new URL(model.baseUrl);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash;
  } catch { return false; }
}, 'baseUrl must be a credential-free HTTP URL');

const settingsSchema = z.object({
  version: z.literal(4),
  revision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  profile: z.object({
    displayName: z.string().trim().min(1).max(80),
    theme: z.enum(['system', 'light', 'dark']),
  }).strict(),
  models: z.array(modelSchema).max(32),
  defaultModelId: z.string().min(1).nullable(),
  runtime: RuntimeRequestOverridesSchema,
  resources: ResourceSelectionSchema,
  updatedAt: z.string().datetime({ offset: true }),
}).strict().refine((settings) => {
  const ids = new Set(settings.models.map((model) => model.id));
  const credentialRefs = new Set(settings.models.map((model) => model.credentialRef));
  return ids.size === settings.models.length && credentialRefs.size === settings.models.length
    && (settings.defaultModelId === null || ids.has(settings.defaultModelId));
}, 'model IDs must be unique and the default must exist');

export function defaultProductSettings(now = new Date().toISOString()): ProductSettings {
  return { version: 4, revision: 0, profile: { displayName: 'Local user', theme: 'system' }, models: [], defaultModelId: null,
    runtime: {}, resources: EMPTY_RESOURCE_SELECTION, updatedAt: now };
}

export function validateProductSettings(value: unknown): Result<ProductSettings> {
  const old = value !== null && typeof value === 'object' && !Array.isArray(value)
    && (value as { version?: unknown }).version === 1 && Array.isArray((value as { models?: unknown }).models)
    ? migrateVersionOne(value as Record<string, unknown>) : value;
  const normalized = old !== null && typeof old === 'object' && !Array.isArray(old)
    && (old as { version?: unknown }).version === 2 && !('runtime' in old)
    ? { ...old, version: 3, runtime: {} } : old;
  const upgraded = normalized !== null && typeof normalized === 'object' && !Array.isArray(normalized)
    && (normalized as { version?: unknown }).version === 3 && !('resources' in normalized)
    ? { ...normalized, version: 4, resources: EMPTY_RESOURCE_SELECTION } : normalized;
  const parsed = settingsSchema.safeParse(upgraded);
  return parsed.success
    ? ok(parsed.data)
    : fail(appError('config_settings_invalid', 'input', 'Model/Profile 配置无效。'));
}

function migrateVersionOne(value: Record<string, unknown>): unknown {
  const models = (value.models as unknown[]).filter((model) => !(model && typeof model === 'object'
    && (model as Record<string, unknown>).model === 'deepseek-flash'
    && (model as Record<string, unknown>).api === 'openai-responses')).map((model) => {
    if (!model || typeof model !== 'object' || Array.isArray(model)) return model;
    const { maxTokens: _retired, ...legacy } = model as Record<string, unknown>;
    return { ...legacy, kind: 'legacy', providerId: null, contextWindow: null, maxTokens: null, reasoning: false };
  });
  const defaultModelId = models.some((model) => model && typeof model === 'object'
    && (model as Record<string, unknown>).id === value.defaultModelId) ? value.defaultModelId : null;
  return { ...value, version: 2, models, defaultModelId };
}

export async function readProductSettings(file: string): Promise<Result<ProductSettings>> {
  let raw: string;
  try { raw = await readFile(file, 'utf8'); }
  catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return ok(defaultProductSettings());
    return fail(appError('config_settings_read_failed', 'storage', 'Model/Profile 配置不可读。', true));
  }
  let parsed: unknown;
  try { parsed = JSON.parse(raw) as unknown; }
  catch { return fail(appError('config_settings_invalid', 'storage', 'Model/Profile 配置不是有效 JSON。')); }
  const validated = validateProductSettings(parsed);
  return validated.ok ? validated : fail(appError('config_settings_invalid', 'storage', 'Model/Profile 配置无效。'));
}

export async function saveProductSettings(file: string, value: unknown, now = new Date().toISOString()): Promise<Result<ProductSettings>> {
  const validated = validateProductSettings(value);
  if (!validated.ok) return validated;
  const current = await readProductSettings(file);
  if (!current.ok) return current;
  if (validated.data.revision !== current.data.revision) {
    return fail(appError('config_revision_conflict', 'input', '配置已被其他操作更新，请重新加载后再保存。', true));
  }
  const settings: ProductSettings = { ...validated.data, revision: current.data.revision + 1, updatedAt: now };
  const temporary = `${file}.${randomUUID()}.tmp`;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    await mkdir(dirname(file), { recursive: true });
    handle = await open(temporary, 'wx', 0o600);
    await handle.writeFile(`${JSON.stringify(settings, null, 2)}\n`, 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, file);
    return ok(settings);
  } catch {
    try { await handle?.close(); } catch { /* keep original write error */ }
    try { await rm(temporary, { force: true }); } catch { /* keep original write error */ }
    return fail(appError('config_settings_write_failed', 'storage', 'Model/Profile 配置保存失败。', true));
  }
}
