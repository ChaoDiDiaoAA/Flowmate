from copy import deepcopy
import hashlib
import json
from pathlib import Path
import sys
import unittest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'agent-eval/tools'))

from rebuild_actions_semantic_review import (CHECK_NAMES, RECEIPT, TEST_COMMAND,
                                             build_receipt, validate_snapshot)
from rebuild_staging import read_candidate


class ActionsSemanticReviewTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.snapshot = read_candidate(ROOT)
        cls.result = {'command': TEST_COMMAND, 'exitCode': 0, 'passed': 30, 'productRuns': 0}

    def test_receipt_covers_all_thirty_checks_without_reading_expected_count(self):
        receipt = build_receipt(ROOT, self.snapshot, self.result)
        self.assertEqual(30, receipt['affectedCheckCount'])
        self.assertEqual(CHECK_NAMES, set(receipt['checkNames']))
        self.assertEqual({5}, set(__import__('collections').Counter(
            row['checkName'] for row in receipt['checkPins']).values()))
        self.assertFalse(receipt['semantics']['expectedCountReadByProjector'])
        self.assertEqual(0, receipt['actualProductRuns'])

    def test_assembled_successor_preserves_predecessor_and_accepts_final_q1_closure(self):
        validate_snapshot(ROOT, self.snapshot)
        receipt = json.loads(self.snapshot[RECEIPT])
        predecessor = receipt['predecessor']
        self.assertEqual(hashlib.sha256(self.snapshot[predecessor['path']]).hexdigest(),
                         predecessor['sha256'])
        readiness = json.loads(self.snapshot['manifests/readiness.json'])
        self.assertEqual('ADDRESSED_449_SEMANTIC_CHECKS',
                         readiness['actionsReview']['Q1'])
        self.assertFalse(any(x['id'] == 'actions_Q1' for x in readiness['blockers']))

    def test_tampered_check_pin_or_source_pin_is_rejected(self):
        for mutate in ('check', 'source'):
            bad = dict(self.snapshot)
            receipt = json.loads(bad[RECEIPT])
            if mutate == 'check':
                receipt['checkPins'][0]['assertion']['value'] = 'tampered'
            else:
                receipt['sourcePins'][0]['sha256'] = '0' * 64
            bad[RECEIPT] = (json.dumps(receipt, ensure_ascii=False, indent=2) + '\n').encode()
            with self.subTest(mutate=mutate), self.assertRaises(ValueError):
                validate_snapshot(ROOT, bad)


if __name__ == '__main__':
    unittest.main()
