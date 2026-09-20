"""Check-level mapping for fresh material; no product observations are created."""
from copy import deepcopy
from pathlib import Path
import sys
import unittest

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / 'agent-eval/tools'))


def case(module='workflow', stage='P8', checks=None):
    return {'schemaVersion': 3, 'id': 'fresh-test', 'harnessModule': module,
            'stage': stage, 'oracle': {'checks': checks or []},
            'provenance': {'legacyCasesRead': False}}


def check(identity, metric, mode='F', path='observation.value', native=False):
    return {'checkId': identity, 'metricId': metric, 'evaluationMode': mode,
            'assertion': {'path': path, 'op': 'eq', 'value': 1},
            'sourceRefs': [{'path': 'product.md', 'section': '1', 'quote': 'direct requirement'}],
            'implementationSources': [{'layer': 'pi_native' if native else 'flowmate_product',
                                        'implementationStatus': 'requires_real_adapter_verification'}],
            'evidenceRequirements': [{'kind': 'trusted-observation', 'required': True}]}


class FreshBenchmarkMappingTests(unittest.TestCase):
    def test_selects_direct_checks_not_all_case_requirements(self):
        from rebuild_benchmark_mapping import classify_fresh_case
        value = case(checks=[check('match', 'MOD-15.match'), check('approve', 'MOD-19.authorization')])
        result = {a['benchmarkId']: a for a in classify_fresh_case(value)}
        self.assertEqual(result['BM-02']['checkIds'], ['match'])
        self.assertEqual(result['BM-04']['checkIds'], ['approve'])
        self.assertEqual(result['BM-08']['checkIds'], ['approve'])
        self.assertEqual(result['BM-02']['membershipReview'], 'pending')

    def test_extraction_whole_invoice_only_and_unimplemented_gold_grader_visible(self):
        from rebuild_benchmark_mapping import classify_fresh_case
        value = case('agent-runtime', 'P2', [check('fields', 'MOD-11.fields', 'A')])
        value['scenarioProtocol'] = {'kind': 'fresh_invoice_extraction', 'version': 1}
        value['oracle']['checks'][0].pop('assertion')
        value['oracle']['checks'][0]['ruleStatus'] = 'unimplemented'
        value['oracle']['fieldGoldRef'] = 'gold/gold-fresh-test.json'
        result = classify_fresh_case(value)
        self.assertEqual([r['benchmarkId'] for r in result], ['BM-01'])
        self.assertEqual(result[0]['checkIds'], ['fields'])
        value.pop('scenarioProtocol')
        with self.assertRaises(ValueError):
            classify_fresh_case(value)

    def test_runtime_requires_native_or_integration_evidence_layer_and_p1(self):
        from rebuild_benchmark_mapping import classify_fresh_case
        value = case('agent-runtime', 'P1', [check('loop', 'MOD-02.loop', native=True)])
        self.assertIn('BM-11', [x['benchmarkId'] for x in classify_fresh_case(value)])
        value['stage'] = 'P0'
        self.assertNotIn('BM-11', [x['benchmarkId'] for x in classify_fresh_case(value)])
        value['stage'] = 'P1'
        value['oracle']['checks'][0]['implementationSources'] = [{'layer': 'flowmate_product'}]
        self.assertNotIn('BM-11', [x['benchmarkId'] for x in classify_fresh_case(value)])

    def test_facilities_never_count_as_product_benchmark(self):
        from rebuild_benchmark_mapping import classify_fresh_case
        self.assertEqual(classify_fresh_case(case('eval-infrastructure', checks=[check('grade', 'MOD-32.scorer')])), [])
        with self.assertRaises(ValueError):
            classify_fresh_case(case('tools', checks=[check('grade', 'MOD-32.scorer')]))

    def test_unknown_missing_duplicate_and_retired_requirements_refused(self):
        from rebuild_benchmark_mapping import classify_fresh_case
        for metric in ['MOD-99.new', 'MOD-22.erp', 'MOD-14.verify']:
            with self.subTest(metric=metric), self.assertRaises(ValueError):
                classify_fresh_case(case(checks=[check('x', metric)]))
        for change in ('duplicate', 'source', 'evidence'):
            value = case(checks=[check('x', 'MOD-15.match')])
            if change == 'duplicate': value['oracle']['checks'] *= 2
            else: value['oracle']['checks'][0]['sourceRefs' if change == 'source' else 'evidenceRequirements'] = []
            with self.subTest(change=change), self.assertRaises(ValueError):
                classify_fresh_case(value)

    def test_no_fallback_benchmark_and_input_is_immutable(self):
        from rebuild_benchmark_mapping import classify_fresh_case
        value = case('context', 'P5', [check('current', 'MOD-03.context')])
        before = deepcopy(value)
        ids = {x['benchmarkId'] for x in classify_fresh_case(value)}
        self.assertNotIn('BM-07', ids)
        self.assertNotIn('BM-11', ids)
        self.assertNotIn('BM-06', ids)
        self.assertNotIn('BM-10', ids)
        self.assertEqual(value, before)

    def test_security_extra_uses_exact_boundary_predicate(self):
        from rebuild_benchmark_mapping import classify_fresh_case
        value = case('context', 'P5', [check('select', 'MOD-03.context', path='observation.selected-material-set'),
                    check('leak', 'MOD-03.context', path='observation.other-task-visible')])
        result = {a['benchmarkId']: a for a in classify_fresh_case(value)}
        self.assertEqual(result['BM-08']['checkIds'], ['leak'])

    def test_all_authored_episodes_map_without_default_or_facility_inflation(self):
        from rebuild_benchmark_mapping import classify_fresh_case
        from rebuild_cases import compile_scenarios
        from rebuild_contracts import load_spec_contracts
        from rebuild_fixtures import registered_scenarios
        rows = compile_scenarios(list(registered_scenarios().values()), load_spec_contracts(ROOT))
        self.assertEqual(len(rows), 448)
        products, facilities = 0, 0
        for value in rows:
            assigned = classify_fresh_case(value)
            if value['harnessModule'] == 'eval-infrastructure':
                self.assertFalse(assigned)
                facilities += 1
                continue
            products += 1
            self.assertTrue(assigned, value['id'])
            checks = {c['checkId'] for c in value['oracle']['checks']}
            for membership in assigned:
                self.assertTrue(set(membership['checkIds']).issubset(checks))
                self.assertNotIn(membership['benchmarkId'], {'BM-01', 'BM-06', 'BM-10'})
                self.assertEqual(membership['actualProductRuns'], 0)
        self.assertEqual((products, facilities), (420, 28))


if __name__ == '__main__':
    unittest.main()
