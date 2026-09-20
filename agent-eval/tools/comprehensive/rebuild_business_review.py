"""Replayable content audit for the 80 fresh synthetic business packages.

The audit checks contract consistency and designed semantic differences.  It is
an AI quality record, not human verification, enterprise-policy approval, a
product run, or a business outcome.
"""
from collections import Counter
from copy import deepcopy
from decimal import Decimal
import hashlib
import json
from pathlib import Path

from rebuild_business import STRUCTURES, structural_signature, validate_business
from rebuild_business_projection import asset_ref
from rebuild_dataset import json_bytes, verify_asset_snapshot
from rebuild_staging import (
    candidate_lock, read_candidate, revise_business_review_candidate, snapshot_digest)


REVIEW_DATE = '2026-09-18'
ACTOR = {'kind': 'ai_assistant', 'id': 'codex-business-contract-reviewer',
         'reviewedOn': REVIEW_DATE}
CHECK_IDS = (
    'source-and-policy-boundary', 'business-arithmetic-and-references',
    'primary-structure-realized', 'temporal-and-version-relations',
    'clean-base-state', 'declared-design-matches-content')


def _decimal(value):
    return Decimal(value)


def _digest(value):
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True,
                                    separators=(',', ':'), allow_nan=False).encode()).hexdigest()


def _pin(path, raw):
    return {'path': path, 'bytes': len(raw), 'sha256': hashlib.sha256(raw).hexdigest()}


def _structure_evidence(asset):
    data, kind = asset['input'], asset['primaryStructure']
    invoice, orders = data['invoice'], data['purchaseOrders']
    referenced = next(x for x in orders if x['id'] == invoice['purchaseOrderId'])
    lines = invoice['lines']
    if kind == 'single-order':
        valid = len(orders) == 1 and bool(data['goodsReceipts'])
        evidence = {'orderCount': len(orders), 'confirmedReceiptCount': sum(
            x['status'] == 'confirmed' for x in data['goodsReceipts'])}
    elif kind == 'unit-conversion':
        factors = [_decimal(x['unitsPerInvoiceUnit']) for x in lines]
        valid = len(lines) >= 2 and all(x > 1 for x in factors) and len(orders) == 1
        evidence = {'lineCount': len(lines), 'unitFactors': [str(x) for x in factors]}
    elif kind == 'multiple-orders':
        alternatives = [x for x in orders if x['id'] != referenced['id']]
        valid = bool(alternatives) and all(
            x['status'] == 'closed' or all(row['sku'] == 'SIM-UNRELATED-ITEM' for row in x['lines'])
            for x in alternatives)
        evidence = {'orderCount': len(orders), 'alternativeStates': [x['status'] for x in alternatives]}
    elif kind == 'partial-receipts':
        confirmed = [x for x in data['goodsReceipts'] if x['status'] == 'confirmed']
        pending = [x for x in data['goodsReceipts'] if x['status'] == 'pending']
        valid = len(confirmed) >= 2 and len(pending) <= 1
        evidence = {'confirmedReceiptCount': len(confirmed), 'pendingReceiptCount': len(pending)}
    elif kind == 'contract-price':
        active = [x for x in data['contracts'] if x['id'] == referenced.get('contractId')]
        valid = len(active) == 1 and active[0]['status'] == 'active' and all(
            any(c['sku'] == row['sku'] and c['unitPrice'] == row['unitPrice']
                for c in active[0]['lines']) for row in lines)
        evidence = {'contractCount': len(data['contracts']),
                    'referencedContract': referenced.get('contractId')}
    elif kind == 'available-balance':
        demand = {(x['orderId'], x['orderLineId']):
                  _decimal(x['quantity']) * _decimal(x['unitsPerInvoiceUnit']) for x in lines}
        balances = {(x['purchaseOrderId'], x['orderLineId']): _decimal(x['availableQuantity'])
                    for x in data['balances']}
        valid = set(demand) == set(balances) and all(balances[k] >= v for k, v in demand.items())
        evidence = {'balanceCount': len(balances), 'demandKeys': len(demand)}
    elif kind == 'supplier-alias':
        actual = next(x for x in data['suppliers'] if x['id'] == referenced['supplierId'])
        same_name = [x for x in data['suppliers'] if invoice['sellerName'] in [x['name'], *x['aliases']]]
        valid = invoice['sellerName'] in actual['aliases'] and bool(actual['registration'])
        evidence = {'actualAliasCount': len(actual['aliases']), 'sameNameCandidateCount': len(same_name)}
    elif kind == 'decimal-rounding':
        raw = [_decimal(x['quantity']) * _decimal(x['unitPrice']) for x in lines]
        rounded = [_decimal(x['netAmount']) for x in lines]
        valid = all(x in {Decimal('1.005'), Decimal('1.015')} for x in raw) and all(
            x in {Decimal('1.00'), Decimal('1.02')} for x in rounded)
        evidence = {'rawProducts': [str(x) for x in raw], 'roundedNet': [str(x) for x in rounded]}
    else:
        valid, evidence = False, {'unknownStructure': kind}
    if not valid:
        raise ValueError(asset['id'] + ': primary structure is not realized')
    return evidence


