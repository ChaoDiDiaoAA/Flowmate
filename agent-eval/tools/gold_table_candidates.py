"""Conservative, source-only invoice table candidates; never verified Gold.

``extract_tables(blocks, sid)`` returns a JSON-compatible dictionary containing
``lineItems`` (ordered ``{rowIndex, fields}`` objects), ``summary`` (field names
to candidate lists), ``issues`` (strings), and ``tableCoverage`` (one record per
table block). Candidate values are raw text with source evidence, without value
normalization or arithmetic. Both HTML row/column positions and output rowIndex
are zero-based. Missing fields are not assertions that the invoice lacks them.
"""

from copy import deepcopy
from html.parser import HTMLParser
import re


class _TableParser(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.rows = []
        self.row = None
        self.cell = None
        self.table_count = 0
        self.depth = 0
        self.errors = []
        self.merged_rows = set()
        self.row_spans = []

    def handle_starttag(self, tag, attrs):
        if tag == 'table':
            self.table_count += 1
            self.depth += 1
        elif self.depth and tag == 'tr':
            if self.row is not None:
                self.errors.append('Unclosed table row')
            self.row = []
        elif self.depth and tag in ('td', 'th'):
            if self.row is None or self.cell is not None:
                self.errors.append('Malformed table cell structure')
            for name, value in attrs:
                if name in ('colspan', 'rowspan') and value != '1':
                    self.merged_rows.add(len(self.rows))
                    if name == 'rowspan':
                        if value is None or not value.isdigit():
                            self.errors.append('Invalid rowspan; affected row range is unknown')
                        else:
                            span = int(value)
                            self.row_spans.append((len(self.rows), len(self.rows) + span if span else None))
            self.cell = []
        elif self.cell is not None and tag in ('br', 'p', 'div'):
            self.cell.append(' ')

    def handle_endtag(self, tag):
        if tag in ('td', 'th') and self.cell is not None:
            if self.row is not None:
                self.row.append(' '.join(''.join(self.cell).split()))
            self.cell = None
        elif tag == 'tr' and self.row is not None:
            if self.cell is not None:
                self.errors.append('Unclosed table cell')
            self.rows.append(self.row)
            self.row = None
        elif tag == 'table':
            self.depth -= 1

    def handle_data(self, data):
        if self.cell is not None:
            self.cell.append(data)

    def row_has_merge(self, row_index):
        return row_index in self.merged_rows or any(
            start <= row_index and (end is None or row_index < end)
            for start, end in self.row_spans)


def _key(text):
    return re.sub(r'[\s_.]+', '', text).casefold()


_ITEM_HEADERS = {
    'no': None, 'no.': None, '#': None, 'id': None,
    'description': 'description', 'qty': 'quantity', 'quantity': 'quantity',
    'um': 'unit', 'unit': 'unit', 'netprice': 'unit_price',
    'unitprice': 'unit_price', 'price': 'unit_price',
    'networth': 'net_amount', 'vat[%]': 'tax_rate',
    'grossworth': 'total_price', 'total': 'total_price', 'amount': 'total_price',
}
_SUMMARY_HEADERS = {
    'vat[%]': 'tax_rate', 'networth': 'net_amount',
    'vat': 'tax_amount', 'grossworth': 'total_amount',
}
_TOTAL_LABELS = {'total', 'subtotal', 'grandtotal', 'totals', 'totaldue', 'amountdue'}


def extract_tables(blocks: list[dict], sid: str) -> dict:
    """Extract review candidates from MinerU ``table_body`` HTML blocks.

    Unknown or merged headers and missing page indexes retain ``unsupported``
    coverage. Merged or ragged data rows are skipped with ``partial`` coverage,
    preserving independently aligned rows instead of guessing cell positions.
    ``Total`` in a VAT-summary table is the only source of summary amounts.
    ``Total``/``Amount`` detail columns map to ``total_price`` without asserting
    whether that value includes tax. Duplicate rows and candidates are retained.
    """
    result = {'lineItems': [], 'summary': {}, 'issues': [], 'tableCoverage': []}
    for block_index, block in enumerate(blocks):
        if not isinstance(block, dict) or (block.get('type') != 'table' and 'table_body' not in block):
            continue
        coverage = {'pointer': f'/{block_index}', 'status': 'unsupported', 'sourceRows': [], 'extractedRows': []}
        result['tableCoverage'].append(coverage)

        def unsupported(reason):
            result['issues'].append(f'/{block_index}: {reason}')
            coverage['reason'] = reason

        html = block.get('table_body')
        if not isinstance(html, str) or not html.strip():
            unsupported('Missing table HTML; manual review required')
            continue
        parser = _TableParser()
        try:
            parser.feed(html)
            parser.close()
        except Exception as exc:
            unsupported(f'Cannot parse table HTML: {exc}')
            continue
        coverage['sourceRows'] = list(range(len(parser.rows)))
        if parser.table_count != 1 or parser.depth != 0 or parser.row is not None or parser.cell is not None:
            parser.errors.append('Expected one complete, non-nested HTML table')
        if parser.errors:
            unsupported('; '.join(dict.fromkeys(parser.errors)))
            continue
        rows = [(i, row) for i, row in enumerate(parser.rows) if any(row)]
        if not rows:
            unsupported('No populated table rows')
            continue
        header_row, headers = rows[0]
        keys = [_key(h) for h in headers]
        coverage['headerRow'] = header_row
        coverage['headers'] = headers
        if parser.row_has_merge(header_row):
            unsupported(f'Header row {header_row} has merged cells; column alignment is uncertain')
            continue
        if 'description' in keys and all(k in _ITEM_HEADERS for k in keys):
            kind, mapping = 'line_items', [_ITEM_HEADERS[k] for k in keys]
        elif set(keys) == set(_SUMMARY_HEADERS) and len(keys) == len(_SUMMARY_HEADERS):
            kind, mapping = 'summary', [_SUMMARY_HEADERS[k] for k in keys]
        else:
            unsupported('Unrecognized table headers; manual mapping required')
            continue
        fields = [f for f in mapping if f is not None]
        if len(fields) != len(set(fields)):
            unsupported('Ambiguous duplicate field columns')
            continue
        page_idx = block.get('page_idx')
        if not isinstance(page_idx, int) or isinstance(page_idx, bool) or page_idx < 0:
            unsupported('Missing or invalid page_idx; cannot locate table evidence')
            continue
        coverage.update(status='supported', kind=kind)

        def candidate(raw, row_index, column):
            evidence = {
                'asset': f'{sid}/content.json', 'pointer': f'/{block_index}',
                'pageNumber': page_idx + 1, 'coordinateSpace': 'source_native',
                'tableRow': row_index, 'columnIndex': column, 'columnHeader': headers[column],
                'note': 'Literal HTML table cell under the stated column header; requires human confirmation.',
            }
            if block.get('bbox') is not None:
                evidence['bbox'] = deepcopy(block['bbox'])
            return {'rawValue': raw, 'origin': 'parsed_table', 'evidence': [evidence]}

        for row_index in range(header_row + 1, len(parser.rows)):
            row = parser.rows[row_index]
            if parser.row_has_merge(row_index):
                result['issues'].append(f'/{block_index}, row {row_index}: Merged cells or active rowspan; row skipped without column alignment')
                coverage['status'] = 'partial'
                continue
            if not any(row):
                continue
            if len(row) != len(headers):
                result['issues'].append(f'/{block_index}, row {row_index}: Unequal row width; row skipped because column alignment is uncertain')
                coverage['status'] = 'partial'
                continue
            if [_key(v) for v in row] == keys:
                continue
            if kind == 'summary':
                rate_column = mapping.index('tax_rate')
                label = _key(row[rate_column]).rstrip(':')
                if label == 'total':
                    for column, field in enumerate(mapping):
                        if field != 'tax_rate' and row[column]:
                            result['summary'].setdefault(field, []).append(candidate(row[column], row_index, column))
                    coverage['extractedRows'].append(row_index)
                elif label in _TOTAL_LABELS:
                    continue
                elif re.fullmatch(r'\d+(?:[.,]\d+)?\s*%?', row[rate_column]):
                    result['summary'].setdefault('tax_rate', []).append(candidate(row[rate_column], row_index, rate_column))
                    coverage['extractedRows'].append(row_index)
                elif row[rate_column]:
                    result['issues'].append(f'/{block_index}, row {row_index}: Unrecognized tax-rate label; manual review required')
                    coverage['status'] = 'partial'
                continue
            description_column = mapping.index('description')
            label_columns = [description_column] + [i for i, field in enumerate(mapping) if field is None]
            if any(_key(row[i]).rstrip(':') in _TOTAL_LABELS for i in label_columns):
                continue
            if not row[description_column]:
                result['issues'].append(f'/{block_index}, row {row_index}: Missing description; row needs manual review')
                coverage['status'] = 'partial'
                continue
            item_fields = {field: [candidate(row[column], row_index, column)]
                           for column, field in enumerate(mapping) if field is not None and row[column]}
            result['lineItems'].append({'rowIndex': len(result['lineItems']), 'fields': item_fields})
            coverage['extractedRows'].append(row_index)
    return result
