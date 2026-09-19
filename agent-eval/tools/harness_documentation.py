"""Refresh a staged data manual, retaining its reviewed parameter dictionaries.

Only README.md below the supplied data root is written. Publication, inventory
updates and all source specification changes belong to the migration caller.
"""
from __future__ import annotations

from collections import Counter
import json
from pathlib import Path
import re

from harness_modules import MODULES


MODULE_EXAMPLES = {
    'foundation': ('员工配置、解析文件与 Workspace 初态', '触发初始化、导入或组装失败', '核对 ready 屏障、输入摘要及持久化身份'),
    'agent-runtime': ('任务输入、Provider 参数与获准原票', '调用真实模型并推进原生 Loop', '核对模型请求、工具回送、结束原因和字段/澄清输出'),
    'tools': ('ToolSpec、权限和带边界的工具参数', '调用、取消或拒绝工具', '核对 Gateway 决定、实际执行、副作用及结构化结果'),
    'events': ('订阅者、事件序列与流式消息', '重复投递、断流或订阅者失败', '核对事件次序、身份、投影与 Trace；不靠最终文本推断过程'),
    'sessions': ('Session 身份、绑定、待消费输入和分支点', '恢复、续接、steer、followUp、取消或关闭', '核对消费次序、generation、分支历史与实际取消传播'),
    'context': ('当前资料选择、权限与版本', '构建 Context 并调用模型', '核对获准快照、当前事实及本次实际模型调用的关联'),
    'memory': ('数据库中的完整原生历史与来源引用', '写入、恢复、损坏或修订后续接', '核对历史完整性、权威来源及实际读取；不手写 SDK 成功历史'),
    'compaction': ('原生会话、压缩阈值和当前事实', '触发重复压缩、失败或取消', '核对原生压缩事件、保留事实及后续模型输入'),
    'workflow': ('模拟发票、供应商、订单、收货及步骤初态', '校验匹配、人工修订或并发推进', '核对差额、候选、StepAttempt、Waiting 和业务修订'),
    'prompt-skills': ('任务目标、Prompt、Skill/SOP 与资源版本', '选择适用资源或处理冲突和注入', '核对装载清单、版本、工具决策与证据不足时的处理'),
    'extensions': ('扩展清单、Hook 与命令配置', '装载、转换、失败、停用或清理', '核对实际 Hook 调用、工具准入和扩展生命周期'),
    'subagents': ('父子会话、命名槽位、只读范围和共享预算', '真实委派、冲突、父取消或父恢复', '核对子会话身份、实际调用、权限交集和资源释放'),
    'actions': ('预览载荷、附件、目标、确认与目标系统台账', '确认、发送、响应丢失、接管或 UNKNOWN 核对', '核对 payloadHash、授权事实、持久动作、防重与权威回读'),
    'operations': ('Host、凭证、发布、预算与备份初态', '断连、停写、恢复、迁移失败或清理', '核对故障传播、版本绑定、恢复结果与受保护资产'),
    'eval-infrastructure': ('Case/Gold、Trial 调度和观测证据', '执行设施自检、缺证据评分或重算报告', '核对成员、摘要、分母、可信证据与判定；自检不计产品成绩'),
}

