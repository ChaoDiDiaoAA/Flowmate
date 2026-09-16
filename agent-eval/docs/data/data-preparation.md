# Flowmate Harness 数据制作方案

## 一、目标与当前基线

按产品总方案和 Agent 评测总方案准备可追溯的输入、初态、触发、判据和证据要求，分别验证功能机制 F、真实 Agent 决策 A 和业务闭环 B。准备资料、目录归属和自动检查都不能替代真实运行。

| 共享资产 | 保留基线 | 制作及使用边界 |
|---|---:|---|
| 去重原票 | 2,902 | 原图和解析仍在项目 data/invoices/voxel51，质量侧只引用 |
| 来源标签 | 1,414 | 保留原始来源身份与去重关联，不自动视为正确答案 |
| 已发布结构化 Gold | 1,200 | 保留当前版本、humanVerified、答案、澄清预期、证据及审核记录 |
| 模拟业务包 | 600 | 保留身份、业务内容与摘要；模拟金额不替代票面答案 |
| 已有 Case | 5,577 | 保留 Case 身份、原票关联、用途与原业务语义，按主责模块迁移并升版 |
| 新增具体场景 | 以迁移报告为准 | 根据细分能力缺口补正常、失败、边界等独立变体，不通过复制凑数量 |

唯一当前质量根为 `agent-eval/data/`，不建立 v1/v2 等并列目录。当前数量和状态读取 `preparation-report.json`；模块成员读取 `module-catalog.json`；真实产品成绩只来自 `runs/` 的受信执行链。旧 6,000 例退役 423 例的范围记录属于历史，本轮不恢复已退役范围。

## 二、十五个 Harness 功能目录与方案映射

主责目录决定存储位置，不决定覆盖结论。下表列出模块职责、MOD/RT 导航范围，以及每组输入、操作和证据。MOD/RT 名称以固定来源方案为准，细项对应 RTC/RTX/HC 或源条款，并在 `oracle.checks` 上登记实际断言关系。

