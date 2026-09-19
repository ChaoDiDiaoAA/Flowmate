"""Explicit AI annotation revisions never grant human review or product scores."""
from copy import deepcopy
import hashlib
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
sys.path[:0] = [str(ROOT / 'agent-eval/tools'), str(ROOT / 'agent-eval/src')]


def annotation_fixture():
    from rebuild_sources import draft_gold, FIELD_NAMES
    from rebuild_case_release import canonical_digest
    gold = draft_gold('sample', [{'type': 'text', 'text': 'Invoice 42', 'page_idx': 0}],
                      'development', 'source-group-sample', [
                          {'path': 'sample/original.jpg', 'bytes': 8, 'sha256': 'a' * 64},
                          {'path': 'sample/content.json', 'bytes': 10, 'sha256': 'b' * 64}])
    def missing():
        return {'valueState': 'source_not_provided', 'rawValue': None, 'normalizedValue': None,
                'availableInAllowedInput': {'parsed_only': 'not_available', 'parsed_with_source_evidence': 'not_available'},
                'alternatives': [], 'note': 'Not visible in this synthetic source',
                'evidence': [{'kind': 'original', 'pageNumber': 1, 'region': 'whole page', 'quote': None}]}
    fields = {name: missing() for name in FIELD_NAMES}
    fields['invoice_number'].update(valueState='present', rawValue='42', normalizedValue='42',
        availableInAllowedInput={'parsed_only': 'available', 'parsed_with_source_evidence': 'available'},
        evidence=[{'kind': 'original', 'pageNumber': 1, 'region': 'top', 'quote': '42'},
                  {'kind': 'parsed', 'pageNumber': 1, 'pointer': '/0/text', 'quote': '42'}])
    packet = {'schemaVersion': 1, 'kind': 'original_image_ai_annotation',
              'sampleId': 'sample', 'baseGoldVersion': 1, 'baseGoldSha256': canonical_digest(gold),
              'originalSha256': 'a' * 64,
              'actor': {'kind': 'ai_assistant', 'id': 'synthetic-unit-test', 'annotatedOn': '2026-09-17'},
              'accessPurpose': 'quality_authoring', 'usedForProductTuning': False,
              'fields': fields, 'extraFields': {}, 'lineItems': [],
              'documentNotes': ['Synthetic test input, not a real image annotation'],
              'workpaper': {'text': 'synthetic workpaper', 'sha256': hashlib.sha256(b'synthetic workpaper').hexdigest()}}
    return gold, packet


