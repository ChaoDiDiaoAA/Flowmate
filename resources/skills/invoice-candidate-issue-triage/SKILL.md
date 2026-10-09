---
name: invoice-candidate-issue-triage
description: Prioritize saved candidate issues and checks for human review.
disable-model-invocation: false
---
# 发票候选问题分级

适用于已有保存候选的检查结果和问题需要整理成复核顺序的任务。当前候选必须由可信工作区或用户明确选定。

1. 用 get_invoice_candidate 读取该候选的实际身份、checks、issues 和字段。缺少候选选择时请求选择，不用列表位置自动选定。
2. 通过两项 Skill 工具读取 references/guide.md，区分 failed、not_evaluable、not_applicable 及问题现有 severity/origin。
3. 对需要说明的问题，用 read_invoice_evidence 读取相关字段的原始证据，再用 check_invoice_sources 核对来源；人工提供值没有文档来源时如实标注。
4. 按已有 error/warning 严重程度及受影响字段整理；先呈现 error 和无法核验的关键条件，保留完整问题 code、origin 和检查状态，不自行改写原问题等级。
5. 输出候选身份、问题/检查、字段路径、依据、影响及建议下一步。每个实际问题已列出或合并注明来源后结束；没有检查不等于检查通过，报告不修改候选或改变接受状态。

先 list_skill_resources({skill:"invoice-candidate-issue-triage"})，再 read_skill_resource({skill:"invoice-candidate-issue-triage",path:"references/guide.md"})；有 nextOffset 时继续。Skill 指导不能充当新的检查或证据。
