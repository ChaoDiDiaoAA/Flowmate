"""Rebind fresh evaluation assets after a semantics-neutral spec formatting edit.

The operation is deliberately narrow: both specification byte versions must be
registered, every changed source line must be a Markdown table line whose
content tokens are unchanged, and all Gold bytes plus the semantic projections
of every business package and Case must remain identical.  It creates no human
review, product Trial, Benchmark result or acceptance status.
"""
from collections import Counter
from copy import deepcopy
import difflib
import hashlib
import json
from pathlib import Path
import re

from rebuild_bindings import (BINDING_2_PINS, BINDING_3_PINS, contract_pins)
from rebuild_case_release import assemble_case_files, canonical_digest, verify_inventory
from rebuild_dataset import json_bytes
from rebuild_sources import file_pin
from rebuild_staging import read_candidate, snapshot_digest


RECEIPT = 'manifests/spec-binding-review.json'
HISTORICAL_BINDING_REVISION = 3
AMENDMENT_RECEIPT = 'manifests/spec-amendment-review.json'
OLD_PRODUCT_SNAPSHOT = (
    '.cache/dataset-rebuild/spec-snapshots/'
    'product-fd6a5891d7fffb8e5e777e82b9cfa649e481787e5452130da127be0aed744b15.md')
OLD_EVALUATION_SNAPSHOT = (
    '.cache/dataset-rebuild/spec-snapshots/'
    'evaluation-8b249d8003feaf307b15005696b84f9b60b073a5ffb29b2386ef4b663997933c.md')


def _pin(path, raw):
    return {'path': path, 'bytes': len(raw), 'sha256': hashlib.sha256(raw).hexdigest()}


def _read(snapshot, path):
    return json.loads(snapshot[path].decode('utf-8-sig'))


def _table_line(line):
    stripped = line.strip()
    return stripped.startswith('|') and stripped.endswith('|')


def canonical_layout_line(line):
    """Remove only Markdown table layout/backtick presentation differences."""
    if not _table_line(line):
        return line
    cells = line.strip()[1:-1].split('|')
    normalized = []
    for cell in cells:
        value = cell.strip()
        if re.fullmatch(r':?-{3,}:?', value):
            normalized.append('<separator>')
        else:
            # All observed changes are padding or inline-code presentation in a
            # table. Removing whitespace/backticks retains every content token.
            normalized.append(re.sub(r'\s+', '', value.replace('`', '')))
    return '|' + '|'.join(normalized) + '|'


def formatting_equivalence(previous_raw, current_raw, path):
    previous = previous_raw.decode('utf-8-sig').splitlines()
    current = current_raw.decode('utf-8-sig').splitlines()
    old_canonical = [canonical_layout_line(line) for line in previous]
    new_canonical = [canonical_layout_line(line) for line in current]
    if old_canonical != new_canonical:
        raise ValueError('Specification has a semantic/non-table change: ' + path)
    changes = []
    matcher = difflib.SequenceMatcher(None, previous, current)
    for tag, i1, i2, j1, j2 in matcher.get_opcodes():
        if tag == 'equal':
            continue
        if (not all(_table_line(line) for line in previous[i1:i2]) or
                not all(_table_line(line) for line in current[j1:j2])):
            raise ValueError('Specification change escaped Markdown tables: ' + path)
        changes.append({'kind': tag, 'previousLines': [i1 + 1, i2],
                        'currentLines': [j1 + 1, j2],
                        'previousLineCount': i2 - i1, 'currentLineCount': j2 - j1})
    canonical_raw = '\n'.join(old_canonical).encode('utf-8')
    return {'path': path, 'equivalent': True,
            'algorithm': 'markdown_table_layout_and_inline_code_presentation',
            'canonicalSha256': hashlib.sha256(canonical_raw).hexdigest(),
            'changedOpcodeCount': len(changes), 'changes': changes}


