"""Prepare a fresh candidate without changing the active quality release.

prepare-assets builds fresh base assets. prepare-cases adds explicitly authored
episodes in an archived candidate revision. verify-assets verifies both layers.
None marks Gold reviewed, publishes a product score or replaces active files.
"""
import argparse
from collections import Counter
import hashlib
import json
from pathlib import Path
import tempfile

from rebuild_business import build_business_packages, validate_business, structural_signature
from rebuild_sources import contained, draft_gold, file_pin, inventory_sources, select_samples


SPEC_PATHS = ('docs/spec/00_Flowmate完整方案.md',
              'agent-eval/docs/spec/01_Flowmate_Agent评测总方案.md')
MODULE_BUDGETS = {'foundation': 36, 'agent-runtime': 128, 'tools': 20, 'events': 28,
                  'sessions': 24, 'context': 16, 'memory': 16, 'compaction': 12,
                  'workflow': 92, 'prompt-skills': 16, 'extensions': 12, 'subagents': 16,
                  'actions': 68, 'operations': 36, 'eval-infrastructure': 28}
STAGING_RELATIVE = 'data/.preparation-stage/rebuild'


def json_bytes(value):
    return (json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False) + '\n').encode('utf-8')


def stage_files(project, outputs):
    """Atomically expose a complete candidate or refuse a different prior one."""
    from rebuild_staging import candidate_lock
    with candidate_lock(project):
        return _stage_files_unlocked(project, outputs)


def _stage_files_unlocked(project, outputs):
    from initial_dataset import is_current
    if is_current(project):
        raise ValueError('Legacy staging is retired for the current-only dataset; use initial_dataset.py')
    project = Path(project).resolve()
    target = contained(project, STAGING_RELATIVE)
    for relative, data in outputs.items():
        contained(target, relative)
        if relative.split('/')[0] not in {'gold', 'business', 'cases', 'manifests'} or not isinstance(data, bytes):
            raise ValueError('Staging accepts only quality construction assets')
    if target.exists():
        existing = {p.relative_to(target).as_posix(): p.read_bytes() for p in target.rglob('*') if p.is_file()}
        if existing != outputs:
            raise ValueError('Existing candidate differs; preserve review work and create an explicit revision')
        return {'changed': False, 'path': str(target), 'files': len(outputs)}
    target.parent.mkdir(parents=True, exist_ok=True)
    # Temp cleanup is confined to this known preparation parent. No source or
    # active quality root can be a cleanup target, including through a symlink.
    with tempfile.TemporaryDirectory(prefix='rebuild-write-', dir=target.parent) as temporary:
        temporary = Path(temporary).resolve()
        if not temporary.is_relative_to(target.parent.resolve()):
            raise ValueError('Temporary directory escaped preparation root')
        candidate = temporary / 'candidate'
        candidate.mkdir()
        for relative, data in outputs.items():
            path = contained(candidate, relative)
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(data)
        candidate.rename(target)  # Refuses a concurrently published nonempty directory.
    return {'changed': True, 'path': str(target), 'files': len(outputs)}


def prepare_assets(project):
    project = Path(project).resolve()
    inventory = inventory_sources(project)
    if inventory['originalCount'] != 2902 or inventory['publisherLabelCount'] != 1414:
        raise ValueError('Unchanged source budget mismatch')
    specs = [file_pin(project, relative) for relative in SPEC_PATHS]
    selected = select_samples(inventory['samples'])
    business = build_business_packages()
    outputs = {}
    for row in selected:
        sample = row['sampleId']
        blocks = json.loads(contained(project, f'data/invoices/voxel51/{sample}/content.json').read_text(encoding='utf-8-sig'))
        gold = draft_gold(sample, blocks, row['split'], row['groupId'], row['files'])
        gold['specRefs'] = specs
        outputs[f'gold/{gold["id"]}.json'] = json_bytes(gold)
    from rebuild_bindings import bind_business
    from rebuild_contracts import load_spec_contracts
    business = [bind_business(asset, load_spec_contracts(project)) for asset in business]
    for asset in business:
        outputs[f'business/{asset["id"]}.json'] = json_bytes(asset)
    calibration_gold = [f'gold/gold-fresh-{r["sampleId"]}.json' for r in selected if r['split'] == 'development'][:20]
    calibration_business = []
    for kind in dict.fromkeys(a['primaryStructure'] for a in business):
        calibration_business.extend(f'business/{a["id"]}.json' for a in business if a['primaryStructure'] == kind and a['design']['variant'] <= 2)
    report = {
        'schemaVersion': 3, 'status': 'construction_candidate_not_published', 'specRefs': specs,
        'originals': 2902, 'publisherLabels': 1414, 'goldCandidates': len(selected),
        'humanVerifiedGold': 0, 'imageAnnotatedGold': 0, 'businessPackages': len(business),
        'businessContentReview': 'pending', 'caseBudget': MODULE_BUDGETS,
        'caseBudgetTotal': sum(MODULE_BUDGETS.values()), 'casesPreparedInThisStep': 0,
        'actualProductRuns': 0, 'baselineCount': 0, 'formalAcceptanceEligible': False,
        'goldSplitCounts': dict(Counter(x['split'] for x in selected)),
        'businessSplitCounts': dict(Counter(x['split'] for x in business)),
        'businessStructureCounts': dict(Counter(x['primaryStructure'] for x in business)),
        'distinctBusinessStructures': len({structural_signature(x) for x in business}),
        'calibrationBatch': {'gold': calibration_gold, 'business': calibration_business,
                             'caseTarget': 60, 'cases': [], 'status': 'incomplete'},
        'remainingWork': ['original_image_annotation_and_human_review', 'near_duplicate_and_exposure_review',
                           'complete_548_case_designs', 'runner_grader_and_benchmark_integration',
                           'content_review_and_control_closure', 'archive_publish_and_documentation'],
    }
    outputs['manifests/source-audit.json'] = json_bytes(inventory)
    outputs['manifests/selection.json'] = json_bytes({'schemaVersion': 3, 'specRefs': specs,
        'status': 'provisional_pending_near_duplicate_and_exposure_review', 'samples': selected,
        'publishedOrReviewed': False, 'reviewRequired': inventory['nearDuplicateReview']['remaining']})
    outputs['manifests/preparation-report.json'] = json_bytes(report)
    pins = [{'path': path, 'bytes': len(data), 'sha256': hashlib.sha256(data).hexdigest()}
            for path, data in sorted(outputs.items())]
    outputs['manifests/inventory.json'] = json_bytes({'schemaVersion': 3, 'files': pins})
    result = stage_files(project, outputs)
    result.update(goldCandidates=len(selected), businessPackages=len(business),
                  humanVerifiedGold=0, activeDatasetChanged=False)
    return result


