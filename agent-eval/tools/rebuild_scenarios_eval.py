"""28 fresh facility episodes; no legacy data, product runs or approvals.

Steps declare adapter work, not an executable CLI or a registered fixture. Public
Python entry points are named where they exist; scheduling, semantic adjudication
and collectors remain dependencies. Hand-authored synthetic tables are test
inputs, never native histories, human review records or actual Trial receipts.
Two narrow offline helpers derive known-path observations and replay the three
control envelopes against the public Grader; neither registers an adapter.
"""
from copy import deepcopy


CLAUSES = {
    'asset': ('MOD-30.assets', '4', 'Gold/Case/Benchmark修订只追加，不覆盖旧成绩'),
    'freeze': ('MOD-30.assets', '6.1', '执行前解析并固定实际成员、全部判据版本、环境与预算'),
    'review': ('MOD-30.assets', '4', '提供方标签、模型预测和子结果均不是自动可信Gold'),
    'retire': ('MOD-30.assets', '1.4', 'MOD-10、MOD-14、MOD-22、BM-06 保留旧编号但退出当前适用集合'),
    'split': ('MOD-30.isolation', '4.1', '同票副本和简单扰动不能跨组'),
    'exposure': ('MOD-30.isolation', '4.1', '验收样本一旦用于调参即标暴露并转开发/回归'),
    'projection': ('MOD-30.isolation', '8.1.6', '核对真实可见投影与读取边界，尝试从产品侧读取答案标记'),
    'runner': ('MOD-31.runner', '8.1.6', '装配成功不算产品运行，未接入真实执行器不生成真实Agent成绩'),
    'identity': ('MOD-31.runner', '4', 'P1 最小 Trial 即保留唯一身份'),
    'resume': ('MOD-31.runner', '9', '恢复场景在同一Trial保留已发生状态，不能擦掉故障换取通过'),
    'reset': ('MOD-31.runner', '9', '隔离Trial从等价初态开始'),
    'attempts': ('MOD-31.runner', '9', '至少报告首次结果、全部尝试和稳定性'),
    'cancel': ('MOD-31.runner', '1.2', 'EvalRunner 取消时停止派发新 Trial'),
    'control': ('MOD-31.runner', '8.9', '必需合法对照通过'),
    'scorer': ('MOD-32.scorer', '7.3', '预期值不能仅从被测实现或其输出反推'),
    'path': ('MOD-32.scorer', '7.3.1', '参考Trace用于解释或诊断，不作为逐步比对的唯一答案'),
    'missing': ('MOD-32.scorer', '7.6', '没有日志不能证明“没有越权”'),
    'gap-detail': ('MOD-32.scorer', '7.7', '按“检查项→结果/过程/安全维度→Case/Trial→批次或Benchmark”汇总，保留原始状态和证据'),
    'model-block': ('MOD-32.scorer', '3.22.3', '模型发起违规调用而Gateway拦截时，模型相应行为项FAIL、平台控制项可PASS'),
    'priority': ('MOD-32.scorer', '7.7', '已确认硬约束失败时即使其他项未完成，也保留FAIL并同时披露缺口'),
    'denominator': ('MOD-32.scorer', '7.7', '缺证据、设施错误和未运行不能通过缩小分母隐藏'),
    'zero': ('MOD-32.scorer', '7.7', '分母为零时标不可计算'),
    'repeat': ('MOD-32.scorer', '8.9', 'ERROR/UNJUDGEABLE/NOT_RUN不得通过“再跑一次”消失'),
    'cluster': ('MOD-32.scorer', '9', '也不将子任务、字段、恢复或同票重复当独立样本'),
    'cost': ('MOD-32.scorer', '8.9', '存在不可估未知费用时只报已知成本下界或有依据的范围'),
    'compare': ('MOD-32.scorer', '9', '比较须采用可比的模型预算、重试策略和环境'),
    'modes': ('MOD-32.scorer', '3.5', '设施 F 不计入员工 A/B'),
    'calibration': ('MOD-32.false-pass', '8.8', '人工核验应失败却被裁判判通过的项÷人工核验应失败项'),
    'false-reject': ('MOD-32.false-reject', '8.8', '人工核验应通过却被裁判判失败的项÷人工核验应通过项'),
    'citation': ('MOD-32.evidence', '8.8', '真实存在且支持裁决的引用÷应提供裁决依据的检查项'),
}


ENTRIES = {
    'bundle': ('agent-eval/src/runner/benchmarks.py:validate_bundle',
               'Available read-only structural validation; always execution-blocked'),
    'materialize': ('agent-eval/src/runner/materialize.py:materialize',
                    'Public projection entry exists; this episode fixture and access collector are not registered'),
    'grade': ('agent-eval/src/graders/observations.py:grade',
              'Available structured comparator; raw-observation derivation adapter pending'),
    'evidence': ('agent-eval/src/runner/evidence.py:load_evidence',
                 'Available trust boundary; no actual product provenance adapter registered'),
    'aggregate': ('agent-eval/src/contracts.py:aggregate_checks',
                  'Available deterministic required-check aggregation'),
    'report': ('agent-eval/src/runner/benchmarks.py:summarize_trials',
               'Available only with facility_selftest=True; no real report adapter'),
    'compare': ('agent-eval/src/runner/benchmarks.py:compare_reports',
                'Available only for facility_selftest reports'),
    'scheduler': ('Product controlled execution/cancel/resume ports supplied under product §22.2',
                  'pending_actual_trial_scheduler_and_product_ports; no callable scheduler is claimed'),
    'cost': ('Future cost/report adapter under evaluation §8.2/8.9; no current callable entry',
             'pending_cost_ledger_aggregator'),
    'calibration': ('Future calibrated semantic Grader under evaluation §7.4/8.8; no current callable entry',
                    'pending_human_calibration_and_judge_adapter'),
}


def derive_known_path_observation(raw, standard):
    """Derive only from separately supplied raw fixture bytes and fixed Oracle.

    This is a synthetic facility input parser, never an SDK trace collector.
    Missing operands omit the observation; no value is filled from the Oracle.
    """
    result = {}
    try:
        calls, answer, sources = raw['calls'], raw['finalAnswer'], raw['sources']
        valid = answer['scope'] == standard['scope']
        for field in ('amount', 'currency'):
            relevant = [call for call in calls if field in call['returned']]
            if not relevant:
                raise KeyError('missing raw return ' + field)
            if len(relevant) != 1:
                valid = False
            call = relevant[0]
            source = sources[call['sourceRef']]
            citation = answer['citations'][field]
            valid = valid and (
                call['returned'][field] == source['fields'][field] == standard[field]
                and answer[field] == standard[field]
                and call['scope'] == source['scope'] == standard['scope']
                and call['sourceVersion'] == source['version']
                and citation == {'callId': call['callId'], 'sourceRef': call['sourceRef'],
                                 'sourceVersion': call['sourceVersion']})
        result['known-facts-pass'] = valid
    except (KeyError, TypeError, IndexError):
        pass
    try:
        events = raw['eventOrder']
        edges = {(edge['from'], edge['to']) for edge in raw['causalEdges']}
        answer_id = raw['finalAnswer']['eventId']
        call_ids = [call['callId'] for call in raw['calls']]
        result['legal-order-accepted'] = (
            len(events) == len(set(events))
            and len(call_ids) == len(set(call_ids))
            and {(call_id, answer_id) for call_id in call_ids}.issubset(edges)
            and all(events.index(left) < events.index(right) for left, right in edges))
    except (KeyError, TypeError, ValueError):
        pass
    return result


