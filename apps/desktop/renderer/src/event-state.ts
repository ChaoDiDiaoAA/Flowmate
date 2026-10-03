import { RuntimeEventsReadResultSchema, RuntimeEventsWakeSchema, RuntimeSubscriptionInfoSchema } from '../../../../packages/contracts/src/events.ts';
import type { AppError, RuntimeEvent, RuntimeEventReadContext, RuntimeEventsQuery, RuntimeEventsReadResult,
  RuntimeEventCursor, RuntimeSubscriptionInfo, RuntimeEventsWake } from '@flowmate/contracts';

/** Observation only. Neither temporary SDK sequence nor replay controls execution. */
export type EventViewState = Readonly<{
  runId: number; sessionId: number | null; generation: number; subscriptionId: string | null;
  cursor: RuntimeEventCursor; displayAfterSequence: number | null;
  context: RuntimeEventReadContext | null; events: ReadonlyMap<number, RuntimeEvent>;
  gap: { fromSequence: number; toSequence: number; continueAfterSequence: number } | null;
  error: AppError | null; wakeSequence: number; needsRefresh: boolean;
}>;
export function createEventView(runId: number, sessionId: number | null, generation: number): EventViewState {
  return { runId, sessionId, generation, subscriptionId: null, cursor: { runId, lastPersistedSequence: 0 },
    displayAfterSequence: null, context: null, events: new Map(), gap: null, error: null, wakeSequence: 0, needsRefresh: true };
}
function corrupt(state: EventViewState): EventViewState {
  return { ...state, error: { code: 'storage_corrupt', category: 'storage', retryable: false,
    message: 'The recorded activity could not be verified.' }, needsRefresh: false };
}
export function bindEventSubscription(state: EventViewState, value: RuntimeSubscriptionInfo, generation: number): EventViewState {
  if (generation !== state.generation) return state;
  const parsed = RuntimeSubscriptionInfoSchema.safeParse(value);
  if (!parsed.success || parsed.data.runId !== state.runId || parsed.data.sessionId !== state.sessionId) return corrupt(state);
  const { subscriptionId, ...context } = parsed.data;
  return { ...state, subscriptionId, context, needsRefresh: true };
}
export function applyEventWake(state: EventViewState, value: RuntimeEventsWake, generation: number): EventViewState {
  if (generation !== state.generation) return state;
  const parsed = RuntimeEventsWakeSchema.safeParse(value);
  if (!parsed.success || parsed.data.subscriptionId !== state.subscriptionId || parsed.data.runId !== state.runId
    || parsed.data.sequence <= state.wakeSequence) return state;
  return { ...state, wakeSequence: parsed.data.sequence, needsRefresh: true };
}
export function eventReadRequest(state: EventViewState, throughSequence?: number): RuntimeEventsQuery {
  return { runId: state.runId, sessionId: state.sessionId, cursor: state.cursor, limit: 50,
    ...(state.subscriptionId === null ? {} : { subscriptionId: state.subscriptionId }),
    ...(throughSequence === undefined ? {} : { throughSequence }),
    ...(state.displayAfterSequence === null ? {} : { availableAfterSequence: state.displayAfterSequence }) };
}
export function applyEventRead(state: EventViewState, value: RuntimeEventsReadResult,
  request: RuntimeEventsQuery, generation: number): EventViewState {
  if (generation !== state.generation || request.runId !== state.runId || request.sessionId !== state.sessionId
    || request.cursor.runId !== state.runId || request.cursor.lastPersistedSequence !== state.cursor.lastPersistedSequence
    || (request.availableAfterSequence ?? null) !== state.displayAfterSequence
    || (request.subscriptionId ?? null) !== state.subscriptionId) return state;
  const parsed = RuntimeEventsReadResultSchema.safeParse(value);
  if (!parsed.success) return corrupt(state);
  const result = parsed.data;
  const context = result.ok ? result.data : result.context;
  if (context && (context.runId !== state.runId || context.sessionId !== state.sessionId)) return corrupt(state);
  if (!result.ok) {
    const position = state.displayAfterSequence ?? state.cursor.lastPersistedSequence;
    if (result.context && result.error.code !== 'event_cursor_invalid') {
      const through = request.throughSequence ?? result.context.highWatermark;
      if (state.cursor.lastPersistedSequence < 0 || position < state.cursor.lastPersistedSequence
        || through < position || through > result.context.highWatermark
        || result.error.code === 'event_gap' && through === position) return corrupt(state);
    }
    if (result.error.code === 'event_gap' && result.context?.gap?.fromSequence !== position + 1) return corrupt(state);
    return { ...state, context: context ?? state.context,
      gap: result.error.code === 'event_gap' ? result.context?.gap ?? null : state.gap,
      error: result.error, needsRefresh: false };
  }
  const page = result.data;
  const c = state.cursor.lastPersistedSequence;
  const d = state.displayAfterSequence;
  let last = d ?? c;
  if (request.throughSequence !== undefined && (request.throughSequence < last
    || request.throughSequence > page.highWatermark)) return corrupt(state);
  const through = request.throughSequence ?? page.highWatermark;
  const events = new Map(state.events);
  const ids = new Map([...events.values()].map(event => [event.eventId, event.sequence]));
  for (const event of page.items) {
    if (event.sequence !== last + 1 || event.sequence > through) return corrupt(state);
    const existing = events.get(event.sequence);
    if (existing && JSON.stringify(existing) !== JSON.stringify(event)
      || ids.has(event.eventId) && ids.get(event.eventId) !== event.sequence) return corrupt(state);
    events.set(event.sequence, event); ids.set(event.eventId, event.sequence); last = event.sequence;
  }
  if (page.nextCursor.runId !== state.runId || page.nextCursor.lastPersistedSequence !== (d === null ? last : c)
    || page.nextAvailableAfterSequence !== (d === null ? null : last)
    || page.hasMore && last >= through || !page.hasMore && last < through) return corrupt(state);
  // Commit the complete page atomically after every field/entry has been verified.
  return { ...state, context: { runId: page.runId, sessionId: page.sessionId, highWatermark: page.highWatermark,
    availableRange: page.availableRange, coverage: page.coverage }, events, cursor: page.nextCursor,
    displayAfterSequence: page.nextAvailableAfterSequence, error: null,
    gap: d === null && (state.gap?.toSequence ?? Infinity) <= last ? null : state.gap,
    needsRefresh: page.hasMore || state.wakeSequence > last };
}
export function selectEventSegment(state: EventViewState, after: number): EventViewState {
  if (!state.gap || after !== state.gap.continueAfterSequence || after < state.cursor.lastPersistedSequence
    || after > (state.context?.highWatermark ?? 0)) return state;
  return { ...state, displayAfterSequence: after, error: null, needsRefresh: true };
}
export function retryEventPrefix(state: EventViewState): EventViewState {
  return { ...state, displayAfterSequence: null, error: null, needsRefresh: true };
}
/** The App uses this FIFO for one page per subscription per round. */
export function enqueueEventRead(queue: readonly string[], subscriptionId: string): string[] {
  return queue.includes(subscriptionId) ? [...queue] : [...queue, subscriptionId];
}
/** Drain the real App FIFO: awaiting one read keeps slow responses from accumulating. */
export async function drainEventReadQueue(next: () => string | undefined, canRead: () => boolean,
  read: (subscriptionId: string) => Promise<void>): Promise<void> {
  while (canRead()) {
    const id = next();
    if (id === undefined) return;
    await read(id);
  }
}
