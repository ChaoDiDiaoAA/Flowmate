"""Offline assets and observation contracts, independent of a product runtime."""
import copy
import json
from pathlib import Path
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'agent-eval/src'))
sys.path.insert(0, str(ROOT / 'agent-eval' / 'tools'))
from invoice_case_catalog import CATALOG
from prepare_invoice_data import file_info, make_business, make_fixture_policy
from runner.materialize import audit, materialize
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
        'targetSystems': {'b2b': {'kind': 'local_simulator', 'records': []}},
        'workspace': {'id': 'WS', 'state': 'active'}}}


class MaterializationTests(unittest.TestCase):
    def test_audit_accepts_revised_b2b_policy_but_rejects_incompatible_rules(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            quality = root / 'agent-eval/data'
            (quality / 'manifests/releases').mkdir(parents=True)
            (quality / 'manifests/inventory.json').write_text('{}', encoding='utf-8')
            policy = make_fixture_policy()
            policy['version'] = 2
            policy_path = quality / 'manifests/fixture-policy.json'
            release_path = quality / 'manifests/releases/revised.json'
            def save_policy():
                policy_path.write_text(json.dumps(policy), encoding='utf-8')
                release = {'id': 'revised', 'assets': [{'kind': 'policy',
                    'id': 'fixture-policy-v1', 'version': 2, 'file': file_info(policy_path, quality)}]}
                release_path.write_text(json.dumps(release), encoding='utf-8')
            save_policy()
            self.assertEqual(audit(root, release='revised')['actualProductRuns'], 0)
            policy['rules']['approverAmountLimit'] = '10000.00'
            save_policy()
            with self.assertRaisesRegex(ValueError, 'policy'):
                audit(root, release='revised')

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

    def test_confirmation_amounts_keep_order_and_receipts_consistent_without_limits(self):
        for amount in ('26.40', '12000.00'):
            case = fixture('approval', 'valid-approval')
            case['initialEnvironment']['scenarioSetup']['conditions']['syntheticTotal'] = amount
            result = materialize(case, business())
            self.assertEqual(result['status'], 'materialized')
            data = result['input']
            self.assertEqual(data['invoice']['totalAmount'], amount)
            self.assertEqual(data['invoice']['lines'], data['purchaseOrders'][0]['lines'])
            self.assertNotIn('approvalLimit', result['harness']['policy'])
            self.assertEqual(result['harness']['commands'][0]['operation'], 'confirm_submission')

    def test_generated_business_has_b2b_target_and_readonly_matching_materials(self):
        row = {'id': 'sample', 'split': 'development', 'labels': None, 'content': []}
        generated = make_business(row, 1)
        self.assertEqual(set(generated['input']['targetSystems']), {'b2b'})
        result = materialize(fixture('matching', 'exact-match'), generated)
        self.assertEqual(result['status'], 'materialized')
        self.assertTrue(result['input']['suppliers'])
        self.assertTrue(result['input']['purchaseOrders'])
        self.assertTrue(result['input']['goodsReceipts'])

    def test_untrusted_role_claim_cannot_replace_trusted_viewer(self):
        result = materialize(fixture('approval', 'wrong-role'), business())
        self.assertEqual(result['status'], 'materialized')
        self.assertEqual(result['harness']['trustedActor']['role'], 'viewer')
        self.assertEqual(result['harness']['commands'][0]['submittedRoleClaim'], 'authorized_operator')
        self.assertEqual(result['input']['approval']['status'], 'not_requested')

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

    def test_b2b_submission_has_no_erp_execution_or_evidence_requirement(self):
        case = fixture('submission', 'confirmed-submit')
        result = materialize(case, business())
        self.assertEqual(result['status'], 'materialized')
        self.assertEqual(set(result['input']['targetSystems']), {'b2b'})
        self.assertEqual(result['harness']['commands'][0]['operation'], 'advance_submission')
        self.assertNotIn('erp', json.dumps(result).lower())
        self.assertFalse(any('ERP' in item for item in case['oracle']['requiredEvidence']))

    def test_removed_families_and_extra_execution_targets_are_rejected(self):
        retired = {
            'matching/verification-unknown': {'verificationRequired': True, 'verificationServiceResult': 'unknown'},
            'matching/verification-invalid': {'verificationRequired': True, 'verificationServiceResult': 'invalid', 'resultSource': 'synthetic_authority'},
            'approval/over-limit': {'actorRole': 'approver', 'syntheticTotal': '10000.01'},
            'approval/at-limit': {'actorRole': 'approver', 'syntheticTotal': '10000.00', 'payloadHashUnchanged': True},
            'approval/erp-outside-scope': {'approvedActions': ['synthetic_b2b_submit'], 'requestedAction': 'synthetic_erp_writeback'},
            'submission/erp-confirmed': {'historicalB2bReceipt': 'confirmed', 'erpRequired': True, 'erpAuthorized': True, 'erpBehavior': 'accept'},
            'submission/erp-retry-only': {'historicalB2bReceipt': 'confirmed', 'historicalErpStatus': 'failed_before_effect', 'erpAuthorized': True, 'erpBehavior': 'accept'},
            'submission/erp-response-lost': {'historicalB2bReceipt': 'confirmed', 'erpAuthorized': True, 'erpBehavior': 'accept_then_drop_response', 'erpQueryBehavior': 'find_exact_record'},
            'submission/erp-scope-missing': {'historicalB2bReceipt': 'confirmed', 'erpRequired': True, 'erpAuthorized': False},
        }
        for family, conditions in retired.items():
            case = fixture('matching', 'exact-match')
            case.update(category=family.split('/')[0], familyId=family)
            case['initialEnvironment']['scenarioSetup']['conditions'] = conditions
            self.assertEqual(materialize(case, business())['status'], 'unsupported')
        data = business()
        data['input']['targetSystems']['erp'] = {'kind': 'local_simulator', 'records': []}
        self.assertEqual(materialize(fixture('submission', 'confirmed-submit'), data)['status'], 'unsupported')

    def test_unknown_action_cannot_be_projected_as_an_execution_command(self):
        case = fixture('submission', 'no-approval')
        case['initialEnvironment']['scenarioSetup']['conditions']['requestedAction'] = 'synthetic_erp_writeback'
        result = materialize(case, business())
        self.assertEqual(result['status'], 'unsupported')
        self.assertEqual(result['harness'], {})

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
