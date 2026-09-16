import unittest

try:
    from gold_table_candidates import extract_tables
except ModuleNotFoundError:
    extract_tables = None


def table(headers, rows, **extra):
    html = '<table><tr>' + ''.join(f'<th>{h}</th>' for h in headers) + '</tr>'
    html += ''.join('<tr>' + ''.join(f'<td>{v}</td>' for v in row) + '</tr>' for row in rows)
    return {'type': 'table', 'table_body': html + '</table>', 'page_idx': 2, 'bbox': [1, 2, 3, 4], **extra}


class GoldTableCandidatesTests(unittest.TestCase):
    def extract(self, blocks):
        self.assertIsNotNone(extract_tables, 'extract_tables must be implemented')
        return extract_tables(blocks, 'sample')

    def test_standard_rows_retain_raw_values_and_source_positions(self):
        block = table(['No.', 'Description', 'Qty', 'UM', 'Net price', 'Net worth', 'VAT [%]', 'Gross worth'],
                      [['1', 'Widget A', '2', 'pcs', '10.00', '20.00', '20%', '24.00'],
                       ['2', 'Widget B', '3', 'kg', '5.00', '15.00', '5%', '15.75']])
        result = self.extract([{'type': 'text'}, block])
        self.assertEqual([row['rowIndex'] for row in result['lineItems']], [0, 1])
        row = result['lineItems'][1]['fields']
        self.assertEqual(set(row), {'description', 'quantity', 'unit', 'unit_price', 'net_amount', 'tax_rate', 'total_price'})
        candidate = row['description'][0]
        self.assertEqual(candidate['rawValue'], 'Widget B')
        self.assertEqual(candidate['origin'], 'parsed_table')
        self.assertNotIn('normalizedValue', candidate)
        evidence = candidate['evidence'][0]
        self.assertEqual({k: evidence[k] for k in ['asset', 'pointer', 'pageNumber', 'bbox', 'coordinateSpace', 'tableRow', 'columnIndex', 'columnHeader']},
                         {'asset': 'sample/content.json', 'pointer': '/1', 'pageNumber': 3, 'bbox': [1, 2, 3, 4], 'coordinateSpace': 'source_native', 'tableRow': 2, 'columnIndex': 1, 'columnHeader': 'Description'})
        self.assertTrue(evidence['note'])

    def test_summary_only_explicit_total_and_all_tax_rates(self):
        result = self.extract([table(['VAT [%]', 'Net worth', 'VAT', 'Gross worth'],
                                    [['20%', '100', '20', '120'], ['5%', '40', '2', '42'], ['Total', '140', '22', '162']])])
        self.assertEqual(result['lineItems'], [])
        summary = result['summary']
        self.assertEqual([c['rawValue'] for c in summary['tax_rate']], ['20%', '5%'])
        self.assertEqual(summary['net_amount'][0]['rawValue'], '140')
        self.assertEqual(summary['tax_amount'][0]['rawValue'], '22')
        self.assertEqual(summary['total_amount'][0]['rawValue'], '162')
        self.assertEqual(summary['total_amount'][0]['evidence'][0]['tableRow'], 3)

    def test_missing_columns_do_not_invent_fields_and_total_not_item(self):
        result = self.extract([table(['#', 'Description', 'Unit Price', 'Total'],
                                    [['1', 'Work', '15', '30'], ['', 'Total', '', '30']])])
        self.assertEqual(len(result['lineItems']), 1)
        fields = result['lineItems'][0]['fields']
        self.assertEqual(set(fields), {'description', 'unit_price', 'total_price'})
        self.assertEqual(result['summary'], {})

    def test_merged_cells_refused_without_shifted_values(self):
        result = self.extract([{'type': 'table', 'page_idx': 0, 'table_body':
                               '<table><tr><th>Description</th><th>Qty</th><th>Price</th><th>Total</th></tr>'
                               '<tr><td colspan="2">Thing</td><td>9</td><td>18</td></tr></table>'}])
        self.assertEqual(result['lineItems'], [])
        self.assertTrue(result['issues'])
        self.assertEqual(result['tableCoverage'][0]['status'], 'partial')
        self.assertIn('row 1', result['issues'][0])

    def test_duplicate_items_remain_distinct_across_tables(self):
        block = table(['ID', 'Description', 'Qty', 'Price', 'Total'], [['1', 'Same', '1', '5', '5'], ['2', 'Same', '1', '5', '5']])
        result = self.extract([block, block])
        self.assertEqual(len(result['lineItems']), 4)
        self.assertEqual([r['rowIndex'] for r in result['lineItems']], [0, 1, 2, 3])
        self.assertEqual([r['fields']['description'][0]['evidence'][0]['tableRow'] for r in result['lineItems']], [1, 2, 1, 2])

    def test_unknown_header_unsupported_and_ragged_rows_partial(self):
        for block, status in [(table(['Description', 'Mystery', 'Amount'], [['Thing', '1', '2']]), 'unsupported'),
                              (table(['Description', 'Quantity', 'unit_price', 'Amount'], [['Thing', '1', '2']]), 'partial')]:
            with self.subTest(block=block):
                result = self.extract([block])
                self.assertEqual(result['lineItems'], [])
                self.assertEqual(result['tableCoverage'][0]['status'], status)
                self.assertTrue(result['issues'])

    def test_valid_items_survive_blank_row_and_merged_subtotal(self):
        block = table(['#', 'Description', 'Unit Price', 'Total'],
                      [['1', 'First', '10', '20'], ['2', 'Second', '15', '30'], ['3', 'Third', '20', '40'], ['', '', '', '']])
        block['table_body'] = block['table_body'].replace('</table>',
            '<tr><td colspan="2">Subtotal</td><td></td><td>90</td></tr></table>')
        result = self.extract([block])
        self.assertEqual([r['fields']['description'][0]['rawValue'] for r in result['lineItems']], ['First', 'Second', 'Third'])
        self.assertEqual(result['tableCoverage'][0]['status'], 'partial')
        self.assertEqual(result['tableCoverage'][0]['extractedRows'], [1, 2, 3])
        self.assertIn('row 5', result['issues'][0])
        self.assertEqual(result['summary'], {})

    def test_ragged_row_does_not_remove_neighboring_valid_rows(self):
        result = self.extract([table(['Description', 'Quantity', 'unit_price', 'Amount'],
                                    [['Before', '1', '2', '2'], ['Broken', '2'], ['After', '3', '4', '12']])])
        self.assertEqual([r['fields']['description'][0]['rawValue'] for r in result['lineItems']], ['Before', 'After'])
        self.assertEqual(result['tableCoverage'][0]['status'], 'partial')
        self.assertIn('row 2', result['issues'][0])

    def test_merged_header_remains_unsupported(self):
        block = table(['Description', 'Qty', 'Price', 'Total'], [['Thing', '1', '2', '2']])
        block['table_body'] = block['table_body'].replace('<th>Description', '<th colspan="2">Description')
        result = self.extract([block])
        self.assertEqual(result['lineItems'], [])
        self.assertEqual(result['tableCoverage'][0]['status'], 'unsupported')

    def test_rowspan_affected_rows_are_not_aligned_by_cell_count(self):
        block = table(['Description', 'Qty', 'Price', 'Total'],
                      [['Merged', '1', '2', '2'], ['Unsafe', '2', '3', '6'], ['Safe', '1', '4', '4']])
        block['table_body'] = block['table_body'].replace('<td>Merged', '<td rowspan="2">Merged')
        result = self.extract([block])
        self.assertEqual([r['fields']['description'][0]['rawValue'] for r in result['lineItems']], ['Safe'])
        self.assertEqual(result['tableCoverage'][0]['status'], 'partial')
        self.assertEqual(result['tableCoverage'][0]['extractedRows'], [3])

    def test_amount_alias_and_html_text(self):
        result = self.extract([table(['Description', 'Quantity', 'unit_price', 'Amount'],
                                    [['A &amp; B<br>Service', '2', '1,200.00', '2,400.00']])])
        fields = result['lineItems'][0]['fields']
        self.assertEqual(fields['description'][0]['rawValue'], 'A & B Service')
        self.assertEqual(fields['total_price'][0]['rawValue'], '2,400.00')

    def test_unknown_summary_label_is_not_a_tax_rate(self):
        result = self.extract([table(['VAT [%]', 'Net worth', 'VAT', 'Gross worth'],
                                    [['Balance', '100', '20', '120'], ['Total:', '100', '20', '120']])])
        self.assertNotIn('tax_rate', result['summary'])
        self.assertEqual(result['summary']['total_amount'][0]['rawValue'], '120')
        self.assertTrue(result['issues'])

    def test_repeated_header_and_missing_page(self):
        headers = ['ID', 'Description', 'Qty', 'Price', 'Total']
        block = table(headers, [headers, ['1', 'Thing', '2', '3', '6']])
        result = self.extract([block])
        self.assertEqual(len(result['lineItems']), 1)
        self.assertEqual(result['lineItems'][0]['fields']['description'][0]['evidence'][0]['tableRow'], 2)
        block.pop('page_idx')
        result = self.extract([block])
        self.assertEqual(result['lineItems'], [])
        self.assertEqual(result['tableCoverage'][0]['status'], 'unsupported')


if __name__ == '__main__':
    unittest.main()
