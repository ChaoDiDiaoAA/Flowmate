"""Explicit Harness ownership; directory membership is never coverage evidence."""
from collections import Counter
from copy import deepcopy

MODULES = {
    'foundation': ('基础契约与输入接入', '配置、启动屏障、输入身份、Workspace 与公共组装', ['MOD-01','MOD-07','MOD-09','MOD-25','MOD-29'], ['RT-01']),
    'agent-runtime': ('模型运行与任务决策', 'Provider、原生 Loop、任务理解及整票抽取', ['MOD-02','MOD-04','MOD-11'], ['RT-02','RT-03','RT-16']),
    'tools': ('工具注册与准入', 'Spec/Handler、Gateway、参数、结果及权限边界', ['MOD-05','MOD-09'], ['RT-04']),
    'events': ('事件与证据', '消息投影、事件序号、Trace 与诊断日志', ['MOD-02','MOD-26'], ['RT-09']),
    'sessions': ('会话生命周期', '身份、输入交付、队列、续接、分支及绑定', ['MOD-08','MOD-25'], ['RT-05','RT-10','RT-11','RT-12','RT-14']),
    'context': ('上下文工程', '当前资料选择、允许输入和快照实际调用关联', ['MOD-03','MOD-05'], ['RT-03']),
    'memory': ('原生历史与记忆', '完整原生历史持久化、完整性、恢复及历史使用', ['MOD-03','MOD-08','MOD-25'], ['RT-05']),
    'compaction': ('原生上下文压缩', '触发、重复压缩、失败取消及事实保持', ['MOD-03','MOD-08','MOD-28'], ['RT-06']),
    'workflow': ('业务工作流与复核', '步骤、匹配校验、等待、人工修订及评估快照', ['MOD-07','MOD-12','MOD-13','MOD-15','MOD-16','MOD-17','MOD-23'], []),
    'prompt-skills': ('Prompt 与 Skill 管理', '目标决策、SOP、资源装载、版本与资源注入', ['MOD-01','MOD-04','MOD-06'], ['RT-07']),
    'extensions': ('原生扩展', '扩展装载、Hook、命令、停用及清理', ['MOD-33'], ['RT-08']),
    'subagents': ('子 Agent 协作', '真实委派、槽位、身份、只读范围及父子取消预算', ['MOD-34','MOD-08','MOD-28'], ['RT-17']),
    'actions': ('业务动作与结果核对', '预览、正式审批、Browser/B2B、防重与权威结果', ['MOD-18','MOD-19','MOD-20','MOD-21','MOD-23'], []),
    'operations': ('运行维护与恢复', 'Host、环境凭证、发布、预算停写、备份与清理', ['MOD-24','MOD-25','MOD-26','MOD-27','MOD-28','MOD-29'], ['RT-13','RT-15','RT-16']),
    'eval-infrastructure': ('评测设施', '数据契约、Trial、评分、对照和报告', ['MOD-30','MOD-31','MOD-32'], []),
}

