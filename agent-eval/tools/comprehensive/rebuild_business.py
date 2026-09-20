"""Build fresh, source-independent simulated business packages.

This module never opens legacy business, Gold, labels or Cases. Amounts are
explicit simulation assumptions, not answers for any original invoice. Expected
results belong to Case oracles; identities/target faults belong to harness state.
"""
from collections import Counter
from copy import deepcopy
from decimal import Decimal, InvalidOperation, ROUND_HALF_EVEN
import hashlib
import json


STRUCTURES = {
    'single-order': (20, '单订单、完整收货'),
    'unit-conversion': (12, '多明细及不同计量关系'),
    'multiple-orders': (8, '同供应商存在多张订单'),
    'partial-receipts': (8, '分批收货'),
    'contract-price': (8, '合同及价格依据'),
    'available-balance': (8, '余额及可用数量约束'),
    'supplier-alias': (8, '名称、别名及候选区分'),
    'decimal-rounding': (8, '金额精度及舍入关系'),
}
AS_OF = '2026-08-20T09:00:00Z'


def decimal(value):
    if not isinstance(value, str):
        raise ValueError('Business decimals must be explicit strings')
    result = Decimal(value)
    if not result.is_finite():
        raise ValueError('Non-finite decimal')
    return result


def money(value):
    return str(value.quantize(Decimal('0.01'), rounding=ROUND_HALF_EVEN))


def _number(value):
    return format(value, 'f')


def _invoice_line(index, po_id, quantity, price, *, units=1, tax='10'):
    net = money(quantity * price)
    tax_amount = money(decimal(net) * decimal(tax) / 100)
    return {
        'lineId': f'INV-L{index}', 'orderId': po_id, 'orderLineId': f'PO-L{index}',
        'sku': f'SIM-PART-{index}', 'description': f'模拟物料 {index}（测试用途）',
        'quantity': _number(quantity), 'unit': 'each' if units == 1 else f'pack-{units}',
        'unitsPerInvoiceUnit': str(units), 'baseUnit': 'each', 'unitPrice': _number(price),
        'netAmount': net, 'taxRate': tax, 'taxAmount': tax_amount,
        'grossAmount': money(decimal(net) + decimal(tax_amount)),
    }


def _sum_invoice(invoice):
    invoice['netAmount'] = money(sum(decimal(x['netAmount']) for x in invoice['lines']))
    invoice['taxAmount'] = money(sum(decimal(x['taxAmount']) for x in invoice['lines']))
    invoice['totalAmount'] = money(decimal(invoice['netAmount']) + decimal(invoice['taxAmount']))