def _temporal_evidence(asset):
    data, policy = asset['input'], asset['policy']
    invoice_date, as_of = data['invoice']['invoiceDate'], policy['asOf']
    if any(x['confirmedAt'] and x['confirmedAt'] > as_of for x in data['goodsReceipts']):
        raise ValueError(asset['id'] + ': receipt occurs after policy as-of')
    referenced = next(x for x in data['purchaseOrders']
                      if x['id'] == data['invoice']['purchaseOrderId'])
    if referenced.get('contractId'):
        contract = next(x for x in data['contracts'] if x['id'] == referenced['contractId'])
        if not contract['validFrom'] <= invoice_date <= contract['validUntil']:
            raise ValueError(asset['id'] + ': referenced contract is outside invoice date')
    return {'invoiceDate': invoice_date, 'policyAsOf': as_of,
            'referencedContractId': referenced.get('contractId')}


def build_review(asset):
    errors = validate_business(asset)
    if errors:
        raise ValueError(asset['id'] + ': ' + ','.join(errors))
    if (asset['kind'] != 'synthetic_business' or asset['provenance']['legacyAssetsRead'] != [] or
            asset['provenance']['realEnterpriseRecord'] is not False or
            asset['design']['sourceInvoiceUsed'] is not False or
            asset['policy']['authority'] != 'explicit_simulation_assumptions' or
            asset['policy']['enterprisePolicyVerified'] is not False):
        raise ValueError(asset['id'] + ': source/policy boundary differs')
    if (asset['initialState']['approvals'] or asset['initialState']['humanInteractions'] or
            asset['initialState']['b2b']['records'] or asset['initialState']['b2b']['attempts'] or
            asset['initialState']['networkPolicy'] != 'no_real_enterprise_writes'):
        raise ValueError(asset['id'] + ': base state is not clean')
    structure = _structure_evidence(asset)
    temporal = _temporal_evidence(asset)
    expected_prefix = (f'发票明细 {len(asset["input"]["invoice"]["lines"])} 行，订单候选 '
                       f'{len(asset["input"]["purchaseOrders"])} 个，收货记录 '
                       f'{len(asset["input"]["goodsReceipts"])} 份')
    if asset['design']['distinguishingConditions'][0] != expected_prefix:
        raise ValueError(asset['id'] + ': design narrative differs from content')
    checks = [
        {'checkId': CHECK_IDS[0], 'status': 'PASS',
         'evidence': {'legacyAssetsRead': [], 'sourceInvoiceUsed': False,
                      'realEnterpriseRecord': False, 'enterprisePolicyVerified': False}},
        {'checkId': CHECK_IDS[1], 'status': 'PASS',
         'evidence': {'validateBusinessErrors': [], 'invoiceTotal': asset['input']['invoice']['totalAmount']}},
        {'checkId': CHECK_IDS[2], 'status': 'PASS', 'evidence': structure},
        {'checkId': CHECK_IDS[3], 'status': 'PASS', 'evidence': temporal},
        {'checkId': CHECK_IDS[4], 'status': 'PASS',
         'evidence': {'approvals': 0, 'humanInteractions': 0, 'targetRecords': 0,
                      'networkPolicy': 'no_real_enterprise_writes'}},
        {'checkId': CHECK_IDS[5], 'status': 'PASS',
         'evidence': {'primaryStructure': asset['primaryStructure'],
                      'variant': asset['design']['variant'],
                      'structuralSignature': structural_signature(asset)}},
    ]
    return {
        'schemaVersion': 1, 'kind': 'synthetic_business_ai_content_audit',
        'assetRef': asset_ref(asset), 'actor': ACTOR, 'checks': checks,
        'conclusion': 'contract_consistent_simulation_only',
        'humanVerified': False, 'enterprisePolicyVerified': False,
        'formalAcceptanceEligible': False,
        'limitations': [
            '该记录验证模拟资料的内部契约、关系和设计差异，不是企业政策确认。',
            '该记录不是产品执行证据、人工审核签名或业务成功记录。'],
    }


def review_path(record):
    return ('manifests/business-reviews/' + record['assetRef']['id'] + '-' +
            _digest(record) + '.json')


