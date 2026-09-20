"""Independent semantic fixtures for positive Actions submission evidence."""
from copy import deepcopy
from pathlib import Path
import sys
import unittest

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / 'agent-eval/src'))
sys.path.insert(0, str(ROOT / 'agent-eval/tools'))

from graders.action_semantics import (COMMON_ACTION_CHECKS, IncompleteActionEvidence,
                                      POSITIVE_SUBMISSION_CHECKS,
                                      project_action_common,
                                      project_submission_chain)
from rebuild_scenarios_actions import build_scenarios


def fixture():
    scope = {
        'jobIds': ['J-A', 'J-B'], 'actionIds': ['A-A', 'A-B'],
        'attemptIds': ['T-A', 'T-B'], 'principalId': 'submissions-service',
        'targetId': 'b2b-sandbox', 'logicalActionKeys': ['invoice-A', 'invoice-B'],
        'windowStart': 10, 'windowEnd': 20, 'declaredWriteOperations': ['submit'],
    }
    records = {'admissions': [], 'entries': [], 'requests': [], 'effects': [], 'receipts': []}
    for suffix in ('A', 'B'):
        common = {'jobId': 'J-' + suffix, 'actionId': 'A-' + suffix,
                  'attemptId': 'T-' + suffix, 'principalId': 'submissions-service',
                  'targetId': 'b2b-sandbox', 'logicalActionKey': 'invoice-' + suffix, 'at': 15}
        records['admissions'].append(dict(common, operation='submit', decision='admitted', tokenStatus='current'))
        records['entries'].append(dict(common, operation='submit', admission='admitted'))
        records['requests'].append(dict(common, operation='submit', dispatched=True))
        target = {k: v for k, v in common.items() if k not in {'jobId', 'principalId'}}
        records['effects'].append(dict(target, operation='submit', status='created', authority='target', externalId='E-' + suffix))
        records['receipts'].append(dict(target, status='SUCCEEDED', authority='target', externalId='E-' + suffix))
    return records, scope


