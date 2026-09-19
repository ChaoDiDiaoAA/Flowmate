import json
from pathlib import Path
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
sys.path[:0] = [str(ROOT / 'agent-eval/tools'), str(ROOT / 'agent-eval/src')]
from rebuild_benchmarks import build_bundle, close_dependencies, load_cases, pin
from rebuild_dataset import json_bytes
from rebuild_staging import read_candidate


class FreshBenchmarkTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.snapshot = read_candidate(ROOT)
        cls.bundle = build_bundle(ROOT, cls.snapshot)
        cls.cases = load_cases(cls.snapshot)
        cls.full = dict(cls.snapshot) | cls.bundle
        index = json.loads(cls.bundle['manifests/benchmarks/index.json'])
        cls.full['manifests/views.json'] = json_bytes({'schemaVersion': 3, 'benchmarks': {
            r['benchmarkId']: {'membersRef': r['membersRef'], 'selection': 'direct_members_only',
                              'counts': r['counts']} for r in index['benchmarks']}})
        report = json.loads(cls.full['manifests/preparation-report.json'])
        if 'benchmarks' in report:
            report['benchmarks']['indexRef'] = pin('manifests/benchmarks/index.json',
                                                  cls.bundle['manifests/benchmarks/index.json'])
            cls.full['manifests/preparation-report.json'] = json_bytes(report)
        cls.full['manifests/inventory.json'] = json_bytes({'schemaVersion': 3, 'files': [
            pin(p, raw) for p, raw in sorted(cls.full.items()) if p != 'manifests/inventory.json']})

    def test_all_eleven_have_direct_checks_and_closed_pinned_dependencies(self):
        index = json.loads(self.bundle['manifests/benchmarks/index.json'])
        self.assertEqual(len(index['benchmarks']), 11)
        self.assertEqual(index['retired'], ['BM-06'])
        for entry in index['benchmarks']:
            members = json.loads(self.bundle[entry['membersRef']['path']])
            self.assertEqual(members['facilityCasesExcluded'], 28)
            by_id = {m['caseId']: m for m in members['members']}
            self.assertEqual(len(by_id), len(members['members']))
            self.assertFalse(members['completeRequirementCoverage'])
            for m in by_id.values():
                case = self.cases[m['caseId']][0]
                checks = {c['checkId'] for c in case['oracle']['checks']}
                self.assertTrue(set(m['checkIds']).issubset(checks))
                self.assertTrue({c['checkId'] for c in case['oracle']['checks']
                    if c.get('required') or c.get('hardConstraint')}.issubset(m['guardCheckIds']))
                for key in ('normalControlRefs', 'comparisonRefs'):
                    self.assertTrue(all(r['caseId'] in by_id for r in m[key]))
                self.assertNotEqual(m['harnessModule'], 'eval-infrastructure')
        one = json.loads(self.bundle['manifests/benchmarks/BM-01/members.json'])
        self.assertEqual(one['counts']['caseCount'], 100)
        self.assertEqual(one['counts']['originalInvoiceCount'], 100)

    def test_bm10_has_protocol_but_zero_samples_and_no_run(self):
        definition = json.loads(self.bundle['manifests/benchmarks/BM-10/definition.json'])
        self.assertEqual(definition['observationProtocol']['samples'], [])
        self.assertEqual(definition['kind'], 'observational')
        self.assertEqual(json.loads(self.bundle['manifests/benchmarks/BM-10/members.json'])['members'], [])
        self.assertEqual(definition['lifecycle']['execution']['runCount'], 0)

    def test_rebuilding_same_inputs_changes_no_bytes(self):
        self.assertEqual(build_bundle(ROOT, self.full), self.bundle)
        self.assertEqual({p: v for p,v in self.full.items() if p.startswith(('gold/', 'business/', 'cases/'))},
                         {p: v for p,v in self.snapshot.items() if p.startswith(('gold/', 'business/', 'cases/'))})

    def test_corrupt_source_case_or_dependency_refused(self):
        broken = dict(self.snapshot)
        path = next(p for p in broken if p.startswith('cases/'))
        broken[path] += b' '
        with self.assertRaisesRegex(ValueError, 'inventory drift'):
            build_bundle(ROOT, broken)
        m = {'source': {'split':'development','stage':'P2',
                       'normalControlRefs':[{'caseId':'absent','version':1,'caseSha256':'x'}],
                       'comparisonRefs':[]}}
        with self.assertRaisesRegex(ValueError, 'Missing dependency'):
            close_dependencies(m, self.cases, self.snapshot)

    def test_actual_runner_assembles_controls_without_product_execution(self):
        from runner.benchmarks import assemble
        with tempfile.TemporaryDirectory(dir=ROOT / '.cache') as temp:
            quality = Path(temp)
            for path, raw in self.full.items():
                dest = quality / path
                dest.parent.mkdir(parents=True, exist_ok=True)
                dest.write_bytes(raw)
            result = assemble(ROOT, 'BM-08', stage='P2', split='development', data_root=quality)
            self.assertTrue(result['validation']['valid'])
            self.assertGreater(result['plannedCount'], 0)
            self.assertEqual(result['plannedCount'], result['materializedCount'])
            self.assertEqual(result['actualProductRuns'], 0)
            self.assertFalse(result['formalAcceptanceEligible'])
            for row in result['members']:
                self.assertEqual(row['status'], 'NOT_RUN')
                self.assertTrue(row['blockers'])
                self.assertNotIn('grading', row['fixture']['input'])
                self.assertNotIn('oracle', row['fixture']['input'])
            for kwargs in ({'stage':'P99'}, {'profile':{'invented':True}}, {'profile':{'k':True}}):
                with self.assertRaises(ValueError):
                    assemble(ROOT, 'BM-08', data_root=quality, **kwargs)
            path = quality / 'manifests/benchmarks/BM-08/members.json'
            raw = json.loads(path.read_bytes());raw['members'][0]['checkIds'] = []
            path.write_bytes(json_bytes(raw))
            with self.assertRaises(ValueError):
                assemble(ROOT, 'BM-08', data_root=quality)


if __name__ == '__main__':
    unittest.main()
