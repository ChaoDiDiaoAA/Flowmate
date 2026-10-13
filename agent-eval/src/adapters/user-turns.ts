import { z } from 'zod';
import { userTurnSchema, type UserTurn } from '../dataset-loader/authoring.ts';
import { controllerStepsSchema } from '../dataset-loader/schema.ts';

type Step = z.infer<typeof controllerStepsSchema>[number];
type TextStep = Extract<Step, { action: 'user-message' | 'invoice-message' | 'research-plan' | 'research-confirm' }>;
export type ResolvedStep = Exclude<Step, TextStep> | (TextStep & { instruction: string });

export function userTurn(turns: readonly UserTurn[] | undefined, id: string): UserTurn {
    const matches = (turns ?? []).filter(turn => turn.id === id);
    if (matches.length !== 1) throw new Error('Unknown or duplicate user turn reference: ' + id);
    return userTurnSchema.parse(matches[0]);
}
/** Resolve only inside the controller; the returned steps must never become a product mount. */
export function resolveUserSteps(steps: unknown, turns: readonly UserTurn[] | undefined): ResolvedStep[] {
    const parsedTurns = z.array(userTurnSchema).parse(turns ?? []);
    if (new Set(parsedTurns.map(turn => turn.id)).size !== parsedTurns.length) throw new Error('Duplicate user turn identity');
    return controllerStepsSchema.parse(steps).map(step => {
        if ('turnId' in step && step.turnId) return { ...step, instruction: userTurn(parsedTurns, step.turnId).content } as ResolvedStep;
        if ('instruction' in step && parsedTurns.some(turn => turn.content === step.instruction))
            throw new Error('Later user turn text must use turnId instead of an inline copy');
        return step as ResolvedStep;
    });
}

const accepted = z.object({ ok: z.literal(true), data: z.object({ inputId: z.number().int().positive(), runId: z.number().int().positive(), sessionId: z.number().int().positive() }).passthrough() }).passthrough();
const input = z.object({ inputId: z.number(), runId: z.number().nullable(), sessionId: z.number(), mode: z.string(), status: z.string(),
    nativeEntryId: z.string().nullable(), content: z.object({ text: z.string() }).passthrough() }).passthrough();
export function observeUserTurns(turns: readonly UserTurn[], receipts: readonly { turnId?: string; submittedText?: string; result: unknown }[], inputs: readonly unknown[]) {
    const actual = z.array(input).parse(inputs);
    return turns.map(turn => {
        const sent = receipts.filter(receipt => receipt.turnId === turn.id);
        if (!sent.length) return { turnId: turn.id, mode: turn.mode ?? 'prompt', status: 'planned' as const, submitted: false, accepted: false, consumed: false };
        const receipt = accepted.safeParse(sent.at(-1)!.result);
        if (!receipt.success) return { turnId: turn.id, mode: turn.mode ?? 'prompt', status: z.object({ok:z.literal(false)}).passthrough().safeParse(sent.at(-1)!.result).success?'rejected' as const:'submitted' as const,
            submitted: true, accepted: false, consumed: false };
        const owner = receipt.data.data;
        const consumed = actual.find(value => value.inputId === owner.inputId && value.runId === owner.runId && value.sessionId === owner.sessionId &&
            value.mode === (turn.mode ?? 'prompt') && value.content.text === (sent.at(-1)!.submittedText ?? turn.content) && value.status === 'consumed' && value.nativeEntryId !== null);
        return { turnId: turn.id, mode: turn.mode ?? 'prompt', status: consumed ? 'consumed' as const : 'accepted' as const,
            submitted: true, accepted: true, consumed: !!consumed, ...owner };
    });
}
