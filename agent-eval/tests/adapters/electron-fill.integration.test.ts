import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync } from '../../../tests/support/resources.ts';
import { ElectronInvoiceControls } from '../../src/adapters/electron-fill.ts';
import { REPO_ROOT } from '../../src/dataset-loader/local.ts';

test('Bun Trial controller owns actual Electron controls through typed IPC and confirms their exit', async () => {
    const root = mkdtempSync(join(tmpdir(), 'eval-bun-controls-'));
    const controls = await ElectronInvoiceControls.start(REPO_ROOT, root);
    try {
        const opened = await controls.request({ action: 'open', epoch: 1, workspace: { revision: 1, sessionId: 1, jobId: 1,
            documentRef: { id: 1, version: 'independent-synthetic' }, candidateRef: { id: 1, sequence: 1 } } });
        expect(opened.target?.formInstanceId).toBeString();
        const readback = await controls.request({ action: 'inspect' });
        expect(readback.inspection).toEqual(opened.inspection);
        expect(readback.inspection).toMatchObject({ revision: 0, draft: { fields: { invoiceNumber: '' } } });
    } finally { expect(await controls.close()).toMatchObject({ closed: true, stopped: true }); }
}, 45000);
