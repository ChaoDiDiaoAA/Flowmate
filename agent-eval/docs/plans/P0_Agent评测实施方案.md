# P0 Agent 评测实施方案

> 文档版本：`p0-plan-v1`；核查日期：2026-09-20（Asia/Shanghai）。本轮已建立可由产品 F 直接驱动的 P0 Application/CLI 与证据契约，并完成当前 2,902 份输入的产品发布/重读验证；没有运行模型、Agent A/B 或完整质量报告，独立资产阻断仍保留。不修改来源数据、已发布清单、Gold、Case及历史结果。配套产品文件：[P0 阶段实施方案](../../../docs/plans/P0_阶段实施方案.md)。

## 1. 评测对象、真实基线与适用性

### 1.1 这份“Agent评测方案”在P0证明什么

P0首先验证未来Agent所依赖的输入、身份、当前授权、存储与证据能否成立。模型尚未接入，不能生成Agent成绩。按[评测总方案](../spec/01_Flowmate_Agent评测总方案.md) §11.1/§12执行，产品边界继承[产品主方案](../../../docs/spec/00_Flowmate完整方案.md) §21.1。

| 类别 | P0适用性 | 允许的结论 | 禁止替代的结论 |
|---|---|---|---|
| 数据/评测资产准备 | 适用 | 固定集合有哪些、结构/摘要/来源/隔离是否成立，缺口是什么 | 不代表原票字段正确、Gold已人工复核或产品已运行 |
| 产品确定性功能F | 适用；已有基础实现和测试，正式报告待独立复核 | Application真实调用、权限/状态/文件事务/重启和错误边界是否满足契约 | 不代表模型理解、工具选择或业务收益 |
| 真实Agent行为A | 不适用：P1起 | 本期不输出任何Agent通过率、模型成绩、Token费用 | 不以离线任务materialized或合成trace伪造A |
| 业务结果B | 不适用：后续业务阶段 | 本期不输出业务字段准确率、报销/入账成功率或提效收益 | 不以文件完整和存储成功推断业务正确 |
| 评测设施自检 | 适用的子集 | Schema/引用/隔离/汇总/证据复核器正确性 | 不记作产品F或A/B Baseline |

P0使用产品 F 的确定性断言、来源核验和基础证据，不消费完整 Agent 任务数据集，也不输出 Agent A/B 成绩。这里的 Case/Oracle 仅指 P0 产品 F 的检查项、固定预期和证据判定，不等同于后续真实 Agent 任务的业务 Gold/Oracle。产品侧已有 F 能覆盖的检查直接复核复用，不建立完整 EvalRunner、模型裁判、Dashboard、独立业务状态库或发布服务。P1具备真实Agent入口时接入最小Inspect Task/Solver/Scorer；各阶段当期制作并执行独立阶段集，不等待完整Agent。P0不增加Inspect或模型验收门槛。

### 1.1A 阶段评测数据的生命周期与目录

现有 `agent-eval/data/` 是仓库已有的全量质量准备材料。P0 只把其中的来源核验结果作为质量侧参考；产品代码、P0 Application 和 P0 F 报告不能读取 `cases/`、Gold、Oracle、Rubric 或 Benchmark 来制造产品结果。现有材料不删除、不改摘要、不作为 P0 Agent 通过依据。

各阶段当期按需新建独立目录，不预建十四套空集：

```text
agent-eval/stage-evals/Pn/
  README.md
  cases.json
  gold.json       # 有正确事实需求时创建
  fixtures/       # 有额外输入/故障材料时创建
```

Oracle嵌入Case，不另建oracles/benchmarks/manifest目录。数据不追求数量，只追求必要能力、失败路径、正常对照和关键回归的质量。整理P0阶段资产时建立P0/README.md和cases.json，索引现有F、固定判据与证据；仅补缺少夹具，不重复实现测试，不要求业务Gold、模型或真实Agent适配器，不因索引整理改变历史结论。本次不创建目录；P1开始真实A，各阶段按能力增加适用B。现有data综合集完整Agent实现后再核验启用，保留全部原始材料/摘要/状态。

Inspect统一阶段和最终综合评测，CLI执行、Inspect View查看；Python/TS适配仅在agent-eval/src，实现及协议见评测主方案第10章。上游安装已核查不等于产品适配完成。产品实例和配置在质量根之外，旧P0报告保留reports/p0。本次只同步文档，以下数量与检查结果沿用原P0历史核查，不宣称本轮重跑。

数据规范统一引用评测总方案§10.5：P0权限拒绝设计复用现有真实接口与测试；P1例只说明后续Case/Gold及Inspect映射，不属于P0验收。四类状态分别记录：数据准备完成、可以执行、评测完成、阶段通过；评分仍沿用第7章契约，缺证据不能通过。现有综合集原本允许阶段筛选，本次改为完整Agent后核验使用，历史用途与报告不改写。

代码兼容待办见评测总方案§10.5.7：旧离线工具尚不支持阶段目录，P0报告脚本仍固定三项阻断；后续按实际依赖核验并适配，不能直接删除用途检查或重签历史报告。本次仅同步规范，不宣称工具和报告已经调整。

### 1.2 与产品方案共享的版本和现状

Git HEAD=`99ea110dfec0dea909d328f9db17a6687c848b87`；开始时工作区只有用户的`README.md`修改，予以保留。产品主方案SHA-256=`144ad6ad076b8229c9fca28a33dfb40e4774d951aca2ec41d7cf40570ce664e4`；评测总方案SHA-256=`09225f2fd5e9598a9083f700b71f7e55a280eecc414d63259fa190534ab54e54`。原始依据、工作区状态、环境与文件hash见产品方案§1；两份方案使用同一快照，不把方案新增文件当运行代码变更。

| 现状 | 状态标签 | 本次证据及限制 |
|---|---|---|
| 产品工程/Application/Kernel/公共CLI/产品SQLite | 已实现且本次验证 | `apps/composition.ts`、`packages/core`、`scripts/p0.ts`、`package.json`/`bun.lock`；`bunx tsc --noEmit`、`bun run test:p0`通过；尚无完整 Agent adapter |
| 当前来源清单2,902份原票，标签1,414份 | 已实现且本次验证 | `initial_dataset.verify_sources`全量大小/摘要核验成功；verifiedSourceFiles=19,376（来源metadata及文件，不含标签计数），结果保存于`agent-eval/reports/p0/20260920-full-product/source-verification.json` |
| 全量解析结构/配对/图片引用闭包 | 已实现且本次验证（结构范围） | 产品inspect全量检查JSON、页面/block计数、引用路径和图片结构；独立`p0_source_audit.py`核对2,902份身份、2,902组页/block、4,866个图片引用与7,768个图片描述符；2,902份发布后重读、4,755个唯一图片证据读取通过；不代表OCR/业务字段正确 |
| 质量设施指定测试 | 已实现且本次验证 | `InitialContractTests` 11 passed；没有由此产生产品F证据 |
| 完整质量资产发布一致性 | 保留参考，暂不作为P0 Agent评测输入 | initial_dataset verify和coverage_update verify均退出1，`Benchmark definition pin drift`；11个有效Benchmark定义摘要漂移。现有材料不删除、不修复、不用于当前 Agent 评测 |
| 离线装配/自检评分 | 已实现且本次验证 | 源码检查见下节；实际只运行指定设施测试，不宣称逐个执行所有Case |
| Gold100、人工复核0、business80、agentTasks78、contract14/460、selftest1/28 | 已实现但本次未验证 | 当前材料/清单声明，不能当全量复核或实际执行数；本次未逐个业务Gold审核 |
| 真实产品适配器、产品运行、Baseline | 部分已实现/后续阶段 | P0 Application/CLI已作为确定性 F 入口完成全量发布/重读；尚无模型/Agent adapter，不能生成A/B成绩或Baseline |
| 本方案Case执行/证据复核接口 | 已实现部分契约 | `packages/contracts/src/evidence.ts`提供`p0-f-evidence/v1`类型和状态汇总；这里的Case/Oracle是P0产品F证据契约，不替代未来 Agent 阶段文件中的业务Case/Oracle冻结 |
| 模型、Session、Workflow、扩展/子Agent、桌面、Host | 后续阶段启用 | 分别P1/P4/P8/P10/P11/P12/P13；本期不做依赖性虚假门槛 |

来源清单hash=`0668d44b8d91ba69df8ae83821ff646c6268597a17fd59f2367d2df469c0da5f`；标签清单hash=`9f555559e92de7b044f8d51c2237c94ff81db047608121aa644b307d3bb9b500`；inventory hash=`771ef4bdf47bc7dd7d5a3bcb7f851693a9439d843963dbe0c9c38b9528fae0e3`。aliases的3,014条由2,902自身映射+112重复别名构成。历史报告数量、当前清单数量、本次实际检查范围分别列出；不把数字相同当作完整再验证。

