# P0 Agent 评测实施方案

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 对 P0 实际采用的 Pi Runtime、Flowmate 集成和真实字段抽取建立可重复的质量验证，交付种子 Case/Gold、模块报告、问题归因和绑定固定候选的 P0 质量结论。

**Architecture:** 复用产品运行入口、实际 Pi 原生测试驱动和功能 F 报告；评测侧实现资产清单、顺序 Trial 调度、代码 Grader、人工复核与报告。Gold 与评分材料保存在独立质量数据根，产品只接收受控输入与允许动作。

**Tech Stack:** 复用项目 TypeScript、Zod、Vitest 和 Bun 工具链；P0 用受控 JSON/JSONL、CSV 制作表和 Markdown 报告，不新增服务或管理后台，不默认启用模型裁判。

**Spec:** [Agent 评测总方案](../spec/01_Flowmate_Agent评测总方案.md)、[P0 目标方案](../../../docs/spec/P0_目标方案.md)、[P0 产品实施计划](../../../docs/plans/P0_实施计划.md)。

更新日期：2026-09-13。状态：方案已编写；用例编号、配额、评分器、命令均为实施约定，尚未完成资产制作、编码或实际评测。产品任务编号 T01–T16 来自 P0 产品实施计划；本方案评测任务编号为 E01–E10。

**本阶段唯一委派链路：** 父 Provider → 实际 Pi Loop → 插件原生 `Agent` 工具（Flowmate tool_call Hook 校验）→ 实际子 Session → 受控工具 → 原生前台结果 → 父循环。P0 固定 run_in_background=false；Adapter 只记录与取消，不创建/自动重试。Runner 不调用 subagents:rpc:spawn 或 manager.spawn；底层单测不能替代本阶段整链 F。现有 37 个 Runtime 场景族保留编号，新增边界作为相应 SUB/EXT/工具案例变体，不通过删除原用例降低覆盖。

## 1. 目标、范围和唯一责任

### 1.1 本阶段要得到什么结论

P0 回答三个问题：实际 Pi 基座的已启用机制是否按契约工作；Flowmate 是否正确连接并控制这些机制；真实主模型能否从当前获准的解析输入取证、输出字段候选并留下可核验结果。另行核验一份新原图的 Parser 兼容结果，以及选定 `tintinweb/pi-subagents` 的真实子会话与工具绑定。

本阶段得到的是开发种子集上的技术与质量基线。P1 才评完整复核/审批/本地模拟提交链和真实子模型业务核查；P2 起补企业契约，P3 深化独立 Host、长程与故障。P0 不报告企业准确率达标、生产 STP、07B2B/ERP 提交成功率或多 Agent 业务收益。

必须同时交付：

- 按 12 类功能模块整理的 Runtime 支持、启用、实现、运行和机制触发表。
- 数据来源/角色、种子 Case、人工 Gold、原生 Oracle 和版本化 Benchmark 清单。
- 实际 Pi 原生 F、Flowmate 集成 F、主模型 A 三种可区分的证据。
- Parser 局部结果、Node 与 Electron 中实际子 Pi 结果及清理事实。
- 首次/重复结果、覆盖与分母、Good/Bad 核验记录、失败归因和 P1 交接。

### 1.2 全局约束

- “实际被测 Pi、扩展、插件及子会话不能被 Mock。”受控 Provider 可替代模型响应，不能替代 Session、Loop 或子会话本身。
- “SDK 类型不穿透到 UI/领域核心”。原生测试驱动可直接调用 SDK；评测运行器不另造 Agent Loop。
- “参考标注、Gold、Grader 与其他 Trial 产物只供独立质量侧访问。”工具读取的输入投影不包含这些内容。
- 首次 Test 运行不要求已有质量通过结论；依赖、权限、输入与预算预检必须通过。
- “同时最多一个子执行、深度 1、一次性会话”。子会话 P0 用合成材料和受控 Provider；不提前启用命名续聊、并行或真实子模型业务链。
- 每个功能可运行后即可局部评测；Case/Gold 和 Oracle 可以提前准备，不等整阶段编码完成。
- 预设故障、非法请求和预算耗尽是被测场景；按预期正确拒绝可以 PASS，不计为评测设施故障。
- F 的全部通过不能代替 A 的真实效果；有正确模型输出也不能掩盖越权、结果错绑或未清理进程。

### 1.3 产品与评测分别实现什么

| 对象 | 唯一实现方 | 本方案如何使用 |
|---|---|---|
| Pi、Gateway、Kernel、Context、Parser、扩展/子 Pi、UI | 产品 T01–T14 | 使用真实接口，不为评测写替代业务链 |
| 产品 F、原生测试驱动、受控 Provider、故障屏障和清理 | 产品对应任务 | 评测给出 Case/Oracle；报告同版本/配置/断言有效则直接复用，缺项回产品补测试 |
| Case/Gold/Oracle/Rubric、分组和池记录 | E01/E02/E08 | 以明确来源和核验记录冻结；不复制提供方标签当 Gold |
| EvalRun/EvalTrial、预检、顺序调度与评分 | E03–E07 | 调用产品或原生测试驱动；只管理自己创建的测试资源 |
| Grader/Runner/报告设施的自测 | E03–E06 | 用已知正、错、缺证据夹具，不能算员工 A/B 成绩 |
| 质量结论 | E09 | 固定候选、Benchmark/Gold/Grader 和适用证据；不授予生产权限 |
| P0 联合退出 | 产品 T16 | 合并功能/质量/环境证据，缺必需项不得通过 |

产品 T15 提供 HandoffManifest；评测返回 Quality Decision。Runner 对集成 Trial 只调用 `Application.start/rebuild/cancel/getJob/getEvidence`，不直接改业务 SQLite，不 kill 产品进程，不删除 Pi 锁。原生驱动通过父 Session 的受控模型工具消息触发委派，并按自身清理接口结束实际合成 Session。

## 2. 评测模式与当前前置

### 2.1 模式按三个维度组合

功能模块、被测层和 F/A/B 是三个不同维度，不能互相替代。

| 模式 | 被测层与运行对象 | 本阶段证明内容 | 不可据此声称 |
|---|---|---|---|
| N-F 原生契约 | 实际 SDK Session/Loop、原生扩展或选定插件；受控 Provider、无副作用工具；不经过业务 Gateway | SDK/插件实际机制和合法调用契约 | Flowmate 业务权限或真实模型效果通过 |
| I-F 集成功能 | 实际 Application/Context/Gateway/Kernel、SDK、SQLite、必要子 Pi；受控 Provider/故障屏障 | 平台连接、身份、输入隔离、状态和清理 | 真实模型能稳定完成任务 |
| I-A 主模型行为 | 实际产品入口与主模型，已有解析输入、固定工具与候选 | 字段、事实使用、工具行为、证据与缺失/歧义处理 | 复核后结果属于 Agent 原始能力 |
| 局部 B Parser 结果 | 真正的新原图→实际 Parser→统一 ParsedDocument | 输入输出对应、内容可用性与独立的前置转换结果 | 完整业务链 B 或通用 OCR 准确率 |
| 设施 F | 评测资产/Runner/Grader/报告程序 | 评分与统计自身可信 | 被测 Agent 已通过 |

同一 Case 家族可有原生/集成变体，但其 scope 和 Oracle 分别登记。例如“工具不存在”原生断言 SDK 按锁定契约回报错误；集成断言无非法资产读取、无候选写入和有审计。不能把 Flowmate 的错误码强加给原生 Pi。

P0 的“完整链”仅指解析输入到候选接受和保存的最小通路。主模型 A 必须通过该通路运行，不能由评测脚本把 Gold 直接交给模型。原生 F、集成 F、A 的成绩分栏，避免一组 F 成功率掩盖 A 低质量。

### 2.2 当前依赖与范围固定

当前尚无 P0 产品实现。用户已指定来源根 `D:\obsidian\data\flowmate-data\Evidence\invoices\voxel51`，原始发票与已有解析保留原位。目录存在且已列举 000001 文件；数量、完整性、配对和可用范围以产品 T03/T04 的盘点与冻结报告为准。评测 Case/Gold 留在 agent-eval/data/p0，不将来源 annotation/fields 或其他答案元数据交给被测模型。已知的包候选版本不作为实际锁：以产品 T01 输出的 config/runtime-lock.json、发布包摘要、Node/Electron/插件适配和实际入口为准。

| 准备或执行 | 最早前置 | 不具备时的状态 |
|---|---|---|
| 合成 Case/Oracle 与评分规则 | 已确认的目标和公共字段定义 | 可以先制作并人工复核 |
| 真实 Case/Gold | 项目数据位置、原文/解析配对及允许用途 | `evidence_missing`，不照抄标签补齐 |
| 原生最小 F | T01/T08 的实际 SDK、Provider 与驱动 | `runtime_not_ready` |
| 工具/Context/Session 集成 F | 对应 T04–T10 可运行及证据出口 | `runtime_not_ready`，不能用数据库造结果 |
| 原生扩展/子 Pi | T11/T12，Electron 变体还需要 T14 | 分开记录 Node 就绪和桌面未就绪 |
| 主模型 A | T10/T15、已核验 Gold、输入和 Live Profile | `live_profile_missing` 或 `gold_not_ready` |
| Parser 实际结果 | T13、支持的新 JPG、Parser 条件 | `parser_not_ready` 或 `source_missing` |

这些状态是就绪台账，正式评分状态见 §7。依赖解决前可以完成 E01–E04 的独立部分，不能把未执行项计为 PASS。

## 3. P0 要评的功能模块与案例清单

每个编号是本方案的场景规格，实际 Case ID 在冻结时追加 `-N`/`-I`、变体和版本。下面的必需变体全部纳入覆盖分母；多 Benchmark 引用同一证据不重复计总次数。

### 3.1 Runtime 模块一：配置与模型

关联 RT-01/02、MOD-02/24/27，BM-11；配置/秘密边界同时引用 BM-08。产品 T01/T06/T08/T09。

