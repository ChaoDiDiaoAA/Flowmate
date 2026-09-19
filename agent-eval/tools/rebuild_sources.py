"""Raw-source inventory, conservative grouping and fresh annotation worksheets.

No legacy Gold or source label *answers* are read. The label manifest supplies
presence only, and old split membership only constrains project exposure. Draft
values are parse-derived candidates, never original-image/human verified truth.
"""
from collections import defaultdict
from copy import deepcopy
import hashlib
from html.parser import HTMLParser
import json
from pathlib import Path, PurePosixPath
import re
import unicodedata


FIELD_NAMES = ('invoice_number', 'invoice_date', 'due_date', 'buyer_name', 'buyer_address',
               'buyer_tax_id', 'seller_name', 'seller_address', 'seller_tax_id', 'currency',
               'net_amount', 'tax_amount', 'total_amount', 'discount_amount')
FIELD_PATTERNS = {
    'invoice_number': r'\binvoice\s*(?:number|no\.?|#)\s*[:#]?\s*([^\s:]+)',
    'invoice_date': r'\b(?:invoice\s+date|date\s+of\s+issue|issue\s+date)\s*:?\s*([^\n]+)',
    'due_date': r'\bdue\s+date\s*:?\s*([^\n]+)',
    'currency': r'\b(USD|EUR|GBP|CAD|AUD|CNY|JPY|INR)\b',
    'net_amount': r'\b(?:subtotal|sub\s+total|net\s+amount)\s*:?\s*([$€£]?\s*\d[\d,.]*)',
    'tax_amount': r'\b(?:tax\s+amount|sales\s+tax|total\s+tax)\s*:?\s*([$€£]?\s*\d[\d,.]*)',
    'total_amount': r'\b(?:grand\s+total|total\s+due|amount\s+due|total)\s*:?\s*([$€£]?\s*\d[\d,.]*)',
    'discount_amount': r'\bdiscount\s*:?\s*([$€£]?\s*\d[\d,.]*)',
}
HEADERS = {'description': {'description', 'itemdescription', 'product', 'item'},
           'quantity': {'quantity', 'qty'}, 'unit': {'unit', 'uom'},
           'unit_price': {'unitprice', 'price', 'rate'},
           'line_amount': {'amount', 'total', 'linetotal'},
           'tax_rate': {'taxrate', 'vat'}, 'tax_amount': {'taxamount'}}


def contained(root, relative):
    if not isinstance(relative, str) or not relative or '\\' in relative or ':' in relative:
        raise ValueError('Unsafe relative path')
    path = PurePosixPath(relative)
    if path.is_absolute() or '..' in path.parts or relative != path.as_posix():
        raise ValueError('Unsafe relative path')
    base = Path(root).resolve()
    resolved = (base / relative).resolve()
    if not resolved.is_relative_to(base):
        raise ValueError('Path outside expected root')
    return resolved


def file_pin(root, relative):
    path = contained(root, relative)
    h = hashlib.sha256()
    size = 0
    with path.open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            h.update(block)
            size += len(block)
    return {'path': relative, 'bytes': size, 'sha256': h.hexdigest()}


def _read(path):
    return json.loads(Path(path).read_text(encoding='utf-8-sig'))


def _text_hash(text):
    normalized = re.sub(r'\s+', '', unicodedata.normalize('NFKC', text)).casefold()
    return hashlib.sha256(normalized.encode()).hexdigest()


