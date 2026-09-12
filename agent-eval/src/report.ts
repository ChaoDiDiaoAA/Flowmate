import type { Summary } from "./statistics.js";

export function renderReport(summary: Summary, moduleBindings: Record<string, string[]> = {}): string {
  const lines = [
    "# Flowmate Agent 评测报告",
    "",
    `- 计划项：${summary.planned}`,
    `- 已执行：${summary.executed}`,
    `- 可评分：${summary.scoreable}`,
    `- PASS / FAIL / UNJUDGEABLE：${summary.pass} / ${summary.fail} / ${summary.unjudgeable}`,
    `- ERROR / NOT_RUN：${summary.error} / ${summary.notRun}`,
    `- 可评分通过率：${summary.scoreablePassRate === null ? "不可计算" : `${(summary.scoreablePassRate * 100).toFixed(1)}%`}`,
    "",
    "| 模块 | 计划 | 已执行 | PASS | FAIL | UNJUDGEABLE | ERROR | NOT_RUN | 绑定 |",
    "|---|---:|---:|---:|---:|---:|---:|---:|---|",
  ];
  for (const [module, value] of Object.entries(summary.byModule).sort(([a], [b]) => a.localeCompare(b))) {
    lines.push(`| ${module} | ${value.planned} | ${value.executed} | ${value.pass} | ${value.fail} | ${value.unjudgeable} | ${value.error} | ${value.notRun} | ${(moduleBindings[module] ?? []).join(", ")} |`);
  }
  return `${lines.join("\n")}\n`;
}
