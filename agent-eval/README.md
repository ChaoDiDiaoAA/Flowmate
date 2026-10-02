# Flowmate Agent 评测操作手册

修订：2026-10-02（删除提前实现的评测数据及 Runtime 评测增量）。所有正式 Case/Gold 制作、真实开发及必要 Judge 校准、Smoke、留出和四组质量运行，统一等待完整 P1–P16、公共入口、必要采证及工程就绪（01 §12.1）。旧完整数据及本轮 Runtime 24 Cases、清单、Gold 审核草稿、A–D 配置已删除，不归档、不改名为夹具；本轮新增 Runtime Adapter/v2/holdout/校准/故障增量和专属测试已撤回。原通用 Runner、评分、独立工程夹具与历史记录保留，生产 productAgent.readiness=false、prepare 拒绝。T15/T16 均延期到完整产品门槛后；以下 50/10、24/8/16 与四组设计仅为待实施计划。

## 完整目录与职责

```text
agent-eval/
├── README.md
├── package.json
├── tsconfig.json
├── datasets/
│   └── README.md             # 当前仅制作说明，业务数据均已删除
├── src/
│   ├── README.md
│   ├── cli.ts
│   ├── types.ts
│   ├── datasets/             # 加载、校验、选集与输入投影
│   ├── execution/            # Runner、独立 Trial、采证与清理
│   ├── adapters/             # Kernel窄接口；productAgent未就绪并拒绝执行
│   ├── scoring/
│   │   ├── types.ts
│   │   ├── registry.ts
│   │   ├── evaluate.ts
│   │   ├── aggregate.ts
│   │   ├── evaluators/       # 每项确定性评分器一个文件
│   │   └── judges/           # 每项 Judge 一个文件及公共客户端
│   ├── reports/              # 本地结果、查询与比较
│   ├── review/               # 独立人工反馈
│   └── langfuse/             # 可选导出与人工记录同步
├── tests/
│   ├── datasets/
│   ├── execution/
│   ├── scoring/
│   ├── reports/
│   ├── review/
│   ├── langfuse/
│   ├── cli/
│   ├── fixtures/             # 独立工程测试材料
│   └── support/
└── runs/                     # 运行时产生，保留已有记录，不预建成绩
```

`datasets/` 当前只保留制作说明。提前创建的 Runtime 数据、清单、Gold 审核草稿与配置均已删除，不留冻结/归档副本，不移到 tests/。`src/datasets/` 保留原 v1 加载代码；原独立 tests/fixtures 和通用支持保留，本轮 Runtime 数据依赖的专属测试与支持文件随实现撤回。`runs/` 保留独立历史记录，不预建成员、校准或成绩。

## 命令

在仓库根目录执行，参数中的占位符替换为实际值。

```powershell
bun run eval -- --help
bun run eval -- doctor
```

doctor 默认检查本地配置，不创建数据、执行记录或调用模型。`ok` 只证明该检查范围；当前业务数据不存在且生产 productAgent 未就绪，配置/凭据齐全不能打开真实 Agent 质量运行。

以下依赖 Dataset 的命令在**制作完成后使用**。当前数据不存在时明确报错并返回非零，不自动生成或回退数据。真实运行还有模型费用，无模拟模型分支：

```powershell
bun run eval -- dataset validate --dir agent-eval/datasets/flowmate-agent-v1
bun run eval -- status --dataset flowmate-agent-v1
bun run eval:smoke
bun run eval:full
bun run eval -- run --dataset flowmate-agent-v1 --selection smoke --judge off
bun run eval -- run --dataset flowmate-agent-v1 --selection full --judge required
bun run eval -- run --dataset flowmate-agent-v1 --case <CaseID> --judge auto
bun run eval -- run --dataset flowmate-agent-v1 --dataset-version <版本> --selection full --repeat 1 --config <JSON路径> --execution-id <ID> --backend langfuse --judge required
```

现有选集 smoke/full，默认 full；单 Case 独立记录，repeat 1～20、默认1。backend 默认 FLOWMATE_EVAL_BACKEND 或 local，judge auto/off/required 默认 auto；auto 配置齐全可能收费，Smoke 快捷关闭 Judge、Full 要求 Judge。严格原配置/密钥预检保留，CLI repeat 优先；Runtime holdout、预算/策略及扩展期限为完整产品后的待实施增量。命令存在、off 或配置合法均不能授权提前质量运行。

