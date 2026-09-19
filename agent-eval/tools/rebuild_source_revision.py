"""Controlled, reproducible source-binding migration of a private candidate.

Checks old indexed bytes and source files even when old full specification text
is unavailable. It does not claim historical semantic revalidation, content
approval, human review, product execution or acceptance eligibility.
"""
from copy import deepcopy
import hashlib
import json
from pathlib import Path

from rebuild_bindings import BINDING_2_PINS, PREVIOUS_PINS, contract_pins
from rebuild_case_release import assemble_case_files, verify_inventory, canonical_digest
from rebuild_dataset import json_bytes, verify_asset_snapshot
from rebuild_sources import file_pin
from rebuild_staging import snapshot_digest

RECEIPT = 'manifests/source-revision.json'
READINESS = 'manifests/readiness.json'


def reindex(files):
    files['manifests/inventory.json'] = json_bytes({'schemaVersion': 3, 'files': [
        {'path': p, 'bytes': len(raw), 'sha256': hashlib.sha256(raw).hexdigest()}
        for p, raw in sorted(files.items()) if p != 'manifests/inventory.json']})


def verify_preserved_snapshot(project, snapshot, expected_sha256):
    verify_inventory(snapshot)
    if snapshot_digest(snapshot) != expected_sha256:
        raise ValueError('Expected candidate snapshot differs')
    audit = json.loads(snapshot['manifests/source-audit.json'])
    if (audit['originalCount'], audit['publisherLabelCount']) != (2902, 1414):
        raise ValueError('Preserved source counts differ')
    if not any(p['root'] == 'quality' and p['path'] == 'manifests/splits.json' for p in audit['sourcePins']):
        raise ValueError('Historical split source pin missing')
    from rebuild_publication import quality_history_candidates
    quality_candidates = quality_history_candidates(project)
    for pin in audit['sourcePins']:
        if pin['root'] not in {'source', 'quality'}:
            raise ValueError('Unknown preserved source root')
        base = Path(project) / ('data/invoices/voxel51' if pin['root'] == 'source' else 'agent-eval/data')
        expected = {k: pin[k] for k in ('path', 'bytes', 'sha256')}
        if pin['root'] == 'quality':
            from rebuild_publication import preserved_quality_pin
            actual = preserved_quality_pin(project, expected, quality_candidates)
        else:
            actual = file_pin(base, pin['path'])
        if actual != expected:
            raise ValueError('Preserved source changed: ' + pin['path'])
    # Close historical catalog membership/digests and asset/control dependencies
    # without substituting the new source text for unavailable old source text.
    catalog = json.loads(snapshot['manifests/case-catalog.json'])
    entries = catalog['cases']
    if catalog['caseCount'] != len(entries) or len({e['id'] for e in entries}) != len(entries):
        raise ValueError('Historical catalog identity/count differs')
    if {e['path'] for e in entries} != {p for p in snapshot if p.startswith('cases/')}:
        raise ValueError('Historical catalog membership differs')
    cases = {e['id']: json.loads(snapshot[e['path']]) for e in entries}
    for entry in entries:
        raw, case = snapshot[entry['path']], cases[entry['id']]
        if (entry['bytes'] != len(raw) or entry['sha256'] != hashlib.sha256(raw).hexdigest()
                or entry['caseSha256'] != canonical_digest(case) or entry['version'] != case['version']):
            raise ValueError('Historical catalog digest/version differs')
        for ref in case.get('normalControlRefs', []) + case.get('comparisonRefs', []):
            peer = cases.get(ref['caseId'])
            if not peer or peer['version'] != ref['version'] or canonical_digest(peer) != ref['caseSha256']:
                raise ValueError('Historical control/comparison dependency differs')
        ref = case.get('businessRef')
        if ref:
            from rebuild_business_projection import asset_ref
            if ref != asset_ref(json.loads(snapshot[ref['path']])):
                raise ValueError('Historical business dependency differs')
        ref = case['oracle'].get('fieldGoldRef')
        if ref:
            gold = json.loads(snapshot[ref])
            if (canonical_digest(gold) != case['oracle']['fieldGoldSha256'] or
                    gold['version'] != case['oracle']['fieldGoldVersion']):
                raise ValueError('Historical Gold dependency differs')
    return len(audit['sourcePins'])


