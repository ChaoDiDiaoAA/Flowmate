# Flowmate Agent 评测

[评测指南](../docs/public/EVALUATION.zh-CN.md) · [基准制作](../docs/public/EVALUATION-BENCHMARK.zh-CN.md) · [Langfuse 评测与问题定位操作指南](Langfuse评测与问题定位操作指南.md) · [源码职责](src/README.md)

通过隔离本机 Host 执行真实产品任务，将原始执行、业务交付、质量评分和回归比较保存在同一次 Run 中。实际 Smoke／Full 结果、Full 中断与续跑边界及网页操作见上方中文指南。Langfuse 用于观察实际模型、工具、子 Agent 和评分；本地保存的原始证据用于复核比较与 Gate。

## 两个运行入口

在仓库根目录执行。两个命令都实际调用被测模型和适用的独立 Judge，并上传、回读 Langfuse，可能产生模型费用：

```powershell
bun --no-env-file run eval:smoke
bun --no-env-file run eval:full
```

| 入口 | Case 选集 | 模型与重复 | 被测 Trial 数 |
|---|---|---|---|
| Smoke | 7 题：业务 5、研究 2 | Sol 对照与 Luna 候选，各题各 1 次 | 14 |
| Full | 原始 62 题：业务 50、研究 12 | 同上 | 124 |

Smoke 的 Case ID 为 **FM-001、FM-002、FM-027、FM-033、FM-046、FM-051、FM-055**。完整执行两个入口共 **138 个被测 Trial**，不另加 canary。Judge 与挖掘调用不计入被测 Trial 数；没有适用语义项的 Trial 无需 Judge。

两个入口按顺序完成：预检 → 真实执行 → 确定性检查及适用语义项的一次合并 Judge → 本地原始证据保存 → Langfuse 上传与回读 → 失败诊断 → 双模型比较 → 对应选集的 Baseline/Gate → 人类可读 README。预检先检查数据、配置、角色可用性和平台连接；预检通过不代表模型质量通过。

质量 FAIL 是有效测量结果。执行与采证完整而质量失败，仍可完成比较与 Gate；缺失结果、评分故障、不可比条件或必要回读缺口须明确报告。不要为了得到全 PASS 重跑并覆盖失败。每题一次只能比较本轮观测，不能证明稳定性。

普通 `eval -- run` 仍为单模型执行；不要用它的默认值推断上述两个双模型入口的行为。只补处理已有 Run 的上传时使用：

```powershell
bun --no-env-file run eval:upload -- --run-id <RunId>
```

此操作读取已存证据，不生成新的被测 Trial。上传结果未知时先回读原操作，不能盲目重发。

## 模型与私有配置

评测配置文件为被 Git 忽略的 `agent-eval/configs/.env`；同名系统环境变量优先。`--no-env-file` 避免 Bun 自动加载仓库根目录的环境文件，评测自身按约定读取专用配置。不要在公开 JSON、报告、截图或命令输出中保存密钥。

| 职责 | 连接与模型 | 强度 |
|---|---|---|
| 双模型对照 | 现有本地网关，`gpt-6.1-sol`、`openai-completions` | `max` |
| 双模型候选 | 现有本机网关 `http://127.0.0.1:8767/v1`，`openai-completions`、`gpt-6-luna` | `max` |
| 独立 Judge | 现有本地 HTTP 网关，`gpt-6.1-terra` | `max` |
| 候选挖掘 | 原生 Codex CLI，`gpt-6-luna` | `max` |
| 候选真实重放 | 与被测候选相同的现有 Luna 网关 | `max` |

Judge 使用现有网关 `http://127.0.0.1:8767/v1`；挖掘复用原生 Codex ChatGPT 登录及 `FLOWMATE_CODEX_EXECUTABLE`。原生可执行文件不用于 Judge，不修改全局 Codex 配置。挖掘、候选重放和正式发布由明确操作触发，Smoke/Full 不自动执行这些操作。

