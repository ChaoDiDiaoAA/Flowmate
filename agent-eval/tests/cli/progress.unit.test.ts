import { afterEach, expect, jest, spyOn, test } from 'bun:test';
import * as cli from '../../src/cli.ts';
import { registerSecrets } from '../../src/execution/evidence-safety.ts';

afterEach(() => { jest.useRealTimers(); });

test('final invalidation explains the earlier per-Trial results once and keeps the report path',()=>{
    const lines:string[]=[],reporter=cli.createProgressReporter(line=>lines.push(line));
    reporter.onProgress({type:'source-invalidated',datasetId:'flowmate-agent-v1',executionId:'synthetic',
        reason:'Execution source changed during the experiment',paths:['packages/core/src/example.ts']});
    reporter.onProgress({type:'dataset-end',datasetId:'flowmate-agent-v1',executionId:'synthetic',reportPath:'D:/synthetic/report.json',stopped:false,counts:{ERROR:10}});
    expect(lines.join('')).toContain('⚠ [业务]本组执行无效');
    expect(lines.join('')).toContain('代码条件变化');expect(lines.join('')).toContain('此前逐题结果仅供诊断');
    expect(lines.filter(line=>line.includes('本组执行无效'))).toHaveLength(1);
    expect(lines.at(-1)).toContain('D:/synthetic/report.json');reporter.close();
});

test('terminal progress reports actual stages immediately and waiting every sixty seconds', () => {
    expect(cli.createProgressReporter).toBeFunction();
    jest.useFakeTimers();
    const lines: string[] = [], reporter = cli.createProgressReporter(line => { lines.push(line); });
    reporter.onProgress({ type:'plan',selection:'smoke',total:14,datasets:[{id:'flowmate-agent-v1',total:10},{id:'flowmate-research-v1',total:4}] });
    reporter.onProgress({ type:'dataset-start',datasetId:'flowmate-agent-v1',executionId:'synthetic',reportPath:'D:/synthetic/report.json' });
    reporter.onProgress({ type:'trial-phase',index:1,total:14,caseId:'FM-001',trialId:'synthetic-FM-001-trial-1',phase:'executing' });
    expect(lines.at(-1)).toBe('▶ [1/14] FM-001：Agent执行\n');
    jest.advanceTimersByTime(59999);
    expect(lines.join('')).not.toContain('仍在等待');
    jest.advanceTimersByTime(1);
    expect(lines.at(-1)).toBe('⏳ [1/14] FM-001：Agent执行；仍在等待，已用时60秒\n');
    const firstWaitCount = lines.length;
    jest.advanceTimersByTime(59999);
    expect(lines).toHaveLength(firstWaitCount);
    jest.advanceTimersByTime(1);
    expect(lines).toHaveLength(firstWaitCount + 1);
    expect(lines.at(-1)).toBe('⏳ [1/14] FM-001：Agent执行；仍在等待，已用时120秒\n');
    reporter.onProgress({ type:'trial-end',index:1,total:14,caseId:'FM-001',trialId:'synthetic-FM-001-trial-1',status:'FAIL',reason:'Synthetic mismatch',
        elapsedMs:120000,evidenceDirectory:'evidence/synthetic-FM-001-trial-1/' });
    expect(lines.join('')).toContain('FAIL'); expect(lines.join('')).toContain('结果已保存');
    expect(lines.join('')).toContain('evidence/synthetic-FM-001-trial-1/');
    const count=lines.length;
    jest.advanceTimersByTime(60000);
    expect(lines).toHaveLength(count);
    reporter.close(); jest.advanceTimersByTime(60000); expect(lines).toHaveLength(count);
});

test('switching phases resets the sixty-second wait and clears the previous timer', () => {
    jest.useFakeTimers();
    const lines: string[] = [], reporter = cli.createProgressReporter(line => { lines.push(line); });
    const identity = { index: 1, total: 14, caseId: 'FM-001', trialId: 'synthetic-trial' };
    reporter.onProgress({ type: 'trial-phase', ...identity, phase: 'executing' });
    jest.advanceTimersByTime(45000);
    reporter.onProgress({ type: 'trial-phase', ...identity, phase: 'scoring' });
    expect(lines.at(-1)).toBe('▶ [1/14] FM-001：评分\n');
    const count = lines.length;
    jest.advanceTimersByTime(15000);
    expect(lines).toHaveLength(count);
    jest.advanceTimersByTime(44999);
    expect(lines).toHaveLength(count);
    jest.advanceTimersByTime(1);
    expect(lines).toHaveLength(count + 1);
    expect(lines.at(-1)).toBe('⏳ [1/14] FM-001：评分；仍在等待，已用时60秒\n');
    reporter.close();
    jest.advanceTimersByTime(60000);
    expect(lines).toHaveLength(count + 1);
});

