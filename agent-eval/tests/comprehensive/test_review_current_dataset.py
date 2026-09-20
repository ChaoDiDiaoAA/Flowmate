"""Review forms for the controlled rebuild must bind current bytes safely."""
import json
from pathlib import Path
import sys
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / 'agent-eval/tools'))


class CurrentReviewFormTests(unittest.TestCase):
    def test_fresh_gold_form_covers_every_current_field_and_line(self):
        from review_invoice_data import make_asset_review_form

        form = make_asset_review_form(ROOT, 'gold', '000115')
        target = ROOT / 'agent-eval/data' / form['target']['path']
        gold = json.loads(target.read_text(encoding='utf-8'))
        review = form['goldReview']

        self.assertEqual(review['kind'], 'fresh_gold_human_review')
        self.assertEqual(set(review['fieldReviews']), set(gold['fields']))
        self.assertEqual(set(review['extraFieldReviews']), set(gold.get('extraFields', {})))
        self.assertEqual(
            [(row['lineId'], set(row['fields'])) for row in review['lineItemReviews']],
            [(row['lineId'], set(row['fields'])) for row in gold['lineItems']],
        )
        self.assertTrue(all(value is False for value in review['coverage'].values()))
        self.assertEqual(review['documentDecision'], 'pending')
        self.assertIsNone(review['replacementLineItems'])

    def test_current_rebuild_submission_cannot_edit_published_files_in_place(self):
        from review_invoice_data import submit_asset_review

        with self.assertRaisesRegex(ValueError, 'cannot be edited in place'):
            submit_asset_review(ROOT, {'assetKind': 'gold', 'assetId': '000115'})

    def test_batch_export_binds_all_one_hundred_current_gold_candidates(self):
        from review_invoice_data import export_current_gold_review_batch

        with tempfile.TemporaryDirectory() as temporary:
            output = Path(temporary) / 'review-batch'
            result = export_current_gold_review_batch(ROOT, output)
            index = json.loads((output / 'index.json').read_text(encoding='utf-8'))
            self.assertEqual(result['goldReviewForms'], 100)
            self.assertEqual(index['goldCount'], 100)
            self.assertEqual(index['humanReviewsPerformed'], 0)
            self.assertEqual(len(index['items']), 100)
            self.assertEqual(len(list(output.glob('*.review.json'))), 100)
            self.assertTrue(all(item['status'] == 'pending_human_review'
                                for item in index['items']))
            from rebuild_gold_reviews import inspect_review_batch
            inspected = inspect_review_batch(ROOT, output)
            self.assertEqual(inspected['forms'], 100)
            self.assertEqual(inspected['pendingHumanReviews'], 100)
            self.assertEqual(inspected['acceptedHumanReviews'], 0)
            self.assertEqual(inspected['invalidHumanReviews'], [])


if __name__ == '__main__':
    unittest.main()