### 1.3 现有设施能做和不能做的事情

真实签名如下，不改造成不存在的产品API：

| 符号 | 已有行为 | 评测处理 |
|---|---|---|
| `tools/initial_dataset.py:581 verify_sources(project)` | 校验来源与标签文件描述符，含当前资产版本固定数量约束 | 可作当前资料核查，不能替代产品输入入口/全语义检查 |
| `tools/initial_dataset.py:451 validate_snapshot(project, outputs, public=None, check_sources=True, check_review=True)` | 质量资产结构、引用、控制/分割、来源和Benchmark摘要检查 | pin冲突解除前不得宣称当前全量冻结通过 |
| `src/runner/initial_dataset.py:41 materialize_task(case, project=None, quality=None)` | 分离fixture.input/harness/grading；actualProductRun=false、NOT_RUN | 只证明离线装配；任务入口不存在时保持阻断 |
| 同文件`:80 grade_observation(case, observation, gold=None)` | 仅eval_selftest做合成JSON比较；产品场景UNJUDGEABLE | 自报success/伪trace不能换成产品PASS |
| 同文件`:119 assemble_benchmark(benchmark_id, project, stage=None, split=None, subset='capability', capability=None, task_type=None)` | 筛选Case/依赖，保留后阶段控制阻断 | stage=P0不是执行授权，不删除控制项来制造通过 |
| `src/runner/evidence.py:31 load_evidence(run_root: Path, manifest: dict, trusted_adapters: dict) -> dict` | 要求产品来源、固定文件和注册可信adapter；VerifiedObservation带内部校验 | 当前无可用产品adapter不接入此路径；P0用真实产品F报告+人工原始证据复核，不伪造Run来满足接口 |
| `src/contracts.py:12 aggregate_checks(checks)` | FAIL优先，旧INFRA_ERROR/NOT_APPLICABLE枚举，空必要集UNJUDGEABLE | 不能直接复用其结果为现行门禁；见§5显式兼容和自检 |

当前已有P0声明场景31个（foundation28、事件/日志3），包含`adapter.publish_prepared_dataset`等字符串；这些是声明命令，不是可调用函数。实施后由产品F驱动明确映射至Application真实API，原Case不通过改写为PASS。P0不要求补建所有460个高阶段场景的执行设施。

## 2. 能力、指标、用例与证据映射

### 2.1 版本规则

共享能力：C01身份/配置、C02契约/错误、C03SQLite/审计、C04受控文件、C05来源/发布、C06读取/状态、C07诊断日志、C08组装/CLI、C09证据交接、C10质量隔离；完整前缀均为`P0-Cxx`。

指标名称与公式沿用总方案§8.4、§8.5.1、§8.9。总方案未单列指标semver时，使用`{metricId, definitionSourceSha256, section, instantiation:'p0-plan-v1'}`固定含义，不虚构官方“v1”指标版本。Case本方案版本=`p0-plan-v1`，执行前另记录实际Case文件hash；引用已有场景须记录Case版本、场景ID、Oracle摘要和控制引用。需求版本改变先评审影响再重冻结，不能运行后改分母/门槛。

### 2.2 可追溯矩阵

表内Vxx编号与产品方案§9逐项台账一致；“证据E1～E8”定义见§3。门槛C为必要正确性，S为隔离/安全；全部必要项逐项100%满足、违反为0，不能平均。责任角色P=产品实现/F负责人，D=数据负责人，Q=独立质量复核人；同一人兼任时必须留下不同职责检查步骤，不能以自评分替代Oracle。

| 主/评测/补充依据 | 能力 → 拟新增类/方法 | 指标ID（版本按§2.1） | Case / Oracle | 可信证据与判定 / 门槛 / 责任 |
|---|---|---|---|---|
| 主§17/§21.1；评§3.3“输入与资产治理覆盖”/§11.1；V17 2.1～2.3 | C05 → DataPort.inspect、mapPreparedParse | MOD-09.input；MOD-30.assets；ALL.prepared | F01、F05～F10；固定来源描述符+解析结构/配对协议 | E1/E3/E4逐项闭包核验；全量保留成员无未解释差异C；D/P/Q |
| 主§17隔离；评§3.22/§11.1；V17 2.1/2.6 | C10 → validateRelativePath、readVerified、projection | MOD-30.isolation；MOD-30.assets | F02/F18～F20；来源白名单、质量禁止根、canary对照 | E1/E3/E7；非法根实际拒绝、禁止内容输出0 S；P/Q |
| 主§17发布/§18事务；V03 2.3、V17 2.4、V18 2.3 | C03/C04/C05 → preparePublication、Kernel.commit、publishDataset | MOD-09.input；MOD-25.atomic；MOD-26.audit | F03/F11～F14；不可变版本/回执/事务Oracle | E2/E4/E5；新版本半可见0、重复有效版本0 C/S；P/Q |
| 主§17可读输入/§21.1；V07 2.2、V18 2.2 | C06 → readDocument、captureInput、readCapturedInput | MOD-09.availability；MOD-25.atomic；MOD-29.backup | F04/F29；固定内容链与当前状态 | E2/E4/E5两进程核验；真实样本≥1且身份/内容稳定C；P/Q |
| 主§2.6/§19；评§3.23/§3.27；V02 2.5、V19 2.5 | C01/C02 → Kernel.authorize、getWorkspace、publishPolicy | MOD-07.foundation；MOD-25.atomic；MOD-26.audit | F15～F17/F23；可信主体/当前策略/归属矩阵 | E2/E4/E7；未知身份/空间/无权/错归属均拒绝且无正文外泄S；P/Q |
| 主§21.15.1/§17/§2.6；评§3.25；V17 2.5 | C06 → setWorkspaceStatus、setDocumentStatus | ALL.state；ALL.edges；MOD-09.availability；MOD-29.retention | F21/F22；预先冻结的合法边/拒绝矩阵 | E2/E4/E5逐边；合法全覆盖、非法有效转换0 C/S；P/Q |
| 主§18迁移；V18 2.1/2.4 | C03 → openFoundationDb、applyMigrations | MOD-25.atomic；MOD-29.backup | F24/F29；迁移checksum/闭库恢复协议 | E2/E4/E5；失败不破坏旧事实、不带旧撤回状态放行C/S；P/Q |
| 主§18.5；评§3.6.1；V03 2.5 | C07 → LoggerPort.write/flush/close | MOD-26.logs；MOD-26.audit | F25～F27；脱敏、容量、日志/审计故障分离 | E2/E4/E6；秘密/正文泄漏0、配额不突破、降级可见C/S；P/Q |
| 主§20.3.2/§21.1；V20 2.2/2.4 | C08 → createProduct、main、StartedProduct.close | MOD-07.foundation；MOD-25.atomic | F28/F30/F31；依赖图、导入差分、资源句柄 | E2/E7；无隐式启动、无Electron/Pi加载、明确关闭C；P/Q |
| 主§22；评§7.6～7.7/§12；V22全部/V24 2.2 | C09 → 产品F收集器、质量review_p0_report | MOD-30.assets；ALL.executed/judgeable/pass/confirmed | F32；独立已知正反/缺证据夹具 | E8+所有原证据；版本与来源完整，缺证据不能通过C；Q |

正文引用模块主题以标题为准，章节精确定位执行前以固定总方案核对；不能仅因MOD编号涵盖高阶段模块就要求P0全部实现。`MOD-27.release`的完整release口径本期N/A：配置锁具体检查归MOD-07/25/26，P0无生产Release。MOD-29.backup/retention仅当期文件/身份/状态恢复与拒绝，不要求Host、Session恢复或完整备份平台。

### 2.3 与既有31个P0声明场景的映射

以下仅登记复用关系，不声称其adapter已实现；缺少实际驱动或可信证据时仍NOT_RUN。

| 本期组 | 现有scenario ID |
|---|---|
| F03/F04 | `contract-input-valid-multipage-import` |
| F05 | `contract-input-missing-second-page`、`contract-input-original-only` |
| F07 | `contract-input-malformed-schema` |
| F09 | `contract-input-digest-tampered` |
| F10 | `contract-input-same-image-conflicting-parses`、`contract-input-changed-parse-new-version` |
| F11 | `contract-input-identical-reimport`、`contract-storage-immutable-artifact-conflict` |
| F12/F13 | `contract-storage-file-save-before-reference`、`contract-input-publication-db-failure` |
| F14 | `contract-storage-commit-ack-loss-reconcile` |
| F15/F16 | `contract-storage-default-workspace-restart`、`contract-assembly-cli-unknown-actor`、`contract-storage-missing-workspace` |
| F17 | `contract-storage-source-read-permission`、`contract-storage-document-artifact-owner-mismatch` |
| F19 | `contract-input-reparse-point-escape` |
| F20 | `contract-input-metadata-label-isolation` |
| F22 | `contract-input-withdrawn-old-manifest` |
| F24 | `contract-storage-migration-failure` |
| F25/F27 | `contract-rt-log-normal`、`contract-rt-log-redaction`、`contract-rt-log-audit-fail` |
| F28 | `contract-assembly-core-dependency-direction`、`contract-assembly-import-only`、`contract-assembly-p0-no-runtime-import` |
| F29 | `contract-supplement-dataset-restore-identity` |
| F30/F31 | `contract-assembly-cli-without-electron`、`contract-assembly-explicit-start-close`、`contract-assembly-partial-start-failure` |

