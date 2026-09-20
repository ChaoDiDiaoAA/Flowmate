"""92 fresh P8 episodes, authored from current specifications and fresh inputs.

This is a declarative author, not a Workflow implementation or evidence collector.
Adapter command names below are required test-port contracts, not existing APIs.
No old Case, business asset or Gold is opened. Business arithmetic conflicts are
intentional patches; this author never recalculates them away.
"""
from copy import deepcopy
import hashlib
from pathlib import Path

from rebuild_contracts import load_spec_contracts


SOURCES = {
    'normalize': ('MOD-12.normalize', '16.2', '规范化不静默改写票面事实'),
    'original': ('MOD-12.normalize', '16.2', '字段保存原值、规范值、来源/证据定位、缺失/歧义/冲突和修订号'),
    'decimal': ('MOD-12.normalize', '16.2', '金额使用明确十进制精度、舍入和容差'),
    'unknown': ('MOD-12.rule-coverage', '16.2', '未实现、未执行、查询失败或依据缺失不能记为不适用或通过'),
    'conflict': ('MOD-12.rule-recall', '16.2', '票面与计算值冲突同时保留'),
    'rule': ('MOD-12.rule-precision', '16.2', '人工点击确认不能直接改成通过'),
    'rule-execution': ('MOD-12.rule-precision', '16.2', '规则分为格式、内部一致、目标字段关联和适用业务核查，保存 ruleId/version、severity、依据和结果'),
    'rule-rejection': ('MOD-12.rule-precision', '16.2', '保留不通过依据，按规则修正或进入既有业务处置'),
    'duplicate': ('MOD-13.recall', '16.2', '发现既有成功或 UNKNOWN 时沿用原业务记录及动作核对规则，新 Job 不能绕过防重'),
    'distinct': ('MOD-13.false-block', '16.2', '不用字节或正文相似性替代业务唯一性判断'),
    'input-dedup': ('MOD-09.input', '16.2', '输入文件去重、业务重复识别和提交动作防重分别成立'),
    'input-digest': ('MOD-09.input', '17.2', '管理受控文件位置、摘要与引用，不替代文档业务状态'),
    'input-registration': ('MOD-09.input', '17.2', '登记输入版本、Workspace 归属和当前可用状态'),
    'single-invoice': ('MOD-07.workflow', '16.2', '输入必须已明确对应一张发票'),
    'supplier': ('MOD-15.match', '16.3', '查询权威 ID、唯一性及可选状态'),
    'supplier-invalid': ('MOD-15.false-match', '16.2', '补充有效依据或人工选择，接受前仍核验范围和有效性'),
    'query': ('MOD-15.match', '16.3', '接口失败不能当成查询成功但无候选'),
    'match': ('MOD-16.match', '16.3', '无匹配、多匹配、依据冲突或主数据过期转人工，不由模型补造结论'),
    'association-origin': ('MOD-16.false-match', '16.2', '目标供应商/订单 ID 来自合法关联，不由模型直接从票面猜造'),
    'association-conflict': ('MOD-16.false-match', '16.3', '无匹配、多匹配、依据冲突或主数据过期转人工，不由模型补造结论'),
    'order-selectable': ('MOD-16.false-match', '16.3', '查询权威 ID、唯一性及可选状态'),
    'business': ('MOD-16.check', '16.3', '收货、合同、价格、余额/数量等适用业务核查继续保留'),
    'recheck': ('MOD-17.revision', '16.2', '人工修改后重新核验受影响字段、关联及业务依据，不只重算单个金额'),
    'revision': ('MOD-17.revision', '12.2', '候选不可覆盖；人工修改生成修订并保留原始预测'),
    'saved-candidate': ('MOD-17.revision', '5.3', '失败 Run 已保存但未接受的候选可由有权限的人在当前版本下显式复核选择，不能以旧 Run 身份恢复执行权'),
    'human': ('MOD-17.revision', '18.2.11', '相同响应请求返回原结果，不同响应竞争按 version 拒绝或显式发起后续交互'),
    'human-acceptance': ('MOD-17.revision', '18.2.11', '采纳回答与新修订、步骤位置、任务指针和审计同事务保存'),
    'clarify': ('MOD-17.revision', '18.2.11', '用户回答仍有歧义时继续澄清'),
    'authority': ('MOD-17.revision', '12.2.1', 'Renderer/模型传入的 actorId、role 或 approved 不能建立身份'),
    'qualification': ('MOD-17.revision', '12.2.1', '复核者提交 expectedRevision，生成新修订并失效旧依据/授权'),
    'no-submit': ('MOD-07.workflow', '18.2.11', '字段确认属于事实采纳，不能直接授予提交权限'),
    'response-terminal': ('MOD-17.revision', '12.2.3', 'answered/rejected/expired/cancelled 不再接受新决定'),
    'expiry': ('MOD-17.revision', '12.2.3', '过期后回答需新交互'),
    'atomic': ('MOD-25.atomic', '18.3', '关键业务事实或审计保存失败不得继续依赖未提交状态'),
    'notify': ('MOD-25.atomic', '18.3', '通知或响应丢失不能证明事务未提交'),
    'step': ('MOD-07.workflow', '12.5.2', '每个活动尝试的状态写入都检查 expectedStepVersion、generation 和相关修订'),
    'unique': ('MOD-07.workflow', '12.5.2', '同一逻辑步骤在同一有效输入版本下只能有一个可推进尝试'),
    'no-revision': ('MOD-07.workflow', '18.2.2', 'input_basis_hash 即使无修订也非空'),
    'parallel': ('MOD-07.workflow', '12.5.2', '允许并行的只读分支有独立 stepInstanceKey'),
    'terminal': ('MOD-07.workflow', '12.5.3', '终态尝试不改写'),
    'wait': ('MOD-07.workflow', '12.5.3', '等待人工、主数据、依赖或外部核对，必须保存 waitReason/waitingOnRefs、责任主体及适用期限'),
    'wait-object': ('MOD-07.workflow', '12.5.3.1', '无等待对象不允许标 waiting'),
    'direct': ('MOD-07.workflow', '12.5.3', '人工或确定性产品命令可以直接完成适用步骤，不要求额外启动模型'),
    'generation': ('MOD-07.workflow', '12.5.4', '受控命令终结旧活动尝试并创建关联的新 waiting 尝试'),
    'recover': ('MOD-07.workflow', '12.5.4', '已完成且依据仍有效的步骤不重做'),
    'checkpoint': ('MOD-25.atomic', '12.5.4', '事务失败留下的无引用产物不能作为恢复依据'),
    'assessment': ('MOD-07.assessment', '18.2.10', '并发产出先按同一版本合并，再用 CAS 更新当前引用，冲突重新读取不能覆盖另一份新结果'),
    'assessment-unknown': ('MOD-07.assessment', '18.2.10', '每次评估发布完整的有界快照，未检查项明确 unknown'),
    'assessment-old': ('MOD-07.assessment', '18.2.10', '新 Run/旧代次结果不能越过当前版本约束成为有效结论'),
    'evidence-only': ('MOD-07.assessment', '18.2.10', '仅证据变化时更新快照引用并使旧动作确认失效'),
}

SINGLE = 'business-single-order-01'
ALIAS = 'business-supplier-alias-02'
MULTI = 'business-multiple-orders-01'
UNITS = 'business-unit-conversion-03'
RECEIPTS = 'business-partial-receipts-03'
CONTRACT = 'business-contract-price-02'
BALANCE = 'business-available-balance-02'
DECIMAL_DOWN = 'business-decimal-rounding-01'
DECIMAL_UP = 'business-decimal-rounding-02'


def patch(path, value=None, op='replace', reason='构造本例明确输入条件，保留冲突供产品判断'):
    result = {'op': op, 'path': path, 'reason': reason}
    if op != 'remove':
        result['value'] = value
    return result


def ck(source, key, value, description, mode='F'):
    return (source, key, value, description, mode)


def action(command, **arguments):
    return (command, arguments)


def fault(boundary, effect):
    return {'boundary': boundary, 'effect': effect, 'scope': '本例受控模拟端口',
            'occurrences': 1, 'capture': '故障注入记录及关联命令/事务身份'}


def _episode(contracts, key, group, title, request, facts, actions, checks, *, base=None,
             patches=(), controls=(), faults=(), legal=False, routes=(), extra_dependencies=(),
             evidence_requirements=()):
    def source_refs(alias):
        metric, section, quote = SOURCES[alias]
        return [{'spec': 'product', 'section': section, 'quote': quote},
                {'spec': 'evaluation', 'section': contracts['metrics'][metric]['section'],
                 'quote': '`' + metric + '`'}]
    checks = list(checks)
    # Trigger observations are required scored checks, never success guards.
    # A missed barrier/fault is therefore visible instead of silently removing
    # this episode from its denominator. Missing capture stays UNJUDGEABLE.
    if facts.get('concurrency'):
        checks.extend([
            ck(checks[0][0], 'barrier-arrival-count', len(facts['concurrency']['workers']),
               '全部声明工作者实际到达并发屏障，缺少一方不能冒充并发覆盖'),
            ck(checks[0][0], 'barrier-released', True, '可信屏障已释放且有原始事务记录')])
    if faults:
        checks.append(ck(checks[0][0], 'observed-fault-count', len(faults),
                         '指定故障边界确实触发，不能把未注入的正常执行记为故障覆盖'))
    definitions = []
    model = any(c[4] == 'A' for c in checks)
    for alias, check_key, value, description, mode in checks:
        evidence = ['formal_command_results', 'raw_transaction_log', 'authoritative_before_after']
        evidence.extend(evidence_requirements)
        if check_key.startswith('barrier-'):
            evidence.append('trusted_barrier_log')
        if check_key == 'observed-fault-count':
            evidence.append('trusted_fault_injection_log')
        if mode in {'A', 'B'}:
            evidence.append('versioned_business_query_records')
        if mode == 'A':
            evidence.extend(['real_model_output', 'actual_model_request_link'])
        condition = {'path': 'observation.command-delivered', 'op': 'eq', 'value': True,
                     'description': '可信接入端已经交付本例命令；不要求命令成功或预期结果出现',
                     'evidence': ['formal_command_delivery']}
        preconditions = [condition]
        if mode == 'A':
            preconditions.append({'path': 'observation.model-request-delivered', 'op': 'eq', 'value': True,
                                  'description': '实际任务及查询证据已交付真实模型请求；不以模型答对作为触发',
                                  'evidence': ['actual_model_request_link']})
        definitions.append({'key': check_key, 'description': description,
                            'metricId': SOURCES[alias][0], 'mode': mode,
                            'path': 'observation.' + check_key, 'op': 'eq', 'value': deepcopy(value),
                            'evidence': evidence, 'sourceRefs': source_refs(alias),
                            'hardConstraint': mode == 'F', 'preconditions': preconditions})
    # P8 fact acceptance and matching must never synthesize submission permission.
    definitions.append({'key': 'submission-permission-created', 'description': '核对权限及动作记录，本例不产生提交许可',
                        'metricId': SOURCES['no-submit'][0], 'mode': 'F',
                        'path': 'observation.submission-permission-created', 'op': 'eq', 'value': False,
                        'evidence': ['authorization_ledger_complete', 'formal_command_results'],
                        'sourceRefs': source_refs('no-submit'), 'hardConstraint': True,
                        'preconditions': [{'path': 'observation.command-delivered', 'op': 'eq', 'value': True,
                                           'description': '操作命令已到达受控入口，不依赖匹配或复核成功',
                                           'evidence': ['formal_command_delivery']}]})
    commands = [action('adapter.prepare_workflow_episode', useBusinessProjection=base is not None,
                       createThroughControlledPorts=True, preserveDeclaredConflicts=True)]
    commands.extend(actions)
    commands.append(action('adapter.collect_workflow_evidence', capture=['命令原始响应', '事务提交与回滚',
                          '修订及候选前后原文', '完整评估快照', '权限与步骤历史'],
                           missingIsUnknown=True, neverDeriveObservedFromOracle=True))
    steps = []
    for index, (command, arguments) in enumerate(commands):
        step = {'id': 'step-' + str(index + 1), 'actor': 'trusted_harness_adapter',
                'command': command, 'arguments': deepcopy(arguments)}
        if index:
            step['after'] = [steps[-1]['id']]
        steps.append(step)
    scenario = {'key': key, 'module': 'workflow', 'subcapability': group, 'stage': 'P8',
                'title': title, 'userInput': request, 'input': {'request': request},
                'initialState': {'fixtureStatus': 'declaration_only', 'legalControl': legal,
                                 'facts': deepcopy(facts),
                                 'observationEncoding': {'money': '保留原文另列；计算金额按业务包两位小数字符串',
                                                         'quantity': '精确十进制结果去掉无意义尾零；不得改动源数据或修复冲突',
                                                         'unorderedSets': '字符串集合按字典序输出，原始记录及身份另存'},
                                 'dependencies': ['actual_product_adapter', 'trusted_evidence_collector',
                                                  'case_content_review', *extra_dependencies] + (['real_model'] if model else []),
                                 'acceptedModelRoutes': list(routes),
                                 'adapterBoundary': '声明端口尚未实现；仅通过产品公开命令准备事实，禁止直写数据库；业务包策略仅为显式模拟假设'},
                'steps': steps, 'faults': list(faults),
                'expectedOutcome': '；'.join(c[3] for c in checks) + '。各必要项分别判定，缺证据不记通过。',
                'forbidden': ['静默修复票面冲突或覆盖原候选', '将查询失败或未检查项记为通过/不适用',
                              '以模型文字取代受控事实或由复核产生提交许可'],
                'controlKeys': list(controls), 'relatedModules': [],
                'sourceRefs': source_refs(checks[0][0]), 'checks': definitions}
    if base is not None:
        scenario.update(businessId=base, businessPatches=deepcopy(list(patches)))
    return scenario


