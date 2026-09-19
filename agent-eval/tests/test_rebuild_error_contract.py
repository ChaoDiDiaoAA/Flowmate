"""Error fixtures must construct actual failure windows, not just expect flags."""
from pathlib import Path
from copy import deepcopy
import sys
import unittest

ROOT = Path(__file__).resolve().parents[2]
sys.path[:0] = [str(ROOT / 'agent-eval/tools'), str(ROOT / 'agent-eval/src')]


def raw_cleanup_fixture():
    """Synthetic concrete acquisition identities; never product evidence."""
    primary = {'errorId': 'migration-e1', 'code': 'migration_failed', 'resourceId': 'sqlite-connection',
               'commandRequestId': 'partial-start'}
    worker_identity = {'resourceId': 'diagnostic-flush-worker', 'nativeHandleId': 'worker-h1',
                       'acquisitionId': 'worker-a1', 'acquisitionCommandRequestId': 'partial-start'}
    sink_identity = {'resourceId': 'diagnostic-sink', 'nativeHandleId': 'sink-h1',
                     'acquisitionId': 'sink-a1', 'acquisitionCommandRequestId': 'partial-start'}
    worker = {**worker_identity, 'errorId': 'cleanup-e1', 'code': 'cleanup_deadline_exceeded',
              'commandRequestId': 'partial-start'}
    blocked = {**sink_identity, 'errorId': 'cleanup-e2', 'code': 'dependency_blocked',
               'blockedByErrorId': 'cleanup-e1', 'commandRequestId': 'partial-start'}
    trace = [
        {**sink_identity, 'operation': 'acquired', 'monotonicMs': 0, 'sequence': 1, 'commandRequestId': 'partial-start'},
        {**worker_identity, 'operation': 'acquired', 'monotonicMs': 1, 'sequence': 2,
         'commandRequestId': 'partial-start', 'dependencyHandles': [sink_identity]},
        {**worker_identity, 'operation': 'cleanup_started', 'monotonicMs': 10, 'sequence': 3,
         'deadlineMs': 100, 'commandRequestId': 'partial-start'},
        {'operation': 'cleanup_error', 'monotonicMs': 110, 'sequence': 6, **worker},
        {'operation': 'cleanup_error', 'monotonicMs': 111, 'sequence': 7, **blocked},
    ]
    return primary, worker, blocked, trace