def semantic_projection(value):
    """Remove source-binding identity while retaining task/business semantics."""
    value = deepcopy(value)
    ignored = {'version', 'caseSha256', 'sha256', 'bytes', 'specSha256',
               'startLine', 'sourceBindingRevision', 'assetSha256'}

    def visit(node):
        if isinstance(node, dict):
            for key in list(node):
                if key in ignored:
                    node.pop(key)
                else:
                    visit(node[key])
        elif isinstance(node, list):
            for item in node:
                visit(item)
    visit(value)
    return value


def projection_digest(value):
    return canonical_digest(semantic_projection(value))


def _tree(project, relative):
    root = (Path(project).resolve() / relative).resolve()
    project = Path(project).resolve()
    if not root.is_relative_to(project) or not root.is_dir():
        raise ValueError('Specification-binding history is missing')
    return {p.relative_to(root).as_posix(): p.read_bytes()
            for p in root.rglob('*') if p.is_file()}


def _registered_spec_snapshots(project):
    project = Path(project).resolve()
    pairs = [
        ('product', BINDING_2_PINS[0], OLD_PRODUCT_SNAPSHOT, BINDING_3_PINS[0]),
        ('evaluation', BINDING_2_PINS[1], OLD_EVALUATION_SNAPSHOT, BINDING_3_PINS[1]),
    ]
    records, equivalence = [], []
    for identity, previous_pin, previous_path, current_pin in pairs:
        previous = file_pin(project, previous_path)
        if (previous['bytes'], previous['sha256']) != (previous_pin['bytes'], previous_pin['sha256']):
            raise ValueError('Previous specification snapshot differs: ' + identity)
        current_path = (f'.cache/dataset-rebuild/spec-snapshots/{identity}-'
                        f'{current_pin["sha256"]}.md')
        current_snapshot = project / current_path
        if not current_snapshot.is_file():
            raise ValueError('Historical current specification snapshot missing: ' + identity)
        current_raw = current_snapshot.read_bytes()
        if _pin(current_pin['path'], current_raw) != current_pin:
            raise ValueError('Historical current specification snapshot differs: ' + identity)
        records.append({'identity': identity, 'previous': previous,
                        'current': file_pin(project, current_path)})
        equivalence.append(formatting_equivalence(
            (project / previous_path).read_bytes(), current_raw, current_pin['path']))
    return records, equivalence


def verify_prior(snapshot):
    verify_inventory(snapshot)
    if RECEIPT in snapshot:
        raise ValueError('Candidate is already rebound')
    report = _read(snapshot, 'manifests/preparation-report.json')
    if report.get('specRefs') != BINDING_2_PINS:
        raise ValueError('Only registered binding 2 can be rebound')
    business = [_read(snapshot, path) for path in snapshot if path.startswith('business/')]
    cases = [_read(snapshot, path) for path in snapshot if path.startswith('cases/')]
    gold_paths = [path for path in snapshot if path.startswith('gold/')]
    if (len(business), len(cases), len(gold_paths)) != (80, 548, 100):
        raise ValueError('Prior asset membership differs')
    if any(asset.get('sourceBindingRevision') != 2 or asset.get('specRefs') != BINDING_2_PINS
           for asset in business):
        raise ValueError('Prior business binding differs')
    expected_hashes = {pin['path']: {'path': pin['path'], 'sha256': pin['sha256']}
                       for pin in BINDING_2_PINS}
    if any(case.get('provenance', {}).get('sourceBindingRevision') != 2 or
           case.get('sourceSpecHashes') != expected_hashes for case in cases):
        raise ValueError('Prior Case binding differs')
    return {'business': business, 'cases': cases, 'goldPaths': gold_paths}


def _asset_transitions(previous, current, prefix):
    old = {_read(previous, path)['id']: (path, _read(previous, path))
           for path in previous if path.startswith(prefix)}
    new = {_read(current, path)['id']: (path, _read(current, path))
           for path in current if path.startswith(prefix)}
    if set(old) != set(new):
        raise ValueError('Specification rebinding changed asset membership: ' + prefix)
    result = []
    for identity in sorted(old):
        old_path, before = old[identity]
        new_path, after = new[identity]
        if old_path != new_path or semantic_projection(before) != semantic_projection(after):
            raise ValueError('Specification rebinding changed asset semantics: ' + identity)
        result.append({'id': identity, 'path': old_path,
                       'previousVersion': before['version'], 'currentVersion': after['version'],
                       'previousSha256': hashlib.sha256(previous[old_path]).hexdigest(),
                       'currentSha256': hashlib.sha256(current[new_path]).hexdigest(),
                       'semanticProjectionSha256': projection_digest(after)})
    return result


