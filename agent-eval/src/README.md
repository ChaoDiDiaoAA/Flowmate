# 评测源码职责

修订：2026-10-02（撤回提前实现的Runtime评测增量）。所有正式Case/Gold制作、真实开发及必要Judge校准、Smoke/留出/四组质量运行统一等完整P1–P16、公共入口、必要采证及工程就绪，沿01§12.1。本轮Runtime24条Case/清单/Gold审核草稿/四组配置已删除，不归档、不改名为夹具；新增产品Adapter/v2/holdout/故障/校准增量及专属测试已撤回。

原通用Runner负责设施编排，不另建Agent Runtime。当前 `adapters/agent.ts` 中的 `productAgent.readiness=false`、`prepare` 拒绝；T15/T16 延期到完整产品门槛后。配置/密钥齐全、空requires、支持子集或draft均不能提前使用生产Agent评测入口。

|目录/文件|职责|
|---|---|
|cli.ts|原校验、运行、查询、比较、反馈及显式导出入口；选集smoke/full|
|datasets/local.ts|原严格v1 Case/清单契约、按需材料/Gold、hash及输入投影|
|execution/runner.ts|原通用冻结、编排、预算、报告和独立Trial|
|execution/execute-case.ts|原准备、执行、取消、快照、清理、身份校验和脱敏|
|adapters/agent.ts|Kernel/Session窄接口；生产productAgent未就绪并拒绝执行|
|scoring/types.ts|EvaluatorKind/Context/Definition/Score，deterministic与llm-judge|
|scoring/registry.ts、evaluate.ts|原注册/去重，任务终点后按适用性和证据评分|
|scoring/evaluators/|原独立确定性评分器，只读已采证事实|
|scoring/judges/|原独立模型配置、Rubric、结构化请求和失败记录|
|scoring/aggregate.ts|必要失败优先、五态与未知|
|reports/、review/、langfuse/|原本地报告、真实人工反馈及可选导出，不重跑产品|

原质量评分只在整个Trial completed且到达终点后按适用性和证据触发；Judge另需选中、独立合法配置及冻结预算。失败、超时、中止、未启动不执行质量Judge；缺证据不可判定，不补零分或忽略，不以确定性分数触发Judge。原报告只读，不能用新判据重解释旧成绩。

AgentKernel.prepare只接收当前可见输入、受控setup/steps、身份和配置，不接收expected/Gold或未来消息。未来适配必须逐次从真实公共入口投递与采证，最后一步才标endpointReached；不能用Provider直调、模型自报布尔值或SQL造成功事实。input.json保存真实准备后的输入与来源/hash；未知材料、秘密或未登记初始改写在模型调用前拒绝。

candidate-record、tool-records、history-binding、export-readback等为待实现领域采证契约，必须指向真实对象、原始值、事件或文件。通用fact-check仅比较已有证据；任一端缺失/未知不能PASS。Gold、未来脚本和核验管理信息留质量侧；评分字段存在不证明产品采证接通。

T15/T16完整产品后复用既有接口接通Application/Session/Runtime/Pi/Executor/SQLite、实际停止和必要保存，再实施严格v2/v1兼容、holdout、注册故障、预算策略、校准引用及过程报告。独立最小合成夹具验证设施，不恢复已删正式数据。所有终态过程与Case预期分列，安全停止不变造completed，无模型解释则诊断理解/主动停止未测；原质量Judge触发条件保留。

未来采证区分raw登记、SDK prepare/before、Host before最终检查、实际execute/领域提交、Host after、固定终态/观察事务、SDK after及历史/delivery。SDK immediate无execute/after；Host内部拒绝虽SDK after发生，实际业务execute/Host after/耗时仍未发生。产品固定事实不因后续反馈错误改写，未知提交/停止不重投、不执行补证，不增加统计/记忆表或第二套Loop。

T17当前仅验产品Runtime T10–T14工程，不依赖延期评测实现或正式数据。T18须完整产品门槛、工程及评测设施通过，再正式制作→独立核验→真实开发/必要Judge校准→冻结→质量对照。Runtime24/8/16、四组A–D及真实快照/hash/cutoff均为待实施计划；null不解锁整体门槛，不足回退不自动付费补20，留出不反哺。

根typecheck、test:unit、test:integration和test:e2e仍负责原通用设施与产品工程，见 [测试说明](../tests/README.md)。原独立工程夹具保留，本轮Runtime数据依赖的专属测试与支持文件撤回；已删除数据不得归档或改名移作fixture。工程通过不形成Agent质量结论。

`../datasets/`当前仅制作说明，无业务Case/Gold/配置/校准资产；`src/datasets/`保留原加载代码，`../runs/`保留独立历史记录。正式制作规则见 [02](../../docs/eval/02_Flowmate_Agent评测数据集制作方案_v1.md)，完整目录见 [操作手册](../README.md)。
