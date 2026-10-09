---
name: invoice-review-handoff
description: Prepare an evidence-backed handoff summary for human invoice review.
disable-model-invocation: false
---
# 发票人工复核交接摘要

适用于将当前明确选定的保存候选及复核依据交给人工继续处理；交付的是聊天中的摘要，不是导出文件或业务决策。

1. 用 get_invoice_candidate 取得当前候选身份、文档版本、字段、明细、checks 和 issues。缺选定候选时说明需要选择，不自动挑选或宣称已找到最佳版本。
2. 按需用两项 Skill 工具读取 references/guide.md；区分模型来源、人工值与未解决字段，不把摘要写成接受结论。
3. 用 read_invoice_evidence 取得摘要所引用关键字段的原文，再用 check_invoice_sources 核对其引用。保留受限或不可读原因，不用历史印象填入新来源。
4. 整理候选身份、关键字段、明细概况、实际检查/问题、待确认条件及建议下一步；人工提供值单列，无来源或未验证值说明其状态。
5. 输出带来源的人工复核交接摘要。每个纳入的关键结论都有实际读取依据或明确未验证说明后结束；不修改候选，不执行保存/接受/导出/Fill，不宣称整票任务已完成。

先 list_skill_resources({skill:"invoice-review-handoff"})，再 read_skill_resource({skill:"invoice-review-handoff",path:"references/guide.md"})，依 nextOffset 继续。文档仅定义摘要结构，不提供发票事实。