def build_receipt(project, previous, current, spec_snapshots, equivalence):
    before = snapshot_digest(previous)
    if any(not row['equivalent'] for row in equivalence):
        raise ValueError('Specification equivalence is not established')
    gold_paths = sorted(path for path in previous if path.startswith('gold/'))
    if gold_paths != sorted(path for path in current if path.startswith('gold/')) or any(
            previous[path] != current[path] for path in gold_paths):
        raise ValueError('Specification rebinding changed Gold bytes')
    return {
        'schemaVersion': 1, 'operation': 'semantics_neutral_specification_rebinding',
        'status': 'SOURCE_BYTES_REBOUND_CONTENT_TOKENS_UNCHANGED',
        'previousBindingRevision': 2, 'currentBindingRevision': HISTORICAL_BINDING_REVISION,
        'previousCandidateSha256': before,
        'historyPath': 'data/.preparation-stage/history/candidate-' + before,
        'previousSpecRefs': deepcopy(BINDING_2_PINS),
        'currentSpecRefs': deepcopy(BINDING_3_PINS),
        'specSnapshots': spec_snapshots, 'formattingEquivalence': equivalence,
        'gold': {'count': len(gold_paths), 'bytesUnchanged': True,
                 'aggregateSha256': canonical_digest([
                     {'path': path, 'sha256': hashlib.sha256(previous[path]).hexdigest()}
                     for path in gold_paths])},
        'businessTransitions': _asset_transitions(previous, current, 'business/'),
        'caseTransitions': _asset_transitions(previous, current, 'cases/'),
        'semanticContentChanged': False, 'humanReviewGranted': False,
        'actualProductRuns': 0, 'formalAcceptanceEligible': False,
    }


def _baseline_author_version(version, binding_revision):
    if (type(version) is not int or version < 1000 or
            version % 1000 != binding_revision):
        raise ValueError('Specification-binding transition version differs')
    authored = version // 1000
    if authored < 1:
        raise ValueError('Specification-binding authored version differs')
    return authored


