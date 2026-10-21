[English](UI-SYSTEM.md) | [简体中文](UI-SYSTEM.zh-CN.md) · [文档导航](README.zh-CN.md)

# UI 系统

## 工作台结构

React Renderer 使用共享 CSS 变量和普通表单元素，主体为导航、中心工作区和 Assistant。实现位于 [app.tsx](../../apps/desktop/renderer/src/app.tsx)、[styles.css](../../apps/desktop/renderer/src/styles.css) 及同目录专题组件。

| 区域 | 用途 |
|---|---|
| Invoices / Workspace | 原件、解析、结果复核与资料、候选上下文 |
| Processing History | 保存的处理 Run 和业务结果 |
| Chats | 持久对话与 Session 管理 |
| Deep Research | Plan、Evidence、Report 与关联 Assistant |
| Activity | 运行事件与实际工具证据 |
| Models | 模型、供应商配置与显式连接检查 |
| Evaluation | 专用配置、执行与保存质量结果 |
| Prompts / Skills / Extensions | 资源选择、就绪与受控能力 |
| Settings | 用户、主题、模型和运行偏好 |

## 布局与主题

可调整布局默认偏好为导航 240 px、Assistant 380 px，展开布局适用时下限 200/300 px，中心下限 360 px。1200/1080 px 响应式规则调整侧栏；隐藏、收起宽度不覆盖展开偏好。

两条分隔线使用 Pointer Capture，支持拖动、双击重置、左右键 10 px、Shift 50 px、Home 重置。`flowmate.panel-widths` 为可选 UI 偏好，localStorage 无效或不可用时回退默认；显式调整保持另一可见栏稳定。见 [panel-layout.tsx](../../apps/desktop/renderer/src/panel-layout.tsx)。

Light、dark、system 主题复用背景、表面、正文、边框、强调、成功、警告和失败变量，字体区分一般文字、标题及数值。复用既有变量，不逐页另造颜色。主题、栏宽不是业务执行状态。

## 状态与交互

- 切页、查历史、刷新工具只观察，不等于 Send 或模型执行。
- 输入属于具体 Session/Context，迟到回复不能把旧工作区或结果附到新选择。
- Send、Stop、Fill with Agent、Save、Accept、Export 含义不同，字段可见值不证明候选提交。
- 加载、错误、缺证据、历史不可用、停止未确认分别保留；回复丢失不等于成功，也不授权新执行。
- 未保存发票编辑仅在内存，离开时显式 Save/Discard。
- 长任务展示父 Run、真实子卡片、工具与保存身份，助手文字不充当执行回执。

子卡片展示真实生命周期和单子 Stop，详细规则见 [Subagent](subagents.zh-CN.md)，交付状态见[业务流程](workflows.zh-CN.md)。

## 可访问性约定与限制

保留原生按钮、输入框、文本域、选择框及语义标题。既有控件提供可见键盘焦点，分隔线具有焦点、方向、可访问标签及当前、最小、最大值。保持菜单、选择框、调整栏宽的键盘行为，提供明确标签、禁用或忙碌状态、文字错误，不只依赖颜色。

复用字段和提示样式，标明相关操作但不泄露凭据或原始私有载荷。这些约定和受控 Electron 测试不代表完成辅助技术或 WCAG 合规审计。

验证入口：[布局测试](../../tests/desktop/panel-layout.unit.test.ts)、[主题 E2E](../../tests/desktop/theme.e2e.test.ts)、[Subagent E2E](../../tests/desktop/subagents.e2e.test.ts)、[表单 E2E](../../tests/desktop/invoice-form.e2e.test.ts)、[测试说明](../../tests/README.md)。存在测试不表示所有视口、读屏器或系统配置已验证。
