"""Read-only audit of a prepared release; does not certify OCR, Gold or product behavior."""
from __future__ import annotations

import argparse
from collections import Counter
from decimal import Decimal
import hashlib
import json
from pathlib import Path, PurePosixPath, PureWindowsPath
import re

EXPECTED = {'extraction': 1200, 'matching': 1000, 'approval': 600, 'submission': 1000,
            'runtime': 1000, 'isolation': 800, 'platform': 400}


def load(path):
    return json.loads(path.read_text(encoding='utf-8-sig'))


def sha(path):
    h = hashlib.sha256()
    with path.open('rb') as stream:
        for part in iter(lambda: stream.read(1048576), b''):
            h.update(part)
    return h.hexdigest()


def require(condition, message):
    if not condition:
        raise ValueError(message)


def resolve(root, relative):
    require(isinstance(relative, str) and relative and '\\' not in relative
            and not PureWindowsPath(relative).drive and not PurePosixPath(relative).is_absolute()
            and '..' not in PurePosixPath(relative).parts, f'Unsafe reference: {relative}')
    path = root / relative
    require(path.resolve().is_relative_to(root.resolve()), f'Escaping reference: {relative}')
    require(path.is_file() and not path.is_symlink(), f'Missing or linked file: {relative}')
    return path


def check_descriptor(root, descriptor):
    path = resolve(root, descriptor['path'])
    require(path.stat().st_size == descriptor['bytes'], f'Size mismatch: {path}')
    require(sha(path) == descriptor['sha256'], f'Hash mismatch: {path}')
    return path


def walk(value):
    yield value
    if isinstance(value, dict):
        for x in value.values():
            yield from walk(x)
    elif isinstance(value, list):
        for x in value:
            yield from walk(x)


def indexed_jsonl(path, identity='caseId'):
    rows = [json.loads(line) for line in path.read_text(encoding='utf-8').splitlines() if line.strip()]
    index = {row[identity]: row for row in rows}
    require(len(index) == len(rows), f'Duplicate record in {path.name}')
    return index


def verify_current_artifacts(product, evaluation, cases, catalog, splits):
    index = {c['id']: c for c in cases}
    for entry in catalog['cases']:
        case = index[entry['id']]
        require(entry['path'] == f'cases/{case["category"]}/{case["id"]}.json', 'Noncanonical current case')
        require(all(case.get(k) == v for k, v in entry.items() if k != 'path'), 'Catalog differs from current case')
    requirements = load(evaluation/'manifests/requirements.json')
    for source in requirements['sourceHashes'].values():
        require(sha(resolve(product.resolve().parents[2], source['path'])) == source['sha256'], 'Requirements reference stale specs')
    audit = load(evaluation/'manifests/audit/audit-report.json')
    require(audit['sourceManifestSha256'] == sha(product/'manifest.json')
            and audit['splitManifestSha256'] == sha(evaluation/'manifests/splits.json')
            and audit['caseCatalogSha256'] == sha(evaluation/'manifests/case-catalog.json'), 'Audit references stale assets')
    from audit_invoice_assets import case_eligible
    prior = {'gold': set(), 'business': set(), 'cases': set()}
    for batch, expected in zip(load(evaluation/'manifests/audit/batches.json')['batches'],
                               ((100, 50, 500), (500, 250, 2500), (1200, 600, 6000)), strict=True):
        members = {kind: set(batch[kind]) for kind in prior}
        require(all(len(batch[kind]) == len(members[kind]) == count for kind, count in zip(prior, expected)), 'Batch budgets differ')
        require(all(prior[kind] <= members[kind] for kind in prior), 'Review batches are not cumulative')
        require(all(c in index and case_eligible(index[c], members['gold'], members['business'])
                    for c in members['cases']), 'Batch lacks referenced input')
        require(batch['coveredFamilyCount'] == len({index[c]['familyId'] for c in members['cases']}), 'Batch coverage inflated')
        prior = members
    materialization_root = evaluation/'manifests/materialization'
    records = indexed_jsonl(materialization_root/'cases.jsonl')
    fixtures = indexed_jsonl(materialization_root/'fixtures.jsonl')
    require(set(records) == set(index), 'Materialization case denominator differs')
    require(set(fixtures) == {k for k, v in records.items() if v['status'] == 'materialized'}, 'Materialization fixture membership differs')
    counts = Counter()
    for identity, row in records.items():
        case = index[identity]
        require(row['caseVersion'] == case['version'] and row['familyId'] == case['familyId']
                and row['sourceCaseSha256'] == sha(evaluation/f'cases/{case["category"]}/{identity}.json'), 'Materialization references stale case')
        counts[case['category']+'/'+row['status']] += 1
        if identity in fixtures:
            fixture = fixtures[identity]
            require(fixture['caseVersion'] == case['version'] and fixture['status'] == 'materialized', 'Fixture revision differs')
            for key in ('input', 'harness'):
                value_hash = hashlib.sha256(json.dumps(fixture[key], sort_keys=True, ensure_ascii=False).encode()).hexdigest()
                require(row[key+'Sha256'] == value_hash, 'Fixture bytes differ from recorded payload')
    report = load(materialization_root/'report.json')
    require(report['caseCount'] == len(index) and report['fixtureCount'] == len(fixtures)
            and report['counts'] == dict(counts) and report['actualProductRuns'] == 0, 'Materialization report contradicts artifacts')
    views = load(evaluation/'manifests/views.json')
    for stage, members in views['stages'].items():
        require(set(members) == {c['id'] for c in cases if c['stage'] == stage}, 'Stale phase view')
    for benchmark, members in views['benchmarks'].items():
        require(set(members) == {c['id'] for c in cases if benchmark in c['benchmarks']}, 'Stale benchmark view')


