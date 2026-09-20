import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / 'agent-eval/tools'))
from rebuild_dataset import json_bytes
from rebuild_publication import (flatten_publication_history, install_materials,
                                 preserved_quality_pin, quality_history_candidates,
                                 read_quality_snapshot)
from rebuild_sources import file_pin
from rebuild_benchmarks import pin


def sample():
    files = {f'{folder}/sample.json': b'{}' for folder in ('gold', 'business', 'cases')}
    files['manifests/preparation-report.json'] = json_bytes({
        'goldCandidates': 1, 'businessPackages': 1, 'casesPreparedInThisStep': 1,
        'imageAnnotatedGold': 0, 'humanVerifiedGold': 0})
    files['manifests/inventory.json'] = json_bytes({'schemaVersion': 3,
        'files': [pin(p, b) for p,b in sorted(files.items())]})
    return files


class PublicationTests(unittest.TestCase):
    def test_repeated_publications_keep_archives_as_siblings(self):
        with tempfile.TemporaryDirectory() as directory:
            project = Path(directory); quality = project/'agent-eval/data'
            quality.mkdir(parents=True)
            previous = None
            for index in range(3):
                files = sample()
                files['gold/sample.json'] = str(index).encode()
                files['manifests/inventory.json'] = json_bytes({'schemaVersion': 3,
                    'files': [pin(p, b) for p,b in sorted(files.items())
                              if p != 'manifests/inventory.json']})
                result = install_materials(project, files)
                self.assertTrue(result['changed'])
                previous = result
            archives = list((quality/'manifests/history').glob('materials-replaced-*'))
            self.assertEqual(len(archives), 3)
            self.assertFalse(list((quality/'manifests/history').glob(
                'materials-replaced-*/manifests/history/materials-replaced-*')))
            self.assertEqual(flatten_publication_history(quality), 0)

    def test_preserved_pin_resolves_nested_publication_history(self):
        with tempfile.TemporaryDirectory() as directory:
            project = Path(directory); quality = project/'agent-eval/data'
            historical = quality/'manifests/history/materials-replaced-new/manifests/history/materials-replaced-old'
            pinned = historical/'manifests/splits.json'
            pinned.parent.mkdir(parents=True)
            pinned.write_bytes(b'original-splits')
            expected = file_pin(historical, 'manifests/splits.json')
            current = quality/'manifests/splits.json'
            current.parent.mkdir(parents=True, exist_ok=True)
            current.write_bytes(b'new-splits')
            self.assertEqual(preserved_quality_pin(project, expected), expected)
            candidates = quality_history_candidates(project)
            self.assertEqual(preserved_quality_pin(project, expected, candidates), expected)
            self.assertEqual(candidates[0], quality.resolve())

    def test_archive_previous_preserve_labels_runs_and_idempotence(self):
        with tempfile.TemporaryDirectory() as directory:
            project = Path(directory);quality = project/'agent-eval/data'
            for name in ('gold/old.json','business/old.json','cases/old/old.json','manifests/reviews/old.json',
                         'manifests/history/existing.json','source-labels/original.json','runs/evidence.json','README.md'):
                p=quality/name;p.parent.mkdir(parents=True,exist_ok=True);p.write_bytes(name.encode())
            result=install_materials(project,sample())
            self.assertEqual(read_quality_snapshot(quality),sample())
            archive=Path(result['historyPath'])
            for name in ('gold/old.json','cases/old/old.json','manifests/reviews/old.json','manifests/history/existing.json'):
                self.assertEqual((archive/name).read_bytes(),name.encode())
            for name in ('source-labels/original.json','runs/evidence.json','README.md'):
                self.assertEqual((quality/name).read_bytes(),name.encode())
            self.assertFalse(install_materials(project,sample())['changed'])
            (quality/'cases/orphan.json').write_bytes(b'{}')
            with self.assertRaises(ValueError): read_quality_snapshot(quality)

    def test_rename_failure_restores_all_prior_directories_and_retains_journal(self):
        with tempfile.TemporaryDirectory() as directory:
            project=Path(directory);quality=project/'agent-eval/data'
            for folder in ('gold','business','cases','manifests'):
                p=quality/folder/'old.json';p.parent.mkdir(parents=True,exist_ok=True);p.write_bytes(folder.encode())
            real=Path.rename
            def failing(path,target):
                if path.name=='cases' and path.parent.name.startswith('.dataset-prepared-'):
                    raise OSError('injected')
                return real(path,target)
            with patch.object(Path,'rename',failing),self.assertRaises(OSError):
                install_materials(project,sample())
            for folder in ('gold','business','cases','manifests'):
                self.assertEqual((quality/folder/'old.json').read_bytes(),folder.encode())
            self.assertTrue((project/'agent-eval/.dataset-publication.json').exists())

    def test_source_migration_receipt_allows_traceable_new_gold_only(self):
        from rebuild_staging import read_candidate
        from rebuild_annotations import build_annotation_revision
        from rebuild_contracts import load_spec_contracts
        from rebuild_source_revision import validate_receipt
        from copy import deepcopy
        before=read_candidate(ROOT)
        packet=json.loads((ROOT/'.cache/dataset-rebuild/image-annotations/002024.packet.json').read_bytes())
        after=build_annotation_revision(ROOT,before,packet,load_spec_contracts(ROOT))
        validate_receipt(after)
        broken=deepcopy(after)
        gold=json.loads(broken['gold/gold-fresh-002024.json']);gold['fields']['invoice_number']['normalizedValue']='forged'
        broken['gold/gold-fresh-002024.json']=json_bytes(gold)
        with self.assertRaises(ValueError):validate_receipt(broken)


if __name__=='__main__':unittest.main()
