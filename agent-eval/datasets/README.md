# Agent Benchmark 制作说明

现行修订：2026-10-10。当前只有本说明，没有正式业务Case/Gold/成员清单；50/10与Runtime24/8/16是计划。旧提前草稿已删除，历史未验收工程已撤回，不恢复/归档或改名Fixture；原始voxel51、独立夹具和历史结果保留。

制作由Agent按[06](../../docs/eval/06_Flowmate_Agent评测数据集制作实施与操作手册_v1.md)执行，用户不手工创建JSON/复制/hash。权威为[02§2–12](../../docs/eval/02_Flowmate_Agent评测数据集制作方案_v1.md#eval02-2)和[01§4–8](../../docs/eval/01_Flowmate_Agent评测总方案_v1.md#eval01-4)：先接通契约/处理器/真实Adapter/采证/必要评分并受控验证，再覆盖矩阵→种子→材料/来源→投影→Case→Gold/行为预期→评分映射→真实审核/交付。P1–P14对应能力/工程为依据，不等待P15/P16，不靠空requires/draft/null绕过。

完整50条、Smoke引用10条。Runtime12正常/故障对24条，4对8开发/Smoke、8对16留出；配对/同来源/近重复同分区，跨集合暴露登记。正式范围为[33项](../../docs/eval/01_Flowmate_Agent评测总方案_v1.md#eval01-8-4)，全部有适用机会/单位/原公式/分子分母/证据/方法/缺失映射，不按指标数分配Case；退役指标不恢复。

原始`data/invoices/voxel51`只读；准备脚本生成agent-input及报告，产品注册/解析版本另取证。模型只见当前输入和允许材料，Gold/未来步骤/控制故障/评分/审核留质量侧。Gold从原件/可见解析独立核，不从模型输出或人工接受反推；真实人工参考/审核须有真实来源/姓名/日期/内容hash，Agent自检另列。

当前[src/datasets/local.ts](../src/datasets/local.ts)严格v1，只接受manifest draft、Case review pending；步骤枚举不表示执行能力。阶段一按[02§3.3](../../docs/eval/02_Flowmate_Agent评测数据集制作方案_v1.md#eval02-3-3)接通审核/冻结、v2 pairs/profile/calibration与holdout，保持v1兼容，不往v1塞未来字段。生产readiness=false/prepare拒绝，无数据时明确报错，不生成占位。

阶段一交付数据/Gold/覆盖/工程与无密钥模板后停止；用户按[07](../../docs/eval/07_Flowmate_Langfuse接入与评测执行操作手册_v1.md)真实校准/先导/快照/统一冻结/完整执行，按[08](../../docs/eval/08_Flowmate_Agent评测结果核验与流程验收手册_v1.md)核验/真实平台反馈/补传，再明确启动P15，P16后验安装。复用Langfuse4.55.0，但数据/Gold权威在本地。

Runtime A–D保留权限/停止/提交/必要保存；开发真实快照/hash/cutoff冻结，留出不反哺。样本不足回退、不自动付费凑20。单组留出Judge12288，四组留出49152＋正式Smoke8192＝57344，额外校准先导单列累计，不事后拆超额Execution。

工程制作命令/新增修改目录/审核模板见06；`dataset validate`和`status --dataset`由Agent在制作后执行，结构合法不等于Gold核验或真实质量通过。

Case是[任务定义](../../docs/eval/01_Flowmate_Agent评测总方案_v1.md#eval01-trial-model)，同一任务只保存一份JSON，Smoke引用原成员；不为Trial1/2/3复制Case正文、不在严格v1添加repeat或未来聚合字段。重复属于Execution计划，优先级`--repeat → config.repeat → 1`。固定初态/预置历史种子须可重建，各Trial独立可写且不继承上次候选、文件、历史或经验；同Trial恢复保留已发生事实。

制作交付分别登记唯一Case数和计划Trial数：50条全量×1、两个10条Smoke各×1、Runtime每组16条留出×3；任务数量不随重复增长，配对/来源分区不变。两层评分及[Case/Dataset正式聚合](../../docs/eval/01_Flowmate_Agent评测总方案_v1.md#eval01-trial-aggregation)仍须阶段一实现；不能把成员去重当成删除真实Trial，或将repeat=1声称为稳定性证明。
