"""Explicit revisions of the private candidate; never publish active quality data.

Writers serialize with an exclusive lock and compare the complete prior tree.
The rename pair has rollback for ordinary errors, not a crash-atomic transaction.
A pending journal and the exact archived tree make interrupted swaps detectable.
Interrupted locks/journals require inspection; they are never silently removed.
"""
import hashlib
from contextlib import contextmanager
import json
from pathlib import Path
import stat
import tempfile

from rebuild_dataset import STAGING_RELATIVE, json_bytes
from rebuild_sources import contained


def _plain_path(project, relative):
    resolved = contained(project, relative)
    current = Path(project).resolve()
    for part in Path(relative).parts:
        current = current / part
        if current.exists() or current.is_symlink():
            info = current.lstat()
            if current.is_symlink() or getattr(info, 'st_file_attributes', 0) & stat.FILE_ATTRIBUTE_REPARSE_POINT:
                raise ValueError('Candidate path cannot contain a link or junction')
    return resolved


def _read_tree(project, relative):
    root = _plain_path(project, relative)
    if not root.is_dir():
        raise ValueError('Candidate directory missing; inspect any pending revision')
    result = {}
    def visit(folder):
        for entry in sorted(folder.iterdir()):
            name = entry.relative_to(root).as_posix()
            safe = _plain_path(project, relative + '/' + name)
            if safe.is_dir():
                visit(safe)
            elif safe.is_file():
                result[name] = safe.read_bytes()
            else:
                raise ValueError('Unsupported candidate filesystem entry')
    visit(root)
    return result


def read_candidate(project):
    return _read_tree(Path(project).resolve(), STAGING_RELATIVE)


@contextmanager
def candidate_lock(project):
    """Shared by initial creation, verification and explicit revisions."""
    project = Path(project).resolve()
    parent = _plain_path(project, 'data/.preparation-stage')
    parent.mkdir(parents=True, exist_ok=True)
    lock = _plain_path(project, 'data/.preparation-stage/rebuild.lock')
    journal = _plain_path(project, 'data/.preparation-stage/rebuild.pending.json')
    if journal.exists():
        raise ValueError('Pending candidate revision requires recovery inspection')
    try:
        handle = lock.open('x', encoding='utf-8')
    except FileExistsError as exc:
        raise ValueError('Candidate is locked; inspect the existing writer') from exc
    try:
        with handle:
            handle.write('controlled candidate operation\n')
        if journal.exists():
            raise ValueError('Pending candidate revision requires recovery inspection')
        yield
    finally:
        lock.unlink()


def snapshot_digest(files):
    return hashlib.sha256(json_bytes([
        {'path': name, 'bytes': len(value), 'sha256': hashlib.sha256(value).hexdigest()}
        for name, value in sorted(files.items())])).hexdigest()


def _validate_outputs(project, outputs):
    if not isinstance(outputs, dict) or not outputs:
        raise ValueError('Empty candidate revision')
    names = set()
    target = _plain_path(project, STAGING_RELATIVE)
    for relative, data in outputs.items():
        contained(target, relative)
        if relative.split('/')[0] not in {'gold', 'business', 'cases', 'manifests'} or not isinstance(data, bytes):
            raise ValueError('Only private quality assets can be staged')
        if relative.casefold() in names:
            raise ValueError('Case-insensitive path collision')
        names.add(relative.casefold())
    for name in names:
        if any('/'.join(name.split('/')[:i]) in names for i in range(1, len(name.split('/')))):
            raise ValueError('File and directory path collision')


def revise_candidate(project, expected, outputs):
    """Add Case material while preserving independently created base assets.

Only this candidate tree can be renamed. Source and active data roots are never
operation targets. Changed answers need a separate reviewed asset revision.
"""
    project = Path(project).resolve()
    _validate_outputs(project, outputs)
    preserved = lambda name: name.startswith(('gold/', 'business/', 'manifests/annotations/')) or name in {
        'manifests/source-audit.json', 'manifests/selection.json'}
    if {k: v for k, v in expected.items() if preserved(k)} != {
            k: v for k, v in outputs.items() if preserved(k)}:
        raise ValueError('Base assets must be preserved byte for byte')
    return _swap_candidate(project, expected, outputs)


