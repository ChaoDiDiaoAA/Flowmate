"""Runtime contract correction is atomic and preserves the approved budgets."""
import json
from pathlib import Path
import sys
import unittest

ROOT = Path(__file__).resolve().parents[3]
sys.path[:0] = [str(ROOT / 'agent-eval/tools'), str(ROOT / 'agent-eval/src')]


class RuntimeContractRevisionTests(unittest.TestCase):
    def test_in_memory_revision_preserves_assets_and_revises_only_authored_cases(self):
        from rebuild_bindings import CURRENT_BINDING_REVISION
        from rebuild_runtime_contracts import REVISED_KEYS, REVISED_VERSIONS, build_revision
        from rebuild_staging import read_candidate
        before = read_candidate(ROOT)
        after = build_revision(ROOT, before)
        for prefix in ('gold/', 'business/'):
            self.assertEqual({p: raw for p, raw in before.items() if p.startswith(prefix)},
                             {p: raw for p, raw in after.items() if p.startswith(prefix)})
        cases = {json.loads(raw)['id']: json.loads(raw) for path, raw in after.items()
                 if path.startswith('cases/')}
        self.assertEqual(len(cases), 548)
        self.assertEqual(set(cases) & REVISED_KEYS, REVISED_KEYS)
        for identity in REVISED_KEYS:
            self.assertEqual(cases[identity]['version'],
                             REVISED_VERSIONS[identity] * 1000 + CURRENT_BINDING_REVISION)
            self.assertEqual(cases[identity]['provenance']['authoredVersion'],
                             REVISED_VERSIONS[identity])
        report = json.loads(after['manifests/preparation-report.json'])
        self.assertEqual(report['casesPreparedInThisStep'], 548)
        self.assertEqual(report['actualProductRuns'], 0)
        self.assertFalse(report['formalAcceptanceEligible'])
        coverage = json.loads(after['manifests/coverage.json'])
        self.assertEqual(coverage['counts']['invalidOrBroadRequirementReferences'], 0)


if __name__ == '__main__':
    unittest.main()
