import type { PromptTraceBuffer, PromptTraceCall, PromptTraceEntry, PromptTraceReference, PromptTraceResult } from '@flowmate/contracts';

const maxEntries = 200;
const maxSummaryLength = 2_000;
const maxEndedCalls = 20;
const maxEvictedKeys = 4_096;

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

  return {
    begin(reference) {
      if (!Number.isSafeInteger(reference.runId) || reference.runId <= 0
        || !Number.isSafeInteger(reference.sessionId) || reference.sessionId <= 0
        || !Number.isSafeInteger(reference.callSequence) || reference.callSequence <= 0
        || !reference.nativeSessionId) return;
      const key = keyOf(reference);
      if (active.has(key) || ended.some((call) => keyOf(call) === key)) return;
      active.set(key, { ...reference, state: 'active', entries: [], droppedEntries: 0 });
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
        .map((call) => ({ ...call, entries: call.entries.map((entry) => ({ ...entry })) }));
      if (calls.length) return { availability: 'available', calls, droppedCalls };
      const wasEvicted = callSequence === undefined
        ? [...evicted].some((key) => key.startsWith(`${runId}:`))
        : evicted.has(`${runId}:${callSequence}`);
      return { availability: wasEvicted ? 'evicted' : 'not-started', calls: [], droppedCalls };
    },
  };
}
