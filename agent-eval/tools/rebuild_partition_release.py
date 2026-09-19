"""Apply the reviewed selected-source page grouping and split decisions."""
from collections import Counter
from copy import deepcopy
from datetime import date
import hashlib
import json
from pathlib import Path

from rebuild_annotations import validate_gold_annotations
from rebuild_case_release import assemble_case_files, canonical_digest, verify_case_files
from rebuild_cases import compile_scenarios
from rebuild_contracts import load_spec_contracts
from rebuild_dataset import json_bytes, verify_asset_snapshot
from rebuild_extraction import build_extraction_cases
from rebuild_fixtures import registered_scenarios
from rebuild_partitions import (
    REVIEW_METHODS, apply_partition_review, apply_selected_source_review,
    partition_record_path,
)
from rebuild_staging import candidate_lock, read_candidate, revise_partition_candidate, snapshot_digest


REVIEW_DATE = '2026-09-18'
RELATIONSHIPS = [
    {'groupId': 'source-document-000225-000229', 'sampleIds': ['000225', '000229'],
     'split': 'acceptance', 'roles': {'000225': 'first_or_header_page', '000229': 'continuation_or_tail_page'},
     'evidence': '同一Flora Landscape Management发票；第二页续接明细并给出Subtotal/Total/Paid。'},
    {'groupId': 'source-document-001897-001903', 'sampleIds': ['001897', '001903'],
     'split': 'development', 'roles': {'001897': 'first_or_header_page', '001903': 'continuation_or_tail_page'},
     'evidence': '同一CANON CANADA Invoice No.126；第一页为行1-3，第二页为行4-6及总额。'},
    {'groupId': 'source-document-002055-002091', 'sampleIds': ['002055', '002091'],
     'split': 'regression', 'roles': {'002055': 'first_or_header_page', '002091': 'continuation_or_tail_page'},
     'evidence': '同一CIRCA METALS Invoice#95572；第一页Subtotal191，第二页续接行4-6并形成349.72总额。'},
]


def _pin(path, raw):
    return {'path': path, 'bytes': len(raw), 'sha256': hashlib.sha256(raw).hexdigest()}


def _selection_receipt(previous, source_audit, decisions):
    return {
        'schemaVersion': 1,
        'kind': 'selected_source_relationship_review',
        'previousSelectionSha256': canonical_digest(previous),
        'previousSelection': deepcopy(previous),
        'previousNearDuplicateReview': deepcopy(source_audit['nearDuplicateReview']),
        'actor': {'kind': 'ai_assistant', 'id': 'codex-source-relationship-reviewer',
                  'reviewedOn': REVIEW_DATE},
        'scope': {'selectedSamples': 100, 'fullSourcePool': 2902},
        'methods': REVIEW_METHODS,
        'decisions': decisions,
        'unresolvedSelectedRelationships': [],
        'limitations': [
            '该记录是质量侧AI来源关系审查，不是Gold人工核验。',
            '未选择的2,802份来源不因此获得未来选样的近重复冻结结论。'],
    }


