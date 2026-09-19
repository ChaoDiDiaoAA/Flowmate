"""Non-sensitive benchmark contracts; no product or model execution."""
import hashlib
import json
from pathlib import Path
import unittest
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[2]
DIRECTORY = ROOT / 'agent-eval' / 'benchmarks'
ACTIVE = {f'BM-{n:02}' for n in range(1, 13) if n != 6}
sys.path.insert(0, str(ROOT / 'agent-eval' / 'tools'))
from invoice_requirements import load_requirements  # noqa: E402


class BenchmarkDefinitionTests(unittest.TestCase):
    def test_generator_refuses_to_overwrite_frozen_definition(self):
        from benchmark_definitions import generate
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            target = root/'agent-eval/benchmarks/BM-01/definition.json'
            target.parent.mkdir(parents=True)
            target.write_text('{"status":"frozen"}', encoding='utf-8')
            with self.assertRaisesRegex(ValueError, 'frozen'):
                generate(root)
            self.assertEqual(target.read_text(encoding='utf-8'), '{"status":"frozen"}')

    def definitions(self):
        return {p.parent.name: json.loads(p.read_text(encoding='utf-8'))
                for p in DIRECTORY.glob('BM-*/definition.json')}

    def test_catalog_has_eleven_current_candidates_and_retired_six(self):
        catalog = json.loads((DIRECTORY / 'catalog.json').read_text(encoding='utf-8'))
        self.assertEqual({r['benchmarkId'] for r in catalog['benchmarks']}, ACTIVE)
        self.assertEqual((catalog['schemaVersion'], catalog['version'], catalog['status']),
                         (3, 2, 'candidate'))
        self.assertEqual(catalog['retired'][0]['benchmarkId'], 'BM-06')
        self.assertFalse((DIRECTORY / 'BM-06').exists())
        self.assertEqual(set(self.definitions()), ACTIVE)

    def test_shared_contract_and_current_source(self):
        for bid, definition in self.definitions().items():
            with self.subTest(benchmark=bid):
                self.assertEqual(definition['schemaVersion'], 3)
                self.assertEqual(definition['benchmarkId'], bid)
                self.assertEqual(definition['version'], 2)
                self.assertEqual(definition['status'], 'candidate')
                self.assertEqual(definition['membershipRule'], 'schema3_direct_check_mapping')
                self.assertEqual(definition['membersRef'], f'manifests/benchmarks/{bid}/members.json')
                for key in ('inputContract', 'outputContract', 'executionProtocol',
                            'gradingProtocol', 'comparisonProtocol', 'coverageRequirements'):
                    self.assertTrue(definition[key], key)
                for source in definition['sourceRefs']:
                    self.assertEqual(hashlib.sha256((ROOT / source['path']).read_bytes()).hexdigest(),
                                     source['sha256'])
                self.assertEqual({s['purpose'] for s in definition['subsets']},
                                 {'capability', 'regression'})
                self.assertEqual(definition['lifecycle']['execution']['runCount'], 0)
                self.assertEqual(definition['baselineRefs'], [])
                self.assertEqual(definition['lifecycle']['readiness']['status'], 'blocked')
                self.assertIsNone(definition['executionProtocol']['frozenConfig']['model'])
                self.assertIsNone(definition['executionProtocol']['frozenConfig']['k'])

    def test_coverage_is_explicit_and_machine_selectable(self):
        for bid, definition in self.definitions().items():
            seen = set()
            for row in definition['coverageRequirements']:
                self.assertNotIn(row['id'], seen)
                seen.add(row['id'])
                self.assertTrue(row['title'])
                self.assertTrue(row['source'])
                self.assertIn(row['obligation'], {'required_when_applicable', 'exploratory'})
                self.assertEqual(set(row['caseCriteria']), {'families', 'requirementRefs', 'assertionPaths'})
                self.assertNotIn('*', json.dumps(row['caseCriteria']))
                self.assertIn('contentReviewRequired', row)

    def test_normative_scopes_do_not_reuse_legacy_family_membership(self):
        self.assertFalse((DIRECTORY / 'family-mapping.json').exists())
        self.assertFalse((DIRECTORY / 'mapping-audit.md').exists())
        for bid, definition in self.definitions().items():
            for row in definition['coverageRequirements']:
                with self.subTest(benchmark=bid, requirement=row['id']):
                    self.assertEqual(row['caseCriteria'], {
                        'families': [], 'requirementRefs': [], 'assertionPaths': []})
                    self.assertEqual(row['coverageStatus'],
                                     'atomic_condition_review_pending')

    def test_runtime_protocol_enumerates_each_normative_rtc_and_rtx(self):
        definitions = self.definitions()
        required = {r['id'] for r in load_requirements(ROOT)['requirements']
                    if r['id'].startswith(('RTC-', 'RTX-'))}
        actual = {row['id'].upper() for bid in ('BM-11', 'BM-12')
                  for row in definitions[bid]['coverageRequirements']
                  if row['id'].startswith(('rtc-', 'rtx-'))}
        self.assertEqual(actual, required)

    def test_observation_requires_frozen_schema_without_fake_samples_or_writes(self):
        d = self.definitions()['BM-10']
        self.assertEqual(d['kind'], 'observational')
        protocol = d['observationProtocol']
        for key in ('population', 'window', 'inclusionExclusion', 'sampling',
                    'candidateExposure', 'environment', 'humanComparison',
                    'outcomes', 'costAndLatency', 'unknownBacklog'):
            self.assertTrue(protocol['requiredSchema'][key])
            self.assertIsNone(protocol['frozenConfig'][key])
        self.assertEqual(protocol['samples'], [])
        self.assertFalse(protocol['productionWritesAllowed'])
        self.assertFalse(protocol['repeatBusinessForComparison'])

    def test_action_environments_are_separate_and_production_is_readonly(self):
        d = self.definitions()['BM-05']
        self.assertTrue({'P12-A', 'P12-B', 'P12-C'}.issubset(
            {r['id'] for r in d['executionProtocol']['environmentVariants']}))
        self.assertEqual(d['executionProtocol']['productionPolicy'], 'read_only_evidence_association')

    def test_readmes_explain_stage_and_contract_boundaries(self):
        for bid in ACTIVE:
            content = (DIRECTORY / bid / 'README.md').read_text(encoding='utf-8')
            for heading in ('输入', '输出', '证据', '指标', '冻结', '阻塞'):
                self.assertIn(heading, content)


if __name__ == '__main__':
    unittest.main()
