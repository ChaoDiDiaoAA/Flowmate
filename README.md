# Flowmate

基于 Pi SDK 二次开发的数字员工产品，首个业务场景为发票复核、审批与提交。

当前处于重新设计阶段。实现代码、测试、构建产物、项目依赖和 P0 阶段方案已删除；仓库目前没有可运行应用或测试命令。Git 历史保留已有提交。

## 方案入口

- [产品总方案](docs/spec/00_Flowmate完整方案.md)：按 Agent 工程化路线重写的 24 章总方案，涵盖原生机制与产品职责、业务链、Workspace 业务边界、38 表设计、逐目录说明和 P0–P13 Harness 建设路线。
- [Agent 评测总方案](agent-eval/docs/spec/01_Flowmate_Agent评测总方案.md)：按模块定义评测、Case/Gold、Benchmark 与阶段交付。
- [领域术语](CONTEXT.md)。

## 重新实施路线

P0 基础契约 → P1 Agent Runtime → P2 工具 → P3 事件 → P4 会话 → P5 上下文 → P6 Memory → P7 压缩 → P8 Workflow → P9 Prompt/Skill → P10 扩展 → P11 Subagent → P12 产品与动作 → P13 生产运行。Test → Shadow → Canary → Production 是 P13 内的发布阶梯。

先细化并审核阶段目标，再编写实施计划；按实际任务创建总方案规定的目录，不提前生成空包。Pi 提供 Provider、Loop、消息、Session、上下文压缩和资源机制；Flowmate 实现产品层。子任务由 LLM 调用 @tintinweb/pi-subagents 原生 Agent 工具发起。

## 数据

原始发票与已有解析文件保留于 `D:\obsidian\data\flowmate-data\Evidence\invoices\voxel51`；该路径本身已包含 voxel51。

本地 `FlowmateData/` 及可能存在的 `agent-eval/data/` 私有数据予以保留并继续 Git 忽略。历史运行数据不代表新的 P0 已经通过。`docs/archive/` 仅为历史审查记录。
