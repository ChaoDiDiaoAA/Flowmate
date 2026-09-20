"""Runtime/Tools/Events contract review closes only the authored-data blocker."""
import hashlib
import json
from pathlib import Path
import sys
import unittest


ROOT = Path(__file__).resolve().parents[3]
sys.path[:0] = [str(ROOT / 'agent-eval/tools'), str(ROOT / 'agent-eval/src')]


class RuntimeEvidenceReviewTests(unittest.TestCase):
    def test_review_receipt_preserves_cases_and_removes_only_its_blocker(self):
        from rebuild_runtime_evidence_review import (BLOCKER, RECEIPT, TEST_COMMAND,
                                                     assemble)
        from rebuild_dataset import json_bytes
        from rebuild_source_revision import reindex
        from rebuild_staging import read_candidate

        before = read_candidate(ROOT)
        if RECEIPT in before:
            before = dict(before)
            del before[RECEIPT]
            readiness = json.loads(before['manifests/readiness.json'])
            readiness.pop('runtimeToolsEventsReview', None)
            readiness['blockers'].append({'id': BLOCKER, 'status': 'blocked',
                                          'detail': 'authored contract review pending'})
            before['manifests/readiness.json'] = json_bytes(readiness)
            report = json.loads(before['manifests/preparation-report.json'])
            report.pop('runtimeToolsEventsReview', None)
            report['remainingWork'].append(BLOCKER)
            before['manifests/preparation-report.json'] = json_bytes(report)
            reindex(before)
        result = {'command': TEST_COMMAND, 'exitCode': 0, 'passed': 32,
                  'subtests': 315, 'productRuns': 0}
        after = assemble(ROOT, before, result)

        self.assertEqual({p: raw for p, raw in before.items() if p.startswith('cases/')},
                         {p: raw for p, raw in after.items() if p.startswith('cases/')})
        receipt = json.loads(after[RECEIPT])
        self.assertEqual('authored_runtime_tools_events_contract_gaps_addressed',
                         receipt['status'])
        self.assertEqual(10, len(receipt['auditItems']))
        self.assertEqual(0, receipt['actualProductRuns'])
        self.assertFalse(receipt['formalAcceptanceEligible'])

        readiness = json.loads(after['manifests/readiness.json'])
        blocker_ids = {row['id'] for row in readiness['blockers']}
        self.assertNotIn('runtime_input_evidence_and_error_contract', blocker_ids)
        self.assertIn('actual_adapters_and_collectors', blocker_ids)
        review = readiness['runtimeToolsEventsReview']
        self.assertEqual('ADDRESSED_AUTHORED_CONTRACTS', review['status'])
        self.assertEqual(hashlib.sha256(after[RECEIPT]).hexdigest(),
                         review['receiptRef']['sha256'])

        report = json.loads(after['manifests/preparation-report.json'])
        self.assertNotIn('runtime_input_evidence_and_error_contract', report['remainingWork'])
        self.assertIn('actual_adapters_and_collectors', report['remainingWork'])
        self.assertEqual(review, report['runtimeToolsEventsReview'])


if __name__ == '__main__':
    unittest.main()
