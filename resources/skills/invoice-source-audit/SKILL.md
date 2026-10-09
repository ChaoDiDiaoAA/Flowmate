---
name: invoice-source-audit
description: 需要复核候选字段引用、来源版本或原文是否支持字段时，核验当前冻结材料并区分有效来源与待确认项。
disable-model-invocation: false
---
# 发票来源审计

使用当前 Run 冻结的任务、材料和候选范围；工具输入及结果以当前工具契约为准。

1. 取当前任务提供的字段与来源清单，确认它们属于当前冻结文档范围；缺少清单时先说明所需输入。
2. 阅读 references/guide.md，按字段或行用 read_invoice_evidence 读取被引用块，核对原文支持关系。
3. 将完整引用传给 check_invoice_sources；逐项记录真实返回的来源检查和拒绝原因。
4. 将“引用存在且版本合法”与“引用原文支持此字段含义”分别报告；对不充分、错主体或冲突的引用保留待确认。
5. 输出字段/行路径、原引用、检查事实、支持判断及补充资料要求。每条待审引用都有核验结果或明确缺口时完成。

本 Skill 的参考规则通过 list_skill_resources({skill:"invoice-source-audit"}) 确认文件，再按需调用 read_skill_resource({skill:"invoice-source-audit",path:"references/guide.md"})。存在 nextOffset 时继续读取对应页；Skill 资料是操作指导，业务来源来自发票工具。
