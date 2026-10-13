# Flowmate 第一阶段剩余任务实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 完成05手册第一阶段剩余工程，交付已审核数据、可用评测设施、工程证据和准确操作手册；完成后停止，等待用户启动第二阶段。

**Architecture:** 复用现有AgentKernel → Runner → 独立Trial → Bun Host及公共产品操作 → 原始采证 → 独立评分 → 本地报告/导出链。保留现有v1兼容、v2审核绑定、固定故障、紧凑Judge和两层聚合，不新建评测服务或Evaluation页面。实际研究、历史、候选、原生工具和Fill接现有产品入口。

**Tech Stack:** TypeScript、Bun、Zod、既有Pi SDK及两份补丁、SQLite单所有者、Linux容器隔离、Electron/Playwright、已配置Python/pypdf；不新增第三方依赖。

**Spec:** `D:\code\Flowmate\docs\eval\05_Flowmate_Agent评测分阶段实施与操作手册_v1.md` §4及附录A；01 §6–12、02数据规则、06制作交付；07/08只作接口与交接要求。当前数据依据`D:\code\Flowmate\docs\eval\records\2026-10-12-dataset-review.md`，历史实施记录按各自时点解释。

## Global Constraints

- 本轮只实施第一阶段：不执行真实Judge校准、业务Smoke/Full、Runtime正式开发或留出，不上传平台。工程测试使用固定脚本Provider、受控Judge/Transport和独立合成材料，不给待测模型暴露正式留出或Gold。
- 数据规模保持业务50/10＋研究12/4＝62/14，研究六类各2；Runtime十二对24条、8开发/16留出。保留已审核86条Case/Gold，不重做材料或以缩减样本结束阶段。
- 原33项＋DR01–06＝39项，身份/单位/公式沿01；业务、Runtime过程、工程、内容审核和真实质量结论分别保存。未实现或缺证据不能写N/A或0。
- 每Trial最多一次独立Judge、最多256输出Token、无自动重试；每Execution事前输出预算上限15,000。实际不足保持ERROR/UNJUDGEABLE，不放宽预算或补一次Judge。普通Full和研究Full分别登记，不能事后拆分规避守卫。
- Host是本Trial产品根唯一SQLite所有者；主进程/Node/评测器只经公共操作查询。Gold、未来输入、控制文件、Judge凭据及用户秘密不可经模型输入、原生文件、Shell、链接或挂载泄露。
- 未确认停止必须阻断后续Trial并保留现场；取消受理不等于停止，清理不能删除已提交事实或不属于本次的实例。
- 第一阶段可以固定数据/判据/代码版本与hash，交付无密钥模板；真实模型配置、真实校准和开发快照及A–D统一实验冻结在第二阶段生成。本轮不预造Execution、Trial、产品ID、计时或快照。
- 工作根`D:\code\Flowmate`；保留当前未提交修改，不reset/clean/自动commit/push，不移动用户材料。默认由同一实施者按依赖顺序完成，不默认启动其他Agent或新聊天。
- Bun命令全部显式`--no-env-file`；测试用`--isolate`，子进程使用测试入口现有环境变量白名单，不能继承真实Provider/Judge/平台密钥。

## 当前基线与完成口径

当前已完成86条内容审核，Case/集合内容版本2；业务、研究、Runtime内容hash依次为`7a98e8d8461dec7d19eea4f93d3fed80bd3a8f4928b80d42247730e7f31474ae`、`bee0b121e13822fffce6729c0fb17343e075c0b4dad2ea76c34b5dab5b0f1ac3`、`72e7d24e915e388221f89e3776b086056af7ad59be1f680549f3b33625fd11a2`。最近agent-eval回归227 pass/8容器skip/0 fail、typecheck通过，是历史基线，不能替代本计划最终回归。

