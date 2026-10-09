# Agent Benchmark 制作说明

修订：2026-10-02（删除提前制作的评测数据）。旧 `flowmate-agent-v1/` 的50条Case、清单及专属README，以及本轮 `flowmate-runtime-recovery-v1/` 的24条Case、清单、Gold审核草稿与A–D四组配置均已删除，不留冻结/归档副本，不改名或移作工程夹具。当前 `datasets/` 只有本制作说明。

**现行顺序：按 06 制作→07 接入/执行→08 核验，完整独立流程验收后由用户启动 P15，P16 后验安装。** 正式制作按 01 §12.1 核对产品能力、契约/处理器、公开入口、采证及工程证据；缺项先接合验证，不等待 P15/P16。 规则沿 [01 §12.1](../../docs/eval/01_Flowmate_Agent评测总方案_v1.md)。Runtime 专题见 [01 §12.2](../../docs/eval/01_Flowmate_Agent评测总方案_v1.md)/[02 §7.10](../../docs/eval/02_Flowmate_Agent评测数据集制作方案_v1.md)，仅为整体门槛后的待实施计划。requires子集/空数组、draft/null、配置或凭据不能解锁；生产 productAgent.readiness=false、prepare拒绝。

完整首版规划50条、Smoke引用10条；Runtime规划12正常/故障配对共24条，8开发/Smoke、16留出，同来源和配对在同分区。不沿用旧草稿、类别配额或审核结果；复用同一Runner，不按开发阶段另建运行器。

原Loader保留严格 `flowmate-agent-dataset/v1`。本轮新增v2/holdout/校准/故障与产品Adapter增量及专属测试已撤回，Runtime T15/T16 随独立手册前置开发实施；未来先实现契约、公共采证及独立最小合成设施验证，再由T18正式制作。一JSON一任务，清单维护版本/成员/Smoke/环境/评分；未来v2字段和校准要求见 [02 §3.3](../../docs/eval/02_Flowmate_Agent评测数据集制作方案_v1.md)，当前不可冒称已支持。

制作时逐项核验真实用户输入、初始环境、成功/失败标准、评分和风险，公共要求只维护一次。Gold及未来消息不进入Agent；材料、真值、审核和冻结遵循 [02制作手册](../../docs/eval/02_Flowmate_Agent评测数据集制作方案_v1.md)。正式数据核验后才真实开发及必要Judge校准、冻结、Smoke/留出和四组对照，不自动付费补20条样本，留出不反哺。

原始来源 `data/invoices/voxel51` 只读保留。`src/datasets/` 是加载代码，原独立 `tests/fixtures/` 是通用工程夹具，`runs/` 保留独立历史记录；不把它们当业务Case正文替身。本轮依赖Runtime数据的专属测试及支持文件随实现撤回。产品Runtime T10–T14与适用工程验证保留，T17当前不依赖正式评测数据。

完整产品和正式制作核验完成后使用：

```powershell
bun run eval -- dataset validate --dir agent-eval/datasets/flowmate-agent-v1
```

当前业务Dataset缺失时明确报错，不生成占位、自动回退或模型请求。doctor只检查声明范围；原报告查询/比较/反馈/显式补传保留原执行与评分事实，反馈另存、补传只更新导出状态，不解锁质量运行。

未来四组A基础/B预算/C统计期限/D经验均保留安全、权限、提交、停止及必要保存。独立留出Execution各12288<15000、四组49152，四组正式Smoke8192，八正式Execution57344；额外校准事前单列并汇总，不事后拆超额计划。安全停止确定性核验，无模型解释则语义理解未测；所有规模和预算是计划，没有质量成绩。

[06 逐步制作](../../docs/eval/06_Flowmate_Agent评测数据集制作实施与操作手册_v1.md) · [05 总入口](../../docs/eval/05_Flowmate_Agent评测分阶段实施与操作手册_v1.md) · [评测 README](../README.md) · [源码职责](../src/README.md)

后续平台统一复用本机已部署的 **Langfuse 服务端 4.55.0**，见 [03 §6](../../docs/eval/03_Flowmate_Langfuse平台接入设计方案_v1.md#eval03-6)；正式数据与 Gold 仍由本地制作/审核，不以平台部署完成代替。