def verify(product, evaluation):
    product, evaluation = Path(product), Path(evaluation)
    manifest = load(resolve(product, 'manifest.json'))
    sample_index = {entry['sampleId']: entry for entry in manifest['samples']}
    require(len(sample_index) == len(manifest['samples']), 'Duplicate sample identifiers')
    require(len({entry['originalSha256'] for entry in manifest['samples']}) == len(sample_index), 'Original byte duplicates remain')
    require(all(sid in sample_index for sid in manifest['aliases'].values()), 'Invalid alias target')
    allowed_product = {'manifest.json'}
    images = 0
    for sid, entry in sample_index.items():
        meta_path = check_descriptor(product, entry['metadata'])
        allowed_product.add(meta_path.relative_to(product).as_posix())
        meta = load(meta_path)
        require(meta['sampleId'] == sid and meta['originalSha256'] == entry['originalSha256'], f'Wrong metadata identity: {sid}')
        require(meta['qualityStatus'] == 'not_checked', f'False quality certification: {sid}')
        text = json.dumps(meta, ensure_ascii=False)
        require(not re.search(r'(annotation\.json|fields\.json|[A-Za-z]:\\\\)', text), f'Label or old local path in metadata: {sid}')
        for f in meta['files']:
            p = check_descriptor(product / sid, f)
            allowed_product.add(p.relative_to(product).as_posix())
            images += p.suffix.lower() == '.jpg'
        require(sha(product / sid / 'original.jpg') == entry['originalSha256'], f'Original changed: {sid}')
        for name in ('content.json', 'pages.json'):
            content = load(product / sid / name)
            require(isinstance(content, list) and len(content) > 0, f'Empty parse: {sid}/{name}')
            for value in walk(content):
                if isinstance(value, dict) and value.get('img_path'):
                    resolve(product / sid, value['img_path'])
    actual_product = {p.relative_to(product).as_posix() for p in product.rglob('*') if p.is_file()}
    require(actual_product == allowed_product, f'Unexpected product files: {actual_product ^ allowed_product}')

    inventory = load(resolve(evaluation, 'manifests/inventory.json'))
    current = inventory.get('kind') == 'single_current_dataset'
    inventory_paths = [f['path'] for f in inventory['files']]
    require(len(inventory_paths) == len(set(inventory_paths)), 'Repeated inventory files')
    for descriptor in inventory['files']:
        path = check_descriptor(evaluation, descriptor)
        if path.suffix == '.json':
            load(path)
    actual_eval = {p.relative_to(evaluation).as_posix() for p in evaluation.rglob('*') if p.is_file()}
    extension_paths = set()
    workflow_path = evaluation / 'manifests/workflow-inventory.json'
    if workflow_path.exists():
        workflow = load(workflow_path)
        require(workflow['baseInventorySha256'] == sha(evaluation / 'manifests/inventory.json'), 'Workflow base snapshot changed')
        extension_paths.add('manifests/workflow-inventory.json')
        for descriptor in workflow['files']:
            require(descriptor['path'] not in extension_paths and descriptor['path'] not in inventory_paths,
                    'Workflow inventory overlaps or duplicates v1')
            extra = check_descriptor(evaluation, descriptor)
            if extra.suffix == '.json':
                load(extra)
            extension_paths.add(descriptor['path'])
    require(actual_eval == set(inventory_paths) | {'manifests/inventory.json'} | extension_paths, 'Quality inventory is incomplete')
    label_manifest = load(evaluation / 'source-labels/voxel51/manifest.json')
    require(label_manifest['humanVerified'] is False, 'Publisher labels certified as human Gold')
    for entry in label_manifest['samples']:
        require(manifest['aliases'].get(entry['sourceSampleId']) == entry['canonicalSampleId'], 'Label alias differs from original')
        require(sample_index[entry['canonicalSampleId']]['originalSha256'] == entry['originalSha256'], 'Label/original mismatch')
        for f in entry['files']:
            check_descriptor(evaluation, f)

    splits = load(evaluation / 'manifests/splits.json')
    by_sample = {x['sampleId']: x for x in splits['samples']}
    require(set(by_sample) == set(sample_index), 'Split sample coverage incomplete')
    group_splits = {}
    for entry in by_sample.values():
        group = entry['leakageGroup']
        require(group_splits.setdefault(group, entry['split']) == entry['split'], 'Leakage group crosses splits')
    gold_files = sorted(p for p in (evaluation / 'gold').glob('*.json') if re.fullmatch(r'\d{6}\.json', p.name))
    require(len(gold_files) == 1200, 'Gold review queue count differs from 1200')
    gold_splits = Counter()
    accepted = 0
    for path in gold_files:
        gold = load(path)
        sid = gold['sampleId']
        gold_splits[gold['split']] += 1
        require(gold['split'] == by_sample[sid]['split'], 'Gold split mismatch')
        if not current or not gold.get('reviewRecord'):
            require(gold['status'] == 'review_pending' and gold['humanVerified'] is False
                and gold['reviewedBy'] is None and gold['reviewedAt'] is None
                and gold['acceptedGoldVersion'] is None, 'Unverified Gold marked accepted')
            require(all(f['verifiedValue'] is None for f in gold['fields'].values()), 'Invented verified field value')
        accepted += bool(gold['humanVerified'])
        for value in walk(gold):
            if isinstance(value, dict) and 'asset' in value and 'pointer' in value:
                blocks = load(resolve(product, value['asset']))
                index = int(value['pointer'].lstrip('/'))
                require(0 <= index < len(blocks), 'Evidence pointer out of bounds')
                require(value['pageNumber'] == blocks[index].get('page_idx', 0) + 1, 'Evidence page mismatch')
        if gold.get('sourceLabelRef'):
            labels = load(resolve(evaluation, gold['sourceLabelRef']))
            for key, f in gold['fields'].items():
                if f.get('candidateSource') == 'publisher_annotation':
                    require(f['candidateValue'] == labels['fields'][key]['value'], 'Provider candidate changed')
    require(gold_splits == {'development': 600, 'regression': 200, 'acceptance': 400}, 'Gold split quotas differ')
    business_files = sorted(p for p in (evaluation / 'business').glob('*.json') if re.fullmatch(r'\d{6}\.json', p.name))
    require(len(business_files) == 600, 'Business fixture count differs')
    business_splits = Counter()
    for path in business_files:
        b = load(path)
        business_splits[b['split']] += 1
        require(b['kind'] == 'synthetic_business_fixture' and (current or b['humanVerified'] is False), 'Misrepresented fixture origin')
        require(b['split'] == by_sample[b['sampleId']]['split'], 'Business split mismatch')
        require(b['input']['historicalEntries'] == [] and b['input']['approval']['status'] == 'not_requested', 'Invented successful initial business state')
        invoice = b['input']['invoice']
        net_sum = tax_sum = Decimal('0')
        for line in invoice['lines']:
            net = (Decimal(line['quantity']) * Decimal(line['unitPrice'])).quantize(Decimal('.01'))
            tax = (net * Decimal(line['taxRate']) / 100).quantize(Decimal('.01'))
            require(Decimal(line['netAmount']) == net and Decimal(line['taxAmount']) == tax
                    and Decimal(line['grossAmount']) == net+tax, 'Simulation line arithmetic mismatch')
            net_sum += net
            tax_sum += tax
        require(Decimal(invoice['netAmount']) == net_sum and Decimal(invoice['taxAmount']) == tax_sum
                and Decimal(invoice['totalAmount']) == net_sum+tax_sum, 'Simulation header arithmetic mismatch')
        po = b['input']['purchaseOrders'][0]
        require(po['lines'] == invoice['lines'] and po['supplierId'] == invoice['supplierId'], 'Base order does not match fixture invoice')
        receipts = b['input']['goodsReceipts'][0]['lines']
        require([x['receivedQuantity'] for x in receipts] == [x['quantity'] for x in invoice['lines']], 'Base receipt mismatch')
    require(business_splits == {'development': 300, 'regression': 100, 'acceptance': 200}, 'Business split quotas differ')

    catalog = load(evaluation / 'manifests/case-catalog.json')
    families = {x['category'] + '/' + x['id']: x for x in catalog['families']}
    require(len(families) == len(catalog['families']), 'Duplicate scenario family')
    ids = set()
    combinations = set()
    counts = Counter()
    case_splits = Counter()
    semantic_counts = Counter()
    for ref in catalog['cases']:
        case = load(resolve(evaluation, ref['path']))
        require(case['id'] not in ids, 'Duplicate Case ID')
        ids.add(case['id'])
        combination = ((case['semanticScenarioKey'], case['replicaIndex']) if current
                       else (case['familyId'], case['sampleId']))
        require(combination not in combinations, 'Repeated family/source instance')
        combinations.add(combination)
        require(case['familyId'] in families, 'Unknown scenario family')
        counts[case['category']] += 1
        case_splits[case['split']] += 1
        semantic_counts[case['semanticScenarioKey']] += 1
        require(case['replicaIndex'] == semantic_counts[case['semanticScenarioKey']], 'Replica numbering differs')
        require(case['initialEnvironment']['networkPolicy']['actualEnterpriseWrites'] == 'forbidden', 'Real business writes enabled')
        if case['sampleRole'] == 'allocation_anchor_only':
            require(case['inputAssets'] == [] and (current or case['semanticScenarioKey'] == case['familyId']), 'Unrelated invoice injected into mechanism fixture')
        require(case['split'] == by_sample[case['sampleId']]['split'], 'Case split mismatch')
        require(case['executionStatus'] == 'not_run' and (current or case['reviewStatus'] == 'pending')
                and case['eligibleForAcceptance'] is False, 'False case readiness or results')
        if not current:
            require(case['oracle']['status'] == 'review_pending' and case['scoring']['graderImplementation'] is None, 'Unimplemented grader claimed ready')
        else:
            checks = case['oracle'].get('checks', [])
            require(checks and len({x['checkId'] for x in checks}) == len(checks), 'Missing or duplicate atomic check')
            for check in checks:
                require(isinstance(check.get('required'), bool) and isinstance(check.get('hardConstraint'), bool)
                        and check.get('dimension'), 'Incomplete check contract')
                require(check.get('evidenceKinds') or check.get('evidenceRequirements'), 'Check has no evidence requirements')
        require(case['trigger'] and case['initialEnvironment']['scenarioSetup'] and case['dependencies'], 'Incomplete case initial conditions')
        require(case['oracle']['assertions'] and case['oracle']['forbidden'] and case['oracle']['requiredEvidence'], 'Incomplete case oracle')
        for assertion in case['oracle']['assertions']:
            require(assertion['op'] in ('eq', 'lte', 'gte', 'contains', 'absent'), 'Unsupported predicate')
            require(isinstance(assertion['path'], str) and assertion['path'], 'Missing observed result path')
        for item in case['inputAssets']:
            asset_root = product if item['root'] == 'product' else evaluation
            resolve(asset_root, item['path'])
            if item['root'] == 'quality':
                require(item['path'].startswith('business/') and item['pointer'] == '/input'
                        and item['projectionRequired'], 'Oracle or labels leaked through input assets')
        if case['inputMode'] == 'simulated_structured_invoice':
            require(all(x['root'] == 'quality' for x in case['inputAssets']), 'Simulation mixed with raw invoice answers')
            resolve(evaluation, case['initialEnvironment']['fixtureBaseRef'])
        if case['oracle']['fieldGoldRef']:
            resolve(evaluation, case['oracle']['fieldGoldRef'])
        if case['category'] == 'isolation':
            if not current or case.get('scenarioRole') != 'control':
                require(case['normalControlFamily'] in families, 'Security case lacks declared normal control family')
                require(int(families[case['normalControlFamily']]['phase'][1:]) <= int(case['stage'][1:]), 'Normal control requires a later stage')
        for value in walk(case):
            if isinstance(value, str):
                require(value not in ('$sampleId', '$businessId', '$caseId', '$split', '$invoiceNumber', '$total', '$supplierId'), 'Unexpanded parameter')
    require(counts == EXPECTED, f'Case quotas differ: {counts}')
    for split, members in splits['members'].items():
        require(len(members['cases']) == case_splits[split], 'Case split view mismatch')
        require(all(case_id in ids for case_id in members['cases']), 'Split references nonexistent Case')
        for kind in ('gold', 'business'):
            for name in members[kind]:
                require(load(resolve(evaluation, name))['split'] == split, 'Cross-split reference')
    views = load(evaluation / 'manifests/views.json')
    for dimension in ('stages', 'benchmarks'):
        for members in views[dimension].values():
            require(all(x in ids for x in members), 'View references missing Case')
    require(views['golden'] == [] and views['failures'] == [], 'Unrun cases presented as actual performance')
    report = load(evaluation / 'manifests/preparation-report.json')
    require(report['uniqueOriginals'] == len(sample_index) and report['caseDrafts'] == len(ids)
            and report['humanVerifiedInvoices'] == accepted and (current or accepted == 0)
            and report['executedCases'] == 0, 'Report contradicts assets')
    require(report['distinctSemanticScenarioKeys'] == len(semantic_counts)
            and report['replicaInstancesBeyondFirst'] == sum(n-1 for n in semantic_counts.values()), 'Semantic coverage count inflated')
    if current:
        from invoice_requirements import validate_coverage
        from review_invoice_data import validate_current_assets
        validate_current_assets(evaluation, product)
        cases = [load(resolve(evaluation, ref['path'])) for ref in catalog['cases']]
        validate_coverage(cases, load(evaluation/'manifests/requirements.json'), load(evaluation/'manifests/coverage.json'))
        verify_current_artifacts(product, evaluation, cases, catalog, splits)
        require(not any(re.search(r'(?:^|/)(?:audit|materialization)-v\d+|\.v\d+\.json$', x) for x in actual_eval),
                'Parallel versioned assets remain in current dataset')
        require(not workflow_path.exists() and not (evaluation/'manifests/releases').exists(), 'Parallel release inventories remain')
    return {'status': 'file_and_reference_checks_passed', 'uniqueOriginals': len(sample_index),
            'publisherLabels': len(label_manifest['samples']), 'productFiles': len(actual_product),
            'qualityFiles': len(actual_eval), 'imageAssets': images, 'goldCandidates': len(gold_files),
            'humanVerifiedGold': accepted, 'businessPackages': len(business_files),
            'caseDrafts': len(ids), 'scenarioFamilies': len(families),
            'distinctSemanticScenarioKeys': len(semantic_counts),
            'replicaInstancesBeyondFirst': sum(n-1 for n in semantic_counts.values()),
            'executedCases': 0, 'semanticReview': 'pending', 'countsByCategory': dict(counts)}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--project', type=Path, default=Path.cwd())
    parser.add_argument('--release', help='Additionally validate an explicitly pinned review release')
    args = parser.parse_args()
    result = verify(args.project / 'data/invoices/voxel51', args.project / 'agent-eval/data')
    if args.release:
        from review_invoice_data import resolve_release
        reviewed = resolve_release(args.project, args.release)
        result['reviewRelease'] = {'id': reviewed['id'], 'humanVerifiedCount': reviewed['humanVerifiedCount'],
                                  'formalAcceptanceEligible': reviewed['formalAcceptanceEligible']}
    print(json.dumps(result, ensure_ascii=False, indent=2))
