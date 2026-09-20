"""Fresh business fixtures use exact authored assets and explicit data patches."""
from copy import deepcopy
from pathlib import Path
import sys
import unittest

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / 'agent-eval/tools'))
sys.path.insert(0, str(ROOT / 'agent-eval/src'))


class BusinessProjectionTests(unittest.TestCase):
    def business_scenarios(self):
        from test_rebuild_cases import contracts_and_scenario
        from rebuild_contracts import load_spec_contracts
        _, normal = contracts_and_scenario()
        normal.update(module='workflow', businessId='business-single-order-01',
                      businessPatches=[], input={'request': '核对当前发票与订单'},
                      controlKeys=[])
        condition = deepcopy(normal)
        condition.update(key='receipt-shortage', controlKeys=[normal['key']],
            businessPatches=[{'op': 'replace', 'path': '/goodsReceipts/0/lines/0/receivedBaseQuantity',
                              'value': '0', 'reason': '已收货数量不足'}])
        # Use a source/metric actually defined in the real current specs.
        for s in (normal, condition):
            s['sourceRefs'] = [{'spec': 'product', 'section': '18.3', 'quote': '事务成功后才发布对应成功通知'}]
            for check in s['checks']:
                check['metricId'] = 'MOD-25.atomic'
                check['sourceRefs'] = s['sourceRefs']
        return load_spec_contracts(ROOT), [normal, condition]

    def test_business_case_pins_identity_and_inherits_split(self):
        from rebuild_cases import compile_scenarios
        from rebuild_business_projection import authored_business, asset_ref
        contracts, scenarios = self.business_scenarios()
        assets = authored_business(contracts)
        cases = compile_scenarios(scenarios, contracts)
        for case in cases:
            asset = assets[scenarios[0]['businessId']]
            self.assertEqual(asset_ref(asset), case['businessRef'])
            self.assertEqual(asset['split'], case['split'])
            self.assertEqual(asset['leakageGroup'], case['leakageGroup'])
            self.assertEqual('controlled_business_episode', case['inputMode'])
        self.assertNotEqual(cases[0]['semanticScenarioKey'], cases[1]['semanticScenarioKey'])
        scenarios[1]['businessId'] = 'business-single-order-02'
        with self.assertRaisesRegex(ValueError, 'business.*control|control.*business'):
            compile_scenarios(scenarios, contracts)

    def test_public_projection_requires_exact_supplied_business_asset(self):
        from unittest.mock import patch
        from rebuild_cases import compile_scenarios
        from rebuild_business_projection import authored_business
        from runner.materialize import materialize
        contracts, scenarios = self.business_scenarios()
        cases = compile_scenarios(scenarios, contracts)
        asset = authored_business(contracts)[scenarios[0]['businessId']]
        registry = {'fresh-' + s['key']: s for s in scenarios}
        with patch('rebuild_fixtures.registered_scenarios', return_value=registry):
            result = materialize(cases[1], asset)
            self.assertEqual('materialized', result['status'], result)
            self.assertEqual('0', result['input']['business']['goodsReceipts'][0]['lines'][0]['receivedBaseQuantity'])
            self.assertEqual(asset['input']['invoice'], result['input']['business']['invoice'])
            self.assertNotIn('humanVerified', result['input'])
            self.assertNotIn('businessPatches', result['input'])
            self.assertEqual([], result['harness']['businessInitialState']['approvals'])
            self.assertEqual('unsupported', materialize(cases[0])['status'])
            bad = deepcopy(asset)
            bad['input']['invoice']['totalAmount'] = '1'
            self.assertEqual('unsupported', materialize(cases[0], bad)['status'])

    def test_public_materialize_rejects_rehashed_asset_with_untrusted_spec_pins(self):
        from unittest.mock import patch
        from rebuild_cases import compile_scenarios
        from rebuild_bindings import CURRENT_BINDING_REVISION
        from rebuild_business_projection import authored_business, asset_ref, project_business
        from runner.materialize import materialize
        contracts, scenarios = self.business_scenarios()
        original_case = compile_scenarios(scenarios, contracts)[0]
        original_asset = authored_business(contracts)[scenarios[0]['businessId']]
        registry = {'fresh-' + s['key']: s for s in scenarios}
        with patch('rebuild_fixtures.registered_scenarios', return_value=registry):
            valid = materialize(original_case, original_asset)
            self.assertEqual('materialized', valid['status'])
            self.assertTrue(valid['fixtureValidation']['businessBaseValidated'])
            self.assertFalse(valid['fixtureValidation']['actualProductRun'])
            for mutation in ('bad-hash', 'missing', 'duplicate', 'outdated', 'bad-path', 'bad-length'):
                with self.subTest(mutation=mutation):
                    asset = deepcopy(original_asset)
                    if mutation == 'bad-hash':
                        asset['specRefs'][0]['sha256'] = '0' * 64
                    elif mutation == 'missing':
                        del asset['specRefs']
                    elif mutation == 'duplicate':
                        asset['specRefs'] = [deepcopy(asset['specRefs'][0]), deepcopy(asset['specRefs'][0])]
                    elif mutation == 'outdated':
                        import hashlib
                        asset['specRefs'][0]['sha256'] = hashlib.sha256(b'synthetic previous specification').hexdigest()
                    elif mutation == 'bad-path':
                        asset['specRefs'][0]['path'] = 'untrusted/spec-copy.md'
                    else:
                        asset['specRefs'][0]['bytes'] += 1
                    # Reviewer reproducer: both references legitimately hash the
                    # supplied bytes, and authored scenario conditions are unchanged.
                    case = deepcopy(original_case)
                    case['businessRef'] = asset_ref(asset)
                    case['initialEnvironment']['fixtureBaseRef'] = asset_ref(asset)
                    before = deepcopy((case, asset))
                    result = materialize(case, asset)
                    self.assertEqual('unsupported', result['status'], mutation)
                    self.assertNotIn('fixtureValidation', result)
                    self.assertTrue(any('source specification' in message for message in result['limitations']))
                    with self.assertRaisesRegex(ValueError, 'source specification'):
                        project_business(asset_ref(asset), asset, [])
                    self.assertEqual(before, (case, asset))

    def test_public_source_authority_is_code_root_not_cwd_or_asset_root(self):
        import os
        import tempfile
        from unittest.mock import patch
        from rebuild_cases import compile_scenarios
        from rebuild_business_projection import authored_business, asset_ref
        from rebuild_dataset import json_bytes
        from harness_paths import canonical_case_path
        from runner.materialize import audit, materialize
        contracts, scenarios = self.business_scenarios()
        case = compile_scenarios(scenarios, contracts)[0]
        asset = authored_business(contracts)[scenarios[0]['businessId']]
        registry = {'fresh-' + s['key']: s for s in scenarios}
        with tempfile.TemporaryDirectory() as temporary, patch('rebuild_fixtures.registered_scenarios', return_value=registry):
            root = Path(temporary)
            data = root / 'untrusted-quality'
            # A supported audit(root, data_root=...) may use a caller-owned root.
            # Its spec copies must not become the source-pin authority.
            for document in contracts['documents'].values():
                copy_path = root / document['path']
                copy_path.parent.mkdir(parents=True, exist_ok=True)
                copy_path.write_text('caller-controlled specification', encoding='utf-8')
            prior_cwd = Path.cwd()
            try:
                os.chdir(root)
                self.assertEqual('materialized', materialize(case, asset)['status'])
                import hashlib
                asset['specRefs'][0]['sha256'] = hashlib.sha256(b'caller-controlled specification').hexdigest()
                asset['specRefs'][0]['bytes'] = len(b'caller-controlled specification')
                case['businessRef'] = asset_ref(asset)
                case['initialEnvironment']['fixtureBaseRef'] = asset_ref(asset)
                path = data / asset_ref(asset)['path']
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(json_bytes(asset))
                path = data / canonical_case_path(case)
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(json_bytes(case))
                report = audit(root, data_root=data)
                self.assertEqual(0, report['adapterPlanCount'])
                self.assertEqual(0, report['actualProductRuns'])
                self.assertEqual({case['familyId']: 1}, report['unsupportedFamilies'])
            finally:
                os.chdir(prior_cwd)
    def test_pinned_packages_match_actual_construction_shape(self):
        from rebuild_bindings import CURRENT_BINDING_REVISION
        from rebuild_business_projection import authored_business, asset_ref, project_business
        from rebuild_contracts import load_spec_contracts
        from rebuild_business import build_business_packages
        assets = authored_business(load_spec_contracts(ROOT))
        self.assertEqual(80, len(assets))
        for unpinned in build_business_packages():
            asset = assets[unpinned['id']]
            self.assertEqual(unpinned['version'] + CURRENT_BINDING_REVISION - 1,
                             asset['version'])
            self.assertEqual(unpinned['version'], asset['authoredVersion'])
            self.assertEqual(CURRENT_BINDING_REVISION, asset['sourceBindingRevision'])
            from rebuild_bindings import PREVIOUS_PINS
            self.assertEqual(PREVIOUS_PINS, asset['creationSpecRefs'])
            self.assertEqual({k: v for k, v in unpinned.items() if k != 'version'},
                {k: v for k, v in asset.items() if k not in {
                    'version', 'specRefs', 'creationSpecRefs', 'authoredVersion', 'sourceBindingRevision'}})
            result = project_business(asset_ref(asset), asset, [])
            self.assertEqual(asset['input'], result['input'])
            self.assertEqual(asset['policy'], result['policy'])
            self.assertNotIn('design', result['input'])
            self.assertNotIn('reviewStatus', result['input'])
            result['input']['invoice']['totalAmount'] = 'changed'
            self.assertNotEqual('changed', asset['input']['invoice']['totalAmount'])

    def test_explicit_mismatch_stays_visible_without_mutating_base(self):
        from rebuild_business_projection import authored_business, asset_ref, project_business
        from rebuild_contracts import load_spec_contracts
        asset = next(iter(authored_business(load_spec_contracts(ROOT)).values()))
        before = deepcopy(asset)
        patches = [{'op': 'replace', 'path': '/goodsReceipts/0/lines/0/receivedBaseQuantity',
                    'value': '0', 'reason': '收货不足，不能自行降低发票数量'}]
        result = project_business(asset_ref(asset), asset, patches)
        self.assertEqual('0', result['input']['goodsReceipts'][0]['lines'][0]['receivedBaseQuantity'])
        self.assertEqual(before['input']['invoice'], result['input']['invoice'])
        self.assertEqual(before, asset)
        self.assertFalse(result['baseContentReviewed'])
        self.assertEqual(patches, result['appliedPatches'])

    def test_digest_and_patch_errors_fail_closed(self):
        from rebuild_business_projection import authored_business, asset_ref, project_business
        from rebuild_contracts import load_spec_contracts
        asset = next(iter(authored_business(load_spec_contracts(ROOT)).values()))
        wrong = deepcopy(asset)
        wrong['input']['invoice']['totalAmount'] = '999'
        with self.assertRaisesRegex(ValueError, 'digest'):
            project_business(asset_ref(asset), wrong, [])
        # Rehashing both sides cannot invent a new current asset under the same ID.
        wrong = deepcopy(asset)
        wrong['input']['suppliers'][0]['name'] = 'unauthored supplier name'
        wrong['input']['invoice']['sellerName'] = 'unauthored supplier name'
        with self.assertRaisesRegex(ValueError, 'authored'):
            project_business(asset_ref(wrong), wrong, [])
        for patch in [
                {'op': 'replace', 'path': '/invoice/notAField', 'value': 'x', 'reason': 'bad'},
                {'op': 'replace', 'path': '/policy/currency', 'value': 'EUR', 'reason': 'bad'},
                {'op': 'remove', 'path': '/suppliers/999', 'reason': 'bad'},
                {'op': 'unknown', 'path': '/suppliers', 'reason': 'bad'},
                {'op': 'remove', 'path': '/invoice', 'reason': 'bad'},
                {'op': 'replace', 'path': '/invoice/currency', 'value': 'EUR', 'reason': ''},
                {'op': 'replace', 'path': '/invoice/currency', 'value': {'oracle': 1}, 'reason': 'bad'},
                {'op': 'replace', 'path': '/invoice/currency', 'value': 'EUR', 'reason': 'x', 'autoFix': True}]:
            with self.assertRaises(ValueError, msg=str(patch)):
                project_business(asset_ref(asset), asset, [patch])

    def test_catalog_requires_actual_business_bytes_and_matching_data_use(self):
        from unittest.mock import patch
        from test_rebuild_case_release import asset_snapshot
        from rebuild_cases import compile_scenarios
        from rebuild_business_projection import authored_business, asset_ref
        from rebuild_case_release import assemble_case_files
        from rebuild_dataset import json_bytes
        contracts, scenarios = self.business_scenarios()
        cases = compile_scenarios(scenarios, contracts)
        asset = authored_business(contracts)[scenarios[0]['businessId']]
        ref = asset_ref(asset)
        files = asset_snapshot()
        files[ref['path']] = json_bytes(asset)
        registry = {'fresh-' + s['key']: s for s in scenarios}
        with patch('rebuild_fixtures.registered_scenarios', return_value=registry):
            outputs = assemble_case_files(files, cases, contracts)
            import json
            catalog = json.loads(outputs['manifests/case-catalog.json'])
            self.assertTrue(all(e.get('businessRef') == ref for e in catalog['cases']))
            for changed in ('missing', 'drift', 'source', 'split'):
                bad_files, bad_cases = dict(files), deepcopy(cases)
                if changed == 'missing':
                    del bad_files[ref['path']]
                elif changed == 'drift':
                    bad_asset = deepcopy(asset)
                    bad_asset['input']['invoice']['totalAmount'] = '999'
                    bad_files[ref['path']] = json_bytes(bad_asset)
                elif changed == 'source':
                    bad_asset = deepcopy(asset)
                    bad_asset['specRefs'][0]['sha256'] = '0' * 64
                    bad_files[ref['path']] = json_bytes(bad_asset)
                    for case in bad_cases:
                        case['businessRef'] = asset_ref(bad_asset)
                        case['initialEnvironment']['fixtureBaseRef'] = asset_ref(bad_asset)
                else:
                    for case in bad_cases:
                        case['split'] = 'acceptance'
                with self.assertRaisesRegex(ValueError, '[Bb]usiness'):
                    assemble_case_files(bad_files, bad_cases, contracts)

    def test_audit_resolves_business_ref_without_invoice_sample_identity(self):
        import json
        import tempfile
        from unittest.mock import patch
        from rebuild_cases import compile_scenarios
        from rebuild_business_projection import authored_business, asset_ref
        from rebuild_dataset import json_bytes
        from harness_paths import canonical_case_path
        from runner.materialize import audit
        contracts, scenarios = self.business_scenarios()
        cases = compile_scenarios(scenarios, contracts)
        asset = authored_business(contracts)[scenarios[0]['businessId']]
        registry = {'fresh-' + s['key']: s for s in scenarios}
        with tempfile.TemporaryDirectory() as tmp, patch('rebuild_fixtures.registered_scenarios', return_value=registry):
            root = Path(tmp)
            data = root / 'quality'
            for case in cases:
                path = data / canonical_case_path(case)
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(json_bytes(case))
            path = data / asset_ref(asset)['path']
            path.parent.mkdir(parents=True)
            path.write_bytes(json_bytes(asset))
            report = audit(root, data_root=data)
            self.assertEqual(2, report['fixtureCount'])
            self.assertEqual(2, report['adapterPlanCount'])
            self.assertEqual(0, report['actualProductRuns'])
            path.unlink()
            with self.assertRaisesRegex(ValueError, '[Bb]usiness'):
                audit(root, data_root=data)

    def test_malformed_refs_and_undeclared_business_fail_closed(self):
        from rebuild_business_projection import project_business, authored_business, asset_ref
        from rebuild_contracts import load_spec_contracts
        assets = authored_business(load_spec_contracts(ROOT))
        asset = next(iter(assets.values()))
        for value in ({}, {'id': []}, [], None):
            with self.assertRaises(ValueError):
                project_business(asset_ref(asset), value, [])
        for value in ('../outside', '/absolute', 'business/../gold/answer.json'):
            ref = asset_ref(asset)
            ref['path'] = value
            with self.assertRaises(ValueError):
                project_business(ref, asset, [])


if __name__ == '__main__':
    unittest.main()
