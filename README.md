# Flowmate

基于 Pi SDK 的数字员工产品，首个业务场景是：使用已有合格解析结果和获准原票证据，完成发票字段抽取、适用业务核查、人工复核、具体动作审批、B2B 录入及权威结果核对。

**当前处于方案与分阶段实施准备期，尚无可运行的产品应用。** 仓库已有数据准备、覆盖核验、离线任务选择及评测设施；这些不代表产品 Runtime 已实现，也不代表真实 Agent 或业务验收通过。

## 文档入口

| 想了解什么 | 阅读入口 |
|---|---|
| 为什么做、总体架构、模块职责、业务与存储、实施路线 | [产品主方案](docs/spec/00_Flowmate完整方案.md)，产品建设的唯一总方案 |
| 功能机制、真实 Agent 行为、业务结果如何分别验证 | [Agent 评测总方案](agent-eval/docs/spec/01_Flowmate_Agent评测总方案.md) |
| 当前评测资产、目录及工具入口 | [评测 README](agent-eval/README.md) |
| 数据如何制作、对齐与使用 | [制作方案](agent-eval/docs/data/data-preparation.md) · [对齐方案](agent-eval/docs/data/data-alignment-plan.md) · [使用指南](agent-eval/docs/data/data-usage-guide.md) |
| 领域概念 | [领域术语](CONTEXT.md)，具体契约以主方案为准 |

`docs/v1/` 保留逐章修改方案，当前设计及执行依据以 `docs/spec/` 主方案为准。阶段目标和实施计划在进入对应阶段时编写，不提前生成全部阶段文件或空包。

## 架构与职责

以下是目标设计，随 P0–P13 启用，并非现有产品能力清单。

| 层次 | 职责 |
|---|---|
| Pi SDK | Provider、认证、模型与工具循环、原生消息及会话历史、上下文压缩、资源与扩展机制 |
| Flowmate 产品控制 | Workspace 隔离、身份权限、Job／步骤、Run／绑定、输入受理、业务工具、人工交互、审批、受控发送与恢复 |
| `runtime-pi` 接入层 | 装配并调用 Pi，接合工具、获准 Hook、事件、历史存储与原生控制 |
| 第三方 `@tintinweb/pi-subagents` | 提供 Agent 工具委派；仅由主 LLM 调用发起，Flowmate 核验子执行的范围、身份、预算与存储 |
| 发票领域与外部接入 | 实现字段与适用业务规则，读取企业依据，按冻结动作及有效审批提交并核对结果 |

业务只读工具由 Flowmate 实现并注册给 Pi；“只读”描述行为，不表示工具必然来自 Pi。三类工具共用产品准入，Hook 不授予独立业务权限。

Session 保存可跨 Run 续接的历史；Run 管一次获准执行；Job 管业务进度和结果。一次回答结束、Run 成功和 Job 完成分别判断。主子 Agent 按需协作，不要求每票创建子任务。

### 存储与技术路线

- 最终目标为 **22 张功能表＋1 张迁移表，共 23 张**；各阶段只建立当期需要的结构。
- SQLite 是会话历史的唯一持久化来源：`sessions` 保存原生头和当前位置，`memories` 保存完整原生条目及压缩内容，`session_inputs` 记录输入受理与投递；业务上下文正文保存在 `context_snapshots`。
- 当前只实现 Session 会话记忆，复用 Pi 历史与压缩语义；不额外建设跨任务长期记忆、向量检索或自动经验提炼引擎。保存正确与模型正确使用记忆分别验证。
- 原票、附件、配置清单及文件型证据使用受控文件存储；诊断日志保持独立 JSONL，不能替代数据库业务事实或审计。
- 目标工程使用 TypeScript、Bun；P1–P12 嵌入 Pi SDK，P12 引入 Electron／React 桌面，P13 将主子会话及插件移入受控 Pi Host，业务数据库留在控制侧。依赖和承载兼容性在对应阶段实际验证。

## 分阶段实施

