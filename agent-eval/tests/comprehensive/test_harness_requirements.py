"""Source identity and provenance tests for the Harness requirement registry."""
import hashlib
from pathlib import Path
import sys
import tempfile
import unittest

PROJECT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(PROJECT / 'agent-eval' / 'tools'))
from invoice_requirements import (  # noqa: E402
    CHAPTER_FOUR_REGISTRY, LEGACY_CRITICAL_REGISTRY, SPEC_PATHS,
    STORAGE_REQUIREMENT_REGISTRY, load_requirements,
)


class HarnessRequirementsTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.spec = (PROJECT / SPEC_PATHS[1]).read_text(encoding='utf-8-sig')
        cls.product = (PROJECT / SPEC_PATHS[0]).read_bytes()
        cls.catalog = load_requirements(PROJECT)

    def parse(self, spec):
        with tempfile.TemporaryDirectory() as directory:
            project = Path(directory)
            for relative, content in ((SPEC_PATHS[0], self.product),
                                      (SPEC_PATHS[1], spec.encode('utf-8'))):
                target = project / relative
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(content)
            return load_requirements(project)

    def indexed(self, catalog=None):
        return {row['id']: row for row in (catalog or self.catalog)['requirements']}

    def test_numbered_chapter_heading_at_every_level_ends_previous_section(self):
        for level in range(1, 7):
            with self.subTest(level=level):
                spec = self.spec.replace('## 4. 评测资产与数据生命周期',
                                         '#' * level + ' 4. 评测资产与数据生命周期')
                result = self.indexed(self.parse(spec))
                self.assertEqual(result['CRIT-4-case-record']['section'], '4')
                self.assertNotIn('CRIT-3.23.4-05', result)
                self.assertEqual({key for key in result if key.startswith('CRIT-3.23.4-')},
                                 {'CRIT-3.23.4-01', 'CRIT-3.23.4-02'})

    def test_unnumbered_headings_end_the_previous_section(self):
        paragraph = self.indexed()['CRIT-3.23.4-02']['source']['verbatim']
        for level in range(1, 7):
            with self.subTest(level=level):
                spec = self.spec.replace('### 3.24 精简存储契约与恢复断言',
                    '#' * level + ' Unnumbered appendix\n\n' + paragraph +
                    '\n\n### 3.24 精简存储契约与恢复断言')
                self.assertEqual(set(self.indexed(self.parse(spec))), set(self.indexed()))

    def test_unrelated_insertion_and_table_formatting_do_not_renumber(self):
        spec = self.spec.replace('#### 3.23.4 评分、可比性与继承',
            '#### 3.23.4 评分、可比性与继承\n\nAn unrelated explanatory paragraph.')
        spec = '\n'.join('  ' + line.replace(' | ', '   |   ')
                         if line.startswith('|') else line for line in spec.splitlines())
        spec = spec.replace('Session生命周期与恢复', '**Session 生命周期与恢复**')
        parsed = self.parse(spec)
        self.assertEqual(set(self.indexed(parsed)), set(self.indexed()))
        self.assertTrue(any(row['verbatim'] == 'An unrelated explanatory paragraph.'
                            for row in parsed['unregisteredPassages']))
        self.assertEqual(self.indexed(parsed)['CRIT-3.24-session-lifecycle']['section'], '3.24')

    def test_new_rows_and_atomic_definitions_are_registered(self):
        index = self.indexed()
        for section, _, slug in STORAGE_REQUIREMENT_REGISTRY:
            with self.subTest(section=section, slug=slug):
                row_id = f'CRIT-{section}-{slug}'
                parent = index[row_id]
                self.assertEqual(parent['section'], section)
                self.assertGreater(len(parent['atomicRequirements']), 1)
                for atomic in parent['atomicRequirements']:
                    self.assertEqual(atomic, index[atomic['id']])
                    self.assertEqual(atomic['kind'], 'atomic')
                    self.assertEqual(atomic['parentRequirementId'], row_id)
                    self.assertEqual(atomic['source'], parent['source'])
                    self.assertTrue(atomic['description'])
                    self.assertEqual(atomic['acceptanceStatus'], 'not_evaluated')

    def test_every_record_preserves_exact_source_and_hash(self):
        raw = (PROJECT / SPEC_PATHS[1]).read_bytes()
        lines = raw.decode('utf-8-sig').splitlines()
        expected_hash = hashlib.sha256(raw).hexdigest()
        for requirement in self.catalog['requirements']:
            with self.subTest(requirement=requirement['id']):
                source = requirement['source']
                self.assertEqual(source['sha256'], expected_hash)
                self.assertEqual(source['path'], SPEC_PATHS[1])
                self.assertEqual(source['lineStart'], source['lineEnd'])
                self.assertEqual(source['verbatim'], lines[source['lineStart'] - 1])
                self.assertEqual(requirement['productSpec']['sha256'],
                                 hashlib.sha256(self.product).hexdigest())

    def test_existing_critical_ids_remain_bound_to_their_sections(self):
        index = self.indexed()
        for section, _, identity in LEGACY_CRITICAL_REGISTRY:
            self.assertEqual(index[identity]['section'], section)

    def test_aliases_correct_chapter_four_and_retire_only_the_header(self):
        index = self.indexed()
        aliases = {row['oldId']: row for row in self.catalog['requirementAliases']}
        self.assertEqual(set(aliases), {f'CRIT-3.23.4-{i:02d}' for i in range(3, 15)})
        for identity, alias in aliases.items():
            self.assertNotIn(identity, index)
            self.assertTrue(alias['reason'])
            if identity == 'CRIT-3.23.4-04':
                self.assertEqual(alias['status'], 'retired')
                self.assertIsNone(alias['requirementId'])
            else:
                self.assertEqual(alias['status'], 'migrated')
                self.assertEqual(index[alias['requirementId']]['section'], '4')
        self.assertEqual(aliases['CRIT-3.23.4-13']['requirementId'], 'CRIT-4-gold-authority')
        self.assertEqual(aliases['CRIT-3.23.4-14']['requirementId'], 'CRIT-4-phased-preparation')
        for section, _, slug in CHAPTER_FOUR_REGISTRY:
            self.assertEqual(index[f'CRIT-{section}-{slug}']['section'], section)

    def test_registry_detects_missing_and_replaced_identities_not_just_counts(self):
        with self.assertRaisesRegex(ValueError, 'MOD catalog changed'):
            self.parse(self.spec.replace('| MOD-01 ', '| MOD-99 ', 1))
        row = self.indexed()['CRIT-3.24-native-memory']['source']['verbatim']
        with self.assertRaisesRegex(ValueError, 'CRIT-3.24-native-memory'):
            self.parse(self.spec.replace(row, ''))
        old = self.indexed()['CRIT-3.6.1-01']['source']['verbatim']
        with self.assertRaisesRegex(ValueError, 'CRIT-3.6.1-01'):
            self.parse(self.spec.replace(old, ''))

    def test_duplicate_source_identity_fails_instead_of_silently_discarding(self):
        row = self.indexed()['CRIT-3.24-native-memory']['source']['verbatim']
        with self.assertRaisesRegex(ValueError, 'Duplicate requirement identity'):
            self.parse(self.spec.replace(row, row + '\n' + row))

    def test_cross_cutting_normative_paragraphs_are_registered(self):
        index=self.indexed()
        for identity in ('CRIT-3.6.1-coverage-accounting','CRIT-3.6.1-evidence-authority',
                         'CRIT-3.23.1-database-isolation-contract'):
            self.assertEqual(index[identity]['kind'],'critical')
            self.assertTrue(index[identity]['source']['verbatim'])
        self.assertEqual(self.catalog['unregisteredPassages'],[])


if __name__ == '__main__':
    unittest.main()
