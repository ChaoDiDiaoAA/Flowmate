"""Source rebinding is a candidate revision, never content approval."""
import json
from pathlib import Path
import sys
import unittest

ROOT = Path(__file__).resolve().parents[3]
sys.path[:0] = [str(ROOT / 'agent-eval/tools'), str(ROOT / 'agent-eval/src')]

class SourceRevisionTests(unittest.TestCase):
    def test_current_candidate_remains_verifiable_after_authorized_revisions(self):
        """The migration receipt must survive later replayable annotation revisions."""
        from rebuild_dataset import verify_asset_snapshot
        from rebuild_staging import read_candidate
        checked = verify_asset_snapshot(ROOT, read_candidate(ROOT))
        self.assertEqual(checked['imageAnnotatedGold'], 100)
        self.assertEqual(checked['humanVerifiedGold'], 0)

    def test_actions_are_registered_for_public_materialization(self):
        from rebuild_fixtures import registered_scenarios
        scenarios = registered_scenarios()
        self.assertEqual(sum(s['module'] == 'actions' for s in scenarios.values()), 68)
        self.assertEqual(len(scenarios), 448)

    def test_higher_authored_case_revision_is_allowed_but_same_version_tampering_is_not(self):
        from rebuild_dataset import json_bytes, verify_asset_snapshot
        from rebuild_source_revision import reindex
        from rebuild_staging import read_candidate
        current = read_candidate(ROOT)
        checked = verify_asset_snapshot(ROOT, current)
        self.assertEqual(checked['casesPrepared'], 548)

        path = 'cases/actions/fresh-act-submit-distinct-objects.json'
        damaged = dict(current)
        case = json.loads(damaged[path])
        check = next(x for x in case['oracle']['checks'] if x['checkId'].endswith(':submit-request-count'))
        check['assertion']['value'] = 3
        damaged[path] = json_bytes(case)
        reindex(damaged)
        with self.assertRaisesRegex(
                ValueError, 'authored source revision|higher current-binding author revision|normal control dependency|changed asset semantics'):
            verify_asset_snapshot(ROOT, damaged)

    def test_explicit_revision_preserves_bases_and_is_currently_verifiable(self):
        from rebuild_staging import read_candidate, snapshot_digest
        from rebuild_dataset import verify_asset_snapshot
        current = read_candidate(ROOT)
        receipt = json.loads(current['manifests/spec-binding-review.json'])
        history = ROOT / receipt['historyPath']
        previous = {p.relative_to(history).as_posix(): p.read_bytes()
                    for p in history.rglob('*') if p.is_file()}
        self.assertEqual(snapshot_digest(previous), receipt['previousCandidateSha256'])
        self.assertEqual({k:v for k,v in previous.items() if k.startswith('gold/')},
                         {k:v for k,v in current.items() if k.startswith('gold/')})
        for path, data in previous.items():
            if path.startswith('business/'):
                before, after = json.loads(data), json.loads(current[path])
                self.assertEqual(before['input'], after['input'])
                self.assertGreater(after['version'], before['version'])
                self.assertEqual(after['creationSpecRefs'], before['creationSpecRefs'])
        checked = verify_asset_snapshot(ROOT, current)
        self.assertEqual(checked['casesPrepared'], 548)
        self.assertTrue(checked['completeCaseBudget'])
        self.assertFalse(checked['formalAcceptanceEligible'])
        readiness = json.loads(current['manifests/readiness.json'])
        self.assertEqual(readiness['acceptanceFreeze'], 'blocked')
        self.assertNotIn('cross_split_near_duplicate_001897_001903',
                         [x['id'] for x in readiness['blockers']])
        selection = json.loads(current['manifests/selection.json'])
        self.assertEqual(selection['status'], 'selected_set_source_relationship_review_complete')
        from runner.materialize import materialize
        from harness_paths import canonical_case_path
        counts = {}
        for path, raw in current.items():
            if not path.startswith('cases/'): continue
            case = json.loads(raw)
            self.assertEqual(path, canonical_case_path(case))
            counts[case['harnessModule']] = counts.get(case['harnessModule'], 0) + 1
            business = json.loads(current[case['businessRef']['path']]) if 'businessRef' in case else None
            result = materialize(case, business, product_root=ROOT/'data/invoices/voxel51')
            self.assertEqual(result['status'], 'materialized', (case['id'], result))
            self.assertFalse(result['fixtureValidation']['actualProductRun'])
        from rebuild_dataset import MODULE_BUDGETS
        self.assertEqual(counts, MODULE_BUDGETS)

if __name__ == '__main__': unittest.main()