# Meanings of the controlled initial-state parameters, not translations inferred
# from CamelCase. A new parameter must acquire a definition before publication.
STATE_PARAMETERS = {
    'manifestVersion': '待索引并绑定 Job/Run 的资源清单版本',
    'workspaceStatus': '当前工作空间的准入状态',
    'mutateFileAfterIndex': '是否在建立清单摘要之后修改被索引文件',
    'removeIndexedFile': '是否移除清单已登记的文件以测试装载拒绝',
    'manifestWorkspace': '资源清单声明归属的工作空间，用于测试跨空间错配',
    'inputCount': '输入清单中的原始文档数量',
    'externalParsedCount': '外部已解析文档数量，用于核对与原件配对',
    'datasetVersion': '输入数据集固定版本，重启后必须重新验证身份',
    'captureTurns': '通过真实适配器需要执行并采集的会话轮数',
    'readPageSize': '分页读取会话或历史的每页条数，需验证全部分页',
    'nativeSessionFilesEnabled': '是否启用原生会话文件；关闭时仍要求数据库历史完整',
    'captureSessionCount': '需要真实创建并采集的不同会话数量',
    'captureInitialEntries': '需要从真实会话取得的初始原生条目数',
    'metadataVersion': '产品会话元数据的并发版本，独立于原生历史提交版本推进',
    'storageVersion': '原生历史及游标持久提交的并发版本，用于条件更新；不是数据库schema版本',
    'persistenceEnabled': '是否启用会话持久化能力，关闭不能声称恢复成功',
    'captureTypes': '需要真实采集的原生条目类型集合',
    'customPayload': '需要往返保留的自定义原生条目载荷',
    'repeatCapturedEntry': '是否重复写入同一已采集条目，以验证幂等',
    'captureValidBatchBeforeMutation': '是否先采集合法历史批次再注入单一损坏',
    'nativeTree': '需要由原生适配器产生的分支树形态',
    'nativeFormat': '恢复时要求识别的原生历史格式',
    'branchFrom': '分支起点的原生条目或历史位置',
    'captureNativeSummaries': '是否需要真实捕获 SDK 压缩摘要条目',
    'approvedRevision': '已有人工确认所绑定的业务修订',
    'currentRevision': '运行开始时当前生效的业务修订',
    'snapshotAlias': '本例上下文快照的局部引用名',
    'currentGeneration': '当前活动绑定代次，旧代次不得写入或消费',
    'sessionState': '提交输入前的会话生命周期状态；closed 表示句柄已关闭，后续 steer 不得被消费或复活运行',
    'snapshotAliases': '用于区分多个上下文快照的局部名称',
    'captureValidContext': '是否先通过真实入口建立有效上下文再注入变化',
    'currentSnapshotAlias': '本轮模型调用应使用的当前快照引用',
    'repeatCount': '同一请求或存储操作重复触发的次数',
    'runtimeInitialContext': 'Runtime 初始上下文状态，不应被评测器补造历史',
    'exportFilesPresent': '导出文件是否存在；缺少导出不应取代数据库历史权威性',
    'contextSnapshotsEnabled': '上下文快照能力是否开启，关闭时须明确限制',
    'nativeMutations': '需要实际产生并持久化的原生历史变更',
    'holdLoopAfterFirstEntry': '是否在首个原生条目之后阻塞 Loop 以测试中断边界',
    'productTitle': '产品会话标题，不能冒充原生历史消息',
    'eventGeneration': '延迟事件携带的绑定代次，用于测试失效事件拒绝',
    'interruptAfterToolStarted': '是否在工具已经开始后中断，验证已发生事实保存',
    'enabledChildModes': '本场景明确启用的子 Agent 运行模式',
    'requestedSlots': '请求分配的命名子 Agent 槽位',
    'repeatAdmissionCount': '相同子 Agent 准入请求重复次数',
    'identityReturnOrder': '多个子会话身份返回顺序，测试乱序关联',
    'failSlot': '需要注入启动失败的具体子 Agent 槽位',
    'crashPoint': '计划令进程崩溃的事务或生命周期位置',
    'revision': '本场景开始时对象的业务修订号',
    'requiredChecks': '评估快照必须具备的校验项集合',
    'assessmentVersion': '当前评估快照版本',
    'concurrentPublishers': '同时发布评估结果的执行者数量',
    'lateResultRevision': '晚到校验结果绑定的旧业务修订',
    'availableChecks': '当前确实已取得结果的校验项集合',
    'total': '合成发票总额；不得用于原图字段评分',
    'evidenceVersion': '校验依据或证据版本，变动需触发重新评估',
    'ruleVersionBefore': '规则变更前用于评估的版本',
    'ruleVersionAfter': '规则变更后的当前版本',
    'requestKey': '输入或命令的幂等请求键',
    'runBusy': '运行是否正在忙，决定输入受理后的交付安排',
    'waitingField': '当前向操作员等待澄清的字段',
    'initialAnswer': '对已有澄清请求先前给出的回答',
    'interactionRevision': '人工交互所绑定的业务修订',
    'interactionKind': '人工业务交互类型，不能提升为正式动作确认',
    'actorRole': '受信命令执行者角色，文本自称角色不构成授权',
    'actionState': '持久业务动作的执行前状态',
    'basisVersion': '人工交互或确认所依据内容的版本',
    'approvedAction': '现有正式确认绑定的具体动作',
    'requestedAction': '本次尝试派发的具体动作，须与确认一致',
    'fixtureClock': '控制器提供的固定测试时钟',
    'expiresAt': '人工确认或授权的到期时间，与测试时钟比较',
    'expectedVersion': '请求携带的乐观并发预期版本',
    'currentVersion': '持久对象当前版本，旧版本命令应拒绝',
    'submittedTokenType': '提交给正式确认入口的令牌类别，用于测试非法提升',
    'text': '合成文本输入；不能凭自然语言构成正式授权',
    'actionSent': '测试初态中动作是否已经发送，用于撤销和补偿边界',
    'approvedBasis': '现有确认固定的目标、载荷或依据内容',
    'currentBasis': '当前实际动作使用的目标、载荷或依据内容',
    'firstApprovalAlias': '首个正式确认的局部身份引用',
    'objects': '本例参与防重或关联核验的业务对象集合',
    'target': '合成本地业务目标及其身份',
    'jobs': '参与并发或跨 Job 防重的任务集合',
    'businessObject': '跨尝试共享的同一逻辑业务对象',
    'firstAttemptState': '首次发送尝试在恢复前的持久状态',
    'actionApproval': '动作层已有确认状态，重试不能自动扩大授权',
    'targetVisibility': '目标端结果可见性，决定能否权威确认成功或未发生',
    'targetContract': '目标系统声明的幂等、查询或重试语义',
    'oldAttemptState': '被替换或核对的旧动作尝试状态',
    'oldResourceState': '旧尝试占用的资源状态，验证释放和新尝试的一致性',
    'retryContract': '允许创建下一次尝试的已声明重试契约',
    'readToolFixture': '只读工具返回的合成资料，用于模型决策验证',
    'availableDocuments': '当前实际可用的获准文档范围',
    'independentChecks': '可独立并行执行的业务核对项',
    'targetOrganization': '提交目标组织身份，必须纳入预览与确认绑定',
    'lineCount': '合成发票的明细行数',
    'attachmentCount': '提交载荷所关联的附件数量',
    'frozenRevision': '提交预览固定的业务修订，修改后不得复用旧确认',
    'fixturePage': '本地浏览器测试页面的状态或类别',
    'fixtureLoginMode': '本地页面预设登录模式，不能跳过实际认证边界',
    'initialPageOwner': '浏览器页面初始控制者身份',
    'domTransform': '页面 DOM 的受控变化，用于测试语义定位稳定性',
    'environment': '当前运行环境身份，例如隔离本地测试环境',
    'credentialRef': '凭证引用身份，仅由可信环境解析，不是秘密明文',
    'trustedEnvironment': '控制器认定的受信运行环境',
    'requestedEnvironment': '请求尝试使用的环境，需校验与受信环境一致',
    'credentialStatus': '当前凭证可用、失效或撤销状态',
    'otherAccountAvailable': '是否存在其他账号，用于证明不能静默切换身份',
    'initialEnvironment': '环境切换或撤销发生前的运行环境',
    'qualityConclusion': '已有质量结论状态，不能单独授予生产写权限',
    'qualityConclusionScope': '质量结论适用的版本、环境和能力范围',
    'oldVersion': '旧运行固定的版本，发布后不应静默漂移',
    'trialCount': '计划执行的独立 Trial 数量',
    'providerMode': 'fixed 或 live Provider 模式，机制与真实模型行为分别统计',
    'k': '重复试验次数，每次必须隔离身份、状态和费用',
    'batchSize': '调度批次内 Trial 总数',
    'concurrency': '允许同时执行的 Trial 数量',
    'trialAlias': '当前待评分 Trial 的局部身份',
    'evidenceTrialAlias': '待加载证据所宣称的 Trial，用于拒绝错配',
    'faultPurpose': '故障归属产品用例或设施，不能把产品故障剔出分母',
    'missingRequiredEvidence': '本场景是否故意缺失必要证据以验证不可判定',
    'recoveryMode': '恢复来源和隔离方式，例如受控备份副本',
    'faultBarrier': '在已提交身份之后等具体屏障处触发崩溃',
    'oldHostStopRequired': '恢复副本运行前必须停止旧 Host，避免并发控制或重复动作',
}