| 阶段 | 当期增量 |
|---|---|
| P0 | 输入集合、默认 Workspace、基础契约与存储 |
| P1 | 真实模型接通、Pi 原生 Loop 与最小产品 Run |
| P2 | 工具定义、准入、调用记录及候选保存 |
| P3 | 事件、期限、预算与停止控制 |
| P4 | Session、输入投递、完整历史持久化与续接 |
| P5 | 业务上下文选择、快照与实际交付关联 |
| P6 | 会话记忆使用、纠正、来源及隔离验证 |
| P7 | 原生上下文压缩、保存及继续资格 |
| P8 | 业务 Workflow、修订、步骤、复核与人工等待 |
| P9 | Prompt／Skill 及资源版本治理 |
| P10 | 原生 Extensions 接入、Hook、启停与清理 |
| P11 | 第三方 Subagent 的单个前台只读委派闭环 |
| P12 | 完整产品界面、冻结动作、审批、提交与权威结果核对 |
| P13 | Host、安装、备份恢复、发布与持续运维 |

每阶段通过最小真实任务证明增量，同时验证适用失败路径和受影响前序能力。一次成功演示不等于阶段完整通过。

P12-A 通用模拟、P12-B 企业契约模拟、P12-C 获准真实测试分别报告。Test → Shadow → Canary → Production 是 P13 内的放行阶梯；工程验证、质量结论、生产放行和逐动作批准不能互相替代。

## 当前数据与评测状态

**2026-09-20 核对本地制作报告：**

| 项目 | 当前记录 |
|---|---:|
| 原票及配对解析 | 2,902 份 |
| 提供方标签 | 1,414 份 |
| Gold 材料／已登记人工核验 | 100 份／0 份 |
| 模拟业务资料 | 80 套 |
| 完整 Agent 任务 | 78 个（当前上限 100） |
| 产品契约 | 14 套／460 个场景 |
| 真实产品运行／Baseline | 0／0 |

**当前核验阻断（2026-09-20）：** `initial_dataset.py verify` 与 `coverage_update.py verify` 均报告 `Benchmark definition pin drift`，表示 Benchmark 定义与清单固定摘要不一致，当前材料不能宣称完整核验通过。下列命令可用于复查；本次 README 更新未修改数据或重新发布清单。

以上是本次核对的盘点，后续以本地 [制作报告](agent-eval/data/manifests/preparation-report.json) 和当前清单为准。Gold 材料存在不等于人工核验完成；契约场景、字段检查、工具调用和子 Agent 不计作独立 Agent 任务，也不代表已执行成绩。

产品输入位于 `data/invoices/voxel51/`；外部来源为 `D:\obsidian\data\flowmate-data\Evidence\invoices\voxel51`，保留来源副本，产品运行不依赖该外部路径。提供方标签及 Gold、Case、评分资料在独立 `agent-eval/data/` 根下，产品 Agent、子 Agent、工具发现和 Context 不得读取；仅由可信控制器交付获准输入投影。

`data/invoices/`、`FlowmateData/`、`agent-eval/data/` 和评测运行产物均被 Git 忽略，克隆仓库不会自动取得本地资料。文件准备不代表 P0 的产品读取链路、默认 Workspace 和基础存储已验收。

## 当前可用命令

需要 Python 和已准备的本地数据。在项目根目录执行以下只读检查；当前没有产品启动命令。

```powershell
# 查看当前资产与阻断项
python agent-eval/tools/initial_dataset.py report --project .

# 检查当前材料结构、引用、计数和隔离
python agent-eval/tools/initial_dataset.py verify --project .

# 核验当前覆盖修订
python agent-eval/tools/coverage_update.py verify --project .

# 选择当期评测子集并报告就绪状态，不执行产品
python agent-eval/src/runner/initial_dataset.py BM-08 --project . --stage P2 --split development --subset capability
```

准备或发布资料的写入命令见[评测 README](agent-eval/README.md)及[数据制作方案](agent-eval/docs/data/data-preparation.md)。产品尚未接入时，Runner 的产品执行保持 blocked，不生成真实成绩或 Baseline。旧准备、迁移脚本仍保留在仓库中，当前流程以这些文档指定的入口为准。

## 业务边界

保留字段抽取与规范化、按需供应商／订单关联，以及适用的收货、合同、价格、数量和订单余额核查。关联用于确定目标字段，业务核查用于判断既定条件，两者分开。人工复核接受业务事实；有资格人员批准具体冻结动作后，产品才进行最终发送准入。

当前不建设产品内 OCR／Parser、自动拆合票、外部独立验真、ERP 回写、付款／入账流程、额度／多级财务审批、通用员工创建、复杂配置管理页面或第二业务领域演示。ERP 可作为获准只读依据来源。外部结果未知（UNKNOWN）先按原动作核对，不因重启、回送丢失或切换提交路径自动重发。
