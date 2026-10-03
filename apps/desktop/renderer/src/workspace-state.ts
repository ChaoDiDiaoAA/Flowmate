import type { WorkspaceChange, WorkspaceSelection, WorkspaceSnapshot } from '@flowmate/contracts';

export type WorkspaceStatus = 'loading' | 'saving' | 'ready' | 'error' | 'conflict' | 'unknown' | 'blocked';
export type WorkspaceState = { confirmed: WorkspaceSnapshot | null; hostEpoch: number; requestToken: number;
  status: WorkspaceStatus; pending: WorkspaceChange | null; message: string | null };

export function createWorkspaceState(hostEpoch = 0): WorkspaceState {
  return { confirmed: null, hostEpoch, requestToken: 0, status: 'loading', pending: null, message: null };
}
export function sameWorkspaceBasis(a: WorkspaceSnapshot | null, b: WorkspaceSnapshot | null): boolean {
  return a?.documentRef?.id === b?.documentRef?.id && a?.documentRef?.version === b?.documentRef?.version
    && a?.jobId === b?.jobId && a?.sessionId === b?.sessionId && a?.candidateRef?.id === b?.candidateRef?.id
    && a?.candidateRef?.sequence === b?.candidateRef?.sequence;
}
export function resetWorkspaceHost(state: WorkspaceState, hostEpoch: number): WorkspaceState {
  return { ...state, hostEpoch, requestToken: 0, status: 'loading', pending: null, message: null };
}
export function beginWorkspaceRequest(state: WorkspaceState, requestToken: number,
  status: 'loading' | 'saving', pending: WorkspaceChange | null = null): WorkspaceState {
  return { ...state, requestToken, status, pending, message: null };
}
export function sameWorkspaceSelection(a: WorkspaceSelection | null, b: WorkspaceSelection | null): boolean {
  if (!a || !b) return a === b;
  if (a.kind !== b.kind || a.target !== b.target || a.targetId !== b.targetId || a.targetVersion !== b.targetVersion) return false;
  if (a.kind === 'field' && b.kind === 'field') return a.fieldPath === b.fieldPath;
  if (a.kind === 'line' && b.kind === 'line') return a.lineIndex === b.lineIndex;
  return a.kind === 'source' && b.kind === 'source' && a.artifactId === b.artifactId && a.page === b.page && a.block === b.block;
}
export function acceptWorkspaceSnapshot(state: WorkspaceState, hostEpoch: number, requestToken: number,
  snapshot: WorkspaceSnapshot): WorkspaceState {
  if (hostEpoch !== state.hostEpoch || requestToken !== state.requestToken
    || state.confirmed && (snapshot.revision < state.confirmed.revision
      || snapshot.revision === state.confirmed.revision && (!sameWorkspaceBasis(snapshot, state.confirmed)
        || snapshot.activeView !== state.confirmed.activeView
        || !sameWorkspaceSelection(snapshot.selection, state.confirmed.selection)))) return state;
  return { ...state, confirmed: snapshot, status: snapshot.invalidReferences.length ? 'blocked' : 'ready', pending: null,
    message: snapshot.invalidReferences.length ? 'Workspace recovery blocked. Refresh the workspace after repairing its material.' : null };
}
export function failWorkspaceRequest(state: WorkspaceState, hostEpoch: number, requestToken: number,
  message: string, status: 'error' | 'conflict' | 'unknown' | 'blocked'): WorkspaceState {
  if (hostEpoch !== state.hostEpoch || requestToken !== state.requestToken) return state;
  return { ...state, status, message, pending: null };
}
export function workspaceReady(state: WorkspaceState): boolean {
  return state.status === 'ready' && state.confirmed !== null && state.confirmed.invalidReferences.length === 0;
}
export function selectionLabel(selection: WorkspaceSelection | null): string {
  if (!selection) return 'No selection';
  if (selection.kind === 'line') return `Line ${selection.lineIndex + 1}`;
  if (selection.kind === 'source') return `${selection.page ? `Page ${selection.page}` : 'Source'}${selection.block ? ` · Block ${selection.block}` : ''}`;
  const parts = selection.fieldPath.split('.');
  const field = parts.at(-1)!.replace(/([A-Z])/g, ' $1').replace(/^./, c => c.toUpperCase());
  return `${parts[0] === 'lines' ? `Line ${Number(parts[1]) + 1} · ` : ''}${field}`;
}
