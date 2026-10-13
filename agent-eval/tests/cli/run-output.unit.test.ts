import { expect, spyOn, test } from 'bun:test';
import * as runner from '../../src/execution/runner.ts';
import { main } from '../../src/cli.ts';
import { fixtureRepo, reportFixture } from '../support/fixtures.ts';

test('run keeps the progress summary and report path without automatic JSON; status remains explicit JSON', async () => {
    const report = reportFixture(), file = fixtureRepo + '/agent-eval/runs/unit/report.json';
    const run = spyOn(runner, 'runLocal').mockImplementation(async (_repo, _options, deps) => {
        deps?.onProgress?.({ type: 'dataset-start', datasetId: report.dataset.id, executionId: report.executionId, reportPath: file });
        deps?.onProgress?.({ type: 'dataset-end', datasetId: report.dataset.id, executionId: report.executionId,
            reportPath: file, stopped: false, counts: { PASS: 1 } });
        return { report, file, stopped: false };
    });
    const logs = spyOn(console, 'log').mockImplementation(() => {}), output: string[] = [];
    const stderr = spyOn(process.stderr, 'write').mockImplementation(chunk => { output.push(String(chunk)); return true; });
    const exit = process.exitCode;
    try {
        await main(['run', '--dataset', 'facility-test', '--judge', 'off'], fixtureRepo);
        expect(run).toHaveBeenCalledTimes(1);
        expect(logs).not.toHaveBeenCalled();
        expect(output.join('')).toContain('PASS=1');
        expect(output.join('')).toContain('[报告]' + file);
        expect(process.exitCode).toBe(0);
        await main(['status', '--dataset', 'facility-test'], fixtureRepo);
        expect(JSON.parse(String(logs.mock.calls[0]![0])).id).toBe('facility-test');
    } finally { process.exitCode = exit ?? 0; run.mockRestore(); logs.mockRestore(); stderr.mockRestore(); }
});