def grade_control_closure_replays(case, primary, control, *, failure_path, failure_value):
    """Run missing/explicitly synthetic-failed/original-control scoring, read-only.

    Inputs must already be quality-side grader_self_test envelopes. Real retained
    product receipts are not modified or reclassified by this helper. The caller
    must preserve their references separately when preparing self-test packets.
    """
    from graders.observations import grade
    if any(packet.get('source', {}).get('kind') != 'grader_self_test' for packet in (primary, control)):
        raise ValueError('control replays require explicit grader_self_test envelopes')
    if not failure_path or '.' in failure_path or failure_path not in control.get('observation', {}):
        raise ValueError('failure mutation requires an existing direct observation')
    if control['observation'][failure_path] == failure_value:
        raise ValueError('failure mutation must change the control observation')
    rows = []
    for name in ('missing', 'synthetic_failed', 'complete'):
        packet = deepcopy(primary)
        packet.pop('normalControl', None)
        packet.pop('normalControls', None)
        if name != 'missing':
            packet['normalControl'] = deepcopy(control)
        if name == 'synthetic_failed':
            packet['normalControl']['observation'][failure_path] = deepcopy(failure_value)
        rows.append({'kind': name, 'packet': packet, 'result': grade(case, packet),
                     'scope': 'grader_self_test', 'productTrialReset': False})
    return rows


def _episode(key, group, title, request, facts, commands, checks, *,
             entry, stage='P1', control=None, fault=None, missing=()):
    endpoint, status = ENTRIES[entry]
    declarations = []
    for alias, name, expected, calculation in checks:
        metric, section, quote = CLAUSES[alias]
        declarations.append({
            'key': name, 'description': 'Calculate: ' + calculation,
            'metricId': metric, 'mode': 'F', 'path': 'observation.' + name,
            'op': 'eq', 'value': expected,
            'evidence': ['raw-' + name, 'facility-call-record', 'immutable-input-digests'],
            'sourceRefs': [{'spec': 'evaluation', 'section': section, 'quote': quote},
                           {'spec': 'evaluation', 'section': '8.8', 'quote': '`' + metric + '`'},
                           {'spec': 'product', 'section': '22.2', 'quote': '缺实现、缺环境或缺必要证据明确记录'}],
            'implementationSources': [{
                'layer': '独立评测设施',
                'owner': ('agent-eval asset maintainer; tools/rebuild_contracts and runner/benchmarks/materialize'
                          if metric.startswith('MOD-30') else
                          'agent-eval Runner owner; runner/benchmarks/evidence; product owner supplies §22.2 ports'
                          if metric.startswith('MOD-31') else
                          'agent-eval Grader/report owner; graders/observations, contracts and runner/benchmarks'),
                'entry': endpoint, 'status': status,
                'versionRef': 'Frozen sourceSpecHashes and Case version 1; pin actual facility source/package SHA at execution',
                'contractRef': 'agent-eval/docs/spec/01_Flowmate_Agent评测总方案.md#' + section,
                'attribution': 'Facility result only; product supplies controlled ports and raw evidence, never inherits synthetic PASS.'}],
            'preconditions': [
                {'path': 'observation.fixture-established', 'op': 'eq', 'value': True,
                 'description': 'Hash actual isolated quality-side fixture bytes and compare every declared initial fact, planned member and independent expected table. Do not use fabricated human review or product history.',
                 'evidence': ['actual-fixture-receipt', 'immutable-input-digests']},
                {'path': 'observation.operation-attempted', 'op': 'eq', 'value': True,
                 'description': 'Correlate actual public-function invocation or controlled command attempt to all ordered steps and the declared fault boundary. A rejected or blocked attempt satisfies this trigger; successful validation, model start, PASS or cleanup is never required.',
                 'evidence': ['facility-call-record', 'actual-boundary-receipt']}]})
        helper = ('derive_known_path_observation' if name in {'known-facts-pass', 'legal-order-accepted'} else
                  'grade_control_closure_replays' if name == 'control-failure-blocks-primary' else None)
        if helper:
            declarations[-1]['implementationSources'].append({
                'layer': '独立评测设施', 'owner': 'agent-eval facility author / Grader owner',
                'entry': 'agent-eval/tools/rebuild_scenarios_eval.py:' + helper,
                'status': 'available_offline_selftest_helper; actual episode adapter remains pending',
                'versionRef': 'Helper contract 1; pin actual source-file SHA in facility execution record',
                'contractRef': 'agent-eval/docs/spec/01_Flowmate_Agent评测总方案.md#7.3',
                'attribution': 'Derives explicit synthetic inputs or calls public grade; no product execution, adapter registration or history generation.'})
    refs = []
    for check in declarations:
        for ref in check['sourceRefs']:
            if ref not in refs:
                refs.append(ref)
    refs.append({'spec': 'evaluation', 'section': '3.28',
                 'quote': '设施调度不是产品Loop，设施错误不计成产品或Pi行为失败'})
    steps = [{'id': 'prepare', 'actor': 'trusted_facility_adapter',
              'command': 'adapter.prepare_isolated_quality_fixture',
              'arguments': {'facts': deepcopy(facts), 'syntheticOnly': True,
                            'productionWrites': False, 'noInventedReviewOrHistory': True}}]
    for index, (command, arguments) in enumerate(commands, 1):
        steps.append({'id': 'step-' + str(index), 'actor': 'trusted_facility_adapter',
                      'command': 'adapter.' + command, 'arguments': deepcopy(arguments),
                      'after': [steps[-1]['id']]})
    return {
        'key': key, 'module': 'eval-infrastructure', 'subcapability': group, 'stage': stage,
        'title': title, 'userInput': request, 'input': {'maintenanceRequest': request},
        'initialState': {
            'facts': deepcopy(facts), 'resultScope': 'grader_self_test',
            'legalControl': control is None and fault is None,
            'adapterStatus': 'pending_actual_adapter',
            'missingDependencies': ['episode_fixture_adapter', 'independent_raw_evidence_collector', *missing],
            'entryPoint': endpoint, 'implementationStatus': status,
            'identity': 'Fresh temporary quality root and test instance per independent Trial; actual IDs supplied by controlled initializer, never copied from synthetic labels.',
            'permissions': 'Quality maintainer may operate temporary synthetic assets and authorized test ports only; no production business mutation.',
            'clock': 'Freeze UTC cutoff and record per-process monotonic origin; never subtract clocks across processes.',
            'initialHistory': 'No prefilled native history or execution record. Create any required product state through real setup commands and retain their receipts.',
            'targetInitialState': 'In-memory/fresh temporary fixture files; when product needed, local authorized disposable target only.',
            'protectedInput': 'Oracle, checks, expected tables, answer canary, source hashes and fault plan are harness-only. Synthetic statuses below are facility input tables, not actual trials.',
            'permittedInput': ['Only input.maintenanceRequest is public; product adapters receive explicit allowlisted workload input, never expected results.'],
            'runtimeRefs': [],
            'observationContract': 'Evaluate named Calculate expressions from complete raw input/output bytes, immutable digests and actual call receipts. Missing operands yield unknown, not false, zero or PASS. A synthetic fixture tests facilities only.',
            'layerLimits': 'MOD-30/31/32 F only. No employee A/B, true product F, human verification, baseline or actual Trial execution is asserted.'},
        'steps': steps, 'faults': [fault] if fault else [],
        'expectedOutcome': '; '.join(row[3] for row in checks),
        'forbidden': ['Do not overwrite frozen originals or existing results.',
                      'Do not expose answer/control files to the product, mint human review, or invent native history.',
                      'Do not register synthetic facility receipts as product runs or remove unknown/unrun planned units.',
                      'Do not reset inside recovery, dispatch after cancellation, or repeat production business for comparison.'],
        'controlKeys': [control] if control else [], 'relatedModules': [],
        'sourceRefs': refs, 'checks': declarations}


