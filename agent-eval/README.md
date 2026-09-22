# Flowmate Agent Evaluation

`agent-eval` 是独立质量工程。Langfuse 提供 Dataset、Experiment、Trace、Score 和 UI；Flowmate 负责真实产品执行、Trial 隔离、SQLite 事实、故障注入、确定性判定和证据保留。产品代码不依赖 Langfuse，也不能读取 Case 的 `expected`、`setup` 或评分结果。

## 当前状态

- P1 v1 已制作 8 个 Case：7 个 Fixture、1 个 Live，均保留 `review.status=pending`；pending 现在表示尚未完成人工复核与资产冻结，不表示 Case 未执行或执行失败。
- 2026-09-22 的 Fixture execution `p1-2026-09-22T02-22-15-133Z` 通过 7/7；每例均调用同一 `Application`、Pi SDK、独立 `trial-N.sqlite` 和确定性 Grader，并写入本机 Langfuse。
- 同日 Live execution `p1-2026-09-22T02-25-18-550Z` 的 `provider-invoice-text/v1` 通过 1/1：实际走 `openai-responses` 到 `https://api.deepseek.com/responses`，模型 `deepseek-flash`，保存完整回复、290 Token 与一次 Provider attempt；费用仍为 unknown/null。
- P1 只评直接 Provider 请求，类型为 F；A 不适用，B 未启用，LLM-as-Judge 默认关闭。

## 安装与配置

```powershell
cd D:\code\Flowmate
Copy-Item .env.example .env
bun install --frozen-lockfile
```

在 `.env` 填写本地 Langfuse 的 `LANGFUSE_PUBLIC_KEY`、`LANGFUSE_SECRET_KEY` 和 `LANGFUSE_BASE_URL`。真实 LLM 则填写 `FLOWMATE_LLM_BASE_URL`、`FLOWMATE_LLM_MODEL`、`FLOWMATE_LLM_API_KEY`，可选 `FLOWMATE_LLM_API`。`BASE_URL` 是 API 根地址，密钥不能写入 Case、Trace、SQLite、日志或提交。

`FLOWMATE_LLM_API` 只选择请求协议，不能填 Base URL 或 Provider 名称。P1 接受：`openai-completions`（默认）、`openai-responses`、`anthropic-messages`、`google-generative-ai`。当前环境加载器明确拒绝其他值；Pi SDK 本身支持的额外 Provider 不能自动视为 Flowmate P1 已接入。

## P1 命令

```powershell
bun run eval -- doctor
bun run eval -- sync --stage P1
bun run p1:eval:fixture
bun run eval -- run --stage P1 --mode fixture --case provider-cancel
# 以下命令会产生真实 Provider 请求/费用
bun run p1:eval:live
bun run eval -- status --stage P1
Start-Process http://localhost:3000
```

本地完整证据保存在 `agent-eval/runs/<executionId>/summary.json` 和 `trials/<caseId>/trial-N/{data,logs,artifacts}`。`agent-eval/logs` 不再作为全局目录；Langfuse 的服务端日志由其部署维护，产品 stderr 位于各 Trial 的 `logs/`。若上传失败，修复连接后可用 `resend --report <绝对summary.json>` 重放保存的评测证据；它不会重新执行产品，UI 中会标记 `replay=true`。

## 在 Langfuse 查看一个完整 Case

1. 执行 `bun run p1:eval:fixture`，终端会打印 `executionId`，并列出每个 Case 的中文名称、能力点、结论、检查项和 Trace 链接。
2. 打开 `http://localhost:3000`，进入 **Experiments**，按 `executionId` 找到本次实验，再打开一个 Item Run。也可先从 **Datasets → flowmate/P1/v1/fixture** 进入对应成员。
3. Item Run 的 `input.case` 显示 `id`、中文 `name`、`capability`；`modelInput` 才是实际投给产品的白名单输入。输出保存 Run 终态、错误、输出、用量、证据和每项确定性检查。
4. **Scores** 的 `Name` 是指标名称，不是 Case 名称：`p1_case_identity` 是身份字段，`p1_case_status` 是五态结论，`p1_case_pass` 是 1/0 汇总，`check_<checkId>` 来自 `cases.json` 中对应的 `expected.checks[].id`。先看 `p1_case_identity` 的 **Value**，它固定显示 `Case ID/v版本 | 中文名称 | 能力点`；每条 Comment 也带相同前缀。稳定 Name 让同一检查可以跨 Case 聚合。
5. Item Run 下的 P1 子 Observation 名称固定为 `P1 · Fixture|Live · Case ID/v版本 · 中文名称`。最外层 `experiment-item-run` 是 Langfuse SDK 的 Experiment 根节点，不是 Case 名称。

如果 **Tracing** 页面没有内容，先清除筛选条件，将时间范围覆盖本次运行，Environment 选择 `sdk-experiment`，并同时显示 Root 与非 Root Observation。当前 Langfuse v4/events-only 部署在这些条件满足后仍可能不列出 Observation；这不表示 Flowmate 未开启 Trace，直接从 **Experiments/Datasets** 或终端 Trace 链接查看即可。

## 目录

```text
agent-eval/
├─ src/                         # TS 控制器、协议、执行器、Grader、Langfuse 适配
├─ stage-evals/P1/v1/           # P1 Case 与 Fixture 控制资产
├─ data/v1/                     # P13 完整 Agent 综合数据集契约与未来资产
├─ benchmarks/                  # smoke/full 成员引用，不复制 Case
├─ tests/                       # 质量设施自检
└─ runs/<executionId>/          # 忽略提交的实际结果、Trial DB、日志和证据
```

Fixture 与 Live 是执行模式，不是评分类型。Fixture 仍运行 Flowmate 和 Pi SDK，只把远端服务替换为可控响应，用来稳定验证错误、取消、超时、断流、重试和 usage 缺失；它不能证明真实认证、网络或模型响应。Live 使用 Pi SDK 真实 Provider 请求，用来证明实际连接和响应，不能在失败时自动降级为 Fixture。
