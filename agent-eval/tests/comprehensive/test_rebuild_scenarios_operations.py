"""Facility-only mutation tests for fresh declarations; never product evidence."""
from collections import Counter
from copy import deepcopy
import importlib.util
from pathlib import Path
import sys
import unittest

ROOT = Path(__file__).resolve().parents[3]
sys.path[:0] = [str(ROOT / 'agent-eval/tools'), str(ROOT / 'agent-eval/src')]
from rebuild_cases import compile_scenarios
from rebuild_bindings import case_version
from rebuild_contracts import load_spec_contracts
from graders.observations import grade


def catalog():
    path = ROOT / 'agent-eval/tools/comprehensive/rebuild_scenarios_operations.py'
    assert path.is_file(), 'Operations scenario author has not been implemented'
    spec = importlib.util.spec_from_file_location('fresh_operations', path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.build_scenarios()


def facility_envelope(case):
    """Separate scorer self-test identity; do not attach invented evidence to a Case."""
    facility = deepcopy(case)
    facility.update(id='grader-operations-facility', category='platform',
                    familyId='platform/grader-operations', normalControlRefs=[])
    payload = {}
    for check in facility['oracle']['checks']:
        for assertion in [check['assertion'], *check['preconditions']]:
            payload[assertion['path'].split('.')[1]] = assertion['value']
    envelope = {'caseId': facility['id'], 'caseVersion': facility['version'],
                'source': {'kind': 'grader_self_test', 'runId': 'facility-only',
                           'adapterVersion': 'synthetic-comparator-v1'},
                'evidence': [{'kind': kind, 'artifact': 'facility/' + kind + '.json',
                              'sha256': '0' * 64}
                             for kind in facility['oracle']['requiredEvidence']],
                'observation': payload}
    return facility, envelope


class OperationsScenariosTests(unittest.TestCase):
    def test_exact_count_current_sources_and_control_phases(self):
        scenarios = catalog()
        self.assertEqual({'adapter-environment-credentials': 8,
                          'host-persistence-recovery': 12,
                          'release-revocation-migration': 8,
                          'backup-retention-cleanup': 8},
                         dict(Counter(s['subcapability'] for s in scenarios)))
        contracts = load_spec_contracts(ROOT)
        cases = compile_scenarios(scenarios, contracts)
        self.assertEqual(36, len({c['semanticScenarioKey'] for c in cases}))
        by_key = {s['key']: s for s in scenarios}
        for s, c in zip(scenarios, cases):
            self.assertNotEqual(s['title'], s['userInput'])
            self.assertGreaterEqual(len(s['checks']), 3)
            self.assertEqual('not_run', c['executionStatus'])
            self.assertFalse(c['formalAcceptanceEligible'])
            authored_version = 3 if s['key'] == 'ops-release-revoked' else (
                2 if s['stage'] == 'P13' else 1)
            self.assertEqual(authored_version, s['version'])
            self.assertEqual(case_version(authored_version, contracts), c['version'])
            self.assertEqual(authored_version, c['provenance']['authoredVersion'])
            self.assertEqual('pending_actual_adapter', s['initialState']['adapterStatus'])
            self.assertTrue(s['initialState']['permittedInput'])
            for control in s['controlKeys']:
                self.assertTrue(by_key[control]['initialState']['legalControl'])
                self.assertFalse(by_key[control]['faults'])
                self.assertLessEqual(int(by_key[control]['stage'][1:]), int(s['stage'][1:]))
            for check in s['checks']:
                self.assertEqual('F', check['mode'])
                self.assertTrue(check['implementationSources'])
                self.assertIn('Calculate:', check['description'])
                self.assertNotIn('conditionObserved', check['description'])
                self.assertLessEqual({'observation.fixture-established', 'observation.stimulus-reached'},
                                     {g['path'] for g in check['preconditions']})

    def test_every_required_predicate_false_missing_and_untriggered(self):
        cases = compile_scenarios(catalog(), load_spec_contracts(ROOT))
        for case in cases:
            facility, good = facility_envelope(case)
            result = grade(facility, good)
            self.assertEqual('pass', result['verdict'], case['id'])
            self.assertEqual('grader_self_test', result['scope'])
            self.assertFalse(result['formalAcceptanceEligible'])
            for check in facility['oracle']['checks']:
                key = check['assertion']['path'].split('.')[1]
                bad = deepcopy(good)
                value = check['assertion']['value']
                bad['observation'][key] = not value if isinstance(value, bool) else value + 1
                self.assertEqual('fail', grade(facility, bad)['verdict'], check['checkId'])
                missing = deepcopy(good)
                del missing['observation'][key]
                self.assertEqual('insufficient_evidence', grade(facility, missing)['verdict'])
                for requirement in check['evidenceRequirements']:
                    missing = deepcopy(good)
                    missing['evidence'] = [e for e in missing['evidence'] if e['kind'] != requirement['kind']]
                    self.assertEqual('insufficient_evidence', grade(facility, missing)['verdict'])
                for gate in check['preconditions']:
                    bad = deepcopy(good)
                    bad['observation'][gate['path'].split('.')[1]] = False
                    self.assertEqual('insufficient_evidence', grade(facility, bad)['verdict'])
                    missing = deepcopy(good)
                    del missing['observation'][gate['path'].split('.')[1]]
                    self.assertEqual('insufficient_evidence', grade(facility, missing)['verdict'])
                    for kind in gate['evidence']:
                        missing = deepcopy(good)
                        missing['evidence'] = [e for e in missing['evidence'] if e['kind'] != kind]
                        self.assertEqual('insufficient_evidence', grade(facility, missing)['verdict'])

    def test_host_recovery_does_not_require_model_success_to_score_denial(self):
        scenarios = catalog()
        for s in scenarios:
            if s['subcapability'] == 'host-persistence-recovery':
                self.assertEqual('P13', s['stage'])
                self.assertIn('RT-15', s['initialState']['runtimeRefs'])
            for check in s['checks']:
                for gate in check['preconditions']:
                    self.assertNotIn('model-response', gate['path'])
        keys = {s['key'] for s in scenarios}
        self.assertLessEqual({'ops-host-ack-lost', 'ops-host-old-binding',
                              'ops-host-diagnostic-degraded', 'ops-host-audit-fatal',
                              'ops-release-revoked', 'ops-backup-old-gap',
                              'ops-backup-clone', 'ops-retention-protected'}, keys)

    def test_p13_runtime_references_are_exact_registered_scenarios(self):
        from invoice_requirements import load_requirements
        requirements = {row['id'] for row in load_requirements(ROOT)['requirements']}
        expected = {
            'ops-host-commit': ['RT-15', 'RTC-15-02'],
            'ops-host-ack-delay': ['RT-15', 'RTC-15-02'],
            'ops-host-ack-lost': ['RT-15', 'RTC-15-02'],
            'ops-host-evaluation-cas': ['RT-15', 'RTC-15-02'],
            'ops-host-session-context': ['RT-15', 'RTC-15-02'],
            **{key: ['RT-15', 'RTC-15-04'] for key in (
                'ops-host-save-failure', 'ops-host-crash-sent-action',
                'ops-host-old-binding', 'ops-host-event-reconnect',
                'ops-host-pending-child', 'ops-host-diagnostic-degraded',
                'ops-host-audit-fatal')},
            **{key: ['RT-16', 'RTC-16-04'] for key in (
                'ops-release-test-candidate', 'ops-release-shadow',
                'ops-release-revoked', 'ops-release-report-mismatch')},
            **{key: ['RT-16', 'RTC-16-05'] for key in (
                'ops-release-compatible-rollback', 'ops-release-migration-unknown',
                'ops-release-migration-failed', 'ops-release-kill-switch',
                'ops-backup-original', 'ops-backup-clone',
                'ops-backup-missing-file', 'ops-backup-digest-conflict',
                'ops-backup-old-gap')},
            'ops-retention-protected': ['RT-16', 'RTC-16-01', 'RTC-16-05'],
            'ops-retention-expired': ['RT-16', 'RTC-16-01'],
            'ops-retention-junction': ['RT-16', 'RTC-16-01'],
        }
        scenarios = catalog()
        actual = {s['key']: s['initialState']['runtimeRefs']
                  for s in scenarios if s['stage'] == 'P13'}
        self.assertEqual(expected, actual)
        self.assertTrue({item for refs in actual.values() for item in refs}.issubset(requirements))
        self.assertNotIn('RTC-15', {item for refs in actual.values() for item in refs})
        self.assertNotIn('RTC-16', {item for refs in actual.values() for item in refs})

    def test_invalid_source_is_rejected_and_revision_is_supported(self):
        scenarios = catalog()
        scenarios[0]['version'] = 2
        contracts = load_spec_contracts(ROOT)
        cases = compile_scenarios(scenarios, contracts)
        self.assertEqual(case_version(2, contracts), cases[0]['version'])
        scenarios[0]['checks'][0]['sourceRefs'][0]['quote'] = 'Invented operations rule'
        with self.assertRaisesRegex(ValueError, 'Source quote missing'):
            compile_scenarios(scenarios, load_spec_contracts(ROOT))

    def test_action_faults_have_actual_success_control_and_current_stop_metric(self):
        by_key = {s['key']: s for s in catalog()}
        normal = by_key['ops-host-commit']
        self.assertTrue(any(step['command'] == 'adapter.send_currently_authorized_mock_action'
                            for step in normal['steps']))
        stopped = by_key['ops-host-crash-sent-action']
        self.assertIn('MOD-28.stop', {c['metricId'] for c in stopped['checks']})
        pending = by_key['ops-host-pending-child']
        self.assertTrue(any(step['command'] == 'adapter.deliver_held_original_child_identity'
                            for step in pending['steps']))

    def test_native_credentials_and_kill_switch_exercise_the_intended_boundaries(self):
        by_key = {s['key']: s for s in catalog()}
        wrong = by_key['ops-adapter-wrong-credential']
        refresh = by_key['ops-adapter-auth-refresh']
        self.assertIn('adapter.resolve_model_availability', [s['command'] for s in wrong['steps']])
        self.assertIn('adapter.invoke_native_provider_request', [s['command'] for s in wrong['steps']])
        self.assertEqual(2, sum(s['command'] == 'adapter.invoke_native_provider_request' for s in refresh['steps']))
        self.assertEqual(['ops-adapter-auth-refresh'], wrong['controlKeys'])
        stopped = by_key['ops-release-kill-switch']
        self.assertEqual(['ops-host-commit'], stopped['controlKeys'])
        self.assertTrue(stopped['initialState']['facts']['approvedAction']['confirmationValid'])
        self.assertIn('all_non_stop_conditions_proven', str(stopped['steps']))
        for check in stopped['checks']:
            self.assertIn('observation.non-stop-send-conditions-proven', {g['path'] for g in check['preconditions']})

    def test_future_transitions_are_not_pre_command_facts(self):
        by_key = {s['key']: s for s in catalog()}
        for key, future in [('ops-release-revoked', 'newState'),
                            ('ops-host-evaluation-cas', 'currentVersionAfterAuthorizedUpdate'),
                            ('ops-backup-old-gap', 'currentRevocation')]:
            state = by_key[key]['initialState']
            self.assertNotIn(future, state['facts'])
            self.assertIn(future, state['transitionPlan'])
            for check in by_key[key]['checks']:
                gate = next(g for g in check['preconditions'] if g['path'].endswith('fixture-established'))
                self.assertIn('transitionPlan is not pre-command fact', gate['description'])


if __name__ == '__main__':
    unittest.main()