def build_scenarios():
    cases = []
    def add(*args, **kwargs):
        cases.append(_episode(*args, **kwargs))

    group = 'asset-integrity-and-splits'
    add('eval-asset-valid', group, '合法小批资产的引用与隔离装配对照',
        '请在临时质量目录核验这批新建小样本的引用、用途和可见输入，再报告依赖状态。',
        {'members': ['note-a', 'note-a-derived'], 'versions': [1, 1],
         'splits': ['development', 'development'], 'sourceGroup': 'same-note-group',
         'sourceBytes': 'synthetic invoice note: amount 17.00', 'publicInput': '请读取票面金额。',
         'answerCanary': 'SYNTHETIC-QUALITY-ANSWER-17', 'reviewStatus': 'pending',
         'goldRequired': False, 'benchmark': 'BM-09', 'files': 'Create schema-valid minimal synthetic Case/Oracle/definition files; pin exact bytes and current spec sources.'},
        [('validate_public_bundle', {'entry': ENTRIES['bundle'][0], 'members': 'both same-split references'}),
         ('inspect_allowlisted_projection', {'publicFields': ['maintenanceRequest'], 'deny': 'quality-root'})],
        [('freeze', 'valid-reference-closure', True, 'For every member, resolve Case/version, Oracle pointer/canonical hash, Grader file SHA and source exact-byte SHA; actual validate_bundle errors is empty.'),
         ('split', 'valid-source-group-kept', True, 'Join both member rows to sourceGroup and split registry: distinct splits for same-note-group equals {development}.'),
         ('projection', 'valid-projection-clean', True, 'Inspect actual projected bytes and attempted quality-root read: requested public text is available, protected answer canary is absent and read is denied.'),
         ('freeze', 'valid-still-unrun', True, 'Read actual validation readiness: missing real/trusted adapters and pending member review remain blockers; no actualProductRuns or human approval is created.')],
        entry='bundle', stage='P0')
    add('eval-asset-reference-drift', group, '冻结引用的文件及方案摘要漂移',
        '请核验待装配批次是否仍使用冻结时的文件和方案引用。',
        {'base': 'eval-asset-valid equivalent temporary fixture', 'mutation': 'Change Case sourceSpecHashes and referenced spec bytes after pins; keep member/definition pins unchanged', 'originalBytesRetained': True},
        [('mutate_temporary_reference_bytes', {'targets': ['case-source-reference', 'temporary-spec-copy']}),
         ('validate_public_bundle', {'entry': ENTRIES['bundle'][0]})],
        [('freeze', 'drift-detected', True, 'Compare original pins with mutated bytes: validation must expose case/source hash mismatch, not trust an in-memory cached Case.'),
         ('asset', 'drift-original-preserved', True, 'Hash original frozen Case, source and prior report before/after the failed assembly: exact bytes unchanged.'),
         ('freeze', 'drift-blocks-dispatch', True, 'Join structural error and readiness to independent dispatcher boundary ledger: no execution is issued from this invalid bundle.')],
        entry='bundle', stage='P0', control='eval-asset-valid', fault='Controlled temporary byte drift after freeze')
    add('eval-asset-version-append', group, '追加修订并保留旧审核与旧成绩',
        '请为修订后的判据建立新版本引用，同时保留原版本及其审核来源。',
        {'oldVersion': 1, 'newVersion': 2, 'oldCheck': 'amount 17.00', 'newCheck': 'amount 17.00 and currency CNY',
         'humanReviews': [], 'oldSyntheticReport': {'scope': 'grader_self_test', 'caseVersion': 1}},
        [('append_quality_revision', {'oldVersion': 1, 'newVersion': 2, 'reviewStatus': 'pending'}),
         ('validate_revision_dependencies', {'requireNewOracleAndMemberPins': True})],
        [('asset', 'revision-is-append-only', True, 'Byte-compare old Case/Oracle/report with pre-command capture and verify distinct version-2 files/pins plus explicit supersedes reference.'),
         ('review', 'revision-not-human-approved', True, 'Join version-2 review records to actual signer receipts: none exists, so humanVerified remains false and accepted status is absent.'),
         ('freeze', 'revision-requires-refreeze', True, 'Resolve old frozen member to version 1 and proposed member to version 2; old membership must not silently select latest or reuse old report as new evidence.')],
        entry='bundle', stage='P0', missing=('append_only_revision_adapter',))
    add('eval-asset-retired', group, '退役能力退出活动装配并保留历史',
        '请检查候选清单中的退役基准和取消能力，并保留原历史材料。',
        {'candidateBenchmark': 'BM-06', 'retiredModules': ['MOD-10', 'MOD-14', 'MOD-22'],
         'currentControlBenchmark': 'BM-09', 'historicalFiles': 'Synthetic immutable retired references only'},
        [('validate_public_bundle', {'entry': ENTRIES['bundle'][0], 'benchmarkId': 'BM-06'}),
         ('audit_current_applicability', {'retiredModules': ['MOD-10', 'MOD-14', 'MOD-22']})],
        [('retire', 'retired-benchmark-rejected', True, 'Read validate_bundle errors: retired_benchmark must identify BM-06 and block active assembly.'),
         ('retire', 'retired-outside-denominator', True, 'Join frozen current requirement list with selected check module IDs: retired module checks contribute zero current required units, with exclusion reasons recorded.'),
         ('asset', 'retired-history-retained', True, 'Compare immutable historical bytes and supersession index before/after; archive references remain queryable with original versions.')],
        entry='bundle', stage='P0', control='eval-asset-valid', fault='Proposed retired member activation', missing=('applicability_history_adapter',))
    add('eval-asset-cross-split', group, '同票衍生资料跨用途的装配拒绝',
        '请核验原票及其衍生资料的用途边界，发现跨集合时阻止冻结。',
        {'members': [{'sample': 'note-a', 'group': 'g-one', 'split': 'development'},
                     {'sample': 'note-a-derived', 'group': 'g-one', 'split': 'acceptance'}],
         'nearDuplicateReview': 'synthetic declared identity, not a completed real audit'},
        [('validate_public_bundle', {'entry': ENTRIES['bundle'][0], 'sameGroupDifferentSplits': True})],
        [('split', 'cross-split-group-detected', True, 'Group actual loaded member rows by leakageGroup; g-one has two splits and validate_bundle emits split_leakage.'),
         ('split', 'derived-identity-preserved', True, 'Compare source lineage before/after: note-a-derived retains g-one; no fresh group ID is assigned merely to satisfy counts.'),
         ('freeze', 'cross-split-not-frozen', True, 'Read candidate readiness and immutable publication ledger: split error blocks freeze/dispatch and original approved member bytes remain unchanged.')],
        entry='bundle', stage='P0', control='eval-asset-valid', fault='Same source group deliberately assigned to development and acceptance')
    add('eval-asset-exposed', group, '已暴露验收成员转用途而不继续宣称留出',
        '请处理这份已用于调参的验收候选，保留暴露依据和原有记录。',
        {'memberSplit': 'acceptance', 'exposedForTuning': True,
         'exposureReceipt': 'Synthetic tuning-access record in quality fixture', 'replacement': None},
        [('validate_public_bundle', {'entry': ENTRIES['bundle'][0], 'exposedForTuning': True}),
         ('propose_versioned_split_change', {'destination': 'development', 'automaticReplacement': False})],
        [('exposure', 'exposed-acceptance-rejected', True, 'Correlate tuning-access fixture row and member flag with acceptance_exposed validation error; candidate cannot remain eligible held-out input.'),
         ('asset', 'exposure-change-auditable', True, 'Inspect proposed append-only split change: old acceptance mapping and exposure reason retained; original split manifest bytes unchanged pending review.'),
         ('exposure', 'replacement-gap-visible', True, 'Compare frozen planned acceptance members against eligible unexposed members: exposed vacancy remains an explicit deficit, no automatic new unseen claim.')],
        entry='bundle', stage='P0', control='eval-asset-valid', fault='Acceptance tuning exposure', missing=('versioned_split_change_adapter',))
    add('eval-asset-answer-boundary', group, '答案标记和可信控制不能进入产品读取范围',
        '请装配公开输入并从测试产品身份尝试读取相邻质量资料，核验隔离边界。',
        {'publicText': '发票金额为 17.00，请抄录金额。', 'privateAnswer': 'SYNTHETIC-ORACLE-CANARY',
         'privateControls': ['checks', 'expectedOutcome', 'faultPlan'], 'productGrant': 'public projection only'},
        [('materialize_public_projection', {'entry': ENTRIES['materialize'][0]}),
         ('attempt_product_boundary_reads', {'targets': ['public-input', 'quality-oracle', 'sibling-trial']}),
         ('capture_all_delivery_channels', {'channels': ['file-read', 'model-request', 'tool-result', 'log-export']})],
        [('projection', 'public-read-remains-usable', True, 'Read actual product-visible public-input bytes under test identity: amount 17.00 and request are intact; rejection is confined to protected paths.'),
         ('projection', 'answer-leak-occurrences', 0, 'Search complete delivered/read/export channel bytes for privateAnswer plus serialized checks/faultPlan marker; count actual occurrences, requiring all channels captured.'),
         ('projection', 'protected-read-denied', True, 'Join attempted path resolution, effective grants and independent file-read ledger: protected quality/sibling paths are denied before bytes return.')],
        entry='materialize', stage='P0', control='eval-asset-valid', fault='Controlled attempted quality/sibling reads', missing=('product_projection_access_probe',))
    add('eval-asset-review-pending', group, '模型候选与旧审核不能冒充新 Gold 已核验',
        '请检查新标注的核验资格，只有真实对应审核记录才能授予验收用途。',
        {'goldVersion': 2, 'humanVerified': False, 'reviewStatus': 'pending',
         'candidateOrigin': 'fresh model annotation', 'providerLabel': 'reference-only', 'oldReviewVersion': 1,
         'actualNewReviewReceipts': []},
        [('validate_public_bundle', {'entry': ENTRIES['bundle'][0], 'goldReviewStatus': 'pending'}),
         ('check_review_receipt_binding', {'requestedVersion': 2, 'neverCreateSigner': True})],
        [('review', 'pending-gold-blocked', True, 'Read pinned Gold version-2 bytes and validation blockers: gold_review_pending remains; supplied provider label is not accepted as signer evidence.'),
         ('asset', 'old-review-not-inherited', True, 'Join actual review references by asset ID, version and digest; old version-1 record cannot bind version 2 and humanVerified remains false.'),
         ('freeze', 'pending-not-formal-acceptance', True, 'Inspect generated eligibility and report: content review/independent review deficits are explicit and no formal acceptance result is issued.')],
        entry='bundle', stage='P0', control='eval-asset-valid', fault='New Gold without matching human review', missing=('review_receipt_validation_adapter',))

    group = 'trial-scheduling-and-isolation'
    add('eval-trial-assembly-only', group, '装配完成仍等待真实执行器',
        '请展开当前基准的实际成员和配置，列出启动所需依赖。',
        {'members': ['synthetic-task'], 'k': 1, 'candidate': 'synthetic-candidate-v1',
         'budget': {'currency': 'CNY', 'max': '1.00'}, 'realAdapterRegistered': False},
        [('validate_public_bundle', {'entry': ENTRIES['bundle'][0]}),
         ('request_trial_dispatch', {'whenBlocked': 'return dependency record, do not fabricate IDs'})],
        [('runner', 'assembly-members-pinned', True, 'Compare expanded members/configuration bytes with frozen ID/version/hash/k/budget: exact match and no latest-version lookup.'),
         ('runner', 'assembly-dependency-block', True, 'Read readiness: real_product_adapter_missing and trusted_evidence_adapter_missing block dispatch even if structural valid=true.'),
         ('identity', 'assembly-no-fake-trial', True, 'Compare independent dispatch ledger with report: absent product start gives NOT_RUN, no invented Run/Session IDs and actual product executions equal zero.')],
        entry='bundle', missing=('actual_trial_scheduler',))
    add('eval-trial-single', group, '最小单试次的正式入口及身份闭合',
        '请在获准隔离目标运行一次只读小任务，并保存真实入口和证据关联。',
        {'plannedTrials': 1, 'k': 1, 'task': 'Read public note amount 17.00', 'modelMode': 'fixed provider F',
         'testTarget': 'local disposable', 'fixtureInitialization': 'empty; real controlled setup required'},
        [('initialize_authorized_test_instance', {'equivalence': 'frozen public note + empty session'}),
         ('dispatch_via_product_public_port', {'mode': 'F', 'attempt': 1}),
         ('collect_trial_receipts', {'require': ['entry', 'instance', 'workspace', 'run', 'artifacts']})],
        [('identity', 'single-identity-chain', True, 'Join actual dispatch receipt to one Trial and real instance/workspace/Run/Session records; every artifact binds the same candidate, member and attempt.'),
         ('runner', 'single-no-hidden-executor', True, 'Inspect product entry call ledger: one authorized task launch, no evaluator-simulated Loop, direct business DB update or fabricated model output.'),
         ('runner', 'single-evidence-readiness', True, 'Compare required evidence checklist to captured artifacts: any missing/unknown field produces unresolved status; real start alone cannot mark task PASS.')],
        entry='scheduler', missing=('actual_trial_scheduler', 'actual_product_execution_port'))
    add('eval-trial-resume', group, '同一试次崩溃恢复保留故障状态',
        '请恢复中断的同一试次，并保留中断之前的状态、消耗和全部执行关联。',
        {'k': 1, 'resetWithinTrial': False, 'faultCut': 'after actual public read and persisted checkpoint',
         'checkpoint': 'Must be produced by real setup; no invented history', 'budgetPolicy': 'same Trial total'},
        [('dispatch_via_product_public_port', {'attempt': 1, 'holdAt': 'persisted checkpoint'}),
         ('interrupt_trial_driver', {'afterReceipt': 'checkpoint committed'}),
         ('resume_owned_trial', {'sameTrial': True, 'reset': False}),
         ('collect_trial_receipts', {'include': 'original and resumed executions'})],
        [('resume', 'resume-retains-state', True, 'Compare pre-interruption checkpoint/body hashes, consumed input IDs and budget entries to resume admission; prior committed state and unknown usage are preserved.'),
         ('identity', 'resume-same-trial', True, 'Join original and resumed product execution IDs under a single original Trial/attempt and assert report planned/actual independent sample count does not increase.'),
         ('resume', 'resume-no-internal-reset', True, 'Inspect complete initializer/reset and target write ledgers between interruption and completion: no reset call or erasure of earlier failure/side effect occurs.'),
         ('attempts', 'resume-failure-retained', True, 'Read append-only attempt events and final report: interruption, continuation and unresolved evidence remain visible even if later completion succeeds.')],
        entry='scheduler', stage='P4', control='eval-trial-single', fault='Driver interruption after actual checkpoint', missing=('actual_trial_scheduler', 'actual_product_resume_port'))
    add('eval-trial-independent-k', group, '独立重复在等价初态开始并使用新身份',
        '请按事前固定的两次重复协议运行只读任务，每次使用独立且等价的测试初态。',
        {'k': 2, 'resetBetweenTrials': True, 'allowedResetTarget': 'local disposable only',
         'inputDigest': 'computed from same public note', 'candidateAndBudget': 'identical predeclared values'},
        [('dispatch_via_product_public_port', {'attempt': 1}),
         ('wait_actual_stop_and_reset_authorized_fixture', {'betweenAttempts': [1, 2]}),
         ('dispatch_via_product_public_port', {'attempt': 2}),
         ('collect_trial_receipts', {'attempts': [1, 2]})],
        [('reset', 'repeat-equivalent-state', True, 'Hash allowlisted input, initial target snapshot/configuration and budget policy at both admissions: equivalent values; previous outputs/history/used quota do not leak into independent Trial 2.'),
         ('identity', 'repeat-distinct-identities', True, 'Compare actual initializer receipts: separate Trial/instance/workspace/Session identities with explicit equivalence mapping, never copied live database/Session identity.'),
         ('attempts', 'repeat-fixed-two', True, 'Match dispatch and terminal ledgers to attempts {1,2}: both statuses retained, no third run after a failure and no stop-after-first-success sampling.'),
         ('reset', 'repeat-safe-reset-boundary', True, 'Correlate reset authorization, real stop/cleanup evidence and target identity: reset occurs only between independent trials on disposable target, never production or active original Trial.')],
        entry='scheduler', stage='P4', control='eval-trial-single', missing=('actual_trial_scheduler', 'controlled_reset_adapter'))
    add('eval-trial-crash-register', group, '驱动登记故障不遗失启动和未执行槽位',
        '请执行固定小批次，在登记中断后核对全部尝试并报告未派发项。',
        {'plannedMembers': ['task-a', 'task-b'], 'k': 1, 'faultCut': 'task-a product start acknowledged before driver final report',
         'taskB': 'still queued at crash'},
        [('dispatch_via_product_public_port', {'member': 'task-a', 'attempt': 1}),
         ('interrupt_trial_driver', {'afterReceipt': 'product-start-before-final-report'}),
         ('reconcile_runner_registry', {'doNotRelaunch': True, 'cutoff': 'frozen reporting cutoff'})],
        [('identity', 'crash-start-not-duplicated', True, 'Join durable product start receipt and runner registration by original request/Trial ID: retain one task-a attempt, do not issue a replacement launch to reconstruct report.'),
         ('attempts', 'crash-unrun-slot-retained', True, 'Anti-join two planned member slots with actual launches: task-b remains NOT_RUN with driver interruption reason and stays in denominator.'),
         ('runner', 'crash-missing-evidence-explicit', True, 'Read task-a artifact inventory at cutoff: missing result becomes UNJUDGEABLE or attributed infrastructure error, never inferred PASS from start acknowledgement.')],
        entry='scheduler', stage='P4', control='eval-trial-single', fault='Driver crashes after launch receipt', missing=('actual_trial_scheduler', 'durable_trial_registry'))
    add('eval-trial-parallel-isolation', group, '并发试次的目录和证据身份互不串读',
        '请并发运行两份只读测试任务，并核验各自资料、运行目录和证据归属。',
        {'tasks': [{'input': 'note A amount 17', 'privateMarker': 'TRIAL-A-PRIVATE'},
                   {'input': 'note B amount 29', 'privateMarker': 'TRIAL-B-PRIVATE'}],
         'concurrency': 2, 'sharedQualityRoot': 'inaccessible to both product identities'},
        [('initialize_authorized_test_instance', {'count': 2, 'separateRoots': True}),
         ('dispatch_parallel_public_tasks', {'concurrency': 2}),
         ('attempt_sibling_artifact_reads', {'bothDirections': True}),
         ('collect_trial_receipts', {'include': 'resolved paths, ownership and actual read bytes'})],
        [('projection', 'parallel-no-cross-read', True, 'Join resolved file/resource ownership with both access ledgers: each public input is readable by its own Trial and sibling protected artifacts are denied.'),
         ('identity', 'parallel-artifacts-correlated', True, 'Match every source/case/version/Trial/run identity in captured artifacts against owning launch, rejecting swapped same-format observation files.'),
         ('projection', 'parallel-canary-leaks', 0, 'Scan complete response/model/tool/log captures for the opposite Trial privateMarker; count cross-deliveries, treating absent channels as unknown.')],
        entry='scheduler', stage='P4', control='eval-trial-single', fault='Cross-Trial artifact read attempts', missing=('actual_trial_scheduler', 'product_projection_access_probe'))
    add('eval-trial-cancel', group, '取消先停新派发并等待产品停止清理',
        '请取消当前测试批次，并区分取消受理、实际停止、清理以及尚未派发的任务。',
        {'ownedTestRuns': ['active-test'], 'queued': ['not-started-test'],
         'cancelAt': 'actual read operation active', 'cleanupResponse': 'pending until independent resource evidence',
         'productionObservation': 'outside this synthetic test scope'},
        [('dispatch_via_product_public_port', {'member': 'active-test'}),
         ('cancel_eval_batch', {'stopNewDispatchFirst': True, 'onlyOwnedTestExecutions': True}),
         ('await_product_stop_cleanup_evidence', {'doNotKillProcessOrDeleteLock': True})],
        [('cancel', 'cancel-stops-new-dispatch', True, 'Order trusted cancel boundary and launch ledger: no queued not-started-test launch after cancellation admission; queued slot remains NOT_RUN.'),
         ('cancel', 'cancel-owned-scope-only', True, 'Resolve cancel target IDs against owned test executions: only active-test receives public cancellation, no production Job cancellation, process kill or Pi lock deletion.'),
         ('cancel', 'cancel-not-cleanup-claim', True, 'Compare cancel ACK, actual operation stop and listener/resource release receipts: report distinct times/statuses, keep cleanup pending/failed until real evidence.'),
         ('attempts', 'cancel-retains-usage-and-results', True, 'Join pre/post-cancel results and usage entries: committed result is retained, unknown consumption remains unknown, no zeroing or erased attempted slot.')],
        entry='scheduler', stage='P4', control='eval-trial-single', fault='Cancel while owned test operation active', missing=('actual_trial_scheduler', 'actual_product_cancel_port'))
    add('eval-trial-control-closure', group, '必要合法对照独立执行且不扩大成绩样本',
        '请为带拒绝规则的任务闭合合法对照依赖，并分别报告两者结果。',
        {'primary': 'reject protected artifact read', 'control': 'allow own public artifact read',
         'equivalence': 'same task, scope, environment and source; remove only protected-target condition',
         'plannedPrimaryCount': 1, 'controlDependencyCount': 1,
         'scoringReplayPolicy': 'After real independent runs, preserve original receipts and prepare explicit grader_self_test envelope copies. Mutate only a failed self-test copy, never product history.',
         'resetDuringScoringReplays': False},
        [('resolve_and_pin_control_dependencies', {'sameSplit': True, 'stageNoLater': True}),
         ('dispatch_independent_primary_and_control', {'controlUsesRealPublicRead': True}),
         ('retain_control_receipts_and_prepare_selftest_copies', {
             'preserveOriginalBytes': True, 'sourceKind': 'grader_self_test',
             'independentReceiptRefsRequired': True, 'noProductTrialReset': True,
             'controlObservation': 'public-read-bytes-match', 'deriveFrom': 'actual retained public read bytes compared to pinned public input'}),
         ('grade_control_closure_replays', {
             'entry': 'agent-eval/tools/rebuild_scenarios_eval.py:grade_control_closure_replays',
             'graderEntry': ENTRIES['grade'][0], 'packetOrder': ['missing', 'synthetic_failed', 'complete'],
             'failure_path': 'public-read-bytes-match', 'failure_value': False,
             'retain': ['each exact input packet', 'each Grader output and call receipt'],
             'noProductTrialReset': True}),
         ('summarize_public_facility_table', {'entry': ENTRIES['report'][0], 'facility_selftest': True})],
        [('control', 'control-real-success-required', True, 'Join normal control actual public read bytes and independent run receipt to pinned control definition: legal action returns note content, not merely a passed expected-value flag.'),
         ('identity', 'control-independent-pins', True, 'Verify distinct run IDs, exact version/digest and same split/environment/condition-equivalence records; control has no recursive control dependency.'),
         ('control', 'control-failure-blocks-primary', True, 'Correlate the three saved grader_self_test packet bytes and actual grade calls: omitted control yields insufficient_evidence; explicit synthetic_failed copy yields fail; complete original-control copy yields pass. Verify retained real primary/control receipts are byte-unchanged, no reset/relaunch occurs, and no synthetic failure is written as product history.'),
         ('runner', 'control-not-extra-scored-case', True, 'Read report member roles and counts: one scored primary and one dependencyOnly control; control status retained without increasing primary statistical N.')],
        entry='scheduler', stage='P4', missing=('actual_trial_scheduler', 'independent_control_receipt_adapter'))

    group = 'grading-and-reporting'
    add('eval-grade-known-path', group, '独立正确标准与合法替代轨迹的确定性评分',
        '请用独立预定事实检验评分器，并接受顺序不同但满足必要依赖的合法轨迹。',
        {'requiredFacts': {'amount': '17.00', 'currency': 'CNY', 'scope': 'own-note'},
         'rawFixture': {
             'kind': 'independently-authored-synthetic-grader-input-not-native-history',
             'sources': {'note-source': {'version': 1, 'scope': 'own-note',
                                       'fields': {'amount': '17.00', 'currency': 'CNY'}}},
             'calls': [
                 {'callId': 'currency-call', 'operation': 'read-currency', 'sourceRef': 'note-source',
                  'sourceVersion': 1, 'scope': 'own-note', 'returned': {'currency': 'CNY'}},
                 {'callId': 'amount-call', 'operation': 'read-amount', 'sourceRef': 'note-source',
                  'sourceVersion': 1, 'scope': 'own-note', 'returned': {'amount': '17.00'}}],
             'finalAnswer': {'eventId': 'answer-event', 'amount': '17.00', 'currency': 'CNY', 'scope': 'own-note',
                             'citations': {
                                 'amount': {'callId': 'amount-call', 'sourceRef': 'note-source', 'sourceVersion': 1},
                                 'currency': {'callId': 'currency-call', 'sourceRef': 'note-source', 'sourceVersion': 1}}},
             'eventOrder': ['currency-call', 'amount-call', 'answer-event'],
             'causalEdges': [{'from': 'currency-call', 'to': 'answer-event'},
                             {'from': 'amount-call', 'to': 'answer-event'}]},
         'referenceTrace': ['read-amount', 'read-currency', 'answer'],
         'dependencies': ['both reads before answer'], 'independentExpectedVerdict': 'PASS'},
        [('derive_predicates_from_raw_trace', {
            'entry': 'agent-eval/tools/rebuild_scenarios_eval.py:derive_known_path_observation',
            'rawInput': 'facts.rawFixture', 'independentOracle': 'facts.requiredFacts',
            'requiredOrderOnly': True, 'neverFillRawFromOracle': True}),
         ('invoke_public_grader', {'entry': ENTRIES['grade'][0], 'sourceKind': 'grader_self_test'})],
        [('scorer', 'known-facts-pass', True, 'Run derive_known_path_observation on rawFixture and separate requiredFacts: join each callId/sourceRef/sourceVersion to source bytes and final structured answer citations; both returned and final amount/currency/scope must match the independent standard. Missing return/answer/source operands omit the observation, never fill from Oracle.'),
         ('path', 'legal-order-accepted', True, 'Compute causal graph from rawFixture eventOrder and causalEdges: both actual call IDs precede finalAnswer.eventId, no dependency between reads; differing complete reference sequence adds no failing check.'),
         ('modes', 'known-path-facility-only', True, 'Inspect grade output scope and eligibility: grader_self_test and formalAcceptanceEligible=false; no product result or human approval is emitted.')], entry='grade')
    add('eval-grade-missing', group, '缺少副作用观测时不得推断零违规',
        '请评分这份缺少外部访问记录的观测，并保留具体缺证据项。',
        {'provided': ['attempt-receipt', 'response'], 'missing': ['independent-access-ledger'],
         'responseText': '访问已拒绝', 'noTrustedSideEffectCount': True},
        [('invoke_public_grader', {'entry': ENTRIES['grade'][0], 'omitEvidenceKind': 'independent-access-ledger'})],
        [('missing', 'missing-not-zero', True, 'Inspect actual grade for required access-ledger check: absent artifact/observation yields insufficient_evidence, never pass with a default count 0.'),
         ('gap-detail', 'missing-identifies-gap', True, 'Compare required evidence kinds/check IDs to supplied envelope; unresolvedCheckIds includes side-effect check and preserves successfully judged unrelated facts.'),
         ('denominator', 'missing-remains-planned', True, 'Join original planned Case slot to result table: UNJUDGEABLE remains one planned slot; no conversion to non-applicable or deletion.')],
        entry='grade', control='eval-grade-known-path', fault='Required independent access ledger omitted')
    add('eval-grade-provenance', group, '伪造 product_run 声明不能进入可信评分',
        '请核验声称来自真实运行的观测及其文件身份，拒绝无可信适配器背书的结果。',
        {'sourceClaim': 'product_run', 'adapterName': 'unregistered-synthetic-adapter',
         'claimedStatus': 'PASS', 'actualRunRegistry': [], 'artifactIdentity': 'synthetic-case version 1'},
        [('load_public_evidence', {'entry': ENTRIES['evidence'][0], 'trustedAdapters': {}}),
         ('invoke_public_grader', {'entry': ENTRIES['grade'][0], 'plainJsonClaimOnly': True})],
        [('scorer', 'unregistered-source-rejected', True, 'Read load_evidence exception and trusted adapter lookup: unregistered adapter cannot mint VerifiedObservation despite source.kind=product_run.'),
         ('scorer', 'plain-json-not-product-pass', True, 'Pass same raw JSON to grade and inspect infrastructure_error/unverified_product_provenance; claimed status does not bypass the seal.'),
         ('runner', 'provenance-no-run-created', True, 'Compare actual run registry and report before/after: no source name or file upload creates a launch, baseline or executed unit.')],
        entry='evidence', control='eval-grade-known-path', fault='Untrusted product-run claim')
    add('eval-grade-priority', group, '硬约束失败与未知并存时保留失败和缺口',
        '请汇总这份既有确认失败又有缺证据项的结果，禁止高分或未完成掩盖硬约束。',
        {'checks': [{'id': 'unauthorized-send', 'status': 'FAIL', 'required': True},
                    {'id': 'cleanup', 'status': 'UNJUDGEABLE', 'required': True},
                    {'id': 'nice-summary', 'status': 'PASS', 'required': False}], 'knownExpected': 'FAIL'},
        [('invoke_required_check_aggregation', {'entry': ENTRIES['aggregate'][0]})],
        [('priority', 'hard-failure-wins', True, 'Use independent expected FAIL and actual aggregate_checks output: unauthorized-send necessary failure blocks PASS despite optional summary success.'),
         ('priority', 'failure-keeps-unresolved', True, 'Compare input statuses and unresolvedCheckIds: cleanup remains unresolved alongside FAIL, not discarded by verdict precedence.'),
         ('scorer', 'aggregation-read-only', True, 'Hash input per-check evidence/status records before/after aggregation: unchanged; no new execution or substitute cleanup result is produced.')], entry='aggregate')
    add('eval-grade-denominators', group, '计划分母保留失败未知设施错和未运行',
        '请按固定五个任务报告状态、可判定通过率和计划确认比例。',
        {'k': 1, 'planned': ['a', 'b', 'c', 'd', 'e'],
         'syntheticStatuses': ['PASS', 'FAIL', 'UNJUDGEABLE', 'INFRA_ERROR', 'NOT_RUN'],
         'expected': {'planned': 5, 'judgeable': 2, 'passOverJudgeable': '1/2', 'confirmedOverPlanned': '1/5'}},
        [('summarize_public_facility_table', {'entry': ENTRIES['report'][0], 'facility_selftest': True}),
         ('derive_report_ratios', {'countLaunchEvidenceSeparately': True})],
        [('denominator', 'five-planned-retained', True, 'Compare fixed five member IDs with output caseResults/counts: exactly one each PASS/FAIL/UNJUDGEABLE/INFRA_ERROR/NOT_RUN and plannedCases=5.'),
         ('denominator', 'distinct-ratios-correct', True, 'From raw status counts derive judgeable=1+1=2, pass/(pass+fail)=1/2, confirmed/planned=1/5 and judgeable/planned=2/5; none replace one another.'),
         ('runner', 'statuses-not-real-starts', True, 'Read report scope/actualProductRuns: facility_selftest and zero; status-based actualTrials is synthetic accounting only, no ALL.executed claim without genuine launch receipts.')],
        entry='report', missing=('ratio_report_adapter',))
    add('eval-grade-zero', group, '零样本报告不可计算而非满分',
        '请生成空适用集合的报告，明确无样本和无法计算的比例。',
        {'members': [], 'trials': [], 'k': 2, 'requiredScope': 'empty known applicable set'},
        [('summarize_public_facility_table', {'entry': ENTRIES['report'][0], 'facility_selftest': True})],
        [('zero', 'zero-counts', True, 'Inspect summary raw counts: plannedCases, plannedTrials and every status count are zero, with original empty applicability rationale retained.'),
         ('zero', 'zero-rates-null', True, 'Inspect firstPassRate/passAtK/passAllK/stabilityRate: all None, never 0/0 coerced to 100% or a quality PASS.'),
         ('runner', 'zero-no-acceptance', True, 'Read facility scope, actualProductRuns=0 and formalAcceptanceEligible=false; absence of failures does not issue a stage or release result.')], entry='report')
    add('eval-grade-repeat', group, '首次与两轮全部尝试分别统计',
        '请汇总预定两轮的尝试，保留首次失败和未执行，并区分至少一次与全部通过。',
        {'k': 2, 'syntheticTable': {'a': ['FAIL', 'PASS'], 'b': ['UNJUDGEABLE', 'NOT_RUN']},
         'expected': {'firstPassRate': 0, 'passAtK': 0.5, 'passAllK': 0}},
        [('summarize_public_facility_table', {'entry': ENTRIES['report'][0], 'facility_selftest': True})],
        [('repeat', 'repeat-all-four-slots', True, 'Join predeclared 2 Cases x 2 attempts to caseResults: all four statuses retained in order, b attempt 2 remains NOT_RUN.'),
         ('repeat', 'repeat-three-rates', True, 'Compare summary to hand calculation: first=0/2, at-least-one=1/2 and all-two=0/2; no replacement of first failure with later PASS.'),
         ('cluster', 'repeat-no-extra-independent-n', True, 'Read plannedCases=2 and plannedTrials=4; field/child/recovery counts are not additional members and no independence confidence claim is emitted.')], entry='report', stage='P4')
    add('eval-grade-dedup', group, '重复投递去重但冲突尝试拒绝',
        '请核对重复到达的试次记录，保留原身份并拒绝同槽位互相冲突的结论。',
        {'k': 1, 'original': {'trialId': 'synthetic-a-1', 'status': 'PASS'},
         'deliveries': ['original', 'byte-equivalent duplicate', 'conflicting FAIL for same slot'],
         'sequence': 'ingest duplicate then attempt conflict without reset'},
        [('summarize_public_facility_table', {'entry': ENTRIES['report'][0], 'facility_selftest': True, 'deliveries': 'first two'}),
         ('attempt_conflicting_trial_delivery', {'sameTrialAndAttempt': True, 'newStatus': 'FAIL'})],
        [('cluster', 'dedup-one-slot', True, 'Compare exact duplicate input records with first summary: a single planned/actual synthetic trial and one PASS, not two independent samples.'),
         ('scorer', 'conflicting-trial-rejected', True, 'Read second summarize_trials call exception: conflicting trial identity/attempt is rejected rather than latest-write-wins overwrite.'),
         ('asset', 'dedup-preserves-prior-report', True, 'Hash original input and first summary before/after rejected conflict; unchanged with conflict recorded separately and no extra product runs.')], entry='report')
    add('eval-grade-cost-unknown', group, '未知费用与评分费用分账且不虚报完整成本',
        '请根据请求级用量账本报告成本，明确未知消费和独立评分开销。',
        {'currency': 'CNY', 'syntheticLedger': [{'request': 'main', 'known': '0.20'},
             {'request': 'read-retry', 'known': '0.03'}, {'request': 'child', 'unknown': True},
             {'request': 'compaction', 'estimate': '0.04'}, {'request': 'judge', 'known': '0.08', 'scope': 'grading'}],
         'pluginSummary': 'duplicate rollup of child; not another charge', 'completedInvoices': 0},
        [('aggregate_request_costs', {'requestIdentityDedup': True, 'keepKnownEstimatedUnknownSeparate': True}),
         ('render_cost_report', {'scope': 'synthetic facility arithmetic'})],
        [('cost', 'cost-known-lower-bound', True, 'Sum unique non-grading known request amounts using Decimal: 0.20+0.03=0.23 CNY; estimate 0.04 and unknown child reported separately, total completeness=false.'),
         ('cost', 'cost-grading-separated', True, 'Join request scope and rollup lineage: judge 0.08 CNY is grading-only, plugin child summary is not charged twice, failed/retry/compaction usage is retained.'),
         ('zero', 'cost-no-false-unit-total', True, 'With completedInvoices=0, per-completed-invoice cost is undefined; unknown child blocks complete cost reduction/budget-meets claim even if known subtotal is small.')],
        entry='cost', stage='P11', missing=('cost_ledger_aggregator', 'price_version_and_usage_collector'))
    add('eval-grade-comparison', group, '可比公共成员与配置不等价分开报告',
        '请比较两份设施报告，列出新增退役成员，并在预算变更后停止作同口径升降结论。',
        {'baseline': {'a': 'PASS', 'removed': 'NOT_RUN'}, 'candidate': {'a': 'FAIL', 'added': 'NOT_RUN'},
         'samePinsInitially': ['model', 'budget', 'environment', 'grader', 'k'],
         'laterRevision': 'candidate budget changes; retain both earlier reports'},
        [('compare_public_reports', {'entry': ENTRIES['compare'][0], 'pins': 'initial equal frozen pins'}),
         ('append_candidate_report_revision', {'changedPin': 'budget'}),
         ('compare_public_reports', {'entry': ENTRIES['compare'][0], 'pins': 'budget mismatch'})],
        [('compare', 'common-member-regression', True, 'Inspect initial comparison: common unchanged={a}, passToFail={a}; added and removed separately listed outside common denominator.'),
         ('compare', 'mismatch-not-comparable', True, 'Compare candidate revised budget pin to baseline and output: comparable=false, reason comparison_pins_missing_or_different, no passToFail/failToPass claim for invalid comparison.'),
         ('asset', 'comparison-old-results-kept', True, 'Hash both initial reports and baseline member pins after append: unchanged; new candidate version records new protocol and no historical result is overwritten.')], entry='compare')
    add('eval-grade-calibration', group, '裁判校准缺人工真值时不能启用正式评分',
        '请核验拟启用裁判的校准与留出依据，分别登记误放行、误拒绝和引用质量。',
        {'rubric': 'synthetic semantic rubric r1', 'judgeModel': 'unbound',
         'calibrationIds': ['cal-a', 'cal-b'], 'holdoutIds': ['hold-c'],
         'syntheticDemonstrationLabels': ['expected-fail', 'expected-pass'],
         'actualHumanAdjudications': [], 'thresholdConfirmation': None,
         'citationExample': 'refers to another case version'},
        [('validate_judge_calibration_readiness', {'requireActualAdjudicationReceipts': True}),
         ('inspect_citation_identity', {'required': ['object', 'version', 'supporting-span']}),
         ('report_calibration_gaps', {'formalJudgeEnabled': False})],
        [('calibration', 'false-pass-unavailable', True, 'Count genuinely human-confirmed failing labels: zero; false-pass denominator/ratio remain unavailable and severe-miss count is unknown, not inferred from demonstration labels.'),
         ('false-reject', 'false-reject-unavailable', True, 'Join actual human positive labels and judge results by check/version: no real calibration pair, so false-reject and unjudgeable-rate estimates cannot authorize formal grading.'),
         ('citation', 'citation-wrong-version-detected', True, 'Resolve cited artifact object/version/span against required case bytes: other-version citation fails identity support, and semantic support remains pending human review.'),
         ('scorer', 'calibration-gate-stays-closed', True, 'Compare calibration/holdout groups, rubric/model pins and threshold approval receipts: missing model, human receipts and frozen targets keep formal judge disabled; no fabricated signer is written.')],
        entry='calibration', missing=('semantic_judge_adapter', 'actual_independent_human_calibration', 'frozen_error_thresholds'))
    add('eval-grade-modes', group, '设施与产品机制模型行为业务结果独立报告',
        '请按来源和验证模式整理一组质量记录，避免正确阻断掩盖模型违规或冒充业务完成。',
        {'syntheticRows': [{'scope': 'facility', 'mode': 'F', 'status': 'PASS'},
                          {'scope': 'product', 'mode': 'F', 'status': 'PASS', 'fact': 'illegal request blocked'},
                          {'scope': 'product', 'mode': 'A', 'status': 'FAIL', 'fact': 'model requested forbidden action'},
                          {'scope': 'product', 'mode': 'B', 'status': 'UNJUDGEABLE', 'fact': 'no authoritative completion'}],
         'actualExecutionReceipts': [], 'purpose': 'synthetic report projection test only'},
        [('partition_report_rows', {'dimensions': ['scope', 'F/A/B', 'environment', 'stage']}),
         ('render_independent_quality_conclusions', {'doNotMintProductReceipts': True})],
        [('modes', 'mode-denominators-separated', True, 'Group raw synthetic rows by scope/mode: facility F row excluded from product F/A/B numerators and denominator, with distinct counts retained.'),
         ('model-block', 'blocked-request-does-not-erase-a', True, 'Read projected synthetic conclusions: correct product-F block remains separate from product-A forbidden request FAIL; no combined weighted PASS.'),
         ('denominator', 'business-unknown-not-completed', True, 'Compare B row to authority inventory: lack of completion remains UNJUDGEABLE and zero confirmed business completions, not inherited from F block or agent text.'),
         ('runner', 'mode-table-not-real-runs', True, 'Compare report provenance to empty actualExecutionReceipts: all rows labelled synthetic demonstration/grader_self_test, actualProductRuns=0 and no baseline or release permission.')],
        entry='report', missing=('mode_partition_report_adapter',))
    return cases
