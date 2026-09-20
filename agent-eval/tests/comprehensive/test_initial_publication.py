"""Integrity checks against the current design release (no product execution)."""
from copy import deepcopy
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

PROJECT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(PROJECT / 'agent-eval/tools'))
from initial_dataset import assets, encode, is_current, read, validate_snapshot
import initial_dataset


class PublicationRecoveryTests(unittest.TestCase):
    def test_failed_install_restores_current_data_and_public_definitions(self):
        with tempfile.TemporaryDirectory() as directory:
            project=Path(directory)
            quality=project/'agent-eval/data'; (quality/'source-labels').mkdir(parents=True)
            (quality/'source-labels/label.json').write_text('{"untouched":true}')
            (quality/'old-case.json').write_text('{"old":true}')
            public=project/'agent-eval/benchmarks/catalog.json'; public.parent.mkdir(parents=True)
            public.write_bytes(b'old-definition')
            outputs={'cases/new.json':b'{}','manifests/active-dataset.json':encode({'format':initial_dataset.FORMAT})}
            new_public={'agent-eval/benchmarks/catalog.json':b'new-definition'}
            with patch.object(initial_dataset,'build',return_value=(outputs,new_public)), \
                 patch.object(initial_dataset,'validate_snapshot'), \
                 patch.object(initial_dataset,'verify_sources'), \
                 patch.object(initial_dataset,'verify',side_effect=ValueError('post-publication failure')):
                with self.assertRaisesRegex(ValueError,'post-publication failure'):
                    initial_dataset.prepare(project)
            self.assertEqual(public.read_bytes(),b'old-definition')
            self.assertEqual(read(quality/'old-case.json'),{'old':True})
            self.assertEqual(read(quality/'source-labels/label.json'),{'untouched':True})
            self.assertFalse((quality/'cases/new.json').exists())
            self.assertFalse((project/'agent-eval/.initial-publication').exists())

    def test_interrupted_rollback_still_restores_public_definitions(self):
        with tempfile.TemporaryDirectory() as directory:
            project=Path(directory)
            quality=project/'agent-eval/data'; quality.mkdir(parents=True)
            (quality/'restored.json').write_bytes(b'old-data')
            relative='agent-eval/benchmarks/catalog.json'
            public=project/relative; public.parent.mkdir(parents=True)
            public.write_bytes(b'new-definition')
            transaction=project/'agent-eval/.initial-publication'
            backup=transaction/'previous-public'/relative
            backup.parent.mkdir(parents=True); backup.write_bytes(b'old-definition')
            (transaction/'journal.json').write_bytes(encode({
                'state':'prepared','publicPrevious':{relative:True}}))
            initial_dataset.recover_publication(project)
            self.assertEqual(public.read_bytes(),b'old-definition')
            self.assertEqual((quality/'restored.json').read_bytes(),b'old-data')
            self.assertFalse(transaction.exists())

    def test_cleanup_refuses_workspace_and_other_directories(self):
        with tempfile.TemporaryDirectory() as directory:
            project=Path(directory)
            for target in (project,project/'agent-eval/data',project.parent):
                with self.assertRaisesRegex(ValueError,'Unsafe'):
                    initial_dataset.remove_transaction_tree(project,target)


class InitialPublicationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if not is_current(PROJECT):
            raise unittest.SkipTest('Initial design release not installed yet')
        quality = PROJECT / 'agent-eval/data'
        cls.outputs = {p.relative_to(quality).as_posix(): p.read_bytes()
                       for p in quality.rglob('*') if p.is_file()
                       and not p.is_relative_to(quality / 'source-labels')}
        cls.public = {r['path']: (PROJECT / r['path']).read_bytes()
                      for r in json.loads(cls.outputs['manifests/inventory.json'])['publicFiles']}

    def test_current_snapshot_and_all_references_are_closed(self):
        result = validate_snapshot(PROJECT, self.outputs, self.public)
        self.assertTrue(result['valid'])
        self.assertLessEqual(result['agentTasks'], 100)
        self.assertEqual(result['actualProductRuns'], 0)

    def test_stale_or_unindexed_quality_file_is_rejected(self):
        snapshot = dict(self.outputs)
        snapshot['manifests/old-copy.json'] = b'{}\n'
        with self.assertRaisesRegex(ValueError, 'Inventory'):
            validate_snapshot(PROJECT, snapshot, self.public, check_sources=False)

    def test_benchmark_cannot_claim_unknown_check_or_changed_pin(self):
        path = 'manifests/benchmarks/BM-03/members.json'
        for mutation in ('check', 'pin'):
            snapshot = dict(self.outputs)
            doc = json.loads(snapshot[path])
            if mutation == 'check':
                doc['members'][0]['checkIds'].append('unregistered-success')
            else:
                doc['members'][0]['sha256'] = '0' * 64
            snapshot[path] = encode(doc)
            with self.assertRaisesRegex(ValueError, 'Dangling check|Benchmark pin'):
                validate_snapshot(PROJECT, snapshot, self.public, check_sources=False)

    def test_migration_has_one_disposition_for_every_old_definition(self):
        migration = json.loads(self.outputs['manifests/migration.json'])
        rows = migration['records']
        self.assertEqual(len(rows), 548)
        self.assertEqual(len({r['oldId'] for r in rows}), 548)
        current = {ref['id'] for _, ref in assets(self.outputs)}
        facility = json.loads(self.public['agent-eval/tests/fixtures/evaluation-selftests.json'])
        current.update(s['id'] for s in facility['scenarios'])
        self.assertTrue(all(r['newId'] in current for r in rows if r['newId']))
        self.assertFalse(any('previousGold' in json.loads(raw)
                             for path, raw in self.outputs.items() if path.endswith('.json')))

    def test_no_archived_roots_or_fake_performance_views(self):
        self.assertFalse(any('/history/' in path or '/archive/' in path for path in self.outputs))
        self.assertFalse(any(path.startswith('runs/') for path in self.outputs))
        views = json.loads(self.outputs['manifests/views.json'])
        self.assertEqual(views['golden'], [])
        self.assertEqual(views['failures'], [])
        self.assertEqual(json.loads(self.outputs['manifests/benchmarks/BM-10/members.json'])['members'], [])


if __name__ == '__main__':
    unittest.main()
