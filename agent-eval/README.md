# Flowmate Agent 评测：Inspect AI 与质量资产

P0当前执行入口：`bun run p0:eval`；详细说明见[阶段README](stage-evals/P0/README.md)，判据见[Case/Oracle](stage-evals/P0/cases.json)。P0无需Inspect，用户执行真实产品F，报告写入runs新目录。启动无交互，不填用途依据或记录人；新 development 运行绑定 `p0-local-f/v2`，人工用途声明不再是本地技术 F 前提，但不改变来源许可未核实的事实。

`agent-eval/` 保存评测规范、数据及设施。现有P0产品入口已实现，但尚无真实Agent/Inspect适配；当前综合集没有Agent运行或Baseline。离线准备、自检和Inspect安装不等于产品通过。

## 执行方式与当前边界

P1起采用**Inspect CLI执行、Inspect View查看**，P1–P13阶段评测和完整Agent综合评测共用一套Task/适配器/Scorer，不另建调度平台、成绩库或评测UI。框架安装已在本机核查：Inspect 0.3.266／Python 3.13.12，Editable源码D:\inspect_ai；版本与View帮助命令成功，未启动UI或运行Agent。

- 现有data综合集不改动，完整Agent实现后核验启用；阶段当期使用stage-evals/Pn，不等待整体完成。
- 阶段数据只保留README.md、cases.json、必要gold.json/fixtures；Oracle嵌入Case，质量优先、不设配额，样本不足限制统计结论。整理P0资产也建立README/Case索引，复用现有F及报告，仅补缺少夹具；不要求业务Gold、模型或真实Agent适配器。
- 拟新增适配全部位于src：runner/inspect_tasks.py、adapters/flowmate.py和flowmate.ts、graders/inspect_scores.py、analysis.py。TS调用公共产品入口，产品不反向依赖质量侧。
- Python依赖拟由本目录pyproject.toml/uv.lock统一锁定；根bun.lock仍管理JS/TS。当前安装无需重装，上游Inspect源码不放项目代码。
- 新真实运行产物位于runs/<executionId>，旧P0报告已删除；产品实例在质量根以外。