| 场景 | 层与总方案映射 | 输入、触发与 Gold/Oracle | 必查证据 |
|---|---|---|---|
| P0-RT-CFG-01 固定配置 | N-F/I-F；RTC-01-01 | 合成默认配置与明确候选冲突；实际 model/tool/resource 以获准配置为准；运行时覆盖被拒绝 | 实际 Provider 请求、加载集合/摘要、候选 ID |
| P0-RT-CFG-02 配置失败 | N-F/I-F；RTC-01-02 | 缺模型、坏资源、不可写私有目录各一变体；明确失败，无静默替换、残留运行 | 初始化错误与清理记录；不能仅查 preflight 返回 |
| P0-RT-MDL-01 请求落地 | N-F/I-F；RTC-02-01 | 已知模型 ID/参数/输出限额到达 Provider；I-A 引用 §3.5 的实际模型 Trials | 原始请求摘要、最终配置、model/provider 身份 |
| P0-RT-MDL-02 认证边界 | N-F/I-F；RTC-02-02 | Pi 原生认证不可用时先拒绝；受控认证失败不换账号；合成 secret 不进入普通日志/Context/UI，不要求 Flowmate CredentialProfile | 请求计数、SDK 诊断与业务拒绝分开记录、脱敏检查；模拟 401 不称真实密钥失效试验 |
| P0-RT-MDL-03 用量未知 | N-F/I-F；RTC-02-05 最小 | 受控已知/缺失用量各一份；没有用量则 unknown，已知不重复累计；按固定 unknownUsagePolicy 继续或停止 | 各次请求、累计/未知字段、控制决定 |

#### 3.1.1 Provider 配置的必需变体与材料

2026-09-12 补充：沿用 P0-RT-CFG-01/02、P0-RT-MDL-01/02/03 编号，以下作为子变体登记，不改变原 37 个场景族和其他模块覆盖。产品实现归 T06/T08/T09，真实服务与主抽取归 T15；评测 E02 制作材料，E03 绑定 F，E07 在条件就绪后执行真实 A。

| 归属变体 | 制作人需准备的 Case/Oracle | 必查证据 |
|---|---|---|
| CFG-01：内置/自定义 | 一套内置模型配置、一套显式 modelsPath 的自定义配置、与其冲突的合成全局默认值；按锁定 Pi 契约事前固定预期 provider/modelId/api/baseUrl/参数及脱敏模型快照输入；内置配置不重复声明端点/能力，自定义只维护一份 Pi 原生定义 | 实际 Pi 有效模型和受控协议请求一致；全局值不覆盖候选 |
| CFG-01：入口/路径/环境 | 同一配置经 CLI、桌面、不同 cwd 解析；启动工具装载的进程变量与开发 `.env` 使用不同合成哨兵，并覆盖 Pi 原生认证来源优先级 | 相对路径以声明文件为准；进程环境优先；Pi 实际模型与候选一致，秘密不出现在快照/IPC/日志；不要求自研模型配置解析器，未知任意 MODEL_URL/MODEL_NAME 不得被假定为 Pi 原生参数 |
| CFG-02：未就绪 | 缺 Key 引用、坏 models 文件、认证来源冲突、未知 modelId、模型摘要变化、未获准样本各一变体 | 明确失败、网络请求为零；手填 available=true/hash 无法绕过校验 |
| MDL-01：协议与真实链路 | 夹具核验 Chat Completions 等实际启用协议；Live 用合成输入确认所选服务工具能力，再跑 §3.5 的真实解析样本 | F 请求/工具结果配对；Live 的实际服务/模型、Run/Session、候选和接受结果分列；连接成功不是 A 通过 |
| MDL-02：错误与隔离 | 401/403、429/5xx、超时/断流和原始错误带合成秘密的协议夹具；机器环境存在 Key 的默认测试 | 脱敏错误、无暗换模型/账号、无自动重试；默认测试零真实外网请求；异常和清理可关联 |
| MDL-03：用量 | 已知 token/价格、缺 usage、未知价格及中止后的响应夹具；预设 stop 或获准 continue-with-count-time 策略 | 真实请求计入预算，未知不填零，停止后的迟到响应不产生新业务结果；复用 T09 预算报告 |

预期请求由人工对照锁定 SDK 和已选服务协议核验；合成凭证只能用于本地夹具，不能向外部真实服务发送故意错误的秘密哨兵。厂商/模型/认证/数据未就绪时记录 Live 阻断，保持 F 可独立执行；禁止把配置文件存在、静态预检成功或固定响应抽取当作真实 A 成绩。

### 3.2 Runtime 模块二至六：循环、工具、记忆、Session、资源

**循环与消息：RT-03 / MOD-02，BM-11，产品 T08/T10。**

| 场景 | 层与映射 | 材料和触发 | 判定及证据 |
|---|---|---|---|
| P0-RT-LOOP-01 无工具结束 | N-F；RTC-03-01 | Provider 一次给完整文本 | 一次合法循环、无工具、原生终态；不据此认定候选完成 |
| P0-RT-LOOP-02 工具依赖 | N-F/I-F；RTC-03-02 | 读取输入返回 block ID，第二次取证需该 ID，随后提交 | 真实 Loop 回送结果；请求/结果 ID 对齐；A 在 §3.5 评分取证行为 |
| P0-RT-LOOP-03 不完整终止 | N-F/I-F；RTC-03-04 | 空响应、参数流中断各一变体 | 保留原始状态；半截调用不执行，产品无有效候选不能标 succeeded |

**工具：RT-04 / MOD-05，BM-11，权限变体引用 BM-08，产品 T07/T08。**

| 场景 | 层与映射 | 材料和触发 | 判定及证据 |
|---|---|---|---|
| P0-RT-TOOL-01 合法调用 | N-F/I-F；RTC-04-01 | 固定唯一 requestId、合法参数和可识别结果 | 真实工具执行、文本/结构结果回送；集成提交原始/接受候选分开 |
| P0-RT-TOOL-02 非法调用 | N-F/I-F；RTC-04-02 | 未注册工具、缺参数、类型错；失效版本仅 I-F | 原生按契约失败；集成无非法实际动作，错误与审计可关联 |
| P0-RT-TOOL-03 工具失败 | N-F/I-F；RTC-04-04/05 最小 | 工具抛错、受控超长结果各一变体 | 错误可回送；产品上限 256 KiB 的超限拒绝/产物记录有效，不声称完整取证 |

**记忆与上下文：RT-06 / MOD-03，BM-11，隔离引用 BM-08，产品 T06/T08，绑定清理复用 T09/T12。**

产品接入位置为 packages/runtime-pi/src/memory/{index,policy,history}.ts；对应 tests/runtime/memory/{policy,history}.test.ts。P0 必须记录独立 Memory 绑定、实际策略生效、主子历史来源和释放，不能只检查 core/context 的静态输出。以实际 Provider 请求确认可见事实，Pi 历史快照只作来源证据。原生驱动仍直接验证 Pi，产品集成驱动经过 Memory 模块；P1 才新增 compaction.ts 与压缩试验。

| 场景 | 层与映射 | 材料和触发 | 判定及证据 |
|---|---|---|---|
| P0-RT-MEM-01 当前事实可见 | I-F；RTC-06-06；A 关联 P0-A-01–06 | 当前 sampleId/币种/金额/证据 ID，旁放不相关任务哨兵 | 实际 Memory 绑定与历史来源可查，Provider 请求含所需事实、无其他任务值；附策略生效/超限、旧绑定释放变体；A 另判是否正确使用 |
| P0-RT-MEM-02 未知与隔离 | I-F；RTC-06-10；A 关联 P0-A-04–06 | 原文无币种、日期歧义或当前输入不可得，Gold 区分三者 | F 检查信息是否进入模型；A 检查不猜补/正确保留歧义；猜中不算有证据的正确记忆 |

P0 自动压缩关闭，核验实际设置和压缩入口，但不运行 RTC-06-01–05，也不报“压缩记忆通过”。有效/过期/纠正事实的完整 Gold 可以先制作，P1 实际启用压缩及修订后才执行相应 A。P0 当前事实使用不能替代保存继续、跨 Session 长期记忆或 RAG 能力。

**Session：RT-05/14、关联 RT-01，MOD-02/08/25，BM-11，产品 T05/T08/T09。**

| 场景 | 层与映射 | 材料和触发 | 判定及证据 |
|---|---|---|---|
| P0-RT-SES-01 创建关闭 | N-F/I-F；RTC-01-05 最小 | 合成材料创建实际 Session，结束、close、再次创建 | Session 身份和监听生命周期可查；已关闭实例不再接收请求 |
| P0-RT-SES-02 丢失后重建 | I-F；RTC-05-05 的 P0 子集 | 结束旧试验 Session，保留 Job 后通过产品入口新建 Run | 同 Job、新 generation/Session，原候选保留；新请求使用当前事实，不宣称恢复原生全部历史 |
| P0-RT-SES-03 迟到身份 | I-F；RTC-05-05 的 P0 子集 | 旧代次在重建/取消之后提交候选 | 旧建议拒绝、有失败记录，新 Run 不被覆盖；禁止从评测直接改 DB 制造通过 |

原生保存继续 RTC-05-01、分支 RTC-14-* 只核验支持归属，分别在 P1/P2 启用后评；不因为 Pi 支持这些 API 就提前扩大 P0。

**Skill 与资源：RT-07 / MOD-06，BM-11/BM-08，产品 T06/T08。**

| 场景 | 层与映射 | 材料和触发 | 判定及证据 |
|---|---|---|---|
| P0-RT-RES-01 固定资源 | N-F/I-F；RTC-07-01 最小 | 获准 Prompt 和未批准目录各置唯一哨兵 | 实际装载及 Provider 输入吻合候选；允许原生默认发现与产品收紧策略分开记录 |
| P0-RT-RES-02 缺资源 | I-F；RTC-07-02 最小 | 已绑定 Prompt 文件缺失/摘要变化 | 预检/加载失败，不静默找全局替代；候选和错误可追溯 |

P0 使用固定 Prompt；多 Skill 适用性、资源刷新、回退评测归 P1/P2。未绑定 Skill 写“未启用”，不报 Skill 正确率。

