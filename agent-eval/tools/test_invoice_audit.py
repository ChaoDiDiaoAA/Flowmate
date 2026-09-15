"""Tests for conservative candidate discovery and closed, nested review batches."""
import unittest
from pathlib import Path
import tempfile

from PIL import Image

import audit_invoice_assets as audit


class CandidateTests(unittest.TestCase):
    def row(self, sid, **updates):
        value = {'sampleId': sid, 'dHash64': '0000000000000000',
                 'normalizedContentSha256': sid, 'split': 'development',
                 'leakageGroup': sid, 'identityCandidates': {}}
        value.update(updates)
        return value

    def test_visual_similarity_is_review_candidate_not_duplicate_truth(self):
        pair = list(audit.candidate_pairs([self.row('a'), self.row('b', split='acceptance')]))[0]
        self.assertEqual(pair['status'], 'review_pending')
        self.assertTrue(pair['crossSplit'])
        self.assertFalse(pair['sameExistingLeakageGroup'])
        self.assertIsNone(pair['sameInvoiceConfirmed'])
        self.assertIn('dhash_hamming_le_4', pair['reasons'])
        self.assertEqual(pair['candidateKind'], 'image_similarity_only')

    def test_same_number_with_conflicting_sellers_is_explicit_conflict(self):
        a = self.row('a', identityCandidates={'invoice_number': '77', 'seller_name': 'Alpha'})
        b = self.row('b', dHash64='ffffffffffffffff',
                     identityCandidates={'invoice_number': '77', 'seller_name': 'Beta'})
        pair = list(audit.candidate_pairs([a, b]))[0]
        self.assertIn('seller_name', pair['identityConflicts'])
        self.assertIn('invoice_number_candidate_equal', pair['reasons'])
        self.assertIsNone(pair['sameInvoiceConfirmed'])
        self.assertEqual(pair['candidateKind'], 'identity_clue_requires_review')

    def test_unrelated_pairs_are_not_emitted(self):
        self.assertEqual(list(audit.candidate_pairs([
            self.row('a'), self.row('b', dHash64='ffffffffffffffff')])), [])

    def test_candidate_connected_component_is_not_automatic_leakage_group(self):
        rows = [self.row(s, normalizedContentSha256='same') for s in ('a', 'b', 'c')]
        groups = audit.candidate_groups(rows, audit.candidate_pairs(rows))
        self.assertEqual(groups[0]['sampleIds'], ['a', 'b', 'c'])
        self.assertEqual(groups[0]['status'], 'review_pending')
        self.assertFalse(groups[0]['applyAsLeakageGroup'])

    def test_same_template_images_do_not_form_invoice_groups(self):
        rows = [self.row('a'), self.row('b'), self.row('c')]
        self.assertEqual(audit.candidate_groups(rows, audit.candidate_pairs(rows)), [])

    def test_dhash_uses_64_horizontal_comparisons(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / 'gradient.png'
            im = Image.new('L', (9, 8))
            im.putdata([255 - x * 20 for y in range(8) for x in range(9)])
            im.save(path)
            result = audit.image_features(path)
            self.assertEqual(result, {'width': 9, 'height': 8, 'dHash64': 'ffffffffffffffff'})

    def test_output_rejects_existing_directory_without_overwriting(self):
        with tempfile.TemporaryDirectory() as folder:
            quality = Path(folder) / 'agent-eval/data'
            output = quality / 'manifests/existing'
            output.mkdir(parents=True)
            marker = output / 'marker.txt'
            marker.write_text('keep')
            with self.assertRaisesRegex(ValueError, 'overwrite'):
                audit.run(folder, output)
            self.assertEqual(marker.read_text(), 'keep')


class BatchTests(unittest.TestCase):
    def test_sample_ties_include_unlabelled_strata(self):
        samples = [{'sampleId': str(i), 'split': 'development', 'hasPublisherLabels': i < 8,
                    'selectedForReview': True, 'businessRef': None} for i in range(10)]
        batch = audit.build_batches(samples, [], targets=[(5, 0, 0)])[0]
        self.assertEqual(len([s for s in batch['gold'] if int(s) >= 8]), 1)
        self.assertEqual(batch['goldSplitLabelCounts'], {
            'development': {'labelled': 4, 'unlabelled': 1}})

    def test_nested_batches_resolve_real_inputs_but_not_allocation_anchors(self):
        samples = [{'sampleId': str(i), 'split': 'development',
                    'selectedForReview': True, 'businessRef': f'business/{i}.json' if i < 4 else None}
                   for i in range(8)]
        cases = []
        for i in range(8):
            cases.append({'id': f'e{i}', 'sampleId': str(i), 'category': 'extraction',
                          'familyId': 'extraction/full', 'sampleRole': 'input_source',
                          'inputMode': 'source_invoice', 'split': 'development', 'version': 1})
        for i in range(4):
            cases.append({'id': f'b{i}', 'sampleId': str(i), 'category': 'matching',
                          'familyId': f'matching/{i % 2}', 'sampleRole': 'input_source',
                          'inputMode': 'simulated_structured_invoice', 'split': 'development', 'version': 1})
        cases.append({'id': 'mechanism', 'sampleId': 'outside', 'category': 'runtime',
                      'familyId': 'runtime/session', 'sampleRole': 'allocation_anchor_only',
                      'inputMode': 'mechanism_fixture', 'split': 'acceptance', 'version': 1})
        batches = audit.build_batches(samples, cases, targets=[(3, 2, 6), (5, 3, 9), (8, 4, 13)])
        previous = {'gold': set(), 'business': set(), 'cases': set()}
        index = {c['id']: c for c in cases}
        for batch, target in zip(batches, [(3, 2, 6), (5, 3, 9), (8, 4, 13)]):
            members = {key: set(batch[key]) for key in previous}
            self.assertEqual(tuple(len(members[k]) for k in previous), target)
            self.assertTrue(members['business'] <= members['gold'])
            for key in previous:
                self.assertTrue(previous[key] <= members[key])
            for cid in members['cases']:
                case = index[cid]
                if case['sampleRole'] == 'input_source':
                    self.assertIn(case['sampleId'], members['gold'])
                    if case['category'] == 'matching':
                        self.assertIn(case['sampleId'], members['business'])
            self.assertEqual(batch['status'], 'review_pending')
            previous = members
        self.assertIn('mechanism', batches[0]['cases'])

    def test_impossible_closed_budget_fails_instead_of_padding(self):
        with self.assertRaisesRegex(ValueError, 'eligible|budget|target'):
            audit.build_batches([], [], targets=[(1, 0, 0)])


if __name__ == '__main__':
    unittest.main()