完整使用、协议和工作包以[评测主方案第10章](docs/spec/01_Flowmate_Agent评测总方案.md#10-评测设施与工程对接)为准。下方现有工具命令仍属于综合材料离线准备，不能获得Inspect产品成绩。

阶段制作、逐阶段材料来源和Case/Gold完整设计示例统一见[§10.5](docs/spec/01_Flowmate_Agent评测总方案.md#105-数据怎样准备阶段集怎样映射)。Task加载Case，Solver只传获准输入，Scorer读取质量侧Oracle/Gold；四类状态分别为数据准备、可执行、评测完成与阶段通过。综合集后置使用是本次新安排，不改写原先跨阶段筛选的历史。

兼容待办见§10.5.7：旧工具的--stage仍筛选综合集，P0报告已按实际依赖调整，产品评测待用户执行；文档修订不会自动改变代码行为或历史摘要。P0阶段README和Case索引已创建；Inspect适配器尚未实现。

P1–P13 同样无交互启动：参数来自固定配置/环境/命令，缺项说明配置位置后退出，不新增确认表单或自动审核。P8/P12 的产品人工复核和审批保留，真实批准不能代签。旧无策略证据沿原规则，未知策略或绑定错配不能通过；规范细则见总方案 §10.1.1、§10.5.7。

产品行为契约来源是本次绑定的产品主方案；本评测总方案拥有指标、评分和证据规则，产品行为描述仅作测试映射。冲突在既有阶段文档登记并修正、复核资产适用性，解决前不据此宣称通过，不改变历史结果或删除独立质量要求。

## P1 起的实例生命周期与阶段阅读入口

阶段 Case 只维护一份，产品实例 `FlowmateData/<instanceId>/` 保存真实数据库/文件/状态，`runs/<executionId>/` 保存 Inspect 日志、证据与结论。既有 `binding.json` 关联 Case、Sample/epoch、Trial、实例及实际产品 Run；同 Trial 多轮/重启/恢复保留现场，一个批次可有多个独立实例。

P1 拟新增质量配置 `instanceRetention`，默认 `preserve_on_failure`，调试可选 `preserve_all`。完整 Trial 结束且产品关闭、证据独立保存及评分/日志/绑定落盘后，只有全部回收条件成立才删除控制器新建的专用实例；失败、未完成、缺证据、UNKNOWN 或待恢复保留。删除失败记录设施错误和残留位置，不改原业务评分。日常产品、共享来源、P0 和历史目录不适用；产品 Session 保留政策不变。完整规则见[§10.7.1](docs/spec/01_Flowmate_Agent评测总方案.md#1071-评测专用实例保留与回收p1-拟实施)，不新增 Runner、清理服务或成绩库。已保留失败实例的长期维护在 P13.3 细化，此前默认保留、不按天数自动删除；未来清理仍须满足所有权、关闭、独立证据和无未决责任的条件，不改原评分或删除评测证据。

P1–P13 先看产品第21章的阶段验收卡，再看评测第11章对应条款；当期固定三份文档：`docs/spec/Pn_阶段目标方案.md`、`docs/plans/Pn_阶段实施计划.md`、`agent-eval/docs/plans/Pn_Agent评测实施方案.md`。先核实依赖并编写目标，再编写产品计划及评测方案；产品实现/F、阶段资产和执行依据就绪后，使用 Inspect 开展 A/适用 B 与回归并交接。目标方案定义公共契约，评测方案引用真实入口并给出独立判据；不额外拆评测目标文件。P4 假 Runtime IPC 探针只算工程 F 设计证据，P8 按三步取证，P12 的四个里程碑分别关联既有三类测试环境，P13 按承载迁移、故障恢复、安装运维、生产放行四步推进；里程碑和验证环境分别标记，均复用各自同一阶段数据目录与 Inspect 接入。Inspect 适配和实例回收尚未实现；P0 保留原两份方案、无交互入口和判定规则。

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
├─ tools/
│  ├─ p0/                      # P0专用编排、来源审计与报告复核
│  ├─ comprehensive/           # 综合数据准备、核验、治理、重建和工具自检
│  └─ 少量路径固定兼容入口      # 保持数据说明、Benchmark和设施夹具既有引用
├─ src/runner/initial_dataset.py # 当前综合材料离线选择与就绪检查
├─ src/runner/inspect_tasks.py   # 拟新增Inspect任务入口
├─ src/adapters/                # 拟新增Python/TS适配
├─ stage-evals/Pn/              # 当期高质量Case/必要Gold与夹具
├─ runs/                        # 新实际运行的日志、证据和报告
├─ pyproject.toml / uv.lock     # 拟新增Python声明/锁
├─ tests/
│  ├─ p0/                      # P0判定与报告复核合成测试
│  ├─ comprehensive/           # 综合数据和质量设施测试
│  ├─ fixtures/                # 固定设施夹具
│  └─ test_coverage_metrics.py # 综合清单固定路径兼容入口
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
python agent-eval/tools/comprehensive/initial_dataset.py prepare --project .
python agent-eval/tools/comprehensive/initial_dataset.py verify --project .
python agent-eval/tools/comprehensive/initial_dataset.py report --project .
python agent-eval/tools/comprehensive/coverage_update.py check --project .
python agent-eval/tools/comprehensive/coverage_update.py publish --project .
python agent-eval/tools/comprehensive/coverage_update.py verify --project .
python agent-eval/src/runner/initial_dataset.py BM-08 --project . --stage P2 --split development --subset capability
```

`prepare` 执行首次迁移发布；当前格式已经发布后再次执行只核验，返回 `changed: false`。它不自动重签任意修改后的清单。`verify` 检查结构/引用/计数/隔离，`report` 显示真实统计。旧离线装配/评分命令按综合集的能力阶段标签筛选并报告阻断；真实Agent未接入时其执行保持blocked，不生成成绩或 Baseline。JSON 是唯一编辑源；JSONL 仅按需导出，不维护可独立修改的第二套数据。

内容维护使用 `coverage_update`：`check` 只读显示候选差异，`publish` 校验当前摘要后从受控声明同步当前材料，`verify` 检查发布结果。覆盖清单的结构版本为 2，任务和契约仍为 1；父级功能、原子条件、指标协议分别报告，均不代表真实产品已通过。

## 权限与责任

被测主 Agent、子 Agent、工具发现、Context 和文件访问必须排除整个 `agent-eval/`。可信控制器仅交付任务授权的输入投影；标签、Gold、契约答案、Rubric、目标失败模式、其他 Trial 输出和评分代码留在质量侧。工具环境及故障由可信控制器装配，答案不能改名后当作产品输入。

产品 F 验证归产品模块与根目录测试，真实模型 A 验证依赖真实 Pi/产品入口，业务 B 结论依赖独立权威业务结果。评测设施不复制产品 Runtime/Workflow。下一步P1落实Inspect最小适配、阶段输入投影、可信采证、确定性评分和必要Gold核验；仅第7.5适用场景触发人工复核，不设置全体Case独立签名门槛。现有综合集在完整Agent后另行核验启用。
