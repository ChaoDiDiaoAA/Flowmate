"""Offline schema-v1 plans. Product execution and product scoring stay blocked."""
from copy import deepcopy
import hashlib
import json
from pathlib import Path
import stat
import sys

if __package__ in {None, ''}:
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from initial_contract import validate_asset, asset_ref, safe_relative


def resolve_asset(ref, project, quality, *, model_input=False):
    """Resolve an explicit logical root, reject links, and verify pinned bytes."""
    asset_ref(ref, model_input=model_input)
    supplied = project if ref['root'] == 'project' else quality
    if supplied is None:
        raise ValueError(f"{ref['root']} root is required to load {ref['path']}")
    root = Path(supplied).resolve(strict=True)
    path = root
    for part in safe_relative(ref['path']).split('/'):
        path /= part
        try:
            info = path.lstat()
        except OSError as exc:
            raise ValueError('asset missing or unreadable') from exc
        if path.is_symlink() or getattr(info, 'st_file_attributes', 0) & stat.FILE_ATTRIBUTE_REPARSE_POINT:
            raise ValueError('asset cannot traverse links or junctions')
    if not path.resolve().is_relative_to(root) or not path.is_file():
        raise ValueError('asset escapes declared root')
    raw = path.read_bytes()
    if 'bytes' in ref and len(raw) != ref['bytes']:
        raise ValueError('asset byte count mismatch')
    if 'sha256' in ref and hashlib.sha256(raw).hexdigest() != ref['sha256']:
        raise ValueError('asset digest mismatch')
    return path


def materialize_task(case, project=None, quality=None):
    """Return separate model input, trusted harness plan and grading authority.

    No Gold is opened during assembly. Optional roots resolve pinned task assets
    and business bases; callers must only deliver ``fixture.input`` to a model.
    """
    validate_asset(case)
    if case['kind'] != 'agent_task':
        raise ValueError('materialize_task accepts agent_task assets only')
    task = deepcopy(case['task'])
    if project is not None:
        for ref in task['assetRefs']:
            resolve_asset(ref, project, quality, model_input=True)
    setup = deepcopy(case['setup'])
    harness = {**setup, 'caseId': case['id'], 'caseVersion': case['version'],
               'interactions': deepcopy(case['interactions']),
               'executionStatus': 'NOT_RUN', 'adapterStatus': 'product_adapter_required',
               'nativeHistoryFabricated': False, 'actualProductRun': False,
               'networkPolicy': 'isolated_test_targets_only_except_configured_model_provider'}
    if setup['businessRef'] is not None:
        if quality is None:
            raise ValueError('quality root required to validate business dependency')
        from rebuild_business_projection import load_business, project_business
        business = load_business(Path(quality), setup['businessRef'])
        projection = project_business(setup['businessRef'], business, setup['businessPatches'])
        task['business'] = projection['input']
        task['simulationPolicy'] = projection['policy']
        harness['businessInitialState'] = projection['initialState']
    from rebuild_cases import assert_product_projection
    assert_product_projection(task)
    return {'status': 'materialized', 'caseId': case['id'], 'caseVersion': case['version'],
            'fixture': {'input': task, 'harness': harness},
            'grading': {'oracle': deepcopy(case['oracle']),
                        'controlRefs': deepcopy(case['controlRefs']),
                        'comparisonRefs': deepcopy(case['comparisonRefs'])},
            'executionEligibility': 'blocked', 'blockers': ['product_adapter_required'],
            'productScoreEligible': False}


def grade_observation(case, observation, gold=None):
    """An initial declaration cannot attest a product run or award its score.

    Product JSON, including asserted success booleans and synthetic traces,
    remains unjudgeable until an implemented trusted adapter is registered.
    Selftests exercise only exact JSON comparisons of their declared examples.
    """
    validate_asset(case)
    if case['kind'] == 'eval_selftest':
        observations = observation if isinstance(observation, dict) else {}
        checks = []
        for scenario in case['scenarios']:
            if scenario['id'] not in observations:
                status, reason = 'UNJUDGEABLE', 'selftest_observation_missing'
            else:
                actual = json.dumps(observations[scenario['id']], sort_keys=True, allow_nan=False)
                expected = json.dumps(scenario['expected'], sort_keys=True, allow_nan=False)
                status, reason = ('PASS' if actual == expected else 'FAIL'), 'synthetic_selftest_only'
            checks.append({'checkId': scenario['id'], 'required': True, 'status': status, 'reason': reason})
        from contracts import aggregate_checks
        return {**aggregate_checks(checks), 'checks': checks, 'scope': 'eval_selftest',
                'productScoreEligible': False, 'formalAcceptanceEligible': False}
    definitions = case['oracle']['checks'] if case['kind'] == 'agent_task' else [
        check for scenario in case['scenarios'] for check in scenario['oracle']['checks']]
    checks = [{**{key: deepcopy(check[key]) for key in ('checkId', 'capabilities', 'required', 'hardConstraint')},
               'status': 'UNJUDGEABLE', 'reason': 'product_adapter_required'} for check in definitions]
    return {'verdict': 'UNJUDGEABLE', 'reason': 'product_adapter_required', 'checks': checks,
            'scope': case['kind'], 'executionStatus': 'NOT_RUN', 'productScoreEligible': False,
            'formalAcceptanceEligible': False, 'unresolvedCheckIds': [check['checkId'] for check in checks]}


