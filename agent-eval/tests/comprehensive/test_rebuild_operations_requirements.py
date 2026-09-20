"""The Operations requirement correction is atomic and does not grant results."""
import json
from pathlib import Path
import sys
import unittest

ROOT = Path(__file__).resolve().parents[3]
sys.path[:0] = [str(ROOT / 'agent-eval/tools'), str(ROOT / 'agent-eval/src')]


class OperationsRequirementRevisionTests(unittest.TestCase):
    def test_in_memory_revision_has_exact_refs_and_preserves_base_assets(self):
        from rebuild_bindings import CURRENT_BINDING_REVISION
        from rebuild_operations_requirements import build_revision
        from rebuild_staging import read_candidate
        before = read_candidate(ROOT)
        after = build_revision(ROOT, before)
        for prefix in ('gold/', 'business/'):
            self.assertEqual({p: raw for p, raw in before.items() if p.startswith(prefix)},
                             {p: raw for p, raw in after.items() if p.startswith(prefix)})
        operations = [json.loads(raw) for path, raw in after.items()
                      if path.startswith('cases/operations/')]
        p13 = [case for case in operations if case['stage'] == 'P13']
        self.assertEqual(len(p13), 28)
        for case in p13:
            authored = 3 if case['id'] == 'fresh-ops-release-revoked' else 2
            self.assertEqual(authored * 1000 + CURRENT_BINDING_REVISION,
                             case['version'])
            self.assertEqual(authored,
                             case['provenance']['authoredVersion'])
        refs = {ref for case in p13 for ref in case['episode']['initialState']['runtimeRefs']}
        self.assertNotIn('RTC-15', refs)
        self.assertNotIn('RTC-16', refs)
        coverage = json.loads(after['manifests/coverage.json'])
        self.assertEqual(coverage['counts']['explicitlyLinkedRequirements'], 10)
        self.assertEqual(coverage['counts']['invalidOrBroadRequirementReferences'], 0)
        report = json.loads(after['manifests/preparation-report.json'])
        self.assertEqual(report['actualProductRuns'], 0)
        self.assertFalse(report['formalAcceptanceEligible'])


if __name__ == '__main__':
    unittest.main()
