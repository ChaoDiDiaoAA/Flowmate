"""Migration safeguards for replacing machine drafts with one current dataset."""
import tempfile
import unittest
from pathlib import Path

from finalize_invoice_data import checked_snapshot, canonical_path, verify_retirable, revise_case
from prepare_invoice_data import file_info, write_new
from verify_invoice_data import indexed_jsonl


class FinalizationSafeguards(unittest.TestCase):
    def test_changed_oracle_gets_new_revision_without_renaming_or_mutating_parent(self):
        prior = {'id': 'submission-00001', 'version': 2, 'oracle': {'version': 3}}
        current = revise_case(prior, {'sha256': 'a'*64})
        self.assertEqual((current['id'], current['version'], current['oracle']['version']), ('submission-00001', 3, 4))
        self.assertEqual(prior['version'], 2)
        self.assertEqual(current['revisionProvenance']['priorSha256'], 'a'*64)
        self.assertFalse(current['revisionProvenance']['humanVerified'])

    def test_duplicate_run_or_materialization_rows_do_not_shrink_denominator(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder)/'cases.jsonl'
            path.write_text('{"caseId":"one"}\n{"caseId":"one"}\n', encoding='utf-8')
            with self.assertRaises(ValueError):
                indexed_jsonl(path)

    def test_snapshot_rejects_changed_and_unlisted_files(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            write_new(root/'gold/000001.json', {'humanVerified': False})
            write_new(root/'manifests/inventory.json', {'files': [file_info(root/'gold/000001.json', root)]})
            checked_snapshot(root)
            (root/'gold/000001.json').write_text('{}', encoding='utf-8')
            with self.assertRaises(ValueError):
                checked_snapshot(root)
            write_new(root/'unexpected.json', {})
            with self.assertRaises(ValueError):
                checked_snapshot(root)

    def test_canonical_names_do_not_embed_revision(self):
        self.assertEqual(canonical_path('case', {'id': 'approval-00005', 'category': 'approval', 'version': 2}),
                         'cases/approval/approval-00005.json')
        self.assertEqual(canonical_path('gold', {'sampleId': '000001', 'version': 8}), 'gold/000001.json')
        with self.assertRaises(ValueError):
            canonical_path('case', {'id': '../outside', 'category': 'approval'})

    def test_never_retires_actual_reviews_or_runs_as_machine_drafts(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            write_new(root/'gold/000001.json', {'humanVerified': False})
            verify_retirable(root)
            write_new(root/'manifests/reviews/person.json', {'reviewerId': 'human'})
            with self.assertRaises(ValueError):
                verify_retirable(root)
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            write_new(root/'runs/run-001/report.json', {})
            with self.assertRaises(ValueError):
                verify_retirable(root)


if __name__ == '__main__':
    unittest.main()
