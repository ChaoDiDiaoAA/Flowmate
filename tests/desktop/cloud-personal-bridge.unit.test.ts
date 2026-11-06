import { expect, test } from 'bun:test';
import { ok } from '@flowmate/contracts';
import { createCloudPersonalBridge } from '../../apps/desktop/renderer/src/cloud-personal-bridge.ts';
import { capturePersonalWrite } from '../../apps/desktop/renderer/src/personal-state.ts';
import { prepareCloudPersonalWrite } from '../../apps/desktop/renderer/src/cloud-personal-bridge.ts';

test('cloud Personal Agent commands retain the selected workspace and reject a foreign receipt', async () => {
  const workspaceId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', seen: unknown[] = [];
  let foreign = false;
  const receipt = { operation: 'create', personalAgentId: 1, workId: 7, sessionId: 8, revision: 0,
    requestId: 'original-create', receivedAt: '2026-10-29T00:00:00.000Z',
    execution: { kind: 'waiting', authorizationAccepted: false, attempt: null, reason: 'Waiting.', todoIds: [] } };
  const bridge = createCloudPersonalBridge({ request: async input => { seen.push(input);
    return ok(foreign ? { ...receipt, requestId: 'different-create' } : receipt); } }, workspaceId);
  const input = { personalAgentId: 1, expectedAgentRevision: 0, requestId: 'original-create',
    goal: 'Review the original invoice.', documents: [{ id: 1, version: 'v1' }] };
  expect(await bridge.invoiceWorks.create(input)).toMatchObject({ ok: true, data: { workId: 7 } });
  expect(seen).toEqual([{ workspaceId, command: { type: 'invoice_work_create', input } }]);
  foreign = true;
  expect(await bridge.invoiceWorks.create(input)).toMatchObject({ ok: false });
});

test('cloud invoice creation uploads the original local references before fixing the cloud command', async () => {
  const workspaceId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', uploaded: unknown[] = [];
  const command = capturePersonalWrite({ type: 'invoice_work_create', input: { personalAgentId: 1, expectedAgentRevision: 0,
    requestId: 'original-create', goal: 'Review the originals.', documents: [{ id: 1, version: 'local-v1' }, { id: 2, version: 'local-v2' }] } });
  if (!command) throw Error('Expected the original create command.');
  const prepared = await prepareCloudPersonalWrite({ upload: async input => { uploaded.push(input); return ok({ workspaceId,
    uploadId: '11111111-1111-4111-8111-111111111111', sourceDocumentRef: input.documentRef,
    cloudDocumentRef: { id: input.documentRef.id + 100, version: input.documentRef.version } }); } }, workspaceId, command);
  expect(prepared).toMatchObject({ ok: true, data: { type: 'invoice_work_create', input: { requestId: 'original-create',
    documents: [{ id: 101, version: 'local-v1' }, { id: 102, version: 'local-v2' }] } } });
  expect(uploaded).toEqual([{ workspaceId, documentRef: { id: 1, version: 'local-v1' } },
    { workspaceId, documentRef: { id: 2, version: 'local-v2' } }]);
  expect(command.input).toMatchObject({ documents: [{ id: 1 }, { id: 2 }] });
});
