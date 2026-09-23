import { expect, test, spyOn } from 'bun:test';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync } from '../../../tests/support/resources.ts';
import { discoverDatasets, loadDataset } from '../../src/datasets/local.ts';
import { findDataset } from '../../src/execution/runner.ts';
import { main } from '../../src/cli.ts';
import { reportFixture } from '../support/fixtures.ts';
import { exportReport, exportEvents } from '../../src/langfuse/export.ts';

function emptyRepo() {
    const repo = mkdtempSync(join(tmpdir(), 'flowmate-empty-dataset-'));
    mkdirSync(join(repo, 'agent-eval/datasets'), { recursive: true });
    writeFileSync(join(repo, 'agent-eval/datasets/README.md'), 'No business Dataset yet.');
    return repo;
}

test('empty discovery and missing Dataset explain the deferred creation', () => {
    const repo = emptyRepo();
    expect(discoverDatasets(join(repo, 'agent-eval/datasets'))).toEqual([]);
    expect(() => findDataset(repo)).toThrow('尚未制作，等待完整 Agent');
    expect(() => loadDataset(join(repo, 'agent-eval/datasets/missing'))).toThrow('Dataset 目录不存在');
});

test('doctor distinguishes configuration checks from Benchmark readiness', async () => {
    const repo = emptyRepo(), output = spyOn(console, 'log').mockImplementation(() => {});
    try {
        await main(['doctor', '--backend', 'local'], repo);
        const value = JSON.parse(String(output.mock.calls.at(-1)![0]));
        expect(value.ok).toBe(true);
        expect(value.datasets).toEqual([]);
        expect(value.benchmark.ready).toBe(false);
        expect(value.benchmark.reason).toContain('尚未制作，等待完整 Agent');
        expect(existsSync(join(repo, 'agent-eval/runs'))).toBe(false);
    } finally { output.mockRestore(); }
});

test('missing datasets reject runs and dataset operations before model or execution creation', async () => {
    const repo = emptyRepo();
    const network = spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Unexpected network'));
    try {
        for (const args of [
            ['run', '--dataset', 'flowmate-agent-v1', '--selection', 'smoke', '--judge', 'off'],
            ['run', '--dataset', 'flowmate-agent-v1', '--selection', 'full', '--judge', 'required', '--backend', 'langfuse'],
            ['status', '--dataset', 'flowmate-agent-v1'],
            ['review', 'status', '--dataset', 'flowmate-agent-v1'],
        ]) await expect(main(args, repo)).rejects.toThrow('尚未制作，等待完整 Agent');
        await expect(main(['dataset', 'validate', '--dir', join(repo, 'missing')], repo)).rejects.toThrow('Dataset 目录不存在');
        expect(network).not.toHaveBeenCalled();
        expect(existsSync(join(repo, 'agent-eval/runs'))).toBe(false);
        expect(discoverDatasets(join(repo, 'agent-eval/datasets'))).toEqual([]);
    } finally { network.mockRestore(); }
});

test('saved reports remain queryable, comparable, reviewable and exportable without Dataset', async () => {
    const repo = emptyRepo(), dir = join(repo, 'agent-eval/runs/unit');
    mkdirSync(dir, { recursive: true });
    const report = reportFixture(), file = join(dir, 'summary.json');
    writeFileSync(file, JSON.stringify(report));
    const output = spyOn(console, 'log').mockImplementation(() => {}), code = process.exitCode;
    try {
        await main(['status', '--execution-id', 'unit'], repo);
        expect(JSON.parse(String(output.mock.calls.at(-1)![0])).executionId).toBe('unit');
        await main(['compare', '--left', 'unit', '--right', 'unit'], repo);
        await main(['review', 'add', '--execution-id', 'unit', '--case', 'sample', '--reviewer', 'test-reviewer', '--verdict', 'good', '--note', 'synthetic feedback'], repo);
        await main(['review', 'status', '--execution-id', 'unit'], repo);
        expect(JSON.parse(String(output.mock.calls.at(-1)![0])).records).toHaveLength(1);
        const ids = exportEvents(report).map(e => e.id);
        await exportReport(report, file, async () => {});
        await exportReport(report, file, async () => {});
        expect(report.export.status).toBe('complete');
        expect(exportEvents(report).map(e => e.id)).toEqual(ids);
        expect(discoverDatasets(join(repo, 'agent-eval/datasets'))).toEqual([]);
    } finally { output.mockRestore(); process.exitCode = code; }
});
