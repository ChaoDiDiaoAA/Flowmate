[English](EVALUATION-BENCHMARK.md) | [简体中文](EVALUATION-BENCHMARK.zh-CN.md)

# Flowmate 基准制作

基准将有独立证据支持的任务变为可复测评测。从任务与证据出发，定义成功/失败，校验受控场景，再在当前真人批准后发布明确版本。Trace、候选与正式 Case 是不同资产。

[评测指南](EVALUATION.zh-CN.md)解释执行、评分与 Gate，[模块说明](../../agent-eval/README.md)说明配置及保存位置。

## 原始基准与选集

Full 保留原始 **62 题：业务 50、研究 12**。Smoke 为 **7 题：业务 5、研究 2**：

`FM-001、FM-002、FM-027、FM-033、FM-046、FM-051、FM-055`。

标准 Smoke/Full 命令比较 Sol 与 Luna，每题各重复一次，分别产生 14/124 个被测 Trial。新候选不会自动加入任一选集；评测新增成员时明确选择已发布基准版本。

## 从真实任务和独立材料开始

保留原始用户输入、轮次、授权材料、场景条件和来源 Trace 身份，保留原语言及顺序。证据不完整时记录缺口，不补造未采到的输入。

使用独立材料证明正确答案、合法业务值与必要行为。决定性要求需绑定来源位置或可独立核验的规则。被测回答、Judge 的旧判断及看似合理的解释都不能充当独立 Gold。

| 组成 | 内容 |
|---|---|
| Case | 身份/版本、输入、类别、难度、任务用途与期望行为 |
| Gold | 独立事实、可接受值、来源见证与评分规则 |
| Review | 题目质量、歧义与证据充分性的作者侧检查，明确来源；Agent 自审与真人批准分别记录 |
| Scenario | 受控产品状态及按任务授权交付的材料 |
| Source | 解释候选来源的真实 Trace 与材料引用 |

Gold、Review、私有场景控制和未来用户轮次不提前进入被测 Agent 首轮上下文。评分侧使用这些材料，被测侧仅接收任务授权的输入和产品资源。

## 选择候选类型

| 集合 | 用途 |
|---|---|
| Gold candidates | 有独立预期证明的真实成功轨迹 |
| Bad candidates | 值得定位的真实失败，证据足以区分能力失败、评分问题与采证故障 |
| Regression candidates | 应可复现、用于守住后续修复的真实缺陷或失败 |

候选类型 `gold` 不等于难度 `golden`。新回归 Case 使用 regression 用途/难度，并保留真实缺陷与 Trace 来源。候选是待审核资产，不是可运行 Dataset。

已覆盖且预期不变的任务复用原 Case。原输入、场景、标签、材料不变，仅修正预期或评分时，使用 `reviseCase: { id, version }` 指向当前已发布 CaseVersion；与 `reuseCaseId` 互斥。改变任务目标应新增 Case。

## 发布前校验

核对 schema、来源绑定、独立预期和受控场景。成功候选需要正例控制；失败候选还需要复现相关失败的负例控制。分别记录每项控制实际证明了什么。

受控回放验证夹具/场景和评分器行为；真实模型重放验证被测模型在这些条件下的表现，两者分别报告。`NOT_RUN` 不能当作 PASS。候选重放使用现有 Luna 网关的 `gpt-6-luna/max`，挖掘使用原生 Codex 的 `gpt-6-luna/max`；两者不随 Smoke/Full 自动执行。

独立材料不足以确定预期时保留待补证据或 blocked 状态，写明具体缺口。不能为了让旧答案通过而降低要求。候选改为新 revision 后，重新校验并取得当前批准。

## 审核与版本发布

真人审核判断题目与 Gold 是否正确、有用；批准须对应当前候选 revision 和发布目标。Agent 建议、校验成功或真实重放 PASS 不能替代这一批准。

发布保存含明确 CaseVersion 成员的基准快照。修订已有 Case 增加对应 CaseVersion，旧版基准快照保留原始条件。候选 revision、CaseVersion、基准 version 分别表示不同层面的变更。

本指南不预先批准任何候选。真实操作发生后才创建候选、反馈和发布版本。挖掘、重放、审核与发布均保持明确操作，评测结果不会自动发布 Case。

## 每项资产集中保存

```text
agent-eval/
  traces/
    Trace-<date>-<entry>-<purpose>-01.json
  feedback.json
  src/datasets/
    gold-candidates/
      Gold-<date>-<purpose>-01.json
    bad-candidates/
      Bad-<date>-<purpose>-01.json
    regression-candidates/
      Regression-<date>-<purpose>-01.json
    published/
      Benchmark-<name>/
        Version-001-<date>/
          benchmark.json
          materials/              # 仅必要二进制材料
```

这是命名约定，不表示资产现已存在。各候选集合内平铺保存文件，内部 UUID 和明确版本保留关联。不预建空候选、反馈或发布快照。

候选 JSON 集中保存 Case、独立证据、校验/重放和审核状态；发布的 `benchmark.json` 保存版本快照，必要二进制材料可随附。不另建 approval、replay、validation、export 旁文件目录。

Case 质量、保存 Run、Trace、候选审核四类 HumanFeedback 共用 `agent-eval/feedback.json`，第一次实际反馈后才创建，原始评分保留。Benchmark 的轨迹已在 `runs/Run-<Shanghai date_time>-smoke|full-compare-01/run.json` 内，不复制到产品 Trace 集合。

## 运行后怎样解释结果

比较两侧使用相同明确 CaseVersion、独立 Gold、评分规则与场景条件。先读实际模型输入、工具/子 Agent 观察和业务回执，再把差异归因于配置。

Baseline 统一保存在 `agent-eval/baselines.json`；Smoke7 与 Full62 范围分开。关键指标和必要断言零退步，实际泄漏/禁止副作用为零，其他归一化质量比例最多绝对下降 `0.02`；缺失、错误、不可比证据阻断 Gate。

相对 Gate 通过仍可能保留已知失败。呈现绝对质量及各指标分子/分母；一次重复不证明稳定性，新增或修订题目不证明产品修复成功。后续验证须绑定具体失败、受影响要求与可比条件。

## 按 Metric 选择评分，不按调用次数设计案例

Case 的 `scoring.judge` 使用 Metric ID，例如 `['tool-selection', 'tool-arguments']`。目录有 30 个独立语义定义，按 10 个领域组织，其中 2 项为可选诊断；正式指标仍为 39 项。既有 25 个本地实现继续复用，活动实现共 55 个。Case 的预期和独立 Gold 细化本题判据，不改写指标单位或公式。

每个 Trial 将适用语义项合并为 0／1 次逻辑 Judge 提交。缺证据不能自动记作不适用，已知失败也不因采证不全消失。明确必要／可选条件及原始机会分母。新增语义诊断的 `evaluatorId` 使用对应 Metric ID；历史 `task-judge`／`tool-use-judge` 声明依据明确的 `params.metricId` 读取。

修改 Evaluator 的 Rubric、证据契约或校验行为，需要修改该项独立版本；公共协议变化需要修改对应评分／模板版本。Case／Gold 版本规则另行保留。旧结果仍可读，评分条件不兼容时比较和 Gate 阻断。单指标校准不能代替组合效果；校准未提供、覆盖不足或版本不匹配均需显示。详见[评分与校准](EVALUATION.zh-CN.md#evaluator先核对行为再判断语义)。

执行预算属于 Run／实验条件，调整预算不修改 Case 或 Gold，旧结果保留原预算。显式补评分使用原执行保存的 Case／Gold 版本；评分修订不等于发布新的 Benchmark。