def readiness():
    descriptions = {
        'gold_annotation_and_human_review': 'All 100 Gold candidates have original-image AI annotations; independent human verification remains incomplete.',
        'business_content_review': '80 input packages retain their values; business content and split review pending.',
        'new_source_conditions': 'Current source binding is not an atomic condition or content coverage review.',
        'actions_S1': 'Distinct-object positive control still lacks cross-Job actual request/send-entry counting.',
        'actions_Q1': 'Independent correct/wrong/missing semantic fixtures for every necessary Actions check remain incomplete. The 30 positive submission-chain checks now use a shared semantic projector with identity, token, authority and time-window filtering; the remaining checks still need explicit equivalence-class coverage.',
        'runtime_input_evidence_and_error_contract': 'High-risk Runtime definitions now cover cancel/stop, retry ownership, budget continuity, partial usage, ErrorDescriptor propagation, shared impact, cleanup errors, confirmed internal invariants and post-commit output/delivery failure. Remaining semantic fixture review and real product evidence are still pending.',
        'cross_split_near_duplicate_001897_001903': 'Potential related pages in development/acceptance; distinct existing groups preserved; acceptance split freeze blocked pending image/group review.',
        'schema3_extraction_grader_and_paired_trials': 'Schema3 extraction scoring and trusted paired independent Trial receipts remain missing.',
        'actual_adapters_and_collectors': 'All materializations are offline plans; real adapters, evidence collectors and product runs remain missing.',
        'benchmark_integration': 'Eleven active Benchmark definitions and member bundles are assembled; content and atomic-coverage review remain incomplete.',
        'publication': 'Current work-in-progress materials are published at agent-eval/data; release freeze and baseline measurement remain pending.',
        'historical_spec_text_unavailable': 'Previous full specification bytes were not available; previous pins are preserved, historical source semantics not revalidated.'}
    return {'schemaVersion': 3, 'assembly': 'materials_built_work_in_progress',
            'contentReview': 'blocked', 'acceptanceFreeze': 'blocked',
            'formalAcceptanceEligible': False, 'actualProductRuns': 0,
            'actionsReview': {'S1': 'NOT_ADDRESSED', 'Q1': 'NOT_ADDRESSED',
                              **{f'S{i}': 'ADDRESSED' for i in range(2, 8)}},
            'relatedSourceGroups': {'samples': ['001897', '001903'], 'status': 'unresolved_cross_split',
                                    'freezeBlocked': True, 'groupsMerged': False},
            'blockers': [{'id': k, 'status': 'blocked', 'detail': v} for k, v in descriptions.items()]}


def validate_source_revision(project, expected, outputs):
    """Restrict this migration to exact known bindings and unchanged base values."""
    receipt = json.loads(outputs[RECEIPT])
    verify_preserved_snapshot(project, expected, receipt['previousCandidateSha256'])
    if json.loads(expected['manifests/preparation-report.json'])['specRefs'] != PREVIOUS_PINS:
        raise ValueError('Only the explicitly declared prior source binding can migrate')
    if receipt['previousSpecRefs'] != PREVIOUS_PINS or receipt['currentCompilationSpecRefs'] != BINDING_2_PINS:
        raise ValueError('Source migration pins differ')
    preserved = lambda p: p.startswith(('gold/', 'manifests/annotations/')) or p in {
        'manifests/source-audit.json', 'manifests/selection.json'}
    if {p:v for p,v in expected.items() if preserved(p)} != {p:v for p,v in outputs.items() if preserved(p)}:
        raise ValueError('Source revision must preserve Gold, annotations, selection and source bytes')
    from rebuild_business_projection import authored_business
    from rebuild_contracts import load_spec_contracts
    contracts = load_spec_contracts(project)
    if contract_pins(contracts) != BINDING_2_PINS:
        raise ValueError('Binding-2 migration specification changed')
    authored = authored_business(contracts)
    old_paths = {p for p in expected if p.startswith('business/')}
    if old_paths != {p for p in outputs if p.startswith('business/')} or len(old_paths) != 80:
        raise ValueError('Source revision cannot change business membership')
    for path in old_paths:
        old, new = json.loads(expected[path]), json.loads(outputs[path])
        allowed = deepcopy(old)
        allowed.update(version=old['version'] + 1, authoredVersion=old['version'],
                       specRefs=deepcopy(BINDING_2_PINS), creationSpecRefs=deepcopy(old['specRefs']),
                       sourceBindingRevision=2)
        if old.get('specRefs') != PREVIOUS_PINS or new != allowed or new != authored.get(new['id']):
            raise ValueError('Only the declared business source binding may change')
    verify_asset_snapshot(project, outputs)


