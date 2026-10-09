---
name: invoice-candidate-save
description: 用户显式要求保存时，核验候选结构和来源，并依据真实保存回执报告候选身份。
disable-model-invocation: true
---
# 发票候选验证与保存

使用当前 Run 冻结的任务、材料和候选范围；工具输入及结果以当前工具契约为准。

1. 确认用户显式要求保存，当前任务是允许 save_invoice_candidate 的 save-candidate Run，且有明确候选草稿与冻结发票范围。
2. 阅读 references/guide.md；针对待保存字段用 read_invoice_evidence 取得依据，用 check_invoice_sources 核完整引用。
3. 按当前工具 schema 用 validate_invoice_candidate 校验草稿。保存资格以真实校验和保存工具为准；拒绝时保留原稿并说明需要修正项。
4. 资格与授权均满足后调用 save_invoice_candidate。结果未知或调用被取消时先查原调用/候选事实，不能重新制造一次保存。
5. 只有真实保存回执确认后报告 candidateId/sequence 及剩余问题；未确认时报告未确认。保存完成不等于用户已接受或表单已应用。

本 Skill 的参考规则通过 list_skill_resources({skill:"invoice-candidate-save"}) 确认文件，再按需调用 read_skill_resource({skill:"invoice-candidate-save",path:"references/guide.md"})。存在 nextOffset 时继续读取对应页；Skill 资料是操作指导，业务来源来自发票工具。
