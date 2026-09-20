"""Author/Grader facilities only; synthetic probes are never product results."""
from collections import Counter
from copy import deepcopy
from decimal import Decimal
import hashlib
import importlib.util
import json
from pathlib import Path
import sys
import unittest

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / 'agent-eval/tools'))
sys.path.insert(0, str(ROOT / 'agent-eval/src'))
from rebuild_cases import compile_scenarios
from rebuild_contracts import load_spec_contracts
from rebuild_business_projection import authored_business, project_business
from graders.action_semantics import IncompleteActionEvidence, project_submission_chain
from graders.observations import grade


class ActionsAuthorTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.module = importlib.util.find_spec('rebuild_scenarios_actions')
        if cls.module:
            from rebuild_scenarios_actions import build_scenarios
            cls.scenarios = build_scenarios()
            cls.contracts = load_spec_contracts(ROOT)
            cls.cases = compile_scenarios(cls.scenarios, cls.contracts)
            cls.by_key = {s['key']: s for s in cls.scenarios}
            cls.by_case = {c['id'][6:]: c for c in cls.cases}

    def setUp(self):
        self.assertIsNotNone(self.module, 'Actions requires 68 newly authored semantic episodes')

    def check(self, key, check_key):
        return next(c for c in self.by_key[key]['checks'] if c['key'] == check_key)

    def probe(self, key, check_key, actual, missing=False, records=None):
        case = deepcopy(self.by_case[key])
        check = next(c for c in case['oracle']['checks'] if c['checkId'].endswith(':' + check_key))
        case['oracle']['checks'] = [check]
        case['normalControlRefs'] = []
        kinds = [e['kind'] for e in check['evidenceRequirements']]
        case['oracle']['requiredEvidence'] = kinds
        fingerprint = hashlib.sha256(json.dumps(records, sort_keys=True, ensure_ascii=False).encode()).hexdigest() if records is not None else 'a' * 64
        artifact = 'synthetic-raw-fixture.json' if records is not None else 'equality-smoke-placeholder.json'
        envelope = {'caseId': case['id'], 'caseVersion': case['version'],
                    'source': {'kind': 'grader_self_test', 'runId': 'facility-actions', 'adapterVersion': 'facility-only'},
                    'evidence': [] if missing else [{'kind': k, 'artifact': artifact, 'sha256': fingerprint} for k in kinds],
                    'observation': {} if missing == 'observation' else {check_key: actual}}
        if missing == 'observation':
            envelope['evidence'] = [{'kind': k, 'artifact': 'facility.json', 'sha256': 'a' * 64} for k in kinds]
        return grade(case, envelope)

    def record_probe(self, key, check_key, records, projection):
        """Pure fixture projection; no product state machine and no Oracle reads.

        Raw records are deliberately synthetic in-memory facility evidence. Their
        digest identifies this fixture, never a claimed product/native artifact.
        Missing raw columns stay unjudgeable instead of becoming zero/empty.
        """
        try:
            value = projection(records)
        except (KeyError, TypeError, IncompleteActionEvidence):
            return self.probe(key, check_key, None, 'observation', records=records)
        return self.probe(key, check_key, value, records=records)

    def test_budget_and_semantic_substance(self):
        self.assertEqual(68, len(self.scenarios))
        self.assertEqual({'payload-preview': 12, 'approval-validity': 16, 'browser-takeover': 12,
                          'submission-reconciliation': 20, 'workbench-control': 8},
                         dict(Counter(s['subcapability'] for s in self.scenarios)))
        self.assertEqual(68, len({c['semanticScenarioKey'] for c in self.cases}))
        # No titles or prose count as semantic diversity.
        substances = [json.dumps([s['initialState']['facts'], s['steps'][1:-1], s['faults'],
                                  s.get('businessPatches')], sort_keys=True) for s in self.scenarios]
        self.assertEqual(68, len(set(substances)))

    def test_sources_modes_controls_phase_and_dependencies(self):
        assets = authored_business(self.contracts)
        for s, c in zip(self.scenarios, self.cases):
            expected_revision = 2 if s['key'] in {'act-submit-cross-job', 'act-submit-distinct-objects'} else 1
            self.assertEqual(('actions', 'P12', expected_revision), (s['module'], s['stage'], s['version']))
            self.assertRegex(s['userInput'], '[\u4e00-\u9fff]')
            self.assertEqual('not_run', c['executionStatus'])
            self.assertFalse(c['formalAcceptanceEligible'])
            self.assertFalse(c['humanVerified'])
            self.assertIn('actual_product_adapter', s['initialState']['dependencies'])
            self.assertIn('trusted_evidence_collector', s['initialState']['dependencies'])
            for check in s['checks']:
                self.assertFalse(check.get('preconditions'), 'Necessary triggers are scored, never gated by success')
                self.assertEqual(['product', 'evaluation'], [x['spec'] for x in check['sourceRefs']])
                definition = self.contracts['metrics'][check['metricId']]['definition']
                self.assertIn(check['mode'], definition.split('|')[2])
                self.assertIn('identity_join_records', check['evidence'])
                if check['mode'] == 'A':
                    self.assertIn('real_model', s['initialState']['dependencies'])
                    self.assertIn('real_model_input_output_and_result_use', check['evidence'])
            if c.get('businessRef'):
                data = project_business(c['businessRef'], assets[c['businessRef']['id']], c['businessPatches'])
                self.assertFalse(data['actualProductRun'])
            for ref in c['normalControlRefs']:
                control = self.by_case[ref['caseId'][6:]]
                self.assertTrue(control['episode']['initialState']['legalControl'])
                self.assertFalse(control['normalControlRefs'])
                self.assertEqual(c.get('businessRef'), control.get('businessRef'))
            self.assertTrue(s['controlKeys'] or s['initialState']['legalControl'])

    def test_predicate_equality_smoke_only_not_semantic_verification(self):
        # Deliberate interface smoke test only. Independent raw-record probes below
        # establish semantics; copying values here is NOT independent truth.
        for s in self.scenarios:
            for check in s['checks']:
                value = check['value']
                wrong = (not value if type(value) is bool else value + 1 if type(value) is int
                         else value + '-wrong' if isinstance(value, str) else ['wrong'] if isinstance(value, list)
                         else {'wrong': True})
                self.assertEqual('pass', self.probe(s['key'], check['key'], value)['verdict'])
                self.assertEqual('fail', self.probe(s['key'], check['key'], wrong)['verdict'])
                self.assertEqual('insufficient_evidence', self.probe(s['key'], check['key'], value, True)['verdict'])
                self.assertEqual('insufficient_evidence', self.probe(s['key'], check['key'], value, 'observation')['verdict'])
                self.assertFalse(self.probe(s['key'], check['key'], value)['formalAcceptanceEligible'])

    def test_independent_mapping_uses_actual_fresh_business(self):
        assets = authored_business(self.contracts)
        case = self.by_case['act-payload-control']
        data = project_business(case['businessRef'], assets[case['businessRef']['id']], [])['input']
        inv = data['invoice']
        # Independently compute a target representation, not from emitted oracle.
        payload = {'invoice_no': inv['invoiceNumber'], 'currency': inv['currency'],
                   'total_minor': int(Decimal(inv['totalAmount']) * 100),
                   'supplier_id': data['suppliers'][0]['id'],
                   'lines': [{'line_ref': r['lineId'], 'po_line': r['orderLineId'],
                              'quantity': r['quantity'], 'price': r['unitPrice']} for r in inv['lines']]}
        self.assertEqual('pass', self.probe('act-payload-control', 'mapped-fields', payload)['verdict'])
        payload['lines'][0]['po_line'] = 'PO-L-WRONG'
        self.assertEqual('fail', self.probe('act-payload-control', 'mapped-fields', payload)['verdict'])
        attachment = {'artifact': 'source-attachment', 'workspace': 'workspace-actions',
                      'sha256': hashlib.sha256('模拟附件原文'.encode()).hexdigest()}
        self.assertEqual('pass', self.probe('act-payload-control', 'attachment-identity', attachment)['verdict'])
        attachment['sha256'] = hashlib.sha256('同名替换文件'.encode()).hexdigest()
        self.assertEqual('fail', self.probe('act-payload-control', 'attachment-identity', attachment)['verdict'])

    def test_network_requests_are_not_business_effects_across_jobs(self):
        requests = [{'job': 'j1', 'path': 'api', 'logical': 'L'},
                    {'job': 'j2', 'path': 'browser', 'logical': 'L'}]
        ledger = [{'effect': 'effect-1', 'logical': 'L'}]
        effects = Counter(r['logical'] for r in ledger)
        self.assertEqual(2, len(requests))
        self.assertEqual('pass', self.probe('act-submit-safe-retry', 'network-requests', len(requests))['verdict'])
        self.assertEqual('pass', self.probe('act-submit-safe-retry', 'business-effects', effects['L'])['verdict'])
        ledger.append({'effect': 'effect-2', 'logical': 'L'})
        self.assertEqual('fail', self.probe('act-submit-safe-retry', 'business-effects', len(ledger))['verdict'])
        self.assertEqual('insufficient_evidence', self.probe('act-submit-safe-retry', 'business-effects', 0, True)['verdict'])

    def test_success_and_missing_completion_are_separate(self):
        raw = {'receipts': [{'attempt': 'T', 'status': 'SUCCEEDED', 'authority': 'target'}],
               'workflow': {'required': ['submission_receipt', 'authoritative_line_readback']},
               'completedFacts': ['submission_receipt'], 'job': {'state': 'reconciling'}}
        action = 'succeeded' if any(r['status'] == 'SUCCEEDED' and r['authority'] == 'target' for r in raw['receipts']) else 'unknown'
        gaps = sorted(set(raw['workflow']['required']) - set(raw['completedFacts']))
        self.assertEqual('pass', self.probe('act-submit-incomplete', 'action-status', action)['verdict'])
        self.assertEqual('pass', self.probe('act-submit-incomplete', 'completion-gaps', gaps)['verdict'])
        self.assertEqual('pass', self.probe('act-submit-incomplete', 'job-status', raw['job']['state'])['verdict'])
        raw['job']['state'] = 'completed'  # Bad implementation promotes Job on receipt alone.
        self.assertEqual('fail', self.probe('act-submit-incomplete', 'job-status', raw['job']['state'])['verdict'])
        raw['receipts'] = []
        self.assertEqual('insufficient_evidence', self.probe('act-submit-incomplete', 'action-status', None, 'observation')['verdict'])

    def test_evidence_only_change_invalidates_approval_without_revision_change(self):
        key = 'act-approval-evidence-change'
        snapshots = [{'revision': 'rev-1', 'assessment': {'version': 1, 'hash': 'assessment-A'}},
                     {'revision': 'rev-1', 'assessment': {'version': 2, 'hash': 'assessment-B'}}]
        approval = {'decision': 'approved', 'frozenAssessmentHash': 'assessment-A', 'status': 'stale'}
        self.assertEqual('pass', self.probe(key, 'revision-ids', [x['revision'] for x in snapshots])['verdict'])
        self.assertEqual('pass', self.probe(key, 'assessment-versions', [x['assessment']['version'] for x in snapshots])['verdict'])
        self.assertNotEqual(approval['frozenAssessmentHash'], snapshots[-1]['assessment']['hash'])
        self.assertEqual('pass', self.probe(key, 'approval-status', approval['status'])['verdict'])
        self.assertEqual('pass', self.probe(key, 'original-decision', approval['decision'])['verdict'])
        approval['status'] = 'approved'  # Ignores assessment change because revision ID stayed fixed.
        self.assertEqual('fail', self.probe(key, 'approval-status', approval['status'])['verdict'])

    def test_late_success_blocks_unsent_retry_and_preserves_approval(self):
        key = 'act-submit-late-success'
        records = {'attempts': [{'id': 'T1', 'approval': 'approval-1', 'status': 'SUCCEEDED'},
                                {'id': 'T2', 'approval': 'approval-2', 'status': 'BLOCKED'}],
                   'requests': [{'attempt': 'T1'}], 'receipt': {'attempt': 'T1', 'status': 'SUCCEEDED'},
                   'action': {'state': 'succeeded'}}
        for name, value in [('old-attempt-status', records['attempts'][0]['status']),
                            ('new-attempt-status', records['attempts'][1]['status']),
                            ('network-requests', len(records['requests'])), ('action-status', records['action']['state']),
                            ('attempt-approval-ids', [a['approval'] for a in records['attempts']])]:
            self.assertEqual('pass', self.probe(key, name, value)['verdict'])
        records['attempts'][1]['status'] = 'SENDING'
        records['requests'].append({'attempt': 'T2'})
        self.assertEqual('fail', self.probe(key, 'new-attempt-status', records['attempts'][1]['status'])['verdict'])
        self.assertEqual('fail', self.probe(key, 'network-requests', len(records['requests']))['verdict'])
        commands = [x['command'] for x in self.by_key[key]['steps']]
        self.assertLess(commands.index('adapter.prepare_safe_retry'), commands.index('adapter.deliver_old_receipt'))

    def test_same_actor_requires_two_current_qualifications(self):
        key = 'act-approval-same-person'
        grant = {'principal': 'maintainer-1', 'qualification': 'configure_roles', 'subject': 'operator-1',
                 'roles': ['review', 'approve'], 'beforeVersion': 1, 'afterVersion': 2, 'committed': True}
        commands = [{'actor': 'operator-1', 'operation': 'review', 'configurationVersion': 2},
                    {'actor': 'operator-1', 'operation': 'approve', 'configurationVersion': 2}]
        def accepted_operations():
            return [c['operation'] for c in commands if grant['committed'] and grant['qualification'] == 'configure_roles'
                    and c['actor'] == grant['subject'] and c['configurationVersion'] == grant['afterVersion']
                    and c['operation'] in grant['roles']]
        self.assertEqual('pass', self.probe(key, 'review-and-approval-actors', [c['actor'] for c in commands])['verdict'])
        self.assertEqual('pass', self.probe(key, 'qualified-operations', accepted_operations())['verdict'])
        grant_projection = {'principal': grant['principal'], 'configurationVersion': grant['afterVersion'],
                            'subject': grant['subject'], 'granted': grant['roles']}
        self.assertEqual('pass', self.probe(key, 'role-grant-authority', grant_projection)['verdict'])
        grant['qualification'] = 'view'  # Invented maintainer name without maintenance authority.
        self.assertEqual('fail', self.probe(key, 'qualified-operations', accepted_operations())['verdict'])
        grant['qualification'] = 'configure_roles'; grant['roles'] = ['review']
        self.assertEqual('fail', self.probe(key, 'qualified-operations', accepted_operations())['verdict'])

    def test_real_target_is_dependency_blocked_and_no_placeholder_endpoint(self):
        self.assertEqual({'P12-A', 'P12-B', 'P12-C'},
                         {s['initialState']['environment']['eligibility'] for s in self.scenarios})
        scenario = self.by_key['act-browser-real-test']
        env = scenario['initialState']['environment']
        self.assertEqual('P12-C', env['eligibility'])
        self.assertIsNone(env['targetEndpoint'])
        self.assertEqual('dependencies_missing', env['status'])
        self.assertTrue({'authorized_real_target', 'real_target_contract', 'test_credentials'} <=
                        set(scenario['initialState']['dependencies']))
        self.assertEqual('not_run', self.by_case['act-browser-real-test']['executionStatus'])

    def test_independent_identity_target_and_approval_joins(self):
        # Facility input records are separate from authored expectations.
        action = {'id': 'A', 'job': 'J', 'target': 'test-org', 'payload': 'H'}
        approval = {'id': 'P', 'action': 'A'}
        attempt = {'id': 'T', 'action': 'A', 'approval': 'P', 'target': 'test-org', 'payload': 'H'}
        def mismatches():
            return sum([attempt['action'] != action['id'], approval['action'] != action['id'],
                        attempt['approval'] != approval['id'], attempt['target'] != action['target'],
                        attempt['payload'] != action['payload']])
        self.assertEqual('pass', self.probe('act-approval-control', 'identity-join-errors', mismatches())['verdict'])
        for field, value in [('target', 'wrong-org'), ('approval', 'other-approval'), ('payload', 'changed-hash')]:
            previous = attempt[field]
            attempt[field] = value
            self.assertEqual('fail', self.probe('act-approval-control', 'identity-join-errors', mismatches())['verdict'])
            attempt[field] = previous
        approvals = []  # Complete empty authority table: absent approval is a violation, not missing capture.
        self.assertEqual('fail', self.probe('act-approval-control', 'identity-join-errors',
            sum(not any(p['id'] == attempt['approval'] and p['action'] == attempt['action'] for p in approvals)
                for _ in [attempt]))['verdict'])

    def test_retry_revoke_checkpoint_retains_old_unknown(self):
        key = 'act-submit-retry-revoked'
        for name, value in [('after-revoke-action-status', 'unknown'), ('after-revoke-job-status', 'reconciling'),
                            ('after-revoke-old-attempt-status', 'UNKNOWN'), ('new-attempt-status', 'BLOCKED')]:
            self.assertEqual('pass', self.probe(key, name, value)['verdict'])
        for wrong in ['cancelled', 'expired', 'awaiting_confirmation']:
            self.assertEqual('fail', self.probe(key, 'after-revoke-action-status', wrong)['verdict'])
        self.assertEqual('pass', self.probe(key, 'action-status', 'succeeded')['verdict'])

    def test_missing_or_failed_legal_control_cannot_pass_condition(self):
        def envelope(case, run):
            return {'caseId': case['id'], 'caseVersion': case['version'],
                    'source': {'kind': 'grader_self_test', 'runId': run, 'adapterVersion': 'facility'},
                    'evidence': [{'kind': k, 'artifact': 'facility.json', 'sha256': 'b' * 64}
                                 for k in case['oracle']['requiredEvidence']],
                    'observation': {c['assertion']['path'].split('.')[1]: deepcopy(c['assertion']['value'])
                                    for c in case['oracle']['checks']}}
        for case in self.cases:
            if not case['normalControlRefs']:
                continue
            trial = envelope(case, 'condition-facility')
            self.assertEqual('insufficient_evidence', grade(case, trial)['verdict'])
            control = self.by_case[case['normalControlRefs'][0]['caseId'][6:]]
            normal = envelope(control, 'separate-control-facility')
            normal['observation']['evaluatedCase'] = deepcopy(control)
            trial['normalControls'] = [normal]
            self.assertEqual('pass', grade(case, trial)['verdict'])
            normal['observation']['identity-join-errors'] = 1
            self.assertEqual('fail', grade(case, trial)['verdict'])

    def test_faults_and_concurrency_have_scored_trigger_checks(self):
        for s in self.scenarios:
            values = {c['key']: c['value'] for c in s['checks']}
            self.assertTrue(values['command-delivered'])
            if s['faults']:
                self.assertEqual(len(s['faults']), values['observed-fault-count'])
            if s['initialState']['facts'].get('concurrency'):
                self.assertEqual(len(s['initialState']['facts']['concurrency']['workers']), values['barrier-arrivals'])
                self.assertTrue(values['barrier-released'])

    def test_fix1_positive_execution_controls_from_raw_ledgers(self):
        records = {'admissions': [{'attempt': 'T', 'token': 'current'}],
                   'entries': [{'attempt': 'T', 'operation': 'submit'}],
                   'requests': [{'attempt': 'T', 'operation': 'submit', 'job': 'J'}],
                   'effects': [{'logical': 'L', 'operation': 'submit', 'externalId': 'E'}],
                   'receipts': [{'attempt': 'T', 'externalId': 'E', 'status': 'SUCCEEDED'}]}
        for key in ['act-browser-control', 'act-browser-api-control', 'act-browser-mfa', 'act-submit-cross-job']:
            for check, table in [('admitted-submit-count', 'admissions'), ('submit-send-entry-count', 'entries'),
                                 ('submit-request-count', 'requests'), ('submit-effect-count', 'effects'),
                                 ('submit-success-count', 'receipts')]:
                actual = len(records[table])
                self.assertEqual('pass', self.record_probe(key, check, records, lambda r: len(r[table]))['verdict'])
                # Empty *complete* ledger is wrong, distinct from unavailable ledger.
                bad = deepcopy(records); bad[table] = []
                self.assertEqual('fail', self.record_probe(key, check, bad, lambda r: len(r[table]))['verdict'])
                missing = deepcopy(records); del missing[table]
                self.assertEqual('insufficient_evidence', self.record_probe(key, check, missing, lambda r: len(r[table]))['verdict'])
            duplicate = records['requests'] + [{'attempt': 'T', 'operation': 'submit', 'job': 'J2'}]
            self.assertEqual('fail', self.probe(key, 'submit-request-count', len(duplicate))['verdict'])
            self.assertEqual(1, len(records['effects']))  # Target idempotency does not hide product duplicate sends.
            self.assertEqual('pass', self.record_probe(key, 'undeclared-write-request-count', records,
                lambda r: sum(x['operation'] != 'submit' for x in r['requests']))['verdict'])
            extra_write = deepcopy(records); extra_write['requests'].append({'operation': 'upload'})
            self.assertEqual('fail', self.record_probe(key, 'undeclared-write-request-count', extra_write,
                lambda r: sum(x['operation'] != 'submit' for x in r['requests']))['verdict'])
        resume_trace = {'resume': {'at': 5, 'accepted': True}, 'requests': [{'at': 6, 'operation': 'submit'}]}
        after_resume = lambda r: sum(q['at'] > r['resume']['at'] and r['resume']['accepted'] for q in r['requests'])
        self.assertEqual('pass', self.record_probe('act-browser-mfa', 'submit-after-resume-count', resume_trace, after_resume)['verdict'])
        resume_trace['requests'][0]['at'] = 4
        self.assertEqual('fail', self.record_probe('act-browser-mfa', 'submit-after-resume-count', resume_trace, after_resume)['verdict'])

    def test_fix2_distinct_objects_counts_every_job_and_rejects_semantic_false_positives(self):
        """Two legal objects need two complete sends, not merely two target effects.

        The projections deliberately use ledger semantics instead of ``len(table)``:
        denied admissions, rejected send entries, unsent requests and non-authoritative
        receipts must not satisfy a positive execution denominator.
        """
        key = 'act-submit-distinct-objects'
        scope = {
            'jobIds': ['J-A', 'J-B'], 'actionIds': ['A-A', 'A-B'],
            'attemptIds': ['T-A', 'T-B'], 'principalId': 'submissions-service',
            'targetId': 'b2b-sandbox', 'logicalActionKeys': ['invoice-A', 'invoice-B'],
            'windowStart': 10, 'windowEnd': 20, 'declaredWriteOperations': ['submit'],
        }
        records = {
            'admissions': [
                {'jobId': 'J-A', 'actionId': 'A-A', 'attemptId': 'T-A', 'operation': 'submit',
                 'decision': 'admitted', 'tokenStatus': 'current', 'principalId': 'submissions-service',
                 'targetId': 'b2b-sandbox', 'logicalActionKey': 'invoice-A', 'at': 15},
                {'jobId': 'J-B', 'actionId': 'A-B', 'attemptId': 'T-B', 'operation': 'submit',
                 'decision': 'admitted', 'tokenStatus': 'current', 'principalId': 'submissions-service',
                 'targetId': 'b2b-sandbox', 'logicalActionKey': 'invoice-B', 'at': 15},
            ],
            'entries': [
                {'jobId': 'J-A', 'actionId': 'A-A', 'attemptId': 'T-A', 'operation': 'submit',
                 'admission': 'admitted', 'principalId': 'submissions-service', 'targetId': 'b2b-sandbox',
                 'logicalActionKey': 'invoice-A', 'at': 15},
                {'jobId': 'J-B', 'actionId': 'A-B', 'attemptId': 'T-B', 'operation': 'submit',
                 'admission': 'admitted', 'principalId': 'submissions-service', 'targetId': 'b2b-sandbox',
                 'logicalActionKey': 'invoice-B', 'at': 15},
            ],
            'requests': [
                {'jobId': 'J-A', 'actionId': 'A-A', 'attemptId': 'T-A', 'operation': 'submit',
                 'dispatched': True, 'principalId': 'submissions-service', 'targetId': 'b2b-sandbox',
                 'logicalActionKey': 'invoice-A', 'at': 15},
                {'jobId': 'J-B', 'actionId': 'A-B', 'attemptId': 'T-B', 'operation': 'submit',
                 'dispatched': True, 'principalId': 'submissions-service', 'targetId': 'b2b-sandbox',
                 'logicalActionKey': 'invoice-B', 'at': 15},
            ],
            'effects': [
                {'actionId': 'A-A', 'attemptId': 'T-A', 'operation': 'submit', 'status': 'created',
                 'authority': 'target', 'targetId': 'b2b-sandbox', 'logicalActionKey': 'invoice-A',
                 'externalId': 'E-A', 'at': 15},
                {'actionId': 'A-B', 'attemptId': 'T-B', 'operation': 'submit', 'status': 'created',
                 'authority': 'target', 'targetId': 'b2b-sandbox', 'logicalActionKey': 'invoice-B',
                 'externalId': 'E-B', 'at': 15},
            ],
            'receipts': [
                {'actionId': 'A-A', 'attemptId': 'T-A', 'externalId': 'E-A', 'status': 'SUCCEEDED',
                 'authority': 'target', 'targetId': 'b2b-sandbox', 'logicalActionKey': 'invoice-A', 'at': 15},
                {'actionId': 'A-B', 'attemptId': 'T-B', 'externalId': 'E-B', 'status': 'SUCCEEDED',
                 'authority': 'target', 'targetId': 'b2b-sandbox', 'logicalActionKey': 'invoice-B', 'at': 15},
            ],
        }
        projections = {name: (lambda r, name=name: project_submission_chain(r, scope)[name]) for name in [
            'admitted-submit-count', 'submit-send-entry-count', 'submit-request-count',
            'submit-effect-count', 'submit-success-count']}
        for check, projection in projections.items():
            self.assertEqual('pass', self.record_probe(key, check, records, projection)['verdict'])
            missing = deepcopy(records)
            del missing[{'admitted-submit-count': 'admissions', 'submit-send-entry-count': 'entries',
                         'submit-request-count': 'requests', 'submit-effect-count': 'effects',
                         'submit-success-count': 'receipts'}[check]]
            self.assertEqual('insufficient_evidence', self.record_probe(key, check, missing, projection)['verdict'])

        # Three product requests can still yield only two effects through target idempotency.
        duplicate = deepcopy(records)
        duplicate['entries'].append(deepcopy(duplicate['entries'][1]))
        duplicate['requests'].append(deepcopy(duplicate['requests'][1]))
        self.assertEqual('fail', self.record_probe(key, 'submit-send-entry-count', duplicate,
                                                   projections['submit-send-entry-count'])['verdict'])
        self.assertEqual('fail', self.record_probe(key, 'submit-request-count', duplicate,
                                                   projections['submit-request-count'])['verdict'])
        self.assertEqual('pass', self.record_probe(key, 'submit-effect-count', duplicate,
                                                   projections['submit-effect-count'])['verdict'])

        semantic_failures = [
            ('admitted-submit-count', 'admissions', 1, {'decision': 'denied'}),
            ('submit-send-entry-count', 'entries', 1, {'admission': 'rejected'}),
            ('submit-request-count', 'requests', 1, {'dispatched': False}),
            ('submit-effect-count', 'effects', 1, {'status': 'rejected'}),
            ('submit-success-count', 'receipts', 1, {'status': 'REJECTED'}),
            ('submit-success-count', 'receipts', 1, {'authority': 'page_banner'}),
        ]
        for check, table, index, mutation in semantic_failures:
            bad = deepcopy(records)
            bad[table][index].update(mutation)
            self.assertEqual('fail', self.record_probe(key, check, bad, projections[check])['verdict'])

    def test_fix1_second_invoice_material_and_aggregate_receipts(self):
        scenario = self.by_key['act-submit-distinct-objects']
        material = scenario['input']['additionalBusinessInput']
        self.assertEqual({'invoice', 'suppliers', 'purchaseOrders', 'goodsReceipts', 'contracts', 'balances', 'historicalEntries'}, set(material))
        assets = authored_business(self.contracts)
        c = self.by_case['act-submit-distinct-objects']
        first = project_business(c['businessRef'], assets[c['businessRef']['id']], [])['input']
        required, received = Counter(), Counter()
        for data in [first, material]:
            for line in data['invoice']['lines']:
                required[(line['orderId'], line['orderLineId'])] += Decimal(line['quantity']) * Decimal(line['unitsPerInvoiceUnit'])
            for receipt in data['goodsReceipts']:
                if receipt['status'] == 'confirmed':
                    for line in receipt['lines']:
                        received[(receipt['purchaseOrderId'], line['orderLineId'])] += Decimal(line['receivedBaseQuantity'])
            order = data['purchaseOrders'][0]
            self.assertEqual(data['suppliers'][0]['id'], order['supplierId'])
            self.assertEqual(order['id'], data['invoice']['purchaseOrderId'])
            for line in data['invoice']['lines']:
                self.assertEqual(Decimal(line['netAmount']), Decimal(line['quantity']) * Decimal(line['unitPrice']))
                po_line = next(r for r in order['lines'] if r['lineId'] == line['orderLineId'])
                self.assertEqual(line['sku'], po_line['sku'])
                self.assertEqual(Decimal(line['unitPrice']), Decimal(po_line['invoiceUnitPrice']))
            self.assertEqual(Decimal(data['invoice']['totalAmount']),
                             sum(Decimal(r['grossAmount']) for r in data['invoice']['lines']))
        self.assertEqual(2, len(required))
        self.assertTrue(all(received[k] >= qty for k, qty in required.items()))
        self.assertEqual('pass', self.probe('act-submit-distinct-objects', 'insufficient-receipt-lines',
                                          sum(received[k] < qty for k, qty in required.items()))['verdict'])
        received[next(iter(required))] = Decimal('0')
        self.assertEqual('fail', self.probe('act-submit-distinct-objects', 'insufficient-receipt-lines',
                                          sum(received[k] < qty for k, qty in required.items()))['verdict'])

    def test_fix1_command_principals_and_qualified_maintenance(self):
        for scenario in self.scenarios:
            principals = scenario['initialState']['facts']['principals']
            self.assertIn('maintainer-1', principals)
            for step in scenario['steps']:
                invocation = step['arguments']['invocation']
                if invocation['kind'] == 'product_command':
                    principal = principals[invocation['principalId']]
                    self.assertEqual('workspace-actions', principal['workspaceId'])
                    self.assertEqual(1, principal['configurationVersion'])
                    self.assertIn('sessionRef', invocation)
        scenario = self.by_key['act-approval-same-person']
        grant = next(s for s in scenario['steps'] if s['command'] == 'adapter.grant_roles')
        self.assertEqual('maintainer-1', grant['arguments']['invocation']['principalId'])
        self.assertIn('configure_roles', scenario['initialState']['facts']['principals']['maintainer-1']['qualifications'])

    def test_fix1_ui_survival_and_real_control_from_records(self):
        key = 'act-workbench-ui-failure'
        records = {'run': {'status': 'running', 'resource': 'live'}, 'terminals': [],
                   'writeProbe': {'delivered': True, 'denied': True},
                   'controllers': [{'id': 'controller-new', 'principal': 'maintainer-1'}],
                   'query': {'status': 'ok', 'principal': 'maintainer-1'}}
        values = {'after-ui-error-run-status': records['run']['status'],
                  'after-ui-error-resource-state': records['run']['resource'],
                  'ui-caused-run-terminal-count': len(records['terminals']),
                  'post-stop-write-probe-delivered': records['writeProbe']['delivered'],
                  'post-stop-write-probe-denied': records['writeProbe']['denied'],
                  'active-controller-count': len(records['controllers']),
                  'current-controller-principal': records['controllers'][0]['principal'],
                  'authorized-query-status': records['query']['status']}
        for name, value in values.items():
            self.assertEqual('pass', self.probe(key, name, value, records=records)['verdict'])
            self.assertEqual('insufficient_evidence', self.probe(key, name, value, 'observation', records=records)['verdict'])
        records['run']['status'] = 'failed'
        records['terminals'].append({'cause': 'ui_error'})
        self.assertEqual('fail', self.probe(key, 'after-ui-error-run-status', records['run']['status'])['verdict'])
        self.assertEqual('fail', self.probe(key, 'ui-caused-run-terminal-count', len(records['terminals']))['verdict'])
        # These are distinct semantic failures, not random typed value changes.
        records['writeProbe']['delivered'] = False
        records['controllers'].append({'id': 'old-controller', 'principal': 'maintainer-1'})
        records['query']['status'] = 'permission_denied'
        for name, actual in [('post-stop-write-probe-delivered', records['writeProbe']['delivered']),
                             ('active-controller-count', len(records['controllers'])),
                             ('authorized-query-status', records['query']['status'])]:
            self.assertEqual('fail', self.probe(key, name, actual, records=records)['verdict'])

    def test_fix1_full_workbench_facts_are_keyed_by_attempt(self):
        # Authoritative fixture records; projection is constructed independently.
        records = [{'id': 'match-wait', 'state': 'waiting', 'owner': 'reviewer-1', 'reason': 'select_order',
                    'checkpoint': 'checkpoint-2', 'allowed': ['review.select_order'], 'history': ['match-old']},
                   {'id': 'evidence-wait', 'state': 'waiting', 'owner': 'operator-1', 'reason': 'document_gap',
                    'checkpoint': 'checkpoint-3', 'allowed': ['input.attach_evidence'], 'history': []}]
        view = {r['id']: {k: deepcopy(v) for k, v in r.items() if k != 'id'} for r in records}
        self.assertEqual('pass', self.probe('act-workbench-control', 'step-view-facts', view, records=records)['verdict'])
        for field, wrong in [('owner', 'wrong-person'), ('checkpoint', 'old-checkpoint'), ('allowed', ['approve']),
                             ('history', []), ('state', 'completed')]:
            bad = deepcopy(view)
            bad['match-wait'][field] = wrong
            self.assertEqual('fail', self.probe('act-workbench-control', 'step-view-facts', bad)['verdict'])
        raw = {'run': {'status': 'succeeded'}, 'action': {'status': 'unknown'},
               'attempt': {'status': 'UNKNOWN'}, 'job': {'status': 'reconciling'}}
        for entity in ['run', 'action', 'attempt', 'job']:
            self.assertEqual('pass', self.record_probe('act-workbench-unknown', 'view-' + entity + '-status', raw,
                             lambda r: r[entity]['status'])['verdict'])
        raw['action']['status'] = 'succeeded'
        self.assertEqual('fail', self.record_probe('act-workbench-unknown', 'view-action-status', raw,
                         lambda r: r['action']['status'])['verdict'])

    def test_fix1_error_propagation_and_safe_projection(self):
        # Error records here are not imported from the author or copied from its Oracle.
        descriptor = {'schemaVersion': 1, 'errorId': 'ui-query-error-1', 'code': 'ASYNC_QUERY_REJECTED',
                      'category': '外部依赖故障', 'source': ['desktop.query_transport'],
                      'safeMessage': '查询暂时不可用，请使用当前授权入口重查。', 'impactScope': 'call',
                      'recoveryAction': 'retry_read', 'requestId': 'ui-query-1', 'jobId': 'job-1'}
        chain = [dict(descriptor), dict(descriptor)]
        raw = {'application': chain[0], 'ipc': chain[1]}
        self.assertEqual('pass', self.record_probe('act-workbench-ui-failure', 'error-descriptor-chain', raw,
                         lambda r: [r['application'], r['ipc']])['verdict'])
        self.assertEqual('insufficient_evidence', self.record_probe('act-workbench-ui-failure', 'error-descriptor-chain',
                         {'application': chain[0]}, lambda r: [r['application'], r['ipc']])['verdict'])
        for field, value in [('code', 'INTERNAL_ERROR'), ('category', '程序缺陷/不变量破坏'), ('source', []),
                             ('errorId', 'replacement-error'), ('impactScope', 'host'), ('recoveryAction', 'resume_run')]:
            bad = deepcopy(chain); bad[1][field] = value
            self.assertEqual('fail', self.probe('act-workbench-ui-failure', 'error-descriptor-chain', bad)['verdict'])
        bad = deepcopy(chain); del bad[1]['requestId']
        self.assertEqual('fail', self.probe('act-workbench-ui-failure', 'error-descriptor-chain', bad)['verdict'])
        projection = dict(descriptor)
        self.assertEqual('pass', self.probe('act-workbench-ui-failure', 'safe-error-projection', projection)['verdict'])
        for field in ['stack', 'cause', 'rawError', 'authorizationHeader', 'actionId']:
            bad = dict(projection, **{field: 'should-not-cross-boundary'})
            self.assertEqual('fail', self.probe('act-workbench-ui-failure', 'safe-error-projection', bad)['verdict'])

    def test_fix1_lease_trigger_uses_actual_time_records(self):
        record = {'leaseIssued': 0, 'leaseUntil': 60, 'sendTimeoutAt': 30, 'clock': 61,
                  'newClaim': {'owner': 'dispatcher-B', 'accepted': True}, 'resource': 'unconfirmed'}
        values = {'lease-expired-at-reclaim': record['clock'] > record['leaseUntil'],
                  'reclaim-accepted': record['newClaim']['accepted'], 'new-lease-owner': record['newClaim']['owner'],
                  'before-reclaim-attempt-status': 'UNKNOWN' if record['clock'] > record['sendTimeoutAt'] else 'SENDING',
                  'old-resource-state': record['resource']}
        for name, value in values.items():
            self.assertEqual('pass', self.probe('act-submit-lease-expiry', name, value, records=record)['verdict'])
        record['clock'] = 59
        self.assertEqual('fail', self.probe('act-submit-lease-expiry', 'lease-expired-at-reclaim', record['clock'] > record['leaseUntil'])['verdict'])
        timing = self.by_key['act-submit-lease-expiry']['initialState']['facts']['timing']
        self.assertEqual(60, timing['leaseSeconds'])
        self.assertEqual(30, timing['sendTimeoutSeconds'])
        record['newClaim']['accepted'] = False
        self.assertEqual('fail', self.record_probe('act-submit-lease-expiry', 'reclaim-accepted', record,
                         lambda r: r['newClaim']['accepted'])['verdict'])
        missing = deepcopy(record); del missing['leaseUntil']
        self.assertEqual('insufficient_evidence', self.record_probe('act-submit-lease-expiry', 'lease-expired-at-reclaim', missing,
                         lambda r: r['clock'] > r['leaseUntil'])['verdict'])

    def test_fix1_audit_error_and_unknown_query_have_independent_error_records(self):
        descriptor = {'schemaVersion': 1, 'errorId': 'audit-error-1', 'code': 'AUDIT_WRITE_FAILED',
                      'category': '基础设施严重故障', 'source': ['storage.audit'],
                      'safeMessage': '审批预览未保存，请稍后按原请求核对。', 'impactScope': 'job',
                      'recoveryAction': 'none', 'requestId': 'freeze-request-1', 'jobId': 'job-1'}
        raw = {'storage': dict(descriptor), 'command': dict(descriptor),
               'jobTransitions': [], 'ui': dict(descriptor)}
        chain = lambda r: [r['storage'], r['command']]
        self.assertEqual('pass', self.record_probe('act-payload-save-failure', 'error-descriptor-chain', raw, chain)['verdict'])
        bad = deepcopy(raw); bad['command']['errorId'] = 'new-error'
        self.assertEqual('fail', self.record_probe('act-payload-save-failure', 'error-descriptor-chain', bad, chain)['verdict'])
        missing = deepcopy(raw); del missing['command']
        self.assertEqual('insufficient_evidence', self.record_probe('act-payload-save-failure', 'error-descriptor-chain', missing, chain)['verdict'])
        rejected = lambda r: sum(t['state'] == 'rejected' for t in r['jobTransitions'])
        self.assertEqual('pass', self.record_probe('act-payload-save-failure', 'error-caused-job-rejections', raw, rejected)['verdict'])
        bad = deepcopy(raw); bad['jobTransitions'].append({'state': 'rejected', 'cause': 'audit_failed'})
        self.assertEqual('fail', self.record_probe('act-payload-save-failure', 'error-caused-job-rejections', bad, rejected)['verdict'])
        unsafe = lambda r: len(set(r['ui']) & {'stack', 'cause', 'rawError', 'secret', 'unapprovedBusinessText'})
        self.assertEqual('pass', self.record_probe('act-payload-save-failure', 'unsafe-error-field-count', raw, unsafe)['verdict'])
        for field in ['stack', 'cause', 'rawError', 'secret', 'unapprovedBusinessText']:
            bad = deepcopy(raw); bad['ui'][field] = 'diagnostic-canary'
            self.assertEqual('fail', self.record_probe('act-payload-save-failure', 'unsafe-error-field-count', bad, unsafe)['verdict'])
        query_records = {'attempt': {'state': 'UNKNOWN'}, 'query': {'error': 'permission_denied'}, 'authoritativeReceipts': []}
        self.assertEqual('pass', self.record_probe('act-submit-unavailable-query', 'attempt-status', query_records,
                         lambda r: r['attempt']['state'])['verdict'])
        for wrong in ['REJECTED', 'SUCCEEDED']:
            query_records['attempt']['state'] = wrong
            self.assertEqual('fail', self.record_probe('act-submit-unavailable-query', 'attempt-status', query_records,
                             lambda r: r['attempt']['state'])['verdict'])


if __name__ == '__main__':
    unittest.main()
