import { expect, spyOn, test } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from '../../src/cli.ts';
import { reportFixture } from '../support/fixtures.ts';

test('explicit comparison adds a pending regression signal only after the existing comparability checks', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'eval-diagnostic-compare-'));
    for (const id of ['left', 'right']) {
        const report = reportFixture(), trial = report.trials[0]!; report.executionId = id; trial.execution!.identity.executionId = id;
        if (id === 'right') { trial.status = 'FAIL'; trial.scores[0]!.status = 'FAIL'; trial.scores[0]!.value = 0; }
        const directory = join(repo, 'agent-eval/runs', id); mkdirSync(directory, { recursive: true });
        writeFileSync(join(directory, 'report.json'), JSON.stringify(report));
    }
    const output = spyOn(console, 'log').mockImplementation(() => {});
    try {
        await main(['compare', '--left', 'left', '--right', 'right'], repo);
        const row = JSON.parse(String(output.mock.calls.at(-1)![0]))[0];
        expect(row).toMatchObject({ caseId: 'sample', before: 'PASS', after: 'FAIL' });
        expect(row.badcase.status).toBe('pending-review');
        expect(row.badcase.signals.some((signal: any) => signal.kind === 'version-regression')).toBe(true);
    } finally { output.mockRestore(); rmSync(repo, { recursive: true, force: true }); }
});

test('diagnostics retain mixed failures and PASS anomalies but exclude a merely planned Trial', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'eval-diagnostic-signals-')), directory = join(repo, 'agent-eval/runs/unit');
    mkdirSync(directory, { recursive: true });
    const report = reportFixture(), first = report.trials[0]!;
    first.status = 'FAIL'; first.scores[0]!.status = 'FAIL'; first.scores[0]!.value = 0;
    first.scores.push({ ...first.scores[0]!, metricId: 'tool-arguments', method: 'llm-judge', status: 'ERROR', value: null, reason: 'Invalid metric count' });
    const recovered = structuredClone(first); recovered.caseId = 'recovered'; recovered.trialId = 'trial-2'; recovered.traceId = '1234567890abcdef1234567890abcdef';
    recovered.status = 'PASS'; recovered.scores = [{ ...first.scores[0]!, required: false }];
    recovered.execution!.identity.caseId = recovered.caseId; recovered.execution!.identity.trialId = recovered.trialId;
    recovered.execution!.evidence.tools = { present: true, source: 'actual tool snapshots', actual: [
        { toolCallId: 10, runId: 1, toolName: 'save_research_claim', status: 'failed' },
        { toolCallId: 11, runId: 1, toolName: 'save_research_claim', status: 'succeeded' }
    ] };
    const planned = structuredClone(recovered); planned.caseId = 'planned'; planned.trialId = 'trial-3'; planned.traceId = 'abcdefabcdefabcdefabcdefabcdefab';
    planned.status = 'NOT_RUN'; planned.reason = 'Planned'; planned.execution = null; planned.scores = [];
    report.trials.push(recovered, planned);
    const file = join(directory, 'summary.json'); writeFileSync(file, JSON.stringify(report));
    const output = spyOn(console, 'log').mockImplementation(() => {}), code = process.exitCode;
    try {
        await main(['status', '--execution-id', 'unit'], repo);
        const index = JSON.parse(String(output.mock.calls.at(-1)![0])).badcases;
        expect(index.summary).toEqual({ candidates: 2, confirmed: 0 });
        expect(index.candidates.map((candidate: any) => candidate.trialId)).toEqual(['trial-1', 'trial-2']);
        expect(index.candidates[0].signals.map((signal: any) => signal.kind)).toContain('judge-error');
        expect(index.candidates[0].scores.map((score: any) => score.status)).toEqual(['FAIL', 'ERROR']);
        expect(index.candidates[1].signals.map((signal: any) => signal.kind)).toContain('tool-recovery');
        expect(index.candidates[1].signals.flatMap((signal: any) => signal.evidence).some((ref: any) => ref.file.endsWith('observation.json') && ref.nodeId === 'toolCall:10')).toBe(true);
    } finally { output.mockRestore(); process.exitCode = code ?? 0; rmSync(repo, { recursive: true, force: true }); }
});

test('status derives a pending diagnostic from a legacy report without rewriting it or calling a model', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'eval-diagnostic-status-')), directory = join(repo, 'agent-eval/runs/unit');
    mkdirSync(directory, { recursive: true });
    const report = reportFixture(), trial = report.trials[0]!;
    trial.status = 'FAIL'; trial.reason = 'Observed missing product'; trial.scores[0]!.status = 'FAIL'; trial.scores[0]!.value = 0;
    const file = join(directory, 'summary.json'); writeFileSync(file, JSON.stringify(report));
    const before = readFileSync(file), files = readdirSync(directory);
    const output = spyOn(console, 'log').mockImplementation(() => {}), network = spyOn(globalThis, 'fetch').mockImplementation(Object.assign(async () => { throw Error('Diagnosis must be offline'); }, { preconnect: () => {} }));
    const code = process.exitCode;
    try {
        await main(['status', '--execution-id', 'unit'], repo);
        const result = JSON.parse(String(output.mock.calls.at(-1)![0]));
        expect(result.badcases).toMatchObject({ contract: 'flowmate-badcase-index/v1', summary: { candidates: 1, confirmed: 0 } });
        expect(result.badcases.candidates[0]).toMatchObject({ trialId: 'trial-1', originalStatus: 'FAIL', status: 'pending-review', primaryCause: null });
        expect(result.trials[0].status).toBe('FAIL');
        expect(readFileSync(file)).toEqual(before); expect(readdirSync(directory)).toEqual(files); expect(network).not.toHaveBeenCalled();
    } finally { output.mockRestore(); network.mockRestore(); process.exitCode = code ?? 0; rmSync(repo, { recursive: true, force: true }); }
});
