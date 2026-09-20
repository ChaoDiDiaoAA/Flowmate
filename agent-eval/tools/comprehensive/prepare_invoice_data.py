"""Prepare private invoice assets. Never alters the external source or overwrites a release."""
from __future__ import annotations

import argparse
from collections import Counter, defaultdict, deque
from decimal import Decimal
import hashlib
import html
import json
from pathlib import Path, PurePosixPath, PureWindowsPath
import re
import shutil
from datetime import datetime, timezone

VERSION = 'voxel51-preparation-v1'
SEED = 'flowmate-data-v1'
from invoice_scope import CASE_COUNTS as TARGETS
BASE_FILES = ('original.jpg', 'content.json', 'content.md', 'pages.json')
DROP_FILES = ('invoice.md', 'snapshot.json', 'record.json', 'receipt.json', 'parse.json')
SOURCE_DEPENDENT_MECHANISMS = {'isolation/allowed-source', 'isolation/allowed-selected-context',
                               'isolation/invoice-injection', 'runtime/context-stale'}
FIELD_NAMES = ('invoice_number', 'invoice_date', 'buyer_name', 'buyer_address',
               'seller_name', 'seller_address', 'currency', 'net_amount',
               'tax_amount', 'tax_rate', 'total_amount', 'buyer_tax_id', 'seller_tax_id')


def digest(path):
    h = hashlib.sha256()
    with Path(path).open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            h.update(chunk)
    return h.hexdigest()


def read_json(path):
    return json.loads(Path(path).read_text(encoding='utf-8-sig'))


def safe_relative(root, value):
    value = str(value)
    if ('\\' in value or PureWindowsPath(value).drive or PurePosixPath(value).is_absolute()
            or '..' in PurePosixPath(value).parts or not value or ':' in value):
        raise ValueError(f'Unsafe relative path: {value}')
    result = Path(root) / value
    if not result.resolve().is_relative_to(Path(root).resolve()):
        raise ValueError(f'Path escapes root: {value}')
    return result


