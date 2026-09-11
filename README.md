# Flowmate

Flowmate 交付基于 Pi SDK 二次开发的企业数字员工平台，以及首个可生产运行的 07B2B 发票员工。Pi 提供 Agent Runtime 能力；Flowmate 自研员工定义、运行控制、任务与业务 Kernel、能力管理、人工协同及 Agent Ops。

`docs/spec` 维护两份各自完整的总方案：

- [项目总方案](docs/spec/00_Flowmate完整方案.md)：产品与业务目标、Pi SDK/Flowmate 职责、从已解析文件开始的业务链、P0–P6 功能实施、功能测试、生产发布与运维。
- [Agent 评测总方案](docs/spec/01_Flowmate_Agent评测总方案.md)：评测目标与平台、人工定向制作 Case/Gold 的流程和模板、Benchmark、裁判与指标、运行比较、P0–P6 评测路线及后续阶段方案的编写要求。第 5 节可直接用于安排人工准备工作。

两条路线沿用相同的 P0–P6 阶段。功能实现后提供可运行版本与证据；独立质量结论作为阶段退出和发布的必要输入。后续按阶段编写具体实施方案，评测阶段稿放在 `docs/plans/agent-eval`，进入对应阶段时再建立，不提前创建空白文档。

当前已编写并按其修订基线实施 [P0 目标方案](docs/spec/P0_目标方案.md)，明确第一阶段的范围、七项功能目标、Runtime 接入深度、成果里程碑、验收和评测交接；逐项编码任务和开发排期仍以实施计划为准。

目标确认后对应的 [P0 实施计划](docs/plans/P0_实施计划.md) 将功能工作拆为 16 项任务，列明文件、接口、验证步骤、执行依赖和验收覆盖。[P0 Agent 评测实施方案](docs/plans/agent-eval/P0_Agent评测实施方案.md) 对应规定 12 类 Runtime 模块、种子 Case/Gold 制作、原生/集成/真实模型评测、评分设施、问题归因及联合退出。两份计划已编写，当前按修订基线实施；真实数据、Live Profile 和正式评测仍未完成。

当前已有首版工程骨架、Pi SDK 原生扩展加载和 `@tintinweb/pi-subagents` 原生 Agent→子 Session 离线验证；文档中的 Case/Gold 模板、基准、程序与验收要求不代表已完成数据标注、真实模型运行或企业验收。企业契约与运行参数仍需在相应阶段明确。

旧方案及旧教程已在迁移复核完成后删除。[归档审查与迁移记录](docs/archive/2026-09-10-spec-review/04_旧方案迁移清单.md)仅用于追溯，其章节落点属于归档时版本；当前项目范围与评测安排分别以两份总方案为准。

用户已更正使用项目内的数据，实际子目录在 P0 接入前核验；总方案中的外部数据路径属于待同步的历史位置。旧实现与工程配置已清理，当前代码按新方案迁移并继续补齐 P0；旧教程中的命令及成绩不作为当前基线。

当前可运行的检查入口：`npm run doctor`、`npm run typecheck`、`npm test`、`npm run build`、`npm run p0 -- plugin-probe`。数据冻结必须显式指定角色映射和用途，例如 `npm run p0 -- freeze -- --root <sourceRoot> --role-map <role-map.json> --output <frozenRoot> --purpose <sampleId>=test`；不会默认把目录中的全部文件纳入模型输入。真实主模型入口在具备 Live Profile、候选和冻结清单后使用 `npm run p0 -- run -- --profile live-main --manifest <frozenRoot> --candidate <candidate.json> --sample <sampleId>`，缺条件时返回明确未就绪错误。
