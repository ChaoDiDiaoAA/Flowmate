"""Independent fixtures for Actions model report, error and workbench views."""
from copy import deepcopy
from pathlib import Path
import sys
import unittest

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / 'agent-eval/src'))
sys.path.insert(0, str(ROOT / 'agent-eval/tools'))

from graders.action_presentation_semantics import (
    PRESENTATION_CHECK_COUNTS, PRESENTATION_CHECKS,
    IncompleteActionPresentationEvidence, project_action_presentation,
)
from rebuild_scenarios_actions import build_scenarios


SAFE = {
    'schemaVersion': 1, 'errorId': 'err-1', 'code': 'ASYNC_QUERY_REJECTED',
    'category': '外部依赖故障', 'source': ['desktop.query_transport'],
    'safeMessage': '查询暂时不可用，请使用当前授权入口重查。',
    'impactScope': 'call', 'recoveryAction': 'retry_read',
    'requestId': 'query-1', 'jobId': 'J1',
}


def fixture():
    records = {
        'modelReports': [
            {'reportId': 'MR1', 'workspaceId': 'ws', 'jobId': 'J1',
             'actionId': 'A1', 'ownership': 'agent_owned',
             'reportedActionStatus': 'succeeded', 'reportedJobStatus': 'completed',
             'acknowledgesUnknown': False, 'claimsSubmission': True,
             'grounded': True, 'at': 20},
        ],
        'diagnostics': [
            {'diagnosticId': 'D1', 'workspaceId': 'ws', 'jobId': 'J1',
             'name': 'optional_screenshot', 'required': True, 'present': False, 'at': 20},
        ],
        'errors': [
            {'recordId': 'E1', 'workspaceId': 'ws', 'layer': 'application',
             'descriptor': deepcopy(SAFE), 'at': 20},
            {'recordId': 'E2', 'workspaceId': 'ws', 'layer': 'ipc',
             'descriptor': deepcopy(SAFE), 'at': 21},
        ],
        'views': [
            {'viewId': 'V1', 'workspaceId': 'ws', 'jobId': 'J1', 'actionId': 'A1',
             'attemptId': 'T1', 'kind': 'status', 'authorized': True,
             'fields': {'approvalStatus': 'rejected', 'jobStatus': 'reviewing',
                        'actionStatus': 'cancelled', 'attemptStatus': 'UNKNOWN',
                        'runStatus': 'succeeded', 'waitingOwner': 'submissions-service'},
             'at': 22},
            {'viewId': 'V2', 'workspaceId': 'ws', 'jobId': 'J1', 'actionId': 'A1',
             'attemptId': 'T1', 'kind': 'session', 'authorized': True,
             'fields': {'title': '核对任务'}, 'at': 22},
            {'viewId': 'V3', 'workspaceId': 'ws', 'jobId': 'J1', 'actionId': 'A1',
             'attemptId': 'T1', 'kind': 'error', 'authorized': True,
             'fields': {'error': deepcopy(SAFE)}, 'at': 22},
        ],
        'steps': [
            {'stepId': 'match-wait', 'workspaceId': 'ws', 'jobId': 'J1',
             'state': 'waiting', 'owner': 'reviewer-1', 'reason': 'select_order',
             'checkpoint': 'checkpoint-2', 'allowed': ['review.select_order'],
             'history': ['match-old'], 'visible': True, 'current': True, 'at': 22},
            {'stepId': 'evidence-wait', 'workspaceId': 'ws', 'jobId': 'J1',
             'state': 'waiting', 'owner': 'operator-1', 'reason': 'document_gap',
             'checkpoint': 'checkpoint-3', 'allowed': ['input.attach_evidence'],
             'history': [], 'visible': True, 'current': True, 'at': 22},
        ],
        'appConfigs': [
            {'configId': 'CFG1', 'workspaceId': 'ws', 'contextIsolation': True,
             'nodeIntegration': False, 'at': 1},
        ],
        'jobTransitions': [
            {'transitionId': 'JT1', 'workspaceId': 'ws', 'jobId': 'J1',
             'status': 'completed', 'cause': 'business', 'at': 20},
        ],
    }
    scope = {
        'workspaceId': 'ws', 'jobIds': ['J1'], 'actionIds': ['A1'],
        'attemptIds': ['T1'], 'windowStart': 1, 'windowEnd': 30,
        'outputs': sorted(PRESENTATION_CHECKS),
    }
    return records, scope


class ActionPresentationSemanticProjectionTests(unittest.TestCase):
    def test_inventory_covers_exactly_the_remaining_model_error_view_class(self):
        authored = []
        for scenario in build_scenarios():
            authored.extend(check['key'] for check in scenario['checks']
                            if check['key'] in PRESENTATION_CHECKS)
        counts = {name: authored.count(name) for name in PRESENTATION_CHECKS}
        self.assertEqual(23, len(authored))
        self.assertEqual(PRESENTATION_CHECK_COUNTS, counts)

    def test_correct_fixture_projects_grounded_report_errors_and_views(self):
        records, scope = fixture()
        value = project_action_presentation(records, scope)
        self.assertEqual('action_succeeded_job_completed', value['model-reported-state'])
        self.assertEqual(['optional_screenshot'], value['diagnostic-gaps'])
        self.assertEqual([SAFE, SAFE], value['error-descriptor-chain'])
        self.assertEqual(SAFE, value['safe-error-projection'])
        self.assertEqual(0, value['unsafe-error-field-count'])
        self.assertEqual('核对任务', value['desktop-session-title'])
        self.assertEqual(['match-wait', 'evidence-wait'], value['visible-active-step-ids'])
        self.assertEqual(['select_order', 'document_gap'], value['waiting-reasons'])
        self.assertEqual({'contextIsolation': True, 'nodeIntegration': False},
                         value['electron-isolation'])
        self.assertEqual('UNKNOWN', value['view-attempt-status'])

    def test_same_shape_wrong_or_ungrounded_report_fails_semantic_label(self):
        records, scope = fixture()
        records['modelReports'][0]['grounded'] = False
        records['views'][0]['fields']['actionStatus'] = 'unknown'
        self.assertEqual('unsupported_or_incomplete',
                         project_action_presentation(records, scope)['model-reported-state'])

    def test_unsafe_nested_error_and_unauthorized_view_are_detected(self):
        records, scope = fixture()
        records['views'][2]['fields']['error']['cause'] = {'stack': 'secret-token'}
        records['views'][0]['authorized'] = False
        value = project_action_presentation(records, scope)
        self.assertGreaterEqual(value['unsafe-error-field-count'], 2)
        self.assertEqual(1, value['unauthorized-view-records'])
        self.assertIsNone(value['safe-error-projection'])

    def test_missing_table_field_unknown_output_or_duplicate_id_is_insufficient(self):
        records, scope = fixture()
        for table in records:
            with self.subTest(table=table):
                broken = deepcopy(records)
                del broken[table]
                with self.assertRaises(IncompleteActionPresentationEvidence):
                    project_action_presentation(broken, scope)
        records, scope = fixture()
        del records['steps'][0]['checkpoint']
        with self.assertRaises(IncompleteActionPresentationEvidence):
            project_action_presentation(records, scope)
        records, scope = fixture()
        scope['outputs'][0] = 'unknown'
        with self.assertRaises(IncompleteActionPresentationEvidence):
            project_action_presentation(records, scope)
        records, scope = fixture()
        records['views'].append(deepcopy(records['views'][0]))
        with self.assertRaises(IncompleteActionPresentationEvidence):
            project_action_presentation(records, scope)


if __name__ == '__main__':
    unittest.main()
