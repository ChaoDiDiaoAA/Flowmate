"""Replayable AI image annotations; these are never human acceptance records.

Source checks prove file identity and parsed quotations, not visual truth. The
image interpretation still requires the independent human review in the plan.
"""
from copy import deepcopy
from datetime import date
import hashlib
import json
from pathlib import Path
import re

from rebuild_sources import FIELD_NAMES, HEADERS, contained, file_pin, table_rows


PACKET_KEYS = {'schemaVersion', 'kind', 'sampleId', 'baseGoldVersion', 'baseGoldSha256',
               'originalSha256', 'actor', 'accessPurpose', 'usedForProductTuning',
               'fields', 'extraFields', 'lineItems', 'documentNotes', 'workpaper'}
FIELD_KEYS = {'valueState', 'rawValue', 'normalizedValue', 'availableInAllowedInput',
              'alternatives', 'note', 'evidence'}
STATES = {'present', 'source_not_provided', 'unreadable', 'ambiguous', 'not_applicable', 'invalid_literal'}
AVAILABILITY = {'available', 'partial', 'not_available', 'not_applicable'}
EXTRA_FIELDS = {'shipping_handling', 'paid_amount', 'balance_due', 'payment_terms',
                'buyer_invoice_email', 'document_tax_rate'}
LINE_FIELDS = set(HEADERS) | {'gross_amount', 'displayed_amount', 'discount_amount'}


def _digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=False,
                                    separators=(',', ':'), allow_nan=False).encode()).hexdigest()


def _exact(value, keys, label):
    if not isinstance(value, dict) or set(value) != keys:
        raise ValueError('Unsupported ' + label)


def _text(value):
    return isinstance(value, str) and bool(value.strip())


def _identity(value):
    return isinstance(value, str) and re.fullmatch(r'[A-Za-z0-9_-]+', value) is not None


def _hash(value):
    return isinstance(value, str) and re.fullmatch(r'[a-f0-9]{64}', value) is not None


def _field(field):
    _exact(field, FIELD_KEYS, 'annotation field')
    state = field['valueState']
    if state not in STATES or not _text(field['note']):
        raise ValueError('Explicit value state and interpretation note required')
    raw, normalized = field['rawValue'], field['normalizedValue']
    if state == 'present':
        if not _text(raw) or not _text(normalized):
            raise ValueError('Present value requires raw and normalized text')
    elif normalized is not None or (raw is not None and not _text(raw)):
        raise ValueError('Uncertain or absent value cannot have a settled normalization')
    if state == 'invalid_literal' and not _text(raw):
        raise ValueError('Invalid printed literal requires the actual printed text')
    if state in {'source_not_provided', 'not_applicable'} and raw is not None:
        raise ValueError('Absent value cannot claim a printed representation')
    availability = field['availableInAllowedInput']
    _exact(availability, {'parsed_only', 'parsed_with_source_evidence'}, 'input availability')
    if any(v not in AVAILABILITY for v in availability.values()):
        raise ValueError('Unknown input availability')
    alternatives = field['alternatives']
    if (not isinstance(alternatives, list) or not all(_text(v) for v in alternatives)
            or len(set(alternatives)) != len(alternatives)
            or (state != 'ambiguous' and alternatives)):
        raise ValueError('Alternatives belong only to ambiguous values')
    evidence = field['evidence']
    if not isinstance(evidence, list) or not evidence:
        raise ValueError('Original evidence required even for absent fields')
    has_original = False
    for item in evidence:
        if not isinstance(item, dict):
            raise ValueError('Invalid evidence')
        kind = item.get('kind')
        if type(item.get('pageNumber')) is not int or item['pageNumber'] < 1:
            raise ValueError('Positive page number required')
        if kind == 'original':
            _exact(item, {'kind', 'pageNumber', 'region', 'quote'}, 'original evidence')
            if not _text(item['region']) or (item['quote'] is not None and not _text(item['quote'])):
                raise ValueError('Original evidence requires a semantic region')
            has_original = True
        elif kind == 'parsed':
            keys = {'kind', 'pageNumber', 'pointer', 'quote'}
            if 'tableRow' in item or 'tableCell' in item:
                keys |= {'tableRow', 'tableCell'}
                if any(type(item.get(k)) is not int or item[k] < 0 for k in ('tableRow', 'tableCell')):
                    raise ValueError('Table evidence requires actual row and cell indices')
            _exact(item, keys, 'parsed evidence')
            if not _text(item['quote']) or not isinstance(item['pointer'], str) or not re.fullmatch(
                    r'/(0|[1-9][0-9]*)(?:/(?:[A-Za-z_][A-Za-z0-9_]*|0|[1-9][0-9]*))+', item['pointer']):
                raise ValueError('Explicit parse pointer and quotation required')
        else:
            raise ValueError('Unknown evidence kind')
    if not has_original:
        raise ValueError('A parse candidate is not an original image annotation')