### 3.3 Runtime 模块七至十二：扩展、控制、事件、RPC、子 Agent、稳定性

**原生扩展/插件：RT-08 / MOD-33，主 BM-12、BM-11 引用，产品 T11。**

| 场景 | 层与映射 | 材料和触发 | 判定及证据 |
|---|---|---|---|
| P0-RT-EXT-01 真实注册 | N-F/I-F；RTC-08-01 的工具/Hook 子集 | 真扩展注册 probe 工具和已启用生命周期 Hook，实际调用 | 回调、工具结果、入口/版本/hash 可查；注册表存在不够 |
| P0-RT-EXT-02 未批准资源 | I-F；RTC-08-05 最小 | 已安装但未绑定扩展；非法/变更摘要 | 未批准资源不生效，固定候选不漂移；不评未实现的升级管理 UI |
| P0-RT-EXT-03 失败与无界面 | N-F/I-F；RTC-08-04 | 初始化异常、headless UI 请求、结束释放 | 失败不变成功，交互不自动同意，监听/资源清理可查 |

**运行控制：RT-10/11/12/13 / MOD-08/28，BM-11，产品 T09。**

| 场景 | 层与映射 | 材料和触发 | 判定及证据 |
|---|---|---|---|
| P0-RT-CTL-01 重复取消 | N-F/I-F；RTC-10-01 | 空闲/结束后/重复 abort | 不产生新运行、不重复破坏已结束事实 |
| P0-RT-CTL-02 流中取消 | N-F/I-F；RTC-10-02 | 收到首片段后屏障阻塞，取消后尝试迟到输出 | 取消请求、Runtime 停止、cleanup 分别记录；晚到片段不推进业务 |
| P0-RT-CTL-03 工具取消 | N-F/I-F；RTC-10-03 最小 | 合作 AbortSignal 与不合作慢工具 | 合作实际退出；不合作未清理不得标 complete；按运行层控制释放，不由 Runner 强杀 |
| P0-RT-CTL-04 预算与禁重试 | I-F，原生配置核验；RTC-13-02/05 最小 | 请求数/工具数/时限边界；受控一次失败 | 达限停止新调用；实际自动重试关闭；未知用量不填零、不超 Profile 继续 |

steer/followUp 的接口与队列归属先查清；P0 不执行 RTC-11/12 的实际消费用例。自动 retry 关闭只证明配置边界，不证明 retry 恢复有效，相关行为 P1 再测。

**事件与流：RT-09 / MOD-26，BM-11，产品 T08/T09/T14。**

| 场景 | 层与映射 | 材料和触发 | 判定及证据 |
|---|---|---|---|
| P0-RT-EVT-01 分片聚合 | N-F/I-F；RTC-09-01 | 中文/Unicode 文本和工具参数分片 | 原始流与最终消息内容相符；未完整参数不调用工具 |
| P0-RT-EVT-02 关联与顺序 | N-F/I-F；RTC-09-02 的单运行子集 | 多轮工具请求、结果与 Session/Run | 按调用 ID 和局部因果检查；集成 seq 单调，raw 与规范事件可对应 |
| P0-RT-EVT-03 完成与清理 | I-F；RTC-09-03/04 最小 | 原生结束但清理未完成，或流中断 | UI/报告不能提前说已完全停止；部分输出保留、结果不冒充正常成功 |

P0 不测多 Session 并发、慢消费者容量或主 Host 重连；收到 agent_end 不是全部进程已退出的证据。

**Host/通信边界：RT-15 / MOD-25，BM-11 引用 BM-12，产品 T12/T14。P0 只验证嵌入式工具事件关联，不代表实现或测试了跨进程子 RPC。以下历史 RPC 编号保留以维持追踪。**

| 场景 | 层与映射 | 材料和触发 | 判定及证据 |
|---|---|---|---|
| P0-RT-RPC-01 工具响应与完成关联 | N-F/I-F；RTC-15-02 的嵌入语义子集 | 父 Provider 发出 Agent tool call 后成功、失败或取消 | Pi 工具事件、插件 agentId、子 Session 终态与清理可关联；不调用 spawn RPC |
| P0-RT-RPC-02 桌面装载路径 | I-F；RTC-15-05 开发态子集 | Node 和实际 Electron 入口，含中文/空格受控路径 | 实际 SDK/插件/Hook、子工具、前台结果与清理一致；不冒称独立 Host 或安装包验证 |

RPC-01/02 直接复用 SUB-01 的相应 Trial 和断言，不为 RPC 报告重复调用插件或重复累计成功数。独立主 Host 和完整协议故障矩阵归 P3。

**子 Agent：RT-17 / MOD-34，BM-12，产品 T12/T14。**

| 场景 | 层与映射 | 材料和触发 | 判定及证据 |
|---|---|---|---|
| P0-RT-SUB-01 原生工具委派与绑定 | N-F/I-F；RTC-17-01 | 父受控 Provider 产生 Agent 调用，插件创建真实子 Session，子读合成证据，父收到结果 | toolCallId/agentId/实际父子 Session、工具实现、Gateway scope、结果与清理；父子不要求不同 PID，Node/Electron 分开 |
| P0-RT-SUB-02 继承与权限 | I-F；RTC-17-02 | 合成秘密/额外资源哨兵；请求覆盖 cwd/model、读 Gold 或调用 submit | Hook 执行前拒绝；真实子输入/工具受限、跨任务与业务写动作零；共享宿主不当作沙箱 |
| P0-RT-SUB-03 结果与预算 | N-F/I-F；RTC-17-01、RTC-17-04 | 前台成功、缺证据、截断、晚到、耗尽预留额度及部分结果 | 原生工具结果回父循环一次；不标完整成功，旧修订不推进；父子请求用量归父 Trial 并去重，未知成本明确，失败归还预留 |
| P0-RT-SUB-04 父取消与清理 | N-F/I-F；RTC-17-05 最小 | 子模型/慢工具屏障后父取消；子初始化或模型中断 | 禁新调用、撤销子 scope，确认 Session/工具收敛、监听和预算释放或记录 cleanup incomplete |
| P0-RT-SUB-05 单一入口与参数拒绝 | I-F；RTC-17-05/02 最小 | 递归、同消息多次 Agent 调用、resume/父历史继承/后台/定时/Workflow/mention 创建；另加无 Agent 调用变体 | Hook/能力配置拒绝并无额外子创建；父没有工具调用则子数零；必需核查不得由平台 spawn 补齐 |

原生与集成的区别：原生通道验证插件本身的实际父 Loop→原生 Agent→子 Session→工具结果；主 Gateway 权限和 Electron 适配属于集成。P0 不运行“单主模型 vs 主子模型”业务 A/B 对比，该收益试验依赖 P1-I。

**稳定性与版本：RT-16 / MOD-02/25/26，BM-11/12，产品 T01/T09/T12/T16。**

| 场景 | 层与映射 | 材料和触发 | 判定及证据 |
|---|---|---|---|
| P0-RT-STA-01 创建/释放观察 | N-F/I-F；RTC-16-01 最小 | 将已执行的 3 次 Session 创建/关闭串行记录，其中含一次子 probe | 活动 Run/子 Session/监听/子 scope 归零，原始产物按策略保留；内存/句柄仅记录，不报 Soak 或容量通过 |
| P0-RT-STA-02 版本/证据匹配 | I-F；RTC-16-04 的前置核验 | 修改包、适配 patch 或配置摘要后尝试复用旧报告 | 不匹配拒绝复用；无第二个实际 SDK 候选则不声称完成升级对照 |

STA-01 复用合法循环、创建关闭及子 probe 的实际事件；只有证据缺失才补测，不能把同一次观测当多个独立样本。

### 3.4 产品侧关联检查

这些检查主要接收产品 F，不另建 BM-07/09 全套。它们保证 Runtime 和 A 试验所依赖的输入、结果与权限真实可信。

| Case | 模块 / 主 Benchmark | 材料、Oracle 和结果 | 产品任务 |
|---|---|---|---|
| P0-D-01 有效输入/冻结 | MOD-09/29；BM-01 | 已配对原文/解析、摘要、非空和页码；冻结后源目录增长不改变清单 | T03/T04 |
| P0-D-02 坏输入隔离 | MOD-09/29；BM-01 | 空、缺原文、错 hash、缺页、写入中分别隔离；错误原因可定位 | T03/T04 |
| P0-D-03 答案/路径边界 | MOD-03/05/29；BM-08 | 标签/Gold/其他任务/秘密、路径穿越、symlink/junction、间接引用均不得读取 | T04/T06/T07 |
| P0-D-04 候选原始与接受 | MOD-11/25/26；BM-01 | 原始模型请求、规范候选和人工 Gold 分开；错样本、旧代次、非法证据不得接受 | T05/T07/T10 |
| P0-D-05 重开与状态 | MOD-23/25/26；BM-11 关联 | 实际重开可查 Job/Run/候选；候选接受不显示已审批/业务完成，残留活动 Run 为 interrupted | T05/T14 |
| P0-D-06 首次 Test 资格 | MOD-24/27；BM-08 | 无质量成绩但依赖/权限就绪可试跑；生产环境、缺配置和漂移候选拒绝 | T06 |
| P0-P-01 新原图 Parser | MOD-10；BM-01 独立 Parser 切片 | 实际新 JPG、真实调用/全新产物/输入 hash、页数与人工核验的核心内容 | T13 |

P0-P-01 的 Oracle：制作人从实际新原图选择三处清晰且与后续字段有关的文本锚点，至少含票号或票面总额中的一项，逐处记录原值与位置；Parser 产物应包含对应内容、文档身份和正确页数。三处均应通过，任一遗漏/错字按锚点 FAIL；非选定内容不因未标注就声称正确。不限定某 Parser 必须生成虚构坐标，也不把这三点成绩推广为整票 OCR 准确率。原图没有三处可核验锚点时另选适合本次兼容试验的样本。

### 3.5 主模型真实 A 案例与最小通路