COMMAND_PARAMETERS = {
    'version': '该操作读取、写入或发布的对象版本',
    'field': '本次受控变更的字段名，不修改其他条件',
    'alias': '新建对象在本场景后续命令中的局部引用名',
    'job': '该操作作用的 Job 局部引用，必须解析为真实身份',
    'environment': '本次操作申请的环境身份',
    'scope': '本次操作生效的工作空间或授权范围',
    'kind': '当前操作的变更、损坏或输入类型',
    'count': '该操作需要创建、采集或处理的数量',
    'target': '本次操作指向的对象、条目或目标身份',
    'iterateAllPages': '是否遍历所有分页，以验证非首页数据完整性',
    'expectedVersion': '请求持有的对象预期版本；与当前不符必须拒绝',
    'expectedStorageVersion': '请求要求的持久存储版本',
    'from': '恢复或分支所依据的起始位置',
    'context': '本次调用明确关联的上下文快照引用',
    'nested': '是否执行嵌套操作，用于验证事务或原生自定义结构',
    'title': '本次操作设置的产品标题文本',
    'slot': '本次子 Agent 操作占用的命名槽位',
    'check': '本次发布或消费的具体校验项',
    'order': '并发结果发布或命令执行的指定先后次序',
    'revision': '本次命令绑定的业务修订',
    'evidenceVersion': '本次发布评估结果绑定的证据版本，恢复后须与业务修订及评估快照一致',
    'generation': '本次命令携带的活动绑定代次',
    'total': '此次人工修订后的合成发票总额',
    'requestKey': '本次命令的幂等请求键，重复请求应关联原命令',
    'content': '本次提交给正式输入入口的内容',
    'mutation': '合法底包上仅在本次操作引入的受控变化',
    'purchaseOrder': '人工业务回答提供的合成订单身份',
    'responseKey': '回答或交互响应的幂等关联键',
    'text': '本次操作提交的自然语言文本，不能替代正式授权',
    'basis': '本次正式确认所绑定的依据快照',
    'fixtureResponse': '可信适配器向目标模拟器安排的响应行为',
    'k': '本次调度申请的独立重复 Trial 次数',
}


