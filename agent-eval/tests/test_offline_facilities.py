"""Offline assets and observation contracts, independent of a product runtime."""
import copy
import json
from pathlib import Path
import sys
import unittest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'agent-eval/src'))
sys.path.insert(0, str(ROOT / 'agent-eval' / 'tools'))
from invoice_case_catalog import CATALOG
from runner.materialize import materialize
from graders.observations import grade


def fixture(category, slug):
    spec = next(x for x in CATALOG[category] if x['id'] == slug)
    return {'id': 'case-1', 'version': 1, 'category': category,
            'familyId': category + '/' + slug, 'sampleId': 'sample',
            'initialEnvironment': {'scenarioSetup': copy.deepcopy(spec['initialState'])},
            'oracle': {'assertions': spec['expected'], 'requiredEvidence': spec['evidence']}}


def business():
    return {'id': 'business-sample', 'sampleId': 'sample', 'input': {
        'invoice': {'invoiceNumber': 'SIM-1', 'supplierId': 'SUP-1',
            'sellerName': 'Seller', 'currency': 'USD', 'revision': 1,
            'purchaseOrderId': 'PO-1', 'lines': [{'lineId': 'L1', 'sku': 'SKU',
             'quantity': '2', 'unitPrice': '12.00', 'taxRate': '10',
             'netAmount': '24.00', 'taxAmount': '2.40', 'grossAmount': '26.40'}],
            'netAmount': '24.00', 'taxAmount': '2.40', 'totalAmount': '26.40'},
        'suppliers': [{'id': 'SUP-1', 'name': 'Seller', 'aliases': [], 'status': 'active'}],
        'purchaseOrders': [{'id': 'PO-1', 'supplierId': 'SUP-1', 'status': 'open', 'lines': []}],
        'goodsReceipts': [{'id': 'GR-1', 'purchaseOrderId': 'PO-1', 'lines': []}],
        'historicalEntries': [], 'approval': {'status': 'not_requested', 'revision': 1},
        'targetSystems': {'b2b': {'kind': 'local_simulator', 'records': []},
                          'erp': {'kind': 'local_simulator', 'records': []}},
        'workspace': {'id': 'WS', 'state': 'active'}}}