| 目录 / 中文职责 | 对应 MOD / RT | 输入、触发与检查证据 | 当前实例 |
|---|---|---|---|
| `cases/foundation/`：基础契约与输入接入；配置、启动屏障、输入身份、Workspace 与公共组装 | MOD-01, MOD-07, MOD-09, MOD-25, MOD-29, RT-01 | 输入：员工配置、解析文件与 Workspace 初态；触发：触发初始化、导入或组装失败；证据：核对 ready 屏障、输入摘要及持久化身份 | 见 module-catalog |
| `cases/agent-runtime/`：模型运行与任务决策；Provider、原生 Loop、任务理解及整票抽取 | MOD-02, MOD-04, MOD-11, RT-02, RT-03, RT-16 | 输入：任务输入、Provider 参数与获准原票；触发：调用真实模型并推进原生 Loop；证据：核对模型请求、工具回送、结束原因和字段/澄清输出 | 见 module-catalog |
| `cases/tools/`：工具注册与准入；Spec/Handler、Gateway、参数、结果及权限边界 | MOD-05, MOD-09, RT-04 | 输入：ToolSpec、权限和带边界的工具参数；触发：调用、取消或拒绝工具；证据：核对 Gateway 决定、实际执行、副作用及结构化结果 | 见 module-catalog |
| `cases/events/`：事件与证据；消息投影、事件序号、Trace 与诊断日志 | MOD-02, MOD-26, RT-09 | 输入：订阅者、事件序列与流式消息；触发：重复投递、断流或订阅者失败；证据：核对事件次序、身份、投影与 Trace；不靠最终文本推断过程 | 见 module-catalog |
| `cases/sessions/`：会话生命周期；身份、输入交付、队列、续接、分支及绑定 | MOD-08, MOD-25, RT-05, RT-10, RT-11, RT-12, RT-14 | 输入：Session 身份、绑定、待消费输入和分支点；触发：恢复、续接、steer、followUp、取消或关闭；证据：核对消费次序、generation、分支历史与实际取消传播 | 见 module-catalog |
| `cases/context/`：上下文工程；当前资料选择、允许输入和快照实际调用关联 | MOD-03, MOD-05, RT-03 | 输入：当前资料选择、权限与版本；触发：构建 Context 并调用模型；证据：核对获准快照、当前事实及本次实际模型调用的关联 | 见 module-catalog |
| `cases/memory/`：原生历史与记忆；完整原生历史持久化、完整性、恢复及历史使用 | MOD-03, MOD-08, MOD-25, RT-05 | 输入：数据库中的完整原生历史与来源引用；触发：写入、恢复、损坏或修订后续接；证据：核对历史完整性、权威来源及实际读取；不手写 SDK 成功历史 | 见 module-catalog |
| `cases/compaction/`：原生上下文压缩；触发、重复压缩、失败取消及事实保持 | MOD-03, MOD-08, MOD-28, RT-06 | 输入：原生会话、压缩阈值和当前事实；触发：触发重复压缩、失败或取消；证据：核对原生压缩事件、保留事实及后续模型输入 | 见 module-catalog |
| `cases/workflow/`：业务工作流与复核；步骤、匹配校验、等待、人工修订及评估快照 | MOD-07, MOD-12, MOD-13, MOD-15, MOD-16, MOD-17, MOD-23 | 输入：模拟发票、供应商、订单、收货及步骤初态；触发：校验匹配、人工修订或并发推进；证据：核对差额、候选、StepAttempt、Waiting 和业务修订 | 见 module-catalog |
| `cases/prompt-skills/`：Prompt 与 Skill 管理；目标决策、SOP、资源装载、版本与资源注入 | MOD-01, MOD-04, MOD-06, RT-07 | 输入：任务目标、Prompt、Skill/SOP 与资源版本；触发：选择适用资源或处理冲突和注入；证据：核对装载清单、版本、工具决策与证据不足时的处理 | 见 module-catalog |
| `cases/extensions/`：原生扩展；扩展装载、Hook、命令、停用及清理 | MOD-33, RT-08 | 输入：扩展清单、Hook 与命令配置；触发：装载、转换、失败、停用或清理；证据：核对实际 Hook 调用、工具准入和扩展生命周期 | 见 module-catalog |
| `cases/subagents/`：子 Agent 协作；真实委派、槽位、身份、只读范围及父子取消预算 | MOD-34, MOD-08, MOD-28, RT-17 | 输入：父子会话、命名槽位、只读范围和共享预算；触发：真实委派、冲突、父取消或父恢复；证据：核对子会话身份、实际调用、权限交集和资源释放 | 见 module-catalog |
| `cases/actions/`：业务动作与结果核对；预览、正式审批、Browser/B2B、防重与权威结果 | MOD-18, MOD-19, MOD-20, MOD-21, MOD-23 | 输入：预览载荷、附件、目标、确认与目标系统台账；触发：确认、发送、响应丢失、接管或 UNKNOWN 核对；证据：核对 payloadHash、授权事实、持久动作、防重与权威回读 | 见 module-catalog |
| `cases/operations/`：运行维护与恢复；Host、环境凭证、发布、预算停写、备份与清理 | MOD-24, MOD-25, MOD-26, MOD-27, MOD-28, MOD-29, RT-13, RT-15, RT-16 | 输入：Host、凭证、发布、预算与备份初态；触发：断连、停写、恢复、迁移失败或清理；证据：核对故障传播、版本绑定、恢复结果与受保护资产 | 见 module-catalog |
| `cases/eval-infrastructure/`：评测设施；数据契约、Trial、评分、对照和报告 | MOD-30, MOD-31, MOD-32 | 输入：Case/Gold、Trial 调度和观测证据；触发：执行设施自检、缺证据评分或重算报告；证据：核对成员、摘要、分母、可信证据与判定；自检不计产品成绩 | 见 module-catalog |

