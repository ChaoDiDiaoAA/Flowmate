"""Contract tests for scenario assets; these do not execute the product."""
import copy
import importlib
import json
from pathlib import Path
import re
import sys
import unittest

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / 'agent-eval' / 'tools'))
import harness_scenarios as scenarios
from invoice_requirements import load_requirements


class HarnessScenariosTests(unittest.TestCase):
    def case(self, sid='session-complete-restore'):
        return {'id': 'TEST-' + sid, 'version': 1, 'harnessScenarioId': sid,
                'initialEnvironment': {'scenarioSetup': {
                    'conditions': {'harnessScenarioId': sid}}}}

    def test_ids_modules_and_assertions_are_explicit(self):
        seen = set()
        for item in scenarios.SCENARIOS:
            with self.subTest(item=item['id']):
                self.assertRegex(item['id'], r'^[a-z0-9]+(?:-[a-z0-9]+)*$')
                self.assertNotIn(item['id'], seen)
                seen.add(item['id'])
                self.assertIn(item['module'], scenarios.MODULES)
                self.assertIn(item['category'], scenarios.CATEGORIES)
                self.assertIn(item['mode'], ('F', 'A', 'B'))
                self.assertRegex(item['phase'], r'^P(?:[0-9]|1[0-3])$')
                self.assertTrue(item['commands'])
                self.assertTrue(item['expected'])
                self.assertTrue(item['input']['task'])
                self.assertTrue(item['requiredCapability'])
                self.assertFalse(item['enabledMode']['countsAsExecutedWhenDisabled'])
                for assertion in item['expected']:
                    self.assertTrue(assertion['path'].startswith('observation.'))
                    self.assertIn(assertion['op'], ('eq', 'gte'))
                    self.assertTrue(assertion['description'])

    def test_source_anchor_is_unique_and_in_correct_section(self):
        lines = (ROOT / 'agent-eval/docs/spec/01_Flowmate_Agent评测总方案.md').read_text(encoding='utf-8-sig').splitlines()
        section = ''
        indexed = []
        for line in lines:
            match = re.match(r'^#{1,6}\s+(\d+(?:\.\d+)*)\b', line)
            if match:
                section = match.group(1)
            indexed.append((section, line))
        for item in scenarios.SCENARIOS:
            with self.subTest(item=item['id']):
                hits = [(section, line) for section, line in indexed if item['sourceAnchor'] in line]
                self.assertEqual(len(hits), 1)
                self.assertEqual(hits[0][0], item['sourceSection'])

    def test_all_storage_atoms_have_direct_semantic_assertions(self):
        catalog = load_requirements(ROOT)['requirements']
        required = {item['id'] for item in catalog if item['kind'] == 'atomic'}
        actual = {key for scenario in scenarios.SCENARIOS for assertion in scenario['expected']
                  for key in assertion.get('requirementKeys', []) if key in required}
        self.assertEqual(actual, required)
        self.assertEqual(len(scenarios.ATOM_LINKS), len(required))
        # Cross-Job dedup must have independent-object positive controls and
        # target effects; request counts alone cannot establish business dedup.
        dedup = scenarios.SCENARIOS_BY_ID['dispatch-cross-job-concurrent']
        self.assertEqual(dedup['normalControlId'], 'dispatch-independent-objects')
        self.assertIn('observation.external.businessEffects', {a['path'] for a in dedup['expected']})

    def test_all_twelve_storage_boundaries_and_five_critical_groups(self):
        storage = {item['sourceAnchor'] for item in scenarios.SCENARIOS if item['sourceSection'] == '3.24'}
        self.assertEqual(len(storage), 12)
        critical = {item['sourceAnchor'] for item in scenarios.SCENARIOS if item['sourceSection'] == '3.24.1'}
        self.assertEqual(critical, set(scenarios.CRITICAL_GROUPS.values()))

    def test_rejection_controls_exist_and_are_independent(self):
        for item in scenarios.SCENARIOS:
            if item['variant'] == 'permission':
                with self.subTest(item=item['id']):
                    self.assertTrue(item['normalControlId'])
            if item['normalControlId']:
                control = scenarios.SCENARIOS_BY_ID[item['normalControlId']]
                self.assertTrue(set(control['enabledMode']['required']).issubset(item['enabledMode']['required']), item['id'])
                self.assertNotEqual(control['id'], item['id'])
                self.assertIsNot(control['initialState'], item['initialState'])
                self.assertNotEqual((control['initialState'], control['commands']),
                                    (item['initialState'], item['commands']))

    def test_model_input_has_no_oracle_or_native_fixture_projection(self):
        forbidden = {'expected','oracle','assertions','forbidden','normalControlId',
                     'requirementKeys','initialState','commands','faults','nativeSetup'}
        def visit(value):
            if isinstance(value, dict):
                self.assertFalse(forbidden.intersection(value))
                for child in value.values():
                    visit(child)
            elif isinstance(value, list):
                for child in value:
                    visit(child)
        for item in scenarios.SCENARIOS:
            result = scenarios.materialize_scenario(self.case(item['id']))
            visit(result['input'])
            self.assertNotIn('expected', result['harness'])
            self.assertNotIn('oracle', result['harness'])
            self.assertEqual(result['harness']['executionStatus'], 'NOT_RUN')
            self.assertFalse(result['fixtureValidation']['actualProductRun'])

    def test_native_plans_cannot_be_mistaken_for_generated_history(self):
        for item in scenarios.SCENARIOS:
            adapter = item['adapterRequirements']
            self.assertEqual(adapter['status'], 'pending_product_harness_adapter')
            self.assertFalse(adapter['syntheticNativeHistoryAllowed'])
            if adapter['nativeEvidenceRequired']:
                self.assertEqual(adapter['nativeFixtureSource'], 'real_locked_pi_0.85.1_adapter')
                self.assertFalse(item['initialState']['nativeSetup']['persistedEntriesProvided'])
                result = scenarios.materialize_scenario(self.case(item['id']))
                self.assertEqual(result['harness']['materializationStatus'], 'adapter_plan_only')
                self.assertNotIn('entries', result['harness'])
                self.assertNotIn('header', result['harness'])

    def test_materialization_does_not_mutate_catalog_or_other_trials(self):
        before = json.dumps(scenarios.SCENARIOS, sort_keys=True, ensure_ascii=False)
        first = scenarios.materialize_scenario(self.case())
        first['input']['task'] = 'changed'
        first['harness']['commands'].clear()
        first['harness']['adapterRequirements']['status'] = 'PASS'
        second = scenarios.materialize_scenario(self.case())
        self.assertTrue(second['harness']['commands'])
        self.assertNotEqual(second['input']['task'], 'changed')
        self.assertEqual(before, json.dumps(scenarios.SCENARIOS, sort_keys=True, ensure_ascii=False))

    def test_unknown_identity_and_all_override_channels_fail_closed(self):
        with self.assertRaisesRegex(ValueError, 'UNKNOWN_HARNESS_SCENARIO'):
            scenarios.materialize_scenario({'harnessScenarioId': 'missing'})
        for key in ('input','harness','initialState','commands','faults',
                    'inputOverrides','harnessOverrides','scenarioOverrides','overrides'):
            case = self.case()
            case[key] = {'unexpected': True}
            with self.subTest(key=key), self.assertRaisesRegex(ValueError, 'OVERRIDES_NOT_ALLOWED'):
                scenarios.materialize_scenario(case)
        case = self.case()
        case['initialEnvironment']['scenarioSetup']['conditions']['unexpected'] = True
        with self.assertRaisesRegex(ValueError, 'CONDITIONS_MISMATCH'):
            scenarios.materialize_scenario(case)
        case = self.case()
        case['initialEnvironment']['scenarioSetup']['conditions']['harnessScenarioId'] = 'memory-null-root'
        with self.assertRaisesRegex(ValueError, 'CONDITIONS_MISMATCH'):
            scenarios.materialize_scenario(case)

    def test_fresh_import_is_deterministic(self):
        before = json.dumps(scenarios.SCENARIOS, sort_keys=True, ensure_ascii=False)
        importlib.reload(scenarios)
        self.assertEqual(before, json.dumps(scenarios.SCENARIOS, sort_keys=True, ensure_ascii=False))

    def test_host_recovery_preserves_only_original_instance_identity(self):
        for item in scenarios.SCENARIOS:
            if item['id'].endswith('host-backup-integrity'):
                self.assertEqual(item['initialState']['conditions']['recoveryMode'], 'original_instance_host_replacement')
                operations = [c['operation'] for c in item['commands']]
                self.assertLess(operations.index('confirm_old_host_stopped_and_execution_fenced'),
                                operations.index('restore_original_instance_on_replacement_host'))


if __name__ == '__main__':
    unittest.main()