class MaterializationTests(unittest.TestCase):
    def test_receipt_short_has_exact_two_difference_without_price_conflict(self):
        result = materialize(fixture('matching', 'receipt-short'), business())
        inv = result['input']['invoice']
        self.assertEqual(result['status'], 'materialized')
        self.assertEqual(inv['lines'][0]['quantity'], '10')
        self.assertEqual(result['input']['goodsReceipts'][0]['lines'][0]['receivedQuantity'], '8')
        self.assertEqual(result['input']['purchaseOrders'][0]['lines'], inv['lines'])
        self.assertEqual(inv['totalAmount'], '132.00')

    def test_price_and_total_overlays_are_internally_explicit(self):
        price = materialize(fixture('matching', 'price-mismatch'), business())['input']
        self.assertEqual(price['invoice']['totalAmount'], '110.00')
        self.assertEqual(price['purchaseOrders'][0]['lines'][0]['grossAmount'], '100.00')
        total = materialize(fixture('matching', 'total-mismatch'), business())['input']
        self.assertEqual(total['invoice']['lines'][0]['grossAmount'], '100.00')
        self.assertEqual(total['invoice']['totalAmount'], '101.00')

    def test_all_business_families_materialize_without_oracle_leak(self):
        for category in ('matching', 'approval', 'submission'):
            for spec in CATALOG[category]:
                case = fixture(category, spec['id'])
                case['oracle']['canary'] = 'DO-NOT-PROJECT-ANSWER'
                base = business()
                before = copy.deepcopy(base)
                result = materialize(case, base)
                self.assertEqual(result['status'], 'materialized', spec['id'])
                self.assertNotIn('DO-NOT-PROJECT-ANSWER', json.dumps(result))
                self.assertEqual(base, before)

    def test_boundary_values_keep_order_and_receipts_consistent(self):
        for amount in ('9999.99', '10000.00', '10000.01'):
            case = fixture('approval', 'at-limit')
            case['initialEnvironment']['scenarioSetup']['conditions']['syntheticTotal'] = amount
            data = materialize(case, business())['input']
            self.assertEqual(data['invoice']['totalAmount'], amount)
            self.assertEqual(data['invoice']['lines'], data['purchaseOrders'][0]['lines'])

    def test_unknown_conditions_fail_closed(self):
        case = fixture('matching', 'exact-match')
        case['initialEnvironment']['scenarioSetup']['conditions']['unimplementedChange'] = True
        self.assertEqual(materialize(case, business())['status'], 'unsupported')

    def test_native_history_is_not_fabricated(self):
        self.assertEqual(materialize(fixture('runtime', 'session-reopen'))['status'], 'unsupported')

    def test_missing_evidence_removes_receipt_and_stale_review_has_actual_revision(self):
        missing = materialize(fixture('approval', 'missing-evidence'), business())
        self.assertEqual(missing['input']['goodsReceipts'], [])
        stale = materialize(fixture('approval', 'stale-review'), business())
        self.assertEqual(stale['input']['invoice']['revision'], 2)
        self.assertEqual(stale['harness']['commands'][0]['revision'], 1)

    def test_erp_history_is_fixture_not_future_outcome(self):
        result = materialize(fixture('submission', 'erp-confirmed'), business())
        self.assertTrue(result['harness']['b2bReceipt']['fixtureHistory'])
        self.assertEqual(result['input']['targetSystems']['erp']['records'], [])
        self.assertEqual(result['harness']['commands'][0]['operation'], 'advance_erp')

    def test_remote_business_target_rejected(self):
        data = business()
        data['input']['targetSystems']['b2b']['kind'] = 'production'
        self.assertEqual(materialize(fixture('matching', 'exact-match'), data)['status'], 'unsupported')


