"""Read-only source audit; write new review aids without modifying the v1 assets.

Image/text similarity only schedules human review. It never establishes invoice
identity, freezes splits, accepts Gold, or records a product evaluation result.
"""
from __future__ import annotations

import argparse
from collections import Counter, defaultdict
import csv
import hashlib
import json
from pathlib import Path
import re
import unicodedata

from PIL import Image, ImageOps

from prepare_invoice_data import block_text, digest, read_json, safe_relative, write_new
from harness_paths import canonical_case_path, list_current_case_paths

VERSION = 'invoice-asset-audit-v1'
from invoice_scope import REVIEW_BATCHES as TARGETS
IDENTITY_FIELDS = ('invoice_number', 'seller_name', 'invoice_date', 'total_amount')


def normalized(value):
    return re.sub(r'\s+', '', unicodedata.normalize('NFKC', str(value or '')).casefold())


def image_features(path):
    with Image.open(path) as original:
        oriented = ImageOps.exif_transpose(original)
        width, height = oriented.size
        gray = oriented.convert('L').resize((9, 8), Image.Resampling.LANCZOS)
        pixels = [gray.getpixel((x, y)) for y in range(8) for x in range(9)]
        value = 0
        for y in range(8):
            for x in range(8):
                value = (value << 1) | (pixels[y * 9 + x] > pixels[y * 9 + x + 1])
    return {'width': width, 'height': height, 'dHash64': f'{value:016x}'}


def candidate_pairs(features):
    """Yield candidates, including conflicting identity evidence, without merging."""
    hashes = [int(row['dHash64'], 16) for row in features]
    identities = [{k: normalized(v) for k, v in row['identityCandidates'].items()}
                  for row in features]
    for i, a in enumerate(features):
        for j in range(i + 1, len(features)):
            b = features[j]
            distance = (hashes[i] ^ hashes[j]).bit_count()
            equal = [k for k in IDENTITY_FIELDS if identities[i].get(k)
                     and identities[i].get(k) == identities[j].get(k)]
            conflicts = [k for k in IDENTITY_FIELDS if identities[i].get(k)
                         and identities[j].get(k) and identities[i][k] != identities[j][k]]
            reasons = []
            if distance <= 4:
                reasons.append('dhash_hamming_le_4')
            if a['normalizedContentSha256'] and a['normalizedContentSha256'] == b['normalizedContentSha256']:
                reasons.append('normalized_content_equal')
            if 'invoice_number' in equal:
                reasons.append('invoice_number_candidate_equal')
            if all(k in equal for k in ('seller_name', 'invoice_date', 'total_amount')):
                reasons.append('seller_date_total_candidates_equal')
            same_group = a['leakageGroup'] == b['leakageGroup']
            if same_group:
                reasons.append('existing_leakage_group')
            if not reasons:
                continue
            strong = ('normalized_content_equal' in reasons or
                      ('invoice_number' in equal and 'seller_name' in equal
                       and any(k in equal for k in ('invoice_date', 'total_amount')) and not conflicts)
                      or ('seller_date_total_candidates_equal' in reasons and not conflicts))
            kind = ('strong_duplicate_candidate' if strong else
                    'identity_clue_requires_review' if any(r != 'dhash_hamming_le_4' for r in reasons)
                    else 'image_similarity_only')
            yield {'sampleIds': [a['sampleId'], b['sampleId']], 'reasons': reasons,
                   'candidateKind': kind,
                   'dHashDistance': distance, 'identityAgreements': equal,
                   'identityConflicts': conflicts, 'crossSplit': a['split'] != b['split'],
                   'splits': [a['split'], b['split']],
                   'existingLeakageGroups': [a['leakageGroup'], b['leakageGroup']],
                   'sameExistingLeakageGroup': same_group,
                   'evidenceRefs': [f'sample-features.json#/samples/{i}', f'sample-features.json#/samples/{j}'],
                   'status': 'review_pending', 'sameInvoiceConfirmed': None}


