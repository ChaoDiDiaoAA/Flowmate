import { describe, expect, it } from 'bun:test';
import { z } from 'zod';
import { parseHostCommand } from '../../apps/host/protocol.ts';
import { PersonalAgentCommandSchema, isPersonalAgentHostCommand, matchesPersonalAgentResponse,
  parsePersonalAgentCommand, parsePersonalAgentHostResult, personalAgentHostFailure,
  personalAgentHostCommandSchemas } from '../../packages/contracts/src/personal-agent-commands.ts';

const at = '2026-10-29T00:00:00.000Z';
const configuration = { modelId: null, thinkingLevel: 'off', preferences: '', workingDirectory: null,
  resources: { prompt: null, enabledSkills: [] }, extensions: { enabledExtensions: [] }, tools: [] } as const;
const snapshot = { personalAgentId: 1, revision: 2, runtimeKind: 'durable', configuration, createdAt: at, updatedAt: at } as const;
const attempt = { attemptId: 21, runId: 31, runtimeLinked: true };
const work = { workId: 7, personalAgentId: 1, sessionId: 70, runtimeKind: 'durable', revision: 3, goal: 'Organize invoices.',
  status: 'open', createdAt: at, updatedAt: at, counts: { total: 1, unresolved: 1, accepted: 0, rejected: 0, excluded: 0 },
  execution: { attempt, runStatus: 'running', queued: false, requiresContinue: false, stopUnconfirmed: false,
    waitingReason: null, ownedChildRunIds: [] }, actions: [] } as const;
const task = { workId: 7, sessionId: 70, attempt, runStatus: 'running', createdAt: at, queued: false,
  stopRequestedAt: null, stoppedAt: null } as const;
const receipt = { operation: 'continueWork', workId: 7, requestId: 'continue-1', revision: 4, receivedAt: at,
  execution: { kind: 'accepted', authorizationAccepted: true, attempt, relation: 'new' } } as const;
const continued = { type: 'invoice_work_continue', input: { workId: 7, requestId: 'continue-1', expectedRevision: 3, expectedAttemptId: 21 } };
const ok = <T>(data: T) => ({ ok: true as const, data });

