"""Independent fixtures for Actions payload and frozen-basis projections."""
from copy import deepcopy
import hashlib
import json
from pathlib import Path
import sys
import unittest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'agent-eval/src'))
sys.path.insert(0, str(ROOT / 'agent-eval/tools'))

from graders.action_payload_semantics import (
    IncompleteActionPayloadEvidence, PAYLOAD_CHECK_COUNTS, PAYLOAD_CHECKS,
    project_action_payload,
)
from rebuild_scenarios_actions import build_scenarios


def digest(value):
    raw = json.dumps(value, ensure_ascii=False, sort_keys=True,
                     separators=(',', ':'), allow_nan=False).encode()
    return hashlib.sha256(raw).hexdigest()


def fixture():
    body = {'invoice_no': 'INV-2', 'currency': 'USD', 'total_minor': 4455,
            'supplier_id': 'SUP-1', 'lines': [
                {'line_ref': 'L-1', 'po_line': 'PO-L1', 'quantity': '3', 'price': '13.50'}]}
    target = {'system': 'local-form', 'environment': 'isolated-test', 'organization': 'org-1'}
    attachment = {'artifactId': 'source-attachment', 'workspaceId': 'ws-1',
                  'name': 'invoice.pdf', 'sha256': 'a' * 64}
    records = {
        'revisions': [
            {'revisionId': 'rev-1', 'workspaceId': 'ws-1', 'actionId': 'A-1',
             'kind': 'candidate', 'version': 1, 'invoiceNumber': 'INV-1', 'currency': 'USD',
             'total': '44.55', 'supplierId': 'SUP-1', 'lines': [], 'memo': '',
             'extraFields': {}, 'at': 11},
            {'revisionId': 'rev-2', 'workspaceId': 'ws-1', 'actionId': 'A-1',
             'kind': 'accepted', 'version': 2, 'invoiceNumber': 'INV-2', 'currency': 'USD',
             'total': '44.55', 'supplierId': 'SUP-1', 'lines': [
                 {'lineId': 'L-1', 'orderLineId': 'PO-L1', 'quantity': '3',
                  'unitPrice': '13.50'}], 'memo': 'review only',
             'extraFields': {'internalMemo': 'review only'}, 'at': 12},
        ],
        'assessments': [
            {'assessmentId': 'AS-1', 'workspaceId': 'ws-1', 'actionId': 'A-1',
             'version': 1, 'evidenceDigest': 'e1', 'at': 11},
            {'assessmentId': 'AS-2', 'workspaceId': 'ws-1', 'actionId': 'A-1',
             'version': 2, 'evidenceDigest': 'e2', 'at': 13},
        ],
        'actions': [
            {'actionId': 'A-1', 'workspaceId': 'ws-1', 'revisionId': 'rev-2',
             'assessmentVersion': 2, 'rulesHash': 'rules-1', 'target': target,
             'payloadId': 'PL-1', 'payloadHash': digest(body), 'basisHash': 'basis-1',
             'basisComponents': {name: name + '-hash' for name in
                                 ('revision','assessment','rules','target','payload','attachments')},
             'attachmentRefs': [attachment], 'logicalActionKey': 'invoice/INV-2',
             'idempotencyIdentity': 'idem-1', 'status': 'frozen', 'at': 14},
        ],
        'payloads': [
            {'payloadId': 'PL-1', 'workspaceId': 'ws-1', 'actionId': 'A-1',
             'body': deepcopy(body), 'target': deepcopy(target),
             'attachmentRefs': [deepcopy(attachment)],
             'canonicalHash': digest(body), 'at': 14},
        ],
        'requests': [
            {'requestId': 'RQ-1', 'workspaceId': 'ws-1', 'actionId': 'A-1',
             'payloadId': 'PL-1', 'path': 'api', 'environment': 'isolated-test',
             'target': deepcopy(target), 'body': deepcopy(body), 'bodyHash': digest(body),
             'basisHash': 'basis-1', 'idempotencyIdentity': 'idem-1',
             'attachmentRefs': [deepcopy(attachment)], 'at': 16},
        ],
        'pages': [],
        'artifacts': [
            {'artifactId': 'source-attachment', 'workspaceId': 'ws-1',
             'name': 'invoice.pdf', 'bytesSha256': 'a' * 64, 'at': 10},
        ],
        'approvals': [
            {'approvalId': 'RV-1', 'workspaceId': 'ws-1', 'actionId': 'A-1',
             'actorId': 'operator-1', 'recordType': 'review', 'status': 'accepted',
             'target': target, 'basisHash': 'basis-1', 'payloadHash': digest(body), 'at': 14},
            {'approvalId': 'AP-1', 'workspaceId': 'ws-1', 'actionId': 'A-1',
             'actorId': 'operator-1', 'recordType': 'approval', 'status': 'approved',
             'target': target, 'basisHash': 'basis-1', 'payloadHash': digest(body), 'at': 15},
        ],
        'roleGrants': [
            {'grantId': 'G-1', 'workspaceId': 'ws-1', 'principalId': 'maintainer-1',
             'subjectId': 'operator-1', 'configurationVersion': 2,
             'operations': ['review', 'approve'], 'authority': 'role_configuration', 'at': 13},
        ],
        'queryResults': [
            {'resultId': 'Q-1', 'workspaceId': 'ws-1', 'actionId': 'A-1',
             'source': 'cli', 'version': 2, 'fieldsHash': 'fields-2', 'at': 17},
            {'resultId': 'Q-2', 'workspaceId': 'ws-1', 'actionId': 'A-1',
             'source': 'desktop', 'version': 2, 'fieldsHash': 'fields-2', 'at': 18},
        ],
    }
    allowed = ['invoice_no','currency','total_minor','supplier_id','lines[0].line_ref',
               'lines[0].po_line','lines[0].quantity','lines[0].price']
    scope = {'workspaceId': 'ws-1', 'actionIds': ['A-1'], 'currentActionId': 'A-1',
             'windowStart': 10, 'windowEnd': 20,
             'targetContract': {'id': 'invoice-local-form-v1',
                                'requiredPaths': allowed, 'allowedPaths': allowed,
                                'basisOrder': ['revision','assessment','rules','target','payload','attachments']},
             'outputs': sorted(PAYLOAD_CHECKS)}
    return records, scope


