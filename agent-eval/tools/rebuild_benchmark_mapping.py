"""Candidate check-level applicability for the newly authored schema3 dataset.

These explicit metric/predicate rules select *candidate* members, not proof of
whole-requirement coverage or content approval. The member writer must pin the
whole Case, protocol and these rules, close controls and keep mandatory guards.
Unknown metrics are errors: there is no default BM-07/BM-11 allocation.
"""
import re

RULE_VERSION = 1
ACTIVE = tuple(f'BM-{n:02}' for n in range(1, 13) if n != 6)
FACILITY = frozenset(('MOD-30.assets MOD-30.isolation MOD-31.runner MOD-32.evidence '
                     'MOD-32.false-pass MOD-32.false-reject MOD-32.scorer').split())
EXTRACTION = frozenset(('MOD-11.fields MOD-11.lines MOD-11.evidence MOD-11.uncertainty').split())

# Explicit submetrics, rather than an open-ended prefix or a physical directory.
METRIC_BENCHMARKS = {}
def _bind(metrics, *benchmarks):
    for metric in metrics.split():
        if metric in METRIC_BENCHMARKS:
            raise RuntimeError('Repeated metric mapping')
        METRIC_BENCHMARKS[metric] = benchmarks

_bind('MOD-01.binding MOD-02.goal MOD-07.foundation MOD-09.availability MOD-09.input '
      'MOD-23.control MOD-26.audit MOD-26.events MOD-26.logs '
      'MOD-27.release MOD-28.alert MOD-28.stop', 'BM-09')
_bind('MOD-02.loop MOD-02.provider', 'BM-03')
_bind('MOD-03.context MOD-03.context-use MOD-03.correction MOD-03.coverage '
      'MOD-03.delivery MOD-03.memory MOD-03.retention MOD-04.goal MOD-04.truth '
      'MOD-05.execution MOD-05.registry MOD-05.retry MOD-05.selection MOD-05.use '
      'MOD-06.resources MOD-06.selection MOD-06.use MOD-06.version', 'BM-03')
_bind('MOD-05.admission', 'BM-03', 'BM-08')
_bind('MOD-03.history MOD-25.atomic MOD-25.host MOD-08.binding MOD-08.delivery '
      'MOD-08.processing MOD-08.response MOD-08.stop', 'BM-07')
_bind('MOD-27.rollback MOD-29.backup MOD-29.retention', 'BM-07', 'BM-09')
_bind('MOD-03.compaction MOD-28.budget MOD-28.usage', 'BM-09')
_bind('MOD-07.assessment MOD-12.normalize MOD-12.rule-coverage MOD-12.rule-precision '
      'MOD-12.rule-recall MOD-13.false-block MOD-13.recall MOD-15.false-match MOD-15.match '
      'MOD-16.check MOD-16.false-match MOD-16.match', 'BM-02')
_bind('MOD-07.workflow MOD-23.view', 'BM-04', 'BM-09')
_bind('MOD-04.handoff', 'BM-03', 'BM-04')
_bind('MOD-17.revision', 'BM-04')
_bind('MOD-18.payload MOD-18.ready', 'BM-04', 'BM-05')
_bind('MOD-19.authorization', 'BM-04', 'BM-08')
_bind('MOD-20.execution MOD-21.e2e MOD-21.submission', 'BM-05')
_bind('MOD-21.duplicate MOD-21.reconcile MOD-21.unknown', 'BM-05', 'BM-07')
_bind('MOD-24.target', 'BM-05', 'BM-09')
_bind('MOD-20.takeover', 'BM-04', 'BM-05')
_bind('MOD-33.cleanup MOD-33.extension MOD-33.hook MOD-34.gain '
      'MOD-34.identity MOD-34.stop', 'BM-12')
_bind('MOD-34.decision MOD-34.result', 'BM-03', 'BM-12')

# Only exact boundary predicates extend membership; a generic Context or event
# requirement does not automatically prove isolation. Missing selectors remain
# visible as mapping/coverage work, never a fabricated complete safety matrix.
SECURITY_PATHS = frozenset('''
observation.label-content-visible observation.other-job-material-present
observation.other-snapshot-read observation.other-task-visible
observation.scope-expanded-by-snapshot observation.source-text-expanded-permissions
observation.source-text-marked-untrusted observation.model-text-used-as-link
observation.first-history-in-second-request observation.attachment-access-granted
observation.read.qualityRootBytes observation.plugin.writeAdmission
observation.agent.sourceInstructionTreatedAsAuthority
observation.executor.outOfScopeCalls observation.resource.readsAfterRevocation
observation.resource.revokedPermissionRestored observation.workflow.policyChangedByResource
observation.approval.syntheticConfirmations observation.executor.callsAfterRevocation
observation.query.deniedRequests observation.query.outOfScopePayloads
observation.logs.rawSecrets observation.export.outsideRootReads
observation.approval-attempt-denied observation.approval-or-write-count
observation.business-write-count observation.forbidden-access-rejected
observation.protected-canary-delivery-count observation.stale-write-count
'''.split())

RECOVERY_PATHS = frozenset('''
observation.compacted-tree-cursor-restored observation.original-history-unmodified
observation.uncommitted-summary-restored observation.restored-checkpoint-id
observation.resumed-from-orphan observation.usable-new-checkpoint-count
observation.no-reissued-delegation observation.recovery-created-child-count
observation.committed-native-history-restored observation.pending-identity-preserved
'''.split())

