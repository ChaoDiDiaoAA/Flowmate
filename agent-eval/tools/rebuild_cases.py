"""Compile independently authored episodes into the shared Case contract.

No legacy Case catalog is read. Compilation validates source locations and
declared predicates; it does not approve semantics, collect evidence or run SDKs.
"""
from copy import deepcopy
import hashlib
import json
import re

from rebuild_contracts import resolve_source_ref
from rebuild_bindings import case_version, binding_revision
from rebuild_dataset import MODULE_BUDGETS


SCENARIO_KEYS = {'key', 'module', 'subcapability', 'stage', 'title', 'userInput', 'input',
                 'initialState', 'steps', 'faults', 'expectedOutcome', 'forbidden',
                 'controlKeys', 'relatedModules', 'sourceRefs', 'checks'}
CHECK_KEYS = {'key', 'description', 'metricId', 'mode', 'path', 'op', 'value', 'evidence',
              'sourceRefs', 'requirementRefs', 'hardConstraint', 'implementationSources',
              'preconditions'}
STEP_KEYS = {'id', 'actor', 'command', 'arguments', 'after'}


def _hash(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=False,
                                    separators=(',', ':'), allow_nan=False).encode()).hexdigest()


def _slug(value):
    if not isinstance(value, str) or not re.fullmatch(r'[a-z][a-z0-9-]*', value):
        raise ValueError(f'Invalid stable identity: {value}')
    return value


def _phase(value):
    if not isinstance(value, str) or not re.fullmatch(r'P(?:[0-9]|1[0-3])', value):
        raise ValueError(f'Invalid phase: {value}')
    return int(value[1:])


def _check_preconditions(definition):
    if 'preconditions' not in definition:
        return []
    conditions = definition['preconditions']
    if not isinstance(conditions, list) or not conditions:
        raise ValueError('Preconditions must be a nonempty list')
    for condition in conditions:
        if not isinstance(condition, dict) or set(condition) != {'path', 'op', 'value', 'description', 'evidence'}:
            raise ValueError('Unknown or missing precondition configuration')
        if not isinstance(condition['path'], str) or not re.fullmatch(
                r'observation\.[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*', condition['path']):
            raise ValueError('Precondition needs an actual observation path')
        if condition['op'] not in {'eq', 'gte', 'lte', 'contains'}:
            raise ValueError('Unknown precondition operator')
        if condition['op'] in {'gte', 'lte'} and type(condition['value']) not in (int, float):
            raise ValueError('Ordered precondition needs numeric oracle')
        if not isinstance(condition['description'], str) or not condition['description'].strip():
            raise ValueError('Precondition description is required')
        if not isinstance(condition['evidence'], list) or not condition['evidence'] or not all(
                isinstance(k, str) and k.strip() for k in condition['evidence']):
            raise ValueError('Precondition evidence is required')
    return deepcopy(conditions)


def assert_product_projection(value):
    if isinstance(value, dict):
        reserved = {'oracle', 'grading', 'gold', 'checks', 'expectedOutcome', 'humanVerified', 'sourceSpecHashes'}
        if reserved.intersection(value):
            raise ValueError('Product input contains quality-side fields')
        for child in value.values():
            assert_product_projection(child)
    elif isinstance(value, list):
        for child in value:
            assert_product_projection(child)


def _semantic_signature(scenario, business=None):
    substance = {key: scenario[key] for key in ('userInput', 'input', 'initialState', 'steps', 'faults')}
    if business is not None:
        substance = dict(substance, businessInput=business['input'], businessPolicy=business['policy'],
                         businessPatches=scenario['businessPatches'])
    identities = {}
    def gather(value):
        if isinstance(value, dict):
            for key, child in value.items():
                if (key == 'id' or key.endswith('Id')) and isinstance(child, str):
                    identities.setdefault(child, f'entity-{len(identities)}')
                gather(child)
        elif isinstance(value, list):
            for child in value:
                gather(child)
    gather(substance)
    def normalize(value):
        if isinstance(value, dict):
            return {key: normalize(child) for key, child in value.items()}
        if isinstance(value, list):
            return [normalize(child) for child in value]
        if isinstance(value, str):
            return identities.get(value, value)
        return value
    return _hash(normalize(substance))


