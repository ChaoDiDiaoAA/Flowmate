# Flowmate

基于 Pi SDK 的数字员工产品，首个业务场景是：使用已有合格解析结果和获准原票证据，完成发票字段抽取、适用业务核查、人工复核、具体动作审批、B2B 录入及权威结果核对。

**已有 P0 产品基础实现，当前为收尾与阶段评测准备完成、等待用户执行。** 公共 Application、默认 Workspace、受控文件/SQLite、输入发布读取及无桌面 CLI 已存在；本轮改动仅经过静态检查和合成设施自检，未重跑产品评测。Pi 模型/Agent Loop 属于 P1，尚不能宣称真实 Agent 或业务验收通过。

## 文档入口

| 想了解什么 | 阅读入口 |
|---|---|
| 为什么做、总体架构、模块职责、业务与存储、实施路线 | [产品主方案](docs/spec/00_Flowmate完整方案.md)，产品建设的唯一总方案 |
| 功能机制、真实 Agent 行为、业务结果如何分别验证 | [Agent 评测总方案](agent-eval/docs/spec/01_Flowmate_Agent评测总方案.md) |
| 当前评测资产、目录及工具入口 | [评测 README](agent-eval/README.md) |
| 数据如何制作、对齐与使用 | [制作方案](agent-eval/docs/data/data-preparation.md) · [对齐方案](agent-eval/docs/data/data-alignment-plan.md) · [使用指南](agent-eval/docs/data/data-usage-guide.md) |
| 领域概念 | [领域术语](CONTEXT.md)，具体契约以主方案为准 |

`docs/v1/` 保留逐章修改方案，当前设计及执行依据以 `docs/spec/` 主方案为准。P1–P13 进入对应阶段后编写产品目标、产品实施计划和 Agent 评测实施方案三份文档；P0 保留既有两份文件，不提前生成空稿或空包。

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
- 目标只建设 Session 会话记忆，随 P4/P6/P7 接入（P0 尚无会话持久化），复用 Pi 历史与压缩语义；不额外建设跨任务长期记忆、向量检索或自动经验提炼引擎。保存正确与模型正确使用记忆分别验证。
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

P1–P13 从产品主方案第21章的阶段验收卡开始阅读：明确新增能力、真实任务、必要 F/A/适用 B、失败与回归、退出证据及索引。阶段目标放 `docs/spec/Pn_阶段目标方案.md`，产品实施计划放 `docs/plans/Pn_阶段实施计划.md`，评测方案放 `agent-eval/docs/plans/Pn_Agent评测实施方案.md`。按“核实当前实现与依赖 → 编写阶段目标方案 → 编写产品实施计划及评测方案 → 产品实现与 F 验证 → 完善阶段资产 → 冻结执行依据 → Inspect 执行 A／适用 B 与回归 → 结论及交接”推进，目标方案首页细化阶段卡，计划与评测引用契约，不再另建 Gate Card 或评测目标文件。P4 收尾增加假 Runtime 的最小 IPC 工程探针，P8 按事实接受/人工等待修订/检查点恢复三步推进，P12 按 UI → 本地动作模拟 → 企业契约模拟 → 获准真实测试四个里程碑实施；P13 按承载迁移、故障恢复、安装运维、生产放行四个内部里程碑推进；里程碑进度与 Test/Shadow/Canary/Production 环境分别记录。均是后续设计，不表示已经实现。

P1 起拟由同一 Inspect 适配管理专用测试实例：Case 是任务定义，`FlowmateData/<instanceId>/` 是产品现场，`agent-eval/runs/<executionId>/` 是评测证据与结果，既有 `binding.json` 关联它们。默认 `instanceRetention=preserve_on_failure`：完整通过、产品关闭及评分/独立证据落盘后才清理；异常、未完成、UNKNOWN 或待恢复时保留，调试可选 `preserve_all`。只处理控制器新建的专用评测实例，不影响日常产品、P0 实例或历史目录；详见评测总方案 §10.7.1。失败实例的长期保留和人工清理在 P13.3 细化；此前对已保留失败实例默认保留，不增加自动到期删除，也不影响成功 Trial 正常回收。该规则不改变 P0；P0 无交互入口和技术判定策略见下方操作命令。

P12-A 通用模拟、P12-B 企业契约模拟、P12-C 获准真实测试分别报告。Test → Shadow → Canary → Production 是 P13 内的放行阶梯；工程验证、质量结论、生产放行和逐动作批准不能互相替代。

## 当前数据与评测状态

**2026-09-20 历史本地制作报告盘点（本次收尾未重跑综合集核验）：**

| 项目 | 当前记录 |
|---|---:|
| 原票及配对解析 | 2,902 份 |
| 提供方标签 | 1,414 份 |
| Gold 材料／已登记人工核验 | 100 份／0 份 |
| 模拟业务资料 | 80 套 |
| 完整 Agent 任务 | 78 个（当前上限 100） |
| 产品契约 | 14 套／460 个场景 |
| 综合集真实 Agent 运行／Agent Baseline | 0／0（不包含 P0 产品 F） |

**综合集历史核验阻断（2026-09-20）：** `initial_dataset.py verify` 与 `coverage_update.py verify` 均报告 `Benchmark definition pin drift`，表示 Benchmark 定义与清单固定摘要不一致，当前材料不能宣称完整核验通过。下列命令可用于复查；本次 README 更新未修改数据或重新发布清单。

