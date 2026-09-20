"""The current dataset is bound to the current specs without semantic drift."""
import json
from pathlib import Path
import sys
import unittest

ROOT = Path(__file__).resolve().parents[3]
sys.path[:0] = [str(ROOT / 'agent-eval/tools'), str(ROOT / 'agent-eval/src')]


class SpecificationBindingTests(unittest.TestCase):
    def test_table_formatting_equivalence_is_narrow(self):
        from rebuild_spec_binding import formatting_equivalence
        previous = b'heading\n| name | `value` |\n|---|---|\n'
        current = b'heading\n| name    |`value`|\n| ------- | ----- |\n'
        result = formatting_equivalence(previous, current, 'example.md')
        self.assertTrue(result['equivalent'])
        self.assertEqual(result['changedOpcodeCount'], 1)
        with self.assertRaisesRegex(ValueError, 'semantic/non-table'):
            formatting_equivalence(previous, current.replace(b'value', b'other'), 'example.md')
        with self.assertRaisesRegex(ValueError, 'semantic/non-table'):
            formatting_equivalence(previous, previous.replace(b'heading', b'changed'), 'example.md')

    def test_current_candidate_has_replayable_binding_receipt(self):
        from rebuild_bindings import BINDING_3_PINS
        from rebuild_spec_binding import (HISTORICAL_BINDING_REVISION, RECEIPT,
                                          validate_snapshot)
        from rebuild_staging import read_candidate
        snapshot = read_candidate(ROOT)
        validate_snapshot(ROOT, snapshot)
        receipt = json.loads(snapshot[RECEIPT])
        self.assertEqual(receipt['currentBindingRevision'], HISTORICAL_BINDING_REVISION)
        self.assertEqual(receipt['currentSpecRefs'], BINDING_3_PINS)
        self.assertEqual(len(receipt['businessTransitions']), 80)
        self.assertEqual(len(receipt['caseTransitions']), 548)
        self.assertTrue(receipt['gold']['bytesUnchanged'])


if __name__ == '__main__':
    unittest.main()