剩余实施按Task 0→1→2→3→4→5→6→7→8→9→10→11→12顺序推进。每项先建立能证明真实缺口的失败用例，再做最小实现，正反/缺证据测试通过后进入下一项；已成立的不变量复用既有测试，不为凑数量重复写测试。

最终以`stage1-delivery.md`逐门槛接受。集合可在内容和执行契约通过后标记`reviewed`，`frozen`用于第二阶段真实实验冻结。`formalAcceptedCases=0`及无真实质量分数不阻止第一阶段工程交付；不能用该字段替代工程验收状态。正式运行在第二阶段还需有效用户配置/预算/必要校准/快照，第一阶段结束不自动发起运行。

## Review Focus

1. Host/模型请求之前中止、挂载或注册失败：不得遗留可执行实例、污染下一Trial或发送Provider请求；Task 1/12验证。
2. 同一逻辑保存查回、不同参数冒用原ID、提交后响应丢失：只读查回不重放，冲突明确拒绝，已提交候选不重复；Task 3/4验证。
3. 取消与提交竞争及停止未知：依原事实区分提交前/后/未知，不能把ack当停止、未知当零候选；Task 6/12验证。
4. 证据只读了首段、引用格式有效但语义不支持、重复/缺环Claim：不以结构校验替代语义、不漏计分母；Task 7/8验证。
5. 空/不兼容/截止后快照与Judge截断：缺失和回退显式保存，不临时补样本、不放宽256、不选择性丢失败；Task 8/9/10验证。

## 接口与文件职责

以下相对路径均以`D:\code\Flowmate`为根；只修改任务涉及内容，不做模块整体重排。

| 边界 | 现有接口/文件与决策 |
|---|---|
| 产品评测入口 | 保持`AgentKernel.readiness()`、`prepare(trial, signal): Promise<AgentTrialSession>`与Session的input/execute/snapshot/cancel/close；修改`agent-eval/src/adapters/agent.ts`接`prepareHostTrial`，不增加第二套Kernel协议 |
| 可信控制 | 扩展`agent-eval/src/datasets/schema.ts`的v2固定interactionProfile及对应控制Schema；四个ID为`invoice-save-replay`、`invoice-save-delivery-loss`、`invoice-read-execution-failure`、`invoice-save-cancel-race`，version=1；v1继续拒绝 |
| 控制与采证 | 修改`agent-eval/src/adapters/host-research.ts`及现有invoice/runtime/tool evidence模块；过长分支提取为专用`invoice-controllers.ts`，仅返回原产品事实，不引入通用脚本执行器 |
| 固定工具故障 | 在既有`packages/core/src/tools/evaluation-fault.ts`扩展两个Case专用固定接点；Case故障类型与现有R01–R12枚举分开，不能让Runtime pair接受任意Case故障或脚本 |
| 39项评分 | 新增`agent-eval/src/scoring/evaluators/formal.ts`；`evaluateFormalMetrics(context: EvaluationContext): EvaluationScore[]`只产生确定性原计数/缺口。语义仍由现有`evaluateSemantic`一次调用，DR03复用`deriveResearchF1`；`evaluateAll`合并时禁止同一正式指标重复 |
| 校准入口 | 新增`agent-eval/src/scoring/judges/calibration.ts`与CLI子命令`judge calibrate --dir <references> --execution-id <id>`；输入参考与输出报告独立版本化，复用既有Judge调用记录/预算/取消 |
| Runtime快照 | 新增`agent-eval/src/execution/runtime-snapshot.ts`与CLI子命令`runtime snapshot --execution-id <id> --trial <trialId> --cutoff-tool-call-id <id> --out <absolute-json>`；只读已保存报告和原工具观察，不调用Provider或修改来源报告 |
| 配置与比较 | 扩展现有strict `runConfigSchema`，新增有版本的Runtime策略A–D、可信快照引用和事前登记来源/截止；保留旧配置读取，新增字段纳入`configurationHash`和比较条件 |
| 报告/平台 | 复用LocalReport v2与既有聚合、exportEvents、feedback/import/sync；必要新增字段同步严格重读验证。旧v1只读兼容，不重算旧分数 |
| 桌面能力 | 复用`apps/desktop/main/invoice-form-bridge.ts`的真实控件桥和既有Electron测试；不建设P16 Evaluation页面，不以Headless写库代替Fill |

