# Flowmate 初始 Agent 评测集

`agent-eval/` 保存评测规范、任务资料、产品契约索引和评测设施。当前产品实现尚未接入，真实产品运行 **0**、Baseline **0**；离线准备、自检通过和任务入库都不等于 Agent 通过。

## 阅读入口

| 要了解什么 | 文件 |
|---|---|
| 产品责任、业务状态与 P0–P13 | [产品主方案](../docs/spec/00_Flowmate完整方案.md) |
| MOD/RT、Benchmark 与评测方法 | [评测总方案](docs/spec/01_Flowmate_Agent评测总方案.md) |
| 如何制作和验收初始材料 | [数据制作方案](docs/data/data-preparation.md) |
| 本轮范围、映射与接收条件 | [数据对齐方案](docs/data/data-alignment-plan.md) |
| 开发阶段怎样选集和使用 | [数据使用指南](docs/data/data-usage-guide.md) |
| 目录、全部数据字段和参数 | [数据手册](data/README.md) |
| 当前真实数量与阻断项 | [制作报告](data/manifests/preparation-report.json) |

## 当前资产及计数口径

保留 **2,902 份原票及配对解析、1,414 份提供方标签、100 份 Gold、80 套模拟业务资料**。Gold 人工核验仍为 **0**；AI 标注不能改写该状态。

当前 Agent 任务最多 **100 个**，按完整任务过程计数；字段、检查项、工具调用、事件及子 Agent 都不单独增加任务数。六类任务上限分别为抽取 20、匹配 20、人工协同 15、证据取用 15、恢复 15、提交 15。不为填满预算制造近重复实例。实际任务数、契约数、自检数分别从当前清单统计，不在文档维护另一套数值。

| `kind` | 保存位置 | 可以证明什么 |
|---|---|---|
| `agent_task` | `data/cases/<caseId>.json` | 一段有目标、输入、工具环境、步骤、终点和判据的完整 Agent 任务；需真实执行才能评价 |
| `product_contract` | `data/contracts/<module>.json` | 应由产品实现并以确定性证据验证的契约；不是 Agent 任务数或 Agent 成绩 |
| `eval_selftest` | `tests/fixtures/evaluation-selftests.json` | 数据解析、选择、隔离、评分、统计等设施自检；不是产品验证 |

Benchmark 保留 11 个有效身份：BM-01–05、BM-07–12。BM-06 退役；BM-10 暂无真实业务成员。多个 Benchmark 引用同一任务，不复制文件，不相加为独立任务数。

## 目录职责

```text
agent-eval/
├─ README.md
├─ docs/spec/                   # 唯一评测总方案
├─ docs/data/                   # 制作、对齐、使用说明
├─ benchmarks/                  # 非敏感 Benchmark 定义
├─ tools/initial_dataset.py     # 当前准备、验证与报告
├─ tools/coverage_update.py     # 当前资产的覆盖修订预览、发布与核验
├─ src/runner/initial_dataset.py # 当前离线选择与就绪检查
├─ tests/fixtures/evaluation-selftests.json
└─ data/                        # Git 忽略，只保留最新活动材料
   ├─ README.md                 # 完整参数字典
   ├─ source-labels/            # 提供方标签，质量侧参考
   ├─ gold/                     # 答案及真实核验状态
   ├─ business/                 # 模拟输入、规则与可信初态；判据在Case
   ├─ cases/<caseId>.json       # 完整任务，平铺唯一存储
   ├─ contracts/<module>.json   # 产品契约
   └─ manifests/               # 索引、分类、映射、摘要、缺口与报告
```

原始材料仍在项目 `data/invoices/voxel51/`，任务通过引用使用。运行产物在实际执行发生后写到数据集之外的 `agent-eval/runs/<runId>/`；准备工具不创建假运行目录。当前材料不保留归档集或 V1/V2 并列根。新任务和套件的 `schemaVersion: 1` 表示结构协议，`version: 1` 表示初始内容版本，二者独立。保留来源、Gold 和业务包沿用其领域结构及真实修订，不能为了统一数字改写来源。

## 分类、阶段与使用

每个任务同时按六个维度描述：能力 `capabilities`、任务形态 `taskShape`、难度 `difficulty`、条件 `conditions`、目标失败模式 `targetFailureModes`、业务 `business`。模块、阶段、用途和 Benchmark 是引用/筛选关系，不再决定任务物理目录。完整允许值和嵌套字段见数据手册及当前分类清单。

在项目根运行：

```powershell
python agent-eval/tools/initial_dataset.py prepare --project .
python agent-eval/tools/initial_dataset.py verify --project .
python agent-eval/tools/initial_dataset.py report --project .
python agent-eval/tools/coverage_update.py check --project .
python agent-eval/tools/coverage_update.py publish --project .
python agent-eval/tools/coverage_update.py verify --project .
python agent-eval/src/runner/initial_dataset.py BM-08 --project . --stage P2 --split development --subset capability
```

`prepare` 执行首次迁移发布；当前格式已经发布后再次执行只核验，返回 `changed: false`。它不自动重签任意修改后的清单。`verify` 检查结构/引用/计数/隔离，`report` 显示真实统计。Runner 命令选择当期子集并报告阻断；产品未接入时所有产品执行保持 blocked，不生成成绩或 Baseline。JSON 是唯一编辑源；JSONL 仅按需导出，不维护可独立修改的第二套数据。

内容维护使用 `coverage_update`：`check` 只读显示候选差异，`publish` 校验当前摘要后从受控声明同步当前材料，`verify` 检查发布结果。覆盖清单的结构版本为 2，任务和契约仍为 1；父级功能、原子条件、指标协议分别报告，均不代表真实产品已通过。

## 权限与责任

被测主 Agent、子 Agent、工具发现、Context 和文件访问必须排除整个 `agent-eval/`。可信控制器仅交付任务授权的输入投影；标签、Gold、契约答案、Rubric、目标失败模式、其他 Trial 输出和评分代码留在质量侧。工具环境及故障由可信控制器装配，答案不能改名后当作产品输入。

产品 F 验证归产品模块与根目录测试，真实模型 A 验证依赖真实 Pi/产品入口，业务 B 结论依赖独立权威业务结果。评测设施不复制产品 Runtime/Workflow。下一步按阶段补齐产品入口、证据接口及 Gold 人工核验，再冻结适用子集并执行。
