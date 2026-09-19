# 初始评测数据的离线设施

当前处于方案设计阶段。新任务和契约采用 `schemaVersion: 1`；实际数量以 `data/manifests/active-dataset.json` 为准。装配不会创建真实 Trial、调用模型或提交业务，真实产品运行数与 Baseline 均为 0。

## 当前入口

在项目根目录执行：

```powershell
python agent-eval/tools/initial_dataset.py verify --project .
python agent-eval/src/runner/initial_dataset.py BM-08 --project . --stage P2 --split development --subset capability
python agent-eval/src/runner/initial_dataset.py BM-03 --project . --capability tool_use --output .cache/exports/tool-inputs.jsonl
```

- `verify` 核对格式、身份、引用、摘要、用途和当前文件库存，以及原票、提供方标签的完整性。
- `--stage` 筛选当前阶段，`--split` 选择数据用途，`--subset` 选择 capability 或 regression 测量目的。
- `--capability`、`--task-type` 根据任务标签筛选，必要对照仍按依赖关系闭合。
- `--output` 仅导出模型允许接收的输入 JSONL，不导出整份 Case、Gold 或评分断言。项目内导出限定在 `.cache/exports/`，拒绝覆盖已有文件。
- `prepare` 是首次迁移发布入口；当前格式已发布后再次执行只核验，返回 `changed: false`。它不恢复旧数据，不积累历史快照，也不是任意修改 Case 后自动重签清单的入口。

旧归档式制作入口不能覆盖当前发布。今后修订需同步更新当前引用、摘要及审核状态，不应沿用旧格式的 staging/archive 命令。

## 文件职责

| 文件或目录 | 职责 |
|---|---|
| `initial_contract.py` | 严格校验三种 kind、六维分类、检查项、受控场景协议及输入引用；未知配置拒绝 |
| `runner/initial_dataset.py` | 从当前清单解析任务和契约，验证固定引用，闭合对照，输出离线装配结果 |
| `runner/benchmarks.py` | 公共兼容入口，将当前数据转交初始评测装配器 |
| `runner/materialize.py` | 公共物化入口，区分当前任务与旧协议实现 |
| `runner/evidence.py` | 按受信采集器核对执行证据、身份和摘要；模型自报成功不构成可信证据 |
| `graders/observations.py` | 公共评分分派；当前格式交由对应的受控评分入口处理 |
| `graders/` | 证据投影和评分实现；已有确定性设施不能代替未接入的产品采集器 |

## 装配结果的边界

装配返回 `selectedIds`、`dependencyIds` 和逐成员计划。成员可能是完整 Agent 任务或产品契约场景，两者分别统计；契约场景数量不代表完整任务数量。

- `fixture.input`：可交给产品的用户目标、选中资料和输入。
- `fixture.harness`：仅可信控制器可读的初态、权限、故障和互动触发。
- `grading`：质量侧保留的 Oracle、检查项和对照引用。

原票抽取按明确允许的解析输入模式投影，Gold 不进入模型输入。模拟业务资料的审批等控制初态由控制器持有。整个 Case JSON 不直接交给模型。

## 证据与评分

材料准备、审核、正式冻结、执行资格和实际运行状态分别管理。装配成功不解除产品适配器、可信采证、Gold 核验或评分器依赖。当前产品评分保持未运行或不可判定；伪造的成功观测不能产生产品 PASS。

确定性证据投影需要完整台账、准确身份和观察窗口。缺少访问日志不能证明零越权，缺少目标台账不能证明零重复；缺证据与业务 UNKNOWN 分开处理。Planning 与 Reasoning 通过可观察决策、操作和结果评估，不读取隐藏思维过程。

`eval_selftest` 使用明确标记的合成观测，只验证设施本身。其 PASS 不计作产品 F/A/B 成绩。必要合法对照必须独立执行和评分，不能仅因存在引用就视为通过。

首次真实产品执行后，证据和报告保存到 `agent-eval/runs/`，固定数据目录不保存运行结果。未来独立 Trial 从隔离初态开始；同一 Trial 内的恢复保留已经发生的状态。

## 回归检查

```powershell
python -m pytest agent-eval/tests/test_initial_tasks.py agent-eval/tests/test_initial_dataset.py agent-eval/tests/test_initial_publication.py -q
```

这些检查验证格式、物化、引用闭合、阻断、评分自检及发布回滚，不是产品运行成绩。

详细字段与数量见 [数据 README](../data/README.md)，使用流程见 [数据使用方案](../docs/data/data-usage-guide.md)。
