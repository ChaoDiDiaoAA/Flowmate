"""Authoring facilities only: never produce product execution or reviewed Gold."""
from collections import Counter
from copy import deepcopy
from decimal import Decimal, ROUND_HALF_EVEN
import hashlib
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'agent-eval/tools'))
sys.path.insert(0, str(ROOT / 'agent-eval/src'))
from rebuild_cases import compile_scenarios
from rebuild_contracts import load_spec_contracts
from rebuild_business_projection import authored_business, project_business
from graders.observations import grade


class WorkflowAuthoringTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.module = importlib.util.find_spec('rebuild_scenarios_workflow')
        if cls.module:
            from rebuild_scenarios_workflow import build_scenarios
            cls.scenarios = build_scenarios()
            cls.contracts = load_spec_contracts(ROOT)
            cls.cases = compile_scenarios(cls.scenarios, cls.contracts)
            cls.by_key = {s['key']: s for s in cls.scenarios}

    def setUp(self):
        self.assertIsNotNone(self.module, '92 fresh Workflow episodes must be authored')

    def test_budget_and_semantic_substance(self):
        self.assertEqual(92, len(self.scenarios))
        self.assertEqual({'normalization-rules': 12, 'business-duplicates': 12,
                          'supplier-matching': 16, 'order-receipt-contract-balance': 20,
                          'human-review-revision': 16, 'steps-wait-concurrency-recovery': 16},
                         dict(Counter(s['subcapability'] for s in self.scenarios)))
        self.assertEqual(92, len({c['semanticScenarioKey'] for c in self.cases}))
        # Ignore titles, user prose and episode IDs; different facts/actions remain.
        substances = [json.dumps([s.get('businessId'), s.get('businessPatches'),
                                  s['initialState']['facts'], s['steps'][1:-1], s['faults']],
                                 sort_keys=True, ensure_ascii=False) for s in self.scenarios]
        self.assertEqual(92, len(set(substances)))

    def test_exact_sources_controls_and_asset_pins(self):
        by_id = {c['id']: c for c in self.cases}
        assets = authored_business(self.contracts)
        for s, c in zip(self.scenarios, self.cases):
            self.assertRegex(s['userInput'], '[\u4e00-\u9fff]')
            self.assertEqual('P8', s['stage'])
            self.assertEqual('workflow', s['module'])
            for check in s['checks']:
                self.assertEqual(['product', 'evaluation'], [r['spec'] for r in check['sourceRefs']])
                self.assertEqual('`' + check['metricId'] + '`', check['sourceRefs'][1]['quote'])
            for ref in c['normalControlRefs']:
                control = by_id[ref['caseId']]
                self.assertFalse(control['normalControlRefs'])
                self.assertTrue(control['episode']['initialState']['legalControl'])
                self.assertFalse(control['episode']['faults'])
                raw = json.dumps(control, ensure_ascii=False, sort_keys=True,
                                 separators=(',', ':'), allow_nan=False).encode()
                self.assertEqual(hashlib.sha256(raw).hexdigest(), ref['caseSha256'])
                self.assertEqual(c.get('businessRef'), control.get('businessRef'))
            if 'businessRef' in c:
                asset = assets[c['businessRef']['id']]
                projected = project_business(c['businessRef'], asset, c['businessPatches'])
                self.assertFalse(projected['actualProductRun'])
                self.assertEqual(asset['split'], c['split'])
                self.assertEqual(asset['leakageGroup'], c['leakageGroup'])
            self.assertFalse(c['humanVerified'])
            self.assertFalse(c['formalAcceptanceEligible'])
            self.assertEqual('not_run', c['executionStatus'])

    def test_each_necessary_check_fails_and_missing_evidence_stays_unknown(self):
        for case in self.cases:
            for definition in case['oracle']['checks']:
                # Isolate each real compiled predicate in explicit grader self-test mode.
                probe = deepcopy(case)
                probe['normalControlRefs'] = []
                probe['oracle']['checks'] = [deepcopy(definition)]
                needs = {e['kind'] for e in definition['evidenceRequirements']}
                needs.update(e for p in definition.get('preconditions', []) for e in p['evidence'])
                probe['oracle']['requiredEvidence'] = sorted(needs)
                payload = {}
                def put(path, value):
                    node = payload
                    names = path.split('.')[1:]
                    for name in names[:-1]:
                        node = node.setdefault(name, {})
                    node[names[-1]] = value
                for condition in definition.get('preconditions', []):
                    put(condition['path'], condition['value'])
                    self.assertNotEqual(condition['path'], definition['assertion']['path'])
                    self.assertNotRegex(condition['path'], 'success|passed|accepted|correct')
                assertion = definition['assertion']
                put(assertion['path'], assertion['value'])
                envelope = {'caseId': probe['id'], 'caseVersion': probe['version'],
                            'source': {'kind': 'grader_self_test', 'runId': 'facility', 'adapterVersion': 'self-test'},
                            'evidence': [{'kind': k, 'artifact': 'facility.json', 'sha256': 'a' * 64} for k in needs],
                            'observation': payload}
                result = grade(probe, envelope)
                self.assertEqual('pass', result['verdict'], definition['checkId'])
                self.assertFalse(result['formalAcceptanceEligible'])
                value = assertion['value']
                wrong = (not value if type(value) is bool else value + 1 if type(value) in (int, float)
                         else value + '-wrong' if isinstance(value, str) else ['wrong'] if isinstance(value, list)
                         else {'wrong': True})
                put(assertion['path'], wrong)
                self.assertEqual('fail', grade(probe, envelope)['verdict'], definition['checkId'])
                put(assertion['path'], value)
                for kind in needs:
                    missing = deepcopy(envelope)
                    missing['evidence'] = [e for e in missing['evidence'] if e['kind'] != kind]
                    self.assertEqual('insufficient_evidence', grade(probe, missing)['verdict'])
                missing = deepcopy(envelope)
                missing['observation'] = {}
                self.assertEqual('insufficient_evidence', grade(probe, missing)['verdict'])

    def test_independent_decimal_and_quantity_recalculation(self):
        assets = authored_business(self.contracts)
        by_id = {c['id'].removeprefix('fresh-'): c for c in self.cases}
        def projected(key):
            c = by_id[key]
            return project_business(c['businessRef'], assets[c['businessRef']['id']], c['businessPatches'])['input']
        def oracle(key, check):
            return next(x['value'] for x in self.by_key[key]['checks'] if x['key'] == check)
        for key in ['wf-round-even-down', 'wf-round-even-up']:
            row = projected(key)['invoice']['lines'][0]
            net = (Decimal(row['quantity']) * Decimal(row['unitPrice'])).quantize(Decimal('.01'), rounding=ROUND_HALF_EVEN)
            self.assertEqual(str(net), oracle(key, 'calculated-net'))
        data = projected('wf-receipt-unit-control')
        row = data['invoice']['lines'][0]
        self.assertEqual(str(Decimal(row['quantity']) * Decimal(row['unitsPerInvoiceUnit'])),
                         oracle('wf-receipt-unit-control', 'required-base-quantity'))
        data = projected('wf-balance-reservation-control')
        row = data['balances'][0]
        available = Decimal(row['receivedQuantity']) - Decimal(row['consumedQuantity']) - Decimal(row['reservedQuantity'])
        self.assertEqual(str(available), oracle('wf-balance-reservation-control', 'available-quantity'))
        data = projected('wf-total-conflict')
        self.assertNotEqual(Decimal(data['invoice']['totalAmount']),
                            Decimal(data['invoice']['netAmount']) + Decimal(data['invoice']['taxAmount']))

    def test_adapter_dependencies_and_constructive_races(self):
        for s in self.scenarios:
            self.assertEqual('declaration_only', s['initialState']['fixtureStatus'])
            self.assertIn('actual_product_adapter', s['initialState']['dependencies'])
            self.assertIn('trusted_evidence_collector', s['initialState']['dependencies'])
            if any(c['mode'] == 'A' for c in s['checks']):
                self.assertIn('real_model', s['initialState']['dependencies'])
                self.assertGreaterEqual(len(s['initialState']['acceptedModelRoutes']), 2)
                self.assertIn('adapter.run_real_model_task', [c['command'] for c in s['steps']])
                for c in s['checks']:
                    if c['mode'] == 'A':
                        self.assertIn('real_model_output', c['evidence'])
            for index, step in enumerate(s['steps']):
                self.assertTrue(step['actor'].startswith('trusted_'))
                if index:
                    self.assertEqual([s['steps'][index - 1]['id']], step['after'])
            if s['initialState']['facts'].get('concurrency'):
                race = s['initialState']['facts']['concurrency']
                self.assertGreaterEqual(len(race['workers']), 2)
                self.assertIn('releaseBarrier', race)
                self.assertIn('raw_transaction_log', {e for c in s['checks'] for e in c['evidence']})
                triggers = {c['key']: c['value'] for c in s['checks']}
                self.assertEqual(len(race['workers']), triggers.get('barrier-arrival-count'))
                self.assertEqual(True, triggers.get('barrier-released'))
            if s['faults']:
                triggers = {c['key']: c['value'] for c in s['checks']}
                self.assertEqual(len(s['faults']), triggers.get('observed-fault-count'))

    def test_independent_supplier_and_contract_selection_from_projected_facts(self):
        assets = authored_business(self.contracts)
        cases = {c['id'].removeprefix('fresh-'): c for c in self.cases}
        def data(key):
            c = cases[key]
            return project_business(c['businessRef'], assets[c['businessRef']['id']], c['businessPatches'])['input']
        candidate = data('wf-supplier-alias-control')
        inv = candidate['invoice']
        eligible = [s['id'] for s in candidate['suppliers'] if s['registration'] == inv['supplierRegistration']
                    and inv['sellerName'] in [s['name'], *s['aliases']] and s['status'] == 'active']
        self.assertEqual(['business-supplier-alias-02-SUP'], eligible)
        candidate = data('wf-supplier-ambiguous-registration')
        self.assertNotIn('supplierRegistration', candidate['invoice'])
        self.assertEqual(2, len([s for s in candidate['suppliers'] if candidate['invoice']['sellerName'] in [s['name'], *s['aliases']]]))
        candidate = data('wf-contract-control')
        order = candidate['purchaseOrders'][0]
        eligible = [c['id'] for c in candidate['contracts'] if c['id'] == order['contractId']
                    and c['validFrom'] <= candidate['invoice']['invoiceDate'] <= c['validUntil']
                    and c['status'] == 'active']
        self.assertEqual(['business-contract-price-02-CONTRACT'], eligible)

    def test_normal_control_missing_or_failed_cannot_pass_condition(self):
        by_id = {c['id']: c for c in self.cases}
        def envelope(case, run):
            payload = {}
            def put(path, value):
                node = payload
                names = path.split('.')[1:]
                for name in names[:-1]:
                    node = node.setdefault(name, {})
                node[names[-1]] = deepcopy(value)
            for check in case['oracle']['checks']:
                for condition in check.get('preconditions', []):
                    put(condition['path'], condition['value'])
                put(check['assertion']['path'], check['assertion']['value'])
            return {'caseId': case['id'], 'caseVersion': case['version'],
                    'source': {'kind': 'grader_self_test', 'runId': run, 'adapterVersion': 'facility'},
                    'evidence': [{'kind': kind, 'artifact': 'facility.json', 'sha256': 'b' * 64}
                                 for kind in case['oracle']['requiredEvidence']], 'observation': payload}
        for case in self.cases:
            if not case['normalControlRefs']:
                continue
            trial = envelope(case, 'condition-facility')
            self.assertEqual('insufficient_evidence', grade(case, trial)['verdict'])
            ref = case['normalControlRefs'][0]
            control = by_id[ref['caseId']]
            control_trial = envelope(control, 'independent-control-facility')
            control_trial['observation']['evaluatedCase'] = deepcopy(control)
            trial['normalControls'] = [control_trial]
            self.assertEqual('pass', grade(case, trial)['verdict'])
            assertion = control['oracle']['checks'][-1]['assertion']
            control_trial['observation'][assertion['path'].split('.')[1]] = True
            self.assertEqual('fail', grade(case, trial)['verdict'])

    def test_late_duplicate_query_has_real_revision_and_release_sequence(self):
        scenario = self.by_key['wf-duplicate-late-search']
        facts = scenario['initialState']['facts']
        self.assertEqual(1, facts.get('revision'), 'initial revision must agree with projected invoice')
        commands = scenario['steps'][1:-1]
        names = [c['command'] for c in commands]
        self.assertEqual(['adapter.create_declared_evidence', 'adapter.start_business_duplicate_query',
                          'adapter.await_duplicate_query_barrier', 'adapter.respond_human_interaction',
                          'adapter.start_business_duplicate_query', 'adapter.publish_duplicate_query_result',
                          'adapter.release_held_duplicate_query'], names)
        asset = authored_business(self.contracts)[scenario['businessId']]
        from rebuild_business_projection import asset_ref
        data = project_business(asset_ref(asset), asset, scenario['businessPatches'])['input']
        old_invoice = deepcopy(data['invoice'])
        old_query = commands[1]['arguments']
        correction = commands[3]['arguments']
        new_query = commands[4]['arguments']
        self.assertEqual(old_invoice['revision'], old_query['revision'])
        self.assertEqual(old_invoice['revision'], correction['expectedRevision'])
        self.assertNotEqual(old_invoice['invoiceNumber'], correction['fields']['invoiceNumber'])
        proof = facts['evidenceObjects'][0]
        self.assertEqual(proof['id'], correction['evidenceRef'])
        self.assertEqual(correction['fields']['invoiceNumber'], json.loads(proof['content'])['invoiceNumber'])
        self.assertEqual(2, new_query['revision'])
        self.assertEqual(new_query['queryId'], commands[5]['arguments']['queryId'])
        self.assertEqual(old_query['queryId'], commands[6]['arguments']['queryId'])
        self.assertEqual(commands[5]['arguments'].get('responseRef'),
                         commands[6]['arguments']['afterCommandResponse'])
        # Derive query opportunities from input facts, not relation labels or checks.
        old_hits = [r for r in data['historicalEntries'] if r['invoiceNumber'] == old_invoice['invoiceNumber']]
        new_hits = [r for r in data['historicalEntries'] if r['invoiceNumber'] == correction['fields']['invoiceNumber']]
        self.assertEqual(['prior-object'], [r['businessObjectId'] for r in old_hits])
        self.assertEqual([], new_hits)
        self.assertNotIn('currentQuery', facts)
        self.assertIn('duplicate_query_requests_and_results', scenario['checks'][0]['evidence'])

    def test_byte_duplicate_builds_two_actual_equal_sources_and_acceptances(self):
        scenario = self.by_key['wf-duplicate-byte-identical']
        facts = scenario['initialState']['facts']
        self.assertIn('sourceInputs', facts, 'a relation label cannot create bytes')
        sources = facts['sourceInputs']
        self.assertEqual(2, len(sources))
        self.assertEqual(2, len({s['sourceId'] for s in sources}))
        self.assertEqual(2, len({s['requestId'] for s in sources}))
        self.assertNotIn('inputContentHashRelation', facts)
        # Materialize and reread the authored byte payload independently of oracles.
        with tempfile.TemporaryDirectory() as directory:
            reread = []
            for source in sources:
                path = Path(directory) / source['filename']
                path.write_bytes(source['content'].encode(source['encoding']))
                reread.append(path.read_bytes())
            self.assertEqual(reread[0], reread[1])
            self.assertGreater(len(reread[0]), 30)
            hashes = [hashlib.sha256(raw).hexdigest() for raw in reread]
            self.assertEqual(hashes[0], hashes[1])
            self.assertNotEqual(hashes[0], hashlib.sha256(reread[1] + b' ').hexdigest())
        commands = scenario['steps'][1:-1]
        self.assertEqual(['adapter.create_synthetic_source_bytes', 'adapter.capture_source_bytes',
                          'adapter.accept_declared_source', 'adapter.accept_declared_source',
                          'adapter.check_business_duplicate'], [c['command'] for c in commands])
        self.assertEqual([s['requestId'] for s in sources], [c['arguments']['requestId'] for c in commands[2:4]])
        self.assertEqual([s['sourceId'] for s in sources], [c['arguments']['sourceId'] for c in commands[2:4]])
        digest_check = next(c for c in scenario['checks'] if c['key'] == 'source-byte-sha256s')
        self.assertEqual(hashes, digest_check['value'])
        self.assertIn('input_source_byte_artifacts', digest_check['evidence'])
        self.assertIn('input_acceptance_records', digest_check['evidence'])
        self.assertNotIn('confirmed-business-duplicate', facts)

    def test_wait_answer_evidence_has_content_version_scope_and_sufficient_facts(self):
        scenario = self.by_key['wf-wait-human-no-run']
        facts = scenario['initialState']['facts']
        self.assertIn('evidenceObjects', facts, 'a nonexistent evidenceRef is not a legal completion')
        self.assertIsNone(facts['activeRun'])
        evidence = facts['evidenceObjects'][0]
        body = json.loads(evidence['content'])
        self.assertEqual(body['declaredPageCount'], len(body['pages']))
        invoice_numbers = {page['invoiceNumber'] for page in body['pages']}
        self.assertEqual({'SIM-WAIT-701'}, invoice_numbers)
        self.assertEqual([1, 2], [page['pageNumber'] for page in body['pages']])
        commands = scenario['steps'][1:-1]
        self.assertEqual(['adapter.create_declared_evidence', 'adapter.read_declared_evidence',
                          'adapter.respond_human_interaction'], [c['command'] for c in commands])
        answer = commands[-1]['arguments']
        self.assertEqual(evidence['id'], answer['evidenceRef'])
        self.assertEqual(evidence['version'], answer['evidenceVersion'])
        self.assertEqual(evidence['jobId'], facts['job']['id'])
        self.assertEqual(evidence['workspaceId'], facts['job']['workspaceId'])
        self.assertEqual(evidence['workspaceId'], facts['principal']['workspaceId'])
        self.assertEqual(evidence['documentId'], facts['logicalStep']['inputBasis']['documentId'])
        self.assertEqual(evidence['documentVersion'], facts['logicalStep']['inputBasis']['documentVersion'])
        self.assertIn('inputDocument', facts, 'waiting input identity must refer to declared registered metadata')
        self.assertEqual(evidence['documentId'], facts['inputDocument']['documentId'])
        self.assertEqual(evidence['documentVersion'], facts['inputDocument']['version'])
        self.assertEqual('SIM-WAIT-701', answer['answer']['invoiceNumber'])
        self.assertEqual(2, answer['answer']['pageCount'])
        self.assertEqual(['same-owner-and-current-document-version', 'complete-page-sequence',
                          'one-invoice-number-across-pages', 'human-answer-agrees-with-source'],
                         facts['completionRequirements'])
        self.assertIn('两页', facts['waitingObject']['question'])
        self.assertFalse(any('evidence-valid' in str(c['preconditions']) for c in scenario['checks']))

    def test_reviewed_checks_use_relevant_rule_association_and_quantity_clauses(self):
        expected = {
            ('wf-po-currency', 'accepted-order-count'): '无匹配、多匹配、依据冲突或主数据过期转人工',
            ('wf-po-supplier', 'accepted-order-count'): '无匹配、多匹配、依据冲突或主数据过期转人工',
            ('wf-po-closed', 'accepted-order-count'): '查询权威 ID、唯一性及可选状态',
            ('wf-receipt-unit-mismatch', 'order-unit-factor'): '收货、合同、价格、余额/数量等适用业务核查继续保留',
            ('wf-normal-control', 'arithmetic-status'): '规则分为格式、内部一致、目标字段关联和适用业务核查',
            ('wf-tax-conflict', 'line-tax-status'): '保留不通过依据，按规则修正或进入既有业务处置',
            ('wf-line-identity-conflict', 'line-reference-status'): '无匹配、多匹配、依据冲突或主数据过期转人工',
        }
        for (case, key), quote in expected.items():
            check = next(c for c in self.by_key[case]['checks'] if c['key'] == key)
            self.assertIn(quote, check['sourceRefs'][0]['quote'], (case, key))
        # The two overbroad aliases are removed from all analogous mechanisms.
        for scenario in self.scenarios:
            for check in scenario['checks']:
                quote = check['sourceRefs'][0]['quote']
                self.assertNotEqual('区分票头、明细、附件和主数据字段', quote)
                if '人工点击确认不能直接改成通过' in quote:
                    self.assertEqual('wf-rule-confirm-cannot-waive', scenario['key'])


if __name__ == '__main__':
    unittest.main()