def revise_annotated_candidate(project, expected, outputs):
    """Permit only replayable image annotations; never bypass base-asset guards."""
    from rebuild_annotations import (annotation_record_path, apply_annotation,
                                     validate_annotation_sources, validate_gold_annotations)
    project = Path(project).resolve()
    _validate_outputs(project, outputs)
    preserved = lambda name: name.startswith('business/') or name in {
        'manifests/source-audit.json', 'manifests/selection.json'}
    if {k: v for k, v in expected.items() if preserved(k)} != {
            k: v for k, v in outputs.items() if preserved(k)}:
        raise ValueError('Annotation cannot change business, selection or source audit')
    old_gold = {k for k in expected if k.startswith('gold/')}
    if old_gold != {k for k in outputs if k.startswith('gold/')}:
        raise ValueError('Annotation cannot add or remove selected Gold')
    old_records = {k for k in expected if k.startswith('manifests/annotations/')}
    if any(outputs.get(k) != expected[k] for k in old_records):
        raise ValueError('Prior annotation receipts are immutable')
    additions = set()
    for path in sorted(old_gold):
        revised = json.loads(outputs[path])
        validate_gold_annotations(revised, outputs)
        if expected[path] == outputs[path]:
            continue
        previous = json.loads(expected[path])
        record_path = revised.get('annotationRef', {}).get('path')
        if record_path not in outputs or record_path in old_records:
            raise ValueError('Changed Gold requires a new annotation receipt')
        record = json.loads(outputs[record_path])
        if record.get('previousGold') != previous:
            raise ValueError('Annotation receipt must preserve the exact prior Gold')
        packet = record['annotation']
        if record_path != annotation_record_path(packet) or apply_annotation(previous, packet) != revised:
            raise ValueError('Gold change is not the declared annotation')
        validate_annotation_sources(project, previous, packet)
        additions.add(record_path)
    if {k for k in outputs if k.startswith('manifests/annotations/')} != old_records | additions:
        raise ValueError('Orphan annotation receipt')
    return _swap_candidate(project, expected, outputs)


def revise_human_review_candidate(project, expected, outputs):
    """Permit replayable human Gold reviews and their derived references only."""
    from rebuild_gold_reviews import validate_human_review_record
    project = Path(project).resolve()
    _validate_outputs(project, outputs)

    immutable_prefixes = (
        'business/', 'manifests/annotations/', 'manifests/partition-reviews/',
        'manifests/business-reviews/',
    )
    immutable_exact = {
        'manifests/source-audit.json', 'manifests/selection.json',
        'manifests/source-revision.json', 'manifests/spec-binding.json',
        'manifests/fixture-policy.json',
    }
    for path, raw in expected.items():
        if (path.startswith(immutable_prefixes) or path in immutable_exact) and outputs.get(path) != raw:
            raise ValueError('Human Gold review cannot change its source, business or prior receipts')

    old_gold = {path for path in expected if path.startswith('gold/')}
    if old_gold != {path for path in outputs if path.startswith('gold/')}:
        raise ValueError('Human Gold review cannot add or remove selected Gold')
    prior_reviews = {path for path in expected if path.startswith('manifests/reviews/')}
    if any(outputs.get(path) != expected[path] for path in prior_reviews):
        raise ValueError('Prior human review receipts are immutable')

    changed_samples = set()
    additions = set()
    quality = project / STAGING_RELATIVE
    for path in sorted(old_gold):
        if expected[path] == outputs[path]:
            continue
        previous, revised = json.loads(expected[path]), json.loads(outputs[path])
        if revised.get('sampleId') != previous.get('sampleId'):
            raise ValueError('Reviewed Gold identity changed')
        record_path = revised.get('humanReviewRef', {}).get('path')
        if record_path not in outputs or record_path in prior_reviews:
            raise ValueError('Changed Gold requires a new human review receipt')
        replayed_previous = validate_human_review_record(
            revised, outputs, project=project, quality=quality)
        if replayed_previous != previous:
            raise ValueError('Human review receipt does not preserve the exact prior Gold')
        changed_samples.add(previous['sampleId'])
        additions.add(record_path)
    if not changed_samples:
        if outputs != expected:
            raise ValueError('Derived assets cannot change without a new human review')
        return _swap_candidate(project, expected, outputs)
    if {path for path in outputs if path.startswith('manifests/reviews/')} != prior_reviews | additions:
        raise ValueError('Orphan human review receipt')

    old_cases = {path for path in expected if path.startswith('cases/')}
    if old_cases != {path for path in outputs if path.startswith('cases/')}:
        raise ValueError('Human Gold review cannot add or remove Cases')
    for path in old_cases:
        old = json.loads(expected[path])
        if old.get('scenarioProtocol') != {'kind': 'fresh_invoice_extraction', 'version': 1}:
            if outputs[path] != expected[path]:
                raise ValueError('Human Gold review cannot change non-extraction Cases')
        elif old.get('sampleId') not in changed_samples and outputs[path] != expected[path]:
            raise ValueError('Unreviewed extraction Case changed')

    allowed_manifest_changes = {
        'manifests/inventory.json', 'manifests/preparation-report.json',
        'manifests/case-catalog.json', 'manifests/module-catalog.json',
        'manifests/views.json', 'manifests/readiness.json',
        'manifests/requirements.json', 'manifests/coverage.json',
        'manifests/case-reviews/grader-facilities.json',
        'manifests/case-reviews/source-coverage.json',
    }
    for path in set(expected) | set(outputs):
        if expected.get(path) == outputs.get(path):
            continue
        if (path in old_gold or path in old_cases or path in additions or
                path in allowed_manifest_changes or path.startswith('manifests/benchmarks/')):
            continue
        raise ValueError('Human Gold review changed an unrelated candidate asset: ' + path)
    return _swap_candidate(project, expected, outputs)


