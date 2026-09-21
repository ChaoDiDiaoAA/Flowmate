# Flowmate Agent 评测

当前三份 v1 方案已整理，旧评测代码及数据已清理，包括 Case、Gold、Fixture、来源标签、清单、中间结果和历史运行成绩；保留仓库原始发票材料。尚未建立新的数据集、执行器或 Baseline，后续按当前方案重新制作和验证。

当前设计入口：

- [Agent 评测主方案（第一版）](../docs/eval/01_Flowmate_Agent评测总方案_v1.md)：F/A/B、完整指标与测法、Inspect、证据和回归。
- [数据集制作方案（第一版）](../docs/eval/02_Flowmate_Agent评测数据集制作方案_v1.md)：目录树、阶段/综合数量、input + expected、Gold、核验与冻结。
- [产品主方案（第一版）](../docs/spec/00_Flowmate完整方案_v1.md)：真实 Pi 接入、产品与存储契约。

P1–P13 逐阶段先制作 3–5 个种子 Case，随开发扩充并在验收前核验冻结；数量范围见数据制作方案。P13 验收通过后制作综合任务集，先 10–20 个先导，再到 50–100 个、默认 80 个。Smoke 成熟后 10–20 个高价值成员引用。所有数字是计划，不是已完成数量。

目标目录为 `src` 共用 Runner/Adapter/Grader，`stage-evals/Pn/v1` 放当期 Case 和必要 Gold/Fixture，`data/v1` 放 P13 后综合数据，`benchmarks` 只引用成员，`tests` 放设施自检，`runs/<日期序号>` 保存实际 Inspect 日志与独立证据。详细文件级树以两份评测文档为准，不提前创建空模块。

正式用户库是 `<userData>/data/app.sqlite`。评测每 Trial 在质量根外新建测试根，DB 命名 `data/trial-1.sqlite`、`data/trial-2.sqlite` 等；同 Trial 恢复不换库，不复制用户库。Gold、expected、未来用户步骤和质量元数据不交付模型。使用 Inspect 承载评测，真实 Pi Runtime 仍由产品执行。

数据制作以当前 [数据集制作方案](../docs/eval/02_Flowmate_Agent评测数据集制作方案_v1.md) 为准。新资产必须重新制作和核验；原始发票材料不是现成 Gold。