F01/F02/F06/F08/F18/F21/F23/F26/F32等补足阶段协议缺口，不为了保持既有场景数而省略。32是协议用例组数量，不是已发布Case数，也不是最终检查分母；各组参数化变体在执行前展开并冻结。

## 3. 执行与证据协议

### 3.1 角色和可信证据

产品执行命令、控制故障点、保存业务事实；质量侧冻结Oracle、核验证据与判定。正常初态通过createProduct/真实Application命令建立；质量侧不直接UPDATE业务库造成功。损坏/缺失、故障DB、受限目录等反例只在专用临时实例/来源副本操作，并在Case声明破坏位置，不能触碰实际保留输入或已发布质量数据。

| 证据ID | 内容及实际来源 | 核验方式 |
|---|---|---|
| E1 版本/集合 | source manifest及metadata描述符、别名/差异/排除、集合范围；质量定义/Oracle分别固定 | 外部只读重算摘要和数量，记录全集/子集、来源声明与已验证资格的区别 |
| E2 执行身份/进程 | 启动命令、真实PID/processInstanceId、instance/workspace/actor、requestId、UTC起止、exit code、stdout受控结果/stderr | 产品F驱动在子进程外记录；新进程重启不得复用测试内存单例 |
| E3 来源读取 | 实际读取的相对路径、大小/hash、解码/Schema/配对/引用检查结果 | 对所有保留成员建立明细；外部核验器重算固定样本及有争议项，不把`verified:true`当证据 |
| E4 持久事实 | 产品成功回执、Document/Artifact/Workspace/audit/migrations的受控只读快照，必要Artifact原始字节 | close后由质量侧只读连接/文件读取交叉核对引用、唯一键、当前状态、事务前后差分；不直接改库 |
| E5 时序/故障 | 文件写完前、DB提交前后、回送前、重开时间点与故障触发确认、前后可读性 | 驱动观察实际故障发生，正常对照同样入口；“计划注入”不等于注入成功 |
| E6 日志 | JSONL、实例所有分段大小、脱敏检测、队列/容量健康、stderr降级 | 对真实文件与允许字段做确定性比较；日志缺失不能证明没有越权 |
| E7 结构/访问/关闭 | 编译依赖图、产品文件访问观测、导入前后文件/连接/进程差分、句柄释放检查 | 导入实际composition；禁止根读取计数/正常对照；close后新进程打开和目录重命名成功 |
| E8 复核 | 质量复核人、Oracle版本、每check状态/reason、证据refs、设施自检记录 | 独立已知答案/反例验证；无自报成绩转换为PASS |

访问观测必须覆盖实际受控文件实现，测试包装器只记录路径/开关，不返回预制成功结果。另查产品依赖/直接fs入口，防止绕过ControlledFileStore。P0验证产品受控边界，不声称能观测所有同权限外部进程；Windows平台检测不成立时标阻断，不因“没日志”推导质量根未被打开。

质量根canary只放临时质量夹具，模型输入投影中绝不包含其答案/Oracle。产品可见夹具只提供原票/已有解析/元数据/白名单描述符，故障调度由测试composition注入；不把Case成功条件传入Application。未知链接种类可安全拒绝，不允许“测试跳过”变PASS。

### 3.2 共享方法、参数和测试调用约定

真实方法将由产品工作包W01～W06创建，参数以产品方案§3～§6为唯一产品接口定义：

```ts
// 以下为拟新增产品F驱动调用示意；不是现有可运行代码
const started = await createProduct({instanceRoot, configPath, mode:'open'});
const req = {requestId, workspaceId:started.workspaceId};
const published = await started.application.publishDataset(req, {
  sourceKey:'voxel51', manifestSha256, selection, purpose:'development'
});
const captured = await started.application.captureInput(
  {requestId:captureRequestId, workspaceId:started.workspaceId},
  {document:published.documentRefs[0], manifest:published.manifest, purpose:'development'}
);
const closed = await started.close();
// 下一次readCapturedInput必须在新的OS进程调用，不复用started。
```

所有Case固定同一组真实source/config/code/lock/mapper/migration/Oracle版本；反例修改生成独立fixture版本，记录差异而不篡改期望hash。Request不接受actorId，未知主体测试通过受控平台身份测试适配或真实不同OS账户触发，再经同一可信身份校验；不能向公开CLI塞一个根本不存在的参数后把解析错误当鉴权通过。

每组适用变体展开为`P0-Fxx/<variant>/v1`；记录 `required=true`、C/S分类和正常对照ref。下面初态“S0”为新受控测试实例active，无Document；“S1”为S0通过真实publish产生一个available版本及captured projection。除明确变体外，purpose=development、sourceKey=voxel51、正常actor=实例绑定主体、requestId=新UUID、expectedRevision从真实查询读取。测试数据不带模型/会话身份。

### 3.3 故障注入端口（仅测试组装，已实现部分）

```ts
type FaultPoint = 'after-stage-write'|'before-content-finalize'|
  'before-publication-commit'|'after-publication-commit-before-response'|
  'before-audit-insert'|'during-migration'|'before-log-append'|'during-close';
interface TestFaultPlan { point:FaultPoint; occurrence:number;
  effect:'throw'|'exit-process'|'deny-write'; }
interface FaultObservation { point:FaultPoint; occurrence:number;
  triggeredAt:string; processInstanceId:string; requestId?:string; }
```

当前 `apps/composition.ts` 已提供仅测试调用的 `ProductTestHooks`：文件 `after-stage-write`/`before-content-finalize`、数据库 `before-commit`/`before-audit-insert`、Application `before-response`；实现位于 `packages/core/src/storage/file-store.ts`、`packages/core/src/storage/database.ts` 和 `packages/core/src/application.ts`。`scripts/p0-fault-probe.ts` 在独立临时一票副本上真实触发 F12～F14，验证旧版本可读、事务无半提交、回执可恢复。接口不进入公开CLI配置或生产组装，不替换Kernel业务决策。尚未实现的 `exit-process`、`during-migration`、`before-log-append`、`during-close` 仍按 NOT_RUN/后续平台验证记录；注入器自身没触发是ERROR，不是产品通过。

## 4. 必要Case与Oracle

每组都有正常对照，Oracle来自主/评测方案的固定规则及独立清单/故障夹具。除特别说明，清理规则为：先close所有真实进程/句柄、保存证据摘要，再删除本Case临时根；删除前验证绝对路径在专用临时父目录内。实际数据和历史报告永不作为清理目标。缺少规定证据按§5处理，不能用期望值补齐。

### 4.1 来源、发布和重启

| ID / 目标与依据 | 初态、输入、入口和步骤 | Oracle、预期事实与禁止副作用 | 证据/对照/清理 |
|---|---|---|---|
| P0-F01 全量来源完整性；主§17/§21.1 | 固定当前完整来源清单；先独立质量核验，再`inspectSource(req,{sourceKey,manifestSha256,purpose:'development'})`逐份检查原票、metadata、解析、图片、配对及别名 | 分母=冻结清单全部保留样本与其文件闭包；每个大小/hash/可解码/Schema/配对通过，所有排除与数量差异说明；不得只验000001，也不将历史2902写为永恒产品约束 | E1/E3；正常集合与缺一文件的临时副本对照。原集合只读不清理；本次只完成摘要子检查，其他NOT_RUN |
| P0-F02 准备/标签/质量隔离；V17 2.1/2.6 | 从S0注册获准来源；外部读取来源/标签各自manifest；调用inspect/read，观测访问根与投影字段 | 来源标签1414与Gold100各自计数，不能混称；产品只读白名单，整个agent-eval根禁止；3,014 aliases明确自身/重复数。Gold人工复核0不妨碍文件F，但不能报字段真值通过 | E1/E3/E7；正常来源对照标签/Case/评分根；临时标签canary清理，原资产不动 |
| P0-F03 正常发布；主§17.3/§18 | S0，结构已确认的单票及多页夹具，`publishDataset`传固定hash、选择及用途；再readDocument | 文件全部存在/hash一致才有已提交dataset.publish审计和manifest引用；Document available、Artifact同空间；返回真实引用。来源manifest存在本身不算发布 | E2/E4/E5；F12/F13为反例；正常两页夹具必须经相同adapter映射，不能模拟API返回 |
| P0-F04 保存与重启重读；主§21.1 | S1，至少真实000001（重验后）；readDocument→captureInput→close；新进程mode=open后readCapturedInput | 原票/parse/投影hash、页与图片引用相同；instance/workspace/owner稳定，process不同；断开旧外部路径仍成功；无Job/Run/Session伪记录 | E2/E4/E5/E7；重启后缺文件/withdrawn分别对照F05/F22；保存两进程exit及关闭证据 |

