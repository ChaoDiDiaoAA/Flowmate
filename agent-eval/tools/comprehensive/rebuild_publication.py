"""Expose prepared materials at agent-eval/data, without granting acceptance.

Only Gold/business/Case/manifests are replaced. Original inputs, provider labels
and actual runs retain their paths. Every prior quality directory is archived.
"""
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import stat
import uuid

from rebuild_dataset import json_bytes
from rebuild_sources import contained
from rebuild_staging import read_candidate, snapshot_digest

COMPONENTS = ('gold', 'business', 'cases', 'manifests')
MARKER = 'manifests/active-dataset.json'


def _extended(path):
    return str(path) if os.name != 'nt' else '\\\\?\\' + str(Path(path).resolve())


def flatten_publication_history(quality):
    """Keep immutable publication archives as siblings to avoid path growth."""
    quality = Path(quality).resolve()
    history = safe_path(quality, 'manifests/history')
    if not history.is_dir():
        return 0
    roots = [node for node in history.rglob('materials-replaced-*') if node.is_dir()]
    moved = 0
    for source in sorted(roots, key=lambda p: len(p.parts), reverse=True):
        if source.parent == history:
            continue
        if source.is_symlink():
            raise ValueError('Publication history cannot contain a link or junction')
        destination = history / source.name
        if destination.exists():
            raise ValueError('Publication history archive collision: ' + source.name)
        os.replace(_extended(source), _extended(destination))
        moved += 1
    return moved


def quality_history_candidates(project):
    """Snapshot contained roots that may hold a preserved quality source.

    Callers that verify thousands of pins should compute this once. Re-running
    the recursive archive discovery for every pin made a normal verification
    scale with pins times publication history depth.
    """
    quality = Path(project).resolve() / 'agent-eval/data'
    candidates = [quality]
    history_root = safe_path(quality, 'manifests/history')
    if history_root.is_dir():
        for node in history_root.rglob('materials-replaced-*'):
            if node.is_symlink():
                raise ValueError('Publication history cannot contain a link or junction')
            if node.is_dir():
                candidates.append(node)
    return tuple(candidates)


def preserved_quality_pin(project, expected, candidate_roots=None):
    """Resolve historical split/exposure pins through explicit publication history.

Provider labels remain in place. A new current split must never be substituted
for the historical exposure record used to choose these fresh samples.
"""
    candidates = candidate_roots if candidate_roots is not None else quality_history_candidates(project)
    for candidate in candidates:
        path = safe_path(candidate, expected['path'])
        readable = Path(_extended(path))
        try:
            raw = readable.read_bytes()
        except (FileNotFoundError, NotADirectoryError, OSError):
            continue
        actual = {'path': expected['path'], 'bytes': len(raw),
                  'sha256': hashlib.sha256(raw).hexdigest()}
        if actual == expected:
            return actual
    raise ValueError('Preserved quality source changed or missing: ' + expected['path'])


def safe_path(root, relative):
    path = contained(root, relative)
    node = Path(root).resolve()
    for part in Path(relative).parts:
        node /= part
        if node.exists() or node.is_symlink():
            info = node.lstat()
            if node.is_symlink() or getattr(info, 'st_file_attributes', 0) & stat.FILE_ATTRIBUTE_REPARSE_POINT:
                raise ValueError('Publication cannot traverse a link or junction')
    return path


def read_quality_snapshot(quality):
    """Read indexed current material, excluding preserved history/labels/runs."""
    quality = Path(quality).resolve()
    marker = quality / MARKER
    if not marker.exists():
        return {p.relative_to(quality).as_posix(): p.read_bytes()
                for p in quality.rglob('*') if p.is_file()}
    publication = json.loads(marker.read_bytes())
    inventory_raw = safe_path(quality, 'manifests/inventory.json').read_bytes()
    if hashlib.sha256(inventory_raw).hexdigest() != publication['inventorySha256']:
        raise ValueError('Active inventory differs from published material')
    inventory = json.loads(inventory_raw)
    result = {'manifests/inventory.json': inventory_raw}
    for entry in inventory['files']:
        path = entry['path']
        if path in result or path.split('/')[0] not in COMPONENTS or path.startswith('manifests/history/') or path == MARKER:
            raise ValueError('Invalid active inventory member')
        raw = safe_path(quality, path).read_bytes()
        if len(raw) != entry['bytes'] or hashlib.sha256(raw).hexdigest() != entry['sha256']:
            raise ValueError('Active file digest differs: ' + path)
        result[path] = raw
    observed = set()
    for component in COMPONENTS:
        def visit(directory):
            for child in directory.iterdir():
                relative = child.relative_to(quality).as_posix()
                if relative == 'manifests/history' or relative == MARKER:
                    continue
                safe = safe_path(quality, relative)
                if safe.is_dir(): visit(safe)
                elif safe.is_file(): observed.add(relative)
                else: raise ValueError('Unsupported active filesystem entry')
        visit(safe_path(quality, component))
    if observed != set(result):
        raise ValueError('Unindexed current files or missing material')
    if snapshot_digest(result) != publication['materialSha256']:
        raise ValueError('Active snapshot differs from publication')
    return result