跨模块场景只存一份，使用 `relatedHarnessModules` 关联其他参与模块。比如动作恢复例主属 actions，可能涉及 sessions、workflow 和 operations；只有有对应检查与证据的细项能算准备覆盖。原来的 extraction、matching、approval、submission、runtime、isolation、platform 保留为兼容分派类别，不再作为文件夹。

### 按细项准备，按阶段启用

1. 从两份源方案记录条款身份、章节、原文、行号和文件摘要；不得通过改主方案来消除缺口。
2. 建立模块 → 子能力 → 场景变化 → 原子检查 → 必需证据的链路；MOD 标签和默认 status=pass 不能覆盖整模块。
3. 区分 F/A/B，明确最早适用的 P0–P13 阶段和实际启用模式，早期场景不得依赖晚期能力。缺失模式保留 unprepared。
4. 针对正常、失败、边界、并发、取消、恢复、越界或无授权变化明确改变的条件。每项变化必须有可观察的预期和适用证据。
5. 继承原方案的数据库原生历史权威来源、Context 与实际调用关联、正式确认和持久动作边界、P10 扩展、P11 子 Agent 等约束。

## 三、Case 字段、输入与判据

| 参数 | 制作要求与中文示例 |
|---|---|
| id / version / familyId | 稳定用例 ID、当前修订和场景族；迁移目录不另造已有 Case 身份 |
| harnessModule / relatedHarnessModules | 主责如 sessions，相关如 memory；物理文件仅在 cases/sessions 下 |
| caseSummary | 分别说明输入、触发、预期，例如“已有待消费输入 → 恢复会话 → 只消费一次并拒绝失效绑定” |
| subcapabilityRefs / requirementRefs | 子能力及要求引用；覆盖结论必须进一步追溯到检查项 |
| category | 旧类别分派兼容值，例如 runtime；读取文件时用清单路径 |
| sampleId / sampleRole / inputAssets | 原票用例保留真实引用；纯机制例使用 null / synthetic_only / 空输入引用，不挂靠任意发票 |
| initialEnvironment | 隔离实例、身份、网络范围、复位约定和受控初态，不能视为运行证据 |
| harnessScenarioId | 对应 SCENARIOS 的新增场景键；未知键拒绝物化 |
| oracle.assertions / oracle.checks | 观测路径、比较算子和值、中文行为说明、必要/硬约束、证据与规则实现状态 |
| stage / evaluationMode / fab | 阶段、F/A/B 当前准备模式和缺口；实际运行记录独立 |
| dependencies / executionEligibility | 真实模型、SDK、适配器、内容审核等限制；离线可构造与实际可执行分别表达 |

新增机制场景由可信控制器设置 `initialState`，按 `commands` 触发并注入 `faults`；获准内容才进入产品 input。Gold、expected、forbidden、检查项和评分答案留在质量侧。生成器不能把 expected 复制成 observation，也不能凭场景名生成“已通过”的原生事件历史。

### 中文端到端阅读示例

一个“提交响应丢失”的 Case 先提供固定模拟发票、载荷、附件、目标与有效确认，再由适配器让目标接受动作而丢失响应。预期是保存 UNKNOWN、查询权威台账、绑定同一业务动作并避免重复有效提交。证据至少需要动作身份、实际请求、确认依据和权威回读；模型回复“已经处理”不足以证明成功。当前仅构造初态和故障计划时，执行状态仍是 not_run。

## 四、来源、Gold 与业务资料制作

### 4.1 来源与用途

原图按字节摘要去重，保留来源别名和提供方记录。近重复只作人工线索，不自动删除或改变用途。同票及近重复组维持同一 split；开发、回归和验收是引用视图，不复制目录。已经公开准备和查看的合成种子放 development，不能冒充未暴露留出验收。

### 4.2 原票答案链

1,200 份 Gold 已发布。确定字段保留具体答案与证据；未定字段和明细保留请求澄清预期，不能补造金额或把 unknown 当不存在。原候选包、用户确认及发布记录作为历史依据保留。整票抽取一票一例，原图/解析/提供方标签指针的不同来源不能混用。当前发布口径和完整流程见本文末尾及数据 README。