### 4.2 缺失、损坏、版本与提交故障

| ID / 目标与依据 | 初态、输入、入口和故障 | Oracle、预期返回/状态/事实 | 证据/正常对照/清理 |
|---|---|---|---|
| P0-F05 缺文件/页；主§17 | S0临时来源分别缺原票、content.json、第二页、被引用图片；inspect/publish；S1副本删除必需Artifact再read | FILE_MISSING/INPUT_INCOMPLETE；不发布新available集合；已发布读不得返回残缺内容，可受控转unavailable并审计。原票单独存在不算合格解析 | E3/E4/E5；每个反例配文件齐全对照；只操作临时副本 |
| P0-F06 图片/JSON损坏；主§3/§17 | 副本中构造可读字节但无法完整图片解码，或JSON截断；为结构损坏变体重算fixture描述符以隔离摘要检查 | IMAGE_UNREADABLE/PARSE_SCHEMA_INVALID，未发布；不能仅看扩展名/metadata就通过，也不能把解码错误归成OCR字段错 | E3/E4；正常同格式图片/JSON对照；单独不重算hash变体归F09 |
| P0-F07 空内容/Schema；主§17输入要求 | content.json空数组、markdown空白、pages空、未知block、页号非法；分别inspect/publish | PARSE_SCHEMA_INVALID/INPUT_INCOMPLETE；不标available；正常业务数值0不被判空。未知字段按白名单/严格Schema明确拒绝或记录排除，不静默保留答案 | E3/E4；已确认正常Schema对照；Oracle说明哪种空是无有效解析 |
| P0-F08 原票解析错配；主§17来源配对 | 两份正常票交换解析，描述符各自字节可验证但sourceRecordId/page指针/配对来源不一致；publish | 不因hash各自正确而接受错配；拒INPUT_PAIR_MISMATCH（拟新增细分码，归data/source）；保持原发布不变。若来源本身无法提供更强配对证明，记UNJUDGEABLE/阻断，不声称检测所有语义错票 | E1/E3/E4；未交换对照；独立Oracle保留交换前固定对应关系 |
| P0-F09 摘要不符；主§17/§18 | 修改原票/解析/metadata/引用图任一种字节而保留声明hash；inspect/publish；S1固定Artifact被改后read | FILE_DIGEST_MISMATCH；无新发布，禁止返回改后字节；保存同位置不同内容报VERSION_CONFLICT，不能覆盖；原票hash成功不代替其他文件hash | E3/E4；原字节对照；每文件角色分别展开 |
| P0-F10 同票不同解析；V17 2.3 | 同一originalSha，两份parseHash和parser/依赖版本；无selection、含错误selection、明确有效selection各调用publish；另只改sourceRevision | 前两者PARSE_SELECTION_REQUIRED/VERSION_CONFLICT；正确选择保留两版本及选用依据，不按mtime/目录/Gold取胜；解析摘要或来源版本变化产生新Document版本，旧manifest不变 | E1/E3/E4；同票同解析同来源版本对照F11；选择理由独立来源证据而非答案正确率 |
| P0-F11 重复/冲突；主§17/§18 | S1；同requestId同参数重发；新requestId相同内容；同requestId不同参数；同不可变路径不同字节 | 原请求返回同receipt；新请求可多一个审计但不多Document/Artifact版本；不同参数IDEMPOTENCY_CONFLICT；不可变冲突不覆盖；withdrawn下重导不复活 | E2/E4精确行数/引用差分；正常首次导入作对照；不要把审计行增长误判重复业务效果 |
| P0-F12 文件保存中断；主§17发布协议 | S1旧有效版；发布新版本，在after-stage-write/before-content-finalize抛错、拒写或退出进程，再open/read | 新manifest/部分文件即使在盘上也不可由产品读到；旧版可读；重试重验文件，孤立文件不自动作为发布。未完成文件不注册为可用引用 | E2/E4/E5，故障必须实际触发；无故障同版发布对照；孤立文件数量记证据，清理只临时根 |
| P0-F13 DB/audit提交失败；V18 2.3 | S1；文件已保存，在before-publication-commit/before-audit-insert失败；检查事务后读并重开 | artifacts/documents/发布audit引用全提交或全回滚；关键audit失败即不能发布；旧版保持有效。不得只检查API抛错而不查DB | E4/E5；正常commit对照；注入迁移错误另归F24，日志写失败另归F27 |
| P0-F14 commit后响应丢失；V03 2.3 | 提交新版本后before-response退出进程；客户端保留requestId，新进程findReceipt，再同请求重发 | 已提交回执可查，返回同manifest/Document，重复有效提交0；无回执且已确认未提交可重做；证据不完整时不猜未执行。readReceipt不绕过当前正文权限 | E2/E4/E5；commit前退出对照F13；不得把进程退出码非0等同业务未提交 |

### 4.3 身份、授权、路径与状态

| ID / 目标与依据 | 初态、输入、真实操作 | Oracle、预期与禁止副作用 | 证据/对照/清理 |
|---|---|---|---|
| P0-F15 稳定/未知主体；主§2.6 | S0 init→close→open，对比身份；另以不匹配OS身份适配或受控另一账户open/read/publish | instance/workspace/owner稳定，process变化；未知主体IDENTITY_UNTRUSTED且正文读取0；不能通过客户端actorId冒充owner；默认owner无后期审批权 | E2/E4/E7；正常绑定主体对照；记录OS身份验证方式，报告不输出原SID |
| P0-F16 未知/错误空间；主§2.6/§18 | S1，以未知workspaceId请求get/read/publish；指向另一测试实例的ref | WORKSPACE_UNKNOWN/OWNERSHIP_MISMATCH或等价无泄漏描述；不自动创建新Workspace，无正文读取、无业务新增 | E2/E4/E7；正确workspace对照；错误描述关联本请求，不泄露目标正文/根 |
| P0-F17 权限/用途/多级归属；评§3.27 | S1，将策略固定为reader，对比reader/maintainer；错配Document/Artifact workspace；读取期间发布收窄策略；未获准purpose | 未授予操作OPERATION_DENIED；归属错误OWNERSHIP_MISMATCH；等待期间授权收回后最终返回前拒绝；无未启用操作隐式owner-all放行 | E2/E4/E7；每个拒绝有同版本正常授权对照，不能全部拒绝刷安全PASS |
| P0-F18 路径越界；主§17隔离 | source manifest/metadata图片引用分别传`../`、绝对盘符、UNC、ADS、反斜杠、大小写前缀陷阱、保留名、尾点/空格 | PATH_FORBIDDEN/QUALITY_ROOT_DENIED；不open目标字节；普通合法相对路径能读；URL不能自动下载 | E3/E7实际访问观测；合法路径正常对照；无权限创建某夹具则该变体NOT_RUN，不标N/A |
| P0-F19 链接/junction；主§17 | 临时来源根、祖先目录、最终文件各建symlink/junction/reparse变体，指向外部或质量canary，再inspect/read | REPARSE_POINT_DENIED，根内链接亦按P0禁止策略拒绝；不可只验最后文件或realpath字符串。平台无法可靠识别则阻断读取能力 | E3/E7；普通目录/文件对照；清理先确认链接本身，不能递归删除链接目标 |
| P0-F20 标签/Gold/Case/评分暴露；V17 2.1/2.6 | 固定批准来源摘要；metadata/JSON增加质量路径、Gold专用键、旧导航引用或sourceUrl指令；原markdown被篡改但不更新批准摘要；质量临时根放canary；调用inspect/read/capture | 未批准字节变更摘要拒绝；额外字段Schema拒绝或白名单排除，质量路径不打开，整个agent-eval不能注册为source。普通票面中出现“忽略规则”仅作不可信文字，不执行动作 | E1/E3/E7；正常票面文字对照；不声称能按语义识别任意已被错误批准的正文中的Gold答案，无模型不报Prompt注入A成绩 |
| P0-F21 Workspace状态；主§2.6/§21.15.1 | 用真实Application从S0建立每个状态；分别执行允许边及非法/self/旧revision/乱序/无权变体；暂停期间新read/publish/capture | 四条管理合法边active→paused→archived→paused→active成立（初始化另计）；archived→active拒绝；paused阻新业务，维护核验/撤回与回执查询按契约允许。拒绝无状态/audit成功回执变化 | E2/E4/E5；详见下方展开；依赖未来Run/Action的归档条件N/A，不能用空假对象作证 |
| P0-F22 Document状态/撤回；主§17/§21.15.1 | registerSourceDocument形成真实pending；publishDataset完成pending→available，setDocumentStatus处理核验失败/撤回/受控重验；对旧manifest/投影/alias、新request、同票新解析、旧revision、自循环及乱序重试读取 | 7条合法边全验；withdrawn没有出边；同scope所有别名/解析版本当前读取拒绝；unavailable恢复只能同hash完整字节重验；Document.version不变，stateRevision递增，旧请求不能ABA覆盖。parseHash=null的仅原票登记不能变available，须新解析版本 | E2/E4/E5/E7；未撤回正常对照；恢复字节仅在闭库临时实例维护，禁止改DB造结果；撤回≠物理删除，误放行才失败 |