def install_materials(project, snapshot):
    """Install a previously verified snapshot with rollback for ordinary errors.

An interrupted process leaves a journal and all prior bytes for recovery; the
next call refuses to overwrite it. Moves are confined to checked repo paths.
"""
    from initial_dataset import is_current
    if is_current(project):
        raise ValueError('Legacy archived publication is retired; use initial_dataset.py for the current-only dataset')
    from rebuild_case_release import verify_inventory
    verify_inventory(snapshot)
    project = Path(project).resolve()
    quality = safe_path(project, 'agent-eval/data')
    digest = snapshot_digest(snapshot)
    journal = safe_path(project, 'agent-eval/.dataset-publication.json')
    if journal.exists():
        raise ValueError('Interrupted publication requires recovery; journal preserved')
    marker = quality / MARKER
    if marker.exists() and json.loads(marker.read_bytes()).get('materialSha256') == digest:
        if read_quality_snapshot(quality) == snapshot:
            return {'changed': False, 'path': str(quality), 'materialSha256': digest}
    token = uuid.uuid4().hex
    new = safe_path(project, 'agent-eval/.dataset-prepared-' + token)
    prior = safe_path(project, 'agent-eval/.dataset-previous-' + token)
    archive_rel = 'manifests/history/materials-replaced-' + token
    archive = safe_path(quality, archive_rel)
    new.mkdir(); prior.mkdir()
    if (quality / 'README.md').is_file():
        (prior / 'README.md').write_bytes((quality / 'README.md').read_bytes())
    for relative, raw in snapshot.items():
        if relative.split('/')[0] not in COMPONENTS or relative == MARKER:
            raise ValueError('Only core quality materials can be installed')
        destination = safe_path(new, relative)
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_bytes(raw)
    report = json.loads(snapshot['manifests/preparation-report.json'])
    publication = {'schemaVersion': 1, 'status': 'current_materials_work_in_progress',
        'publishedAt': datetime.now(timezone.utc).isoformat(), 'materialSha256': digest,
        'inventorySha256': hashlib.sha256(snapshot['manifests/inventory.json']).hexdigest(),
        'historyPath': archive_rel, 'source': 'controlled_fresh_preparation',
        'counts': {'gold': report['goldCandidates'], 'business': report['businessPackages'],
                   'cases': report['casesPreparedInThisStep'], 'imageAnnotatedGold': report['imageAnnotatedGold']},
        'humanVerifiedGold': report['humanVerifiedGold'], 'formalAcceptanceEligible': False,
        'actualProductRuns': 0, 'baselineCount': 0,
        'meaning': '保存和切换当前制作材料；不授予人工核验、冻结或产品通过状态。'}
    (new / MARKER).write_bytes(json_bytes(publication))
    # Check the full new tree before moving any existing directory.
    if read_quality_snapshot(new) != snapshot:
        raise ValueError('Prepared publication changed while writing')
    state = {'status': 'installing', 'quality': str(quality), 'prepared': str(new),
             'prior': str(prior), 'archive': str(archive), 'oldMoved': [], 'newInstalled': []}
    with journal.open('x', encoding='utf8') as handle:
        json.dump(state, handle, ensure_ascii=False, indent=2)
    try:
        for component in COMPONENTS:
            target = safe_path(quality, component)
            if target.exists():
                target.rename(safe_path(prior, component))
                state['oldMoved'].append(component)
            safe_path(new, component).rename(target)
            state['newInstalled'].append(component)
            journal.write_bytes(json_bytes(state))
        archive.parent.mkdir(parents=True, exist_ok=True)
        prior.rename(archive)
    except BaseException:
        # Restore actual path state, including an exception between a rename and
        # its journal update. No recursive deletion is used during rollback.
        for component in reversed(COMPONENTS):
            target, saved, staged = quality / component, prior / component, new / component
            if saved.exists():
                if target.exists(): target.rename(staged)
                saved.rename(target)
            elif component in state['newInstalled'] and target.exists():
                target.rename(staged)
        state['status'] = 'rolled_back_review_required'
        journal.write_bytes(json_bytes(state))
        raise
    journal.unlink()
    new.rmdir()  # Exact empty prepared parent, never recursive.
    flattened = flatten_publication_history(quality)
    return {'changed': True, 'path': str(quality), 'historyPath': str(archive),
            'materialSha256': digest, 'counts': publication['counts'],
            'humanVerifiedGold': publication['humanVerifiedGold'], 'actualProductRuns': 0,
            'formalAcceptanceEligible': False, 'historyArchivesFlattened': flattened}


def publish_current(project):
    from rebuild_case_release import verify_case_files
    from rebuild_contracts import load_spec_contracts
    from rebuild_benchmarks import verify
    project = Path(project).resolve()
    snapshot = read_candidate(project)
    verify_case_files(snapshot, load_spec_contracts(project))
    verify(project, project / 'data/.preparation-stage/rebuild')
    if read_candidate(project) != snapshot:
        raise ValueError('Preparation changed before publication')
    return install_materials(project, snapshot)


if __name__ == '__main__':
    import argparse
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--project', type=Path, default=Path(__file__).resolve().parents[3])
    args = parser.parse_args()
    print(json.dumps(publish_current(args.project), ensure_ascii=False, indent=2))
