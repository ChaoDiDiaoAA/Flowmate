import { describe, expect, it } from 'bun:test';
import * as contracts from '@flowmate/contracts';
import type { ZodTypeAny } from 'zod';
import { makeApplication } from '../../packages/core/src/application.ts';
import type { RuntimeServicePort } from '../../packages/core/src/application.ts';
import { CONTEXT_ERROR_FACTS as portableFacts } from '../../packages/contracts/src/errors.ts';
import { CONTEXT_ERROR_FACTS as originalFacts } from '../../packages/contracts/src/context.ts';

const at = '2026-10-03T00:00:00.000Z';
const base = { eventId: 1, runId: 21, sequence: 1, sessionId: 12, toolCallId: null,
  sourceConnection: null, sourceSequence: null, occurredAt: at, receivedAt: at };
const runPayload = { version: 1, status: 'running', origin: 'live', stopped: null, errorCode: null };
const started = { ...base, type: 'run_started', payload: runPayload };
const inputPayload = { version: 1, inputId: 7, origin: 'live', status: 'consumed', processingStatus: 'pending',
  nativeEntryId: 'entry-1', resultEntryId: null, errorCode: null };
const context = { runId: 21, sessionId: 12, highWatermark: 3,
  availableRange: { fromSequence: 1, toSequence: 3 }, coverage: 'partial' };
const query = { runId: 21, sessionId: 12, cursor: { runId: 21, lastPersistedSequence: 0 } };
const none = { runId: 21, sessionId: null, highWatermark: 0, availableRange: null, coverage: 'none' };
const tool = { toolCallId: 8, runId: 21, sessionId: 12, toolName: 'read_invoice_document', status: 'succeeded',
  requestedAt: at, startedAt: at, endedAt: at, stoppedAt: null, committedCandidateId: null,
  errorCode: null, stopped: null, deliveryState: 'unknown', formApplicationOutcome: null, context: null };
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value), 'utf8');
const schemas = {
  RuntimeEventSchema: contracts.RuntimeEventSchema, RuntimeEventsQuerySchema: contracts.RuntimeEventsQuerySchema,
  RuntimeEventsSubscriptionRequestSchema: contracts.RuntimeEventsSubscriptionRequestSchema,
  RuntimeEventsPageSchema: contracts.RuntimeEventsPageSchema, RuntimeEventsReadResultSchema: contracts.RuntimeEventsReadResultSchema,
  RuntimeToolViewSchema: contracts.RuntimeToolViewSchema, RunToolCallsRequestSchema: contracts.RunToolCallsRequestSchema,
  RunToolCallRequestSchema: contracts.RunToolCallRequestSchema, RuntimeToolPageSchema: contracts.RuntimeToolPageSchema,
  RuntimeSubscriptionInfoSchema: contracts.RuntimeSubscriptionInfoSchema, RuntimeEventsWakeSchema: contracts.RuntimeEventsWakeSchema,
  RuntimeEventsAvailableSchema: contracts.RuntimeEventsAvailableSchema, RuntimeSubscriptionResultSchema: contracts.RuntimeSubscriptionResultSchema,
  RuntimeToolResultSchema: contracts.RuntimeToolResultSchema, RuntimeToolPageResultSchema: contracts.RuntimeToolPageResultSchema,
};
function schema(name: keyof typeof schemas): ZodTypeAny {
  return schemas[name];
}
function eventOfSize(size: number, sequence = 1) {
  const event = { ...started, eventId: sequence, sequence, sourceConnection: '' };
  return { ...event, sourceConnection: 'x'.repeat(size - bytes(event)) };
}

