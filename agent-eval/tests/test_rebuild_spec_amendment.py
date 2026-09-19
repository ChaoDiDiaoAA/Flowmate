"""The current dataset follows the approved 100/80/548 plan amendment."""
import json
from pathlib import Path
import sys
import unittest


ROOT = Path(__file__).resolve().parents[2]
sys.path[:0] = [str(ROOT / 'agent-eval/tools'), str(ROOT / 'agent-eval/src')]


class SpecificationAmendmentTests(unittest.TestCase):
    def test_amendment_is_limited_to_the_two_approved_budget_paragraphs(self):
        from rebuild_spec_amendment import registered_amendment

        result = registered_amendment(ROOT)
        self.assertEqual(result['previousBindingRevision'], 3)
        self.assertEqual(result['currentBindingRevision'], 4)
        self.assertEqual(result['changedParagraphCount'], 2)
        self.assertEqual(result['approvedCounts'], {
            'gold': 100, 'business': 80, 'cases': 548,
            'goldSplitCounts': {'development': 51, 'regression': 21, 'acceptance': 28},
            'businessSplitCounts': {'development': 40, 'regression': 16, 'acceptance': 24},
        })

    def test_current_candidate_has_replayable_semantic_amendment(self):
        from rebuild_bindings import CURRENT_BINDING_REVISION, CURRENT_PINS
        from rebuild_dataset import verify_asset_snapshot
        from rebuild_spec_amendment import RECEIPT, validate_snapshot
        from rebuild_staging import read_candidate

        snapshot = read_candidate(ROOT)
        validate_snapshot(ROOT, snapshot)
        receipt = json.loads(snapshot[RECEIPT])
        self.assertEqual(CURRENT_BINDING_REVISION, 4)
        self.assertEqual(receipt['currentSpecRefs'], CURRENT_PINS)
        self.assertEqual(receipt['gold']['count'], 100)
        self.assertTrue(receipt['gold']['bytesUnchanged'])
        self.assertEqual(len(receipt['businessTransitions']), 80)
        self.assertEqual(len(receipt['caseTransitions']), 548)
        self.assertTrue(receipt['semanticContentChanged'])
        self.assertFalse(receipt['humanReviewGranted'])
        self.assertEqual(receipt['actualProductRuns'], 0)
        result = verify_asset_snapshot(ROOT, snapshot)
        self.assertEqual(result['casesPrepared'], 548)
        self.assertEqual(result['businessPackages'], 80)
        self.assertEqual(result['goldCandidates'], 100)
        self.assertEqual(result['actualProductRuns'], 0)
        self.assertFalse(result['formalAcceptanceEligible'])


if __name__ == '__main__':
    unittest.main()
