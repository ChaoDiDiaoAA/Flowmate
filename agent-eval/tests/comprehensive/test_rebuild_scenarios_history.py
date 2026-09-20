"""Tests of draft integrity and non-vacuous predicates, not product execution."""
from collections import Counter
from copy import deepcopy
import hashlib
import json
from pathlib import Path
import sys
import unittest

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / 'agent-eval/tools'))
sys.path.insert(0, str(ROOT / 'agent-eval/src'))
from rebuild_cases import compile_scenarios, assert_product_projection
from rebuild_contracts import load_spec_contracts
from rebuild_scenarios_history import build_scenarios, MODEL_METRICS
from graders.observations import _check_trigger, _compare, _path


class HistoryCatalogTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.scenarios = build_scenarios()
        cls.contracts = load_spec_contracts(ROOT)
        cls.cases = compile_scenarios(cls.scenarios, cls.contracts)

    def test_frozen_budgets_and_subcapabilities(self):
        self.assertEqual({'sessions': 24, 'context': 16, 'memory': 16, 'compaction': 12},
                         dict(Counter(s['module'] for s in self.scenarios)))
        self.assertEqual({'lifecycle-binding': 6, 'input-delivery-processing': 8,
                          'branch-scope': 4, 'session-recovery': 6,
                          'current-selection': 6, 'request-snapshot': 6, 'current-fact-use': 4,
                          'history-integrity': 6, 'history-correction-use': 6, 'persistence-failure': 4,
                          'native-trigger': 4, 'post-compaction-task': 4, 'compaction-failure-recovery': 4},
                         dict(Counter(s['subcapability'] for s in self.scenarios)))
        self.assertEqual(68, len({c['semanticScenarioKey'] for c in self.cases}))
        # Ignore task titles and IDs: command/fact substance remains distinct.
        substance = [json.dumps([s['initialState']['facts'],
                                 [(x['command'], x['arguments']) for x in s['steps'][1:]], s['faults']],
                                sort_keys=True) for s in self.scenarios]
        self.assertEqual(68, len(set(substance)))

    def test_exact_direct_sources_and_independent_hash_pinned_controls(self):
        by_key = {s['key']: s for s in self.scenarios}
        by_id = {c['id']: c for c in self.cases}
        for scenario, case in zip(self.scenarios, self.cases):
            for check in scenario['checks']:
                self.assertEqual(['product', 'evaluation'], [r['spec'] for r in check['sourceRefs']])
                self.assertEqual('`' + check['metricId'] + '`', check['sourceRefs'][1]['quote'])
            for key in scenario['controlKeys']:
                control = by_key[key]
                self.assertTrue(control['initialState']['legalControl'])
                self.assertFalse(control['controlKeys'])
                self.assertFalse(control['faults'])
                self.assertLessEqual(int(control['stage'][1:]), int(scenario['stage'][1:]))
            for reference in case['normalControlRefs']:
                data = json.dumps(by_id[reference['caseId']], ensure_ascii=False, sort_keys=True,
                                  separators=(',', ':'), allow_nan=False).encode()
                self.assertEqual(hashlib.sha256(data).hexdigest(), reference['caseSha256'])

    def test_source_drift_and_invalid_control_cannot_compile(self):
        invalid = deepcopy(self.scenarios)
        invalid[0]['checks'][0]['sourceRefs'][0]['quote'] = 'NOT A REAL PRODUCT CONTRACT'
        with self.assertRaisesRegex(ValueError, 'Source quote missing'):
            compile_scenarios(invalid, self.contracts)
        invalid = deepcopy(self.scenarios)
        invalid[0]['controlKeys'] = [invalid[1]['key']]
        with self.assertRaisesRegex(ValueError, 'Normal control must execute independently'):
            compile_scenarios(invalid, self.contracts)

    def test_ordered_adapter_commands_and_model_boundary(self):
        for scenario in self.scenarios:
            self.assertEqual('declarative_not_execution_evidence', scenario['initialState']['fixtureKind'])
            self.assertIn('actual product', scenario['initialState']['adapterRequirement'])
            assert_product_projection(scenario['input'])
            self.assertEqual({'request'}, set(scenario['input']))
            self.assertNotIn('observation.', json.dumps(scenario['input']))
            for index, command in enumerate(scenario['steps']):
                self.assertTrue(command['command'].startswith('adapter.'))
                self.assertTrue(command['actor'].startswith('trusted_'))
                if index:
                    self.assertEqual([scenario['steps'][index - 1]['id']], command['after'])
            self.assertEqual(len(scenario['checks']), len({x['path'] for x in scenario['checks']}))
            for check in scenario['checks']:
                self.assertEqual(check['metricId'] in MODEL_METRICS, check['mode'] == 'A')
                if check['mode'] == 'A':
                    self.assertIn('real_model_output', check['evidence'])
                else:
                    self.assertIn('actual_sdk_observation', check['evidence'])

    def test_missing_observation_and_unreached_probe_never_pass(self):
        for case in self.cases:
            self.assertEqual('not_run', case['executionStatus'])
            self.assertFalse(case['formalAcceptanceEligible'])
            for check in case['oracle']['checks']:
                assertion = check['assertion']
                self.assertIsNone(_compare(_path({}, assertion['path']), assertion['op'], assertion['value']))
                kinds = {e for condition in check['preconditions'] for e in condition['evidence']}
                self.assertIsNone(_check_trigger(check, {}, kinds)['triggered'])
                payload = {condition['path'].split('.')[1]: condition['value']
                           for condition in check['preconditions']}
                self.assertTrue(_check_trigger(check, payload, kinds)['triggered'])
                payload['stimulus-reached'] = False
                self.assertFalse(_check_trigger(check, payload, kinds)['triggered'])

    def test_critical_contracts_have_distinct_predicates(self):
        by_key = {s['key']: s for s in self.scenarios}
        def expected(key):
            return {c['key']: c['value'] for c in by_key[key]['checks']}
        self.assertEqual(3, expected('input-many-one-result')['shared-result-input-count'])
        self.assertFalse(expected('input-remaining-queue')['queued-processing-complete'])

    def test_current_prompt_does_not_supply_the_history_answers_being_tested(self):
        by_key = {s['key']: s for s in self.scenarios}
        for key in ('memory-correct-total', 'memory-correct-source', 'memory-correction-after-restart',
                    'compaction-retain-correction', 'compaction-retain-source'):
            request = by_key[key]['input']['request']
            self.assertNotRegex(request, r'120|128|USD|CNY|page\s*[234]')
            self.assertRegex(request, r'[\u4e00-\u9fff]')
        for scenario in self.scenarios:
            self.assertRegex(scenario['userInput'], r'[\u4e00-\u9fff]')

    def test_observed_request_and_restored_summary_have_real_declared_triggers(self):
        by_key = {s['key']: s for s in self.scenarios}
        commands = [s['command'] for s in by_key['context-evidence-step']['steps']]
        self.assertIn('adapter.deliver_and_capture_request', commands)
        commands = [s['command'] for s in by_key['compaction-save-failure']['steps']]
        self.assertIn('adapter.restart_from_sqlite', commands)
        self.assertLess(commands.index('adapter.clear_injected_storage_fault'), commands.index('adapter.restart_from_sqlite'))

    def test_additional_history_and_compaction_contract_boundaries(self):
        by_key = {s['key']: s for s in self.scenarios}
        def expected(key):
            return {c['key']: c['value'] for c in by_key[key]['checks']}
        self.assertFalse(expected('input-admission-race')['new-input-in-old-queue'])
        self.assertEqual('A', expected('snapshot-pointer-race')['old-tool-snapshot'])
        self.assertEqual('B', expected('snapshot-pointer-race')['current-pointer'])
        self.assertFalse(expected('snapshot-forged-model-id')['model-text-used-as-link'])
        self.assertEqual(1, expected('branch-position-only')['storage-version-increment'])
        self.assertFalse(expected('memory-storage-outage-poison')['claimed-db-fault-persisted'])
        self.assertTrue(expected('history-root-sentinel')['root-sentinel-accepted'])
        self.assertTrue(expected('history-root-sentinel')['ordinary-string-not-reference'])
        self.assertTrue(expected('history-pagination-restore')['restore-loaded-complete-set'])
        self.assertEqual(128, expected('memory-correct-total')['current-total'])
        self.assertEqual(120, expected('memory-correct-total')['original-total'])
        for scenario in self.scenarios:
            commands = [s['command'] for s in scenario['steps']]
            if any('compaction' in command for command in commands):
                self.assertEqual('P7', scenario['stage'])
            for check in scenario['checks']:
                if check['metricId'] == 'MOD-03.retention':
                    self.assertIn('observation.native-compaction-before-response',
                                  [p['path'] for p in check['preconditions']])

    def test_reviewed_trigger_capacity_and_evidence_layer_conditions(self):
        by_key = {s['key']: s for s in self.scenarios}
        capacity = by_key['context-capacity-key-constraint']
        self.assertEqual('required_fits_full_exceeds', capacity['initialState']['facts']['capacityConstruction']['rule'])
        self.assertNotIn('or-blocked', str([c['key'] for c in capacity['checks']]))
        dangling = by_key['history-dangling-reference']
        self.assertIn('adapter.capture_uncommitted_sdk_delta', [s['command'] for s in dangling['steps']])
        submit = next(s for s in dangling['steps'] if s['command'] == 'adapter.submit_declarative_invalid_delta')
        self.assertTrue(submit['arguments']['prependCapturedValidDelta'])
        isolation = by_key['memory-two-session-isolation']
        modes = {c['key']: c['mode'] for c in isolation['checks']}
        self.assertEqual('F', modes['first-history-in-second-request'])
        self.assertEqual('A', modes['secret-code-recalled'])
        attack = by_key['context-use-untrusted-instruction']
        a_check = next(c for c in attack['checks'] if c['mode'] == 'A')
        self.assertIn('observation.attack-source-request-link-verified', [p['path'] for p in a_check['preconditions']])
        self.assertTrue(all('attack-source-request-link-verified' not in str(c['preconditions'])
                            for c in attack['checks'] if c['mode'] == 'F'))


if __name__ == '__main__':
    unittest.main()