下面仅为字段示例，空值需填入已有实际配置；不表示连接已验证：

```dotenv
FLOWMATE_EVAL_AGENT_BASE_URL=http://127.0.0.1:8767/v1
FLOWMATE_EVAL_AGENT_MODEL=gpt-6-luna
FLOWMATE_EVAL_AGENT_API=openai-completions
FLOWMATE_EVAL_AGENT_REASONING_EFFORT=max

# 仅用于双模型对照，不改变默认 Luna Agent
FLOWMATE_EVAL_CONTROL_MODEL=gpt-6.1-sol
FLOWMATE_EVAL_CONTROL_API=openai-completions
FLOWMATE_EVAL_CONTROL_BASE_URL=http://127.0.0.1:8767/v1
FLOWMATE_EVAL_CONTROL_REASONING_EFFORT=max

FLOWMATE_JUDGE_PROVIDER=openai-compatible
FLOWMATE_JUDGE_API=openai-completions
FLOWMATE_JUDGE_BASE_URL=http://127.0.0.1:8767/v1
FLOWMATE_JUDGE_MODEL=gpt-6.1-terra
FLOWMATE_JUDGE_REASONING_EFFORT=max
FLOWMATE_JUDGE_TIMEOUT_MS=180000

FLOWMATE_MINING_PROVIDER=codex-cli
FLOWMATE_MINING_MODEL=gpt-6-luna
FLOWMATE_MINING_REASONING_EFFORT=max
FLOWMATE_MINING_TIMEOUT_MS=180000
FLOWMATE_CODEX_EXECUTABLE=codex

LANGFUSE_BASE_URL=
LANGFUSE_PUBLIC_KEY=
LANGFUSE_SECRET_KEY=
```

Sol、Luna 和 Terra 共用已有本地网关，分别承担对照、候选和评分角色；使用现有本机登录，不向网关转发旧外部服务凭据。报告分别记录请求配置、实际返回的模型信息和已知传输限制；未报告的内部重试、费用或用量保持未知。

可单独执行不生成任务答案的检查：

```powershell
bun --no-env-file run eval -- dataset validate --dir agent-eval/src/datasets
bun --no-env-file run eval -- doctor --backend local
```

## 保存位置

每次双模型运行使用上海时间命名一个目录：

```text
agent-eval/
  runs/
    Run-<Shanghai date_time>-smoke-compare-01/
      README.md
      run.json
      materials/                 # 仅确有二进制材料时创建
    Run-<Shanghai date_time>-full-compare-01/
      README.md
      run.json
  baselines.json                 # Baseline 集合
  feedback.json                  # 首次真实人工反馈后创建
  traces/
    Trace-<date>-<entry>-<purpose>-01.json
  src/datasets/
    cases.ts
    gold.ts
    review.ts
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
          materials/             # 必要二进制材料
```

以上是布局约定，候选、反馈和发布目录只在真实操作发生时产生，不预填草稿。

`run.json` 保存本次运行的配置与可比条件、每个 Trial 原始输入输出、实际模型/工具/子 Agent 观察、业务回执、确定性与 Judge 结果、比例分子分母、上传与回读状态，以及诊断、比较和 Gate。所用 Case、独立 Gold、scenario、评分规则快照在 Run 内各保存一次，Trial 通过身份引用。二进制材料确有需要时才放入 `materials/`。README 解释结论并链接原始证据。

不再为模型、Trial、evidence、experiment、comparison、gate、export 各建一套目录或旁文件。Benchmark 的 Trace 已在 Run 中，不再复制成产品 Trace；独立产品 Trace 用平铺 JSON 和内部 UUID 关联。名称用于阅读，内部 ID 用于关联，不按名称猜测最新结果。

四类 HumanFeedback——Case 质量、保存 Run、Trace、候选审核——统一存入 `feedback.json`，保留原评分与目标身份；反馈不直接改写原始得分。候选编辑后的新版本须重新核验及批准。