def _cell(value):
    if not isinstance(value, str):
        value = json.dumps(value, ensure_ascii=False, sort_keys=True)
    return value.replace('|', '&#124;').replace('\n', ' ').replace('\r', ' ')


def module_table(cases=None):
    counts = Counter(c['harnessModule'] for c in cases) if cases is not None else None
    rows = ['| 目录 / 中文职责 | 对应 MOD / RT | 输入、触发与检查证据 | 当前实例 |', '|---|---|---|---|']
    for key, (name, scope, mods, rts) in MODULES.items():
        inputs, trigger, evidence = MODULE_EXAMPLES[key]
        count = str(counts[key]) if counts is not None else '见 module-catalog'
        rows.append(f'| `cases/{key}/`：{name}；{scope} | {", ".join(mods + rts) or "以检查项映射为准"} | 输入：{inputs}；触发：{trigger}；证据：{evidence} | {count} |')
    return '\n'.join(rows)


CASE_PARAMETERS = '''### 5.5 Harness 模块与场景契约

| 参数 | 含义、用法与边界 |
|---|---|
| `harnessModule` | 唯一主责模块，决定 `cases/<harnessModule>/<id>.json` 物理路径；例如 `sessions` 表示主测会话生命周期 |
| `relatedHarnessModules[]` | 参与当前场景的其他模块；用于导航，不复制 Case，也不能单凭关联声明覆盖 |
| `category` / `familyId` | 兼容既有物化、业务逻辑分派与场景身份；extraction/runtime 等旧类别不再决定物理目录 |
| `caseSummary.input/trigger/expected` | 中文说明当前输入、触发动作和预期行为，帮助人在打开用例后理解检查目的；实际判定仍读取 Oracle |
| `subcapabilityRefs[]` | 检查级细分能力引用，在 requirements 中解析原文、来源摘要和阶段；集合不等于整模块完成 |
| `harnessScenarioId` | 新增场景稳定键，关联工具中审查过的 SCENARIOS 配置；未知键必须报错，不能用默认成功场景兜底 |
| `initialEnvironment.scenarioSetup.conditions.harnessScenarioId` | 在旧 conditions 契约中传递同一新增场景身份，供可信物化器选择场景；不包含预期答案 |
| `variant` | 当前场景的正常、失败、边界等具体变化身份；结合初态、故障和断言判断差异，不以换 ID 充当新增覆盖 |
| `sampleRole=synthetic_only` / `sampleId=null` | 纯机制场景无真实原票依赖；不能为了凑样本为其绑定无关原票 |
| `evaluationMode` / `fab` | F、A、B 准备及实际执行分别记录；只准备一种模式时，其余模式仍列入缺口 |
| `executionEligibility` / `dependencies[]` / `blockedUntil[]` | 当前依赖和执行限制；已构造离线输入不等于可运行，更不等于已通过 |
| `enabledMode` | 场景适用的能力启用前提，必须与阶段实际能力核对；不能用晚期机制作为早期硬要求 |
| `revisionProvenance` | 上一内容版本、摘要、旧路径和历史归档关系；变更后的用例不继承旧人工审核 |
| `oracle.checks[].harnessModule` / `coverageScope` | 检查项的模块归属与覆盖范围；只有有对应断言和证据的细项计作准备覆盖 |
| `oracle.checks[].implementationDependency` | 尚未实现的证据规则所需适配器；例如实际输入投影与调用主体来源核验。该检查保持 required=true、ruleStatus=unimplemented，会阻断整例通过 |

例如：会话恢复用例可以主属 `sessions` 并关联 `memory`，先构造绑定和输入队列，再触发恢复，分别验证原生历史、输入消费与失效绑定拒绝。Case 只保存一次；按阶段、模式或 Benchmark 查找时读取清单视图。

### 5.6 新场景配置与可信物化计划

这些参数由质量工具中的 `harness_scenarios.SCENARIOS` 提供；场景配置不能整体投影给模型。产品输入只来自明确的输入投影，期望结果只交给评分器。

| 场景配置参数 | 含义及读取者 |
|---|---|
| `id/module/category/title` | 稳定场景键、主责模块、兼容分派类别与中文名称；质量控制器用于定位唯一场景 |
| `input` / `trigger` | 获准产品输入对象与需执行的具体触发；input 的 task 为任务文本，documents 为本例获准合成资料 |
| `phase` / `mode` / `variant` | 最早适用阶段、F/A/B 模式及独立条件变化；与 requirements 的适用边界共同检查 |
| `input.documents[].id/text` | 文档的合成身份与正文；不包含 expected、Oracle、Gold 或评分答案 |
| `initialState` | 可信控制器设置的运行前状态，包括场景条件、身份、配置、持久事实；不是本轮已经执行的观测 |
| `commands[]` | 控制器按次序触发的动作及参数，例如恢复会话或发送输入；这些是计划，不是执行记录 |
| `commands[].operation/parameters` | 声明操作名及其参数，不冒充已经实现的产品 API；真实适配器须按契约执行并采证 |
| `faults` | 仅由可信适配器注入的故障位置、类型和参数；必须与合法底包及本场景判据相符 |
| `faults[].at/inject` | 故障注入屏障与故障类型，例如在上下文插入和 Run 指针更新之间令数据库写入失败 |
| `expected[]` | 评分用原子断言；每项 path 指观测路径，op 指比较算子，value 指固定比较值，description 解释正确行为 |
| `expected[].requirementKeys[]` | 此条断言实际支撑的条款键；必须具体对应观察事实，不能把全模块要求复制到每条断言 |
| `forbidden[]` | 本场景禁止出现的动作或后果；即使最终文本正确，也不能掩盖已发生的禁止行为 |
| `evidence[]` | 必需的可信证据类型，如原生事件、网关记录或权威台账；缺失时不能通过 |
| `refs[]` / `requirementKeys[]` | 场景导航引用与细分条款引用；最终覆盖以 oracle.checks 的对应关系重算 |
| `sourceSection` / `sourceAnchor` | 源方案章节及可定位的原文锚点；生成需求记录时保存行号、原文与摘要 |
| `normalControlId` | 独立合法对照场景键；挑战场景需要同用途、同操作的对照真实证据，不能填入一个 pass 代替 |
| `relatedModules[]` | 其他参与模块，仅提供导航关联；不建立重复 Case |
| `requiredCapability` / `observationScope` | 执行依赖及允许采证对象范围；避免无关运行事实满足当前断言 |
| `enabledMode.required/disabledDisposition/countsAsExecutedWhenDisabled` | 必需能力列表、未启用时的 NOT_RUN 限制说明、关闭能力时不能计作已执行 |
| `adapterRequirements.status/commandSemantics/executionStatus` | 适配器待接入状态、操作声明的解释边界、当前 NOT_RUN；不是已实现产品接口 |
| `adapterRequirements.nativeEvidenceRequired/nativeFixtureSource/syntheticNativeHistoryAllowed` | 是否必须真实原生证据、锁定适配器来源、禁止伪造原生历史的约束 |
| `initialState.fixtureOrigin/workspace` | 合成测试初态来源与工作空间身份，不能当实际业务数据或执行记录 |
| `initialState.nativeSetup.method/fixtureStatus/persistedEntriesProvided` | 通过真实适配器创建和采集历史的方法、尚待采集状态、未提供伪造持久条目 |

新增场景逐项参数、具体值与行为解释见附录 C。配置中的预设状态只能帮助安排实验；评分必须使用实际执行后独立采集的证据。
'''


