# 评测维护工具

`tools/` 保存需要人工显式执行的数据维护和阶段辅助脚本，不承载产品业务逻辑，也不作为 P1 之后的评测调度平台。

| 位置 | 用途 |
|---|---|
| `p0/` | P0 专用的一键编排、来源审计、Case 判定和报告复核 |
| `comprehensive/` | 现有完整 Agent 综合数据的准备、核验、治理、重建及其工具自检 |
| `initial_dataset.py`、`coverage_update.py` | 私有数据 README 的旧命令兼容入口；实际实现位于 `comprehensive/` |
| `rebuild_benchmark_mapping.py` | Benchmark 定义已固定引用的兼容入口；保持原路径，避免改写现有 Benchmark |
| `rebuild_scenarios_eval.py` | 设施夹具已固定引用的兼容入口；保持原路径，避免改写既有夹具 |

P0 日常入口仍是仓库根目录的 `bun run p0:eval`。综合数据工具通过 `python agent-eval/tools/comprehensive/<脚本>.py ...` 显式执行。P1 起的 Inspect Task、产品适配和 Scorer 放在 `agent-eval/src/`，不会继续向 `tools/` 增加阶段调度器。