def revise_partition_candidate(project, expected, outputs, changed_samples):
    """Permit only replayable selected-source partition revisions and derived indexes."""
    from rebuild_dataset import verify_asset_snapshot
    from rebuild_partitions import apply_partition_review, partition_record_path
    project = Path(project).resolve()
    _validate_outputs(project, outputs)
    changed_samples = set(changed_samples)
    if not changed_samples:
        raise ValueError('Partition revision needs changed selected samples')
    for path, raw in expected.items():
        if path.startswith('business/') and outputs.get(path) != raw:
            raise ValueError('Partition review cannot change business inputs')
        if path.startswith('manifests/annotations/') and outputs.get(path) != raw:
            raise ValueError('Image annotation receipts are immutable')
        if path.startswith('gold/'):
            sample = json.loads(raw)['sampleId']
            if sample not in changed_samples and outputs.get(path) != raw:
                raise ValueError('Unreviewed Gold changed during partition revision')
        if path.startswith('cases/'):
            case = json.loads(raw)
            if case.get('scenarioProtocol') != {'kind': 'fresh_invoice_extraction', 'version': 1}:
                if outputs.get(path) != raw:
                    raise ValueError('Partition review cannot change non-extraction Cases')
    prior_partition_records = {p for p in expected if p.startswith('manifests/partition-reviews/')}
    if any(outputs.get(p) != expected[p] for p in prior_partition_records):
        raise ValueError('Prior partition receipts are immutable')
    additions = set()
    for sample in changed_samples:
        path = 'gold/gold-fresh-' + sample + '.json'
        if path not in expected or path not in outputs:
            raise ValueError('Partition review Gold identity missing')
        previous, revised = json.loads(expected[path]), json.loads(outputs[path])
        record_path = revised.get('partitionReviewRef', {}).get('path')
        if record_path not in outputs or record_path in prior_partition_records:
            raise ValueError('Changed Gold requires a new partition receipt')
        record = json.loads(outputs[record_path])
        if (set(record) != {'previousGold', 'review'} or record['previousGold'] != previous or
                record_path != partition_record_path(record['review']) or
                apply_partition_review(previous, record['review']) != revised):
            raise ValueError('Partition receipt does not reproduce revised Gold')
        additions.add(record_path)
    new_partition_records = {p for p in outputs if p.startswith('manifests/partition-reviews/')}
    # One additional selection-wide audit receipt is allowed and must be indexed.
    if len(new_partition_records - prior_partition_records - additions) != 1:
        raise ValueError('Exactly one selection review receipt required')
    verify_asset_snapshot(project, outputs)
    return _swap_candidate(project, expected, outputs)


