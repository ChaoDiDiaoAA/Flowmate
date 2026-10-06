import { z } from 'zod';
import type { AppError, DbId } from './runtime.ts';
import { RequestContextBindingSchema } from './context.ts';
import { MAX_TOOL_NAME_CHARS, MAX_TOOL_VERSION_CHARS, RunScopeSchema } from './tool-config.ts';
export { MAX_TOOL_NAME_CHARS, MAX_TOOL_VERSION_CHARS, RunScopeSchema } from './tool-config.ts';

// 工具身份的固定契约长度，供装配、记录与 Schema 共用。
/** Registration names; observed invalid attempts retain their original bounded strings. */
export const RegisteredToolNameSchema = z.string().regex(/^(?:Agent|[a-z][a-z0-9_]{0,127})$/);

export const ToolEffectSchema = z.enum(['PURE', 'READ', 'LOCAL_WRITE']);
export type ToolEffect = z.infer<typeof ToolEffectSchema>;

export const ToolExecutionModeSchema = z.enum(['sequential', 'parallel']);
export type ToolExecutionMode = z.infer<typeof ToolExecutionModeSchema>;

export const ToolIdentitySchema = z.object({
  name: z.string().min(1).max(MAX_TOOL_NAME_CHARS),
  version: z.string().min(1).max(MAX_TOOL_VERSION_CHARS),
  effect: ToolEffectSchema,
  executionMode: ToolExecutionModeSchema,
}).strict();

type RunScopeValues = z.infer<typeof RunScopeSchema>;
type ReadonlyScope<T> = {
  readonly [K in keyof T]: T[K] extends readonly unknown[] ? Readonly<T[K]> : T[K];
};
export type RunScope = ReadonlyScope<RunScopeValues>;
/** Historical draft records only. New executions use RunScope. */
export type LegacyRunScope = Readonly<Omit<RunScope, 'version'> & {
  version: 3; allowedWritePaths: readonly string[]; commandAccess: 'none' | 'trusted-local';
}>;
export type ToolIdentity = z.infer<typeof ToolIdentitySchema>;

export const NATIVE_TOOL_NAMES = ['read', 'grep', 'find', 'ls', 'edit', 'write', 'bash', 'powershell'] as const;
export type NativeToolName = typeof NATIVE_TOOL_NAMES[number];
export type NativeToolAvailability = { name: NativeToolName; available: boolean; reason: string | null };

function isJsonData(value: unknown): boolean {
  const pending = [value];
  const seen = new Set<object>();
  while (pending.length) {
    const item = pending.pop();
    if (item === null || typeof item === 'string' || typeof item === 'boolean') continue;
    if (typeof item === 'number') { if (!Number.isFinite(item)) return false; continue; }
    if (typeof item !== 'object' || Object.getOwnPropertySymbols(item).length) return false;
    if (seen.has(item)) continue;
    seen.add(item);
    const array = Array.isArray(item);
    if (!array && Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null) return false;
    const descriptors = Object.getOwnPropertyDescriptors(item);
    if (array && (Object.keys(descriptors).length !== item.length + 1 || Object.keys(descriptors).some(key =>
      key !== 'length' && (!/^(0|[1-9]\d*)$/.test(key) || Number(key) >= item.length)))) return false;
    for (const [key, descriptor] of Object.entries(descriptors)) {
      if (array && key === 'length') continue;
      if (!descriptor.enumerable || !('value' in descriptor)) return false;
      pending.push(descriptor.value);
    }
  }
  return true;
}

export const NativeToolOutputSchema = z.object({
  content: z.array(z.discriminatedUnion('type', [
    z.object({ type: z.literal('text'), text: z.string() }).strict(),
    z.object({ type: z.literal('image'), data: z.string(), mimeType: z.string().min(1) }).strict(),
  ])),
  details: z.unknown().optional(),
}).strict().superRefine((output, context) => {
  try {
    if (!isJsonData(output)) {
      context.addIssue({ code: 'custom', message: 'Native tool output must be JSON data.' });
    }
    JSON.stringify(output);
  } catch {
    context.addIssue({ code: 'custom', message: 'Native tool output must be JSON data.' });
  }
});
export type NativeToolOutput = z.infer<typeof NativeToolOutputSchema>;

export class ToolExecutionFailure<O = unknown> extends Error {
  readonly error: AppError;
  readonly data: O | undefined;
  constructor(error: AppError, data?: O) {
    super(error.message);
    this.name = 'ToolExecutionFailure';
    this.error = error;
    this.data = data;
  }
}

export const ToolExecutionContextSchema = z.object({
  runId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  sessionId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  nativeToolCallId: z.string().min(1).max(256),
  requestBinding: RequestContextBindingSchema.optional(),
  deadlineAt: z.number().finite().positive().optional(),
  scope: RunScopeSchema,
  signal: z.custom<AbortSignal>((value) => typeof value === 'object' && value !== null
    && typeof (value as AbortSignal).aborted === 'boolean'
    && typeof (value as AbortSignal).addEventListener === 'function'),
}).strict().refine(value => value.requestBinding === undefined
  || value.requestBinding.runId === value.runId && value.requestBinding.sessionId === value.sessionId,
  'Tool request binding belongs to a different Run or Session.');

export type ToolExecutionContext = Readonly<Omit<z.infer<typeof ToolExecutionContextSchema>, 'scope'> & { scope: RunScope }>;
export type ToolCallContext = Pick<ToolExecutionContext, 'nativeToolCallId' | 'signal' | 'requestBinding' | 'deadlineAt'>;
export type ProductToolContext = Pick<ToolExecutionContext, 'sessionId' | 'runId' | 'scope'>;

export type ToolResult<O> =
  | { status: 'succeeded'; data: O }
  | { status: 'failed' | 'cancelled'; error: AppError; data?: O };

export type ExecuteOptions = {
  timeoutMs?: number;
  signal?: AbortSignal;
};

export type Tool<I, O> = {
  name: string;
  version: string;
  description: string;
  inputSchema: z.ZodType<I>;
  outputSchema?: z.ZodType<O>;
  effect: ToolEffect;
};

export type AgentTool<I, O> = Tool<I, O> & {
  label?: string;
  executionMode: ToolExecutionMode;
  execute(input: I, call: ToolCallContext): Promise<O>;
};

export type ToolDefinition<I, O> = Omit<AgentTool<I, O>, 'execute'> & {
  execute(input: I, call: ToolCallContext, ctx: ProductToolContext): Promise<O>;
};

export { ToolIdentitySchema as toolIdentitySchema };
export type { DbId };
