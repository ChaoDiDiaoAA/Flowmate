[English](getting-started.md) | [简体中文](getting-started.zh-CN.md) · [文档导航](README.zh-CN.md)

# 快速开始

## 准备开发环境

使用 Windows x64、Bun **1.4.4**、Node.js **24** 与 Git。当前工程基线为 Pi SDK **1.4.0**、数据 schema **21**。依赖版本由 [package.json](../../package.json) 和 [bun.lock](../../bun.lock) 固定，保留[必要补丁](development.zh-CN.md#dependency-patches)。模型操作需要服务地址与凭据，浏览界面和运行工程夹具不需要真实模型。

在仓库根目录执行：

```powershell
bun install --frozen-lockfile
bun run dev
```

开发入口构建并打开 Electron。Renderer 支持热更新，Main/Preload 修改经过停止与重建。结束时按 Ctrl+C 并等待关闭完成；杀进程不证明任务已正常停止。

发行安装见[打包与恢复](packaging-and-recovery.zh-CN.md)。

## 配置模型

1. 打开 **Models** 或 **Settings → LLM**。
2. 选择 Pi 目录中的供应商与模型，填写密钥并保存。**Custom model** 还需填写真实 Base URL、Pi API 类型和模型能力。
3. 点击 **Test connection** 显式发起连接请求，失败时查看供应商诊断。
4. 新会话选择已保存模型；既有 Run 保留原配置。

API 协议必须匹配服务地址。Anthropic 兼容地址需要对应 API 类型，填写 OpenAI 风格协议不会转换端点。以模型元数据和供应商原始错误为准。

桌面凭据由系统加密存储，不要将密钥粘贴进 Prompt 或发布本地设置。评测不继承桌面模型和密钥，见[评测配置](EVALUATION.zh-CN.md#configuration)。

## 第一次对话

应用启动后默认显示对话主区，仅打开此视图不会创建 Session 或请求模型回复。

1. 配置模型后，点击左侧导航中的 **New chat** 创建 Session 并进入对话主区。
2. 输入一个小任务，例如“概括以下段落，并说明它不能证明什么”，附上不敏感的示例文字。
3. 在对话主区点击 **Send**，观察 Run 和回复；需要时点击 **Stop**，等待实际停止事实。
4. 从左侧最近会话或 **Chats** 打开已有会话，回到对话主区查看保存历史；查看不会再次请求模型。

在原有发票、研究和设置页面，对话显示为右侧 Assistant。切换布局、收起并重新展开侧栏，会在当前窗口内保留当前 Session 草稿。**Chats**、**Invoices**、**Deep Research** 保持 AgentSession 流程，布局规则见 [UI 系统](UI-SYSTEM.zh-CN.md)；独立 **Personal Agent** 入口使用 Pi Durable 处理持续发票事项。

处理本地文件前，选择预期工作目录或授权资料，并在请求中说明范围。可用原生工具可能包含写文件和执行 Shell；目录选择只确定工作位置，不是文件系统沙箱。

## 在 Personal Agent 创建持续发票事项

1. 从左侧导航打开 **Personal Agent**，先确认并保存其模型、工具与资源配置，再固定选择一组已有解析的发票，填写目标并明确提交，创建持久发票事项。创建入口仅在 Personal Agent；**Invoices** 保持单票选择与编辑。
2. 查看事项概览、逐票 Todo、候选和来源证据，为对应票据补料，或沿复核动作回到 **Invoices**。
3. 阅读操作回执，区分资料保存、执行授权受理、原尝试或新尝试、排队与受阻。原尝试正常完成后的有效补料可以自动继续符合条件的工作；用户停止或失败后的补料仅保存，须明确继续。
4. 逐票明确最终处置为 `accepted`、`rejected` 或 `excluded`。普通 **Reject** 只拒绝候选，不结束该票处理；有候选或 Run 成功均不单独代表事项完成。

查看页面/历史与桌面重连仅纯读，不发起模型或工具调用，也不触发后端恢复。后端启动恢复另行加载原持久事实和原生记录，核已保存授权及当前资格后恢复符合条件的原尝试；不因事项仍 `open` 产生新意图，不复活已停止或失败的尝试。本次工程交付覆盖应用运行期间已验证的行为；关闭桌面后执行、Windows 服务重启恢复与开机恢复仍属系统服务目标，真实 SCM 验收延期。配置、继续和复核细节见 [Personal Agent](personal-agent.zh-CN.md)。

## 按需启用能力

在 **Skills** 或 **Settings → Skills** 刷新资源、查看缺失依赖并启用版本。新资源默认不启用，Partial 表示尚未完全就绪。

在 AgentSession 对话中需要独立检查时，启用 **Extensions → subagents**，查看 **Plugin details → Manage agents**，可先尝试不带工具的 `general-analyst`：

```text
/subagent general-analyst 只依据这里提供的文字，比较以下两种解释：……
```

命令仍需模型实际发出 `Agent` 工具调用；命令或模板成功展开不证明子任务执行。Personal Agent 使用单独配置的 Durable `Agent` 工具，不使用此扩展命令。两条路径的准备、实际子记录与故障处理见 [Subagent](subagents.zh-CN.md)。

## 后续流程与常见问题

研究、单票复核与 Personal Agent 持续事项见[业务流程](workflows.zh-CN.md)。研究读取选定本地文本、Markdown 或已登记解析资料；发票流程需要原件与外部准备的解析材料，应用不生成解析。

| 现象 | 优先检查 |
|---|---|
| 连接测试失败 | API 类型、服务地址、模型身份与保存的凭据 |
| Send 不可用 | 模型选择、Host/Runtime 就绪、在途或停止未确认的任务 |
| Skill 显示 Partial | 列出的工具、Skill 和扩展依赖 |
| 没有子任务 | 扩展启用、角色可用、实际 Agent 调用及剩余预算 |
| 历史会话不能继续 | 保存历史或资料权限可能不可用；新 Run 前查看诊断 |

默认 Windows 数据根为 `%APPDATA%\Flowmate`，SQLite 位于 `data\app.sqlite`。模型请求会向选定服务发送相应内容，可能收费。Test connection、Optimize、Send、Fill with Agent、研究规划与执行、获准的 Personal Agent 执行可能请求模型；打开页面、保存设置不会自动请求。
