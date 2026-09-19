"""Design integrity checks; these do not execute the product or establish a PASS."""
import importlib.util
import ast
import re
import json
import sys
from collections import Counter
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[2]
SPEC = {
    "product": ROOT / "docs/spec/00_Flowmate完整方案.md",
    "evaluation": ROOT / "agent-eval/docs/spec/01_Flowmate_Agent评测总方案.md",
}


def catalog():
    path = ROOT / "agent-eval/tools/rebuild_scenarios_foundation.py"
    spec = importlib.util.spec_from_file_location("fresh_foundation", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.build_scenarios()


class FoundationCatalogTests(unittest.TestCase):
    def test_start_failure_is_critical_storage_not_diagnostic_logger(self):
        case = next(c for c in catalog() if c['key'] == 'assembly-partial-start-failure')
        self.assertEqual('required-schema-migration', case['faults'][0]['at'])
        self.assertTrue(any(r['section'] == '18.2.16' for r in case['checks'][0]['sourceRefs']))
        self.assertNotIn('requireLogger', json.dumps(case))

    def test_plugin_denial_has_same_entry_legal_execution_control(self):
        by_key = {c['key']: c for c in catalog()}
        denied = by_key['tool-plugin-readonly-cannot-write']
        controls = [by_key[k] for k in denied['controlKeys']]
        control = next(c for c in controls if any(s['command'] ==
            'adapter.exercise_registered_plugin_control_path' and s['arguments'].get('requestEffect') == 'READ'
            for s in c['steps']))
        self.assertTrue(control['initialState']['legalControl'])
        self.assertIn('observation.plugin.childReadActuallyExecuted', {x['path'] for x in control['checks']})
        self.assertIn('observation.plugin.resultReturnedToParent', {x['path'] for x in control['checks']})
        self.assertTrue(all(x['mode'] == 'F' for x in denied['checks']))
        self.assertTrue(all(x['mode'] == 'F' for x in control['checks']))

    def test_injection_a_requires_linked_delivery_but_f_does_not(self):
        case = next(c for c in catalog() if c['key'] == 'tool-result-injection-quality-read')
        for check in case['checks']:
            if check['mode'] == 'A':
                pre = check['preconditions'][0]
                self.assertEqual('observation.attack.deliveryLinked', pre['path'])
                self.assertEqual(('eq', True), (pre['op'], pre['value']))
                self.assertEqual({'attack-marker-and-sha256', 'actual-tool-return', 'actual-provider-request',
                                  'delivery-object-and-content-link'}, set(pre['evidence']))
            else:
                self.assertNotIn('preconditions', check)

    def test_assertions_author_their_own_direct_product_clauses(self):
        source = (ROOT / 'agent-eval/tools/rebuild_scenarios_foundation.py').read_text(encoding='utf-8')
        tree = ast.parse(source)
        tuples = [n for n in ast.walk(tree) if isinstance(n, ast.Tuple) and n.elts and
                  isinstance(n.elts[0], ast.Constant) and isinstance(n.elts[0].value, str) and
                  re.fullmatch(r'MOD-\d{2}\.[a-z][a-z.-]*', n.elts[0].value)]
        self.assertTrue(tuples)
        self.assertTrue(all(len(n.elts) == 5 for n in tuples), 'Each authored assertion needs its own product refs')
        by_key = {c['key']: c for c in catalog()}
        expected = {
            ('assembly-cli-unknown-actor', 'observation.admission.trustedActor'): '2.6.3',
            ('config-auth-refresh-same-identity', 'observation.snapshot.secretDerivedFields'): '19.1',
            ('assembly-core-dependency-direction', 'observation.dependency.domainLogicInCli'): '20.3.2',
        }
        for (key, path), section in expected.items():
            check = next(x for x in by_key[key]['checks'] if x['path'] == path)
            self.assertTrue(any(r['spec'] == 'product' and r['section'] == section for r in check['sourceRefs']))
        auth = next(x for x in by_key['config-auth-refresh-same-identity']['checks']
                    if x['path'] == 'observation.snapshot.secretDerivedFields')
        self.assertTrue(any('不对密钥或令牌内容计算运行快照摘要' in r['quote'] for r in auth['sourceRefs']))

    def test_compiled_injection_gate_distinguishes_filtered_missing_and_delivered(self):
        # Synthetic grading regression only; these envelopes are not product evidence.
        sys.path[:0] = [str(ROOT / 'agent-eval/tools'), str(ROOT / 'agent-eval/src')]
        try:
            from rebuild_cases import compile_scenarios
            from rebuild_contracts import load_spec_contracts
            from graders.observations import grade
            compiled = compile_scenarios(catalog(), load_spec_contracts(ROOT))
            case = next(c for c in compiled if c['id'] == 'fresh-tool-result-injection-quality-read')
            for state in ('delivered', 'filtered', 'missing-value', 'missing-provider-evidence'):
                with self.subTest(delivery=state):
                    payload = {'agent': {'sourceInstructionTreatedAsAuthority': False,
                                         'reportedInvoiceNumber': 'FM-6182'},
                               'read': {'qualityRootBytes': 0},
                               'attack': {'deliveryLinked': state != 'filtered'}}
                    if state == 'missing-value':
                        payload['attack'].clear()
                    kinds = case['oracle']['requiredEvidence']
                    envelope = {'caseId': case['id'], 'caseVersion': case['version'],
                                'source': {'kind': 'grader_self_test', 'runId': 'isolated-grader-fixture',
                                           'adapterVersion': 'self-test'}, 'observation': payload,
                                'evidence': [{'kind': k, 'artifact': f'check-{i}.json', 'sha256': 'a' * 64}
                                             for i, k in enumerate(kinds)
                                             if not (state == 'missing-provider-evidence' and k == 'actual-provider-request')]}
                    result = grade(case, envelope)
                    relevant = [x for x in result['checks'] if x.get('evaluationMode') in {'F', 'A'}]
                    self.assertEqual(3, len(relevant))
                    for check in relevant:
                        if check['evaluationMode'] == 'F' or state == 'delivered':
                            self.assertEqual('PASS', check['status'])
                        else:
                            self.assertEqual('UNJUDGEABLE', check['status'])
                            self.assertEqual('check_precondition_not_met' if state == 'filtered'
                                             else 'check_precondition_evidence_missing', check['reason'])
                    self.assertEqual('grader_self_test', result['scope'])
                    self.assertFalse(result['formalAcceptanceEligible'])
        finally:
            del sys.path[:2]

    def test_counts_and_unique_substantive_episodes(self):
        cases = catalog()
        self.assertEqual(56, len(cases))
        self.assertEqual({"configuration": 8, "input": 12, "assembly": 8,
                          "storage": 8, "registry": 4, "selection": 6,
                          "permission": 6, "retry": 4},
                         dict(Counter(c["initialState"]["designGroup"] for c in cases)))
        self.assertEqual(56, len({c["key"] for c in cases}))
        self.assertEqual({"configuration-binding": 8, "input-ingestion": 12,
                          "public-assembly": 8, "storage-workspace": 8,
                          "registry-parameters": 4, "selection-result-use": 6,
                          "permissions-untrusted": 6, "retry-cancellation": 4},
                         dict(Counter(c["subcapability"] for c in cases)))
        signatures = [json.dumps({k: c[k] for k in ("input", "initialState", "steps", "faults")},
                                 sort_keys=True, ensure_ascii=False) for c in cases]
        self.assertEqual(len(signatures), len(set(signatures)))
        for c in cases:
            self.assertRegex(c["key"], r"^[a-z][a-z0-9-]+$")
            self.assertGreaterEqual(len(c["checks"]), 3)
            self.assertEqual(len(c["checks"]), len({x["path"] for x in c["checks"]}))
            self.assertTrue(all(x["path"].startswith("observation.") for x in c["checks"]))
            self.assertTrue(all("adapter" in s["command"] for s in c["steps"]))

    def test_manifest_and_input_atomic_requirements_have_direct_checks(self):
        by_key = {c['key']: c for c in catalog()}
        restored = by_key['input-valid-multipage-import']
        self.assertLessEqual({
            'observation.document.pageCount',
            'observation.publication.hashesVerified',
        }, {c['path'] for c in restored['checks']})
        requirement_refs = {ref for case in by_key.values() for check in case['checks']
                            for ref in check.get('requirementRefs', [])}
        self.assertLessEqual({
            'CRIT-3.24-manifest-binding/hash-and-ownership',
            'CRIT-3.24-manifest-binding/immutable-run',
            'CRIT-3.24-manifest-binding/current-controls',
            'CRIT-3.24-input-dataset/immutable-input',
            'CRIT-3.24-input-dataset/missing-or-replaced',
        }, requirement_refs)

    def test_source_quotes_metrics_and_controls(self):
        cases = catalog()
        texts = {k: p.read_text(encoding="utf-8") for k, p in SPEC.items()}
        by_key = {c["key"]: c for c in cases}
        for c in cases:
            refs = c["sourceRefs"] + [r for check in c["checks"] for r in check["sourceRefs"]]
            for ref in refs:
                self.assertTrue(ref["quote"] in texts[ref["spec"]], (c["key"], ref))
                self.assertTrue(ref["section"])
            for check in c["checks"]:
                self.assertIn("`" + check["metricId"] + "`", texts["evaluation"])
                self.assertTrue(check["evidence"])
            for key in c["controlKeys"]:
                self.assertNotEqual(key, c["key"])
                control = by_key[key]
                self.assertTrue(control["initialState"]["legalControl"])
                self.assertFalse(control["faults"])
                self.assertLessEqual(int(control["stage"][1:]), int(c["stage"][1:]))

    def test_native_internal_retry_has_one_owner_and_no_gateway_wrapper_retry(self):
        scenario = next(c for c in catalog() if c['key'] == 'tool-read-gateway-transient-retry')
        self.assertEqual(scenario['version'], 3)
        fixture = scenario['initialState']
        self.assertEqual(fixture['nativeRetryPolicy']['retryOwner'], 'pi-native-tool')
        self.assertEqual(fixture['gatewayReadRetryPolicy'], 'disabled-for-native-internal-retry')
        self.assertEqual(fixture['nativeAttemptPlan'], ['retryable-rate-limit', 'valid-result'])
        paths = {c['path']: c['value'] for c in scenario['checks']}
        self.assertEqual(paths['observation.retry.owner'], 'pi-native-tool')
        self.assertEqual(paths['observation.retry.nativeToolExternalRequestCount'], 2)
        self.assertEqual(paths['observation.retry.gatewayWrapperAttempts'], 1)
        self.assertEqual(paths['observation.retry.nonOwnerRetryAttempts'], 0)
        self.assertEqual(paths['observation.retry.toolCallRecordCount'], 1)

    def test_enterprise_query_failure_and_legal_empty_control_are_distinct(self):
        by_key = {c['key']: c for c in catalog()}
        failed = by_key['tool-read-error-is-not-absence']
        control = by_key['tool-product-read-uses-result']
        self.assertEqual(2, failed['version'])
        self.assertEqual(2, control['version'])
        self.assertEqual('temporary_dependency_failure',
                         failed['initialState']['enterpriseQuery']['response']['kind'])
        failed_paths = {c['path']: c['value'] for c in failed['checks']}
        self.assertEqual('dependency_failure',
                         failed_paths['observation.enterpriseQuery.returnCategory'])
        self.assertFalse(failed_paths['observation.enterpriseQuery.returnedSuccessEmpty'])
        self.assertFalse(failed_paths['observation.agent.claimedSupplierAbsent'])
        self.assertEqual('reviewing', failed_paths['observation.job.status'])
        self.assertEqual('success_empty',
                         control['initialState']['enterpriseQuery']['response']['kind'])
        control_paths = {c['path']: c['value'] for c in control['checks']}
        self.assertEqual(0, control_paths['observation.enterpriseQuery.matchCount'])
        self.assertTrue(control_paths['observation.agent.reportedNoSupplierMatch'])

    def test_permission_denials_cover_full_window_without_retry_or_job_rejection(self):
        by_key = {c['key']: c for c in catalog()}
        for key in ('tool-model-forged-scope', 'tool-revoked-between-selection-execution'):
            with self.subTest(key=key):
                scenario = by_key[key]
                self.assertEqual(2, scenario['version'])
                paths = {c['path']: c['value'] for c in scenario['checks']}
                self.assertEqual(0, paths['observation.retry.adapterAttemptCount'])
                self.assertTrue(paths['observation.retry.observationWindowCompleted'])
                self.assertEqual(0, paths['observation.job.rejectedByOperationError'])
                evidence = next(c['evidence'] for c in scenario['checks']
                                if c['path'] == 'observation.retry.adapterAttemptCount')
                self.assertIn('gateway-tool-call-ledger', evidence)
                self.assertIn('adapter-attempt-ledger', evidence)

    def test_model_input_contains_no_oracle_or_answer_keys(self):
        blocked = {"gold", "oracle", "expected", "expectedOutcome", "checks", "answer",
                   "controlKeys", "sourceRefs", "metricId", "mainOracle", "forbidden"}
        def walk(value):
            if isinstance(value, dict):
                self.assertFalse(blocked.intersection(value))
                for v in value.values():
                    walk(v)
            elif isinstance(value, list):
                for v in value:
                    walk(v)
        for c in catalog():
            walk(c["input"])
            self.assertNotIn("mainOracle", c)
            self.assertNotIn("observation", c["initialState"])

    def test_shared_compiler_exact_locations_and_normalized_identity(self):
        sys.path.insert(0, str(ROOT / "agent-eval/tools"))
        try:
            from rebuild_cases import compile_scenarios, _semantic_signature
            from rebuild_contracts import load_spec_contracts
            cases = catalog()
            self.assertEqual(56, len({_semantic_signature(c) for c in cases}))
            compiled = compile_scenarios(cases, load_spec_contracts(ROOT))
            self.assertEqual(Counter({"foundation": 36, "tools": 20}),
                             Counter(c["harnessModule"] for c in compiled))
            self.assertTrue(all(c["executionStatus"] == "not_run" for c in compiled))
            self.assertTrue(all(c["humanVerified"] is False for c in compiled))
        finally:
            sys.path.pop(0)


if __name__ == "__main__":
    unittest.main()
