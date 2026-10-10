# Flowmate 领域词汇

> Deep Research当前实施范围：仅用户选择的本地文本／Markdown和已有解析资料；本轮不实现联网搜索／网页提取，也无需Tavily key。核心设计见[主方案第19章](docs/spec/00_Flowmate完整方案_v1.md#deep-research)。

**Deep Research核心价值与设计：** 用户确认复杂问题的研究计划后，工作流组织资料获取、综合与证据核验，交付覆盖／依据／局限可查看的保存报告。核心为研究规划→能力执行→证据收集→Agent综合→证据报告→持久化，复用Pi SDK／现有Runtime，详见[主§19.1–19.2](docs/spec/00_Flowmate完整方案_v1.md#research-core-chain)。本地研究产品已接合；研究质量仍待独立评测验证。

> **2026-10-10 Deep Research现行交付：** P1–P14→P15 Deep Research→独立统一评测→P16 Evaluation桌面→P17 Host & Packaging。[主方案§19](docs/spec/00_Flowmate完整方案_v1.md#deep-research)、[P15目标](docs/spec/P15_目标方案_v1.md)、[P15计划](docs/plans/P15_实施计划_v1.md)、[评测总计划](docs/eval/05_Flowmate_Agent评测分阶段实施与操作手册_v1.md#manual-route)。桌面在Chats之后新增独立Deep Research，研究列表／新建／Plan、Evidence、Report及右侧关联Session。原50／10＋研究12／4＝62／14，原33项＋研究6项＝39，Runtime24另报；本地研究产品已交付，证据见[P15实施记录](docs/plans/P15_实施计划_v1.md#p15-engineering-delivery)；研究评测工程及正式数据仍待实施，现有readiness=false保持，历史日期／成绩／Runtime T15/T16不改。

**2026-10-09 命令菜单与三栏布局当前状态：** 本轮已实现 Renderer 共用 skillIntroduction，十六份内置 Skill 在 Skills / Settings → Skills / 斜杠菜单中显示一致英文介绍和完整提示；全文匹配回退规则、原作者文件及模型索引身份保留。usePanelLayout 沿用 CSS Grid、两条 8px Pointer Capture 分隔线及键盘调整，独立 flowmate.panel-widths 偏好在刷新/重启后恢复，存储异常容错；240/380 默认、200/300/360 下限、1200/1080 响应式及 680 容器单列规则已通过真实 Electron 验证。显式调整固定另一可见栏当前宽度，隐藏64/44px不覆盖展开偏好；主聊天 DOM、草稿及两个正在执行子任务不重建或额外请求。标准门禁 exit0：typecheck/fresh build、Unit356/0、Integration1341/0、Electron101/0（10.3m）。420项源码/配置/资源/测试门禁前后指纹一致，2项CSS/HTML构建前后指纹一致，48份Skill作者文件SHA-256不变。独立审查的另一栏自动扩张、次指针提前结束和小数响应式断点均有RED→GREEN并复核关闭。见 [实施记录](docs/plans/2026-10-09_命令菜单英文与三栏调整_实施记录.md)。未新增依赖/公共API/迁移；保留此前未提交成果，本轮未提交或推送。以下旧状态和成绩继续作为历史记录。


**2026-10-09 当前工程状态：** Skill/输入触发/Subagent 联合修订已交付，类型检查、Unit 353/0、Integration 1341/0、桌面构建及 Electron 100/0（9.8m）；同次标准门禁退出 0，417 项前后源码指纹一致。见 [实施记录](docs/plans/2026-10-09_Skill输入与Subagent_实施记录.md)。现行 Agent Tool 位于 Core，READ/parallel p13.2；三入口最终共用真实 Tool，父子独立 Pi SDK 会话，最多四个 owned child、第五 busy。两种内置 Markdown 角色、用户 CAS 覆盖、四个管理/查询 API、四组斜杠菜单、实际 Command/Template 身份与 Assistant 卡片均已接通。Schema18/018 保留根唯一占用，停止未确认不释放。Skill Hub 七模块、十六份英文展示资源、实际 Readiness 索引/16 KiB/渐进读取及扁平 Prompt 作者包保持；原十一份33文件 SHA-256 不变。十五调用历史压力问题已修复并通过完成/预算/取消验证，批次缓存不跨写或交易；旧83–100秒失败记录仍表示修复前事实。旧日期与单子/固定角色/作者版本层状态均是历史。未运行付费模型、正式 Benchmark 或正式用户库迁移，未提交/推送/合并。

2026-10-08 SKEN11 当前状态：在 codex/hide-assistant-inputs、HEAD e1130ec 完成英文介绍展示与五份只读发票Skill，当前库十六份，新增默认关闭且无v1作者一级。原十一份33文件SHA-256与入场完全一致；只在ResourcePage的Skill分支按原介绍全文匹配英文，列表/title/详情、两入口及中英文搜索共用，变更或未知介绍回退。新五包真实工具依赖5/5/7/5/5，不写候选/接受/导出/Fill；核心API/DTO/Hub/工具注册不变。定向Core/SDK/HTTP 19/0、288断言，Electron资源4/0；最终同次标准门禁exit0：typecheck/fresh build、Unit353/0、Integration1322/0、Electron99/0，399项源码前后指纹 da95db6c94bc4c13678fa8c069aea4691b1bb938d115f2ea6fed930d9c7b9349。独立只读审查无本轮需修复缺陷；额外十五调用批量读取二次HTTP/二十receipt后Run未及时结束、诊断取消83—85s，根因与基线未定位，未宣称已修复，逐份三调用通过。模型语义遵循仍未评测。详见 [SKEN11记录](docs/plans/P11_实施计划_v1.md#2026-10-08-sken11-英文介绍与五份资源实施记录)；前序HUB11/SKUI11的十一包及成绩保留历史范围。变更在当前工作区，未提交/推送/合并。

2026-10-08 HUB11 当前工作区状态：分支 `codex/hide-assistant-inputs`，起始/当前 HEAD `e1130ec`，本轮未提交、推送或合并。Core 原资源服务拆成 `skill-hub/` 七个实际模块；两个自定义 READ 工具放在 `employee-invoice/src/tools/` 并单独组合。作者 `resources/skills/<id>/` 无版本一级，原 invoice 身份/内容保留并新增十份默认关闭的 SOP；manifest 版本、固定 Bundle 版本路径和 journal v1 兼容。Pi 原短索引/system 与冻结工作区/user 链继续复用，增加专用读取器独立索引模式、实际读取反馈与原请求证据；子 READ 可见集合不扩大父范围，Fill 唯一工具不变。定向真实 Core/SDK/HTTP/SQLite 与十一包 Electron 管理已验证，独立审查的二进制文本边界已通过 RED→GREEN；最终同次标准门禁 exit 0：类型检查、Unit353/0、Integration1317/0、fresh build、Electron98/0；383项源码前后hash同为 a543f96be37ba66287c059b90e556de31a5bcd3f2981a81074d3c16ff43c033e。方案/任务/验收及入口记录已最终化，保留本地日志和未提交工作区。历史 Prompt 正文标签可能显示 Skill body，列为待处理小项。详见 [HUB11](docs/plans/P11_实施计划_v1.md#hub11-07标准门禁审查与交接)，下方 UI11 与旧日期结果不能替代本轮成绩。

当前设计以 [产品主方案](docs/spec/00_Flowmate完整方案_v1.md)、[评测主方案](docs/eval/01_Flowmate_Agent评测总方案_v1.md)和[数据制作方案](docs/eval/02_Flowmate_Agent评测数据集制作方案_v1.md)为准。路线是 Agent Engineering + Invoice Product + Deep Research + Agent Evaluation；核心为 Agent Harness / Runtime，不以完整企业后台为目标。此前 P14 工作基线 HEAD 13c83028f3342174d25363230f322050bf2330d7 已包含 P1—P13 工程接合及迁移 001—017；P14 此前在 codex/p14-invoice-workflow 实施。下文 P8 的附着分支、当时 D:仅同步文档和未合并记录保留为历史范围，不能作为当前代码状态。后续阶段按主方案边界实施。P3 唯一正式发票输入目录为 `data/invoices/agent-input/`，业务取证读取已登记解析、候选来源仍按其版本/引用核验；普通 Run 的 SDK read 支持文本/图像，图像向模型交付仍核验 model.input，不能把“原图仅 UI 查看”的 P3 业务历史限制泛化成 SDK 无图像能力。旧连接的真实模型 A20 请求、失败/复验和样例观察已记录，新配置的连接/认证/协议兼容性按 P3 实施计划中的实际工程证据解释。模型行为、业务质量与真实语义评测统一依评测主方案§12.1，包含Runtime专题，全部等P1–P15对应产品能力、公共入口、采证及适用工程门禁就绪后才制作／核验正式Case／Gold、真实校准、Smoke／对照／Benchmark。子集提前准入例外已撤销；阶段只依工程交付，未评测不是阶段未完成项，旧样例不作为退出条件。

2026-10-08 当前工程状态：在 `codex/ui-workbench`、起始 HEAD `66107c182535fe3e2336d1023499849edd60aeec` 完成界面职责修订。Chats 保留工作目录/会话，诊断归 Settings → Performance；Prompts 为单轮 Provider 优化工作台，窗口草稿可编辑/复制/填入聊天且不自动发送；固定业务 Prompt 选择在 LLM 高级区。Skills 为真实依赖就绪度及四筛选，Extensions 为登记插件列表与实例/历史详情，Settings 五个标签复用原状态；Assistant 删除指定辅助控件，新 Send/Fill 使用默认预算，公共覆盖、显式 Skill 和旧原输入冻结仍有效。同次标准门禁 typecheck/fresh build、Unit 352、Integration 1309、Electron 98 全部通过；本次记录见 [UI11](docs/plans/P11_实施计划_v1.md#ui11-实施记录)、[UI03](docs/plans/P3_实施计划_v1.md#ui03-实施记录)、[UI05](docs/plans/P5_实施计划_v1.md#ui05-实施记录)、[UI12](docs/plans/P12_实施计划_v1.md#ui12-实施记录)。改动仍在本地分支工作区；既有迁移/依赖与正式评测门槛保持，以下旧日期记录解释当时状态。

2026-09-30 P4 实施状态：当前工作区已接入三具名消息视图及严格 schema、原生历史公共查询、008 原生条目 run_id 归属、逐消息完整快照归并与成功保存身份桥；`runtime-pi/messages.ts` 统一原生校验、prompt 格式化和 `projectMessageView` 白名单投影。必要历史失败保留最后已提交前缀并阻断续用。本次 Unit、Integration、标准 Electron E2E、typecheck 及桌面构建工程门禁通过，命令、数量与限制见 [P4 实施计划 §4.3](docs/plans/P4_实施计划_v1.md)；P3 历史数字、真实模型证据和 Benchmark readiness 不由此更新。

2026-10-01 文档同步基线：HEAD `b92c3e89a7ac42ad68f4c6d9cf89fd6f5de7ae2e` 及包含既有未提交差异的工作区，实际 Pi 包为 `@earendil-works/pi-ai`、`@earendil-works/pi-agent-core`、`@earendil-works/pi-coding-agent` 0.85.1。此前同步只核词汇/阶段责任；随后按 P4 未完成项续行实际接合 P14 Fill、原调用应用回执、人工保存/Accept/三格式导出及必要 P5 输入子集，新增工程证据见 [P4 实施计划 §5](docs/plans/P4_实施计划_v1.md)，普通原生工具和终态收尾证据仍分别见 [P1 实施计划 §11.7/§11.8](docs/plans/P1_实施计划_v1.md)。本轮不追认原 P4 首次交付或历史数字；其余未实现工程能力按所属阶段交付。真实模型录入行为和业务质量统一归评测主方案 §12整体启用后的评测，不另设阶段质量任务，也不依赖用户临时排除。

2026-10-02 P5 实施状态：当前工作区已接通prompt／steer／followUp与逐输入冻结、原键查重／查回、真实原生消费和首个结果关联；投递与处理两组状态分开提交，取消／收尾／恢复不重投未知输入。空闲归档解除及本期同Session合法回复分支已接桌面，位置提交／Adapter缓存确认失败阻断，未完成Delete标记跨重启保留。011兼容旧台账；首次最终类型检查、Unit196项、Integration393项、桌面构建与Electron25项通过，故障与命令证据见 [P5 实施计划 §5](docs/plans/P5_实施计划_v1.md#5-交付与当前状态)。Fill保持空闲显式新Run，同目标并发只固定一次原身份。此工程记录不改变旧P1—P4成绩或统一质量评测边界。

2026-10-02 用户故障补充：只读核验真实Run在第12次调用保存候选后耗尽模型请求预算，候选已提交但回执未进入下一请求，不能宣称Run成功或候选未保存。新P3工具Run（材料／普通目录／Fill）固定16次请求，Core冻结／SDK实际闸门／终态校验使用同一准备预算，用量v2支持至16条；历史12只读兼容，P5纯Chat12／P2 1／工具24及权限、停止、保存规则保持。桌面删除“cannot continue safely”底部提示，后端不可用状态和Send禁用保留；错误文案准确说明预算或未确认目标并指向Processing History。本次最终标准门禁exit0：类型检查／构建、Unit196／Integration397／Electron25通过，故障与完整复验证据见 [P5 实施计划 §5.4](docs/plans/P5_实施计划_v1.md#54-用户反馈后的晚保存故障修复2026-10-02)。不重写或重投旧Run，不新增迁移或质量结论。

2026-10-02 Run43反馈补充：正式库只读证据确认该Run已使用16次模型策略，实际15次模型调用、24次工具请求后tool_budget_exceeded，Job8未保存候选。具体错误包括ambiguous只有一个备选、缺notes／多余netAmount2，以及部分来源version遗漏`:parsed-v3:`；原始和最终参数逐字段版本未被转换改变。参数与候选拒绝改沿现有Error.message返回有界code／字段路径／权威documentRef，严格来源和保存条件保持；完整version及逐字quote规则写入工具描述。Assistant隐藏Runtime未就绪的底部技术提示，保留Models／Settings诊断与后端资格／Send／Stop约束，工具上限改为具体错误。标准门禁exit0：类型检查／构建、Unit196／Integration400／Electron25通过，三种受控修正场景及真实SDK／SQLite证据见 [P5 实施计划 §5.5](docs/plans/P5_实施计划_v1.md#55-run43候选拒绝反馈与assistant技术提示修复2026-10-02)。未再次增加预算、重放正式Run或运行真实模型与质量评测。

2026-10-02 Runtime统一门槛修订（先前T09文档记录）：主方案§5.6／第8章及原五部分T09–T18保留动态预算、beforeToolUse／afterToolUse、跨Run观察／可靠性经验、诊断与合法恢复。该次静态核验已见contracts／Settings默认、新Run budget解析冻结、Executor前后阶段／统计、Recorder／Repository观察持久化和queryCandidateCommit；012已创建注册，24／16／10秒是默认值，不能写成不可配置现状。该次未跑产品验证、不核正式库版本、不认领T10–T18通过；当时存在的评测Adapter／holdout及24条draft和“后续修复子集放行”安排，已被本轮删除提前评测实现与数据的决定替代，不再作为当前状态或待保留资产。

2026-10-02 Runtime产品工程交付：T10–T14及T17已完成，实际核验新Run预算／原身份先查回、SDK与Host拒绝两路、实际反馈容量、终态与观察事务、提交后响应丢失、after修改／异常、冻结统计与经验，以及桌面未知受理查询与一次性预算消费。最终标准入口 `bun --no-env-file run test` exit0：类型检查、Unit203／Integration459／Electron25和桌面构建通过，证据见 [P3实施计划§12.4](docs/plans/P3_实施计划_v1.md#124-runtime-产品工程交付与新证据2026-10-02)。隔离库迁移与故障已验，正式用户库本次未打开；未调用付费模型，未恢复评测数据或配套。整体P1–P16与评测就绪不由此认领，T15／T16／T18继续延期。

2026-10-03 P6 产品工程交付：013 runtime_events、原对象状态／事件同事务、最外 COMMIT 后唤醒、H 前后补读、连续 C／独立缺口展示 D、安全 Tool 公共查询及 Activity／Run／Trace 已接合。Main 预分配订阅 UUID，原 owner／frame／epoch 清理；Host 8／owner、64 总量、原生 90s 租约，App 一页 FIFO 与 2s 纯查询。独立审阅修复和新增真实 SQL／Host／Renderer 证据后，标准 `bun --no-env-file run test` exit0：typecheck／fresh build、Unit239／Integration546／Electron43，245 源码指纹无差异，详情见 [P6 实施计划 §5.5](docs/plans/P6_实施计划_v1.md#55-2026-10-03-独立审阅修复与最终交接)。隔离新库／旧12库升级13已验，正式用户库未打开；补读／重连不执行模型、工具或输入。正式评测仍等待完整产品；该P6验收时P7产品尚未实施。旧调查和失败记录不改写。

2026-10-03 P7 产品工程交付：合法候选字段／明细／parsed页块定位、共享无写材料核验、014兼容迁移、CAS更新及确定失效清理／暂不可读阻断、完整现场恢复已接通。初始与逐输入冻结Context及原promptText沿实际Pi原生user／HTTP传递，当前页面切换不改旧依据；第七Workspace使用唯一epoch/token/revision确认状态及身份核验，空保存Session不选最新，恢复／补查不请求模型或重放。人工保存用当前revision与固定对象basis，Fill保原应用闸门。固定源码标准入口exit0：typecheck／Unit249／Integration615／fresh build／Electron51，267文件指纹一致，原失败及限制见[P7 实施计划 §5.4](docs/plans/P7_实施计划_v1.md#54-实际实施与交叉审阅记录)。正式用户库未打开、未调用付费模型或质量评测、未提交Git。P8实际选材／ContextSnapshot、P9完整历史继续各自实施；旧阶段成绩不改写。

2026-10-04 P8产品工程交付：在`C:/Users/yyc/.codex/worktrees/p8-context-engineering/Flowmate`，分支`codex/p8-context-engineering`实现真实受管选材、015不可变快照／原事务Input关联、稳定entry桥与原请求采证、Tool／Candidate历史依据、三公共只读查询及Session Details／Context。T01—T10独立审查及F8-01—24适用证据完成；固定HEAD`895c41a19cd43b4ab67e784fb9928b8283c028ec`的同次标准入口exit0，typecheck exit0；Unit 291 pass／0 fail／2401断言／34文件；Integration 802 pass／0 fail／7824断言／58文件；fresh Main／Preload／Renderer build完成；Electron 60 passed／0 failed／9文件／1 worker，287文件指纹一致。原失败及限制见[P8实施计划§5.3](docs/plans/P8_实施计划_v1.md#53-最终同次门禁与阶段交接)和[P8目标方案](docs/spec/P8_目标方案_v1.md)。旧请求／Tool／Candidate读原snapshot/request pair，旧NULL保缺口；查看／重启不重放，新合法Input才恢复原native种子。两个OpenAI codec的保存／消费／包含／传输／响应分事实，不能证明语义采用；正式用户库／付费模型／质量评测未运行，P9／P10／P11按边界交接。D:仅同步四份文档，main产品与用户prompt保留；代码未merge／push。

本轮统一评测约束：严格依评测主方案§12.1，原flowmate-agent-v1的50／10、新flowmate-research-v1的12／4与单列Runtime专题24／8／16均为P1–P15对应产品能力／公共入口／采证和适用工程验证就绪后的设计。已提前制作的Runtime Case／Gold／manifest／配置及其配套Adapter、校准、holdout与评分增量已经删除，不归档、不改名、不改称工程夹具；当前productAgent.readiness=false、prepare拒绝。T15／T16配套评测设施延期至整体就绪后；当前各阶段继续产品工程实现与T17工程交接，退出不依赖这些任务、正式数据或语义成绩，不能独立开启T18。原有框架合成测试夹具与产品工程测试保留，不再依赖被删除资产。整体就绪后再实施T15／T16、制作核验T18正式Case／Gold、真实开发与必要Judge校准、冻结配置／数据／统计／经验并执行Smoke／对照／正式评测；calibration=null、CLI／环境变量或空能力列表不能绕过门槛。跨Run产品观察冷启动／不足／失败用工程验证，不主动调用模型补早期样本。未来四组安全边界一致、留出不反哺；正式八Execution Judge上界57344及额外校准／重跑累计设计保留，未执行不认领效果。旧样例及历史工程记录保留原日期与范围。

2026-10-07 P14 实施：当前工作分支 codex/p14-invoice-workflow，起始 HEAD 13c83028f3342174d25363230f322050bf2330d7。Pi 0.85.1、pi-subagents 0.19.0 及锁定补丁，迁移仍 001—017。行来源映射贯通内存、inspection 与人工新版本；共享原导出查询核实际文件；Native 另存为、逐字段来源／原文复核和独立用户 Discard 已接通。工程门禁／审查及 F14 实际证据见 [P14 实施计划 §4.4](docs/plans/P14_实施计划_v1.md#44-2026-10-07-实施记录)，职责、状态、接口、存储和限制见 [P14 目标方案](docs/spec/P14_目标方案_v1.md)。最终同一固定源码标准门禁已通过：typecheck／fresh build、Unit 352／Integration 1308／Electron 95 全部零失败（P14 17项）；一次整枝审查的三个 Important 均经真实 IPC 反例 RED→GREEN，前后源指纹一致。P14 工程完成；内存草稿不跨重启恢复、查询不重放、受管登记与外部副本分事实。正式用户库／付费 Provider／Judge／模型质量评测未运行，P15／P16 按主方案整体准入边界交接。

| 词汇 | 定义与边界 |
|---|---|
| Application Core | 薄产品入口与协调，连接 Runtime、Session、存储与发票服务；不重写 Pi Loop |
| Runtime / Harness | Runtime 执行真实模型/工具循环；Harness 接合输入、上下文、资源、范围、停止、保存与验证 |
| RuntimeBudgetOverrides | 已实现新Run请求budget可选maxToolCalls/maxModelCalls/toolTimeoutMs，原timeoutMs/stopGraceMs保留；任务默认→Settings→新Run覆盖→准入冻结总预算，每轮按事实计算已用／剩余。多输入共享，Steer/Follow Up不增权限或额度；原键查回先于当前配置解析 |
| Request identity version | 已实现SessionInputContent外层v2，既有JSON可选requestIdentityVersion:1及originalBudgetOverrides记录budget/timeoutMs/stopGraceMs原覆盖意图；缺省走旧hash。身份版本与正文/Settings/Schema版本分开，不新增输入列或重建011 |
| beforeToolUse / afterToolUse | 已实现的Executor内部阶段，不是公共Hook。首次可信observeRequest只记raw并同步计数，SDK准备后才固定final；before最终核权限、参数、取消和await后的期限，领域提交前再核。after在execute真实收束后查证提交、校验输出／停止／计时并固定终态及观察；timer或Promise返回不证明全部原生进程停止 |
| Pi beforeToolCall / afterToolCall | 0.85.1实际SDK Hook。prepare/Schema→before→execute→after正常顺序；SDK准备／before的immediate拒绝跳过SDKafter；Host包装内拒绝仍经过真实SDKafter，但不补造业务execute／Hostafter或计时。包装保留原handler且每Session一层；after不能反转权威失败/回执，不替代Host停止或模型消费证据 |
| CommitObservation | 已实现提交查证三态none_confirmed/committed/unknown，不是业务生命周期。原toolCallId/runId/sessionId窄查询核候选，查询失败不等于空；候选事务与ToolCall终态事务独立，已提交异常保留且不重写 |
| RuntimeObservation | 012新增tool_calls.runtime_observation_json和groupKey/id部分索引，观察v1 Schema／DTO与采证读写已接合并通过新工程验证。记录before/after结论、阶段、真实耗时、期限和提交查证；旧NULL不回填，与首次固定终态同事务。后续SDKafter／历史／投递失败走既有Delivery／Run错误，不覆盖固定观察，不复制正文 |
| Dynamic tool timeout | 已实现最近200真实开始尝试、至少20完整成功停止样本的nearest-rank P95×1.5；最近20异常则回配置。仅结构化PURE/READ，新Run冻结，受配置及Run/原生更短期限约束；统计失败不放行未知副作用 |
| Tool reliability experience | 已实现已有调用事实的有界兼容摘要，下一Run冻结，仅当前获准工具；参数经验按模型/提示版本/任务隔离，不含私有材料，不凭文本/时间推断恢复因果或编造概率；不增加长期知识库、经验表或第二历史。真实模型采纳效果仍等待完整产品后的统一评测 |
| WorkspaceSelection | formatVersion=1是定位格式；候选字段／明细以id和sequence固定，source只指真实parsedArtifact/page/block；Document字段形状保留但语义拒绝，未保存表单副本不作为定位来源 |
| Workspace revision / restore | revision为safe integer现场CAS版本，与P6 cursor分开；同值不增，确定失效清理一次+1，暂不可核验保原事实并受阻；availability-only修复不增现场版本。恢复不请求模型、不重放输入，不证明P9历史恢复 |
| Job | 一项发票用户任务，保留必要输入、候选及进度，不是复杂 Workflow |
| Run | Runtime/Run Repository 负责 created/running/completed/failed/cancelled；停止意图不是第六个持久状态，终态不复活；实际停止/必要保存各自核验，显式重试或恢复创建新 Run |
| Session | SessionService 负责 active/archived 与历史归属；可用性/模型资格分别核验，不复制 Run 五态，完整历史不等于一次 Run |
| Session Input | P5公共入口接prompt/steer/followUp，Fill仍只空闲显式新Run。投递queued/consumed/failed/cancelled/delivery_unknown与处理pending/completed/failed/cancelled分开；同Run多个inputId分别关联真实user和固定首个最终result，Run completed不能批量完成。011扩展既有台账，原Session/clientSequence+hash查重；Desktop原modelId等请求由Host摘要冻结、先查原键再核当前配置/凭据，未知查询须匹配原请求才能清稿。真实user/消费、最终assistant/result引用分别同事务；processing另核该批目标与必要保存，消费未知不重投，启动恢复不重放 |
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
| ContextSnapshot | 某次合法新输入的不可变业务选材，唯一context_snapshots整数ID／Run内sequence；同快照可用于多个请求。Input、旧请求、Tool和Candidate保存原snapshotId／requestSequence；Run当前pointer不解释旧依据，不复制Provider载荷或原生历史 |
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
| F / A / B | 机制、真实Agent行为、发票结果三类判断；阶段只以产品机制、实际链路、失败路径和工程回归验收。包括Runtime专题的所有正式数据与A/B质量评测均等P1–P15对应产品能力就绪，受控工程不证明真实语义；等待质量不构成阶段未完成 |
| Fixture / Live | 受控测试与真实运行方式，不等同 F/A/B 或来源类别 |
| Benchmark / Baseline | 固定测试定义与实际参照成绩分别记录；业务62／14（原50／10＋研究12／4）和Runtime24条专题均继承P1–P15对应产品能力／公共入口／采证／工程门槛，能力子集不是提前准入。提前Runtime草稿及配套评测增量已经删除，整体就绪后才重新制作核验，不制造阶段质量成绩；未运行不叫Baseline |

数据库持久化、历史恢复、错误、取消和质量隔离是核心工程内容。业务终点为候选、人工修正/接受、导出；不包含审批、B2B 写入、组织权限、预算账本或生产治理。

P4 消息快照/权威查询由局部 applyMessageUpsert/mergeSavedHistory 接合：同消息较旧、重复、冲突、ended/saved 后回退及终态迟到分别处理，低序号 run_finished 仍接收；旧 Run 不清新 Run 的 busy/草稿。断流、缺号、saved 丢失先查询消息/Session/Run，同选中 Session 合并在途刷新，失败保留内容与错误，零 prompt/工具重放。P4 的临时接收与 P6 的持久补读分别验收，不新增通用消息状态机或事件框架。

原生双表正文为权威，storage_version=1 是格式版本，008 nullable run_id 仅保存真实归属，旧行不猜测回填。原main基线迁移注册至014；P8附着分支实际注册至015（正式用户库版本本轮未核验）：009为早期空闲Fill输入台账；010为人工候选/业务活动/导出兼容；011以增量迁移扩展原台账三模式/result关联和未完成Delete标记，012仅增加观察JSON列和部分索引，Recorder／Repository及Executor采证读写已接合并通过本次隔离库与事务故障工程核验，013新增关键事件表／Run内序号和真实归属约束，旧001–012不修改，旧Run不补造历史事件；014重建workspace保九字段/FK/id=1，仅开放合法版本1定位JSON，001–013未改，旧Run/Input不回填。015新增唯一不可变context_snapshots、Run pointer／journal及Input／Tool／Candidate原依据列，快照／pointer／Input原事务提交，旧NULL与原正文不回填，001—014未改。原生header/entries/parent/leaf仍是唯一历史，台账不成为第二份UI消息正文或P6事件。快照/P8已在附着分支交付；完整历史/P9、压缩/P10、扩展/P12、子执行/P13仍按所属阶段开放；P14当前工程接合与统一质量结论分开记录，模型录入行为和业务正确性只在评测主方案 §12整体启用后验证，不是P4/P14剩余任务。消息生成、必要保存、Run完成、Job接受及Host实际停止互不替代，模型自述与气泡不能推进业务状态。只读查询、诊断和平台反馈不新增状态、不回灌模型、不重放副作用；同进程执行重送有原在途引用时复用Promise，纯查询／恢复无引用返回原状态。
