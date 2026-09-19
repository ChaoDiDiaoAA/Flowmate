"""Staging is repeatable, contains private assets and never rewrites review work."""
import json
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'tools'))


class StagingTests(unittest.TestCase):
    def test_write_is_repeatable_but_drift_requires_explicit_new_revision(self):
        from rebuild_dataset import stage_files
        with tempfile.TemporaryDirectory() as tmp:
            project = Path(tmp)
            outputs = {'business/fresh.json': b'{"id":"fresh"}\n', 'manifests/readiness.json': b'{}\n'}
            first = stage_files(project, outputs)
            self.assertTrue(first['changed'])
            self.assertFalse(stage_files(project, outputs)['changed'])
            target = project / 'data/.preparation-stage/rebuild/business/fresh.json'
            target.write_bytes(b'{"id":"reviewed-change"}')
            with self.assertRaisesRegex(ValueError, 'differs'):
                stage_files(project, outputs)
            self.assertEqual(target.read_bytes(), b'{"id":"reviewed-change"}')

    def test_escape_and_source_overwrite_are_rejected_before_writing(self):
        from rebuild_dataset import stage_files
        with tempfile.TemporaryDirectory() as tmp:
            project = Path(tmp)
            for relative in ['../../secret', 'data/invoices/x', 'source-labels/x', 'C:/x', 'gold/../../x']:
                with self.assertRaises(ValueError):
                    stage_files(project, {relative: b'bad'})
            self.assertFalse((project / 'data/.preparation-stage/rebuild').exists())

    def test_unexpected_file_is_not_silently_omitted_from_idempotence(self):
        from rebuild_dataset import stage_files
        with tempfile.TemporaryDirectory() as tmp:
            project = Path(tmp)
            stage_files(project, {'gold/fresh.json': b'{}'})
            (project / 'data/.preparation-stage/rebuild/gold/extra.json').write_text('{}')
            with self.assertRaisesRegex(ValueError, 'differs'):
                stage_files(project, {'gold/fresh.json': b'{}'})


if __name__ == '__main__':
    unittest.main()
