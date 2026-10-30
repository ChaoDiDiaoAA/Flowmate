[English](README.md) | [简体中文](README.zh-CN.md)

# Flowmate 文档

Flowmate 是基于 Pi SDK 的本地优先 Agent 桌面工作台，提供持久会话、授权本地资料处理、证据研究、发票复核，以及用于持续发票事项的独立 **Personal Agent**。**Chats**、**Invoices**、**Deep Research** 继续使用 AgentSession，Personal Agent 使用 Pi Durable。这些文档说明仓库中的实际实现，不代表模型质量达标或发行认证。

本次工程版本交付覆盖应用运行期间已验证的能力。关闭桌面后持续执行、Windows 开机恢复仍属系统服务目标；真实 Windows SCM 验收延期，这些系统行为尚未验证。

## 从这里开始

使用者路线：[快速开始](getting-started.zh-CN.md) → [业务流程](workflows.zh-CN.md) → [Skills 与扩展](skills-and-extensions.zh-CN.md)。持续处理发票请阅读 [Personal Agent](personal-agent.zh-CN.md)，委派任务请阅读 [Subagent](subagents.zh-CN.md)，迁移本地数据前阅读[打包与恢复](packaging-and-recovery.zh-CN.md)。

本地研究请参考 [Deep Research 流程](workflows.zh-CN.md#deep-research)；[Context 与 Memory 分层](agent-runtime.zh-CN.md#context-memory-layers)说明输入依据、会话历史和研究进度分别如何保存与恢复。

持续整理一组发票时，从 **Personal Agent** 进入[专题指南](personal-agent.zh-CN.md)：固定选择已解析发票，逐票跟踪 Todo、补料和候选复核，直到每张票都有明确最终处置。

开发者路线：[产品范围](PRD.zh-CN.md) → [架构](architecture.zh-CN.md) → [Agent Runtime](agent-runtime.zh-CN.md) → [Personal Agent](personal-agent.zh-CN.md) → [Subagent](subagents.zh-CN.md) → [开发指南](development.zh-CN.md)。[评测指南](EVALUATION.zh-CN.md)解释工程验证与真实模型试验的区别。

## 专题导航

| 专题 | 解决的问题 |
|---|---|
| [产品范围](PRD.zh-CN.md) | 面向谁、主要流程与当前限制 |
| [快速开始](getting-started.zh-CN.md) | 开发启动、配置模型、第一次对话与 Personal Agent 入口 |
| [架构](architecture.zh-CN.md) | Electron、Bun Host、各包职责及数据流 |
| [Agent Runtime](agent-runtime.zh-CN.md) | Session、Run、Context／Memory 分层、工具、预算、停止与恢复 |
| [Personal Agent](personal-agent.zh-CN.md) | Durable 发票事项、Todo、复核、尝试及恢复边界 |
| [Subagent](subagents.zh-CN.md) | 角色准备、委派、父子归属及生命周期 |
| [业务流程](workflows.zh-CN.md) | 本地问答、Deep Research 步骤和继续、单票复核与 Personal Agent 持续事项 |
| [Skills 与扩展](skills-and-extensions.zh-CN.md) | 资源发现、依赖就绪、模板与受控扩展 |
| [评测指南](EVALUATION.zh-CN.md) | 目的、轨迹、评分、双模型 Smoke/Full 与 Baseline/Gate |
| [基准制作](EVALUATION-BENCHMARK.zh-CN.md) | 真实来源候选、独立 Gold、校验与版本发布 |
| [UI 系统](UI-SYSTEM.zh-CN.md) | 布局、可观察状态、交互与可访问性约定 |
| [开发指南](development.zh-CN.md) | 仓库结构、测试入口与必要依赖补丁 |
| [打包与恢复](packaging-and-recovery.zh-CN.md) | Windows 产物、数据目录、诊断、备份与恢复验证 |

## 如何理解证据

源码和测试链接用于定位实现与验证入口，测试文件存在不表示它已在你的环境中通过。Run 完成、业务产物保存和质量通过是不同事实；排查结果时应沿已保存的 Run、工具调用与产物身份核对。

英文文件使用 `.md`，中文对应文件使用 `.zh-CN.md`，每页提供语言切换。本地实施资料和评测记录不作为公开文档的阅读依赖。

专题组织、流程图与明确能力边界的写法参考 [Folio 文档](https://github.com/helsome/folio/tree/main/docs)，Flowmate 的行为与技术细节依据自身源码撰写。
