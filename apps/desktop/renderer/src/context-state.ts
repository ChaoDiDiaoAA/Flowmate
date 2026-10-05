import { useEffect, useRef, useState } from 'react';
import type { Result } from '@flowmate/contracts';
import type { EventViewState } from './event-state.ts';

export type ContextIdentity = Readonly<{ hostEpoch: number; sessionId: number; runId: number | null; selectionToken: number }>;
export type ContextLease = Readonly<{ identity: ContextIdentity; token: number; key: string }>;
export type ContextRead<T> = Readonly<{ identity: ContextIdentity; token: number; key: string;
  data: T | null; pending: boolean; error: string | null }>;
export function sameContextIdentity(a: ContextIdentity, b: ContextIdentity): boolean {
  return a.hostEpoch === b.hostEpoch && a.sessionId === b.sessionId && a.runId === b.runId && a.selectionToken === b.selectionToken;
}
export function createContextRead<T>(identity: ContextIdentity): ContextRead<T> {
  return { identity, token: 0, key: '', data: null, pending: false, error: null };
}
export function beginContextRead<T>(state: ContextRead<T>, token: number, key: string): ContextRead<T> {
  return { ...state, token, key, pending: true, error: null };
}
export function contextReadLease<T>(state: ContextRead<T>): ContextLease {
  return { identity: state.identity, token: state.token, key: state.key };
}
export function matchesContextRead<T>(state: ContextRead<T>, lease: ContextLease): boolean {
  return sameContextIdentity(state.identity, lease.identity) && state.token === lease.token && state.key === lease.key;
}
export function acceptContextRead<T>(state: ContextRead<T>, lease: ContextLease, data: T): ContextRead<T> {
  return matchesContextRead(state, lease) ? { ...state, data, pending: false, error: null } : state;
}
export function failContextRead<T>(state: ContextRead<T>, lease: ContextLease, error: string): ContextRead<T> {
  return matchesContextRead(state, lease) ? { ...state, pending: false, error } : state;
}
export function finishContextRead<T>(state: ContextRead<T>, lease: ContextLease): ContextRead<T> {
  return matchesContextRead(state, lease) ? { ...state, pending: false } : state;
}
const refreshFacts = new Set(['run_started', 'input_state_changed', 'tool_succeeded', 'tool_failed', 'tool_cancelled',
  'run_completed', 'run_failed', 'run_cancelled']);
/** Called only after P6 has atomically applied the complete persisted page. A wake is merely a hint. */
export function hasNewContextEvents(before: EventViewState, after: EventViewState, target: Pick<ContextIdentity, 'sessionId' | 'runId'>): boolean {
  if (after.error || target.runId !== after.runId || target.sessionId !== after.sessionId
    || before.generation !== after.generation || before.runId !== after.runId || before.sessionId !== after.sessionId) return false;
  const priorIds = new Set([...before.events.values()].map(event => event.eventId));
  return [...after.events.values()].some(event => !priorIds.has(event.eventId) && event.runId === target.runId
    && event.sessionId === target.sessionId && refreshFacts.has(event.type));
}

export function useRead<T>(identity: ContextIdentity, scope = '') {
  const state = useRef(createContextRead<T>(identity)), scopeRef = useRef(scope), sequence = useRef(0), alive = useRef(true);
  const [, render] = useState(0);
  if (!sameContextIdentity(state.current.identity, identity) || scopeRef.current !== scope) {
    state.current = createContextRead<T>(identity); scopeRef.current = scope;
  }
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  async function read(key: string, query: () => Promise<Result<T>>, verify: (data: T) => boolean,
    merge?: (previous: T | null, next: T) => T): Promise<T | null> {
    state.current = beginContextRead(state.current, ++sequence.current, key);
    const lease = contextReadLease(state.current); render(value => value + 1);
    try {
      const result = await query();
      if (!alive.current || !matchesContextRead(state.current, lease)) return null;
      if (!result.ok) state.current = failContextRead(state.current, lease, result.error.message);
      else if (!verify(result.data)) state.current = failContextRead(state.current, lease, 'The saved context could not be verified.');
      else { state.current = acceptContextRead(state.current, lease, merge ? merge(state.current.data, result.data) : result.data); return result.data; }
      return null;
    } catch {
      if (alive.current) state.current = failContextRead(state.current, lease, 'Context could not be loaded. Refresh to try again.');
      return null;
    } finally {
      if (alive.current && matchesContextRead(state.current, lease)) {
        state.current = finishContextRead(state.current, lease); render(value => value + 1);
      }
    }
  }
  return { state: state.current, read };
}