class GradingTests(unittest.TestCase):
    def case(self, op='eq', value=0):
        return {'id': 'c1', 'version': 1, 'category': 'matching', 'familyId': 'matching/exact-match',
                'oracle': {'checks': [{'checkId': 'writes', 'dimension': 'result', 'required': True, 'assertion': {'path': 'observation.writes', 'op': op, 'value': value}, 'evidenceRequirements': [{'kind':'ledger'}]}],
                           'requiredEvidence': ['ledger']}}

    def observation(self, value=0):
        return {'caseId': 'c1', 'caseVersion': 1,
                'source': {'kind': 'grader_self_test', 'runId': 'run1', 'adapterVersion': 'v1'},
                'evidence': [{'kind': 'ledger', 'artifact': 'ledger.json', 'sha256': 'a'*64}],
                'observation': {'writes': value}}

    def test_real_evidence_required(self):
        self.assertEqual(grade(self.case(), self.observation())['verdict'], 'pass')
        obs = self.observation()
        obs['evidence'] = []
        self.assertEqual(grade(self.case(), obs)['verdict'], 'insufficient_evidence')

    def test_bool_not_integer(self):
        self.assertEqual(grade(self.case(), self.observation(False))['verdict'], 'infrastructure_error')

    def test_absent_distinguishes_missing_from_null(self):
        obs = self.observation()
        obs['observation'] = {}
        self.assertEqual(grade(self.case('absent', None), obs)['verdict'], 'pass')
        self.assertEqual(grade(self.case('absent', None), self.observation(None))['verdict'], 'fail')

    def test_comparisons_and_missing(self):
        for op in ('gte', 'lte'):
            self.assertEqual(grade(self.case(op, 0), self.observation())['verdict'], 'pass')
        self.assertEqual(grade(self.case('contains', 'x'), self.observation(['x']))['verdict'], 'pass')
        obs = self.observation()
        obs['observation'] = {}
        self.assertEqual(grade(self.case(), obs)['verdict'], 'insufficient_evidence')
        self.assertEqual(grade(self.case(), self.observation(1))['verdict'], 'fail')

    def test_identity_and_synthetic_results_fail_closed(self):
        obs = self.observation()
        obs['caseId'] = 'another'
        self.assertEqual(grade(self.case(), obs)['verdict'], 'infrastructure_error')

    def test_bad_evidence_paths_and_operator_types(self):
        obs = self.observation()
        obs['evidence'][0]['artifact'] = '../secret.json'
        self.assertEqual(grade(self.case(), obs)['verdict'], 'infrastructure_error')
        self.assertEqual(grade(self.case('lte', 0), self.observation('0'))['verdict'], 'infrastructure_error')
        self.assertEqual(grade(self.case('not-supported', 0), self.observation())['verdict'], 'infrastructure_error')

    def test_synthetic_self_test_cannot_claim_product_success(self):
        case = self.case()
        case.update(category='platform', familyId='platform/grader-positive')
        obs = self.observation()
        obs['source']['kind'] = 'grader_self_test'
        result = grade(case, obs)
        self.assertEqual(result['verdict'], 'pass')
        self.assertEqual(result['scope'], 'grader_self_test')

    def test_isolation_requires_actual_normal_control_result(self):
        case = self.case()
        case.update(category='isolation', familyId='isolation/path-traversal', normalControlFamily='isolation/allowed-source')
        obs = self.observation()
        self.assertEqual(grade(case, obs)['verdict'], 'insufficient_evidence')
        obs['normalControl'] = {'familyId': 'isolation/allowed-source', 'runId': 'control1',
                                'verdict': 'fail', 'sourceKind': 'product_run'}
        self.assertEqual(grade(case, obs)['verdict'], 'infrastructure_error')
        obs = self.observation()
        obs['source']['kind'] = 'grader_self_test'
        self.assertEqual(grade(self.case(), obs)['scope'], 'grader_self_test')

    def test_extraction_requires_verified_gold(self):
        case = self.case()
        case['category'] = 'extraction'
        self.assertEqual(grade(case, self.observation())['verdict'], 'blocked')

    def test_gold_comparison_does_not_trust_product_claim(self):
        case = self.case()
        case.update(category='extraction', sampleId='s1')
        case['oracle']['fieldGoldVersion'] = 2
        loc = {'asset': 's1/content.json', 'pageNumber': 1, 'pointer': '/0', 'note': 'Human annotation'}
        gold = {'sampleId': 's1', 'version': 2, 'humanVerified': True,
                'reviewedBy': ['reviewer'], 'reviewedAt': '2026-01-15T12:00:00Z',
                'sourceEvidence': [{'sha256': 'a'*64}], 'lineItems': [],
                'fields': {'total': {'normalizedValue': '100.00', 'valueState': 'confirmed', 'evidence': [loc]}}}
        obs = self.observation()
        obs['observation'] = {'extraction': {'goldComparison': 'match_reviewed_gold',
            'fields': {'total': {'normalizedValue': '101.00', 'valueState': 'confirmed', 'evidence': [loc]}},
            'lineItems': []}}
        self.assertEqual(grade(case, obs, gold)['verdict'], 'fail')
        obs['observation']['extraction']['fields']['total']['normalizedValue'] = '100.00'
        self.assertEqual(grade(case, obs, gold)['verdict'], 'pass')
        obs['observation']['extraction']['fields']['total']['evidence'] = [
            {k:v for k,v in loc.items() if k != 'note'}]
        self.assertEqual(grade(case, obs, gold)['verdict'], 'pass')
        self.assertFalse(grade(case, obs, gold)['formalAcceptanceEligible'])
        page_only = {'asset':'s1/original.jpg','pageNumber':1,'note':'Entire page checked'}
        gold['fields']['total']['evidence'] = [page_only]
        obs['observation']['extraction']['fields']['total']['evidence'] = [page_only]
        self.assertEqual(grade(case, obs, gold)['verdict'], 'insufficient_evidence')


if __name__ == '__main__':
    unittest.main()
