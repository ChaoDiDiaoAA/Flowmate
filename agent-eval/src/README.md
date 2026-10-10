# 评测源码职责

已有产品入口位于[research.ts](../../packages/contracts/src/research.ts)、[research-commands.ts](../../packages/contracts/src/research-commands.ts)及[ProductApi](../../packages/contracts/src/runtime.ts)；研究核心／工具／SQLite存储在产品内已实现。待接合的是Node→Bun Host评测Adapter、用户确认步骤、列表分页／片段／原Run采证、独立DR评分与白名单；不复制产品研究服务、API或数据库写入者。来源body、Gold、资源正文及本地路径默认留本地，Langfuse4.55.0只展示本地结果。

**Deep Research产品与评测现状（2026-10-10，`acf1257`）：** P15本地产品已实现规划→精确Plan确认→调查→来源／Claim→保存证据报告，复用Pi SDK与现有Runtime，见[主§19](../../docs/spec/00_Flowmate完整方案_v1.md#deep-research)及[P15实施§6](../../docs/plans/P15_实施计划_v1.md#p15-engineering-delivery)。当前仅显式本地UTF-8文本、Markdown和已有解析Document，无搜索／网页提取／Tavily／检索回放前置；产品工程记录及限制不等于评测工程或正式质量已通过。

> **现行交接：** P1–P15适用产品→独立评测前三阶段→用户明确启动P16 Evaluation桌面→P17安装。原50／10＋研究12／4＝62／14，原33项＋DR01–06＝39项，Runtime24（8开发／16留出）另报。生产Adapter仍readiness=false，研究评测契约／步骤／采证／评分及正式数据未接通；已撤回工程不再次回退或恢复。执行状态以[05总计划](../../docs/eval/05_Flowmate_Agent评测分阶段实施与操作手册_v1.md#current-state)为准，历史数字按当时语境解释。

前次修订记录：2026-10-10。[05](../../docs/eval/05_Flowmate_Agent评测分阶段实施与操作手册_v1.md)为唯一总计划，06 Agent工程/制作→07用户真实执行/平台查看→08核验，通过后用户明确启动P16。当前strict v1、smoke/full、production readiness=false/prepare拒绝，正式数据/质量未测；本轮只文档修订，不再次回退工程。

| 入口 | 当前职责及阶段一缺口 |
|---|---|
| cli.ts | 已有运行/查询/比较/反馈/补传/平台审核；calibrate/snapshot/holdout待实现 |
| datasets/local.ts | v1严格Schema/hash/成员/投影；正式审核冻结/v2/注册fault/holdout待接合 |
| adapters/agent.ts | Kernel.readiness/prepare；Session.input/execute/snapshot/cancel/close；生产拒绝，Node经既有Bun Host公共入口接合，不直开产品DB |
| execution/runner.ts、execute-case.ts | 独立Trial/预算/报告/取消清理；进度/停止确认/受控结果根和生产采证待补 |
| execution/source.ts | 当前指纹，.tsx/Markdown资源/角色模板/锁文件/补丁完整身份待补 |
| scoring/registry.ts、evaluate.ts、aggregate.ts | 8确定性＋1Judge；aggregate仅合并单Trial评分项/执行事实为五态。39项映射、失败终态过程及Case/Dataset原分子分母聚合待接 |
| scoring/evaluators/ | 只读可信事实；字段/明细Gold支撑任务成功，隔离/no-secret/closed仍必要约束，不恢复退役KPI |
| scoring/judges/ | 独立FLOWMATE_JUDGE_*、请求/解析/错误；紧凑多语义判据、取消/校准记录待补；一次/Trial≤256输出、无自动重试 |
| reports/store.ts | summary仅计all/smoke/holdout计划/启动/完成/五态；报告/重读/比较已有，完整身份检查及Case分组统计待补。旧报告只读、同Execution不覆盖 |
| review/local.ts | 独立真实反馈绑定Case hash/Trial/来源；不覆盖Gold或自动成绩 |
| langfuse/export.ts、human.ts | 稳定身份/部分回执/补传/审核；完整白名单/生产父子/39项映射待补；当前raw载荷不能当白名单已完成 |

正式范围只沿[01§8.4–8.8的39项](../../docs/eval/01_Flowmate_Agent评测总方案_v1.md#eval01-8-4)，不是现有9个评分器的别名，也不要求一指标一Grader/Judge。业务完成、Runtime过程、安全停止分立，五态与检查不适用单列，缺实现不能N/A；硬约束不平均抵消。39项及76退役与历史见04，费用/停止/清理仍记必要事实。

AgentTrial仅含身份/目录/当前input/requires/受控setup/steps/config，不含expected/Gold；Adapter通过公开入口分时投递，不整体复制未来steps给模型。Host唯一持SQLite，必要Fill经真实Electron桥。临时dataRoot/cwd不构成系统隔离，质量文件/Judge/平台密钥必须对Agent的原生文件/Shell不可读。停止未知阻断下一Trial并保留现场，原Run/core/delivery/历史事实不相互覆盖。

Runtime v2/pairs/profile/holdout/真实快照/hash/cutoff按02§3.3和06阶段一实施，产品Runtime已有不等于专题Adapter/数据/报告完成。统计最近200实际尝试、≥20合格样本/最近20风险回退、ceil(1.5×P95)与既定结构化产品PURE/READ激活沿原设计；写工具、命令及Pi原生文件工具用配置期限。不伪造/自动凑20/留出反哺。T15/T16评测配套与产品P16/P17分开，T17产品工程保留，T18制作与真实对照分阶段记录。

Langfuse服务端4.55.0与锁定SDK5.11.1分列。Execution为平台sessionId、Trial为稳定Trace、子仍同Trial；本地算分后结束导出，不实时编排。backend local不初始化平台；resend只更新导出状态不新增Agent/Judge，真实平台队列反馈显式import/sync并去重。正式分子分母在本地，不使用第二套平台自动Judge。

工程测试用独立夹具/受控Transport，不调用付费模型或真实平台；适用命令在06附录，当前源文件不是已验收能力清单。新增catalog/runtime-recovery/calibration是阶段一目标，本轮不预建空文件。运行结果实际路径见[评测README](../README.md)，详细缺口/命令状态见[07](../../docs/eval/07_Flowmate_Langfuse接入与评测执行操作手册_v1.md#execution-gaps)。

重复结构现有实现：runner按`options.repeat ?? config.repeat ?? 1`计划各Case的Trial，保留caseId/version/hash、repetition、trialId及绑定Execution的traceId，逐次执行/评分；不是Case级重复控制，也不是已完成跨Trial指标聚合。[01§6.2](../../docs/eval/01_Flowmate_Agent评测总方案_v1.md#eval01-trial-model)/[§7.7](../../docs/eval/01_Flowmate_Agent评测总方案_v1.md#eval01-trial-aggregation)规定两层职责和待实现逻辑输出。阶段一复用现有aggregate/报告设施版本化接合，绑定Case/冻结/评分身份、来源Trial及逐指标分子/分母/缺失，不另建评分服务、Case最好一次或平均总分。

各Trial等价初态/独立可写实例与同Trial恢复保留事实要分别验证；生产未就绪不能认领真实隔离通过。不同Execution默认独立报告/比较，A–D各自统计；Trace稳定身份包含Execution，补传不增加Trial或模型调用。完整repeat=1、两个Smoke Execution及每组留出repeat=3的既定规模/预算不变。

研究阶段一复用[现有研究操作](../../packages/contracts/src/research-commands.ts)，接合版本化本地材料／精确确认／调查与分页采证，制作12／4和独立Claim／证据链Gold。SourceSnapshot完整保存、首段4000 UTF-16字符及续读、后续请求／采用分别取证，Gold只要求本题允许材料支持的结论，Report新增事实同样核验。DR01–06及原33项由本地算分，产品full／supported不替代独立结果；每Trial一次Judge／256／无重试不变。原业务Full12800、研究Full3072，事前分别Execution累计15872，单Execution15000；校准／先导／复测另登记，Agent／Judge真实费用及未知保留，当前搜索未发生／不适用。研究Dataset和配置目标未创建，严格v1不接受未来字段。