class CandidateComponents:
    """Connectivity is a review worklist, never a transitive identity assertion."""
    def __init__(self, features):
        self.features = {r['sampleId']: r for r in features}
        self.parent = {sid: sid for sid in self.features}
        self.touched = set()

    def find(self, sid):
        while self.parent[sid] != sid:
            self.parent[sid] = self.parent[self.parent[sid]]
            sid = self.parent[sid]
        return sid

    def add(self, pair):
        if pair.get('candidateKind') != 'strong_duplicate_candidate':
            return
        a, b = pair['sampleIds']
        self.touched.update((a, b))
        ar, br = self.find(a), self.find(b)
        self.parent[max(ar, br)] = min(ar, br)

    def result(self):
        groups = defaultdict(list)
        for sid in sorted(self.touched):
            groups[self.find(sid)].append(sid)
        result = []
        for root, members in sorted(groups.items()):
            splits = sorted({self.features[s]['split'] for s in members})
            result.append({'candidateGroupId': 'candidate-' + root, 'sampleIds': members,
                           'splits': splits, 'crossSplit': len(splits) > 1,
                           'existingLeakageGroups': sorted({self.features[s]['leakageGroup'] for s in members}),
                           'status': 'review_pending', 'applyAsLeakageGroup': False,
                           'meaning': 'connected_similarity_candidates_not_confirmed_same_invoice'})
        return result


def candidate_groups(features, pairs):
    components = CandidateComponents(features)
    for pair in pairs:
        components.add(pair)
    return components.result()


def case_eligible(case, gold, business):
    if case['sampleRole'] in ('allocation_anchor_only', 'synthetic_only'):
        return True
    sid = case['sampleId']
    if sid not in gold:
        return False
    needs_business = (case.get('inputMode') == 'simulated_structured_invoice'
                      or case.get('category') in ('matching', 'approval', 'submission'))
    return not needs_business or sid in business


