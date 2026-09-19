"""Read-only assembly of fresh schema3 Benchmark candidates; never executes."""
from copy import deepcopy
import json
from pathlib import Path
import re
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'tools'))
from rebuild_benchmarks import PREFIX, verify
from rebuild_benchmark_mapping import ACTIVE
from rebuild_business_projection import load_business
from rebuild_sources import contained


def _phase(stage):
    if not isinstance(stage, str) or not re.fullmatch(r'P(?:[0-9]|1[0-3])(?:-[ABC])?', stage):
        raise ValueError('Unknown stage')
    return int(stage[1:].split('-')[0])


def assemble_fresh(project, quality, benchmark_id, subset='capability', stage=None,
                   split=None, environment=None, profile=None):
    from runner.benchmarks import _configuration, ENVIRONMENT_FIELDS, PROFILE_FIELDS
    from runner.materialize import materialize
    if benchmark_id not in ACTIVE or subset not in {'capability', 'regression'}:
        raise ValueError('Unknown Benchmark or subset')
    if stage is not None: _phase(stage)
    if split is not None and split not in {'development', 'regression', 'acceptance'}:
        raise ValueError('Unknown split')
    profile = _configuration(profile, PROFILE_FIELDS, 'profile')
    environment = _configuration(environment, ENVIRONMENT_FIELDS, 'environment')
    if 'k' in profile and (type(profile['k']) is not int or profile['k'] < 1):
        raise ValueError('k must be a positive integer')
    if environment.get('kind', 'offline') not in {'offline', 'test', 'production_readonly'}:
        raise ValueError('Unknown environment kind')
    project, quality = Path(project).resolve(), Path(quality).resolve()
    validation = verify(project, quality)
    read = lambda p: json.loads(contained(quality, p).read_bytes())
    base = PREFIX + benchmark_id + '/'
    bundle, readiness = read(base + 'members.json'), read(base + 'readiness.json')
    by_id = {m['caseId']: m for m in bundle['members']}
    selected = {m['caseId']: m for m in bundle['members']
                if not m['dependencyOnly'] and subset in m['subsets']
                and (stage is None or _phase(m['stage']) <= _phase(stage))
                and (split is None or m['split'] == split)}
    measured = set(selected)
    pending = list(selected)
    while pending:
        current = selected[pending.pop()]
        for key in ('normalControlRefs', 'comparisonRefs'):
            for ref in current[key]:
                cid = ref['caseId']
                if cid not in selected:
                    selected[cid] = by_id[cid]
                    pending.append(cid)
    config_blockers = ['profile_missing:' + k for k in sorted(PROFILE_FIELDS) if profile.get(k) is None]
    config_blockers += ['environment_missing:' + k for k in sorted(ENVIRONMENT_FIELDS) if environment.get(k) is None]
    rows = []
    for cid, m in sorted(selected.items()):
        case = read(m['caseRef']['path'])
        business = load_business(quality, case['businessRef']) if case.get('businessRef') else None
        fixture = materialize(case, business, project / 'data/invoices/voxel51')
        blockers = list(readiness['blockers']) + config_blockers
        if fixture['status'] != 'materialized': blockers.append('materialization_failed')
        if stage and _phase(m['stage']) > _phase(stage): blockers.append('dependency_outside_enabled_stage')
        if split and m['split'] != split: blockers.append('dependency_outside_selected_split')
        rows.append({'caseId': cid, 'caseVersion': m['caseVersion'],
                     'role': 'measurement' if cid in measured else 'dependency',
                     'status': 'NOT_RUN', 'executionEligibility': 'blocked',
                     'blockers': sorted(set(blockers)), 'fixture': fixture,
                     'grading': {k: deepcopy(m[k]) for k in ('checkIds', 'guardCheckIds',
                         'checkContracts', 'oraclePin', 'qualityAssets')},
                     'normalControlRefs': m['normalControlRefs'], 'comparisonRefs': m['comparisonRefs']})
    return {'benchmarkId': benchmark_id, 'subset': subset, 'validation': validation,
            'measuredCaseCount': len(measured), 'plannedCount': len(rows),
            'dependencyCount': len(rows) - len(measured),
            'materializedCount': sum(r['fixture']['status'] == 'materialized' for r in rows),
            'blockedCount': len(rows), 'actualProductRuns': 0, 'baselineCount': 0,
            'formalAcceptanceEligible': False, 'readiness': readiness,
            'config': {'stage': stage, 'stageMeaning': 'maximum_enabled_phase', 'split': split,
                       'profile': profile, 'environment': environment}, 'members': rows}
