"""Fresh simulated data: arithmetic, relations, diversity and honest provenance."""
from collections import Counter
from copy import deepcopy
from decimal import Decimal, ROUND_HALF_EVEN
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'tools' / 'comprehensive'))


class FreshBusinessTests(unittest.TestCase):
    def test_duplicate_consumption_and_dangling_references_are_not_valid(self):
        from rebuild_business import validate_business
        asset = self.assets()[0]
        duplicate = deepcopy(asset['input']['invoice']['lines'][0])
        duplicate['lineId'] = 'separate-invoice-line'
        asset['input']['invoice']['lines'].append(duplicate)
        for key in ['netAmount', 'taxAmount', 'totalAmount']:
            asset['input']['invoice'][key] = str(Decimal(asset['input']['invoice'][key]) * 2)
        self.assertTrue(any('aggregate' in error for error in validate_business(asset)))
        for field, row in [('goodsReceipts', {'id': 'orphan', 'purchaseOrderId': 'missing', 'lines': [], 'status': 'confirmed'}),
                           ('balances', {'purchaseOrderId': 'missing', 'orderLineId': 'missing'})]:
            asset = self.assets()[0]
            asset['input'][field].append(row)
            self.assertTrue(validate_business(asset), field)

    def assets(self):
        from rebuild_business import build_business_packages
        return build_business_packages()

    def test_counts_and_reproducibility_without_legacy_data_argument(self):
        assets = self.assets()
        self.assertEqual(assets, self.assets())
        self.assertEqual(len(assets), 80)
        self.assertEqual(len({a['id'] for a in assets}), 80)
        self.assertEqual(Counter(a['split'] for a in assets),
                         {'development': 40, 'regression': 16, 'acceptance': 24})
        self.assertEqual(Counter(a['primaryStructure'] for a in assets), {
            'single-order': 20, 'unit-conversion': 12, 'multiple-orders': 8,
            'partial-receipts': 8, 'contract-price': 8, 'available-balance': 8,
            'supplier-alias': 8, 'decimal-rounding': 8})

    def test_all_packages_have_independently_valid_arithmetic_and_relations(self):
        from rebuild_business import validate_business
        for asset in self.assets():
            with self.subTest(asset=asset['id']):
                self.assertEqual(validate_business(asset), [])
                data = asset['input']
                inv = data['invoice']
                net = sum(Decimal(line['netAmount']) for line in inv['lines'])
                tax = sum(Decimal(line['taxAmount']) for line in inv['lines'])
                self.assertEqual(Decimal(inv['totalAmount']), net + tax)
                for line in inv['lines']:
                    expected = (Decimal(line['quantity']) * Decimal(line['unitPrice'])).quantize(
                        Decimal('.01'), rounding=ROUND_HALF_EVEN)
                    self.assertEqual(Decimal(line['netAmount']), expected)
                self.assertFalse(asset['humanVerified'])
                self.assertFalse(asset['formalAcceptanceEligible'])
                self.assertNotIn('sampleId', asset)
                self.assertEqual(data['historicalEntries'], [])
                self.assertEqual(asset['initialState']['approvals'], [])

    def test_each_fixture_has_a_distinct_non_identity_structure(self):
        from rebuild_business import structural_signature
        assets = self.assets()
        self.assertEqual(len({structural_signature(a) for a in assets}), 80,
                         'Names/IDs or raw amounts must not be the only distinction')

    def test_multiline_conversion_is_consistent_with_receipts(self):
        assets = [a for a in self.assets() if a['primaryStructure'] == 'unit-conversion']
        self.assertEqual({len(a['input']['invoice']['lines']) for a in assets}, {2, 3, 5, 8})
        for asset in assets:
            data = asset['input']
            for line in data['invoice']['lines']:
                factor = Decimal(line['unitsPerInvoiceUnit'])
                received = sum(Decimal(row['receivedBaseQuantity'])
                               for receipt in data['goodsReceipts'] for row in receipt['lines']
                               if row['orderLineId'] == line['orderLineId'])
                self.assertEqual(received, Decimal(line['quantity']) * factor)

    def test_business_input_does_not_contain_approval_or_oracle(self):
        banned = {'oracle', 'checks', 'expected', 'expectedResult', 'approved',
                  'humanVerified', 'gold', 'targetSystems', 'trustedActor', 'approvalId'}
        def keys(value):
            if isinstance(value, dict):
                for key, child in value.items():
                    yield key
                    yield from keys(child)
            elif isinstance(value, list):
                for child in value:
                    yield from keys(child)
        for asset in self.assets():
            self.assertFalse(banned.intersection(keys(asset['input'])))
            self.assertEqual(asset['initialState']['b2b']['records'], [])

    def test_bad_total_missing_receipt_and_wrong_supplier_are_detected(self):
        from rebuild_business import validate_business
        base = self.assets()[0]
        for change, expected in [
            (lambda a: a['input']['invoice'].__setitem__('totalAmount', '0.00'), 'invoice_total'),
            (lambda a: a['input'].__setitem__('goodsReceipts', []), 'receipt_coverage'),
            (lambda a: a['input']['purchaseOrders'][0].__setitem__('supplierId', 'nonexistent'), 'supplier_reference'),
        ]:
            changed = deepcopy(base)
            change(changed)
            self.assertTrue(any(expected in e for e in validate_business(changed)))

    def test_bad_contract_or_balance_is_rejected(self):
        from rebuild_business import validate_business
        contract = next(a for a in self.assets() if a['primaryStructure'] == 'contract-price')
        contract['input']['contracts'][0]['lines'][0]['unitPrice'] = '9999.00'
        self.assertTrue(any('contract_price' in e for e in validate_business(contract)))
        balance = next(a for a in self.assets() if a['primaryStructure'] == 'available-balance')
        balance['input']['balances'][0]['availableQuantity'] = '0'
        self.assertTrue(any('balance' in e for e in validate_business(balance)))
        balance['input']['balances'] = []
        self.assertTrue(any('required_balance' in e for e in validate_business(balance)))
        balance = next(a for a in self.assets() if a['primaryStructure'] == 'available-balance'
                       and len(a['input']['invoice']['lines']) == 2)
        balance['input']['balances'].pop()
        self.assertTrue(any('required_balance' in e for e in validate_business(balance)))
        asset = self.assets()[0]
        asset['input']['invoice']['purchaseOrderId'] = 'missing'
        self.assertTrue(any('invoice_order_reference' in e for e in validate_business(asset)))

    def test_unknown_policy_and_non_finite_numbers_fail_closed(self):
        from rebuild_business import validate_business
        for value in ['NaN', 'Infinity', '-Infinity']:
            asset = self.assets()[0]
            asset['input']['invoice']['lines'][0]['quantity'] = value
            self.assertTrue(validate_business(asset))
        asset = self.assets()[0]
        asset['policy']['rounding'] = 'guess'
        self.assertTrue(validate_business(asset))


if __name__ == '__main__':
    unittest.main()
