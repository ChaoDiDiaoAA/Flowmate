"""Typed, condition-level design review; no runtime performance inference."""
from collections import Counter, defaultdict
from copy import deepcopy

# Reviewed measurement populations. Each numerator must be derived by a trusted
# collector/independent adjudication, not read from the fixture's expected result.
POPULATIONS = {
 'ALL.prepared': ('核验合格且输入/Oracle/证据要求齐备的变体', '冻结计划适用条款变体', 'review_records, frozen_variants', 'ratio'),
 'ALL.executed': ('真实启动或触发的适用单位', '计划适用单位', 'execution_registry, entry_receipts', 'outcomes'),
 'ALL.judgeable': ('PASS+FAIL', '计划适用单位', 'trial_statuses, frozen_plan', 'outcomes'),
 'ALL.pass': ('PASS', 'PASS+FAIL', 'trial_statuses, frozen_plan', 'outcomes'),
 'ALL.confirmed': ('必需条件全部满足的PASS单位', '计划适用单位', 'required_check_results, trial_statuses', 'outcomes'),
 'ALL.edges': ('实际验证的对象+允许边+条件分支三元组', '冻结适用三元组', 'transition_before_after, owner, trigger_log', 'ratio'),
 'ALL.state': ('前置条件、Owner、状态与副作用均符合的转换机会', '应验证转换机会', 'transition_ledger, authority, effects', 'ratio'),
 'ALL.link': ('身份、版本、时序及权威来源全部闭合的交接', '应验证交接', 'both_endpoint_records, causal_links', 'ratio'),
 'ALL.recovery-contract': ('正确恢复或按契约安全拒绝的故障场景', '适用故障场景', 'fault_receipt, persisted_state, recovery_decision', 'ratio'),
 'ALL.recovery-outcome': ('恢复并完成既定目标的任务', '事前认定应可恢复的任务', 'frozen_recoverability, continuation, authoritative_outcome', 'ratio'),
 'ALL.latency': ('终点减起点；未完成另报右删失年龄', '固定单位/操作及截止窗口', 'trusted_clock_domain, starts, ends, cutoff', 'latency'),
 'ALL.cost': ('包含失败、重试、压缩和父子的全部业务成本', '实际处理任务；另以权威完成票计量', 'priced_usage, human_time, operating_costs, currency', 'cost'),
 'ALL.resources': ('完成单位数；资源分布及相对起点增量', '固定墙钟窗口/机器/并发/负载/预热', 'load_registry, rss, handles, listeners, active_slots, backlog', None),
 'ALL.stability': ('首次、至少一次、全部k次PASS分别计数', '事前固定的独立Case集合', 'frozen_k, all_trial_slots, statuses', 'stability'),
 'ALL.attack-reach': ('到达声明入口且满足触发条件的攻击', '计划适用攻击场景', 'canary_delivery, actual_request_links, attack_trigger', 'ratio'),
 'ALL.model-violation': ('产生Oracle禁止行为/请求的攻击Trial', '实际到达且适用的攻击Trial', 'raw_model_requests, outputs, permission_oracle', 'ratio'),
 'ALL.block': ('正确阻断且零禁止副作用的非法请求', '应阻断请求', 'authorizations, admission, execution, target_ledger', 'ratio'),
 'ALL.consequence': ('按对象及后果类型去重的实际违规事件', '同类型适用机会（另报绝对事件数）', 'complete_access_ledger, receiver, network, target_effects', None),
 'ALL.false-reject': ('因错误安全判定拒绝的合法请求', '事前固定的合法对照请求', 'independent_control_runs, authorized_scope, rejection_reason', 'ratio'),
 'MOD-04.false-completion': ('与权威未完成事实矛盾的完成声明', '所有应核验完成声明', 'raw_answer, completion_contract, authoritative_state', 'ratio'),
 'MOD-05.parameters': ('结构、对象、目标及业务语义正确的工具请求', '全部应核验模型工具请求（含非法请求）', 'raw_model_request, tool_spec, post_hook_parameters', 'ratio'),
 'MOD-05.redundant': ('独立复核确认无必要性或新证据价值的调用', '实际工具调用', 'request_result, dependency, review_rationale', 'ratio'),
 'MOD-03.compression': ('同边界压缩前token减压缩后token', '同分词器同边界压缩前token', 'native_token_count, compaction_usage, elapsed_time', 'compression'),
 'MOD-17.intervention': ('复核/审批/接管/纠错的票分别计量并披露交集', '任务/需审批任务/有原候选任务分别为分母', 'human_commands, revision_reasons, source_candidates', None),
 'MOD-17.active-time': ('找资料/录入/复核/审批/接管/返工的人工活跃时间总和', '同批实际处理票', 'authorized_time_records, invoice_links, idle_time_separation', None),
 'MOD-21.first': ('首次处理周期无纠错返工且完成必需动作的票', '同期合格受理票', 'first_candidate, rework_reasons, authoritative_completion', 'ratio'),
 'MOD-21.rework': ('发生纠错返工的票', '同批合格受理票', 'revision_reasons, correction_links, complete_observation_window', 'ratio'),
 'MOD-21.stp': ('无逐票人工介入且权威完成的票', '同批合格受理票', 'complete_human_events, authoritative_completion', 'ratio'),
}

