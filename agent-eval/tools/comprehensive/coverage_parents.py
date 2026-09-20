"""Explicit family relationships for the initial dataset coverage review.

These rows organize reviewed child requirements. They are not atomic coverage
units and never infer full coverage from a module tag or a matching title.
The publisher attaches source pins and aggregates the independently reviewed
child conditions; this module does not mutate assets or published manifests.
"""
from __future__ import annotations

import re


# This list is transcribed from evaluation specification sections 8.5–8.8.
# Explicit suffixes avoid treating a newly introduced metric as reviewed.
MOD_METRICS = {
    'MOD-01': 'binding',
    'MOD-02': 'provider loop goal',
    'MOD-03': 'context coverage delivery context-use history memory correction compaction retention compression',
    'MOD-04': 'goal truth false-completion handoff',
    'MOD-05': 'registry selection parameters admission execution use retry redundant',
    'MOD-06': 'resources selection use version',
    'MOD-07': 'foundation workflow assessment',
    'MOD-08': 'binding delivery processing response stop',
    'MOD-09': 'input availability',
    'MOD-11': 'fields lines evidence uncertainty',
    'MOD-12': 'normalize rule-precision rule-recall rule-coverage',
    'MOD-13': 'recall false-block',
    'MOD-15': 'match false-match',
    'MOD-16': 'match false-match check',
    'MOD-17': 'revision intervention active-time',
    'MOD-18': 'payload ready',
    'MOD-19': 'authorization',
    'MOD-20': 'execution takeover',
    'MOD-21': 'submission unknown reconcile duplicate e2e first rework stp',
    'MOD-23': 'view control',
    'MOD-24': 'target',
    'MOD-25': 'atomic host',
    'MOD-26': 'events audit logs',
    'MOD-27': 'release rollback',
    'MOD-28': 'budget usage stop alert',
    'MOD-29': 'backup retention',
    'MOD-30': 'assets isolation',
    'MOD-31': 'runner',
    'MOD-32': 'scorer false-pass false-reject evidence',
    'MOD-33': 'extension hook cleanup',
    'MOD-34': 'identity decision result stop gain',
}

# These named product invariants supplement metric families. They must remain
# individually reviewed even when their parent metric has some direct checks.
MOD_INVARIANTS = {
    'MOD-01': ['CRIT-3.6.1-02', 'CRIT-3.24-manifest-binding'],
    'MOD-03': ['CRIT-3.24-context-snapshot', 'CRIT-3.24-native-memory',
               'CRIT-3.24.1-context-attribution'],
    'MOD-05': ['CRIT-3.23.1-02', 'CRIT-3.23.1-04'],
    'MOD-07': ['CRIT-3.6.1-01', 'CRIT-3.6.1-03', 'CRIT-3.6.1-04',
               'CRIT-3.6.1-05', 'CRIT-3.24-assessment-basis',
               'CRIT-3.24.1-assessment-consistency'],
    'MOD-08': ['CRIT-3.24-session-lifecycle', 'CRIT-3.24-session-input',
               'CRIT-3.24-persistence-binding', 'CRIT-3.24.1-session-integrity'],
    'MOD-09': ['CRIT-3.24-input-dataset'],
    'MOD-17': ['CRIT-3.24-human-interaction'],
    'MOD-19': ['CRIT-3.24-formal-approval'],
    'MOD-21': ['CRIT-3.24-action-dispatch', 'CRIT-3.24.1-action-dedup'],
    'MOD-23': ['CRIT-3.6.1-06', 'CRIT-3.6.1-07', 'CRIT-3.6.1-08', 'CRIT-3.6.1-09'],
    'MOD-25': ['CRIT-3.23.1-01', 'CRIT-3.23.1-03',
               'CRIT-3.24-storage-host-commit-ack'],
    'MOD-26': ['CRIT-3.6.1-10', 'CRIT-3.6.1-11', 'CRIT-3.6.1-12', 'CRIT-3.6.1-13'],
    'MOD-28': ['CRIT-3.23.2-01', 'CRIT-3.23.2-02'],
    'MOD-29': ['CRIT-3.23.2-03', 'CRIT-3.23.3-07', 'CRIT-3.23.3-08',
               'CRIT-3.24-storage-earlier-backup-recovery',
               'CRIT-3.24-storage-migration-retention'],
    'MOD-30': ['CRIT-4-case-record', 'CRIT-4-gold-oracle-record',
               'CRIT-4-benchmark-record', 'CRIT-4.1-sampling-isolation'],
    'MOD-31': ['CRIT-4-trial-record', 'CRIT-4-phased-identities', 'CRIT-4-workspace-evidence'],
    'MOD-32': ['CRIT-4-grader-record'],
    'MOD-34': ['CRIT-3.24-child-delegation', 'CRIT-3.24.1-delegation-identity'],
}

