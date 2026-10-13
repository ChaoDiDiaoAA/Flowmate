import { expect, test } from 'bun:test';
import { executionUsage } from '../../src/reports/usage.ts';

test('original Run and manual operation usage is counted once; automatic compaction stays in its Run', () => {
    const tokens = { inputTokens: 10, outputTokens: 2, totalTokens: 12, cost: 0.01 };
    const root = { runId: 1, sessionId: 1, tokens }, child = { runId: 2, sessionId: 2, tokens };
    const manual = { sessionId: 1, operation: { operationId: 'manual-3', runId: null, tokens } };
    const auto = { sessionId: 1, operation: { operationId: 'auto-4', runId: 1, tokens } };
    expect(executionUsage([root, root, child], [manual, manual, auto], true)).toEqual({ inputTokens: 30, outputTokens: 6, totalTokens: 36, cost: 0.03 });
    expect(executionUsage([root, { ...child, tokens: { ...tokens, cost: null } }], [], true)).toEqual({ inputTokens: 20, outputTokens: 4, totalTokens: 24, cost: null });
    expect(executionUsage([root], [], false)).toEqual({ inputTokens: null, outputTokens: null, totalTokens: null, cost: null });
    expect(executionUsage([], [], true).totalTokens).toBeNull();
    expect(executionUsage([{ ...root, tokens: { ...tokens, cost: '0.01' } }], [], true).cost).toBe(0.01);
    expect(executionUsage([root], [{ sessionId: 1, operation: null }], true).inputTokens).toBeNull();
    expect(() => executionUsage([root, { ...root, tokens: { ...tokens, totalTokens: 13 } }], [], true)).toThrow('Conflicting');
});
