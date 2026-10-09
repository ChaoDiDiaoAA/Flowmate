---
name: invoice-form-readiness-review
description: 准备把已选候选用于表单前，复核字段、明细、来源及未解决问题，报告需要人工确认的条件。
disable-model-invocation: false
---
# 发票表单就绪复核

使用当前 Run 冻结的任务、材料和候选范围；工具输入及结果以当前工具契约为准。

1. 用 get_invoice_candidate 读取当前任务明确选择的候选；记录 candidateRef、文档版本及现有状态，未选定时说明所需选择。
2. 阅读 references/guide.md，按当前表单所需字段及明细核对已取得值、未知状态和来源映射。
3. 用 read_invoice_evidence 与 check_invoice_sources 复核关键字段的完整引用，再用 validate_invoice_candidate 取得实际诊断。
4. 返回已核验条件、阻断项及需要人工确认项，区分候选可保存与表单可应用；缺少当前表单或目标信息时保持就绪结论未确认。
5. 完成条件是所有所需字段/行都有明确状态和对应核验依据。本 Skill 不调用 Fill、不修改表单；实际应用由用户沿独立 Fill 流程触发。

本 Skill 的参考规则通过 list_skill_resources({skill:"invoice-form-readiness-review"}) 确认文件，再按需调用 read_skill_resource({skill:"invoice-form-readiness-review",path:"references/guide.md"})。存在 nextOffset 时继续读取对应页；Skill 资料是操作指导，业务来源来自发票工具。
