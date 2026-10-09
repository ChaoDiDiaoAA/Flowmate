# 逐行计算规则

- 用当前行的表头、单位与来源确定 quantity、unitPrice、netAmount、taxRate、taxAmount、totalAmount；续行归属不明确时先报告缺口。
- quantity×unitPrice 只与含义一致的行金额比较。若单价含税、存在折扣/附加费用或价格单位不同，不擅自用该乘积证明净额。
- calculate_invoice_amounts 的 taxRate 是十进制比例；票面明确 13% 时比例为 0.13，记录该单位转换及原文。只有裸数字 13 且单位未知时不能选 0.13 或 13。
- normalize_invoice_values 不解析百分号或千位分隔格式。不支持的 raw 不冒称已规范化；必要的明确单位转换注明依据，不能用猜测填补格式歧义。
- decimal 输入服从真实工具 schema，包括精度及字符限制；超限时说明不能计算，不截断数值后继续。
- 只在材料或任务明确给出 scale 时采用该精度；否则使用 exact 和 scale=null。工具 rounding 为 half_away_from_zero，不能宣称其他舍入方式也已检验。
- 明细金额不同币种、含税/未税口径不明或缺输入时标记不能计算。净额加税额只在币种和口径相同且未存在其他费用时核对总额。
- 输出：行来源 | 算式与输入 | exact/rounded | 票面值 | 比较结论 | 舍入/缺口。差异不自动触发更正、保存或 Fill。
