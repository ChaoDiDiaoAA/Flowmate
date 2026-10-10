import { expect, it } from 'bun:test';
import { parseResearchCommand, matchesResearchResponse, researchHostFailure } from '../../packages/contracts/src/research-commands.ts';
import { parseHostCommand, DesktopSessionInputRequestSchema } from '../../apps/host/protocol.ts';

it('validates research boundaries and rejects responses for another task or evidence source', () => {
  const command = { type: 'query_research_evidence', input: { researchId: 1, sourceSnapshotId: 2, offset: 20, limit: 30 } };
  expect(parseResearchCommand(command)).not.toBeNull();
  expect(parseHostCommand({ version: 1, requestId: 'research', ...command })).not.toBeNull();
  expect(parseResearchCommand({ ...command, input: { ...command.input, path: '../secret' } })).toBeNull();
  expect(matchesResearchResponse(command, { ok: true, data: { source: {}, excerpt: { start: 0, end: 1, quote: 'x' }, nextOffset: null } })).toBe(false);
  expect(researchHostFailure('create_research_task').error.code).toBe('operation_result_unknown');
  expect(researchHostFailure('query_research_evidence').error.code).toBe('storage_read_failed');
  const envelope = { version: 1, requestId: 'main-research', type: 'list_research_tasks', input: {} };
  expect(matchesResearchResponse(envelope, { ok: true, data: { items: [], nextBeforeId: null } })).toBe(true);
});

it('accepts explicit research input without invoice workspace or working directory', () => {
  const input = { sessionId: 1, clientSequence: 1, mode: 'prompt', text: 'Plan this research', modelId: 'test',
    research: { researchId: 2, phase: 'planning', plan: null } };
  expect(DesktopSessionInputRequestSchema.safeParse(input).success).toBe(true);
  expect(DesktopSessionInputRequestSchema.safeParse({ ...input, workingDirectory: 'C:/private' }).success).toBe(false);
});
