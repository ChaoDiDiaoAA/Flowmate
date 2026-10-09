---
name: invoice-amount-reconciliation
description: 需要核对净额、税额、总额、明细合计或舍入差异时，使用精确十进制工具并报告无法计算的条件。
disable-model-invocation: false
---
# 发票金额核算

使用当前 Run 冻结的任务、材料和候选范围；工具输入及结果以当前工具契约为准。

1. 从当前材料读取 read_invoice_evidence，区分需要核对的实际金额和计算输入，保留每个输入的来源。
2. 在多币种、税率或舍入判断前读取 references/guide.md；确定计算所需币种、精度和金额是否已取得。
3. 先用 normalize_invoice_values 取得可计算的十进制值，再用 calculate_invoice_amounts 的实际 schema 计算合计、乘积或税额。
4. 报告工具返回的 exact、rounded、scale 和 rounding，比较材料中的实际值与工具计算值；缺少输入时报告不能计算及所缺条件。
5. 输出各项核对的原值、工具计算值、差异和未确认条件。完成条件是每项都有真实计算结果或可解释的缺口；计算通过不表示候选已保存。

本 Skill 的参考规则通过 list_skill_resources({skill:"invoice-amount-reconciliation"}) 确认文件，再按需调用 read_skill_resource({skill:"invoice-amount-reconciliation",path:"references/guide.md"})。存在 nextOffset 时继续读取对应页；Skill 资料是操作指导，业务来源来自发票工具。