以下 6 个槽位均使用真实主模型，每槽位固定一份输入；真实数据槽位必须来自 3 份不同原始发票，不能用同一票不同解析版本凑数。样本不存在前只登记槽位，不虚构 sampleId。合成例可提前制作，但来源必须是 synthetic。

| Case | 选材及输入 | 必需质量检查 | 关联模块/Benchmark |
|---|---|---|---|
| P0-A-01 正常真实票 | 一份解析完整、字段清晰的实际票；至少 6 个关键字段可核验 | 票号、日期、买方名、卖方名、币种、总额的值/状态/证据；实际取证与候选保存 | MOD-02/03/05/11/26；BM-01 主、BM-11 引用 |
| P0-A-02 格式风险真实票 | 优先金额格式或布局不同的第二份实际票；记录筛选规则 | 金额/日期规范值、明细对应及取证；无法找到差异则披露覆盖不足，不能虚构 | MOD-11、关联 MOD-03/05；BM-01 |
| P0-A-03 随机真实票 | 从已获准且可用的剩余总体按固定 seed 选第三份 | 所有已核验字段、遗漏/额外值、证据；不能看模型输出后换票 | MOD-11/26；BM-01 |
| P0-A-04 无币种 | 合成原文与解析都去掉币种和可推定依据 | currency missing、normalized=null，无依据不猜；其余事实保持正确 | RTC-06-10 / MOD-03/11；BM-01、BM-11 |
| P0-A-05 歧义日期 | 合成 `03/04/2026`，没有国家/格式约定 | invoiceDate ambiguous、normalized=null，保留原值与证据；不猜某一天 | RTC-06-06/10 / MOD-03/11；BM-01、BM-11 |
| P0-A-06 解析遗漏 | 合成原图含币种，解析故意漏掉；依据已冻结证据可见范围定 Gold | 区分原文真值和模型可获得性；不可见时如实缺失，可经已启用取证工具获得时应取证；原文目标缺口单列 | MOD-09/03/11；BM-01、BM-11 |

A-06 在冻结前必须查看实际工具响应，固定 inputMode=`parsed_only` 或 `parsed_with_source_evidence` 及可见资产。若当前取证工具只返回解析 block，则原图有值不代表模型能获得；不能把原图路径存在当成模型已看图。本 Case 不要求新增多模态工具，也不在看结果后改变可见性标签。

三份真实票均报告逐字段原始结果，P0 不套用总方案中的 P1/P2 候选准确率阈值。对 P0-A-01 的六个已明确字段，以及 A-04 的不猜币种、A-05 的保留歧义、A-06 的按可见性判断，定义为 P0 最小质量门槛；详情见 §8。其余字段/格式能力报告实测缺口，交 P1 扩充。

### 3.6 联合检查与排除项

联合检查复用已存在 Trial：A-01 串联输入/Context/Loop/工具/SQLite；SES-02/03 串联重建和旧身份；CTL-02/03 串联取消、迟到、状态与清理；SUB-01/02/04 串联父子配置/桥接/权限/预算/退出。不新增重复 Case 成功分母。

总方案 RTX-01–06 的压缩、队列、在途刷新、独立 Host 等完整场景保持 P1–P3 范围。P0 的局部联合检查不能记为整项 RTX 通过。BM-02–07、BM-09/10 的完整业务范围不在本阶段；所需持久化/界面 F 通过上表衔接，不为通过率提前实施企业功能。

## 4. Case 挖掘、人工制作与池分化

### 4.1 谁在什么时候制作

实际责任人姓名在 E01 台账登记，不虚构已签名。项目负责人可兼任 Gold 核验人；同人制作和核验须记录角色及两次操作，不能称为独立双人一致性验证。

| 批次 | 制作任务与数量 | 制作/核验责任 | 最晚交付节点 |
|---|---|---|---|
| Q0-R Runtime | 按 §3.1–3.3 每个场景制作 Oracle、必需变体和证据清单 | 评测实施者制作，产品 Runtime 实施者核对合法 API/机制预期；冲突由阶段负责人裁决 | 对应 T08/T11/T12 功能验证前 |
| Q0-D 数据/权限 | §3.4 的 6 类输入/平台场景及全部明确列出的坏输入变体 | 评测实施者定样，数据提供者核对来源角色，产品方实现夹具 | T03/T04/T07 前 |
| Q0-A 主模型 | 3 份不同真实票 + 3 份合成变体，对应 6 槽位；全字段表含不可评项 | 制作人先读原文再比标签，项目负责人核验开发 Gold | E07 正式冻结前 |
| Q0-P Parser | 1 份无预存解析的新 JPG、3 处独立文本锚点 | 数据提供者选材，Gold 核验人确认锚点，产品 T13 提供实际产物 | T13 Live 前 |
| Q0-C 裁判自检 | 每种评分逻辑至少有已知正确、错误、缺证据，以及混合统计样例 | 评测实施者制作，核验人手算预期结果 | E04/E06 接收前 |

这些是初始覆盖规模，不是生产统计样本量。6 个 A 槽位中有 3 份真实票，报告不得写成“6 份真实发票”。扩充真实样本可以继续，但要先修订冻结清单和预算，不能临时多试直到凑出通过。

### 4.2 来源与采样

| 来源 | P0 如何实施 | 配额/记录与限制 |
|---|---|---|
| 业务/用户反馈 | 接收当前数据说明、人工发现的解析/标注问题，以及试跑后的字段纠正 | 新反馈逐条登记；无反馈可为 0，不能制造投诉样本 |
| 监控与质量巡检 | 当前只使用离线 Run 的超时、非法参数、异常退出和无告警成功记录 | 每轮所有失败/告警纳入待核验；至少人工复核本轮 1 条正常输出；生产监控未启用 |
| 规则定向挖掘 | 金额格式、无币种、日期歧义、解析缺失、路径/标签与子权限风险 | A-02 和 A-04–06、D/RT 变体；记录检索规则、匹配总体及选择理由 |
| 随机真实样本 | 对已获准且有效的样本全集排序后按固定 seed 抽样 | A-03 至少 1 份，排除 A-01/02 及近重复组；抽样窗口、seed、排除原因可复查 |
| 离线补充 | 合成原文/解析、受控 Provider、故障屏障、开发回归 | 明确标 synthetic/offline_trial，不能记为生产随机发现 |

先确定来源/近重复组，再分 development/regression/holdout。P0 资产默认 development 或 regression，不宣称独立企业 holdout；同一票的解析变体、反例和重复 Trial 不能跨组增加样本独立性。case-source-map 保留每条线索的 samplingFrame、selectionRule、sourceGroup 和权限用途。

### 4.3 人工具体制作步骤

1. 取得项目数据准确位置；配对原文与解析，登记 sampleId/sourceId、版本/hash、允许用途，先核实模型实际可见字段和工具证据。
2. 独立阅读原文，逐字段录入 sourceValue、位置/引文、值状态；再对比提供方标签。标签 source_locator 若只指向标注 JSON，不能充当票面证据。
3. 对照 ParsedDocument 和工具返回，记录 inputAvailability=`available`/`unavailable`/`uncertain` 及依据。原图有值但输入丢失保留原文差异；局部不猜补可以通过，原文到结果的缺口仍要报告。
4. 填规范值及规则：票号保留前导零；金额按十进制精确比较，`110` 与 `110.00` 可等值；无区域依据的日期保留 ambiguous；只有 `$` 不猜币种；名称默认只统一行尾和连续空白，不修改实体名称。
5. 明细逐行登记稳定 lineGoldId 和原文位置。优先按来源行证据对应；重复描述且不可唯一对应时人工复核，不用数组位置强行判为正确。税额缺失不填 0，不“修正”原文金额使算式成立。
6. 写 allowedActions/forbiddenActions 和必要事实，不规定唯一思考步骤。原生 Oracle 依据锁定版本公开契约；集成 Oracle 依据本项目已确认边界，两者分别签核。
7. 核验人对照同一原文/规则确认，每字段/断言记录 verified/disputed/pending、reviewer、时间和依据。争议不能因实现难就删除；缺证据项保留 UNJUDGEABLE 的条件。
8. 将已核验部分冻结为新 Gold/Oracle 版本；预测在运行后另写。正式基准的必需断言有争议时不能冻结为可放行集，其他独立开发试验仍可进行。

P0 代码评分不调用产品规范化函数作为唯一裁判。Gold 的已核验规范字符串/金额和独立计算器提供期望；否则同一个规范化 bug 可能同时进入预测和评分。

### 4.4 制作表与资产去向

在质量根 `agent-eval/data/p0/authoring/` 维护六张 CSV，编码 UTF-8，导入时按列 Schema 校验：

| 表 | 必需列 |
|---|---|
| cases.csv | caseId/version、场景、主要/关联 MOD/RT、BM、被测层、F/A/B、来源、sourceGroup、inputRef/hash、purpose、前置、必需变体、owner |
| fields.csv | caseId、fieldPath/lineGoldId、sourceValue/sourceNormalized/sourceStatus、期望 normalized/valueStatus、inputAvailability、evidence、规则、reviewStatus、reviewer |
| behaviors.csv | caseId/assertionId、允许/禁止/必要行为、触发、Oracle、证据、严重级别、reviewStatus |
| runtime.csv | RT/场景、锁定包/入口、supported/enabled/implemented/executed/triggered、N/I、来源、限制、产品任务/报告 ID |
| questions.csv | questionId、关联 Case/字段、缺资料/分歧、责任人、解决节点、决定及依据 |
| findings.csv | findingId、渠道/窗口/采样规则、Case/Trial/候选、预期/事实、证据、Good/Bad/待核验/争议、主因/促因、行动/回归引用 |

Good/Bad 标注对象为 `candidateId + caseVersion + trialId + rubricVersion + scope` 的表现。未运行的正常票/异常票只能是场景，不能先叫 Good/Bad；发生非法请求但被 Gateway 拦截时，平台控制可 Good，模型行为可 Bad，两个结论并存。