def _validate_historical_transitions(previous, snapshot, receipt):
    """Validate the immutable rebinding proof while permitting later authors.

    The receipt proves the binding-2 -> binding-3 transition that occurred at
    that time.  A later Case correction must not rewrite that receipt; it must
    publish a higher authored version under binding 3.  The enclosing complete
    verifier subsequently rebuilds every current Case from its registered
    author and byte-compares it, so this function only validates the revision
    chain and the historical receipt.
    """
    gold_paths = sorted(path for path in previous if path.startswith('gold/'))
    current_gold = sorted(path for path in snapshot if path.startswith('gold/'))
    gold_summary = receipt.get('gold', {})
    aggregate = canonical_digest([
        {'path': path, 'sha256': hashlib.sha256(previous[path]).hexdigest()}
        for path in gold_paths])
    if (gold_paths != current_gold or any(previous[path] != snapshot[path] for path in gold_paths)
            or gold_summary != {'count': len(gold_paths), 'bytesUnchanged': True,
                                'aggregateSha256': aggregate}):
        raise ValueError('Specification-binding Gold preservation differs')

    def indexed(prefix):
        result = {}
        for path in sorted(p for p in previous if p.startswith(prefix)):
            value = _read(previous, path)
            if value['id'] in result:
                raise ValueError('Specification-binding prior identity duplicated')
            result[value['id']] = (path, value)
        return result

    old_business = indexed('business/')
    business_transitions = {row['id']: row for row in receipt.get('businessTransitions', [])}
    if set(old_business) != set(business_transitions):
        raise ValueError('Specification-binding business membership differs')
    current_business = {_read(snapshot, path)['id']: (path, _read(snapshot, path))
                        for path in snapshot if path.startswith('business/')}
    if set(current_business) != set(old_business):
        raise ValueError('Current business membership differs from specification binding')
    for identity, (path, before) in old_business.items():
        row = business_transitions[identity]
        current_path, after = current_business[identity]
        authored = before.get('authoredVersion')
        if (type(authored) is not int or before.get('sourceBindingRevision') != 2 or
                before.get('version') != authored + 1):
            raise ValueError('Specification-binding prior business version differs: ' + identity)
        baseline_version = authored + HISTORICAL_BINDING_REVISION - 1
        expected = {
            'id': identity, 'path': path,
            'previousVersion': before['version'], 'currentVersion': baseline_version,
            'previousSha256': hashlib.sha256(previous[path]).hexdigest(),
            'currentSha256': row.get('currentSha256'),
            'semanticProjectionSha256': projection_digest(before),
        }
        if row != expected or current_path != path:
            raise ValueError('Specification-binding business transition differs: ' + identity)
        if (AMENDMENT_RECEIPT in snapshot and
                after.get('sourceBindingRevision', 0) > HISTORICAL_BINDING_REVISION):
            continue
        if (hashlib.sha256(snapshot[path]).hexdigest() != row['currentSha256'] or
                after.get('version') != row['currentVersion'] or
                after.get('authoredVersion') != authored or
                after.get('sourceBindingRevision') != HISTORICAL_BINDING_REVISION or
                after.get('specRefs') != BINDING_3_PINS or
                projection_digest(after) != row['semanticProjectionSha256']):
            raise ValueError('Business changed after specification binding: ' + identity)

    old_cases = indexed('cases/')
    case_transitions = {row['id']: row for row in receipt.get('caseTransitions', [])}
    if set(old_cases) != set(case_transitions):
        raise ValueError('Specification-binding Case membership differs')
    current_cases = {_read(snapshot, path)['id']: (path, _read(snapshot, path))
                     for path in snapshot if path.startswith('cases/')}
    if set(current_cases) != set(old_cases):
        raise ValueError('Current Case membership differs from specification binding')
    expected_hashes = {pin['path']: {'path': pin['path'], 'sha256': pin['sha256']}
                       for pin in BINDING_3_PINS}
    for identity, (path, before) in old_cases.items():
        row = case_transitions[identity]
        current_path, current = current_cases[identity]
        authored = _baseline_author_version(before['version'], 2)
        baseline_version = authored * 1000 + HISTORICAL_BINDING_REVISION
        stable = {
            'id': identity, 'path': path,
            'previousVersion': before['version'], 'currentVersion': baseline_version,
            'previousSha256': hashlib.sha256(previous[path]).hexdigest(),
            'currentSha256': row.get('currentSha256'),
            'semanticProjectionSha256': projection_digest(before),
        }
        if row != stable or current_path != path or not re.fullmatch(r'[0-9a-f]{64}', row['currentSha256']):
            raise ValueError('Specification-binding Case transition differs: ' + identity)
        current_sha = hashlib.sha256(snapshot[path]).hexdigest()
        if current_sha == row['currentSha256']:
            if (current.get('version') != baseline_version or
                    projection_digest(current) != row['semanticProjectionSha256']):
                raise ValueError('Specification-bound Case baseline differs: ' + identity)
            continue
        provenance = current.get('provenance', {})
        if (AMENDMENT_RECEIPT in snapshot and
                provenance.get('sourceBindingRevision', 0) > HISTORICAL_BINDING_REVISION):
            continue
        current_authored = provenance.get('authoredVersion')
        if (provenance.get('sourceBindingRevision') != HISTORICAL_BINDING_REVISION or
                type(current_authored) is not int or current_authored <= authored or
                current.get('version') != current_authored * 1000 + HISTORICAL_BINDING_REVISION or
                current.get('sourceSpecHashes') != expected_hashes):
            raise ValueError('Changed Case is not a higher current-binding author revision: ' + identity)


