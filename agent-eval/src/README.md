# Agent评测设施：现有离线工具与拟新增Inspect接入

现有代码主要提供离线装配和评分设施；Inspect接入仍为设计，已有P0产品工程不等于真实Agent适配。新任务和契约采用 `schemaVersion: 1`；实际数量以 `data/manifests/active-dataset.json` 为准。装配不会创建真实 Trial、调用模型或提交业务，真实产品运行数与 Baseline 均为 0。

P0 独立入口为 `bun run p0:eval`，无交互、无 Inspect；`runner/p0-binding.ts` 固定 `p0-local-f/v2`，本地 development F 不要求手填用途声明，不生成授权或审核身份。旧无策略证据维持原规则，未知策略和绑定错配拒绝；来源许可未核实不由技术 PASS 解除。P1 起共用 Inspect 入口也不提问，缺配置即说明原因和位置后退出；业务人工批准仍按产品契约执行。

P1–P13 的目标、实现和评测按三份文档分工：产品目标方案定义公共契约，产品实施计划落实内部实现，Agent 评测实施方案引用真实入口并定义独立判据，名称和位置见[评测总方案第12章](../docs/spec/01_Flowmate_Agent评测总方案.md#12-后续阶段评测方案的编制规则)。产品行为测试映射冲突按执行绑定的规范版本核对，修正并复核适用性后再采用结论；不复制第二份产品规范，也不改历史结果。P0 保留原文件及规则。

## 当前入口

在项目根目录执行：

```powershell
python agent-eval/tools/comprehensive/initial_dataset.py verify --project .
python agent-eval/src/runner/initial_dataset.py BM-08 --project . --stage P2 --split development --subset capability
python agent-eval/src/runner/initial_dataset.py BM-03 --project . --capability tool_use --output .cache/exports/tool-inputs.jsonl
```

- `verify` 核对格式、身份、引用、摘要、用途和当前文件库存，以及原票、提供方标签的完整性。
- `--stage` 仅按阶段标签筛选现有综合集，不能读取stage-evals/Pn；`--split`选择数据用途，`--subset`选择capability或regression测量目的。这些是旧离线入口的行为说明，当前阶段评测不据此启动综合集。
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

首次真实产品执行后，证据和报告保存到 `agent-eval/runs/`，固定数据目录不保存运行结果。P1起Trial/Sample生命周期由Inspect管理，项目只保存与产品实际对象的关联；独立执行从隔离初态开始，同一执行内的恢复保留已经发生的状态。

## 回归检查

```powershell
python -m pytest agent-eval/tests/comprehensive/test_initial_tasks.py agent-eval/tests/comprehensive/test_initial_dataset.py agent-eval/tests/comprehensive/test_initial_publication.py -q
```

这些检查验证格式、物化、引用闭合、阻断、评分自检及发布回滚，不是产品运行成绩。

详细字段与数量见 [数据 README](../data/README.md)，使用流程见 [数据使用方案](../docs/data/data-usage-guide.md)。


## Inspect接入落点（拟新增，P1实施）

| 文件 | 职责 |
|---|---|
| runner/inspect_tasks.py | 阶段/综合入口、预检、固定选集及Sample映射 |
| adapters/flowmate.py | 自定义Solver；驱动Bun、进程生命周期、版本化消息和可信采证 |
| adapters/flowmate.ts | 经公共composition/Application调用真实产品；不实现业务规则 |
| graders/inspect_scores.py | 复用已核验Grader、映射五态/适用性与自定义指标 |
| analysis.py | 同批次日志/报告的失败、耗时、质量/成本分析 |

CLI执行，Inspect View消费相同日志。现有initial_dataset/evidence/graders保留，契约适配先自检，不能删除product_adapter_required就宣称接通；不伪造VerifiedObservation。新版产品接口只能在其实际阶段映射。整个质量根、Sample元数据和Gold不得直接交给Agent；只传获准投影。产品实例根和配置必须位于agent-eval之外。

现有data综合集完整Agent后核验启用；stage-evals/Pn当期执行，数据质量优先，代码不按阶段复制。精确签名、协议、命令、状态、版本锁及I1–I5工作包见[主方案第10章](../docs/spec/01_Flowmate_Agent评测总方案.md#10-评测设施与工程对接)，本目录不维护第二份接口规范。


## P1 拟新增的实例回收边界

同一质量适配层负责控制器新建专用实例的生命周期；不新增调度器、清理服务或状态库。配置 `instanceRetention` 映射为拟新增 `TrialContext.instance_retention`，默认 `preserve_on_failure`，可选 `preserve_all`。`TrialResult.cleanup_confirmed` 只证明产品关闭及资源释放；既有 `binding.json` 另记实例关联与回收状态。

Solver 的 finally 负责 cancel/close，不能提前删除现场。须在完整 Trial、Scorer、可信证据和 Inspect 日志/绑定落盘后才判断回收，实际落盘时点在 P1 锁定环境中验证；未确认就保留。必要证据须脱离待删实例仍可复核。失败、缺证据、取消/未完成、UNKNOWN、待恢复、未释放及路径/所有权异常均保留并记录；删除失败不改写业务评分。只回收本控制器新建实例，不改产品持久 Session 保留规则或 P0 行为。接口和完整合成自检要求集中于评测总方案 §10.6–10.8、§10.12。

P4 收尾的假 Runtime IPC 探针属于产品工程测试；本目录 Python—TS 通信不能作为该探针或 P13 真实 Host 通过证据。

失败实例长期保留及人工清理在 P13.3 运维说明细化；此前已保留失败实例默认保留，不增加 TTL 配置或自动到期删除，不影响符合条件的成功 Trial 回收。未来清理须确认所有权、资源释放、证据独立保存且无 UNKNOWN／未决恢复／核对责任；不改原评分、不删评测证据，本次不提供清理实现或命令。

## 阶段资产与兼容交接

阶段README/Case、按需Gold/fixtures的字段与制作集中于[主方案§10.5](../docs/spec/01_Flowmate_Agent评测总方案.md#105-数据怎样准备阶段集怎样映射)。整理P0也建立索引，复用F测试/Oracle/历史证据，无需Agent Solver或业务Gold。P1起拟新增load_cases/to_sample分离Sample可见输入与控制/评分资料；Scorer读取质量注册表，产品不读取Case/Gold。阶段包装示例不能直接交给旧initial_contract假定兼容。

后续I2用合成自检验证stage入口不访问无关综合资产；P0报告已按实际依赖调整，逐Case解释器位于tools/p0/p0_stage.py，绑定辅助位于src/runner/p0-binding.ts；均不是Agent Runner，实际执行待用户进行，见§10.5.7。运行记录绑定Case/Gold/输入/判据/Grader/产品/配置和环境；修订生成新版本，旧结果保留原依据。规范更新不等于适配完成，也不自动解除实际数据用途问题。