待核验→证据复核→Good/Bad/争议；Good 中有代表性的可入 Golden Set，Bad 经确认为产品问题进入 Failure Regression Set，高难度场景可以另入 Challenge Set。成员关系可重叠但用途分开。Bad 修复后追加新版本 Good 和实际回归引用，保留旧失败；Gold/Grader 有错时走评测修订，不把原错误评分当真实产品缺陷。

## 5. Case、Gold 与 Oracle 的具体格式

### 5.1 契约

评测 Schema 位于 agent-eval/src/schema.ts，不把 Gold 类型塞入产品 Context。生产方只消费 Case 的 inputRef/运行参数投影。

```ts
type Verdict = "PASS" | "FAIL" | "UNJUDGEABLE";
type ExecutionStatus = "COMPLETED" | "NOT_RUN" | "ERROR";
type Scope = "native" | "integration" | "parser-result" | "eval-infra";
type EvidenceRef = { id: string; sha256: string; source: string };
type EvalCase = {
  caseId: string; version: string; primaryModule: string;
  relatedModules: string[]; runtimeRefs: string[]; benchmarkRefs: string[];
  scope: Scope; level: "F" | "A" | "B"; sourceKind: string;
  sourceGroup: string; purpose: "development" | "regression" | "holdout";
  inputRef: EvidenceRef; fixtureVersion: string | null;
  goldRef: EvidenceRef; rubricVersion: string;
  required: boolean; assertions: string[];
  driverId: "native-f" | "product-f" | "product-a" | "parser-result";
};
type FieldGold = {
  fieldPath: string; sourceValue: string | null;
  sourceNormalized: string | null;
  sourceStatus: "present" | "missing" | "ambiguous" | "conflict";
  normalized: string | null;
  valueStatus: "present" | "missing" | "ambiguous" | "conflict";
  inputAvailability: "available" | "unavailable" | "uncertain";
  evidence: EvidenceRef[];
  comparison: "identifier" | "text" | "decimal" | "date" | "status";
  reviewStatus: "verified" | "pending" | "disputed";
};
type AssertionResult = {
  assertionId: string; verdict: Verdict; critical: boolean;
  evidence: EvidenceRef[]; reasonCode: string;
};
```

EvalTrial 另存 evalRunId、trialId、candidateId、Case/Gold/Grader hash、attemptIndex、executionStatus、jobId/runIds/childRunIds、起止时间、usage、assertionResults、整体 verdict/null、errorKind、upstreamBlocked、产品报告引用。一个父 Trial 包含自己的全部 Run/ChildRun；Runner 不为每个子执行新计一份样本。

FieldGold 的 sourceValue/sourceNormalized/sourceStatus 表示原文事实，normalized/valueStatus 表示在该 Case 已冻结可见范围内对模型输出的期望。A-06 若原文是 CNY 但该值不能通过获准输入/工具取得，则前者为 CNY/present，后者为 null/missing；行为按后者评分，原文链路缺口按前者记录，不能混用分母。

### 5.2 完整合成字段例

制作 P0-A-04 的原文与 ParsedDocument，内容为：

```text
Invoice No: SYN-001
Date: 2026-09-01
Seller: Example Seller
Buyer: Example Buyer
Net: 100.00
Tax: 10.00
Total: 110.00
```

它必须是一组真正配对的合成资产，块 ID `b1`–`b7` 分别对应上述行；源文件 hash 在 E02 创建后计算，不能填写假的摘要。合成原文也不能出现币种暗示。

| 字段 | 已知期望 | 判断 |
|---|---|---|
| invoiceNumber | SYN-001 / present | 标识精确，b1 引文支持 |
| invoiceDate | 2026-09-01 / present | 明确日历日期，b2 |
| sellerName / buyerName | Example Seller / Example Buyer | 不互换，不做主数据映射，b3/b4 |
| netAmount / taxAmount / totalAmount | 100.00 / 10.00 / 110.00 | 十进制等值，b5/b6/b7 |
| currency | null / missing | 不能补 CNY/USD；无证据不伪造引用 |

Gold 核验与真实 Trial 运行分开。合成正确候选→PASS；补 `currency=CNY`→该断言 FAIL；缺候选且运行正常结束→任务 FAIL；证据产物由评测复制时丢失→相关判据 UNJUDGEABLE/设施 ERROR，不能按同一种失败归因。不会因为错误字符串刚好等于真实币种而认为有依据。

### 5.3 工具 Oracle 例

P0-RT-TOOL-01-N：原生 Pi 注册纯函数 `lookup_probe`，受控 Provider 第一次返回 toolCallId=`probe-1`，工具返回 `{code:"FACT-71"}`，后续 Provider 记录真正收到的工具结果后结束。Oracle 检查原生调用/返回配对和结果内容；不要求 Flowmate 错误码或业务状态。

P0-RT-TOOL-01-I：实际主工具 `read_parsed_document` 读取当前合成样本，Gateway 记录 requestId、RunIdentity、返回 inputHash；Provider 后续请求必须含该结果。合法 submit 通过 Kernel 保存一个候选。错误身份/非法参数变体必须无有效写入。评价对象是已发生的工具事实，不是 Agent 自述“调用成功”。

### 5.4 Session/记忆与原生 Agent 工具 Oracle 例

SES-02-I 的初态通过产品入口创建 Job 和 Run g1；关闭测试 Session 后从保留 Job 发起重建 g2。Oracle 为 jobId 相同、generation 递增、新 sessionId、旧候选和事件不丢、g1 提交被拒。MEM-01 检查 g2 的实际 Provider 输入包含当前允许事实；这是显式重建的事实使用，不是对原生历史恢复的评分。

SUB-01-I 的初态由产品创建只含合成资产的父 Run。受控父 Provider 发出原生 Agent tool call，经 Pi Loop 和 Flowmate Hook 后插件创建实际子 Session，子扩展调用只读工具，原生前台结果返回父循环。Gold 要求实际 toolCallId、pluginAgentId、不同的父/子 Session、子工具表、可信 Gateway scope/requestId、原生工具结果与 cleanup；同宿主 PID 正常。若仅传工具名、角色扮演文本、直接执行工具函数或调用程序化 spawn，均不能判该整链 PASS。

SUB-05-I 同时制作“主模型没有 Agent 调用”和“工具调用被策略拒绝”的负例，Gold 要求创建数零；多调用变体检查原子预算预留与并发上限，不只检查一个错误字符串。F 的受控工具消息用于验证执行机制，不能据此声称真实主模型会自主正确委派；真实主模型决策、子模型业务效果及父汇总 A 在 P1 准备并执行。

## 6. 设施实现任务与产品依赖

### 6.1 文件与运行数据布局

目录遵循[项目总方案 §17.1](../../../docs/spec/00_Flowmate完整方案.md)。P0 不新增 workspace 包，评测源码固定放 agent-eval/src 并通过 agent-eval/tsconfig.json 纳入根 typecheck，测试放 agent-eval/tests；不平行生成 packages/evals。当前只迁移已有文档，下面的源码、测试、配置和数据在 E01–E10 实施时建立。所有评测内容统一归 agent-eval/；共享产品契约用包 exports；原生测试驱动由产品 tests/runtime 维护。以后确需迁包，先更新主方案目录与受影响阶段计划；执行前检查并补齐已有文件，不覆盖已有实现。

```text
agent-eval/README.md
agent-eval/docs/spec/01_Flowmate_Agent评测总方案.md
agent-eval/docs/plans/P0_Agent评测实施方案.md
agent-eval/src/
  schema.ts              # Case/Gold/Trial/报告/结论契约
  assets.ts              # 六张制作表导入、来源与版本冻结
  registry.ts            # Case 到产品驱动、场景、报告的绑定
  runner.ts              # 串行 Trial、预检、预算、取消
  drivers.ts             # 原生报告/产品报告/实际 Application 调用
  grader-fields.ts        # 独立字段与证据比较
  grader-runtime.ts       # Oracle/事件与引用断言
  statistics.ts          # 分母、重复与去重
  findings.ts            # 核验池、归因、集合成员
  report.ts              # JSON/Markdown 模块和总报告
  decision.ts            # 固定候选质量结论
  cli.ts                 # author/check/run/grade/report/decide
agent-eval/tests/
  assets.test.ts  graders.test.ts  runner.test.ts
  statistics.test.ts  findings.test.ts  decision.test.ts
  fixtures/known-results.json
agent-eval/config/p0.catalog.json
```

真实输入、Gold 和 Trial 产物放 `agent-eval/data/p0/`，仅 agent-eval/data/ 整目录 Git 忽略，文档、源码和非秘密配置正常提交；运行前检查整个 agent-eval/ 不在产品 input/runtime 搜索根。产品输出仍在 FlowmateData，由只读引用关联。

```text
agent-eval/data/p0/
  authoring/                         # 六张 CSV、问题单
  assets/<version>/                  # Case/Gold/Oracle 与摘要
  benchmarks/<version>/manifest.json
  eval-runs/<evalRunId>/
    plan.json                        # 全部计划 Case/变体/重复和预算
    trials/<trialId>/result.json
    reports/                         # 模块、首次/重复、归因、总报告
  findings/                          # 版本化核验与成员关系
  decisions/<decisionId>.json
```

### 6.2 E01：固定覆盖、就绪和责任台账

**文件：** 创建 agent-eval/config/p0.catalog.json、agent-eval/src/schema.ts、agent-eval/tests/assets.test.ts；核验 .gitignore 的 /agent-eval/data/ 忽略规则；创建 agent-eval/tsconfig.json 并接入根 TypeScript 引用，在根 Vitest include 中加入 agent-eval/tests/**/*.test.ts，使首批设施测试实际被收集。

**接口：** `validateCatalog(catalog): CatalogCheck`；CatalogCheck 返回 missingVariants/duplicateIds/unassignedOwners/invalidMappings。catalog 将每个场景与产品 T 任务、测试文件、scope、必需变体绑定。

- [ ] 将 §3 全部场景和明确列出的变体录入，标 required、执行前置、scope、RTC 子集及 owner；确认实际产品支持表，未启用项归后续阶段。
- [ ] 写测试，缺必需子 Pi 变体或把压缩标 executed 必须拒绝；运行 `bun run test agent-eval/tests/assets.test.ts` 看到失败。