def build_batches(samples, cases, targets=TARGETS):
    """Build deterministic cumulative review queues with dependency closure.

    Greedy family coverage chooses inputs first, then category-balanced queues
    choose cases. Existing splits are never changed. Full coverage gaps are
    reported rather than silently exceeding a target or using missing inputs.
    """
    selected = {s['sampleId']: s for s in samples if s['selectedForReview']}
    businesses = {sid for sid, s in selected.items() if s.get('businessRef')}
    all_families = {c['familyId'] for c in cases}
    by_sample = defaultdict(set)
    for case in cases:
        if case['sampleRole'] == 'input_source':
            by_sample[case['sampleId']].add(case['familyId'])
    gold, business, chosen = set(), set(), set()
    batches = []
    case_by_id = {c['id']: c for c in cases}
    if len(case_by_id) != len(cases):
        raise ValueError('Duplicate case identity')

    def split_label_counts(ids):
        counts = defaultdict(Counter)
        for sid in ids:
            flag = selected[sid].get('hasPublisherLabels')
            label = 'labelled' if flag is True else 'unlabelled' if flag is False else 'unknown'
            counts[selected[sid]['split']][label] += 1
        return {split: dict(counter) for split, counter in sorted(counts.items())}

    def extend_inputs(pool, active, count, covered):
        while len(active) < count:
            candidates = pool - active
            if not candidates:
                raise ValueError('Input budget target exceeds eligible pool')
            def stratum(s):
                return selected[s]['split'], selected[s].get('hasPublisherLabels')
            split_counts = Counter(stratum(s) for s in active)
            split_available = Counter(stratum(s) for s in pool)
            # More unrepresented families first; balanced split share breaks ties.
            sid = min(candidates, key=lambda s: (
                -len(by_sample[s] - covered),
                split_counts[stratum(s)] / split_available[stratum(s)], s))
            active.add(sid)
            covered.update(by_sample[sid])

    for number, (gold_target, business_target, case_target) in enumerate(targets, 1):
        if not (len(gold) <= gold_target and len(business) <= business_target and len(chosen) <= case_target):
            raise ValueError('Cumulative batch targets must be monotonic')
        covered = set().union(*(by_sample[s] for s in gold)) if gold else set()
        extend_inputs(businesses, business, business_target, covered)
        gold.update(business)
        if len(gold) > gold_target:
            raise ValueError('Business closure exceeds Gold budget target')
        extend_inputs(set(selected), gold, gold_target, covered)
        eligible = [c for c in cases if case_eligible(c, gold, business)]
        if len(eligible) < case_target:
            raise ValueError(f'Batch {number} has {len(eligible)} eligible cases for target {case_target}')
        covered = {case_by_id[c]['familyId'] for c in chosen}
        category_counts = Counter(case_by_id[c]['category'] for c in chosen)
        full_counts = Counter(c['category'] for c in cases)
        remaining = {c['id']: c for c in eligible if c['id'] not in chosen}
        # Sort/select dynamically so a repeated family cannot displace a new one.
        while len(chosen) < case_target:
            case = min(remaining.values(), key=lambda c: (
                c['familyId'] in covered,
                category_counts[c['category']] / full_counts[c['category']],
                c.get('replicaIndex', 1), c['id']))
            chosen.add(case['id'])
            covered.add(case['familyId'])
            category_counts[case['category']] += 1
            del remaining[case['id']]
        gaps = sorted(all_families - covered)
        batches.append({'batchId': f'batch{number}', 'status': 'review_pending',
                        'humanVerificationCompleted': False, 'acceptanceFrozen': False,
                        'gold': sorted(gold), 'business': sorted(business), 'cases': sorted(chosen),
                        'counts': {'gold': len(gold), 'business': len(business), 'cases': len(chosen)},
                        'goldSplitCounts': dict(Counter(selected[s]['split'] for s in gold)),
                        'businessSplitCounts': dict(Counter(selected[s]['split'] for s in business)),
                        'goldSplitLabelCounts': split_label_counts(gold),
                        'businessSplitLabelCounts': split_label_counts(business),
                        'caseCategoryCounts': dict(category_counts),
                        'coveredFamilyCount': len(covered), 'uncoveredFamilies': gaps,
                        'familyGaps': [{'familyId': family, 'reason': (
                            'not_selected_within_case_budget' if any(c['familyId'] == family for c in eligible)
                            else 'required_inputs_not_selected_in_this_batch')} for family in gaps]})
    return batches


def collect_features(project):
    quality = project / 'agent-eval/data'
    product = project / 'data/invoices/voxel51'
    manifest = read_json(product / 'manifest.json')
    splits = read_json(quality / 'manifests/splits.json')
    split_index = {s['sampleId']: s for s in splits['samples']}
    labels_index = defaultdict(list)
    for source in read_json(quality / 'source-labels/voxel51/manifest.json')['samples']:
        labels_index[source['canonicalSampleId']].append(source['sourceSampleId'])
    features = []
    for entry in manifest['samples']:
        sid = entry['sampleId']
        folder = safe_relative(product, sid)
        content = read_json(folder / 'content.json')
        pages = read_json(folder / 'pages.json')
        text = ' '.join(block_text(block) for block in content)
        identity, evidence, label_lines = {}, {}, None
        source_ids = sorted(labels_index[sid])
        if source_ids:
            relative = f'source-labels/voxel51/{source_ids[0]}/fields.json'
            labels = read_json(safe_relative(quality, relative))
            for name in IDENTITY_FIELDS:
                identity[name] = labels.get('fields', {}).get(name, {}).get('value')
                if identity[name] is not None:
                    evidence[name] = relative + '#/fields/' + name
            label_lines = len(labels.get('line_items', []))
        if not identity.get('invoice_number'):
            match = re.search(r'invoice\s*(?:no\.?|number|#)\s*:?\s*([A-Z0-9][A-Z0-9/-]{2,})', text, re.I)
            if match:
                identity['invoice_number'] = match.group(1)
                evidence['invoice_number'] = f'product:{sid}/content.json; regex_candidate_only'
        normalized_text = normalized(text)
        features.append({'sampleId': sid, **image_features(folder / 'original.jpg'),
                         'originalSha256': entry['originalSha256'],
                         'split': split_index[sid]['split'], 'leakageGroup': split_index[sid]['leakageGroup'],
                         'hasPublisherLabels': bool(source_ids), 'labelSourceIds': source_ids,
                         'pages': len(pages), 'blocks': len(content),
                         'tables': sum(b.get('type') == 'table' for b in content),
                         'publisherLineCandidateCount': label_lines,
                         'htmlTableRowCandidateCount': sum(len(re.findall(r'<tr\b', block_text(b), re.I)) for b in content),
                         'numericPatternCounts': {'dotDecimal': len(re.findall(r'\b\d+\.\d{1,2}\b', text)),
                                                  'commaDecimal': len(re.findall(r'\b\d+,\d{1,2}\b', text))},
                         'datePatternCounts': {'yearFirst': len(re.findall(r'\b\d{4}[-/]\d{1,2}[-/]\d{1,2}\b', text)),
                                               'yearLast': len(re.findall(r'\b\d{1,2}[-/]\d{1,2}[-/]\d{4}\b', text))},
                         'normalizedContentSha256': hashlib.sha256(normalized_text.encode()).hexdigest() if normalized_text else None,
                         'identityCandidates': identity, 'identityEvidence': evidence,
                         'identityCandidateStatus': 'unverified', 'featureMethod': 'machine_observation_not_human_layout_annotation',
                         'reviewStatus': 'review_pending'})
    return features, splits


