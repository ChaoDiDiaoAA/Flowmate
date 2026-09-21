# Flowmate

**Agent Engineering + Invoice Product + Agent Evaluation**：基于 Pi SDK 构建本地优先发票 Agent 产品，主要实现和学习 Agent Harness / Runtime。产品支持真实 Provider、Agent Loop、工具、会话与历史、上下文、压缩、资源、扩展及子 Agent；业务终点为候选生成、人工修正/接受与导出。后端保持必要产品事实，不建设完整企业后台。

当前处于按第一版方案重新实施的起点。三份 v1 方案已整理，此前实现与旧评测资产已清理，保留设计文档和原始发票材料。下面是设计入口，不表示新能力已实现或评测已通过。具体依赖和执行命令进入相应阶段后建立。

| 阅读内容 | 入口 |
|---|---|
| 产品行为、架构、24 章工程设计与 P1–P13 | [产品主方案（第一版）](docs/spec/00_Flowmate完整方案_v1.md) |
| F/A/B、Inspect、14 章评测设计与完整指标 | [Agent 评测主方案（第一版）](docs/eval/01_Flowmate_Agent评测总方案_v1.md) |
| Case 数量、时点、Folio 制作方法、Gold、目录与核验 | [数据集制作方案（第一版）](docs/eval/02_Flowmate_Agent评测数据集制作方案_v1.md) |
| 质量目录当前状态 | [评测说明](agent-eval/README.md) |
| 当前领域词汇 | [CONTEXT.md](CONTEXT.md) |

P1 Provider → P2 Agent Loop → P3 Tools → P4 Events → P5 Session → P6 Context → P7 Memory → P8 Compaction → P9 Prompt/Skill → P10 Extensions → P11 Subagent → P12 Product → P13 Host/打包。不设独立 P0；基础工程并入 P1。

正式产品唯一数据库设计为 `<userData>/data/app.sqlite`，Electron 固定应用名 Flowmate，CLI 使用同一操作系统标准路径。Windows 当前用户目标为 `C:UsersyycAppDataRoamingFlowmatedataapp.sqlite`；这不是已创建数据库的声明。Main 为桌面 SQLite 唯一写入方，数据库保留 11 功能表加 schema_migrations。主外键为整数，无自定义内容摘要字段。

评测使用质量目录之外的独立临时 Trial 根及不同名测试库，例如 `<temp>/flowmate-eval/20260921-001/trial-1/data/trial-1.sqlite`。同一 Trial 的恢复继续该测试库，恢复 Session 后创建新 Run；不复制正式用户库。阶段数据在当期制作，综合任务数据在 P13 验收通过后制作。

`docs/` 内原始方案、`docs/v1/` 和历史阶段稿保留阅读，但不作为本轮实施依据。`data/invoices/` 保留原票与已有解析，仅是原始材料，不是已核验新 Gold。旧 Case、Gold、Fixture、清单、中间数据和运行成绩已清理，后续依据三份 v1 主方案重新制作。
