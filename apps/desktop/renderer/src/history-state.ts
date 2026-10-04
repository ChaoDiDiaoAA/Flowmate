import { normalizeSessionTitle } from '../../../../packages/contracts/src/session-title.ts';
import type { ForkSessionRequest, HistoryCommitState, NativeHistoryPage, SessionHistoryEntryDetail, SessionHistoryEntryRequest } from '@flowmate/contracts';

export type HistoryIdentity = Readonly<{ sessionId: number; hostEpoch: number; navigationToken: number; entryId: string | null }>;
export type HistoryLease = Readonly<{ identity: HistoryIdentity; token: number; key: string }>;
export type HistoryRead<T> = HistoryLease & Readonly<{ data: T | null; error: string | null; pending: boolean }>;
export function sameHistoryIdentity(a: HistoryIdentity, b: HistoryIdentity): boolean {
  return a.sessionId === b.sessionId && a.hostEpoch === b.hostEpoch && a.navigationToken === b.navigationToken && a.entryId === b.entryId;
}
export function createHistoryRead<T>(identity: HistoryIdentity): HistoryRead<T> {
  return { identity, token: 0, key: '', data: null, error: null, pending: false };
}
export function beginHistoryRead<T>(state: HistoryRead<T>, token: number, key: string): HistoryRead<T> {
  return { ...state, token, key, pending: true, error: null };
}
export function historyLease<T>(state: HistoryRead<T>): HistoryLease {
  return { identity: state.identity, token: state.token, key: state.key };
}
export function matchesHistoryRead<T>(state: HistoryRead<T>, lease: HistoryLease): boolean {
  return sameHistoryIdentity(state.identity, lease.identity) && state.token === lease.token && state.key === lease.key;
}
export function acceptHistoryRead<T>(state: HistoryRead<T>, lease: HistoryLease, data: T): HistoryRead<T> {
  return matchesHistoryRead(state, lease) ? { ...state, data, error: null, pending: false } : state;
}
export function failHistoryRead<T>(state: HistoryRead<T>, lease: HistoryLease, error: string): HistoryRead<T> {
  return matchesHistoryRead(state, lease) ? { ...state, error, pending: false } : state;
}
export function finishHistoryRead<T>(state: HistoryRead<T>, lease: HistoryLease): HistoryRead<T> {
  return matchesHistoryRead(state, lease) ? { ...state, pending: false } : state;
}
export function freezeForkRequest(input: ForkSessionRequest): ForkSessionRequest {
  const title = normalizeSessionTitle(input.title);
  if (title === null) throw new Error('Session history request is invalid.');
  return Object.freeze({ ...input, title, clientOperationId: input.clientOperationId.toLowerCase(), expected: Object.freeze({ ...input.expected }) });
}
export function sameHistoryCommit(a: HistoryCommitState, b: HistoryCommitState) {
  return a.commitRevision === b.commitRevision && a.entryCount === b.entryCount && a.leafId === b.leafId;
}
/** Loaded rows remain a contiguous prefix of one saved tree, including non-current branches. */
export function mergeHistoryPage(previous: NativeHistoryPage | null, next: NativeHistoryPage, after?: number): NativeHistoryPage | null {
  if (after !== undefined && (!previous || previous.nextAfterSequence !== after || previous.session.sessionId !== next.session.sessionId || !sameHistoryCommit(previous.commit, next.commit))) return null;
  const items = after === undefined ? [...next.items] : [...previous!.items, ...next.items];
  const ids = new Set<string>();
  for (const [index, item] of items.entries()) {
    if (item.sequence !== index || ids.has(item.entryId) || item.parentId !== null && !ids.has(item.parentId)) return null;
    ids.add(item.entryId);
  }
  if (next.nextAfterSequence === null && items.length !== next.commit.entryCount) return null;
  return { ...next, items };
}
export function matchesHistoryDetail(page: NativeHistoryPage, input: SessionHistoryEntryRequest, detail: SessionHistoryEntryDetail): boolean {
  const held = page.items.find(item => item.entryId === input.entryId);
  return page.session.sessionId === input.sessionId && sameHistoryCommit(page.commit, detail.commit)
    && detail.commit.commitRevision === input.expectedCommitRevision && held !== undefined
    && JSON.stringify(held) === JSON.stringify(detail.summary)
    && (detail.part === null ? (input.partIndex ?? 0) === 0 && (input.offset ?? 0) === 0
      : detail.partIndex === (input.partIndex ?? 0) ? detail.offset === (input.offset ?? 0)
        : detail.partIndex > (input.partIndex ?? 0) && detail.offset === 0);
}
export function historyError(code: string): string {
  return code === 'state_conflict' ? 'History changed. Reload to continue.' : 'History is unavailable.';
}