### 4.3 模拟业务链

600 套业务包提供模拟发票、供应商、PO、收货、合同、订单余额、目标初态及政策。异常场景从合法底包引入明确变化，并核对十进制算术和引用完整性。按需匹配，保留修订、澄清、具体 B2B 提交确认、失效处理及接管。ERP 仅提供获准只读资料。

不新增外部验真、ERP 回写、产品内 OCR/Parser、自动拆合票、额度/多级财务审批、强制两人分离、复杂员工创建配置 UI 或第二任务通用性证明。

## 五、身份、计数、审核与历史

- 分别报告原票数、Case 实例、场景族、语义键和重复实例；重复分配不能算新增独立业务覆盖。
- 迁移保留已存在的 5,577 个 ID，不把旧归档成员算入当前总数。新增语义变化逐条登记，`replicaIndex` 和语义键一致。
- 已改 Case 升版，记录旧版本、摘要、路径和历史归档；其 reviewStatus 回到 pending，不继承旧内容审核。未改 Gold、业务包、来源和审核记录保持字节与身份。
- 用户旧批量审核声明及绑定内容、后续 Gold 发布审核和真实运行历史全部保留；不改写审核时间，不伪造新确认。
- materialStatus、reviewStatus、executionEligibility、executionStatus 与 formalAcceptanceEligible 分开管理；正式验收仍需内容、模式、阶段与受信实际证据齐全。

## 六、实际目录和清单职责

| 目录/文件 | 内容、用途及维护方式 |
|---|---|
| source-labels/voxel51 | 提供方 annotation/fields 和来源 manifest，只服务制作与追溯 |
| gold | 已发布原票答案和澄清预期，仅可信评分器读取 |
| business | 合成业务输入，产品只读获准 input 投影 |
| cases/<harnessModule> | 十五模块唯一 Case 定义；全文含 Oracle，不整体交给产品 |
| manifests/inventory.json | 当前受管文件的身份、大小、摘要；发布前后检查 |
| manifests/case-catalog.json | Case 身份、版本、类别、模块与真实物理 path |
| manifests/module-catalog.json | 十五模块职责、来源、成员、子能力、检查项和准备状态 |
| manifests/requirements.json | MOD/RT/细项及源方案的原文、行号、摘要、阶段和模式要求 |
| manifests/coverage.json | 从检查重算的细项准备情况、缺口与未准备模式 |
| manifests/splits.json / views.json | 用途、阶段、BM 和模块成员视图，不复制资产 |
| manifests/audit | 来源特征、近重复线索、累计复核批次和任务单 |
| manifests/materialization | 物化输入、可信控制计划、支持限制及数量报告 |
| manifests/reviews / history | 实际审核记录和其绑定的历史内容，不作为活动成员 |
| manifests/harness-migration.json | 本轮路径、身份、保留检查和补充场景迁移记录 |
| manifests/gold-preparation / gold-publication | 历史候选与实际 Gold 发布依据 |
| runs/<runId> | 真实运行的配置、输入版本、可信证据、逐项成绩和报告 |

## 七、迁移批次与验证顺序

1. 核对当前 inventory 与主方案摘要，保存资产基线和历史审核依据。
2. 明确十五模块主责、细项映射、旧目录到新目录的一对一路径和新场景语义。
3. 在项目内新的暂存根生成，保留共享资产及审核，修订已有 Case 并追加具体变体。
4. 重建目录清单、用途、阶段/BM/模块视图、覆盖、审核队列、物化和完整数据 README。
5. 运行数据工具和离线设施自检、全量资产与引用校验；核对不变资产摘要、原 ID 保留及答案不泄露。
6. 检查成功后发布唯一当前根，发布后再次校验并记录结果。任一步失败保留现场，不登记成功。

累计审核批次沿用前两批 100 Gold/50 业务/500 Case、500/250/2,500，最终批次覆盖全部 1,200 Gold、600 业务与当前 Case；最终数从清单生成。批次标记表示复核任务分配，不意味着已完成复核。

