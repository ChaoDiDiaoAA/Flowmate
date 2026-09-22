# 完整 Agent 综合数据集 v1

此目录为 P13 完整 Agent 实现后的跨阶段综合数据集保留。它将引用已冻结的 P1–P13 Case 身份，并补充只在端到端 Agent 闭环中可证明的多轮、工具、恢复、压缩、权限、桌面和业务结果场景。

当前不创建空 Case、Gold 或 Baseline。启用条件是 P13 产品入口、综合 Grader 和全部依赖阶段已经实现，并完成来源、去重、污染和 split 核验。执行命令在启用后为：

```powershell
bun run eval -- sync --stage comprehensive
bun run eval -- run --stage comprehensive --mode fixture
# Live 仍沿用 .env 的 FLOWMATE_LLM_BASE_URL / MODEL / API_KEY / API。
bun run eval -- run --stage comprehensive --mode live
Start-Process http://localhost:3000
```