# Section 3.17 has exactly five native Runtime scenarios per family. Its
# RTC-06-06..10 are Context/Memory tasks, not five more Compaction mechanisms.
RT_CHILDREN = {
    f'RT-{number:02}': [f'RTC-{number:02}-{scenario:02}' for scenario in range(1, 6)]
    for number in range(1, 18)
}
RT_CHILDREN['RT-03'] += ['MOD-02.loop', 'MOD-02.goal', 'MOD-04.goal']
RT_CHILDREN['RT-04'] += ['MOD-05.registry', 'MOD-05.admission', 'MOD-05.execution', 'MOD-05.use']
RT_CHILDREN['RT-05'] += ['MOD-03.history', 'CRIT-3.24-session-lifecycle',
                         'CRIT-3.24-persistence-binding']
RT_CHILDREN['RT-06'] += ['MOD-03.compaction', 'MOD-03.retention', 'MOD-03.compression']
RT_CHILDREN['RT-08'] += ['MOD-33.extension', 'MOD-33.hook', 'MOD-33.cleanup']
RT_CHILDREN['RT-09'] += ['MOD-26.events']
RT_CHILDREN['RT-10'] += ['MOD-08.stop']
RT_CHILDREN['RT-11'] += ['MOD-08.delivery', 'MOD-08.processing', 'MOD-08.response']
RT_CHILDREN['RT-12'] += ['MOD-08.delivery', 'MOD-08.processing', 'MOD-08.response']
RT_CHILDREN['RT-13'] += ['MOD-28.budget', 'MOD-28.usage', 'MOD-05.retry']
RT_CHILDREN['RT-15'] += ['MOD-25.host', 'CRIT-3.24-storage-host-commit-ack']
RT_CHILDREN['RT-17'] += ['MOD-34.identity', 'MOD-34.decision', 'MOD-34.result',
                         'MOD-34.stop', 'MOD-34.gain', 'CRIT-3.24-child-delegation']