## Task 0：建立收尾基线并纠正阶段状态说明

**Files:** 修改`docs/eval/records/2026-10-11-stage-one/implementation.md`、`docs/eval/records/2026-10-12-dataset-review.md`、必要datasets README；新增`docs/eval/records/2026-10-12-stage-one-completion/implementation.md`作为本计划唯一进度表。

**Interfaces:** 消费既有86条审核记录与当前git状态；产出13项待办、初始文件身份和可追溯日志目录。日志保留本机，交付文档保存摘要/退出码/范围。

- [ ] 记录当前branch/HEAD/dirty、依赖锁和两SDK补丁；逐项读取当前实现确认旧实施记录哪些已被后续增量取代。
- [ ] 将“缺少正式成绩/真实校准/真实快照导致阶段一未完成”的表述纠正为具体工程缺口；数据审核完成、工程尚未完成、正式运行尚未启动分别记录。
- [ ] 校验三集合数量/审核hash及coverage现有字节；不运行Provider、不重做已审核材料。执行3次`dataset validate`和既有数据审核/原件校验脚本，失败先修正基线再进入Task 1。

## Task 1：独立Trial隔离与生产入口基础

**Files:** 修改`agent-eval/src/adapters/{agent,isolation,host-research}.ts`、`agent-eval/src/execution/{runner,execute-case}.ts`；测试`agent-eval/tests/adapters/{isolation,host-research}.integration.test.ts`及execution/runner测试。

**Interfaces:** 保持AgentKernel/Session接口，复用`prepareHostTrial(trial, signal, {repo, credential, isolation:'container'})`；凭据只来自既有Provider配置机制，不能使用Judge凭据或在配置JSON中持久化密钥。正式路径必须隔离；无Docker/镜像/凭据/能力时返回具体拒绝原因，不降级到未隔离Host。

- [ ] RED：实际容器Native Read/Shell探测外部Gold/Judge/用户哨兵均失败；路径链接/挂载越界在启动前拒绝；Trial2不继承Trial1候选、文件、历史与经验。
- [ ] RED：prepare任意阶段取消或失败后不得发送模型请求；迟到启动实例必须被确认关闭；停止/清理未知时后续Trial保持NOT_RUN并保留现场。
- [ ] 接通公共Host准备、材料注册、独立可写根、隔离包/镜像及源码资源身份；snapshot/cancel/close使用原实例事实与幂等回执。保留Host单DB所有者。
- [ ] 将既有8项容器测试在专用命令中实际启用：`$env:FLOWMATE_TEST_CONTAINER_ISOLATION='1'; bun --no-env-file test --isolate --timeout 120000 agent-eval/tests/adapters; Remove-Item Env:FLOWMATE_TEST_CONTAINER_ISOLATION`。必须在finally清除临时开关，不能把skip计通过。
- [ ] 本任务只完成prepare基础和逐能力测试；全生产能力通过前继续保持默认readiness拒绝，最终Task 12统一接通，不提前改成常量true。

## Task 2：补齐所有实际Case所需步骤、初态和真实Fill

**Files:** 修改`agent-eval/src/adapters/host-research.ts`及对应evidence/material模块、v2步骤Schema；复用`apps/desktop/main/invoice-form-bridge.ts`及`tests/desktop/invoice-form.e2e.test.ts`，新增`tests/desktop/evaluation-fill.e2e.test.ts`。

**Interfaces:** 消费全部86条Case的requires/steps/control定义，产出“Case→处理器→公开产品入口→证据→工程测试”逐项能力表。注册规则固定，Artifact/Document/Run/候选等ID只在Trial运行时获得。

