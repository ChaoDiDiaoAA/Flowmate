# Flowmate Agent 评测：Inspect AI 与质量资产

`agent-eval/` 保存评测规范、数据及设施。现有P0产品入口已实现，但尚无真实Agent/Inspect适配；当前综合集没有Agent运行或Baseline。离线准备、自检和Inspect安装不等于产品通过。

## 执行方式与当前边界

采用**CLI执行、Inspect View查看**，阶段评测和完整Agent综合评测共用Inspect。框架安装已在本机核查：Inspect 0.3.266／Python 3.13.12，Editable源码D:\inspect_ai；版本与View帮助命令成功，未启动UI或运行Agent。

- 现有data综合集不改动，完整Agent实现后核验启用；阶段当期使用stage-evals/Pn，不等待整体完成。
- 阶段数据只保留README.md、cases.json、必要gold.json/fixtures；Oracle嵌入Case，质量优先、不设配额，样本不足限制统计结论。整理P0资产也建立README/Case索引，复用现有F及报告，仅补缺少夹具；不要求业务Gold、模型或真实Agent适配器。
- 拟新增适配全部位于src：runner/inspect_tasks.py、adapters/flowmate.py和flowmate.ts、graders/inspect_scores.py、analysis.py。TS调用公共产品入口，产品不反向依赖质量侧。
- Python依赖拟由本目录pyproject.toml/uv.lock统一锁定；根bun.lock仍管理JS/TS。当前安装无需重装，上游Inspect源码不放项目代码。
- 新真实运行产物位于runs/<executionId>，P0已有reports/p0保持原位；产品实例在质量根以外。

完整使用、协议和工作包以[评测主方案第10章](docs/spec/01_Flowmate_Agent评测总方案.md#10-评测设施与工程对接)为准。下方现有工具命令仍属于综合材料离线准备，不能获得Inspect产品成绩。

阶段制作、逐阶段材料来源和Case/Gold完整设计示例统一见[§10.5](docs/spec/01_Flowmate_Agent评测总方案.md#105-数据怎样准备阶段集怎样映射)。Task加载Case，Solver只传获准输入，Scorer读取质量侧Oracle/Gold；四类状态分别为数据准备、可执行、评测完成与阶段通过。综合集后置使用是本次新安排，不改写原先跨阶段筛选的历史。

兼容待办见§10.5.7：旧工具的--stage仍筛选综合集，P0报告仍固定三项阻断；文档修订不会自动改变代码行为或历史摘要。阶段目录、适配器和示例数据本次均未创建。

## 阅读入口

| 要了解什么 | 文件 |
|---|---|
| 产品责任、业务状态与 P0–P13 | [产品主方案](../docs/spec/00_Flowmate完整方案.md) |
| MOD/RT、Benchmark 与评测方法 | [评测总方案](docs/spec/01_Flowmate_Agent评测总方案.md) |
| 如何制作和验收初始材料 | [数据制作方案](docs/data/data-preparation.md) |
| 本轮范围、映射与接收条件 | [数据对齐方案](docs/data/data-alignment-plan.md) |
| 阶段与综合评测怎样使用 | [数据使用指南](docs/data/data-usage-guide.md) |
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
├─ src/runner/initial_dataset.py # 当前综合材料离线选择与就绪检查
├─ src/runner/inspect_tasks.py   # 拟新增Inspect任务入口
├─ src/adapters/                # 拟新增Python/TS适配
├─ stage-evals/Pn/              # 当期高质量Case/必要Gold与夹具
├─ runs/                        # 新实际运行的日志、证据和报告
├─ pyproject.toml / uv.lock     # 拟新增Python声明/锁
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

原始材料仍在项目 `data/invoices/voxel51/`，任务通过引用使用。运行产物在实际执行发生后写到数据集之外的 `agent-eval/runs/<executionId>/`；准备工具不创建假运行目录。当前材料不保留归档集或 V1/V2 并列根。新任务和套件的 `schemaVersion: 1` 表示结构协议，`version: 1` 表示初始内容版本，二者独立。保留来源、Gold 和业务包沿用其领域结构及真实修订，不能为了统一数字改写来源。

## 分类、阶段与使用

每个任务同时按六个维度描述：能力 `capabilities`、任务形态 `taskShape`、难度 `difficulty`、条件 `conditions`、目标失败模式 `targetFailureModes`、业务 `business`。在现有综合集内部，模块、能力阶段标签、用途和Benchmark是引用/筛选关系；这不替代独立stage-evals/Pn，也不授权开发期启动综合集。完整允许值和嵌套字段见数据手册及当前分类清单。

下列为现有综合材料工具的命令说明，不是Inspect阶段执行流程；prepare/publish会修改资产，本次不运行。在项目根使用：

```powershell
python agent-eval/tools/initial_dataset.py prepare --project .
python agent-eval/tools/initial_dataset.py verify --project .
python agent-eval/tools/initial_dataset.py report --project .
python agent-eval/tools/coverage_update.py check --project .
python agent-eval/tools/coverage_update.py publish --project .
python agent-eval/tools/coverage_update.py verify --project .
python agent-eval/src/runner/initial_dataset.py BM-08 --project . --stage P2 --split development --subset capability
```

`prepare` 执行首次迁移发布；当前格式已经发布后再次执行只核验，返回 `changed: false`。它不自动重签任意修改后的清单。`verify` 检查结构/引用/计数/隔离，`report` 显示真实统计。旧Runner命令按综合集的能力阶段标签离线筛选并报告阻断；真实Agent未接入时其执行保持blocked，不生成成绩或 Baseline。JSON 是唯一编辑源；JSONL 仅按需导出，不维护可独立修改的第二套数据。

内容维护使用 `coverage_update`：`check` 只读显示候选差异，`publish` 校验当前摘要后从受控声明同步当前材料，`verify` 检查发布结果。覆盖清单的结构版本为 2，任务和契约仍为 1；父级功能、原子条件、指标协议分别报告，均不代表真实产品已通过。

## 权限与责任

被测主 Agent、子 Agent、工具发现、Context 和文件访问必须排除整个 `agent-eval/`。可信控制器仅交付任务授权的输入投影；标签、Gold、契约答案、Rubric、目标失败模式、其他 Trial 输出和评分代码留在质量侧。工具环境及故障由可信控制器装配，答案不能改名后当作产品输入。

产品 F 验证归产品模块与根目录测试，真实模型 A 验证依赖真实 Pi/产品入口，业务 B 结论依赖独立权威业务结果。评测设施不复制产品 Runtime/Workflow。下一步P1落实Inspect最小适配、阶段输入投影、可信采证、确定性评分和必要Gold核验；仅第7.5适用场景触发人工复核，不设置全体Case独立签名门槛。现有综合集在完整Agent后另行核验启用。