# Native presence is necessary, not sufficient: only these declared runtime
# submetrics enter BM-11, F/A only, P1+. No fabricated native history is accepted.
RUNTIME_METRICS = frozenset(('MOD-01.binding MOD-02.goal MOD-02.loop MOD-02.provider '
    'MOD-03.compaction MOD-03.context MOD-03.context-use MOD-03.correction MOD-03.coverage '
    'MOD-03.delivery MOD-03.history MOD-03.memory MOD-03.retention MOD-04.goal '
    'MOD-04.handoff MOD-04.truth MOD-05.admission MOD-05.execution MOD-05.registry '
    'MOD-05.retry MOD-05.selection MOD-05.use MOD-06.resources MOD-06.selection '
    'MOD-06.use MOD-06.version MOD-08.binding MOD-08.delivery MOD-08.processing '
    'MOD-08.response MOD-08.stop MOD-26.events MOD-28.budget MOD-28.usage '
    'MOD-33.cleanup MOD-33.extension MOD-33.hook').split())

REASONS = {
    'BM-01': '整票抽取的字段、明细、来源和不确定状态检查；Gold仍需独立核验。',
    'BM-02': '业务规则、对象匹配、重复识别或当前Assessment的直接判据。',
    'BM-03': '模型、工具、资料或Skill的选择、执行、使用及结果诚实性判据。',
    'BM-04': '人工修订、提交预览、正式授权或接管的直接判据。',
    'BM-05': '载荷、实际目标操作、提交和权威核对的直接判据。',
    'BM-07': '持久化、事务、历史恢复、备份或显式恢复位置的直接判据。',
    'BM-08': '明确准入/审批要求或精确边界观测；合法对照必须闭合且实际运行。',
    'BM-09': '产品控制、配置、状态、输入接入、事件日志或运行治理的直接判据。',
    'BM-11': 'P1及以后、F/A层、明确声明原生或SDK接入来源的Runtime检查；实际采证仍未就绪。',
    'BM-12': '扩展或子Agent的直接能力、身份、结果、控制及资源判据。',
}


def classify_fresh_case(case):
    """Return explicit candidates only; never freeze, grant readiness or score.

The caller must validate the full Case against its pinned author and specs.
This function does not replace schema validation, controls or evidence grading.
"""
    if case.get('schemaVersion') != 3 or case.get('provenance', {}).get('legacyCasesRead') is not False:
        raise ValueError('Fresh schema3 Case provenance required')
    if not re.fullmatch(r'P(?:[0-9]|1[0-3])', case.get('stage', '')):
        raise ValueError('Valid product stage required')
    checks = case.get('oracle', {}).get('checks', [])
    if not checks or len({c.get('checkId') for c in checks}) != len(checks):
        raise ValueError('Unique nonempty checks required')
    selected = {}
    for check in checks:
        metric = check.get('metricId')
        if (not check.get('checkId') or not check.get('sourceRefs') or not check.get('evidenceRequirements')
                or check.get('evaluationMode') not in {'F', 'A', 'B'}):
            raise ValueError('Direct source, mode and evidence required for every member check')
        if case.get('harnessModule') == 'eval-infrastructure':
            if metric not in FACILITY:
                raise ValueError('Facility metric outside declared facility contract')
            continue
        if metric in FACILITY:
            raise ValueError('Facility predicate cannot contribute product capability')
        if metric in EXTRACTION:
            if (case.get('scenarioProtocol') != {'kind': 'fresh_invoice_extraction', 'version': 1}
                    or not case['oracle'].get('fieldGoldRef')):
                raise ValueError('BM-01 requires a whole-invoice extraction and Gold reference')
            targets = {'BM-01'}
        elif metric in METRIC_BENCHMARKS:
            if not check.get('assertion'):
                raise ValueError('Mechanism/business membership needs a concrete predicate')
            targets = set(METRIC_BENCHMARKS[metric])
        else:
            raise ValueError('Unmapped or retired metric: ' + str(metric))
        path = check.get('assertion', {}).get('path')
        if path in SECURITY_PATHS:
            targets.add('BM-08')
        if path in RECOVERY_PATHS:
            targets.add('BM-07')
        if (metric in RUNTIME_METRICS and case['stage'] != 'P0' and check['evaluationMode'] in {'F', 'A'}
                and any(s.get('layer') in {'pi_native', 'flowmate_sdk_integration'}
                        for s in check.get('implementationSources', []))):
            targets.add('BM-11')
        # A budget/history predicate inside a real delegation/Hook task can also
        # measure that task's resource and lifecycle obligation, with its own ID.
        if (case.get('harnessModule') in {'extensions', 'subagents'} and
                metric in RUNTIME_METRICS):
            targets.add('BM-12')
        for identity in sorted(targets):
            selected.setdefault(identity, []).append(check)
    return [{'benchmarkId': identity, 'checkIds': [c['checkId'] for c in rows],
             'requirementRefs': sorted({c['metricId'] for c in rows}),
             'reason': REASONS[identity], 'ruleVersion': RULE_VERSION,
             'membershipReview': 'pending', 'executionEligibility': 'dependencies_missing',
             'coverageMeaning': 'candidate_direct_checks_not_full_requirement_coverage',
             'actualProductRuns': 0}
            for identity, rows in sorted(selected.items())]