- [ ] RED：遍历86条定义，任何步骤、资源/故障控制、必要证据无处理器时preflight失败且零Provider请求；已有实现不重复重建。
- [ ] 补齐固定历史种子、实际重启查回、全部自动压缩及原生文件/命令/导出组合中尚缺的接合；固定种子通过公开输入/历史入口重建，禁止导入任意SQL/数据库副本。
- [ ] 将本地文本、三页合成PDF的既有冻结解析内容按允许材料注册为真实产品Document；测试完整分页/明细、版本变更与候选归属。工程用独立合成副本，不给待测模型正式留出材料。
- [ ] Fill由本Trial拥有的最小Electron运行实例调用既有表单桥；Host与桌面只通过类型化控件请求/回执交互，校验frame/epoch、formInstanceId/revision、Workspace/候选身份。Electron只拥有控件与IPC，复用该Trial的Host客户端，禁止另启一个Host打开同一产品根。Native Read/Shell仍处于容器内，不因桥接暴露质量目录；不新增Evaluation UI或任意桌面执行RPC。
- [ ] GREEN：真实控件填入/读回、过期revision/错误所有者拒绝、提交后回送丢失查回、取消/关闭清理；已有三格式受管导出和Native Save As按原文件/原操作区分。受控Electron用例与能力表全部覆盖后交付。

## Task 3：039 原身份幂等查回与重送

**Files:** 修改v2 interactionProfile、Host控制/evidence；更新`agent-eval/datasets/flowmate-agent-v1/quality-controls/agent-039/controller.json`及其绑定；测试新增`agent-eval/tests/adapters/invoice-recovery.integration.test.ts`中的039组。

**Interfaces:** `invoice-save-replay/v1`读取原sessionId/runId/nativeToolCallId/argumentsHash及原提交，最多重送一次；复用实际保存幂等/公共查询，禁止用新逻辑toolCallId模拟幂等。

- [ ] RED：完成首次实际保存后，查回、同身份同参数重送均只得到同候选；同身份改参数明确冲突；全分页候选历史不得多一条。
- [ ] 在第一次真实保存提交后触发既有controller约束；先查原提交，再重送一次并再次查回，保存原逻辑身份/原参数/回执与候选内容。
- [ ] GREEN：真实一逻辑保存/一候选、冲突拒绝、未发生保存时exposed=false/UNJUDGEABLE；独立Gold字段/明细判定保留，唯一候选不能直接证明内容正确。

## Task 4：040 提交后模型回送丢失恢复

**Files:** 修改Case固定故障契约、`packages/core/src/tools/evaluation-fault.ts`和实际工具回送接点、Host/evidence；更新040控制绑定；沿用invoice-recovery测试。

**Interfaces:** `invoice-save-delivery-loss/v1`使用控制文件既定`case-save-delivery-loss/v1`，只在原提交已被公共查询确认后丢失一次原模型结果交付；原提交回执与候选保持，最多一次恢复尝试。

- [ ] RED：有真实提交/回送失败/原Run错误记录；查回原结果不重复保存；未知提交、没有真实暴露和第二个新逻辑保存均不能被评分为恢复成功。
- [ ] 复用Runtime R11的提交身份验证与丢失采证，新增本题要求的有界查回路径；不得把R11的fatal停止直接冒充040恢复，也不得修改既有失败Run为completed。
- [ ] GREEN：提交存在/未确认、未触发、重复写入反例全部明确；模型仅收到真实可交付诊断，不提前看到触发条件或Gold。正常对照无故障。

## Task 5：041 原始读取执行失败与一次恢复

**Files:** 修改Case固定故障契约/执行接点、Host/evidence；更新041控制绑定；沿用invoice-recovery测试。

**Interfaces:** `invoice-read-execution-failure/v1`使用`case-evidence-read-execution-failure/v1`；第一次获准`read_invoice_evidence`实际执行失败，只激活一次，最多一次恢复尝试，正常权限和剩余预算保持。

