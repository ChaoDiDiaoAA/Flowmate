import { expect, it } from 'bun:test';
import { appError, fail } from '@flowmate/contracts';
import { WorkspaceService } from '../../../packages/core/src/workspace/service.ts';
import { makeCurrentSelectedCandidate } from '../../support/selected-candidate.ts';

async function fixture() {
  const store = await makeCurrentSelectedCandidate();
  return { store, service: new WorkspaceService(store, () => store.stamp, store.verify) };
}

for (const operation of ['read', 'update', 'restore', 'select'] as const) it(`Workspace ${operation} waits for the current SQLite owner`, async () => {
  const { store, service } = await fixture();
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const held = store.transaction(async () => { entered.resolve(); await release.promise; });
  await entered.promise;
  let settled = false;
  const result = operation === 'read' ? service.read() : operation === 'restore' ? service.restore()
    : operation === 'update' ? service.update({ expectedRevision: store.selectedWorkspace.revision, change: { kind: 'view', view: 'parsed' } })
      : service.selectCandidate({ jobId: store.jobId, candidateId: store.candidateId,
        expectedCandidateId: store.candidateId, expectedRevision: store.selectedWorkspace.revision });
  const pending = (async () => { const value = await result; settled = true; return value; })();
  try {
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(settled).toBe(false);
  } finally { release.resolve(); await held; }
  expect(await pending).toMatchObject({ ok: true });
});

it('Workspace verification uses current repositories and refuses a newly unavailable material', async () => {
  const { store, service } = await fixture();
  store.documents.get = () => fail(appError('storage_read_failed', 'storage', 'Root material alias must not serve Workspace.'));
  expect(await service.read()).toMatchObject({ ok: true, data: { invalidReferences: [] } });
  await store.transaction(scope => scope.documents.setAvailability({ documentId: 1, status: 'unavailable',
    reason: 'artifact_missing_or_invalid', at: store.stamp }));
  const before = await store.read(scope => scope.db.query('SELECT * FROM workspace').get());
  expect(await service.update({ expectedRevision: store.selectedWorkspace.revision, change: { kind: 'view', view: 'parsed' } }))
    .toMatchObject({ ok: false, error: { code: 'input_unavailable' } });
  expect(await store.read(scope => scope.db.query('SELECT * FROM workspace').get())).toEqual(before);
});
