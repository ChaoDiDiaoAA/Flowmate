# Flowmate 领域词汇

当前设计以 [产品主方案](docs/spec/00_Flowmate完整方案_v1.md)、[评测主方案](docs/eval/01_Flowmate_Agent评测总方案_v1.md)和[数据制作方案](docs/eval/02_Flowmate_Agent评测数据集制作方案_v1.md)为准。路线是 Agent Engineering + Invoice Product + Agent Evaluation；核心为 Agent Harness / Runtime，不以完整企业后台为目标。当前工作区已实现 P3 工程能力；P3 唯一正式发票输入目录为 `data/invoices/agent-input/`，Agent 只读取既有解析，原图仅供 UI 查看。旧连接的真实模型 A20 行为证据已记录；新模型配置和正式业务 Benchmark 尚需单独核验，详见 P3 实施计划。

| 词汇 | 定义与边界 |
|---|---|
| Application Core | 薄产品入口与协调，连接 Runtime、Session、存储与发票服务；不重写 Pi Loop |
| Runtime / Harness | Runtime 执行真实模型/工具循环；Harness 接合输入、上下文、资源、范围、停止、保存与验证 |
| Job | 一项发票用户任务，保留必要输入、候选及进度，不是复杂 Workflow |
| Run | 一次实际执行，created/running/completed/failed/cancelled；重试或恢复创建新 Run |
| Session | 多轮与原生历史归属，active/archived；完整历史可保存恢复，不等于一次 Run |
| Session Input | 用户提交及投递/消费/处理关联；受理不代表模型已经消费 |
| Messages 四层 | 完整 SessionEntry/header/parent/leaf、当前 AgentMessage[]、实际模型兼容 Message[] 与产品 UI 投影分别承担历史、工作记忆、请求和展示职责 |
| SDK Message | Pi 0.85.1 pi-ai 的 user/assistant/toolResult 三角色联合类型；systemPrompt、tools 和模型参数独立装配，没有 SystemMessage 角色 |
| SDK CustomMessage / 摘要 | pi-coding-agent 提供的消息扩展；容器、摘要或角色类型存在不表示产品入口已启用，custom.display 不等于上下文排除或资料授权 |
| Flowmate 自定义原生消息 | 当前代码没有产品专属原生角色/业务 customType/载荷；P4 取舍后不新增，沿标准 user 与真实 toolResult 路径；未来确有独立业务语义时随所属阶段评估 |
| UI Message Projection | P4 待实施的 MessageDisplayBlock、SessionMessageView、SessionMessagesPage；白名单查询/IPC 投影，不进入模型；生成 phase 与保存 persistence 分开 |
| Live Message Identity | P4 的 Run 内 liveOrdinal 与真实 entryId 归并；Host 已加载 native Session 在成功保存后保留 entry→Run/ordinal，Run 终态不清、release/重启清；查询仍核验 SQLite 正文/关联，不按内容或时间猜身份 |
| Temporary Sequence / Durable Cursor | P4 事件 sequence 仅当前进程临时顺序，按每消息比较；P6 持久事件 sequence/cursor 才用于补读。liveOrdinal/临时序号不作恢复来源或平台稳定 ID |
| ContextSnapshot | 某次请求使用的任务事实与来源快照；后续新快照不能改写历史依据 |
| Memory | 原生 header/entries/parent/leaf 的持久化与使用；不增加跨任务知识库 |
| Compaction | Pi 原生历史压缩；真实触发、保存和后续事实使用分别验证 |
| Tool Call | requested/running/succeeded/failed/cancelled；拒绝以 failed 加原因表达 |
| Tool Delivery | not_attempted/message_observed/request_observed/failed/unknown 与 ToolCall 执行终态分别确认；回送失败/未知不撤销已提交候选或改写执行成功 |
| Tool / AgentTool / ToolDefinition | 按主方案三层契约接合 SDK 描述/执行与产品展示及可信 ProductToolContext；ToolExecutor 是唯一业务执行入口，登记准入和调用事实 |
| ToolExecutionMode | 工具声明的 parallel/sequential 调度属性；Pi 调度，P3 为 12 个并行读取/纯计算工具和 1 个串行候选保存工具 |
| RunScope | 工具及资料允许范围，来自可信产品控制；子范围不得大于父范围 |
| Model access revocation | 对已使用指定材料的 Session 持久禁用后续模型调用；本地历史仍可查看，显式新 Session 才能用当前授权继续 |
| Invoice Candidate | 不可变发票字段/明细/来源/问题候选；人工编辑生成新候选 |
| Accepted Candidate | 用户接受的指定候选；接受是产品事实，不自动证明 Gold 正确性 |
| Artifact | 受控文件产物，以整数 ID 和实际内容/路径关联，不使用自定义摘要身份 |
| Prompt / Skill | 作者行为指导及原生发现/读取资源；选用、读取、遵循分别核验 |
| Extension | Pi 原生可执行扩展/Hook，是受信代码，不是操作系统沙箱 |
| State Transition | 按具体对象定义当前状态、真实触发、前置条件、负责人、动作、新状态和保存边界；Run/ToolCall/Delivery、P4 生成/保存、P5 投递/处理、P10 压缩、P12 实例、P13 子执行各自冻结必要合法/拒绝边，不合成统一消息状态机 |
| Subagent | 主 LLM 通过插件工具发起的只读子任务；独立原生 Session，绑定父子产品身份，范围收窄 |
| userData | 操作系统/Electron 标准应用数据根；正式 DB 只有 data/app.sqlite |
| Case / expected | 质量场景及预期约束，采用 input + expected；expected 不发送模型 |
| Gold | 经核验的领域真值，独立于模型候选和用户接受，留质量侧 |
| Trial | 一个独立评测尝试，可含多个 Run/恢复/子任务；专用 trial-序号.sqlite，不是正式库副本 |
| F / A / B | 机制、真实 Agent 行为、发票结果三类判断，不能互相替代 |
| Fixture / Live | 受控测试与真实运行方式，不等同 F/A/B 或来源类别 |
| Benchmark / Baseline | 前者固定测试定义，后者是指定组合实际执行后的参照成绩 |

数据库持久化、历史恢复、错误、取消和质量隔离是核心工程内容。业务终点为候选、人工修正/接受、导出；不包含审批、B2B 写入、组织权限、预算账本或生产治理。