- [ ] RED：执行阶段真实失败与准入拒绝、参数错误、伪造失败正文可区分；正确重试/合法替代与无法恢复时诚实说明均可判定，不能强制唯一工具序列。
- [ ] 通过固定执行失败接点留下原ToolCall终态和耗时/停止事实，后续恢复由模型新调用触发；没有自动重试或自动修参。
- [ ] GREEN：一次恢复成功、一次仍失败后停止、无剩余预算、第二次恢复违规、未触发五类情况；只读场景保持零候选/零保存，错误不得从轨迹中消失。

## Task 6：042 取消与提交竞争

**Files:** 修改Host控制、既有保存/取消窄接点与evidence；更新042控制绑定；沿用invoice-recovery测试并增加execute-case/Runner反例。

**Interfaces:** `invoice-save-cancel-race/v1`在原保存已获准并进入提交窗口后，只发送一次真实`cancel_run`，依据原提交/停止事实输出三类观察，不预设竞态胜负。

- [ ] RED：分别固定cancel-before-commit、commit-before-cancel、commit-unknown三种可观察次序；取消ack不能证明已停，未知提交不能记0或成功。
- [ ] 通过固定事务前后闸点稳定控制工程用例，不使用sleep概率碰撞、不替换产品结果；查原候选/提交及所有实际后代停止。
- [ ] GREEN：提交前取消无副作用；提交后候选/原事实保留且零重送；未知保持未知。停止超时/后代仍运行时保留原失败和现场，后续Trial NOT_RUN；迟到close不能回填原Trial成功。

## Task 7：补齐原33项采证、机会与评分

**Files:** 新增`agent-eval/src/scoring/evaluators/formal.ts`及分组测试；修改既有adapter evidence、`evaluate.ts`、catalog/metric-plan使用、aggregate/report验证；更新metric-mapping和coverage中的当前支持状态。

**Interfaces:** `evaluateFormalMetrics(context: EvaluationContext): EvaluationScore[]`核可信采证并生成原统计单位/计数；语义要求编译到现有CompactPlan，由现有`evaluateSemantic`统一一次请求。目录39项身份不变，v1 legacy九种检查枚举不扩成正式39项。

- [ ] 建立33项逐项表：task4、tool4、Runtime6、context3、memory4、skill3、subagent5、safety4；每项明确适用Case/机会来源、确定性或语义判定、分子/分母/未知、报告字段与正负缺证测试。
- [ ] RED：合法引用但错误金额、无新信息重复调用、只装配未读资源、父未采用子输出、旧事实覆盖新纠正、违规请求被挡但模型仍违规等反例不能被相关性或结构成功掩盖。
- [ ] 确定性证明身份/权限/调用/提交/回送/停止/范围；语义证明目标正确性、选择/使用合理性、事实采用等，不能让产品supported或模型自述代替独立判定。Runtime fault未暴露不计恢复成功，R07 outcome=null保持未知，R08/R11/R12保留业务与过程分离。
- [ ] 根据实际任务条件确认适用机会，更新Case的版本化评分声明与Gold依据；不因代码缺失标N/A，不要求每Case触发全部39项。必要失败不被均值抵消。
- [ ] GREEN：33项每项至少正/负/缺证据一例；两层汇总保留5次3PASS/1FAIL/1ERROR的3/5和ERROR，两Case机会1/1与1/3汇总2/4；旧v1和已验收聚合不回归。语义计划预算不够时明确阻断，禁止二次Judge。

## Task 8：研究独立评分、校准参考与校准命令

**Files:** 修改research evidence/integrity、`semantic.ts`、`judges/{compact,harness}.ts`，新增`judges/calibration.ts`、`agent-eval/calibration/judge/`参考及对应CLI/评分测试。