def build_scenarios():
    contracts = load_spec_contracts(Path(__file__).resolve().parents[3])
    result = []
    def add(*args, **kwargs):
        result.append(_episode(contracts, *args, **kwargs))
    g = 'normalization-rules'
    standard = {'candidate': {'status': 'saved', 'sourceRef': 'simulated-parsed/page1', 'revision': 1},
                'applicableRules': ['decimal', 'currency', 'line-arithmetic', 'invoice-total'],
                'queryCoverage': '本例仅执行指定规范化和规则检查；其余评估项初始unknown'}
    normalize = [action('adapter.normalize_and_check', candidateRef='current', ruleScope='declared')]
    add('wf-normal-control', g, '规范金额与完整原值正常接受', '请按固定模拟规则校验这张发票，并保存票面与计算依据。', standard, normalize,
        [ck('normalize', 'normalized-total', '44.55', '总额规范值为44.55'),
         ck('original', 'original-total', '44.55', '保留总额原值和来源'),
         ck('rule-execution', 'arithmetic-status', 'pass', '固定模拟规则的算术一致检查通过，保存规则版本及计算依据')], base=SINGLE, legal=True)
    add('wf-round-even-down', g, '半偶舍入向下与零税', '请校验明细小数精度和零税计算，并说明原始单价。', standard, normalize,
        [ck('decimal', 'calculated-net', '1.00', '1乘1.005按两位半偶得到1.00'),
         ck('original', 'original-unit-price', '1.005', '单价原值1.005不改写'),
         ck('decimal', 'calculated-tax', '0.00', '明确零税计算为0.00')], base=DECIMAL_DOWN, legal=True)
    add('wf-round-even-up', g, '半偶舍入向上及逐行税', '请核对这张票的明细净额与税额，保留三位单价。', standard, normalize,
        [ck('decimal', 'calculated-net', '1.02', '1乘1.015按两位半偶得到1.02'),
         ck('decimal', 'calculated-tax', '0.10', '逐行净额1.02的10%税为0.10'),
         ck('original', 'original-unit-price', '1.015', '原始单价仍为1.015')], base=DECIMAL_UP, legal=True)
    for key, title, request, changes, expectations in [
        ('wf-total-conflict', '票面总额与合计冲突', '请核对票面总额和明细合计，保留差异等待处理。',
         [patch('/invoice/totalAmount', '45.55')],
         [ck('conflict', 'printed-total', '45.55', '票面45.55原样保留'), ck('conflict', 'calculated-total', '44.55', '独立计算44.55'), ck('rule-rejection', 'arithmetic-status', 'reject', '冲突不能静默改成通过')]),
        ('wf-tax-conflict', '行税与税率冲突', '请检查行税额是否符合固定税率规则，展示冲突。',
         [patch('/invoice/lines/0/taxAmount', '5.05')],
         [ck('conflict', 'printed-tax', '5.05', '行税原值5.05保留'), ck('decimal', 'calculated-tax', '4.05', '40.50的10%为4.05'), ck('rule-rejection', 'line-tax-status', 'reject', '拒绝行税不一致')]),
        ('wf-currency-missing', '缺币种不猜USD', '请检查发票币种信息是否足够进行金额校验。',
         [patch('/invoice/currency', op='remove')],
         [ck('normalize', 'currency-state', 'missing', '币种保持缺失'), ck('normalize', 'guessed-currency-count', 0, '不根据模拟默认币种补造票面币种'), ck('unknown', 'currency-check', 'unknown', '必需币种未明确不能通过')]),
        ('wf-date-ambiguous', '月日歧义需澄清', '请确认开票日期的含义，歧义未解时保留原文。',
         [patch('/invoice/invoiceDate', '08/09/2026')],
         [ck('original', 'original-date', '08/09/2026', '保留日期原文'), ck('normalize', 'date-state', 'ambiguous', '无地区解释依据保留歧义'), ck('unknown', 'date-check', 'unknown', '不擅定8月9日或9月8日')]),
        ('wf-decimal-separator-ambiguous', '金额分隔符歧义', '请核对总额中的分隔符含义，并请求必要澄清。',
         [patch('/invoice/totalAmount', '1,234')],
         [ck('original', 'printed-total', '1,234', '原文逗号保留'), ck('normalize', 'amount-state', 'ambiguous', '无地区规则时两种解析均不擅选'), ck('unknown', 'total-check', 'unknown', '不把歧义总额判通过')]),
        ('wf-line-identity-conflict', '行引用与物料不一致', '请逐行检查订单行引用与物料，不要只看票头合计。',
         [patch('/invoice/lines/0/orderLineId', 'PO-L9')],
         [ck('association-conflict', 'line-reference-status', 'reject', '不存在的订单行引用不能通过'), ck('original', 'original-order-line', 'PO-L9', '保留错误原引用'), ck('unknown', 'unresolved-line-count', 1, '明确一条待修订关联')]),
        ('wf-quantity-missing', '数量缺失不填零', '请检查第一行数量缺口，并保留其它已知金额。',
         [patch('/invoice/lines/0/quantity', op='remove')],
         [ck('normalize', 'quantity-state', 'missing', '数量明确缺失'), ck('normalize', 'zero-filled-count', 0, '不把缺数量填成0'), ck('unknown', 'line-arithmetic-status', 'unknown', '缺数量算术未知')]),
    ]:
        add(key, g, title, request, standard, normalize, expectations, base=SINGLE,
            patches=changes, controls=['wf-normal-control'])
    add('wf-unchecked-rule', g, '部分校验不能让未检查项变通过', '请只运行格式检查，并如实展示其余必要核查的状态。',
        dict(standard, applicableRules=['format', 'invoice-total', 'supplier']),
        [action('adapter.normalize_and_check', candidateRef='current', ruleScope=['format'])],
        [ck('unknown', 'total-status', 'unknown', '未执行金额核查仍unknown'),
         ck('unknown', 'supplier-status', 'unknown', '未执行供应商核查仍unknown'),
         ck('assessment-unknown', 'snapshot-check-keys', ['format', 'invoice-total', 'supplier'], '发布完整有界检查集合')],
        base=SINGLE, controls=['wf-normal-control'])
    add('wf-rule-confirm-cannot-waive', g, '点击复核不能豁免算术冲突', '我确认收到这张发票，请继续核对票面与计算差异。',
        dict(standard, reviewer={'actorId': 'reviewer-local', 'role': 'reviewer', 'workspace': 'same'}),
        [*normalize, action('adapter.review_facts', decision='confirmed-received', expectedRevision=1)],
        [ck('rule', 'arithmetic-status', 'reject', '人工确认收到不让算术冲突通过'),
         ck('original', 'printed-total', '45.55', '原总额45.55保留'),
         ck('recheck', 'pending-correction-count', 1, '冲突仍待有效修订和重查')], base=SINGLE,
        patches=[patch('/invoice/totalAmount', '45.55')], controls=['wf-normal-control'])

    g = 'business-duplicates'
    duplicate_facts = {'historyQuery': {'authority': 'local-simulation-registry', 'readOnly': True},
                       'identityContract': {'status': 'requires_approved_duplicate_identity_contract',
                                            'rule': '本例只判权威已有对象关联，不将票号或相似文本单独当业务键'}}
    historical = {'entryId': 'prior-entry', 'businessObjectId': 'prior-object', 'invoiceNumber': 'SIM-REBUILD-001',
                  'supplierRegistration': 'SIM-REG-MAIN', 'currency': 'USD', 'totalAmount': '44.55',
                  'result': 'succeeded', 'sourceRef': 'registry/prior-entry', 'version': 1}
    def dup(key, title, request, entry, facts, checks, *, legal=False, faults=(), mode=False,
            commands=None, evidence_requirements=()):
        entries = [] if entry is None else entry if isinstance(entry, list) else [entry]
        add(key, g, title, request, dict(duplicate_facts, **facts),
            commands or [action('adapter.run_real_model_task' if mode else 'adapter.check_business_duplicate',
                    requestRef='episode.request', query='registry-by-authorized-identity',
                    preserveOriginalBusinessIdentity=True)], checks, base=SINGLE,
            patches=[patch('/historicalEntries/-', e, 'add') for e in entries],
            controls=[] if legal else ['wf-duplicate-distinct-control'], legal=legal, faults=faults,
            routes=['先按业务身份查询，再核对结果', '先读历史来源凭证，再按同一业务身份查询'] if mode else [],
            extra_dependencies=['approved_duplicate_identity_contract'], evidence_requirements=evidence_requirements)
    dup('wf-duplicate-distinct-control', '相同金额不同合法业务对象', '请核对同一供应商金额相同的两张票是否确为同一业务对象。',
        dict(historical, invoiceNumber='SIM-OTHER-002', businessObjectId='separate-object'),
        {'currentObjectId': 'current-object', 'identityEvidence': {'relation': 'distinct', 'sourceRef': 'registry/separate-identity'}},
        [ck('distinct', 'duplicate-disposition', 'distinct', '权威身份不同不误报重复'),
         ck('distinct', 'blocked-as-duplicate', False, '合法独立票不因同金额拦截'),
         ck('distinct', 'history-record-count', 1, '保留被比较历史对象')], legal=True)
    dup('wf-duplicate-confirmed-success', '已成功业务对象重复出现', '请查明这张票的已有业务结果，再决定核查路径。', historical,
        {'currentObjectId': 'prior-object', 'identityEvidence': {'relation': 'same', 'sourceRef': 'registry/prior-entry'}},
        [ck('duplicate', 'duplicate-disposition', 'confirmed', '同权威业务身份识别重复'),
         ck('duplicate', 'reused-business-object', 'prior-object', '沿原成功业务对象核对'),
         ck('duplicate', 'new-send-intent-count', 0, '不建立新发送意图')])
    dup('wf-duplicate-unknown', '历史UNKNOWN保留核对', '请核对已有未明结果的发票记录，不要假设未发送。', dict(historical, result='UNKNOWN'),
        {'currentObjectId': 'prior-object', 'identityEvidence': {'relation': 'same', 'sourceRef': 'registry/prior-entry'}},
        [ck('duplicate', 'duplicate-disposition', 'reconcile-original', 'UNKNOWN转原记录核对'),
         ck('duplicate', 'original-result', 'UNKNOWN', '查询前未明结果保持UNKNOWN'),
         ck('duplicate', 'new-send-intent-count', 0, 'UNKNOWN不产生第二次发送意图')])
    dup('wf-duplicate-query-failed', '查重查询故障不是无重复', '请检查此票是否有历史业务记录，查询失败时说明缺口。', None,
        {'queryPlan': {'port': 'duplicate-registry', 'response': 'timeout', 'attemptLimit': 1}},
        [ck('unknown', 'duplicate-status', 'unknown', '查询失败后重复状态unknown'),
         ck('unknown', 'reported-query-state', 'technical-error', '错误归于技术查询'),
         ck('distinct', 'confirmed-nonduplicate-count', 0, '无证据不宣称非重复')],
        faults=[fault('duplicate-registry.read.before-response', 'timeout')])
    dup('wf-duplicate-empty-query', '成功空结果仍是查重范围内结论', '请查询当前身份的历史记录，并说明查重范围。', None,
        {'queryPlan': {'port': 'duplicate-registry', 'response': 'complete-empty', 'scope': 'current-identity'}},
        [ck('distinct', 'duplicate-disposition', 'no-record-in-scope', '成功完整查询无记录'),
         ck('distinct', 'blocked-as-duplicate', False, '无历史命中不误拦重复'),
         ck('unknown', 'query-scope', 'current-identity', '保留有限查重范围')], legal=True)
    dup('wf-duplicate-similar-text', '文本相似不等于业务重复', '请比较名称和金额接近的历史票，依据身份而不是相似文本判断。',
        dict(historical, invoiceNumber='SIM-REBUILD-001-A'),
        {'currentObjectId': 'new-object', 'textSimilarity': '0.99', 'identityEvidence': {'relation': 'distinct', 'sourceRef': 'registry/new-object'}},
        [ck('distinct', 'duplicate-disposition', 'distinct', '高相似文本仍是独立身份'),
         ck('distinct', 'blocked-as-duplicate', False, '不因相似度阻断独立票'),
         ck('distinct', 'used-identity-evidence', 'registry/new-object', '模型依据权威身份解释差异', 'A')], mode=True)
    dup('wf-duplicate-same-number-other-supplier', '票号相同但供应商不同', '请核对与历史票同号的本票供应商归属和业务身份。',
        dict(historical, supplierRegistration='SIM-REG-OTHER'),
        {'currentObjectId': 'new-supplier-object', 'identityEvidence': {'relation': 'distinct', 'sourceRef': 'registry/supplier-scope'}},
        [ck('distinct', 'duplicate-disposition', 'distinct', '不同供应商对象不被票号单独合并'),
         ck('distinct', 'blocked-as-duplicate', False, '不同对象正常继续核查'),
         ck('distinct', 'identity-source', 'registry/supplier-scope', '使用供应商范围身份来源')])
    synthetic_source = '{"source":"synthetic-external-parser","invoiceNumber":"SIM-REBUILD-001","supplierRegistration":"SIM-REG-MAIN","currency":"USD","totalAmount":"44.55"}\n'
    source_digest = hashlib.sha256(synthetic_source.encode('utf-8')).hexdigest()
    dup('wf-duplicate-byte-identical', '文件字节相同而业务身份待核', '请受理这两份合成输入，分别核对文件内容重复与业务身份是否已明确。', historical,
        {'sourceInputs': [
            {'sourceId': 'synthetic-source-a', 'requestId': 'import-source-a', 'filename': 'source-a.json',
             'workspaceId': 'SIM-WS-development', 'kind': 'external-already-parsed', 'parserVersion': 'synthetic-1',
             'encoding': 'utf-8', 'content': synthetic_source},
            {'sourceId': 'synthetic-source-b', 'requestId': 'import-source-b', 'filename': 'source-b.json',
             'workspaceId': 'SIM-WS-development', 'kind': 'external-already-parsed', 'parserVersion': 'synthetic-1',
             'encoding': 'utf-8', 'content': synthetic_source}],
         'registryQueryFixture': {'sourceRef': 'registry/identity-gap', 'version': 1,
             'request': {'invoiceNumber': 'SIM-REBUILD-001', 'supplierRegistration': 'SIM-REG-MAIN'},
             'response': {'bindings': [], 'coverage': 'partial', 'missingIdentityFields': ['organizationId']} }},
        [ck('input-dedup', 'file-duplicate', True, '记录输入字节重复'),
         ck('input-digest', 'source-byte-sha256s', [source_digest, source_digest], '两份实际捕获字节独立计算SHA-256后相同'),
         ck('input-registration', 'accepted-input-request-count', 2, '两个独立受理请求均有回执，允许产品按内容去重底层文件'),
         ck('distinct', 'confirmed-business-duplicate', False, '字节不替代业务身份'),
         ck('unknown', 'business-identity-status', 'unknown', '业务身份缺口明确unknown')],
        commands=[action('adapter.create_synthetic_source_bytes', sourcesRef='facts.sourceInputs',
                         writeToControlledTemporaryRoot=True, preserveExactEncoding=True),
                  action('adapter.capture_source_bytes', sourceIds=['synthetic-source-a', 'synthetic-source-b'],
                         digestAlgorithm='sha256', digestFromActualBytes=True),
                  action('adapter.accept_declared_source', sourceId='synthetic-source-a', requestId='import-source-a'),
                  action('adapter.accept_declared_source', sourceId='synthetic-source-b', requestId='import-source-b'),
                  action('adapter.check_business_duplicate', queryFixtureRef='facts.registryQueryFixture',
                         inputRequestIds=['import-source-a', 'import-source-b'], preserveOriginalBusinessIdentity=True)],
        evidence_requirements=['input_source_byte_artifacts', 'input_acceptance_records', 'duplicate_query_requests_and_results'])
    dup('wf-duplicate-two-candidates', '多个历史身份候选需核清', '请解释两个历史身份候选，资料不足时提出具体核对问题。',
        [historical, dict(historical, entryId='other-entry', businessObjectId='other-object',
                          result='UNKNOWN', sourceRef='registry/other-entry')],
        {'queryPlan': {'candidateRefs': ['prior-object', 'other-object']},
         'identityAlternatives': [{'id': 'prior-object', 'registration': 'SIM-REG-MAIN', 'result': 'succeeded', 'sourceRef': 'registry/prior-entry'},
                                  {'id': 'other-object', 'registration': 'SIM-REG-MAIN', 'result': 'UNKNOWN', 'sourceRef': 'registry/other-entry'}],
         'identityEvidence': {'relation': 'ambiguous', 'sourceRef': 'registry/two-matches'}},
        [ck('duplicate', 'duplicate-disposition', 'clarify', '多个候选时不擅选原对象', 'A'),
         ck('unknown', 'business-identity-status', 'unknown', '未解歧义保持unknown'),
         ck('duplicate', 'new-send-intent-count', 0, '身份未解不新建发送')], mode=True)
    dup('wf-duplicate-cross-job', '新Job仍使用既有成功身份', '新任务收到同一业务票，请查询前一任务结果。', historical,
        {'jobId': 'new-job', 'priorJobId': 'old-job', 'currentObjectId': 'prior-object',
         'identityEvidence': {'relation': 'same', 'sourceRef': 'registry/prior-entry'}},
        [ck('duplicate', 'duplicate-disposition', 'confirmed', '跨Job同身份仍识别重复'),
         ck('duplicate', 'reused-business-object', 'prior-object', '不以新Job生成独立业务身份'),
         ck('duplicate', 'new-send-intent-count', 0, '跨Job不重建发送意图')])
    dup('wf-duplicate-late-search', '旧版本查重结果迟到不覆盖', '请先核对原票号；随后依据我提供的凭证更正为SIM-CORRECTED-991，按新修订重新查重。', historical,
        {'revision': 1, 'job': {'id': 'duplicate-job', 'workspaceId': 'SIM-WS-development', 'currentRevision': 1, 'generation': 1},
         'principal': {'actorId': 'duplicate-reviewer', 'qualifications': ['reviewer'], 'workspaceId': 'SIM-WS-development'},
         'interaction': {'id': 'number-correction', 'version': 1, 'revision': 1, 'status': 'pending',
                         'jobId': 'duplicate-job', 'question': '请依据登记凭证更正票号'},
         'evidenceObjects': [{'id': 'number-correction-evidence', 'version': 1, 'jobId': 'duplicate-job',
                              'workspaceId': 'SIM-WS-development', 'sourceId': 'synthetic-registration-extract',
                              'encoding': 'utf-8', 'content': '{"invoiceNumber":"SIM-CORRECTED-991","registration":"SIM-REG-MAIN","businessObjectId":"corrected-object"}'}],
         'identityRegistryRecords': [
             {'sourceRef': 'registry/prior-entry', 'version': 1, 'invoiceNumber': 'SIM-REBUILD-001',
              'supplierRegistration': 'SIM-REG-MAIN', 'businessObjectId': 'prior-object'},
             {'sourceRef': 'registry/corrected-number', 'version': 1, 'invoiceNumber': 'SIM-CORRECTED-991',
              'supplierRegistration': 'SIM-REG-MAIN', 'businessObjectId': 'corrected-object'}]},
        [ck('assessment-old', 'current-assessment-revision', 2, '当前结论绑定修订2'),
         ck('assessment-old', 'old-result-published', False, '修订1迟到查询不覆盖'),
         ck('revision', 'current-invoice-number', 'SIM-CORRECTED-991', '受控人工命令写入具体新票号'),
         ck('assessment-old', 'query-revisions', [1, 2], '两次实际查询分别保留修订1及2的请求依据'),
         ck('assessment-old', 'publication-dispositions', ['current-query:accepted', 'old-query:stale-rejected'], '新查询发布后旧结果释放并明确拒绝'),
         ck('distinct', 'blocked-as-duplicate', False, '更正后的独立身份不误拦')],
        commands=[action('adapter.create_declared_evidence', evidenceObjectsRef='facts.evidenceObjects'),
                  action('adapter.start_business_duplicate_query', queryId='old-query', revision=1,
                         generation=1, fieldsRef='current-revision', registryRef='facts.identityRegistryRecords',
                         holdAt='duplicate-query.revision1.before-publish'),
                  action('adapter.await_duplicate_query_barrier', queryId='old-query',
                         barrier='duplicate-query.revision1.before-publish', timeoutMs=5000),
                  action('adapter.respond_human_interaction', interactionId='number-correction',
                         responseRequestId='correct-number-once', expectedVersion=1, expectedRevision=1,
                         decision='edit', fields={'invoiceNumber': 'SIM-CORRECTED-991'},
                         evidenceRef='number-correction-evidence', evidenceVersion=1),
                  action('adapter.start_business_duplicate_query', queryId='current-query', revision=2,
                         generation=1, fieldsRef='current-revision', registryRef='facts.identityRegistryRecords'),
                  action('adapter.publish_duplicate_query_result', queryId='current-query', expectedRevision=2,
                         responseRef='current-query-publication'),
                  action('adapter.release_held_duplicate_query', queryId='old-query',
                         afterCommandResponse='current-query-publication', timeoutMs=5000)],
        faults=[fault('duplicate-query.revision1.before-publish', 'hold-until-revision2-publication-attempted')],
        evidence_requirements=['duplicate_query_requests_and_results', 'revision_acceptance_receipts',
                               'assessment_publication_receipts', 'declared_evidence_bytes'])
    dup('wf-duplicate-rejected-rework', '明确未生效拒绝后合法关联重办', '原票已明确被拒且未生效，请核查这次关联重办的业务身份。',
        dict(historical, result='rejected', authoritativeEffect='not-applied'),
        {'currentObjectId': 'rework-object', 'priorJobTerminal': 'rejected',
         'reworkAuthorization': {'actorId': 'operator-local', 'requested': True},
         'identityEvidence': {'relation': 'authorized-rework', 'sourceRef': 'registry/rejection-proof'}},
        [ck('distinct', 'duplicate-disposition', 'linked-rework', '合法关联重办不误拦'),
         ck('distinct', 'prior-job-status', 'rejected', '原Job保持拒绝终态'),
         ck('duplicate', 'inherited-send-permission', False, '重办不继承原发送资格')])

    g = 'supplier-matching'
    supplier_facts = {'revision': 1, 'supplierQuery': {'port': 'simulated-suppliers', 'readOnly': True,
                                                    'scope': 'current-workspace', 'asOf': '2026-08-20T09:00:00Z'},
                      'alternatives': '业务包中存在注册号SIM-REG-MAIN的已登记别名供应商，以及同名但注册号SIM-REG-DIFFERENT的另一主体'}
    supplier_routes = ['按注册号查询并核验别名及状态', '按票面名称取得候选后用注册号、别名和状态消歧']
    def supplier(key, title, request, checks, *, changes=(), facts=None, legal=False, model=False,
                 faults=(), commands=None, control='wf-supplier-alias-control'):
        add(key, g, title, request, dict(supplier_facts, **(facts or {})),
            commands or [action('adapter.run_real_model_task' if model else 'adapter.match_supplier',
                                requestRef='episode.request', readOnlyQueries=True)], checks,
            base=ALIAS, patches=changes, controls=[] if legal else [control], legal=legal,
            faults=faults, routes=supplier_routes if model else [])
    supplier('wf-supplier-alias-control', '注册别名与同名异主体消歧', '请核对票面商号对应的有效供应商，并列明身份依据。',
             [ck('supplier', 'selected-supplier', ALIAS + '-SUP', '凭注册号和已登记别名选中正确权威ID', 'A'),
              ck('supplier', 'accepted-supplier', ALIAS + '-SUP', '受控接受正确供应商关联', 'B'),
              ck('supplier', 'supplier-source-version', 1, '记录实际主数据版本1')], legal=True, model=True)
    supplier('wf-supplier-no-candidate', '完整查询确无候选', '请查询票面供应商，找不到有效主体时提出补充请求。',
             [ck('supplier', 'match-disposition', 'no-match', '成功完整查询无候选时明确无匹配', 'A'),
              ck('supplier-invalid', 'accepted-supplier-count', 0, '不存在候选时不建立关联'),
              ck('supplier', 'query-completion', 'complete', '无匹配有完整查询证据')],
             changes=[patch('/invoice/supplierRegistration', 'SIM-NOT-REGISTERED'), patch('/invoice/sellerName', '模拟未登记供货方')], model=True)
    supplier('wf-supplier-ambiguous-registration', '注册身份缺失且同名候选', '请核查同名供应商的区别，证据不足时请求确认注册身份。',
             [ck('supplier', 'match-disposition', 'clarify-registration', '两个同名主体需澄清注册身份', 'A'),
              ck('supplier-invalid', 'accepted-supplier-count', 0, '歧义未解不接受首条候选'),
              ck('supplier', 'candidate-count', 2, '保留两个真实不同注册主体')],
             changes=[patch('/invoice/supplierRegistration', op='remove')], model=True)
    supplier('wf-supplier-name-conflict', '注册号与商号证据冲突', '请核查注册号命中但商号不在登记名称中的供应商关系。',
             [ck('supplier', 'match-disposition', 'conflicting-evidence', '注册命中与名称冲突同时呈现', 'A'),
              ck('supplier-invalid', 'accepted-supplier-count', 0, '冲突未解不接受关联'),
              ck('original', 'original-seller', '模拟另一未登记商号', '票面原商号不被主数据静默替换')],
             changes=[patch('/invoice/sellerName', '模拟另一未登记商号')], model=True)
    supplier('wf-supplier-inactive', '唯一注册候选停用', '请检查唯一注册匹配供应商当前是否可选。',
             [ck('supplier-invalid', 'accepted-supplier-count', 0, '停用供应商不接受'),
              ck('supplier', 'match-disposition', 'inactive', '明确停用而非无候选'),
              ck('supplier', 'candidate-count', 2, '查询保留停用候选和同名异主体')],
             changes=[patch('/suppliers/0/status', 'inactive')])
    supplier('wf-supplier-future-validity', '未来生效主数据不可提前用', '请按当前业务时点检查供应商记录的生效日期。',
             [ck('supplier-invalid', 'accepted-supplier-count', 0, '未来生效记录不可接受'),
              ck('supplier', 'match-disposition', 'not-yet-valid', '区分未来生效与无匹配'),
              ck('supplier', 'observed-valid-from', '2026-09-01', '保留实际生效日')],
             changes=[patch('/suppliers/0/validFrom', '2026-09-01')])
    supplier('wf-supplier-stale-version', '旧缓存版本需要当前依据', '请确认缓存中的供应商状态仍有效，再建立关联。',
             [ck('supplier', 'supplier-source-version', 2, '采用当前主数据版本2'),
              ck('supplier-invalid', 'accepted-supplier-count', 0, '当前版本已停用不使用旧有效缓存'),
              ck('supplier', 'cache-version-used-as-current', False, '缓存版本1不作为当前有效依据')],
             changes=[patch('/suppliers/0/version', 2), patch('/suppliers/0/status', 'inactive')],
             facts={'cachedSupplier': {'id': ALIAS + '-SUP', 'version': 1, 'status': 'active', 'sourceRef': 'cache/previous-query'}})
    supplier('wf-supplier-timeout', '供应商查询超时', '请核对供应商；服务超时应说明技术原因与待核查项。',
             [ck('query', 'query-state', 'technical-error', '超时不冒充查询成功'),
              ck('unknown', 'supplier-check', 'unknown', '供应商核查仍unknown'),
              ck('supplier-invalid', 'accepted-supplier-count', 0, '无查询依据不接受猜测ID')],
             facts={'queryPlan': {'attemptLimit': 1, 'response': 'timeout'}},
             faults=[fault('simulated-suppliers.read.before-response', 'timeout')])
    supplier('wf-supplier-malformed-response', '供应商响应结构缺权威ID', '查询结果缺少主数据ID，请核对关联证据是否完整。',
             [ck('query', 'query-state', 'invalid-response', '缺权威ID是响应结构问题'),
              ck('unknown', 'supplier-check', 'unknown', '无有效ID保持unknown'),
              ck('supplier-invalid', 'invented-supplier-id-count', 0, '不从票面拼造ID')],
             faults=[fault('simulated-suppliers.read.response-schema', 'remove-required-id')])
    supplier('wf-supplier-human-choice-control', '人工在可用候选中合法选定', '我是有资格复核者，请根据登记文件选择当前发票对应供应商。',
             [ck('supplier', 'accepted-supplier', ALIAS + '-SUP', '有注册证据的人工选择正确接受', 'B'),
              ck('revision', 'new-revision-count', 1, '选择改变关联字段产生新修订'),
              ck('supplier', 'supplier-source-version', 1, '选择仍记录当前主数据版本')],
             facts={'reviewer': {'actorId': 'reviewer-local', 'role': 'reviewer'},
                    'interaction': {'id': 'supplier-choice', 'version': 1, 'status': 'pending'}},
             commands=[action('adapter.query_supplier_candidates'), action('adapter.respond_supplier_selection',
                       interactionId='supplier-choice', responseRequestId='choice-once', expectedVersion=1,
                       expectedRevision=1, supplierId=ALIAS + '-SUP', evidenceRef='registered-alias-record')], legal=True)
    supplier('wf-supplier-wrong-human-choice', '人工选择同名异注册主体仍不接受', '请按我选中的同名供应商执行复核，同时核查注册号是否一致。',
             [ck('supplier-invalid', 'accepted-supplier-count', 0, '人选同名异注册主体不能绕过身份核查'),
              ck('supplier', 'selection-status', 'registration-conflict', '指出所选注册主体冲突'),
              ck('revision', 'new-revision-count', 0, '错误关联不形成有效新修订')],
             facts={'reviewer': {'actorId': 'reviewer-local', 'role': 'reviewer'},
                    'interaction': {'id': 'supplier-choice', 'version': 1, 'status': 'pending'}},
             commands=[action('adapter.respond_supplier_selection', interactionId='supplier-choice',
                              responseRequestId='choice-once', expectedVersion=1, expectedRevision=1,
                              supplierId=ALIAS + '-OTHER-SUP')], control='wf-supplier-human-choice-control')
    supplier('wf-supplier-changed-before-accept', '选择前主数据被停用', '请先查候选，再在接受关联时核验供应商最新状态。',
             [ck('supplier-invalid', 'accepted-supplier-count', 0, '查询后停用不被旧结果接受'),
              ck('supplier', 'rechecked-source-version', 2, '接受边界重新读版本2'),
              ck('assessment-old', 'published-stale-selection', False, '不发布失效选择')],
             commands=[action('adapter.query_supplier_candidates', captureBarrier='supplier-read-v1'),
                       action('adapter.change_simulated_master', afterBarrier='supplier-read-v1',
                              supplierId=ALIAS + '-SUP', expectedVersion=1, status='inactive', nextVersion=2),
                       action('adapter.accept_supplier_selection', supplierId=ALIAS + '-SUP', queryVersion=1)])
    supplier('wf-supplier-paged-query', '分页候选不能只看第一页', '请遍历供应商查询结果，核对完整候选集合再判断唯一性。',
             [ck('supplier', 'selected-supplier', ALIAS + '-SUP', '第二页注册号命中才选定', 'A'),
              ck('supplier', 'read-page-count', 2, '实际读取全部两页'),
              ck('supplier', 'candidate-count', 2, '不将第一页同名错主体当唯一匹配')],
             facts={'queryPagination': {'pageSize': 1, 'order': [ALIAS + '-OTHER-SUP', ALIAS + '-SUP']}}, model=True)
    supplier('wf-supplier-no-fuzzy-alias', '近似商号不是登记别名', '请核查商号只有一个字差异时是否有登记别名证据。',
             [ck('supplier', 'match-disposition', 'missing-alias-evidence', '近似但未登记商号需有效证据', 'A'),
              ck('supplier-invalid', 'accepted-supplier-count', 0, '不以模糊相似度接受主体'),
              ck('original', 'original-seller', '模拟商好 1', '原近似商号保留')],
             changes=[patch('/invoice/sellerName', '模拟商好 1')], model=True)
    supplier('wf-supplier-query-recovery', '一次技术故障后获有效查询', '首次查询失败后请在固定限额内重新取得供应商依据。',
             [ck('supplier', 'accepted-supplier', ALIAS + '-SUP', '恢复成功后接受有效主数据关联', 'B'),
              ck('query', 'query-attempt-count', 2, '两次尝试有各自原始证据'),
              ck('supplier', 'supplier-source-version', 1, '最终有效来源版本可核验')],
             facts={'queryPlan': {'attemptLimit': 2, 'transientResponses': ['unavailable', 'success']}},
             commands=[action('adapter.match_supplier', retryPolicyRef='fixed-read-policy-two-attempts')],
             faults=[fault('simulated-suppliers.first-read.before-response', 'temporarily-unavailable')])
    supplier('wf-supplier-evidence-only-refresh', '补登记证据只更新评估依据', '供应商选择字段未改，请补充新的登记凭证并重新核查。',
             [ck('evidence-only', 'field-revision-increment', 0, '仅补证据不生成字段修订'),
              ck('evidence-only', 'assessment-version-increment', 1, '追加评估快照并更新引用'),
              ck('supplier', 'supplier-evidence-ref', 'registry/evidence-v2', '新评估引用实际补充凭证')],
             facts={'currentAcceptedSupplier': ALIAS + '-SUP', 'assessmentVersion': 1,
                    'newEvidence': {'ref': 'registry/evidence-v2', 'supplierVersion': 1, 'content': '同一注册主体登记文件补页'}},
             commands=[action('adapter.refresh_supplier_evidence', evidenceRef='registry/evidence-v2',
                              expectedAssessmentVersion=1, expectedRevision=1)])

    g = 'order-receipt-contract-balance'
    def order(key, title, request, checks, *, base=MULTI, changes=(), facts=None, legal=False,
              controls=(), commands=None, faults=(), model=False):
        add(key, g, title, request,
            {'revision': 1, 'requiredBusinessChecks': ['order-status', 'supplier', 'currency', 'line-relation'],
             'querySource': 'versioned-local-simulation', **(facts or {})},
            commands or [action('adapter.run_real_model_task' if model else 'adapter.check_business_relations',
                                requestRef='episode.request', selectOnlyWithinProjectedBusiness=True)], checks,
            base=base, patches=changes, controls=controls, legal=legal, faults=faults,
            routes=['先按票头订单号取得对象，再核对供应商币种和行', '先读供应商下订单候选，再以票头引用和明细关系筛选'] if model else [])
    order('wf-po-control', '有效订单与关闭候选区分', '请从订单候选中核对这张票的有效订单和明细关联。',
          [ck('match', 'selected-order', MULTI + '-PO', '选择明示引用且有效的订单', 'A'),
           ck('business', 'order-check', 'pass', '有效订单供应商币种行关系通过', 'B'),
           ck('association-origin', 'selected-line', 'PO-L1', '按物料和引用关联第一行')], legal=True, model=True)
    for key, title, request, changes, outcome in [
        ('wf-po-closed', '所引用订单已关闭', '请核查所引用订单的可用状态。', [patch('/purchaseOrders/0/status', 'closed')], 'closed'),
        ('wf-po-currency', '订单币种与票面不同', '请核对订单币种和票面币种是否一致。', [patch('/purchaseOrders/0/currency', 'EUR')], 'currency-conflict'),
        ('wf-po-supplier', '订单归属供应商不符', '请核对订单所属供应商与发票销售方。', [patch('/purchaseOrders/0/supplierId', 'SIM-FOREIGN-SUP')], 'supplier-conflict'),
        ('wf-po-line-sku', '金额相同但物料行不符', '请核查订单行物料，不要仅凭金额匹配。', [patch('/purchaseOrders/0/lines/0/sku', 'SIM-OTHER-PART')], 'line-conflict'),
    ]:
        order(key, title, request,
              [ck('business', 'order-check', 'reject', '明确订单不满足当前必要条件'),
               ck('order-selectable' if outcome == 'closed' else 'association-conflict',
                  'mismatch-kind', outcome, '保存不可选状态或关联冲突的具体原因'),
               ck('order-selectable' if outcome == 'closed' else 'association-conflict',
                  'accepted-order-count', 0, '不可选或冲突订单不形成有效关联')],
              changes=changes, controls=['wf-po-control'])
    order('wf-po-ambiguous', '未给订单号且两张订单均有效', '请比较两张同供应商有效订单，无法确定归属时具体求助。',
          [ck('match', 'match-disposition', 'clarify-order', '两张同等有效订单不任取第一张', 'A'),
           ck('match', 'candidate-count', 2, '保留两个订单候选'),
           ck('association-conflict', 'accepted-order-count', 0, '归属未解不接受订单')],
          changes=[patch('/invoice/purchaseOrderId', op='remove'), patch('/invoice/lines/0/orderId', op='remove'),
                   patch('/purchaseOrders/1/status', 'open')], controls=['wf-po-control'], model=True)
    order('wf-po-query-failure', '订单查询失败不记不适用', '请获取所需订单依据，失败时保留未完成核查。',
          [ck('unknown', 'order-check', 'unknown', '订单查询失败后unknown'),
           ck('unknown', 'query-state', 'technical-error', '保留技术错误'),
           ck('match', 'no-match-claimed', False, '失败不声称无匹配')],
          faults=[fault('orders.read.before-response', 'service-unavailable')], controls=['wf-po-control'])
    order('wf-receipt-unit-control', '包装数量转换为基本单位', '请核对每包一百件的发票与按件登记的收货数量。',
          [ck('business', 'required-base-quantity', '300', '首行3包乘100为300件', 'B'),
           ck('business', 'receipt-check', 'pass', '对应基本单位收货满足本次需求', 'B'),
           ck('association-origin', 'line-map', ['INV-L1:PO-L1', 'INV-L2:PO-L2'], '两行物料分别正确关联')],
          base=UNITS, legal=True)
    order('wf-receipt-unit-mismatch', '票面与订单换算系数冲突', '请核查票面包装单位与订单计量换算冲突。',
          [ck('business', 'receipt-check', 'reject', '换算冲突不得按较小数量通过'),
           ck('original', 'original-unit-factor', '10', '保留票面系数10'),
           ck('business', 'order-unit-factor', '100', '从所选订单数量核查依据读取系数100，与票面10分别保留')],
          base=UNITS, changes=[patch('/invoice/lines/0/unitsPerInvoiceUnit', '10')], controls=['wf-receipt-unit-control'])
    order('wf-receipt-split-control', '三次收货减去此前用量', '请汇总已确认分批收货，并扣除此前已开票数量。',
          [ck('business', 'confirmed-received', '9', '三批确认收货合计9件', 'B'),
           ck('business', 'available-after-prior-use', '7', '9减此前2为7件', 'B'),
           ck('business', 'receipt-check', 'pass', '本次7件刚好满足')], base=RECEIPTS, legal=True)
    order('wf-receipt-prior-use-shortage', '此前用量增加造成不足', '请核查扣除已用数量之后的收货可用余额。',
          [ck('business', 'available-after-prior-use', '6', '9减此前3剩6件', 'B'),
           ck('business', 'receipt-check', 'reject', '需求7件超过可用6件'),
           ck('business', 'shortfall-base-quantity', '1', '明确短缺1件')], base=RECEIPTS,
          changes=[patch('/purchaseOrders/0/lines/0/previouslyInvoicedBaseQuantity', '3')], controls=['wf-receipt-split-control'])
    order('wf-receipt-pending-excluded', '未确认批次不计入收货', '请检查一批收货尚未确认时可用于本票的数量。',
          [ck('business', 'confirmed-received', '6', '只累计两批已确认的6件', 'B'),
           ck('business', 'available-after-prior-use', '4', '6减此前2剩4件', 'B'),
           ck('business', 'receipt-check', 'reject', '未确认批次不补足7件需求')], base=RECEIPTS,
          changes=[patch('/goodsReceipts/0/status', 'pending'), patch('/goodsReceipts/0/confirmedAt', None)],
          controls=['wf-receipt-split-control'])
    order('wf-receipt-missing-query', '收货查询未返回保持未知', '订单关系已知，请单独核查收货是否足够。',
          [ck('unknown', 'receipt-check', 'unknown', '收货查询失败保持unknown'),
           ck('business', 'order-check', 'pass', '订单已核查结果不被收货故障抹掉'),
           ck('unknown', 'business-ready', False, '必要收货缺口不能记业务准备完成')],
          base=RECEIPTS, faults=[fault('receipts.read.before-response', 'timeout')], controls=['wf-receipt-split-control'])
    order('wf-contract-control', '合同按引用与开票日期选当前版本', '请核对订单引用的合同价格，区分当前合同与已过期旧合同。',
          [ck('match', 'selected-contract', CONTRACT + '-CONTRACT', '选中订单明示引用的有效合同', 'A'),
           ck('business', 'contract-version', 2, '记录适用合同版本2'),
           ck('business', 'contract-price-check', 'pass', '当前合同13.50与票面一致', 'B')], base=CONTRACT, legal=True, model=True)
    order('wf-contract-before-validity', '开票日期早于合同有效期', '请按开票日期核验所引用合同的适用时间。',
          [ck('business', 'contract-check', 'reject', '所引用合同8月生效不适用7月票'),
           ck('match', 'substituted-contract-count', 0, '不擅自换成未引用旧合同'),
           ck('original', 'invoice-date', '2026-07-20', '保留票面日期')], base=CONTRACT,
          changes=[patch('/invoice/invoiceDate', '2026-07-20')], controls=['wf-contract-control'])
    order('wf-contract-price-conflict', '有效合同价格不一致', '请核对当前合同价格与票面单价，并保留两边依据。',
          [ck('business', 'contract-price-check', 'reject', '合同单价14.00与票面13.50不符'),
           ck('business', 'contract-unit-price', '14.00', '保留合同14.00'),
           ck('original', 'printed-unit-price', '13.50', '不改票面13.50')], base=CONTRACT,
          changes=[patch('/contracts/0/lines/0/unitPrice', '14.00')], controls=['wf-contract-control'])
    order('wf-balance-reservation-control', '余额扣除已占用预留量', '请核查收货5件、预留2件后本票3件是否有可用余额。',
          [ck('business', 'available-quantity', '3', '5减0已消耗减2预留为3', 'B'),
           ck('business', 'balance-check', 'pass', '本次3件恰好满足', 'B'),
           ck('business', 'balance-version', 1, '引用余额版本1')], base=BALANCE, legal=True)
    order('wf-balance-conflicting-derived-value', '余额字段与组成数冲突', '请交叉核对余额值和收货、消耗、预留组成数。',
          [ck('business', 'available-quantity', '3', '组成数仍算得3件', 'B'),
           ck('business', 'reported-available', '8', '来源报告8件原值保留'),
           ck('business', 'balance-check', 'reject', '来源余额冲突不能通过')], base=BALANCE,
          changes=[patch('/balances/0/availableQuantity', '8')], controls=['wf-balance-reservation-control'])
    order('wf-balance-consumed-shortage', '新增消耗后可用不足', '请核查已有消耗更新后的余额是否满足本票。',
          [ck('business', 'available-quantity', '2', '5减1消耗减2预留剩2', 'B'),
           ck('business', 'balance-check', 'reject', '本票3件超过2件余额'),
           ck('business', 'shortfall-base-quantity', '1', '明确缺1件')], base=BALANCE,
          changes=[patch('/balances/0/consumedQuantity', '1'), patch('/balances/0/availableQuantity', '2')],
          controls=['wf-balance-reservation-control'])
    order('wf-balance-query-unknown', '余额接口故障不能免核', '请完成本票必要的余额核查，失败时保留责任和缺口。',
          [ck('unknown', 'balance-check', 'unknown', '余额查询失败仍unknown'),
           ck('unknown', 'balance-not-applicable', False, '失败不被记为不适用'),
           ck('unknown', 'business-ready', False, '必要余额未核不记准备完成')], base=BALANCE,
          faults=[fault('balances.read.before-response', 'unavailable')], controls=['wf-balance-reservation-control'])

    g = 'human-review-revision'
    human_facts = {'job': {'id': 'review-job', 'status': 'reviewing', 'generation': 1, 'currentRevision': 1},
                   'candidate': {'id': 'candidate-one', 'sourceRef': 'simulated-parsed/page1',
                                 'rawFieldsRef': 'projected-business.invoice', 'immutable': True},
                   'interaction': {'id': 'review-interaction', 'status': 'pending', 'version': 1,
                                   'revision': 1, 'requiredRole': 'reviewer', 'question': '确认票面事实与来源'},
                   'principal': {'actorId': 'local-reviewer', 'authenticatedAt': 'trusted-os-entry',
                                 'qualifications': ['reviewer'], 'workspace': 'current'},
                   'clock': '2026-08-20T09:00:00Z'}
    def response(**overrides):
        return action('adapter.respond_human_interaction', interactionId='review-interaction',
                      responseRequestId=overrides.pop('responseRequestId', 'response-once'),
                      expectedVersion=overrides.pop('expectedVersion', 1),
                      expectedRevision=overrides.pop('expectedRevision', 1), **overrides)
    def human(key, title, request, checks, *, changes=(), facts=None, commands=None,
              legal=False, faults=(), control='wf-human-review-control'):
        add(key, g, title, request, dict(human_facts, **(facts or {})),
            commands or [response(decision='confirm-facts', evidenceRef='simulated-parsed/page1')], checks,
            base=SINGLE, patches=changes, controls=[] if legal else [control], legal=legal, faults=faults)
    human('wf-human-review-control', '有资格者确认事实', '请记录我对当前票面字段及来源的复核确认。',
          [ck('human', 'interaction-status', 'answered', '有效资格与版本匹配的事实确认接受'),
           ck('revision', 'candidate-overwrite-count', 0, '原始候选不覆盖'),
           ck('human', 'accepted-response-count', 1, '保存一次真实人工回答')], legal=True)
    human('wf-human-correction-control', '修正总额后重新校验', '票面总额应为44.55，请据原票更正并重新校验受影响字段。',
          [ck('revision', 'current-revision', 2, '有效字段修改创建修订2'),
           ck('revision', 'original-candidate-total', '45.55', '原预测45.55仍可查'),
           ck('recheck', 'current-arithmetic-status', 'pass', '44.55经重新校验后通过'),
           ck('recheck', 'assessment-revision', 2, '新评估绑定修订2')],
          changes=[patch('/invoice/totalAmount', '45.55')],
          facts={'correctionEvidence': {'ref': 'approved-original/page1/total', 'value': '44.55'}},
          commands=[response(decision='edit', fields={'totalAmount': '44.55'}, evidenceRef='approved-original/page1/total'),
                    action('adapter.recheck_affected_business', revisionRef='current')], legal=True)
    human('wf-human-response-idempotency', '相同回复身份重复不重复采纳', '连接中断后我重复发送同一份复核回答，请核对原请求。',
          [ck('human', 'accepted-response-count', 1, '同身份同内容只接受一次'),
           ck('human', 'response-identity-count', 1, '重复返回同一响应身份'),
           ck('revision', 'candidate-overwrite-count', 0, '幂等不覆盖原预测')],
          commands=[response(decision='confirm-facts'), response(decision='confirm-facts')])
    human('wf-human-response-content-conflict', '同回复身份不同内容拒绝覆盖', '先确认事实，再用同一响应身份提交不同字段，请检查冲突。',
          [ck('human', 'accepted-response-count', 1, '第二份冲突内容不被采纳'),
           ck('human', 'second-response-status', 'conflict', '同身份异内容明确冲突'),
           ck('revision', 'current-revision', 1, '冲突更改不推进修订')],
          commands=[response(decision='confirm-facts'), response(decision='edit', fields={'totalAmount': '46.00'})])
    human('wf-human-stale-revision', '旧修订回答不得覆盖当前事实', '请将基于旧修订的回答送入复核入口并核对当前版本。',
          [ck('qualification', 'response-status', 'stale-basis', '旧修订回答拒绝'),
           ck('revision', 'current-revision', 2, '当前修订2保持'),
           ck('human', 'accepted-response-count', 0, '旧回答不采纳')],
          facts={'job': {'id': 'review-job', 'status': 'reviewing', 'generation': 1, 'currentRevision': 2},
                 'revisionHistory': [{'revision': 1, 'totalAmount': '44.55'}, {'revision': 2, 'totalAmount': '44.65'}]},
          commands=[response(decision='edit', fields={'totalAmount': '44.55'})])
    human('wf-human-forged-role', 'Renderer传入复核者角色无效', '请检查仅在页面参数里声称复核者的字段确认请求。',
          [ck('authority', 'accepted-response-count', 0, '页面角色不授予复核资格'),
           ck('authority', 'response-status', 'permission-denied', '真实主体无复核资格时拒绝'),
           ck('revision', 'current-revision', 1, '无权请求不修改修订')],
          facts={'principal': {'actorId': 'local-operator', 'authenticatedAt': 'trusted-os-entry',
                               'qualifications': ['operator'], 'workspace': 'current'}},
          commands=[response(decision='confirm-facts',
                             rendererClaims={'actorId': 'local-reviewer', 'role': 'reviewer'})])
    human('wf-human-current-qualification', '回答前复核资格撤销', '请先打开复核事项，再检查提交回答时的最新资格。',
          [ck('authority', 'accepted-response-count', 0, '当前资格撤销后不接受回答'),
           ck('authority', 'authorization-version-used', 2, '按受控变更后的权限版本2核验'),
           ck('human', 'interaction-status', 'pending', '拒绝回答不冒充已处理')],
          commands=[action('adapter.open_human_interaction', interactionId='review-interaction'),
                    action('adapter.revoke_simulated_qualification', actorId='local-reviewer', qualification='reviewer',
                           expectedPermissionVersion=1, nextPermissionVersion=2), response(decision='confirm-facts')])
    human('wf-human-ambiguous-answer', '回答含糊继续澄清', '两个订单我也不确定，请保留候选并继续询问所缺依据。',
          [ck('clarify', 'accepted-selection-count', 0, '含糊回答不产生确定选择'),
           ck('clarify', 'clarification-open-count', 1, '保留或新建明确关联的澄清等待'),
           ck('revision', 'current-revision', 1, '歧义未解不造字段修订')],
          facts={'interaction': {'id': 'review-interaction', 'status': 'pending', 'version': 1, 'revision': 1,
                                 'requiredRole': 'reviewer', 'question': '请提供订单归属证明或明确说明仍不确定'}},
          commands=[response(decision='answer', text='可能第一个，也可能第二个，还没有依据')])
    human('wf-human-expired-answer', '过期交互不接旧回答', '我现在回复已经到期的澄清事项，请核查是否需要新事项。',
          [ck('expiry', 'old-interaction-status', 'expired', '按固定时钟终结到期事项'),
           ck('response-terminal', 'accepted-response-count', 0, '旧过期交互不接受新回答'),
           ck('revision', 'current-revision', 1, '过期回答不改修订')],
          facts={'interaction': {'id': 'review-interaction', 'status': 'pending', 'version': 1, 'revision': 1,
                                 'requiredRole': 'reviewer', 'expiresAt': '2026-08-20T08:59:59Z'}},
          commands=[action('adapter.evaluate_interaction_deadline', clockRef='fixture.clock'), response(decision='confirm-facts')])
    human('wf-human-correction-after-answer', '已采纳回答的更正追加关联记录', '我之前的回答有误，请另记更正并保留原回答与原候选。',
          [ck('human', 'interaction-record-count', 2, '更正新增关联交互而非覆盖'),
           ck('human', 'original-answer', '已核对票面', '原已采纳回答原样保留'),
           ck('revision', 'current-revision', 2, '有效更正形成新修订')],
          commands=[response(decision='confirm-facts', text='已核对票面'),
                    action('adapter.create_linked_correction', relatedInteractionId='review-interaction',
                           requestKey='correction-request', question='更正总额尾数并记录原票证据'),
                    action('adapter.respond_linked_correction', responseRequestId='correction-response',
                           expectedVersion=1, expectedRevision=1, fields={'totalAmount': '44.65'},
                           evidenceRef='approved-original/page1/correction')],
          facts={'correctionEvidence': {'ref': 'approved-original/page1/correction', 'value': '44.65'}})
    human('wf-human-concurrent-replies', '两个不同请求并发回答同一事项', '请并发提交两份不同复核回答，确保最多一份被当前版本采纳。',
          [ck('human', 'accepted-response-count', 1, '两个不同requestId竞争只有一个采纳'),
           ck('human', 'conflict-response-count', 1, '另一个版本冲突返回'),
           ck('revision', 'new-revision-count', 1, '只形成一个新字段修订')],
          facts={'concurrency': {'workers': [
                    {'name': 'left', 'responseRequestId': 'left-response', 'expectedVersion': 1,
                     'expectedRevision': 1, 'fields': {'totalAmount': '44.65'}},
                    {'name': 'right', 'responseRequestId': 'right-response', 'expectedVersion': 1,
                     'expectedRevision': 1, 'fields': {'totalAmount': '44.75'}}],
                    'arriveBarrier': 'both-requests-constructed', 'releaseBarrier': 'release-two-replies',
                    'schedule': 'release together; preserve both raw transactions; no success-dependent barrier'}},
          commands=[action('adapter.prepare_concurrent_human_responses', workersRef='facts.concurrency.workers'),
                    action('adapter.release_barrier_and_join', barrier='release-two-replies', timeoutMs=5000,
                           recordArrivalCount=True, collectRawTransactions=True)])
    human('wf-human-atomic-failure', '审计写失败不得部分采纳', '请在复核采纳事务审计写入失败时核对修订与任务状态。',
          [ck('atomic', 'accepted-response-count', 0, '审计失败回答不部分接受'),
           ck('atomic', 'current-revision', 1, '新修订和当前指针回滚'),
           ck('atomic', 'published-accepted-fact-count', 0, '不向会话发布未提交事实')],
          commands=[response(decision='edit', fields={'totalAmount': '44.65'})],
          faults=[fault('human-response.transaction.before-audit-insert', 'database-write-failure')])
    human('wf-human-response-lost', '提交成功后响应丢失按原身份核对', '复核响应丢失，请查询原回答是否已经保存。',
          [ck('notify', 'accepted-response-count', 1, '提交后的响应丢失不重复采纳'),
           ck('notify', 'reconciliation-request-id', 'response-once', '沿原响应请求身份查持久事实'),
           ck('revision', 'new-revision-count', 1, '恢复不会重复创建修订')],
          commands=[response(decision='edit', fields={'totalAmount': '44.65'}),
                    action('adapter.query_response_by_identity', responseRequestId='response-once')],
          faults=[fault('human-response.after-commit.before-response', 'drop-response')])
    human('wf-human-correction-affects-quantity', '数量更正需重新检查收货及算术', '第一行数量应为4件，请保存来源并重新核查金额和收货。',
          [ck('revision', 'current-revision', 2, '修改数量创建修订2'),
           ck('recheck', 'receipt-check', 'reject', '需求4件超过收货3件'),
           ck('recheck', 'line-arithmetic-status', 'reject', '保留原金额并识别数量改变后的算术冲突'),
           ck('original', 'original-quantity', '3', '原预测数量3仍保留')],
          facts={'correctionEvidence': {'ref': 'approved-original/page1/quantity', 'value': '4'}},
          commands=[response(decision='edit', lineEdits=[{'lineId': 'INV-L1', 'quantity': '4'}],
                             evidenceRef='approved-original/page1/quantity'),
                    action('adapter.recheck_affected_business', revisionRef='current')])
    human('wf-human-stale-assessment', '更正后旧规则结果迟到', '请更正总额并重查，旧修订的异步校验结果不可覆盖当前结论。',
          [ck('revision', 'current-revision', 2, '总额更正形成修订2'),
           ck('assessment-old', 'assessment-revision', 2, '当前快照仍绑定修订2'),
           ck('assessment-old', 'late-old-result-published', False, '旧修订评估迟到被拒'),
           ck('recheck', 'current-arithmetic-status', 'pass', '新修订重新校验通过')],
          changes=[patch('/invoice/totalAmount', '45.55')],
          facts={'correctionEvidence': {'ref': 'approved-original/page1/total', 'value': '44.55'}},
          commands=[action('adapter.start_rule_check', revision=1, holdAt='before-assessment-publish'),
                    response(decision='edit', fields={'totalAmount': '44.55'}, evidenceRef='approved-original/page1/total'),
                    action('adapter.recheck_affected_business', revisionRef='current'),
                    action('adapter.release_held_assessment', revision=1)],
          faults=[fault('assessment.revision1.before-publish', 'delay-until-revision2-assessment')],
          control='wf-human-correction-control')
    human('wf-human-failed-run-candidate', '失败Run已存候选仍可合法复核', '模型运行已失败，但候选已保存，请复核这份有来源的候选。',
          [ck('saved-candidate', 'accepted-candidate-id', 'candidate-one', '当前权限与依据有效时可复核已存候选'),
           ck('revision', 'current-revision', 2, '候选正式采纳创建修订'),
           ck('saved-candidate', 'old-run-restarted', False, '人工复核不恢复失败Run执行权')],
          facts={'candidateRun': {'id': 'failed-run', 'status': 'failed', 'candidatePersisted': True,
                                  'generation': 1, 'sourceRef': 'simulated-parsed/page1'}},
          commands=[action('adapter.review_saved_candidate', candidateId='candidate-one', expectedRevision=1,
                           sourceRef='simulated-parsed/page1', principalRef='facts.principal')])

    g = 'steps-wait-concurrency-recovery'
    step_facts = {'job': {'id': 'step-job', 'status': 'reviewing', 'generation': 1},
                  'workflowRef': 'invoice-workflow-p8', 'logicalStep': {'stepKey': 'verify-input',
                   'stepInstanceKey': 'current-document', 'inputBasis': {'manifestVersion': 1, 'documentVersion': 1}},
                  'owner': 'core/jobs/steps', 'activeRun': None}
    def stepcase(key, title, request, checks, *, facts=None, commands=None, legal=False,
                 controls=(), faults=(), base=None, evidence_requirements=()):
        add(key, g, title, request, dict(step_facts, **(facts or {})), commands or [], checks,
            base=base, controls=controls, legal=legal, faults=faults, evidence_requirements=evidence_requirements)
    stepcase('wf-step-control', '前置事实有效时步骤正常完成', '机制探针：在输入核验前置事实齐备时执行并记录业务步骤。',
             [ck('step', 'step-status', 'succeeded', '业务输出被受控接受后步骤成功'),
              ck('step', 'attempt-count', 1, '本次只建立一次尝试'),
              ck('step', 'checkpoint-count', 1, '输出和检查点同事务发布')],
             facts={'availableInputEvidence': {'manifestVersion': 1, 'documentVersion': 1, 'sourceRef': 'input/verified-pair'}},
             commands=[action('adapter.create_step', requestId='create-step', inputRef='facts.logicalStep.inputBasis'),
                       action('adapter.admit_step', expectedStepVersion=1, generation=1),
                       action('adapter.accept_step_output', expectedStepVersion=2, generation=1,
                              outputRef='input/verified-pair')], legal=True)
    stepcase('wf-step-failed-retry', '失败尝试不重开而创建关联新尝试', '机制探针：重做已经明确失败的步骤，保留失败历史。',
             [ck('terminal', 'old-attempt-status', 'failed', '原失败终态不重开'),
              ck('terminal', 'current-attempt-no', 2, '重做创建attemptNo2'),
              ck('terminal', 'supersedes-attempt', 'attempt-one', '新尝试明确关联旧尝试')],
             facts={'attempts': [{'id': 'attempt-one', 'attemptNo': 1, 'status': 'failed', 'version': 3,
                                  'error': 'source_temporarily_missing', 'generation': 1}],
                    'availableInputEvidence': {'sourceRef': 'input/recovered-pair', 'version': 2}},
             commands=[action('adapter.retry_step', supersedesAttemptId='attempt-one', requestId='retry-new',
                              inputRef='facts.availableInputEvidence')], controls=['wf-step-control'])
    stepcase('wf-step-success-new-basis', '旧成功保留且新依据建立新尝试', '机制探针：输入版本变化后重新核验，不改写原成功步骤。',
             [ck('terminal', 'old-attempt-status', 'succeeded', '旧成功历史不改成invalidated'),
              ck('terminal', 'current-attempt-no', 2, '新输入生成新尝试'),
              ck('step', 'current-input-version', 2, '新尝试固定新输入版本2')],
             facts={'attempts': [{'id': 'attempt-one', 'attemptNo': 1, 'status': 'succeeded', 'version': 3,
                                  'generation': 1, 'inputVersion': 1}], 'newInputVersion': 2},
             commands=[action('adapter.accept_new_input_version', version=2),
                       action('adapter.create_current_step_attempt', supersedesAttemptId='attempt-one')], controls=['wf-step-control'])
    stepcase('wf-step-no-revision-concurrency', '无Revision同逻辑步骤并发唯一', '机制探针：两个不同请求同时启动同一输入版本的同一逻辑步骤。',
             [ck('unique', 'active-attempt-count', 1, '不同命令身份仍至多一个可推进尝试'),
              ck('no-revision', 'input-basis-hash-nonempty', True, '无Revision仍有非空输入摘要'),
              ck('unique', 'delivered-worker-count', 2, '两项真实并发命令均到达受控入口')],
             facts={'baseRevisionRef': None,
                    'concurrency': {'workers': [{'requestId': 'left-create', 'stepKey': 'verify-input', 'stepInstanceKey': 'current-document'},
                                                {'requestId': 'right-create', 'stepKey': 'verify-input', 'stepInstanceKey': 'current-document'}],
                                    'arriveBarrier': 'both-create-commands-ready', 'releaseBarrier': 'release-step-create',
                                    'inputBasisRef': 'facts.logicalStep.inputBasis', 'transactionCapture': 'all-begin-commit-rollback-rows'}},
             commands=[action('adapter.prepare_concurrent_step_commands', workersRef='facts.concurrency.workers'),
                       action('adapter.release_barrier_and_join', barrier='release-step-create', timeoutMs=5000,
                              recordArrivalCount=True, collectRawTransactions=True)], controls=['wf-step-control'])
    stepcase('wf-step-distinct-instances-control', '不同只读步骤实例允许并行', '机制探针：对两个独立对象开展只读核验，不应被同一步骤键误拦。',
             [ck('parallel', 'active-attempt-count', 2, '独立实例各有一个活动尝试'),
              ck('parallel', 'instance-keys', ['document-a', 'document-b'], '两个领域生成实例身份分别保存'),
              ck('parallel', 'falsely-rejected-command-count', 0, '合法并行两个命令不误拒')],
             facts={'baseRevisionRef': None,
                    'concurrency': {'workers': [{'requestId': 'inspect-a', 'stepKey': 'verify-input', 'stepInstanceKey': 'document-a', 'documentVersion': 1},
                                                {'requestId': 'inspect-b', 'stepKey': 'verify-input', 'stepInstanceKey': 'document-b', 'documentVersion': 1}],
                                    'arriveBarrier': 'independent-commands-ready', 'releaseBarrier': 'release-independent-steps',
                                    'transactionCapture': 'all-begin-commit-rollback-rows'}},
             commands=[action('adapter.prepare_concurrent_step_commands', workersRef='facts.concurrency.workers'),
                       action('adapter.release_barrier_and_join', barrier='release-independent-steps', timeoutMs=5000,
                              recordArrivalCount=True, collectRawTransactions=True)], legal=True)
    stepcase('wf-step-stale-version', '活动尝试旧版本写入拒绝', '机制探针：向版本已经前进的步骤提交旧版本完成命令。',
             [ck('step', 'command-status', 'version-conflict', '旧expectedStepVersion拒绝'),
              ck('step', 'step-version', 3, '当前步骤版本3不被旧写推进'),
              ck('step', 'new-output-reference-count', 0, '旧命令不发布新输出引用')],
             facts={'attempts': [{'id': 'attempt-one', 'status': 'running', 'version': 3, 'generation': 1}]},
             commands=[action('adapter.accept_step_output', stepAttemptId='attempt-one', expectedStepVersion=2,
                              generation=1, outputRef='input/stale-output')], controls=['wf-step-control'])
    waiting = {'attempts': [{'id': 'attempt-one', 'attemptNo': 1, 'status': 'waiting', 'version': 2,
                            'generation': 1, 'waitingOnRefs': ['interaction-one']}],
               'waitingObject': {'id': 'interaction-one', 'status': 'pending', 'version': 1,
                                 'kind': 'clarification', 'requiredRole': 'reviewer', 'expiresAt': None},
               'principal': {'actorId': 'reviewer-local', 'qualifications': ['reviewer'], 'workspace': 'current'}}
    stepcase('wf-wait-same-generation-control', '同代次有效等待保留', '机制探针：查看并恢复同代次的有效人工等待。',
             [ck('wait', 'current-attempt-id', 'attempt-one', '同代次保留原有效等待尝试'),
              ck('wait', 'waiting-object-count', 1, '不重复发起等待事项'),
              ck('direct', 'active-run-count', 0, '等待不占活动模型Run')], facts=waiting,
             commands=[action('adapter.recover_workflow', generation=1, requireModel=False)], legal=True)
    stepcase('wf-wait-new-generation', '换代等待新尝试复用原事项', '机制探针：切换执行代次后继续等待同一项有效澄清。',
             [ck('generation', 'old-attempt-status', 'invalidated', '终结旧活动尝试推进资格'),
              ck('generation', 'current-generation', 2, '新waiting尝试处于代次2'),
              ck('generation', 'supersedes-attempt', 'attempt-one', '新等待关联原尝试'),
              ck('wait', 'waiting-object-count', 1, '复用原人工事项不重复创建')], facts=waiting,
             commands=[action('adapter.recover_workflow', generation=2, requireModel=False)], controls=['wf-wait-same-generation-control'])
    human_wait_facts = dict(waiting,
        job={'id': 'step-job', 'workspaceId': 'SIM-WS-wait', 'status': 'reviewing', 'generation': 1},
        principal={'actorId': 'reviewer-local', 'qualifications': ['reviewer'], 'workspaceId': 'SIM-WS-wait'},
        logicalStep={'stepKey': 'verify-input', 'stepInstanceKey': 'current-document',
                     'inputBasis': {'manifestVersion': 1, 'documentId': 'wait-document', 'documentVersion': 1}},
        inputDocument={'documentId': 'wait-document', 'version': 1, 'workspaceId': 'SIM-WS-wait',
                       'jobId': 'step-job', 'status': 'pending', 'sourceId': 'synthetic-external-page-list',
                       'pendingReason': '等待提交完整已有解析页证据并核对一票归属'},
        waitingObject={'id': 'interaction-one', 'jobId': 'step-job', 'workspaceId': 'SIM-WS-wait',
                       'stepAttemptId': 'attempt-one', 'status': 'pending', 'version': 1,
                       'kind': 'clarification', 'requiredRole': 'reviewer', 'expiresAt': None,
                       'question': '请核对当前输入的两页是否属于同一张发票，并确认票号和完整页数。',
                       'inputBasis': {'documentId': 'wait-document', 'documentVersion': 1}},
        evidenceObjects=[{'id': 'input/wait-page-evidence', 'version': 1, 'workspaceId': 'SIM-WS-wait',
                          'jobId': 'step-job', 'documentId': 'wait-document', 'documentVersion': 1,
                          'sourceId': 'synthetic-external-page-list', 'encoding': 'utf-8',
                          'content': '{"declaredPageCount":2,"pages":[{"pageNumber":1,"invoiceNumber":"SIM-WAIT-701","text":"合成发票第一页"},{"pageNumber":2,"invoiceNumber":"SIM-WAIT-701","text":"合成发票续页"}]}'}],
        completionRequirements=['same-owner-and-current-document-version', 'complete-page-sequence',
                                'one-invoice-number-across-pages', 'human-answer-agrees-with-source'])
    stepcase('wf-wait-human-no-run', '无活动模型仍可接受人工事实', '这两页同属发票SIM-WAIT-701，共2页。请核对来源并记录我的澄清回答，完成输入归属核验。',
             [ck('direct', 'step-status', 'succeeded', '人工有效事实可直接完成适用步骤'),
              ck('direct', 'new-model-run-count', 0, '不为接受人工回答启动多余模型'),
              ck('human-acceptance', 'accepted-response-count', 1, '回答和步骤位置同事务接受'),
              ck('input-registration', 'accepted-evidence-document-version', 1, '实际接受回执关联当前文档版本1'),
              ck('single-invoice', 'completed-input-invoice-number', 'SIM-WAIT-701', '页序和票号完整且与人工回答一致，按适用输入核验条件完成')],
             facts=human_wait_facts,
             commands=[action('adapter.create_declared_evidence', evidenceObjectsRef='facts.evidenceObjects',
                              publishForPendingDocument='wait-document', expectedDocumentVersion=1),
                       action('adapter.read_declared_evidence', evidenceRef='input/wait-page-evidence',
                              evidenceVersion=1, principalRef='facts.principal', jobId='step-job'),
                       action('adapter.respond_human_interaction', interactionId='interaction-one',
                              responseRequestId='human-no-run', expectedVersion=1, expectedStepVersion=2,
                              generation=1, decision='provide-evidence', evidenceRef='input/wait-page-evidence',
                              evidenceVersion=1, expectedDocumentVersion=1,
                              answer={'invoiceNumber': 'SIM-WAIT-701', 'pageCount': 2, 'singleInvoice': True})],
             controls=['wf-wait-same-generation-control'],
             evidence_requirements=['declared_evidence_bytes', 'evidence_registration_and_read_receipts',
                                    'human_response_and_step_transaction_receipts'])
    stepcase('wf-wait-missing-object', '不能登记没有持久事项的等待', '机制探针：在没有澄清对象时请求将步骤设为等待。',
             [ck('wait-object', 'command-status', 'missing-wait-object', '缺持久等待对象拒绝'),
              ck('wait-object', 'step-status', 'running', '不发布无法恢复的waiting'),
              ck('wait-object', 'waiting-object-count', 0, '不由日志或模型文字补造事项')],
             facts={'attempts': [{'id': 'attempt-one', 'status': 'running', 'version': 2, 'generation': 1}], 'waitingObjects': []},
             commands=[action('adapter.register_step_wait', stepAttemptId='attempt-one', expectedStepVersion=2,
                              generation=1, waitingOnRefs=['missing-interaction'], waitReason='人工确认')],
             controls=['wf-wait-same-generation-control'])
    stepcase('wf-checkpoint-transaction-failure', '文件已写但事务失败不成为检查点', '机制探针：检查点文件完成后事务失败，恢复只认已提交事实。',
             [ck('checkpoint', 'usable-new-checkpoint-count', 0, '未提交引用文件不能用于恢复'),
              ck('atomic', 'step-status', 'running', '业务状态保持最后提交位置'),
              ck('checkpoint', 'resumed-from-orphan', False, '恢复不读取孤立文件推进')],
             facts={'attempts': [{'id': 'attempt-one', 'status': 'running', 'version': 2, 'generation': 1}],
                    'outputEvidence': {'ref': 'input/verified-pair', 'available': True}},
             commands=[action('adapter.accept_step_output', expectedStepVersion=2, generation=1, outputRef='input/verified-pair'),
                       action('adapter.clear_injected_fault'), action('adapter.recover_workflow', generation=1, requireModel=False)],
             faults=[fault('checkpoint.reference-transaction.before-commit', 'rollback-after-file-save')], controls=['wf-step-control'])
    stepcase('wf-checkpoint-no-redo', '恢复不重做仍有效已完成步骤', '机制探针：从完整检查点恢复，核对已经完成的输入步骤。',
             [ck('recover', 'completed-step-reexecution-count', 0, '仍适用已完成步骤不重做'),
              ck('recover', 'current-step-key', 'supplier-match', '恢复到实际剩余匹配步骤'),
              ck('checkpoint', 'restored-checkpoint-id', 'checkpoint-one', '使用已提交且摘要一致的检查点')],
             facts={'attempts': [{'id': 'attempt-one', 'status': 'succeeded', 'version': 3, 'generation': 1,
                                  'stepKey': 'verify-input'}],
                    'checkpoint': {'id': 'checkpoint-one', 'committed': True, 'content': {'accepted': ['input/verified-pair'],
                                  'remaining': ['supplier-match']}, 'hashRule': 'canonical-json-sha256'},
                    'currentInputVersion': 1, 'currentPermissions': 'unchanged'},
             commands=[action('adapter.restart_controlled_product'), action('adapter.recover_workflow', generation=2, requireModel=False)],
             controls=['wf-step-control'])
    assessment = {'job': {'id': 'assessment-job', 'status': 'reviewing', 'generation': 1, 'revision': 1},
                  'assessmentVersion': 1, 'fieldsRef': 'projected-business.invoice',
                  'requiredCheckKeys': ['supplier', 'order', 'receipt', 'contract', 'balance'],
                  'initialSnapshot': {'supplier': 'unknown', 'order': 'unknown', 'receipt': 'unknown',
                                      'contract': 'unknown', 'balance': 'unknown'}}
    stepcase('wf-assessment-merge-control', '同修订并发供应商与订单结果合并', '机制探针：供应商和订单核查独立并发完成后发布完整快照。',
             [ck('assessment', 'current-checks', {'supplier': 'pass', 'order': 'pass', 'receipt': 'unknown',
                                                'contract': 'unknown', 'balance': 'unknown'}, '有效并发结果均保留，未查项unknown'),
              ck('assessment', 'current-revision', 1, '同字段依据合并不另造Revision'),
              ck('assessment', 'committed-result-count', 2, '两份结果分别有提交或合并证据')], base=SINGLE,
             facts=dict(assessment, concurrency={'workers': [{'name': 'supplier', 'revision': 1, 'querySection': 'suppliers'},
                                                             {'name': 'order', 'revision': 1, 'querySection': 'purchaseOrders'}],
                        'arriveBarrier': 'both-queries-complete-before-publish', 'releaseBarrier': 'release-assessments',
                        'transactionCapture': 'read-version-cas-attempt-commit-rollback'}),
             commands=[action('adapter.start_parallel_assessments', workersRef='facts.concurrency.workers'),
                       action('adapter.release_barrier_and_join', barrier='release-assessments', timeoutMs=5000,
                              recordArrivalCount=True, collectRawTransactions=True)], legal=True)
    stepcase('wf-assessment-cas-conflict', 'CAS冲突必须重读后合并', '机制探针：两发布者都读取评估版本1，再先后提交不同检查结果。',
             [ck('assessment', 'cas-conflict-count', 1, '固定交错产生一次CAS冲突'),
              ck('assessment', 'reread-after-conflict-count', 1, '冲突方实际重读当前版本再合并'),
              ck('assessment', 'current-checks', {'supplier': 'pass', 'order': 'pass', 'receipt': 'unknown',
                                                'contract': 'unknown', 'balance': 'unknown'}, '不丢失先提交方结果'),
              ck('assessment', 'assessment-version', 3, '两次合法发布最终版本3')], base=SINGLE,
             facts=dict(assessment, concurrency={'workers': [{'name': 'supplier', 'readAssessmentVersion': 1},
                                                             {'name': 'order', 'readAssessmentVersion': 1}],
                        'arriveBarrier': 'both-read-version-one', 'releaseBarrier': 'release-supplier-first',
                        'schedule': ['both-read-version-one', 'supplier-commit', 'order-stale-cas', 'order-reread-and-merge']}),
             commands=[action('adapter.start_parallel_assessments', workersRef='facts.concurrency.workers',
                              holdBefore='assessment-cas'),
                       action('adapter.release_assessment_worker', worker='supplier', afterBarrier='both-read-version-one'),
                       action('adapter.release_assessment_worker', worker='order', afterBarrier='supplier-commit',
                              firstExpectedAssessmentVersion=1),
                       action('adapter.join_assessment_workers', timeoutMs=5000, collectRawTransactions=True)],
             faults=[fault('assessment.order.after-read-version1', 'hold-until-supplier-commit')], controls=['wf-assessment-merge-control'])
    stepcase('wf-assessment-old-generation', '旧代次结果不能发布为当前评估', '机制探针：旧代次查询迟到后尝试发布，当前代次结果应保持有效。',
             [ck('assessment-old', 'old-result-published', False, '旧代次结果不得更新当前评估引用'),
              ck('assessment-old', 'current-generation', 2, '当前执行代次保持2'),
              ck('assessment-old', 'current-supplier-status', 'unknown', '未经当前代次核验的项保持unknown')],
             base=SINGLE, facts=dict(assessment, oldQuery={'generation': 1, 'revision': 1, 'querySection': 'suppliers'}),
             commands=[action('adapter.start_supplier_query', generation=1, holdAt='before-publish'),
                       action('adapter.advance_workflow_generation', expectedGeneration=1, nextGeneration=2),
                       action('adapter.release_held_assessment', generation=1, revision=1)],
             faults=[fault('assessment.generation1.before-publish', 'delay-until-generation2')], controls=['wf-assessment-merge-control'])
    stepcase('wf-assessment-unchecked-evidence-update', '仅证据更新保留未查项与字段Revision', '机制探针：当前字段未变，只追加供应商凭证并发布新评估快照。',
             [ck('evidence-only', 'field-revision-increment', 0, '证据变化不生成字段Revision'),
              ck('evidence-only', 'assessment-version-increment', 1, '证据变化追加不可变快照并更新引用'),
              ck('assessment-unknown', 'unchecked-statuses', {'order': 'unknown', 'receipt': 'unknown',
                                                           'contract': 'unknown', 'balance': 'unknown'}, '完整快照保留全部未查项unknown'),
              ck('assessment', 'old-snapshot-overwrite-count', 0, '旧快照历史不覆盖')], base=SINGLE,
             facts=dict(assessment, supplementalEvidence={'ref': 'supplier/evidence-addendum', 'version': 2,
                                                          'scope': 'supplier', 'content': '注册主体的补充登记凭证'}),
             commands=[action('adapter.publish_evidence_update', revision=1, expectedAssessmentVersion=1,
                              evidenceRef='supplier/evidence-addendum', scope=['supplier'])], controls=['wf-assessment-merge-control'])

    return result