class _TableParser(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.rows, self.row, self.cell = [], None, None

    def handle_starttag(self, tag, attrs):
        if tag == 'tr':
            self.row = []
        elif tag in ('td', 'th'):
            attrs = dict(attrs)
            self.cell = {'text': '', 'rowspan': int(attrs.get('rowspan', 1)),
                         'colspan': int(attrs.get('colspan', 1)), 'header': tag == 'th'}
        elif tag == 'br' and self.cell is not None:
            self.cell['text'] += '\n'

    def handle_data(self, text):
        if self.cell is not None:
            self.cell['text'] += text

    def handle_endtag(self, tag):
        if tag in ('td', 'th') and self.cell is not None:
            self.cell['text'] = self.cell['text'].strip()
            if self.row is not None:
                self.row.append(self.cell)
            self.cell = None
        elif tag == 'tr' and self.row is not None:
            self.rows.append(self.row)
            self.row = None


def table_rows(html):
    parser = _TableParser()
    parser.feed(html)
    parser.close()
    return parser.rows


def block_text(block):
    if 'table_body' in block:
        return '\n'.join(' | '.join(c['text'] for c in row) for row in table_rows(block['table_body']))
    return str(block.get('text', ''))


def _blank_field():
    return {'valueState': 'unreviewed', 'rawValue': None, 'normalizedValue': None,
            'sourcePresence': 'not_reviewed', 'availableInAllowedInput': 'not_reviewed',
            'candidates': [], 'evidence': [], 'review': {'status': 'pending', 'reviewer': None}}


def _locator(sample_id, index, block, **extra):
    return {'asset': f'data/invoices/voxel51/{sample_id}/content.json',
            'pageNumber': block.get('page_idx', 0) + 1,
            'pointer': f'/{index}/' + ('table_body' if 'table_body' in block else 'text'), **extra}


def draft_gold(sample_id, blocks, split, group_id, source_pins):
    """Prepare candidate evidence for a new independent original-image review."""
    fields = {name: _blank_field() for name in FIELD_NAMES}
    tables, items = [], []
    for index, block in enumerate(blocks):
        text = block_text(block)
        for name, pattern in FIELD_PATTERNS.items():
            for match in re.finditer(pattern, text, re.IGNORECASE):
                fields[name]['candidates'].append({
                    'rawValue': match.group(1).strip(), 'normalizedCandidate': None,
                    'method': 'parse_pattern_unverified',
                    'evidence': _locator(sample_id, index, block, quote=match.group(0))})
        if 'table_body' not in block:
            continue
        rows = table_rows(block['table_body'])
        tables.append({'blockIndex': index, 'pageNumber': block.get('page_idx', 0) + 1,
                       'rows': rows, 'rawBbox': block.get('bbox'),
                       'coordinateSpace': 'parser_original_unconfirmed',
                       'originalImageChecked': False})
        if (not rows or any(c['colspan'] != 1 or c['rowspan'] != 1 for c in rows[0])
                or any(c['rowspan'] != 1 for row in rows for c in row)):
            continue
        mapped = {}
        for column, cell in enumerate(rows[0]):
            header = re.sub(r'[^a-z]', '', cell['text'].lower())
            for name, choices in HEADERS.items():
                if header in choices:
                    mapped[column] = name
        # Complex spans/unknown headers are preserved above, never flattened
        # into invented row positions or silently treated as invoice lines.
        if 'description' not in mapped.values() or len(mapped) < 2:
            continue
        for row_index, row in enumerate(rows[1:], 1):
            if (len(row) != len(rows[0]) or any(c['colspan'] != 1 or c['rowspan'] != 1 for c in row)
                    or not any(c['text'] for c in row)):
                continue
            joined = ' '.join(c['text'] for c in row)
            if re.search(r'\b(subtotal|total|balance|tax|shipping|discount)\b', joined, re.I):
                continue
            values = {name: _blank_field() for name in HEADERS}
            for column, name in mapped.items():
                values[name]['candidates'] = [{'rawValue': row[column]['text'],
                    'normalizedCandidate': None, 'method': 'parse_table_column_unverified',
                    'evidence': _locator(sample_id, index, block, tableRow=row_index, tableCell=column)}]
            items.append({'lineId': f'candidate-block-{index}-row-{row_index}',
                          'valueState': 'unreviewed', 'rowCorrespondenceStatus': 'candidate', 'fields': values})
    return {'schemaVersion': 3, 'id': f'gold-fresh-{sample_id}', 'version': 1,
            'sampleId': sample_id, 'split': split, 'leakageGroup': group_id,
            'status': 'annotation_candidate', 'humanVerified': False, 'reviewStatus': 'pending',
            'reviewedBy': [], 'reviewedAt': None, 'acceptedGoldVersion': None,
            'eligibleForFieldScoring': False, 'formalAcceptanceEligible': False,
            'sourceSnapshot': source_pins, 'sourceEvidence': {'original': f'data/invoices/voxel51/{sample_id}/original.jpg'},
            'provenance': {'method': 'fresh_parse_candidates_then_independent_image_annotation',
                           'legacyAnswersRead': False, 'publisherAnswersRead': False,
                           'originalImageReviewed': False},
            'inputModes': ['parsed_only', 'parsed_with_source_evidence'],
            'fields': fields, 'lineItems': items, 'tableEvidenceCandidates': tables,
            'reviewChecklist': ['逐字段对照原图，区分缺失、歧义、无法辨认和未核验',
                                '逐行对照全部明细，不将候选行数当作完整行数',
                                '单独标记解析可用性与票面存在性',
                                '核对日期、小数、币种和金额关系，保留真实票面冲突',
                                '完成独立标注后再参考提供方标签；记录分歧',
                                '核验人实际确认，验收和关键歧义另作独立复核'],
            'blockingReasons': ['original_image_annotation_required', 'human_review_required',
                                'split_and_exposure_review_required']}


def inventory_sources(project):
    """Hash all unchanged source files; derive features without source answers."""
    project = Path(project)
    source = project / 'data/invoices/voxel51'
    quality = project / 'agent-eval/data'
    manifest = _read(source / 'manifest.json')
    labels = _read(quality / 'source-labels/voxel51/manifest.json')
    labeled = {x['canonicalSampleId'] for x in labels['samples']}
    split_bytes = contained(quality, 'manifests/splits.json').read_bytes()
    old_splits = json.loads(split_bytes.decode('utf-8-sig'))
    split_pin = {'path': 'manifests/splits.json', 'bytes': len(split_bytes),
                 'sha256': hashlib.sha256(split_bytes).hexdigest()}
    records, pins = [], [dict(root='source', **file_pin(source, 'manifest.json')),
                         dict(root='quality', **file_pin(quality, 'source-labels/voxel51/manifest.json')),
                         dict(root='quality', **split_pin)]
    for row in manifest['samples']:
        sample = row['sampleId']
        metadata_pin = file_pin(source, row['metadata']['path'])
        if metadata_pin != row['metadata']:
            raise ValueError(f'Source metadata digest changed: {sample}')
        metadata = _read(contained(source, row['metadata']['path']))
        sample_pins = [metadata_pin]
        for descriptor in metadata['files']:
            actual = file_pin(source, f'{sample}/{descriptor["path"]}')
            if actual['sha256'] != descriptor['sha256'] or actual['bytes'] != descriptor['bytes']:
                raise ValueError(f'Source file digest changed: {actual["path"]}')
            sample_pins.append(actual)
        pins.extend(dict(root='source', **p) for p in sample_pins)
        blocks = _read(contained(source, f'{sample}/content.json'))
        if not isinstance(blocks, list) or not blocks:
            raise ValueError(f'Empty or unsupported parsed content: {sample}')
        texts = [block_text(b) for b in blocks]
        text = '\n'.join(texts)
        tables = [table_rows(b['table_body']) for b in blocks if 'table_body' in b]
        features = {'pageCount': max(b.get('page_idx', 0) for b in blocks) + 1,
                    'tableCount': len(tables), 'tableRows': sum(len(t) for t in tables),
                    'blockCount': len(blocks), 'hasPublisherLabel': sample in labeled,
                    'explicitCurrencies': sorted(set(re.findall(FIELD_PATTERNS['currency'], text, re.I))),
                    'hasDecimalCommaCandidate': bool(re.search(r'\d+,\d{2}(?!\d)', text)),
                    'hasDateCandidate': bool(re.search(r'\d{1,4}[-/]\d{1,2}[-/]\d{1,4}', text)),
                    'hasSpannedCells': any(c['colspan'] > 1 or c['rowspan'] > 1 for t in tables for r in t for c in r),
                    'visualLayoutAndLegibility': 'not_reviewed'}
        number = re.search(FIELD_PATTERNS['invoice_number'], text, re.I)
        records.append({'sampleId': sample, 'originalSha256': row['originalSha256'],
                        'normalizedParseHash': _text_hash(text), 'invoiceNumberCandidate': number.group(1) if number else None,
                        'features': features, 'files': sample_pins})
    for label in labels['samples']:
        for descriptor in label['files']:
            pin = file_pin(quality, descriptor['path'])
            if pin != descriptor:
                raise ValueError(f'Publisher label bytes changed: {descriptor["path"]}')
            pins.append(dict(root='quality', **pin))
    # Exact parsed content is a conservative leakage group, not a source deletion.
    # Repeated invoice number alone is a review signal and never identity proof.
    by_number = defaultdict(list)
    for record in records:
        if record['invoiceNumberCandidate']:
            by_number[record['invoiceNumberCandidate'].casefold()].append(record['sampleId'])
    group_sources(records, old_splits['samples'])
    return {'schemaVersion': 3, 'method': 'raw_source_only_no_legacy_answers',
            'originalCount': len(records), 'publisherLabelCount': len(labels['samples']),
            'sourcePins': pins, 'samples': records,
            'repeatedInvoiceNumberCandidates': {k: v for k, v in by_number.items() if len(v) > 1},
            'nearDuplicateReview': {'status': 'pending',
                'implementedSignals': ['exact_normalized_parse', 'prior_leakage_groups', 'invoice_number_review_signal'],
                'remaining': ['visual_recoding_crop_similarity', 'business_identity_review', 'exposure_confirmation']}}


def group_sources(records, previous_members):
    """Keep historical grouping constraints, never inherit labels or answers."""
    parent = {r['sampleId']: r['sampleId'] for r in records}
    def find(identity):
        while parent[identity] != identity:
            parent[identity] = parent[parent[identity]]
            identity = parent[identity]
        return identity
    def union(a, b):
        left, right = sorted((find(a), find(b)))
        parent[right] = left
    text_heads, prior_heads = {}, {}
    for record in records:
        first = text_heads.setdefault(record['normalizedParseHash'], record['sampleId'])
        union(first, record['sampleId'])
    for member in previous_members:
        sample = member['sampleId']
        if sample in parent:
            first = prior_heads.setdefault(member.get('leakageGroup', sample), sample)
            union(first, sample)
    uses = defaultdict(set)
    for member in previous_members:
        if member['sampleId'] in parent and member.get('split') in {'development', 'regression', 'acceptance'}:
            uses[find(member['sampleId'])].add(member['split'])
    for record in records:
        leader = find(record['sampleId'])
        record['groupId'] = f'source-group-{leader}'
        record['priorUses'] = sorted(uses[leader])


def _stratum(record):
    f = record['features']
    return (bool(f.get('hasPublisherLabel')), min(f.get('pageCount', 1), 3),
            min(f.get('tableCount', 0), 3), min(f.get('tableRows', 0) // 10, 4),
            bool(f.get('hasDecimalCommaCandidate')), bool(f.get('hasSpannedCells')))


def select_samples(records, budgets=None):
    budgets = budgets or {'development': 50, 'regression': 20, 'acceptance': 30}
    grouped = defaultdict(list)
    for record in records:
        grouped[record['groupId']].append(record)
    candidates = []
    for group in grouped.values():
        record = deepcopy(sorted(group, key=lambda r: hashlib.sha256(('fresh-source:' + r['sampleId']).encode()).hexdigest())[0])
        record['groupPriorUses'] = sorted({u for r in group for u in r.get('priorUses', [])})
        candidates.append(record)
    selected, used_groups = [], set()
    # Reserve eligible acceptance groups first. Prior dev/reg use can only
    # disqualify; absence of a record never proves it was not exposed.
    for split in ('acceptance', 'regression', 'development'):
        buckets = defaultdict(list)
        for record in candidates:
            if record['groupId'] in used_groups:
                continue
            if split == 'acceptance' and set(record['groupPriorUses']) & {'development', 'regression'}:
                continue
            buckets[_stratum(record)].append(record)
        for bucket in buckets.values():
            bucket.sort(key=lambda r: hashlib.sha256(('fresh-selection:' + r['sampleId']).encode()).hexdigest())
        chosen = []
        while len(chosen) < budgets[split]:
            progressed = False
            for key in sorted(buckets):
                if buckets[key] and len(chosen) < budgets[split]:
                    record = buckets[key].pop(0)
                    record.update(split=split, selectionRationale={'method': 'deterministic_feature_round_robin',
                                  'stratum': list(key), 'notSelectedFromPriorGold': True},
                                  exposureStatus='requires_review', formalAcceptanceEligible=False)
                    chosen.append(record)
                    used_groups.add(record['groupId'])
                    progressed = True
            if not progressed:
                raise ValueError(f'Insufficient source groups for {split}: {len(chosen)}/{budgets[split]}')
        selected.extend(chosen)
    return sorted(selected, key=lambda r: r['sampleId'])