class ErrorContractTests(unittest.TestCase):
    def cases(self):
        from rebuild_scenarios_foundation import build_scenarios
        return {c['key']: c for c in build_scenarios()}

    def test_partial_initialization_exercises_secondary_cleanup_failure(self):
        case = self.cases()['assembly-partial-start-failure']
        faults = {f['at']: f for f in case['faults']}
        self.assertIn('cleanup:diagnostic-flush-worker', faults)
        self.assertEqual('deadline-exceeded-until-test-release', faults['cleanup:diagnostic-flush-worker']['kind'])
        resources = {r['id']: r for r in case['initialState']['resources']}
        self.assertEqual([], resources['sqlite-connection']['dependsOn'])
        self.assertEqual(['diagnostic-sink'], resources['diagnostic-flush-worker']['dependsOn'])
        self.assertIn('adapter.release_failed_cleanup_fixture_after_observation', [s['command'] for s in case['steps']])
        checks = {c['path']: c for c in case['checks']}
        self.assertEqual(['diagnostic-flush-worker', 'diagnostic-sink'], checks['observation.cleanup.unreleasedResources']['value'])
        self.assertEqual(0, checks['observation.assembly.remainingStorageHandles']['value'])
        self.assertEqual('required-schema-migration', checks['observation.assembly.primaryFailure']['value'])
        self.assertEqual(1, checks['observation.cleanup.observedSecondaryFailureCount']['value'])
        self.assertEqual('gte', checks['observation.cleanup.observedSecondaryFailureCount']['op'])
        self.assertEqual('contains', checks['observation.cleanup.secondaryFailureResourceIds']['op'])
        self.assertTrue(all(not c.get('preconditions') for c in case['checks']))
        self.assertGreater(case['version'], 1)

    def test_normal_close_supplies_resource_dependencies_and_actual_release_evidence(self):
        case = self.cases()['assembly-explicit-start-close']
        self.assertTrue(case['initialState']['resources'])
        check = next(c for c in case['checks'] if c['path'] == 'observation.cleanup.dependencyOrderViolations')
        self.assertEqual(0, check['value'])
        self.assertIn('actual-resource-acquisition-release-trace', check['evidence'])
        self.assertFalse(case['faults'])

    def test_cancel_does_not_collapse_acceptance_stop_release_and_cost(self):
        case = self.cases()['tool-read-cancel-stop-unknown']
        self.assertEqual('withheld-until-after-stop', case['initialState']['requestAccounting']['usageReport'])
        paths = {c['path']: c for c in case['checks']}
        expected = {'observation.cancellation.accepted': True,
                    'observation.cancellation.reason': 'user_cancel',
                    'observation.cancellation.stopConfirmedBeforeRelease': False,
                    'observation.cancellation.resourcesReleasedBeforeStop': False,
                    'observation.accounting.unknownReservationRetainedBeforeUsage': True,
                    'observation.accounting.requestIdentityStable': True}
        for path, value in expected.items():
            self.assertEqual(value, paths[path]['value'])
            self.assertFalse(paths[path].get('preconditions'))
        commands = [s['command'] for s in case['steps']]
        self.assertLess(commands.index('adapter.observe_stop_pending_window'), commands.index('adapter.release_slow_read_fixture'))
        self.assertLess(commands.index('adapter.release_slow_read_fixture'), commands.index('adapter.deliver_late_read_usage_and_inspect'))
        self.assertEqual('s4', case['faults'][0]['releaseStep'])

    def test_cleanup_is_constructed_with_independent_storage_and_held_sink(self):
        cases = self.cases()
        for key in ('assembly-explicit-start-close', 'assembly-partial-start-failure'):
            case = cases[key]
            resources = {r['id']: r for r in case['initialState']['resources']}
            self.assertEqual(['diagnostic-sink'], resources['diagnostic-flush-worker']['dependsOn'])
            self.assertEqual([], resources['sqlite-connection']['dependsOn'])
            self.assertEqual([], resources['diagnostic-sink']['dependsOn'])
            self.assertEqual('initialState.resources', case['steps'][0]['arguments']['resourceGraphRef'])
            self.assertEqual(['diagnostic-sink', 'diagnostic-flush-worker', 'sqlite-connection'],
                             case['initialState']['acquisitionOrder'])
            self.assertTrue(all('actual-resource-acquisition-release-trace' in c['evidence']
                                for c in case['checks'] if c['path'].startswith('observation.cleanup.')))
        failed = cases['assembly-partial-start-failure']
        self.assertNotIn('cleanupCanSucceed', failed['initialState'])
        inspect, release = failed['steps'][1:]
        self.assertEqual('cleanup-outcome-before-fixture-release', inspect['arguments']['captureRef'])
        self.assertEqual(inspect['arguments']['captureRef'], release['arguments']['afterCaptureRef'])
        self.assertEqual(['s2'], release['after'])
        timeout = failed['faults'][1]
        self.assertEqual('s3', timeout['releaseStep'])
        self.assertEqual('diagnostic-flush-worker', timeout['resourceId'])
        self.assertGreater(timeout['deadlineMs'], 0)
        self.assertEqual('migration-before-commit', failed['faults'][0]['barrierId'])
        self.assertTrue(all('actual-primary-and-cleanup-error-records' in c['evidence']
                            for c in failed['checks'] if c['path'] in {
                                'observation.assembly.primaryFailure',
                                'observation.cleanup.observedSecondaryFailureCount'}))

    def test_cancel_commands_construct_stable_identity_and_late_usage_window(self):
        case = self.cases()['tool-read-cancel-stop-unknown']
        state = case['initialState']
        accounting = state['requestAccounting']
        request_key = accounting['requestKey']
        steps = {s['id']: s for s in case['steps']}
        self.assertEqual('initialState.requestAccounting', steps['s1']['arguments']['accountingFixtureRef'])
        self.assertEqual('initialState.readFixture', steps['s1']['arguments']['sourceFixtureRef'])
        self.assertEqual('initialState.readFixture.response', steps['s4']['arguments']['lateReadResponseRef'])
        self.assertEqual('SIM-CANCEL-701', state['readFixture']['response']['invoiceNumber'])
        self.assertEqual('read-request-entered', steps['s1']['arguments']['awaitBarrier'])
        self.assertEqual('read-request-entered', steps['s2']['arguments']['afterBarrier'])
        self.assertEqual('user_cancel', steps['s2']['arguments']['reason'])
        self.assertEqual(request_key, steps['s3']['arguments']['requestKey'])
        self.assertEqual('after-actual-stop-before-usage', steps['s4']['arguments']['captureRef'])
        self.assertEqual(steps['s4']['arguments']['captureRef'], steps['s5']['arguments']['afterCaptureRef'])
        self.assertEqual(request_key, steps['s5']['arguments']['requestKey'])
        self.assertEqual('initialState.requestAccounting.lateUsage', steps['s5']['arguments']['usageFixtureRef'])
        self.assertEqual(request_key, accounting['lateUsage']['requestKey'])
        self.assertEqual(accounting['requestId'], accounting['lateUsage']['requestId'])
        self.assertEqual(accounting['policyVersion'], accounting['lateUsage']['policyVersion'])
        self.assertGreater(accounting['reservationUnits'], accounting['lateUsage']['units'])
        self.assertEqual('s5', case['faults'][1]['releaseStep'])
        self.assertTrue(all(not c.get('preconditions') for c in case['checks']))
        paths = {c['path']: c for c in case['checks']}
        for path in ('observation.accounting.requestIdentityStable',
                     'observation.accounting.unknownReservationRetainedBeforeUsage'):
            self.assertIn('actual-request-and-accounting-records', paths[path]['evidence'])
        self.assertEqual(request_key, paths['observation.accounting.settledRequestKey']['value'])
        self.assertEqual('unknown', paths['observation.accounting.stateAfterStopBeforeUsage']['value'])
        self.assertEqual('settled', paths['observation.accounting.stateAfterLateUsage']['value'])

    def test_changed_definitions_have_new_versions_and_keep_controls(self):
        cases = self.cases()
        expected = {'assembly-explicit-start-close': [],
                    'assembly-partial-start-failure': ['assembly-explicit-start-close'],
                    'tool-read-cancel-stop-unknown': ['tool-product-read-uses-result']}
        for key, controls in expected.items():
            expected_version = 4 if key == 'assembly-partial-start-failure' else (
                3 if key == 'tool-read-cancel-stop-unknown' else 2)
            self.assertEqual(expected_version, cases[key]['version'])
            self.assertEqual(controls, cases[key]['controlKeys'])

    def test_required_raw_identity_checks_do_not_accept_unrealized_windows(self):
        cases = self.cases()
        failure = {c['path']: c for c in cases['assembly-partial-start-failure']['checks']}
        self.assertEqual(['diagnostic-flush-worker', 'diagnostic-sink', 'sqlite-connection'],
                         failure['observation.cleanup.acquiredResourceIds']['value'])
        self.assertEqual(['sqlite-connection'], failure['observation.cleanup.releasedResourceIds']['value'])
        cancel = {c['path']: c for c in cases['tool-read-cancel-stop-unknown']['checks']}
        self.assertEqual('SIM-READ-REQUEST-1', cancel['observation.readRequest.requestId']['value'])
        self.assertEqual(['read-transport', 'read-worker'],
                         cancel['observation.cancellation.heldResourceIdsBeforeStop']['value'])
        self.assertEqual('SIM-READ-COST-1', cancel['observation.accounting.requestKeyBeforeUsage']['value'])
        self.assertTrue(cancel['observation.accounting.usageReceivedAfterActualStop']['value'])

    def test_bad_cleanup_and_cancel_outcomes_fail_required_checks(self):
        # Negative grader self-tests only: these are NOT fabricated product runs.
        from copy import deepcopy
        from rebuild_cases import compile_scenarios
        from rebuild_contracts import load_spec_contracts
        from graders.observations import grade
        compiled = {c['id']: c for c in compile_scenarios(list(self.cases().values()), load_spec_contracts(ROOT))}
        bad = [
            ('assembly-explicit-start-close', {'cleanup': {'dependencyOrderViolations': 1}},
             'observation.cleanup.dependencyOrderViolations', 'actual-resource-acquisition-release-trace'),
            ('assembly-partial-start-failure', {'cleanup': {'unreleasedResources': []}},
             'observation.cleanup.unreleasedResources', 'actual-native-handle-inventory'),
            ('assembly-partial-start-failure', {'cleanup': {'observedSecondaryFailureCount': 0}},
             'observation.cleanup.observedSecondaryFailureCount', 'actual-primary-and-cleanup-error-records'),
            ('tool-read-cancel-stop-unknown', {'cancellation': {'stopConfirmedBeforeRelease': True}},
             'observation.cancellation.stopConfirmedBeforeRelease', 'actual-read-request-and-stop-trace'),
            ('tool-read-cancel-stop-unknown', {'accounting': {'stateAfterStopBeforeUsage': 'released'}},
             'observation.accounting.stateAfterStopBeforeUsage', 'actual-request-and-accounting-records'),
            ('tool-read-cancel-stop-unknown', {'accounting': {'settledRequestKey': 'ANOTHER-REQUEST'}},
             'observation.accounting.settledRequestKey', 'actual-request-and-accounting-records'),
        ]
        for key, payload, path, raw_kind in bad:
            with self.subTest(case=key, path=path):
                case = compiled['fresh-' + key]
                definition = next(c for c in case['oracle']['checks'] if c['assertion']['path'] == path)
                self.assertTrue(definition['required'])
                envelope = {'caseId': case['id'], 'caseVersion': case['version'],
                            'source': {'kind': 'grader_self_test', 'runId': 'negative-self-test', 'adapterVersion': 'self-test'},
                            'observation': payload,
                            'evidence': [{'kind': kind, 'artifact': f'synthetic-{i}.json', 'sha256': 'a' * 64}
                                         for i, kind in enumerate(case['oracle']['requiredEvidence'])]}
                result = grade(case, envelope)
                check = next(c for c in result['checks'] if c['checkId'] == definition['checkId'])
                self.assertEqual('FAIL', check['status'])
                self.assertFalse(result['formalAcceptanceEligible'])
                missing = deepcopy(envelope)
                missing['evidence'] = [e for e in missing['evidence'] if e['kind'] != raw_kind]
                result = grade(case, missing)
                check = next(c for c in result['checks'] if c['checkId'] == definition['checkId'])
                self.assertEqual('UNJUDGEABLE', check['status'])
                self.assertEqual('check_evidence_missing', check['reason'])

    def test_cleanup_error_projection_accepts_backed_dependency_diagnostic(self):
        # Synthetic raw records exercise the evidence projection and grader,
        # not the product; no oracle flags are supplied as source observations.
        from rebuild_scenarios_foundation import derive_partial_start_cleanup_errors
        from rebuild_cases import compile_scenarios
        from rebuild_contracts import load_spec_contracts
        from graders.observations import grade
        scenario = self.cases()['assembly-partial-start-failure']
        compiled = compile_scenarios(list(self.cases().values()), load_spec_contracts(ROOT))
        case = next(c for c in compiled if c['id'] == 'fresh-assembly-partial-start-failure')
        primary, worker, blocked, trace = raw_cleanup_fixture()
        paths = {'observation.cleanup.' + x for x in ('observedSecondaryFailureCount', 'secondaryFailureResourceIds',
                 'primaryErrorInCleanupErrors', 'workerTimeoutRecordCount', 'unsupportedSecondaryErrorCount')}
        for name, records, raw_trace, should_pass in [
            ('timeout-only', [worker], trace[:-1], True),
            ('timeout-and-blocked-sink', [worker, blocked], trace, True),
            ('missing-worker', [blocked], trace, False),
            ('primary-mixed-in', [worker, blocked, primary], trace, False),
            ('unsupported-extra', [worker, dict(blocked, resourceId='unrelated-resource')], trace, False),
            ('unbacked-timeout', [worker], trace[:3], False),
            ('cross-command-blocked', [worker, dict(blocked, commandRequestId='another-command')],
             trace[:-1] + [dict(trace[-1], commandRequestId='another-command')], False),
            ('blocked-before-timeout', [worker, blocked], trace[:-1] + [dict(trace[-1], monotonicMs=5)], False),
        ]:
            with self.subTest(name=name):
                projection = derive_partial_start_cleanup_errors(primary, records,
                    scenario['initialState']['resources'], raw_trace)
                envelope = {'caseId': case['id'], 'caseVersion': case['version'],
                            'source': {'kind': 'grader_self_test', 'runId': name, 'adapterVersion': 'self-test'},
                            'observation': {'cleanup': projection},
                            'evidence': [{'kind': k, 'artifact': f'synthetic-{i}.json', 'sha256': 'a' * 64}
                                         for i, k in enumerate(case['oracle']['requiredEvidence'])]}
                result = grade(case, envelope)
                ids = {c['checkId'] for c in case['oracle']['checks'] if c['assertion']['path'] in paths}
                statuses = [c['status'] for c in result['checks'] if c['checkId'] in ids]
                self.assertEqual(5, len(statuses))
                if should_pass:
                    self.assertEqual(['PASS'] * 5, statuses)
                else:
                    self.assertIn('FAIL', statuses)
                self.assertFalse(result['formalAcceptanceEligible'])
                if name == 'timeout-and-blocked-sink':
                    self.assertEqual(2, projection['observedSecondaryFailureCount'])
                    self.assertEqual(['diagnostic-flush-worker', 'diagnostic-sink'], projection['secondaryFailureResourceIds'])

    def test_released_old_worker_cannot_borrow_reused_resource_name(self):
        from rebuild_scenarios_foundation import derive_partial_start_cleanup_errors
        primary, worker, _, trace = raw_cleanup_fixture()
        trace[1]['monotonicMs'] = 0
        released = dict(trace[1], operation='released', monotonicMs=20, sequence=4)
        acquired = dict(trace[1], nativeHandleId='new-unrelated-handle', acquisitionId='new-acquisition',
                        commandRequestId='other-start', acquisitionCommandRequestId='other-start',
                        monotonicMs=109, sequence=5)
        trace = trace[:3] + [released, acquired, trace[3]]
        result = derive_partial_start_cleanup_errors(primary, [worker],
            self.cases()['assembly-partial-start-failure']['initialState']['resources'], trace)
        self.assertEqual(0, result['workerTimeoutRecordCount'])
        self.assertEqual(1, result['unsupportedSecondaryErrorCount'])

    def test_worker_timeout_requires_same_handle_acquisition_and_cleanup_interval(self):
        from rebuild_scenarios_foundation import derive_partial_start_cleanup_errors
        resources = self.cases()['assembly-partial-start-failure']['initialState']['resources']
        mutations = []
        for key in ('nativeHandleId', 'acquisitionId', 'acquisitionCommandRequestId'):
            for target in ('error', 'acquired', 'cleanup_started'):
                mutations.append(('missing-' + target + '-' + key, target, key, None))
                mutations.append(('wrong-' + target + '-' + key, target, key, 'another-identity'))
        mutations += [('wrong-acquiring-command', 'acquired', 'commandRequestId', 'another-command'),
                      ('cleanup-before-acquired', 'acquired', 'monotonicMs', 11),
                      ('wrong-cleanup-command', 'cleanup_started', 'commandRequestId', 'another-command')]
        for name, target, key, value in mutations:
            with self.subTest(name=name):
                primary, worker, _, trace = raw_cleanup_fixture()
                record = {'error': worker, 'acquired': trace[1], 'cleanup_started': trace[2]}[target]
                if value is None:
                    record.pop(key)
                else:
                    record[key] = value
                if target == 'error':
                    trace[3] = dict(worker, operation='cleanup_error', monotonicMs=110, sequence=6)
                result = derive_partial_start_cleanup_errors(primary, [worker], resources, trace[:-1])
                self.assertEqual(0, result['workerTimeoutRecordCount'])
                self.assertEqual(1, result['unsupportedSecondaryErrorCount'])
        # Even reuse of the native handle string needs its original acquisition.
        for end_operation in ('stopped', 'released'):
            with self.subTest(end_operation=end_operation):
                primary, worker, _, trace = raw_cleanup_fixture()
                ended = dict(trace[1], operation=end_operation, monotonicMs=20, sequence=4)
                reacquired = dict(trace[1], acquisitionId='worker-a2', monotonicMs=109, sequence=5)
                result = derive_partial_start_cleanup_errors(primary, [worker], resources,
                    trace[:3] + [ended, reacquired, trace[3]])
                self.assertEqual(0, result['workerTimeoutRecordCount'])
                self.assertEqual(1, result['unsupportedSecondaryErrorCount'])
        # Internally consistent records from another command do not establish
        # cleanup for this primary failure, nor ownership of its fresh resources.
        for change in ('all-other-command', 'other-acquisition-command', 'missing-primary-command', 'blank-native-handle'):
            with self.subTest(change=change):
                primary, worker, _, trace = raw_cleanup_fixture()
                if change == 'missing-primary-command':
                    primary.pop('commandRequestId')
                elif change == 'blank-native-handle':
                    for record in [worker, *trace]:
                        if record.get('resourceId') == 'diagnostic-flush-worker':
                            record['nativeHandleId'] = ' '
                else:
                    for record in [worker, *trace]:
                        record['acquisitionCommandRequestId'] = 'other-start'
                        if change == 'all-other-command' or record.get('operation') == 'acquired':
                            record['commandRequestId'] = 'other-start'
                result = derive_partial_start_cleanup_errors(primary, [worker], resources, trace[:-1])
                self.assertEqual(0, result['workerTimeoutRecordCount'])
                self.assertEqual(1, result['unsupportedSecondaryErrorCount'])

    def test_sink_blocker_requires_the_workers_bound_dependency_handle(self):
        from rebuild_scenarios_foundation import derive_partial_start_cleanup_errors
        resources = self.cases()['assembly-partial-start-failure']['initialState']['resources']
        for mutation in ('wrong-bound-handle', 'missing-bound-handle', 'sink-reacquired', 'worker-ended'):
            with self.subTest(mutation=mutation):
                primary, worker, blocked, trace = raw_cleanup_fixture()
                trace = deepcopy(trace)
                if mutation == 'wrong-bound-handle':
                    trace[1]['dependencyHandles'][0]['nativeHandleId'] = 'another-sink'
                elif mutation == 'missing-bound-handle':
                    trace[1]['dependencyHandles'][0].pop('nativeHandleId')
                elif mutation == 'sink-reacquired':
                    trace += [dict(trace[0], operation='released', monotonicMs=110.5, sequence=8),
                              dict(trace[0], acquisitionId='sink-a2', nativeHandleId='sink-h2',
                                   monotonicMs=110.6, sequence=9)]
                    blocked.update(acquisitionId='sink-a2', nativeHandleId='sink-h2')
                    trace[4] = dict(blocked, operation='cleanup_error', monotonicMs=111, sequence=10)
                else:
                    trace.append(dict(trace[1], operation='stopped', monotonicMs=110.5, sequence=8))
                    trace[4]['sequence'] = 9
                result = derive_partial_start_cleanup_errors(primary, [worker, blocked], resources, trace)
                self.assertEqual(1, result['workerTimeoutRecordCount'])
                self.assertEqual(1, result['unsupportedSecondaryErrorCount'])


if __name__ == '__main__':
    unittest.main()
