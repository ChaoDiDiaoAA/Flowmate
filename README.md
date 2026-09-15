# Flowmate

基于 Pi SDK 二次开发的数字员工产品，首个业务场景为发票复核、审批与提交。

当前处于重新设计阶段，仓库没有可运行的产品应用。现有实现包括独立数据准备、人工核验版本管理、近重复审查、离线场景物化和评分设施；产品 Runtime 继续按阶段建设。Git 历史保留已有提交。

## 方案入口

- [产品总方案](docs/spec/00_Flowmate完整方案.md)：按 Agent 工程化路线重写的 24 章总方案，涵盖原生机制与产品职责、业务链、Workspace 业务边界、38 表设计、逐目录说明和 P0–P13 Harness 建设路线。
- [Agent 评测总方案](agent-eval/docs/spec/01_Flowmate_Agent评测总方案.md)：按模块定义评测、Case/Gold、Benchmark 与阶段交付。
- [领域术语](CONTEXT.md)。

## 重新实施路线

P0 基础契约 → P1 Agent Runtime → P2 工具 → P3 事件 → P4 会话 → P5 上下文 → P6 Memory → P7 压缩 → P8 Workflow → P9 Prompt/Skill → P10 扩展 → P11 Subagent → P12 产品与动作 → P13 生产运行。Test → Shadow → Canary → Production 是 P13 内的发布阶梯。

先细化并审核阶段目标，再编写实施计划；按实际任务创建总方案规定的目录，不提前生成空包。Pi 提供 Provider、Loop、消息、Session、上下文压缩和资源机制；Flowmate 实现产品层。子任务由 LLM 调用 @tintinweb/pi-subagents 原生 Agent 工具发起。

## 数据

外部来源为 `D:\obsidian\data\flowmate-data\Evidence\invoices\voxel51`，外部副本保留只读。项目输入已整理到 `data/invoices/voxel51/`：2,902 份唯一原票、配对解析和必要图片，重建来源与摘要，112 个重复别名留在清单中。提供方的 1,414 份来源标签独立存于 `agent-eval/data/source-labels/voxel51/`。

质量资料集中存于 `agent-eval/data/`：1,200 份待人工核验候选、600 套模拟业务资料和 6,000 个未运行用例草案。原票/模拟金额、候选/人工核验、文件检查/实际评测严格区分；当前人工已核验和已执行用例均为 0。阶段、Benchmark 和用途通过清单引用，不复制多套数据。

- [全类型数据集制作方案](docs/data-preparation.md)：九类数据、划分理由、核验标准、目录和复现命令。
- 本地数量及状态：`agent-eval/data/manifests/preparation-report.json`。
- 累计三批任务单：`agent-eval/data/manifests/audit/batches.json`；对应核验入口为同目录 `review-queue.csv`。
- 当前状态：`agent-eval/data/manifests/preparation-report.json`；离线夹具和依赖缺口见 `manifests/materialization/report.json`，需求覆盖见 `manifests/coverage.json`。
- 文件、引用及生命周期检查：`python agent-eval/tools/verify_invoice_data.py --project .`。统一摘要使用 `manifests/inventory.json`，不并列保存版本后缀目录。
- 工具自检：`python -m unittest discover -s tools -p "test_invoice*.py" -v`；离线设施自检：`python -m unittest discover -s agent-eval/tests -v`。

项目 `data/invoices/`、`FlowmateData/` 和 `agent-eval/data/` 均 Git 忽略。文件准备不能代替 P0 的 Application 接入、默认 Workspace 注册或后续真实 Agent 评测。
