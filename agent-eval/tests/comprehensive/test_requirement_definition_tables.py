"""Cross-reference metric tables must not redefine MOD/RT identities."""
from collections import Counter
from pathlib import Path
import sys
import unittest

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / 'agent-eval/tools'))


class DefinitionTableTests(unittest.TestCase):
    def test_runtime_ids_come_from_definition_table_not_metric_crosswalk(self):
        from invoice_requirements import load_requirements
        requirements = load_requirements(ROOT)['requirements']
        runtimes = [r for r in requirements if r['kind'] == 'RT']
        self.assertEqual(len(runtimes), 17)
        self.assertTrue(all(r['section'] == '3.12' for r in runtimes))
        self.assertEqual(len({r['id'] for r in requirements}), len(requirements))


if __name__ == '__main__':
    unittest.main()
