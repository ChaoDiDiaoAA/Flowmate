---
name: invoice-evidence-discovery
description: 资料跨页、字段出处未知或需要定位明细表时，建立当前发票的证据地图并标明资料缺口。
disable-model-invocation: false
---
# 发票证据定位

使用当前 Run 冻结的任务、材料和候选范围；工具输入及结果以当前工具契约为准。

1. 从当前冻结任务确认 documentRef 与材料范围，用 list_invoice_pages 取得实际页号。只在该范围定位证据。
2. 用 read_invoice_document 查看需要的页段；字段已知时用 search_invoice_document 搜索标签或原文片段，明细任务用 list_invoice_tables 定位表格。
3. 用 read_invoice_evidence 取得相关块的完整文本和来源引用。引用以工具返回的文档版本、artifact、page、blockId、quote 为准。
4. 遇到跨页、重复块或页号不连续时，读取 references/guide.md 的定位规则；对未能取得的范围记录原因。
5. 输出“字段或行 → 原文 → 完整来源 → 当前判断”地图及资料缺口。完成条件是每个已提出的定位目标都有真实出处或明确缺口；定位阶段不创建候选。

本 Skill 的参考规则通过 list_skill_resources({skill:"invoice-evidence-discovery"}) 确认文件，再按需调用 read_skill_resource({skill:"invoice-evidence-discovery",path:"references/guide.md"})。存在 nextOffset 时继续读取对应页；Skill 资料是操作指导，业务来源来自发票工具。