def _validate_scenario(scenario):
    if set(scenario) - SCENARIO_KEYS - {'version', 'comparisons', 'businessId', 'businessPatches'}:
        raise ValueError('Unknown scenario configuration')
    if SCENARIO_KEYS - set(scenario):
        raise ValueError(f'Missing scenario configuration: {SCENARIO_KEYS - set(scenario)}')
    if type(scenario.get('version', 1)) is not int or scenario.get('version', 1) < 1:
        raise ValueError('Scenario revision must be a positive integer')
    _slug(scenario['key'])
    _slug(scenario['subcapability'])
    _phase(scenario['stage'])
    if scenario['module'] not in MODULE_BUDGETS or any(m not in MODULE_BUDGETS for m in scenario['relatedModules']):
        raise ValueError('Unknown Harness module')
    for field in ('title', 'userInput', 'expectedOutcome'):
        if not isinstance(scenario[field], str) or not scenario[field].strip():
            raise ValueError(f'Empty {field}')
    if not isinstance(scenario['input'], dict) or not isinstance(scenario['initialState'], dict):
        raise ValueError('Input and initialState must be objects')
    assert_product_projection(scenario['input'])
    if ('businessId' in scenario) != ('businessPatches' in scenario):
        raise ValueError('businessId and businessPatches must be declared together')
    if 'businessId' in scenario and not isinstance(scenario['businessId'], str):
        raise ValueError('businessId must be an authored string identity')
    if not scenario['steps'] or not scenario['sourceRefs'] or not scenario['forbidden']:
        raise ValueError('Episode commands, sources and prohibitions are required')
    step_ids = set()
    for step in scenario['steps']:
        if set(step) - STEP_KEYS or STEP_KEYS - {'after'} - set(step):
            raise ValueError('Unknown or missing step configuration')
        _slug(step['id'])
        if step['id'] in step_ids:
            raise ValueError('Duplicate command identity')
        if not isinstance(step['arguments'], dict) or not isinstance(step['command'], str) or not step['command']:
            raise ValueError('Invalid declared command')
        if not isinstance(step['actor'], str) or not step['actor']:
            raise ValueError('Missing trusted command actor')
        # `after` may be a declared external barrier, not necessarily another
        # command. The adapter must resolve it; compilation never executes it.
        step_ids.add(step['id'])
    if len(scenario['checks']) < 3:
        raise ValueError('A coherent episode needs its declared outcome, process and guard checks')