def verify_assets(project):
    from rebuild_staging import candidate_lock, read_candidate
    with candidate_lock(project):
        return verify_asset_snapshot(project, read_candidate(project))


def verify_asset_snapshot(project, snapshot, require_current_authors=True):
    """Validate exactly one captured candidate, also used by the revision CAS."""
    project = Path(project).resolve()
    from rebuild_case_release import verify_case_files, verify_inventory
    from rebuild_contracts import load_spec_contracts
    from rebuild_staging import snapshot_digest
    verify_inventory(snapshot)
    from rebuild_spec_binding import validate_snapshot as validate_spec_binding
    validate_spec_binding(project, snapshot)
    from rebuild_spec_amendment import validate_snapshot as validate_spec_amendment
    validate_spec_amendment(project, snapshot)
    from rebuild_coverage_review import validate_snapshot as validate_coverage_review
    validate_coverage_review(project, snapshot)
    from rebuild_source_revision import validate_receipt
    validate_receipt(snapshot)
    from rebuild_actions_review import validate_snapshot as validate_actions_review
    validate_actions_review(project, snapshot)
    from rebuild_actions_semantic_review import validate_snapshot as validate_actions_semantic_review
    validate_actions_semantic_review(project, snapshot)
    from rebuild_actions_common_review import validate_snapshot as validate_actions_common_review
    validate_actions_common_review(project, snapshot)
    from rebuild_actions_state_review import validate_snapshot as validate_actions_state_review
    validate_actions_state_review(project, snapshot)
    from rebuild_actions_effect_review import validate_snapshot as validate_actions_effect_review
    validate_actions_effect_review(project, snapshot)
    from rebuild_actions_payload_review import validate_snapshot as validate_actions_payload_review
    validate_actions_payload_review(project, snapshot)
    from rebuild_actions_recovery_review import validate_snapshot as validate_actions_recovery_review
    validate_actions_recovery_review(project, snapshot)
    from rebuild_actions_presentation_review import validate_snapshot as validate_actions_presentation_review
    validate_actions_presentation_review(project, snapshot)
    from rebuild_runtime_evidence_review import validate_snapshot as validate_runtime_evidence_review
    validate_runtime_evidence_review(project, snapshot)
    from rebuild_grader_review import validate_snapshot as validate_grader_review
    validate_grader_review(project, snapshot)
    def read(relative):
        return json.loads(snapshot[relative].decode('utf-8-sig'))
    inventory = read('manifests/inventory.json')
    paths = [x['path'] for x in inventory['files']]
    if len(paths) != len(set(paths)):
        raise ValueError('Duplicate staged asset identity')
    actual_paths = set(snapshot)
    if actual_paths != set(paths) | {'manifests/inventory.json'}:
        raise ValueError('Unindexed or missing staged asset')
    for expected in inventory['files']:
        data = snapshot[expected['path']]
        if {'path': expected['path'], 'bytes': len(data), 'sha256': hashlib.sha256(data).hexdigest()} != expected:
            raise ValueError(f'Candidate digest changed: {expected["path"]}')
    report = read('manifests/preparation-report.json')
    for pin in report['specRefs']:
        if file_pin(project, pin['path']) != pin:
            raise ValueError(f'Spec changed: {pin["path"]}')
    source_audit = read('manifests/source-audit.json')
    if not any(p['root'] == 'quality' and p['path'] == 'manifests/splits.json'
               for p in source_audit['sourcePins']):
        raise ValueError('Historical split/exposure source pin missing; regenerate construction candidate')
    from rebuild_publication import quality_history_candidates
    quality_candidates = quality_history_candidates(project)
    for pin in source_audit['sourcePins']:
        base = project / ('data/invoices/voxel51' if pin['root'] == 'source' else 'agent-eval/data')
        expected = {k: pin[k] for k in ('path', 'bytes', 'sha256')}
        if pin['root'] == 'quality':
            from rebuild_publication import preserved_quality_pin
            actual = preserved_quality_pin(project, expected, quality_candidates)
        else:
            actual = file_pin(base, pin['path'])
        if actual != expected:
            raise ValueError(f'Preserved source changed: {pin["path"]}')
    business = [read(path) for path in paths if path.startswith('business/')]
    gold = [read(path) for path in paths if path.startswith('gold/')]
    if len(business) != 80 or len(gold) != 100:
        raise ValueError('Fresh asset count mismatch')
    for asset in business:
        errors = validate_business(asset)
        if errors:
            raise ValueError(f'{asset["id"]}: {errors}')
    for answer in gold:
        if answer['humanVerified']:
            if (answer.get('status') != 'human_reviewed' or answer.get('reviewStatus') != 'accepted' or
                    answer.get('eligibleForFieldScoring') is not True or
                    answer.get('acceptedGoldVersion') != answer.get('version') or
                    not answer.get('humanReviewRef') or not answer.get('reviewedBy') or
                    not answer.get('reviewedAt')):
                raise ValueError('Reviewed Gold status differs from its review evidence')
        elif (answer.get('eligibleForFieldScoring') is not False or
              answer.get('acceptedGoldVersion') is not None or answer.get('reviewStatus') != 'pending'):
            raise ValueError('Unreviewed Gold claims scoring eligibility')
        from rebuild_annotations import validate_gold_annotations, validate_annotation_sources
        validate_gold_annotations(answer, snapshot)
        current = answer
        while ('humanReviewRef' in current or 'annotationRef' in current or
               'partitionReviewRef' in current):
            if 'humanReviewRef' in current:
                current = read(current['humanReviewRef']['path'])['previousGold']
                continue
            if 'partitionReviewRef' in current:
                current = read(current['partitionReviewRef']['path'])['previousGold']
                continue
            record = read(current['annotationRef']['path'])
            validate_annotation_sources(project, record['previousGold'], record['annotation'])
            current = record['previousGold']
    annotated = sum('annotationRef' in answer for answer in gold)
    reviewed = sum(answer.get('humanVerified') is True for answer in gold)
    if (report.get('imageAnnotatedGold') != annotated or
            report.get('humanVerifiedGold') != reviewed):
        raise ValueError('Annotation/review count differs from candidate evidence')
    case_result = verify_case_files(snapshot, load_spec_contracts(project), require_current_authors)
    return {'valid': True, 'goldCandidates': len(gold), 'businessPackages': len(business),
            'imageAnnotatedGold': annotated, 'humanVerifiedGold': reviewed,
            'candidateSha256': snapshot_digest(snapshot),
            'unchangedSourceFilesChecked': len(source_audit['sourcePins']),
            'originals': source_audit['originalCount'], 'publisherLabels': source_audit['publisherLabelCount'],
            'actualProductRuns': 0, 'formalAcceptanceEligible': False,
            'casesPrepared': case_result['caseCount'], 'completeCaseBudget': case_result['completeBudget'],
            'remainingWork': report['remainingWork']}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command', choices=['prepare-assets', 'prepare-cases', 'verify-assets', 'annotate-gold', 'revise-sources'])
    parser.add_argument('--project', default='.')
    parser.add_argument('--annotations', help='UTF-8 JSON list of original-image AI annotation packets')
    parser.add_argument('--expected-sha256', help='Exact prior candidate digest, required for revise-sources')
    args = parser.parse_args()
    if (args.command == 'revise-sources') != bool(args.expected_sha256):
        parser.error('--expected-sha256 is required only for revise-sources')
    if (args.command == 'annotate-gold') != bool(args.annotations):
        parser.error('--annotations is required only for annotate-gold')
    if args.command == 'revise-sources':
        from rebuild_source_revision import revise_sources
        result = revise_sources(args.project, args.expected_sha256)
    elif args.command == 'annotate-gold':
        from rebuild_annotations import prepare_gold_annotations
        packets = json.loads(Path(args.annotations).read_text(encoding='utf-8-sig'))
        result = prepare_gold_annotations(args.project, packets)
    elif args.command == 'prepare-cases':
        from rebuild_case_release import prepare_cases
        result = prepare_cases(args.project)
    else:
        result = prepare_assets(args.project) if args.command == 'prepare-assets' else verify_assets(args.project)
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