**Interfaces:** DR01=C/|A|、DR02=K/|G|、DR03沿原P/R派生、DR04=S/|L|、DR05=V/|F|、DR06=B/|H|；原计数保持独立，并使用同Trial的一次紧凑语义判断。校准命令输入调参/验证分区参考，输出独立本地校准报告及所有尝试记录，不回退Agent凭据。

- [ ] RED：空Report、遗漏、重复Claim、错误/同义改写、引用格式正确但不支持、反证/时间冲突、断链/外部未关联证据、合理partial均保持正确分母和匹配；只读首4000字符不当全文采用。
- [ ] 在质量侧从Report/Claim/引用/Gold构建固定序号及一对一匹配问题；复用已审核123条事实/2链来源作为依据，但校准输入使用独立合成实例，调参和验证分区不复用同一实例。单个Claim不得重复覆盖不同Gold而膨胀Recall。
- [ ] 将DR计数与原33项适用语义判据合并一次CompactPlan；按256输出上界审查最坏响应，截断/错误/缺证据保留现行五态、原文/finishReason/用量。超过预算拒绝，不能简化必需判据或扩大输出。
- [ ] 实现`judge calibrate --dir ... --execution-id ...`严格输入/分区/hash、独立凭据、事前预算、取消和原子本地报告；执行时不读被测Agent输出反推参考，现有真实模型结果不参与本阶段调参。
- [ ] 校准报告按01§7.4逐语义判据保存误放行、误拒绝、严重错误漏判、无法判定、引用正确性和样本量；不新增方案未规定的总体一致率阈值，不自动声称真实校准通过，实际接受结论留第二阶段记录。
- [ ] GREEN：六项独立计数/派生、一次请求、256/15,000守卫、事前取消零请求、截断/非法JSON/泄露/重复ID/跨分区引用等反例通过。命令仅以受控Transport测试，校准报告明确engineering-fixture，无真实校准通过标记。

## Task 9：Runtime A–D配置与快照设施

**Files:** 新增`agent-eval/src/execution/runtime-snapshot.ts`及测试；修改runner strict配置、Host组装、报告配置身份、必要产品Runtime统计/经验接合；新增无密钥`agent-eval/configs/runtime-{A,B,C,D}-template.json`。

**Interfaces:** A=配置期限，B=A+每轮剩余预算/证据缺口诊断，C=B+兼容统计期限，D=C+有界经验；强制权限/提交/停止/必要保存所有组都启用。新配置版本和快照引用纳入完整比较身份。

- [ ] RED：从事前指定的开发Execution/Trial及cutoff提取已提交可信观察；拒绝留出来源、截止后记录、来源/SDK/工具/策略/环境/任务不兼容、文件越界/hash错误和未确认停止样本。
- [ ] 实现只读`runtime snapshot --execution-id ... --trial ... --cutoff-tool-call-id ... --out ...`，保存来源实例、原调用身份、版本、截止、计时资格、排除/回退原因和安全摘要。输出独占原子写入；不触发模型、不补采样、不含Gold或其他会话正文。
- [ ] 接通01§6.4原规则：最近200实际尝试；至少20成功/停止确认/完整计时且未截断样本才用nearest-rank P95；最近20有超时/截断/停止未知则回退；期限`ceil(1.5×P95)`，通常下限1秒，受配置期限/Run剩余时间/更短原生期限约束。只结构化PURE/READ激活，写工具/命令/Pi原生文件工具使用配置期限。
- [ ] D组经验只用兼容可信已提交摘要及有条件合法替代提示，不越权、不跨Trial学入新经验、不把经验当可靠性概率。每轮重算实际剩余额度，不能冻结首轮剩余值。
- [ ] GREEN：19/20样本边界、分组/时间/200窗口、最近20风险、写工具禁用、C/D缺快照拒绝与样本不足回退明确。统计/经验关闭的首次开发A允许尚无快照；正式或依赖统计/经验必须使用第二阶段真实快照，合成工程快照不能通过正式来源门禁。
- [ ] 本阶段只产工具、模板和受控测试，不生成正式observations.json、实际A–D冻结配置或开发Execution。

