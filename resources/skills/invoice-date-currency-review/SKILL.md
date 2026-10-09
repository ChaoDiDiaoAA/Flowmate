---
name: invoice-date-currency-review
description: Review ambiguous dates and currency labels without guessing formats or exchange rates.
disable-model-invocation: false
---
# 发票日期与币种歧义复核

适用于日期顺序、多种日期标签或币种代码/符号存在歧义的任务；本流程不进行汇率换算。

1. 用 read_invoice_evidence 读取相关原文和来源，区分开票日期、到期日期及其他出现的日期；仅有用户转述而未取得材料时说明缺口。
2. 在判断日期顺序或币种符号前，通过两项 Skill 工具读取 references/guide.md。
3. 对实际取得的原文用 normalize_invoice_values 的 date/currency 类型处理；逐项保留 status、value、alternatives、reason。工具不支持的符号不得改写成猜测的币种代码再冒称原文已规范化。
4. 用 check_invoice_sources 核对引用；将材料提供的语义归属与工具提供的格式转换分别列出。
5. 输出原值、字段标签、规范化结果、替代解释、来源及补充条件。每项都有工具结果或明确不能处理的原因后结束；歧义保持未解决，不用当前时间/地区习惯选择解释，不修改候选。

先调用 list_skill_resources({skill:"invoice-date-currency-review"})，再按需调用 read_skill_resource({skill:"invoice-date-currency-review",path:"references/guide.md"})；按 nextOffset 继续读取。正文和参考文件不作为日期或币种的业务证据。