def _replace_section(text, start, end, body):
    left = text.index(start)
    right = text.index(end, left)
    return text[:left] + (body.rstrip() + '\n\n' if body else '') + text[right:]


def _scenario_appendix(specs):
    lines = ['## 附录 C：新增 Harness 场景的输入、控制参数与逐项判据', '',
             '以下逐场景列出受控状态和操作的实际配置。每条断言说明对应行为，参数值只描述实验安排，不证明本轮发生过该行为。', '']
    for spec in specs:
        lines += [f"### `{spec['id']}`：{spec['title']}", '',
                  f"主责 `{spec['module']}`；阶段 `{spec['phase']}`；变化 `{spec['variant']}`。输入任务：{spec['input'].get('task', '')}", '',
                  '触发：' + str(spec['trigger']), '', '| 参数位置 | 当前配置及具体用途 |', '|---|---|']
        for name, meaning in [('input', '获准产品输入'), ('commands', '控制器按所列顺序触发操作，各 parameters 只作用于本次操作'), ('faults', 'at 标明故障注入屏障，inject 标明注入类型')]:
            if name in spec:
                lines.append(f'| `{name}` | {meaning}：`{_cell(spec[name])}` |')
        for key, value in spec['initialState'].get('conditions', {}).items():
            if key not in STATE_PARAMETERS:
                raise ValueError('Missing Harness parameter explanation: ' + key)
            lines.append(f'| `initialState.conditions.{key}` | {STATE_PARAMETERS[key]}；当前值 `{_cell(value)}` |')
        for index, command in enumerate(spec['commands']):
            for key, value in command['parameters'].items():
                if key not in COMMAND_PARAMETERS:
                    raise ValueError('Missing command parameter explanation: ' + key)
                lines.append(f'| `commands[{index}].parameters.{key}` | {COMMAND_PARAMETERS[key]}；操作 `{command["operation"]}`，当前值 `{_cell(value)}` |')
        lines += ['', '| 观测路径 | 正确行为及比较要求 |', '|---|---|']
        for assertion in spec['expected']:
            description = assertion.get('description')
            if not description:
                raise ValueError('Missing expected description: ' + spec['id'] + ':' + assertion['path'])
            lines.append(f"| `{assertion['path']}` | {_cell(description)}；`{assertion['op']}` 比较 `{_cell(assertion.get('value'))}` |")
        lines += ['', '必需证据：' + _cell(spec['evidence']) + '。', '', '禁止行为：' + _cell(spec['forbidden']) + '。', '']
    return '\n'.join(lines)