def _refresh_review_receipts(project, previous, outputs):
    from rebuild_actions_review import (RECEIPT as ACTIONS_RECEIPT,
                                        build_receipt as actions_receipt)
    from rebuild_grader_review import (RECEIPT as GRADER_RECEIPT,
                                       build_receipt as grader_receipt)
    actions_facility = _read(previous, ACTIONS_RECEIPT)['facilityVerification']
    grader_facility = _read(previous, GRADER_RECEIPT)['facilityVerification']
    outputs[ACTIONS_RECEIPT] = json_bytes(actions_receipt(project, outputs, actions_facility))
    outputs[GRADER_RECEIPT] = json_bytes(grader_receipt(project, outputs, grader_facility))
    readiness = _read(outputs, 'manifests/readiness.json')
    readiness['actionsReview']['receiptRef'] = _pin(ACTIONS_RECEIPT, outputs[ACTIONS_RECEIPT])
    readiness['graderFacilities']['receiptRef'] = _pin(GRADER_RECEIPT, outputs[GRADER_RECEIPT])
    outputs['manifests/readiness.json'] = json_bytes(readiness)
    report = _read(outputs, 'manifests/preparation-report.json')
    report['actionsDefinitionReview'] = deepcopy(readiness['actionsReview'])
    report['graderFacilities'] = deepcopy(readiness['graderFacilities'])
    outputs['manifests/preparation-report.json'] = json_bytes(report)
    return outputs


def _refresh_benchmarks(project, outputs):
    from rebuild_benchmarks import PREFIX, build_bundle
    # build_bundle verifies the inventory before reading the current catalog.
    reindex(outputs)
    bundle = build_bundle(project, outputs)
    outputs = {path: raw for path, raw in outputs.items() if not path.startswith(PREFIX)}
    outputs.update(bundle)
    index = _read(outputs, PREFIX + 'index.json')
    views = _read(outputs, 'manifests/views.json')
    views['benchmarks'] = {row['benchmarkId']: {'membersRef': row['membersRef'],
        'selection': 'direct_members_only', 'counts': row['counts']} for row in index['benchmarks']}
    outputs['manifests/views.json'] = json_bytes(views)
    report = _read(outputs, 'manifests/preparation-report.json')
    report['benchmarks'] = {'preparedDefinitions': 11,
        'indexRef': _pin(PREFIX + 'index.json', outputs[PREFIX + 'index.json']),
        'membershipReview': 'pending', 'freeze': 'not_frozen',
        'actualProductRuns': 0, 'baselineCount': 0}
    outputs['manifests/preparation-report.json'] = json_bytes(report)
    reindex(outputs)
    return outputs


def reindex(outputs):
    outputs['manifests/inventory.json'] = json_bytes({'schemaVersion': 3, 'files': [
        _pin(path, raw) for path, raw in sorted(outputs.items())
        if path != 'manifests/inventory.json']})


def build_revision(project, previous):
    project = Path(project).resolve()
    verify_prior(previous)
    spec_snapshots, equivalence = _registered_spec_snapshots(project)
    from rebuild_contracts import load_spec_contracts
    contracts = load_spec_contracts(project)
    if contract_pins(contracts) != BINDING_3_PINS:
        raise ValueError('Current specifications changed during rebinding')
    outputs = dict(previous)
    report = _read(outputs, 'manifests/preparation-report.json')
    report.update(specRefs=deepcopy(BINDING_3_PINS), sourceBindingRevision=HISTORICAL_BINDING_REVISION,
                  specBindingReview='semantics_neutral_formatting_rebind')
    outputs['manifests/preparation-report.json'] = json_bytes(report)
    from rebuild_business_projection import authored_business
    for asset in authored_business(contracts).values():
        outputs['business/' + asset['id'] + '.json'] = json_bytes(asset)
    from rebuild_cases import compile_scenarios
    from rebuild_extraction import build_extraction_cases
    from rebuild_fixtures import registered_scenarios
    golds = [_read(outputs, path) for path in sorted(outputs) if path.startswith('gold/')]
    cases = (compile_scenarios(list(registered_scenarios().values()), contracts) +
             build_extraction_cases(golds, contracts))
    outputs = assemble_case_files(outputs, cases, contracts)
    # Add the proof before validating the old source-migration receipt; that
    # receipt explicitly recognizes this separately validated later binding.
    outputs[RECEIPT] = json_bytes(build_receipt(
        project, previous, outputs, spec_snapshots, equivalence))
    from rebuild_business_review import assemble_reviews
    outputs = assemble_reviews(outputs)
    outputs = _refresh_review_receipts(project, previous, outputs)
    outputs = _refresh_benchmarks(project, outputs)
    reindex(outputs)
    validate_snapshot(project, outputs, previous)
    return outputs


