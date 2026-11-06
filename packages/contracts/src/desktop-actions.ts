import { z } from 'zod';
import { AppErrorSchema } from './runtime.ts';
import { PersonalInvoiceFormObservationSchema } from './invoice.ts';

export const PERSONAL_DESKTOP_TOOL_NAMES = [
  'desktop_list_windows', 'desktop_observe_window', 'desktop_propose_action', 'desktop_execute_approved',
] as const;

const id = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const index = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const observation = { observationId: z.string().min(36).max(36).refine(value => z.string().uuid().safeParse(value).success), elementIndex: index };
const text = z.string().max(22_000).refine(value => new TextEncoder().encode(value).byteLength <= 22_000);

export const DesktopActionTargetSchema = z.object({
  connectionId: z.string().uuid(),
  window: z.object({ id, app: z.string().min(1).max(256), title: z.string().max(1024) }).strict(),
  element: z.string().min(1).max(4096),
}).strict();
export type DesktopActionTarget = z.infer<typeof DesktopActionTargetSchema>;

export const DesktopActionProposalSchema = z.union([
  z.object({ kind: z.literal('click'), ...observation }).strict(),
  z.object({ kind: z.literal('set_value'), ...observation, value: text }).strict(),
  z.object({ kind: z.literal('type_text'), ...observation, text }).strict(),
]);
export type DesktopActionProposal = z.infer<typeof DesktopActionProposalSchema>;

export const DesktopActionExecuteSchema = z.object({ proposalId: id }).strict();
export type DesktopActionExecute = z.infer<typeof DesktopActionExecuteSchema>;
export const DesktopActionDiscardSchema = DesktopActionExecuteSchema.extend({ workId: id, itemId: id }).strict();
export type DesktopActionDiscard = z.infer<typeof DesktopActionDiscardSchema>;

export const DesktopWindowSchema = DesktopActionTargetSchema.shape.window;
export const DesktopOwnerSchema = z.object({ workId: id, itemId: id }).strict();
export const DesktopWindowSelectionSchema = DesktopOwnerSchema.extend({ window: DesktopWindowSchema, workspaceId: z.string().uuid().optional() }).strict();
export const DesktopBridgeRequestSchema = z.discriminatedUnion('kind', [
  DesktopOwnerSchema.extend({ kind: z.literal('list') }).strict(),
  DesktopOwnerSchema.extend({ kind: z.literal('observe') }).strict(),
  DesktopOwnerSchema.extend({ kind: z.literal('form') }).strict(),
  DesktopOwnerSchema.extend({ kind: z.literal('resolve'), action: DesktopActionProposalSchema }).strict(),
  DesktopOwnerSchema.extend({ kind: z.literal('dispatch'), action: DesktopActionProposalSchema, target: DesktopActionTargetSchema, proposalId: id.optional() }).strict(),
]);
export type DesktopBridgeRequest = z.infer<typeof DesktopBridgeRequestSchema>;
const bridgeData = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('list'), windows: z.array(DesktopWindowSchema).max(100) }).strict(),
  z.object({ kind: z.literal('observe'), observationId: z.string().uuid(), window: DesktopWindowSchema,
    tree: z.string().max(22000).refine(value => new TextEncoder().encode(value).byteLength <= 22000), truncated: z.boolean() }).strict(),
  PersonalInvoiceFormObservationSchema.extend({ kind: z.literal('form') }).strict(),
  z.object({ kind: z.literal('resolve'), target: DesktopActionTargetSchema }).strict(),
  z.object({ kind: z.literal('dispatch') }).strict(),
]);
export const DesktopBridgeResultSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), data: bridgeData }).strict(),
  z.object({ ok: z.literal(false), error: AppErrorSchema }).strict(),
]);
export type DesktopBridgeResult = z.infer<typeof DesktopBridgeResultSchema>;
export function parseDesktopBridgeResult(request: DesktopBridgeRequest, value: unknown): DesktopBridgeResult | null {
  const result = DesktopBridgeResultSchema.safeParse(value);
  if (!result.success || result.data.ok && result.data.data.kind !== request.kind) return null;
  if (result.data.ok && request.kind === 'resolve' && result.data.data.kind === 'resolve'
    && !result.data.data.target.element.trimStart().startsWith(`[${request.action.elementIndex}]`)) return null;
  return result.data;
}

export const DesktopActionDecisionRequestSchema = z.object({
  workId: id, itemId: id, proposalId: id, expectedRevision: index,
  requestId: z.string().min(1).max(128).refine(value => value.trim().length > 0),
  decision: z.enum(['approve', 'reject']),
  confirmedAction: DesktopActionProposalSchema.optional(), confirmedTarget: DesktopActionTargetSchema.optional(),
}).strict();
export type DesktopActionDecisionRequest = z.infer<typeof DesktopActionDecisionRequestSchema>;

export const DesktopActionDecisionReceiptSchema = DesktopActionDecisionRequestSchema.extend({
  revision: index, receivedAt: z.string().datetime({ offset: true }),
}).strict().refine(value => value.expectedRevision < Number.MAX_SAFE_INTEGER && value.revision === value.expectedRevision + 1);
export type DesktopActionDecisionReceipt = z.infer<typeof DesktopActionDecisionReceiptSchema>;

export const DesktopActionViewSchema = z.object({
  proposalId: id, workId: id, itemId: id, proposalToolCallId: id,
  target: DesktopActionTargetSchema, action: DesktopActionProposalSchema,
  status: z.enum(['waiting', 'approved', 'rejected', 'claimed', 'dispatched', 'unknown', 'invalidated']),
  canDecide: z.boolean(), canReject: z.boolean(), executionToolCallId: id.nullable(),
  createdAt: z.string().datetime({ offset: true }), updatedAt: z.string().datetime({ offset: true }),
}).strict().refine(value => ['claimed', 'dispatched', 'unknown'].includes(value.status) === (value.executionToolCallId !== null)
  && (!value.canDecide || value.canReject) && (!value.canReject || value.status === 'waiting')
  && value.target.element.trimStart().startsWith(`[${value.action.elementIndex}]`));
export type DesktopActionView = z.infer<typeof DesktopActionViewSchema>;

export const DesktopActionListRequestSchema = z.object({
  workId: id, itemId: id, afterProposalId: id.optional(), limit: z.number().int().min(1).max(100).default(50),
}).strict();
export type DesktopActionListRequest = z.input<typeof DesktopActionListRequestSchema>;
export const DesktopActionListResultSchema = z.object({
  workId: id, itemId: id, items: z.array(DesktopActionViewSchema).max(100), nextAfterProposalId: id.nullable(),
}).strict().refine(value => value.items.every((item, i) => item.workId === value.workId && item.itemId === value.itemId
  && (i === 0 || item.proposalId > value.items[i - 1]!.proposalId))
  && (value.nextAfterProposalId === null || value.items.at(-1)?.proposalId === value.nextAfterProposalId)
  && new TextEncoder().encode(JSON.stringify(value)).byteLength <= 262_144);
export type DesktopActionListResult = z.infer<typeof DesktopActionListResultSchema>;

export const DesktopActionDecisionQuerySchema = z.object({ workId: id, itemId: id, proposalId: id, requestId: z.string().min(1).max(128) }).strict();
export type DesktopActionDecisionQuery = z.infer<typeof DesktopActionDecisionQuerySchema>;
