---
name: invoice-candidate-comparison
description: 需要比较同一任务的候选版本、字段变化或明细差异时，读取实际候选并说明来源、状态和未解决差别。
disable-model-invocation: false
---
# 发票候选比较

使用当前 Run 冻结的任务、材料和候选范围；工具输入及结果以当前工具契约为准。

1. 用 list_invoice_candidates 取得当前任务可访问的候选及实际ID/sequence；用户指定项缺失时明确报告。
2. 用 get_invoice_candidate 读取要比较的候选，记录任务、文档版本与候选身份。
3. 阅读 references/guide.md，再用 compare_invoice_candidates 的实际输入契约取得差异；保留工具返回的字段和行路径。
4. 分别说明 raw、normalized、state、sources 与明细变化；没有证据读取权限时将“来源引用改变”与“来源内容已核验”区分。
5. 输出比较双方身份、关键差异、未解决项及建议复核顺序。完成条件是所要求比较项均有实际差异或明确不可比原因；本 Skill 不选定、保存或接受候选。

本 Skill 的参考规则通过 list_skill_resources({skill:"invoice-candidate-comparison"}) 确认文件，再按需调用 read_skill_resource({skill:"invoice-candidate-comparison",path:"references/guide.md"})。存在 nextOffset 时继续读取对应页；Skill 资料是操作指导，业务来源来自发票工具。
