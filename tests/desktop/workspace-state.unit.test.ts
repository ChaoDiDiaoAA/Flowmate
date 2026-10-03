import { describe, expect, it } from 'bun:test';
import type { WorkspaceSnapshot } from '@flowmate/contracts';
import { createWorkspaceState, beginWorkspaceRequest, acceptWorkspaceSnapshot, failWorkspaceRequest,
  resetWorkspaceHost, workspaceReady, sameWorkspaceBasis } from '../../apps/desktop/renderer/src/workspace-state.ts';

const snapshot = (revision: number): WorkspaceSnapshot => ({ revision, documentRef: { id: 1, version: 'v1' },
  jobId: 2, sessionId: 3, candidateRef: { id: 4, sequence: 1 }, activeView: 'candidate', selection: null,
  updatedAt: '2026-10-03T00:00:00.000Z', invalidReferences: [], nextTaskSequence: 1 });

describe('P7 confirmed Workspace', () => {
  it('rejects old epochs tokens revisions and equal-revision foreign bases', () => {
    let state = beginWorkspaceRequest(createWorkspaceState(1), 1, 'loading');
    state = acceptWorkspaceSnapshot(state, 1, 1, snapshot(18));
    expect(workspaceReady(state)).toBe(true);
    state = beginWorkspaceRequest(state, 2, 'saving');
    for (const [epoch, token, value] of [[0, 2, snapshot(99)], [1, 1, snapshot(99)], [1, 2, snapshot(17)],
      [1, 2, { ...snapshot(18), sessionId: 8 }]] as const)
      expect(acceptWorkspaceSnapshot(state, epoch, token, value)).toBe(state);
    expect(workspaceReady(state)).toBe(false);
    state = acceptWorkspaceSnapshot(state, 1, 2, snapshot(19));
    expect(state.confirmed?.revision).toBe(19);
    state = beginWorkspaceRequest(state, 3, 'saving');
    expect(failWorkspaceRequest(state, 1, 2, 'Late error', 'error')).toBe(state);
    expect(resetWorkspaceHost(state, 2).confirmed).toBe(state.confirmed);
    expect(workspaceReady(resetWorkspaceHost(state, 2))).toBe(false);
  });
  it('keeps facts across unknown read recovery and a late earlier selection', () => {
    let state = acceptWorkspaceSnapshot(beginWorkspaceRequest(createWorkspaceState(2), 1, 'loading'), 2, 1, snapshot(18));
    state = beginWorkspaceRequest(state, 2, 'saving');
    state = failWorkspaceRequest(state, 2, 2, 'Receipt unknown', 'unknown');
    expect(state.confirmed?.revision).toBe(18);
    expect(workspaceReady(state)).toBe(false);
    state = acceptWorkspaceSnapshot(state, 2, 2, snapshot(19));
    state = beginWorkspaceRequest(state, 3, 'saving');
    state = acceptWorkspaceSnapshot(state, 2, 3, snapshot(20));
    expect(acceptWorkspaceSnapshot(state, 2, 2, snapshot(19))).toBe(state);
    expect(sameWorkspaceBasis(snapshot(18), { ...snapshot(20), documentRef: { id: 1, version: 'v2' } })).toBe(false);
    const invalid = acceptWorkspaceSnapshot(beginWorkspaceRequest(state, 4, 'loading'), 2, 4,
      { ...snapshot(20), invalidReferences: ['selection_location_missing'] });
    expect(workspaceReady(invalid)).toBe(false);
  });
});