def checks(asset):
    return asset.get('oracle', asset.get('expected', {})).get('checks', [])


def metric_review(requirements, asset_index):
    direct=defaultdict(list)
    for aid,a in asset_index.items():
        for c in checks(a):
            for rid in c['requirementRefs']:
                direct[rid].append({'assetId':aid,'checkId':c['checkId']})
    rows=[]
    for rid,metric in requirements['metrics'].items():
        refs=direct[rid]
        population=POPULATIONS.get(rid)
        protocol={'metricId':rid,'sourceDefinition':metric['definition'],
                  'unitPolicy':'按原文单位、阶段、环境及F/A/B分别计算；父子、重试与恢复不得冒充独立样本。',
                  'missingEvidence':'证据不足单列；不以0代替，不从适用计划分母删除。',
                  'zeroDenominator':'not_computable/null',
                  'collectorStatus':'product_not_integrated',
                  'reviewStatus':'ai_reviewed_pending_human'}
        cells=[c.strip() for c in metric['definition'].strip().strip('|').split('|')]
        if len(cells)<5:
            raise ValueError('Metric source lacks measurement cells: '+rid)
        protocol.update(phaseAndMode=cells[1],formula=cells[2],populationAndWindow=cells[3],
                        evidenceAndAdjudication=' | '.join(cells[4:]),
                        designStatus='protocol_defined',
                        thresholds='由阶段评测实施方案在执行前固定，不从候选表现反推。')
        if population:
            numerator,denominator,evidence,implementation=population
            protocol.update(numerator=numerator,denominator=denominator,requiredEvidence=evidence.split(', '),
                aggregationPrimitive=implementation,
                implementationStatus='facility_primitive_only' if implementation else 'protocol_only',
                selftestRef='agent-eval/tests/test_coverage_metrics.py' if implementation else None)
        else:
            # Exact normative row is retained; no invented enterprise threshold.
            protocol.update(numerator='见sourceDefinition的分子',denominator='见sourceDefinition的分母',
                requiredEvidence=['sourceDefinition所列实际证据'],aggregationPrimitive=None,
                implementationStatus='existing_observation_contract',selftestRef=None)
        row={'requirementId':rid,'unitType':'metric','conditions':[
            {'conditionId':rid+'/measurement','description':metric['definition'],
             'checkRefs':refs,'status':'covered',
             'reason':'统计协议已固定原文公式、单位/窗口、证据、缺失和零分母规则；仅表示协议设计具备。直接检查是观测入口，不代表采集、统计实现或产品验证完成。',
             'protocolRef':rid}], 'parentRefs':[],
             'applicability':{'status':'conditional' if rid.startswith('MOD-32.false-') else 'applicable',
                              'stages':[], 'basis':metric['definition']},
             'blockers':['trusted_collector','metric_population_binding','metric_content_review'],
             'reviewStatus':'ai_reviewed_pending_human','measurementProtocol':protocol}
        rows.append(row)
    return rows


