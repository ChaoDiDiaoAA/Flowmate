"""Render the current dataset manual from publication facts, without changing data."""
from __future__ import annotations

import json


def _cell(value):
    return str(value).replace('|', '&#124;').replace('\n', ' ').replace('\r', ' ')


def _observed_fields(value, path=''):
    """Include nested optional metadata present in the representative task."""
    if isinstance(value, dict):
        for key, child in value.items():
            name = f'{path}.{key}' if path else key
            yield name, type(child).__name__
            yield from _observed_fields(child, name)
    elif isinstance(value, list):
        for child in value:
            if isinstance(child, (dict, list)):
                yield from _observed_fields(child, path + '[]')


MANUAL = r'''
## 二、目录和清单

| 路径 | 职责 |
|---|---|
| 项目 `data/invoices/voxel51/` | 原票和配对解析，原位只读；不属于质量答案目录 |
| `source-labels/voxel51/` | 提供方 annotation/fields 及其来源 manifest，不能直接当 Gold |
| `gold/` | 原图标注、字段/明细、可得性、来源及真实审核状态 |
| `business/` | 合成业务输入、政策假设、目标初态及独立 Oracle |
| `cases/<caseId>.json` | `agent_task` 完整任务，平铺唯一存储 |
| `contracts/<module>.json` | `product_contract` 套件，内部场景独立计数 |
| 数据集外 `../tests/fixtures/evaluation-selftests.json` | `eval_selftest` 套件，不计产品成员或成绩 |
| 数据集外 `../runs/<runId>/` | 仅真实执行后创建，保存实际 Trial/证据/成绩 |
| `manifests/active-dataset.json` | 当前格式、状态、库存摘要和真实计数 |
| `manifests/inventory.json` | 当前文件及公开文件 path/bytes/sha256；列出排除项 |
| `manifests/preparation-report.json` | 来源数、任务数、契约/自检数、审核状态、限制和零运行 |
| `manifests/case-catalog.json` | 任务和契约场景身份、类型、文件定位与摘要 |
| `manifests/module-catalog.json` | 模块职责、任务/契约引用及检查数；不是完整覆盖证明 |
| `manifests/requirements.json` | 两份规范的要求及指标身份、来源定位 |
| `manifests/coverage.json` | 每条直接要求的 assetId/checkId/kind，缺口与无法解析的引用 |
| `manifests/splits.json` | 来源组、既有暴露、当前资产用途；正式验收资格独立 |
| `manifests/fixture-policy.json` | 模拟政策，企业政策核验 false，只允许本地模拟业务写入 |
| `manifests/views.json` | 能力、条件、任务类型、BM 及 golden/failures 的引用视图 |
| `manifests/migration.json` | 旧身份/版本/摘要到新身份或退役理由；不保存旧正文 |
| `manifests/benchmarks/index.json` | 11 个有效 BM 的成员统计和 BM-06 退役身份 |
| `manifests/benchmarks/<BM-ID>/members.json` | 固定成员、检查项和依赖；不复制任务 |
| `manifests/benchmarks/<BM-ID>/readiness.json` | 基准执行阻断与缺口，不能冒充 Baseline |
| `manifests/reviews/annotations/` | 保留标注出处及当前答案绑定；不是人工核验声明 |

当前材料只保留最新集合，不建立 archive、history 或 V1/V2 并列根。JSON 是唯一编辑源；JSONL 只按需从固定版本导出。Gold、来源和业务数据的领域结构可能保留既有 Schema/修订；本轮 Schema 1 只约束新任务、契约、自检和清单，不能为了统一数字改写来源事实。

## 三、任务完整字段字典

无“可选”标记的任务结构字段均必需。数组可以为空的场合应显式写 `[]`，不得以缺字段替代。配置中未知字段由验证器拒绝；业务正文不是可执行配置。

### 3.1 身份与状态

| 字段 | 类型 / 允许值 | 含义 |
|---|---|---|
| `schemaVersion` | integer，当前 1 | 结构协议，独立于内容版本 |
| `kind` | `agent_task` / `product_contract` / `eval_selftest` | 三类材料的实际职责，不混合计数 |
| `id` | 非空 string | 稳定资产身份；任务对应同名 JSON 文件 |
| `version` | 正 integer，初始新内容 1 | 内容修订；引用须固定版本和摘要 |
| `title` | 非空 string | 质量侧可读任务说明，不自动成为模型提示 |
| `split` | `development` / `regression` / `acceptance` | 开发、回归、验收用途；不等于审核资格 |
| `leakageGroup` | 非空 string | 同原票、相关页及近重复分组，不跨用途 |
| `controlRefs[]` | string | 正常对照或执行所需依赖身份，不允许引用自身 |
| `comparisonRefs[]` | string | 对比任务身份；不能把对比方输出交给被测任务 |
| `lifecycle.material` | 非空 string，当前 `draft` | 材料生命周期，初始设计状态不代表运行 |
| `lifecycle.review` | 非空 string，当前 `pending` | 内容审阅状态；只有真实审阅才能改变 |
| `applicability.minimumStage` | `P0`–`P13` | 首次适用阶段，按能力递增选择 |
| `applicability.adapterRef` | string 或 null | 所需产品适配器身份，不表示已经实现 |
| `applicability.executionEligibility` | 当前固定 `blocked` | 当前没有产品实际执行资格 |
| `applicability.blockers[]` | 非空 string 数组 | 具体依赖；包含 `product_adapter_required`，可有 `trusted_collector_required` 等 |

### 3.2 六个并列维度

| 字段 | 结构 / 允许值 | 使用含义 |
|---|---|---|
| `classification.capabilities[]` | 非空 string 数组 | 多选能力，作者词表为 `tool_use/memory/planning/reasoning/interaction/context_use/resource_use/delegation/recovery` |
| `classification.taskShape.stepStructure` | `single_step/multi_step` | 步骤形态，由任务结构描述，不是检查项数量 |
| `classification.taskShape.interactionMode` | `single_turn/multi_turn` | 一轮或多轮等交互形态 |
| `classification.taskShape.longHorizon` | boolean | 是否跨较长历史/恢复过程 |
| `classification.difficulty.level` | `easy/medium/hard` | 初始难度标签，不能当作实测模型难度 |
| `classification.difficulty.basis` | 非空 string 或非空 string 数组 | 歧义、信息跨度、依赖、决策负担等具体依据 |
| `classification.difficulty.status` | 非空 string，当前 `provisional` | 难度标注/校准状态，初始仍需效果校准 |
| `classification.conditions[]` | string 数组 | 构造的正常、异常、冲突、注入等条件 |
| `classification.targetFailureModes[]` | string 数组 | 希望检出的失败，仅质量侧使用 |
| `classification.business.domain` | 非空 string | 业务领域 |
| `classification.business.primaryTaskType` | 六类之一 | `extraction/matching/human_collaboration/evidence_explanation/recovery_continuation/submission_confirmation` |
| `classification.business.relatedTaskTypes[]` | 上述六类的数组 | 相关业务目标，不增加任务数 |

六维是并列关系，任务族配额不是六维本身。能力/条件等词表可按实际作者值扩充，但需同步作者、校验和分类说明，不用目录层级代替。当前校验器核验能力、业务类型、形态、难度级别枚举；conditions 与 targetFailureModes 是作者提供的具体描述数组，不伪造已校准分类。当前代表任务的具体嵌套值见文末示例。

### 3.3 可见任务输入

| 字段 | 类型 / 允许值 | 含义 |
|---|---|---|
| `task.messages[]` | 非空 object 数组 | 获准初始消息 |
| `task.messages[].role` | `user` / `system` / `assistant` | 消息角色，不能借内容伪造真实操作者权限 |
| `task.messages[].content` | 非空 string | 实际任务文本，不含 Oracle 或禁止读取的答案 |
| `task.context` | object | 该任务获准的业务事实投影；业务键随任务变化 |
| `task.assetRefs[]` | asset reference | 可访问源资料；model input 只能 `root=project` |

`task.context` 是业务输入而非 Harness 选项；每个任务的具体字段以该 JSON 为准。产品投影必须屏蔽 Gold、标签、Oracle、评分、目标失败模式及其他 Trial 内容。即使路径可读取也不代表被授权。

### 3.4 可信初态与交互

| 字段 | 类型 / 允许值 | 含义 |
|---|---|---|
| `setup.protocol` | `invoice_extraction` / `declared_episode` | 选择数据装配声明，不是产品实现 |
| `setup.initialState` | object | 控制器初态，episode 必须与已注册声明一致 |
| `setup.initialState.sampleId` | string；抽取协议 | 原票身份 |
| `setup.initialState.inputMode` | 抽取初始集为 `parsed_only` | 仅授权既有解析；不能借 Gold 引用开启原图权限 |
| `setup.commands[]` | object 数组 | 控制器操作声明；抽取协议为空 |
| `setup.commands[].id` | string | 命令身份，供 `after` 和 `commandRef` 关联 |
| `setup.commands[].actor` | string | 声明的可信执行角色，不由模型签发权限 |
| `setup.commands[].command` | 已注册 string | 正式产品操作名；声明存在不等于入口已实现 |
| `setup.commands[].arguments` | object | 对应命令的精确参数，不能添加任意执行选项 |
| `setup.commands[].after[]` | string，可选 | 命令/屏障依赖，不能规定模型唯一工具选择顺序 |
| `setup.faults` | object | 声明的故障窗口/触发，由控制器构造，抽取为空 |
| `setup.businessRef` | 业务引用或 null | 固定业务包及投影协议；原票任务可为空 |
| `setup.businessPatches[]` | object | 获准业务变更；必须匹配注册声明，不能修改答案 |
| `setup.businessPatches[].op` | `add/replace/remove` | 白名单内添加/替换/删除获准输入 |
| `setup.businessPatches[].path` | JSON Pointer | 业务 input 内目标位置，父级必须存在 |
| `setup.businessPatches[].value` | JSON，remove 时不存在 | 变更值仍须通过产品输入隔离检查 |
| `setup.businessPatches[].reason` | 非空 string | 变更的明确业务/条件依据 |
| `interactions[]` | object 数组，可空 | 后续用户、人工或环境事件 |
| `interactions[].interactionId` | 非空 string | 交互稳定身份 |
| `interactions[].kind` | `user_message` / `human_decision` / `environment_event` | 交互性质；人工命令不是普通聊天 |
| `interactions[].after` | 屏障/前序命令引用 | 交互送达条件 |
| `interactions[].commandRef` | 非空 string | 必须指向 `setup.commands[].id` |
| `interactions[].actor` | 非空 string | 正式操作者或控制器身份 |
| `interactions[].payload` | JSON | 该事件内容；只在规定条件下投影，不能伪造模型实际答复 |

业务引用严格包含 `id/version/path/assetSha256`：身份、正整数版本、`business/<id>.json` 路径、规范化 JSON 内容摘要；它与普通文件字节 sha256 不同。业务变更 `op/path/value` 仅按白名单和具体声明执行。命令 `arguments`、初态、faults 是不同场景的受约束领域对象，完整键值在任务 JSON 和对应注册声明中，不是任意可执行的通用脚本。

### 3.5 Oracle、检查与可选断言元数据

| 字段 | 类型 / 允许值 | 含义 |
|---|---|---|
| `oracle.graderRef` | 非空 string | 评分器声明；抽取 `reviewed_invoice_extraction`，其他按实际注册声明 |
| `oracle.goldRef` | asset reference，可选 | Gold 只允许 `root=quality`；答案不能投影给产品 |
| `oracle.expectedOutcome` | JSON，可选 | 自然任务终点和独立预期，不是模型指令 |
| `oracle.forbidden` | JSON，可选 | 禁止行为判据，留在质量侧 |
| `oracle.checks[]` | 非空 object 数组 | 任务内的检查项，不是独立任务 |
| `checks[].checkId` | 唯一非空 string | 本任务内的检查身份 |
| `checks[].capabilities[]` | string 数组 | 此项实际测量的能力；可不同于任务全部能力 |
| `checks[].harnessModules[]` | string 数组 | 此项相关逻辑模块，不决定物理目录 |
| `checks[].requirementRefs[]` | string 数组 | 直接要求/指标身份，须可解析 |
| `checks[].evaluationMode` | `A/B/F` | 沿用总方案模式；F/A/B 分别看机制/模型/业务证据 |
| `checks[].criterion` | 非空 string | 人可审查的判定依据 |
| `checks[].assertion` | predicate 或 null | null 仅允许需核验 Gold 的抽取评分；不等于自动通过 |
| `checks[].assertion.path` | `observation.<字段>...` | 从可信观测取值，不能从 Oracle 生成 observation |
| `checks[].assertion.op` | `eq/lte/gte/contains/absent` | 相等/不大于/不小于/包含/缺席；有序比较值须为数值 |
| `checks[].assertion.value` | JSON | 独立预期值；null 也是显式值，不代表丢失 |
| `checks[].assertion.description` | string，可选 | 保留作者说明，不改变比较语义 |
| `checks[].required` | boolean | 是否为该范围必需检查 |
| `checks[].hardConstraint` | boolean | 是否硬约束，不能被平均分掩盖 |
| `checks[].evidenceRequirements[]` | 非空 object 数组 | 所需可信证据 |
| `checks[].evidenceRequirements[].kind` | 非空 string | 实际证据种类 |
| `checks[].evidenceRequirements[].required` | boolean，可选 | 该证据是否必需 |
| `checks[].preconditions[]` | 数组，可空，可选 | 评分前置条件，不能静默替代失败结果 |
| `checks[].preconditions[].path/op/value` | 同 predicate | 前置观测及判断 |
| `checks[].preconditions[].description` | string | 前置条件含义 |
| `checks[].preconditions[].evidence[]` | 非空 string 数组 | 前置条件所需证据 |
| `checks[].sourceRefs[]` | source reference，可选 | 此项实际规范出处，不能全部复制任务级引用 |

### 3.6 引用与全部保留来源元数据

| 字段 | 类型 / 允许值 | 含义 |
|---|---|---|
| `traceability.modRefs[]` | string | MOD 功能覆盖身份 |
| `traceability.rtRefs[]` | string | RT 能力身份；RT-17 与原生 RT-01–16 分开 |
| `traceability.rtcRefs[]` | string | RTC/联合条件追溯 |
| `traceability.harnessModules[]` | string | 多模块逻辑导航 |
| `traceability.legacyIds[]` | string | 注册声明/迁移的旧身份，不保留旧正文 |
| `traceability.sourceRefs[]` | string 或 source reference | 规范/事实依据 |
| asset reference `root` | `project` / `quality` | 项目源根 / 质量数据根 |
| asset reference `path` | 非空相对 POSIX 路径 | 禁止绝对路径、`..`、反斜线、盘符、编码绕过及链接逃逸 |
| asset reference `id` | string，可选 | 引用对象身份 |
| asset reference `version` | 正 integer，可选 | 引用内容版本 |
| asset reference `sha256` | 64 位小写十六进制，可选 | 文件字节摘要 |
| asset reference `bytes` | 非负 integer，可选 | 文件字节数 |
| source reference `path` | string，可选 | 项目内规范相对路径 |
| source reference `spec` | string，可选 | 规范身份/来源元数据 |
| source reference `specSha256` | string，可选 | 引用时固定的规范摘要 |
| source reference `section` | string，可选 | 章节定位 |
| source reference `heading` | string，可选 | 章节标题 |
| source reference `startLine` | integer，可选 | 一起始行，规范变化后需重新核验 |
| source reference `quote` | string，可选 | 支撑当前检查的原文 |
| source reference `quoteSha256` | string，可选 | 引文摘要 |
| source reference `interpretationReview` | JSON，可选 | 保留的条款解释/审阅元数据，不能自动推导人工接受 |

source reference 对象至少有一个已知字段；还允许非空字符串引用。上表完整列出可选来源字段，不能在迁移时因当前例子没用到而删除可解释的元数据。`sha256` 文件字节摘要与规范化 JSON 内容摘要不能混用。

## 四、产品契约和设施自检字段

| 对象 | 必需字段 | 解释 |
|---|---|---|
| product_contract 套件 | `schemaVersion/kind/id/version/harnessModule/scenarios` | 每模块一个文件，不把套件数当场景数 |
| `scenarios[]` | `id/title/setup/exercise/oracle/traceability/applicability/split/leakageGroup/controlRefs` | 一个独立产品契约条件；setup/oracle/追溯沿用上述字典 |
| `exercise.input` | object | 契约触发的获准输入 |
| `exercise.commands[]` | object 数组 | 必须与 setup.commands 完全一致的注册操作 |
| eval_selftest 套件 | `schemaVersion/kind/id/version/scenarios` | 评测设施自检 |
| selftest `scenarios[]` | `id/input/expected/evidenceOrigin` | 合成输入与独立预期 |
| selftest `input` | 声明 episode/合成观测 | 只测试评测设施，不冒充实际产品观测 |
| selftest `expected.checks[]` | 同检查项字典 | 对/错/缺证据的预期评分 |
| selftest `evidenceOrigin` | `synthetic/synthetic_selftest/grader_self_test` | 明示合成来源，禁止计入真实执行 |

## 五、Gold 与业务资料

### 5.1 Gold 外层与字段

`fields` 保存票头、买卖方、币种及金额；`lineItems` 保存全部可见商品行；`extraFields` 保存额外事实。`sourceSnapshot` 固定来源摘要，`sourceEvidence.original` 指向原图，`inputModes` 声明输入条件。`tableEvidenceCandidates` 是解析位置候选，不是已确认答案。`documentNotes/reviewChecklist/blockingReasons` 保存限制与待核验项。

`annotationRef` 指向保留的原图标注记录；`humanVerified/reviewStatus/eligibleForFieldScoring` 分别表示真实人工核验、审核状态和评分资格。`provenance/sourceRefs/creationSpecRefs` 保留来源。初始人工核验 0，不能凭有答案文字启用正式评分；删除旧副本也不能产生审核资格。

| 字段对象参数 | 类型 / 允许值 | 含义 |
|---|---|---|
| `rawValue` | JSON 或 null | 票面原始内容，保留异常与错误 |
| `normalizedValue` | JSON 或 null | 有依据的规范值，不确定或非法字面保持 null |
| `valueState` | `present/source_not_provided/unreadable/ambiguous/not_applicable/invalid_literal` | 已读出候选/票面未提供/不可辨认/歧义/不适用/字面非法 |
| `availableInAllowedInput.parsed_only` | `available/partial/not_available` | 仅解析可得性 |
| `availableInAllowedInput.parsed_with_source_evidence` | 同上 | 获准原图取证后的可得性，不自动授权额外文件 |
| `alternatives[]` | JSON | 有证据的歧义解释，不是猜测纠错 |
| `note` | string | 规范化、歧义或冲突原因 |
| `evidence[]` | object | 原图或解析支持 |
| `evidence[].kind` | `original/parsed` | 证据来源 |
| `evidence[].pageNumber/region/quote` | 页码/语义区域/原文 | 原图定位，不猜像素坐标 |
| `evidence[].pointer/tableRow/tableCell` | JSON Pointer/行/单元格 | 解析定位，按真实合并单元格结构解释 |
| `lineItems[].lineId` | string | 标注行身份 |
| `lineItems[].rowOrdinal` | integer | 原图内顺序 |
| `lineItems[].originalRowLabel` | JSON | 票面行号，不因编号从 4 开始补造 1–3 行 |
| `lineItems[].fields` | 字段对象集合 | 每列沿用字段状态及证据 |

票头：`invoice_number/invoice_date/due_date` 为票号/开票日/到期日；`buyer_*`、`seller_*` 为买卖方名称、地址、税号；`currency/net_amount/tax_amount/total_amount/discount_amount` 为币种/净额/税额/总额/折扣。仅有 `$` 不自动确定 USD 或 CAD。

明细：`description/quantity/unit/unit_price/line_amount/tax_rate/tax_amount` 为描述/数量/单位/单价/行额/税率/税额，适用时保留 `gross_amount/displayed_amount/discount_amount`。型号、包装数和公差不误作数量。额外事实包括 `shipping_handling/paid_amount/balance_due/payment_terms/buyer_invoice_email/document_tax_rate`，分别为运费/已付/余额/付款条款/邮箱/票头税率；不能无依据将票头税率赋给每行。

未来真人核验回执需要真实 `reviewedBy/reviewedAt/acceptedGoldVersion` 与原图证据。字段/额外字段的 `accept/replace`、逐行核对、整行列表替换均须真人决定；批量脚本不能填写审核人或接受结论。当前不生成空白假审核记录。

### 5.2 业务资料和嵌套关系

| 字段 | 含义 |
|---|---|
| `id/version/schemaVersion/split/leakageGroup` | 既有业务包身份、领域结构、用途与分组，不随新任务 Schema 强改 |
| `primaryStructure/design.variant/design.distinguishingConditions` | 主要结构、变体及实质差异；只改 ID 不构成新内容 |
| `input.invoice` | 合成结构化发票与明细；金额为十进制文本 |
| `input.suppliers[]` | 供应商注册身份、别名及有效状态 |
| `input.purchaseOrders[]` | 订单/行与供应商、数量、计量、金额及可用状态 |
| `input.goodsReceipts[]` | 关联订单/行的收货依据 |
| `input.contracts[]` | 合同身份、版本、适用时点和价格关系 |
| `input.balances[]` | 关联对象余额/可用数量，按 asOf 时点判断 |
| `input.historicalEntries[]` | 声明的历史初态，不是本次真实运行 |
| `policy.id/version/authority/enterprisePolicyVerified` | 模拟规则版本、权威来源假设和企业核验状态 |
| `policy.currency/moneyScale/rounding/taxRounding/tolerance` | 币种、金额精度、舍入及容差 |
| `policy.quantityUnit/supplierIdentity/contractSelection` | 计量、供应商识别、合同选择规则 |
| `policy.submissionRequires/financialApprovalTiers/asOf` | 提交前置、保留政策元数据和依据时点；不新增退役审批范围 |
| `initialState.workspaceId/executionMode` | 测试隔离范围与执行模式 |
| `initialState.approvals/humanInteractions` | 声明初态；不得因资料生成自动批准 |
| `initialState.b2b/networkPolicy` | 模拟目标与访问边界 |
| `oracle` | 业务独立答案，不能交给模型 |

关联通过对象 ID、行 ID、版本与时点核对。原票抽取与合成业务分别评分；合成金额不是原图真值。任一业务包完整实体字段以当前 JSON 为准，任务只能使用注册投影和白名单变更。

## 六、索引、报告、成员和权限

清单中的通用文件引用为 `path/bytes/sha256`；场景引用还含 `id/kind/version/scenarioId/suiteId`，用于从一个契约文件定位具体场景。`coverage.directChecks` 下每项由 `assetId/checkId/kind` 组成；`requirementsWithoutDirectCheck` 保留缺口，`unresolvedReferences` 保留无法解析项。标签存在只证明设计引用，不证明整个要求已经覆盖。

`splits.samples` 的 `sampleId/originalSha256/groupId/split/priorUses/groupPriorUses/exposureStatus` 固定来源分组与既有暴露；`splits.assets` 的 `id/split/leakageGroup` 固定当前用途。`formalAcceptanceEligible=false` 和 `reviewStatus` 独立于 split。

制作报告字段：`originals/publisherLabels/gold/humanVerifiedGold/business/agentTasks/taskBudgetMaximum/taskTypeCounts/contractSuites/contractScenarios/selftestSuites/selftestScenarios/benchmarks/actualProductRuns/baselineCount` 分别统计，不能互相相加；`phase/materialStatus/reviewStatus/formalAcceptanceEligible/latestOnly/limitations` 表示状态边界，`specRefs/sourcePins` 绑定规范与来源。

Benchmark 定义的 `id/version/status/sourceRefs/membersRef/assetKinds/baselineRefs` 固定身份、协议版本、规范与成员入口；当前 status 为 `design_candidate`，baselineRefs 为空。成员文件的 `benchmarkId` 指向 BM，`members[]` 的完整通用结构如下：

| 成员字段 | 含义 |
|---|---|
| `assetId/assetKind/path/version/sha256` | 固定任务或产品契约场景的身份、类型、文件及版本摘要 |
| `scenarioId` | 契约场景在套件中的身份，任务没有此字段 |
| `checkIds[]` | 当前 BM 直接测量的检查身份；控制依赖可包含全部检查 |
| `guardCheckIds[]` | 不能被普通聚合分数掩盖的硬约束检查 |
| `split/stage` | 成员用途与最低阶段 |
| `subsets[]` | `capability/regression` 测量目的 |
| `subsetRationale.capability/regression` | 选入该目的的设计理由，不冒充已有回归成绩 |
| `dependencyOnly` | true 为控制依赖，独立统计而不计直接任务覆盖 |
| `controlRefs[]` | 当前成员的控制/比较依赖身份 |
| `requirementRefs[]` | 直接测量要求引用，依赖可为空 |
| `gradingDependencies.graderRef/status` | 评分器声明及可信产品证据依赖，当前未就绪 |

Benchmark 统计的 `agentTasks/contractScenarios/controls/actualProductRuns` 分开计算；多 BM 成员不能相加为独立任务数量。空 BM-10 是真实状态，不以模拟记录填充。

`migration.records[].oldId/oldVersion/oldDigest/newId/disposition/reason` 保存身份去向；`represented` 表示重组后有代表，`retired_from_initial_budget` 表示初始预算内未选入，不自动表示对应要求不再需要。

| 数据/通道 | 可见权限 |
|---|---|
| `task` 授权投影 | 产品/主 Agent，只能在对应任务范围读取 |
| 子 Agent | 父级权限、任务范围和子 Scope 的交集，不自动继承全部材料 |
| `setup/interactions` | 可信控制器；仅把当时允许的事件/消息交付产品 |
| 分类、目标失败模式、Oracle、Gold、标签、规范、评分器、其他 Trial | 质量侧，整个 `agent-eval/` 必须从 Agent 发现/读取范围排除 |
| 目标系统独立台账与采证 | 可信采集器，输出受控证据；不得由预期答案造观测 |

## 七、查询、评分掩码和操作

```powershell
python agent-eval/tools/comprehensive/initial_dataset.py prepare --project .
python agent-eval/tools/comprehensive/initial_dataset.py verify --project .
python agent-eval/tools/comprehensive/initial_dataset.py report --project .
python agent-eval/src/runner/initial_dataset.py BM-08 --project . --stage P2 --split development --subset capability
```

Runner 当前只选集、绑定和报告阻断。`--stage` 为当前阶段，`--split` 是用途，`--subset capability/regression` 是测量目的；控制依赖单列，不能因不计直接分而移除。需要批量工具时从固定 JSON 按需导出 JSONL，保留 ID/版本/摘要，不建立第二编辑源。

```python
import json
from pathlib import Path
tasks = [json.loads(p.read_text(encoding='utf-8'))
         for p in Path('agent-eval/data/cases').glob('*.json')]
selected = [t for t in tasks if t['split'] == 'development'
            and 'tool_use' in t['classification']['capabilities']]
long_tasks = [t for t in tasks if t['classification']['taskShape']['longHorizon']]
matching = [t for t in tasks if t['classification']['business']['primaryTaskType'] == 'matching']
```

阶段掩码只选择适用 checkId；输入可得性掩码区分 parsed_only 与获准原图；证据掩码区分可判、缺证据、不适用。必需检查不能因失败静默剔除，blocked/未运行不是 FAIL 也不是 PASS。模型违规、控制拦截、实际后果和正常对照误拒分别统计；原始候选、人工修订后结果和权威提交结果分别评分。

MOD 是产品功能索引，RT 是运行机制，RTC 是具体条件族，RTX 是跨机制场景，BM 是测量协议，P0–P13 是功能阶段。BM-11 覆盖 RT-01–16；RT-17 为第三方 pi-subagents，由 BM-12 单列。BM-06 退役；BM-10 无真实业务样本。完整 MOD/RT/BM/阶段表和变更选集方法见[使用指南](../docs/data/data-usage-guide.md)。

Baseline 必须绑定真实候选、环境、协议、成员、Gold/Grader 版本及执行证据。等待/UNKNOWN 不等于完成，Run 成功不等于业务成功，请求批准不等于正式批准。数据准备不授予任何生产写权限。
'''