def revise_business_review_candidate(project, expected, outputs):
    """Add replayable AI content-audit receipts without changing business input."""
    from rebuild_business_review import validate_business_review_snapshot
    from rebuild_dataset import verify_asset_snapshot
    project = Path(project).resolve()
    _validate_outputs(project, outputs)
    immutable_prefixes = ('gold/', 'business/', 'cases/', 'manifests/annotations/',
                          'manifests/partition-reviews/', 'manifests/benchmarks/')
    immutable_exact = {'manifests/source-audit.json', 'manifests/selection.json',
                       'manifests/source-revision.json', 'manifests/case-catalog.json',
                       'manifests/module-catalog.json', 'manifests/views.json'}
    for path, raw in expected.items():
        if (path.startswith(immutable_prefixes) or path in immutable_exact) and outputs.get(path) != raw:
            raise ValueError('Business content audit cannot change authored assets or dependencies')
    prior = {p for p in expected if p.startswith('manifests/business-reviews/')}
    if any(outputs.get(p) != expected[p] for p in prior):
        raise ValueError('Prior business review receipts are immutable')
    validate_business_review_snapshot(outputs)
    verify_asset_snapshot(project, outputs)
    return _swap_candidate(project, expected, outputs)


def _swap_candidate(project, expected, outputs):
    """Shared compare-and-swap after each caller's distinct mutation validation."""
    target = _plain_path(project, STAGING_RELATIVE)
    parent = target.parent
    parent.mkdir(parents=True, exist_ok=True)
    journal = _plain_path(project, 'data/.preparation-stage/rebuild.pending.json')
    with candidate_lock(project):
        if read_candidate(project) != expected:
            raise ValueError('Candidate changed since validation; preserve edits and revalidate')
        if outputs == expected:
            return {'changed': False, 'files': len(outputs), 'path': str(target)}
        before, after = snapshot_digest(expected), snapshot_digest(outputs)
        history_relative = f'data/.preparation-stage/history/candidate-{before}'
        history = _plain_path(project, history_relative)
        if history.exists():
            raise ValueError('History collision; do not overwrite a prior revision')
        history.parent.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(prefix='rebuild-revision-', dir=parent) as temporary:
            temporary = Path(temporary).resolve()
            if not temporary.is_relative_to(parent.resolve()):
                raise ValueError('Temporary candidate escaped preparation root')
            candidate = temporary / 'candidate'
            candidate.mkdir()
            for relative, data in outputs.items():
                path = contained(candidate, relative)
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(data)
            # Recheck after writing: a reviewer may have edited while building.
            if read_candidate(project) != expected:
                raise ValueError('Candidate changed during construction; preserve edits')
            with journal.open('x', encoding='utf-8') as stream:
                json.dump({'before': before, 'after': after, 'historyPath': history_relative,
                           'target': STAGING_RELATIVE, 'status': 'swap_pending'}, stream)
            try:
                target.rename(history)
                try:
                    candidate.rename(target)
                except BaseException:
                    if not target.exists():
                        history.rename(target)
                    raise
            except BaseException:
                # Keep journal if rollback did not restore the exact prior tree.
                if target.is_dir() and read_candidate(project) == expected:
                    journal.unlink()
                raise
            journal.unlink()
        return {'changed': True, 'files': len(outputs), 'path': str(target),
                'historyPath': history_relative, 'beforeSha256': before, 'afterSha256': after}


def revise_source_bound_candidate(project, expected, outputs):
    """Dedicated source-binding path; ordinary revisions retain base-byte guards."""
    from rebuild_source_revision import validate_source_revision
    project = Path(project).resolve()
    _validate_outputs(project, outputs)
    validate_source_revision(project, expected, outputs)
    return _swap_candidate(project, expected, outputs)


def revise_spec_bound_candidate(project, expected, outputs):
    """Dedicated path for a proved semantics-neutral specification rebinding."""
    from rebuild_spec_binding import validate_snapshot
    project = Path(project).resolve()
    _validate_outputs(project, outputs)
    validate_snapshot(project, outputs, expected)
    return _swap_candidate(project, expected, outputs)


def revise_spec_amendment_candidate(project, expected, outputs):
    """Dedicated path for the exact approved semantic plan amendment."""
    from rebuild_spec_amendment import validate_snapshot
    project = Path(project).resolve()
    _validate_outputs(project, outputs)
    validate_snapshot(project, outputs, expected)
    return _swap_candidate(project, expected, outputs)