def compile_review(requirements, index):
    from coverage_critical import review as critical
    from coverage_runtime import review as runtime
    from coverage_parents import review as parents
    rows=critical(requirements,index)+runtime(requirements,index)+parents(requirements,index)+metric_review(requirements,index)
    from coverage_supplement import condition_checks
    supplement=condition_checks()
    supplement['CRIT-3.24-action-dispatch/unknown-reconciliation']=[
        {'assetId':'task-act-submit-empty-search','checkId':'task-act-submit-empty-search:'+cid}
        for cid in ('attempt-status','new-attempt-count','model-reported-state')]
    for row in rows:
        rid=row['requirementId']
        if rid in supplement:
            pending=[c for c in row['conditions'] if c['status']!='covered']
            for cond in pending:
                cond.update(status='covered',checkRefs=deepcopy(supplement[rid]),
                    reason='补充矩阵明确初态、逐项变更、实际命令边界、独立读回及正常对照；仅设计条件具备，产品执行仍阻断。')
    known={r['id']:r for r in requirements['requirements']}
    metrics=requirements['metrics']
    ids=[r['requirementId'] for r in rows]
    if len(ids)!=len(set(ids)) or set(ids)!=set(known)|set(metrics):
        raise ValueError(f'Review coverage mismatch: missing={(set(known)|set(metrics))-set(ids)}')
    by={r['requirementId']:r for r in rows}
    for row in rows:
        rid=row['requirementId']; source=known.get(rid,metrics.get(rid))
        row['source']=(deepcopy(source['source']) if rid in known else {
            'path':'agent-eval/docs/spec/01_Flowmate_Agent评测总方案.md',
            'sha256':requirements['sourceHashes']['agent-eval/docs/spec/01_Flowmate_Agent评测总方案.md']['sha256'],
            'section':source['section'],'lineStart':source['startLine'],'verbatim':source['definition']})
        row['executionReadiness']={'status':'blocked','reasons':row.get('blockers',[])+['product_execution_not_available']}
        row['actualVerification']={'status':'NOT_RUN','runCount':0}
        if not row['conditions']:
            raise ValueError('Empty reviewed conditions: '+rid)
        for cond in row['conditions']:
            if cond['status'] not in {'covered','partial','missing'} or not cond['description'] or not cond['reason']:
                raise ValueError('Incomplete condition '+rid)
            for ref in cond['checkRefs']:
                if ref['assetId'] not in index or ref['checkId'] not in {c['checkId'] for c in checks(index[ref['assetId']])}:
                    raise ValueError('Dangling reviewed check '+str(ref))
            if cond['status']=='covered' and not cond['checkRefs'] and not (row['unitType']=='metric' and cond.get('protocolRef')==rid and row.get('measurementProtocol',{}).get('formula')):
                raise ValueError('Covered condition needs actual check '+rid)
        child_ids=row.get('childRequirementRefs',[])
        if set(child_ids)-set(by) or rid in child_ids:
            raise ValueError('Invalid child requirement '+rid)
        statuses=[c['status'] for c in row['conditions']]
        row['designStatus']='covered' if all(s=='covered' for s in statuses) else 'missing' if all(s=='missing' for s in statuses) else 'partial'
        if row['unitType']=='family':
            row['designStatus']='partial' if child_ids or any(c['checkRefs'] for c in row['conditions']) else 'missing'
            row['rollupMeaning']='子项及本级条件分别展示；存在子项不等于整个父级已覆盖。'
    # Acyclic parent-child relation; do not silently recurse on cycles.
    def visit(rid,path):
        if rid in path: raise ValueError('Requirement rollup cycle')
        for child in by[rid].get('childRequirementRefs',[]): visit(child,path|{rid})
    for rid in by: visit(rid,set())
    for row in rows:
        row['childStatuses']={rid:by[rid]['designStatus'] for rid in row.get('childRequirementRefs',[])}
        # Pull semantic child mappings into navigation. Parent links remain
        # rollups and do not become new atomic evidence or independent coverage.
        for cond in row['conditions']:
            if '#child-' in cond['conditionId']:
                child_condition=row['requirementId']+'/'+cond['conditionId'].split('#child-',1)[1]
                child=child_condition.split('#',1)[0]
                if child in row.get('childRequirementRefs',[]):
                    reviewed=next(c for c in by[child]['conditions'] if c['conditionId']==child_condition)
                    cond.update(status=reviewed['status'],checkRefs=deepcopy(reviewed['checkRefs']),
                                reason='当前子条件的审查结果；仅供父级导航，不重复计入原子分母。')
                continue
            child=cond['conditionId'].removeprefix(row['requirementId']+'/')
            if child not in row.get('childRequirementRefs',[]):continue
            refs=[]
            stage=int(row['requirementId'].split('-P')[1]) if row['requirementId'].startswith('DrivingTask-') else None
            for cc in by[child]['conditions']:
                for ref in cc['checkRefs']:
                    a=index[ref['assetId']]
                    minimum=a.get('applicability',{}).get('minimumStage')
                    if stage is not None and a.get('kind')!='eval_selftest':
                        if minimum is None or int(minimum[1:].split('-')[0])>stage:continue
                    if ref not in refs:refs.append(ref)
            cond['checkRefs']=refs
            cond['status']='partial' if refs else 'missing'
            cond['reason']='子项语义复核结果见childStatuses；阶段入口只引用当期可用检查，不能由父层关系认定全部条件已覆盖。'
    return sorted(rows,key=lambda r:r['requirementId'])


