# Flowmate Agent 评测操作手册

修订：2026-09-23（目录补齐、旧 Dataset 删除与延后制作）。本地 JSON、Runner、自动评分和报告组成统一 Benchmark；Langfuse 仅可选展示。当前业务 Dataset 尚未制作。完整 Agent 实现、真实入口与必要采证接通、工程验证通过后，才依据 01/02 制作首版 50 条任务及 10 条 Smoke 引用。此前只维护方案、制作规范和设施，不制作业务 Case、Gold 或成员清单。运行入口拒绝缺数据或未接通的 Agent，不降级为 Provider 直调。

## 完整目录与职责

```text
agent-eval/
├── README.md
├── package.json
├── tsconfig.json
├── datasets/
│   └── README.md             # 当前只保留制作说明
├── src/
│   ├── README.md
│   ├── cli.ts
│   ├── types.ts
│   ├── datasets/             # 加载、校验、选集与输入投影
│   ├── execution/            # Runner、独立 Trial、采证与清理
│   ├── adapters/             # 真实 Agent 产品入口适配（当前待接通）
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

`datasets/` 保存任务数据；当前仅有制作说明，未来 Dataset 子目录在正式制作时创建。`src/datasets/` 是数据读取与校验代码，`tests/fixtures/` 仅服务工程验证，不是业务 Benchmark。`runs/` 是生成目录，保存实际快照与记录；不创建空目录、空成员清单或占位成绩。完整 Agent 适配未接通不等于目录缺失，接口存在也不代表实现完成。

## 命令

在仓库根目录执行，参数中的占位符替换为实际值。

```powershell
bun run eval -- --help
bun run eval -- doctor
```

doctor 默认检查本地配置；零 Dataset 时显示“尚未制作，等待完整 Agent”，`ok` 仅代表配置检查，`benchmark.ready=false`。不会创建数据、执行记录或调用模型。

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

选集 smoke/full 默认 full，单 Case 选择独立记录；repeat 为 1～20，默认 1。backend 默认 FLOWMATE_EVAL_BACKEND 或 local；judge auto/off/required 默认 auto。Judge auto 配置齐全时可能收费，Smoke 快捷入口关闭 Judge；Full 快捷入口要求 Judge。全量也可显式 judge off，但报告标明未测语义指标。config 是严格 JSON，支持 model、baseUrl、api、maxTokens、repeat、timeoutMs（100～120000）、stopGraceMs（100～10000）、environment；不接受密钥。CLI repeat 优先。

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

runs/<executionId>/ 保存 summary.json、snapshot.json、source.json 和各 Trial/execution.json。每个 Task 的多轮、恢复和子 Run 仍只属于一个 Trial；重复另建 Trial。报告区分 smoke/holdout、计划/启动/完成与五态，Agent 原始候选和模拟用户编辑后的候选不得混算。正式验收状态始终与自动通过独立。

退出码：0 必要自动检查通过；1 失败、错误或未完成；2 必要评分未完成。人工反馈和导出不影响自动成绩。旧契约报告仅 status 只读展示，不重评分或导出为新版本。

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

材料不可用不回退；完整 Agent、环境场景处理器和领域采证尚待接入。当前通用事实比较器不是全部领域指标已实现的证明。Gold、语义参考和 Judge 的真实校准待人工核验。未升级依赖、不恢复历史成绩、不修改平台数据。

[源码职责](src/README.md) · [任务与材料](datasets/README.md) · [Judge](src/scoring/judges/README.md) · [总方案](../docs/eval/01_Flowmate_Agent评测总方案_v1.md)

## 当前状态与历史边界

旧 `datasets/flowmate-agent-v1` 已删除，包括 50 条草稿、dataset.json 与专属 README，不保留归档副本或空清单。先前“内容版本 2、16 类已分配、草稿暂存”的记录均已被本次决定替代；不据此认定当前已有数据。历史修订依据见 [核对表](../docs/eval/04_统一评测修订核对表.md)。原始发票来源、独立测试夹具、评分代码和已有运行记录保留，未操作 Langfuse。

正式制作以完整 [01 总方案](../docs/eval/01_Flowmate_Agent评测总方案_v1.md) 和详细 [02 手册](../docs/eval/02_Flowmate_Agent评测数据集制作方案_v1.md) 为依据，在完整 Agent、真实入口与必要采证接通、工程验证通过后开始。首版 50 条、Smoke 引用 10 条是未来规模，不是已有成员。当前通用比较器与 Judge Rubric 保留，不表示领域采证、Gold 核验、真实 Judge 校准或正式冻结已完成。

设施测试使用独立最小合成数据，见 [测试说明](tests/README.md)。工程验证与设施通过不能形成 Agent 质量结论；本轮不调用真实 Agent/Judge、不写平台、不生成 Benchmark 成绩。
