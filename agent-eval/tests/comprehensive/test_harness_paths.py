"""Current catalogs are authoritative across module and legacy layouts."""
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / 'agent-eval/tools'))
sys.path.insert(0, str(ROOT / 'agent-eval/src'))
from harness_paths import canonical_case_path, list_current_case_paths, resolve_case_path
from runner.materialize import audit, materialize


class HarnessPathTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)

    def write(self, relative, value):
        path = self.root / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(value), encoding='utf-8')
        return path

    def catalog(self, entries):
        self.write('manifests/case-catalog.json', {'cases': entries})

    def case(self, **changes):
        case = {'id': 'runtime-1', 'category': 'runtime', 'harnessModule': 'tools'}
        case.update(changes)
        return case

    def test_module_path_preserves_case_identity_and_legacy_category(self):
        case = self.case()
        path = self.write(canonical_case_path(case), case)
        self.catalog([{'id': case['id'], 'path': canonical_case_path(case)}])
        self.assertEqual(resolve_case_path(self.root, case['id']), path)
        self.assertEqual(list_current_case_paths(self.root), [path])
        self.assertEqual(case['category'], 'runtime')

    def test_legacy_fixture_without_catalog_can_be_resolved(self):
        case = {'id': 'runtime-1', 'category': 'runtime'}
        path = self.write(canonical_case_path(case), case)
        self.assertEqual(resolve_case_path(self.root, case['id']), path)

    def test_catalog_missing_member_never_falls_back_to_glob(self):
        case = self.case()
        self.write(canonical_case_path(case), case)
        self.catalog([])
        self.assertEqual(list_current_case_paths(self.root), [])
        with self.assertRaisesRegex(ValueError, 'not a current catalog member'):
            resolve_case_path(self.root, case['id'])

    def test_missing_catalog_file_target_fails_closed(self):
        case = self.case()
        self.catalog([{'id': case['id'], 'path': canonical_case_path(case)}])
        with self.assertRaisesRegex(ValueError, 'Missing case catalog member'):
            list_current_case_paths(self.root)

    def test_duplicate_catalog_identity_fails_closed(self):
        case = self.case()
        self.write(canonical_case_path(case), case)
        entry = {'id': case['id'], 'path': canonical_case_path(case)}
        self.catalog([entry, entry])
        with self.assertRaisesRegex(ValueError, 'Duplicate'):
            resolve_case_path(self.root, case['id'])

    def test_unsafe_and_mismatched_catalog_paths_fail_closed(self):
        for relative in ('../outside.json', 'cases/../runtime-1.json',
                         'cases/tools/other.json', 'cases\\tools\\runtime-1.json',
                         'C:/cases/runtime-1.json', 'cases//tools/runtime-1.json'):
            with self.subTest(path=relative):
                self.catalog([{'id': 'runtime-1', 'path': relative}])
                with self.assertRaises(ValueError):
                    list_current_case_paths(self.root)

    def test_catalog_identity_and_module_must_match_file(self):
        for case in (self.case(id='wrong'), self.case(harnessModule='sessions')):
            with self.subTest(case=case):
                self.write('cases/tools/runtime-1.json', case)
                self.catalog([{'id': 'runtime-1', 'path': 'cases/tools/runtime-1.json'}])
                with self.assertRaises(ValueError):
                    list_current_case_paths(self.root)

    def test_canonical_path_validates_identity_and_module(self):
        for case in (self.case(id='../escape'), self.case(harnessModule='../escape'),
                     self.case(harnessModule='unknown'), self.case(harnessModule=None)):
            with self.subTest(case=case), self.assertRaises(ValueError):
                canonical_case_path(case)

    def test_audit_uses_module_catalog_and_only_explicit_business_input(self):
        case = self.case(category='matching', familyId='matching/mechanism',
                         version=1, harnessScenarioId='mechanism', inputMode='harness_fixture')
        self.write(canonical_case_path(case), case)
        self.catalog([{'id': case['id'], 'path': canonical_case_path(case)}])
        outcome = {'status': 'materialized', 'input': {}, 'harness': {}, 'limitations': []}
        with patch('runner.materialize.materialize', return_value=outcome):
            report = audit(self.root, data_root=self.root)
        self.assertEqual(report['caseCount'], 1)
        self.assertEqual(report['fixtureCount'], 1)

    def test_scenario_dispatch_precedes_legacy_family_lookup(self):
        import types
        outcome = {'status': 'materialized', 'input': {}, 'harness': {}, 'limitations': []}
        scenario_module = types.SimpleNamespace(materialize_scenario=lambda case: outcome)
        with patch.dict(sys.modules, {'harness_scenarios': scenario_module}):
            self.assertEqual(materialize({'harnessScenarioId': 'mechanism'}), outcome)


if __name__ == '__main__':
    unittest.main()