def _phase(stage):
    import re
    match = re.fullmatch(r'P([0-9]|1[0-3])(?:-([ABC]))?', str(stage))
    if not match:
        raise ValueError('stage must be P0 through P13')
    return int(match[1]), 'ABC'.find(match[2]) if match[2] else -1


def assemble_benchmark(benchmark_id, project, stage=None, split=None, subset='capability',
                       capability=None, task_type=None):
    """Filter candidate membership and retain all required dependency plans.

    A caller-selected stage never authorizes a later-stage control. Such
    controls are retained with explicit blockers so filtering cannot turn an
    unsupported or unpaired case into a passing benchmark.
    """
    from initial_contract import CAPABILITIES, BUSINESS_TASK_TYPES
    active = {f'BM-{index:02}' for index in range(1, 13)} - {'BM-06'}
    if benchmark_id not in active:
        raise ValueError('unknown or retired benchmark')
    if stage is not None:
        _phase(stage)
    if split is not None and split not in {'development', 'regression', 'acceptance'}:
        raise ValueError('unknown split')
    if subset not in {'capability', 'regression'}:
        raise ValueError('unknown subset')
    if capability is not None and capability not in CAPABILITIES:
        raise ValueError('unknown capability')
    if task_type is not None and task_type not in BUSINESS_TASK_TYPES:
        raise ValueError('unknown task type')
    project = Path(project).resolve(strict=True)
    quality = project / 'agent-eval/data'

    def load(relative, pin=None):
        ref = {'root': 'quality', 'path': relative}
        if pin:
            ref.update({key: pin[key] for key in ('sha256', 'bytes') if key in pin})
        return json.loads(resolve_asset(ref, project, quality).read_bytes())

    marker = load('manifests/active-dataset.json')
    if marker.get('format') != 'initial-agent-evaluation':
        raise ValueError('current initial dataset is not active')
    inventory = load('manifests/inventory.json', {'sha256': marker['inventorySha256']})
    file_pins = {ref['path']: ref for ref in inventory['files']}
    public_pins = {ref['path']: ref for ref in inventory['publicFiles']}
    def current(relative):
        if relative not in file_pins:
            raise ValueError('required manifest is outside active inventory')
        return load(relative, file_pins[relative])
    catalog = current('manifests/case-catalog.json')
    member_doc = current(f'manifests/benchmarks/{benchmark_id}/members.json')
    readiness = current(f'manifests/benchmarks/{benchmark_id}/readiness.json')
    definition_pin = member_doc['definitionPin']
    if public_pins.get(definition_pin['path']) != definition_pin:
        raise ValueError('benchmark definition pin differs from active inventory')
    resolve_asset({'root': 'project', **definition_pin}, project, quality)
    if readiness.get('benchmarkId') != benchmark_id or readiness.get('executionEligibility') != 'blocked':
        raise ValueError('unknown benchmark readiness state')
    if catalog.get('schemaVersion') != 1 or member_doc.get('benchmarkId') != benchmark_id:
        raise ValueError('unsupported catalog or benchmark identity')
    rows = catalog.get('cases', [])
    by_id = {row['id']: row for row in rows}
    if len(by_id) != len(rows):
        raise ValueError('duplicate catalog identity')
    members = {member['assetId']: member for member in member_doc['members']}
    if len(members) != len(member_doc['members']):
        raise ValueError('duplicate benchmark membership')
    definitions = {}
    loaded_suites = {}
    for identity, member in members.items():
        row = by_id.get(identity)
        if row is None or any(member.get(key) != row.get(key) for key in ('path', 'version', 'sha256')):
            raise ValueError('benchmark catalog pin mismatch')
        if member.get('assetKind') != row['kind']:
            raise ValueError('benchmark asset kind mismatch')
        if row['path'] not in loaded_suites:
            loaded_suites[row['path']] = load(row['path'], row)
            validate_asset(loaded_suites[row['path']])
        value = loaded_suites[row['path']]
        if value['version'] != row['version'] or value['kind'] != row['kind']:
            raise ValueError('catalog asset revision mismatch')
        if row['kind'] == 'product_contract':
            scenarios = [scenario for scenario in value['scenarios'] if scenario['id'] == row.get('scenarioId')]
            if len(scenarios) != 1 or row.get('scenarioId') != identity:
                raise ValueError('contract scenario identity mismatch')
            value = scenarios[0]
        elif row['kind'] != 'agent_task' or value['id'] != identity:
            raise ValueError('unknown benchmark asset kind or identity')
        checks = {check['checkId'] for check in value['oracle']['checks']}
        if not set(member['checkIds'] + member['guardCheckIds']) <= checks:
            raise ValueError('unknown benchmark check')
        if member['split'] != value['split'] or member['stage'] != value['applicability']['minimumStage']:
            raise ValueError('membership split or stage mismatch')
        expected_refs = value['controlRefs'] + value.get('comparisonRefs', [])
        if set(member['controlRefs']) != set(expected_refs):
            raise ValueError('membership hides declared dependencies')
        definitions[identity] = value

    selected = set()
    for identity, member in members.items():
        value = definitions[identity]
        if member.get('dependencyOnly') or subset not in member['subsets']:
            continue
        if stage is not None and _phase(member['stage']) > _phase(stage):
            continue
        if split is not None and member['split'] != split:
            continue
        classification = value.get('classification', {})
        if capability is not None and capability not in classification.get('capabilities', []):
            continue
        if task_type is not None and task_type != classification.get('business', {}).get('primaryTaskType'):
            continue
        selected.add(identity)
    closure = set(selected)
    pending = list(selected)
    edges = []
    while pending:
        identity = pending.pop()
        for dependency in members[identity]['controlRefs']:
            if dependency not in members:
                raise ValueError(f'unclosed benchmark dependency: {identity} -> {dependency}')
            edges.append((identity, dependency))
            if dependency not in closure:
                closure.add(dependency)
                pending.append(dependency)
    plans = []
    blockers = ['product_adapter_required', *readiness['blockers']]
    for identity in sorted(closure):
        value, member = definitions[identity], members[identity]
        item_blockers = ['product_adapter_required']
        if stage is not None and _phase(member['stage']) > _phase(stage):
            item_blockers.append('dependency_requires_later_stage')
        if split is not None and member['split'] != split:
            item_blockers.append('dependency_split_mismatch')
        for owner, dependency in edges:
            if dependency == identity:
                if member['split'] != members[owner]['split']:
                    item_blockers.append('dependency_split_mismatch')
                if _phase(member['stage']) > _phase(members[owner]['stage']):
                    item_blockers.append('dependency_requires_later_stage')
        item_blockers = sorted(set(item_blockers))
        blockers.extend(item_blockers)
        if member['assetKind'] == 'agent_task':
            plan = materialize_task(value, project, quality)
        else:
            plan = {'fixture': {'harness': {'setup': deepcopy(value['setup']),
                                            'exercise': deepcopy(value['exercise']),
                                            'executionStatus': 'NOT_RUN', 'actualProductRun': False}},
                    'grading': {'oracle': deepcopy(value['oracle']), 'controlRefs': deepcopy(value['controlRefs'])}}
        plans.append({'assetId': identity, 'kind': member['assetKind'],
                      'dependencyOnly': identity not in selected, 'checkIds': deepcopy(member['checkIds']),
                      'guardCheckIds': deepcopy(member['guardCheckIds']), **plan,
                      'executionEligibility': 'blocked', 'blockers': item_blockers})
    return {'benchmarkId': benchmark_id, 'status': 'blocked', 'blockers': sorted(set(blockers)),
            'selectedIds': sorted(selected), 'dependencyIds': sorted(closure - selected),
            'filters': {'stage': stage, 'split': split, 'subset': subset,
                        'capability': capability, 'taskType': task_type},
            'readiness': readiness, 'plans': plans, 'actualProductRuns': 0, 'productScoreEligible': False,
            'formalAcceptanceEligible': False}


