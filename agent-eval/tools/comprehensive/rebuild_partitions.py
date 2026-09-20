"""Replayable selected-source relationship and split review.

This records an AI quality audit of source relationships.  It never grants
human Gold verification, product execution, or formal acceptance.
"""
from copy import deepcopy
from datetime import date
import hashlib
import json
import re

from rebuild_case_release import canonical_digest


SPLITS = {'development', 'regression', 'acceptance'}
PACKET_KEYS = {
    'schemaVersion', 'kind', 'sampleId', 'baseGoldVersion', 'baseGoldSha256',
    'priorSplit', 'newSplit', 'priorLeakageGroup', 'newLeakageGroup',
    'relationship', 'relatedSampleIds', 'pageRole', 'originalSha256',
    'decisionBasis', 'actor',
}
SELECTION_RECORD_KEYS = {
    'schemaVersion', 'kind', 'previousSelectionSha256', 'previousSelection',
    'previousNearDuplicateReview', 'actor', 'scope', 'methods', 'decisions',
    'unresolvedSelectedRelationships', 'limitations',
}
DECISION_KEYS = {'groupId', 'sampleIds', 'split', 'roles', 'evidence', 'prior', 'policy'}
REVIEW_METHODS = [
    'exact_original_sha256', 'normalized_parse_hash', 'prior_leakage_group',
    'invoice_number_and_entity_signals', 'fragment_and_row_continuity_scan',
    'targeted_original_image_visual_review', 'prior_use_exposure_check']


def _exact(value, keys, label):
    if not isinstance(value, dict) or set(value) != keys:
        raise ValueError('Unsupported ' + label)


def _text(value):
    return isinstance(value, str) and bool(value.strip())


def _identity(value):
    return _text(value) and re.fullmatch(r'[A-Za-z0-9_-]+', value) is not None


def _digest(value):
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True,
                                    separators=(',', ':'), allow_nan=False).encode()).hexdigest()


def _json_bytes(value):
    return (json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False) + '\n').encode()


def _pin(path, raw):
    return {'path': path, 'bytes': len(raw), 'sha256': hashlib.sha256(raw).hexdigest()}


def validate_partition_packet(gold, packet):
    _exact(packet, PACKET_KEYS, 'partition review packet')
    if packet['schemaVersion'] != 1 or packet['kind'] != 'selected_source_relationship_review':
        raise ValueError('Unregistered partition review protocol')
    if (packet['sampleId'] != gold.get('sampleId') or not _identity(packet['sampleId']) or
            packet['baseGoldVersion'] != gold.get('version') or
            packet['baseGoldSha256'] != canonical_digest(gold)):
        raise ValueError('Partition review does not bind exact Gold')
    if (packet['priorSplit'] != gold.get('split') or
            packet['priorLeakageGroup'] != gold.get('leakageGroup') or
            packet['newSplit'] not in SPLITS or not _identity(packet['newLeakageGroup'])):
        raise ValueError('Partition decision differs from prior or target state')
    if packet['relationship'] != 'same_invoice_distinct_page':
        raise ValueError('Only visually confirmed same-invoice pages are supported')
    peers = packet['relatedSampleIds']
    if (not isinstance(peers, list) or len(peers) < 2 or packet['sampleId'] not in peers or
            len(peers) != len(set(peers)) or not all(_identity(x) for x in peers)):
        raise ValueError('Complete related sample identities required')
    if packet['pageRole'] not in {'first_or_header_page', 'continuation_or_tail_page'}:
        raise ValueError('Explicit page role required')
    originals = [p for p in gold.get('sourceSnapshot', [])
                 if p.get('path') == packet['sampleId'] + '/original.jpg']
    if len(originals) != 1 or packet['originalSha256'] != originals[0]['sha256']:
        raise ValueError('Partition review original differs from pinned source')
    basis = packet['decisionBasis']
    _exact(basis, {'visualReview', 'businessIdentity', 'pageContinuity', 'exposurePolicy'},
           'partition decision basis')
    if basis != {
            'visualReview': 'original_image_viewed',
            'businessIdentity': 'same_invoice_confirmed',
            'pageContinuity': 'distinct_continuation_pages',
            'exposurePolicy': 'most_exposed_split_wins'}:
        raise ValueError('Unsupported partition decision basis')
    actor = packet['actor']
    _exact(actor, {'kind', 'id', 'reviewedOn'}, 'partition actor')
    if actor['kind'] != 'ai_assistant' or not _text(actor['id']):
        raise ValueError('This route is an AI source audit, never human verification')
    try:
        if date.fromisoformat(actor['reviewedOn']).isoformat() != actor['reviewedOn']:
            raise ValueError('Noncanonical review date')
    except (TypeError, ValueError) as error:
        raise ValueError('Actual partition review date required') from error
    if (gold.get('humanVerified') is not False or gold.get('eligibleForFieldScoring') is not False or
            gold.get('formalAcceptanceEligible') is not False):
        raise ValueError('Partition review cannot revise accepted Gold')


