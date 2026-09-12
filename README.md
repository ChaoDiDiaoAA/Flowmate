# Flowmate

Flowmate 交付基于 Pi SDK 二次开发的企业数字员工平台，以及首个可生产运行的 07B2B 发票员工。Pi 提供 Agent Runtime 能力；Flowmate 自研员工定义、运行控制、任务与业务 Kernel、能力管理、人工协同及 Agent Ops。

产品总方案与 Agent 评测总方案分别维护在 `docs/spec/` 和 `agent-eval/docs/spec/`：

- [项目总方案](docs/spec/00_Flowmate完整方案.md)：产品与业务目标、Pi SDK/Flowmate 职责、从已解析文件开始的业务链、P0–P6 功能实施、功能测试、生产发布与运维。
- [Agent 评测总方案](agent-eval/docs/spec/01_Flowmate_Agent评测总方案.md)：评测目标与平台、人工定向制作 Case/Gold 的流程和模板、Benchmark、裁判与指标、运行比较、P0–P6 评测路线及后续阶段方案的编写要求。第 5 节可直接用于安排人工准备工作。

评测统一入口为 [agent-eval/](agent-eval/README.md)，文档、后续设施源码、配置、测试和私有数据集中在该目录。两条路线沿用相同的 P0–P6 阶段。功能实现后提供可运行版本与证据；独立质量结论作为阶段退出和发布的必要输入。后续按阶段编写具体实施方案，评测阶段稿放在 `agent-eval/docs/plans`，进入对应阶段时再建立，不提前创建空白文档。

当前已编写并按其修订基线实施 [P0 目标方案](docs/spec/P0_目标方案.md)，明确第一阶段的范围、七项功能目标、Runtime 接入深度、成果里程碑、验收和评测交接；逐项编码任务和开发排期仍以实施计划为准。

目标确认后对应的 [P0 实施计划](docs/plans/P0_实施计划.md) 将功能工作拆为 16 项任务，列明文件、接口、验证步骤、执行依赖和验收覆盖。[P0 Agent 评测实施方案](agent-eval/docs/plans/P0_Agent评测实施方案.md) 对应规定 12 类 Runtime 模块、种子 Case/Gold 制作、原生/集成/真实模型评测、评分设施、问题归因及联合退出。两份计划已编写，当前按修订基线实施；真实数据、Live Profile 和正式评测仍未完成。

当前已有首版工程骨架、Pi SDK 原生扩展加载和 `@tintinweb/pi-subagents` 原生 Agent→子 Session 离线验证；文档中的 Case/Gold 模板、基准、程序与验收要求不代表已完成数据标注、真实模型运行或企业验收。企业契约与运行参数仍需在相应阶段明确。

旧方案及旧教程已在迁移复核完成后删除。[归档审查与迁移记录](docs/archive/2026-09-10-spec-review/04_旧方案迁移清单.md)仅用于追溯，其章节落点属于归档时版本；当前项目范围与评测安排分别以两份总方案为准。

发票来源根 sourceRoot 已由用户指定为 `D:\obsidian\data\flowmate-data\Evidence\invoices\voxel51`，位于代码仓库外；原始发票和已有解析保留原位。已确认目录存在并列举 000001 样本文件，完整配对、摘要和可用子集仍由 P0 接入核验。当前代码按方案继续补齐 P0，历史命令与成绩不能代替当前验证。

## 前置条件

| 项目 | 要求 | 用途 |
|---|---|---|
| Bun | 1.4 或更高版本 | 安装依赖和运行全部根脚本 |
| Node.js | 22 或更高版本 | Pi SDK、脚本和原生依赖兼容 |
| Electron | 项目锁定版本及可执行文件 | 开发模式和桌面 E2E |
| SQLite | `better-sqlite3` 可加载 | Job、Run、候选和事件持久化 |
| Pi 运行时 | Pi SDK 原生包和 `@tintinweb/pi-subagents` | Agent Session、扩展和子 Session |
| 真实模型 | Live Profile、Provider 配置和本机凭证 | P0 真实字段抽取；默认测试不会自动调用 |
| 新原图 Parser | 已核验的 MinerU 可执行文件、模型缓存和 Parser Profile | 没有预存解析结果的新原图试验 |

Flowmate 不需要 Longbridge CLI，也不使用截图中的 `FINAGENT_*` 环境变量。默认开发和测试使用受控 Provider；真实模型只通过显式 Live Profile 运行。

## 安装与开发

| 命令 | 说明 | 适用阶段 | 状态 |
|---|---|---|---|
| `bun install --frozen-lockfile` | 按锁定版本安装工作区依赖 | P0–P6 | 可执行 |
| `bunx install-electron --no` | Electron 二进制缺失时补齐本机文件 | P0 | 按需执行 |
| `bun run doctor` | 检查 Bun、Node、Electron、SQLite、Pi SDK、插件和目录 | P0–P6 | 可执行 |
| `bun run dev` | 启动 Electron 开发模式 | P0–P6 | 可执行 |
| `$env:FLOWMATE_DESKTOP_CONFIG='<desktop-config>'; bun run dev` | 使用指定桌面配置启动开发模式（PowerShell） | P0–P6 | 可执行 |

