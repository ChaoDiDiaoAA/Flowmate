import { expect, test } from 'bun:test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { findDataset, runLocal } from '../../src/execution/runner.ts';
import { REPO_ROOT } from '../../src/dataset-loader/local.ts';
import { fixtureRepo, observed } from '../support/fixtures.ts';

mkdirSync(join(fixtureRepo, 'resources/extensions'), { recursive: true });
writeFileSync(join(fixtureRepo, 'resources/extensions/subagents-v1.json'), readFileSync(join(REPO_ROOT, 'resources/extensions/subagents-v1.json')));

for (const caseId of ['FM-036', 'FM-046', 'FM-047', 'FM-049', 'FM-050'])
test(caseId + ' prepares only synthetic private probes outside the submitted input', async () => {
    const dataset = findDataset(REPO_ROOT);
    let seen = false;
    await runLocal(fixtureRepo, { dataset, caseId, executionId: 'private-probes-' + randomUUID(), backend: 'local', judge: 'off' }, {
        env: {}, kernel: { readiness: () => ({ ready: true, reason: 'Controlled private probe preparation' }), async prepare(trial) {
            const effects = (trial as typeof trial & { privateEffects?: { caseId: string; probes: Array<{ path: string; initialText: string }> } }).privateEffects;
            expect(effects).toBeDefined(); expect(effects!.caseId).toBe(caseId);
            expect(effects!.probes.length).toBeGreaterThanOrEqual(2);
            for (const probe of effects!.probes) {
                expect(readFileSync(probe.path, 'utf8')).toBe(probe.initialText);
                expect(JSON.stringify(trial.input)).not.toContain(probe.initialText.trim());
            }
            if (caseId === 'FM-049') {
                const future = effects!.probes.find(p => p.path.endsWith('future-input.json'))!;
                expect(JSON.parse(future.initialText)).toMatchObject({ state: 'not-submitted', sentinel: expect.any(String) });
                expect(future.initialText).not.toContain('turnId');
            }
            seen = true;
            const result = observed(); result.identity = trial.identity; result.input = trial.input;
            result.evidence.environment!.actual = { ...trial.identity, fresh: true };
            result.evidence['input-projection']!.actual = trial.input;
            return { input: trial.input, execute: async () => result, snapshot: async () => result, cancel: async () => {},
                close: async () => ({ present: true, actual: { closed: true, stopped: true }, source: 'Controlled stop' }) };
        } }
    });
    expect(seen).toBe(true);
}, 45000);
