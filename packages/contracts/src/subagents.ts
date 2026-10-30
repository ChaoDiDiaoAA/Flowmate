import { InputDefinitionIdSchema, SubagentDefinitionSchema } from './input-commands.ts';
import { z } from 'zod';
import { AppErrorSchema, UsageRecordSchema, TokenColumnsSchema } from './runtime.ts';
import { ToolCallDeliverySchema } from './activity.ts';
import { RunScopeSchema } from './tool-config.ts';
import type { DbId, Result } from './runtime.ts';
import type { RequestContextBinding } from './context.ts';
import type { RunScope } from './tools.ts';
import type { AgentExecutionInput, AgentNativeOutcome, AgentObservation, RuntimeAgentConfigFacts, SafeConfigSnapshot } from './ports.ts';

export const SUBAGENT_ROLE = 'invoice-evidence-checker' as const;
export const SUBAGENT_SYSTEM_PROMPT = 'Verify invoice evidence using only the provided read-only tools and frozen document scope. Report findings, source references, uncertainties and missing evidence to the parent. Do not save candidates, edit files, run commands, delegate again or claim business completion.';
export const SUBAGENT_TOOL_NAMES = ['read', 'grep', 'find', 'ls', 'list_invoice_pages', 'read_invoice_document',
  'search_invoice_document', 'list_invoice_tables', 'read_invoice_evidence', 'check_invoice_sources', 'list_skill_resources', 'read_skill_resource'] as const;
const text = (maxBytes: number) => z.string().max(maxBytes).refine(value => value.trim().length > 0
  && new TextEncoder().encode(value).byteLength <= maxBytes, 'Text is empty or exceeds its UTF-8 byte limit.');
export const DelegateArgsSchema = z.object({ prompt: text(65000), description: text(512),
  subagent_type: InputDefinitionIdSchema, run_in_background: z.literal(false).optional().default(false) }).strict();
export type DelegateArgs = z.input<typeof DelegateArgsSchema>;
export { SUBAGENT_ERROR_CODES } from './errors.ts';
const id = z.number().int().positive().max(Number.MAX_SAFE_INTEGER), nativeId = z.string().min(1).max(256);
const time = z.string().datetime({ offset: true });
export const SubagentProvenanceSchema = z.object({ version: z.literal(1), role: InputDefinitionIdSchema, definition: SubagentDefinitionSchema.optional(),
  pluginVersion: z.literal('0.19.0'), patchVersion: z.enum(['flowmate-p13.1', 'flowmate-p13.2']), extensionInstanceId: z.string().uuid(),
  parentNativeSessionId: nativeId, parentContextSnapshotId: id, parentInputId: id, parentRequestSequence: id,
  childInputId: id }).strict().readonly();
export const SubagentSummarySchema = z.object({ childRunId: id, childSessionId: id, childNativeSessionId: nativeId,
  parentRunId: id, parentSessionId: id, originToolCallId: id, parentNativeToolCallId: nativeId, pluginAgentId: nativeId,
  role: InputDefinitionIdSchema, description: text(512), status: z.enum(['created', 'running', 'completed', 'failed', 'cancelled']),
  createdAt: time, startedAt: time.nullable(), endedAt: time.nullable(), cancelRequestedAt: time.nullable(), stoppedAt: time.nullable(),
}).strict().readonly();
export type SubagentSummary = z.infer<typeof SubagentSummarySchema>;
export const SubagentPageSchema = z.object({ items: z.array(SubagentSummarySchema).max(100).readonly(), nextBeforeRunId: id.nullable(),
  totals: TokenColumnsSchema }).strict().readonly();
export type SubagentPage = z.infer<typeof SubagentPageSchema>;
export const SubagentDetailSchema = SubagentSummarySchema.unwrap().extend({ scope: z.lazy(() => RunScopeSchema),
  output: z.record(z.unknown()).readonly().nullable(), error: AppErrorSchema.nullable(),
  usage: UsageRecordSchema, tokens: TokenColumnsSchema, delivery: ToolCallDeliverySchema,
  cleanup: z.record(z.unknown()).readonly(), historyUsable: z.boolean(), stopConfirmed: z.boolean(),
}).strict().refine(value => value.stopConfirmed === (value.cleanup.stopped === true && value.stoppedAt !== null),
  'Stop confirmation must have the saved stopped fact and timestamp.').readonly();
export type SubagentDetail = z.infer<typeof SubagentDetailSchema>;
export const ListSubagentsRequestSchema = z.object({ parentRunId: id, parentSessionId: id,
  beforeRunId: id.optional(), limit: z.number().int().min(1).max(100).default(20) }).strict();
export type ListSubagentsRequest = z.input<typeof ListSubagentsRequestSchema>;
export const QuerySubagentRequestSchema = z.object({ parentRunId: id, parentSessionId: id, childRunId: id }).strict();
export type QuerySubagentRequest = z.infer<typeof QuerySubagentRequestSchema>;
export const CancelSubagentRequestSchema = z.object({ parentRunId: id, childRunId: id }).strict();
export type CancelSubagentRequest = z.infer<typeof CancelSubagentRequestSchema>;
export const SubagentCancelReceiptSchema = z.object({ accepted: z.boolean(), cancelRequestedAt: time.nullable() }).strict().readonly();
export type SubagentCancelReceipt = z.infer<typeof SubagentCancelReceiptSchema>;

