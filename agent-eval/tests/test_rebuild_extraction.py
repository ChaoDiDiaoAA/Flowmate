from copy import deepcopy
from pathlib import Path
import hashlib
import json
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'agent-eval/tools'))
sys.path.insert(0, str(ROOT / 'agent-eval/src'))
from rebuild_contracts import load_spec_contracts
from rebuild_sources import draft_gold
from rebuild_extraction import build_extraction_cases


class FreshExtractionTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.contracts = load_spec_contracts(ROOT)

    def gold(self):
        pins = [{'path': 'sample/' + name, 'sha256': char * 64, 'bytes': 100}
                for name, char in [('original.jpg', 'a'), ('content.json', 'b'), ('metadata.json', 'c'),
                                   ('assets/images/table.jpg', 'd')]]
        return draft_gold('sample', [{'text': 'Invoice Number: SENSITIVE-ANSWER', 'page_idx': 0}],
                          'acceptance', 'group-sample', pins)

    def test_whole_invoice_preserves_split_and_pending_gold_without_leaking_answers(self):
        gold = self.gold()
        case = build_extraction_cases([gold], self.contracts)[0]
        self.assertEqual(case['split'], 'acceptance')
        self.assertEqual(case['leakageGroup'], gold['leakageGroup'])
        self.assertEqual(case['stage'], 'P2')
        self.assertEqual(len(case['oracle']['checks']), 4)
        self.assertEqual({c['metricId'] for c in case['oracle']['checks']},
                         {'MOD-11.fields', 'MOD-11.lines', 'MOD-11.evidence', 'MOD-11.uncertainty'})
        self.assertFalse(case['formalAcceptanceEligible'])
        self.assertFalse(case['humanVerified'])
        self.assertNotIn('SENSITIVE-ANSWER', str(case))
        self.assertEqual(len(case['inputAssets']), 2)
        self.assertFalse(any('original.jpg' in p['path'] or 'metadata.json' in p['path'] for p in case['inputAssets']))
        self.assertTrue(all(c['ruleStatus'] == 'implemented' for c in case['oracle']['checks']))
        from rebuild_bindings import CURRENT_BINDING_REVISION
        self.assertEqual(case['version'], 3000 + CURRENT_BINDING_REVISION)
        self.assertEqual(case['scoring']['implementationStatus'], 'available')
        self.assertNotIn('schema3_field_and_line_grader', case['executionEligibility']['missing'])

    def test_duplicate_original_is_not_more_coverage(self):
        gold = self.gold()
        with self.assertRaisesRegex(ValueError, 'Duplicate'):
            build_extraction_cases([gold, deepcopy(gold)], self.contracts)
        second = deepcopy(gold)
        second.update(sampleId='other', id='gold-fresh-other')
        for pin in second['sourceSnapshot']:
            pin['path'] = pin['path'].replace('sample/', 'other/')
        with self.assertRaisesRegex(ValueError, 'Repeated original'):
            build_extraction_cases([gold, second], self.contracts)

    def test_legacy_answer_or_source_escape_cannot_enter_new_case(self):
        for mutation in ('legacy', 'escape', 'missing-parse'):
            gold = self.gold()
            if mutation == 'legacy':
                gold['provenance']['legacyAnswersRead'] = True
            elif mutation == 'escape':
                gold['sourceSnapshot'][0]['path'] = 'sample/../../secret'
            else:
                gold['sourceSnapshot'] = [p for p in gold['sourceSnapshot'] if not p['path'].endswith('content.json')]
            with self.assertRaises(ValueError):
                build_extraction_cases([gold], self.contracts)

    def test_new_answer_revision_changes_quality_pin_not_product_input(self):
        gold = self.gold()
        before = build_extraction_cases([gold], self.contracts)[0]
        gold['fields']['invoice_number']['candidates'][0]['rawValue'] = 'revised candidate'
        after = build_extraction_cases([gold], self.contracts)[0]
        self.assertNotEqual(before['oracle']['fieldGoldSha256'], after['oracle']['fieldGoldSha256'])
        self.assertEqual(before['inputAssets'], after['inputAssets'])
        self.assertEqual(before['semanticScenarioKey'], after['semanticScenarioKey'])

    def source_fixture(self, root):
        raw = {'original.jpg': b'original-private-to-quality',
               'content.json': json.dumps([{'type': 'image', 'page_idx': 0,
                                            'img_path': 'assets/images/table.jpg'}]).encode(),
               'assets/images/table.jpg': b'parsed-local-image'}
        pins = []
        for name, data in raw.items():
            path = root / 'sample' / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(data)
            pins.append({'path': 'sample/' + name, 'sha256': hashlib.sha256(data).hexdigest(), 'bytes': len(data)})
        gold = self.gold()
        gold['sourceSnapshot'] = pins
        return build_extraction_cases([gold], self.contracts)[0]

    def test_public_projection_reads_only_pinned_parse_and_local_images(self):
        from runner.materialize import materialize
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            case = self.source_fixture(root)
            case['oracle']['fieldGoldRef'] = 'do-not-read-this-secret.json'
            result = materialize(case, product_root=root)
            self.assertEqual(result['status'], 'materialized', result)
            self.assertEqual(len(result['input']['document']['parsedContent']), 1)
            self.assertEqual(set(result['input']['document']['assets']), {'assets/images/table.jpg'})
            self.assertNotIn('original-private-to-quality', str(result))
            self.assertNotIn('fieldGoldRef', str(result))
            self.assertFalse(result['fixtureValidation']['oracleRead'])
            self.assertEqual(result['harness']['executionStatus'], 'NOT_RUN')

    def test_projection_rejects_tampered_bytes_and_unapproved_inputs(self):
        from runner.materialize import materialize
        for mutation in ('hash', 'traversal', 'original', 'unknown-mode', 'missing-root',
                         'malformed-protocol', 'missing-file', 'boolean-version'):
            with tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                case = self.source_fixture(root)
                if mutation == 'hash':
                    (root / 'sample/content.json').write_text('[]')
                elif mutation == 'traversal':
                    case['inputAssets'][0]['path'] = 'data/invoices/voxel51/sample/../../secret'
                elif mutation == 'original':
                    case['inputAssets'][0]['path'] = 'data/invoices/voxel51/sample/original.jpg'
                elif mutation == 'unknown-mode':
                    case['inputMode'] = 'all-quality-data'
                elif mutation == 'malformed-protocol':
                    case['scenarioProtocol'] = 'fresh_invoice_extraction'
                elif mutation == 'missing-file':
                    (root / 'sample/assets/images/table.jpg').unlink()
                elif mutation == 'boolean-version':
                    case['version'] = True
                result = materialize(case, product_root=None if mutation == 'missing-root' else root)
                self.assertEqual(result['status'], 'unsupported', (mutation, result))
                self.assertEqual(result['input'], {})

    def test_public_audit_supplies_source_root_for_fresh_extraction(self):
        from runner.materialize import audit
        with tempfile.TemporaryDirectory() as directory:
            project = Path(directory)
            case = self.source_fixture(project / 'data/invoices/voxel51')
            quality = project / 'data/.preparation-stage/rebuild'
            path = quality / 'cases/agent-runtime' / (case['id'] + '.json')
            path.parent.mkdir(parents=True)
            path.write_text(json.dumps(case), encoding='utf-8')
            report = audit(project, data_root=quality)
            self.assertEqual(report['caseCount'], 1)
            self.assertEqual(report['fixtureCount'], 1, report)
            self.assertEqual(report['actualProductRuns'], 0)
            self.assertEqual(report['unsupportedFamilies'], {})
            (project / 'data/invoices/voxel51/sample/assets/images/table.jpg').unlink()
            blocked = audit(project, data_root=quality)
            self.assertEqual(blocked['fixtureCount'], 0)
            self.assertEqual(blocked['unsupportedFamilies'], {case['familyId']: 1})


if __name__ == '__main__':
    unittest.main()
