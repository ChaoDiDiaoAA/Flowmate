# 评测源码职责

修订：2026-09-23。业务 Dataset 尚未制作；完整 Agent 实现、真实入口与必要采证接通、工程验证通过后才依据 01/02 制作。

统一 Runner 对应任务编排，不是另建 Agent Runtime。所有实现均在 src；当前生产接入明确未实现，不允许 Provider 直调替代 Agent。

|目录/文件|职责|
|---|---|
|cli.ts|校验、运行、查询、比较、反馈及显式导出入口|
|datasets/local.ts|严格 Case/清单契约、按需材料/Gold、材料 hash、输入投影、Smoke 引用|
|execution/runner.ts|冻结成员/源码/数据/预算，编排独立 Trial，保存完整计划|
|execution/execute-case.ts|准备、执行、取消、快照、真实清理、身份校验和脱敏|
|adapters/agent.ts|AgentKernel/Session 窄接口；生产 productAgent 当前不可用|
|scoring/types.ts|EvaluatorKind、Context、Definition、Score；仅 deterministic / llm-judge|
|scoring/registry.ts、evaluate.ts|注册与去重，整条任务结束后按适用性和证据评分|
|scoring/evaluators/|每项独立文件；只读已采证事实，不进行产品操作|
|scoring/judges/|独立模型配置、Rubric、结构化请求及失败记录|
|scoring/aggregate.ts|硬失败优先、五态与未知，避免平均分掩盖失败|
|reports/|权威本地记录、兼容性比较及状态汇总|
|review/|真实人工主动反馈，与自动评分独立|
|langfuse/|按需加载 SDK、显式轨迹/分数导出及人工同步|

触发边界：整个 Trial completed 且到达终点 → 适用确定性规则；Judge 还要求独立合法配置、选中、证据齐全及冻结预算。失败、超时、中止、未启动不执行质量评分。缺证据是不可判定，不是“不适用”。Judge 不由确定性分数触发；人工没有自动阈值。

AgentKernel.prepare 只收到当前输入、受控 setup/steps、身份和配置，不接收 expected/Gold。适配器必须按实际交互逐次投递、从公开产品入口取证，并在最后一步后才标 endpointReached。setup.resources 是按正常资源入口装载的受控内容，不是提前创建的产品 Skill 服务。

candidate-record、tool-records、history-binding、export-readback 等 key 是待实现的采证契约，必须指向真实对象、原始值、事件和文件，不接受模型自报布尔值。fact-check v2 只比较已有证据：equals、includes 或 compareTo；后者任一端缺失或为未知 null 都不可判定，不能用两端都缺数据获得 PASS。常量 equals:null 仅用于事前明确的未知字段状态。当前没有完整产品采证实现，不能把通用比较器当领域采证器交付。

reference 可省略；字段/明细评分仍要求对应参考。Judge Rubric v4 读取成功/失败标准以及实际交互和结果，标准只进入评分侧，不送给被测 Agent，也不能让 Judge 证明数据库或文件事实。

清单 judges.requiredFor 只声明现有 Judge 对哪些任务必要，不新增调用。Loader 校验引用；Runner 根据选集预检 auto 配置，off 保留必要未测项；汇总不得判 PASS。此规则与确定性分数无关。

Session.input 返回受控准备后的真实可见输入；控制器在调用模型前保存 input.json，保留原始来源、变体及 hash，评分对照冻结的实际投影。没有 setup 的初始输入改写、未登记材料、秘密或提前取消均在模型执行前拒绝。

后续接入前：实现受控环境注册与产品采证、证据身份和来源、必要指标独立计算、原始/接受候选区分、真实停止/清理。prepare/close 有界；清理未确认停止剩余 Trial。多轮的 interaction-history 只保存实际投递历史，未来消息不能提前用于 Judge。

输出名称在 langfuse/export.ts；评分名称/版本在各评分文件，Dataset 身份在 dataset.json。environment 由运行配置优先，随后 FLOWMATE_EVAL_ENVIRONMENT，默认 development；密钥与 Provider 模型不硬编码。无 Langfuse 时全部本地工作。

[操作手册](../README.md) · [评分设计](../../docs/eval/01_Flowmate_Agent评测总方案_v1.md)


工程验证统一由根 typecheck、test:unit、test:integration 和 test:e2e 入口执行，`test` 顺序组合。设施测试按源码模块保存在 [tests](../tests/README.md)，用独立最小合成数据；不依赖业务 Dataset，零 Dataset 时仍可验证。数据制作细节以 [02](../../docs/eval/02_Flowmate_Agent评测数据集制作方案_v1.md) 为准，当前不制作业务 Case、Gold 或成员清单。

`../datasets/` 保存任务数据（当前只有 README），`src/datasets/` 保存加载与校验代码；`../tests/fixtures/` 是独立工程材料。`../runs/` 按实际运行生成并保留既有证据。完整目录见 [操作手册](../README.md)，未来数据目录在满足制作条件后才创建，不预建空资产。
