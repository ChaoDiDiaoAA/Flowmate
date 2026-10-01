# Flowmate 领域词汇

当前设计以 [产品主方案](docs/spec/00_Flowmate完整方案_v1.md)、[评测主方案](docs/eval/01_Flowmate_Agent评测总方案_v1.md)和[数据制作方案](docs/eval/02_Flowmate_Agent评测数据集制作方案_v1.md)为准。路线是 Agent Engineering + Invoice Product + Agent Evaluation；核心为 Agent Harness / Runtime，不以完整企业后台为目标。当前工作区已有 P3 工具/最小原生历史和 P4 Messages 工程能力，后续阶段按首次交付边界实施。P3 唯一正式发票输入目录为 `data/invoices/agent-input/`，业务取证读取已登记解析、候选来源仍按其版本/引用核验；普通 Run 的 SDK read 支持文本/图像，图像向模型交付仍核验 model.input，不能把“原图仅 UI 查看”的 P3 业务历史限制泛化成 SDK 无图像能力。旧连接的真实模型 A20 请求、失败/复验和样例观察已记录，新配置的连接/认证/协议兼容性按 P3 实施计划中的实际工程证据解释。模型行为和业务质量统一归评测主方案 §12，P16及整体产品、真实 Agent 入口与必要采证就绪且工程通过后才制作和运行 Benchmark，不作为当前阶段完成条件。

2026-09-30 P4 实施状态：当前工作区已接入三具名消息视图及严格 schema、原生历史公共查询、008 原生条目 run_id 归属、逐消息完整快照归并与成功保存身份桥；`runtime-pi/messages.ts` 统一原生校验、prompt 格式化和 `projectMessageView` 白名单投影。必要历史失败保留最后已提交前缀并阻断续用。本次 Unit、Integration、标准 Electron E2E、typecheck 及桌面构建工程门禁通过，命令、数量与限制见 [P4 实施计划 §4.3](docs/plans/P4_实施计划_v1.md)；P3 历史数字、真实模型证据和 Benchmark readiness 不由此更新。

2026-10-01 文档同步基线：HEAD `b92c3e89a7ac42ad68f4c6d9cf89fd6f5de7ae2e` 及包含既有未提交差异的工作区，实际 Pi 包为 `@earendil-works/pi-ai`、`@earendil-works/pi-agent-core`、`@earendil-works/pi-coding-agent` 0.85.1。此前同步只核词汇/阶段责任；随后按 P4 未完成项续行实际接合 P14 Fill、原调用应用回执、人工保存/Accept/三格式导出及必要 P5 输入子集，新增工程证据见 [P4 实施计划 §5](docs/plans/P4_实施计划_v1.md)，普通原生工具和终态收尾证据仍分别见 [P1 实施计划 §11.7/§11.8](docs/plans/P1_实施计划_v1.md)。本轮不追认原 P4 首次交付或历史数字；其余未实现工程能力按所属阶段交付。真实模型录入行为和业务质量统一归评测主方案 §12整体启用后的评测，不另设阶段质量任务，也不依赖用户临时排除。

