import { join, dirname } from 'node:path';
import { atomicText } from './files.ts';
import { archiveFile, archiveReference, readArchive, readArchivePart } from './archive.ts';
import type { LocalReport } from './store.ts';
import type { ExperimentRecord, ExperimentComparison, GateResult } from '../../../packages/contracts/src/evaluation-experiments.ts';
import { scanEvidence } from '../execution/evidence-safety.ts';
import { isRequiredScore } from '../scoring/types.ts';
import { scoreAvailability } from '../scoring/availability.ts';

const cell = (value: unknown) => String(value ?? '—').replaceAll('|', '\\|').replace(/[\r\n]+/g, ' ').replace(/[<>]/g, '');
const percent = (value: number | null) => value === null ? '不可比' : (value * 100).toFixed(2) + '%';
export function runProgress(reports: LocalReport[]) {
    const trials = reports.flatMap(report => report.trials), started = trials.filter(trial => trial.execution?.started);
    const processed = reports.flatMap(report => report.trials.filter(trial => trial.execution?.started &&
        (trial.scoringState === 'complete' || trial.scoringState === undefined && report.scoring === 'complete' && trial.scores.length > 0)));
    const required = (trial: typeof trials[number]) => trial.scores.filter(score => isRequiredScore(score, trial));
    const calls = trials.flatMap(trial => trial.judgeCalls), submitted = calls.filter(call => call.attempts > 0);
    return { storedTrials: trials.length, startedTrials: started.length,
        endedTrials: started.filter(trial => trial.execution?.endedAt).length,
        stopConfirmedTrials: started.filter(trial => {
            const cleanup = trial.execution?.evidence.cleanup, actual = cleanup?.actual;
            return cleanup?.present && actual && typeof actual === 'object' && 'closed' in actual && actual.closed === true && 'stopped' in actual && actual.stopped === true;
        }).length,
        processedTrials: processed.length,
        scoredTrials: processed.filter(trial => required(trial).length > 0 && required(trial).every(score => scoreAvailability(score, trial).state === 'measured')).length,
        scoringErrorTrials: processed.filter(trial => required(trial).some(score => scoreAvailability(score, trial).state === 'error')).length,
        unjudgeableTrials: processed.filter(trial => !required(trial).length || required(trial).some(score =>
            ['missing-evidence', 'not-run'].includes(scoreAvailability(score, trial).state))).length,
        judgeTasksPrepared: calls.length, judgeTasksSubmitted: submitted.length, judgeTasksEnded: calls.filter(call => call.endedAt).length,
        judgeTasksUnknown: calls.filter(call => call.submissionUnknown === true).length,
        judgeTasksCompleted: submitted.filter(call => !call.error && call.raw != null).length,
        verifiedTrials: reports.filter(report => report.export.status === 'complete').reduce((sum, report) => sum + report.trials.filter(trial => trial.execution?.started).length, 0) };
}
export function writeRunReadme(file: string) {
    file = archiveFile(file);
    const run = readArchive(file), reports: LocalReport[] = Object.keys(run.executions).map(id => readArchivePart(archiveReference(file, 'executions', id)));
    const experiment = run.experiment as ExperimentRecord | undefined;
    const arms = experiment?.arms ?? [{ id: 'agent', status: run.status, executionIds: reports.map(report => report.executionId) }];
    const comparisons = Object.values(run.comparisons) as ExperimentComparison[], gates = Object.values(run.gates) as GateResult[];
    const workflow = run.workflow as { summary?: Record<string, unknown>; baselineIds?: string[] } | undefined;
    const progress = runProgress(reports);
    const lines = ['# ' + run.id, '', `选集：**${cell(run.selection)}**；状态：**${cell(run.status)}**。`, '',
        '本页来自同目录的 [run.json](run.json)。原始执行与评分保留，人工意见和相对门禁不覆盖原成绩。', '',
        '## 执行范围与配置', '', '| 模型组 | 实际模型 / 强度 | 已存 Trial | PASS | FAIL | 其他 | 评分与上传 |', '|---|---|---:|---:|---:|---:|---|'];
    for (const arm of arms) {
        const selected = reports.filter(report => arm.executionIds.includes(report.executionId)), trials = selected.flatMap(report => report.trials);
        const model = experiment ? [experiment.plan.control, ...experiment.plan.candidates].find(value => value.id === arm.id)?.model : undefined;
        const actual = model ? `${model.model} / ${model.reasoning ?? 'provider default'}` : String(trials[0]?.execution?.configuration.model ?? '未执行');
        lines.push(`| ${cell(arm.id)} | ${cell(actual)} | ${trials.length} | ${trials.filter(trial => trial.status === 'PASS').length} | ${trials.filter(trial => trial.status === 'FAIL').length} | ${trials.filter(trial => !['PASS', 'FAIL'].includes(trial.status)).length} | ${cell(selected.map(report => `${report.dataset.id}: scoring=${report.scoring}, upload=${report.export.status}`).join('; '))} |`);
    }
    const judge = reports[0]?.scoringConfiguration.judge;
    if (experiment?.plan.evaluationBudgets) {
        lines.push('', '预算为本轮执行条件；确认后的研究 Plan 保留其原预算。', '',
            '| 任务 | Trial 业务期限 ms | 单 Run 默认期限 ms | 单 Run 模型调用上限 | 准备 / 采证 ms |',
            '|---|---:|---:|---:|---|');
        for (const [profile, budget] of Object.entries(experiment.plan.evaluationBudgets))
            lines.push('| ' + profile + ' | ' + budget.trialTimeoutMs + ' | ' + budget.runTimeoutMs + ' | ' + budget.maxModelCalls +
                ' | ' + budget.prepareTimeoutMs + ' / ' + budget.captureTimeoutMs + ' |');
        lines.push('', '逐 Run 实际限额、采用来源与步骤见 Trial 的 evaluation-budget 证据；准备、执行、采证和清理分别计时。');
    }
    lines.push('', '统计摘要规则：' + [...new Set(reports.map(report => report.statisticsPolicyVersion ?? 1))].join('、') +
        '。旧版摘要保留原值，当前比较与 Gate 另行检查证据；默认结果为 Original，显式补评分不覆盖本页原成绩。');
    lines.push('', `每题重复：${experiment?.plan.repeats ?? reports[0]?.repeat ?? 1}。变化轴：${cell(experiment?.plan.axes.join(', ') ?? 'single model')}。`, '',
        `Judge：${cell(judge?.model)}；推理强度：${cell(judge && 'reasoningEffort' in judge ? judge.reasoningEffort : undefined)}。`, '',
        `Judge 任务已准备：${progress.judgeTasksPrepared}；实际已提交：${progress.judgeTasksSubmitted}；提交状态未知：${progress.judgeTasksUnknown}；已结束：${progress.judgeTasksEnded}；成功取得结果：${progress.judgeTasksCompleted}。纯确定性题可不调用 Judge；未报告费用保持未知。`, '',
        '## 逐题结果与 Trace', '', '| Case | 名称 | 模型组 | 状态 | Trial 总耗时 ms | 输入 / 输出 Token | 结果说明 | Trace |', '|---|---|---|---|---:|---|---|---|');
    for (const arm of arms) for (const report of reports.filter(value => arm.executionIds.includes(value.executionId))) for (const trial of report.trials) {
        const target = report.export.target;
        const trace = target ? `[查看](${target.baseUrl}/project/${encodeURIComponent(target.projectId)}/traces/${trial.traceId})` : '上传未确认';
        const execution = trial.execution, elapsed = execution?.startedAt && execution.endedAt ? Date.parse(execution.endedAt) - Date.parse(execution.startedAt) : null;
        const known = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? String(value) : '未知';
        lines.push(`| ${cell(trial.caseId)} | ${cell(trial.caseName)} | ${cell(arm.id)} | ${trial.status} | ${elapsed !== null && Number.isFinite(elapsed) ? elapsed : '未知'} | ${known(execution?.usage?.inputTokens)} / ${known(execution?.usage?.outputTokens)} | ${cell(trial.reason).slice(0, 240)} | ${trace} |`);
    }
    lines.push('', 'Trial 总耗时包含业务执行、采证和清理，不代表纯模型延迟；Judge 的时间和已知用量另保留在原始记录中。未报告的用量及费用显示未知。', '', '## 模型比较', '');
    if (!comparisons.length) lines.push('尚无完整比较；执行中或证据不足时不能推断配置优劣。');
    for (const comparison of comparisons) {
        lines.push(`范围：${cell(comparison.scope.selection)}，${comparison.scope.cases} 题；比较：${comparison.status}。`, '',
            '| 指标 | 对照 | 候选 | 差值 | 方向 |', '|---|---:|---:|---:|---|');
        for (const metric of comparison.metrics) lines.push(`| ${cell(metric.metricId)} | ${percent(metric.before)} | ${percent(metric.after)} | ${metric.delta === null ? '不可比' : (metric.delta * 100).toFixed(2) + ' pp'} | ${cell(metric.direction)} |`);
        for (const reason of comparison.reasons) lines.push(`- ${cell(reason.code)}：${cell(reason.message)}`);
    }
    lines.push('', '## Baseline 与 Gate', '');
    if (workflow?.baselineIds?.length) lines.push('参考记录：' + workflow.baselineIds.map(cell).join('；') + '。', '');
    if (!gates.length) lines.push('尚无有效 Gate；缺少完整执行、评分或可比条件时保持 blocked。');
    for (const gate of gates) {
        lines.push(`- **${gate.status}**；范围 ${cell(gate.scope.selection)} / ${gate.scope.cases} 题；Baseline ${cell(gate.baselineId)}。`);
        for (const reason of gate.reasons) lines.push(`  - ${cell(reason.caseId)} ${cell(reason.metricId)}：${cell(reason.message)}；阈值 ${cell(reason.threshold)}。`);
    }
    lines.push('', '相对 Gate 通过不等于绝对质量合格；Full 不使用 Smoke 结果冒充全量门禁。', '', '## 失败定位', '');
    let signals = 0;
    for (const raw of Object.values(run.diagnostics)) for (const candidate of (raw as { candidates?: Array<{ caseId?: string; trialId?: string; signals: Array<{ kind: string; node: string; reason: string; evidence: unknown[] }> }> }).candidates ?? [])
        for (const signal of candidate.signals) {
            signals++; lines.push(`- ${cell(candidate.caseId)} / ${cell(candidate.trialId)}：${cell(signal.kind)} · ${cell(signal.node)} · ${cell(signal.reason)}`);
            if (signal.evidence.length) lines.push('  - 原始证据：' + signal.evidence.map(reference => '`' + cell(JSON.stringify(reference)).replaceAll('`', '\\`') + '`').join('；'));
        }
    if (!signals) lines.push('当前无已保存失败信号；仍应检查执行与评分完整性。');
    lines.push('', '诊断信号不是已确认根因。JSON 保留证据定位、原始工具过程与业务回执。', '', '## 完整性与限制', '',
        `已存执行组：${reports.length}；已存 Trial：${progress.storedTrials}；已启动：${progress.startedTrials}；已结束：${progress.endedTrials}；停止已确认：${progress.stopConfirmedTrials}；评分已处理：${progress.processedTrials}；必要评分可用：${progress.scoredTrials}；必要评分错误：${progress.scoringErrorTrials}；必要评分未决：${progress.unjudgeableTrials}；平台完整核对：${progress.verifiedTrials}。`, '',
        '一次重复用于本轮覆盖与比较，不能证明重复稳定性。没有执行的代码、Prompt 或策略改进不宣称已经有效。');
    if (workflow?.summary) lines.push('', '流程状态：', '', '```json', JSON.stringify(workflow.summary, null, 2), '```');
    atomicText(join(dirname(file), 'README.md'), scanEvidence(lines.join('\n') + '\n').value);
}
