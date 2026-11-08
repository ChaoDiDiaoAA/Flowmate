import { z } from 'zod';
import { appError, fail, ok } from './errors.ts';
import { AppErrorSchema, type Result } from './runtime.ts';
import { MemoryEntriesPageSchema, MemoryEntriesRequestSchema, MemoryEntryDetailSchema, MemoryEntryRequestSchema,
  MemoryForgetRequestSchema, MemoryForgetResultSchema, MemoryOperationsPageSchema, MemoryOperationsRequestSchema, MemoryRecallResultSchema, MemorySearchRequestSchema,
  MemoryPolicyUpdateSchema, MemoryRememberRecoveryRequestSchema, MemoryRememberRecoveryResultSchema, MemoryRememberRequestSchema, MemoryRememberResultSchema, MemorySettingsViewSchema,
  MemorySyncRequestSchema, MemorySyncResultSchema } from './openviking-memory.ts';

const commands = [
  z.object({ type: z.literal('memory_get_settings'), input: z.object({}).strict() }).strict(),
  z.object({ type: z.literal('memory_list_entries'), input: MemoryEntriesRequestSchema }).strict(),
  z.object({ type: z.literal('memory_read_entry'), input: MemoryEntryRequestSchema }).strict(),
  z.object({ type: z.literal('memory_list_operations'), input: MemoryOperationsRequestSchema }).strict(),
  z.object({ type: z.literal('memory_search'), input: MemorySearchRequestSchema }).strict(),
  z.object({ type: z.literal('memory_update_policy'), input: MemoryPolicyUpdateSchema }).strict(),
  z.object({ type: z.literal('memory_remember'), input: MemoryRememberRequestSchema }).strict(),
  z.object({ type: z.literal('memory_reconcile_remember'), input: MemoryRememberRequestSchema }).strict(),
  z.object({ type: z.literal('memory_reconcile_remember_by_id'), input: MemoryRememberRecoveryRequestSchema }).strict(),
  z.object({ type: z.literal('memory_forget'), input: MemoryForgetRequestSchema }).strict(),
  z.object({ type: z.literal('memory_reconcile_sync'), input: MemorySyncRequestSchema }).strict(),
] as const;
export const MemoryCommandSchema = z.discriminatedUnion('type', commands)
  .refine(value => new TextEncoder().encode(JSON.stringify(value)).byteLength <= 262144);
