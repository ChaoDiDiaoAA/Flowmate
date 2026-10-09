---
name: invoice-line-item-extraction
description: 明细表跨行、跨页或列映射不清时，整理商品、数量、单价及税额，并保留每行来源和未识别项。
disable-model-invocation: false
---
# 发票明细整理

使用当前 Run 冻结的任务、材料和候选范围；工具输入及结果以当前工具契约为准。

1. 用 list_invoice_tables 确认当前发票的实际表格和页位置，再用 read_invoice_evidence 读取相关块。
2. 在映射列、合并续行或处理跨页前读取 references/guide.md；依当前表头建立列对应，保留无法映射的原始片段。
3. 每行记录原始文本、字段状态及完整来源；只有证据明确指向同一项时合并续行。
4. 用 normalize_invoice_values 处理数量、价格、金额及税率，并用 check_invoice_sources 核对所引用块；真实诊断保留为待确认项。
5. 输出有来源的明细清单、未归属片段及缺口。结束时每行要么有对应证据，要么明确保留为未识别；此处不做金额平衡或保存。

本 Skill 的参考规则通过 list_skill_resources({skill:"invoice-line-item-extraction"}) 确认文件，再按需调用 read_skill_resource({skill:"invoice-line-item-extraction",path:"references/guide.md"})。存在 nextOffset 时继续读取对应页；Skill 资料是操作指导，业务来源来自发票工具。
