import { expect, test } from 'bun:test';
import { runProgress } from '../../src/reports/readme.ts';
import { reportFixture } from '../support/fixtures.ts';

test('processed Trial progress uses completed scoring checkpoints and keeps scoring quality separate', () => {
    const report = reportFixture(); report.scoring = 'pending';
    const first = report.trials[0]!, error = structuredClone(first), unknown = structuredClone(first), pending = structuredClone(first), planned = structuredClone(first);
    for (const [i, trial] of [first, error, unknown, pending, planned].entries()) {
        trial.trialId = 'progress-' + i;
        Object.assign(trial, { scoringState: 'complete' });
    }
    error.scores[0]!.status = 'ERROR'; error.scores[0]!.value = null;
    error.scores[0]!.statistics = { unit: 'opportunity', numerator: 0, denominator: 0, missing: 0 };
    unknown.scores[0]!.status = 'UNJUDGEABLE'; unknown.scores[0]!.value = null;
    unknown.scores[0]!.statistics = { unit: 'opportunity', numerator: 0, denominator: 0, missing: 0 };
    Object.assign(pending, { scoringState: 'prepared' });
    planned.execution = null; planned.status = 'NOT_RUN'; planned.scores = [];
    report.trials = [first, error, unknown, pending, planned];
    expect(runProgress([report])).toMatchObject({ storedTrials: 5, startedTrials: 4, processedTrials: 3,
        scoredTrials: 1, scoringErrorTrials: 1, unjudgeableTrials: 1 });
});

test('legacy processed progress requires original report scoring completion and real score records', () => {
    const report = reportFixture(), trial = report.trials[0]!;
    report.scoring = 'pending';
    expect(runProgress([report])).toMatchObject({ processedTrials: 0, scoredTrials: 0 });
    report.scoring = 'complete';
    expect(runProgress([report])).toMatchObject({ processedTrials: 1, scoredTrials: 1 });
    trial.scores = [];
    expect(runProgress([report])).toMatchObject({ processedTrials: 0, scoredTrials: 0 });
});

test('logical Judge endings include local rejections and unknown submissions without increasing submitted calls', () => {
    const report = reportFixture();
    const base = { callId: '10000000-0000-4000-8000-000000000001' as const,
        configuration: { provider: 'codex-cli' as const, transport: 'codex-cli' as const, model: 'synthetic', reasoningEffort: 'max' as const,
            timeoutMs: 180000, protocolVersion: 'flowmate-judge/v2' },
        startedAt: '2026-10-30T00:00:00Z', endedAt: '2026-10-30T00:00:01Z', attempts: 1, usage: {}, responseModel: 'synthetic',
        raw: 'original response', error: null, judgment: null, stopReason: 'stop' as const, rawStopReason: null,
        usageSource: 'codex-cli' as const, responseComplete: true, lifecycle: 'ended' as const,
        request: { system: 'Declared rubric', data: '{}', redacted: false }, compact: undefined };
    report.trials[0]!.judgeCalls = [base, { ...base, callId: '10000000-0000-4000-8000-000000000002', attempts: 0, raw: null,
        endedAt: '', lifecycle: 'prepared', responseComplete: false },
        { ...base, callId: '10000000-0000-4000-8000-000000000003', raw: null, error: 'Transport failed' },
        Object.assign({ ...base, callId: '10000000-0000-4000-8000-000000000004' as const, attempts: 0, raw: null,
            responseComplete: false, error: 'Submission state unknown' }, { submissionUnknown: true }),
        { ...base, callId: '10000000-0000-4000-8000-000000000005', attempts: 0, raw: null, responseComplete: false, error: 'Input exceeds local capacity' }];
    expect(runProgress([report])).toMatchObject({ judgeTasksPrepared: 5, judgeTasksSubmitted: 2, judgeTasksEnded: 4, judgeTasksCompleted: 1, judgeTasksUnknown: 1 });
});