def _fields(packet):
    yield from packet['fields'].values()
    yield from packet['extraFields'].values()
    for line in packet['lineItems']:
        yield from line['fields'].values()


def _validate(gold, packet):
    _exact(packet, PACKET_KEYS, 'annotation packet')
    if packet['schemaVersion'] != 1 or type(packet['schemaVersion']) is not int or packet['kind'] != 'original_image_ai_annotation':
        raise ValueError('Unregistered annotation protocol')
    sample = packet['sampleId']
    if not _identity(sample) or sample != gold.get('sampleId') or gold.get('id') != 'gold-fresh-' + sample:
        raise ValueError('Annotation identity differs from fresh Gold')
    if (type(packet['baseGoldVersion']) is not int or packet['baseGoldVersion'] < 1
            or packet['baseGoldVersion'] != gold.get('version')
            or not _hash(packet['baseGoldSha256']) or packet['baseGoldSha256'] != _digest(gold)):
        raise ValueError('Annotation does not bind the exact previous Gold')
    if (gold.get('humanVerified') is not False or gold.get('eligibleForFieldScoring') is not False
            or gold.get('acceptedGoldVersion') is not None or gold.get('reviewStatus') != 'pending'
            or gold.get('reviewedBy') != [] or gold.get('reviewedAt') is not None
            or gold.get('formalAcceptanceEligible') is not False):
        raise ValueError('AI import cannot replace accepted or reviewed content')
    pins = [p for p in gold['sourceSnapshot'] if p['path'] == sample + '/original.jpg']
    if len(pins) != 1 or not _hash(packet['originalSha256']) or packet['originalSha256'] != pins[0]['sha256']:
        raise ValueError('Annotation original differs from pinned source')
    _exact(packet['actor'], {'kind', 'id', 'annotatedOn'}, 'annotation actor')
    actor = packet['actor']
    if actor['kind'] != 'ai_assistant' or not _text(actor['id']):
        raise ValueError('This route records AI work only, never human verification')
    try:
        if date.fromisoformat(actor['annotatedOn']).isoformat() != actor['annotatedOn']:
            raise ValueError('Noncanonical annotation date')
    except (TypeError, ValueError) as error:
        raise ValueError('Actual annotation date required') from error
    if packet['accessPurpose'] != 'quality_authoring' or packet['usedForProductTuning'] is not False:
        raise ValueError('Only declared quality-authoring annotations supported')
    _exact(packet['fields'], set(FIELD_NAMES), 'complete header annotation')
    extra = packet['extraFields']
    if not isinstance(extra, dict) or not set(extra).issubset(EXTRA_FIELDS):
        raise ValueError('Unregistered extra field')
    lines = packet['lineItems']
    if not isinstance(lines, list):
        raise ValueError('Explicit annotated line list required')
    ids = set()
    for ordinal, line in enumerate(lines, 1):
        _exact(line, {'lineId', 'rowOrdinal', 'originalRowLabel', 'fields'}, 'annotated line')
        if (not _identity(line['lineId']) or line['lineId'] in ids
                or type(line['rowOrdinal']) is not int or line['rowOrdinal'] != ordinal
                or (line['originalRowLabel'] is not None and not _text(line['originalRowLabel']))):
            raise ValueError('Unique line identity and actual row correspondence required')
        ids.add(line['lineId'])
        if not isinstance(line['fields'], dict) or not set(HEADERS).issubset(line['fields']) or not set(line['fields']).issubset(LINE_FIELDS):
            raise ValueError('Complete line annotation required; do not infer missing quantity')
    for field in _fields(packet):
        _field(field)
    if not isinstance(packet['documentNotes'], list) or not packet['documentNotes'] or not all(_text(n) for n in packet['documentNotes']):
        raise ValueError('Document interpretation and completeness notes required')
    _exact(packet['workpaper'], {'text', 'sha256'}, 'workpaper')
    workpaper = packet['workpaper']
    if not _text(workpaper['text']) or hashlib.sha256(workpaper['text'].encode()).hexdigest() != workpaper['sha256']:
        raise ValueError('Workpaper digest mismatch')