def main(argv=None):
    import argparse
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('benchmark')
    parser.add_argument('--project', type=Path, default=Path(__file__).resolve().parents[3])
    parser.add_argument('--stage')
    parser.add_argument('--split')
    parser.add_argument('--subset', default='capability')
    parser.add_argument('--capability')
    parser.add_argument('--task-type')
    parser.add_argument('--output', type=Path, help='Write model input objects only as JSONL')
    args = parser.parse_args(argv)
    result = assemble_benchmark(args.benchmark, args.project, args.stage, args.split,
                                args.subset, args.capability, args.task_type)
    if args.output is not None:
        # Export is deliberately one-way: no harness, oracle or expected result.
        destination = args.output.resolve()
        project = args.project.resolve()
        if destination.suffix.lower() != '.jsonl' or destination.exists():
            raise ValueError('export requires a new .jsonl destination')
        if destination.is_relative_to(project) and not destination.is_relative_to(project / '.cache' / 'exports'):
            raise ValueError('exports within the project must be under .cache/exports/')
        inputs = [plan['fixture']['input'] for plan in result['plans'] if plan['kind'] == 'agent_task']
        destination.parent.mkdir(parents=True, exist_ok=True)
        with destination.open('x', encoding='utf-8') as output:
            output.write(''.join(json.dumps(value, ensure_ascii=False, allow_nan=False) + '\n' for value in inputs))
        result = {key: value for key, value in result.items() if key != 'plans'}
        result['exportedInputs'] = len(inputs)
        result['output'] = str(args.output.resolve())
    print(json.dumps(result, ensure_ascii=False, indent=2, allow_nan=False))
    return result


if __name__ == '__main__':
    main()