以上是历史核对的盘点，后续以本地 [制作报告](agent-eval/data/manifests/preparation-report.json) 和当前清单为准。Gold 材料存在不等于人工核验完成；契约场景、字段检查、工具调用和子 Agent 不计作独立 Agent 任务，也不代表已执行成绩。

产品输入位于 `data/invoices/voxel51/`；外部来源为 `D:\obsidian\data\flowmate-data\Evidence\invoices\voxel51`，保留来源副本，产品运行不依赖该外部路径。提供方标签及 Gold、Case、评分资料在独立 `agent-eval/data/` 根下，产品 Agent、子 Agent、工具发现和 Context 不得读取；仅由可信控制器交付获准输入投影。

`data/invoices/`、`FlowmateData/`、`agent-eval/data/` 和评测运行产物均被 Git 忽略，克隆仓库不会自动取得本地资料。文件准备不代表 P0 的产品读取链路、默认 Workspace 和基础存储已验收。

产品行为以本次绑定的产品规范为依据，评测总方案负责独立质量判据；测试映射冲突须修正并核验适用性，不能用新工作区文本改写旧运行或借产品优先降低质量要求。具体分工与变更见两份主方案，当前能力以代码和实际证据为准。

## 各阶段操作命令

每实现一个阶段，必须同步本节的状态、环境、操作/验证命令、结果位置、清理方式和方案链接。只登记已实现入口；命令能执行不等于该阶段已验收。当前只展开 P0，P1–P13 随实施补充。

### P0：基础输入、身份、存储与确定性 F

状态：已有实现；旧 F 报告已按用户要求删除，仅保留历史文字记录；本次收尾含新修复、新边界测试及独立 Case，**等待用户执行新评测**。历史成绩不自动适用于修改后的源码。P0 不用 Inspect AI，没有模型运行或桌面常驻服务。

工作目录 `D:/code/Flowmate`；Bun ≥1.4、Node ≥24、已有 Python/Pillow/pytest 环境及本地 `data/invoices/voxel51/`。JS 依赖按 `bun.lock` 安装。启动后直接检查，不询问用途依据或记录人，也无需交互终端。

```powershell
Set-Location D:/code/Flowmate
# 依赖尚未安装时执行
bun install --frozen-lockfile
# 完整 P0 评测：直接执行，无需输入
bun run p0:eval
```

该命令自动创建本次实例和报告目录、固定版本、执行现有测试/来源审计/发布读取/重启重读/故障探针并逐 Case 复核。它不运行模型，也不使用 Inspect AI。底层命令和失败定位见 [P0 阶段执行 README](agent-eval/stage-evals/P0/README.md)。

结果：命令最后直接显示通过、失败或未完成及报告位置。`agent-eval/runs/<实际ExecutionId>/summary.md` 是可读摘要，`stage-review.json` 是逐 Case 正式复核结果，步骤日志用于排错。缺证据、版本错配、必要覆盖缺口或产品策略拒绝仍不能通过。新运行绑定 `p0-local-f/v2`，本地技术 F 不要求人工用途声明；来源许可未核实的事实保留，PASS 不表示数据许可、业务语义、Agent 或生产用途通过。

副作用与关闭：全量发布仅写本次 `FlowmateData/p0-evals/<实际ExecutionId>/`，`capture` 写输入投影与审计；CLI 正常结束显式关闭资源。异常后先确认进程停止与句柄释放，不能盲删锁。测试和故障探针仅修改它们的临时副本；全量实例及报告保留，用户核对后再处理，历史输出不覆盖。

依据：[P0 产品方案](docs/plans/P0_阶段实施方案.md) · [P0 评测方案](agent-eval/docs/plans/P0_Agent评测实施方案.md) · [P0 Case](agent-eval/stage-evals/P0/cases.json)。

如果旧命令还停在提问处，先按 `Ctrl+C` 结束，再重新运行 `bun run p0:eval`。新版创建新目录，不恢复旧进程或覆盖旧结果。P1–P13 同样规定无交互启动；缺必要配置时说明原因并退出，后续命令随实现登记。

### 综合评测集维护（完整 Agent 实现后核验启用）

以下是综合资产报告/维护入口，不是本期 P0 评测命令。旧离线 `--stage` 参数仍筛选综合集，不加载独立阶段目录。

```powershell
Set-Location D:/code/Flowmate
python -B agent-eval/tools/comprehensive/initial_dataset.py report --project .
# 完整 Agent 实现后核验现有综合材料时使用
python -B agent-eval/tools/comprehensive/initial_dataset.py verify --project .
python -B agent-eval/tools/comprehensive/coverage_update.py verify --project .
```

准备或发布资料的写入命令见[评测 README](agent-eval/README.md)及[数据制作方案](agent-eval/docs/data/data-preparation.md)。本次未运行以上综合核验、未改清单/Gold/Benchmark。综合集真实 Agent 运行数为零，不能用来否定已有 P0 产品读取链路；P0 F 通过也不能代替完整 Agent 评测。

## 业务边界

保留字段抽取与规范化、按需供应商／订单关联，以及适用的收货、合同、价格、数量和订单余额核查。关联用于确定目标字段，业务核查用于判断既定条件，两者分开。人工复核接受业务事实；有资格人员批准具体冻结动作后，产品才进行最终发送准入。

当前不建设产品内 OCR／Parser、自动拆合票、外部独立验真、ERP 回写、付款／入账流程、额度／多级财务审批、通用员工创建、复杂配置管理页面或第二业务领域演示。ERP 可作为获准只读依据来源。外部结果未知（UNKNOWN）先按原动作核对，不因重启、回送丢失或切换提交路径自动重发。