export type MemoryCommand = z.infer<typeof MemoryCommandSchema>;
export type MemoryCommandType = MemoryCommand['type'];
export function memoryHostCommandTypes(): readonly MemoryCommandType[] { return commands.map(command => command.shape.type.value); }
export function memoryHostCommandSchemas(envelope: { version: z.ZodLiteral<1>; requestId: z.ZodString }) {
  return commands.map(command => command.extend(envelope));
}
export function isMemoryHostCommand(type: string): type is MemoryCommandType {
  return commands.some(command => command.shape.type.value === type);
}
export function parseMemoryCommand(raw: unknown): MemoryCommand | null {
  const parsed = MemoryCommandSchema.safeParse(raw); return parsed.success ? parsed.data : null;
}
export function memoryHostFailure(command: MemoryCommand): Extract<Result<never>, { ok: false }> {
  const write = ['memory_update_policy', 'memory_remember', 'memory_reconcile_remember', 'memory_reconcile_remember_by_id', 'memory_forget', 'memory_reconcile_sync'].includes(command.type);
  return { ok: false, error: appError(write ? 'operation_result_unknown' : 'memory_unavailable', 'runtime',
    write ? 'The original memory operation could not be confirmed.' : 'The original memory information is unavailable.', true) };
}
export function parseMemoryHostResult(command: MemoryCommand, raw: unknown): Result<unknown> | null {
  const schema = command.type === 'memory_get_settings' || command.type === 'memory_update_policy' ? MemorySettingsViewSchema
    : command.type === 'memory_list_entries' ? MemoryEntriesPageSchema : command.type === 'memory_read_entry' ? MemoryEntryDetailSchema
      : command.type === 'memory_list_operations' ? MemoryOperationsPageSchema : command.type === 'memory_search' ? MemoryRecallResultSchema : command.type === 'memory_forget' ? MemoryForgetResultSchema
        : command.type === 'memory_reconcile_remember_by_id' ? MemoryRememberRecoveryResultSchema
        : command.type === 'memory_reconcile_sync' ? MemorySyncResultSchema : MemoryRememberResultSchema;
  const result = z.discriminatedUnion('ok', [z.object({ ok: z.literal(true), data: schema }).strict(),
    z.object({ ok: z.literal(false), error: AppErrorSchema }).strict()]).safeParse(raw);
  if (!result.success || new TextEncoder().encode(JSON.stringify(result.data)).byteLength > 262144) return null;
  if (!result.data.ok) {
    const error = result.data.error;
    return error.runId === undefined && error.sessionId === undefined && error.toolCallId === undefined
      ? fail(appError(error.code, error.category, 'The memory operation could not be completed.', error.retryable)) : null;
  }
  const data = result.data.data;
  if (command.type === 'memory_search') return MemoryRecallResultSchema.safeParse(data).success ? ok(data) : null;
  if (command.type === 'memory_get_settings') return ok(data);
  if (command.type === 'memory_update_policy') {
    const value = MemorySettingsViewSchema.safeParse(data);
    return value.success && value.data.settings.revision === command.input.expectedRevision + 1
      && value.data.settings.provider === command.input.provider && value.data.settings.recallEnabled === command.input.recallEnabled
      && value.data.settings.captureMode === command.input.captureMode ? ok(value.data) : null;
  }
  if (command.type === 'memory_list_entries') {
    const page = MemoryEntriesPageSchema.safeParse(data);
    return page.success && page.data.items.length <= command.input.limit
      && page.data.items.every((item, index) => item.entryId > (index ? page.data.items[index - 1]!.entryId : command.input.afterId ?? 0))
      && (page.data.nextAfterId === null || page.data.items.length === command.input.limit && page.data.nextAfterId === page.data.items.at(-1)?.entryId)
      ? ok(page.data) : null;
  }
  if (command.type === 'memory_read_entry') {
    const value = MemoryEntryDetailSchema.safeParse(data); return value.success && value.data.entryId === command.input.entryId ? ok(value.data) : null;
  }
  if (command.type === 'memory_list_operations') {
    const page = MemoryOperationsPageSchema.safeParse(data);
    return page.success && page.data.items.length <= command.input.limit && page.data.items.every((item, index) => item.kind === command.input.kind
      && item.operationId > (index ? page.data.items[index - 1]!.operationId : command.input.afterId ?? 0))
      && (page.data.nextAfterId === null || page.data.items.length === command.input.limit && page.data.nextAfterId === page.data.items.at(-1)?.operationId)
      ? ok(page.data) : null;
  }
  if (command.type === 'memory_forget') {
    const value = MemoryForgetResultSchema.safeParse(data);
    return value.success && value.data.requestId === command.input.requestId && value.data.entryId === command.input.entryId ? ok(value.data) : null;
  }
  if (command.type === 'memory_reconcile_sync') {
    const value = MemorySyncResultSchema.safeParse(data); return value.success && value.data.syncId === command.input.syncId ? ok(value.data) : null;
  }
  if (command.type === 'memory_reconcile_remember_by_id') {
    const value = MemoryRememberRecoveryResultSchema.safeParse(data);
    return value.success && value.data.operationId === command.input.operationId && value.data.result.requestId === command.input.requestId ? ok(value.data) : null;
  }
  const value = MemoryRememberResultSchema.safeParse(data);
  return value.success && value.data.requestId === command.input.requestId ? ok(value.data) : null;
}
