import type { PromptTraceBuffer, PromptTraceCall, PromptTraceEntry, PromptTraceReference, PromptTraceResult, PromptTraceTiming } from '@flowmate/contracts';

const maxEntries = 200;
const maxSummaryLength = 2_000;
const maxEndedCalls = 20;
const maxEvictedKeys = 4_096;
const maxHttpAttempts = 16;

function keyOf(reference: Pick<PromptTraceReference, 'runId' | 'callSequence'>): string {
  return `${reference.runId}:${reference.callSequence}`;
}

function bounded(entry: PromptTraceEntry): PromptTraceEntry {
  const characters = [...entry.summary];
  if (characters.length <= maxSummaryLength) return { ...entry };
  return { ...entry, summary: `${characters.slice(0, maxSummaryLength - 1).join('')}…`, truncated: true };
}

export function createPromptTraceBuffer(): PromptTraceBuffer {
  const active = new Map<string, PromptTraceCall>();
  const ended: PromptTraceCall[] = [];
  const evicted = new Set<string>();
  const evictedOrder: string[] = [];
  let droppedCalls = 0;

  function rememberEvicted(key: string): void {
    evicted.add(key);
    evictedOrder.push(key);
    if (evictedOrder.length > maxEvictedKeys) evicted.delete(evictedOrder.shift()!);
  }

  const buffer: PromptTraceBuffer = {
    begin(reference) {
      if (!Number.isSafeInteger(reference.runId) || reference.runId <= 0
        || !Number.isSafeInteger(reference.sessionId) || reference.sessionId <= 0
        || !Number.isSafeInteger(reference.callSequence) || reference.callSequence <= 0
        || !reference.nativeSessionId) return;
      const key = keyOf(reference);
      if (active.has(key) || ended.some((call) => keyOf(call) === key)) return;
      active.set(key, { ...reference, state: 'active', entries: [], droppedEntries: 0 });
    },
    beginTiming(reference, startedAt, observesHttp, observe) {
      buffer.begin(reference);
      const timing: PromptTraceTiming = {
        elapsedMs: null, budgetMs: null, beforeHttpMs: null, firstTextMs: null,
        transport: observesHttp ? 'not-entered' : 'unobservable', outcome: 'pending', attempts: [], droppedAttempts: 0,
      };
      const call = active.get(keyOf(reference));
      if (call) {
        call.timing = timing;
        if (observe) {
          try { observe(structuredClone(call)); } catch { /* Diagnostics are optional. */ }
        }
      }
      return {
        budget(ms) { if (timing.outcome === 'pending') timing.budgetMs = (timing.budgetMs ?? 0) + ms; },
        dispatch(at) {
          if (timing.outcome !== 'pending') return () => {};
          timing.transport = 'entered';
          timing.beforeHttpMs ??= at - startedAt;
          if (timing.attempts.length >= maxHttpAttempts) {
            timing.droppedAttempts += 1;
            return () => {};
          }
          const attempt: PromptTraceTiming['attempts'][number] = { headersMs: null, status: null, outcome: 'pending' };
          timing.attempts.push(attempt);
          return (settledAt, status, failure) => {
            if (timing.outcome !== 'pending' || attempt.outcome !== 'pending') return;
            attempt.outcome = status === null ? failure ?? 'error' : 'headers';
            attempt.status = status;
            if (status !== null) attempt.headersMs = settledAt - at;
          };
        },
        text(at) { if (timing.outcome === 'pending') timing.firstTextMs ??= at - startedAt; },
        finish(at, outcome) {
          if (timing.outcome !== 'pending') return;
          timing.elapsedMs = at - startedAt;
          timing.outcome = outcome;
          if (call && active.get(keyOf(reference))?.timing === timing) {
            buffer.end(reference);
            if (observe) {
              call.endedAt = new Date().toISOString();
              try { observe(structuredClone(call)); } catch { /* Diagnostics are optional. */ }
            }
          }
        },
      };
    },
    append(reference, entry) {
      const call = active.get(keyOf(reference));
      if (!call) return;
      if (call.entries.length === maxEntries) {
        call.entries.shift();
        call.droppedEntries += 1;
      }
      call.entries.push(bounded(entry));
    },
    end(reference) {
      const key = keyOf(reference);
      const call = active.get(key);
      if (!call) return;
      active.delete(key);
      call.state = 'ended';
      ended.push(call);
      if (ended.length > maxEndedCalls) {
        const removed = ended.shift();
        if (removed) {
          droppedCalls += 1;
          rememberEvicted(keyOf(removed));
        }
      }
    },
    clearSession(sessionId) {
      for (const [key, call] of active) if (call.sessionId === sessionId) active.delete(key);
      for (let index = ended.length - 1; index >= 0; index -= 1) {
        if (ended[index].sessionId === sessionId) ended.splice(index, 1);
      }
    },
    query(runId, callSequence) {
      const calls = [...ended, ...active.values()]
        .filter((call) => call.runId === runId && (callSequence === undefined || call.callSequence === callSequence))
        .map((call) => structuredClone(call));
      if (calls.length) return { availability: 'available', calls, droppedCalls };
      const wasEvicted = callSequence === undefined
        ? [...evicted].some((key) => key.startsWith(`${runId}:`))
        : evicted.has(`${runId}:${callSequence}`);
      return { availability: wasEvicted ? 'evicted' : 'not-started', calls: [], droppedCalls };
    },
  };
  return buffer;
}