状态展开固定规则：Workspace合法管理边4条；Document合法边7条（pending→available/unavailable/withdrawn、available→unavailable/withdrawn、unavailable→available/withdrawn）。每条各建合法正例、无权限、旧revision、同request重复、旧请求乱序五类；仅因某前置不适用而省去变体时执行前逐条写理由。另遍历状态笛卡尔积中的非法边：Workspace三态9组合扣4合法=5组合（含self），Document四态16组合扣7合法=9组合（含self）。self仅相同request回执幂等，不是新的状态转换。

因此预期至少有11条合法边正例和14条非法边组，不能用一个“状态测试通过”覆盖所有边。初始化、暂停并发提交/撤回、归属、旧内容version拒绝是额外检查。最终分母以展开后的唯一checkId列表冻结，不能简单写32或31。

### 4.4 配置、迁移、日志、组装和证据设施

| ID / 目标与依据 | 初态、输入、入口和故障 | Oracle、预期与禁止副作用 | 证据/对照/清理 |
|---|---|---|---|
| P0-F23 配置/依赖锁；主§19/§20/§24 | createProduct使用固定code/lock/config/Schema；改变其中一个hash、启用未知模型字段、改环境/dataRoot、发布新策略后持旧缓存请求 | CONFIG_LOCK_MISMATCH或配置Schema拒绝；不得静默变环境/执行组合、读取秘密或启动Pi。授权策略更新须CAS+审计；旧权限不生效 | E1/E2/E4/E7；匹配锁正常启动对照；新独立环境应创建新实例 |
| P0-F24 迁移；主§18 | 新库applyMigrations0001→close/open；同版本重跑、checksum漂移、库版本超前、during-migration故障 | 初次只有五表和真实初始化；重开无重复迁移/身份；失败事务回滚且Application不ready，旧库不删除重建；关闭释放连接 | E2/E4/E5/E7；正常迁移对照；测试临时库，不迁移现有未知历史实例 |
| P0-F25 日志结构/脱敏；主§18.5 | 正常publish/read与拒绝日志；输入秘密canary、原始异常、嵌套对象、超长UTF-8、多字节边界，调用LoggerPort.write | 必填时间/level/component/code及真实身份；只允许白名单attrs，行≤16KiB；正文/Gold/token/原始堆栈出现0；不得用虚假runId填日志字段 | E6与E2；正常可定位日志作对照；canary只测试数据，报告不传播秘密 |
| P0-F26 容量/重启；主§18.5/评§3.6.1 | 小测试配置与正式配置各一组；填满分段/实例配额/queue，close后新process再写；用正常写入生成分段，不伪造业务结果 | 每文件≤配置maxFileBytes、所有同实例分段合计≤maxTotalBytes；重启不刷新总配额；队列有界、dropped计数/健康告警可见。7天保留目标不冒充自动清理已实现 | E6/E2/E7；未满正常对照；测试配额版本单独记录，不拿小限额结果直接证明正式吞吐 |
| P0-F27 日志失败与审计失败；V03 2.5 | S1；before-log-append拒写、queue满、flush超时；另在业务事务before-audit-insert失败 | 前者已提交业务事实仍成功、health.degraded及限频stderr可见；后者事务失败/新版本不可读。关闭日志超时报告incomplete，不吞掉主异常 | E4/E5/E6；正常日志/审计分别对照；已确认产品漏必要审计判FAIL，采集器坏是ERROR |
| P0-F28 导入/依赖方向；主§20.3.2 | 独立子进程仅import composition/public contracts；对比前后目录、进程、端口、DB/log文件；静态依赖核对 | 导入不init、不建库/日志/锁端点、不启动Pi/Electron；core不导入data私有实现，产品不导入agent-eval；只有createProduct显式打开资源 | E2/E7；随后显式createProduct应出现预期资源，否则全不启动不能算正例成功 |
| P0-F29 原实例恢复/独立副本；主§18/评§3.23 | S1先close，保存DB+所有必要Artifact+身份/配置的完整集合；原实例恢复演练后重读；缺文件/hash错/更旧撤回事实的副本；独立副本走新init | 完整原实例保持身份和引用；不完整/无法证明撤回连续性的旧备份安全拒绝可读恢复；独立测试实例新身份，不能当原实例续跑。P0不要求在线Host备份平台 | E1/E2/E4/E5；完整恢复与拒绝变体分别判定，不用安全拒绝替代所有正常恢复 |
| P0-F30 无桌面CLI/输入容量/控制者；主§20/§21.1 | 无Electron/Pi安装环境实际CLI init/inspect/publish/read；同时第二CLI同实例；输入文件/样本/页/数量/像素限额各在上限−1/上限/上限+1 | 当期命令可执行；第二控制者CONTROLLER_BUSY，不能同时写；边界合法成功，超限INPUT_LIMIT_EXCEEDED（拟新增）拒绝且不落半完整版本；关闭后允许另一控制者 | E2/E3/E4/E7；限额单位与产品§2.2一致，禁止超限静默截断；记录Windows资源失败归属 |
| P0-F31 显式关闭/部分启动；主§3/§20 | createProduct各资源取得后依次故障；运行中close、重复close、close后调用；during-close故障；然后独立进程重开DB/改名测试目录 | 无活跃句柄/控制者残留才closed=true；失败保留primaryError/cleanupErrors，拒新工作；重复close无副作用；不得只检查close函数被调用 | E2/E5/E7；正常关闭对照；真实无法释放则保留临时目录和缺陷证据，不强删伪装清理成功 |
| P0-F32 证据/汇总设施；评§7.6～7.7/§12 | 独立固定正例/反例/空集/缺文件/hash错/版本错/设施坏/FAIL混NOT_RUN/不适用集合；调用拟新增review_p0_report或人工同协议核验 | 仅完整匹配且Oracle满足可PASS；缺证据UNJUDGEABLE，未执行NOT_RUN，设施坏ERROR；已确认FAIL不可被缺项/高分覆盖；N/A独立。不能以设施通过记产品通过 | E8及所有fixture hashes；正反/边界/缺证据各有独立预期，禁止复核器自己生成预期再唯一评分 |

P0-F08与F30的新细分码由产品W03/W04在统一ErrorDescriptor实现时纳入，代码名称与含义同步于产品方案错误表；它们是本次拟新增契约，不是现有异常。

## 5. 判定、统计、样本和执行窗口

### 5.1 状态契约与汇总

严格沿用总方案§7.6/§7.7：

| 展示项 | 含义 | 汇总处理 |
|---|---|---|
| PASS | 适用且所需证据充分，满足事先规则 | 进入可判定分母与通过分子；人工确认后才计confirmed |
| FAIL | 证据确认违反必要条件/硬约束 | 阻断Case/阶段通过；其他项未跑仍保留FAIL和缺口 |
| UNJUDGEABLE | 已尝试判定，但证据不足、冲突或Oracle缺依据 | 仍留计划适用分母；不进入PASS+FAIL分母 |
| ERROR | 非故意场景内的驱动/采集/判定设施故障，使测量无效 | 设施归因，不直接判产品FAIL；保留在计划适用分母 |
| NOT_RUN | 未执行，或前置阻断 | 记录依赖、责任人与解除条件；不能当N/A |
| BLOCKED | 准备/执行资格的展示状态，字段`executionEligibility='blocked'` | **不是新增verdict枚举**；尚未执行的检查status=NOT_RUN并列blockers |
| N/A | 不适用展示，`applicable=false`及理由 | 不填PASS；不进入适用分母，单列清单和依据 |

故意注入DB失败、非法路径、日志拒写属于产品场景：产品按契约拒绝/降级可以PASS，不是ERROR。证据采集坏了才ERROR。没有日志不能证明“没有越权”；若证实产品违反必须保存的审计要求，可将审计检查判FAIL，行为本身仍可UNJUDGEABLE，分别保留。