def validate_snapshot(project, snapshot, previous=None):
    if RECEIPT not in snapshot:
        return
    receipt = _read(snapshot, RECEIPT)
    if (receipt.get('schemaVersion') != 1 or
            receipt.get('operation') != 'semantics_neutral_specification_rebinding' or
            receipt.get('previousBindingRevision') != 2 or
            receipt.get('currentBindingRevision') != HISTORICAL_BINDING_REVISION or
            receipt.get('previousSpecRefs') != BINDING_2_PINS or
            receipt.get('currentSpecRefs') != BINDING_3_PINS or
            receipt.get('semanticContentChanged') is not False or
            receipt.get('humanReviewGranted') is not False or
            receipt.get('actualProductRuns') != 0 or
            receipt.get('formalAcceptanceEligible') is not False):
        raise ValueError('Specification-binding receipt contract differs')
    spec_snapshots, equivalence = _registered_spec_snapshots(project)
    if receipt.get('specSnapshots') != spec_snapshots or receipt.get('formattingEquivalence') != equivalence:
        raise ValueError('Specification formatting-equivalence proof differs')
    if previous is None:
        previous = _tree(project, receipt['historyPath'])
    verify_prior(previous)
    if snapshot_digest(previous) != receipt['previousCandidateSha256']:
        raise ValueError('Specification-binding prior candidate differs')
    _validate_historical_transitions(previous, snapshot, receipt)
    report = _read(snapshot, 'manifests/preparation-report.json')
    if AMENDMENT_RECEIPT not in snapshot:
        if (report.get('specRefs') != BINDING_3_PINS or
                report.get('sourceBindingRevision') != HISTORICAL_BINDING_REVISION or
                report.get('specBindingReview') != 'semantics_neutral_formatting_rebind'):
            raise ValueError('Preparation report is not on historical binding 3')


def release(project):
    from rebuild_staging import candidate_lock, revise_spec_bound_candidate
    project = Path(project).resolve()
    with candidate_lock(project):
        previous = read_candidate(project)
    if RECEIPT in previous:
        validate_snapshot(project, previous)
        return {'changed': False, 'candidateSha256': snapshot_digest(previous),
                'sourceBindingRevision': HISTORICAL_BINDING_REVISION,
                'cases': 548, 'business': 80, 'gold': 100,
                'actualProductRuns': 0, 'formalAcceptanceEligible': False}
    outputs = build_revision(project, previous)
    result = revise_spec_bound_candidate(project, previous, outputs)
    # Now the history path named in the receipt exists; run the complete current
    # verifier rather than trusting the in-memory construction alone.
    from rebuild_dataset import verify_asset_snapshot
    verified = verify_asset_snapshot(project, read_candidate(project))
    result.update(candidateSha256=snapshot_digest(outputs),
                  sourceBindingRevision=HISTORICAL_BINDING_REVISION,
                  cases=548, business=80, gold=100,
                  actualProductRuns=verified['actualProductRuns'],
                  formalAcceptanceEligible=verified['formalAcceptanceEligible'])
    return result


if __name__ == '__main__':
    import argparse
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--project', type=Path, default=Path(__file__).resolve().parents[3])
    args = parser.parse_args()
    print(json.dumps(release(args.project), ensure_ascii=False, indent=2))
