"""Independent equivalence-class fixtures for Actions state projections."""
from copy import deepcopy
from pathlib import Path
import sys
import unittest

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / 'agent-eval/src'))
sys.path.insert(0, str(ROOT / 'agent-eval/tools'))

from graders.action_state_semantics import (
    IncompleteActionStateEvidence, STATE_CHECK_COUNTS, STATE_CHECKS,
    project_action_state,
)
from rebuild_scenarios_actions import build_scenarios


def fixture():
    records = {
        'entitySnapshots': [
            {'workspaceId': 'ws-1', 'entityType': 'approval', 'entityId': 'P-1',
             'revision': 1, 'values': {'status': 'pending', 'decision': 'pending'},
             'authoritative': True, 'at': 11},
            {'workspaceId': 'ws-1', 'entityType': 'approval', 'entityId': 'P-1',
             'revision': 2, 'values': {'status': 'approved', 'decision': 'approved'},
             'authoritative': True, 'at': 16},
            {'workspaceId': 'ws-1', 'entityType': 'job', 'entityId': 'J-1',
             'revision': 3, 'values': {'status': 'completed'},
             'authoritative': True, 'at': 18},
            {'workspaceId': 'ws-1', 'entityType': 'attempt', 'entityId': 'T-1',
             'revision': 2, 'values': {'status': 'UNKNOWN'},
             'authoritative': True, 'at': 17},
        ],
        'attemptBindings': [
            {'workspaceId': 'ws-1', 'actionId': 'A-1', 'attemptId': 'T-1',
             'approvalId': 'P-1', 'sequence': 1, 'authoritative': True, 'at': 14},
            {'workspaceId': 'ws-1', 'actionId': 'A-1', 'attemptId': 'T-2',
             'approvalId': 'P-2', 'sequence': 2, 'authoritative': True, 'at': 19},
        ],
        'dispatchBindings': [
            {'workspaceId': 'ws-1', 'actionId': 'A-1', 'attemptId': 'T-2',
             'approvalId': 'P-2', 'selected': True, 'authoritative': True, 'at': 19},
        ],
        'authorizationEvaluations': [
            {'workspaceId': 'ws-1', 'principalId': 'human-1', 'objectType': 'action',
             'objectId': 'A-1', 'operation': 'review', 'decision': 'ALLOW',
             'policyVersion': 7, 'authoritative': True, 'at': 13},
            {'workspaceId': 'ws-1', 'principalId': 'human-1', 'objectType': 'action',
             'objectId': 'A-1', 'operation': 'approve', 'decision': 'ALLOW',
             'policyVersion': 7, 'authoritative': True, 'at': 14},
            {'workspaceId': 'ws-1', 'principalId': 'human-1', 'objectType': 'action',
             'objectId': 'A-1', 'operation': 'dispatch', 'decision': 'DENY',
             'policyVersion': 7, 'authoritative': True, 'at': 15},
        ],
    }
    scope = {
        'workspaceId': 'ws-1', 'windowStart': 10, 'windowEnd': 20,
        'policyVersion': 7,
        'queries': [
            {'output': 'approval-status', 'kind': 'entity_field_at',
             'entityType': 'approval', 'entityId': 'P-1', 'field': 'status', 'asOf': 20},
            {'output': 'original-decision', 'kind': 'entity_field_at',
             'entityType': 'approval', 'entityId': 'P-1', 'field': 'decision', 'asOf': 20},
            {'output': 'job-status', 'kind': 'entity_field_at',
             'entityType': 'job', 'entityId': 'J-1', 'field': 'status', 'asOf': 20},
            {'output': 'attempt-status', 'kind': 'entity_field_at',
             'entityType': 'attempt', 'entityId': 'T-1', 'field': 'status', 'asOf': 20},
            {'output': 'attempt-approval-ids', 'kind': 'attempt_approval_ids',
             'actionId': 'A-1'},
            {'output': 'selected-approval-id', 'kind': 'selected_approval_id',
             'actionId': 'A-1', 'attemptId': 'T-2'},
            {'output': 'qualified-operations', 'kind': 'qualified_operations',
             'principalId': 'human-1', 'objectType': 'action', 'objectId': 'A-1', 'asOf': 20},
        ],
    }
    return records, scope