## 评分与回归

确定性评分先检查实际行为和业务值；每个 Trial 的适用语义项合并为至多一次逻辑 Judge 提交。Gold 仅进入评分侧，不进入被测 Agent。缺项、重复项、不可判断和格式错误分别保留，不补成通过。一次逻辑 Judge 不等于底层网络请求次数。

Baseline 统一保存在 `baselines.json`，绑定明确 Run、模型组、选集和条件，不使用 `latest` 自动替换。完整、可比且已测量的 Agent FAIL 可以作为已知失败基线；缺失结果、Judge ERROR 或不可比条件不能。

| Gate 规则 | 要求 |
|---|---|
| 关键指标与每题必要断言 | 按正确优劣方向零退步 |
| 已发布回归断言 | 所有实际重复均通过 |
| 实际泄漏与禁止副作用 | 零 |
| 其他归一化质量比例 | 最多绝对下降 `0.02`，同时显示分子/分母 |
| 缺失、错误、不可比证据 | `blocked` |

Smoke7 与 Full62 各自计算 Baseline/Gate，不能跨选集混算。Gate 的 `pass` 是相对所选基线未退化；两个模型都失败时也可能相对通过，绝不等于绝对质量合格。输出 `pass/fail/blocked` 及具体原因，不能只看命令退出状态。

## 观察与复核

Langfuse 中从 Score 进入 Trace，再回到 Session，核对实际模型请求响应、工具/子 Agent、业务回执与失败要求；也可以从 User 的 Sessions/Traces 比较同一 Case 的两组配置。远端接收成功不等于所有节点、正文和分数已完整回读。

产品 capture、upload、mining 三开关独立且默认关闭；已填写凭据不自动上传产品轨迹。主动运行 Smoke/Full 所需的评测上传是这两个命令的明确动作。Langfuse 展示观察与评分，本地 README/`run.json` 给出比较和 Baseline/Gate；不把本地结论描述成 Langfuse 原生页面。

详细实操、截图和本次实际执行结果见[中文操作指南](Langfuse评测与问题定位操作指南.md)。未执行步骤应保留未执行状态；工程测试或受控演示不能替代真实模型质量证据。

## Metric 独立定义与校准

**评分链：Metric 独立定义 → Rubric 评分规范 → Case 选择 → Trial 合并请求 → 按 Metric 返回 Scores。** 正式指标保持 **39 项**：默认 28 项语义、11 项本地或派生；另有 2 项语义诊断。实现目录为 **55 个活动定义＝25 个确定性／派生实现＋30 个独立语义定义**，按 10 个领域文件组织。实现数量不是指标数量，也不是模型请求次数。

每个语义 Evaluator 只负责一个 Metric，独立维护版本、Rubric、适用性、证据要求、准备与校验；定义本身不持有模型客户端。Case 的 `scoring.judge` 仍使用 Metric ID；未被选择的项不会因适用性为 true 自动加入。工具预算为零等现有本地替代路径保持不变。Rubric 的多条判据不会自动成为额外指标。

调度层先处理本地确定事实，再将剩余适用语义项按原顺序合并。研究事实、引用和链条共用原始见证框架，比例继续本地计算。单项坏计数、缺项或坏证据只使该 Metric ERROR；重复／未知 Metric ID 或根级坏 JSON 使整个模型批次出现契约错误。已确认的泄露和禁止副作用不被 Judge 覆盖。错误不触发拆分、额外请求或静默截断。

新流程记录 `scoringVersion: 2`、`semantic-metric-batch` v1、`metric-json-independent/v1`、实际请求和各 Evaluator 版本。Metric 版本继续表示公式、方向和单位；Evaluator 版本表示该项评分规则。旧组定义、旧协议和原成绩只读保留，读取不使用当前 Rubric 重评。新旧评分条件不同，比较和 Gate 明确阻断。

