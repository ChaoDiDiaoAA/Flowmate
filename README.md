# Flowmate

## 项目与当前阶段

基于 Pi SDK 的本地发票 Agent，目标是整理材料、生成候选、人工接受和导出。当前实现 Provider、SQLite 与 CLI；完整 Agent 尚未交付。统一 Benchmark 尚未制作；完整 Agent、入口与采证就绪且工程验证通过后，按方案制作 50 条任务、10 条 Smoke 引用。本地评分，可选 Langfuse 展示。

## 安装与配置

```powershell
bun install --frozen-lockfile
if (!(Test-Path .env)) { Copy-Item .env.example .env }
```

[.env.example](.env.example)：产品 `FLOWMATE_LLM_*`，独立裁判 `FLOWMATE_JUDGE_*`，可选平台 `LANGFUSE_*`。普通测试不调用付费模型或平台。

## 命令入口

在根目录执行；详细参数见专项 README。

| 命令 | 用途 |
|---|---|
| `bun run typecheck` | 产品、评测与全部测试类型 |
| `bun run test:unit` | 产品及评测设施单元测试 |
| `bun run test:integration` | SDK、存储、生命周期与设施接合 |
| `bun run test:e2e` | 真实 CLI 进程、受控端点、持久化与查询 |
| `bun run test` | 依次执行以上四项，失败即停止 |
| `bun run cli -- …` | 产品聊天、调用和查询 |
| `bun run eval:smoke` | 制作完成后使用：10 条真实任务，有模型费用 |
| `bun run eval:full` | 制作完成后使用：50 条任务并要求 Judge，有模型费用 |
| `bun run eval -- …` | 校验、选集、状态、比较、反馈、诊断及补传 |

```powershell
bun run cli -- provider chat
bun run cli -- provider call --input <文件> --goal "<任务>"
bun run cli -- provider query --run-id <ID>
bun run eval -- --help
```

聊天和单次调用使用真实模型，可能收费；支持 `--config`、`--timeout-ms`、`--stop-grace-ms`。聊天内 `/help`、`/cancel`、`/exit`（`/quit`）。

## 文档导航

[产品方案](docs/spec/00_Flowmate完整方案_v1.md) · [P1 目标](docs/spec/P1_目标方案_v1.md) · [实施计划](docs/plans/P1_实施计划_v1.md)

[评测总方案](docs/eval/01_Flowmate_Agent评测总方案_v1.md) · [Case 制作手册](docs/eval/02_Flowmate_Agent评测数据集制作方案_v1.md) · [可选 Langfuse](docs/eval/03_Flowmate_Langfuse平台接入设计方案_v1.md)

[工程测试](tests/README.md) · [评测操作](agent-eval/README.md) · [设施测试](agent-eval/tests/README.md) · [源码职责](agent-eval/src/README.md) · [Judge 配置](agent-eval/src/scoring/judges/README.md)
