# Agent Benchmark 制作说明

修订：2026-09-23。当前本目录只保留本说明。旧 `flowmate-agent-v1/`（50 条 Case、dataset.json 和专属 README）已删除，不另建归档、空清单或占位资产。

**完整 Agent 实现、真实入口与必要采证能力接通、工程验证通过后，才依据 01 和 02 制作首版 Benchmark。** 此前只维护方案、制作规范和评测设施，不制作业务 Case、Gold 或成员清单。

首版规划 50 条任务，Smoke 引用其中 10 条，不复制正文。按 [总方案第八章](../../docs/eval/01_Flowmate_Agent评测总方案_v1.md) 的具体功能规划分类，tags 表示交叉覆盖；不按开发阶段建 Dataset，也不沿用旧类别分配。

制作开始后才创建 `flowmate-agent-v1/dataset.json`、说明与 `cases/<case-id>.json`。一个 JSON 一条任务，清单保存版本、成员、Smoke 引用、公共环境和评分配置。本地版本化数据为权威来源；执行时固定实际内容和材料快照。

制作时逐项核验用户输入、初始环境、成功标准、失败标准、评分方式与风险；公共要求只维护一次。Gold 与未来消息不进入 Agent。具体制作方法、复杂任务、材料与 Gold、证据要求、审核和冻结以 [02 制作手册](../../docs/eval/02_Flowmate_Agent评测数据集制作方案_v1.md) 为准。

原始发票来源 `data/invoices/voxel51` 只读保留。`src/datasets/` 是加载代码，`tests/fixtures/` 是独立工程测试材料，`runs/` 是既有或实际运行生成的证据；它们不因业务 Dataset 删除而清理，也不作为业务 Case 正文的替代来源。

制作完成后使用：

```powershell
bun run eval -- dataset validate --dir agent-eval/datasets/flowmate-agent-v1
```

当前校验或运行指定 Dataset 会明确拒绝，不调用模型、不创建执行记录、不自动生成数据。`doctor --backend local` 可检查零 Dataset 状态；配置检查通过不表示 Benchmark 就绪。已有报告的查询、比较、反馈与显式补传继续可用。

[操作手册](../README.md) · [源码职责](../src/README.md)
