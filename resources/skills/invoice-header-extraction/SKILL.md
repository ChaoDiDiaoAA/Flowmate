---
name: invoice-header-extraction
description: 需要整理发票号码、日期、买卖方、币种和头部金额时，区分原始值、规范化值及可核验来源。
disable-model-invocation: false
---
# 发票头字段整理

使用当前 Run 冻结的任务、材料和候选范围；工具输入及结果以当前工具契约为准。

1. 根据当前任务要整理的头字段读取 read_invoice_evidence；记录对应完整来源和原文片段。
2. 阅读 references/guide.md 后逐字段判定 present、missing、unreadable、not_applicable 或 ambiguous。字段状态以取得的证据决定。
3. 对已取得的日期、金额及其他受支持值调用 normalize_invoice_values；使用真实返回值及诊断，未解决的 normalized 保持 null。
4. 用 check_invoice_sources 核对将要引用的来源。来源失败的字段保持待确认并报告安全原因。
5. 返回头字段表，列出状态、raw、normalized、来源及待确认事项。所有要求字段均有证据或明确状态后结束；本 Skill 只整理字段，不保存候选。

本 Skill 的参考规则通过 list_skill_resources({skill:"invoice-header-extraction"}) 确认文件，再按需调用 read_skill_resource({skill:"invoice-header-extraction",path:"references/guide.md"})。存在 nextOffset 时继续读取对应页；Skill 资料是操作指导，业务来源来自发票工具。