class AnnotationTests(unittest.TestCase):
    def test_invalid_printed_literal_preserved_without_inventing_valid_date(self):
        from rebuild_annotations import apply_annotation
        gold, packet = annotation_fixture()
        field = packet['fields']['due_date']
        field.update(valueState='invalid_literal', rawValue='FEB 29, 2022',
                     normalizedValue=None, note='2022 is not a leap year; printed text is unambiguous.',
                     availableInAllowedInput={'parsed_only': 'not_available', 'parsed_with_source_evidence': 'available'},
                     evidence=[{'kind': 'original', 'pageNumber': 1, 'region': 'due date', 'quote': 'FEB 29, 2022'}])
        result = apply_annotation(gold, packet)
        self.assertEqual(result['fields']['due_date']['valueState'], 'invalid_literal')
        self.assertIsNone(result['fields']['due_date']['normalizedValue'])
        self.assertFalse(result['humanVerified'])
        for change in ({'rawValue': None}, {'normalizedValue': '2022-02-28'}, {'alternatives': ['2022-03-01']}):
            bad = deepcopy(packet)
            bad['fields']['due_date'].update(change)
            with self.subTest(change=change), self.assertRaises(ValueError):
                apply_annotation(gold, bad)

    def test_table_cell_evidence_uses_actual_cells_and_preserves_ambiguous_values(self):
        from rebuild_annotations import validate_annotation_sources, apply_annotation
        from rebuild_case_release import canonical_digest
        from rebuild_sources import file_pin
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            gold, packet = self.source_fixture(root)
            source = root / 'data/invoices/voxel51'
            parse = source / 'sample/content.json'
            parse.write_text(json.dumps([{'text': 'Invoice 42', 'page_idx': 0},
                {'table_body': '<table><tr><td colspan="2">Total</td><td>$ 12,30</td></tr></table>', 'page_idx': 0}]), encoding='utf-8')
            gold['sourceSnapshot'][1] = file_pin(source, 'sample/content.json')
            packet['baseGoldSha256'] = canonical_digest(gold)
            currency = packet['fields']['currency']
            currency.update(valueState='ambiguous', rawValue='$', alternatives=['USD', 'CAD'],
                availableInAllowedInput={'parsed_only': 'available', 'parsed_with_source_evidence': 'available'})
            currency['evidence'].append({'kind': 'parsed', 'pageNumber': 1, 'pointer': '/1/table_body',
                                         'quote': '$', 'tableRow': 0, 'tableCell': 1})
            validate_annotation_sources(root, gold, packet)
            self.assertIsNone(apply_annotation(gold, packet)['fields']['currency']['normalizedValue'])
            bad = deepcopy(packet)
            bad['fields']['currency']['evidence'][-1]['tableCell'] = 2
            with self.assertRaises(ValueError):
                validate_annotation_sources(root, gold, bad)

    def test_multiple_annotation_revisions_need_the_entire_prior_chain(self):
        from rebuild_annotations import apply_annotation, annotation_record_path, validate_gold_annotations
        from rebuild_case_release import canonical_digest
        from rebuild_dataset import json_bytes
        gold, packet = annotation_fixture()
        second = apply_annotation(gold, packet)
        newer = deepcopy(packet)
        newer.update(baseGoldVersion=2, baseGoldSha256=canonical_digest(second))
        newer['documentNotes'].append('Clarified annotation, still not human reviewed')
        third = apply_annotation(second, newer)
        self.assertEqual(3, third['version'])
        files = {annotation_record_path(packet): json_bytes({'previousGold': gold, 'annotation': packet}),
                 annotation_record_path(newer): json_bytes({'previousGold': second, 'annotation': newer})}
        validate_gold_annotations(third, files)
        del files[annotation_record_path(packet)]
        with self.assertRaises(ValueError):
            validate_gold_annotations(third, files)

    def test_parse_quotation_cannot_use_bytes_read_after_the_pin_check(self):
        from rebuild_annotations import validate_annotation_sources
        from rebuild_sources import file_pin
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            gold, packet = self.source_fixture(root)
            packet['fields']['invoice_number']['evidence'][1]['quote'] = 'UNPINNED'
            parse = root / 'data/invoices/voxel51/sample/content.json'
            def change_after_pin(base, relative):
                result = file_pin(base, relative)
                if relative.endswith('/content.json'):
                    parse.write_text(json.dumps([{'text': 'UNPINNED', 'page_idx': 0}]), encoding='utf-8')
                return result
            with patch('rebuild_annotations.file_pin', side_effect=change_after_pin):
                with self.assertRaises(ValueError):
                    validate_annotation_sources(root, gold, packet)

    def test_batch_rebuilds_case_pins_counts_and_rejects_duplicate_or_stale_packets(self):
        from rebuild_annotations import build_annotation_revision
        from rebuild_contracts import load_spec_contracts
        from rebuild_case_release import assemble_case_files, verify_case_files
        from rebuild_dataset import json_bytes
        from rebuild_extraction import build_extraction_cases, materialize_extraction
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            gold, packet = self.source_fixture(root)
            contracts = load_spec_contracts(ROOT)
            path = 'gold/' + gold['id'] + '.json'
            before = {path: json_bytes(gold), 'manifests/preparation-report.json': json_bytes({
                'actualProductRuns': 0, 'baselineCount': 0, 'imageAnnotatedGold': 0,
                'calibrationBatch': {'caseTarget': 60, 'cases': [], 'status': 'incomplete'}})}
            before_case = build_extraction_cases([gold], contracts)[0]
            before = assemble_case_files(before, [before_case], contracts)
            after = build_annotation_revision(root, before, [packet], contracts)
            self.assertEqual(1, json.loads(after['manifests/preparation-report.json'])['imageAnnotatedGold'])
            after_case = json.loads(next(data for name, data in after.items() if name.startswith('cases/')))
            from rebuild_bindings import CURRENT_BINDING_REVISION
            self.assertEqual(4000 + CURRENT_BINDING_REVISION, after_case['version'])
            self.assertEqual(2, after_case['oracle']['fieldGoldVersion'])
            source = root / 'data/invoices/voxel51'
            self.assertEqual(materialize_extraction(before_case, source)['input'], materialize_extraction(after_case, source)['input'])
            self.assertFalse(materialize_extraction(after_case, source)['fixtureValidation']['actualProductRun'])
            self.assertEqual(1, verify_case_files(after, contracts)['caseCount'])
            self.assertEqual(after, build_annotation_revision(root, after, [packet], contracts))
            with self.assertRaises(ValueError):
                build_annotation_revision(root, before, [packet, packet], contracts)
            stale = deepcopy(packet); stale['baseGoldSha256'] = '0' * 64
            with self.assertRaises(ValueError):
                build_annotation_revision(root, before, [stale], contracts)

    def source_fixture(self, root):
        from rebuild_case_release import canonical_digest
        from rebuild_sources import file_pin
        gold, packet = annotation_fixture()
        sample = root / 'data/invoices/voxel51/sample'
        sample.mkdir(parents=True)
        (sample / 'original.jpg').write_bytes(b'synthetic-image-test')
        (sample / 'content.json').write_text(json.dumps([{'text': 'Invoice 42', 'page_idx': 0}]), encoding='utf-8')
        gold['sourceSnapshot'] = [file_pin(sample.parent, 'sample/' + n) for n in ('original.jpg', 'content.json')]
        packet['baseGoldSha256'] = canonical_digest(gold)
        packet['originalSha256'] = gold['sourceSnapshot'][0]['sha256']
        return gold, packet

    def test_annotation_revision_archives_exact_prior_tree_and_is_repeatable(self):
        from rebuild_annotations import apply_annotation, annotation_record_path
        from rebuild_staging import revise_annotated_candidate, read_candidate
        from rebuild_dataset import stage_files, json_bytes
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            gold, packet = self.source_fixture(root)
            path = 'gold/' + gold['id'] + '.json'
            before = {path: json_bytes(gold), 'business/retained.json': b'unchanged'}
            stage_files(root, before)
            after = dict(before)
            after[path] = json_bytes(apply_annotation(gold, packet))
            after[annotation_record_path(packet)] = json_bytes({'previousGold': gold, 'annotation': packet})
            result = revise_annotated_candidate(root, before, after)
            self.assertTrue(result['changed'])
            archived = root / result['historyPath']
            self.assertEqual(before, {p.relative_to(archived).as_posix(): p.read_bytes() for p in archived.rglob('*') if p.is_file()})
            self.assertEqual(after, read_candidate(root))
            self.assertFalse(revise_annotated_candidate(root, after, after)['changed'])

    def test_annotation_route_rejects_unrecorded_changes_and_other_asset_changes(self):
        from rebuild_annotations import apply_annotation, annotation_record_path
        from rebuild_staging import revise_annotated_candidate, read_candidate
        from rebuild_dataset import stage_files, json_bytes
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            gold, packet = self.source_fixture(root)
            path = 'gold/' + gold['id'] + '.json'
            before = {path: json_bytes(gold), 'business/retained.json': b'unchanged'}
            stage_files(root, before)
            after = dict(before)
            after[path] = json_bytes(apply_annotation(gold, packet))
            receipt = annotation_record_path(packet)
            after[receipt] = json_bytes({'previousGold': gold, 'annotation': packet})
            variants = []
            bad = dict(after); bad.pop(receipt); variants.append(bad)
            bad = dict(after); bad['business/retained.json'] = b'changed'; variants.append(bad)
            bad = dict(after); revised = json.loads(bad[path]); revised['humanVerified'] = True; bad[path] = json_bytes(revised); variants.append(bad)
            bad = dict(after); bad.pop(path); variants.append(bad)
            for bad in variants:
                with self.assertRaises(ValueError):
                    revise_annotated_candidate(root, before, bad)
                self.assertEqual(before, read_candidate(root))
            (root / 'data/invoices/voxel51/sample/original.jpg').write_bytes(b'changed')
            with self.assertRaises(ValueError):
                revise_annotated_candidate(root, before, after)
            self.assertEqual(before, read_candidate(root))

    def test_normal_case_revision_cannot_change_or_remove_annotation_receipts(self):
        from rebuild_staging import revise_candidate
        from rebuild_dataset import stage_files
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            before = {'gold/fresh.json': b'{}', 'manifests/annotations/record.json': b'retained'}
            stage_files(root, before)
            for after in ({'gold/fresh.json': b'{}'}, dict(before, **{'manifests/annotations/record.json': b'changed'})):
                with self.assertRaises(ValueError):
                    revise_candidate(root, before, after)

    def test_revision_keeps_prior_candidate_and_does_not_grant_review(self):
        from rebuild_annotations import apply_annotation, annotation_record_path
        gold, packet = annotation_fixture()
        before = deepcopy(gold)
        revised = apply_annotation(gold, packet)
        self.assertEqual(before, gold)
        self.assertEqual(2, revised['version'])
        self.assertEqual('42', revised['fields']['invoice_number']['normalizedValue'])
        self.assertEqual('pending', revised['fields']['invoice_number']['review']['status'])
        self.assertFalse(revised['humanVerified'])
        self.assertFalse(revised['eligibleForFieldScoring'])
        self.assertIsNone(revised['acceptedGoldVersion'])
        self.assertEqual(annotation_record_path(packet), revised['annotationRef']['path'])
        self.assertEqual(gold['split'], revised['split'])
        self.assertEqual(gold['sourceSnapshot'], revised['sourceSnapshot'])
        self.assertTrue(revised['provenance']['originalImageReviewed'])
        self.assertEqual('ai_assistant', revised['provenance']['imageAnnotationActorKind'])

    def test_unknown_config_forged_review_wrong_source_and_incomplete_fields_rejected(self):
        from rebuild_annotations import apply_annotation
        gold, packet = annotation_fixture()
        mutations = [lambda a: a.update(humanVerified=True),
                     lambda a: a['actor'].update(kind='human'),
                     lambda a: a.update(originalSha256='0' * 64),
                     lambda a: a.update(baseGoldSha256='0' * 64),
                     lambda a: a['fields'].pop('currency'),
                     lambda a: a['fields']['invoice_number'].update(normalizedValue=None),
                     lambda a: a['fields']['currency'].update(normalizedValue='USD'),
                     lambda a: a['fields']['invoice_number'].update(evidence=[]),
                     lambda a: a['workpaper'].update(text='changed')]
        for mutate in mutations:
            bad = deepcopy(packet)
            mutate(bad)
            with self.assertRaises(ValueError):
                apply_annotation(gold, bad)

    def test_receipt_closure_detects_changed_field_or_lost_prior_revision(self):
        from rebuild_annotations import apply_annotation, annotation_record_path, validate_gold_annotations
        from rebuild_dataset import json_bytes
        gold, packet = annotation_fixture()
        revised = apply_annotation(gold, packet)
        path = annotation_record_path(packet)
        files = {path: json_bytes({'previousGold': gold, 'annotation': packet})}
        validate_gold_annotations(revised, files)
        bad = deepcopy(revised)
        bad['fields']['invoice_number']['normalizedValue'] = 'wrong'
        with self.assertRaises(ValueError):
            validate_gold_annotations(bad, files)
        with self.assertRaises(ValueError):
            validate_gold_annotations(revised, {})

    def test_existing_extraction_revision_updates_gold_pin_without_input_change(self):
        from rebuild_annotations import apply_annotation
        from rebuild_contracts import load_spec_contracts
        from rebuild_extraction import build_extraction_cases
        gold, packet = annotation_fixture()
        revised = apply_annotation(gold, packet)
        before, after = [build_extraction_cases([g], load_spec_contracts(ROOT))[0] for g in (gold, revised)]
        from rebuild_bindings import CURRENT_BINDING_REVISION
        self.assertEqual(3000 + CURRENT_BINDING_REVISION, before['version'])
        self.assertEqual(4000 + CURRENT_BINDING_REVISION, after['version'])
        self.assertEqual((1, 2), (before['oracle']['fieldGoldVersion'], after['oracle']['fieldGoldVersion']))
        self.assertNotEqual(before['oracle']['fieldGoldSha256'], after['oracle']['fieldGoldSha256'])
        self.assertEqual(before['inputAssets'], after['inputAssets'])
        self.assertEqual(before['semanticScenarioKey'], after['semanticScenarioKey'])
        self.assertFalse(after['formalAcceptanceEligible'])

    def test_annotation_source_checks_actual_pin_pointer_and_quoted_substring(self):
        from rebuild_annotations import validate_annotation_sources
        from rebuild_case_release import canonical_digest
        from rebuild_sources import file_pin
        gold, packet = annotation_fixture()
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / 'data/invoices/voxel51'
            sample = source / 'sample'
            sample.mkdir(parents=True)
            (sample / 'original.jpg').write_bytes(b'synthetic-image-test')
            (sample / 'content.json').write_text(json.dumps([{'text': 'Invoice 42', 'page_idx': 0}]), encoding='utf-8')
            gold['sourceSnapshot'] = [file_pin(source, 'sample/' + n) for n in ('original.jpg', 'content.json')]
            packet['baseGoldSha256'] = canonical_digest(gold)
            packet['originalSha256'] = gold['sourceSnapshot'][0]['sha256']
            validate_annotation_sources(root, gold, packet)
            for key, value in [('pointer', '/9/text'), ('quote', 'not in source'), ('pageNumber', 2)]:
                bad = deepcopy(packet)
                bad['fields']['invoice_number']['evidence'][1][key] = value
                with self.assertRaises(ValueError):
                    validate_annotation_sources(root, gold, bad)
            (sample / 'original.jpg').write_bytes(b'changed image')
            with self.assertRaises(ValueError):
                validate_annotation_sources(root, gold, packet)


if __name__ == '__main__':
    unittest.main()