describe('P18 command protocol', () => {
  it('admits exactly the product commands and rejects native authority and internal resume', () => {
    const commands = [
      { type: 'personal_agent_get', input: {} },
      { type: 'personal_agent_update', input: { personalAgentId: 1, expectedRevision: 1, configuration } },
      { type: 'personal_agent_open_conversation', input: { workId: 7 } },
      { type: 'invoice_work_create', input: { personalAgentId: 1, expectedAgentRevision: 2, requestId: 'create-1', goal: 'Organize.', documents: [{ id: 11, version: 'v1' }] } },
      { type: 'invoice_work_list', input: { personalAgentId: 1 } },
      { type: 'invoice_work_get', input: { view: 'work', workId: 7 } },
      { type: 'invoice_work_supplement', input: { workId: 7, itemId: 71, todoId: 81, requestId: 'supplement-1', expectedRevision: 3, text: 'Clarification.', materials: [] } },
      { type: 'invoice_work_dispose_item', input: { workId: 7, itemId: 71, requestId: 'dispose-1', expectedRevision: 3, decision: { kind: 'excluded', reason: 'User excluded this invoice.' } } },
      continued,
      { type: 'invoice_work_cancel', input: { workId: 7, requestId: 'cancel-1', expectedRevision: 3 } },
      { type: 'invoice_work_query_operation', input: { operation: 'create', personalAgentId: 1, requestId: 'create-1' } },
      { type: 'personal_task_list', input: { workId: 7 } },
      { type: 'personal_task_get', input: { workId: 7, attemptId: 21 } },
      { type: 'personal_task_stop', input: { workId: 7, attemptId: 21, requestId: 'stop-1', expectedRevision: 3 } },
      { type: 'personal_task_history', input: { target: { workId: 7 } } },
      { type: 'personal_task_history_entry', input: { target: { workId: 7 }, throughEntryId: 9, entryId: 8 } },
      { type: 'invoice_work_timeline', input: { workId: 7 } },
    ];
    expect(personalAgentHostCommandSchemas({ version: z.literal(1), requestId: z.string().min(1) })).toHaveLength(17);
    for (const command of commands) {
      expect(PersonalAgentCommandSchema.safeParse(command).success).toBe(true);
      expect(parseHostCommand({ version: 1, requestId: 'transport-1', ...command })).not.toBeNull();
      expect(isPersonalAgentHostCommand(command.type)).toBe(true);
      expect(parsePersonalAgentCommand({ ...command, input: { ...command.input, nativeTaskId: 'native' } })).toBeNull();
    }
    for (const type of ['personal_task_resume', 'resume_attempt', 'submit_session_input', 'call_harness'])
      expect(parsePersonalAgentCommand({ type, input: { workId: 7, attemptId: 21 } })).toBeNull();
    expect(parseHostCommand({ version: 1, requestId: 'transport-1', type: 'personal_task_resume', input: { workId: 7, attemptId: 21 } })).toBeNull();
    expect(parsePersonalAgentCommand({ ...continued, input: { ...continued.input, expectedAttemptId: undefined } })).toBeNull();
    expect(parsePersonalAgentCommand({ type: 'invoice_work_get', input: { view: 'work', workId: 0 } })).toBeNull();
  });

  it('matches immutable operation receipts to the original operation and product ownership', () => {
    expect(matchesPersonalAgentResponse(continued, ok(receipt))).toBe(true);
    for (const changed of [{ workId: 8 }, { requestId: 'foreign' }, { operation: 'cancelWork', cancelled: true }])
      expect(matchesPersonalAgentResponse(continued, ok({ ...receipt, ...changed }))).toBe(false);
    const query = { type: 'invoice_work_query_operation', input: { operation: 'continueWork', workId: 7, requestId: 'continue-1' } };
    expect(matchesPersonalAgentResponse(query, ok(receipt))).toBe(true);
    expect(matchesPersonalAgentResponse(query, ok(null))).toBe(true);
    expect(matchesPersonalAgentResponse(query, ok({ ...receipt, requestId: 'foreign' }))).toBe(false);
    expect(matchesPersonalAgentResponse({ type: 'personal_agent_update', input: { personalAgentId: 1, expectedRevision: 1, configuration } }, ok(snapshot))).toBe(true);
    expect(matchesPersonalAgentResponse({ type: 'personal_agent_update', input: { personalAgentId: 2, expectedRevision: 1, configuration } }, ok(snapshot))).toBe(false);
    expect(matchesPersonalAgentResponse({ type: 'personal_agent_open_conversation', input: { workId: 7 } }, ok({ workId: 8, sessionId: 70, runtimeKind: 'durable' }))).toBe(false);
  });

  it('matches dedicated history owners, watermarks, byte chunks and live timeline cursors', () => {
    const owner = { runtimeKind: 'durable', workId: 7, sessionId: 70, childRunId: 31 };
    const entry = { entryId: 8, kind: 'assistant', createdAt: at, role: 'assistant',
      preview: { text: 'Original report.', truncated: false }, byteLength: 100, format: 'pi-durable-entry/v1' };
    const query = { type: 'personal_task_history', input: { target: { workId: 7, childRunId: 31 }, throughEntryId: 9, beforeEntryId: 9, limit: 1 } };
    const page = { owner, throughEntryId: 9, entries: [entry], nextBeforeEntryId: null };
    expect(matchesPersonalAgentResponse(query, ok(page))).toBe(true);
    for (const change of [{ owner: { ...owner, workId: 8 } }, { owner: { ...owner, childRunId: null } },
      { throughEntryId: 10 }, { entries: [{ ...entry, entryId: 9 }] }])
      expect(matchesPersonalAgentResponse(query, ok({ ...page, ...change }))).toBe(false);
    const detailQuery = { type: 'personal_task_history_entry', input: { target: { workId: 7, childRunId: 31 }, throughEntryId: 9, entryId: 8, offset: 2, limit: 6 } };
    const detail = { owner, throughEntryId: 9, entryId: 8, kind: 'assistant', format: 'pi-durable-entry/v1', offset: 2, totalBytes: 8, text: '原票', nextOffset: null };
    expect(matchesPersonalAgentResponse(detailQuery, ok(detail))).toBe(true);
    expect(matchesPersonalAgentResponse({ ...detailQuery, input: { ...detailQuery.input, limit: 5 } }, ok(detail))).toBe(false);
    expect(matchesPersonalAgentResponse({ ...detailQuery, input: { ...detailQuery.input, offset: 3 } }, ok(detail))).toBe(false);
    const timeline = { type: 'invoice_work_timeline', input: { workId: 7 } };
    expect(matchesPersonalAgentResponse(timeline, ok({ workId: 7, semantics: 'live-facts', entries: [], nextBefore: null }))).toBe(true);
    expect(matchesPersonalAgentResponse(timeline, ok({ workId: 8, semantics: 'live-facts', entries: [], nextBefore: null }))).toBe(false);
  });

  it('checks page owners, filters, limits and captured cursors without scheduling', () => {
    const list = { type: 'invoice_work_list', input: { personalAgentId: 1, beforeId: 8, status: 'open', limit: 1 } };
    expect(matchesPersonalAgentResponse(list, ok({ items: [work], nextBeforeId: 7 }))).toBe(true);
    for (const changed of [{ personalAgentId: 2 }, { workId: 8 }, { status: 'cancelled' }])
      expect(matchesPersonalAgentResponse(list, ok({ items: [{ ...work, ...changed }], nextBeforeId: null }))).toBe(false);
    const tasks = { type: 'personal_task_list', input: { workId: 7, beforeAttemptId: 22, limit: 1 } };
    expect(matchesPersonalAgentResponse(tasks, ok({ workId: 7, items: [task], nextBeforeAttemptId: 21 }))).toBe(true);
    expect(matchesPersonalAgentResponse({ ...tasks, input: { ...tasks.input, beforeAttemptId: 21 } }, ok({ workId: 7, items: [task], nextBeforeAttemptId: null }))).toBe(false);
    const get = { type: 'personal_task_get', input: { workId: 7, attemptId: 21, stopRequestId: 'stop-1' } };
    const stopReceipt = { workId: 7, attemptId: 21, requestId: 'foreign', receivedAt: at, accepted: true, stopConfirmed: false, stoppedAt: null };
    expect(matchesPersonalAgentResponse(get, ok({ task, children: [], nextAfterChildRunId: null, stopReceipt }))).toBe(false);
    expect(matchesPersonalAgentResponse(get, ok({ task, children: [], nextAfterChildRunId: null, stopReceipt: null }))).toBe(true);
    expect(matchesPersonalAgentResponse({ ...get, input: { workId: 7, attemptId: 22 } }, ok({ task, children: [], nextAfterChildRunId: null, stopReceipt: null }))).toBe(false);
  });

  it('sanitizes boundary failures and nested native errors, and bounds the complete response', () => {
    const failure = { ok: false, error: { code: 'storage_read_failed', category: 'storage', retryable: true, message: 'native secret path' } };
    expect(JSON.stringify(parsePersonalAgentHostResult('invoice_work_get', failure))).not.toContain('native secret path');
    expect(matchesPersonalAgentResponse(continued, { ...failure, runId: 999 })).toBe(false);
    expect(matchesPersonalAgentResponse(continued, { ...failure, error: { ...failure.error, sessionId: 999 } })).toBe(false);
    expect(parsePersonalAgentHostResult('invoice_work_get', { ...failure, error: { ...failure.error, message: 'x'.repeat(262_144) } })).toBeNull();
    const blocked = ok({ ...receipt, execution: { kind: 'blocked', authorizationAccepted: false, attempt, reason: failure.error } });
    expect(JSON.stringify(parsePersonalAgentHostResult(continued.type, blocked))).not.toContain('native secret path');
    expect(matchesPersonalAgentResponse(continued, blocked)).toBe(true);
    expect(matchesPersonalAgentResponse(continued, ok({ ...blocked.data, execution: { ...blocked.data.execution,
      reason: { ...failure.error, toolCallId: 'native-secret' } } }))).toBe(false);
    expect(matchesPersonalAgentResponse(continued, ok({ ...blocked.data, execution: { ...blocked.data.execution,
      reason: { ...failure.error, runId: 999 } } }))).toBe(false);
    expect(personalAgentHostFailure('invoice_work_continue')).toMatchObject({ ok: false, error: { code: 'operation_result_unknown' } });
    expect(personalAgentHostFailure('invoice_work_get')).toMatchObject({ ok: false, error: { code: 'storage_read_failed' } });
    expect(parsePersonalAgentHostResult('personal_agent_get', ok({ ...snapshot, nativeConversationId: 'native' }))).toBeNull();
  });

  it('counts transport fields in the Host wire budget as well as the business command', () => {
    const command = { type: 'invoice_work_create', input: { personalAgentId: 1, expectedAgentRevision: 2,
      requestId: 'create-1', goal: 'x', documents: Array.from({ length: 450 }, (_, index) => ({ id: index + 1, version: 'v'.repeat(512) })) } };
    const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength;
    command.input.goal = 'x'.repeat(262_100 - bytes(command) + 1);
    expect(bytes(command)).toBe(262_100);
    expect(parsePersonalAgentCommand(command)).not.toBeNull();
    const wire = { version: 1, requestId: 't'.repeat(128), ...command };
    expect(bytes(wire)).toBeGreaterThan(262_144);
    expect(parseHostCommand(wire)).toBeNull();
  });
});