## Task 10：完整报告、白名单导出与反馈工程

**Files:** 修改`agent-eval/src/reports/store.ts`、`scoring/aggregate.ts`、`langfuse/{export,human}.ts`及review现有模块；补report/export/review测试。

**Interfaces:** 消费原Execution/Trial/Run、39项原计数与五态、Judge/工具/Compaction真实用量；输出原子可重读报告和白名单平台事件，原评分保持不变。平台网络只注入受控Transport。

- [ ] RED：多Run/父子/规划调查/手动自动Compaction费用去重，未知不写0；未知Score不上传0；不同Execution同Case/repetition不合并，同报告重复补传ID保持。
- [ ] 用显式白名单替代raw对象展开，导出最少必要身份/版本/计数/状态/安全证据摘要；不把Gold/控制/未来输入/完整Judge请求/密钥作为metadata。平台平均值不能代替本地分母。
- [ ] 保留原分数和执行，区分导出成功/部分成功/失败；补传不执行模型或Judge，不覆盖已完成事实；反馈严格关联原Execution/Trial/评分版本并幂等去重。
- [ ] GREEN：白名单泄露哨兵、39项映射、多Run关联、局部回执失败/重复回执、反馈错身份/重复导入、旧v1报告只读及比较不兼容拒绝。真实上传/UI仍留第三阶段。

## Task 11：数据绑定刷新与可执行交接模板

**Files:** 修改实际受影响三集合的Case/Gold/reviews/authoring-status/控制绑定及coverage/metric-mapping；更新既有审核脚本；新增`agent-eval/configs/`业务/研究pilot和正式配置模板；更新05/06/07/08及必要README。

**Interfaces:** 消费已通过的控制、39项评分和配置Schema；产出不含密钥的模板、当前数据与工程身份、可由用户在第二阶段填真实条件的操作说明。模板路径固定为`agent-pilot.json`、`research-pilot.json`、`agent-frozen.template.json`、`research-frozen.template.json`及Task 9的四组模板；未填真实配置/快照时验证明确拒绝，不伪装正式可运行配置。

- [ ] 任何Case步骤/成功标准/评分/控制绑定变化都递增相应Case与集合内容版本；重新计算Case/Gold/材料/源码/控制hash，原审核绑定失效后重新做用户授权的Agent审核，不只机械改approved。共享scoring变化影响全体Case时重核全部受影响记录。
- [ ] 保持86条数量、研究六类、整对与同源/近重复分区；原件和事实不因实现困难改掉。刷新86条审核总表、186行材料表与控制表的当前hash，设计快照明确历史身份。
- [ ] 内容及执行契约通过的集合标记reviewed；不伪造frozen时间、真实快照/Execution、预算消耗、模型身份或Baseline。同步更新当前核查脚本中“必须draft”的历史断言，保留真实运行结果为未启动。
- [ ] 业务/研究pilot模板只含已定义非敏感配置；Runtime模板明确A–D因素和首次开发/正式快照要求。Agent/Judge凭据独立，由第二阶段用户通过既有配置机制提供。
- [ ] 07准确列已实现命令、配置填入步骤和真实评测顺序；08只上传既有报告。说明模板到实际冻结文件的转换由第二阶段先导后完成，本阶段不要求用户先执行任何正式评测。
- [ ] GREEN：所有模板通过strict Schema，未填关键真实信息仍拒绝；三集合validate、当前数据审核脚本/原件引文核查、coverage重建、错hash/旧审核/缺配对/跨分区反例通过。

## Task 12：完整工程验收、生产入口接通与停止

**Files:** 修改`agent-eval/src/adapters/agent.ts`最后的readiness/prepare接合及CLI帮助；新增`docs/eval/records/2026-10-12-stage-one-completion/stage1-delivery.md`，更新唯一进度表和当前状态说明。

