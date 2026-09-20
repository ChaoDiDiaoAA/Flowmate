"""Independent fixtures for the remaining Actions control/recovery checks."""
from copy import deepcopy
from pathlib import Path
import sys
import unittest

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / 'agent-eval/src'))
sys.path.insert(0, str(ROOT / 'agent-eval/tools'))

from graders.action_recovery_semantics import (
    RECOVERY_CHECK_COUNTS, RECOVERY_CHECKS,
    IncompleteActionRecoveryEvidence, project_action_recovery,
)
from rebuild_scenarios_actions import build_scenarios


def fixture():
    records = {
        'commands': [
            {'commandId': 'C1', 'workspaceId': 'ws', 'jobId': 'J1', 'actionId': 'A1',
             'principalId': 'dispatcher', 'kind': 'dispatch', 'result': 'accepted',
             'errorKind': None, 'tokenStatus': 'current', 'cause': 'operator', 'at': 30},
            {'commandId': 'C2', 'workspaceId': 'ws', 'jobId': 'J1', 'actionId': 'A1',
             'principalId': 'operator', 'kind': 'approve', 'result': 'rejected',
             'errorKind': 'authorization_or_reference_mismatch', 'tokenStatus': 'current',
             'cause': 'operator', 'at': 20},
        ],
        'ownershipEvents': [
            {'eventId': f'O{i}', 'workspaceId': 'ws', 'pageId': 'P1', 'owner': owner,
             'principalId': principal, 'at': at}
            for i, (owner, principal, at) in enumerate([
                ('agent_owned', 'agent', 10), ('pause_requested', 'agent', 11),
                ('human_owned', 'human', 12), ('resume_check', 'operator', 13),
                ('agent_owned', 'agent', 14),
            ], 1)
        ],
        'operations': [
            {'operationId': 'OP1', 'workspaceId': 'ws', 'pageId': 'P1',
             'principalId': 'agent', 'actorKind': 'agent', 'kind': 'click',
             'status': 'completed', 'startedAt': 15, 'endedAt': 16},
        ],
        'pageChecks': [
            {'checkId': f'PC{i}', 'workspaceId': 'ws', 'pageId': 'P1',
             'kind': 'resume', 'name': name, 'status': 'passed', 'at': 13}
            for i, name in enumerate(['account', 'organization', 'page', 'object', 'basis',
                                      'unknown_actions', 'authorization'], 1)
        ],
        'pagePolicies': [
            {'policyId': 'PP1', 'workspaceId': 'ws', 'pageId': 'P1',
             'automaticWriteEnabled': True, 'at': 14},
        ],
        'resources': [
            {'resourceId': 'R1', 'workspaceId': 'ws', 'jobId': 'J1', 'actionId': 'A1',
             'kind': 'browser-operation', 'role': 'old', 'state': 'stopped',
             'owner': 'agent', 'at': 25},
        ],
        'attemptEvents': [
            {'eventId': f'AE{i}', 'workspaceId': 'ws', 'jobId': 'J1',
             'actionId': 'A1', 'attemptId': 'T1', 'state': state, 'retryOf': None,
             'approvalId': 'AP1', 'at': at}
            for i, (state, at) in enumerate([
                ('PREPARED', 20), ('SENDING', 21), ('UNKNOWN', 22), ('SUCCEEDED', 23)
            ], 1)
        ],
        'actions': [
            {'actionId': 'A1', 'workspaceId': 'ws', 'jobId': 'J1', 'invoiceId': 'I1',
             'logicalActionKey': 'L1', 'status': 'succeeded', 'published': True,
             'prepared': True, 'at': 19},
        ],
        'approvals': [
            {'approvalId': 'AP1', 'workspaceId': 'ws', 'actionId': 'A1',
             'status': 'approved', 'basisCurrent': True, 'at': 19},
        ],
        'jobs': [
            {'jobId': 'J1', 'workspaceId': 'ws', 'status': 'completed',
             'completionGaps': [], 'cause': 'business', 'at': 24},
        ],
        'receipts': [
            {'receiptId': 'RC1', 'workspaceId': 'ws', 'actionId': 'A1',
             'attemptId': 'T1', 'status': 'SUCCEEDED', 'authority': 'target', 'at': 23},
        ],
        'claims': [
            {'claimId': 'CL1', 'workspaceId': 'ws', 'pageId': 'P1',
             'resourceId': 'R1', 'owner': 'dispatcher-B', 'decision': 'accepted',
             'leaseUntil': 25, 'reclaim': True, 'at': 26},
        ],
        'controllers': [
            {'controllerId': 'CTR1', 'workspaceId': 'ws', 'principalId': 'maintainer-1',
             'status': 'active', 'startResult': 'accepted', 'at': 30},
            {'controllerId': 'CTR2', 'workspaceId': 'ws', 'principalId': 'other',
             'status': 'rejected', 'startResult': 'rejected', 'at': 31},
        ],
        'applications': [
            {'applicationId': 'APP1', 'workspaceId': 'ws', 'status': 'active',
             'title': '核对任务', 'version': 3, 'at': 30},
        ],
        'queries': [
            {'queryId': 'Q1', 'workspaceId': 'ws', 'principalId': 'operator',
             'kind': 'authorized_fallback', 'authorized': True, 'status': 'ok',
             'responseCount': 1, 'at': 32},
        ],
        'probes': [
            {'probeId': 'PB1', 'workspaceId': 'ws', 'kind': 'post_stop_write',
             'delivered': True, 'decision': 'denied', 'at': 28},
        ],
        'invoiceReadiness': [
            {'recordId': 'IR1', 'workspaceId': 'ws', 'jobId': 'J1', 'invoiceId': 'I1',
             'prepared': True, 'receiptLinesComplete': True, 'at': 19},
        ],
        'retryProofs': [
            {'proofId': 'RP1', 'workspaceId': 'ws', 'actionId': 'A1',
             'kind': 'authoritative_no_effect', 'authority': 'target', 'at': 27},
        ],
    }
    scope = {
        'workspaceId': 'ws', 'jobIds': ['J1'], 'actionIds': ['A1'],
        'attemptIds': ['T1'], 'pageIds': ['P1'],
        'principalIds': ['agent', 'human', 'operator', 'dispatcher', 'dispatcher-B',
                         'maintainer-1'],
        'logicalActionKeys': ['L1'], 'windowStart': 1, 'windowEnd': 40,
        'boundaries': {'revalidationAt': 14, 'uiErrorAt': 27, 'isolationAt': 29,
                       'stopAt': 27, 'newAttemptAt': 24},
        'outputs': sorted(RECOVERY_CHECKS),
    }
    return records, scope


