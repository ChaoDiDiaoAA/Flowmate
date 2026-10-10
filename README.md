# Flowmate

> Deep Research当前实施范围：仅用户选择的本地文本／Markdown和已有解析资料；本轮不实现联网搜索／网页提取，也无需Tavily key。核心设计见[主方案第19章](docs/spec/00_Flowmate完整方案_v1.md#deep-research)。

**Deep Research核心价值与设计：** 用户确认复杂问题的研究计划后，工作流组织资料获取、综合与证据核验，交付覆盖／依据／局限可查看的保存报告。核心为研究规划→能力执行→证据收集→Agent综合→证据报告→持久化，复用Pi SDK／现有Runtime，详见[主§19.1–19.2](docs/spec/00_Flowmate完整方案_v1.md#research-core-chain)。本地研究产品已接合；研究质量仍待独立评测验证。

> **2026-10-10 Deep Research现行交付：** P1–P14→P15 Deep Research→独立统一评测→P16 Evaluation桌面→P17 Host & Packaging。[主方案§19](docs/spec/00_Flowmate完整方案_v1.md#deep-research)、[P15目标](docs/spec/P15_目标方案_v1.md)、[P15计划](docs/plans/P15_实施计划_v1.md)、[评测总计划](docs/eval/05_Flowmate_Agent评测分阶段实施与操作手册_v1.md#manual-route)。桌面在Chats之后新增独立Deep Research，研究列表／新建／Plan、Evidence、Report及右侧关联Session。原50／10＋研究12／4＝62／14，原33项＋研究6项＝39，Runtime24另报；本地研究产品已交付，证据见[P15实施记录](docs/plans/P15_实施计划_v1.md#p15-engineering-delivery)；研究评测工程及正式数据仍待实施，现有readiness=false保持，历史日期／成绩／Runtime T15/T16不改。

## 当前命令菜单与三栏布局

2026-10-09 本轮界面修订已通过标准入口 `bun --no-env-file run test`：类型检查、Unit 356/0、Integration 1341/0、桌面构建及 Electron 101/0（10.3m），退出 0。方案、审查修复和实际结果见 [本轮实施记录](docs/plans/2026-10-09_命令菜单英文与三栏调整_实施记录.md)；下方旧成绩保留原交付范围。

输入 `/` 后，十六份内置 Skill 的介绍和悬停提示与 Skills / Settings → Skills 共用英文展示；未知或修改过的介绍保留原文。资源正文、身份、Pi 索引和聊天语言保持原合同，选择菜单项仍只修改草稿。

拖动两条栏间分隔线调整导航和 Assistant，中间内容使用剩余空间；宽度在刷新及重启后恢复。分隔线可 Tab 聚焦，左右键调整 10px、Shift＋左右键调整 50px，Home 或双击恢复该侧默认值。完整导航 / Assistant / 中栏最小为 200 / 300 / 360px；窄中栏的配置和 Prompt 编辑转为单列。窗口小于 1200px 时沿用 64px 图标导航，仅右侧可调整；小于 1080px 时沿用 Assistant 浮层，隐藏调整手柄。收起 Assistant 保留此前展开宽度；窗口临时缩小不覆盖偏好。清除本地偏好后恢复默认 240 / 380px，存储失败不妨碍当前调整。

## 当前 Skill、输入触发与 Subagent

2026-10-09 联合修订已通过工程验收：类型检查、Unit 353/0、Integration 1341/0、桌面构建及 Electron 100/0（9.8m），标准入口 `bun --no-env-file run test` 退出 0。完整章节、任务、失败修复与证据见 [实施记录](docs/plans/2026-10-09_Skill输入与Subagent_实施记录.md)。以下旧日期记录保留其原交付范围。

Skills 主页面与 Settings → Skills 共用紧凑列表、英文介绍、依赖计数和真实缺失标签；十六份作者资源位于 `resources/skills/<id>/`。Prompt 作者包位于 `resources/prompts/invoice/`，manifest 仍为 v1，固定 Run bundle 保留版本层。Prompts 页面用于显式 AI 优化，复制和填入只改草稿。Settings 使用 General / LLM / Connections / Skills / Performance；Assistant 已隐藏 Inputs 等辅助控件。

在 Extensions 启用已登记的 subagents 插件，再创建后续会话；已有旧身份可在 Extensions 更新选择。输入 `/` 显示 Skills、Subagents、Prompt Templates、Extension Commands。可用入口示例：

```text
/skill:invoice Review the supplied invoice evidence.
/subagent general-analyst Check the assumptions in this argument.
/invoice-evidence-review Review the current invoice sources.
/parallel-invoice-review Review the invoice with independent checks.
```

发票 Skill 和发票模板需要当前已授权的发票任务；普通聊天可以使用零工具 general-analyst。自然语言、Markdown 模板与真实 Extension Command 共用 Agent Tool。父子都使用 Pi SDK 循环，每个子有独立会话；同一 Root 最多四个前台子，工具只复用父实际 PURE/READ 范围，禁止嵌套/后台/写操作。Assistant 显示真实子任务、状态、结果及单子 Stop，Root Stop 取消全部。自然语言是否委派由模型实际 ToolCall 决定，文本声称委派不算成功。

内置角色在 `resources/subagents/`；Extensions → subagents → Manage agents 可创建/编辑，用户覆盖在已解析产品 runtime 目录的 `subagents/` 中，后续 Run 生效。模板在 `resources/prompt-templates/`，与固定业务 Prompt 分开。018 迁移通过隔离库验证，正式用户库未在本轮打开或迁移。

## 项目与当前阶段

基于 Pi SDK 的本地发票 Agent。当前工作区已实现受控解析材料导入、发票工作台、Assistant 对话及重启续聊、P4 原生消息查询/展示和候选来源记录。普通复核工厂保留13项业务工具，可信桌面另装配第14项填表工具；本轮人工保存、接受和三格式导出接合及工程证据见 [P4实施计划 §5](docs/plans/P4_实施计划_v1.md)。原票供人工查看，业务取证使用已登记解析材料。旧连接的真实模型 A20 请求、失败/复验和样例观察保留在 [P3 实施计划](docs/plans/P3_实施计划_v1.md)；新配置的连接/认证/协议工程记录按其实际范围解释。真实模型自主填表及业务正确性统一归 [评测总方案 §12](docs/eval/01_Flowmate_Agent评测总方案_v1.md#eval01-12)：P1–P15对应产品能力、真实Agent入口与必要采证就绪且工程验证通过后才制作和运行 Benchmark，不作为当前阶段剩余任务。

## 安装与配置

```powershell
bun install --frozen-lockfile
```

模型在桌面 **Models** 或 **Settings → LLM** 配置，两处复用同一设置。选择 Pi 内置供应商和模型后，在页面填写并保存 API Key；现行桌面不使用环境变量或旧 OAuth 凭据代替该 Key。明确选择 **Custom model** 才填写 Base URL、Pi API 类型和实际模型能力。凭据保存在系统加密存储中。评测用的 Judge、Langfuse 可单独配置 [.env.example](.env.example)。

## 启动与使用

在仓库根目录执行：

```powershell
bun run dev                       # 启动桌面应用
bun --no-env-file run test        # 工程验证，不运行 Agent 评测
```

桌面启动、打开页面和保存配置不会自动请求模型。用户点击 **Test connection**、Prompts 的 **Optimize**、Assistant 的 **Send** 或 **Fill with Agent** 才会请求模型，可能产生费用。新会话的 Pi 原生历史保存到 SQLite，可在重启后续聊；升级前没有原生历史的旧会话只读。桌面正式数据位于 `%APPDATA%\Flowmate`，工程测试使用隔离临时目录。

开发时 Renderer 支持热更新；修改 Main/Preload 会先停止当前请求、关闭旧 Host 和 Electron，再构建和启动新实例。构建失败会等待修正，停止未确认会阻止重启。结束开发请按 Ctrl+C，等待关闭完成。

正式发票导入来源为仓库 `data/invoices/agent-input/`。在 **Invoices** 导入并查看 **Original / Parsed / Results**，点击 **Process this invoice** 建立待发送任务，再到右侧 **Assistant** 点击 **Send**。Agent 只读取已登记的解析数据和来源，不发送原票图像，也不运行解析器。**Processing History** 展示候选、来源、问题和操作历史；其 **Delete** 仅从近期列表隐藏处理记录，保留候选与审计。**Chats** 和左侧最近会话均可重命名。撤回材料使用权限后，受影响的会话不能继续请求模型。

候选结果存放在 `%APPDATA%\Flowmate\data\app.sqlite` 的 `invoice_candidates` 表中，字段、明细、问题及来源引用随候选保存；`tool_calls` 和 `business_events` 保留调用与操作记录。生成候选不等于用户接受，接受状态需另行选择。

在 **Invoices → Results** 明确选择未接受候选后，可点击 **Fill with Agent** 通过独立录入 Run 填入固定表单，或点击 **Edit** 直接人工编辑。**Save changes** 有真实差异才追加人工版本；**Accept result** 独立接受已保存版本，随后可导出 JSON、CSV、Markdown。打开、选择、人工保存和接受均不请求模型。未保存副本只存在于当前窗口，离开/正常关闭提供 Save、Discard、Continue editing；未知提交先查询原操作，不自动再填或再保存，重启只恢复已保存候选。

**Chats → Working directory** 可用 **Choose directory** 设置下一次发送的工作目录，或用 **Use Run directory** 恢复默认的 `%APPDATA%\Flowmate\runtime\<runId>\work`。**Settings → Performance → Diagnostics → Refresh tools** 查看当前平台支持的 Pi 原生工具；选择和刷新不执行，仍用普通 Assistant **Send** 发起、**Stop** 停止。目录不是沙箱，平台支持也不保证 Shell／搜索依赖已经可执行，实际缺失由 SDK 返回。

**Settings → Performance** 显示 Runtime 是否可继续，**Check runtime status** 只查询状态。取消受理、回答结束或数据库终态都不单独证明可以发送下一条；实际执行仍占用、必要保存失败或停止证据不足时，Send／Test connection 保持禁用。重启会核验原 Run／工具，不会重放或把未知停止改为成功；缺证据时仍只读受阻，具体实现与工程证据见 [P1 实施计划 §11.8](docs/plans/P1_实施计划_v1.md#p1-state-increment)。

**Prompts** 提供原稿、可选优化要求和可编辑优化稿；Copy 和 Use in chat 只复制或填入/追加草稿，不发送。草稿仅保留当前窗口，重启不恢复。固定业务 Prompt 版本选择在 **Settings → LLM → Business instructions**。**Skills** 用搜索、All / Ready / Partial / Disabled 和开关管理；逐项依赖缺失仍阻止运行。**Extensions** 展示已登记插件，配置启用与当前会话实际加载分别显示，技术与历史证据在详情。

**Settings** 分为 General / LLM / Connections / Skills / Performance。默认运行预算在 Performance；普通 Send / Fill 使用默认值，已受理请求的原预算与身份不变。Assistant 保留消息、真实业务上下文及输入/发送/停止；使用 `/skill:name` 可提出显式技能要求。

**P11 Skills 当前资源库（SKEN11，2026-10-08 已验收）**：共十六份，新增买卖方角色、日期/币种、逐行计算、候选问题分级和人工交接五份只读Skill，默认关闭。Skills / Settings → Skills 的介绍统一英文，列表、完整提示、详情及双语搜索共用；原十一份作者文件、身份、Pi索引、正文及聊天语言保留。黄色标签表示真实缺失依赖，缺项仍不能开启。资源用途与路径见 [资源说明](resources/README.md)，同次完整门禁353单元/1322集成/99 Electron全部通过；已知批量读取结束/取消超时及工程边界见 [SKEN11实施记录](docs/plans/P11_实施计划_v1.md#2026-10-08-sken11-英文介绍与五份资源实施记录)。

**P11 Skill Hub（2026-10-08 工程验收完成）**：具体 Skill 放在 `resources/skills/<id>/`，直接包含 `resource.json`、`SKILL.md` 和参考文件，无 `v1/` 作者目录。保留原 `invoice`，新增十份发票 SOP，默认关闭；编写、依赖、刷新和更新/回退见 [资源说明](resources/README.md)。管理入口共用 **Skills / Settings → Skills**；启用仅影响后续 Run。七个 Hub 模块在 `packages/core/src/skill-hub/`，两个专用工具在 `packages/employee-invoice/src/tools/`，单独注册并沿原 Executor/预算执行。Pi 接收短索引和原工作区 Context，正文按需读取原 Run 固定副本；专用文本读取不执行脚本。最终同次标准门禁 exit 0：类型检查、Unit 353/0、Integration 1317/0、Electron 98/0。工程证据与未验边界见 [HUB11 计划](docs/plans/P11_实施计划_v1.md#hub11-07标准门禁审查与交接)。

本次界面调整的实现和验收见 [UI11 实施记录](docs/plans/P11_实施计划_v1.md#ui11-实施记录)，各页面与预算分别映射 UI03 / UI05 / UI12。

## 文档导航

[产品方案](docs/spec/00_Flowmate完整方案_v1.md) · [P3 目标](docs/spec/P3_目标方案_v1.md) · [P3 实施计划](docs/plans/P3_实施计划_v1.md) · [P1 目标](docs/spec/P1_目标方案_v1.md) · [P1 实施计划](docs/plans/P1_实施计划_v1.md)

[评测总方案](docs/eval/01_Flowmate_Agent评测总方案_v1.md) · [Case 制作手册](docs/eval/02_Flowmate_Agent评测数据集制作方案_v1.md) · [可选 Langfuse](docs/eval/03_Flowmate_Langfuse平台接入设计方案_v1.md)

[工程测试](tests/README.md) · [评测操作](agent-eval/README.md) · [设施测试](agent-eval/tests/README.md) · [源码职责](agent-eval/src/README.md) · [Judge 配置](agent-eval/src/scoring/judges/README.md)
