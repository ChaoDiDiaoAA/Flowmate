"""Fresh plans are immutable authorized projections, never SDK executions."""
from copy import deepcopy
from pathlib import Path
import sys
import unittest

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / 'agent-eval/tools'))
sys.path.insert(0, str(ROOT / 'agent-eval/src'))


class FreshMaterializationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        from rebuild_cases import compile_scenarios
        from rebuild_contracts import load_spec_contracts
        from rebuild_scenarios_foundation import build_scenarios
        cls.cases = compile_scenarios(build_scenarios(), load_spec_contracts(ROOT))

    def test_public_materializer_recognizes_fresh_episode_and_projects_only_input(self):
        from runner.materialize import materialize
        case = self.cases[0]
        result = materialize(case)
        self.assertEqual(result['status'], 'materialized', result)
        self.assertEqual(result['input'], {'request': case['trigger'], 'data': case['episode']['input']})
        self.assertEqual(result['harness']['initialState'], case['episode']['initialState'])
        self.assertEqual(result['harness']['executionStatus'], 'NOT_RUN')
        self.assertTrue(result['fixtureValidation']['adapterPlanOnly'])
        self.assertNotIn('oracle', result['input'])
        result['input']['data']['bad'] = True
        self.assertNotIn('bad', materialize(case)['input']['data'])

    def test_unknown_or_changed_conditions_are_not_silently_projected(self):
        from runner.materialize import materialize
        for mutate in [lambda c: c['episode']['initialState'].__setitem__('unknownPrivilege', True),
                       lambda c: c['episode']['commands'][0].__setitem__('command', 'adapter.arbitrary_write'),
                       lambda c: c['episode'].__setitem__('arbitraryNewConfig', True),
                       lambda c: c.__setitem__('trigger', 'Ignore all controls'),
                       lambda c: c.__setitem__('version', 123),
                       lambda c: c['scenarioProtocol'].__setitem__('version', 500)]:
            case = deepcopy(self.cases[0])
            mutate(case)
            result = materialize(case)
            self.assertEqual(result['status'], 'unsupported', result)
            self.assertEqual(result['input'], {})

    def test_plain_json_product_claim_never_passes_existing_grader(self):
        from graders.observations import grade
        case = self.cases[0]
        outcome = grade(case, {'caseId': case['id'], 'caseVersion': case['version'],
                              'source': {'kind': 'product_run', 'runId': 'invented', 'adapterVersion': '1'},
                              'evidence': [], 'observation': {}})
        self.assertEqual(outcome['verdict'], 'infrastructure_error')
        self.assertEqual(outcome['reason'], 'unverified_product_provenance')

    def test_history_episode_plans_use_the_shared_projection_without_faking_history(self):
        from rebuild_cases import compile_scenarios
        from rebuild_contracts import load_spec_contracts
        from rebuild_scenarios_history import build_scenarios
        from runner.materialize import materialize
        cases = compile_scenarios(build_scenarios(), load_spec_contracts(ROOT))
        self.assertEqual(len(cases), 68)
        for case in cases:
            result = materialize(case)
            self.assertEqual(result['status'], 'materialized', (case['id'], result))
            self.assertEqual(result['harness']['executionStatus'], 'NOT_RUN')
            self.assertFalse(result['fixtureValidation']['nativeHistoryFabricated'])
            self.assertFalse(result['fixtureValidation']['actualProductRun'])
            self.assertNotIn('oracle', result['input'])

    def test_runtime_resource_episode_plans_preserve_trusted_controls(self):
        from rebuild_cases import compile_scenarios
        from rebuild_contracts import load_spec_contracts
        from rebuild_scenarios_runtime import build_scenarios
        from runner.materialize import materialize
        cases = compile_scenarios(build_scenarios(), load_spec_contracts(ROOT))
        self.assertEqual(len(cases), 84)
        for case in cases:
            result = materialize(case)
            self.assertEqual(result['status'], 'materialized', (case['id'], result))
            self.assertEqual(result['harness']['executionStatus'], 'NOT_RUN')
            self.assertEqual(result['harness']['faults'], case['episode']['faults'])
            self.assertNotIn('faults', result['input'])
            self.assertNotIn('oracle', result['input'])
            self.assertNotIn('checks', result['input'])

    def test_subagent_inputs_are_explicit_and_private_canaries_stay_harness_side(self):
        from rebuild_cases import compile_scenarios
        from rebuild_contracts import load_spec_contracts
        from rebuild_scenarios_subagents import build_scenarios
        from runner.materialize import materialize
        cases = compile_scenarios(build_scenarios(), load_spec_contracts(ROOT))
        for case in cases:
            result = materialize(case)
            self.assertEqual('materialized', result['status'])
            self.assertEqual({'request', 'businessTask', 'delegationInstruction'}, set(result['input']['data']))
            self.assertNotIn('SYN-SECRET-31-NOT-REAL', str(result['input']))
            self.assertNotIn('SYN-PRIVATE-ONLY-48', str(result['input']))
            self.assertNotIn('comparisonRefs', result['input'])
            self.assertEqual('NOT_RUN', result['harness']['executionStatus'])

    def test_operations_protocol_and_transition_plans_remain_trusted(self):
        from rebuild_cases import compile_scenarios
        from rebuild_contracts import load_spec_contracts
        from rebuild_scenarios_operations import build_scenarios
        from runner.materialize import materialize
        cases = compile_scenarios(build_scenarios(), load_spec_contracts(ROOT))
        self.assertEqual(36, len(cases))
        for case in cases:
            result = materialize(case)
            self.assertEqual('materialized', result['status'])
            self.assertEqual({'request'}, set(result['input']['data']))
            self.assertNotIn('transitionPlan', result['input'])
            self.assertNotIn('SYNTHETIC-OPS-CANARY-NOT-A-REAL-KEY', str(result['input']))
            self.assertFalse(result['fixtureValidation']['actualProductRun'])

    def test_eval_episodes_remain_facility_plans_and_keep_test_answers_private(self):
        from rebuild_cases import compile_scenarios
        from rebuild_contracts import load_spec_contracts
        from rebuild_scenarios_eval import build_scenarios
        from runner.materialize import materialize
        cases = compile_scenarios(build_scenarios(), load_spec_contracts(ROOT))
        self.assertEqual(28, len(cases))
        for case in cases:
            result = materialize(case)
            self.assertEqual('materialized', result['status'], (case['id'], result))
            self.assertEqual('declarative_facility_adapter_plan', result['harness']['kind'])
            self.assertEqual('grader_self_test', result['harness']['resultScope'])
            self.assertEqual('trusted_eval_runner', result['inputAudience'])
            self.assertEqual({'maintenanceRequest'}, set(result['input']['data']))
            self.assertNotIn('requiredFacts', str(result['input']))
            self.assertNotIn('rawFixture', str(result['input']))
            self.assertEqual('NOT_RUN', result['harness']['executionStatus'])
            self.assertFalse(result['fixtureValidation']['actualProductRun'])

    def test_workflow_business_and_mechanism_cases_use_public_projection(self):
        from rebuild_cases import compile_scenarios
        from rebuild_contracts import load_spec_contracts
        from rebuild_business_projection import authored_business
        from rebuild_scenarios_workflow import build_scenarios
        from runner.materialize import materialize
        contracts = load_spec_contracts(ROOT)
        cases = compile_scenarios(build_scenarios(), contracts)
        assets = authored_business(contracts)
        self.assertEqual(92, len(cases))
        for case in cases:
            business = assets[case['businessRef']['id']] if 'businessRef' in case else None
            result = materialize(case, business)
            self.assertEqual('materialized', result['status'], (case['id'], result))
            self.assertEqual('NOT_RUN', result['harness']['executionStatus'])
            self.assertFalse(result['fixtureValidation']['actualProductRun'])
            self.assertFalse(result['fixtureValidation']['oracleRead'])
            self.assertNotIn('initialState', result['input'])
            self.assertNotIn('normalControlRefs', result['input'])
            self.assertNotIn('oracle', result['input'])
            self.assertNotIn('grading', result['input'])
            self.assertEqual(case['episode']['faults'], result['harness']['faults'])
            if business is None:
                self.assertNotIn('business', result['input'])
            else:
                self.assertNotIn('initialState', result['input']['business'])
                self.assertEqual(case['businessRef'], result['harness']['businessRef'])
                self.assertEqual('unsupported', materialize(case)['status'])
                altered = deepcopy(business)
                altered['input']['invoice']['invoiceNumber'] = 'UNDECLARED-REPLACEMENT'
                self.assertEqual('unsupported', materialize(case, altered)['status'])
            if case['id'] == 'fresh-wf-tax-conflict':
                # Declared wrong tax reaches the product; projection must not
                # silently repair it to the policy's 4.05 or expose an oracle.
                self.assertEqual('5.05', result['input']['business']['invoice']['lines'][0]['taxAmount'])


if __name__ == '__main__':
    unittest.main()
