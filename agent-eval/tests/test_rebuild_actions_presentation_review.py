import hashlib
import json
from pathlib import Path
import sys
import unittest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'agent-eval/tools'))

from rebuild_actions_presentation_review import (
    PRESENTATION_CHECK_COUNTS, RECEIPT, TEST_COMMAND, build_receipt, validate_snapshot,
)
from rebuild_actions_recovery_review import (
    RECEIPT as RECOVERY_RECEIPT, TEST_COMMAND as RECOVERY_TEST_COMMAND,
    assemble as assemble_recovery,
)
from rebuild_staging import read_candidate


class ActionsPresentationReviewTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.snapshot = read_candidate(ROOT)
        if RECOVERY_RECEIPT not in cls.snapshot:
            cls.snapshot = assemble_recovery(
                ROOT, cls.snapshot,
                {'command': RECOVERY_TEST_COMMAND, 'exitCode': 0, 'passed': 28,
                 'productRuns': 0},
            )
        cls.result = {'command': TEST_COMMAND, 'exitCode': 0, 'passed': 28,
                      'productRuns': 0}

    def test_receipt_covers_final_presentation_checks_without_oracle_values(self):
        receipt = build_receipt(ROOT, self.snapshot, self.result)
        self.assertEqual(23, receipt['affectedCheckCount'])
        self.assertEqual(PRESENTATION_CHECK_COUNTS, receipt['checkCounts'])
        self.assertEqual(23, len(receipt['checkPins']))
        self.assertFalse(receipt['semantics']['oracleValueReadByProjector'])
        self.assertTrue(receipt['semantics']['unsafeNestedErrorFixtures'])

    def test_published_final_receipt_closes_actions_q1_without_product_claim(self):
        if RECEIPT not in self.snapshot:
            self.skipTest('receipt is tested before publication by build_receipt')
        validate_snapshot(ROOT, self.snapshot)
        receipt = json.loads(self.snapshot[RECEIPT])
        predecessor = receipt['predecessor']
        self.assertEqual(hashlib.sha256(self.snapshot[predecessor['path']]).hexdigest(),
                         predecessor['sha256'])
        readiness = json.loads(self.snapshot['manifests/readiness.json'])
        self.assertEqual('ADDRESSED_449_SEMANTIC_CHECKS', readiness['actionsReview']['Q1'])
        self.assertEqual(449, readiness['actionsReview']['totalSemanticChecks'])
        self.assertNotIn('actions_Q1', [row['id'] for row in readiness['blockers']])
        report = json.loads(self.snapshot['manifests/preparation-report.json'])
        self.assertNotIn('actions_Q1', report['remainingWork'])
        self.assertEqual(0, receipt['actualProductRuns'])
        self.assertFalse(receipt['formalAcceptanceEligible'])

    def test_tampered_presentation_check_or_source_pin_is_rejected(self):
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