class ActionStateSemanticProjectionTests(unittest.TestCase):
    def test_inventory_covers_exactly_the_reviewed_state_equivalence_class(self):
        authored = []
        for scenario in build_scenarios():
            authored.extend(check['key'] for check in scenario['checks']
                            if check['key'] in STATE_CHECKS)
        counts = {name: authored.count(name) for name in STATE_CHECKS}
        self.assertEqual(68, len(authored))
        self.assertEqual(STATE_CHECK_COUNTS, counts)

    def test_correct_fixture_projects_state_history_bindings_and_authorization(self):
        records, scope = fixture()
        self.assertEqual({
            'approval-status': 'approved',
            'original-decision': 'approved',
            'job-status': 'completed',
            'attempt-status': 'UNKNOWN',
            'attempt-approval-ids': ['P-1', 'P-2'],
            'selected-approval-id': 'P-2',
            'qualified-operations': ['approve', 'review'],
        }, project_action_state(records, scope))

    def test_same_length_wrong_semantics_change_projected_values(self):
        records, scope = fixture()
        records['entitySnapshots'][1]['values']['status'] = 'stale'
        records['attemptBindings'][1]['approvalId'] = 'P-wrong'
        records['dispatchBindings'][0]['approvalId'] = 'P-wrong'
        records['authorizationEvaluations'][1]['decision'] = 'DENY'
        projected = project_action_state(records, scope)
        self.assertEqual('stale', projected['approval-status'])
        self.assertEqual(['P-1', 'P-wrong'], projected['attempt-approval-ids'])
        self.assertEqual('P-wrong', projected['selected-approval-id'])
        self.assertEqual(['review'], projected['qualified-operations'])

    def test_old_snapshot_and_non_authoritative_or_cross_workspace_rows_do_not_win(self):
        records, scope = fixture()
        template = deepcopy(records['entitySnapshots'][1])
        records['entitySnapshots'].extend([
            dict(template, workspaceId='ws-other', revision=9,
                 values={'status': 'rejected'}, at=19),
            dict(template, authoritative=False, revision=10,
                 values={'status': 'revoked'}, at=20),
            dict(template, revision=11, values={'status': 'expired'}, at=21),
        ])
        self.assertEqual('approved', project_action_state(records, scope)['approval-status'])
        scope['queries'][0]['asOf'] = 15
        self.assertEqual('pending', project_action_state(records, scope)['approval-status'])

    def test_ambiguous_latest_state_or_binding_is_insufficient(self):
        records, scope = fixture()
        records['entitySnapshots'].append(deepcopy(records['entitySnapshots'][1]))
        with self.assertRaises(IncompleteActionStateEvidence):
            project_action_state(records, scope)
        records, scope = fixture()
        duplicate = deepcopy(records['attemptBindings'][1])
        duplicate['approvalId'] = 'P-3'
        records['attemptBindings'].append(duplicate)
        with self.assertRaises(IncompleteActionStateEvidence):
            project_action_state(records, scope)

    def test_missing_ledger_or_critical_column_is_insufficient(self):
        records, scope = fixture()
        for table in list(records):
            with self.subTest(table=table):
                broken = deepcopy(records)
                del broken[table]
                with self.assertRaises(IncompleteActionStateEvidence):
                    project_action_state(broken, scope)
        records, scope = fixture()
        del records['entitySnapshots'][0]['workspaceId']
        with self.assertRaises(IncompleteActionStateEvidence):
            project_action_state(records, scope)

    def test_scope_rejects_expected_values_unknown_outputs_and_bad_windows(self):
        records, scope = fixture()
        scope['expectedStatus'] = 'approved'
        with self.assertRaises(IncompleteActionStateEvidence):
            project_action_state(records, scope)
        records, scope = fixture()
        scope['queries'][0]['output'] = 'not-a-reviewed-check'
        with self.assertRaises(IncompleteActionStateEvidence):
            project_action_state(records, scope)
        records, scope = fixture()
        scope['queries'][0]['asOf'] = 21
        with self.assertRaises(IncompleteActionStateEvidence):
            project_action_state(records, scope)


if __name__ == '__main__':
    unittest.main()