class ActionSemanticProjectionTests(unittest.TestCase):
    def test_all_positive_submission_checks_share_the_semantic_projector_contract(self):
        authored = [check['key'] for scenario in build_scenarios() for check in scenario['checks']
                    if check['key'] in POSITIVE_SUBMISSION_CHECKS]
        self.assertEqual(30, len(authored))
        self.assertEqual(POSITIVE_SUBMISSION_CHECKS, set(authored))

    def test_independent_correct_fixture_projects_complete_chain(self):
        records, scope = fixture()
        self.assertEqual({
            'admitted-submit-count': 2, 'submit-send-entry-count': 2,
            'submit-request-count': 2, 'submit-effect-count': 2,
            'submit-success-count': 2, 'undeclared-write-request-count': 0,
        }, project_submission_chain(records, scope))
        self.assertEqual(set(POSITIVE_SUBMISSION_CHECKS), set(project_submission_chain(records, scope)))

    def test_same_length_semantic_errors_do_not_count_as_success(self):
        mutations = [
            ('admissions', 1, {'decision': 'denied'}, 'admitted-submit-count'),
            ('admissions', 1, {'tokenStatus': 'revoked'}, 'admitted-submit-count'),
            ('entries', 1, {'admission': 'rejected'}, 'submit-send-entry-count'),
            ('requests', 1, {'dispatched': False}, 'submit-request-count'),
            ('effects', 1, {'status': 'rejected'}, 'submit-effect-count'),
            ('effects', 1, {'authority': 'page'}, 'submit-effect-count'),
            ('receipts', 1, {'status': 'REJECTED'}, 'submit-success-count'),
            ('receipts', 1, {'authority': 'page_banner'}, 'submit-success-count'),
            ('receipts', 1, {'externalId': 'wrong-effect'}, 'submit-success-count'),
        ]
        for table, index, patch, check in mutations:
            with self.subTest(table=table, patch=patch):
                records, scope = fixture()
                records[table][index].update(patch)
                self.assertEqual(1, project_submission_chain(records, scope)[check])

    def test_wrong_identity_target_principal_and_window_are_excluded(self):
        mutations = [
            ('requests', {'attemptId': 'T-other'}, 'submit-request-count'),
            ('requests', {'principalId': 'other-service'}, 'submit-request-count'),
            ('requests', {'targetId': 'other-target'}, 'submit-request-count'),
            ('requests', {'at': 21}, 'submit-request-count'),
            ('effects', {'logicalActionKey': 'other-invoice'}, 'submit-effect-count'),
            ('receipts', {'actionId': 'A-other'}, 'submit-success-count'),
        ]
        for table, patch, check in mutations:
            with self.subTest(table=table, patch=patch):
                records, scope = fixture()
                records[table][1].update(patch)
                self.assertEqual(1, project_submission_chain(records, scope)[check])

    def test_undeclared_write_is_counted_separately(self):
        records, scope = fixture()
        upload = deepcopy(records['requests'][0])
        upload.update(operation='upload', attemptId='T-B')
        records['requests'].append(upload)
        result = project_submission_chain(records, scope)
        self.assertEqual(2, result['submit-request-count'])
        self.assertEqual(1, result['undeclared-write-request-count'])
        scope['declaredWriteOperations'].append('upload')
        self.assertEqual(0, project_submission_chain(records, scope)['undeclared-write-request-count'])

    def test_missing_table_or_critical_column_is_insufficient_evidence(self):
        records, scope = fixture()
        for table in list(records):
            with self.subTest(table=table):
                missing = deepcopy(records)
                del missing[table]
                with self.assertRaises(IncompleteActionEvidence):
                    project_submission_chain(missing, scope)
        records, scope = fixture()
        del records['receipts'][0]['authority']
        with self.assertRaises(IncompleteActionEvidence):
            project_submission_chain(records, scope)

    def test_scope_must_be_explicit_and_does_not_accept_expected_counts(self):
        records, scope = fixture()
        del scope['attemptIds']
        with self.assertRaises(IncompleteActionEvidence):
            project_submission_chain(records, scope)

    def common_fixture(self):
        identity = {'principalId': 'submissions-service', 'workspaceId': 'workspace-actions',
                    'jobId': 'job-1', 'actionId': 'action-1', 'attemptId': 'attempt-1',
                    'targetId': 'b2b-sandbox', 'logicalActionKey': 'invoice-1'}
        scope = {
            'commandBindings': [
                {'commandId': 'dispatch', 'requestId': 'request-1', 'identity': identity},
                {'commandId': 'query', 'requestId': 'request-2', 'identity': identity},
            ],
            'faultBindings': [{'faultId': 'drop-response', 'requestId': 'request-1',
                               'boundary': 'after-target-commit'}],
            'barrier': {'barrierId': 'race-1', 'workerIds': ['worker-a', 'worker-b']},
            'windowStart': 10, 'windowEnd': 30,
        }
        records = {
            'commandDeliveries': [
                {'commandId': 'dispatch', 'requestId': 'request-1', 'status': 'delivered', 'at': 11},
                {'commandId': 'query', 'requestId': 'request-2', 'status': 'delivered', 'at': 12},
            ],
            'identityJoins': [
                {'commandId': 'dispatch', 'requestId': 'request-1', 'identity': deepcopy(identity), 'at': 13},
                {'commandId': 'query', 'requestId': 'request-2', 'identity': deepcopy(identity), 'at': 14},
            ],
            'faults': [{'faultId': 'drop-response', 'requestId': 'request-1',
                        'boundary': 'after-target-commit', 'injected': True, 'at': 15}],
            'barrierEvents': [
                {'barrierId': 'race-1', 'kind': 'arrived', 'workerId': 'worker-a', 'at': 16},
                {'barrierId': 'race-1', 'kind': 'arrived', 'workerId': 'worker-b', 'at': 17},
                {'barrierId': 'race-1', 'kind': 'released', 'workerId': 'harness', 'at': 18},
            ],
        }
        return records, scope

    def test_common_action_guards_come_from_delivery_identity_fault_and_barrier_records(self):
        records, scope = self.common_fixture()
        self.assertEqual({
            'command-delivered': True, 'identity-join-errors': 0,
            'observed-fault-count': 1, 'barrier-arrivals': 2, 'barrier-released': True,
        }, project_action_common(records, scope))
        self.assertEqual(COMMON_ACTION_CHECKS, set(project_action_common(records, scope)))

    def test_common_guard_semantic_errors_are_detected_without_oracle_values(self):
        mutations = [
            ('commandDeliveries', 1, {'status': 'rejected'}, 'command-delivered', False),
            ('identityJoins', 1, {'requestId': 'wrong-request'}, 'identity-join-errors', 1),
            ('faults', 0, {'boundary': 'before-send'}, 'observed-fault-count', 0),
            ('faults', 0, {'injected': False}, 'observed-fault-count', 0),
            ('barrierEvents', 1, {'workerId': 'unknown-worker'}, 'barrier-arrivals', 1),
            ('barrierEvents', 2, {'at': 15}, 'barrier-released', False),
        ]
        for table, index, patch, check, expected in mutations:
            with self.subTest(table=table, patch=patch):
                records, scope = self.common_fixture()
                records[table][index].update(patch)
                self.assertEqual(expected, project_action_common(records, scope)[check])

    def test_common_guard_missing_records_or_columns_are_insufficient(self):
        records, scope = self.common_fixture()
        for table in list(records):
            with self.subTest(table=table):
                missing = deepcopy(records)
                del missing[table]
                with self.assertRaises(IncompleteActionEvidence):
                    project_action_common(missing, scope)
        records, scope = self.common_fixture()
        del records['identityJoins'][0]['identity']
        with self.assertRaises(IncompleteActionEvidence):
            project_action_common(records, scope)
        records, scope = fixture()
        scope['expectedCount'] = 2
        with self.assertRaises(IncompleteActionEvidence):
            project_submission_chain(records, scope)


if __name__ == '__main__':
    unittest.main()