def render_data_readme(report: dict, example: dict) -> str:
    """Return a deterministic Chinese manual; counts always come from report."""
    labels = [('originals', '原票及配对解析'), ('publisherLabels', '提供方标签'),
              ('gold', '保留 Gold'), ('humanVerifiedGold', '真人核验 Gold'),
              ('business', '模拟业务包'), ('agentTasks', '完整 Agent 任务'),
              ('contractSuites', '产品契约套件'), ('contractScenarios', '产品契约场景'),
              ('selftestScenarios', '评测设施自检场景'), ('actualProductRuns', '真实产品运行'),
              ('baselineCount', 'Baseline')]
    rows = '\n'.join(f'| {label} | {_cell(report.get(key, "未提供"))} |' for key, label in labels)
    types = '\n'.join(f'| `{_cell(key)}` | {_cell(value)} |'
                      for key, value in sorted(report.get('taskTypeCounts', {}).items()))
    header = f'''# Flowmate 初始评测数据手册

本文件由当前制作报告生成。只有最新活动材料；产品未实现并接入，所有产品执行保持 blocked。文件、检查项、自检通过和入库数量都不是 Agent 成绩。规范与过程参见[制作方案](../docs/data/data-preparation.md)和[对齐方案](../docs/data/data-alignment-plan.md)。

## 一、当前真实数量

| 对象 | 数量 |
|---|---:|
{rows}

完整任务预算最多 {report.get('taskBudgetMaximum', 100)}，六类上限依次为抽取 20、匹配 20、人工协同 15、证据取用 15、恢复 15、提交 15；不为填满预算制造重复。当前实际任务族分布：

| 类型 | 数量 |
|---|---:|
{types}

11 个有效 Benchmark 身份保留，BM-06 退役、BM-10 无真实样本。Gold 人工核验状态按报告保留；AI 标注不计真人核验。正式验收资格为 `{str(report.get('formalAcceptanceEligible', False)).lower()}`，材料状态 `{report.get('materialStatus', 'design_materials_prepared')}`，审核状态 `{report.get('reviewStatus', 'pending')}`。最终数量和摘要以[制作报告](manifests/preparation-report.json)及[库存](manifests/inventory.json)为准。
'''
    cleanup=report.get('cleanup',{})
    if cleanup.get('remainingPaths'):
        header += '\n## 项目外层旧暂存清理状态\n\n当前 `agent-eval/data/` 已替换为最新材料。以下旧暂存目录的删除被执行策略阻止，尚未清理；它们不参与当前评测清单：\n\n'
        header += '\n'.join(f'- `{row["path"]}`：{row["files"]} 个文件，{row["bytes"]} 字节。' for row in cleanup['remainingPaths'])
        header += '\n\n不能把当前活动数据已更新表述为整个项目的旧副本均已删除。\n'
    fields = sorted(set(_observed_fields(example)))
    observed = '\n'.join(f'| `{_cell(path)}` | `{kind}` |' for path, kind in fields)
    return header + MANUAL + f'''

## 八、当前完整任务示例及嵌套字段核对

下面是当前集合的真实代表任务，不是产品输出。其 context、初态和参数保留源值；阅读它属于质量侧工作，不能把完整 JSON 交给被测 Agent。可选字段以第三章字典为准，示例未出现不代表不允许。

```json
{json.dumps(example, ensure_ascii=False, indent=2, allow_nan=False)}
```

下表逐层列出示例实际字段，供核对嵌套结构；`dict/list/str/int/bool/NoneType` 分别对应 JSON object/array/string/integer/boolean/null。字段语义、允许值、可见性及可选元数据见第三至六章。

| 字段路径 | 实际类型 |
|---|---|
{observed}
'''
