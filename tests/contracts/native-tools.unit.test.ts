import { describe, expect, it } from 'bun:test';
import * as contracts from '../../packages/contracts/src/index.ts';

const config = { version: 1, name: 'fixture', revision: 1,
  modelRef: { provider: 'fixture', model: 'fixture-model' },
  native: { authPath: 'C:\\Users\\test\\.pi\\auth.json', modelsPath: null },
  parameters: { maxRetries: 0, maxRetryDelayMs: 2000 } };
const request = { sessionId: 4, text: 'List this working directory.', config };
const workspace = { revision: 2, documentRef: { id: 1, version: 'v1' }, jobId: 2, candidateRef: null, sessionId: 4 };
const scope = { version: 2 as const, allowedTools: [], allowedDocumentIds: [], allowedArtifactIds: [], allowedResourcePaths: [] };

describe('Pi native tool contracts', () => {
  it('accepts an optional working directory on ordinary answer and save-candidate requests', () => {
    expect(contracts.normalizeAgentRunRequest(request)).toMatchObject({ ok: true, data: { goalMode: 'answer' } });
    for (const goalMode of ['answer', 'save-candidate']) {
      expect(contracts.normalizeAgentRunRequest({ ...request, workspace, goalMode, workingDirectory: 'D:\\work' }))
        .toMatchObject({ ok: true, data: { goalMode, workingDirectory: 'D:\\work', workspace } });
    }
    for (const workingDirectory of ['', ' ', 'relative', 'D:\\work\u0000root', 'D:\\work\nroot']) {
      expect(contracts.normalizeAgentRunRequest({ ...request, workingDirectory })).toMatchObject({ ok: false });
    }
    for (const extra of [{ goalMode: 'local-task' }, { localTask: { workingDirectory: 'D:\\work' } },
      { commandAccess: 'trusted-local' }, { scope }]) {
      expect(contracts.normalizeAgentRunRequest({ ...request, ...extra })).toMatchObject({ ok: false });
    }
    expect(contracts.normalizeAgentRunRequest({ ...request, goalMode: 'save-candidate', workingDirectory: 'D:\\work' }))
      .toMatchObject({ ok: false });
    expect(contracts.normalizeAgentRunRequest({ ...request, workingDirectory: 'D:\\work' })).toMatchObject({ ok: false });
  });

  it('keeps the existing scope without a native path or command permission layer', () => {
    expect(contracts.RunScopeSchema.parse(scope)).toEqual(scope);
    for (const value of [{ ...scope, version: 3 }, { ...scope, allowedWritePaths: ['D:\\work'] },
      { ...scope, commandAccess: 'trusted-local' }]) expect(contracts.RunScopeSchema.safeParse(value).success).toBe(false);
    expect(contracts.normalizeCreateSessionRequest({ title: 'Task', toolProfile: 'trusted-local' })).toMatchObject({ ok: false });
    const session = { sessionId: 4, nativeSessionId: 'native-session', title: 'Task', status: 'active',
      createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z', availability: 'ready',
      historyState: 'recoverable', activeRunId: null, modelUseBlocked: false, deletePending: false, hasBusinessHistory: false };
    expect(contracts.SessionSnapshotSchema.safeParse(session).success).toBe(true);
    expect(contracts.SessionSnapshotSchema.safeParse({ ...session, toolProfile: 'trusted-local' }).success).toBe(false);
  });

  it('preserves SDK text, image, details and large output while rejecting unsafe JSON', () => {
    const output: contracts.NativeToolOutput = { content: [{ type: 'text', text: 'two files' }, { type: 'image', data: 'aW1hZ2U=', mimeType: 'image/png' }],
      details: { paths: ['a.txt', 'b.txt'], truncated: true, fullOutputPath: 'D:\\sdk\\output.txt' } };
    expect(contracts.NativeToolOutputSchema.parse(output)).toEqual(output);
    const large: contracts.NativeToolOutput = { content: [{ type: 'text', text: '界'.repeat(90_000) }], details: { oversized: 'x'.repeat(262_144) } };
    expect(contracts.NativeToolOutputSchema.parse(large)).toEqual(large);
    const cycle: Record<string, unknown> = {}; cycle.self = cycle;
    for (const value of [
      { ...output, isError: true }, { content: [{ type: 'image', data: 'bytes' }] },
      { content: [{ type: 'text', text: 'output', extra: true }] },
      ...[Number.NaN, Number.POSITIVE_INFINITY, 1n, undefined, () => null, new Date(), cycle,
        new Array(1), Object.assign(new Array(1), { extra: true })].map(details => ({ ...output, details })),
    ]) expect(contracts.NativeToolOutputSchema.safeParse(value).success).toBe(false);
  });

  it('keeps eight names separate from invoice tools and carries failure data intact', () => {
    expect(contracts.NATIVE_TOOL_NAMES).toEqual(['read', 'grep', 'find', 'ls', 'edit', 'write', 'bash', 'powershell']);
    expect(contracts.INVOICE_REVIEW_TOOL_NAMES).toHaveLength(13);
    expect(contracts.INVOICE_TOOL_NAMES).toHaveLength(14);
    const error = contracts.appError('tool_execution_failed', 'tool', 'Command failed.');
    const data = { content: [{ type: 'text', text: 'partial output' }], details: { exitCode: 1 } };
    const failure = new contracts.ToolExecutionFailure(error, data);
    expect(failure).toBeInstanceOf(Error); expect(failure.error).toBe(error); expect(failure.data).toBe(data);
  });
});