def validate_receipt(snapshot):
    """Retain the migration proof while allowing later replayable revisions.

    ``readiness.json`` is a live projection: annotation, partition, content and
    runner revisions are expected to resolve individual blockers.  Binding the
    migration receipt to the complete initial projection made every legitimate
    downstream revision unverifiable.  The receipt itself remains immutable;
    the live projection is checked only for construction-stage invariants here.
    """
    if RECEIPT not in snapshot:
        return
    receipt = json.loads(snapshot[RECEIPT])
    if (receipt['previousSpecRefs'] != PREVIOUS_PINS or receipt['currentCompilationSpecRefs'] != BINDING_2_PINS
            or receipt['sourceBindingRevision'] != 2 or receipt['contentReview'] != 'blocked'):
        raise ValueError('Source revision contract differs')
    live_readiness = json.loads(snapshot[READINESS])
    if (live_readiness.get('schemaVersion') != 3 or
            live_readiness.get('assembly') not in {
                'published_548_work_in_progress', 'materials_built_work_in_progress'} or
            live_readiness.get('formalAcceptanceEligible') is not False or
            live_readiness.get('actualProductRuns') != 0 or
            not isinstance(live_readiness.get('blockers'), list) or
            any(x.get('status') != 'blocked' for x in live_readiness['blockers'])):
        raise ValueError('Current construction readiness contract differs')
    required = {p for p in snapshot if p.startswith('gold/') or p in {
        'manifests/source-audit.json', 'manifests/selection.json'}}
    preserved = receipt['preservedAssetSha256']
    if not required.issubset(preserved) or any(p not in snapshot for p in preserved):
        raise ValueError('Incomplete preserved asset receipt')
    # This receipt proves preservation AT the source migration. Later image
    # annotations retain the exact original in their validated revision chain.
    from rebuild_annotations import validate_gold_annotations
    baseline_gold, reachable = {}, set()
    for path in sorted(required):
        if not path.startswith('gold/'):
            continue
        value = json.loads(snapshot[path])
        validate_gold_annotations(value, snapshot)
        current = value
        revision_paths = set()
        while hashlib.sha256(json_bytes(current)).hexdigest() != preserved[path]:
            partition_ref = current.get('partitionReviewRef', {}).get('path')
            if partition_ref:
                if partition_ref in revision_paths:
                    raise ValueError('Gold partition revision cycle')
                revision_paths.add(partition_ref)
                from rebuild_partitions import validate_partition_record
                current = validate_partition_record(current, snapshot)
                continue
            ref = current.get('annotationRef', {}).get('path')
            if not ref or ref in revision_paths or ref in reachable or ref not in snapshot:
                raise ValueError('Gold no longer reaches source-migration baseline')
            revision_paths.add(ref)
            reachable.add(ref)
            current = json.loads(snapshot[ref])['previousGold']
        baseline_gold[value['sampleId']] = current
    new_annotations = {p for p in snapshot if p.startswith('manifests/annotations/')} - set(preserved)
    if new_annotations != reachable:
        raise ValueError('Unreachable annotation after source migration')
    if receipt['historyPath'] != 'data/.preparation-stage/history/candidate-' + receipt['previousCandidateSha256']:
        raise ValueError('Source revision history path differs')
    baseline_cases = None
    for kind, prefix in [('businessRevisions', 'business/'), ('caseRevisions', 'cases/')]:
        entries = receipt[kind]
        if {x['path'] for x in entries} != {p for p in snapshot if p.startswith(prefix)}:
            raise ValueError('Incomplete source revision membership')
        for entry in entries:
            if hashlib.sha256(snapshot[entry['path']]).hexdigest() != entry['afterSha256']:
                case = json.loads(snapshot[entry['path']])
                if kind != 'caseRevisions':
                    # A later registered specification-only rebinding may
                    # update business version and source pins while preserving
                    # the authored business projection. Its dedicated receipt
                    # and full current-author verifier prove that transition.
                    if ('manifests/spec-binding-review.json' not in snapshot or
                            case.get('sourceBindingRevision', 0) <= 2 or
                            type(case.get('authoredVersion')) is not int or
                            case.get('version') != (case['authoredVersion'] +
                                case['sourceBindingRevision'] - 1)):
                        raise ValueError('Source revision output digest differs')
                    continue
                if case.get('category') == 'extraction':
                    from rebuild_contracts import load_spec_contracts
                    from rebuild_extraction import build_extraction_cases
                    if baseline_cases is None:
                        baseline_cases = {c['id']: c for c in build_extraction_cases(list(baseline_gold.values()),
                            load_spec_contracts(Path(__file__).resolve().parents[2]))}
                    original = baseline_cases[case['id']]
                    if hashlib.sha256(json_bytes(original)).hexdigest() != entry['afterSha256']:
                        # A later extraction-grader revision may change only by
                        # publishing a higher authored Case under the same source
                        # binding. The enclosing full verifier still rebuilds and
                        # byte-compares every current Case and Gold pin.
                        provenance = case.get('provenance', {})
                        rebound = ('manifests/spec-binding-review.json' in snapshot and
                                   provenance.get('sourceBindingRevision', 0) > 2 and
                                   provenance.get('authoredVersion') == entry['authoredVersion'])
                        if (case.get('version', 0) <= entry['currentVersion'] or
                                provenance.get('sourceBindingRevision', 0) < 2 or
                                (not rebound and provenance.get('authoredVersion', 0) <= entry['authoredVersion'])):
                            raise ValueError('Extraction no longer derives from source-migration baseline')
                else:
                    # The source-migration receipt proves the then-current Case,
                    # not permanent immutability.  Later authored corrections are
                    # allowed only as an explicit higher author revision under the
                    # same source binding.  verify_case_files(), called by the
                    # enclosing dataset verifier, subsequently proves the exact
                    # bytes match the current registered author.
                    provenance = case.get('provenance', {})
                    rebound = ('manifests/spec-binding-review.json' in snapshot and
                               provenance.get('sourceBindingRevision', 0) > 2 and
                               provenance.get('authoredVersion') == entry['authoredVersion'])
                    if (case.get('version', 0) <= entry['currentVersion'] or
                            provenance.get('sourceBindingRevision', 0) < 2 or
                            (not rebound and provenance.get('authoredVersion', 0) <= entry['authoredVersion'])):
                        raise ValueError('Changed Case is not a higher authored revision')
    selection_path, audit_path = 'manifests/selection.json', 'manifests/source-audit.json'
    selection_changed = hashlib.sha256(snapshot[selection_path]).hexdigest() != preserved[selection_path]
    audit_changed = hashlib.sha256(snapshot[audit_path]).hexdigest() != preserved[audit_path]
    if selection_changed or audit_changed:
        if not (selection_changed and audit_changed):
            raise ValueError('Selection and source audit must revise atomically')
        from rebuild_partitions import validate_selected_source_revision
        validate_selected_source_revision(
            json.loads(snapshot[selection_path]), json.loads(snapshot[audit_path]), snapshot, preserved)
    for path, digest in receipt['preservedAssetSha256'].items():
        if (not path.startswith('gold/') and path not in {selection_path, audit_path} and
                hashlib.sha256(snapshot[path]).hexdigest() != digest):
            raise ValueError('Preserved source-revision asset bytes differ')


