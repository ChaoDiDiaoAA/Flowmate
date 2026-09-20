"""Requirement coverage is explicit, reproducible and does not overclaim."""
import json
from pathlib import Path
import sys
import unittest

ROOT = Path(__file__).resolve().parents[3]
sys.path[:0] = [str(ROOT / 'agent-eval/tools'), str(ROOT / 'agent-eval/src')]


class CoverageReviewTests(unittest.TestCase):
    def test_current_inventory_reports_direct_links_and_real_gaps(self):
        from rebuild_coverage_review import (COVERAGE, REQUIREMENTS, REVIEW_QUEUE,
                                             validate_snapshot)
        from rebuild_staging import read_candidate
        snapshot = read_candidate(ROOT)
        validate_snapshot(ROOT, snapshot)
        requirements = json.loads(snapshot[REQUIREMENTS])
        coverage = json.loads(snapshot[COVERAGE])
        queue = json.loads(snapshot[REVIEW_QUEUE])
        self.assertEqual(len(requirements['requirements']), 330)
        self.assertEqual(requirements['unregisteredPassages'], [])
        self.assertEqual(coverage['counts']['cases'], 548)
        self.assertEqual(coverage['counts']['checks'], 2254)
        self.assertEqual(coverage['counts']['definedMetrics'], 121)
        self.assertEqual(coverage['counts']['directCheckMetrics'], 93)
        self.assertEqual(coverage['counts']['derivedReportMetrics'], 28)
        self.assertEqual(coverage['counts']['explicitlyLinkedRequirements'], 10)
        self.assertEqual(coverage['counts']['invalidOrBroadRequirementReferences'], 0)
        self.assertEqual(coverage['invalidOrBroadRequirementReferences'], [])
        self.assertNotIn('invalid_or_broad_requirement_references',
                         {row['id'] for row in coverage['knownGaps']})
        self.assertEqual(coverage['actualProductRuns'], 0)
        self.assertFalse(coverage['formalAcceptanceEligible'])
        atomic = [row for row in coverage['requirements'] if row['kind'] == 'atomic']
        critical = [row for row in coverage['requirements'] if row['kind'] == 'critical']
        self.assertTrue(all(not row['explicitCaseLinks'] for row in atomic + critical))
        self.assertEqual(queue['counts']['requirements'], 330)
        self.assertEqual(queue['counts']['blockingPriorityRequirements'], 172)
        self.assertEqual(queue['counts']['reviewedRequirementMappings'], 21)
        self.assertEqual(queue['counts']['partiallyReviewedRequirementMappings'], 10)
        self.assertEqual(queue['counts']['reviewedSourceCandidateChecks'], 22)
        self.assertEqual(queue['counts']['acceptedPartialCheckLinks'], 37)
        self.assertEqual(queue['counts']['exactIdentifierCheckLinks'], 85)
        self.assertEqual(queue['counts']['reviewedExactCandidateChecks'], 85)
        self.assertEqual(queue['counts']['acceptedDirectCheckLinks'], 70)
        self.assertEqual(queue['counts']['sourceAnchorCandidateRequirements'], 5)
        self.assertEqual(queue['counts']['sourceAnchorCandidateChecks'], 22)
        self.assertEqual(queue['counts']['sourcePlanConflicts'], 0)
        self.assertEqual(sum(row['reviewDecision'] == 'pending'
                             for row in queue['requirements']), 299)
        self.assertEqual(sum(row['reviewDecision'] == 'reviewed_partial_coverage'
                             for row in queue['requirements']), 10)
        self.assertEqual(sum(row['reviewDecision'] == 'reviewed_full_coverage_mapping'
                             for row in queue['requirements']), 21)
        self.assertTrue(all(row['acceptanceStatus'] == 'not_evaluated'
                            for row in queue['requirements']))
        sampling = next(row for row in queue['requirements']
                        if row['requirementId'] == 'CRIT-4.1-sampling-isolation')
        self.assertEqual(sampling['reviewDecision'], 'reviewed_partial_coverage')
        self.assertEqual(len(sampling['reviewedPartialCheckLinks']), 5)
        self.assertTrue(sampling['missingConditions'])
        self.assertNotIn('sourcePlanConflict', sampling)
        cursor = next(row for row in queue['requirements']
                      if row['requirementId'] == 'CRIT-3.24-persistence-binding/cursor-version')
        self.assertEqual(cursor['reviewDecision'], 'reviewed_full_coverage_mapping')
        self.assertEqual(len(cursor['reviewedDirectCheckLinks']), 1)
        child_slot = next(row for row in queue['requirements']
                          if row['requirementId'] ==
                          'CRIT-3.24-child-delegation/slot-identity')
        self.assertEqual(child_slot['reviewDecision'],
                         'reviewed_full_coverage_mapping')
        self.assertEqual(len(child_slot['reviewedDirectCheckLinks']), 3)
        immutable_run = next(row for row in queue['requirements']
                             if row['requirementId'] ==
                             'CRIT-3.24-manifest-binding/immutable-run')
        self.assertEqual(immutable_run['reviewDecision'],
                         'reviewed_full_coverage_mapping')
        self.assertEqual(len(immutable_run['reviewedDirectCheckLinks']), 4)
        manifest_guard = next(row for row in queue['requirements']
                              if row['requirementId'] ==
                              'CRIT-3.24-manifest-binding/hash-and-ownership')
        self.assertEqual(manifest_guard['reviewDecision'],
                         'reviewed_partial_coverage')
        self.assertEqual(len(manifest_guard['reviewedPartialCheckLinks']), 3)
        self.assertTrue(manifest_guard['missingConditions'])

        cases = {case['id']: case for case in (
            json.loads(raw) for path, raw in snapshot.items() if path.startswith('cases/'))}
        checks = {check['checkId'] for case in cases.values()
                  for check in case['oracle']['checks']}
        for row in queue['requirements']:
            for candidate in row['sourceAnchorCandidates']:
                self.assertIn(candidate['caseId'], cases)
                self.assertIn(candidate['checkId'], checks)
                self.assertEqual(candidate['matchKind'], 'same_spec_path_and_exact_source_line')
                self.assertEqual(candidate['reviewStatus'], 'candidate_not_accepted')
                if row['reviewDecision'] == 'reviewed_partial_coverage':
                    self.assertEqual(candidate['contentReviewDecision'],
                                     'accepted_partial_condition')
                else:
                    self.assertNotIn('contentReviewDecision', candidate)

    def test_source_anchor_candidates_do_not_become_coverage_automatically(self):
        from rebuild_coverage_review import COVERAGE, REVIEW_QUEUE
        from rebuild_staging import read_candidate
        snapshot = read_candidate(ROOT)
        coverage = json.loads(snapshot[COVERAGE])
        queue = json.loads(snapshot[REVIEW_QUEUE])
        candidates = {row['requirementId']: row for row in queue['requirements']
                      if row['sourceAnchorCandidates']}
        coverage_rows = {row['requirementId']: row for row in coverage['requirements']}
        self.assertEqual(len(candidates), 5)
        for requirement_id, row in candidates.items():
            self.assertEqual(row['reviewDecision'], 'reviewed_partial_coverage')
            self.assertNotEqual(row['mappingStatus'], 'reviewed_direct_check_mapping')
            self.assertEqual(coverage_rows[requirement_id]['acceptanceStatus'], 'not_evaluated')
        self.assertEqual(sum(len(row.get('reviewedPartialCheckLinks', []))
                             for row in coverage['requirements']), 37)
        self.assertEqual(sum(len(row.get('reviewedDirectCheckLinks', []))
                             for row in coverage['requirements']), 70)

    def test_derived_metrics_are_not_fake_case_gaps(self):
        from rebuild_coverage_review import COVERAGE, DERIVED_REPORT_METRICS
        from rebuild_staging import read_candidate
        coverage = json.loads(read_candidate(ROOT)[COVERAGE])
        rows = coverage['derivedReportMetrics']
        self.assertEqual({row['metricId'] for row in rows}, DERIVED_REPORT_METRICS)
        self.assertTrue(all(row['directCaseGap'] is False for row in rows))
        self.assertTrue(all(row['status'] == 'requires_trial_level_or_report_aggregation'
                            for row in rows))

    def test_review_blocker_is_counted_from_actual_gold_records(self):
        from rebuild_coverage_review import build_revision, reindex
        from rebuild_dataset import json_bytes
        from rebuild_staging import read_candidate

        snapshot = read_candidate(ROOT)
        report = json.loads(snapshot['manifests/preparation-report.json'])
        report['humanVerifiedGold'] = 100
        snapshot['manifests/preparation-report.json'] = json_bytes(report)
        for path in [name for name in snapshot if name.startswith('gold/')]:
            gold = json.loads(snapshot[path])
            gold['humanVerified'] = True
            snapshot[path] = json_bytes(gold)
        reindex(snapshot)
        outputs = build_revision(ROOT, snapshot)
        readiness = json.loads(outputs['manifests/readiness.json'])
        self.assertNotIn('gold_annotation_and_human_review',
                         {row['id'] for row in readiness['blockers']})
        bm01 = json.loads(outputs['manifests/benchmarks/BM-01/readiness.json'])
        self.assertNotIn('gold_human_review_pending', bm01['blockers'])


if __name__ == '__main__':
    unittest.main()