```powershell
bun run eval -- status --execution-id <ID>
bun run eval -- compare --left <ID> --right <ID>
bun run eval -- review add --execution-id <ID> --case <CaseID> --trial <TrialID> --reviewer <姓名> --verdict good --note "<依据>"
bun run eval -- review status --execution-id <ID>
```

已有报告的查询、比较、反馈和显式补传不依赖 Dataset 存在。Case 质量命令在**制作完成后使用**：

```powershell
bun run eval -- review add --dataset flowmate-agent-v1 --case <CaseID> --reviewer <姓名> --verdict good --note "<核验依据>"
bun run eval -- review status --dataset flowmate-agent-v1
```

运行反馈与 Case 质量记录互斥选择目标；多次重复时指定实际 TrialID。verdict 允许 good/bad，需真实审核人及备注。内容 hash 绑定版本；没有人工反馈显示 none，普通反馈不等于 Gold 已认可或正式验收。

## 评分与结果

整个 Trial 到达预定终点才评分；中间一轮 Run 结束不等于整个任务结束。失败、超时、中止、未启动不调用质量评分器或 Judge；保存原始轨迹与运行事实。已启动业务失败/任务预算耗尽记 FAIL，设施错误、中止、未执行单列。

确定性评分须适用且证据齐全；Judge 还须选中、独立配置齐全且预算允许，分数高低不控制其触发。必要约束失败优先；未知证据与错误是 null，不能写成零分或忽略。Judge 总输出预算 15000 Token，首次 50×256=12800；重复计划超额在启动前拒绝。无重试/切模/自动人工审批。

未来制作时，解释、澄清等依赖语义的任务通过清单 `scoring.judges[].requiredFor` 登记必要 Judge，仍每 Trial 最多一次。auto 缺配置时选中它们会在 Agent 启动前拒绝；显式 off 只执行确定性部分，必要 Judge 为 NOT_RUN/null，任务不能 PASS。其他任务的 Judge 为辅助，full 快捷入口则要求全部选中任务的 Judge。

runs/<executionId>/ 保存 summary.json、snapshot.json、source.json 和各 Trial/execution.json。每个 Task 的多轮、恢复和子 Run 仍只属于一个 Trial；重复另建 Trial。报告区分 smoke/full、计划/启动/完成与五态，Agent 原始候选和模拟用户编辑后的候选不得混算。正式验收状态始终与自动通过独立。

退出码：0 必要自动检查通过；1 失败、错误或未完成；2 必要评分未完成。人工反馈和导出不影响自动成绩。旧契约报告仅 status 只读展示，不重评分或导出为新版本。

## 完整产品后 Runtime 专题的操作（待实施）

提前制作的 `flowmate-runtime-recovery-v1` 数据目录已删除，新增产品 Adapter/v2/holdout/故障/校准设施与专属测试已撤回。完整产品门槛之后才实施 T15 适配与过程报告、T16 契约/设施/冻结协议；当前 T17 仅验证产品 Runtime T10–T14，不依赖正式数据。

未来 T18 正式制作12正常/故障配对共24 Cases、8开发/Smoke和16留出；同来源及配对在同分区。审核和真实开发/必要 Judge 校准后冻结模型/预算、材料、profile、真实统计/经验快照 hash/cutoff 与 A–D 配置，留出不反哺。v2/v1兼容、holdout、calibration 引用和 Runtime 过程报告均为待实施要求，字段见 [02 §3.3](../docs/eval/02_Flowmate_Agent评测数据集制作方案_v1.md)，方法见 [01 §6.4/§12.2](../docs/eval/01_Flowmate_Agent评测总方案_v1.md)。

A基础/B预算/C统计期限/D经验均强制 before/after、权限、提交查证、真实停止及必要保存。calibration:null 不解锁整体门槛；正式核验后，无统计/经验开发范围才可首次真实校准，正式或依赖统计/经验须真实快照/hash/来源/截止。不足回退并报未激活，不伪造或自动付费补20条。

以下仅为**完整产品、T15/T16设施验收及T18数据核验/对应校准冻结完成后的命令设计**，当前未实现 holdout，不能执行为质量证据：

