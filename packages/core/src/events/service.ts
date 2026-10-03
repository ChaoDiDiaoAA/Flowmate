import { appError, fail, ok, RuntimeEventsSubscriptionRequestSchema } from '@flowmate/contracts';
import type { Result, RuntimeEventSubscription, RuntimeEventsAvailable, RuntimeEventsQuery,
  RuntimeEventsReadResult, RuntimeEventsSubscriptionRequest } from '@flowmate/contracts';
import type { RuntimeEventStore } from './store.ts';
import { reportEventObserverFailure } from './store.ts';

export function createEventService(store: RuntimeEventStore) {
  let closed = false;
  const subscriptions = new Set<() => void>();

  function subscribe(input: RuntimeEventsSubscriptionRequest,
    listener: (wake: RuntimeEventsAvailable) => void): Result<RuntimeEventSubscription> {
    if (closed) return fail(appError('event_subscription_invalid', 'input', 'Runtime event service is closed.'));
    const parsed = RuntimeEventsSubscriptionRequestSchema.safeParse(input);
    if (!parsed.success) return fail(appError('input_invalid', 'input', 'Runtime event subscription request is invalid.'));
    const request = parsed.data;
    if (subscriptions.size >= 64) return fail(appError('event_subscription_limit', 'runtime', 'Runtime event subscription limit reached.'));
    let active = true;
    let queued = false;
    let sequence = 0;
    let detach: (() => void) | undefined;
    const unsubscribe = () => {
      if (!active) return;
      active = false;
      subscriptions.delete(unsubscribe);
      try { detach?.(); } catch { reportEventObserverFailure(); }
    };
    subscriptions.add(unsubscribe);
    try {
      detach = store.onCommitted(refs => {
        if (!active) return;
        for (const ref of refs) {
          if (ref.runId !== request.runId || ref.sequence <= sequence) continue;
          sequence = ref.sequence;
          if (queued) continue;
          queued = true;
          queueMicrotask(() => {
            queued = false;
            if (!active) return;
            try { listener({ runId: request.runId, sequence }); }
            catch { reportEventObserverFailure(); }
          });
        }
      });
      const result = store.query(request);
      const context = result.ok ? result.data : result.error.code === 'event_gap' ? result.context : null;
      if (!context) {
        unsubscribe();
        return result.ok ? fail(appError('storage_read_failed', 'storage', 'Runtime event range is unavailable.', true))
          : fail(result.error);
      }
      if (!active) return fail(appError('event_subscription_invalid', 'input', 'Runtime event service is closed.'));
      return ok({ runId: context.runId, sessionId: context.sessionId, highWatermark: context.highWatermark,
        availableRange: context.availableRange, coverage: context.coverage, unsubscribe });
    } catch {
      unsubscribe();
      return fail(appError('storage_read_failed', 'storage', 'Runtime event subscription could not be opened.', true));
    }
  }

  return {
    query: (input: RuntimeEventsQuery): RuntimeEventsReadResult => store.query(input),
    subscribe,
    close(): void {
      if (closed) return;
      closed = true;
      for (const unsubscribe of [...subscriptions]) unsubscribe();
    },
  };
}

export type EventService = ReturnType<typeof createEventService>;