def annotation_record_path(packet):
    if not _identity(packet.get('sampleId')):
        raise ValueError('Unsafe annotation identity')
    return 'manifests/annotations/gold-fresh-' + packet['sampleId'] + '-' + _digest(packet) + '.json'


def apply_annotation(gold, packet):
    """Pure revision; caller must separately check sources and persist the receipt."""
    _validate(gold, packet)
    revised = deepcopy(gold)
    revised.update(version=gold['version'] + 1, status='image_annotated_candidate',
                   fields=deepcopy(packet['fields']), extraFields=deepcopy(packet['extraFields']),
                   lineItems=deepcopy(packet['lineItems']), documentNotes=deepcopy(packet['documentNotes']))
    for field in _fields(revised):
        field['review'] = {'status': 'pending', 'reviewer': None}
    revised['provenance'].update(originalImageReviewed=True, imageAnnotationActorKind='ai_assistant')
    revised['annotationRef'] = {'path': annotation_record_path(packet), 'sha256': _digest(packet),
                                'digestScope': 'canonical_annotation_packet'}
    revised['previousGoldRef'] = {'id': gold['id'], 'version': gold['version'], 'sha256': _digest(gold)}
    revised['blockingReasons'] = [reason for reason in gold['blockingReasons'] if reason != 'original_image_annotation_required']
    return revised


def validate_gold_annotations(gold, files):
    """Replay the immutable receipt chain; edited fields cannot bypass its hashes."""
    current, seen = gold, set()
    while ('humanReviewRef' in current or 'annotationRef' in current or
           'partitionReviewRef' in current):
        if 'humanReviewRef' in current:
            from rebuild_gold_reviews import validate_human_review_record
            path = current['humanReviewRef'].get('path')
            if not isinstance(path, str) or path in seen:
                raise ValueError('Missing or cyclic human review history')
            seen.add(path)
            current = validate_human_review_record(current, files)
            continue
        if 'partitionReviewRef' in current:
            from rebuild_partitions import validate_partition_record
            path = current['partitionReviewRef'].get('path')
            if not isinstance(path, str) or path in seen:
                raise ValueError('Missing or cyclic partition history')
            seen.add(path)
            current = validate_partition_record(current, files)
            continue
        reference = current['annotationRef']
        path = reference.get('path')
        if not isinstance(path, str) or path in seen or path not in files:
            raise ValueError('Missing or cyclic annotation history')
        seen.add(path)
        try:
            record = json.loads(files[path])
        except (ValueError, TypeError, UnicodeDecodeError) as error:
            raise ValueError('Invalid annotation receipt') from error
        _exact(record, {'previousGold', 'annotation'}, 'annotation receipt')
        previous, packet = record['previousGold'], record['annotation']
        if path != annotation_record_path(packet) or apply_annotation(previous, packet) != current:
            raise ValueError('Gold differs from its recorded annotation revision')
        current = previous
    if (current.get('version') != 1 or current.get('status') != 'annotation_candidate'
            or current.get('provenance', {}).get('originalImageReviewed') is not False):
        raise ValueError('Annotation history must terminate at the original draft')


def validate_annotation_sources(project, gold, packet):
    """Check actual source pins and parsed locators; visual assertions stay pending."""
    _validate(gold, packet)
    root = Path(project) / 'data/invoices/voxel51'
    sample = gold['sampleId']
    seen = set()
    parsed_bytes = None
    for pin in gold['sourceSnapshot']:
        relative = pin['path']
        if not relative.startswith(sample + '/') or relative in seen:
            raise ValueError('Duplicate or cross-invoice source pin')
        seen.add(relative)
        if relative == sample + '/content.json':
            # Hash and parse the same captured bytes, never reopen after the
            # identity check: an intervening edit must not supply new evidence.
            parsed_bytes = contained(root, relative).read_bytes()
            actual = {'path': relative, 'bytes': len(parsed_bytes),
                      'sha256': hashlib.sha256(parsed_bytes).hexdigest()}
        else:
            actual = file_pin(root, relative)
        if actual != pin:
            raise ValueError('Actual source differs from annotation snapshot')
    if not {sample + '/original.jpg', sample + '/content.json'}.issubset(seen):
        raise ValueError('Paired image and parse required')
    blocks = json.loads(parsed_bytes.decode('utf-8-sig'))
    if not isinstance(blocks, list) or not blocks or not all(isinstance(b, dict) for b in blocks):
        raise ValueError('Unsupported source parse')
    for field in _fields(packet):
        for evidence in field['evidence']:
            if evidence['kind'] == 'original':
                if evidence['pageNumber'] != 1:
                    raise ValueError('Single original image supports only image page 1')
                continue
            parts = evidence['pointer'].split('/')[1:]
            try:
                block = blocks[int(parts[0])]
                value = blocks
                for part in parts:
                    value = value[int(part)] if isinstance(value, list) else value[part]
                if evidence['pageNumber'] != block.get('page_idx', 0) + 1:
                    raise ValueError('Evidence page differs from parse block')
                if 'tableRow' in evidence:
                    if parts[-1] != 'table_body' or not isinstance(value, str):
                        raise ValueError('Table cell reference must resolve to table HTML')
                    value = table_rows(value)[evidence['tableRow']][evidence['tableCell']]['text']
                if not isinstance(value, str) or evidence['quote'] not in value:
                    raise ValueError('Annotation quote not found at source locator')
            except (IndexError, KeyError, TypeError, ValueError) as error:
                raise ValueError('Invalid parsed annotation evidence') from error


