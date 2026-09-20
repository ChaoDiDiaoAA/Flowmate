import unittest

from prepare_gold_answers import normalize, propose_field, text_candidates, csv_cell


class GoldPreparationTests(unittest.TestCase):
    def test_csv_candidates_cannot_be_interpreted_as_formulas(self):
        self.assertEqual(csv_cell('=SUM(A1)'), "'=SUM(A1)")
        self.assertEqual(csv_cell('  @external'), "'  @external")
        self.assertEqual(csv_cell('ordinary text'), 'ordinary text')
        self.assertEqual(csv_cell(None), '')

    def test_currency_symbol_and_short_dates_remain_ambiguous(self):
        self.assertIsNone(normalize('currency', '$')['value'])
        date = normalize('invoice_date', '03/04/2021')
        self.assertIsNone(date['value'])
        self.assertEqual(set(date['alternatives']), {'2021-03-04', '2021-04-03'})
        self.assertEqual(normalize('invoice_date', '02/23/2021')['value'], '2021-02-23')
        self.assertEqual(normalize('invoice_date', '23/02/2021')['value'], '2021-02-23')

    def test_decimal_normalization_does_not_guess_grouping(self):
        self.assertEqual(normalize('total_amount', '$ 4 802,89')['value'], '4802.89')
        self.assertEqual(normalize('unit_price', '42,32')['value'], '42.32')
        self.assertEqual(normalize('total_amount', '$ 211,77')['value'], '211.77')
        self.assertIsNone(normalize('quantity', '1,234')['value'])
        self.assertIsNone(normalize('total_amount', '1.234,56')['value'])

    def test_missing_parse_field_is_not_claimed_absent_from_original(self):
        field = propose_field('currency', [], '000001', [])
        self.assertEqual(field['valueState'], 'unverified')
        self.assertEqual(field['proposedValueState'], 'needs_original_check')
        self.assertIsNone(field['normalizedValue'])
        self.assertEqual(field['evidence'][0]['asset'], '000001/original.jpg')

    def test_conflicting_sources_remain_unselected_and_no_human_attestation(self):
        candidates = [{'rawValue':'10.00','origin':'publisher_annotation','evidence':[]},
                      {'rawValue':'11,00','origin':'parsed_table','evidence':[{'asset':'000001/content.json','pointer':'/0','pageNumber':1}]}]
        field = propose_field('total_amount', candidates, '000001', [])
        self.assertEqual(field['proposedValueState'], 'ambiguous')
        self.assertIsNone(field['normalizedValue'])
        self.assertFalse(field['humanVerified'])

    def test_text_tax_ids_are_bound_to_party_sections(self):
        blocks=[{'type':'text','text':t,'page_idx':0} for t in ['Seller:', 'Tax Id: 123-45', 'Client:', 'Tax Id: 987-65']]
        fields=text_candidates(blocks,'000001')
        self.assertEqual(fields['seller_tax_id'][0]['rawValue'],'123-45')
        self.assertEqual(fields['buyer_tax_id'][0]['rawValue'],'987-65')


if __name__ == '__main__': unittest.main()