def partition_record_path(packet):
    if not _identity(packet.get('sampleId')):
        raise ValueError('Unsafe partition review identity')
    return ('manifests/partition-reviews/gold-fresh-' + packet['sampleId'] + '-' +
            _digest(packet) + '.json')


def apply_partition_review(gold, packet):
    validate_partition_packet(gold, packet)
    revised = deepcopy(gold)
    revised.update(version=gold['version'] + 1, split=packet['newSplit'],
                   leakageGroup=packet['newLeakageGroup'],
                   partitionStatus='selected_set_source_relationship_reviewed')
    revised['provenance'].update(
        selectedSourceRelationshipReviewed=True,
        partitionReviewActorKind='ai_assistant')
    revised['partitionReviewRef'] = {
        'path': partition_record_path(packet),
        'sha256': _digest(packet),
        'digestScope': 'canonical_partition_review_packet',
    }
    revised['previousGoldRef'] = {
        'id': gold['id'], 'version': gold['version'], 'sha256': canonical_digest(gold)}
    revised['blockingReasons'] = [
        reason for reason in gold['blockingReasons']
        if reason != 'split_and_exposure_review_required']
    return revised


def validate_partition_record(current, files):
    reference = current.get('partitionReviewRef')
    if not isinstance(reference, dict) or set(reference) != {'path', 'sha256', 'digestScope'}:
        raise ValueError('Invalid partition review reference')
    path = reference['path']
    if path not in files or reference['digestScope'] != 'canonical_partition_review_packet':
        raise ValueError('Missing partition review record')
    try:
        record = json.loads(files[path])
    except (UnicodeError, ValueError, TypeError) as error:
        raise ValueError('Invalid partition review record') from error
    _exact(record, {'previousGold', 'review'}, 'partition review record')
    packet = record['review']
    if (path != partition_record_path(packet) or reference['sha256'] != _digest(packet) or
            apply_partition_review(record['previousGold'], packet) != current):
        raise ValueError('Gold differs from its partition review receipt')
    return record['previousGold']


def validate_selection_review_record(record):
    """Validate the selection-wide decision independently of its output files."""
    _exact(record, SELECTION_RECORD_KEYS, 'selected-source review record')
    if record['schemaVersion'] != 1 or record['kind'] != 'selected_source_relationship_review':
        raise ValueError('Unregistered selected-source review protocol')
    previous = record['previousSelection']
    if (not isinstance(previous, dict) or record['previousSelectionSha256'] != canonical_digest(previous)
            or len(previous.get('samples', [])) != 100):
        raise ValueError('Selected-source review does not bind the prior selection')
    if not isinstance(record['previousNearDuplicateReview'], dict):
        raise ValueError('Prior near-duplicate state required')
    actor = record['actor']
    _exact(actor, {'kind', 'id', 'reviewedOn'}, 'selected-source actor')
    if actor['kind'] != 'ai_assistant' or not _text(actor['id']):
        raise ValueError('Selected-source review is an AI quality audit')
    try:
        if date.fromisoformat(actor['reviewedOn']).isoformat() != actor['reviewedOn']:
            raise ValueError('Noncanonical review date')
    except (TypeError, ValueError) as error:
        raise ValueError('Actual selected-source review date required') from error
    if record['scope'] != {'selectedSamples': 100, 'fullSourcePool': 2902}:
        raise ValueError('Selected-source review scope differs')
    if record['methods'] != REVIEW_METHODS or record['unresolvedSelectedRelationships'] != []:
        raise ValueError('Selected-source review method or result differs')
    if (not isinstance(record['limitations'], list) or len(record['limitations']) < 2 or
            not all(_text(x) for x in record['limitations'])):
        raise ValueError('Selected-source review limitations required')
    prior_by_id = {row['sampleId']: row for row in previous['samples']}
    decisions = record['decisions']
    if not isinstance(decisions, list) or not decisions:
        raise ValueError('Selected-source decisions required')
    seen = set()
    for decision in decisions:
        _exact(decision, DECISION_KEYS, 'selected-source decision')
        sample_ids = decision['sampleIds']
        if (not _identity(decision['groupId']) or decision['split'] not in SPLITS or
                not isinstance(sample_ids, list) or len(sample_ids) < 2 or
                len(sample_ids) != len(set(sample_ids)) or seen.intersection(sample_ids) or
                any(sid not in prior_by_id for sid in sample_ids) or
                decision['policy'] != 'most_exposed_split_wins' or not _text(decision['evidence'])):
            raise ValueError('Invalid selected-source decision')
        seen.update(sample_ids)
        if (set(decision['roles']) != set(sample_ids) or
                any(role not in {'first_or_header_page', 'continuation_or_tail_page'}
                    for role in decision['roles'].values())):
            raise ValueError('Selected-source page roles differ')
        expected_prior = [{'sampleId': sid, 'split': prior_by_id[sid]['split'],
                           'leakageGroup': prior_by_id[sid]['groupId']} for sid in sample_ids]
        if decision['prior'] != expected_prior:
            raise ValueError('Selected-source prior state differs')