/** Constructed from a real parent tool request; never accepted as model parameters. */
export type SubagentOrigin = Readonly<{
  parentRunId: DbId; parentSessionId: DbId; parentNativeSessionId: string;
  originToolCallId: DbId; parentNativeToolCallId: string;
  extensionInstanceId: string; requestBinding: RequestContextBinding;
  delegateDeadlineAt?: number;
  delegateSignal?: AbortSignal;
}>;
export type PreparedSubagent = Readonly<{
  childRunId: DbId; childSessionId: DbId; childNativeSessionId: string;
  pluginAgentId: string; parentRunId: DbId; inputId: DbId; scope: RunScope;
  input: AgentExecutionInput; signal: AbortSignal;
  config: SubagentConfig;
  start(systemPrompt: string): Result<void> | Promise<Result<void>>;
  observe(event: AgentObservation): void;
}>;
export type SubagentConfig = SafeConfigSnapshot & {
  agent: RuntimeAgentConfigFacts; goalMode: 'answer';
  contextPolicyVersion: 'p8-context-v1'; workingDirectory?: string;
  historyPolicyVersion: 'p9-native-history-v1';
  subagent: z.infer<typeof SubagentProvenanceSchema>;
};
export type SubagentCallbacks = {
  prepare(origin: SubagentOrigin, pluginAgentId: string, args: DelegateArgs): Promise<Result<PreparedSubagent>>;
  finish(childRunId: DbId, outcome: AgentNativeOutcome): Promise<Result<void>>;
};

const subagentResult = <T extends z.ZodTypeAny>(data: T) => z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), data }).strict(), z.object({ ok: z.literal(false), error: AppErrorSchema, runId: id.optional() }).strict(),
]);
export const SubagentPageResultSchema = subagentResult(SubagentPageSchema);
export const SubagentDetailResultSchema = subagentResult(SubagentDetailSchema);
export const SubagentCancelResultSchema = subagentResult(SubagentCancelReceiptSchema);
export const SubagentCommandSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('list_subagents'), input: ListSubagentsRequestSchema }).strict(),
  z.object({ type: z.literal('query_subagent'), input: QuerySubagentRequestSchema }).strict(),
  z.object({ type: z.literal('cancel_subagent'), input: CancelSubagentRequestSchema }).strict(),
]);
export function parseSubagentCommand(value: unknown) { const parsed = SubagentCommandSchema.safeParse(value); return parsed.success ? parsed.data : null; }
const subagentResults = { list_subagents: SubagentPageResultSchema, query_subagent: SubagentDetailResultSchema, cancel_subagent: SubagentCancelResultSchema };
export function isSubagentHostCommand(type: string): type is keyof typeof subagentResults { return Object.hasOwn(subagentResults, type); }
export function parseSubagentHostResult(type: string, value: unknown) {
  if (!isSubagentHostCommand(type)) return null;
  const parsed = subagentResults[type].safeParse(value);
  return !parsed.success ? null : parsed.data.ok ? parsed.data : { ...parsed.data, error: { ...parsed.data.error,
    message: 'The child operation could not be completed. Query the saved child facts before retrying.' } };
}
export function matchesSubagentResponse(command: { type: string; input?: unknown }, value: unknown): boolean {
  const captured = parseSubagentCommand({ type: command.type, input: command.input });
  if (!captured) return false;
  const result = parseSubagentHostResult(captured.type, value); if (!result) return false;
  if (!result.ok) return result.error.runId === undefined || result.error.runId === captured.input.parentRunId
    || 'childRunId' in captured.input && result.error.runId === captured.input.childRunId;
  const data = result.data;
  if (captured.type === 'cancel_subagent') return 'accepted' in data;
  const owner = (item: SubagentSummary) => item.parentRunId === captured.input.parentRunId
    && 'parentSessionId' in captured.input && item.parentSessionId === captured.input.parentSessionId;
  if (captured.type === 'query_subagent') return 'childRunId' in data && owner(data) && data.childRunId === captured.input.childRunId;
  return 'items' in data && data.items.length <= captured.input.limit && data.items.every((item, index) => owner(item)
    && (captured.input.beforeRunId === undefined || item.childRunId < captured.input.beforeRunId)
    && (index === 0 || item.childRunId < data.items[index - 1]!.childRunId))
    && (data.nextBeforeRunId === null || data.items.length > 0 && data.nextBeforeRunId === data.items.at(-1)!.childRunId);
}
export function subagentHostFailure(type: string) {
  const operation = type === 'cancel_subagent';
  return { ok: false as const, error: { code: operation ? 'operation_result_unknown' : 'storage_read_failed',
    category: operation ? 'runtime' as const : 'storage' as const, retryable: true,
    message: operation ? 'Cancellation receipt is unknown. Query the original child before retrying.' : 'Saved child facts could not be read.' } };
}