def refresh_documents(output, cases, requirements, report):
    """Update ONLY the copied complete README in output; preserve old dictionaries."""
    from harness_scenarios import SCENARIOS
    from harness_storage_supplement import STATE_PARAMETERS as storage_state, COMMAND_PARAMETERS as storage_commands
    from harness_runtime_supplement import STATE_PARAMETERS as runtime_state, COMMAND_PARAMETERS as runtime_commands
    STATE_PARAMETERS.update(storage_state)
    STATE_PARAMETERS.update(runtime_state)
    COMMAND_PARAMETERS.update(storage_commands)
    COMMAND_PARAMETERS.update(runtime_commands)
    from invoice_data_readme import _appendices

    cases = list(cases)
    if report.get('caseDrafts', len(cases)) != len(cases):
        raise ValueError('README case count differs from preparation report')
    target = Path(output) / 'README.md'
    text = target.read_text(encoding='utf-8-sig').replace('\r\n', '\n')
    benchmark_marker = '\n## Benchmark 定义、成员与参数\n'
    has_benchmarks = benchmark_marker in text or (Path(output)/'manifests/benchmarks/index.json').exists()
    text = text.split(benchmark_marker, 1)[0]
    from harness_paths import canonical_case_path
    for case in cases:
        text = text.replace(f"cases/{case['category']}/{case['id']}.json", canonical_case_path(case))
    # Idempotence: our additions are regenerated, all earlier manual prose remains.
    if '\n## 附录 C：' in text:
        text = text.split('\n## 附录 C：', 1)[0] + '\n'
    if '### 5.5 Harness 模块与场景契约' in text:
        text = _replace_section(text, '### 5.5 Harness 模块与场景契约', '## 六、', '')
    tree = '\n'.join(('│  ├─ ' if i < len(MODULES)-1 else '│  └─ ') + key + '/<caseId>.json' for i, key in enumerate(MODULES))
    text = re.sub(r'(?m)^│  ├─ extraction/<caseId>\.json\n(?:│.*\n)*?│  └─ platform/<caseId>\.json', tree, text)
    # Also refresh an already-migrated tree.
    text = re.sub(r'(?m)^│  ├─ foundation/<caseId>\.json\n(?:│.*\n)*?│  └─ eval-infrastructure/<caseId>\.json', tree, text)
    text = re.sub(r'(?m)^\| `cases/(?:extraction|matching|approval|submission|runtime|isolation|platform)/` \|.*\n', '', text)
    if '### 1.4 十五个 Harness 功能目录' in text:
        text = _replace_section(text, '### 1.4 十五个 Harness 功能目录', '## 二、', '')
    text = text.replace('## 二、', '### 1.4 十五个 Harness 功能目录\n\n' + module_table(cases) + '\n\n主责目录不代表该模块已完整覆盖。`module-catalog.json` 保存模块成员和检查映射；`coverage.json` 报告具体缺口。\n\n## 二、', 1)
    text = re.sub(r'^\| 评测用例 \|.*$', f'| 评测用例 | {len(cases):,} | 十五个功能目录；既有 5,577 例保留身份，新增独立场景以迁移清单为准 |', text, flags=re.M)
    text = re.sub(r'^\| 离线夹具 \|.*$', '| 离线夹具 | 见 materialization/report.json | 离线输入与控制计划已构造不代表产品已执行 |', text, flags=re.M)
    text = re.sub(r'^\| 额外重复实例 \|.*$', f"| 额外重复实例 | {report.get('replicaInstancesBeyondFirst', '见 preparation-report.json')} | 同语义键首例以外的实例，不增加独立覆盖 |", text, flags=re.M)
    text = text.replace('用例身份、修订、七类分类、场景族、名称', '用例身份、修订、兼容分派类别、场景族、名称')
    text = text.replace('七类数量、已涉及族数、未涉及族', '兼容分派类别数量、已涉及族数、未涉及族')
    text = text.replace('1200/600/5577', f'1200/600/{len(cases)}')
    text = text.replace('实际接收的 Gold 修订，当前 null', '实际接收的 Gold 修订；当前已发布为 2，历史候选快照可为 null')
    text = text.replace('核验候选数、实际人工核验数、准备阶段的接收 Gold 快照计数；实际评分资格须看当前 Gold 及审核记录', '核验候选数、实际人工核验原票数、已接收的字段答案与澄清预期 Gold 数；当前后两项均为 1,200，不表示产品验收通过')
    text = text.replace('## 六、', CASE_PARAMETERS + '\n## 六、', 1)
    # Extend the original full A/B dictionaries before asking the existing reader
    # to regenerate observed keys; unknown legacy keys still fail explicitly.
    if '| `harnessScenarioId` |' not in text.split('## 附录 A：', 1)[1]:
        text = text.replace('## 附录 B：', '| `harnessScenarioId` | string | 新增场景稳定键；选择附录 C 对应的可信初态、操作和故障计划，不携带预期答案 | runtime, platform, isolation |\n\n## 附录 B：', 1)
    known_paths = set(re.findall(r'^\| `([^`]+)` \|', text.split('## 附录 B：', 1)[1], flags=re.M))
    for spec in SCENARIOS:
        for assertion in spec['expected']:
            if assertion['path'] not in known_paths:
                description = assertion.get('description')
                if not description:
                    raise ValueError('Missing assertion explanation: ' + assertion['path'])
                text += f"\n| `{assertion['path']}` | {_cell(description)} | 具体比较值见 Case |\n"
                known_paths.add(assertion['path'])
    text = _appendices(text, cases)
    text += '\n' + _scenario_appendix(SCENARIOS)
    text += '\n## Harness 清单阅读与迁移命令\n\n' + '''`module-catalog.json` 的 modules[].id/name/responsibility/path 为目录身份、中文名称、职责与路径；caseIds/caseCount/scenarioFamilies 是当前成员及场景族；checks 逐项记录 Case/版本/检查/条款/模式/阶段；requiredSubcapabilities 列出需要核验的细项。preparedModes、variantCounts 统计材料准备，actualRunCount 才是实际运行计数。缺口以 coverage 和执行依赖为准。

`module-catalog.json` 的 `facilityObligations` 单独登记评测治理要求。requirementId/subject 对应条款与主题，facilities[].path/symbol 指实际工具或测试入口，gaps 是尚缺的审核、冻结、企业依据或产品证据。status 表示待验证/责任人审查；actualFacilityRuns/actualProductRuns 仅记录已归档运行，当前为 0；productCaseCoverageCredit=false、wholeRequirementSatisfied=false，不能把测试文件存在或模块标签当成整段规范已满足。

`harness-migration.json` 记录旧身份与路径、新路径、追加场景、历史归档和保留验证；历史内容不参与当前活动用例计数。requirements 的来源摘要必须与原方案一致，目录迁移不能更改两份源方案。源条款记录与 kind=case_contract 的断言变体记录分开解释，后者增加不能宣称新增了同数量源方案要求。

```powershell
python agent-eval/tools/migrate_harness_data.py stage --project . --output data/.preparation-stage/harness-review
python agent-eval/tools/migrate_harness_data.py verify --project . --output data/.preparation-stage/harness-review
```

`stage` 只写新的项目内暂存根；`verify` 检查所选数据根；`publish` 在校验后发布唯一当前根。`--project` 是项目根，`--output` 是暂存数据根。重复执行前先检查迁移记录，不覆盖已有审核、发布或运行历史。
'''
    if has_benchmarks:
        from prepare_benchmarks import benchmark_manual
        text = text.rstrip() + benchmark_marker + '\n' + benchmark_manual()
    target.write_text(text, encoding='utf-8', newline='\n')
