import { isDeepStrictEqual } from 'node:util';

type Tokens = { inputTokens: number | null; outputTokens: number | null; totalTokens: number | null; cost: number | null };
type OriginalTokens = Omit<Tokens, 'cost'> & { cost: number | string | null };
type Run = { runId: number; sessionId: number; tokens: OriginalTokens };
type Compaction = { sessionId: number; operation: { operationId: string; runId: number | null; tokens: OriginalTokens } | null };

export function executionUsage(runs: Run[], compactions: Compaction[], complete: boolean): Tokens {
    const originals = new Map<string, OriginalTokens | null>();
    const add = (id: string, tokens: OriginalTokens | null) => {
        if (originals.has(id) && !isDeepStrictEqual(originals.get(id), tokens)) throw new Error('Conflicting original usage receipt');
        originals.set(id, tokens);
    };
    for (const run of runs) add('run:' + run.runId, run.tokens);
    for (const snapshot of compactions) {
        const operation = snapshot.operation;
        if (!operation) add('unknown-compaction:' + snapshot.sessionId, null);
        // Automatic summary calls are already included in the original Run's product usage.
        else if (operation.runId === null) add('manual:' + snapshot.sessionId + ':' + operation.operationId, operation.tokens);
    }
    const tokens = [...originals.values()];
    return Object.fromEntries((['inputTokens', 'outputTokens', 'totalTokens', 'cost'] as const).map(key => {
        const total = complete && tokens.length && tokens.every(t => t && t[key] !== null)
            ? tokens.reduce((sum, t) => sum + Number(t![key]), 0) : null;
        return [key, total !== null && total >= 0 && (key === 'cost' ? Number.isFinite(total) : Number.isSafeInteger(total)) ? total : null];
    })) as Tokens;
}
