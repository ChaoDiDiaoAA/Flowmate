"""Selected-source partition review is replayable and cannot grant acceptance."""
from copy import deepcopy
import json
from pathlib import Path
import sys
import unittest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'agent-eval/tools'))


def fixture():
    from rebuild_case_release import canonical_digest
    gold = {
        'id': 'gold-fresh-sample', 'sampleId': 'sample', 'version': 2,
        'split': 'acceptance', 'leakageGroup': 'source-sample',
        'humanVerified': False, 'eligibleForFieldScoring': False,
        'formalAcceptanceEligible': False,
        'sourceSnapshot': [
            {'path': 'sample/original.jpg', 'bytes': 8, 'sha256': 'a' * 64},
        ],
        'provenance': {'originalImageInspected': True},
        'blockingReasons': [
            'human_verification_required', 'split_and_exposure_review_required'],
    }
    packet = {
        'schemaVersion': 1, 'kind': 'selected_source_relationship_review',
        'sampleId': 'sample', 'baseGoldVersion': 2,
        'baseGoldSha256': canonical_digest(gold),
        'priorSplit': 'acceptance', 'newSplit': 'development',
        'priorLeakageGroup': 'source-sample',
        'newLeakageGroup': 'source-document-sample-peer',
        'relationship': 'same_invoice_distinct_page',
        'relatedSampleIds': ['sample', 'peer'],
        'pageRole': 'first_or_header_page', 'originalSha256': 'a' * 64,
        'decisionBasis': {
            'visualReview': 'original_image_viewed',
            'businessIdentity': 'same_invoice_confirmed',
            'pageContinuity': 'distinct_continuation_pages',
            'exposurePolicy': 'most_exposed_split_wins'},
        'actor': {'kind': 'ai_assistant', 'id': 'unit-test',
                  'reviewedOn': '2026-09-18'},
    }
    return gold, packet


class PartitionReviewTests(unittest.TestCase):
    def test_selection_wide_receipt_replays_only_declared_group_changes(self):
        from rebuild_case_release import canonical_digest
        from rebuild_partitions import (
            REVIEW_METHODS, apply_selected_source_review,
            validate_selected_source_revision,
        )
        previous_selection = {
            'schemaVersion': 3, 'status': 'provisional', 'publishedOrReviewed': False,
            'reviewRequired': ['source_relationships'],
            'samples': [{
                'sampleId': f's{i:03d}', 'split': 'acceptance' if i else 'development',
                'groupId': f'source-s{i:03d}', 'priorUses': [], 'groupPriorUses': [],
                'selectionRationale': {'reason': 'coverage'}, 'exposureStatus': 'pending',
                'formalAcceptanceEligible': False,
            } for i in range(100)],
        }
        previous_audit = {
            'samples': [{'sampleId': f's{i:03d}', 'groupId': f'source-s{i:03d}'}
                        for i in range(100)],
            'nearDuplicateReview': {'status': 'pending', 'remaining': ['visual_review']},
        }
        decision = {
            'groupId': 'source-document-s000-s001', 'sampleIds': ['s000', 's001'],
            'split': 'development',
            'roles': {'s000': 'first_or_header_page', 's001': 'continuation_or_tail_page'},
            'evidence': 'Synthetic same invoice continuation pages.',
            'prior': [
                {'sampleId': 's000', 'split': 'development', 'leakageGroup': 'source-s000'},
                {'sampleId': 's001', 'split': 'acceptance', 'leakageGroup': 'source-s001'}],
            'policy': 'most_exposed_split_wins',
        }
        record = {
            'schemaVersion': 1, 'kind': 'selected_source_relationship_review',
            'previousSelectionSha256': canonical_digest(previous_selection),
            'previousSelection': previous_selection,
            'previousNearDuplicateReview': previous_audit['nearDuplicateReview'],
            'actor': {'kind': 'ai_assistant', 'id': 'unit-test', 'reviewedOn': '2026-09-18'},
            'scope': {'selectedSamples': 100, 'fullSourcePool': 2902},
            'methods': REVIEW_METHODS, 'decisions': [decision],
            'unresolvedSelectedRelationships': [],
            'limitations': ['Synthetic fixture.', 'Full source pool remains open.'],
        }
        selection, audit, path, raw = apply_selected_source_review(
            previous_selection, previous_audit, record)
        from rebuild_partitions import _json_bytes
        preserved = {
            'manifests/selection.json': __import__('hashlib').sha256(_json_bytes(previous_selection)).hexdigest(),
            'manifests/source-audit.json': __import__('hashlib').sha256(_json_bytes(previous_audit)).hexdigest(),
        }
        self.assertEqual((previous_selection, previous_audit),
                         validate_selected_source_revision(selection, audit, {path: raw}, preserved))
        changed = deepcopy(audit)
        changed['samples'][2]['groupId'] = 'undeclared-change'
        with self.assertRaises(ValueError):
            validate_selected_source_revision(selection, changed, {path: raw}, preserved)

    def test_exact_receipt_replays_and_preserves_human_gate(self):
        from rebuild_partitions import apply_partition_review, partition_record_path, validate_partition_record
        gold, packet = fixture()
        revised = apply_partition_review(gold, packet)
        files = {partition_record_path(packet): json.dumps(
            {'previousGold': gold, 'review': packet}, ensure_ascii=False).encode()}
        self.assertEqual(gold, validate_partition_record(revised, files))
        self.assertEqual('development', revised['split'])
        self.assertEqual('source-document-sample-peer', revised['leakageGroup'])
        self.assertFalse(revised['humanVerified'])
        self.assertFalse(revised['eligibleForFieldScoring'])
        self.assertFalse(revised['formalAcceptanceEligible'])
        self.assertNotIn('split_and_exposure_review_required', revised['blockingReasons'])
        self.assertIn('human_verification_required', revised['blockingReasons'])

    def test_wrong_source_digest_or_mutated_receipt_is_rejected(self):
        from rebuild_partitions import apply_partition_review, partition_record_path, validate_partition_record
        gold, packet = fixture()
        bad = deepcopy(packet)
        bad['originalSha256'] = 'b' * 64
        with self.assertRaises(ValueError):
            apply_partition_review(gold, bad)
        revised = apply_partition_review(gold, packet)
        record = {'previousGold': gold, 'review': deepcopy(packet)}
        record['review']['newSplit'] = 'regression'
        files = {partition_record_path(packet): json.dumps(record).encode()}
        with self.assertRaises(ValueError):
            validate_partition_record(revised, files)


if __name__ == '__main__':
    unittest.main()
