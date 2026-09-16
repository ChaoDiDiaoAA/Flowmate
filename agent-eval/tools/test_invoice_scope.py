"""Scope revisions preserve identities and attested history without recycling IDs."""
import copy
import json
from pathlib import Path
import tempfile
import unittest
import zipfile

from sync_invoice_scope import split_scope_cases, archive_snapshot, verify_history, _changed_revision, scope_baseline
from prepare_invoice_data import file_info, write_new


class ScopeRevisionTests(unittest.TestCase):
    def test_later_review_preserves_exact_scope_baseline_but_forged_parent_fails(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            path = root/'gold/000001.json'
            prior = {'sampleId':'000001','version':1,'status':'review_pending'}
            write_new(path,prior)
            pinned = file_info(path,root)
            text = path.read_text(encoding='utf-8')
            current = {**prior,'version':2,'reviewRecord':'manifests/reviews/review-1.json','parentAsset':pinned}
            record = {'kind':'human_content_review_record','id':'review-1','assetKind':'gold','assetId':'000001',
                      'parentText':text,'parentValue':prior,'parentAsset':pinned,
                      'resultValue':current,'submission':{'target':pinned}}
            write_new(root/current['reviewRecord'],record)
            path.write_text(json.dumps(current),encoding='utf-8')
            self.assertEqual(scope_baseline(root,pinned),prior)
            record['parentText'] = '{}'
            (root/current['reviewRecord']).write_text(json.dumps(record),encoding='utf-8')
            with self.assertRaises(ValueError): scope_baseline(root,pinned)

    def test_changed_content_does_not_inherit_individual_review_acceptance(self):
        prior = {'version': 3, 'status': 'human_reviewed', 'reviewStatus': 'accepted',
                 'humanVerified': True, 'reviewRecord': 'old.json', 'reviewLevel': 'single_human',
                 'contentAcceptance': 'accepted', 'eligibleForFieldScoring': True}
        current = _changed_revision(copy.deepcopy(prior), prior, {'sha256': 'a'*64})
        self.assertEqual(current['status'], 'review_pending')
        self.assertFalse(current['humanVerified'])
        self.assertFalse(current['eligibleForFieldScoring'])
        self.assertNotIn('reviewRecord', current)
        self.assertNotIn('contentAcceptance', current)
        self.assertEqual(prior['status'], 'human_reviewed')

    def test_removed_cases_are_retired_not_reassigned(self):
        cases = [{'id': 'keep', 'familyId': 'runtime/session-reopen', 'split': 'acceptance'},
                 {'id': 'remove', 'familyId': 'submission/erp-confirmed', 'split': 'development'}]
        prior = copy.deepcopy(cases)
        kept, removed = split_scope_cases(cases)
        self.assertEqual(kept, [prior[0]])
        self.assertEqual(removed, [prior[1]])
        self.assertEqual(cases, prior)

    def test_attested_parent_bytes_survive_archive_and_tampering_is_rejected(self):
        with tempfile.TemporaryDirectory() as folder:
            source, target = Path(folder)/'old', Path(folder)/'new'
            write_new(source/'cases/submission/old.json', {'id': 'old', 'version': 2})
            write_new(source/'manifests/reviews/attestation.json', {'reviewer': 'human', 'decision': 'accept_as_is'})
            write_new(source/'manifests/inventory.json', {'files': [file_info(f, source) for f in source.rglob('*.json')]})
            descriptor = archive_snapshot(source, target)
            with zipfile.ZipFile(target/descriptor['path']) as archive:
                self.assertEqual(archive.read('manifests/reviews/attestation.json'),
                                 (source/'manifests/reviews/attestation.json').read_bytes())
                self.assertEqual(archive.read('cases/submission/old.json'),
                                 (source/'cases/submission/old.json').read_bytes())
            verify_history(target, descriptor)
            (target/descriptor['path']).write_bytes(b'corrupt')
            with self.assertRaises(ValueError):
                verify_history(target, descriptor)


if __name__ == '__main__':
    unittest.main()
