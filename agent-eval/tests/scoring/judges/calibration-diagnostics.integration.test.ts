import { expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { calibrateJudge } from '../../../src/scoring/judges/calibration.ts';
import { judgeResponse, namedJudgment } from '../../support/judge-response.ts';
import { main } from '../../../src/cli.ts';
import { spyOn } from 'bun:test';

const env = { FLOWMATE_JUDGE_API: 'openai-completions', FLOWMATE_JUDGE_MODEL: 'llama-3.3-70b-versatile', FLOWMATE_JUDGE_BASE_URL: 'https://unused.invalid/v1', FLOWMATE_JUDGE_API_KEY: 'controlled-independent-key' };
const plan = { contract: 'flowmate-semantic-plan/v1', criteria: [{ metricId: 'tool-arguments', version: 1, unit: '请求', denominator: 1, required: true, rule: 'Compare the requested and authorized object.', evidence: ['original'], trigger: 'started' }] };
function fixture() {
    const repo = mkdtempSync(join(tmpdir(), 'eval-calibration-diagnostics-')), directory = join(repo, 'references'); mkdirSync(directory);
    for (const [i, partition] of ['tune', 'validation'].entries()) writeFileSync(join(directory, partition + '.json'), JSON.stringify({
        contract: 'flowmate-judge-reference/v1', id: partition, instanceId: partition + '-instance', sourceGroup: partition + '-source', partition,
        authority: { kind: 'agent-authored', author: 'Synthetic test', basis: 'Independent controlled example' }, plan,
        evidence: { authorized: 'object-' + i, actual: i ? 'object-1' : 'wrong-object' },
        references: [{ metricId: 'tool-arguments', counts: [i, 1, 0], severeError: !i, citationSupport: null, reason: 'Independent comparison' }]
    }));
    writeFileSync(join(directory, 'calibration.json'), JSON.stringify({ contract: 'flowmate-judge-calibration/v1', version: 1,
        samples: ['tune', 'validation'].map(id => ({ id, file: id + '.json' })) }));
    return { repo, directory };
}
test('calibration writes its workload folder and treats a correctly judged negative example as expected', async () => {
    const { repo, directory } = fixture(); let calls = 0;
    try {
        const result = await calibrateJudge(repo, { directory, executionId: 'controlled-correct' }, { env, fetcher: async () => {
            const n = calls++;
            return judgeResponse({ choices: [{ message: { content: namedJudgment(plan, { v: 1, r: [[n, 1, 0]], f: n ? [] : [[0, 0, 1]] }) }, finish_reason: 'stop' }] });
        } });
        expect(calls).toBe(2); expect(result.file).toBe(join(repo, 'agent-eval/runs/calibration/controlled-correct/summary.json'));
        expect(JSON.parse(readFileSync(join(repo, 'agent-eval/runs/calibration/controlled-correct/badcases.json'), 'utf8')).summary).toEqual({ candidates: 0, confirmed: 0 });
        const before = readFileSync(result.file), output = spyOn(console, 'log').mockImplementation(() => {}), code = process.exitCode;
        try {
            await main(['status', '--execution-id', 'controlled-correct'], repo);
            expect(JSON.parse(String(output.mock.calls.at(-1)![0])).badcases.source.kind).toBe('calibration');
            expect(readFileSync(result.file)).toEqual(before); expect(calls).toBe(2);
        } finally { output.mockRestore(); process.exitCode = code ?? 0; }
    } finally { rmSync(repo, { recursive: true, force: true }); }
});
test('calibration false accepts and false rejects are indexed without claiming human confirmation', async () => {
    const { repo, directory } = fixture(); let calls = 0;
    try {
        const result = await calibrateJudge(repo, { directory, executionId: 'controlled-wrong' }, { env, fetcher: async () => {
            const n = ++calls === 1 ? 1 : 0;
            return judgeResponse({ choices: [{ message: { content: namedJudgment(plan, { v: 1, r: [[n, 1, 0]], f: n ? [] : [[0, 0, 1]] }) }, finish_reason: 'stop' }] });
        } });
        const index = JSON.parse(readFileSync(join(result.file, '../badcases.json'), 'utf8'));
        expect(index.summary).toEqual({ candidates: 2, confirmed: 0 });
        expect(index.candidates.map((candidate: any) => candidate.sampleId)).toEqual(['tune', 'validation']);
        expect(index.candidates.every((candidate: any) => candidate.status === 'pending-review' && candidate.primaryCause === null)).toBe(true);
    } finally { rmSync(repo, { recursive: true, force: true }); }
});