class ActionRecoverySemanticProjectionTests(unittest.TestCase):
    def test_inventory_covers_exactly_the_remaining_control_recovery_class(self):
        authored = []
        for scenario in build_scenarios():
            authored.extend(check['key'] for check in scenario['checks']
                            if check['key'] in RECOVERY_CHECKS)
        counts = {name: authored.count(name) for name in RECOVERY_CHECKS}
        self.assertEqual(62, len(authored))
        self.assertEqual(RECOVERY_CHECK_COUNTS, counts)

    def test_correct_fixture_projects_state_from_complete_ledgers(self):
        records, scope = fixture()
        value = project_action_recovery(records, scope)
        self.assertEqual('authorization_or_reference_mismatch', value['command-error-kind'])
        self.assertEqual(['agent_owned', 'pause_requested', 'human_owned',
                          'resume_check', 'agent_owned'], value['ownership-sequence'])
        self.assertEqual('agent_owned', value['ownership'])
        self.assertEqual(0, value['concurrent-human-agent-operations'])
        self.assertEqual(1, value['prepared-invoices'])
        self.assertEqual(1, value['approved-actions'])
        self.assertEqual(['PREPARED', 'SENDING', 'UNKNOWN', 'SUCCEEDED'],
                         value['attempt-state-history'])
        self.assertEqual('authoritative_no_effect', value['retry-proof-kind'])
        self.assertTrue(value['lease-expired-at-reclaim'])
        self.assertEqual('dispatcher-B', value['new-lease-owner'])
        self.assertTrue(value['post-stop-write-probe-delivered'])
        self.assertTrue(value['post-stop-write-probe-denied'])

    def test_wrong_scope_or_semantics_are_not_counted_by_shape(self):
        records, scope = fixture()
        records['approvals'][0]['basisCurrent'] = False
        records['invoiceReadiness'][0]['prepared'] = False
        records['claims'][0]['decision'] = 'rejected'
        records['commands'][0]['workspaceId'] = 'other'
        value = project_action_recovery(records, scope)
        self.assertEqual(0, value['approved-actions'])
        self.assertEqual(0, value['prepared-invoices'])
        self.assertFalse(value['reclaim-accepted'])
        self.assertIsNone(value['dispatcher-principal'])

    def test_overlap_and_failed_resume_checks_are_derived(self):
        records, scope = fixture()
        records['operations'].append({
            'operationId': 'OP2', 'workspaceId': 'ws', 'pageId': 'P1',
            'principalId': 'human', 'actorKind': 'human', 'kind': 'click',
            'status': 'completed', 'startedAt': 15.5, 'endedAt': 17,
        })
        records['pageChecks'][0]['status'] = 'failed'
        value = project_action_recovery(records, scope)
        self.assertEqual(1, value['concurrent-human-agent-operations'])
        self.assertEqual(1, value['conflicting-operations'])
        self.assertEqual(['account'], value['resume-gaps'])
        self.assertNotIn('account', value['resume-checks'])

    def test_missing_table_field_boundary_unknown_output_or_duplicate_id_is_insufficient(self):
        records, scope = fixture()
        for table in records:
            with self.subTest(table=table):
                broken = deepcopy(records)
                del broken[table]
                with self.assertRaises(IncompleteActionRecoveryEvidence):
                    project_action_recovery(broken, scope)
        records, scope = fixture()
        del records['actions'][0]['logicalActionKey']
        with self.assertRaises(IncompleteActionRecoveryEvidence):
            project_action_recovery(records, scope)
        records, scope = fixture()
        del scope['boundaries']['stopAt']
        with self.assertRaises(IncompleteActionRecoveryEvidence):
            project_action_recovery(records, scope)
        records, scope = fixture()
        scope['outputs'][0] = 'unknown'
        with self.assertRaises(IncompleteActionRecoveryEvidence):
            project_action_recovery(records, scope)
        records, scope = fixture()
        records['commands'].append(deepcopy(records['commands'][0]))
        with self.assertRaises(IncompleteActionRecoveryEvidence):
            project_action_recovery(records, scope)


if __name__ == '__main__':
    unittest.main()
