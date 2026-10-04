export const CONTEXT_POLICY = Object.freeze({
  version: 'p8-context-v1' as const,
  budgets: Object.freeze({ projectionBytes: 65536 as const, fragmentBytes: 4096 as const,
    fragments: 32 as const, issueCount: 20 as const, snapshotBytes: 262144 as const }),
  quoteMarginCodePoints: 128,
});
export const contextTextBytes = (text: string): number => new TextEncoder().encode(text).byteLength;
export const contextJsonBytes = (value: unknown): number => contextTextBytes(JSON.stringify(value));
