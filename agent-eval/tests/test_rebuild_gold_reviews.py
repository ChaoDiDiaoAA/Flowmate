"""Actual-human Gold reviews are complete, replayable and staged atomically."""
from copy import deepcopy
import hashlib
import json
from pathlib import Path
import sys
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[2]
sys.path[:0] = [str(ROOT / 'agent-eval/tools'), str(ROOT / 'agent-eval/src')]


def completed_form(sample='000115'):
    from review_invoice_data import make_asset_review_form

    form = make_asset_review_form(ROOT, 'gold', sample)
    gold = json.loads((ROOT / 'agent-eval/data' / form['target']['path']).read_text(encoding='utf-8'))
    reviewer = {
        'reviewerId': 'human-reviewer-1',
        'performedBy': 'human',
        'role': 'primary',
        'reviewedAt': '2026-09-18T12:00:00+08:00',
        'attestsContentReview': True,
        'attestsOriginalImageReview': True,
    }
    form.update(
        recordId='gold-review-' + sample,
        reviewers=[reviewer],
        owner='quality-owner',
        decision='accept',
        rationale='逐项核对原图、解析、金额关系和全部明细后接受。',
        checks={key: True for key in form['checks']},
        exposure={'scope': '本次评测材料制作；未用于产品调优。', 'reviewed': True,
                  'notes': '已核对用途、近重复组和暴露记录。'},
    )
    original = gold['sourceEvidence']['original']
    original_pin = next(pin for pin in gold['sourceSnapshot'] if pin['path'].endswith('/original.jpg'))
    form['evidence'] = [
        {'path': form['target']['path'], 'sha256': form['target']['sha256'],
         'note': '核对的精确 Gold 候选。'},
        {'path': original, 'sha256': original_pin['sha256'], 'note': '逐项核对的原始发票图像。'},
    ]
    review = form['goldReview']
    review['reviewers'] = [deepcopy(reviewer)]
    review['coverage'] = {key: True for key in review['coverage']}
    for collection in (review['fieldReviews'], review['extraFieldReviews']):
        for entry in collection.values():
            entry.update(decision='accept', reviewNote='已对照原图和解析确认。')
    for line in review['lineItemReviews']:
        line.update(decision='accept', reviewNote='已确认该行身份、顺序和全部字段。')
        for entry in line['fields'].values():
            entry.update(decision='accept', reviewNote='已对照该行原图和解析确认。')
    review.update(lineCountDecision='accept', replacementLineItems=None,
                  documentDecision='accept', documentNotes='整票字段、行数、金额和不确定性已核对。')
    return gold, form


class GoldHumanReviewTests(unittest.TestCase):
    def test_complete_review_creates_replayable_successor(self):
        from rebuild_dataset import json_bytes
        from rebuild_gold_reviews import validate_and_apply, validate_human_review_record

        gold, form = completed_form()
        revised, record_path, record = validate_and_apply(
            ROOT, ROOT / 'agent-eval/data', gold, form)
        self.assertTrue(revised['humanVerified'])
        self.assertTrue(revised['eligibleForFieldScoring'])
        self.assertFalse(revised['formalAcceptanceEligible'])
        self.assertEqual(revised['version'], gold['version'] + 1)
        self.assertEqual(revised['humanReviewRef']['path'], record_path)
        self.assertEqual({'human-reviewer-1'}, {
            value['review']['reviewer'] for value in revised['fields'].values()})
        files = {record_path: json_bytes(record)}
        self.assertEqual(gold, validate_human_review_record(
            revised, files, ROOT, ROOT / 'agent-eval/data'))

    def test_review_can_replace_field_and_complete_line_structure(self):
        from rebuild_gold_reviews import validate_and_apply

        gold, form = completed_form()
        field = form['goldReview']['fieldReviews']['currency']
        replacement = deepcopy(field['candidate'])
        replacement.update(valueState='present', rawValue='USD', normalizedValue='USD',
                           alternatives=[], note='人工确认票面明确显示 USD。')
        field.update(decision='replace', replacement=replacement,
                     reviewNote='候选把币种标为歧义；原图显示 USD。')
        replacement_lines = deepcopy(gold['lineItems'])
        form['goldReview'].update(lineCountDecision='replace',
                                  replacementLineItems=replacement_lines)
        revised, _, _ = validate_and_apply(ROOT, ROOT / 'agent-eval/data', gold, form)
        self.assertEqual('USD', revised['fields']['currency']['normalizedValue'])
        self.assertEqual(revised['lineItems'], [
            {**line, 'fields': {key: {**value, 'review': {'status': 'accepted',
                                                           'reviewer': 'human-reviewer-1'}}
                                for key, value in line['fields'].items()}}
            for line in replacement_lines])

    def test_incomplete_stale_or_nonhuman_review_is_rejected(self):
        from rebuild_gold_reviews import validate_and_apply

        gold, form = completed_form()
        mutations = [
            lambda value: value['goldReview']['fieldReviews']['invoice_number'].update(
                decision='pending'),
            lambda value: value['target'].update(sha256='0' * 64),
            lambda value: value['evidence'][1].update(sha256='0' * 64),
            lambda value: value['reviewers'][0].update(performedBy='automation'),
            lambda value: value['goldReview']['coverage'].update(originalImageReviewed=False),
            lambda value: value['disputes'].append({'id': 'open', 'status': 'open'}),
        ]
        for mutate in mutations:
            bad = deepcopy(form)
            mutate(bad)
            with self.subTest(mutate=mutate), self.assertRaises(ValueError):
                validate_and_apply(ROOT, ROOT / 'agent-eval/data', gold, bad)

    def test_staging_route_accepts_only_recorded_gold_review(self):
        from rebuild_dataset import json_bytes, stage_files
        from rebuild_gold_reviews import validate_and_apply
        from rebuild_staging import read_candidate, revise_human_review_candidate

        gold, form = completed_form()
        revised, record_path, record = validate_and_apply(
            ROOT, ROOT / 'agent-eval/data', gold, form)
        gold_path = 'gold/' + gold['id'] + '.json'
        before = {
            gold_path: json_bytes(gold),
            'business/retained.json': b'unchanged',
            'manifests/annotations/retained.json': b'annotation',
            'manifests/source-audit.json': b'{}',
            'manifests/selection.json': b'{}',
        }
        with tempfile.TemporaryDirectory() as directory:
            project = Path(directory)
            original = project / gold['sourceEvidence']['original']
            original.parent.mkdir(parents=True)
            original.write_bytes((ROOT / gold['sourceEvidence']['original']).read_bytes())
            stage_files(project, before)
            after = dict(before)
            after[gold_path] = json_bytes(revised)
            after[record_path] = json_bytes(record)
            result = revise_human_review_candidate(project, before, after)
            self.assertTrue(result['changed'])
            self.assertEqual(after, read_candidate(project))

            tampered = dict(after)
            bad_gold = deepcopy(revised)
            bad_gold['fields']['invoice_number']['normalizedValue'] = 'tampered'
            tampered[gold_path] = json_bytes(bad_gold)
            with self.assertRaises(ValueError):
                revise_human_review_candidate(project, after, tampered)


if __name__ == '__main__':
    unittest.main()