```powershell
bun run eval -- run --dataset flowmate-runtime-recovery-v1 --selection smoke --repeat 1 --config <开发组配置路径> --judge required --backend local
bun run eval -- run --dataset flowmate-runtime-recovery-v1 --selection holdout --repeat 3 --config <冻结组配置路径> --judge required --backend local
```

未来四组分别预登记独立 Execution/config hash，单组16×3留出 Judge 输出上界12288<15000，四组49152；每组8×1正式 Smoke上界2048，四组8192，八正式Execution合计57344。额外校准事前单列并纳入累计，不事后拆同一超额Execution；全24×3=18432单执行仍须拒绝。报告保留全部计划、原 Run 终态、暴露和独立预期；未暴露不计恢复成功，未知提交/停止不重投。安全停止确定性核验，无模型解释则语义理解未测，质量 Judge 仍依 started/completed/endpoint。

拒绝采证分 SDK immediate（SDK execute/after 未发生）与 Host 内部拒绝（实际业务 execute/Host after/耗时未发生，但 SDK after 发生）；不能把 SDK after 冒称业务执行。产品原生历史、调用终态和 delivery 各自取证，不造另一套 Runtime。

## 可选 Langfuse

local 不初始化 SDK、不验证平台密钥、不请求平台。启用时读取 LANGFUSE_*，先保存本地结果，再导出；失败不改分、不重跑模型。

```powershell
bun run eval -- doctor --backend langfuse
bun run eval -- resend --report <绝对summary.json路径>
bun run eval -- review setup --backend langfuse
bun run eval -- review enqueue --execution-id <ID> --backend langfuse
bun run eval -- review import --execution-id <ID> --backend langfuse
bun run eval -- review sync --execution-id <ID> --backend langfuse
```

review apply 已退役；导入使用 review import。平台反馈导入绑定原 Trace、版本、审核人；补传复用 Observation/Score ID，不调用 Agent/Judge。Trace 为“Agent · 任务名”，Score 使用指标名称，身份及版本在 metadata，environment 可在运行配置或 .env 的 FLOWMATE_EVAL_ENVIRONMENT 中设置。平台不承担 Case 来源、实验编排或原生 Judge。

## 测试、迁移与限制

`bun run typecheck`、`bun run test:unit`、`bun run test:integration` 均为设施验证，不调用模型。产品阶段测试继续在 tests/；旧 Provider 控制器、阶段 Dataset、阶段命令已移除。sync、dataset publish、--version、--wait-seconds、--stage、--mode 返回迁移错误。

材料不可用不回退；完整产品评测接合和必要领域采证仍待实施，原通用比较器不能证明这些能力。正式 Gold、语义参考及真实 Judge 校准只在完整产品门槛后制作核验。产品 Runtime 工程保留，本轮新增评测实现及其专属测试已撤回；未升级依赖、不恢复旧成绩、不操作平台。

[源码职责](src/README.md) · [任务与材料](datasets/README.md) · [Judge](src/scoring/judges/README.md) · [总方案](../docs/eval/01_Flowmate_Agent评测总方案_v1.md)

## 当前状态与历史边界

旧 `datasets/flowmate-agent-v1` 已删除，包括 50 条草稿、dataset.json 与专属 README，不保留归档副本或空清单。先前“内容版本 2、16 类已分配、草稿暂存”的记录均已被本次决定替代；不据此认定当前已有数据。历史修订依据见 [核对表](../docs/eval/04_统一评测修订核对表.md)。原始发票来源、独立测试夹具、评分代码和已有运行记录保留，未操作 Langfuse。

正式制作依 [01 总方案](../docs/eval/01_Flowmate_Agent评测总方案_v1.md) 与 [02 手册](../docs/eval/02_Flowmate_Agent评测数据集制作方案_v1.md)，先满足完整 P1–P16、公共入口、必要采证及工程就绪，不按阶段、requires 子集或空数组提前开放。50/10与Runtime24/8/16均仅为待实施计划；此前“Runtime draft 冻结保留”和“部分评测增量已接通”已由本次删除/撤回取代。

设施测试边界见 [测试说明](tests/README.md)。原独立通用夹具保留，本轮依赖已删 Runtime 数据的专属测试及支持文件撤回；不得将业务评测数据改名移作夹具。工程通过不能形成 Agent 质量结论。本轮未执行 Agent/Judge、平台或 Benchmark。