# Explicit family registration: an unknown family is a migration error, not a
# keyword guess. The large original extraction family keeps one shared owner.
FAMILY_GROUPS = {
 'foundation': {'platform': 'manifest-hash missing-asset malformed-json duplicate-import workspace-persistent pure-composition workspace-multiparent workspace-policy-version', 'runtime': 'ready-barrier config-isolation partial-init-cleanup'},
 'agent-runtime': {'extraction':'full-invoice-evidence', 'runtime':'provider-error provider-parameters tool-result-next-turn empty-response bounded-resource-batch'},
 'tools': {'runtime':'tool-schema tool-timeout large-result-artifact', 'isolation':'allowed-source allowed-root-fixture allowed-query cross-job cross-workspace gold-read source-label-read path-traversal symlink-escape invoice-injection tool-result-injection revoked-grant allowed-query-exfiltration boundary-query-exfiltration allowed-unnecessary-tool boundary-unnecessary-tool allowed-tool-scope-expansion boundary-tool-scope-expansion'},
 'events': {'runtime':'event-duplicate fast-slow-pairing unicode-stream subscriber-failure', 'platform':'logs-single-writer logs-disk-full'},
 'sessions': {'runtime':'abort-loop followup-queue steer-no-revoke stale-binding session-reopen closed-handle-rebuild branch-future-excluded branch-authority close-queued-inputs steer-followup-priority session-safe-rebind'},
 'context': {'runtime':'context-stale context-missing context-selected-only', 'isolation':'allowed-selected-context context-unselected allowed-privacy-minimization boundary-privacy-minimization'},
 'memory': {'runtime':'history-correction history-corrupt source-memory rtx-tool-memory-session', 'isolation':'allowed-history-injection boundary-history-injection'},
 'compaction': {'runtime':'compaction-current compaction-fail auto-compaction-below auto-compaction-above repeated-compaction rtx-compaction-retry-followup', 'isolation':'allowed-compaction-injection boundary-compaction-injection'},
 'workflow': {'matching':'exact-match supplier-alias supplier-missing supplier-ambiguous supplier-inactive supplier-stale po-missing po-wrong-supplier po-closed receipt-short price-mismatch total-mismatch decimal-exact duplicate-success duplicate-unknown non-po-policy', 'approval':'review-correction missing-evidence stale-review duplicate-review', 'platform':'waiting-view step-terminal-invalidation waiting-generation step-concurrent-input'},
 'prompt-skills': {'runtime':'resource-pinned skill-applicable skill-inapplicable resource-conflict', 'isolation':'allowed-resource-injection boundary-resource-injection'},
 'extensions': {'runtime':'extension-init-fail hook-transform-gateway rtx-session-extension'},
 'subagents': {'runtime':'subagent-suggestion parent-cancel shared-budget native-delegation child-conflict named-child-lock rtx-child-parent-recovery', 'isolation':'allowed-child-read child-scope-widening allowed-child-summary-injection boundary-child-summary-injection'},
 'actions': {'approval':'valid-approval reject revoke expired amount-changed attachment-changed target-changed wrong-role human-takeover', 'submission':'confirmed-submit response-lost unknown-unavailable authoritative-absent weak-not-found duplicate-click no-approval payload-changed wrong-target authentication-expired mfa-required attachment-rejected readback-mismatch intent-crash-before-send crash-after-send stop-during-unknown', 'isolation':'role-spoof allowed-approve boundary-approve allowed-revoked-action boundary-revoked-action allowed-changed-payload boundary-changed-payload', 'runtime':'rtx-revision-approval', 'platform':'single-controller desktop-async-failure desktop-ipc-spoof'},
 'operations': {'runtime':'deadline usage-unknown host-reconnect retry-wait-cancel retry-disabled host-protocol-fragment host-equivalence windows-package-path rtx-tools-abort-host', 'platform':'version-mismatch backup-restore migration-failure logs-restart-quota logs-safe-retention workspace-pause-inflight temporary-cleanup-boundary'},
 'eval-infrastructure': {'platform':'grader-positive grader-negative grader-missing-evidence split-leakage run-report-denominator'},
}
FAMILY_MODULE = {}
for module, categories in FAMILY_GROUPS.items():
    for category, slugs in categories.items():
        for slug in slugs.split():
            family = category + '/' + slug
            if family in FAMILY_MODULE:
                raise ValueError('Duplicate ownership: '+family)
            FAMILY_MODULE[family] = module

# Joint scenarios keep one owner. These explicitly declared participants are
# navigation only; they never produce additional coverage or duplicate files.
RELATED_FAMILIES = {
    'runtime/rtx-tool-memory-session': ['tools','sessions'],
    'runtime/rtx-revision-approval': ['workflow'],
    'runtime/rtx-session-extension': ['sessions'],
    'runtime/rtx-tools-abort-host': ['tools','agent-runtime'],
    'runtime/rtx-compaction-retry-followup': ['agent-runtime','sessions'],
    'runtime/rtx-child-parent-recovery': ['sessions','operations'],
}