def build_source_revision(project, snapshot, expected_sha256):
    verify_preserved_snapshot(project, snapshot, expected_sha256)
    if RECEIPT in snapshot:
        verify_asset_snapshot(project, snapshot)
        return dict(snapshot)
    from rebuild_business_projection import authored_business
    from rebuild_cases import compile_scenarios
    from rebuild_contracts import load_spec_contracts
    from rebuild_extraction import build_extraction_cases
    from rebuild_fixtures import registered_scenarios
    contracts = load_spec_contracts(project)
    if contract_pins(contracts) != BINDING_2_PINS:
        raise ValueError('Binding-2 migration specification changed')
    outputs = dict(snapshot)
    for asset in authored_business(contracts).values():
        outputs['business/' + asset['id'] + '.json'] = json_bytes(asset)
    report = json.loads(outputs['manifests/preparation-report.json'])
    if report['specRefs'] != PREVIOUS_PINS:
        raise ValueError('Only the explicitly declared prior source binding can migrate')
    report.update(specRefs=deepcopy(BINDING_2_PINS), creationSpecRefs=deepcopy(PREVIOUS_PINS),
                  sourceBindingRevision=2, sourceContentReview='blocked',
                  remainingWork=[x['id'] for x in readiness()['blockers']])
    outputs['manifests/preparation-report.json'] = json_bytes(report)
    # Preserve and verify only actual existing snapshots. Never synthesize old text.
    spec_snapshots = []
    for identity, pin in zip(('product', 'evaluation'), BINDING_2_PINS):
        relative = f'.cache/dataset-rebuild/spec-snapshots/{identity}-{pin["sha256"]}.md'
        actual = file_pin(project, relative)
        if (actual['sha256'], actual['bytes']) != (pin['sha256'], pin['bytes']):
            raise ValueError('Existing specification snapshot differs')
        spec_snapshots.append(actual)
    preserved = {p:hashlib.sha256(raw).hexdigest() for p,raw in snapshot.items()
                 if p.startswith(('gold/', 'manifests/annotations/')) or p in {
                     'manifests/source-audit.json', 'manifests/selection.json'}}
    outputs[RECEIPT] = json_bytes({'schemaVersion': 3, 'operation': 'source_binding_revision',
        'sourceBindingRevision': 2, 'previousCandidateSha256': expected_sha256,
        'historyPath': 'data/.preparation-stage/history/candidate-' + expected_sha256,
        'previousSpecRefs': PREVIOUS_PINS, 'currentCompilationSpecRefs': BINDING_2_PINS,
        'previousFullSpecificationText': 'unavailable_not_reconstructed',
        'historicalValidation': 'complete_inventory_source_bytes_and_dependency_pins_only',
        'contentReview': 'blocked', 'actualProductRuns': 0, 'preservedAssetSha256': preserved,
        'existingSpecSnapshots': spec_snapshots,
        'versionPolicy': 'case=authoredVersion*1000+sourceBindingRevision; business=authoredVersion+1; Gold unchanged',
        'businessRevisions': [{'path': p, 'beforeSha256': hashlib.sha256(snapshot[p]).hexdigest(),
             'afterSha256': hashlib.sha256(outputs[p]).hexdigest(), 'inputUnchanged': True}
             for p in sorted(snapshot) if p.startswith('business/')]})
    outputs[READINESS] = json_bytes(readiness())
    golds = [json.loads(raw) for p,raw in sorted(snapshot.items()) if p.startswith('gold/')]
    cases = compile_scenarios(list(registered_scenarios().values()), contracts) + build_extraction_cases(golds, contracts)
    outputs = assemble_case_files(outputs, cases, contracts)
    receipt = json.loads(outputs[RECEIPT])
    receipt['caseRevisions'] = [
        {'path': p, 'previousVersion': json.loads(snapshot[p])['version'] if p in snapshot else None,
         'currentVersion': json.loads(raw)['version'],
         'authoredVersion': json.loads(raw)['provenance']['authoredVersion'],
         'beforeSha256': hashlib.sha256(snapshot[p]).hexdigest() if p in snapshot else None,
         'afterSha256': hashlib.sha256(raw).hexdigest(), 'sourceBindingRevision': 2}
        for p, raw in sorted(outputs.items()) if p.startswith('cases/')]
    outputs[RECEIPT] = json_bytes(receipt)
    reindex(outputs)
    if len(cases) != 548:
        raise ValueError('Explicit complete source revision requires all 548 Cases')
    validate_source_revision(project, snapshot, outputs)
    return outputs


def revise_sources(project, expected_sha256):
    from rebuild_staging import candidate_lock, read_candidate, revise_source_bound_candidate
    with candidate_lock(project):
        snapshot = read_candidate(project)
    outputs = build_source_revision(project, snapshot, expected_sha256)
    if outputs == snapshot:
        from rebuild_staging import revise_candidate
        result = revise_candidate(project, snapshot, outputs)
    else:
        result = revise_source_bound_candidate(project, snapshot, outputs)
    result.update(caseCount=548, goldCandidates=100, businessPackages=80,
                  actualProductRuns=0, formalAcceptanceEligible=False, activeDatasetChanged=False)
    return result