Case汇总：有必要FAIL则FAIL；否则有ERROR则ERROR并保留全部缺项；否则有UNJUDGEABLE则UNJUDGEABLE；否则有NOT_RUN则NOT_RUN；全部适用必要项PASS且所需人工复核完成才PASS。没有适用必要项则只显示N/A，不生成虚假PASS。这个优先级是P0对总方案的明确实例化，原始检查状态不被压缩丢失。

旧`aggregate_checks`兼容规则：INFRA_ERROR映射ERROR；NOT_APPLICABLE转换为独立适用性标记并要求理由；缺理由UNJUDGEABLE；不得把legacy aggregate verdict直接复制到新报告。当前不修改该实现。P0新增轻量复核器如确有需要，仅负责报告版本/证据检查与上述确定性汇总，不建立完整Grader平台。

### 5.2 指标公式与门槛

定义单位必须先冻结：资产条件用“资产/检查条件”，API行为用“case变体/check”，状态覆盖用“对象+转换边+条件分支”。一个Case多个检查或重复执行不是多个独立原票。

| 指标 | P0实例化的分子/分母 | 规则 |
|---|---|---|
| ALL.prepared | 输入/Oracle/证据要求齐备且已核验的条款变体数 / 冻结计划适用条款变体数 | 只计准备，不计运行；一个变体全部准备条件齐备才入分子，不按文件数代替 |
| ALL.executed | 实际触发执行单元数 / 计划适用执行单元数 | 需要真实E2/E5；materialized不计执行 |
| ALL.judgeable | (PASS+FAIL) / 计划适用单元数 | 缺证据/ERROR/NOT_RUN不从分母删掉 |
| ALL.pass | PASS / (PASS+FAIL) | 同时展示confirmed/judgeable，不能用小分母100%掩盖未跑 |
| ALL.confirmed | 人工确认PASS单元数 / 计划适用单元数 | P0必要检查需100%确认，缺口不能通过 |
| ALL.edges | 已覆盖对象/允许边/必要分支数 / 冻结适用边分支数 | §4.3展开；合法全覆盖，并单列非法有效转换0 |
| ALL.state | 正确状态操作数 / 必要状态操作数 | 包括正确接受、正确拒绝、幂等及乱序；版本/归属一起检查 |
| ALL.link（仅P0基础子链） | 身份/版本/先后/权威全部成立的输入发布交接数 / 应验证的基础输入发布交接数 | F03/F04/F12～F14双端证据；总指标P1起完整启用，本期不扩展到Runtime/工具链 |
| ALL.recovery-contract | 正确恢复或契约规定安全拒绝数 / 适用恢复演练数 | F14/F29；必须含成功恢复正例，不能全拒绝代替 |
| MOD-07.foundation | 满足模块/组装/入口职责的检查数 / 适用职责检查数 | C，必需检查100%；包括当前配置与身份 |
| MOD-09.input | 配对/Schema/摘要/来源版本/发布原子性及幂等全部正确的导入数 / 应验证导入数 | 与总方案相同导入单位；内部check逐项门禁，不能把一导入的多个成功check刷成多个导入；全量来源盘点子检查另报 |
| MOD-09.availability | 正确当前资格/状态判定次数 / 适用读取/状态机会数 | 100%，撤回/越权读取0 |
| MOD-25.atomic | 正确提交/回滚/幂等/归属/不可变操作数 / 适用存储操作数 | 100%，半发布和重复有效业务效果0 |
| MOD-26.audit | 具备完整审计的必需关键变化数 / 预期关键变化数 | 100%，缺失0；命令回执与业务事实一致 |
| MOD-26.logs | 符合结构/脱敏/有界/故障降级的场景数 / 适用日志场景数 | 100%，敏感泄漏0；容量使用字节实数，不取平均掩盖超限 |
| MOD-29.backup | 正确完整恢复或契约安全拒绝演练数 / 适用当期演练数 | 100%；不涉及未实现Session/Host |
| MOD-29.retention | 正确用途/引用/撤回/保留处理次数 / 适用治理机会数 | 100%；无物理删除功能不伪造删除成功 |
| MOD-30.assets | 来源/版本/用途/Oracle/直接条款/审核状态一致的资产数 / 冻结应审核资产数 | 未审核资产保留分母；设施/资产口径，与产品F分栏；不要求所有高阶段Gold在P0完成 |
| MOD-30.isolation | 正确同票分组、分割/曝光与投影隔离检查数 / 冻结适用检查数 | S，泄漏0；已有未冻结高阶段分割单列阻断 |

所有比率同时输出分子/分母和范围；分母0标不可计算，不填0%或100%。必要C/S全通过、取证完整是阶段门禁；单份正常探针与全量资产核验不能加权抵消。P0不报告ALL.recovery-outcome的Agent/业务效果，不报告模型成本或业务质量Q。

### 5.3 样本、重复与观察窗口

全量来源层：冻结时清单中的全部保留样本及其文件闭包；当前背景2,902份/19,376文件，不把数字作为永久过滤条件。数量变化须列新增/排除/别名/解析版本差异及理由并重冻结。标签/质量资产按各自清单独立验证，不能产品全量扫描质量根。

真实产品正常探针：至少1份真实来源样本，优先000001；页数/引用特性由实际盘点确认。再使用可追溯的最小多页/多解析/状态故障夹具覆盖机制边界。若真实集合存在多页样本，固定一个真实多页样本用于正常对照；否则使用明确标注的合成多页夹具，不谎称真实来源覆盖。Gold内容不参与选样。

必要故障每个预定注入点/变体至少1次真实触发，并有1个无故障正常对照；涉及并发的“授权收回前/后、提交前/后、暂停前/后”分别固定调度。重启使用不同OS进程至少两次启动；重复幂等至少首次+同request重试+新request同内容三次操作，均为同一Case相关观测，不当独立统计样本。

窗口从Case准备快照冻结、产品进程启动前开始，到产品close/新进程重开检查和证据落盘完成结束。故障窗口涵盖实际注入前后；记录UTC时间及同一进程内单调时钟duration，不跨进程直接相减单调时钟。ALL.latency记录真实起止耗时，到截止尚未结束的操作保留右删失标记及当前年龄，不按0处理。已有F复用必须对应这一观察范围；“昨天相同名称的Case”不自动等于同版本证据。

性能作为O观察：记录inspect总耗时、单票read/capture/reopen耗时、峰值RSS、文件/日志量、失败和超时；本期不凭空设置“读取<100ms”门禁。W01/W03先导选小/中/最大样本，每种冷启动与热读取各5次，报告中位数/最大值、机器配置及范围，不把小样本p95当稳定尾延迟。若产品负责人确认性能是当前必要条件，由P/Q在正式批次前共同冻结阈值、分母、冷/热条件和重试规则；未冻结则显示观察项阈值未定，不生成性能PASS，也不能放宽既有正确性/容量上限。

容量边界是已定义的确定性C/S契约，不等待性能基线；限额推荐值见产品§2.2。先导发现当前合法样本超限时先修改并冻结配置，不能正式运行后悄悄上调。

## 6. 轻量证据复核与报告契约

### 6.1 优先复用产品F，避免重复检查

复用前Q逐项核对：实际产品源码提交/dirty diff、依赖锁、配置/策略、Schema/mapper/迁移、输入集合/样本版本、OS/runtime和根控制、Case/Oracle版本、故障实际触发、观察窗口、原始证据摘要、必要检查与范围。任一关键绑定不一致，不能直接复用PASS；可复用未受影响的原始证据，但须重新说明范围并补跑受影响检查。

产品F报告负责记录实际行为与持久事实，Q通过独立原始文件/只读DB/外部进程记录复核Oracle。测试断言通过不是全部来源证明；报告中每个check必须引用E1～E8之一的具体固定文件和范围。不能将读者提供的任意JSON视为可信产品观测，不能只靠生成报告的同一个函数自证其真实性。

W06 已提供下列轻量复核器：

```python
# agent-eval/tools/review_p0_report.py，仅离线只读复核
def review_p0_report(report_path: Path, evidence_root: Path,
                     expected_binding: dict, frozen_checks: list[dict]) -> dict:
    """核验固定版本/证据路径/摘要/适用性与确定性汇总；不驱动产品、不读Gold判业务。"""
```

`report_path`/`evidence_root`必须存在、在声明质量取证根内且逐级拒绝链接；`expected_binding`是Q事前冻结记录，不能由待验证报告自己提供；`frozen_checks`来自Q固定Oracle台账，包含checkId、required、applicable、rule、evidenceTypes、normalControlRefs。无隐式默认，不联网、不发布、不自动修复、不写产品库。复核器会重算报告列出的每个证据文件摘要和长度，检查路径、绑定、Case集合、状态和冻结断言，返回复核结论和缺口；最终报告保存由显式外层命令负责。

