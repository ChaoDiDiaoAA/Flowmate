import hashlib
import json
from pathlib import Path
import sys
import unittest

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / 'agent-eval/tools'))

from rebuild_actions_common_review import (CHECK_COUNTS, RECEIPT, TEST_COMMAND,
                                           build_receipt, validate_snapshot)
from rebuild_staging import read_candidate


class ActionsCommonReviewTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.snapshot = read_candidate(ROOT)
        cls.result = {'command': TEST_COMMAND, 'exitCode': 0, 'passed': 33, 'productRuns': 0}

    def test_receipt_covers_all_common_check_occurrences(self):
        receipt = build_receipt(ROOT, self.snapshot, self.result)
        self.assertEqual(163, receipt['affectedCheckCount'])
        self.assertEqual(CHECK_COUNTS, receipt['checkCounts'])
        self.assertFalse(receipt['semantics']['oracleValueReadByProjector'])

    def test_current_receipt_pins_predecessor_and_accepts_final_q1_closure(self):
        validate_snapshot(ROOT, self.snapshot)
        receipt = json.loads(self.snapshot[RECEIPT])
        predecessor = receipt['predecessor']
        self.assertEqual(hashlib.sha256(self.snapshot[predecessor['path']]).hexdigest(), predecessor['sha256'])
        readiness = json.loads(self.snapshot['manifests/readiness.json'])
        self.assertEqual('ADDRESSED_449_SEMANTIC_CHECKS', readiness['actionsReview']['Q1'])
        self.assertFalse(any(x['id'] == 'actions_Q1' for x in readiness['blockers']))


if __name__ == '__main__':
    unittest.main()