def enrich_case(case):
    """Attach ownership without changing identity, conditions or expected behavior."""
    value = deepcopy(case)
    module = value.get('harnessModule') or FAMILY_MODULE.get(value['familyId'])
    if module not in MODULES:
        raise ValueError('Unregistered Harness family: '+value['familyId'])
    value['harnessModule'] = module
    value.setdefault('relatedHarnessModules', RELATED_FAMILIES.get(value['familyId'], []))
    if module in value['relatedHarnessModules'] or set(value['relatedHarnessModules'])-set(MODULES):
        raise ValueError('Invalid related Harness modules')
    value['subcapabilityRefs'] = list(dict.fromkeys(value.get('subcapabilityRefs', []) +
        [r for r in value.get('requirementRefs', []) if r.startswith(('RTC-', 'RTX-', 'HC-'))]))
    value.setdefault('caseSummary', {
        'input': ('读取当前原票及获准解析；字段答案只供评分使用。' if value['category']=='extraction' else
                  '按本用例获准资料及 scenarioSetup 构造输入和初态。'),
        'trigger': value.get('trigger', value['title']),
        'expected': '逐项满足 oracle.assertions；禁止行为及证据要求分别核验，缺证据不能通过。',
    })
    value['executionEligibility'] = {'status':'dependencies_missing',
        'reason':'需要适用阶段产品入口及可信证据适配器；离线物化不是执行。'}
    return value


def module_catalog(cases, requirements):
    from harness_governance import GOVERNANCE_REQUIREMENTS, RTC_MODULE_OVERRIDES, RTX_MODULE_OVERRIDES
    overrides={**RTC_MODULE_OVERRIDES, **RTX_MODULE_OVERRIDES}
    known = {r['id']: r for r in requirements['requirements']}
    rows = []
    for module, (name, scope, mods, rts) in MODULES.items():
        members = [c for c in cases if c['harnessModule']==module]
        checks = [{'caseId':c['id'],'caseVersion':c['version'],'checkId':ch['checkId'],
                   'requirementRefs':ch.get('requirementRefs',[]),'mode':c['evaluationMode'],
                   'phase':c['stage'],'ruleStatus':ch['ruleStatus']}
                  for c in cases for ch in c['oracle']['checks']
                  if ch.get('harnessModule',c['harnessModule'])==module]
        mapped = set(mods+rts)
        # Register required runtime subcapabilities even when no case/check has
        # been prepared yet. Absence of coverage must not hide the requirement.
        mapped.update(r['id'] for r in known.values() if r['kind']=='RTC'
            and (module in overrides[r['id']] if r['id'] in overrides else
                 'RT-'+r['id'].split('-')[1] in rts))
        mapped.update(r for r, owners in RTX_MODULE_OVERRIDES.items() if module in owners)
        if module=='eval-infrastructure':mapped.update(GOVERNANCE_REQUIREMENTS)
        mapped.update(r for c in members for r in c.get('requirementRefs',[]))
        mapped.update(r for ch in checks for r in ch['requirementRefs'])
        rows.append({'id':module,'name':name,'responsibility':scope,'path':'cases/'+module,
            'requirementRefs':sorted(mapped),'sources':[known[r]['source'] for r in sorted(mapped) if r in known],
            'caseIds':[c['id'] for c in members], 'caseCount':len(members),
            'scenarioFamilies':sorted({c['familyId'] for c in members}),
            'checks':checks, 'requiredSubcapabilities':[r['id'] for r in known.values()
                if r.get('harnessModule')==module or
                (r['id'] in mapped and r['kind'] not in {'MOD','RT','DrivingTask'})],
            'facilityObligations':[{ 'requirementId':r, **deepcopy(value)}
                for r,value in GOVERNANCE_REQUIREMENTS.items()] if module=='eval-infrastructure' else [],
            'preparedModes':dict(Counter(c['evaluationMode'] for c in members)),
            'variantCounts':dict(Counter(c.get('variant','legacy_requires_classification') for c in members)),
            'materialStatus':'structure_checked_content_review_pending',
            'executionEligibility':'dependencies_missing','actualRunCount':0,
            'coverageMeaning':'Only direct assertion links count; directory membership is not completeness.'})
    return {'schemaVersion':1,'sourceHashes':requirements['sourceHashes'],'modules':rows,
            'moduleCount':len(rows),'caseCount':len(cases),'actualProductRuns':0}
