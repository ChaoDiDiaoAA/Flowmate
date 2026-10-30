[English](PRD.md) | [简体中文](PRD.zh-CN.md) · [文档导航](README.zh-CN.md)

# 产品范围

## 定位与使用者

Flowmate 将持续对话、选定本地信息上的任务与可复核的结构化结果放进同一个桌面工作台，适合需要检查答案或候选如何产生，并保留相关资料与执行历史的使用者。

当前主要开发和打包目标是 Windows x64。“本地优先”描述本地状态的持久化与控制；调用远程模型时，相应请求内容仍会发送至模型服务。

## 主要场景

| 需求 | 使用路径 | 可复核结果 |
|---|---|---|
| 针对已有信息提问 | 通过 New chat 或已有会话进入对话主区、选定资料或工作目录、Send | 会话历史、实际工具记录与上下文依据 |
| 跨本地资料研究问题 | Deep Research、计划、用户确认、调查 | 保存的来源、Claim、完整或含缺口的部分报告 |
| 发票提取与核对 | Invoices、已有解析资料、处理、复核 | 候选版本、字段证据、显式接受与导出 |
| 持续处理一组发票 | Personal Agent、固定已解析发票、Todo 和明确复核 | Work／Attempt 历史及每张票的最终处置 |
| 委派独立检查 | AgentSession 的 subagents 扩展或 Personal Agent 有界 Durable `Agent` 工具 | 归属明确的子执行、实际输出与停止事实 |
| 衡量任务表现 | Evaluation 或 CLI、专用模型与数据集 | 隔离 Trial、执行证据、评分和审核记录 |

具体操作见[业务流程](workflows.zh-CN.md)，持续事项见 [Personal Agent](personal-agent.zh-CN.md)，委派限制见 [Subagent](subagents.zh-CN.md)。

默认视图为对话主区。**Chats** 用于列出和管理已保存 Session，打开其中条目或最近会话会回到对话主区；多数业务和设置页面保留右侧 Assistant，Personal Agent 使用独立主工作区。布局与交互规则见 [UI 系统](UI-SYSTEM.zh-CN.md)。

## 功能边界

工作台提供持久 Session、输入与 Context 记录、有界 Run、当前平台可用的 Pi 文件和命令工具、显式启用的 Skill 和受控扩展、研究计划与证据、发票复核与导出。产品分别记录模型输出、工具执行、写入提交、结果向模型交付及用户接受。

Deep Research 当前读取授权本地文本、Markdown 和已登记解析文档，不支持联网搜索或网页提取。调查前确认计划；部分报告可以显式保留未解决问题。原文定位核验不等于推理语义正确。

发票流程读取已登记的原件与外部预先生成的解析材料，Host 不执行发票解析器或 OCR。模型生成候选、表单填入成功、人工编辑保存、接受结果分别留痕；接受前由用户对照原件、解析内容和字段证据。

Personal Agent 通过 Durable 尝试和逐票 Todo 协调固定的已解析发票集合。接受候选、将该接受操作关联到事项票据、完成整个事项是不同步骤；当前支持的子角色是有界只读发票取证角色。

Subagent 是前台只读任务，最多同时保有四个子执行，共享父预算，不支持嵌套、后台执行或业务写入。普通 Assistant 命令工具可能写文件或执行命令；选择工作目录不是操作系统沙箱。

## 需要保持的产品行为

1. 浏览历史或重新连接不重放模型调用或既有副作用。
2. 停止请求与实际停止确认分开；停止未确认或必要保存失败可能阻断复用。
3. Run 使用当次选定配置、授权资料范围及资源版本，当前界面选择变化不改写历史上下文。
4. 缺证据、参数被拒绝和部分结果应明确展示，不能直接视为业务交付成功。
5. 工程夹具、真实模型质量、人工审核及安装恢复验证分别报告。

## 交付与数据

SQLite 与受管文件位于产品用户数据根目录。桌面凭据使用系统加密存储，评测使用独立配置。显式模型操作可能收费。部分评测路径可只在本地执行；标准 Smoke／Full 基准命令要求 Langfuse 预检，并包含上传和回读。详见[评测](EVALUATION.zh-CN.md)。

仓库不承诺自主记账提交、联网研究、所有供应商兼容、操作系统沙箱或跨 Windows 账户恢复成功。实现边界见[架构](architecture.zh-CN.md)、[评测](EVALUATION.zh-CN.md)与[打包和恢复](packaging-and-recovery.zh-CN.md)。

## 实现定位

- [应用组装](../../apps/composition.ts)与[公开运行契约](../../packages/contracts/src/runtime.ts)
- [研究契约](../../packages/contracts/src/research.ts)与[研究界面](../../apps/desktop/renderer/src/research.tsx)
- [发票模块](../../packages/employee-invoice/src)与[工程测试说明](../../tests/README.md)
