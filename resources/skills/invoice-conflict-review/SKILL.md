---
name: invoice-conflict-review
description: 同一字段有多个证据值、买卖方归属冲突或跨材料结果不一致时，列出有来源的替代值及未解决条件。
disable-model-invocation: false
---
# 发票冲突复核

使用当前 Run 冻结的任务、材料和候选范围；工具输入及结果以当前工具契约为准。

1. 将待复核字段或行与冲突线索对应，用 read_invoice_evidence 取得各候选原文及来源。
2. 阅读 references/guide.md，先核对是否属于同一字段、同一文档范围和同一业务含义，再判断冲突。
3. 用 check_invoice_sources 核对各替代值的完整来源；缺来源的推测单列为未确认，不能充作证据值。
4. 输出各有依据的替代值、支持来源及其差别；只有证据充分时解释可判定的结论，否则保留 ambiguous 或未知状态。
5. 完成条件是每个冲突都有至少两个真实依据或已更正为缺失/无法辨认，并列出解决它所需的具体补充条件。

本 Skill 的参考规则通过 list_skill_resources({skill:"invoice-conflict-review"}) 确认文件，再按需调用 read_skill_resource({skill:"invoice-conflict-review",path:"references/guide.md"})。存在 nextOffset 时继续读取对应页；Skill 资料是操作指导，业务来源来自发票工具。