# Stage-specific increments from product ch.21/22 and evaluation §1.4/11.
# Whole later-stage MOD families are deliberately not attached to an early
# Driving Task merely because that module is named in its architecture row.
DRIVING_CHILDREN = {
    'P0': ['MOD-07.foundation', 'MOD-09.input', 'MOD-09.availability',
           'MOD-30.assets', 'MOD-30.isolation', 'CRIT-3.23.1-01',
           'CRIT-3.23.1-03', 'CRIT-3.6.1-01'],
    'P1': ['RTC-01-01', 'RTC-01-02', 'RTC-01-04', 'RTC-02-01', 'RTC-02-02',
           'RTC-02-03', 'RTC-03-01', 'RTC-03-02', 'RTC-03-04', 'RTC-04-01',
           'RTC-10-01', 'RTC-10-02', 'MOD-02.goal', 'MOD-04.goal',
           'CRIT-3.6.1-02', 'MOD-31.runner', 'MOD-32.scorer'],
    'P2': ['RTC-04-01', 'RTC-04-02', 'RTC-04-03', 'RTC-04-04', 'RTC-04-05',
           'MOD-05.registry', 'MOD-05.selection', 'MOD-05.parameters',
           'MOD-05.admission', 'MOD-05.execution', 'MOD-05.use', 'MOD-05.retry',
           'MOD-11.fields', 'MOD-11.lines', 'MOD-11.evidence', 'MOD-11.uncertainty'],
    'P3': ['RTC-09-01', 'RTC-09-02', 'RTC-09-03', 'RTC-09-04', 'RTC-09-05',
           'RTC-13-01', 'RTC-13-02', 'RTC-13-03', 'RTC-13-04', 'RTC-13-05',
           'MOD-28.usage', 'MOD-28.budget'],
    'P4': ['RTC-05-01', 'RTC-05-02', 'RTC-05-03', 'RTC-05-04', 'RTC-05-05',
           'RTC-11-01', 'RTC-11-02', 'RTC-11-03', 'RTC-11-04',
           'RTC-12-01', 'RTC-12-02', 'RTC-12-03', 'RTC-12-04', 'RTC-12-05',
           'RTC-14-01', 'RTC-14-02', 'RTC-14-03', 'RTC-14-04', 'RTC-14-05',
           'MOD-03.history', 'MOD-08.binding', 'MOD-08.delivery',
           'MOD-08.processing', 'MOD-08.response', 'CRIT-3.24-session-lifecycle',
           'CRIT-3.24-session-input'],
    'P5': ['MOD-03.context', 'MOD-03.coverage', 'MOD-03.delivery', 'MOD-03.context-use',
           'RTC-06-06', 'CRIT-3.24-context-snapshot', 'CRIT-3.24.1-context-attribution'],
    'P6': ['MOD-03.memory', 'MOD-03.correction', 'RTC-06-07', 'RTC-06-08',
           'RTC-06-09', 'RTC-06-10', 'CRIT-3.24-native-memory'],
    'P7': ['RTC-06-01', 'RTC-06-02', 'RTC-06-03', 'RTC-06-04', 'RTC-06-05',
           'MOD-03.compaction', 'MOD-03.retention', 'MOD-03.compression'],
    'P8': ['MOD-07.workflow', 'MOD-07.assessment', 'MOD-12.normalize',
           'MOD-12.rule-precision', 'MOD-12.rule-recall', 'MOD-12.rule-coverage',
           'MOD-13.recall', 'MOD-13.false-block', 'MOD-15.match', 'MOD-15.false-match',
           'MOD-16.match', 'MOD-16.false-match', 'MOD-16.check', 'MOD-17.revision',
           'CRIT-3.6.1-03', 'CRIT-3.6.1-04', 'CRIT-3.6.1-05',
           'CRIT-3.24-human-interaction', 'CRIT-3.24-assessment-basis'],
    'P9': ['RTC-07-01', 'RTC-07-02', 'RTC-07-03', 'RTC-07-04', 'RTC-07-05',
           'MOD-06.resources', 'MOD-06.selection', 'MOD-06.use', 'MOD-06.version'],
    'P10': ['RTC-08-01', 'RTC-08-02', 'RTC-08-03', 'RTC-08-04', 'RTC-08-05',
            'MOD-33.extension', 'MOD-33.hook', 'MOD-33.cleanup'],
    'P11': ['RTC-17-01', 'RTC-17-02', 'RTC-17-03', 'RTC-17-04', 'RTC-17-05',
            'MOD-34.identity', 'MOD-34.decision', 'MOD-34.result', 'MOD-34.stop',
            'MOD-34.gain', 'CRIT-3.24-child-delegation',
            'CRIT-3.24.1-delegation-identity'],
    'P12': ['MOD-18.payload', 'MOD-18.ready', 'MOD-19.authorization',
            'MOD-20.execution', 'MOD-20.takeover', 'MOD-21.submission',
            'MOD-21.unknown', 'MOD-21.reconcile', 'MOD-21.duplicate',
            'MOD-21.e2e', 'MOD-23.view', 'MOD-23.control', 'MOD-24.target',
            'CRIT-3.6.1-06', 'CRIT-3.6.1-07', 'CRIT-3.6.1-08', 'CRIT-3.6.1-09',
            'CRIT-3.24-formal-approval', 'CRIT-3.24-action-dispatch',
            'CRIT-3.24.1-action-dedup'],
    'P13': ['RTC-15-01', 'RTC-15-02', 'RTC-15-03', 'RTC-15-04', 'RTC-15-05',
            'RTC-16-01', 'RTC-16-02', 'RTC-16-03', 'RTC-16-04', 'RTC-16-05',
            'MOD-25.host', 'MOD-26.logs', 'MOD-27.release', 'MOD-27.rollback',
            'MOD-28.stop', 'MOD-28.alert', 'MOD-29.backup', 'MOD-29.retention',
            'MOD-17.intervention', 'MOD-17.active-time', 'MOD-21.first',
            'MOD-21.rework', 'MOD-21.stp', 'CRIT-3.6.1-10', 'CRIT-3.6.1-11',
            'CRIT-3.6.1-12', 'CRIT-3.6.1-13', 'CRIT-3.23.2-03'],
}

MINIMUM_STAGES = {
    'MOD-01': 1, 'MOD-02': 1, 'MOD-03': 4, 'MOD-04': 1, 'MOD-05': 2,
    'MOD-06': 9, 'MOD-07': 0, 'MOD-08': 1, 'MOD-09': 0, 'MOD-11': 1,
    'MOD-12': 8, 'MOD-13': 0, 'MOD-15': 8, 'MOD-16': 8, 'MOD-17': 8,
    'MOD-18': 12, 'MOD-19': 12, 'MOD-20': 12, 'MOD-21': 12,
    'MOD-23': 12, 'MOD-24': 2, 'MOD-25': 0, 'MOD-26': 0,
    'MOD-27': 0, 'MOD-28': 1, 'MOD-29': 0, 'MOD-30': 0,
    'MOD-31': 1, 'MOD-32': 0, 'MOD-33': 10, 'MOD-34': 11,
    'RT-01': 1, 'RT-02': 1, 'RT-03': 1, 'RT-04': 1, 'RT-05': 4,
    'RT-06': 7, 'RT-07': 9, 'RT-08': 10, 'RT-09': 3, 'RT-10': 1,
    'RT-11': 4, 'RT-12': 4, 'RT-13': 1, 'RT-14': 4, 'RT-15': 13,
    'RT-16': 1, 'RT-17': 11,
}