def build_annotation_revision(project, snapshot, packets, contracts):
    """Construct indexed output without writing; unchanged packet imports are no-ops."""
    from rebuild_case_release import assemble_case_files, verify_case_files, verify_inventory
    from rebuild_dataset import json_bytes
    from rebuild_extraction import build_extraction_cases
    verify_inventory(snapshot)
    verify_case_files(snapshot, contracts)
    if not isinstance(packets, list) or not packets:
        raise ValueError('Nonempty annotation packet list required')
    outputs, seen = dict(snapshot), set()
    for packet in packets:
        if not isinstance(packet, dict) or not _identity(packet.get('sampleId')):
            raise ValueError('Invalid annotation packet identity')
        sample = packet['sampleId']
        if sample in seen:
            raise ValueError('Only one annotation revision per sample per batch')
        seen.add(sample)
        gold_path = 'gold/gold-fresh-' + sample + '.json'
        if gold_path not in snapshot:
            raise ValueError('Annotation sample not selected in candidate')
        gold = json.loads(snapshot[gold_path])
        validate_gold_annotations(gold, snapshot)
        receipt_path = annotation_record_path(packet)
        if receipt_path in snapshot:
            # A file at the right path alone is not proof that this Gold accepted
            # that packet: resolve its complete reachable receipt chain first.
            current, reachable = gold, False
            while 'annotationRef' in current:
                path = current['annotationRef']['path']
                record = json.loads(snapshot[path])
                if path == receipt_path:
                    if record['annotation'] != packet:
                        raise ValueError('Existing annotation receipt differs')
                    validate_annotation_sources(project, record['previousGold'], packet)
                    reachable = True
                current = record['previousGold']
            if not reachable:
                raise ValueError('Existing receipt is not part of the selected Gold history')
            continue
        validate_annotation_sources(project, gold, packet)
        outputs[gold_path] = json_bytes(apply_annotation(gold, packet))
        outputs[receipt_path] = json_bytes({'previousGold': gold, 'annotation': packet})
    if outputs == snapshot:
        return outputs
    golds = [json.loads(data) for path, data in sorted(outputs.items()) if path.startswith('gold/')]
    cases = [json.loads(data) for path, data in outputs.items()
             if path.startswith('cases/') and json.loads(data).get('category') != 'extraction']
    cases += build_extraction_cases(golds, contracts)
    outputs = assemble_case_files(outputs, cases, contracts)
    verify_case_files(outputs, contracts)
    return outputs


def prepare_gold_annotations(project, packets):
    """Verify, archive and install a private candidate revision, never publish it."""
    from rebuild_contracts import load_spec_contracts
    from rebuild_dataset import verify_asset_snapshot
    from rebuild_staging import candidate_lock, read_candidate, revise_annotated_candidate
    with candidate_lock(project):
        snapshot = read_candidate(project)
        verify_asset_snapshot(project, snapshot)
    outputs = build_annotation_revision(project, snapshot, packets, load_spec_contracts(project))
    # Full source/Case/report verification precedes the final compare-and-swap.
    verify_asset_snapshot(project, outputs)
    result = revise_annotated_candidate(project, snapshot, outputs)
    report = json.loads(outputs['manifests/preparation-report.json'])
    result.update(imageAnnotatedGold=report['imageAnnotatedGold'], humanVerifiedGold=0,
                  actualProductRuns=0, activeDatasetChanged=False, formalAcceptanceEligible=False)
    return result
