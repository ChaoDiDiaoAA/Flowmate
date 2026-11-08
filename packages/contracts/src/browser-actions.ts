import { z } from 'zod';

export const PERSONAL_BROWSER_TOOL_NAMES = ['browser_request_read', 'browser_read_approved'] as const;

const id = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const revision = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const requestId = z.string().min(1).max(128).refine(value => value.trim().length > 0);
const webUrl = z.string().url().max(2048).refine(value => {
  try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password; }
  catch { return false; }
});
const origin = z.string().max(2048).refine(value => {
  try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && url.origin === value; }
  catch { return false; }
});

export const BrowserTargetSchema = z.object({ connectionId: z.string().uuid(), bindingId: z.string().uuid(), origin }).strict();
export type BrowserTarget = z.infer<typeof BrowserTargetSchema>;
export const BrowserPageSchema = z.object({ url: webUrl, title: z.string().max(2048),
  text: z.string().max(22000).refine(value => new TextEncoder().encode(value).byteLength <= 22000), truncated: z.boolean() }).strict();
export type BrowserPage = z.infer<typeof BrowserPageSchema>;
export const BrowserToolInputSchema = z.object({}).strict();
export const BrowserOwnerSchema = z.object({ workId: id, itemId: id, workspaceId: z.string().uuid().optional() }).strict();
export const BrowserSelectionSchema = BrowserOwnerSchema.extend({ url: webUrl }).strict();
export type BrowserSelection = z.infer<typeof BrowserSelectionSchema>;
export const BrowserReadRebindSchema = z.object({ workId: id, itemId: id, proposalId: id,
  confirmedTarget: BrowserTargetSchema, currentTarget: BrowserTargetSchema, resume: z.literal(true).optional() }).strict();
export type BrowserReadRebind = z.infer<typeof BrowserReadRebindSchema>;
export function browserTabGroup(input: { workId: number; itemId: number; cloud: boolean }): string {
  return `Flowmate ${input.cloud ? 'Cloud' : 'Local'} Work ${input.workId} Item ${input.itemId}`;
}

export const BrowserReadViewSchema = z.object({ proposalId: id, workId: id, itemId: id, proposalToolCallId: id,
  target: BrowserTargetSchema, status: z.enum(['waiting', 'approved', 'rejected', 'claimed', 'completed', 'unknown', 'invalidated', 'revoked']),
  canDecide: z.boolean(), canReject: z.boolean(), canRevoke: z.boolean(), resumeOriginal: z.literal(true).optional(), executionToolCallId: id.nullable(),
  createdAt: z.string().datetime({ offset: true }), updatedAt: z.string().datetime({ offset: true }),
}).strict().refine(value => ['claimed', 'completed', 'unknown', 'revoked'].includes(value.status) === (value.executionToolCallId !== null)
  && (!value.canDecide || value.canReject) && (!value.canReject || value.status === 'waiting')
  && (!value.canRevoke || value.status === 'approved' || value.status === 'claimed' || value.status === 'completed'));
export type BrowserReadView = z.infer<typeof BrowserReadViewSchema>;
export const BrowserReadListRequestSchema = z.object({ workId: id, itemId: id, afterProposalId: id.optional(),
  limit: z.number().int().min(1).max(100).default(50) }).strict();
export type BrowserReadListRequest = z.input<typeof BrowserReadListRequestSchema>;
export const BrowserReadListResultSchema = z.object({ workId: id, itemId: id, items: z.array(BrowserReadViewSchema).max(100),
  nextAfterProposalId: id.nullable() }).strict().refine(value => value.items.every((item, index) => item.workId === value.workId
    && item.itemId === value.itemId && (index === 0 || item.proposalId > value.items[index - 1]!.proposalId))
    && (value.nextAfterProposalId === null || value.items.at(-1)?.proposalId === value.nextAfterProposalId)
    && new TextEncoder().encode(JSON.stringify(value)).byteLength <= 262144);
export type BrowserReadListResult = z.infer<typeof BrowserReadListResultSchema>;
export const BrowserReadRevokeSchema = z.object({ workId: id, itemId: id, proposalId: id }).strict();
export type BrowserReadRevoke = z.infer<typeof BrowserReadRevokeSchema>;

const decision = z.object({ workId: id, itemId: id, proposalId: id, expectedRevision: revision, requestId,
  decision: z.enum(['approve', 'reject']), confirmedTarget: BrowserTargetSchema.optional() }).strict();
export const BrowserReadDecisionRequestSchema = decision.refine(value => value.decision !== 'approve' || value.confirmedTarget !== undefined,
  'Approval requires the displayed browser target.');
export type BrowserReadDecisionRequest = z.infer<typeof BrowserReadDecisionRequestSchema>;
export const BrowserReadDecisionReceiptSchema = decision.extend({ revision, receivedAt: z.string().datetime({ offset: true }) }).strict()
  .refine(value => value.expectedRevision < Number.MAX_SAFE_INTEGER && value.revision === value.expectedRevision + 1
    && (value.decision !== 'approve' || value.confirmedTarget !== undefined));
export type BrowserReadDecisionReceipt = z.infer<typeof BrowserReadDecisionReceiptSchema>;
export const BrowserReadDecisionQuerySchema = z.object({ workId: id, itemId: id, proposalId: id, requestId }).strict();
export type BrowserReadDecisionQuery = z.infer<typeof BrowserReadDecisionQuerySchema>;