def _description(identity, requirements_by_id, metrics):
    if identity in requirements_by_id:
        return requirements_by_id[identity]['title']
    definition = metrics[identity].get('definition', '')
    parts = definition.split('|')
    return parts[1].strip().replace('`', '') if len(parts) > 1 else identity


def review(requirements, asset_index):
    """Return exactly the current MOD/RT/DrivingTask family reviews.

    ``asset_index`` maps stable asset IDs to task/contract/selftest dictionaries.
    Direct check candidates are included only for an explicit child identity;
    a later publisher rollup must use the child's substantive condition audit.
    """
    by_id = {row['id']: row for row in requirements['requirements']}
    metrics = requirements.get('metrics', {})
    known = set(by_id) | set(metrics)
    direct = {}
    for identity, asset in sorted(asset_index.items()):
        minimum = asset.get('applicability', {}).get('minimumStage')
        minimum_number = int(minimum[1:]) if isinstance(minimum, str) and re.fullmatch(r'P\d+', minimum) else None
        checks = asset.get('oracle', {}).get('checks', [])
        for check in checks:
            for child in check.get('requirementRefs', []):
                direct.setdefault(child, []).append((minimum_number, {
                    'assetId': identity, 'checkId': check['checkId']}))

    result = []
    for requirement in requirements['requirements']:
        identity, kind = requirement['id'], requirement['kind']
        if kind not in {'MOD', 'RT', 'DrivingTask'}:
            continue
        stage_number = None
        if kind == 'MOD':
            children = [identity + '.' + suffix for suffix in MOD_METRICS[identity].split()]
            children += MOD_INVARIANTS.get(identity, [])
        elif kind == 'RT':
            children = RT_CHILDREN[identity]
        else:
            stage = identity.removeprefix('DrivingTask-')
            children = DRIVING_CHILDREN[stage]
            stage_number = int(stage[1:])
        children = list(dict.fromkeys(children))
        unknown = set(children) - known
        if unknown:
            raise ValueError(f'{identity}: unrecognized authored child requirements: {sorted(unknown)}')
        conditions = []
        for child in children:
            candidates = direct.get(child, [])
            candidates = [ref for minimum, ref in candidates
                          if stage_number is None or (minimum is not None and minimum <= stage_number)
                          or asset_index[ref['assetId']].get('kind') == 'eval_selftest']
            refs = [dict(pair) for pair in sorted({tuple(sorted(ref.items())) for ref in candidates})]
            reason = ('已有该子要求的直接检查引用；完整覆盖由其逐条件语义审查汇总，不能凭父模块标签或检查数量通过。'
                      if refs else '当前未发现满足该父项范围的直接检查；须结合子要求的逐条件审查保留缺口，不能由同名模块代替。')
            if stage_number is not None:
                reason += f' 本行仅纳入最低阶段不晚于P{stage_number}的产品检查；子要求的后期条件不作为本阶段退出要求。'
            conditions.append({'conditionId': identity + '/' + child,
                'description': _description(child, by_id, metrics), 'checkRefs': refs,
                'status': 'partial' if refs else 'missing', 'reason': reason})
        minimum = stage_number if stage_number is not None else MINIMUM_STAGES[identity]
        conditional = identity in {'RT-07', 'RT-08', 'RT-17', 'MOD-06', 'MOD-33', 'MOD-34'}
        result.append({'requirementId': identity, 'unitType': 'family',
            'conditions': conditions, 'childRequirementRefs': children, 'parentRefs': [],
            'applicability': {'status': 'conditional' if conditional else 'applicable',
                'stages': [f'P{minimum}'] if stage_number is not None else [f'P{n}' for n in range(minimum, 14)],
                'basis': ('阶段首次能力及受影响回归；仅启用时适用，不能把前期固定资源当作后期能力完成。'
                          if conditional else '按产品第21/22章与评测§1.4首次能力及后续受影响回归；阶段子集不继承后期条件。')},
            'blockers': [], 'reviewStatus': 'ai_reviewed_pending_human'})
    return result