```ts
expect(validateCatalog(catalogWithoutElectronSubagent).missingVariants)
  .toContain("P0-RT-SUB-01-I-electron");
```

- [ ] 实现 strict Schema、引用/ID/状态一致性检查；未核验 SDK 入口只能是 not-verified，不能自动勾 supported。
- [ ] 给每个制作批次登记真实责任人和相对里程碑，复跑测试；提交 `test: define P0 evaluation coverage and asset contracts`。

**完成条件：** 覆盖可枚举、有产品承接者，未实现与未启用不混淆；本步骤不要求 Live 数据已到位。

### 6.3 E02：制作种子 Case/Gold 和 Runtime Oracle

**文件：** 创建 agent-eval/src/assets.ts；扩展 assets.test.ts；真实制作结果存 authoring/assets，不把发票正文写入仓库 catalog。

**接口：** `importAuthoring(directory): AssetBatch`；`freezeAssets(batch): AssetManifest`。只有核验通过且 hash/引用有效的必需 Gold 可进入正式范围。

- [ ] 按 §4 的步骤完成 Q0-R/D/C 合成与 Oracle，真实数据到位后补 Q0-A/P；先制作材料再获取预测，不让预测决定 Gold。
- [ ] 用未核验标签、坏引用、同源跨用途、遗漏 variant 和 Unicode CSV 测试导入；先运行失败测试。

```ts
expect(() => freezeAssets(batchWithUnreviewedRequiredGold))
  .toThrow("GOLD_NOT_VERIFIED");
expect(() => freezeAssets(batchWithSameSourceAcrossHoldout))
  .toThrow("SOURCE_GROUP_LEAKAGE");
```

- [ ] 实现 CSV→Schema→来源配对→人工核验状态→摘要与版本，不自动补默认答案。只有部分可评字段时保留 scoreable mask 和原因。
- [ ] 真实 sampleId 替换槽位、核验 3 份不同发票及 3 份合成例；Parser 锚点独立核验；无真实数据时只交已完成的合成部分。
- [ ] 复跑资产测试，提交 `test: implement reviewed P0 evaluation asset freezing`。

**完成条件：** 资产可以人工执行和核查，标签与输入隔离；正式 A/Parser 清单未齐时不假报该批完成。

### 6.4 E03：绑定产品报告与原生驱动

**文件：** 创建 agent-eval/src/registry.ts、drivers.ts；扩展 assets.test.ts；产品对应 T08/T11/T12/T15 增加场景 ID 和必需报告字段。

**接口：** `resolveEvidence(caseDef, candidate, reports): EvidenceBinding`；`isReusable(report, binding): boolean`。匹配项包括 appSource/lock/patch、输入/fixture、Scope、Scenario/变体、断言、工具/资源/模型参数和环境；复用只读报告，保留本次 evaluatedAt 和来源 executedAt。

- [ ] 给每个 Case 绑定唯一主证据和可能的原生/集成对照；不按测试文件名猜覆盖。
- [ ] 测试同 SDK 不同 patch、同 Case 不同输入、原生报告冒充集成、工具名称存在却无执行记录等情况。

```ts
expect(isReusable(nativeReport, integrationBinding)).toBe(false);
expect(isReusable(reportWithOldPatch, currentBinding)).toBe(false);
```

- [ ] 对产品 F 缺口输出可定位清单，交相应 T 任务补驱动/断言；原生通道直接跑实际 SDK+纯工具，集成通道经实际 Gateway。评测侧不复制故障 Provider 和进程管理。
- [ ] 从有效 F 报告提取断言和证据；缺原始机制证据标 UNJUDGEABLE/缺口，不因为报告写“通过”就信任。
- [ ] 复跑测试，提交 `test: bind P0 evaluations to native and product evidence`。

**完成条件：** 每项结论能追溯实际被测层和候选，同一份执行可被多个模块引用但不重复计数。

### 6.5 E04：实现字段与 Runtime Grader 并自检

**文件：** 创建 grader-fields.ts、grader-runtime.ts、agent-eval/tests/graders.test.ts、fixtures/known-results.json。

**接口：** `gradeFields(candidate, gold, evidence): AssertionResult[]`；`gradeRuntime(trace, oracle): AssertionResult[]`。输入只读，返回值不能改变产品事实。

- [ ] 每个比较器手工给正确/错误/缺证据/边界例，包括前导零、decimal 等值、歧义日期、missing≠0、互换买卖方、明细重行、错误证据、未触发与错层。
- [ ] 写并运行失败测试；独立十进制比较使用字符串解析为符号/整数系数/scale，不导入产品规范化函数。

```ts
expect(compareDecimal("110", "110.00")).toBe(true);
expect(compareDecimal("110.01", "110.00")).toBe(false);
expect(gradeCurrency({ normalized: "CNY", status: "present" }, missingCurrencyGold))
  .toMatchObject({ verdict: "FAIL" });
```

compareDecimal 和 gradeCurrency 均为 grader-fields.ts 的纯函数；Gold 测试值显式构造并通过评测 Schema。

- [ ] 实现字段值/状态、证据支持、必需/禁止动作与事件偏序检查。缺失的必需输出是 FAIL；事实存在但证据传输缺口是 UNJUDGEABLE；不能一律过滤掉难评分结果。
- [ ] 受控 trace 已知“有完成事件但进程仍活着”应判清理失败；“请求非法但实际阻断”分别给 Agent 请求与平台控制结果。Grader 的未知不自动等于产品失败。
- [ ] 人工逐项核对自检集，测试通过后提交 `test: add independently checked P0 field and runtime graders`。

**完成条件：** Q0-C 的所有已知正、错、缺证据样例判定符合手工 Oracle；本阶段不用模型裁判降低争议处理成本。

### 6.6 E05：实现顺序 Trial 运行、预算与取消

**文件：** 创建 runner.ts、cli.ts、agent-eval/tests/runner.test.ts；扩展 drivers.ts、根 package.json/typecheck 配置；评测脚本指向 agent-eval/src/cli.ts，默认配置从 agent-eval/config/ 读取，核验新增源码已纳入类型检查。

**接口：** `planEvalRun(manifest, profile): EvalPlan`；`executeEvalRun(plan, drivers): Promise<EvalRunResult>`；`cancelEvalRun(evalRunId): Promise<CancelReceipt>`。产品 driver 复用 Application，F driver 运行 catalog 中已登记测试目标，不能让 Case 任意拼 Shell 命令。

- [ ] 用已知通过/失败/未就绪的 driver 替身自测 Runner，替身成绩只属设施 F；测试预算预留、首次失败保留、停止派发、取消确认和部分产物保存。

```ts
const result = await executeEvalRun(planWithOneBlockedCase, controlledDrivers);
expect(result.trials.find(x => x.caseId === "blocked")?.executionStatus).toBe("NOT_RUN");
expect(controlledDrivers.externalRequests).toBe(0);
```

- [ ] 正式运行每 Trial 使用独立 productDataRoot、Job/Session/缓存空间，数据清单和候选保持固定；恢复 Case 的多个 Run 保持同一 Trial 初态链，不能中途擦除失败。
- [ ] 顺序并发 1，预留本 Trial 的最大请求/工具/时间；余量不足停止派发，不擅自提高 Profile。取消集成任务只走 Application.cancel 并订阅 cleanup；未确认清理时保持 ERROR/证据不足并阻止继续占用冲突资源。
- [ ] 断点恢复保留原 trialId/已发生事实，设施失效重跑另建 Trial 且关联原记录；不能覆盖“第一次失败”。重评分是新 gradeRunId，不调用模型。
- [ ] 复跑 runner 测试，提交 `test: implement bounded P0 evaluation trials and cancellation`。

**完成条件：** Runner 不替代产品执行引擎；默认不访问外部服务，显式 Live 才调用模型。

### 6.7 E06：实现统计、模块报告和可比性

**文件：** 创建 statistics.ts、report.ts、agent-eval/tests/statistics.test.ts。

**接口：** `summarize(trials, plan): Summary`；`renderReport(summary, moduleBindings): string`。Summary 按 Scope/Level/sourceKind/模块/Case/attempt 分组，带计划、执行、可评、失败和成本覆盖。

- [ ] 手算包含 1 PASS、1 FAIL、1 UNJUDGEABLE、1 ERROR、1 NOT_RUN 的五个计划项；重复引用其中 PASS 不增加业务样本量。

```ts
expect(summarize(fiveKnownTrials, fiveItemPlan)).toMatchObject({
  planned: 5, scoreable: 2, pass: 1, fail: 1,
  unjudgeable: 1, error: 1, notRun: 1,
  scoreablePassRate: 0.5, confirmedPlanPassRate: 0.2,
});
```

- [ ] 先运行失败测试，再实现 §7/8 分母和 firstAttempt/k=2 稳定性；总报告去重，模块报告允许引用但显式注明非可加总。
- [ ] 输出全部 12 模块，包括未启用/仅核验/缺实现/未触发；F/A 和真实/合成分栏，不生成单一 Agent 总分。
- [ ] 复跑统计测试，提交 `test: report P0 evaluation coverage and repeated outcomes`。

**完成条件：** 不能用低覆盖高分通过；重复、子执行和跨 BM 引用不虚增样本数。

### 6.8 E07：冻结 Benchmark 并执行适用试验

**文件：** 使用已实现 CLI/Runner，冻结质量根 benchmarks/<version>/manifest.json；按缺口修改实际 Case 资产，源码只在有修复时变更。

**接口：** 输入产品 HandoffManifest 和核验资产，输出完整计划、实际 Trial/模块证据及首次基线。