**Interfaces:** 消费前述12项的工程证据，产出阶段一accepted交付记录和可用Kernel。readiness基于已接通能力与运行时必要条件，不能将“缺少第二阶段真实质量成绩”作为永久拒绝理由；选择/配置/凭据/预算/快照的合法性仍在正式调用前检查。

- [ ] RED：经过默认公开CLI→Runner→真实隔离Host的合成最小任务能执行、采证、独立评分、保存/读回/比较；缺隔离、缺必需步骤、错误配置/hash/预算、未校准C/D继续在Provider请求前拒绝。固定脚本Provider调用数可审计，公网请求数为0。
- [ ] 接通productAgent默认prepare和能力readiness；只在所有必需工程链真实具备后解除旧占位拒绝，禁止环境开关绕过。不能要求用户执行正式Smoke来证明工程已经交付。
- [ ] 完成适用产品测试：`bun --no-env-file run typecheck`、`bun --no-env-file run test:unit`、`bun --no-env-file run test:integration`、`bun --no-env-file run test:e2e`、CLI帮助/两新命令参数检查、三集合validate、审核/原件脚本及`git diff --check`。已有依赖无变化不重复install；锁文件变化才执行`bun --no-env-file install --frozen-lockfile`。
- [ ] 容器开关被根测试入口环境白名单剥离，额外使用Task 1专用命令真实运行8项及新增容器用例；要求相关测试0 skip。Fill/Native Save As相关真实Electron桥用例必须实际执行，工具不可用或失败即记录工程未完成，不以skip、mock写库或历史通过替代。
- [ ] 对05附录A和06步骤1–8逐条列证据与退出码；39项正/负/缺证测试、086条绑定、取消/停止未知、跨Trial独立重建、真实控件、白名单/部分成功、校准/快照受控接口均通过才标阶段一accepted。任一门槛不满足，只报明确未决项，继续本阶段修复。
- [ ] 阶段交付说明列出数据路径/版本/hash、工程测试范围、命令/模板和第二阶段需要用户填写的真实配置；正式质量成绩和费用留空，数据内容审核/工程验收/真实评测状态独立。
- [ ] **到此结束本轮。** 不执行`eval:smoke`、`eval:full`、真实`judge calibrate`、Runtime正式开发/留出、真实平台resend/import/sync；不进入P16/P17。

## 完成标准与交接

| 门槛 | 必须满足 |
|---|---|
| 数据 | 86条及全部Gold/审核/当前绑定有效；分区、39项覆盖和版本变更可追溯 |
| 执行 | 全部Case所需步骤/控制可接通，039–042有原产品正反证据；公共入口、独立Trial与真实Fill通过 |
| 评分 | 39项逐项方法/机会/原计数/缺失/正负例齐全，语义一次Judge/256输出且不足明确阻断 |
| Runtime/Judge | 校准命令、调参/验证参考、快照工具、A–D策略和严格配置有受控工程证据；不要求真实校准和快照已经产生 |
| 安全/报告 | Native/Shell/链接/质量隔离、停止未知阻断、独立重置、原子重读、白名单/部分成功/反馈去重均通过 |
| 文档 | 配置模板/CLI/07/08一致，阶段一验收记录accepted；第二阶段执行与第三阶段平台操作仍未开始 |

实施中优先按上述依赖顺序完成，每个任务交付最小可核查差异；不按“通过了多少测试”估算完成百分比，不以正式评测结果填补缺失工程。不承诺未实际测量的工期。任何源码/契约/评分修改导致已审核绑定失效，都在Task 11重新审核后交付。

本计划只完成规划与文件核对，未执行上述实现或测试。主要剩余风险是容器与真实Electron桥能否在同一评测边界下完整接通、以及一次256输出是否足够覆盖每条任务的必需语义判据；计划要求用受控证据逐项验证，失败时保持具体工程缺口并修复，不能用跳过、降级评分或追加真实调用结束第一阶段。