def validate_business_review_snapshot(snapshot):
    assets = {json.loads(raw)['id']: json.loads(raw) for path, raw in snapshot.items()
              if path.startswith('business/')}
    if len(assets) != 80:
        raise ValueError('Business review needs all 80 packages')
    index_path = 'manifests/business-reviews/index.json'
    if index_path not in snapshot:
        raise ValueError('Business review index missing')
    index = json.loads(snapshot[index_path])
    if (index.get('schemaVersion') != 1 or index.get('kind') != 'synthetic_business_content_audit' or
            index.get('actor') != ACTOR or index.get('packageCount') != 80 or
            index.get('humanVerifiedPackages') != 0 or index.get('actualProductRuns') != 0 or
            index.get('formalAcceptanceEligible') is not False):
        raise ValueError('Business review index contract differs')
    expected_structures = {k: v[0] for k, v in STRUCTURES.items()}
    if (index.get('structureCounts') != expected_structures or
            index.get('splitCounts') != {'development': 40, 'regression': 16, 'acceptance': 24} or
            index.get('distinctStructuralSignatures') != 80):
        raise ValueError('Business review aggregate counts differ')
    refs = index.get('reviewRefs')
    if not isinstance(refs, list) or len(refs) != 80:
        raise ValueError('Business review membership differs')
    expected_paths = set()
    for ref in refs:
        if not isinstance(ref, dict) or set(ref) != {'assetId', 'path', 'bytes', 'sha256'}:
            raise ValueError('Business review reference differs')
        path = ref['path']
        if path not in snapshot or _pin(path, snapshot[path]) != {k: ref[k] for k in ('path', 'bytes', 'sha256')}:
            raise ValueError('Business review receipt missing or changed')
        record = json.loads(snapshot[path])
        asset = assets.get(ref['assetId'])
        if asset is None or record != build_review(asset) or path != review_path(record):
            raise ValueError('Business review receipt does not replay')
        expected_paths.add(path)
    actual_paths = {p for p in snapshot if p.startswith('manifests/business-reviews/') and p != index_path}
    if actual_paths != expected_paths:
        raise ValueError('Orphan or missing business review receipt')
    return {'valid': True, 'packageCount': 80, 'humanVerifiedPackages': 0,
            'actualProductRuns': 0, 'formalAcceptanceEligible': False}


def assemble_reviews(snapshot):
    """Rebuild derived review receipts for the exact current business assets.

    This helper does not grant review status and deliberately does not verify
    the prior snapshot. Specification rebinding uses it after replacing only
    binding metadata; the normal public entry point still verifies first.
    """
    outputs = {path: raw for path, raw in snapshot.items()
               if not path.startswith('manifests/business-reviews/')}
    assets = [json.loads(raw) for path, raw in sorted(snapshot.items()) if path.startswith('business/')]
    if len({structural_signature(x) for x in assets}) != 80:
        raise ValueError('Business packages are not structurally distinct')
    refs = []
    for asset in assets:
        record = build_review(asset)
        path, raw = review_path(record), json_bytes(record)
        outputs[path] = raw
        refs.append({'assetId': asset['id'], **_pin(path, raw)})
    index = {
        'schemaVersion': 1, 'kind': 'synthetic_business_content_audit', 'actor': ACTOR,
        'packageCount': 80, 'structureCounts': {k: v[0] for k, v in STRUCTURES.items()},
        'splitCounts': dict(sorted(Counter(x['split'] for x in assets).items())),
        'distinctStructuralSignatures': 80, 'reviewRefs': refs,
        'humanVerifiedPackages': 0, 'enterprisePolicyVerifiedPackages': 0,
        'actualProductRuns': 0, 'formalAcceptanceEligible': False,
        'limitations': [
            '80套仅通过内部契约和结构差异AI审查；企业政策仍未核验。',
            '异常由Case显式构造；该审查没有执行产品。'],
    }
    outputs['manifests/business-reviews/index.json'] = json_bytes(index)
    report = json.loads(outputs['manifests/preparation-report.json'])
    report['businessContentReview'] = 'ai_contract_review_complete'
    report['businessContentReviewCount'] = 80
    report['businessEnterprisePolicyReview'] = 'not_claimed'
    report['remainingWork'] = [x for x in report['remainingWork'] if x != 'business_content_review']
    outputs['manifests/preparation-report.json'] = json_bytes(report)
    readiness = json.loads(outputs['manifests/readiness.json'])
    readiness['blockers'] = [x for x in readiness['blockers'] if x['id'] != 'business_content_review']
    readiness['businessContentAudit'] = {
        'status': 'ai_contract_review_complete', 'packageCount': 80,
        'humanVerifiedPackages': 0, 'enterprisePolicyVerifiedPackages': 0,
        'reviewIndexRef': _pin('manifests/business-reviews/index.json',
                               outputs['manifests/business-reviews/index.json'])}
    outputs['manifests/readiness.json'] = json_bytes(readiness)
    outputs['manifests/inventory.json'] = json_bytes({'schemaVersion': 3, 'files': [
        _pin(path, raw) for path, raw in sorted(outputs.items())
        if path != 'manifests/inventory.json']})
    validate_business_review_snapshot(outputs)
    return outputs


def build_revision(project, snapshot):
    verify_asset_snapshot(project, snapshot)
    outputs = assemble_reviews(snapshot)
    verify_asset_snapshot(project, outputs)
    return outputs


def prepare(project):
    project = Path(project).resolve()
    with candidate_lock(project):
        snapshot = read_candidate(project)
    outputs = build_revision(project, snapshot)
    result = revise_business_review_candidate(project, snapshot, outputs)
    result.update(candidateSha256=snapshot_digest(outputs), reviewedBusinessPackages=80,
                  humanVerifiedPackages=0, enterprisePolicyVerifiedPackages=0,
                  actualProductRuns=0, formalAcceptanceEligible=False)
    return result


if __name__ == '__main__':
    import argparse
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--project', default='.')
    args = parser.parse_args()
    print(json.dumps(prepare(args.project), ensure_ascii=False, indent=2))