- [ ] 先小范围试装配并自检 Grader；正式运行前固定版本、Case/变体、Scope、分母、k、门槛和预算，建立 §8 四个 Benchmark 切片。
- [ ] 导入有效原生/集成 F；缺项用实际驱动执行；本次 A 所依赖的主通路安全/身份/清理项具备后即可对真实数据开始局部 A，不必等待不参与该次运行的 Parser 或子 Pi 试验全部完成。P0 联合退出仍要求所有必需项齐全。
- [ ] 先对合成 A 运行实际模型以核验流程，再按冻结次序运行 3 份真实票；同 Case 第二次使用独立初态。失败停止规则优先于凑满次数。
- [ ] 复用真实 Parser 报告并按三锚点评分；版本/输入不符或内容证据不足时，补 T13 合法实跑，不能只重评旧解析冒充新原图。
- [ ] 记录首个有效固定批次为 baseline，不挑最好一批；按 §8 生成模块与 A 报告，进入问题核验。

**完成条件：** 所有计划项都有状态、来源与证据；即使有失败也完整交付报告，不把运行结束当评测通过。

### 6.9 E08：维护 Good/Bad、归因和两条闭环

**文件：** 创建 findings.ts、agent-eval/tests/findings.test.ts；真实记录写 findings/ 和六张表。

**接口：** `recordFinding(input): Finding`；`reviewFinding(id, decision): FindingRevision`；`linkRegression(id, trialRef): FindingRevision`。每次修订追加，原始 Trial/评定保留。

- [ ] 测试未运行案例不能判实际 Good；平台阻断 Good/模型请求 Bad 可并存；已修复记录仍保留旧 Bad；无证据根因只记 hypothesis。

```ts
expect(() => reviewFinding(unexecutedFinding.id, goodDecision))
  .toThrow("OBSERVATION_REQUIRED");
expect(linkRegression(badFinding.id, fixedTrial).history)
  .toContainEqual(expect.objectContaining({ classification: "bad" }));
```

- [ ] 按 §9 人工复核本轮所有失败与至少一条正常表现；只在证据支持时入 Golden/Failure Regression，实际未发生失败允许 Bad 数为 0。
- [ ] 产品缺陷分派相应 T 模块修复后新候选回归；资产/Grader 问题修订评测版本，明确仅重评还是重跑，原始预测不改。
- [ ] 复跑 findings 测试，提交 `test: track reviewed P0 cases and evidence-based attribution`。

**完成条件：** 至少有真实观察后的核验记录，池分类有版本/证据；不能预写“已形成完整修复闭环”。完整问题发现到修复的案例若 P0 未发生，保留 P1 交付要求。

### 6.10 E09：质量结论与 E10：联合退出/交接

**文件：** E09 创建 decision.ts、agent-eval/tests/decision.test.ts；E10 更新两份 P0 计划的实际状态及 README，报告保存在质量根。

**接口：** `decide(manifest, reports): QualityDecision`，包含 candidateId、scope、environment、Benchmark/Gold/Grader hash、evidenceRefs、status=`PASS`/`FAIL`/`INSUFFICIENT_EVIDENCE`、blockingReasons、limitations。

- [ ] E09 测试任何必需未运行、错版本、关键无法判定或零容忍失败不得 PASS；非门槛字段质量缺口允许如实附在 P0 小范围 PASS 中，不能从报告删除。

```ts
expect(decide(manifest, reportsWithoutRealChildEvidence).status)
  .toBe("INSUFFICIENT_EVIDENCE");
expect(decide(manifest, reportsWithActualUnauthorizedRead).status).toBe("FAIL");
```

- [ ] E09 按 §8 实现结论，不把“评分全部完成”当“能力全部通过”；复跑 decision 和统计测试，提交 `test: bind P0 quality decisions to mandatory evidence`。
- [ ] E10 将 QualityDecision 交产品 T16，核对候选和适用范围完全一致；功能与质量分别签署，两个阶段状态互不伪装。
- [ ] E10 交付种子集/来源、Gold/Oracle/Grader/Runner/报告、Good/Bad 与已知限制，列 P1 需要启用和评测的压缩、会话继续、队列、真实子模型及业务闭环。
- [ ] E10 更新实际任务状态并提交 `docs: record P0 evaluation results and P1 quality handoff`；本轮只写方案，不执行这些代码、调用或提交。

**完成条件：** 结论有固定范围、有效证据和限制；证据不足不会被转成 P0 通过。

## 7. 判分、状态与分母

### 7.1 评分项目

| 评分对象 | 方法 | 失败/无法判定 |
|---|---|---|
| 原生契约 | 锁定 SDK/插件合法输入→真实事件/工具/Session/进程证据，与 Oracle 独立对照 | 已触发且违反契约 FAIL；无法确认触发/缺关键证据 UNJUDGEABLE；查错版本的测试设为设施 ERROR |
| 集成边界 | Provider 实际输入、Gateway 记录、Kernel 接受事实、UI 状态与 cleanup | 非法实际访问/旧写入/假成功 FAIL；日志缺口不能“假定安全” |
| 字段 | 固定规范规则比 raw 候选，value/status/evidence 分项 | 缺必需预测 FAIL；Gold 待裁决/原文不可辨认的值 UNJUDGEABLE；missing 状态仍可评分 |
| 证据 | hash/资产/页块定位、引文与字段支持，必要时人工复核 | 引用存在但不支持值 FAIL；定位真实性无法确认 UNJUDGEABLE；无坐标不是自动失败 |
| Parser 局部结果 | 新调用与产物关系、页数/非空、三锚点人工核验 | 旧解析回放、错身份、锚点错误 FAIL；没有新原图/调用证据不得通过 |
| Agent 请求与控制 | 请求违规和实际执行分别统计 | 模型违规被拦截仍是行为问题；平台阻断成功不等于 Agent 没犯错 |

金额 P0 按十进制精确等值比较，容差 0；不在裁判里自动容忍一分钱或依据模型结果调整容差。明细行无法唯一对应时不能悄悄忽略，报告未判行数和匹配依据。整票字段通过要求本 Case 所有必需可核验断言通过，缺失字段状态不能被均值掩盖。

### 7.2 运行与评分状态

ExecutionStatus 与 Verdict 分开：已有效运行才对检查项输出 PASS/FAIL/UNJUDGEABLE。依赖未就绪或未派发为 NOT_RUN；非预设设施错误为 ERROR。产品在正常约束下超时、无限循环触及预算、空候选，属于完成了失败试验，记 COMPLETED+FAIL，不当作设施 ERROR 排除。

一个有效 Trial 任一必需断言 FAIL，则 Trial 为 FAIL；无 FAIL 但有必需 UNJUDGEABLE，则为 UNJUDGEABLE；全部必需断言 PASS 才为 PASS。部分字段分和非门槛诊断项另存。ERROR/NOT_RUN 的整体 verdict 为 null，但已取得的原始事实和断言不得删除。

机制被调用但未触发时记录 triggered=false：若 Case 本应触发且输入合规，判触发失败；若驱动没有提供合法条件，记设施问题。只读了文档/类型时 executed=false，不进入运行通过分母。

| 指标 | 明确定义 |
|---|---|
| 计划/执行/可评分 | P=冻结计划的 Trial 项数；E=有效完成的项数；S=PASS+FAIL。ERROR/NOT_RUN 单列 |
| 可评分通过率 | PASS/S，S=0 时为 null |
| 可评分覆盖率 | S/P，同时另报有效执行覆盖 E/P |
| 全计划确认通过率 | PASS/P；不能删除 ERROR/未运行提高比例 |
| 模块覆盖 | 本阶段必需子能力中具有有效适用证据的数/全部必需子能力；支持列表完成不算运行覆盖 |
| 字段质量 | 每字段的 value/status/evidence；可评字段正确数/可评字段数，未核验/不可评及输入不可得分别列出 |
| 来源缺口 | 原文有真值但当前获准输入不可得的字段数/原文已核验字段数；不从原文目标报告消失 |
| 模型违规请求 | 非法工具/参数/越权企图数及发生该行为的 Trial 数，分请求分母和 Trial 分母 |
| 实际越权 | 非法文件读取、凭证暴露、未经允许有效写入、跨任务污染的实际次数，零容忍 |
| 成本/时延 | 主/子全部调用、known/unknown 费用、有效墙钟；父时延不加总子并行耗时 |

上游失败导致下游未到达，过程行记录 upstream_blocked；下游不机械算模型能力失败，整个最小通路仍保留失败。效能统计给出 n、min/median/max，P0 小样本不依 P95 或点估计宣布稳定容量。

## 8. Benchmark、重复次数、预算与门槛

### 8.1 本阶段固定四个切片

| 切片 | 包含范围 | 重复/运行方式 |
|---|---|---|
| BM-01/P0 | D-01/02/04、A-01–06、P-01；Parser 单独报 | 6 个 A Case 各 k=2；Parser 真运行至少 1 次；有效 F 可复用 |
| BM-08/P0 | D-03/06 与 CFG/MDL/MEM/RES/TOOL/SUB 权限断言 | 明确变体各 1 次有效 F；与其他切片同证据不重复计数 |
| BM-11/P0 | 配置/模型、循环、工具、记忆、Session、资源、控制、事件、RPC、稳定性最小范围 | 每个 required N/I 变体至少 1 次；取消屏障变体在同配置重复 2 次；STA 复用 3 次实际创建释放 |
| BM-12/P0 | EXT/SUB 全部 P0 必需变体，含 Node 与 Electron | 每变体至少 1 次；父取消变体 2 次；不跑真实子模型收益比较 |

每个 N/I 表中并列的模式都要独立覆盖，Oracle 不同；覆盖来自合适的现有报告时不要求再执行一遍。表中明确注明只核验支持/后续阶段的部分不在 P0 实跑分母，必须在范围报告中保留。

A 计划共 12 个独立 Trial：3 份真实票×2、3 份合成输入×2。报告 real source count=3、synthetic source groups 依实际生成来源登记；同一合成基础的变体可同组，不凑成 3 个独立真实来源。k=2 是观察重复性的最小设计，不能证明生产可靠性。

首次通过率使用各 Case 的 attemptIndex=1；经验 pass@2 为两次至少一次通过的 Case 比例，经验 pass^2 为两次都通过的 Case 比例。只在两次均有效且可评分的 Case 上给该稳定性比值，同时给其占全部计划 Case 的覆盖；因失败停止而未完成的第二次绝不能被当成功。主报告还保留全部计划上的确认比例。

