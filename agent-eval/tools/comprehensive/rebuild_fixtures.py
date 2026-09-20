"""Registered fresh design episodes -> trusted offline execution plans.

This materializes *declarations*. It deliberately does not create native SDK
history, claim implementation of product commands, or produce observations.
"""
from copy import deepcopy
from pathlib import Path
import sys

# The evaluation scenario module keeps its published tools/ path because
# facility fixtures bind that path. Other comprehensive modules live here.
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from rebuild_cases import assert_product_projection


def registered_scenarios():
    from rebuild_scenarios_foundation import build_scenarios as foundation
    from rebuild_scenarios_history import build_scenarios as history
    from rebuild_scenarios_runtime import build_scenarios as runtime
    from rebuild_scenarios_subagents import build_scenarios as subagents
    from rebuild_scenarios_operations import build_scenarios as operations
    from rebuild_scenarios_eval import build_scenarios as evaluation
    from rebuild_scenarios_workflow import build_scenarios as workflow
    from rebuild_scenarios_actions import build_scenarios as actions
    scenarios = actions() + foundation() + history() + runtime() + subagents() + operations() + evaluation() + workflow()
    result = {}
    for scenario in scenarios:
        identity = 'fresh-' + scenario['key']
        if identity in result:
            raise ValueError('Duplicate registered episode')
        result[identity] = scenario
    return result


def materialize_episode(case, business=None):
    if case.get('scenarioProtocol') != {'kind': 'fresh_declarative_episode', 'version': 1}:
        raise ValueError('Unknown fresh episode protocol')
    scenario = registered_scenarios().get(case.get('id'))
    if scenario is None:
        raise ValueError('Unregistered fresh episode')
    from pathlib import Path
    from rebuild_contracts import load_spec_contracts
    from rebuild_bindings import case_version
    contracts = load_spec_contracts(Path(__file__).resolve().parents[3])
    if type(case.get('version')) is not int or case['version'] != case_version(scenario.get('version', 1), contracts):
        raise ValueError('Unregistered episode revision')
    expected = {'input': scenario['input'], 'initialState': scenario['initialState'],
                'commands': scenario['steps'], 'faults': scenario['faults']}
    if case.get('episode') != expected or case.get('trigger') != scenario['userInput']:
        raise ValueError('Episode conditions differ from the registered revision')
    if case.get('harnessModule') != scenario['module'] or case.get('stage') != scenario['stage']:
        raise ValueError('Episode module or phase differs')
    projected_business = None
    if 'businessId' in scenario:
        from rebuild_business_projection import project_business
        ref = case.get('businessRef')
        if (not isinstance(ref, dict) or ref.get('id') != scenario['businessId'] or
                case.get('businessPatches') != scenario['businessPatches'] or
                case.get('inputMode') != 'controlled_business_episode'):
            raise ValueError('Business scenario reference or conditions differ')
        projected_business = project_business(ref, business, scenario['businessPatches'])
        if case.get('split') != business['split'] or case.get('leakageGroup') != business['leakageGroup']:
            raise ValueError('Business data use or group differs')
    elif business is not None or any(k in case for k in ('businessRef', 'businessPatches')):
        raise ValueError('This registered episode does not declare a business package')
    if case.get('initialEnvironment') != {'kind': 'controlled_fixture', 'fixtureBaseRef': case.get('businessRef'),
                                        'resetBeforeEachTrial': True}:
        raise ValueError('Unregistered environment configuration')
    if case.get('inputAssets') != [] or any(k in case for k in ('inputOverrides', 'harnessOverrides', 'scenarioSetup')):
        raise ValueError('Unregistered input or harness override')
    assert_product_projection(scenario['input'])
    result = {
        'status': 'materialized',
        'input': {'request': scenario['userInput'], 'data': deepcopy(scenario['input'])},
        'harness': {'kind': 'declarative_product_adapter_plan',
                    'caseId': case['id'], 'caseVersion': case['version'],
                    'initialState': deepcopy(scenario['initialState']),
                    'commands': deepcopy(scenario['steps']), 'faults': deepcopy(scenario['faults']),
                    'networkPolicy': 'isolated_test_targets_only_except_configured_model_provider',
                    'materializationStatus': 'adapter_plan_only', 'executionStatus': 'NOT_RUN',
                    'adapterRequirements': ['Implement declared commands through product-owned interfaces',
                                            'Create isolated fixture state through a trusted test controller',
                                            'Collect actual command, transaction, request and side-effect evidence',
                                            'Generate native history through the pinned SDK, never handwritten success logs']},
        'fixtureValidation': {'adapterPlanOnly': True, 'actualProductRun': False,
                              'nativeHistoryFabricated': False, 'oracleRead': False},
        'limitations': ['Offline episode plan only. Real command adapters and trusted collectors are not implemented here.'],
    }
    if scenario['module'] == 'eval-infrastructure':
        if scenario['initialState'].get('resultScope') != 'grader_self_test':
            raise ValueError('Facility plans must declare their independent result scope')
        result['harness']['kind'] = 'declarative_facility_adapter_plan'
        result['harness']['resultScope'] = 'grader_self_test'
        result['inputAudience'] = 'trusted_eval_runner'
        result['limitations'].append('Facility task only; synthetic standards and raw self-test tables stay with the trusted evaluator. Product inputs require a separate explicit allowlist.')
    if projected_business is not None:
        result['input']['business'] = projected_business['input']
        result['input']['simulationPolicy'] = projected_business['policy']
        result['harness']['businessInitialState'] = projected_business['initialState']
        result['harness']['businessRef'] = projected_business['businessRef']
        result['harness']['appliedBusinessPatches'] = projected_business['appliedPatches']
        result['fixtureValidation']['businessBaseValidated'] = True
        result['limitations'].append('Declared input mismatches preserved; base content and split review remain required.')
    return result