def run(project, output, image_neighbors=10):
    project, output = Path(project).resolve(), Path(output).resolve()
    quality = project / 'agent-eval/data'
    if not output.is_relative_to(quality.resolve()) or output == quality.resolve():
        raise ValueError('Output must be a new directory inside agent-eval/data')
    if output.exists():
        raise ValueError('Refusing to overwrite an existing output directory')
    if image_neighbors < 1:
        raise ValueError('image neighbor count must be positive')
    features, splits = collect_features(project)
    feature_index = {s['sampleId']: s for s in features}
    for sample in splits['samples']:
        sample['hasPublisherLabels'] = feature_index[sample['sampleId']]['hasPublisherLabels']
    catalog = read_json(quality / 'manifests/case-catalog.json')
    cases = [read_json(path) for path in list_current_case_paths(quality)]
    batches = build_batches(splits['samples'], cases)
    output.mkdir(parents=True, exist_ok=False)
    write_new(output / 'sample-features.json', {'version': VERSION, 'samples': features})
    components = CandidateComponents(features)
    counts, reasons = Counter(), Counter()
    closest = defaultdict(list)
    with (output / 'near-duplicate-pairs.jsonl').open('x', encoding='utf-8', newline='\n') as stream:
        for pair in candidate_pairs(features):
            components.add(pair)
            counts['candidatePairs'] += 1
            counts['crossSplitPairs'] += int(pair['crossSplit'])
            counts['sameExistingGroupPairs'] += int(pair['sameExistingLeakageGroup'])
            counts[pair['candidateKind']] += 1
            reasons.update(pair['reasons'])
            if pair['candidateKind'] != 'image_similarity_only':
                stream.write(json.dumps(pair, ensure_ascii=False) + '\n')
                counts['detailedPairsWritten'] += 1
            else:
                for sid in pair['sampleIds']:
                    neighbors = closest[sid]
                    neighbors.append(pair)
                    neighbors.sort(key=lambda p: (p['dHashDistance'], p['sampleIds']))
                    del neighbors[image_neighbors:]
        retained = {tuple(p['sampleIds']): p for rows in closest.values() for p in rows}
        for _, pair in sorted(retained.items()):
            stream.write(json.dumps(pair, ensure_ascii=False) + '\n')
            counts['detailedPairsWritten'] += 1
        counts['imageSimilarityPairsRetained'] = len(retained)
    counts['omittedPairDetails'] = counts['candidatePairs'] - counts['detailedPairsWritten']
    groups = components.result()
    write_new(output / 'near-duplicate-groups.json', {'version': VERSION, 'status': 'review_pending',
              'groups': groups, 'automaticSplitChanges': False,
              'limitation': 'Connected similarity components are review candidates, not confirmed invoice identities.'})
    write_new(output / 'batches.json', {'version': VERSION, 'sourceVersion': catalog['version'],
              'selectionPolicy': 'cumulative_family_coverage_then_category_share_with_input_closure; split_and_label_strata_tiebreak', 'batches': batches})
    with (output / 'review-queue.csv').open('x', encoding='utf-8-sig', newline='') as stream:
        writer = csv.DictWriter(stream, fieldnames=['assetKind', 'assetId', 'firstBatch', 'split', 'assetRef', 'status'])
        writer.writeheader()
        seen = set()
        sample_index = {s['sampleId']: s for s in splits['samples']}
        case_index = {c['id']: c for c in cases}
        for batch in batches:
            for kind in ('gold', 'business', 'cases'):
                for asset_id in batch[kind]:
                    key = kind, asset_id
                    if key in seen:
                        continue
                    seen.add(key)
                    if kind == 'cases':
                        case = case_index[asset_id]
                        split, ref = case['split'], canonical_case_path(case)
                    else:
                        split, ref = sample_index[asset_id]['split'], f'{kind}/{asset_id}.json'
                    writer.writerow({'assetKind': kind, 'assetId': asset_id, 'firstBatch': batch['batchId'],
                                     'split': split, 'assetRef': ref, 'status': 'review_pending'})
    report = {'version': VERSION, 'status': 'machine_audit_completed_human_review_pending',
              'sourceManifestSha256': digest(project / 'data/invoices/voxel51/manifest.json'),
              'splitManifestSha256': digest(quality / 'manifests/splits.json'),
              'caseCatalogSha256': digest(quality / 'manifests/case-catalog.json'),
              'samplesInspected': len(features), **counts, 'candidateReasons': dict(reasons),
              'candidateGroups': len(groups), 'crossSplitCandidateGroups': sum(g['crossSplit'] for g in groups),
              'imageSimilarityNeighborsPerSample': image_neighbors,
              'detailOrder': 'all_identity_clues_then_union_of_top_image_neighbors',
              'allStrongPairsIncludedInGroups': True, 'imageSimilarityPairsNeverMerged': True,
              'pairsCompared': len(features) * (len(features) - 1) // 2,
              'uncomparedPairs': 0, 'humanVerifiedInvoices': 0,
              'acceptanceFrozen': False, 'sourceFilesModified': False,
              'limitations': ['dHash is sensitive to crop and layout and can match different invoices.',
                             'Matching invoice numbers and publisher fields are unverified clues.',
                             'Date/number patterns are machine counts, not confirmed locale annotations.',
                             'Candidate components must not be applied automatically as identity groups.',
                             'Image-only details use the union of each sample top nearest neighbors; totals include all pairs.',
                             'All strong and identity-clue pairs are retained. Image-only pairs do not form invoice candidate groups.'],
              'batches': [{k: b[k] for k in ('batchId', 'counts', 'coveredFamilyCount', 'uncoveredFamilies',
                                            'goldSplitLabelCounts', 'businessSplitLabelCounts')} for b in batches]}
    write_new(output / 'audit-report.json', report)
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--project', default='.')
    parser.add_argument('--output', required=True)
    parser.add_argument('--image-neighbors', type=int, default=10)
    args = parser.parse_args()
    report = run(args.project, args.output, args.image_neighbors)
    # No Gold, identity candidates or document text on stdout.
    print(json.dumps({k: report[k] for k in ('samplesInspected', 'candidatePairs', 'crossSplitPairs',
                                           'candidateGroups', 'omittedPairDetails', 'batches')}, ensure_ascii=False))


if __name__ == '__main__':
    main()