class ActionPayloadSemanticProjectionTests(unittest.TestCase):
    def test_inventory_covers_exactly_the_reviewed_payload_class(self):
        authored = []
        for scenario in build_scenarios():
            authored.extend(check['key'] for check in scenario['checks']
                            if check['key'] in PAYLOAD_CHECKS)
        counts = {name: authored.count(name) for name in PAYLOAD_CHECKS}
        self.assertEqual(38, len(authored))
        self.assertEqual(PAYLOAD_CHECK_COUNTS, counts)

    def test_correct_fixture_recomputes_mapping_hash_identity_target_and_history(self):
        records, scope = fixture()
        projected = project_action_payload(records, scope)
        self.assertEqual(4455, projected['total-minor'])
        self.assertEqual('INV-1', projected['candidate-invoice-number'])
        self.assertEqual('INV-2', projected['payload-invoice-number'])
        self.assertEqual(0, projected['payload-hash-mismatch-count'])
        self.assertEqual([], projected['missing-target-fields'])
        self.assertEqual([], projected['target-extra-fields'])
        self.assertEqual(['internalMemo'], projected['unmapped-source-fields'])
        self.assertEqual(['api'], [projected['actual-path']])
        self.assertEqual(['rev-1', 'rev-2'], projected['revision-ids'])
        self.assertEqual([1, 2], projected['assessment-versions'])
        self.assertEqual(0, projected['query-semantic-mismatches'])

    def test_same_shape_wrong_bytes_target_or_attachment_is_detected(self):
        records, scope = fixture()
        records['requests'][0]['body']['total_minor'] = 4456
        records['requests'][0]['bodyHash'] = digest(records['requests'][0]['body'])
        records['approvals'][1]['target'] = dict(records['approvals'][1]['target'], organization='other')
        records['artifacts'][0]['bytesSha256'] = 'b' * 64
        projected = project_action_payload(records, scope)
        self.assertEqual(1, projected['request-payload-mismatches'])
        self.assertEqual(1, projected['request-or-page-payload-mismatches'])
        self.assertEqual(1, projected['target-basis-mismatch-count'])
        self.assertEqual(1, projected['attachment-digest-conflicts'])

    def test_hash_mismatch_and_query_semantic_mismatch_are_independently_recomputed(self):
        records, scope = fixture()
        records['payloads'][0]['canonicalHash'] = '0' * 64
        records['queryResults'][1]['fieldsHash'] = 'different'
        projected = project_action_payload(records, scope)
        self.assertEqual(2, projected['payload-hash-mismatch-count'])
        self.assertEqual(1, projected['query-semantic-mismatches'])

    def test_cross_workspace_and_out_of_window_records_do_not_change_projection(self):
        records, scope = fixture()
        extra = deepcopy(records['actions'][0])
        extra.update(actionId='A-other', workspaceId='ws-other', at=19)
        records['actions'].append(extra)
        artifact = deepcopy(records['artifacts'][0])
        artifact.update(artifactId='outside', bytesSha256='c' * 64, at=21)
        records['artifacts'].append(artifact)
        projected = project_action_payload(records, scope)
        self.assertEqual(1, projected['distinct-frozen-actions'])
        self.assertEqual(0, projected['attachment-digest-conflicts'])

    def test_missing_table_column_or_ambiguous_current_record_is_insufficient(self):
        records, scope = fixture()
        for table in list(records):
            with self.subTest(table=table):
                broken = deepcopy(records)
                del broken[table]
                with self.assertRaises(IncompleteActionPayloadEvidence):
                    project_action_payload(broken, scope)
        records, scope = fixture()
        del records['payloads'][0]['body']
        with self.assertRaises(IncompleteActionPayloadEvidence):
            project_action_payload(records, scope)
        records, scope = fixture()
        duplicate = deepcopy(records['payloads'][0])
        duplicate['payloadId'] = 'PL-2'
        records['payloads'].append(duplicate)
        records['actions'][0]['payloadId'] = 'PL-unknown'
        with self.assertRaises(IncompleteActionPayloadEvidence):
            project_action_payload(records, scope)

    def test_scope_rejects_expected_values_and_unknown_outputs(self):
        records, scope = fixture()
        scope['expectedPayload'] = records['payloads'][0]['body']
        with self.assertRaises(IncompleteActionPayloadEvidence):
            project_action_payload(records, scope)
        records, scope = fixture()
        scope['outputs'][0] = 'unknown-output'
        with self.assertRaises(IncompleteActionPayloadEvidence):
            project_action_payload(records, scope)


if __name__ == '__main__':
    unittest.main()