def write_new(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open('x', encoding='utf-8', newline='\n') as out:
        json.dump(value, out, ensure_ascii=False, indent=2, allow_nan=False)
        out.write('\n')


def write_text_new(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open('x', encoding='utf-8', newline='\n') as out:
        out.write(value)


def decimal_value(value):
    """Conservative candidate conversion; a three-digit fraction is ambiguous."""
    value = str(value).strip()
    if not re.fullmatch(r'-?\d+(?:[.,]\d{1,2})?', value):
        return None
    return Decimal(value.replace(',', '.'))


def group_records(records):
    by_hash = defaultdict(list)
    for record in records:
        by_hash[record['sha256']].append(record['id'])
    return {min(ids): sorted(ids) for ids in by_hash.values()}


def file_info(path, root):
    return {'path': Path(path).relative_to(root).as_posix(),
            'bytes': Path(path).stat().st_size, 'sha256': digest(path)}


def image_refs(value):
    refs = set()
    if isinstance(value, str):
        refs.update(re.findall(r'assets/images/[A-Za-z0-9_.-]+', value))
    elif isinstance(value, dict):
        for key, item in value.items():
            if key == 'img_path' and item:
                refs.add(item)
            refs.update(image_refs(item))
    elif isinstance(value, list):
        for item in value:
            refs.update(image_refs(item))
    return refs


def block_text(block):
    return html.unescape(re.sub(r'<[^>]+>', ' ', block.get('text', block.get('table_body', ''))))


def ranking(value):
    return hashlib.sha256((SEED + str(value)).encode()).hexdigest()


def inspect_source(root):
    from PIL import Image
    rows = []
    totals = Counter()
    warnings = Counter()
    dirs = sorted(p for p in root.iterdir() if p.is_dir())
    if any(not re.fullmatch(r'\d{6}', p.name) for p in dirs):
        raise ValueError('Unexpected source directory; explicit classification is required.')
    for index, folder in enumerate(dirs, 1):
        for required in (*BASE_FILES, 'parse.json', 'record.json', 'receipt.json'):
            if not (folder / required).is_file():
                raise ValueError(f'Missing {folder.name}/{required}')
        for path in folder.rglob('*'):
            if not path.is_file():
                continue
            if path.is_symlink():
                raise ValueError(f'Symlink not accepted: {path}')
            totals['files'] += 1
            totals['bytes'] += path.stat().st_size
            if not path.stat().st_size:
                raise ValueError(f'Empty file: {path}')
            if path.suffix == '.json':
                read_json(path)
            elif path.suffix.lower() == '.jpg':
                with Image.open(path) as im:
                    im.verify()
                totals['imagesVerified'] += 1
        content = read_json(folder / 'content.json')
        pages = read_json(folder / 'pages.json')
        markdown = (folder / 'content.md').read_text(encoding='utf-8-sig')
        if not isinstance(content, list) or not content or not isinstance(pages, list) or not pages or not markdown.strip():
            raise ValueError(f'Empty or unsupported parse: {folder.name}')
        refs = image_refs([content, pages, markdown])
        for ref in refs:
            if not safe_relative(folder, ref).is_file():
                raise ValueError(f'Missing image: {folder.name}/{ref}')
        assets = {p.relative_to(folder).as_posix() for p in (folder / 'assets').rglob('*') if p.is_file()}
        totals['referencedImages'] += len(refs)
        totals['unreferencedImages'] += len(assets - refs)
        record = read_json(folder / 'record.json')
        sha = digest(folder / 'original.jpg')
        if record.get('original_sha256') != sha:
            raise ValueError(f'Original hash differs from source record: {folder.name}')
        labels = read_json(folder / 'fields.json') if (folder / 'fields.json').exists() else None
        if bool(labels) != (folder / 'annotation.json').exists():
            raise ValueError(f'Unpaired labels: {folder.name}')
        if labels:
            ann = read_json(folder / 'annotation.json')
            json.loads(ann['json_annotation'])
            totals['labelledSourceRecords'] += 1
        # Historical snapshots are diagnostics only, never the output manifest.
        snap = read_json(folder / 'snapshot.json')
        for f in snap.get('files', []):
            p = safe_relative(folder, f['path'])
            if not p.exists() or digest(p) != f['sha256']:
                warnings['oldSnapshotFileHashMismatch'] += 1
        joined = ' '.join(block_text(b) for b in content)
        number = None
        if labels:
            number = labels.get('fields', {}).get('invoice_number', {}).get('value')
        if not number:
            match = re.search(r'invoice\s*(?:no\.?|number|#)\s*:?\s*([A-Z0-9][A-Z0-9/-]{2,})', joined, re.I)
            number = match.group(1) if match else None
        rows.append({'id': folder.name, 'sha256': sha, 'dir': folder, 'record': record,
                     'content': content, 'pages': pages, 'refs': sorted(refs), 'labels': labels,
                     'invoiceNumberCandidate': number,
                     'parseIdentity': hashlib.sha256(re.sub(r'\s+', '', joined).lower().encode()).hexdigest(),
                     'stratum': (bool(labels), min(sum(b.get('type') == 'table' for b in content), 3),
                                 min(len(content) // 10, 5), len(pages))})
        if index % 300 == 0:
            print(f'Inspected {index}/{len(dirs)} source records', flush=True)
    return rows, totals, warnings


def balanced_take(rows, number):
    buckets = defaultdict(list)
    for row in rows:
        buckets[str(row['stratum'])].append(row)
    queues = [deque(sorted(values, key=lambda r: ranking(r['id']))) for _, values in sorted(buckets.items())]
    result = []
    while len(result) < number:
        progress = False
        for q in queues:
            if q and len(result) < number:
                result.append(q.popleft())
                progress = True
        if not progress:
            raise ValueError(f'Insufficient independent candidate groups for {number} samples')
    return result


def choose_samples(rows):
    # Conservative grouping: equal normalized parse OR equal extracted invoice number
    # stays in one group. This intentionally over-groups reused numbers across sellers.
    parent = {r['id']: r['id'] for r in rows}

    def find(x):
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    keys = {}
    for row in rows:
        identity_keys = [('parse', row['parseIdentity'])]
        if row['invoiceNumberCandidate']:
            identity_keys.append(('number', str(row['invoiceNumberCandidate']).strip().lower()))
        for key in identity_keys:
            if key in keys:
                a, b = find(row['id']), find(keys[key])
                parent[max(a, b)] = min(a, b)
            keys[key] = row['id']
    groups = defaultdict(list)
    for row in rows:
        row['leakageGroup'] = find(row['id'])
        groups[row['leakageGroup']].append(row)
    representatives = [sorted(g, key=lambda r: (not bool(r['labels']), ranking(r['id'])))[0] for g in groups.values()]
    annotated = balanced_take([r for r in representatives if r['labels']], 900)
    unannotated = balanced_take([r for r in representatives if not r['labels']], 300)
    selected = []
    assignments = {}
    a_start = u_start = 0
    for split, a_count, u_count in [('development', 450, 150), ('regression', 150, 50), ('acceptance', 300, 100)]:
        chosen = annotated[a_start:a_start+a_count] + unannotated[u_start:u_start+u_count]
        for row in chosen:
            row['split'] = split
            assignments[row['leakageGroup']] = split
        selected.extend(sorted(chosen, key=lambda r: ranking(r['id'])))
        a_start += a_count
        u_start += u_count
    for row in rows:
        row['split'] = assignments.get(row['leakageGroup'], 'reserve')
    return selected, groups


def import_product(rows, groups, product, evaluation):
    by_id = {r['id']: r for r in rows}
    manifest = {'schemaVersion': 1, 'datasetVersion': VERSION, 'status': 'file_integrity_verified',
                'qualityStatus': 'not_checked', 'samples': [], 'aliases': {},
                'exclusionPolicy': {'legacyFiles': list(DROP_FILES), 'labels': 'quality_root_only',
                                    'unreferencedAssets': 'excluded', 'duplicates': 'canonical_reference_only'}}
    labels_manifest = {'schemaVersion': 1, 'version': VERSION, 'kind': 'publisher_annotation',
                       'humanVerified': False, 'samples': []}
    canonical = []
    for sid, ids in sorted(groups.items()):
        row = by_id[sid]
        # Preserve whichever source has labels when a later alias is annotated.
        label_rows = [by_id[x] for x in ids if by_id[x]['labels']]
        if label_rows:
            row['labels'] = label_rows[0]['labels']
            row['labelSourceId'] = label_rows[0]['id']
        else:
            row['labelSourceId'] = None
        for other in ids[1:]:
            if any(digest(by_id[other]['dir'] / n) != digest(row['dir'] / n) for n in BASE_FILES[1:]):
                raise ValueError(f'Duplicate image with conflicting parse: {sid}, {other}')
        folder = product / sid
        folder.mkdir(parents=True)
        files = []
        for name in (*BASE_FILES, *row['refs']):
            source = safe_relative(row['dir'], name)
            target = safe_relative(folder, name)
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(source, target)
            if digest(source) != digest(target):
                raise ValueError(f'Copy checksum failure: {target}')
            files.append(file_info(target, folder))
        record = row['record']
        receipt = read_json(row['dir'] / 'receipt.json')
        parse = read_json(row['dir'] / 'parse.json')
        metadata = {'schemaVersion': 1, 'sampleId': sid, 'sourceRecordId': record.get('source_record_id'),
                    'datasetId': record.get('dataset_id'), 'datasetRevision': record.get('dataset_revision'),
                    'sourceUrl': receipt.get('stable_url'), 'sourceObservations': record.get('source_observations', []),
                    'originKind': record.get('origin_kind', 'unknown'), 'languageClaim': record.get('language'),
                    'allowedUsesClaim': record.get('allowed_uses', []), 'licenseVerification': 'not_verified',
                    'originalSha256': row['sha256'], 'parserKey': parse.get('parserKey'),
                    'parseAttemptId': parse.get('attemptId'), 'parseStartedAt': parse.get('startedAt'),
                    'qualityStatus': 'not_checked', 'integrityStatus': 'verified', 'files': files}
        write_new(folder / 'metadata.json', metadata)
        manifest['samples'].append({'sampleId': sid, 'originalSha256': row['sha256'],
                                    'metadata': file_info(folder / 'metadata.json', product)})
        for source_id in ids:
            manifest['aliases'][source_id] = sid
            source_row = by_id[source_id]
            if not source_row['labels'] or not (source_row['dir'] / 'fields.json').exists():
                continue
            label_dir = evaluation / 'source-labels' / 'voxel51' / source_id
            label_dir.mkdir(parents=True)
            label_files = []
            for name in ('annotation.json', 'fields.json'):
                target = label_dir / name
                shutil.copy2(source_row['dir'] / name, target)
                label_files.append(file_info(target, evaluation))
            labels_manifest['samples'].append({'sourceSampleId': source_id, 'canonicalSampleId': sid,
                                               'originalSha256': row['sha256'], 'files': label_files,
                                               'sourceRecordId': source_row['record'].get('source_record_id'),
                                               'datasetRevision': source_row['record'].get('dataset_revision')})
        canonical.append(row)
    write_new(product / 'manifest.json', manifest)
    write_new(evaluation / 'source-labels' / 'voxel51' / 'manifest.json', labels_manifest)
    return canonical, manifest, labels_manifest


def evidence_for(row, value):
    if value is None or not str(value).strip():
        return []
    needle = re.sub(r'\s+', '', str(value)).casefold()
    refs = []
    for index, block in enumerate(row['content']):
        haystack = re.sub(r'\s+', '', block_text(block)).casefold()
        if needle in haystack or needle.replace('.', ',') in haystack:
            refs.append({'asset': f"{row['id']}/content.json", 'pointer': f'/{index}',
                         'pageNumber': block.get('page_idx', 0) + 1, 'bbox': block.get('bbox'),
                         'method': 'text_match_candidate', 'humanVerified': False})
    return refs[:8]


def candidate_value(row, key):
    if row['labels']:
        field = row['labels'].get('fields', {}).get(key)
        if field and field.get('value') is not None:
            return field['value'], 'publisher_annotation', field.get('source_locator'), field.get('status')
    if key == 'invoice_number' and row['invoiceNumberCandidate']:
        return row['invoiceNumberCandidate'], 'parse_regex_candidate', None, 'unverified'
    joined = '\n'.join(block_text(b) for b in row['content'])
    if key == 'invoice_date':
        matches = list(dict.fromkeys(re.findall(r'\b\d{1,2}/\d{1,2}/\d{4}\b', joined)))
        if len(matches) == 1:
            return matches[0], 'parse_regex_candidate', None, 'date_interpretation_unverified'
    return None, 'not_established', None, 'not_established'


def make_gold(row):
    result = {'schemaVersion': 1, 'id': 'gold-' + row['id'], 'version': 1, 'sampleId': row['id'],
              'split': row['split'], 'status': 'review_pending', 'humanVerified': False,
              'reviewedBy': None, 'reviewedAt': None, 'acceptedGoldVersion': None,
              'sourceLabelRef': f"source-labels/voxel51/{row['labelSourceId']}/fields.json" if row['labelSourceId'] else None,
              'sourceEvidence': {'root': 'product', 'original': row['id'] + '/original.jpg',
                                 'content': row['id'] + '/content.json', 'pages': row['id'] + '/pages.json'},
              'fields': {}, 'lineItems': [],
              'reviewChecklist': ['逐字段核对原图与模型可见解析', '记录原值、规范值和币种/日期歧义',
                                  '核对每行数量、价格、税率及合计', '记录票面有值但解析缺失',
                                  '补充真实证据位置', '填写核验人、时间和新版本后才可发布Gold']}
    for key in FIELD_NAMES:
        value, method, locator, status = candidate_value(row, key)
        number = decimal_value(value) if key in ('net_amount', 'tax_amount', 'tax_rate', 'total_amount') and value else None
        result['fields'][key] = {'candidateValue': value, 'candidateNormalizedValue': str(number) if number is not None else None,
                                'candidateSource': method, 'providerStatus': status,
                                'providerLocator': locator, 'evidenceCandidates': evidence_for(row, value),
                                'reviewStatus': 'pending', 'verifiedValue': None, 'valueState': 'unverified'}
    if row['labels']:
        for index, line in enumerate(row['labels'].get('line_items', [])):
            result['lineItems'].append({'rowIndex': index, 'reviewStatus': 'pending',
                                       'candidates': {key: {'candidateValue': entry.get('value'),
                                                            'providerLocator': entry.get('source_locator'),
                                                            'evidenceCandidates': evidence_for(row, entry.get('value')),
                                                            'verifiedValue': None}
                                                      for key, entry in line.items()}})
    # Retain concrete table locations also for unlabelled invoices; no invented line answers.
    result['tableEvidenceCandidates'] = [{'asset': row['id'] + '/content.json', 'pointer': f'/{i}',
                                          'pageNumber': b.get('page_idx', 0) + 1, 'bbox': b.get('bbox')}
                                         for i, b in enumerate(row['content']) if b.get('type') == 'table']
    return result


def money(value):
    return str(Decimal(value).quantize(Decimal('0.01')))


def make_business(row, ordinal):
    sid = row['id']
    bid = 'business-' + sid
    supplier_id = 'SIM-SUP-' + sid
    lines = []
    supplied = row['labels'].get('line_items', []) if row['labels'] else []
    count = min(max(len(supplied), 1), 12)
    for i in range(count):
        description = supplied[i].get('description', {}).get('value') if i < len(supplied) else None
        quantity = 1 + (ordinal + i) % 12
        unit = Decimal(100 + (ordinal * 37 + i * 193) % 45000) / 100
        rate = Decimal((0, 5, 10, 20)[(ordinal + i) % 4])
        net = (unit * quantity).quantize(Decimal('.01'))
        tax = (net * rate / 100).quantize(Decimal('.01'))
        lines.append({'lineId': f'SIM-LINE-{i+1:02}', 'sku': f'SIM-SKU-{sid}-{i+1:02}',
                      'description': description or f'Synthetic item {i+1}',
                      'descriptionOrigin': 'publisher_candidate' if description else 'synthetic',
                      'quantity': str(quantity), 'unitPrice': money(unit), 'taxRate': str(rate),
                      'netAmount': money(net), 'taxAmount': money(tax), 'grossAmount': money(net+tax)})
    net = sum(Decimal(x['netAmount']) for x in lines)
    tax = sum(Decimal(x['taxAmount']) for x in lines)
    seller = candidate_value(row, 'seller_name')[0] or f'Synthetic supplier {sid}'
    buyer = candidate_value(row, 'buyer_name')[0] or 'Flowmate Simulation Buyer'
    return {'schemaVersion': 1, 'id': bid, 'version': 1, 'sampleId': sid, 'split': row['split'],
            'kind': 'synthetic_business_fixture', 'status': 'review_pending', 'humanVerified': False,
            'policyRef': 'manifests/fixture-policy.json',
            'provenance': {'sourceInvoice': sid, 'sourceRole': 'names_and_descriptions_candidate_only',
                           'syntheticFields': ['identifiers', 'dates', 'currency', 'quantities', 'prices', 'taxRates',
                                               'totals', 'order', 'receipts', 'history', 'authority'],
                           'warning': '模拟结构化输入不代表原图字段；不得将模拟金额当作原票Gold。'},
            'input': {'invoice': {'invoiceNumber': 'SIM-INV-' + sid, 'invoiceDate': '2026-01-15',
                                  'supplierId': supplier_id, 'sellerName': seller, 'buyerName': buyer,
                                  'currency': 'USD', 'lines': lines, 'netAmount': money(net),
                                  'taxAmount': money(tax), 'totalAmount': money(net+tax),
                                  'revision': 1, 'purchaseOrderId': 'SIM-PO-' + sid},
                      'suppliers': [{'id': supplier_id, 'name': seller, 'status': 'active',
                                     'aliases': [], 'nameOrigin': 'candidate_or_synthetic'}],
                      'purchaseOrders': [{'id': 'SIM-PO-' + sid, 'supplierId': supplier_id, 'status': 'open',
                                          'currency': 'USD', 'lines': [dict(x) for x in lines]}],
                      'goodsReceipts': [{'id': 'SIM-GR-' + sid, 'purchaseOrderId': 'SIM-PO-' + sid,
                                        'status': 'confirmed', 'lines': [{'lineId': x['lineId'], 'receivedQuantity': x['quantity']}
                                                                         for x in lines]}],
                      'historicalEntries': [], 'approval': {'status': 'not_requested', 'revision': 1},
                      'targetSystems': {'b2b': {'kind': 'local_simulator', 'records': []}},
                      'workspace': {'id': 'SIM-WS-' + row['split'], 'state': 'active', 'environment': 'test'}}}


def substitute(value, params):
    if isinstance(value, str):
        return params.get(value, value)
    if isinstance(value, list):
        return [substitute(x, params) for x in value]
    if isinstance(value, dict):
        return {k: substitute(v, params) for k, v in value.items()}
    return value


def make_cases(selected, businesses, evaluation):
    from invoice_case_catalog import CATALOG
    from harness_modules import enrich_case
    from harness_paths import canonical_case_path
    cases_index = []
    all_families = []
    semantic_counts = Counter()
    selected_by_id = {r['id']: r for r in selected}
    for category, target in TARGETS.items():
        families = CATALOG[category]
        for family in families:
            all_families.append({'category': category, **family})
        if category == 'extraction':
            assignment = [(selected[i], families[i % len(families)]) for i in range(target)]
        else:
            pool = [selected_by_id[sid] for sid in businesses] if category in ('matching', 'approval', 'submission') else selected
            pool = sorted(pool, key=lambda r: ranking(category + r['id']))
            # Unique (family, source) combinations, round-robin through families and splits.
            family_counts = Counter()
            assignment = []
            for i in range(target):
                f_index = i % len(families)
                family = families[f_index]
                offset = (family_counts[family['id']] + f_index * 31) % len(pool)
                assignment.append((pool[offset], family))
                family_counts[family['id']] += 1
        for n, (row, family) in enumerate(assignment, 1):
            sid = row['id']
            case_id = f'{category}-{n:05}'
            business = businesses.get(sid)
            params = {'$sampleId': sid, '$caseId': case_id, '$split': row['split'],
                      '$businessId': business['id'] if business else None,
                      '$invoiceNumber': business['input']['invoice']['invoiceNumber'] if business else row['invoiceNumberCandidate'],
                      '$total': business['input']['invoice']['totalAmount'] if business else None,
                      '$supplierId': business['input']['invoice']['supplierId'] if business else None}
            expanded = substitute(family, params)
            mode = expanded['inputMode']
            family_key = category + '/' + family['id']
            if mode == 'simulated_structured_invoice' and not business:
                raise ValueError(f'Business fixture missing: {case_id}')
            if mode == 'simulated_structured_invoice':
                input_assets = [{'root': 'quality', 'path': f'business/{sid}.json', 'pointer': '/input', 'projectionRequired': True}]
            elif category == 'extraction':
                input_assets = [{'root': 'product', 'path': sid + '/' + name} for name in ('content.json', 'pages.json', 'original.jpg')]
            elif family_key in SOURCE_DEPENDENT_MECHANISMS:
                input_assets = [{'root': 'product', 'path': sid + '/content.json', 'copyToIsolatedFixtureBeforeMutation': True}]
            else:
                input_assets = []
            source_affects_input = bool(input_assets)
            semantic_key = family_key + ('/' + sid if source_affects_input else '')
            semantic_counts[semantic_key] += 1
            value = {'schemaVersion': 1, 'id': case_id, 'version': 1, 'category': category,
                     'familyId': category + '/' + family['id'], 'sampleId': sid,
                     'sampleRole': 'input_source' if source_affects_input else 'allocation_anchor_only',
                     'semanticScenarioKey': semantic_key, 'replicaIndex': semantic_counts[semantic_key],
                     'coverageContribution': 'source_variant' if source_affects_input else 'mechanism_family_replica',
                     'leakageGroup': row['leakageGroup'], 'split': row['split'],
                     'title': expanded['title'], 'stage': expanded['phase'], 'benchmarks': expanded['benchmarks'],
                     'materialStatus': 'draft_generated', 'reviewStatus': 'pending', 'executionStatus': 'not_run',
                     'eligibleForAcceptance': False, 'inputMode': mode,
                     'trigger': expanded['trigger'], 'inputAssets': input_assets,
                     'initialEnvironment': {'kind': 'simulated', 'resetBeforeEachTrial': True,
                                            'fixtureBaseRef': f'business/{sid}.json' if mode == 'simulated_structured_invoice' else None,
                                            'scenarioSetup': expanded['initialState'],
                                            'scenarioSetupSemantics': 'declarative_setup_requires_reviewed_harness_adapter',
                                            'instanceId': 'SIM-' + case_id, 'workspaceId': 'SIM-WS-' + row['split'],
                                            'networkPolicy': {'businessTargets': 'local_simulators_only',
                                                              'modelProvider': 'requires_configured_evaluation_provider',
                                                              'providerConfigured': False,
                                                              'actualEnterpriseWrites': 'forbidden'},
                                            'observationScope': 'this_case_and_its_owned_entities_only'},
                     'oracle': {'version': 1, 'status': 'review_pending', 'basis': expanded['basis'],
                                'fieldGoldRef': f'gold/{sid}.json' if category == 'extraction' else None,
                                'assertions': expanded['expected'],
                                'forbidden': expanded['forbidden'], 'requiredEvidence': expanded['evidence'],
                                'missingEvidenceVerdict': 'insufficient_evidence'},
                     'scoring': {'method': 'human_field_review' if category == 'extraction' else 'deterministic_observation_assertions',
                                 'graderContractVersion': 1, 'graderImplementation': None,
                                 'hardConstraints': expanded['forbidden'], 'allRequiredAssertionsMustPass': True,
                                 'fieldAnswersUsable': False if category == 'extraction' else None,
                                 'aggregateInstruction': '按类别、场景族、原票组分别报告；重复Trial不增加样本数'},
                     'risks': expanded['risk'], 'dependencies': expanded['dependencies'],
                     'normalControlFamily': category + '/' + expanded['normalControl'] if expanded.get('normalControl') else None,
                     'provenance': {'kind': 'synthetic_case_from_project_contract', 'generatorVersion': VERSION,
                                    'reviewedBy': None, 'reviewedAt': None},
                     'blockedUntil': ['case_and_oracle_review', 'required_product_capabilities', 'harness_and_grader_implementation']
                                     + (['human_gold_review'] if category == 'extraction' else [])}
            value = enrich_case(value)
            path = evaluation / canonical_case_path(value)
            write_new(path, value)
            cases_index.append({'id': case_id, 'path': path.relative_to(evaluation).as_posix(),
                                'category': category, 'harnessModule': value['harnessModule'],
                                'familyId': value['familyId'], 'sampleId': sid,
                                'semanticScenarioKey': semantic_key, 'replicaIndex': value['replicaIndex'],
                                'sampleRole': value['sampleRole'],
                                'split': row['split'], 'stage': value['stage'], 'benchmarks': value['benchmarks']})
        print(f'Prepared {target} {category} case drafts ({len(families)} scenario families)', flush=True)
    write_new(evaluation / 'manifests' / 'case-catalog.json', {'schemaVersion': 1, 'version': VERSION,
               'status': 'review_pending', 'families': all_families, 'cases': cases_index})
    return cases_index, all_families


def make_fixture_policy():
    """Return the current synthetic invoice matching and submission policy."""
    return {'schemaVersion': 1, 'id': 'fixture-policy-v1', 'kind': 'synthetic_policy',
              'status': 'review_pending', 'scope': 'local_simulated_structured_invoice_only',
              'rules': {'currency': 'USD', 'moneyPrecision': 2, 'rounding': 'ROUND_HALF_EVEN',
                        'amountTolerance': '0.01',
                        'quantityMismatch': 'request_review', 'missingSupplier': 'request_review',
                        'ambiguousMatch': 'request_review', 'missingCurrency': 'request_review',
                        'validSubmissionConfirmationRequired': True, 'unknownSubmission': 'query_before_retry',
                        'defaultPoRequired': True, 'non-po-permitted': 'only_when_explicit_case_policy_marks_po_not_required',
                        'executionTargets': ['b2b'], 'actualExternalWrites': 'forbidden'},
              'basis': '用户确认的模拟业务数据准备范围；模拟金额及核对容差是测试假设；approval兼容字段表示提交确认。'}


def make_evaluation(canonical, product, evaluation):
    selected, leakage_groups = choose_samples(canonical)
    business_rows = []
    for split, count in [('development', 300), ('regression', 100), ('acceptance', 200)]:
        business_rows.extend(balanced_take([r for r in selected if r['split'] == split and r['labels']], count))
    businesses = {}
    for n, row in enumerate(business_rows, 1):
        business = make_business(row, n)
        businesses[row['id']] = business
        write_new(evaluation / 'business' / (row['id'] + '.json'), business)
    for row in selected:
        write_new(evaluation / 'gold' / (row['id'] + '.json'), make_gold(row))
    policy = make_fixture_policy()
    write_new(evaluation / 'manifests' / 'fixture-policy.json', policy)
    cases, families = make_cases(selected, businesses, evaluation)
    splits = {'schemaVersion': 1, 'version': VERSION, 'seed': SEED,
              'status': 'provisional_until_near_duplicate_and_review_audit',
              'grouping': ['original_sha256', 'normalized_parse_identity', 'invoice_number_candidate'],
              'limitations': ['相同模板可跨集合；尚未人工确认近重复和版式家族隔离',
                              '公开语料可能在模型预训练中出现，留出只约束本项目调优',
                              '验收候选没有人工核验，当前不能运行正式验收'],
              'samples': [{'sampleId': r['id'], 'split': r['split'], 'leakageGroup': r['leakageGroup'],
                           'selectedForReview': r['id'] in {x['id'] for x in selected},
                           'businessRef': f"business/{r['id']}.json" if r['id'] in businesses else None}
                          for r in canonical],
              'members': {s: {'gold': [f"gold/{r['id']}.json" for r in selected if r['split'] == s],
                               'business': [f"business/{r['id']}.json" for r in business_rows if r['split'] == s],
                               'cases': [c['id'] for c in cases if c['split'] == s]}
                          for s in ('development', 'regression', 'acceptance')}}
    write_new(evaluation / 'manifests' / 'splits.json', splits)
    write_new(evaluation / 'manifests' / 'views.json', {'schemaVersion': 1,
              'stages': {f'P{n}': [c['id'] for c in cases if c['stage'] == f'P{n}'] for n in range(14)},
              'benchmarks': {f'BM-{n:02}': [c['id'] for c in cases if f'BM-{n:02}' in c['benchmarks']] for n in range(1, 13)},
              'golden': [], 'failures': [], 'challenge': [],
              'explanation': '阶段/BM仅是草案引用。未执行，黄金/错题集为空；BM-10生产观察不伪造。'})
    review_rows = ['sample_id,split,status,label_source,field_candidates,table_evidence,gold_file,original_file']
    for row in selected:
        gold = read_json(evaluation / 'gold' / (row['id'] + '.json'))
        review_rows.append(','.join([row['id'], row['split'], 'review_pending', row['labelSourceId'] or '',
                                   str(sum(f['candidateValue'] is not None for f in gold['fields'].values())),
                                   str(len(gold['tableEvidenceCandidates'])), f"gold/{row['id']}.json",
                                   f"data/invoices/voxel51/{row['id']}/original.jpg"]))
    write_text_new(evaluation / 'manifests' / 'review-queue.csv', '\n'.join(review_rows) + '\n')
    (evaluation / 'runs').mkdir()
    write_text_new(evaluation / 'runs' / 'README.md', '# 实际评测运行\n\n尚未执行评测。此处只存实际执行后的报告，不存伪造成绩。\n')
    return selected, businesses, cases, families, splits


def prepare(source, project):
    source, project = source.resolve(), project.resolve()
    final_product = project / 'data' / 'invoices' / 'voxel51'
    final_eval = project / 'agent-eval' / 'data'
    stage = project / 'data' / '.preparation-stage'
    if final_product.exists() or final_eval.exists():
        raise FileExistsError('Existing data release found; run verify_invoice_data.py. No files were overwritten.')
    if stage.exists():
        raise FileExistsError('Existing preparation staging directory found; inspect it before any retry.')
    rows, totals, warnings = inspect_source(source)
    groups = group_records(rows)
    print(f'Current source: {len(rows)} records, {len(groups)} unique original hashes', flush=True)
    product, evaluation = stage / 'product', stage / 'evaluation'
    product.mkdir(parents=True)
    evaluation.mkdir()
    canonical, manifest, label_manifest = import_product(rows, groups, product, evaluation)
    print('Canonical originals, parse assets and separate publisher labels copied and rehashed', flush=True)
    selected, businesses, cases, families, splits = make_evaluation(canonical, product, evaluation)
    report = {'schemaVersion': 1, 'version': VERSION, 'createdAt': datetime.now(timezone.utc).isoformat(),
              'sourceRoot': str(source), 'sourceSnapshot': dict(totals), 'sourceWarnings': dict(warnings),
              'sourceRecords': len(rows), 'uniqueOriginals': len(canonical),
              'duplicateAliases': len(rows)-len(canonical), 'publisherLabelRecords': len(label_manifest['samples']),
              'reviewCandidates': len(selected), 'humanVerifiedInvoices': 0,
              'selectedWithPublisherLabels': sum(bool(r['labels']) for r in selected),
              'selectedWithoutPublisherLabels': sum(not bool(r['labels']) for r in selected),
              'syntheticBusinessPackages': len(businesses), 'caseDrafts': len(cases),
              'caseCounts': dict(Counter(c['category'] for c in cases)),
              'scenarioFamilies': len(families), 'scenarioFamilyCounts': dict(Counter(f['category'] for f in families)),
              'distinctSemanticScenarioKeys': len({c['semanticScenarioKey'] for c in cases}),
              'replicaInstancesBeyondFirst': sum(c['replicaIndex'] > 1 for c in cases),
              'mechanismAllocationOnlyInstances': sum(c['sampleRole'] == 'allocation_anchor_only' for c in cases),
              'caseSplitCounts': dict(Counter(c['split'] for c in cases)),
              'goldSplitCounts': dict(Counter(r['split'] for r in selected)),
              'businessSplitCounts': dict(Counter(b['split'] for b in businesses.values())),
              'executedCases': 0, 'acceptedGold': 0, 'businessIntegrationVerified': False,
              'fileIntegrity': 'validated_before_publish', 'semanticQuality': 'review_pending',
              'remainingWork': ['人工核验1200份字段与明细', '复核模拟政策和用例Oracle',
                                '近重复/版式家族及验收暴露审查', '实现产品接入、用例适配器和评分器后实际运行',
                                '取得企业契约后再核验企业适配，不能以模拟数据替代生产证据']}
    write_new(evaluation / 'manifests' / 'preparation-report.json', report)
    write_text_new(evaluation / 'README.md',
                   f'# 项目评测数据\n\n本批含 1,200 份待人工核验候选、600 套模拟业务资料、{sum(TARGETS.values()):,} 个未运行用例草案。\n'
                   '人工已核验数为 0；Gold/Case/Oracle 复核及真实运行仍待完成。\n\n'
                   '- `gold/`：候选值、证据索引、人工复核状态，不能直接作为已确认答案。\n'
                   '- `business/`：模拟结构化发票与配套资料，金额不代表原图。\n'
                   '- `cases/`：七类参数化用例；初态为声明式配置，需要适配器实现。\n'
                   '- `source-labels/`：原始提供方标签。\n'
                   '- `manifests/`：数量报告、版本摘要、场景目录、用途划分及人工核验队列。\n'
                   '- `runs/`：当前没有实际运行成绩。\n\n'
                   '业务Agent不可直接读取此根。Harness只投影获准产品资料和business中的/input，Oracle和Gold不投影。\n')
    inventory = {'schemaVersion': 1, 'version': VERSION,
                 'files': [file_info(p, evaluation) for p in sorted(evaluation.rglob('*')) if p.is_file()]}
    write_new(evaluation / 'manifests' / 'inventory.json', inventory)
    from verify_invoice_data import verify
    verification = verify(product, evaluation)
    print(json.dumps(verification, ensure_ascii=False), flush=True)
    final_product.parent.mkdir(parents=True, exist_ok=True)
    product.rename(final_product)
    evaluation.rename(final_eval)
    stage.rmdir()  # Only an empty directory owned by this invocation.
    print(f'Published input data: {final_product}', flush=True)
    print(f'Published quality assets: {final_eval}', flush=True)
    return report


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', type=Path, required=True)
    parser.add_argument('--project', type=Path, default=Path.cwd())
    args = parser.parse_args()
    prepare(args.source, args.project)
