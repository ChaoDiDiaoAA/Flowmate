# P1 Provider 评测

P1 验证短文本经公共 Application 调用 Pi ModelRuntime 后的实际响应、错误、超时、取消、用量和必要持久化。Run 固定 `kind=provider`，不创建 Job、AgentSession、工具或 Agent Loop。

## 8 个 v1 Case

| Case | 模式 | 独立价值 | 当前状态 |
|---|---|---|---|
| `provider-invoice-text/v1` | Live | 真实 Provider、模型、完整响应和 usage | pending，Live 已执行并 PASS |
| `provider-invalid-auth/v1` | Fixture | 401 收口与秘密扫描 | pending，Fixture 已执行 |
| `provider-invalid-model/v1` | Fixture | 模型不存在且不静默替换 | pending，Fixture 已执行 |
| `provider-timeout/v1` | Fixture | 超时、停止确认和迟到结果 | pending，Fixture 已执行 |
| `provider-cancel/v1` | Fixture | 取消受理、实际停止和竞态 | pending，Fixture 已执行 |
| `provider-stream-interrupted/v1` | Fixture | 断流、部分输出和失败终态 | pending，Fixture 已执行 |
| `provider-rate-limit/v1` | Fixture | 429 与 Pi 原生重试边界 | pending，Fixture 已执行 |
| `provider-usage-unknown/v1` | Fixture | usage 缺失保持 unknown | pending，Fixture 已执行 |

全部 Case 使用 `development` split。同来源衍生场景保留同组。没有领域 Gold 需求，因此不创建 `gold.json`。

### 当前核验记录

- 2026-09-21：`p1-fixture-isolated-20260921-175500` 通过 7 个 Fixture Item；每个 Item 的确定性 Grader 为 PASS，Langfuse Experiment 同步写入 `p1_case_identity`、状态、通过值和适用检查。
- 本次本地证据位于忽略提交的 `agent-eval/runs/p1-fixture-isolated-20260921-175500/`。它证明受控 Pi/产品/Trial/Grader 链，不能证明真实 Provider 连通、真实认证、远端停止或费用。
- 2026-09-22：`p1-2026-09-22T02-22-15-133Z` 再次通过 7/7 Fixture；证据位于 `agent-eval/runs/p1-2026-09-22T02-22-15-133Z/`，7 个 Case 均有独立 Trial、SQLite、Case 结果和 Langfuse Trace。
- 2026-09-22：`p1-2026-09-22T02-25-18-550Z` 通过 `provider-invoice-text/v1` Live。实际请求使用 `openai-responses`、`https://api.deepseek.com/responses` 和 `deepseek-flash`；Run completed，回复完整，usage 为 141 input + 149 output = 290 Token，attempts=1，费用未知保留 null。证据位于 `agent-eval/runs/p1-2026-09-22T02-25-18-550Z/`，Langfuse traceId 为 `df7c304c84b452f4b6a0afdad21aefc0`。
- 所有 Case 的 `review.status` 仍为 `pending`，因为运行 PASS 不会自动代替人工复核和资产冻结；它已不再表示 Live 未执行。

## 数据边界

模型只收到 `input.goal` 和 `input.documents` 的 UTF-8 正文。`input.setup`、`expected`、Grader、故障配置、凭证和质量元数据只供可信控制器使用。`fixtures/control.json` 不含 Provider/model；Fixture 使用受控配置，Live 从 `.env` 的 `FLOWMATE_LLM_BASE_URL`、`FLOWMATE_LLM_MODEL`、`FLOWMATE_LLM_API_KEY` 和可选 `FLOWMATE_LLM_API` 读取连接。

## 执行与判定

```powershell
cd D:\code\Flowmate
bun run eval -- doctor
bun run eval -- sync --stage P1
bun run p1:eval:fixture
Start-Process http://localhost:3000
```

Live 执行前在 `.env` 填写 `FLOWMATE_LLM_BASE_URL`、`FLOWMATE_LLM_MODEL`、`FLOWMATE_LLM_API_KEY`；`FLOWMATE_LLM_API` 默认为 `openai-completions`，可改成当前 P1 已接入的 `openai-responses`、`anthropic-messages` 或 `google-generative-ai`。再执行：

```powershell
bun run p1:eval:live
```

Langfuse UI 中优先进入 **Experiments** 打开本次 `executionId`，或从 **Datasets → flowmate/P1/v1/fixture** 进入成员。Item 的 `input.case` 显示 Case ID、中文名称和能力点，`modelInput` 才是实际投给产品的白名单内容。评测命令终端也会打印同样的 Case 摘要和对应 Trace 链接。

### UI 名称解释

每个产品执行子 Observation 固定命名为 `P1 · Fixture|Live · Case ID/v版本 · 中文名称`。Langfuse 自动生成的 `experiment-item-run` 是 Experiment 根节点，不是 Case 名称。

Scores 表的 `Name` 是评分指标，而不是场景名：

| Name | 来源与含义 |
| --- | --- |
| `p1_case_identity` | 评测器固定身份键；Value 显示完整 Case 标签 |
| `p1_case_status` | 评测器固定五态结论键 |
| `p1_case_pass` | 评测器固定 1/0 汇总键 |
| `check_<checkId>` | 来自本 Case `expected.checks[].id` 的确定性检查键 |

因此需要识别场景时先看 `p1_case_identity` 的 Value 或 Comment，再看同一 Item 下的 `check_*`。保持稳定的 Score Name 才能汇总同一检查；把 Case ID 拼进每个 `check_*` 会破坏这个统计口径。Tracing 为空时，清空筛选、扩大时间范围、选择 `sdk-experiment` 环境，并同时显示 Root/非 Root Observation；当前 v4/events-only 部署仍为空时改从 Experiment、Dataset Item 或命令打印的 Trace 链接查看，不把它诊断成 Flowmate 未开启采集。

故障 Case 的产品请求按预期失败时，评测可为 PASS。缺少必要证据、故障未触发或停止未确认分别为 UNJUDGEABLE/FAIL，不会因进程退出或文本看似合理而通过。正式 `verified` 需要冻结 Case、实际运行、评分器自检和人工复核；当前 Fixture 验证不替代 Live。

## Trial 与证据

每个 Dataset Item 建立独立根：`agent-eval/runs/<executionId>/trials/<caseId>/trial-N/`，数据库固定为 `data/trial-N.sqlite`。完整 `ProductPaths` 由控制器注入，所有路径必须留在 Trial 根内，不能复制、读取或回退到正式 `<userData>/data/app.sqlite`。`flowmate-eval/v1` 只允许 `start/call_provider/cancel/query/close`，返回 `ready/event/result/error/cancel_ack/stopped/closed`；stdout 仅协议，诊断写 Trial `logs/product.stderr.log`。
