# 独立 Agent 评测

**Deep Research产品与评测现状（2026-10-10，`acf1257`）：** P15本地产品已实现规划→精确Plan确认→调查→来源／Claim→保存证据报告，复用Pi SDK与现有Runtime，见[主§19](../docs/spec/00_Flowmate完整方案_v1.md#deep-research)及[P15实施§6](../docs/plans/P15_实施计划_v1.md#p15-engineering-delivery)。当前仅显式本地UTF-8文本、Markdown和已有解析Document，无搜索／网页提取／Tavily／检索回放前置；产品工程记录及限制不等于评测工程或正式质量已通过。

> **现行交接：** P1–P15适用产品→独立评测前三阶段→用户明确启动P16 Evaluation桌面→P17安装。原50／10＋研究12／4＝62／14，原33项＋DR01–06＝39项，Runtime24（8开发／16留出）另报。生产Adapter仍readiness=false，研究评测契约／步骤／采证／评分及正式数据未接通；已撤回工程不再次回退或恢复。执行状态以[05总计划](../docs/eval/05_Flowmate_Agent评测分阶段实施与操作手册_v1.md#current-state)为准，历史数字按当时语境解释。

前次修订记录：2026-10-10，代码/部署盘点沿2026-10-09。[05唯一总计划](../docs/eval/05_Flowmate_Agent评测分阶段实施与操作手册_v1.md)→[06 Agent工程/制作](../docs/eval/06_Flowmate_Agent评测数据集制作实施与操作手册_v1.md)→[07用户完整执行/UI](../docs/eval/07_Flowmate_Langfuse接入与评测执行操作手册_v1.md)→[08核验](../docs/eval/08_Flowmate_Agent评测结果核验与流程验收手册_v1.md)→用户明确启动P16。每阶段交付后停止；本轮只修订文档，不制作数据/调用模型或平台。

## 架构与真实状态

Node/tsx CLI与Runner→生产Adapter→Bun Host公共产品入口/必要Electron Fill→采证→本地确定性评分/独立Judge→本地报告→Execution结束后可选Langfuse。Host是对应产品SQLite的唯一所有者，Node/Main不直接开业务库；不新增评测服务、统一预检层、第二套Loop或桌面评分。

正式[指标39项](../docs/eval/01_Flowmate_Agent评测总方案_v1.md#eval01-8-4)，[退役76项](../docs/eval/04_统一评测修订核对表.md#metric-retirement)不进现行汇总/覆盖/待测占位；Gold/隔离/停止/清理/校准/费用仍是必要事实和约束。当前8个确定性Grader＋1个answer-relevance Judge不能认领39项都已实现。P1–P15适用产品机制已有实现（研究限本地）；production productAgent.readiness=false/prepare拒绝，datasets只有说明，strict v1、draft/pending；高级契约/v2/holdout/故障/校准命令待接合。完整配置比较/指纹/平台白名单也有缺口，不能靠draft/空requires/凭据放行。

SDK补丁已恢复，未验收增量已撤回，不再回退；原始材料、原通用设施、产品Runtime和运行/人工记录保留。没有本轮正式Benchmark或Baseline，工程通过与自动评分/完整质量验收分开。

## 命令边界

研究沿同一run／compare／status入口；flowmate-research-v1、configs/research-pilot.json和research-frozen.json是阶段一目标，当前仍生产受阻，不能直接运行。07按配置→校准→两次4条Smoke→冻结→研究12条Full→UI查看组织，不在主流程加入doctor／工程检查。

实际入口见[src/cli.ts](src/cli.ts)，`bun run eval`调用Node/tsx。当前语法：

| 分类 | 命令 |
|---|---|
| 当前可用 | help；dataset validate --dir；doctor --backend local或langfuse；status --execution-id或--dataset；compare --left/--right；review add/status；resend --report绝对summary路径；review setup/enqueue/import/sync --backend langfuse |
| 语法已有、生产受阻 | run --dataset --dataset-version --selection smoke或full --case --repeat 1..20 --config --execution-id --backend local或langfuse --judge auto/off/required |
| 待开发验证 | judge calibrate、runtime snapshot、--selection holdout；实现测试后才更新帮助和07可执行步骤 |

用户实际流程从07三组配置开始，不要求前置重复工程检查。Agent按06完成制作/工程，工程命令在其附录；平台维护/doctor在07附录。auto可能收费，本流程显式required；eval:smoke快捷当前Judge off，不能替代07必要Judge先导。旧sync/dataset publish/review apply/--version/--wait-seconds/--stage/--mode已退役。

## 评分、预算与报告

研究12×1另形成一次基线，两次Smoke各4×1独立比较；规划／调查／子Run不增加Trial。默认目录29／30（含5研究工具）、17 Skill不代表每Run集合，研究规划2／调查4／子调查2个研究工具按角色／冻结配置取证。39项映射及Case／Dataset原计数汇总仍待阶段一，不恢复76项退役指标。

Task在本项目中称Case，只制作一次；Runner按`--repeat → config.repeat → 默认1`生成独立Trial（当前1..20），不新增Case级repeat。同Trial的多轮/恢复/子任务/内部重试不是新尝试。各Trial须从相同冻结初态重建独立可写实例，不能继承前次产物/历史/经验；真实重置仍待生产接合验收。[对象图及术语](../docs/eval/01_Flowmate_Agent评测总方案_v1.md#eval01-trial-model)。

当前[aggregate()](src/scoring/aggregate.ts)只汇总单Trial评分项/执行事实，[summary()](src/reports/store.ts)只计选集计划/启动/完成/五态。正式Trial→Case→Dataset原分子/分母/缺失聚合待阶段一版本化实现，不平均Case百分比、不择优、不静默合并不同Execution；[逻辑输出要求](../docs/eval/01_Flowmate_Agent评测总方案_v1.md#eval01-trial-aggregation)。完整50×1只形成一次基线；两次Smoke各10×1独立比较；Runtime各组16×3留出为48个计划Trial，A–D分别报告。repeat增加须先登记协议/预算。

当前evaluateAll只在started/completed/endpoint触发质量评分；阶段一必须增加已开始失败/取消Trial的Runtime过程/预期安全停止判定，不能把安全停止变completed。PASS/FAIL/UNJUDGEABLE/ERROR/NOT_RUN与检查不适用分别保存；必要失败不均分抵消，缺证据/未测不填0。

Judge使用独立FLOWMATE_JUDGE_*，最多一次/Trial、输出256、无自动重试。单Execution计划输出上限15000；50×256=12800；Runtime16×3×256=12288/组，四组留出49152＋四组Smoke8192=57344；24×3=18432须拒绝。校准/先导/开发/复测事前单列，Agent/Judge真实输入输出费用另累计，不能事后拆分超额计划。Runtime12对24条，8开发/16留出；A基础/B预算/C统计/D经验在留出前统一冻结，样本不足回退，不自动付费凑20次。

当前报告在`runs/<executionId>/summary.json、snapshot.json、source.json、<trialId>/{owner,input,execution}.json、reviews/<reviewId>.json`。同Execution不覆盖，旧报告只读；compare须阶段一补完整冻结身份检查。run退出0为必要自动检查通过、1失败/错误/未完成、2必要评分未完成；人工验收/导出独立。查询/比较/反馈/补传不调用模型。

## Langfuse定位与接入

复用本机D:/langfuse服务端4.55.0，SDK锁定5.11.1分列；部署记录见[03§6](../docs/eval/03_Flowmate_Langfuse平台接入设计方案_v1.md#eval03-6)。Langfuse展示Trace/Observation/Score/Sessions、筛选与审核队列；Execution→sessionId、Trial→稳定Trace，子仍同Trial。本地定义39项与算分，不使用平台自动Judge/SDK Experiment/权威Dataset；跨Trial分子分母以本地报告为准。

local不初始化SDK、不请求平台；显式langfuse先落本地再导出，失败不改分。当前导出仍含input/answer/artifacts/Observation/Judge raw，正式上传必须阶段一补字段白名单。resend只修复原对象/导出状态，不重跑Agent/Judge或重算分；平台review明确真实审核人/版本/Trial和去重。完整流程验收按08包含真实上传/查看/审核/两次补传，doctor成功不能替代。

[源码职责](src/README.md) · [数据制作](datasets/README.md) · [设施测试](tests/README.md) · [总方案](../docs/eval/01_Flowmate_Agent评测总方案_v1.md)

研究阶段一复用[现有研究操作](../packages/contracts/src/research-commands.ts)，接合版本化本地材料／精确确认／调查与分页采证，制作12／4和独立Claim／证据链Gold。SourceSnapshot完整保存、首段4000 UTF-16字符及续读、后续请求／采用分别取证，Gold只要求本题允许材料支持的结论，Report新增事实同样核验。DR01–06及原33项由本地算分，产品full／supported不替代独立结果；每Trial一次Judge／256／无重试不变。原业务Full12800、研究Full3072，事前分别Execution累计15872，单Execution15000；校准／先导／复测另登记，Agent／Judge真实费用及未知保留，当前搜索未发生／不适用。研究Dataset和配置目标未创建，严格v1不接受未来字段。