def _make(kind, variant, serial):
    identity = f'business-{kind}-{variant + 1:02d}'
    supplier_id, order_id = f'{identity}-SUP', f'{identity}-PO'
    line_count, receipt_count, factor, used = 1, 1, 1, 0
    if kind == 'single-order':
        line_count, receipt_count = (1, 2, 4, 8)[variant // 5], variant % 5 + 1
    elif kind == 'unit-conversion':
        line_count, factor = (2, 3, 5, 8)[variant // 3], (2, 10, 100)[variant % 3]
    elif kind == 'partial-receipts':
        receipt_count, used = variant // 2 + 2, 2
    elif kind == 'contract-price':
        line_count = variant // 2 + 1
    elif kind == 'available-balance':
        line_count = variant // 2 + 1
    elif kind == 'decimal-rounding':
        line_count = variant // 2 + 1
    lines = []
    for i in range(1, line_count + 1):
        quantity, price = Decimal(receipt_count * 2 + i), Decimal('12.50') + i
        if kind == 'decimal-rounding':
            # On both sides of half-even ties, with zero vs nonzero tax. The
            # decimal relation itself is the target dimension, not random prices.
            quantity, price = Decimal(1), Decimal('1.005') if variant % 2 == 0 else Decimal('1.015')
        lines.append(_invoice_line(i, order_id, quantity, price, units=factor,
                                   tax='0' if kind == 'decimal-rounding' and variant % 2 == 0 else '10'))
    invoice = {'invoiceNumber': f'SIM-REBUILD-{serial:03d}', 'invoiceDate': '2026-08-20',
               'currency': 'USD', 'sellerName': '模拟精密零件供应商',
               'supplierRegistration': 'SIM-REG-MAIN', 'purchaseOrderId': order_id,
               'revision': 1, 'lines': lines}
    _sum_invoice(invoice)
    supplier = {'id': supplier_id, 'name': invoice['sellerName'], 'aliases': [],
                'registration': 'SIM-REG-MAIN', 'status': 'active', 'version': 1,
                'validFrom': '2026-01-01', 'observedAt': AS_OF}
    po_lines = []
    for row in lines:
        qty = decimal(row['quantity']) * decimal(row['unitsPerInvoiceUnit']) + used
        po_lines.append({'lineId': row['orderLineId'], 'sku': row['sku'],
                         'orderedBaseQuantity': _number(qty), 'baseUnit': 'each',
                         'invoiceUnit': row['unit'], 'unitsPerInvoiceUnit': row['unitsPerInvoiceUnit'],
                         'invoiceUnitPrice': row['unitPrice'], 'previouslyInvoicedBaseQuantity': str(used)})
    order = {'id': order_id, 'supplierId': supplier_id, 'currency': 'USD', 'status': 'open',
             'version': 1, 'observedAt': AS_OF, 'lines': po_lines}
    receipts = []
    for n in range(receipt_count):
        receipt_lines = []
        for row in po_lines:
            total = decimal(row['orderedBaseQuantity'])
            part = (total / receipt_count).quantize(Decimal('0.001'), rounding=ROUND_HALF_EVEN)
            amount = part if n < receipt_count - 1 else total - part * (receipt_count - 1)
            receipt_lines.append({'orderLineId': row['lineId'], 'receivedBaseQuantity': _number(amount)})
        receipts.append({'id': f'{identity}-GR-{n + 1}', 'purchaseOrderId': order_id,
                         'status': 'confirmed', 'confirmedAt': f'2026-08-{10 + n:02d}T09:00:00Z',
                         'version': 1, 'lines': receipt_lines})
    data = {'invoice': invoice, 'suppliers': [supplier], 'purchaseOrders': [order],
            'goodsReceipts': receipts, 'contracts': [], 'balances': [], 'historicalEntries': []}
    if kind == 'partial-receipts' and variant % 2:
        # An unconfirmed delivery cannot contribute to received quantity. This
        # differs from another successful installment, not just a new receipt ID.
        data['goodsReceipts'].append({
            'id': f'{identity}-GR-PENDING', 'purchaseOrderId': order_id,
            'status': 'pending', 'confirmedAt': None, 'version': 1,
            'lines': [{'orderLineId': x['orderLineId'], 'receivedBaseQuantity': '0'} for x in lines]})
    design = {'primaryStructure': kind, 'variant': variant + 1,
              'distinguishingConditions': [], 'sourceInvoiceUsed': False}
    if kind == 'multiple-orders':
        for n in range(variant // 2 + 1):
            alternative = deepcopy(order)
            alternative['id'] = f'{identity}-OTHER-PO-{n + 1}'
            if variant % 2 == 0:
                alternative['status'] = 'closed'
            else:
                for row in alternative['lines']:
                    row['sku'] = 'SIM-UNRELATED-ITEM'
            data['purchaseOrders'].append(alternative)
    elif kind == 'contract-price':
        contract_lines = [{'sku': row['sku'], 'unit': row['unit'], 'unitPrice': row['unitPrice']}
                          for row in lines]
        contract = {'id': f'{identity}-CONTRACT', 'supplierId': supplier_id, 'currency': 'USD',
                    'version': 2, 'validFrom': '2026-08-01', 'validUntil': '2026-12-31',
                    'status': 'active', 'lines': contract_lines}
        order['contractId'] = contract['id']
        data['contracts'].append(contract)
        if variant % 2:
            previous = deepcopy(contract)
            previous.update(id=f'{identity}-CONTRACT-EXPIRED', version=1,
                            validFrom='2026-01-01', validUntil='2026-07-31', status='expired')
            for row in previous['lines']:
                row['unitPrice'] = '99.00'
            data['contracts'].append(previous)
    elif kind == 'available-balance':
        for row in lines:
            required = decimal(row['quantity']) * decimal(row['unitsPerInvoiceUnit'])
            reserve = Decimal(variant % 2 * 2)
            data['balances'].append({'purchaseOrderId': order_id, 'orderLineId': row['orderLineId'],
                                     'receivedQuantity': _number(required + reserve),
                                     'consumedQuantity': '0', 'reservedQuantity': _number(reserve),
                                     'availableQuantity': _number(required), 'version': 1,
                                     'observedAt': AS_OF})
            po_row = next(x for x in order['lines'] if x['lineId'] == row['orderLineId'])
            po_row['orderedBaseQuantity'] = _number(required + reserve)
            receipts[0]['lines'][lines.index(row)]['receivedBaseQuantity'] = _number(required + reserve)
    elif kind == 'supplier-alias':
        alias_count = variant // 2 + 1
        supplier['aliases'] = [f'模拟商号 {n + 1}' for n in range(alias_count)]
        invoice['sellerName'] = supplier['aliases'][-1]
        if variant % 2:
            data['suppliers'].append({'id': f'{identity}-OTHER-SUP', 'name': invoice['sellerName'],
                                      'aliases': [], 'registration': 'SIM-REG-DIFFERENT',
                                      'status': 'active', 'version': 1, 'observedAt': AS_OF})
    design['distinguishingConditions'] = [
        f'发票明细 {len(lines)} 行，订单候选 {len(data["purchaseOrders"])} 个，收货记录 {len(receipts)} 份',
        f'计量换算 {factor}；此前已用数量 {used}；合同版本 {len(data["contracts"])} 个；供应商候选 {len(data["suppliers"])} 个',
    ]
    split = ('development' if (serial - 1) % 10 < 5 else
             'regression' if (serial - 1) % 10 < 7 else 'acceptance')
    return {
        'schemaVersion': 3, 'id': identity, 'version': 1, 'kind': 'synthetic_business',
        'primaryStructure': kind, 'split': split, 'leakageGroup': identity,
        'splitStatus': 'provisional_pending_structure_and_exposure_review',
        'status': 'draft', 'reviewStatus': 'pending', 'humanVerified': False,
        'formalAcceptanceEligible': False, 'design': design,
        'provenance': {'method': 'new_contract_driven_construction', 'legacyAssetsRead': [],
                       'realEnterpriseRecord': False,
                       'sourceRefs': [
                           {'path': 'docs/spec/00_Flowmate完整方案.md', 'section': '16'},
                           {'path': 'agent-eval/docs/spec/01_Flowmate_Agent评测总方案.md', 'section': '5.2.2'},
                           {'path': 'agent-eval/docs/spec/01_Flowmate_Agent评测总方案.md', 'section': '8.6'}]},
        'policy': {'id': 'simulation-business-policy', 'version': 1,
                   'authority': 'explicit_simulation_assumptions', 'enterprisePolicyVerified': False,
                   'currency': 'USD', 'moneyScale': 2, 'rounding': 'ROUND_HALF_EVEN',
                   'taxRounding': 'per_line', 'tolerance': '0.00',
                   'quantityUnit': 'baseUnit', 'supplierIdentity': 'registration_then_registered_alias',
                   'contractSelection': 'explicit_order_reference_and_invoice_date',
                   'submissionRequires': 'current_explicit_submission_confirmation',
                   'financialApprovalTiers': False, 'asOf': AS_OF},
        'input': data,
        'initialState': {'workspaceId': f'SIM-WS-{split}', 'executionMode': 'local_simulation',
                         'approvals': [], 'humanInteractions': [],
                         'b2b': {'kind': 'local_simulator', 'records': [], 'attempts': [], 'faults': []},
                         'networkPolicy': 'no_real_enterprise_writes'},
    }


def structural_signature(asset):
    """Strip identities and absolute amounts; retain actual relation topology.

    Rounding ties and unit conversion are numeric *relations* that matter to the
    policy. They are retained explicitly instead of hashing arbitrary amounts.
    """
    data = asset['input']
    lines = data['invoice']['lines']
    signature = {
        'lineCount': len(lines), 'orderStates': [p['status'] for p in data['purchaseOrders']],
        'orderSkuMatches': [all(any(x['sku'] == row['sku'] for x in lines) for row in p['lines'])
                            for p in data['purchaseOrders']],
        'receiptRows': [len(x['lines']) for x in data['goodsReceipts']],
        'receiptStates': [x['status'] for x in data['goodsReceipts']],
        'unitFactors': [x['unitsPerInvoiceUnit'] for x in lines],
        'previousConsumption': [decimal(x['previouslyInvoicedBaseQuantity']) > 0
                                for p in data['purchaseOrders'] for x in p['lines']],
        'contractStates': [x['status'] for x in data['contracts']],
        'balanceReserved': [decimal(x['reservedQuantity']) > 0 for x in data['balances']],
        'aliases': [len(x['aliases']) for x in data['suppliers']],
        'invoiceUsesAlias': any(data['invoice']['sellerName'] in x['aliases'] for x in data['suppliers']),
        'roundingRelation': [
            ('up' if decimal(x['netAmount']) > decimal(x['quantity']) * decimal(x['unitPrice']) else
             'down' if decimal(x['netAmount']) < decimal(x['quantity']) * decimal(x['unitPrice']) else 'exact')
            for x in lines],
        'taxApplicable': [decimal(x['taxRate']) != 0 for x in lines],
    }
    return hashlib.sha256(json.dumps(signature, sort_keys=True).encode()).hexdigest()


def validate_business(asset):
    """Independent relation checks; invalid/missing structures fail closed."""
    errors = []
    try:
        if asset['policy']['rounding'] != 'ROUND_HALF_EVEN' or asset['policy']['taxRounding'] != 'per_line':
            errors.append('unsupported_policy')
        data, policy = asset['input'], asset['policy']
        invoice = data['invoice']
        if not invoice['lines']:
            errors.append('empty_invoice')
        suppliers = {x['id']: x for x in data['suppliers']}
        orders = {x['id']: x for x in data['purchaseOrders']}
        if len(suppliers) != len(data['suppliers']) or len(orders) != len(data['purchaseOrders']):
            errors.append('duplicate_identity')
        contracts = {x['id']: x for x in data['contracts']}
        if invoice['purchaseOrderId'] not in orders or any(
                row['orderId'] != invoice['purchaseOrderId'] for row in invoice['lines']):
            errors.append('invoice_order_reference')
        if asset['primaryStructure'] == 'available-balance' and not data['balances']:
            errors.append('required_balance_missing')
        if asset['primaryStructure'] == 'available-balance':
            demand_keys = {(r['orderId'], r['orderLineId']) for r in invoice['lines']}
            balance_keys = [(b['purchaseOrderId'], b['orderLineId']) for b in data['balances']]
            if set(balance_keys) != demand_keys or len(balance_keys) != len(set(balance_keys)):
                errors.append('required_balance_missing_or_duplicate')
        if asset['primaryStructure'] == 'contract-price' and not data['contracts']:
            errors.append('required_contract_missing')
        if len({r['lineId'] for r in invoice['lines']}) != len(invoice['lines']):
            errors.append('duplicate_invoice_line_identity')
        if len({r['id'] for r in data['goodsReceipts']}) != len(data['goodsReceipts']):
            errors.append('duplicate_receipt_identity')
        for po in orders.values():
            if po['supplierId'] not in suppliers:
                errors.append('supplier_reference')
            if len({r['lineId'] for r in po['lines']}) != len(po['lines']):
                errors.append('duplicate_order_line_identity')
        for receipt in data['goodsReceipts']:
            if receipt['purchaseOrderId'] not in orders:
                errors.append('receipt_order_reference')
                continue
            line_ids = {r['lineId'] for r in orders[receipt['purchaseOrderId']]['lines']}
            for row in receipt['lines']:
                if row['orderLineId'] not in line_ids or decimal(row['receivedBaseQuantity']) < 0:
                    errors.append('receipt_line_reference_or_quantity')
        for balance in data['balances']:
            if balance['purchaseOrderId'] not in orders or balance['orderLineId'] not in {
                    r['lineId'] for r in orders[balance['purchaseOrderId']]['lines']}:
                errors.append('balance_order_line_reference')
        aggregate = Counter()
        net_sum, tax_sum = Decimal(0), Decimal(0)
        for row in invoice['lines']:
            quantity, price, units = decimal(row['quantity']), decimal(row['unitPrice']), decimal(row['unitsPerInvoiceUnit'])
            if quantity <= 0 or price < 0 or units <= 0:
                errors.append('invalid_line_quantity_or_price')
            net = (quantity * price).quantize(Decimal('.01'), rounding=ROUND_HALF_EVEN)
            tax = (net * decimal(row['taxRate']) / 100).quantize(Decimal('.01'), rounding=ROUND_HALF_EVEN)
            if decimal(row['netAmount']) != net or decimal(row['taxAmount']) != tax or decimal(row['grossAmount']) != net + tax:
                errors.append('line_arithmetic')
            net_sum += net
            tax_sum += tax
            po = orders[row['orderId']]
            if po['status'] != 'open' or po['currency'] != invoice['currency']:
                errors.append('order_state_or_currency')
            supplier = suppliers[po['supplierId']]
            if supplier['registration'] != invoice['supplierRegistration'] or supplier['status'] != 'active':
                errors.append('supplier_identity')
            if invoice['sellerName'] not in [supplier['name'], *supplier['aliases']]:
                errors.append('supplier_name')
            candidates = [x for x in po['lines'] if x['lineId'] == row['orderLineId']]
            if len(candidates) != 1:
                errors.append('order_line_reference')
                continue
            order_line = candidates[0]
            if (row['sku'] != order_line['sku'] or row['unit'] != order_line['invoiceUnit']
                    or units != decimal(order_line['unitsPerInvoiceUnit'])
                    or price != decimal(order_line['invoiceUnitPrice'])):
                errors.append('order_line_match')
            required = quantity * units
            aggregate[(row['orderId'], row['orderLineId'])] += required
            received = sum(decimal(x['receivedBaseQuantity']) for receipt in data['goodsReceipts']
                           if receipt['purchaseOrderId'] == po['id'] and receipt['status'] == 'confirmed'
                           for x in receipt['lines'] if x['orderLineId'] == row['orderLineId'])
            used = decimal(order_line['previouslyInvoicedBaseQuantity'])
            if received - used < required or received > decimal(order_line['orderedBaseQuantity']):
                errors.append('receipt_coverage')
            if 'contractId' in po:
                contract = contracts[po['contractId']]
                if (not contract['validFrom'] <= invoice['invoiceDate'] <= contract['validUntil']
                        or contract['status'] != 'active' or contract['supplierId'] != po['supplierId']
                        or contract['currency'] != invoice['currency']):
                    errors.append('contract_applicability')
                prices = [x for x in contract['lines'] if x['sku'] == row['sku'] and x['unit'] == row['unit']]
                if len(prices) != 1 or decimal(prices[0]['unitPrice']) != price:
                    errors.append('contract_price')
            for balance in data['balances']:
                if balance['purchaseOrderId'] == po['id'] and balance['orderLineId'] == row['orderLineId']:
                    available = (decimal(balance['receivedQuantity']) - decimal(balance['consumedQuantity'])
                                 - decimal(balance['reservedQuantity']))
                    if available != decimal(balance['availableQuantity']) or available < required:
                        errors.append('balance_arithmetic_or_availability')
                    if decimal(balance['receivedQuantity']) != received:
                        errors.append('balance_receipt_relation')
        for (order_id, line_id), required in aggregate.items():
            row = next(r for r in orders[order_id]['lines'] if r['lineId'] == line_id)
            received = sum(decimal(x['receivedBaseQuantity']) for receipt in data['goodsReceipts']
                           if receipt['purchaseOrderId'] == order_id and receipt['status'] == 'confirmed'
                           for x in receipt['lines'] if x['orderLineId'] == line_id)
            if required > received - decimal(row['previouslyInvoicedBaseQuantity']):
                errors.append('aggregate_receipt_overconsumption')
            for balance in data['balances']:
                if balance['purchaseOrderId'] == order_id and balance['orderLineId'] == line_id:
                    if required > decimal(balance['availableQuantity']):
                        errors.append('aggregate_balance_overconsumption')
        if decimal(invoice['netAmount']) != net_sum or decimal(invoice['taxAmount']) != tax_sum:
            errors.append('invoice_subtotals')
        if decimal(invoice['totalAmount']) != net_sum + tax_sum:
            errors.append('invoice_total')
        if invoice['currency'] != policy['currency']:
            errors.append('policy_currency')
        if asset['initialState']['approvals'] or data['historicalEntries'] or asset['initialState']['b2b']['records']:
            errors.append('unexpected_preexisting_approval_or_success')
        if asset['humanVerified'] or asset['formalAcceptanceEligible']:
            errors.append('unearned_review_status')
    except (KeyError, TypeError, ValueError, InvalidOperation, IndexError) as exc:
        errors.append(f'invalid_structure:{type(exc).__name__}:{exc}')
    return errors


def build_business_packages():
    assets = []
    for kind, (count, _label) in STRUCTURES.items():
        for variant in range(count):
            asset = _make(kind, variant, len(assets) + 1)
            errors = validate_business(asset)
            if errors:
                raise ValueError(f'{asset["id"]}: {errors}')
            assets.append(asset)
    if len({structural_signature(a) for a in assets}) != len(assets):
        raise ValueError('Duplicate business relation structures')
    if Counter(a['split'] for a in assets) != {'development': 40, 'regression': 16, 'acceptance': 24}:
        raise ValueError('Business split budget differs')
    return assets
