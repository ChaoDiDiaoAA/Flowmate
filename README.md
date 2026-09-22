# Flowmate

Flowmate 是基于 Pi SDK 的本地优先发票 Agent 工程，目标是学习并实现 Agent Harness、Runtime、工具、会话、上下文、压缩、扩展与子 Agent，同时完成发票候选、人工接受和导出闭环。

当前 P1 已实现最小 TypeScript/Bun 工程、公共 Application、Pi Provider 适配、SQLite `runs`、CLI、生命周期与 `flowmate-eval/v1` 评测协议。2026-09-22 的核验运行中，P1 v1 的 7 个受控 Fixture 和 1 个真实 Live 发票 Case 均得到 PASS，并保存到独立 Trial 与 Langfuse。Case 的 `review.status=pending` 仍表示数据资产尚未完成人工复核与冻结，不能把一次开发核验运行扩大为跨 Provider、生产可靠性或正式 Baseline 结论。

| 阅读内容                            | 入口                                                                 |
| ----------------------------------- | -------------------------------------------------------------------- |
| 产品边界、架构与 P1–P13            | [产品主方案](docs/spec/00_Flowmate完整方案_v1.md)                     |
| Langfuse、F/A/B、证据与指标         | [Agent 评测主方案](docs/eval/01_Flowmate_Agent评测总方案_v1.md)       |
| Case、Gold、Fixture/Live 与数据治理 | [数据集制作方案](docs/eval/02_Flowmate_Agent评测数据集制作方案_v1.md) |
| P1 目标、数据库和公共契约           | [P1 目标方案](docs/spec/P1_目标方案_v1.md)                            |
| P1 文件、方法、参数和实施顺序       | [P1 实施计划](docs/plans/P1_实施计划_v1.md)                           |
| P1 Case、Langfuse 和独立判据        | [P1 Agent 评测方案](docs/eval/P1_Agent评测方案_v1.md)                 |
| 质量工具与实际命令                  | [agent-eval README](agent-eval/README.md)                             |

## 安装与启动

```powershell
cd D:\code\Flowmate
bun install --frozen-lockfile
Copy-Item .env.example .env
```

在 `.env` 填写本地 Langfuse 三项配置。真实 LLM 再填写下面三项；`FLOWMATE_LLM_BASE_URL` 是 API 根地址，不是 Provider 名称。例如 OpenAI-compatible 服务常为 `https://<host>/v1`，不要填完整的 `/chat/completions` 地址。

```powershell
FLOWMATE_LLM_BASE_URL="https://<host>/v1"
FLOWMATE_LLM_MODEL="<model-id>"
FLOWMATE_LLM_API_KEY="<api-key>"
# 可选：默认 openai-completions；也可为 openai-responses、anthropic-messages、google-generative-ai
FLOWMATE_LLM_API="openai-completions"
```

`FLOWMATE_LLM_API` 不是 Provider 名称，也不是 Base URL；它选择 Pi 向该 Base URL 发送请求时使用的协议。当前 P1 环境接入只接受下列四种值：

| 值                       | 对应接口协议            | 适用范围                         |
| ------------------------ | ----------------------- | -------------------------------- |
| `openai-completions`   | OpenAI Chat Completions | OpenAI-compatible 服务的常见选择 |
| `openai-responses`     | OpenAI Responses        | 实现 OpenAI Responses 的服务     |
| `anthropic-messages`   | Anthropic Messages      | Anthropic-compatible 服务        |
| `google-generative-ai` | Google Generative AI    | Google Generative Language API   |

Pi SDK 可能还支持其他 Provider 接入方式，但当前 Flowmate P1 的环境加载器会拒绝未列出的协议值；新增协议必须先补 Pi 兼容性验证和 P1 适配，不能仅修改 `.env`。

当前 P1 常用命令：

```powershell
# 真实调用一段合成发票文本；需要上面的 LLM 配置
bun run p1:call -- --input .\agent-eval\stage-evals\P1\v1\fixtures\invoice-short.txt --goal "提取发票号码、开票日期、销售方、购买方和价税合计"

# 离线 Fixture 评测：不调用真实 LLM，但需要 Langfuse 配置以展示结果
bun run p1:eval:fixture

# 真实 Live 评测：只执行 provider-invoice-text；会产生真实 Provider 请求/费用
bun run p1:eval:live

# 查看本地 Langfuse UI（进入 Datasets 或 Experiments）
Start-Process http://localhost:3000

# 诊断或手动同步数据集
bun run eval -- doctor
bun run eval -- sync --stage P1
bun run eval -- status --stage P1
```

评测结束后，终端先打印每个 Case 的 `Case ID/版本 | 中文名称`、能力点、结论、检查项和 Trace 链接。UI 中优先进入 **Experiments** 打开该次 `executionId`，再打开具体 Item Run；其中 `input.case` 是 Case 标签，`modelInput` 才是产品的白名单输入。Scores 的 `Name` 表示评分指标，例如 `check_auth-terminal`，不是正在评测的 Case；Case 身份在 `p1_case_identity` 的 Value 和每条 Score 的 Comment 中。

Tracing 页面为空不代表 Langfuse 没有记录。先清除筛选、把时间范围覆盖本次执行、选择 `sdk-experiment` 环境，并同时显示 Root/非 Root Observation；若当前 Langfuse v4/events-only 部署仍不显示，则以 Experiment、Dataset Item 和终端 Trace 链接为准，不需要开启 Flowmate 的额外开关。P1 的人可读子 Observation 名称为 `P1 · Fixture|Live · Case ID/v版本 · 中文名称`。Langfuse SDK 生成的最外层 `experiment-item-run` 是平台根节点，不能当作 Case 名称。

`FLOWMATE_LLM_API` 选择 Pi 的协议适配方式；P1 用固定内部 Provider 标识 `flowmate-env` 注册这个动态连接，因此 Case 和 `fixtures/control.json` 不保存模型、Base URL 或密钥。Fixture 永远移除真实 LLM 环境变量；Live 绝不自动降级为 Fixture。

正式产品数据库固定为 `<userData>/data/app.sqlite`。评测每个 Dataset Item 使用独立 Trial 根和 `data/trial-N.sqlite`，不能复制或回退正式用户库。Langfuse 保存 Dataset、Experiment、Trace 和 Score；本地完整 SQLite、协议帧、stderr 与证据保存在 `agent-eval/runs/<executionId>/`。

阶段路线为 P1 Provider → P2 Agent Loop → P3 Tools → P4 Events → P5 Session → P6 Context → P7 Memory → P8 Compaction → P9 Prompt/Skill → P10 Extensions → P11 Subagent → P12 Product → P13 Host/打包。每阶段都在主方案给出实现后启动、Fixture、Live、状态和 UI 命令；当前 CLI 只接受已实现的 P1，避免后续阶段被误报为可运行。
