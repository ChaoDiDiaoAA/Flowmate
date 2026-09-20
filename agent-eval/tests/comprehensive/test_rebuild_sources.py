"""Sample only raw source features; history may constrain exposure, not answers."""
import copy
import hashlib
import json
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'tools' / 'comprehensive'))


class FreshSourceTests(unittest.TestCase):
    def test_prior_group_exposure_survives_new_parse_hashes_and_unselected_aliases(self):
        from rebuild_sources import group_sources
        records = [{'sampleId': 'a', 'normalizedParseHash': 'hash-a'},
                   {'sampleId': 'b', 'normalizedParseHash': 'hash-b'},
                   {'sampleId': 'c', 'normalizedParseHash': 'hash-b'}]
        previous = [{'sampleId': 'a', 'leakageGroup': 'prior-group', 'split': 'development', 'selectedForReview': True},
                    {'sampleId': 'b', 'leakageGroup': 'prior-group', 'split': 'reserve', 'selectedForReview': False},
                    {'sampleId': 'c', 'leakageGroup': 'separate', 'split': 'reserve', 'selectedForReview': False}]
        group_sources(records, previous)
        self.assertEqual(len({r['groupId'] for r in records}), 1)
        self.assertTrue(all('development' in r['priorUses'] for r in records))

    def test_fresh_candidates_never_claim_human_review_or_absence(self):
        from rebuild_sources import draft_gold
        blocks = [{'type': 'text', 'text': 'Invoice No: INV-012\nInvoice Date: 03/04/2026\nTotal: $123.45', 'page_idx': 0}]
        gold = draft_gold('001', blocks, 'acceptance', 'group-1', [])
        self.assertFalse(gold['humanVerified'])
        self.assertFalse(gold['eligibleForFieldScoring'])
        self.assertIsNone(gold['fields']['invoice_number']['normalizedValue'])
        self.assertEqual(gold['fields']['invoice_number']['candidates'][0]['rawValue'], 'INV-012')
        self.assertEqual(gold['fields']['invoice_date']['valueState'], 'unreviewed')
        self.assertEqual(gold['fields']['currency']['candidates'], [], '$ alone does not mean USD')
        self.assertTrue(all(x['valueState'] == 'unreviewed' for x in gold['fields'].values()))
        self.assertEqual(gold['reviewedBy'], [])
        self.assertEqual(gold['provenance']['legacyAnswersRead'], False)

    def test_table_cells_keep_coordinates_and_unsupported_rows_for_review(self):
        from rebuild_sources import table_rows, draft_gold
        table = '<table><tr><th>Description</th><th>Qty</th><th>Price</th></tr><tr><td>Part &amp; screw</td><td>2</td><td>10.00</td></tr><tr><td colspan="2">Total</td><td>20.00</td></tr></table>'
        rows = table_rows(table)
        self.assertEqual(rows[1][0]['text'], 'Part & screw')
        self.assertEqual(rows[2][0]['colspan'], 2)
        gold = draft_gold('001', [{'type': 'table', 'table_body': table, 'page_idx': 1, 'bbox': [2, 3, 4, 5]}], 'development', 'g', [])
        self.assertEqual(len(gold['lineItems']), 1)
        evidence = gold['lineItems'][0]['fields']['description']['candidates'][0]['evidence']
        self.assertEqual(evidence['pageNumber'], 2)
        self.assertEqual(evidence['pointer'], '/0/table_body')
        self.assertEqual(evidence['tableRow'], 1)
        self.assertEqual(gold['tableEvidenceCandidates'][0]['rawBbox'], [2, 3, 4, 5])
        self.assertEqual(gold['tableEvidenceCandidates'][0]['coordinateSpace'], 'parser_original_unconfirmed')
        self.assertEqual(len(gold['tableEvidenceCandidates'][0]['rows']), 3)

    def test_spanned_header_is_preserved_but_not_flattened_into_wrong_columns(self):
        from rebuild_sources import draft_gold
        table = '<table><tr><th colspan="2">Description</th><th>Price</th></tr><tr><td>part</td><td>2</td></tr></table>'
        gold = draft_gold('001', [{'table_body': table, 'page_idx': 0}], 'development', 'g', [])
        self.assertEqual(gold['lineItems'], [])
        self.assertEqual(len(gold['tableEvidenceCandidates']), 1)

    def test_near_duplicate_groups_are_not_split_and_exposed_samples_not_acceptance(self):
        from rebuild_sources import select_samples
        records = []
        for i in range(120):
            records.append({'sampleId': f'{i:03}', 'groupId': f'g{i // 2}',
                            'priorUses': ['development'] if i < 20 else [],
                            'features': {'pageCount': 1 + i % 3, 'tableCount': i % 4,
                                         'tableRows': i % 11, 'blockCount': i + 1,
                                         'hasPublisherLabel': i % 2 == 0}})
        chosen = select_samples(records, {'development': 20, 'regression': 10, 'acceptance': 10})
        self.assertEqual(len(chosen), 40)
        self.assertEqual(len({x['groupId'] for x in chosen}), 40)
        self.assertTrue(all(not set(x['groupPriorUses']) & {'development', 'regression'}
                            for x in chosen if x['split'] == 'acceptance'))
        self.assertEqual(chosen, select_samples(records, {'development': 20, 'regression': 10, 'acceptance': 10}))

    def test_insufficient_unexposed_groups_is_an_error_not_silent_split_change(self):
        from rebuild_sources import select_samples
        with self.assertRaisesRegex(ValueError, 'acceptance'):
            select_samples([{'sampleId': '1', 'groupId': '1', 'priorUses': ['development'], 'features': {}}],
                           {'development': 0, 'regression': 0, 'acceptance': 1})

    def test_source_locator_rejects_escape_and_bytes_are_pinned(self):
        from rebuild_sources import contained, file_pin
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            for path in ['../outside', 'C:/outside', '/outside', 'a\\..\\outside']:
                with self.assertRaises(ValueError):
                    contained(root, path)
            (root / 'input.txt').write_bytes(b'actual input')
            pin = file_pin(root, 'input.txt')
            self.assertEqual(pin['sha256'], hashlib.sha256(b'actual input').hexdigest())


if __name__ == '__main__':
    unittest.main()
