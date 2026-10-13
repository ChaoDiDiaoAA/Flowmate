import { syntheticNativeModel } from '../support/native-model.ts';
import { expect, spyOn, test } from 'bun:test';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { existsSync } from 'node:fs';
import { HostClient } from '../../../apps/desktop/main/host-client.ts';
import { createHttpProvider, mkdtempSync } from '../../../tests/support/resources.ts';
import { prepareHostTrial } from '../../src/adapters/host-research.ts';
import { REPO_ROOT } from '../../src/dataset-loader/local.ts';
import type { AgentTrial, AgentTrialSession } from '../../src/adapters/agent.ts';

for (const boundary of ['start', 'save_settings', 'create_session', 'import_research_material', 'create_research_task'] as const) {
    test('preparation cancelled after actual ' + boundary + ' closes its Host without further setup or Provider requests', async () => {
        let providerRequests = 0;
        const server = await createHttpProvider(async () => { providerRequests++; return new Response('Unexpected Provider request', { status: 500 }); });
        const trial: AgentTrial = {
            identity: { executionId: 'prepare-engineering', trialId: boundary, caseId: 'synthetic-prepare', caseVersion: 1 },
            directory: mkdtempSync(join(tmpdir(), 'eval-prepare-cancel-')), requires: ['agent', 'research'],
            input: { prompt: 'Plan a synthetic investigation.', materials: [{ sample: 'synthetic', file: 'policy.md', text: 'Independent synthetic policy.' }] },
            steps: [{ id: 'plan', action: 'research-plan', instruction: 'Plan a synthetic investigation.' }],
            configuration: { modelCapabilities: syntheticNativeModel, model: 'prepare-fixture', baseUrl: `http://127.0.0.1:${server.port}/v1`, api: 'openai-completions' }
        };
        const controller = new AbortController(), reason = new Error('Controlled cancellation at ' + boundary);
        const afterAbort: string[] = [], closures: unknown[] = [];
        let unexpected: AgentTrialSession | undefined;
        // Interrupt after real public receipts; the original Host methods still perform all I/O.
        const request = HostClient.prototype.request, start = HostClient.prototype.start, close = HostClient.prototype.close;
        const requestSpy = spyOn(HostClient.prototype, 'request').mockImplementation(async function (this: HostClient, command, timeout) {
            if (controller.signal.aborted) afterAbort.push(command.type);
            const result = await request.call(this, command, timeout);
            if (command.type === boundary) controller.abort(reason);
            return result;
        });
        const startSpy = spyOn(HostClient.prototype, 'start').mockImplementation(async function (this: HostClient, ...args) {
            const result = await start.apply(this, args);
            if (boundary === 'start') controller.abort(reason);
            return result;
        });
        const closeSpy = spyOn(HostClient.prototype, 'close').mockImplementation(async function (this: HostClient) {
            const result = await close.call(this); closures.push(result); return result;
        });
        try {
            await expect(prepareHostTrial(trial, controller.signal, { repo: REPO_ROOT, credential: 'synthetic-prepare-key' })
                .then(value => { unexpected = value; return value; })).rejects.toThrow(reason.message);
            expect(closures).toEqual([{ ok: true, data: { closed: true, stopped: true, errors: [] } }]);
            expect(afterAbort).toEqual(['close']);
            expect(providerRequests).toBe(0);
            expect(existsSync(join(trial.directory, 'product'))).toBe(true);
        } finally {
            if (unexpected) await unexpected.close();
            requestSpy.mockRestore(); startSpy.mockRestore(); closeSpy.mockRestore();
            await server.stop();
        }
    }, 30000);
}