复核器的目标自检集合仍包含：完整正例PASS；真实违反Oracle的反例FAIL；空必要集不产生PASS；缺单个证据UNJUDGEABLE；文件hash错/绑定错不通过；采集故障ERROR；FAIL+NOT_RUN仍FAIL并保留缺口；仅不适用集合N/A；旧INFRA_ERROR转换；NOT_APPLICABLE缺理由不通过；路径链接拒绝；分母0不可计算。当前 `agent-eval/tests/test_review_p0_report.py` 已覆盖完整正例、摘要篡改、断言不成立和越界路径；复核器已对本次 7 个产品 check 运行并返回结构性 PASS。尚未覆盖的设施自检变体仍不能宣称已通过。该结果只证明报告/证据的一致性，不能替代质量负责人对来源用途、业务语义和冻结 Oracle 的独立签核。

### 6.2 共享证据类型（拟新增）

```ts
type CheckStatus = 'PASS'|'FAIL'|'UNJUDGEABLE'|'ERROR'|'NOT_RUN';
interface EvidenceFile { path:string; sha256:string; bytes:number;
  kind:'binding'|'process'|'input-check'|'facts'|'fault'|'logs'|'access'|'review'; }
interface CheckObservation { checkId:string; caseVariantId:string;
  capabilityIds:readonly string[]; metricIds:readonly string[];
  required:boolean; applicable:boolean; applicabilityReason?:string;
  status?:CheckStatus; reason:string; evidencePaths:readonly string[];
  reviewedBy?:string; reviewedAt?:string; }
interface P0FBody {
  schemaVersion:'p0-f-evidence/v1'; executionId:string; phase:'P0';
  evidenceKind:'F';
  executionEligibility:'ready'|'blocked'; blockers:readonly string[];
  window:{startedAt:string; endedAt:string};
  files:readonly EvidenceFile[]; checks:readonly CheckObservation[];
  counts:{unit:'check'; plannedApplicable:number; executed:number; judgeable:number;
    pass:number; fail:number; unjudgeable:number; error:number; notRun:number;
    notApplicable:number; confirmedPass:number};
  caseCounts:{planned:number; applicable:number; executed:number; confirmedPass:number};
}
interface ProductBinding {codeCommit:string; dirtyDiffSha256:string|null; lockSha256:string;
    configSha256:string; policySha256:string; inputManifestSha256:string;
    productSpecSha256:string; evalSpecSha256:string; caseSetSha256:string;
    oracleSha256:string; mapperVersion:string; migrationChecksums:readonly string[];
    os:string; architecture:string; bunVersion:string; nodeVersion:string;
    pythonVersion?:string; instanceId:string; workspaceId:string;
    processInstanceIds:readonly string[]; purpose:'development'|'regression'};
interface PreparationBinding {codeCommit:string; dirtyDiffSha256:string|null;
  toolVersionHash:string; assetManifestSha256:string; caseSetSha256:string;
  oracleSha256:string; productSpecSha256:string; evalSpecSha256:string;
  os:string; pythonVersion:string; scopeDescription:string; }
type P0FReport = P0FBody & (
  {scope:'product'; binding:ProductBinding} |
  {scope:'asset'|'facility'; binding:PreparationBinding}
);
```

status只在applicable=true时填；N/A行不冒充NOT_RUN。asset/facility报告没有真实产品instance时省略，不填placeholder UUID。尚无产品锁/实例的当前调查不能伪装成上述正式F报告：先保存人工核查台账，正式绑定字段具备后才生成实际报告。对于独立资产报告使用相应资产检查工具锁/版本记录，不能填不存在的产品bun.lock；正式产品报告的必需绑定均不得省略。

`executionId`是测试记录标识，绝不是AgentRun。E4只读事实快照脱敏、最小字段，不带秘密；完整票据字节在受控Artifact按授权读取，报告只存摘要/引用。需要记录实际actor时使用产品actorId，不复制OS SID。证据文件相对路径不得越过evidence_root；文件hash只能证明固定内容，不单独证明采集来源可信。

报告模板（**仅字段与填写说明，不是本次通过结果**）：

| 字段 | 待实际执行后填写的内容 |
|---|---|
| scope / phase / executionId | product-F、asset核验或facility自检之一；P0；真实测试编号 |
| 代码/配置/输入/环境绑定 | 当次hash、版本与范围，缺失列阻断，不填假值 |
| 计划/适用/执行/可判定/确认通过数 | 按冻结唯一单元统计，附分子/分母和N/A清单 |
| 每项结论 | checkId、Case变体、Oracle、状态、原始证据refs、具体原因、人工复核 |
| 阶段结论 | 全量资产、真实探针、必需失败/状态/隔离、证据设施分别给结论 |
| 不能宣称的内容 | A/B N/A、未覆盖条件、数据用途限制、平台或来源缺口 |
| P1交接 | 固定引用、真实F证据、缺陷/历史失败与回归种子 |

## 7. 执行顺序、当前可执行项和退出交接

### 7.1 固定执行顺序

`现状及资产核查 → 适用设施自检 → 产品F → 证据复核 → 阶段结论与P1交接`

| 步骤 | 现在/实施后 | 输入、交付与完成条件 |
|---|---|---|
| Q01现状与资产核查 | 现在可做；本次已完成产品侧结构核查 | 重查Git/来源/质量版本和命令副作用；来源描述符、产品inspect、独立来源闭包审计、发布后全量重读和图片证据读取已通过；业务语义/用途资格仍独立记录 |
| Q02冻结当期Case/Oracle及设施自检 | P0只冻结产品F检查项和设施自检；Agent任务Case/Oracle暂不创建 | 明确F01～F32的适用变体、版本、正常对照、统计单位、证据来源；不把现有全量Agent数据集当P0输入，也不预建高阶段Agent评测平台 |
| Q03产品F | 正常链路和F12～F14已执行，完整报告待Q04 | 真实CLI/Application驱动；已完成全量inspect、来源结构闭包审计、2,902份发布/重读、4,755份唯一图片证据读取、一份跨进程投影重读和文件/DB提交/审计/响应丢失探针；权限、迁移、日志、链接全变体仍按冻结Case复核 |
| Q04证据复核 | 产品F结构性复核已可执行；Agent资产复核延后 | `review_p0_report.py` 已按§6重算本次 7 个产品 check 的证据摘要、路径、绑定和固定断言并返回 PASS；来源闭包审计明确 `semanticPairing=NOT_ESTABLISHED`，这是没有业务语义Oracle的边界，不伪造为Agent成绩。用途依据仍需在真实来源正式使用前单独确认；Agent Case/Oracle责任人复核在Agent实现完成后随阶段数据文件执行 |
| Q05阶段结论与P1交接 | 产品F可独立交接；Agent A/B延后 | 必需C/S全通过后交接产品契约、F证据、缺陷和回归种子；A/B不生成成绩、不创建当前Agent数据文件，待Agent实现完成后再按阶段新建独立文件 |

### 7.2 现在可执行的命令及本次结果

以下均从仓库根运行；本次先阅读实现确认verify路径不发布/修复。测试仅在其临时夹具中写入，`-B`避免生成pyc，pytest禁缓存写入。

```powershell
python -B agent-eval/tools/initial_dataset.py verify --project .
python -B agent-eval/tools/coverage_update.py verify --project .
python -B -c "import sys,json; from pathlib import Path; sys.path.insert(0,'agent-eval/tools'); from initial_dataset import verify_sources; print(json.dumps(verify_sources(Path('.')),indent=2))"
python -B -m pytest agent-eval/tests/test_initial_dataset.py::InitialContractTests -q -p no:cacheprovider
```

本次前两条退出1（Benchmark definition pin drift）；第三条退出0，2902/1414/19376；第四条11 passed。产品侧另完成全量inspect、2,902份临时实例发布/重读和一份跨进程投影重读；未执行质量资产prepare/rebuild/recover/auto-fix。历史cleanup报告与实际残留状态有差异，见产品§1.2；本任务不清理数据。

当前11份有效Benchmark为BM-01～05、BM-07～12；BM-06不在当前有效集合。示例BM-01固定定义hash=`881eacc4cb121372bb5a9f411d818a079a247ed82730cb538d898df1474b57b2`，当前文件hash=`a1ae3c7bf5b0f3cf0e8a89e5f6307d3e29e41841c25dbcee906a5b3cd2ca744d`。不能重新签摘要就认定语义一致，需要质量负责人追溯差异、评审、版本化发布并完整核验。本文记录问题，不改变既有清单。

