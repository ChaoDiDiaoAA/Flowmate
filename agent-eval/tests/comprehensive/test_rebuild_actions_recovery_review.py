import hashlib
import json
from pathlib import Path
import sys
import unittest

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / 'agent-eval/tools'))

from rebuild_actions_recovery_review import (
    RECOVERY_CHECK_COUNTS, RECEIPT, TEST_COMMAND, build_receipt, validate_snapshot,
)
from rebuild_staging import read_candidate


class ActionsRecoveryReviewTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.snapshot = read_candidate(ROOT)
        cls.result = {'command': TEST_COMMAND, 'exitCode': 0, 'passed': 28,
                      'productRuns': 0}

    def test_receipt_covers_all_recovery_checks_without_oracle_values(self):
        receipt = build_receipt(ROOT, self.snapshot, self.result)
        self.assertEqual(62, receipt['affectedCheckCount'])
        self.assertEqual(RECOVERY_CHECK_COUNTS, receipt['checkCounts'])
        self.assertEqual(62, len(receipt['checkPins']))
        self.assertFalse(receipt['semantics']['oracleValueReadByProjector'])
        self.assertTrue(receipt['semantics']['wrongScopeAndSemanticFixtures'])

    def test_published_successor_is_replayable_and_keeps_only_presentation_pending(self):
        if RECEIPT not in self.snapshot:
            self.skipTest('receipt is tested before publication by build_receipt')
        validate_snapshot(ROOT, self.snapshot)
        receipt = json.loads(self.snapshot[RECEIPT])
        predecessor = receipt['predecessor']
        self.assertEqual(hashlib.sha256(self.snapshot[predecessor['path']]).hexdigest(),
                         predecessor['sha256'])
        readiness = json.loads(self.snapshot['manifests/readiness.json'])
        self.assertIn(readiness['actionsReview']['Q1'], {
            'PARTIALLY_ADDRESSED_426_SEMANTIC_CHECKS',
            'ADDRESSED_449_SEMANTIC_CHECKS',
        })

    def test_tampered_recovery_check_or_source_pin_is_rejected(self):
        if RECEIPT not in self.snapshot:
            self.skipTest('receipt not published yet')
        for mutation in ('check', 'source'):
            bad = dict(self.snapshot)
            receipt = json.loads(bad[RECEIPT])
            if mutation == 'check':
                receipt['checkPins'][0]['assertion']['value'] = 'tampered'
            else:
                receipt['sourcePins'][0]['sha256'] = '0' * 64
            bad[RECEIPT] = (json.dumps(receipt, ensure_ascii=False, indent=2) + '\n').encode()
            with self.subTest(mutation=mutation), self.assertRaises(ValueError):
                validate_snapshot(ROOT, bad)


if __name__ == '__main__':
    unittest.main()
