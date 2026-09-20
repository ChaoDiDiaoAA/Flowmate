# 评测设施测试

| 位置 | 用途 |
|---|---|
| `p0/` | P0 Case 判定与报告复核的合成测试，不启动产品 |
| `comprehensive/` | 综合数据准备、评分、治理和重建工具测试 |
| `fixtures/` | 设施自检使用的固定夹具；不是产品输入 |
| `test_coverage_metrics.py` | 综合清单已固定引用的兼容测试入口，保持原路径 |

P0 的常用验证仍由 `bun run p0:eval` 自动编排。P1 起真实 Agent 评测使用 Inspect；本目录只验证质量设施本身，测试通过不代表产品或 Agent 通过。