当前工作树已经提供产品侧`bun run typecheck`、`bun run test:p0`、`bun run p0 -- init/inspect/register-document/publish/capture/read-captured/...`、只读来源闭包审计`bun run p0:source-audit -- --output <证据根>/source-closure-audit.json`、故障探针`bun run p0:fault-probe -- --output-root <证据根>`和只读验证器`bun run p0:verify -- --instance-root <根> --publication-ref <publish输出> --source-manifest-sha256 <hash> --output-root <证据根>`；验证器会真实驱动Application并把来源闭包审计、`fault-summary.json`、可选的Vitest结果和Benchmark摘要漂移清单绑定进`p0-f-evidence/v1`。这些是产品 F 与来源结构证据，不消费现有完整 Agent 数据集，也不能替代未来阶段文件中的Case/Oracle复核。当前产品证据已保存于`agent-eval/reports/p0/20260920-full-product/`，报告的7个产品check均PASS；来源审计仍明确`semanticPairing=NOT_ESTABLISHED`，用途确认和质量pin作为正式质量资产限制保留。具体产品参数以配套方案§7.2为准，不为评测额外发明另一套产品入口。

独立结构复核命令（只读，不执行产品、不发布、不修复）：

```powershell
python -B agent-eval/tools/review_p0_report.py `
  --report agent-eval/reports/p0/20260920-full-product/p0-f-evidence-v1.json `
  --evidence-root agent-eval/reports/p0/20260920-full-product `
  --expected-binding agent-eval/reports/p0/20260920-full-product/review-expected-binding.json `
  --frozen-checks agent-eval/reports/p0/20260920-full-product/review-frozen-checks.json `
  --output agent-eval/reports/p0/20260920-full-product/review-summary.json
```

本次复核结果为结构性 `PASS`，检查9个证据文件和7个产品 check；其中来源闭包审计、Vitest结果与Benchmark摘要漂移清单只是绑定的支持性观察，不增加产品check，也不能把报告的`confirmedPass`直接改成质量签核，更不能解除用途授权或Benchmark pin阻断。

### 7.3 当前阻断及解除条件

| 阻断/缺口 | 影响范围与当前表示 | 责任人与最迟解除时点 |
|---|---|---|
| 完整产品F证据与独立复核未完成 | 产品报告已绑定全量正常链路和F12～F14故障证据；结构复核器已独立重算并返回PASS，但`confirmedPass=0`，表示正式F报告尚无质量责任人签核。它不转化为Agent A/B成绩，也不要求现在复核完整Agent任务集 | W06产品F负责人和Q04质量负责人，补齐P0 F证据签核；Agent Case/Oracle复核随后续阶段数据文件执行 |
| 无可信产品适配器/采集来源 | 现有离线产品grade保持UNJUDGEABLE；不能导出Baseline | P0不强建完整adapter；W06提供可信F驱动/证据+Q人工复核即满足当期路径，P1再接Runner |
| 11份Benchmark定义pin漂移 | 当前完整质量资产发布核验失败；阻止复用这批旧冻结基准结论，但不影响P0产品F证据，也不触碰现有数据集 | 完整Agent后启用综合集前，由质量负责人受控核对旧BM及其固定版本；阶段数据当期独立制作，不依赖这批漂移清单，也不绕过自身校验 |
| 业务语义/用途资格仍未证实 | 产品结构核查和全量发布/重读已通过，但这不能证明OCR字段正确、业务配对正确或来源许可已核验；P0不把它写成Agent成绩 | 真实来源用于正式开发/回归或后续阶段评测前，数据负责人补充独立语义/用途依据；未确认部分继续按UNJUDGEABLE/BLOCKED记录 |
| 数据用途来源声明尚未证实 | 技术核验可记录；正式允许用途、尤其生产/外传不能推导 | 数据负责人W03冻结前确认当期开发/回归用途依据；不因Gold/manifest存在默认授权 |
| 依赖/Windows身份、受控目录、reparse、锁方案未实际验证 | 受影响产品F NOT_RUN；不能预判平台安全通过 | 产品W01负责人，在受控文件接入前解除 |
| 旧评分枚举兼容 | 若直接套旧aggregate会错误归类/汇总 | Q02按§5显式适配并自检；不改历史报告枚举或重写成绩 |
| 性能阈值未冻结 | O观察未判门槛，不是产品正确性失败或性能PASS | 若升级为门禁，P/Q在正式批次前冻结；否则保持观察并交P1 |

质量pin漂移不会阻止编写产品设计或实施独立基础能力；它阻止复用当前全量质量资产作为正式 Agent 基准。P0不构造Agent A/B数据；需要时仅在阶段目录索引已有F检查。各阶段当期新建 `agent-eval/stage-evals/<stage>/`，完成适用Case/Oracle核验、输入用途和版本固定后执行，人工复核依总方案7.5触发，不强制每例独立签名。现有综合集完整Agent后核验启用，不删除或重写旧资产。P0产品退出仍只依据当期产品行为、来源结构和可信F证据；不能把尚未开始的Agent评测写成通过。

### 7.4 阶段退出与P1交接

退出逐项检查：全量保留输入核验完整；真实产品正常发布/保存/新进程重读至少一份；必要缺失/损坏/冲突/提交故障/重试/归属/路径/质量隔离/状态转换/配置锁/迁移/日志/显式关闭全部成立；证据范围与版本一致；必要C/S没有FAIL、ERROR、UNJUDGEABLE或NOT_RUN；P0 F证据完成结构复核并由责任人签核。Agent A/B 是 N/A，不要求通过，也不创建或提供虚假 Agent 数据集和 Baseline；各阶段能力可运行后即使用对应阶段文件夹执行；完整Agent后另外启用综合集。

P1接收：冻结的来源/manifest/解析选择和用途、共享身份/策略/配置锁、产品Application真实公开输入接口、session-store类型契约（未实现说明）、E1～E8及可复现F命令、P0产品F检查项/Oracle和正常对照、已知缺陷和历史失败、版本漂移/缺证据的处理记录。回归种子至少包括000001真实读取、同票双解析、commit后响应丢失、旧清单撤回、质量根路径/链接、配置漂移、日志/审计分别失败、两进程重开与未知主体拒绝。Agent 任务的 Case/Oracle 不从当前 `agent-eval/data/` 继承，进入P1时另建 `agent-eval/stage-evals/P1/`，不等待完整Agent。

P1接模型后新增真实Run/Session/模型请求证据和Agent任务，不沿用P0 executionId当AgentRun，不将P0确定性F成绩累加为Agent成功次数。质量结论与当前环境/范围的运行资格分开；任何P0通过都不构成生产写入授权或业务收益证明。

## 8. 补充意见覆盖与交付自查

所有24章每个必要调整子项的“已吸收/P0具体落实/后续阶段/依赖与交接”详见产品方案§9，作为两文共同台账，不在本文件复制另一份可能漂移的条款。评测侧对其承接如下：

| 补充章 | 本期验证承接 | 后期验证交接 |
|---|---|---|
| 1～2 | F01/F03/F15～F17/F28；产品/Agent/人工边界、输入与身份 | P1原生接入/P2治理/P8业务/P13Host |
| 3～4 | F05～F14/F23/F27/F31；错误/提交/清理/配置 | P1Provider/模型，P3期限预算；不伪造P0模型错误 |
| 5～8 | F04/F14/F27；投影/回执/日志各自权威，P0没有Loop/消息/事件成绩 | P1Loop消息、P2工具、P3事件，P8Workflow |
| 9～11 | F04/F22/F29；固定输入与当前资格、只交会话契约 | P4Session、P5Context、P6Memory、P7Compaction |
| 12～16 | F15～F17/F20；当期无审批/执行权，输入不冒充候选/业务结果 | P8控制/复核、P9资源、P10Extensions、P11Subagents、P12业务动作 |
| 17～18 | F01～F14/F18～F27/F29；全量输入、版本、发布、状态、必要表、日志/恢复 | P13在线备份/物理保留/跨进程运维，不强加P0 |
| 19～20 | F15/F21/F23/F28/F30/F31；组合/资格/当前目录/公共组装 | P1真实RuntimeSnapshot、P9版本管理、P12桌面/P13Release |
| 21～22 | 全部F及§5～§7；Driving Task≠退出、真实证据双向交接 | 高阶段按首次启用继承；PC最终清单不充当P0门槛 |
| 23～24 | F23/F24/F29/F31；依赖核实/迁移/恢复边界与阻断负责人 | P13安装/生产治理/持续运维，依赖在当期启用前核验 |

文档自查：两文能力/接口/状态/参数/工作包一致；已有签名与拟新增接口明确分开；每个必要验收有真实入口、P0 F检查项和可信证据；全量资产与单票探针分别判；设施自检不算产品通过；32用例组不是既有Case执行数；没有修改 `agent-eval/data/`、Gold、清单/历史成绩，没有编造Agent运行、性能实测或面试经历。本轮产品基础代码、F12～F14故障探针、7个产品check和结构性复核器已执行；正式 P0 F 报告仍需产品F证据责任人签核；阶段Case/Oracle及其输入用途在当期核验，现有综合材料的审核与质量pin在完整Agent后启用该集前核验，不把当前参考数据集当作通过依据。
