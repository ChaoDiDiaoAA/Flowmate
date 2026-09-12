# Agent 评测

本目录集中维护 Flowmate Agent 评测文档及后续评测设施和资产。

- [Agent 评测总方案](docs/spec/01_Flowmate_Agent评测总方案.md)：完整模块覆盖、Case/Gold 制作与挖掘、Good/Bad 池、归因、Benchmark、评分和 P0–P6 路线。
- [P0 Agent 评测实施方案](docs/plans/P0_Agent评测实施方案.md)：本阶段场景、人工准备、设施任务、运行条件与退出要求。
- [产品总方案](../docs/spec/00_Flowmate完整方案.md)：被测产品及 Pi SDK 接入的功能与工程边界。

| 目录 | 职责 | 当前状态 |
|---|---|---|
| `docs/spec/` | 评测总方案 | 已迁入 |
| `docs/plans/` | 各阶段评测实施方案 | 已迁入 P0，后续按阶段编写 |
| `src/` | 资产处理、驱动、Runner、Grader、统计、归因、报告和结论 | E01–E06 已建立，正式运行驱动按 E07–E10 接入 |
| `tests/` | 评测设施自身测试及虚构夹具 | 8 个文件、16 个离线断言已通过 |
| `config/` | 非秘密场景目录与配置模板 | 按实施任务建立 |
| `data/p0/` | P0 私有制作表、Case/Gold、Benchmark、Trial、报告与归因 | 按实际准备和运行建立 |

仅 `data/` 整目录被 Git 忽略。真实票据、Gold 与运行产物保存在其中；文档、源码、配置模板和虚构夹具正常版本管理。

产品功能测试保留在仓库根 `tests/`。评测通过公开接口、受控测试入口和只读证据复用产品能力；产品不依赖本目录，主子 Agent 的资源发现和文件访问也须排除本目录。评测只向被测产品交付获准输入投影。

P0 复用仓库根 Bun 工具链和依赖锁。评测代码已接入根 typecheck、Vitest 和 `eval:p0 check-assets`；这些设施通过只表示质量基础设施可用，不表示真实 Agent 质量或 P0 阶段已经通过。

当前可执行的离线准备命令：

| 命令 | 作用 | 结果 |
|---|---|---|
| `bun run eval:p0 check-assets` | 检查场景目录、责任人、变体和映射 | 结构不合法时非零退出；保留待制作资产提示 |
| `bun run eval:p0 freeze --input <authoring-dir> --output <manifest.json>` | 冻结人工核验的 Case/Gold 批次 | 只接受严格 Schema 和已核验 Gold |
| `bun run eval:p0 check-readiness --manifest <manifest.json> --candidate <candidate.json>` | 检查离线评测是否可以开始 | 缺资产、候选或版本时明确阻断 |
| `bun run eval:p0 plan --manifest <manifest.json> --candidate <candidateId> --output <plan.json>` | 生成顺序 Trial 计划 | 只生成计划，不访问模型 |

正式 `run/grade/report/decide` 命令要等真实资产、产品证据和适用的 Live 条件具备后接通；不会用设施自测结果代替 Agent 质量结论。