桌面配置格式见 [`config/desktop.example.json`](config/desktop.example.json)，桌面主进程和凭证边界见[桌面说明](apps/desktop/README.md)。

## 检查、测试与构建

| 命令 | 说明 | 适用阶段 | 状态 |
|---|---|---|---|
| `bun run typecheck` | 检查所有工作区、脚本和测试的 TypeScript | P0–P6 | 可执行 |
| `bun run lint` | 执行代码风格和静态质量检查 | P1–P6 | P1 起启用 |
| `bun run check:boundaries` | 检查 contracts、core、Runtime 与 Renderer 的依赖方向 | P0–P6 | 可执行 |
| `bun run verify:runtime-lock` | 检查运行时和锁定版本 | P0–P6 | 可执行 |
| `bun run test` | 运行离线单元、契约和集成测试 | P0–P6 | 可执行 |
| `bun run test:runtime` | 运行 Pi Runtime、工具、扩展和子 Agent F | P0–P6 | 可执行 |
| `bun run test:desktop` | 构建并启动真实 Electron，运行 Playwright E2E | P0–P6 | 可执行 |
| `bun run test:live` | 执行显式 Live 测试，不混入默认测试 | P0–P6 | 具备入口，按条件启用 |
| `bun run build` | 构建工作区包、CLI、主进程、preload 和 Renderer | P0–P6 | 可执行 |

## P0 数据与运行

| 命令 | 说明 | 前置条件 | 状态 |
|---|---|---|---|
| `bun run p0 -- inspect --root <sourceRoot> --role-map <roleMap>` | 盘点原始文件和已有解析结果，输出有效项及隔离项 | 数据根与角色映射已核验 | 可执行 |
| `bun run p0 -- freeze --root <sourceRoot> --role-map <roleMap> --output <frozenRoot> --purpose <sampleId>=test` | 冻结明确指定用途的输入 | `inspect` 通过；用途已确认 | 可执行 |
| `bun run p0 -- parser --profile <parserProfile> --input <original> --sample <sampleId> --source-id <sourceId>` | 对没有解析产物的新原图执行 Parser 试验 | Parser、模型缓存、输入格式和 Profile 可用 | 入口可执行，真实环境待接入 |
| `bun run p0 -- plugin-probe` | 验证 Pi 原生扩展、Agent 工具和子 Session | Pi SDK、扩展和子 Agent 插件可加载 | 可执行 |
| `bun run p0 -- run --profile <liveProfile> --manifest <frozenRoot> --candidate <candidate> --sample <sampleId>` | 通过正式 Application/Pi Runtime 执行一次真实字段抽取 | Live Profile、冻结输入、候选和 Provider 已获准 | 入口可执行，真实环境待接入 |
| `bun run verify:handoff <manifest>` | 验证功能证据交接文件 | 交接文件已生成 | 可执行 |

模型接入目标为完全复用 Pi 原生 Provider、模型配置与认证；内置模型使用原生模型引用和认证，自定义服务使用可选的 [`Pi models 示例`](config/pi-models.example.json)。`.env` 由启动工具加载，变量必须被 Pi 原生机制支持或引用。Flowmate 只管理业务授权、预算及运行证据。现有 `ModelProfile` 代码及重复模板尚待按 [P0 实施计划 §2.2.1](docs/plans/P0_实施计划.md) 收敛，本次方案修订不代表代码迁移完成。Parser 模板仍见 [`config/parser-profile.example.json`](config/parser-profile.example.json)；缺少真实数据、Live 授权或 MinerU 时，命令须明确返回未就绪。

## Agent 评测与发布命令

| 命令 | 说明 | 适用阶段 | 状态 |
|---|---|---|---|
| `bun run eval:smoke` | 快速检查评测设施、种子 Case/Gold 和评分器，不访问真实业务系统 | P0–P6 | 评测 Runner 实现后启用 |
| `bun run eval:full` | 执行当前阶段冻结的完整 Agent Benchmark、评分、报告和结论 | P1–P6 | 后续阶段实现 |
| `bun run release:check` | 汇总类型、边界、测试、E2E、构建和质量结论门禁 | P1–P6 | 后续阶段实现 |
| `bun run release:package` | 生成经批准的桌面发布包 | P5–P6 | 后续阶段实现 |

评测命令的模式、Case/Gold、Benchmark、归因和阶段边界见 [Agent 评测总方案](agent-eval/docs/spec/01_Flowmate_Agent评测总方案.md)；未实现的命令不会作为当前验收结果。
