---
name: invoice-missing-info-review
description: 字段缺失、资料无法辨认或不适用时，列出有依据的缺口及需要补充的信息，保留未知状态。
disable-model-invocation: false
---
# 发票缺失资料复核

使用当前 Run 冻结的任务、材料和候选范围；工具输入及结果以当前工具契约为准。

1. 按当前任务的字段或问题清单，用 read_invoice_evidence 查看已有资料，记录取得与无法取得的范围。
2. 在判断 missing、unreadable 或 not_applicable 前读取 references/guide.md，分别说明依据。
3. 每个缺口写明对应字段/行、已看材料、当前状态以及受影响的下一步判断。
4. 将补充要求写成可回答的问题或可提供的材料；同一份补充资料能解决多项时合并要求。
5. 输出缺口清单和优先补充项。完成条件是所有提出的缺口均能追溯到已看材料或不可读范围，未知值仍保持未知。

本 Skill 的参考规则通过 list_skill_resources({skill:"invoice-missing-info-review"}) 确认文件，再按需调用 read_skill_resource({skill:"invoice-missing-info-review",path:"references/guide.md"})。存在 nextOffset 时继续读取对应页；Skill 资料是操作指导，业务来源来自发票工具。
