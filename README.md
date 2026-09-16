# Flowmate

基于 Pi SDK 二次开发的数字员工产品，首个业务场景为发票复核、提交确认与 B2B 提交。

当前处于重新设计阶段，仓库没有可运行的产品应用。现有实现包括独立数据准备、人工核验版本管理、近重复审查、离线场景物化和评分设施；产品 Runtime 继续按阶段建设。Git 历史保留已有提交。

## 方案入口

- [产品总方案](docs/spec/00_Flowmate完整方案.md)：按 Agent 工程化路线重写的 24 章总方案，涵盖原生机制与产品职责、业务链、Workspace 业务边界、35 表设计、逐目录说明和 P0–P13 Harness 建设路线。
- [Agent 评测总方案](agent-eval/docs/spec/01_Flowmate_Agent评测总方案.md)：按模块定义评测、Case/Gold、Benchmark 与阶段交付。
- [领域术语](CONTEXT.md)。

## 重新实施路线

P0 基础契约 → P1 Agent Runtime → P2 工具 → P3 事件 → P4 会话 → P5 上下文 → P6 Memory → P7 压缩 → P8 Workflow → P9 Prompt/Skill → P10 扩展 → P11 Subagent → P12 产品与动作 → P13 生产运行。Test → Shadow → Canary → Production 是 P13 内的发布阶梯。

先细化并审核阶段目标，再编写实施计划；按实际任务创建总方案规定的目录，不提前生成空包。Pi 提供 Provider、Loop、消息、Session、上下文压缩和资源机制；Flowmate 实现产品层。子任务由 LLM 调用 @tintinweb/pi-subagents 原生 Agent 工具发起。

## 数据

外部来源为 `D:\obsidian\data\flowmate-data\Evidence\invoices\voxel51`，外部副本保留只读。项目输入已整理到 `data/invoices/voxel51/`：2,902 份唯一原票、配对解析和必要图片，重建来源与摘要，112 个重复别名留在清单中。提供方的 1,414 份来源标签独立存于 `agent-eval/data/source-labels/voxel51/`。

质量资料集中存于 `agent-eval/data/`：已完成本次范围同步：保留 1,200 份 Gold 候选、600 套模拟业务资料，将用例从旧 6,000 个退役 423 个至 5,577 个，不补数。旧 7,801 项资产的用户批量审核声明及其绑定内容保留；该声明不是逐字段 Gold，变更后的业务资料、用例和政策不能继承旧确认。当前结构化人工核验 Gold 和实际产品运行数仍为 0。阶段、Benchmark 和用途通过清单引用，不复制多套数据；发布结果以当前清单为准。

当前范围保留外部解析导入、原件证据，以及 A2 收货、合同价格、数量和订单余额检查；匹配按需进行。人工可修订、澄清、确认具体 B2B 提交和接管，内容或授权变化使旧确认失效。外部发票验真、ERP 回写、产品内 OCR/Parser 执行、自动拆合票、额度/多级财务审批、强制两人分离、通用员工创建/复杂配置 UI 和第二任务通用性证明均不在当前范围；ERP 只读业务资料仍可使用。

- [全类型数据集制作方案](agent-eval/docs/data/data-preparation.md)：九类数据、划分理由、核验标准、目录和复现命令。
- 本地数量及状态：`agent-eval/data/manifests/preparation-report.json`。
- 累计三批任务单：`agent-eval/data/manifests/audit/batches.json`；对应核验入口为同目录 `review-queue.csv`。
- 当前状态：`agent-eval/data/manifests/preparation-report.json`；离线夹具和依赖缺口见 `manifests/materialization/report.json`，需求覆盖见 `manifests/coverage.json`。
- 范围迁移：`agent-eval/tools/sync_invoice_scope.py` 在暂存根生成并检查，保留 `manifests/history/*.zip` 与 `scope-sync.json`；旧审核声明继续绑定旧内容，当前目录保持唯一。
- 文件、引用及生命周期检查：`python agent-eval/tools/verify_invoice_data.py --project .`。统一摘要使用 `manifests/inventory.json`，不并列保存版本后缀目录。
- 工具自检：`python -m unittest discover -s agent-eval/tools -p "test_invoice*.py" -v`；离线设施自检：`python -m unittest discover -s agent-eval/tests -v`。

项目 `data/invoices/`、`FlowmateData/` 和 `agent-eval/data/` 均 Git 忽略。文件准备不能代替 P0 的 Application 接入、默认 Workspace 注册或后续真实 Agent 评测。