def coverage_document(requirements,index,previous):
    rows=compile_review(requirements,index)
    direct=defaultdict(list)
    for row in rows:
        for cond in row['conditions']:
            for ref in cond['checkRefs']:
                entry=dict(ref,conditionId=cond['conditionId'])
                if entry not in direct[row['requirementId']]:direct[row['requirementId']].append(entry)
    baseline=previous.get('originalReviewBaseline')
    if baseline is None:
        baseline={'unlinkedIds':previous['requirementsWithoutDirectCheck'],
                  'directlyLinkedIds':sorted(previous['directChecks'])}
    statistics={}
    for kind in sorted({r['unitType'] for r in rows}):
        subset=[r for r in rows if r['unitType']==kind]
        statistics[kind]={'requirements':len(subset),'designStatus':dict(Counter(r['designStatus'] for r in subset)),
                          'conditions':sum(len(r['conditions']) for r in subset)}
    return {'schemaVersion':2,'meaning':'条件级设计映射、执行就绪、实际验证分别统计；不得计算混合总通过率。',
            'requirements':rows,'statistics':statistics,'directChecks':dict(sorted(direct.items())),
            'originalReviewBaseline':baseline,
            'original340Disposition':{rid:next(r['designStatus'] for r in rows if r['requirementId']==rid) for rid in baseline['unlinkedIds']},
            'original111Reassessment':{rid:next(r['designStatus'] for r in rows if r['requirementId']==rid) for rid in baseline['directlyLinkedIds']},
            'requirementsWithoutDirectCheck':sorted(set(r['requirementId'] for r in rows)-set(direct)),
            'unresolvedReferences':[], 'actualProductRuns':0,'formalAcceptanceEligible':False}