def build_partition_revision(project, snapshot):
    verify_asset_snapshot(project, snapshot)
    outputs = dict(snapshot)
    selection = json.loads(snapshot['manifests/selection.json'])
    source_audit = json.loads(snapshot['manifests/source-audit.json'])
    by_selected = {row['sampleId']: row for row in selection['samples']}
    gold_by_sample = {
        json.loads(raw)['sampleId']: (path, json.loads(raw))
        for path, raw in snapshot.items() if path.startswith('gold/')}
    decisions, changed = [], set()
    for relationship in RELATIONSHIPS:
        samples = relationship['sampleIds']
        decisions.append(deepcopy(relationship) | {
            'prior': [{'sampleId': sid, 'split': by_selected[sid]['split'],
                       'leakageGroup': by_selected[sid]['groupId']} for sid in samples],
            'policy': 'most_exposed_split_wins'})
        for sid in samples:
            selected = by_selected[sid]
            prior_split, prior_group = selected['split'], selected['groupId']
            path, previous = gold_by_sample[sid]
            packet = {
                'schemaVersion': 1, 'kind': 'selected_source_relationship_review',
                'sampleId': sid, 'baseGoldVersion': previous['version'],
                'baseGoldSha256': canonical_digest(previous),
                'priorSplit': prior_split, 'newSplit': relationship['split'],
                'priorLeakageGroup': prior_group, 'newLeakageGroup': relationship['groupId'],
                'relationship': 'same_invoice_distinct_page',
                'relatedSampleIds': samples, 'pageRole': relationship['roles'][sid],
                'originalSha256': next(p['sha256'] for p in previous['sourceSnapshot']
                                       if p['path'] == sid + '/original.jpg'),
                'decisionBasis': {
                    'visualReview': 'original_image_viewed',
                    'businessIdentity': 'same_invoice_confirmed',
                    'pageContinuity': 'distinct_continuation_pages',
                    'exposurePolicy': 'most_exposed_split_wins'},
                'actor': {'kind': 'ai_assistant', 'id': 'codex-source-relationship-reviewer',
                          'reviewedOn': REVIEW_DATE},
            }
            revised = apply_partition_review(previous, packet)
            record_path = partition_record_path(packet)
            outputs[record_path] = json_bytes({'previousGold': previous, 'review': packet})
            outputs[path] = json_bytes(revised)
            gold_by_sample[sid] = (path, revised)
            changed.add(sid)
    previous_selection = json.loads(snapshot['manifests/selection.json'])
    previous_source_audit = json.loads(snapshot['manifests/source-audit.json'])
    selection_receipt = _selection_receipt(previous_selection, previous_source_audit, decisions)
    selection, source_audit, selection_receipt_path, selection_receipt_raw = \
        apply_selected_source_review(previous_selection, previous_source_audit, selection_receipt)
    outputs[selection_receipt_path] = selection_receipt_raw
    outputs['manifests/selection.json'] = json_bytes(selection)
    outputs['manifests/source-audit.json'] = json_bytes(source_audit)
    contracts = load_spec_contracts(project)
    golds = [gold for _, gold in sorted(gold_by_sample.values())]
    cases = compile_scenarios(list(registered_scenarios().values()), contracts)
    cases += build_extraction_cases(golds, contracts)
    outputs = assemble_case_files(outputs, cases, contracts)
    report = json.loads(outputs['manifests/preparation-report.json'])
    report['goldSplitCounts'] = dict(sorted(Counter(g['split'] for g in golds).items()))
    report['remainingWork'] = [x for x in report['remainingWork']
                               if x != 'cross_split_near_duplicate_001897_001903']
    report['selectedSourceRelationshipReview'] = {
        'status': 'complete', 'confirmedMultiPageGroups': 3,
        'splitCountsAfterGrouping': report['goldSplitCounts'],
        'reviewRef': selection['sourceRelationshipReviewRef']}
    outputs['manifests/preparation-report.json'] = json_bytes(report)
    readiness = json.loads(outputs['manifests/readiness.json'])
    readiness['relatedSourceGroups'] = {
        'samples': sorted(changed), 'status': 'resolved_same_invoice_pages',
        'freezeBlocked': False, 'groupsMerged': True,
        'groupIds': [r['groupId'] for r in RELATIONSHIPS]}
    readiness['blockers'] = [b for b in readiness['blockers']
                             if b['id'] != 'cross_split_near_duplicate_001897_001903']
    for blocker in readiness['blockers']:
        if blocker['id'] == 'gold_annotation_and_human_review':
            blocker['detail'] = ('All 100 Gold candidates have original-image AI annotations; '
                                 'independent human verification remains incomplete.')
    outputs['manifests/readiness.json'] = json_bytes(readiness)
    outputs['manifests/inventory.json'] = json_bytes({'schemaVersion': 3, 'files': [
        _pin(path, raw) for path, raw in sorted(outputs.items())
        if path != 'manifests/inventory.json']})
    verify_case_files(outputs, contracts)
    verify_asset_snapshot(project, outputs)
    return outputs, changed


def prepare(project):
    project = Path(project).resolve()
    with candidate_lock(project):
        snapshot = read_candidate(project)
    outputs, changed = build_partition_revision(project, snapshot)
    result = revise_partition_candidate(project, snapshot, outputs, changed)
    result.update(changedSamples=sorted(changed), splitCounts=json.loads(
        outputs['manifests/preparation-report.json'])['goldSplitCounts'],
        candidateSha256=snapshot_digest(outputs), actualProductRuns=0,
        humanVerifiedGold=0, formalAcceptanceEligible=False)
    return result


if __name__ == '__main__':
    import argparse
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--project', default='.')
    args = parser.parse_args()
    print(json.dumps(prepare(args.project), ensure_ascii=False, indent=2))