| 词汇 | 定义与边界 |
|---|---|
| Application Core | 薄产品入口与协调，连接 Runtime、Session、存储与发票服务；不重写 Pi Loop |
| Runtime / Harness | Runtime 执行真实模型/工具循环；Harness 接合输入、上下文、资源、范围、停止、保存与验证 |
| Job | 一项发票用户任务，保留必要输入、候选及进度，不是复杂 Workflow |
| Run | Runtime/Run Repository 负责 created/running/completed/failed/cancelled；停止意图不是第六个持久状态，终态不复活；实际停止/必要保存各自核验，显式重试或恢复创建新 Run |
| Session | SessionService 负责 active/archived 与历史归属；可用性/模型资格分别核验，不复制 Run 五态，完整历史不等于一次 Run |
| Session Input | P5 SessionService 维护投递/消费与处理两组事实；当前只接空闲 prompt/fill-form 子集，009以Session/clientSequence及完整请求hash查回原input/Run，异请求冲突。真实user条目与消费同事务，Run收口/启动修正关联处理结果；consumed不退queued，delivery_unknown先查证不重投。完整队列/Steer/Follow Up/归档仍待P5 |
| Messages 四层 | 完整 SessionEntry/header/parent/leaf、当前 AgentMessage[]、实际模型兼容 Message[] 与产品 UI 投影分别承担历史、工作记忆、请求和展示职责 |
| SDK Message | `@earendil-works/pi-ai@0.85.1` 的 UserMessage/AssistantMessage/ToolResultMessage 三分支联合；systemPrompt、tools 和模型参数独立装配，没有 SystemMessage 角色 |
| SDK UserMessage | SDK 用户输入，文本或 TextContent/ImageContent；当前产品用户图像输入入口未开放，不能由 SDK 类型反推可上传。普通工具 read 图像结果另按 model.input 核验，角色本身不授权资料 |
| SDK AssistantMessage | SDK 模型输出，TextContent/ThinkingContent/ToolCall、stopReason/usage 及原生协议字段；无文本工具调用合法，UI 不展示隐藏思考 |
| SDK ToolResultMessage | SDK 工具回送消息，原生 toolCallId/toolName/content/details/isError 与原调用关联；不等于产品 ToolResult 封套或 ToolCall 数据库行 |
| SDK AgentMessage | pi-agent-core 的当前工作记忆联合，包含标准 Message 及经扩展机制注册的消息；不等于完整 SessionEntry 或 UI 视图 |
| SDK CustomAgentMessages | pi-agent-core 的类型扩展机制；接口可扩展不表示 Flowmate 已定义/启用业务消息 |
| SDK CustomMessage | pi-coding-agent 提供的 customType/content/details/display 容器，实际扩展业务载荷须另定义；custom.display 不等于上下文排除或资料授权 |
| SDK BashExecutionMessage | coding-agent 的 bashExecution 消息；普通 SDK bash/powershell 工具走标准 toolResult，不开放独立用户 Shell/executeBash 入口 |
| SDK BranchSummaryMessage | coding-agent 组织上下文时产生的分支摘要消息，与原生分支摘要历史条目区分；P9 按实际开放能力核验，不是 Flowmate 新角色 |
| SDK CompactionSummaryMessage | coding-agent 组织上下文时产生的压缩摘要消息，与原生 CompactionEntry 区分；P10 核执行/保存/续用，不是 Flowmate 新角色 |
| Native SessionEntry | header、entryId/parentId/leaf 路径及原生消息/设置/摘要条目；CustomEntry 是元数据，CustomMessageEntry 是可组织入上下文的消息条目，不能互换 |
| Flowmate 自定义原生消息 | 当前代码没有产品专属原生角色/业务 customType/载荷；P4 取舍后不新增，沿标准 user 与真实 toolResult 路径；未来确有独立业务语义时随所属阶段评估 |
| UI Message Projection | P4 已接入 MessageDisplayBlock、三具名 SessionMessageView 分支和 SessionMessagesPage；共享 projectMessageView 生成白名单查询/IPC 投影，不进入模型；生成 phase 与保存 persistence 分开 |
| SessionUserMessageView | Flowmate role=user，text blocks、ended、product-input/native-content 来源；保存反馈及真实条目关联共用产品契约 |
| SessionAssistantMessageView | Flowmate role=assistant，text/真实 toolCall 引用、streaming/ended 与 SDK stopReason；不跨 IPC 传 thinking、执行函数或任意原生对象 |
| SessionToolResultMessageView | Flowmate role=toolResult，受控摘要 text、真实 toolCallId/toolName、boolean isError、ended；不以工具进度替代原生结果 |
| MessageTextBlock / MessageToolCallBlock | Flowmate 展示文本与真实工具引用，组成 MessageDisplayBlock；SessionMessageView 三分支/页面/事件共用 strict schema，Renderer 不重复定义字段 |
| Live Message Identity | P4 的 Run 内 liveOrdinal 与真实 entryId 归并；Host 已加载 native Session 在成功保存后保留 entry→Run/ordinal，Run 终态不清、release/重启清；查询仍核验 SQLite 正文/关联，不按内容或时间猜身份 |
| Temporary Sequence / Durable Cursor | P4 sequence 仅当前进程临时顺序，按每消息 `(sessionId,runId,liveOrdinal)` 比较；不同消息不可用全 Run 水位丢弃。P6 持久 `(runId,sequence)` 才去重/补读，cursor 是实际收到并按序连续交付的持久前缀末端，不是最高 seen；seq=2 先到不能跨过缺失的 seq=1。临时快照/文本/日志不推进 cursor，不作恢复来源或平台稳定 ID |
| ContextSnapshot | 某次请求使用的任务事实与来源快照；后续新快照不能改写历史依据 |
| Memory | 原生 header/entries/parent/leaf 的持久化与使用；不增加跨任务知识库 |
| Compaction | Pi 原生历史压缩；工程核真实触发、保存、容量、合法续用及请求包含；摘要保真和事实正确使用效果在完整产品后统一评测 |
| Tool Call | SDK ToolCall 内容块是调用请求；产品 ToolCall 行由 Executor/Recorder/仓储维护 requested/running/succeeded/failed/cancelled。真实身份映射，不按文本或时间猜；同身份同参不二次执行、异参拒绝，终态冲突不改原事实 |
| Product ToolResult | Flowmate 输出/错误封套，经 Adapter 转为 SDK 原生返回再由 Pi 形成 ToolResultMessage；业务 COMMIT、调用终态、回送、后续实际请求包含分别证明 |
| Tool Delivery | not_attempted/message_observed/request_observed/failed/unknown 与 ToolCall 执行终态分别确认；回送失败/未知不撤销已提交候选或改写执行成功 |
| Tool / AgentTool / ToolDefinition | 按主方案三层契约接合 SDK 描述/执行与产品展示及可信 ProductToolContext；ToolExecutor 是唯一业务执行入口，登记准入和调用事实 |
| ToolExecutionMode | 工具声明的 parallel/sequential 调度属性；Pi 调度，P3 为 12 个并行读取/纯计算工具和 1 个串行候选保存工具 |
| Invoice Tool Set | 普通复核工厂保留13项；有可信桌面invoiceFormBridge才追加fill_invoice_form，发票目录14项，原生8项另计21/22名称目录；目录不是单Run暴露/调用数。Fill新Run只暴露fill工具，普通startRun仍拒绝fill-form |
| Invoice Form Application | P14实际内存应用与候选保存/Accept分事实；真实applied/not_applied/unknown由原Run/ToolCall及固定实例/revision关联，Recorder独立保存formApplication。仅candidateId/candidateSequence/applied安全O进入原生回送，目标/草稿不进messages。unknown纯query，真实迟到补证不重apply、不复活核心Tool/Run终态 |
| RunScope | 工具及资料允许范围，来自可信产品控制；子范围不得大于父范围 |
| Model access revocation | 对已使用指定材料的 Session 持久禁用后续模型调用；本地历史仍可查看，显式新 Session 才能用当前授权继续 |
| Invoice Candidate | 不可变发票字段/明细/来源/问题候选；010保留旧model身份，human_edit依据同Job已有候选、Run/ToolCall双空。实际差异由可信人工命令追加新版本/当前指针/revision/Activity；无差异无新版本，Save不等于Accept；原操作查询纯读，不按后来现场改原事实 |
| Accepted Candidate | 用户接受的指定候选；接受是产品事实，不自动证明 Gold 正确性 |
| Artifact | 受控文件产物，以整数 ID 和实际内容/路径关联，不使用自定义摘要身份 |
| Prompt / Skill | 作者行为指导及原生发现/读取资源；阶段工程核固定版本、选用、装配、读取和请求证据，模型遵循效果在完整产品后统一评测 |
| Extension | P12 复用 Pi 扩展/Hook，是受信代码；实例 loading/active/load_failed/disposed 与 enabled 配置分开，结束实例不复活，新装配创建新实例，不是操作系统沙箱 |
| State Transition | 按具体对象定义当前状态、真实触发、前置条件、负责人、动作、新状态和保存边界；Run/ToolCall/Delivery、P4 生成/保存、P5 投递/处理、P10 压缩、P12 实例、P13 子执行各自冻结必要合法/拒绝边，不合成统一消息状态机 |
| Subagent | P13 主 LLM 经插件工具发起只读子任务；子复用 Run 五态、独立原生 Session/历史，父子身份/范围绑定，返回/父回送/父采用及停止各自取证 |
| userData | 操作系统/Electron 标准应用数据根；正式 DB 只有 data/app.sqlite |
| Case / expected | 质量场景及预期约束，采用 input + expected；expected 不发送模型 |
| Gold | 经核验的领域真值，独立于模型候选和用户接受，留质量侧 |
| Trial | 一个独立评测尝试，可含多个 Run/恢复/子任务；专用 trial-序号.sqlite，不是正式库副本 |
| F / A / B | 机制、真实 Agent 行为、发票结果三类判断，不能互相替代；阶段以工程机制和实际业务链验收，自主行为及领域质量按评测主方案 §12统一启用 |
| Fixture / Live | 受控测试与真实运行方式，不等同 F/A/B 或来源类别 |
| Benchmark / Baseline | 前者固定测试定义，后者是指定组合实际执行后的参照成绩；均在完整产品、真实入口/采证及工程就绪后依评测主方案 §12启用，不设阶段 Dataset/质量成绩 |