def compile_scenarios(scenarios, contracts):
    by_key, signatures, cases = {}, {}, []
    businesses = {}
    if any('businessId' in s for s in scenarios):
        from rebuild_business_projection import authored_business, asset_ref, project_business
        businesses = authored_business(contracts)
    for scenario in scenarios:
        _validate_scenario(scenario)
        key = scenario['key']
        if key in by_key:
            raise ValueError('Duplicate scenario identity')
        business = businesses.get(scenario.get('businessId'))
        if 'businessId' in scenario:
            if business is None:
                raise ValueError('Unknown freshly authored business identity')
            project_business(asset_ref(business), business, scenario['businessPatches'])
        signature = _semantic_signature(scenario, business)
        if signature in signatures:
            raise ValueError(f'semantic duplicate: {key} and {signatures[signature]}')
        signatures[signature] = key
        by_key[key] = scenario
    controls = {key for scenario in scenarios for key in scenario['controlKeys']}
    # Connected membership is only a control association, not a claim these
    # conditions are independent or that an unrun control has passed.
    parent = {key: key for key in by_key}
    def find(key):
        while parent[key] != key:
            key = parent[key]
        return key
    for scenario in scenarios:
        for key in scenario['controlKeys']:
            if key not in by_key or key == scenario['key']:
                raise ValueError('Missing or self-referential normal control')
            if by_key[key]['controlKeys']:
                raise ValueError('Normal control must execute independently')
            if _phase(by_key[key]['stage']) > _phase(scenario['stage']):
                raise ValueError('Normal control requires a later stage')
            if scenario.get('businessId') != by_key[key].get('businessId'):
                raise ValueError('Normal control must use the same business base')
            a, b = sorted((find(key), find(scenario['key'])))
            parent[b] = a
    for scenario in scenarios:
        comparisons = scenario.get('comparisons', [])
        if not isinstance(comparisons, list):
            raise ValueError('Invalid comparison configuration')
        peers = set()
        for comparison in comparisons:
            if (not isinstance(comparison, dict) or set(comparison) !=
                    {'scenarioKey', 'checkKeys', 'equalInputFields', 'purpose'}):
                raise ValueError('Unknown comparison configuration')
            key = comparison['scenarioKey']
            if key not in by_key or key == scenario['key'] or key in peers:
                raise ValueError('Missing, self or duplicate comparison dependency')
            peers.add(key)
            if _phase(by_key[key]['stage']) > _phase(scenario['stage']):
                raise ValueError('comparison requires a later stage')
            if (scenario.get('businessId') != by_key[key].get('businessId') or
                    scenario.get('businessPatches') != by_key[key].get('businessPatches')):
                raise ValueError('comparison business conditions differ')
            fields = comparison['equalInputFields']
            if (not isinstance(fields, list) or not fields or len(set(fields)) != len(fields) or
                    any(f not in scenario['input'] or f not in by_key[key]['input'] or
                        scenario['input'][f] != by_key[key]['input'][f] for f in fields)):
                raise ValueError('comparison task inputs differ')
            checks = comparison['checkKeys']
            if (not isinstance(checks, list) or not checks or len(set(checks)) != len(checks) or
                    not set(checks).issubset({c['key'] for c in scenario['checks']}) or
                    not isinstance(comparison['purpose'], str) or not comparison['purpose'].strip()):
                raise ValueError('comparison needs direct checks and purpose')
            a, b = sorted((find(key), find(scenario['key'])))
            parent[b] = a
        referenced = {s['arguments']['otherScenario'] for s in scenario['steps']
                      if 'otherScenario' in s['arguments']}
        if referenced != peers:
            raise ValueError('comparison command and declared dependencies differ')
    for scenario in scenarios:
        key = scenario['key']
        identity = 'fresh-' + key
        business = businesses.get(scenario.get('businessId'))
        checks, seen_checks, evidence = [], set(), set()
        source_refs = [resolve_source_ref(contracts, r) for r in scenario['sourceRefs']]
        for definition in scenario['checks']:
            if set(definition) - CHECK_KEYS:
                raise ValueError('Unknown check configuration')
            _slug(definition['key'])
            if definition['key'] in seen_checks:
                raise ValueError('Duplicate check identity')
            seen_checks.add(definition['key'])
            if definition['metricId'] not in contracts['metrics']:
                raise ValueError(f'Unknown metric {definition["metricId"]}')
            if definition['mode'] not in {'F', 'A', 'B'}:
                raise ValueError('Unknown evidence layer')
            if not re.fullmatch(r'observation\.[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*', definition['path']):
                raise ValueError('Invalid observation path')
            if definition['op'] not in {'eq', 'gte', 'lte', 'contains'}:
                raise ValueError('Unknown assertion operator')
            if not definition['evidence'] or not definition['sourceRefs']:
                raise ValueError('Every check needs direct source and evidence')
            if scenario['module'] != 'eval-infrastructure' and not any(
                    ref.get('spec') == 'product' for ref in definition['sourceRefs']):
                raise ValueError('Product check requires a direct product clause, not only a metric definition')
            if definition['op'] in {'gte', 'lte'} and type(definition['value']) not in (int, float):
                raise ValueError('Ordered comparison needs numeric oracle')
            check_sources = [resolve_source_ref(contracts, r) for r in definition['sourceRefs']]
            check_id = identity + ':' + definition['key']
            assertion = {k: deepcopy(definition[k]) for k in ('path', 'op', 'value', 'description')}
            preconditions = _check_preconditions(definition)
            evidence.update(definition['evidence'])
            for condition in preconditions:
                evidence.update(condition['evidence'])
            requirement_refs = [definition['metricId'], *definition.get('requirementRefs', [])]
            if any(not isinstance(ref, str) or not ref for ref in requirement_refs):
                raise ValueError('Requirement references must be non-empty strings')
            requirement_refs = list(dict.fromkeys(requirement_refs))
            checks.append({'checkId': check_id, 'dimension': 'mechanism' if definition['mode'] == 'F' else
                           'modelBehavior' if definition['mode'] == 'A' else 'businessResult',
                           'evaluationMode': definition['mode'], 'metricId': definition['metricId'],
                           'metricVersionRef': _hash(contracts['metrics'][definition['metricId']]['definition']),
                           'harnessModule': scenario['module'], 'required': True,
                           'hardConstraint': definition.get('hardConstraint', definition['mode'] == 'F'),
                           'assertion': assertion, 'ruleStatus': 'implemented',
                           'collectorStatus': 'product_adapter_required',
                           'evidenceRequirements': [{'kind': x, 'required': True} for x in definition['evidence']],
                           'sourceRefs': check_sources,
                            'requirementRefs': requirement_refs,
                           'coverageScope': 'specific_declared_condition_not_entire_metric',
                           'implementationSources': definition.get('implementationSources', []),
                           'implementationAttributionReview': 'pending'})
            if preconditions:
                checks[-1]['preconditions'] = preconditions
        modes = sorted({c['evaluationMode'] for c in checks})
        category = {'foundation': 'platform', 'eval-infrastructure': 'platform',
                    'workflow': 'matching', 'actions': 'submission'}.get(scenario['module'], 'runtime')
        case = {'schemaVersion': 3, 'id': identity, 'version': case_version(scenario.get('version', 1), contracts),
                'category': category, 'familyId': f'{scenario["module"]}/{scenario["subcapability"]}',
                'harnessModule': scenario['module'], 'relatedHarnessModules': scenario['relatedModules'],
                'subcapabilityRefs': [scenario['subcapability']], 'stage': scenario['stage'],
                'title': scenario['title'], 'trigger': scenario['userInput'],
                'caseSummary': {'input': scenario['userInput'], 'trigger': scenario['steps'], 'expected': scenario['expectedOutcome']},
                'scenarioProtocol': {'kind': 'fresh_declarative_episode', 'version': 1},
                'episode': {'input': deepcopy(scenario['input']), 'initialState': deepcopy(scenario['initialState']),
                            'commands': deepcopy(scenario['steps']), 'faults': deepcopy(scenario['faults'])},
                'initialEnvironment': {'kind': 'controlled_fixture', 'fixtureBaseRef': None,
                                       'resetBeforeEachTrial': True},
                'inputMode': 'controlled_episode', 'inputAssets': [],
                'sampleId': None, 'sampleRole': 'synthetic_only',
                'split': 'development', 'splitRationale': '公开制作的机制种子；不声称未见验收样本。',
                'leakageGroup': 'episode-' + find(key), 'semanticScenarioKey': _semantic_signature(scenario, business),
                'replicaIndex': 1, 'evaluationMode': 'A' if 'A' in modes else modes[0], 'evaluationModes': modes,
                'scenarioRole': 'control' if key in controls else 'condition',
                'normalControlRefs': [{'caseId': 'fresh-' + k, 'version': case_version(by_key[k].get('version', 1), contracts)} for k in scenario['controlKeys']],
                'controlPairKey': 'control-' + find(key),
                'oracle': {'version': case_version(scenario.get('version', 1), contracts), 'status': 'content_review_pending', 'checks': checks,
                           'assertions': [deepcopy(c['assertion']) for c in checks],
                           'requiredEvidence': sorted(evidence), 'forbidden': scenario['forbidden'],
                           'missingEvidenceVerdict': 'insufficient_evidence', 'fieldGoldRef': None},
                'scoring': {'method': 'structured_observation', 'graderContractVersion': 2,
                            'graderImplementation': 'agent-eval/src/graders/observations.py'},
                'sourceRefs': source_refs,
                'sourceSpecHashes': {d['path']: {'path': d['path'], 'sha256': d['sha256']}
                                     for d in contracts['documents'].values()},
                'provenance': {'method': 'fresh_contract_driven_episode', 'legacyCasesRead': False,
                               'authoredVersion': scenario.get('version', 1),
                               'sourceBindingRevision': binding_revision(contracts)},
                'materialStatus': 'structure_checked', 'reviewStatus': 'pending', 'humanVerified': False,
                'executionStatus': 'not_run', 'formalAcceptanceEligible': False,
                'executionEligibility': {'status': 'dependencies_missing',
                                         'missing': ['case_content_review', 'actual_product_adapter',
                                                      'trusted_evidence_collector', 'execution_profile']},
                'benchmarks': [], 'benchmarkMembershipStatus': 'direct_check_mapping_pending'}
        if business is not None:
            case['businessRef'] = asset_ref(business)
            case['businessPatches'] = deepcopy(scenario['businessPatches'])
            case['initialEnvironment']['fixtureBaseRef'] = deepcopy(case['businessRef'])
            case['inputMode'] = 'controlled_business_episode'
            case['sampleRole'] = 'synthetic_business_input'
            case['split'] = business['split']
            case['splitRationale'] = '继承所引用新业务包的候选用途；仍需结构与暴露审查。'
            case['leakageGroup'] = business['leakageGroup']
            case['controlPairKey'] = 'business-control-' + business['leakageGroup']
            case['executionEligibility']['missing'].extend(['business_content_review', 'business_split_freeze'])
        if scenario.get('comparisons'):
            case['comparisonRefs'] = [{'caseId': 'fresh-' + r['scenarioKey'],
                'version': case_version(by_key[r['scenarioKey']].get('version', 1), contracts),
                'checkIds': [identity + ':' + k for k in r['checkKeys']],
                'equalInputFields': r['equalInputFields'], 'purpose': r['purpose'],
                'protocol': 'paired_independent_trials', 'peerMustPass': False}
                for r in scenario['comparisons']]
            comparison_checks = {x for r in case['comparisonRefs'] for x in r['checkIds']}
            for check in case['oracle']['checks']:
                if check['checkId'] in comparison_checks:
                    check['ruleStatus'] = 'implemented'
                    check['graderRequirement'] = 'trusted_paired_independent_trial_receipts'
        cases.append(case)
    by_id = {case['id']: case for case in cases}
    done, visiting = set(), set()
    def pin(case):
        if case['id'] in done:
            return
        if case['id'] in visiting:
            raise ValueError('Cyclic comparison/control dependency')
        visiting.add(case['id'])
        for reference in case['normalControlRefs'] + case.get('comparisonRefs', []):
            peer = by_id[reference['caseId']]
            pin(peer)
            reference['caseSha256'] = _hash(peer)
        visiting.remove(case['id'])
        done.add(case['id'])
    for case in cases:
        pin(case)
    return cases
