---
name: invoice-line-calculation-review
description: Check quantity, unit price, net amount, and tax calculations for individual invoice lines.
disable-model-invocation: false
---
# 发票逐行金额核算

适用于已经定位的明细行中数量×单价、行净额、税率/税额或行总额需要核对的任务；不重做整票汇总。

1. 用 list_invoice_tables 定位实际表块，按分页游标继续；用 read_invoice_evidence 读取待核行的数量、单价、净额、税率、税额及对应表头，保留来源。
2. 在税率单位、含税价格、折扣或舍入含义不明确时，先通过两项 Skill 工具读取 references/guide.md；不把无法解释的行列关系强行组合成算式。
3. 用 normalize_invoice_values 取得可计算的 decimal 值，随后按 calculate_invoice_amounts 的真实 schema 分别计算 product、tax 或 sum；金额精度无依据时 scale=null。
4. 核算只比较含义一致的量；用 check_invoice_sources 检查输入和票面比较值的引用，报告 exact、rounded、scale、rounding 及对应实际值。没有合法差值运算工具时列出比较值及比较结论，不把模型心算冒充工具结果。
5. 输出逐行核对表、无法计算项和所需条件。每个目标算式有真实计算结果或明确阻断后结束；数量为零不等于字段 missing，计算符合不表示候选已保存或被接受。

先 list_skill_resources({skill:"invoice-line-calculation-review"})，按需 read_skill_resource({skill:"invoice-line-calculation-review",path:"references/guide.md"})，有 nextOffset 时继续。参考规则不是明细数值来源。
