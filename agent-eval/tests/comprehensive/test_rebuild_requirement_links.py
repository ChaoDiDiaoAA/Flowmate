"""Atomic requirement links are explicit and do not manufacture results."""
import json
from pathlib import Path
import sys
import unittest

ROOT = Path(__file__).resolve().parents[3]
sys.path[:0] = [str(ROOT / 'agent-eval/tools'), str(ROOT / 'agent-eval/src')]


class AtomicRequirementLinkTests(unittest.TestCase):
    def test_authored_checks_expose_reviewed_atomic_identifiers(self):
        from rebuild_cases import compile_scenarios
        from rebuild_contracts import load_spec_contracts
        from rebuild_fixtures import registered_scenarios

        cases = {case['id']: case for case in compile_scenarios(
            list(registered_scenarios().values()), load_spec_contracts(ROOT))}
        check = next(row for row in cases['fresh-snapshot-pointer-race']['oracle']['checks']
                     if row['checkId'].endswith(':old-tool-snapshot'))
        self.assertIn('CRIT-3.24.1-context-attribution/request-a-after-b',
                      check['requirementRefs'])
        self.assertEqual(cases['fresh-snapshot-pointer-race']['executionStatus'], 'not_run')
        self.assertFalse(cases['fresh-snapshot-pointer-race']['formalAcceptanceEligible'])

    def test_review_registry_keeps_partial_conditions_explicit(self):
        from rebuild_coverage_review import EXACT_CONTENT_REVIEWS
        self.assertEqual(
            EXACT_CONTENT_REVIEWS['CRIT-3.24-native-memory/batch-atomicity']
            ['missingConditions'],
            ['尚缺合法多条新增批次完整提交的正向对照'])
        self.assertEqual(
            EXACT_CONTENT_REVIEWS['CRIT-3.24-persistence-binding/cursor-version']
            ['missingConditions'], [])


if __name__ == '__main__':
    unittest.main()
