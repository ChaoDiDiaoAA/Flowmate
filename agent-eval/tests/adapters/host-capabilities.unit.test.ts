import { syntheticNativeModel } from '../support/native-model.ts';
import { expect, spyOn, test } from 'bun:test';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync } from '../../../tests/support/resources.ts';
import { HostClient } from '../../../apps/desktop/main/host-client.ts';
import { discoverDatasets, REPO_ROOT } from '../../src/dataset-loader/local.ts';
import { prepareHostTrial } from '../../src/adapters/host-research.ts';
import type { AgentTrial, AgentTrialSession } from '../../src/adapters/agent.ts';

test('all 62 Case capability declarations fail closed on an unknown requirement before Host or Provider creation', async () => {
    const start = spyOn(HostClient.prototype, 'start');
    try {
        let count = 0;
        for (const dataset of ['flowmate-agent-v1', 'flowmate-research-v1'])
            for (const task of discoverDatasets(join(REPO_ROOT, 'agent-eval/src/datasets')).find(d=>d.manifest.id===dataset)!.cases) {
                const trial: AgentTrial = { identity: { executionId: 'capability-engineering', trialId: task.id, caseId: task.id, caseVersion: task.version },
                    directory: '/no-instance', input: { prompt: 'Independent synthetic input', materials: [] }, requires: [...task.requires, 'unregistered-capability'], configuration: {} };
                await expect(prepareHostTrial(trial, new AbortController().signal, { repo: REPO_ROOT, credential: 'synthetic' })).rejects.toThrow('Unsupported'); count++;
            }
        expect(count).toBe(62); expect(start).toHaveBeenCalledTimes(0);
        const trial: AgentTrial = { identity: { executionId: 'capability-engineering', trialId: 'unknown-step', caseId: 'synthetic', caseVersion: 1 },
            directory: '/no-instance', input: { prompt: 'Synthetic', materials: [] }, requires: ['agent'], configuration: {} };
        Reflect.set(trial, 'steps', [{ id: 'initial', action: 'unregistered-step', instruction: 'Synthetic' }]);
        await expect(prepareHostTrial(trial, new AbortController().signal, { repo: REPO_ROOT, credential: 'synthetic' })).rejects.toThrow();
        expect(start).toHaveBeenCalledTimes(0);
    } finally { start.mockRestore(); }
});

test('a required subagent extension must be selected before a product instance is opened', async () => {
    const start = spyOn(HostClient.prototype, 'start'); let session: AgentTrialSession | undefined;
    let error: unknown;
    try {
        const trial: AgentTrial = { identity: { executionId: 'capability-engineering', trialId: 'missing-subagents', caseId: 'synthetic', caseVersion: 1 },
            directory: mkdtempSync(join(tmpdir(), 'eval-missing-resource-')), input: { prompt: 'Synthetic', materials: [] }, requires: ['agent', 'subagent'],
            configuration: { modelCapabilities: syntheticNativeModel, model: 'synthetic', baseUrl: 'http://127.0.0.1:1/v1', api: 'openai-completions' } };
        try { session = await prepareHostTrial(trial, new AbortController().signal, { repo: REPO_ROOT, credential: 'synthetic' }); } catch (caught) { error = caught; }
        expect(error instanceof Error ? error.message : null).toContain('subagents extension'); expect(start).toHaveBeenCalledTimes(0);
    } finally { if (session) await session.close(); start.mockRestore(); }
}, 15000);
