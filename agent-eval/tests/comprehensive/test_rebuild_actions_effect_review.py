import hashlib
import json
from pathlib import Path
import sys
import unittest

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / 'agent-eval/tools'))

from rebuild_actions_effect_review import (
    EFFECT_CHECK_COUNTS, RECEIPT, TEST_COMMAND, build_receipt, validate_snapshot,
)
from rebuild_staging import read_candidate


class ActionsEffectReviewTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.snapshot = read_candidate(ROOT)
        cls.result = {'command': TEST_COMMAND, 'exitCode': 0, 'passed': 30,
                      'productRuns': 0}

    def test_receipt_covers_all_request_effect_checks_without_oracle_counts(self):
        receipt = build_receipt(ROOT, self.snapshot, self.result)
        self.assertEqual(65, receipt['affectedCheckCount'])
        self.assertEqual(EFFECT_CHECK_COUNTS, receipt['checkCounts'])
        self.assertEqual(65, len(receipt['checkPins']))
        self.assertFalse(receipt['semantics']['oracleValueReadByProjector'])
        self.assertTrue(receipt['semantics']['sameLengthWrongSemanticFixtures'])

    def test_current_receipt_is_replayable_through_final_q1_successor(self):
        validate_snapshot(ROOT, self.snapshot)
        receipt = json.loads(self.snapshot[RECEIPT])
        predecessor = receipt['predecessor']
        self.assertEqual(
            hashlib.sha256(self.snapshot[predecessor['path']]).hexdigest(),
            predecessor['sha256'])
        readiness = json.loads(self.snapshot['manifests/readiness.json'])
        review = readiness['actionsReview']
        self.assertEqual('ADDRESSED_449_SEMANTIC_CHECKS', review['Q1'])
        self.assertEqual(449, review['totalSemanticChecks'])
        self.assertFalse(any(x['id'] == 'actions_Q1' for x in readiness['blockers']))

    def test_tampered_effect_check_or_source_pin_is_rejected(self):
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
