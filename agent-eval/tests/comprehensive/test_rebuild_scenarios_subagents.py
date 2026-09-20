"""Draft catalog and grader contract tests; synthetic observations are not runs."""
from collections import Counter
from copy import deepcopy
from pathlib import Path
import sys
import unittest

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / 'agent-eval/tools'))
sys.path.insert(0, str(ROOT / 'agent-eval/src'))
from rebuild_cases import SCENARIO_KEYS, CHECK_KEYS, compile_scenarios, assert_product_projection
from rebuild_contracts import load_spec_contracts
from rebuild_scenarios_subagents import build_scenarios
from graders.observations import _check_trigger, _compare, _path
from graders.observations import grade


class SubagentCatalogTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.scenarios = build_scenarios()
        cls.contracts = load_spec_contracts(ROOT)
        cls.cases = compile_scenarios(cls.scenarios, cls.contracts)
        cls.by_key = {s['key']: s for s in cls.scenarios}

    def test_exact_budget_and_schema(self):
        self.assertEqual(16, len(self.scenarios))
        self.assertEqual({'readonly-delegation': 4, 'unnecessary-and-single-main': 4,
                          'slot-identity-recovery': 4, 'shared-budget-cancel-isolation': 4},
                         dict(Counter(s['subcapability'] for s in self.scenarios)))
        self.assertEqual(16, len({c['semanticScenarioKey'] for c in self.cases}))
        for s in self.scenarios:
            self.assertEqual(SCENARIO_KEYS, set(s) - {'comparisons', 'version'})
            self.assertGreaterEqual(len(s['checks']), 3)
            self.assertEqual('subagents', s['module'])
            for c in s['checks']:
                self.assertLessEqual(set(c), CHECK_KEYS)
                self.assertEqual(['product', 'evaluation'], [r['spec'] for r in c['sourceRefs']])

    def test_projection_and_real_execution_boundary(self):
        for s in self.scenarios:
            assert_product_projection(s['input'])
            self.assertEqual({'request', 'businessTask', 'delegationInstruction'}, set(s['input']))
            self.assertEqual(s['userInput'], s['input']['request'])
            self.assertEqual('declarative_not_execution_evidence', s['initialState']['fixtureKind'])
            self.assertIn('actual SDK', s['initialState']['nativeHistory'])
            self.assertIn('LLM', s['initialState']['delegationEntry'])
            self.assertTrue(s['initialState']['layerLimits'])
            for index, step in enumerate(s['steps']):
                self.assertNotIn('spawn', step['command'])
                if index:
                    self.assertEqual([s['steps'][index - 1]['id']], step['after'])
            for c in s['checks']:
                gates = {p['path'] for p in c['preconditions']}
                self.assertIn('observation.fixture-established', gates)
                self.assertIn('observation.stimulus-reached', gates)
                if c['mode'] == 'A':
                    self.assertIn('actual_provider_request', c['evidence'])
                    self.assertIn('real_model_output', c['evidence'])
                    self.assertIn('observation.real-model-response-collected', gates)

    def test_controls_are_independent_and_earlier(self):
        for s in self.scenarios:
            for key in s['controlKeys']:
                control = self.by_key[key]
                self.assertFalse(control['controlKeys'])
                self.assertFalse(control['faults'])
                self.assertTrue(control['initialState']['legalControl'])
                self.assertLessEqual(int(control['stage'][1:]), int(s['stage'][1:]))
        for pair in [('sub-read-evidence', 'sub-single-evidence'),
                     ('sub-read-conflict', 'sub-single-conflict')]:
            a, b = (self.by_key[k] for k in pair)
            self.assertEqual(a['input']['businessTask'], b['input']['businessTask'])
            self.assertEqual(a['initialState']['facts']['businessTask'], b['initialState']['facts']['businessTask'])

    def test_identity_budget_and_attack_have_direct_checks(self):
        expected = {
            'sub-slot-replay': {'same-slot-one-run', 'origin-retained'},
            'sub-slots-independent': {'different-slots-two-runs', 'distinct-session-bindings'},
            'sub-slot-out-of-order': {'slot-mapping-exact', 'failed-slot-retained'},
            'sub-pending-recovery': {'no-reissued-delegation', 'pending-identity-preserved'},
            'sub-budget-shared': {'atomic-reservation', 'settled-unused-returned', 'no-summary-double-charge'},
            'sub-cancel-usage': {'unknown-retained', 'late-settlement-once', 'zero-release-evidenced'},
            'sub-cancel-orphan': {'cleanup-failed-retained', 'slot-not-early-released'},
            'sub-isolation': {'forbidden-access-rejected', 'allowed-read-completed'},
        }
        for key, checks in expected.items():
            self.assertLessEqual(checks, {c['key'] for c in self.by_key[key]['checks']})
        gates = {p['path'] for c in self.by_key['sub-read-injection']['checks']
                 if c['mode'] == 'A' for p in c['preconditions']}
        self.assertIn('observation.attack-delivered-to-parent', gates)

    def test_unrun_missing_and_mutated_observations_never_pass(self):
        for case in self.cases:
            self.assertEqual('not_run', case['executionStatus'])
            self.assertFalse(case['formalAcceptanceEligible'])
            for c in case['oracle']['checks']:
                a = c['assertion']
                self.assertIsNone(_compare(_path({}, a['path']), a['op'], a['value']))
                evidence = {e for p in c['preconditions'] for e in p['evidence']}
                self.assertIsNone(_check_trigger(c, {}, evidence)['triggered'])
                payload = {p['path'].split('.')[1]: p['value'] for p in c['preconditions']}
                self.assertTrue(_check_trigger(c, payload, evidence)['triggered'])
                self.assertTrue(_compare(a['value'], a['op'], a['value']))
                bad = not a['value'] if isinstance(a['value'], bool) else a['value'] + 1
                self.assertFalse(_compare(bad, a['op'], a['value']))
                payload['stimulus-reached'] = False
                self.assertFalse(_check_trigger(c, payload, evidence)['triggered'])

    def test_source_drift_fails(self):
        mutated = deepcopy(self.scenarios)
        mutated[0]['checks'][0]['sourceRefs'][0]['quote'] = 'INVENTED SUBAGENT RULE'
        with self.assertRaisesRegex(ValueError, 'Source quote missing'):
            compile_scenarios(mutated, self.contracts)

    def test_attack_and_required_delegation_not_vacuous(self):
        attack = self.by_key['sub-read-injection']
        for c in attack['checks']:
            gates = {p['path'] for p in c['preconditions']}
            if c['mode'] == 'A':
                self.assertIn('observation.attack-source-request-provenance-verified', gates)
            else:
                self.assertNotIn('observation.attack-delivered-to-parent', gates)
        required = next(c for c in self.by_key['sub-read-evidence']['checks']
                        if c['key'] == 'required-helper-chosen')
        self.assertNotIn('observation.real-agent-call-observed',
                         {p['path'] for p in required['preconditions']})
        for key in ('sub-single-evidence', 'sub-single-conflict'):
            for c in self.by_key[key]['checks']:
                self.assertNotIn('plugin_child_result', c['evidence'])

    def test_missing_required_helper_is_failure_without_child_output(self):
        case = next(c for c in self.cases if c['id'] == 'fresh-sub-read-evidence')
        check = next(c for c in case['oracle']['checks'] if c['checkId'].endswith(':required-helper-chosen'))
        self.assertNotIn('plugin_child_result', [e['kind'] for e in check['evidenceRequirements']])
        kinds = {e['kind'] for e in check['evidenceRequirements']}
        kinds.update(e for p in check['preconditions'] for e in p['evidence'])
        payload = {p['path'].split('.')[1]: p['value'] for p in check['preconditions']}
        payload['required-helper-chosen'] = False
        result = grade(case, {'caseId': case['id'], 'caseVersion': case['version'],
            'source': {'kind': 'grader_self_test', 'runId': 'decision-only', 'adapterVersion': 'self-test'},
            'evidence': [{'kind': k, 'artifact': k + '.json', 'sha256': 'a' * 64} for k in kinds],
            'observation': payload})
        self.assertEqual('FAIL', next(c for c in result['checks'] if c['checkId'] == check['checkId'])['status'])
        self.assertEqual('fail', result['verdict'])
        self.assertIn('只读助手', case['episode']['input']['delegationInstruction'])
        self.assertNotIn('protectedAsset', case['episode']['input'])

    def test_revision_acceptance_is_mechanism(self):
        check = next(c for c in self.by_key['sub-read-stale-revision']['checks'] if c['key'] == 'result-revision-checked')
        self.assertEqual('F', check['mode'])
        self.assertNotIn('real_model_output', check['evidence'])

    def test_input_does_not_disclose_fault_or_force_optional_decision(self):
        case = self.by_key['sub-slot-out-of-order']
        self.assertNotIn('fails', str(case['input']))
        self.assertIsInstance(case['input']['businessTask']['annex'], dict)
        self.assertEqual('annex', case['initialState']['facts']['failedSlot'])
        result_check = next(c for c in case['checks'] if c['key'] == 'partial-answer-honest')
        self.assertIn('missing independent annex child verification result', result_check['description'])
        self.assertIn('supplied annex content', result_check['description'])
        for key in ('sub-unneeded-date', 'sub-unneeded-currency'):
            text = self.by_key[key]['input']['delegationInstruction']
            self.assertIn('自主选择', text)
            self.assertNotIn('不委派', text)

    def test_comparison_refs_are_pinned_without_becoming_controls(self):
        by_id = {c['id']: c for c in self.cases}
        case = by_id['fresh-sub-read-evidence']
        self.assertFalse(case['normalControlRefs'])
        ref = case['comparisonRefs'][0]
        peer = by_id[ref['caseId']]
        from rebuild_cases import _hash
        self.assertEqual(_hash(peer), ref['caseSha256'])
        self.assertEqual(peer['leakageGroup'], case['leakageGroup'])
        self.assertEqual(['fresh-sub-read-evidence:paired-measurements-valid'], ref['checkIds'])
        # A reported boolean remains insufficient; the quality-side grader validates
        # separately reset, independently identified Trial receipts.
        ck = next(c for c in case['oracle']['checks'] if c['checkId'] in ref['checkIds'])
        self.assertEqual('implemented', ck['ruleStatus'])
        self.assertEqual('trusted_paired_independent_trial_receipts', ck['graderRequirement'])
        self.assertNotIn('trusted_paired_trial_receipt_validation', case['executionEligibility']['missing'])
        bad = deepcopy(self.scenarios)
        bad[0]['steps'][-1]['arguments']['otherScenario'] = 'does-not-exist'
        with self.assertRaisesRegex(ValueError, 'comparison'):
            compile_scenarios(bad, self.contracts)

    def test_paired_trial_grader_requires_independent_complete_receipts(self):
        by_id = {c['id']: c for c in self.cases}
        case = by_id['fresh-sub-read-evidence']
        ref = case['comparisonRefs'][0]
        peer = by_id[ref['caseId']]

        def measurement(prefix, child=False):
            usage = [{'requestId': prefix + '-main', 'role': 'main',
                      'inputTokens': 100, 'outputTokens': 20}]
            if child:
                usage.append({'requestId': prefix + '-child', 'role': 'child',
                              'inputTokens': 40, 'outputTokens': 10})
            return {'quality': {'verdict': 'PASS', 'score': 1.0},
                    'requestUsage': usage,
                    'totalCost': {'currency': 'USD', 'amount': '0.0010'},
                    'wallClockMs': 1250,
                    'executionProfileSha256': 'c' * 64,
                    'resetReceiptSha256': ('d' if child else 'e') * 64}

        payload = {'pairedMeasurement': measurement('helper', child=True)}
        for check in case['oracle']['checks']:
            assertion = check['assertion']
            payload[assertion['path'].split('.')[1]] = assertion['value']
            for condition in check.get('preconditions', []):
                payload[condition['path'].split('.')[1]] = condition['value']
        kinds = case['oracle']['requiredEvidence']
        observation = {'caseId': case['id'], 'caseVersion': case['version'],
            'source': {'kind': 'grader_self_test', 'runId': 'helper-run', 'adapterVersion': 'self-test'},
            'evidence': [{'kind': kind, 'artifact': kind + '.json', 'sha256': 'a' * 64}
                         for kind in kinds], 'observation': payload,
            'comparisonPeers': [{'caseId': peer['id'], 'caseVersion': peer['version'],
                'source': {'kind': 'grader_self_test', 'runId': 'single-run', 'adapterVersion': 'self-test'},
                'evidence': [{'kind': kind, 'artifact': 'peer-' + kind + '.json', 'sha256': 'b' * 64}
                             for kind in kinds],
                'observation': {'evaluatedCase': peer,
                                'pairedMeasurement': measurement('single')}}]}
        result = grade(case, observation)
        paired = next(x for x in result['checks'] if x['checkId'] in ref['checkIds'])
        self.assertEqual('PASS', paired['status'], result)
        self.assertEqual('grader_self_test', result['scope'])
        self.assertEqual(2, paired['metrics']['trialCount'])

        missing = deepcopy(observation)
        missing.pop('comparisonPeers')
        unresolved = grade(case, missing)
        self.assertEqual('UNJUDGEABLE', next(x for x in unresolved['checks']
            if x['checkId'] in ref['checkIds'])['status'])

        same_run = deepcopy(observation)
        same_run['comparisonPeers'][0]['source']['runId'] = 'helper-run'
        invalid = grade(case, same_run)
        self.assertEqual('INFRA_ERROR', next(x for x in invalid['checks']
            if x['checkId'] in ref['checkIds'])['status'])

        partial = deepcopy(observation)
        partial['comparisonPeers'][0]['observation']['pairedMeasurement']['requestUsage'][0].pop('outputTokens')
        incomplete = grade(case, partial)
        self.assertEqual('UNJUDGEABLE', next(x for x in incomplete['checks']
            if x['checkId'] in ref['checkIds'])['status'])


if __name__ == '__main__':
    unittest.main()