## 八、运行命令与结果解释

从项目根运行；`--project .` 指项目根，`--output` 指新的项目内暂存目录，`--data-root` 指需检查或物化的质量根。不要用初次准备脚本覆盖已审核数据。

```powershell
python agent-eval/tools/migrate_harness_data.py stage --project . --output data/.preparation-stage/harness-review
python agent-eval/tools/migrate_harness_data.py verify --project . --output data/.preparation-stage/harness-review
python -m unittest discover -s agent-eval/tools -p "test_*.py" -v
python -m unittest discover -s agent-eval/tests -v
python agent-eval/tools/migrate_harness_data.py publish --project . --output data/.preparation-stage/harness-review
python agent-eval/tools/verify_invoice_data.py --project .
```

`stage` 准备，`verify` 校验指定根的迁移和资产保留链；`publish` 先执行完整文件、来源、审核和引用校验，再替换唯一当前根并保留回滚位置。`verify_invoice_data.py` 用于发布后的全量复验；详细参数以工具 --help 为准。内容审核用 review_invoice_data 的 export-form/submit 流程，不能直接翻转 humanVerified。数据手册的字段字典、附录 A/B/C 解释所有现有条件、观测路径和新增场景参数。

设施自检只能证明工具在对应输入下工作。完整产品执行仍需实际入口、受信适配器、必要规则和证据；缺证据和未实现检查阻断通过。模块材料准备齐备不能据此声称全模块完成或给出产品通过率。

## 逐字段答案与证据准备

用户已说明此前原票审核没有单独保存逐字段答案或修正记录，并确认先整理答案与证据。因此先准备全部 1,200 份候选，供用户具体核对；既有批量审核声明继续保留，不能把它转写成新增候选已逐字段确认的记录。

准备入口：

```powershell
python agent-eval/tools/prepare_gold_answers.py --project .
python agent-eval/tools/prepare_gold_answers.py --project . --verify
```

默认已有目录会拒绝覆盖。`--refresh` 仅用于人工核对尚未开始时重新生成机器候选，执行前会校验当前清单、源文件、Gold 基线及未审核状态。准备结果全部位于项目根目录下的 `agent-eval/data/manifests/gold-preparation/`，并登记到当前质量清单：

| 文件 | 内容与用途 |
|---|---|
| `index.html` | 全部核对入口，按原审核成员顺序，每 100 张一组 |
| `views/group-01.html` 等 | 本地打开后对照原图、字段候选、规范化候选、疑点及证据；不自动登记审核 |
| `samples/<sampleId>.json` | 每票 15 个表头字段及每条已恢复明细的 8 个字段；保留来源、备选值、定位、源文件摘要和 Gold 基线 |
| `fields.csv` | 汇总所有字段和疑点，适合筛选；用文本类型导入样本 ID，避免丢失前导零；可能被表格软件执行的前缀增加单引号，原文以 JSON 为准 |
| `report.json` | 样本、明细、字段与疑点数量、原审核批次成员、未发布状态和原 Gold 摘要 |

答案候选来自现有提供方标签、解析文字及能够识别表头的解析表格。它们是离线数据制作产物，不属于产品运行成绩，也不是新的产品解析功能。规范化只做明确转换；`$` 不自动当作 USD，月日顺序不明确的日期保留备选，不根据算术补造票面未列出的税额。表头未知、合并单元格和错列行显式列为待核对，不能据候选明细数声称已覆盖整票。

本次实际整理 1,200 份候选、4,247 条明细、51,976 个字段核对项。其中 38,961 项有可规范化候选、1,958 项存在歧义或来源冲突、11,057 项需查看原图确定；另有 118 张未可靠恢复明细。所有候选仍须实际核对，这些统计既不是抽取准确率，也不是已发布 Gold 数量。12 个核对页各含 100 张。

解析证据含 `content.json` 块指针、页码、源坐标；表格增加 HTML 行号、列号和列名。原图引用是核对入口，坐标沿用解析的 `source_native` 坐标系，不代表已经人工查看。未从解析和标签找到的字段必须查原图，不能直接判成 `source_not_provided`。

