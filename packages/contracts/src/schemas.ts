import { isAbsolute } from 'node:path';
import { z } from 'zod';
import { appError, fail, ok } from './errors.ts';
import type { AgentRunRequest, CreateSessionRequest, ListSessionsRequest, NormalizedAgentRunRequest, ProviderRequest, Result } from './runtime.ts';

const modelRefSchema = z
  .object({
    provider: z.string().trim().min(1).max(128),
    model: z.string().trim().min(1).max(128),
  })
  .strict();

const providerApiSchema = z.enum([
  'openai-completions',
  'openai-responses',
  'anthropic-messages',
  'google-generative-ai',
]);

const providerConfigSchema = z
  .object({
    version: z.literal(1),
    name: z.string().trim().min(1).max(128),
    revision: z.number().int().positive(),
    modelRef: modelRefSchema,
    native: z
      .object({
        authPath: z.string().min(1),
        modelsPath: z.string().min(1).nullable(),
      })
      .strict(),
    connection: z
      .object({
        baseUrl: z.string().url().max(2048),
        api: providerApiSchema,
      })
      .strict()
      .optional(),
    parameters: z
      .object({
        maxRetries: z.number().int().min(0).max(1).default(0),
        maxRetryDelayMs: z.number().int().min(1).max(5000).default(2000),
      })
      .strict(),
  })
  .strict();

const providerRequestSchema = z
  .object({
    goal: z.string().min(1),
    text: z.string(),
    config: providerConfigSchema,
    timeoutMs: z.number().int().min(100).max(120_000).default(60_000),
    stopGraceMs: z.number().int().min(100).max(10_000).default(5000),
  })
  .strict();

const createSessionSchema = z.object({ title: z.string().trim().min(1).max(120).optional() }).strict();
const listSessionsSchema = z.object({
  limit: z.number().int().min(1).max(100).default(50),
  before: z.object({ updatedAt: z.string().datetime({ offset: true }), sessionId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER) }).strict().optional(),
}).strict();
const agentRunSchema = z.object({
  sessionId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  text: z.string().min(1),
  config: providerConfigSchema,
  timeoutMs: z.number().int().min(100).max(120_000).default(60_000),
  stopGraceMs: z.number().int().min(100).max(10_000).default(5000),
}).strict();

export const INVOICE_CHAT_GOAL = 'Extract key invoice fields and clearly report missing or conflicting information.';
export const INVOICE_CHAT_SYSTEM_PROMPT = '你是 Flowmate 的发票摘要助手。根据用户提供的发票摘要和当前会话上下文，提取关键字段，明确指出缺失或互相矛盾的信息。不得猜测输入中不存在的值。';

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

export function normalizeCreateSessionRequest(raw: unknown): Result<{ title: string }> {
  const parsed = createSessionSchema.safeParse(raw ?? {});
  if (!parsed.success) return fail(appError('session_input_invalid', 'input', 'Session 创建参数无效。'));
  const title = parsed.data.title ?? 'New Session';
  if (byteLength(title) > 480) return fail(appError('session_title_too_large', 'input', 'Session 标题超过允许大小。'));
  return ok({ title });
}

export function normalizeListSessionsRequest(raw?: ListSessionsRequest): Result<{ limit: number; before?: NonNullable<ListSessionsRequest['before']> }> {
  const parsed = listSessionsSchema.safeParse(raw ?? {});
  return parsed.success ? ok(parsed.data) : fail(appError('session_query_invalid', 'input', 'Session 列表查询参数无效。'));
}

export function normalizeAgentRunRequest(raw: unknown): Result<NormalizedAgentRunRequest> {
  const parsed = agentRunSchema.safeParse(raw);
  if (!parsed.success) return fail(appError('agent_run_input_invalid', 'input', 'Agent Run 参数无效。'));
  if (!parsed.data.text.trim()) return fail(appError('agent_run_input_invalid', 'input', '消息不能为空。'));
  if (byteLength(`${INVOICE_CHAT_GOAL}\n\n${parsed.data.text}`) > 65_536) return fail(appError('input_too_large', 'input', 'Agent Run 正文超过允许大小。'));
  if (!isAbsolute(parsed.data.config.native.authPath)
    || (parsed.data.config.native.modelsPath !== null && !isAbsolute(parsed.data.config.native.modelsPath))) {
    return fail(appError('config_invalid', 'input', 'Provider 配置路径无效。'));
  }
  if (parsed.data.config.connection && !isSafeProviderBaseUrl(parsed.data.config.connection.baseUrl)) {
    return fail(appError('config_invalid', 'input', 'Provider Base URL 无效。'));
  }
  return ok({ ...parsed.data, goal: INVOICE_CHAT_GOAL });
}

export function normalizeProviderRequest(raw: unknown): Result<ProviderRequest> {
  const parsed = providerRequestSchema.safeParse(raw);
  if (!parsed.success) {
    return fail(appError('input_invalid', 'input', 'Provider 请求参数无效。'));
  }

  const request = parsed.data;
  if (!isAbsolute(request.config.native.authPath)) {
    return fail(appError('input_invalid', 'input', '认证路径必须是绝对路径。'));
  }
  if (request.config.native.modelsPath !== null && !isAbsolute(request.config.native.modelsPath)) {
    return fail(appError('input_invalid', 'input', '模型目录路径必须是绝对路径或 null。'));
  }
  if (request.config.connection && !isSafeProviderBaseUrl(request.config.connection.baseUrl)) {
    return fail(appError('input_invalid', 'input', 'Provider Base URL 无效。'));
  }
  if (byteLength(request.goal) > 4096) {
    return fail(appError('input_too_large', 'input', '用户目标超过允许大小。'));
  }
  if (byteLength(`${request.goal}\n\n${request.text}`) > 65_536) {
    return fail(appError('input_too_large', 'input', 'Provider 请求正文超过允许大小。'));
  }

  return ok(request);
}

export function normalizeProviderConfig(raw: unknown): Result<ProviderRequest['config']> {
  const parsed = providerConfigSchema.safeParse(raw);
  if (!parsed.success) {
    return fail(appError('config_invalid', 'input', 'Provider 配置无效。'));
  }
  if (!isAbsolute(parsed.data.native.authPath)) {
    return fail(appError('config_invalid', 'input', '认证路径必须是绝对路径。'));
  }
  if (parsed.data.native.modelsPath !== null && !isAbsolute(parsed.data.native.modelsPath)) {
    return fail(appError('config_invalid', 'input', '模型目录路径必须是绝对路径或 null。'));
  }
  if (parsed.data.connection && !isSafeProviderBaseUrl(parsed.data.connection.baseUrl)) {
    return fail(appError('config_invalid', 'input', 'Provider Base URL 无效。'));
  }
  return ok(parsed.data);
}

function isSafeProviderBaseUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === 'https:' || url.protocol === 'http:')
      && url.username.length === 0
      && url.password.length === 0
      && url.search.length === 0
      && url.hash.length === 0;
  } catch {
    return false;
  }
}