数据库持久化、历史恢复、错误、取消和质量隔离是核心工程内容。业务终点为候选、人工修正/接受、导出；不包含审批、B2B 写入、组织权限、预算账本或生产治理。

P4 消息快照/权威查询由局部 applyMessageUpsert/mergeSavedHistory 接合：同消息较旧、重复、冲突、ended/saved 后回退及终态迟到分别处理，低序号 run_finished 仍接收；旧 Run 不清新 Run 的 busy/草稿。断流、缺号、saved 丢失先查询消息/Session/Run，同选中 Session 合并在途刷新，失败保留内容与错误，零 prompt/工具重放。P4 的临时接收与 P6 的持久补读分别验收，不新增通用消息状态机或事件框架。

原生双表正文为权威，storage_version=1 是格式版本，008 nullable run_id 仅保存真实归属，旧行不猜测回填。当前迁移链至010：009是必要P5空闲Fill输入台账，不是第二份UI消息正文或P6事件；010是人工候选/业务活动/导出兼容，原历史DDL不改。完整历史/P9、压缩/P10、快照/P8、扩展/P12、子执行/P13仍按所属阶段开放；P14当前工程接合与统一质量结论分开记录，模型录入行为和业务正确性只在评测主方案 §12整体启用后验证，不是P4/P14剩余任务。消息生成、必要保存、Run完成、Job接受及Host实际停止互不替代，模型自述与气泡不能推进业务状态。只读查询、诊断和平台反馈不新增状态、不回灌模型、不重放副作用。