def selection_review_record_path(record):
    validate_selection_review_record(record)
    return 'manifests/partition-reviews/selection-' + canonical_digest(record) + '.json'


def apply_selected_source_review(previous_selection, previous_source_audit, record):
    """Replay the exact allowed selection and source-audit changes."""
    validate_selection_review_record(record)
    if previous_selection != record['previousSelection']:
        raise ValueError('Selected-source review base differs')
    if previous_source_audit.get('nearDuplicateReview') != record['previousNearDuplicateReview']:
        raise ValueError('Prior source-audit review state differs')
    selection, source_audit = deepcopy(previous_selection), deepcopy(previous_source_audit)
    selected_by_id = {row['sampleId']: row for row in selection['samples']}
    source_by_id = {row['sampleId']: row for row in source_audit['samples']}
    changed = set()
    for decision in record['decisions']:
        sample_ids = decision['sampleIds']
        union_uses = sorted({use for sid in sample_ids
                             for use in selected_by_id[sid].get('priorUses', [])})
        for sid in sample_ids:
            selected = selected_by_id[sid]
            selected.update(split=decision['split'], groupId=decision['groupId'],
                            groupPriorUses=union_uses,
                            exposureStatus='selected_set_reviewed_no_cross_use',
                            formalAcceptanceEligible=False)
            selected['selectionRationale'] = deepcopy(selected['selectionRationale']) | {
                'sourceRelationshipReview': 'same_invoice_distinct_page',
                'partitionPolicy': 'most_exposed_split_wins'}
            source_by_id[sid]['groupId'] = decision['groupId']
            changed.add(sid)
    for selected in selection['samples']:
        if selected['sampleId'] not in changed:
            selected['exposureStatus'] = 'selected_set_reviewed_no_cross_use'
    selection.update(status='selected_set_source_relationship_review_complete',
                     publishedOrReviewed=True, reviewRequired=[])
    raw = _json_bytes(record)
    path = selection_review_record_path(record)
    reference = _pin(path, raw)
    selection['sourceRelationshipReviewRef'] = reference
    source_audit['nearDuplicateReview'] = {
        'status': 'selected_sample_review_complete_full_source_pool_open',
        'implementedSignals': [
            'exact_original_sha256', 'exact_normalized_parse', 'prior_leakage_groups',
            'invoice_number_review_signal', 'business_identity_review',
            'fragment_and_row_continuity_scan', 'original_image_visual_review',
            'exposure_confirmation'],
        'selectedReviewRef': reference,
        'confirmedGroups': [x['groupId'] for x in record['decisions']],
        'remaining': ['future_selection_requires_review_against_unselected_source_pool'],
    }
    return selection, source_audit, path, raw


def validate_selected_source_revision(selection, source_audit, files, preserved):
    """Return the exact pre-review bases after replaying the current outputs."""
    reference = selection.get('sourceRelationshipReviewRef')
    if not isinstance(reference, dict) or set(reference) != {'path', 'bytes', 'sha256'}:
        raise ValueError('Invalid selected-source review reference')
    path = reference['path']
    if path not in files or _pin(path, files[path]) != reference:
        raise ValueError('Missing or changed selected-source review record')
    try:
        record = json.loads(files[path])
    except (UnicodeError, ValueError, TypeError) as error:
        raise ValueError('Invalid selected-source review record') from error
    if path != selection_review_record_path(record):
        raise ValueError('Selected-source review path differs')
    previous_selection = record['previousSelection']
    if hashlib.sha256(_json_bytes(previous_selection)).hexdigest() != preserved['manifests/selection.json']:
        raise ValueError('Selected-source review does not reach migration selection')
    previous_audit = deepcopy(source_audit)
    previous_audit['nearDuplicateReview'] = deepcopy(record['previousNearDuplicateReview'])
    for decision in record['decisions']:
        prior = {row['sampleId']: row['leakageGroup'] for row in decision['prior']}
        for row in previous_audit['samples']:
            if row['sampleId'] in prior:
                row['groupId'] = prior[row['sampleId']]
    if hashlib.sha256(_json_bytes(previous_audit)).hexdigest() != preserved['manifests/source-audit.json']:
        raise ValueError('Selected-source review does not reach migration source audit')
    expected_selection, expected_audit, expected_path, expected_raw = apply_selected_source_review(
        previous_selection, previous_audit, record)
    if (path != expected_path or files[path] != expected_raw or
            selection != expected_selection or source_audit != expected_audit):
        raise ValueError('Selected-source outputs differ from replayed decision')
    return previous_selection, previous_audit