describe('P6 persistent Runtime event contracts', () => {
  it('accepts a real started event and rejects mismatched state and unsafe identities', () => {
    const schema = contracts.RuntimeEventSchema;
    const event = {
      eventId: 1, runId: 21, sequence: 1, sessionId: 12, toolCallId: null,
      sourceConnection: null, sourceSequence: null,
      occurredAt: '2026-10-03T00:00:00.000Z', receivedAt: '2026-10-03T00:00:00.000Z',
      type: 'run_started', payload: { version: 1, status: 'running', origin: 'live', stopped: null, errorCode: null },
    };
    expect(schema.safeParse(event).success).toBe(true);
    expect(schema.safeParse({ ...event, type: 'run_completed' }).success).toBe(false);
    for (const eventId of [0, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(schema.safeParse({ ...event, eventId }).success).toBe(false);
    }
  });

  it('reads all thirteen literal event combinations and rejects foreign lifecycle states', () => {
    const eventSchema = schema('RuntimeEventSchema');
    for (const [type, status] of [['run_created', 'created'], ['run_started', 'running'], ['run_completed', 'completed'],
      ['run_failed', 'failed'], ['run_cancelled', 'cancelled']]) {
      expect(eventSchema.safeParse({ ...base, type, payload: { ...runPayload, status } }).success).toBe(true);
      expect(eventSchema.safeParse({ ...base, type, payload: { ...runPayload, status: 'requested' } }).success).toBe(false);
    }
    for (const [type, status] of [['tool_requested', 'requested'], ['tool_started', 'running'], ['tool_succeeded', 'succeeded'],
      ['tool_failed', 'failed'], ['tool_cancelled', 'cancelled']]) {
      const event = { ...base, toolCallId: 8, type, payload: { version: 1, status, origin: 'recovery',
        toolName: 'read_invoice_document', committedCandidateId: null, stopped: null, errorCode: null } };
      expect(eventSchema.safeParse(event).success).toBe(true);
      expect(eventSchema.safeParse({ ...event, sessionId: null }).success).toBe(false);
      expect(eventSchema.safeParse({ ...event, toolCallId: null }).success).toBe(false);
      expect(eventSchema.safeParse({ ...event, payload: { ...event.payload, status: 'completed' } }).success).toBe(false);
    }
    expect(eventSchema.safeParse({ ...base, type: 'input_state_changed', payload: inputPayload }).success).toBe(true);
    expect(eventSchema.safeParse({ ...base, type: 'run_cancel_requested', payload: { version: 1, requestedAt: at } }).success).toBe(true);
    expect(eventSchema.safeParse({ ...base, sessionId: null, type: 'run_usage_updated', payload: { version: 1,
      tokens: { inputTokens: null, outputTokens: 0, totalTokens: null, cost: null, usageComplete: false },
      attempts: null, attemptsComplete: false, source: 'unknown' } }).success).toBe(true);
    expect(eventSchema.safeParse({ ...started, type: 'tool_completed' }).success).toBe(false);
    expect(eventSchema.safeParse({ ...started, toolCallId: 8 }).success).toBe(false);
  });

  it('validates real UTC dates and source provenance without accepting private fields', () => {
    const eventSchema = schema('RuntimeEventSchema');
    expect(eventSchema.safeParse({ ...started, sourceSequence: 1 }).success).toBe(false);
    expect(eventSchema.safeParse({ ...started, sourceConnection: 'sdk-1', sourceSequence: 40 }).success).toBe(true);
    for (const sourceSequence of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(eventSchema.safeParse({ ...started, sourceConnection: 'sdk-1', sourceSequence }).success).toBe(false);
    }
    for (const occurredAt of ['2026-02-30T00:00:00.000Z', '2026-10-03T24:00:00.000Z',
      '2026-10-03T00:00:00+08:00', '2026-10-03T00:00:00', 'not-a-date']) {
      expect(eventSchema.safeParse({ ...started, occurredAt }).success).toBe(false);
    }
    for (const field of ['prompt', 'text', 'thinking', 'apiKey', 'rawArguments', 'result', 'sdkEvent']) {
      expect(eventSchema.safeParse({ ...started, [field]: 'private' }).success).toBe(false);
      expect(eventSchema.safeParse({ ...started, payload: { ...runPayload, [field]: 'private' } }).success).toBe(false);
    }
  });

  it('keeps P5 consumption and result entry evidence in input events', () => {
    const eventSchema = schema('RuntimeEventSchema');
    const input = { ...base, type: 'input_state_changed', payload: inputPayload };
    expect(eventSchema.safeParse(input).success).toBe(true);
    expect(eventSchema.safeParse({ ...input, sessionId: null }).success).toBe(false);
    expect(eventSchema.safeParse({ ...input, toolCallId: 8 }).success).toBe(false);
    for (const payload of [{ ...inputPayload, nativeEntryId: null }, { ...inputPayload, status: 'queued' },
      { ...inputPayload, processingStatus: 'completed' }, { ...inputPayload, status: 'failed', resultEntryId: 'result-1' }]) {
      expect(eventSchema.safeParse({ ...input, payload }).success).toBe(false);
    }
    expect(eventSchema.safeParse({ ...input, payload: { ...inputPayload, processingStatus: 'completed', resultEntryId: 'result-1' } }).success).toBe(true);
    expect(eventSchema.safeParse({ ...input, payload: { ...inputPayload, processingStatus: 'failed' } }).success).toBe(true);
    expect(eventSchema.safeParse({ ...input, payload: { ...inputPayload, status: 'delivery_unknown', nativeEntryId: null } }).success).toBe(true);
  });

  it('measures payload and full event JSON UTF8 at their independent byte boundaries', () => {
    const eventSchema = schema('RuntimeEventSchema');
    const empty = { ...runPayload, errorCode: '' };
    const payload = { ...empty, errorCode: 'x'.repeat(4096 - bytes(empty)) };
    expect(bytes(payload)).toBe(4096);
    expect(eventSchema.safeParse({ ...started, payload }).success).toBe(true);
    expect(eventSchema.safeParse({ ...started, payload: { ...payload, errorCode: payload.errorCode + 'x' } }).success).toBe(false);
    for (const sample of ['汉', '😀', '\n', '"']) {
      const emptyEvent = { ...started, sourceConnection: '' };
      const budget = 8192 - bytes(emptyEvent);
      const unit = bytes(sample) - 2;
      const event = { ...emptyEvent, sourceConnection: sample.repeat(Math.floor(budget / unit)) + 'x'.repeat(budget % unit) };
      expect(bytes(event)).toBe(8192);
      expect(eventSchema.safeParse(event).success).toBe(true);
      expect(eventSchema.safeParse({ ...event, sourceConnection: event.sourceConnection + 'x' }).success).toBe(false);
      const emptyUsage = { version: 1, tokens: { inputTokens: null, outputTokens: null, totalTokens: null, cost: '', usageComplete: false },
        attempts: null, attemptsComplete: false, source: 'unknown' };
      const payloadBudget = 4096 - bytes(emptyUsage);
      const cost = sample.repeat(Math.floor(payloadBudget / unit)) + 'x'.repeat(payloadBudget % unit);
      const payload = { ...emptyUsage, tokens: { ...emptyUsage.tokens, cost } };
      expect(bytes(payload)).toBe(4096);
      expect(eventSchema.safeParse({ ...base, type: 'run_usage_updated', payload }).success).toBe(true);
      expect(eventSchema.safeParse({ ...base, type: 'run_usage_updated', payload: { ...payload, tokens: { ...payload.tokens, cost: cost + 'x' } } }).success).toBe(false);
    }
    expect(bytes(eventOfSize(8192))).toBe(8192);
    expect(eventSchema.safeParse(eventOfSize(8192)).success).toBe(true);
    expect(eventSchema.safeParse(eventOfSize(8193)).success).toBe(false);
  });

  it('keeps usage unknowns nullable and rejects unsafe or extra token values', () => {
    const eventSchema = schema('RuntimeEventSchema');
    const payload = { version: 1, tokens: { inputTokens: null, outputTokens: 0, totalTokens: null, cost: null, usageComplete: false },
      attempts: null, attemptsComplete: false, source: 'unknown' };
    const usage = { ...base, sessionId: null, type: 'run_usage_updated', payload };
    expect(eventSchema.safeParse(usage).success).toBe(true);
    for (const inputTokens of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(eventSchema.safeParse({ ...usage, payload: { ...payload, tokens: { ...payload.tokens, inputTokens } } }).success).toBe(false);
    }
    expect(eventSchema.safeParse({ ...usage, payload: { ...payload, tokens: { ...payload.tokens, prompt: 'private' } } }).success).toBe(false);
    expect(eventSchema.safeParse({ ...usage, payload: { ...payload, attempts: Number.MAX_SAFE_INTEGER + 1 } }).success).toBe(false);
  });

  it('validates query structure while leaving identifiable cursor errors to semantic reads', () => {
    const querySchema = schema('RuntimeEventsQuerySchema');
    expect(querySchema.parse(query)).toEqual({ ...query, limit: 50 });
    for (const cursor of [{ runId: 21, lastPersistedSequence: -1 }, { runId: 99, lastPersistedSequence: 0 }]) {
      expect(querySchema.safeParse({ ...query, cursor }).success).toBe(true);
    }
    for (const lastPersistedSequence of ['0', 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(querySchema.safeParse({ ...query, cursor: { runId: 21, lastPersistedSequence } }).success).toBe(false);
    }
    expect(querySchema.safeParse({ ...query, limit: 100, throughSequence: 3, availableAfterSequence: 2, subscriptionId: 'sub-1' }).success).toBe(true);
    for (const fields of [{ runId: 0 }, { limit: 0 }, { limit: 101 }, { throughSequence: 0.5 },
      { availableAfterSequence: Number.MAX_SAFE_INTEGER + 1 }, { cursor: { ...query.cursor, owner: 'caller' } }, { owner: 'caller' }]) {
      expect(querySchema.safeParse({ ...query, ...fields }).success).toBe(false);
    }
    const subscription = schema('RuntimeEventsSubscriptionRequestSchema');
    expect(subscription.safeParse(query).success).toBe(true);
    for (const fields of [{ limit: 50 }, { throughSequence: 3 }, { availableAfterSequence: 2 }, { subscriptionId: 'sub-1' },
      { owner: 'caller' }, { pageGeneration: 1 }, { connectionEpoch: 1 }]) {
      expect(subscription.safeParse({ ...query, ...fields }).success).toBe(false);
    }
  });

  it('validates page-local identities and continuity without expanding the DTO with request fields', () => {
    const pageSchema = schema('RuntimeEventsPageSchema');
    const page = { ...context, items: [started], nextCursor: { runId: 21, lastPersistedSequence: 1 }, hasMore: true, nextAvailableAfterSequence: null };
    expect(pageSchema.safeParse(page).success).toBe(true);
    const third = { ...started, eventId: 3, sequence: 3 };
    const segment = { ...page, items: [third], nextCursor: { runId: 21, lastPersistedSequence: 1 }, hasMore: false, nextAvailableAfterSequence: 3 };
    expect(pageSchema.safeParse(segment).success).toBe(true);
    expect(pageSchema.safeParse({ ...segment, items: [], nextAvailableAfterSequence: 2 }).success).toBe(true);
    for (const fields of [{ items: [{ ...started, runId: 22 }] }, { items: [{ ...started, sessionId: 13 }] },
      { nextCursor: { runId: 22, lastPersistedSequence: 1 } }, { items: [started, third] },
      { items: [third, started] }, { availableRange: { fromSequence: 3, toSequence: 1 } },
      { nextAvailableAfterSequence: 4 }, { throughSequence: 1 }, { originalCursor: query.cursor }, { availableAfterSequence: 2 }]) {
      expect(pageSchema.safeParse({ ...page, ...fields }).success).toBe(false);
    }
    expect(pageSchema.safeParse({ ...none, items: [], nextCursor: query.cursor, hasMore: false, nextAvailableAfterSequence: null }).success).toBe(true);
    expect(pageSchema.safeParse({ ...none, highWatermark: 1, items: [], nextCursor: query.cursor, hasMore: false, nextAvailableAfterSequence: null }).success).toBe(false);
  });

  it('requires independent failure context and correct gap/error facts', () => {
    const resultSchema = schema('RuntimeEventsReadResultSchema');
    const gap = { ok: false, error: { code: 'event_gap', category: 'storage', retryable: false, message: 'Missing event.' },
      context: { ...context, gap: { fromSequence: 2, toSequence: 2, continueAfterSequence: 2 } } };
    expect(resultSchema.safeParse(gap).success).toBe(true);
    for (const bad of [{ ...gap, context: null }, { ...gap, context: { ...context } }, { ...gap, context: undefined },
      { ...gap, error: { ...gap.error, gap: gap.context.gap } }, { ...gap, error: { ...gap.error, category: 'runtime' } },
      { ...gap, context: { ...context, gap: { fromSequence: 3, toSequence: 2, continueAfterSequence: 2 } } },
      { ...gap, context: { ...context, gap: { fromSequence: 2, toSequence: 2, continueAfterSequence: 3 } } }]) {
      expect(resultSchema.safeParse(bad).success).toBe(false);
    }
    const mappings = [['event_cursor_invalid', 'input', false], ['event_subscription_limit', 'runtime', false],
      ['event_subscription_invalid', 'input', false], ['event_query_busy', 'runtime', true], ['storage_read_failed', 'storage', true],
      ['storage_corrupt', 'storage', false], ['state_conflict', 'runtime', false]] as const;
    for (const [code, category, retryable] of mappings) {
      const error = { code, category, retryable, message: 'Observed failure.' };
      expect(resultSchema.safeParse({ ok: false, error, context: null }).success).toBe(true);
      expect(resultSchema.safeParse({ ok: false, error: { ...error, retryable: !retryable }, context: null }).success).toBe(false);
    }
    expect(contracts.AppErrorSchema.safeParse({ ...gap.error, gap: gap.context.gap }).success).toBe(false);
  });

  it('bounds the complete success and failure response envelopes to 256KiB', () => {
    const resultSchema = schema('RuntimeEventsReadResultSchema');
    const items = Array.from({ length: 31 }, (_, i) => eventOfSize(8192, i + 1));
    const last = { ...started, eventId: 32, sequence: 32, sourceConnection: '' };
    const response = { ok: true, data: { ...context, highWatermark: 32, availableRange: { fromSequence: 1, toSequence: 32 },
      items: [...items, last], nextCursor: { runId: 21, lastPersistedSequence: 32 }, hasMore: false, nextAvailableAfterSequence: null } };
    last.sourceConnection = 'x'.repeat(262144 - bytes(response));
    expect(bytes(response)).toBe(262144);
    expect(resultSchema.safeParse(response).success).toBe(true);
    expect(resultSchema.safeParse({ ...response, data: { ...response.data, items: [...items, { ...last, sourceConnection: last.sourceConnection + 'x' }] } }).success).toBe(false);
    const failed = { ok: false, error: { code: 'storage_read_failed', category: 'storage', retryable: true, message: '' }, context: null };
    failed.error.message = 'x'.repeat(262144 - bytes(failed));
    expect(bytes(failed)).toBe(262144);
    expect(resultSchema.safeParse(failed).success).toBe(true);
    expect(resultSchema.safeParse({ ...failed, error: { ...failed.error, message: failed.error.message + 'x' } }).success).toBe(false);
    expect(schema('RuntimeEventsPageSchema').safeParse({ ...response.data, items: Array.from({ length: 101 }, (_, i) => ({ ...started, eventId: i + 1, sequence: i + 1 })),
      highWatermark: 101, availableRange: { fromSequence: 1, toSequence: 101 }, nextCursor: { runId: 21, lastPersistedSequence: 101 } }).success).toBe(false);
  });

  it('exposes only safe readonly tool projections and the existing page shape', () => {
    const viewSchema = schema('RuntimeToolViewSchema');
    expect(viewSchema.safeParse(tool).success).toBe(true);
    for (const field of ['args', 'rawArguments', 'finalArguments', 'result', 'cleanup', 'runtimeObservation', 'nativeToolCallId']) {
      expect(viewSchema.safeParse({ ...tool, [field]: {} }).success).toBe(false);
    }
    for (const deliveryState of ['not_attempted', 'message_observed', 'request_observed', 'failed', 'unknown']) {
      expect(viewSchema.safeParse({ ...tool, deliveryState }).success).toBe(true);
    }
    expect(viewSchema.safeParse({ ...tool, deliveryState: 'delivered' }).success).toBe(false);
    expect(schema('RunToolCallsRequestSchema').parse({ runId: 21, sessionId: null })).toEqual({ runId: 21, sessionId: null, limit: 50 });
    expect(schema('RunToolCallsRequestSchema').safeParse({ runId: 21, sessionId: 12, beforeId: 8, limit: 100 }).success).toBe(true);
    expect(schema('RunToolCallsRequestSchema').safeParse({ runId: 21, sessionId: null, limit: 101 }).success).toBe(false);
    expect(schema('RunToolCallRequestSchema').safeParse({ runId: 21, sessionId: null, toolCallId: 8 }).success).toBe(false);
    expect(schema('RunToolCallRequestSchema').safeParse({ runId: 21, sessionId: 12, toolCallId: 8 }).success).toBe(true);
    expect(schema('RuntimeToolPageSchema').safeParse({ items: [tool], nextBeforeId: null }).success).toBe(true);
    expect(schema('RuntimeToolPageSchema').safeParse({ items: [], nextBeforeId: null, hasMore: false }).success).toBe(false);
  });

  it('transports subscription IDs and wakes without local closures or trusted owner fields', () => {
    const infoSchema = schema('RuntimeSubscriptionInfoSchema');
    const info = { ...context, subscriptionId: '72e9078d-d110-4a4f-a875-7893f0e7aa75' };
    expect(infoSchema.safeParse(info).success).toBe(true);
    expect(infoSchema.safeParse({ ...info, unsubscribe: () => {} }).success).toBe(false);
    const wake = { type: 'runtime_events_available', subscriptionId: info.subscriptionId, runId: 21, sequence: 40 };
    expect(schema('RuntimeEventsWakeSchema').safeParse(wake).success).toBe(true);
    expect(schema('RuntimeEventsAvailableSchema').safeParse({ runId: 21, sequence: 40 }).success).toBe(true);
    for (const fields of [{ sequence: 0 }, { owner: 'renderer' }, { epoch: 1 }, { subscriptionId: '' }]) {
      expect(schema('RuntimeEventsWakeSchema').safeParse({ ...wake, ...fields }).success).toBe(false);
    }
    expect(schema('RuntimeSubscriptionResultSchema').safeParse({ ok: true, data: info }).success).toBe(true);
    expect(schema('RuntimeToolResultSchema').safeParse({ ok: true, data: tool }).success).toBe(true);
    expect(schema('RuntimeToolPageResultSchema').safeParse({ ok: true, data: { items: [], nextBeforeId: null } }).success).toBe(true);
  });

  it('honestly rejects unassembled public read services without invoking execution or repositories', async () => {
    let calls = 0;
    const unexpected = (): never => { calls++; throw new Error('Observation invoked execution or a repository.'); };
    const runtime: RuntimeServicePort = { callProvider: unexpected, start: unexpected, cancel: unexpected,
      compactSession: unexpected, querySessionCompaction: unexpected, cancelSessionCompaction: unexpected,
      revokeDocumentUse: unexpected, state: unexpected, close: unexpected };
    const app = makeApplication(runtime, { get: unexpected }, async () => ({ stopped: true, closed: true, errors: [] }));
    expect(await app.queryRuntimeEvents(query)).toMatchObject({ ok: false, context: null, error: { category: 'runtime' } });
    expect(await app.subscribeRuntimeEvents(query, unexpected)).toMatchObject({ ok: false });
    expect(await app.listRunToolCalls({ runId: 21, sessionId: null })).toMatchObject({ ok: false });
    expect(await app.queryRunToolCall({ runId: 21, sessionId: 12, toolCallId: 8 })).toMatchObject({ ok: false });
    expect(calls).toBe(0);
  });

  it('validates subscription release identity and strict void acknowledgments', () => {
    const idSchema = contracts.RuntimeSubscriptionIdSchema;
    const releaseSchema = contracts.RuntimeSubscriptionReleaseResultSchema;
    expect(idSchema.safeParse('sub-1').success).toBe(true);
    expect(idSchema.safeParse('x'.repeat(256)).success).toBe(true);
    for (const id of ['', null, 1, 'x'.repeat(257), { subscriptionId: 'sub-1', owner: 'caller' }]) {
      expect(idSchema.safeParse(id).success).toBe(false);
    }
    expect(releaseSchema.parse({ ok: true })).toEqual({ ok: true, data: undefined });
    expect(releaseSchema.safeParse({ ok: true, data: null }).success).toBe(false);
    expect(releaseSchema.safeParse({ ok: true, owner: 'caller' }).success).toBe(false);
    expect(releaseSchema.safeParse({ ok: false, error: { code: 'event_subscription_invalid', category: 'input', retryable: false, message: 'Invalid.' } }).success).toBe(true);
  });

  it('rejects a continuation claim when the page cannot have further bounded events', () => {
    const empty = { ...none, items: [], nextCursor: query.cursor, hasMore: true, nextAvailableAfterSequence: null };
    expect(contracts.RuntimeEventsPageSchema.safeParse(empty).success).toBe(false);
    const last = { ...started, eventId: 3, sequence: 3 };
    expect(contracts.RuntimeEventsPageSchema.safeParse({ ...context, items: [last], nextCursor: { runId: 21, lastPersistedSequence: 3 },
      hasMore: true, nextAvailableAfterSequence: null }).success).toBe(false);
    expect(contracts.RuntimeEventsPageSchema.safeParse({ ...context, items: [last], nextCursor: { runId: 21, lastPersistedSequence: 1 },
      hasMore: true, nextAvailableAfterSequence: 3 }).success).toBe(false);
  });

  it('rejects different event facts sharing the same persistent event identity within a page', () => {
    expect(contracts.RuntimeEventsPageSchema.safeParse({ ...context, items: [started, { ...started, sequence: 2 }],
      nextCursor: { runId: 21, lastPersistedSequence: 2 }, hasMore: true, nextAvailableAfterSequence: null }).success).toBe(false);
  });

  it('checks visible creation facts without assuming the types of unseen events', () => {
    const created = { ...started, type: 'run_created', payload: { ...runPayload, status: 'created' } };
    const page = { ...context, items: [created], nextCursor: { runId: 21, lastPersistedSequence: 1 }, hasMore: true, nextAvailableAfterSequence: null };
    expect(contracts.RuntimeEventsPageSchema.safeParse({ ...page, coverage: 'from-created' }).success).toBe(true);
    expect(contracts.RuntimeEventsPageSchema.safeParse(page).success).toBe(false);
    expect(contracts.RuntimeEventsPageSchema.safeParse({ ...page, coverage: 'from-created', items: [started] }).success).toBe(true);
    expect(contracts.RuntimeEventsPageSchema.safeParse({ ...page, coverage: 'from-created', items: [{ ...started, eventId: 2, sequence: 2 }],
      nextCursor: { runId: 21, lastPersistedSequence: 2 } }).success).toBe(true);
    expect(contracts.RuntimeEventsPageSchema.safeParse({ ...page, coverage: 'from-created', availableRange: { fromSequence: 3, toSequence: 3 },
      items: [{ ...created, eventId: 3, sequence: 3 }], nextCursor: { runId: 21, lastPersistedSequence: 3 }, hasMore: false }).success).toBe(true);
  });
});

it('T08 RuntimeToolView exposes only a nullable strict ContextReference with equivalent ID boundaries', () => {
  expect(contracts.RuntimeToolViewSchema.parse(tool).context).toBeNull();
  for (const context of [{ snapshotId: 51, requestSequence: 1 }, { snapshotId: Number.MAX_SAFE_INTEGER, requestSequence: Number.MAX_SAFE_INTEGER },
    { snapshotId: 0, requestSequence: 1 }, { snapshotId: -1, requestSequence: 1 }, { snapshotId: 1.5, requestSequence: 1 },
    { snapshotId: Number.MAX_SAFE_INTEGER + 1, requestSequence: 1 }, { snapshotId: 1, requestSequence: 0 },
    { snapshotId: 1 }, { requestSequence: 1 }, { snapshotId: 1, requestSequence: 1, rawSnapshot: {} },
    { snapshotId: 1, requestSequence: 1, runId: 21 }]) {
    expect(contracts.RuntimeToolViewSchema.safeParse({ ...tool, context }).success)
      .toBe(contracts.ContextReferenceSchema.safeParse(context).success);
  }
  const { context: _context, ...missing } = tool;
  expect(contracts.RuntimeToolViewSchema.safeParse(missing).success).toBe(false);
});

it('T08 portable Context error facts keep the original export binding and exact registered facts', () => {
  expect(portableFacts).toBe(originalFacts); expect(contracts.CONTEXT_ERROR_FACTS).toBe(originalFacts);
  expect(portableFacts).toEqual({ context_evidence_too_large:['runtime',false],context_binding_unknown:['runtime',false],
    compaction_unavailable:['runtime',false],compaction_not_needed:['runtime',false],compaction_failed:['runtime',false],
    compaction_cancelled:['runtime',false],compaction_timeout:['runtime',false],compaction_capacity_exceeded:['runtime',false],
    context_binding_conflict:['runtime',false],context_payload_mismatch:['runtime',false],context_snapshot_not_found:['input',false],
    provider_transport_error:['provider',false],internal_error:['internal',false] });
  for (const [code,[category,retryable]] of Object.entries(portableFacts)) {
    const error={code,category,retryable,message:'Controlled product failure.'};
    expect(contracts.ContextErrorSchema.safeParse(error).success).toBe(true);
    expect(contracts.RuntimeEventErrorSchema.safeParse(error).success).toBe(true);
    for(const schema of [contracts.ContextErrorSchema,contracts.RuntimeEventErrorSchema]) {
      expect(schema.safeParse({...error,retryable:!retryable}).success).toBe(false);
      expect(schema.safeParse({...error,category:'evaluation'}).success).toBe(false);
    }
  }
});