test('Agent and scoring completion display distinct outcomes with symbols and stop waiting', () => {
    jest.useFakeTimers();
    const lines: string[] = [], reporter = cli.createProgressReporter(line => { lines.push(line); });
    const identity = { index: 1, total: 14, caseId: 'FM-001', trialId: 'synthetic-trial' };
    for (const [status, symbol, label] of [
        ['completed', '✅', 'Agent执行成功'], ['failed', '❌', 'Agent执行失败'], ['error', '❌', 'Agent执行失败'],
        ['timeout', '⚠', 'Agent执行失败（超时）'], ['cancelled', '⏹', 'Agent执行已取消'], ['not-started', '⏭', 'Agent执行未启动'],
    ] as const) {
        reporter.onProgress({ type: 'trial-phase', ...identity, phase: 'executing' });
        const beforeEnd = lines.length;
        reporter.onProgress({ type: 'agent-end', ...identity, status, reason: 'Synthetic Agent outcome.' });
        expect(lines).toHaveLength(beforeEnd + 1);
        expect(lines.at(-1)).toBe(`${symbol} [1/14] FM-001：${label}；Synthetic Agent outcome.\n`);
        const count = lines.length; jest.advanceTimersByTime(60000); expect(lines).toHaveLength(count);
    }
    reporter.onProgress({ type: 'trial-phase', ...identity, phase: 'scoring' });
    const count = lines.length; jest.advanceTimersByTime(59999); expect(lines).toHaveLength(count);
    jest.advanceTimersByTime(1); expect(lines.at(-1)).toContain('评分；仍在等待，已用时60秒');
    for (const [status, symbol, label] of [
        ['PASS', '✅', '通过（PASS）'], ['FAIL', '❌', '失败（FAIL）'], ['ERROR', '❌', '错误（ERROR）'],
        ['UNJUDGEABLE', '⚠', '未判定（UNJUDGEABLE）'], ['NOT_RUN', '⏭', '未运行（NOT_RUN）'],
    ] as const) {
        reporter.onProgress({ type: 'trial-phase', ...identity, phase: 'scoring' });
        const beforeEnd = lines.length;
        reporter.onProgress({ type: 'scoring-end', ...identity, status, reason: 'Synthetic outcome.' });
        expect(lines).toHaveLength(beforeEnd + 1);
        expect(lines.at(-1)).toBe(`${symbol} [1/14] FM-001：评分结果：${label}；Synthetic outcome.\n`);
        const count = lines.length; jest.advanceTimersByTime(60000); expect(lines).toHaveLength(count);
    }
    reporter.close();
});

test('terminal errors name the last phase and existing report without disclosing credentials', () => {
    expect(cli.createProgressReporter).toBeFunction();
    jest.useFakeTimers(); registerSecrets(['synthetic-progress-private-key']);
    const lines: string[]=[],reporter=cli.createProgressReporter(line=>{lines.push(line);});
    reporter.onProgress({type:'dataset-start',datasetId:'flowmate-agent-v1',executionId:'synthetic',reportPath:'D:/synthetic/report.json'});
    reporter.onProgress({type:'trial-phase',index:3,total:14,caseId:'FM-005',trialId:'synthetic-FM-005-trial-1',phase:'scoring'});
    reporter.close(Error('synthetic-progress-private-key'));
    const text=lines.join('');expect(text).toContain('运行异常');expect(text).toContain('FM-005');expect(text).toContain('评分');
    expect(text).toContain('D:/synthetic/report.json');expect(text).not.toContain('synthetic-progress-private-key');
    expect(text).not.toContain('全部完成');
    const count=lines.length;jest.advanceTimersByTime(60000);expect(lines).toHaveLength(count);
});

test('a broken terminal writer never interrupts evaluation notifications or cleanup', () => {
    expect(cli.createProgressReporter).toBeFunction();
    jest.useFakeTimers();
    const lines: string[] = [];
    const reporter=cli.createProgressReporter(line=>{lines.push(line);throw Error('synthetic closed terminal');});
    expect(()=>reporter.onProgress({type:'trial-phase',index:1,total:1,caseId:'FM-001',trialId:'synthetic-trial',phase:'cleanup'})).not.toThrow();
    expect(()=>jest.advanceTimersByTime(60000)).not.toThrow();
    expect(lines.at(-1)).toBe('⏳ [1/1] FM-001：确认停止与清理；仍在等待，已用时60秒\n');
    expect(()=>reporter.close(Error('synthetic failure'))).not.toThrow();
});

test('default progress uses stderr without changing JSON stdout or requiring an interactive terminal', () => {
    jest.useFakeTimers();
    const stderr=spyOn(process.stderr,'write').mockImplementation(()=>true),stdout=spyOn(console,'log').mockImplementation(()=>{});
    const reporter=cli.createProgressReporter();
    try {
        reporter.onProgress({type:'dataset-end',datasetId:'flowmate-agent-v1',executionId:'synthetic',reportPath:'D:/synthetic/report.json',
            stopped:true,reason:'用户取消评测',counts:{PASS:1,FAIL:2,ERROR:1,NOT_RUN:6}});
        expect(stderr.mock.calls.map(c=>c[0]).join('')).toContain('提前停止');
        expect(stderr.mock.calls.map(c=>c[0]).join('')).toContain('[报告]D:/synthetic/report.json');
        expect(stderr.mock.calls.map(c=>c[0]).join('')).toContain('NOT_RUN=6');
        expect(stdout).not.toHaveBeenCalled();
    } finally { reporter.close(); stderr.mockRestore(); stdout.mockRestore(); }
});
