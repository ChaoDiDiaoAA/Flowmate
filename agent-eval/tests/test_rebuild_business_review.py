"""Business content audits prove simulation consistency without human claims."""
from copy import deepcopy
import json
from pathlib import Path
import sys
import unittest

ROOT = Path(__file__).resolve().parents[2]
sys.path[:0] = [str(ROOT / 'agent-eval/tools'), str(ROOT / 'agent-eval/src')]


class BusinessReviewTests(unittest.TestCase):
    def active_assets(self):
        return [json.loads(p.read_text(encoding='utf-8'))
                for p in sorted((ROOT / 'agent-eval/data/business').glob('*.json'))]

    def test_all_eighty_packages_have_distinct_replayable_content_audits(self):
        from rebuild_business import structural_signature
        from rebuild_business_review import build_review
        assets = self.active_assets()
        self.assertEqual(80, len(assets))
        self.assertEqual(80, len({structural_signature(x) for x in assets}))
        for asset in assets:
            with self.subTest(asset=asset['id']):
                review = build_review(asset)
                self.assertEqual('contract_consistent_simulation_only', review['conclusion'])
                self.assertEqual(6, len(review['checks']))
                self.assertTrue(all(x['status'] == 'PASS' for x in review['checks']))
                self.assertFalse(review['humanVerified'])
                self.assertFalse(review['enterprisePolicyVerified'])
                self.assertFalse(review['formalAcceptanceEligible'])

    def test_audit_rejects_false_design_or_enterprise_claim(self):
        from rebuild_business_review import build_review
        asset = self.active_assets()[0]
        false_design = deepcopy(asset)
        false_design['design']['distinguishingConditions'][0] = 'Only an ID changed'
        with self.assertRaisesRegex(ValueError, 'design narrative'):
            build_review(false_design)
        false_authority = deepcopy(asset)
        false_authority['policy']['enterprisePolicyVerified'] = True
        with self.assertRaisesRegex(ValueError, 'source/policy boundary'):
            build_review(false_authority)


if __name__ == '__main__':
    unittest.main()