每个字段的 `valueState` / `inputAvailability` 保持 `unverified`，`proposedValueState` 仅表示机器建议；其中 `confirmed` 表示存在可规范化的候选，并不表示人工确认。整票保持 `pending_human_confirmation`、`published=false`、`humanVerified=false`、`eligibleForFieldScoring=false`。准备完成后，已发布结构化 Gold 和真实产品运行数均不因此增加。

人工核对时，需要选择或修正原值、规范值，确认字段状态、解析输入可用性、明细完整性及证据归属；对确实不存在、不可读、不适用和存在歧义的字段分别填写对应状态，不能一律空白或通过。通过现有 `review_invoice_data.py export-form --kind gold --asset <sampleId>` 导出正式审核表，将候选包的 `reviewForm` 作为其 `goldReview` 的填写起点。仅在实际核对后填写真实审核者、时间、覆盖与审核声明，使用现有 `submit --review <审核表路径>` 校验并发布。候选 JSON 本身不能直接作为已通过审核提交。

## 已确认的澄清预期与 Gold 发布

用户已确认候选材料审核完毕、没有问题，并明确选择：剩余未定字段、歧义和缺失明细，均要求 Agent 请求澄清。这是对未知项的行为答案，不是提供了新的发票数值。发布工具 `agent-eval/tools/publish_gold_answers.py` 必须接收单独登记的真实用户确认记录，校验其所绑定的候选文件摘要，再使用与单份审核相同的校验生成版本和审核记录。

| 情况 | 发布的 Gold | 正确的 Agent 行为 |
|---|---|---|
| 已确认的具体候选 | `valueState=confirmed`，保留原值、规范值和来源 | 输出有依据的字段值 |
| 未定值或来源歧义 | `valueState=clarification_required`，`normalizedValue=null`，`expectedAction=request_clarification` | 保留未知，指出具体字段并提问，不能代选答案 |
| 未可靠恢复的整票明细 | `lineItemsExpectation.state=clarification_required` | 请求补充明细；不能把空列表说成“没有明细”，不能补造明细 |

`inputAvailability=unknown` 仅表示尚未确定解析输入是否提供该信息，不把它误记为 `omitted` 或票面缺失。确认未知项的 Gold 可用于评测澄清行为，不计作具有确定数值的字段答案。审核通过也不表示原图上不存在这些内容。

可信产品观测中使用 `observation.extraction.clarificationRequests` 记录实际提出的问题，每项含 `target` 和非空 `question`。表头目标例如 `fields.currency`，明细字段例如 `lineItems.0.tax_amount`，整票明细为 `lineItems`。允许一次向用户合并提问，但观测适配器必须据实际问题逐项关联目标，不能从 Gold 自动补写提问记录。评分同时要求未定字段保持未知与确实提问；只输出空值、遗漏提问或擅自给出确定值均不能通过。当前确定性评分核对目标与非空问题文本，问题是否充分、是否有业务意义仍需语义评分或人工核对。

发布保留 `manifests/gold-preparation/` 原始候选快照。当前答案在 `gold/<sampleId>.json` 升版，逐票审核记录保存原版本全文与摘要，`manifests/gold-publication/<publicationId>/report.json` 保存本批次各版本摘要及统计。审核身份来自当前用户的声明，记录时间是最终确认的登记时间，不冒充此前逐票完成审核的准确时间。

本次已发布 1,200 份结构化 Gold，其中 38,961 项为具体字段答案、13,015 项要求字段澄清、118 张另要求补充明细。原候选页的“尚未发布”是历史准备快照状态，当前状态以发布报告和 `preparation-report.json` 为准。既有 Case 草案和产品运行记录不因 Gold 发布而自动通过；实际运行前仍须将 Case/Run 明确绑定到本次 Gold 的版本及摘要，并完成其余评分规则与真实产品观测。`formalAcceptanceEligible` 保持 false，产品真实运行数不增加。