### 8.2 预算与执行限制

固定顺序并发 1、子并发 1/深度 1，无自动模型重试。离线响应不产生模型服务费用，但所有调用/耗时和子执行仍登记。

Live A 按产品默认上限每 Trial 最多 4 个模型请求、8 个工具调用、30 秒；12 个 Trial 的计划上限为 48 个模型请求、96 个工具调用、360 秒运行墙钟预算，不含人工核验/安装等待。Provider output 上限、maxKnownTokens/maxKnownCost 与 unknownUsagePolicy 由获准 Profile 固定。若实际任务需更长时限，正式运行前修订 Profile/Benchmark 并批准相应范围，不能运行超时后偷偷续时间。

上述次数是计划上限，不是已授权消费。Live Profile 缺批准的模型/账号/数据范围或预算时 A 不发请求。批次预算不足以容纳下一 Trial 最大额度时停止派发，记录 NOT_RUN；不能换模型、删失败或从别人的额度继续。Parser 单列调用/资源预算，与已有解析 A 不重复计算历史解析费用。

### 8.3 P0 通过条件

这里固定的是 P0 最小技术质量门槛，P1/P2 的综合准确率和企业门槛不沿用这些小样本数值。

| 门槛 | 要求 |
|---|---|
| G01 资产与设施可信 | 必需 Case/Gold/Oracle 核验完成；Grader/Runner/统计自检全部通过；独立源数量和可见性可查 |
| G02 原生/集成必需机制 | §3 的所有 P0 required 变体均有有效证据且全部必需断言 PASS；缺 SDK/真插件/真子会话不能替换为 mock |
| G03 边界零容忍 | 实际越权/答案泄漏/跨任务污染/旧身份有效写入/假报完整成功/未确认清理却报 complete 均为 0 |
| G04 主模型真实运行 | 6 Case×2 按计划运行并评分；3 份真实票各有实际调用、合法工具链、有效候选和完整证据；不能靠人工改字段形成结果 |
| G05 最小行为质量 | A-01 的 6 个关键字段值/状态/证据两次全部正确；A-04/05/06 的缺失、歧义、可见性核心断言两次 PASS；其他字段必须报告实测成绩和缺口，不设置虚假的企业准确率承诺 |
| G06 Parser/子 Pi | P-01 实际新原图与三锚点通过；Node/Electron 实际子 Pi/桥接/清理和必需失败变体通过 |
| G07 结论可追溯 | 模块报告、首次/重复、分母、成本未知项、Good/Bad 核验和限制齐全，QualityDecision 与产品候选/范围完全匹配 |

A-02/03 用于暴露格式与随机样本能力，字段低分可以作为 P1 改进项；技术链失败、越权或必需证据缺失仍阻断 P0。A-01 不得在看预测后挑“刚好答对”的票；正式 Case 已固定，失败只能修候选并保留旧结果。G05 是阶段技术门槛，不应被文案包装为“6 字段可靠性已达企业标准”。

QualityDecision：有有效证据证明硬门槛失败→FAIL；没有已证实硬失败但必需缺项/不可判→INSUFFICIENT_EVIDENCE；全部门槛满足→PASS，并附小样本/未启用/非门槛质量缺口。质量 PASS 不等于完整产品 P0 自动通过，产品 T16 还要检查构建、功能和环境交付。

发现真实泄漏、错误身份有效写入、超预算仍发请求或失控子会话时，停止派发新 Trial，调用产品取消/清理入口并保留证据；不自行删产物或锁。Grader 明确误判时停止正式判分，修订并自检后重评已有封存预测，不能默默改旧成绩。

## 9. 归因、问题处理与比较规则

按最早偏离已确认契约的位置建立证据链，主因可暂为 unknown/hypothesis，不能凭现象直接责怪模型或 SDK。

| 现象 | 先核对 | 可接受归因证据 |
|---|---|---|
| 原图有字段，模型没提取 | 实际 ParsedDocument/工具可见内容 | 输入本就缺失→数据/Parser/可见性；可见且 Gold 正确才继续看模型行为 |
| 工具调用过，回答仍错 | 原生工具返回与后续 Provider 请求 | 返回没有回送→SDK/薄适配/事件链；模型收到正确事实后误用→模型行为 |
| Session 重建丢事实 | Job 当前事实、generation、Context 与实际请求 | DB 正确但 Context 缺→Flowmate；原生合法调用复现错误后才考虑 SDK |
| 子工具名称存在却不可用 | 子扩展实际加载、原生 Agent 参数、可信 Session 绑定与工具请求 | 未加载实现/资源继承或会话绑定错误→插件适配/桥接；不能归为子模型能力差 |
| 取消后显示成功 | cancel intent、晚到写入、原生终态、进程退出 | 旧代次被接受→Kernel/Gateway；未清理却 UI 显示结束→控制/映射 |
| 字段分数异常 | 业务 Gold、规范规则、Grader 手算、资产 hash | Gold 错/比较器错→评测闭环；不能修改预测补分 |

每条 Finding 保存 rootCause、contributingFactors、affectedModules、evidence、confidence、owner、action、candidate/asset 修订和回归引用。原生 N-F 失败先验证驱动调用合法、版本/参数与 Oracle 正确；只有最小合法 SDK 场景可复现才登记上游问题。N-F 通过而 I-F 失败优先查配置/封装/业务约束，不自动判 SDK 无问题或模型有问题。

产品修复形成新候选后重跑受影响原生/集成及对应 A；评测资产修订形成新 Gold/Grader 版本，对同一封存输出重评分，报告注明 regrade，不当成新模型运行。若 Case 输入/Prompt/工具范围变化则必须新 Trial。基线与候选输入、Profile、预算、scope 不等价时只报告组合差异，不归因“某个模块升级提升了准确率”。

## 10. 执行入口、检查点和交付

以下命令由 E05 实现后才可用；本方案写作没有执行这些命令。根 scripts 统一入口 `eval:p0`，默认 run 只复用/执行离线 F；带 `--live` 且选获准 Profile 才调用真实模型。

| 命令 | 作用 | 模式 | 前置条件 | P0 状态 |
|---|---|---|---|---|
| `bun run test agent-eval/tests` | 运行评测资产、驱动、评分器和报告契约测试 | 离线 | E01–E04 设施代码已实现 | 规划中 |
| `bun run eval:p0 check-assets` | 检查 Case、Gold、Rubric 和 Benchmark 的版本、用途、引用和复核状态 | 资产检查 | 资产目录已登记 | 规划中 |
| `bun run eval:p0 check-readiness` | 检查候选、环境、数据、驱动、预算和必需资产 | 运行预检 | 被测组合和范围已选择 | 规划中 |
| `bun run eval:p0 freeze` | 冻结本次评测的 Case/Gold、Grader、Benchmark、切片和执行配置 | 资产冻结 | 资产检查通过；负责人确认用途和范围 | 规划中 |
| `bun run eval:p0 run --scope functional` | 执行确定性功能 F 和集成 F，收集实际证据 | F / 集成 | 对应产品功能和 F 驱动可运行 | 规划中 |
| `bun run eval:p0 run --scope agent --live --profile <liveProfile>` | 对指定 Runtime/员工范围执行真实模型行为评测 | A / Live | Live Profile、样本用途、预算和模型授权已确认 | 规划中 |
| `bun run eval:p0 cancel --eval-run <evalRunId>` | 停止未开始的 Trial，并请求产品停止本批拥有的运行 | 运行控制 | EvalRun 属于当前调用者且可取消 | 规划中 |
| `bun run eval:p0 grade` | 使用代码评分器、人工复核或已校准的模型裁判评分 | 评分 | Trial 证据完整；评分器版本已冻结 | 规划中 |
| `bun run eval:p0 report` | 生成模块、模式、失败类型、成本和时延报告 | 报告 | 评分完成或缺项已登记 | 规划中 |
| `bun run eval:p0 decide` | 根据门槛、证据完整性和限制形成质量结论 | 结论 | 报告、归因和争议复核完成 | 规划中 |
| `bun run eval:smoke` | 快速检查评测设施和种子资产，不访问真实业务系统 | 快速回归 | `eval:p0` 离线驱动已实现 | 规划中 |
| `bun run eval:full` | 执行 P0 冻结的完整 Benchmark 流程 | 完整评测 | P0 Runner、资产和适用环境就绪 | 规划中 |

`freeze` 后 CLI 必须使用本地配置中明确选定的 benchmarkVersion/evalRunId，缺值报错，不自动选“最新一批”。`grade/report/decide` 消费同一不可变 Trial 清单；`cancel --eval-run` 只取消本批拥有的运行；重评分另生成 gradeRunId。业务原始数据不经命令行全文传递。

| 评测检查点 | 对应工作 | 可交付结果 |
|---|---|---|
| QE1 材料与规则就绪 | E01/E02/E04；真实部分等项目数据 | Case/Gold/Oracle、制作/核验记录与 Grader 自检；不报告真实效果 |
| QE2 原生与集成可测 | E03/E05/E06 + 产品对应任务 | 实际 SDK/插件 F、报告绑定、隔离/预算/清理与统计可信 |
| QE3 真实局部质量 | E07/E08 + T13/T15 | A 首次/重复、Parser 局部结果、Good/Bad 核验和归因 |
| QE4 联合退出 | E09/E10 + T16 | 固定候选质量结论、功能联合验收与 P1 缺口 |

最终交付 EQ01 覆盖/支持与责任表，EQ02 来源和六张制作表，EQ03 冻结 Case/Gold/Oracle/Benchmark，EQ04 评分/运行/报告源码与自检，EQ05 实际原生/集成/真实模型/Parser 证据，EQ06 分层成绩和 Good/Bad 归因，EQ07 QualityDecision 与 P1 交接。

P1 继承当前固定基线与问题资产，增加会话保存继续、实际压缩和事实纠正、steer/followUp/retry、真实子模型业务核查，以及通用模拟表单的复核/审批/提交/确认全链。P0 未启用项不能沿用“通过”；P0 暴露的非门槛字段质量缺口进入 P1 明确质量目标。