独立校准复用同一套定义、合并请求、解析和计数，不启动被测 Agent，不把本地安全兜底计作模型判断正确。单项选择只筛选执行目标，保留原始参考与标签；结果按 Metric ID 匹配。单项校准不能证明组合表现。修改一个 Evaluator 会使其单项及包含它的组合引用不匹配；公共协议或 Judge 配置改变影响相应引用。界面区分 `not-provided`、`insufficient-coverage`、`version-mismatch` 和 `matched`，展示参考、目标组合、Judge 任务及版本；`matched` 只表示范围和版本匹配，`acceptance` 仍为 `not-assessed`。

以下是需要明确启动的真实校准入口，不随 Benchmark 或结果查询自动执行：

```powershell
bun --no-env-file run eval -- judge calibrate --dir <独立参考目录> --execution-id <校准身份> --metric tool-arguments
bun --no-env-file run eval -- judge calibrate --dir <独立参考目录> --execution-id <校准身份>
```

第一条检查单项，第二条按参考中声明的组合合并评分。参考必须保留 tune／validation、来源组和 `agent-authored`／`human-reference` 身份。工程样例和模拟传输通过不代表真实语义校准或人工批准。

## 执行预算与评分故障恢复

预算是 Run 的执行条件，不改变 Case、Gold 或评分标准。业务默认 Trial 600 秒、单 Run 180 秒、模型调用 16 次；研究默认分别为 900 秒、300 秒、24 次。准备和停止后的采证各 60 秒，停止确认沿用 5 秒。环境变量 `FLOWMATE_EVAL_BUSINESS_*`／`FLOWMATE_EVAL_RESEARCH_*` 可覆盖 `TRIAL_TIMEOUT_MS`、`RUN_TIMEOUT_MS`、`MAX_MODEL_CALLS`，同一实验两模型共用解析值。显式旧 `timeoutMs` 仍约束整题的业务执行，指定 `trialTimeoutMs` 后才分开；已确认研究 Plan 的预算继续生效，不被控制器改写。

Judge 默认输出预算为 32768 token，受模型和传输上限约束。发送前核对输入估算、输出预留和安全余量；过大时只使用既有 shared-text 无损共享编码。仍放不下则记录 `judge_context_capacity`，不提交模型、不截断关键证据、不拆分多次评分。

执行及停止事实先保存，再提交 Judge。显示分别区分执行结束、评分处理结束、必要评分充分、评分错误／证据不足和平台核对。完整证据证明没有机会时保留空比例及原计数；ERROR、未知采证和一侧零机会不能被当成通过。历史统计摘要按其原规则校验并保留，新记录使用 `statisticsPolicyVersion: 2`；旧统计不证明当前 Gate 可比。

评分设施错误需要明确补评分。只有 `score retry` 调用 Judge，**不会重跑 Agent**；`score list/show` 只读，`score upload` 只上传已保存的分数。保留并复用操作 UUID，查询未知结果时不另建操作：

```powershell
bun --no-env-file run eval -- score retry --run-id <RunId> --failed-only --operation-id <UUID>
bun --no-env-file run eval -- score list --run-id <RunId>
bun --no-env-file run eval -- score show --run-id <RunId> --revision-id <RevisionId> --execution-id <ExecutionId>
bun --no-env-file run eval -- score upload --run-id <RunId> --revision-id <RevisionId>
```

可用 `--trial <TrialId>` 限定补评分。新结果保存在同一 `run.json.scoringRevisions`，原执行、分数与 Judge 不覆盖；默认查看 Original，不自动选最新或最高分。比较、Baseline 和 Gate 使用修订时明确传 `--scoring-revision <RevisionId>`。条件不兼容仍 blocked。

修订上传只向已核对的原 Trace 添加带修订身份的 Score，不重传观察树。写入状态未知时回读原身份，不盲重发。接口不执行自动 Agent 断点续跑、额外校准或案例发布。
