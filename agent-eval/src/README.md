# 评测源码职责

[操作与配置](../README.md) · [评测指南](../../docs/public/EVALUATION.zh-CN.md) · [基准制作](../../docs/public/EVALUATION-BENCHMARK.zh-CN.md)

评测通过隔离 Host 使用产品核心执行任务。执行事实、业务交付、质量评分和相对回归是不同结果；工程测试只验证相应实现行为。

| 目录/入口 | 职责与数据边界 |
|---|---|
| `cli.ts`、`configuration.ts` | 解析命令与专用配置；Smoke/Full 入口编排双模型运行，普通 run 保留单模型语义 |
| `datasets/`、`dataset-loader/` | 维护原始 Full62、Smoke7 选集，加载 Case/Gold/Review/scenario；Gold、私有检查与后续轮次不提前暴露给被测 Agent |
| `execution/`、`adapters/` | 在隔离 Host 执行，记录请求响应、工具、子 Agent、事件及业务回执 |
| `scoring/` | 25 个本地实现＋30 个 Metric 独立语义定义，39 项正式指标；Case 路由，Trial 0／1 次合并 Judge；独立单项／组合校准，共用计数与见证校验 |
| `text-model/` | 挖掘使用原生 Codex Luna/max；Judge 通过现有 HTTP 网关调用 Terra/max，传输由 `scoring/judges/client.ts` 统一管理 |
| `reports/` | 写入单个 Run 的 `README.md` 和 `run.json`；所用 Case/Gold/scenario/评分快照保存一次 |
| `langfuse/` | 上传同一次运行的观察及分数并回读；未知写入先回读，原始本地事实继续保留 |
| `experiments/` | 检查可比条件、双模型比较、明确 Baseline 与按选集执行的 Gate |
| `curation/`、`review/` | 独立产品 Trace、候选挖掘/校验/人工审核/发布与四类反馈；不随 Smoke/Full 自动触发候选操作 |
| `desktop/` | 桌面操作与完整原始 JSON 阅读入口；页面摘要不能替代完整证据 |

Full 保留原始 **62 题（业务 50、研究 12）**。Smoke 为 **7 题（业务 5、研究 2）**：FM-001、FM-002、FM-027、FM-033、FM-046、FM-051、FM-055。两个标准命令均为 DeepSeek 对照、网关 Luna/max 候选、每题每模型一次，分别为 14 与 124 个被测 Trial。

运行写入 `agent-eval/runs/Run-<Shanghai date_time>-smoke|full-compare-01/`，目录内仅 `README.md`、`run.json` 和必要二进制 `materials/`。每 Trial 原始 I/O、模型/工具/子 Agent 观察、回执、Judge、诊断、比较、Gate 与上传状态都在同一 JSON 中；不新增逐 Trial evidence、experiment、comparison、gate 或 export 旁文件，也不复制 Benchmark Trace。

独立产品 Trace 用 `traces/Trace-<date>-<entry>-<purpose>-01.json` 平铺保存，内部 UUID 保持关联。三类候选分别在 datasets 下同级集合内平铺；发布到 `published/Benchmark-<name>/Version-001-<date>/benchmark.json`。这些资产只在真实操作发生后生成。候选不是可运行基准成员，validated、真实重放与当前真人批准分别记录。

Baseline 集合为 `agent-eval/baselines.json`，四类 HumanFeedback 共用首次实际反馈后才创建的 `agent-eval/feedback.json`。Smoke7 与 Full62 分开做 Gate；相对未退化不代表绝对质量通过，单次重复也不证明稳定性。完整规则和配置以[模块说明](../README.md)及[评测指南](../../docs/public/EVALUATION.zh-CN.md)为准。

评分定义位于 `scoring/judges/metrics/` 的十个领域文件，`judges/evaluators.ts` 显式汇总。每个 Metric 独立维护 Rubric 和版本，不持有模型客户端；公共类型为 `SemanticMetricDefinition`。`evaluator-plan.ts` 负责 Case 路由，`evaluators/semantic.ts` 处理事实与触发条件，`judges/harness.ts` 提交一个合并请求。`compact.ts` 保留计数、研究见证和历史协议；`evaluator-snapshot.ts` 只读保存的定义，不用当前源码解释历史版本。

`judges/calibration.ts` 维护独立参考，`--metric` 过滤目标而不改标签，按 ID 汇总；`calibration-coverage.ts` 检查单项／组合范围、定义与 Judge 条件。评分上下文可显式提供已保存的 `calibration` 报告；缺省为 `not-provided`。`matched` 不等于合格，工程样例来源和 `acceptance: not-assessed` 始终可见。新流程保存 `scoringVersion: 2`；Case 成员、Gold、指标公式和 Gate 阈值保持原义。
