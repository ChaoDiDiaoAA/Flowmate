import { expect, spyOn, test } from 'bun:test';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { HostClient } from '../../../apps/desktop/main/host-client.ts';
import { createHttpProvider, mkdtempSync } from '../../../tests/support/resources.ts';
import { prepareHostTrial } from '../../src/adapters/host-research.ts';
import { REPO_ROOT } from '../../src/dataset-loader/local.ts';
import { syntheticNativeModel } from '../support/native-model.ts';
import type { AgentTrialSession } from '../../src/adapters/agent.ts';

test('ordinary attachment preparation cancelled after actual Session creation closes the Host without dispatching a Provider request', async () => {
    const controller = new AbortController(), reason = Error('Controlled ordinary material cancellation');
    let providerRequests = 0, unexpected: AgentTrialSession | undefined;
    const closures: unknown[] = [], afterAbort: string[] = [];
    const server = await createHttpProvider(async () => { providerRequests++; return new Response('Unexpected generation', { status: 500 }); });
    const originalRequest = HostClient.prototype.request, originalClose = HostClient.prototype.close;
    const requestSpy = spyOn(HostClient.prototype, 'request').mockImplementation(async function (this: HostClient, command, timeout) {
        if (controller.signal.aborted) afterAbort.push(command.type);
        const result = await originalRequest.call(this, command, timeout);
        if (command.type === 'create_session') controller.abort(reason);
        return result;
    });
    const closeSpy = spyOn(HostClient.prototype, 'close').mockImplementation(async function (this: HostClient) {
        const result = await originalClose.call(this); closures.push(result); return result;
    });
    try {
        await expect(prepareHostTrial({ identity: { executionId: 'ordinary-cancel', trialId: 'trial-1', caseId: 'ordinary-qa', caseVersion: 1 },
            directory: mkdtempSync(join(tmpdir(), 'ordinary-material-cancel-')), requires: ['agent'],
            input: { prompt: 'Only answer from the supplied material.', materials: [{ sample: 'authorized', file: 'source.md', text: 'Declared business evidence.' }] },
            configuration: { model: 'ordinary-cancel-fixture', api: 'openai-completions', baseUrl: `http://127.0.0.1:${server.port}/v1`, modelCapabilities: syntheticNativeModel } },
        controller.signal, { repo: REPO_ROOT, credential: 'ordinary-cancel-key' }).then(value => { unexpected = value; return value; })).rejects.toThrow(reason.message);
        expect(providerRequests).toBe(0); expect(afterAbort).toEqual(['close']);
        expect(closures).toEqual([{ ok: true, data: { closed: true, stopped: true, errors: [] } }]);
    } finally { if (unexpected) await unexpected.close(); requestSpy.mockRestore(); closeSpy.mockRestore(); await server.stop(); }
}, 45000);
