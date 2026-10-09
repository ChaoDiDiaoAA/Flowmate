# 独立 Agent 评测

现行修订：2026-10-10，代码/部署盘点沿2026-10-09。[05唯一总计划](../docs/eval/05_Flowmate_Agent评测分阶段实施与操作手册_v1.md)→[06 Agent工程/制作](../docs/eval/06_Flowmate_Agent评测数据集制作实施与操作手册_v1.md)→[07用户完整执行/UI](../docs/eval/07_Flowmate_Langfuse接入与评测执行操作手册_v1.md)→[08核验](../docs/eval/08_Flowmate_Agent评测结果核验与流程验收手册_v1.md)→用户明确启动P15。每阶段交付后停止；本轮只修订文档，不制作数据/调用模型或平台。

## 架构与真实状态

Node/tsx CLI与Runner→生产Adapter→Bun Host公共产品入口/必要Electron Fill→采证→本地确定性评分/独立Judge→本地报告→Execution结束后可选Langfuse。Host是对应产品SQLite的唯一所有者，Node/Main不直接开业务库；不新增评测服务、统一预检层、第二套Loop或桌面评分。

正式[指标33项](../docs/eval/01_Flowmate_Agent评测总方案_v1.md#eval01-8-4)，[退役76项](../docs/eval/04_统一评测修订核对表.md#metric-retirement)不进现行汇总/覆盖/待测占位；Gold/隔离/停止/清理/校准/费用仍是必要事实和约束。当前8个确定性Grader＋1个answer-relevance Judge不能认领33项都已实现。P1–P14产品机制已有实现；production productAgent.readiness=false/prepare拒绝，datasets只有说明，strict v1、draft/pending；高级契约/v2/holdout/故障/校准命令待接合。完整配置比较/指纹/平台白名单也有缺口，不能靠draft/空requires/凭据放行。

SDK补丁已恢复，未验收增量已撤回，不再回退；原始材料、原通用设施、产品Runtime和运行/人工记录保留。没有本轮正式Benchmark或Baseline，工程通过与自动评分/完整质量验收分开。

## 命令边界

实际入口见[src/cli.ts](src/cli.ts)，`bun run eval`调用Node/tsx。当前语法：

| 分类 | 命令 |
|---|---|
| 当前可用 | help；dataset validate --dir；doctor --backend local或langfuse；status --execution-id或--dataset；compare --left/--right；review add/status；resend --report绝对summary路径；review setup/enqueue/import/sync --backend langfuse |
| 语法已有、生产受阻 | run --dataset --dataset-version --selection smoke或full --case --repeat 1..20 --config --execution-id --backend local或langfuse --judge auto/off/required |
| 待开发验证 | judge calibrate、runtime snapshot、--selection holdout；实现测试后才更新帮助和07可执行步骤 |

用户实际流程从07三组配置开始，不要求前置重复工程检查。Agent按06完成制作/工程，工程命令在其附录；平台维护/doctor在07附录。auto可能收费，本流程显式required；eval:smoke快捷当前Judge off，不能替代07必要Judge先导。旧sync/dataset publish/review apply/--version/--wait-seconds/--stage/--mode已退役。

## 评分、预算与报告

Task在本项目中称Case，只制作一次；Runner按`--repeat → config.repeat → 默认1`生成独立Trial（当前1..20），不新增Case级repeat。同Trial的多轮/恢复/子任务/内部重试不是新尝试。各Trial须从相同冻结初态重建独立可写实例，不能继承前次产物/历史/经验；真实重置仍待生产接合验收。[对象图及术语](../docs/eval/01_Flowmate_Agent评测总方案_v1.md#eval01-trial-model)。

当前[aggregate()](src/scoring/aggregate.ts)只汇总单Trial评分项/执行事实，[summary()](src/reports/store.ts)只计选集计划/启动/完成/五态。正式Trial→Case→Dataset原分子/分母/缺失聚合待阶段一版本化实现，不平均Case百分比、不择优、不静默合并不同Execution；[逻辑输出要求](../docs/eval/01_Flowmate_Agent评测总方案_v1.md#eval01-trial-aggregation)。完整50×1只形成一次基线；两次Smoke各10×1独立比较；Runtime各组16×3留出为48个计划Trial，A–D分别报告。repeat增加须先登记协议/预算。

当前evaluateAll只在started/completed/endpoint触发质量评分；阶段一必须增加已开始失败/取消Trial的Runtime过程/预期安全停止判定，不能把安全停止变completed。PASS/FAIL/UNJUDGEABLE/ERROR/NOT_RUN与检查不适用分别保存；必要失败不均分抵消，缺证据/未测不填0。

Judge使用独立FLOWMATE_JUDGE_*，最多一次/Trial、输出256、无自动重试。单Execution计划输出上限15000；50×256=12800；Runtime16×3×256=12288/组，四组留出49152＋四组Smoke8192=57344；24×3=18432须拒绝。校准/先导/开发/复测事前单列，Agent/Judge真实输入输出费用另累计，不能事后拆分超额计划。Runtime12对24条，8开发/16留出；A基础/B预算/C统计/D经验在留出前统一冻结，样本不足回退，不自动付费凑20次。

当前报告在`runs/<executionId>/summary.json、snapshot.json、source.json、<trialId>/{owner,input,execution}.json、reviews/<reviewId>.json`。同Execution不覆盖，旧报告只读；compare须阶段一补完整冻结身份检查。run退出0为必要自动检查通过、1失败/错误/未完成、2必要评分未完成；人工验收/导出独立。查询/比较/反馈/补传不调用模型。

## Langfuse定位与接入

复用本机D:/langfuse服务端4.55.0，SDK锁定5.11.1分列；部署记录见[03§6](../docs/eval/03_Flowmate_Langfuse平台接入设计方案_v1.md#eval03-6)。Langfuse展示Trace/Observation/Score/Sessions、筛选与审核队列；Execution→sessionId、Trial→稳定Trace，子仍同Trial。本地定义33项与算分，不使用平台自动Judge/SDK Experiment/权威Dataset；跨Trial分子分母以本地报告为准。

local不初始化SDK、不请求平台；显式langfuse先落本地再导出，失败不改分。当前导出仍含input/answer/artifacts/Observation/Judge raw，正式上传必须阶段一补字段白名单。resend只修复原对象/导出状态，不重跑Agent/Judge或重算分；平台review明确真实审核人/版本/Trial和去重。完整流程验收按08包含真实上传/查看/审核/两次补传，doctor成功不能替代。

[源码职责](src/README.md) · [数据制作](datasets/README.md) · [设施测试](tests/README.md) · [总方案](../docs/eval/01_Flowmate_Agent评测总方案_v1.md)
