[English](UI-SYSTEM.md) | [简体中文](UI-SYSTEM.zh-CN.md) · [文档导航](README.zh-CN.md)

# UI 系统

## 工作台结构

React Renderer 使用共享 CSS 变量和普通表单元素，启动后显示导航与对话主区。多数业务和设置页面显示各自工作区及右侧 Assistant；Personal Agent 使用独立主工作区，没有该侧栏。对话主区与侧栏复用同一个对话组件。实现位于 [app.tsx](../../apps/desktop/renderer/src/app.tsx)、[styles.css](../../apps/desktop/renderer/src/styles.css) 及同目录专题组件。

| 区域 | 用途 |
|---|---|
| 对话主区 | 默认视图，用于输入消息与阅读当前会话 |
| Personal Agent | Assistant 配置、已保存发票事项、逐票 Todo 与处置、尝试、历史和时间线 |
| Invoices / Workspace | 原件、解析、结果复核与资料、候选上下文 |
| Processing History | 保存的处理 Run 和业务结果 |
| Chats / 最近会话 | 列出、管理已保存 Session，或在对话主区打开会话 |
| Deep Research | Plan、Evidence、Report 与关联 Assistant |
| Activity | 运行事件与实际工具证据 |
| Models | 模型、供应商配置与显式连接检查 |
| Evaluation | 专用配置、执行与保存质量结果 |
| Prompts / Skills / Extensions | 资源选择、就绪与受控能力 |
| Settings | 用户、主题、模型和运行偏好 |

**New chat** 创建 Session 并进入对话主区；打开最近会话或 **Chats** 中的条目也会回到主区。全局 **Evaluation** 入口在对话和业务视图中均可使用。

## 布局与主题

对话主区和 Personal Agent 工作区使用导航以外的空间，没有独立右侧 Assistant 栏或其分隔线；对话主区不能收起。带侧栏的宽屏业务页默认偏好为导航 240 px、Assistant 380 px，下限为 200/300 px，中心下限为 360 px；此时右侧 Assistant 可以收起。

宽度小于 1200 px 时，导航变为 64 px 栏并支持展开抽屉；小于 1080 px 时，展开的右侧 Assistant 浮在业务页面上方，对话主区仍保留在页面布局内。

导航分隔线仅在宽度至少 1200 px 时显示，Assistant 分隔线仅在右侧栏展开且宽度至少 1080 px 时显示。可见分隔线使用 Pointer Capture，支持拖动、双击重置、左右键 10 px、Shift 50 px、Home 重置。`flowmate.panel-widths` 为可选 UI 偏好，localStorage 无效或不可用时回退默认；显式调整保持另一可见栏稳定，切换布局或收起栏位保留其展开宽度偏好。见 [panel-layout.tsx](../../apps/desktop/renderer/src/panel-layout.tsx)。

Light、dark、system 主题复用背景、表面、正文、边框、强调、成功、警告和失败变量。正文与标题共用系统字体栈，数值使用等宽字体栈。复用既有变量，不逐页另造颜色。主题、栏宽不是业务执行状态。

## 状态与交互

- 切页、查历史、刷新工具只观察，不等于 Send 或模型执行。
- 仅打开默认对话视图不会创建 Session 或启动 Run。**New chat** 创建 Session，发送输入是独立操作。
- 草稿归属具体 Session，在当前窗口内切换对话主区与侧栏、收起并重新展开 Assistant，均保留当前草稿。
- 输入属于具体 Session/Context，迟到回复不能把旧工作区或结果附到新选择。
- Send、Stop、Fill with Agent、Save、Accept、Export 含义不同，字段可见值不证明候选提交。
- 加载、错误、缺证据、历史不可用、停止未确认分别保留；回复丢失不等于成功，也不授权新执行。
- 未保存发票编辑仅在内存，离开时显式 Save/Discard。
- 长任务展示父 Run、真实子卡片、工具与保存身份，助手文字不充当执行回执。
- Personal Agent 区分停止当前尝试、Continue work 与 Cancel entire work；Invoices、Tasks、History 和 Timeline 分别展示不同保存事实。详见 [Personal Agent](personal-agent.zh-CN.md)。

子卡片展示真实生命周期和单子 Stop，详细规则见 [Subagent](subagents.zh-CN.md)，交付状态见[业务流程](workflows.zh-CN.md)。

## 可访问性约定与限制

保留原生按钮、输入框、文本域、选择框及语义标题。既有控件提供可见键盘焦点，分隔线具有焦点、方向、可访问标签及当前、最小、最大值。保持菜单、选择框、调整栏宽的键盘行为，提供明确标签、禁用或忙碌状态、文字错误，不只依赖颜色。

复用字段和提示样式，标明相关操作但不泄露凭据或原始私有载荷。这些约定和受控 Electron 测试不代表完成辅助技术或 WCAG 合规审计。

验证入口：[工作台交互 E2E](../../tests/desktop/ui-workbench.e2e.test.ts)、[布局测试](../../tests/desktop/panel-layout.unit.test.ts)、[布局 E2E](../../tests/desktop/panel-layout.e2e.test.ts)、[主题 E2E](../../tests/desktop/theme.e2e.test.ts)、[Subagent E2E](../../tests/desktop/subagents.e2e.test.ts)、[表单 E2E](../../tests/desktop/invoice-form.e2e.test.ts)、[测试说明](../../tests/README.md)。存在测试不表示所有视口、读屏器或系统配置已验证。
