"""Independent facility checks. No fixture is a product Trial or human review."""
from collections import Counter
from copy import deepcopy
import importlib.util
import hashlib
import json
from pathlib import Path
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
sys.path[:0] = [str(ROOT / 'agent-eval/tools'), str(ROOT / 'agent-eval/src')]
from rebuild_cases import compile_scenarios
from rebuild_contracts import load_spec_contracts
from graders.observations import grade
from runner.benchmarks import summarize_trials, compare_reports, validate_bundle, canonical_hash
from runner.evidence import load_evidence, is_verified
from contracts import aggregate_checks


def author_module():
    path = ROOT / 'agent-eval/tools/rebuild_scenarios_eval.py'
    assert path.is_file(), 'Independent evaluation infrastructure scenarios are missing'
    spec = importlib.util.spec_from_file_location('fresh_eval_infrastructure', path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def catalog():
    return author_module().build_scenarios()


def envelope(case):
    # These deliberately invented values exercise comparator wiring only.
    # They must never be attached to a real trial or called evidence collection.
    facility = deepcopy(case)
    facility.update(id='grader-eval-mutation', familyId='platform/grader-eval-mutation',
                    category='platform', normalControlRefs=[])
    payload = {}
    for check in facility['oracle']['checks']:
        for assertion in [check['assertion'], *check['preconditions']]:
            payload[assertion['path'].split('.')[1]] = assertion['value']
    return facility, {
        'caseId': facility['id'], 'caseVersion': facility['version'],
        'source': {'kind': 'grader_self_test', 'runId': 'comparator-only',
                   'adapterVersion': 'synthetic-facility-v1'},
        'evidence': [{'kind': kind, 'artifact': 'synthetic/' + kind + '.json', 'sha256': '0' * 64}
                     for kind in facility['oracle']['requiredEvidence']],
        'observation': payload}


def member(cid, **kwargs):
    return {'caseId': cid, 'caseVersion': 1, 'caseSha256': 'a' * 64,
            'semanticScenarioKey': cid, 'split': 'development', **kwargs}


def trial(cid, attempt, status, **kwargs):
    return {'caseId': cid, 'caseVersion': 1, 'attempt': attempt,
            'trialId': cid + '-' + str(attempt), 'status': status, **kwargs}


def temporary_bundle(root):
    """Fresh temporary authored inputs, never repository data or historical Cases."""
    quality = root / 'quality'
    def write(path, value):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(value, ensure_ascii=False), encoding='utf-8')
        return hashlib.sha256(path.read_bytes()).hexdigest()
    cases = compile_scenarios(catalog(), load_spec_contracts(ROOT))
    case = cases[0]
    path = 'cases/eval-infrastructure/' + case['id'] + '.json'
    case_hash = write(quality / path, case)
    definition = {'schemaVersion': 1, 'benchmarkId': 'BM-09', 'status': 'draft'}
    definition_hash = write(root / 'agent-eval/benchmarks/BM-09/definition.json', definition)
    assets = []
    for ref in case['sourceSpecHashes'].values():
        dest = root / ref['path']
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_bytes((ROOT / ref['path']).read_bytes())
        assets.append({'kind': 'spec', 'root': 'project', **ref})
    grader_path = 'agent-eval/src/graders/observations.py'
    dest = root / grader_path
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_bytes((ROOT / grader_path).read_bytes())
    row = {field: deepcopy(case[field]) for field in
           ('stage', 'evaluationMode', 'split', 'semanticScenarioKey', 'sampleId', 'sampleRole', 'leakageGroup')}
    row.update(caseId=case['id'], caseVersion=case['version'], caseSha256=case_hash, casePath=path,
        reason='Independent temporary facility test', requirementRefs=case['sourceRefs'],
        normalControlRefs=[], checkIds=[c['checkId'] for c in case['oracle']['checks']],
        guardCheckIds=[], subsets=['capability', 'regression'], assets=assets,
        oracleRef={'pointer': '/oracle', 'version': case['oracle']['version'],
                   'sha256': canonical_hash(case['oracle'])},
        rubricRef={'pointer': '/oracle/checks', 'version': case['version'],
                   'sha256': canonical_hash(case['oracle']['checks'])},
        graderRefs=[{'path': grader_path, 'version': 2, 'sha256': hashlib.sha256(dest.read_bytes()).hexdigest()}],
        reviewStatus='pending', executionStatus='not_run')
    members = {'schemaVersion': 1, 'benchmarkId': 'BM-09', 'definitionSha256': definition_hash,
               'members': [row]}
    return quality, definition, members, case


class EvalScenariosTests(unittest.TestCase):
    def test_known_path_derives_from_raw_payload_and_rejects_legal_order_wrong_amount(self):
        author = author_module()
        scenario = next(s for s in author.build_scenarios() if s['key'] == 'eval-grade-known-path')
        facts = scenario['initialState']['facts']
        self.assertIn('rawFixture', facts, 'Normal control needs raw returns and final answer, separate from Oracle')
        raw = facts['rawFixture']
        self.assertTrue(callable(getattr(author, 'derive_known_path_observation', None)))
        derived = author.derive_known_path_observation(raw, facts['requiredFacts'])
        self.assertIs(True, derived['known-facts-pass'])
        self.assertIs(True, derived['legal-order-accepted'])
        compiled = {c['id']: c for c in compile_scenarios(catalog(), load_spec_contracts(ROOT))}
        facility, packet = envelope(compiled['fresh-eval-grade-known-path'])
        packet['observation'].update(derived)
        self.assertEqual('pass', grade(facility, packet)['verdict'])
        for target, field, wrong_value in [('return', 'amount', '18.00'), ('answer', 'amount', '18.00'),
                                            ('answer', 'currency', 'USD'), ('return', 'scope', 'other-note')]:
            wrong = deepcopy(raw)
            if target == 'answer':
                wrong['finalAnswer'][field] = wrong_value
            elif field == 'scope':
                wrong['calls'][0]['scope'] = wrong_value
            else:
                next(c for c in wrong['calls'] if field in c['returned'])["returned"][field] = wrong_value
            derived = author.derive_known_path_observation(wrong, facts['requiredFacts'])
            self.assertIs(True, derived['legal-order-accepted'])
            self.assertIs(False, derived['known-facts-pass'])
            packet['observation'].update(derived)
            self.assertEqual('fail', grade(facility, packet)['verdict'])
        absent = deepcopy(raw)
        del next(c for c in absent['calls'] if 'amount' in c['returned'])['returned']['amount']
        derived = author.derive_known_path_observation(absent, facts['requiredFacts'])
        self.assertNotIn('known-facts-pass', derived)
        packet['observation'].pop('known-facts-pass')
        packet['observation'].update(derived)
        self.assertEqual('insufficient_evidence', grade(facility, packet)['verdict'])
        illegal_order = deepcopy(raw)
        illegal_order['eventOrder'] = ['currency-call', 'answer-event', 'amount-call']
        self.assertIs(False, author.derive_known_path_observation(
            illegal_order, facts['requiredFacts'])['legal-order-accepted'])
        no_answer = deepcopy(raw)
        del no_answer['finalAnswer']['currency']
        self.assertNotIn('known-facts-pass', author.derive_known_path_observation(no_answer, facts['requiredFacts']))

    def test_control_closure_declares_and_executes_three_readonly_scoring_packets(self):
        author = author_module()
        scenario = next(s for s in author.build_scenarios() if s['key'] == 'eval-trial-control-closure')
        replays = [s for s in scenario['steps'] if s['command'] == 'adapter.grade_control_closure_replays']
        self.assertEqual(1, len(replays), 'Episode must actually score missing, failed and complete control packets')
        self.assertEqual(['missing', 'synthetic_failed', 'complete'], replays[0]['arguments']['packetOrder'])
        self.assertTrue(callable(getattr(author, 'grade_control_closure_replays', None)))
        cases = {c['id']: c for c in compile_scenarios(catalog(), load_spec_contracts(ROOT))}
        original, control = cases['fresh-eval-grade-missing'], cases['fresh-eval-grade-known-path']
        facility, primary = envelope(original)
        facility['normalControlRefs'] = deepcopy(original['normalControlRefs'])
        _, secondary = envelope(control)
        secondary['caseId'] = control['id']
        secondary['source']['runId'] = 'separate-control-replay'
        secondary['observation']['evaluatedCase'] = deepcopy(control)
        before = deepcopy((primary, secondary))
        replay = author.grade_control_closure_replays(facility, primary, secondary,
                    failure_path='known-facts-pass', failure_value=False)
        self.assertEqual(['insufficient_evidence', 'fail', 'pass'], [r['result']['verdict'] for r in replay])
        self.assertEqual(before, (primary, secondary))
        self.assertNotIn('normalControl', replay[0]['packet'])
        self.assertFalse(replay[1]['packet']['normalControl']['observation']['known-facts-pass'])
        self.assertTrue(replay[2]['packet']['normalControl']['observation']['known-facts-pass'])
        for row in replay:
            self.assertEqual('grader_self_test', row['result']['scope'])
            self.assertFalse(row['result']['formalAcceptanceEligible'])
            self.assertFalse(row['productTrialReset'])
        product_claim = deepcopy(primary)
        product_claim['source']['kind'] = 'product_run'
        with self.assertRaisesRegex(ValueError, 'explicit grader_self_test'):
            author.grade_control_closure_replays(facility, product_claim, secondary,
                failure_path='known-facts-pass', failure_value=False)

    def test_gap_and_model_block_checks_have_direct_supporting_clauses(self):
        cases = {s['key']: s for s in catalog()}
        for scenario_key, check_key, section in [
                ('eval-grade-missing', 'missing-identifies-gap', '7.7'),
                ('eval-grade-modes', 'blocked-request-does-not-erase-a', '3.22.3')]:
            check = next(c for c in cases[scenario_key]['checks'] if c['key'] == check_key)
            self.assertEqual(section, check['sourceRefs'][0]['section'])
        compile_scenarios(catalog(), load_spec_contracts(ROOT))

    def test_authored_episodes_compile_against_current_sources_and_remain_unrun(self):
        scenarios = catalog()
        self.assertEqual({'asset-integrity-and-splits': 8,
                          'trial-scheduling-and-isolation': 8,
                          'grading-and-reporting': 12},
                         dict(Counter(s['subcapability'] for s in scenarios)))
        cases = compile_scenarios(scenarios, load_spec_contracts(ROOT))
        self.assertEqual(28, len({c['semanticScenarioKey'] for c in cases}))
        by_key = {s['key']: s for s in scenarios}
        for source, case in zip(scenarios, cases):
            self.assertGreaterEqual(len(source['checks']), 3)
            self.assertEqual(['F'], case['evaluationModes'])
            self.assertEqual('not_run', case['executionStatus'])
            self.assertFalse(case['humanVerified'])
            self.assertFalse(case['formalAcceptanceEligible'])
            self.assertEqual('grader_self_test', source['initialState']['resultScope'])
            self.assertTrue(source['initialState']['protectedInput'])
            for check in source['checks']:
                self.assertIn('Calculate:', check['description'])
                self.assertTrue(check['implementationSources'])
                self.assertEqual({'observation.fixture-established', 'observation.operation-attempted'},
                                 {g['path'] for g in check['preconditions']})
            for control in source['controlKeys']:
                self.assertTrue(by_key[control]['initialState']['legalControl'])
                self.assertFalse(by_key[control]['faults'])
                self.assertLessEqual(int(by_key[control]['stage'][1:]), int(source['stage'][1:]))

    def test_every_declared_check_rejects_wrong_missing_and_untriggered_observations(self):
        for case in compile_scenarios(catalog(), load_spec_contracts(ROOT)):
            facility, good = envelope(case)
            result = grade(facility, good)
            self.assertEqual('pass', result['verdict'], case['id'])
            self.assertEqual('grader_self_test', result['scope'])
            self.assertFalse(result['formalAcceptanceEligible'])
            for check in facility['oracle']['checks']:
                key = check['assertion']['path'].split('.')[1]
                wrong = deepcopy(good)
                expected = check['assertion']['value']
                wrong['observation'][key] = not expected if isinstance(expected, bool) else expected + 1
                self.assertEqual('fail', grade(facility, wrong)['verdict'], check['checkId'])
                absent = deepcopy(good)
                del absent['observation'][key]
                self.assertEqual('insufficient_evidence', grade(facility, absent)['verdict'])
                for need in check['evidenceRequirements']:
                    absent = deepcopy(good)
                    absent['evidence'] = [r for r in absent['evidence'] if r['kind'] != need['kind']]
                    self.assertEqual('insufficient_evidence', grade(facility, absent)['verdict'])
                for gate in check['preconditions']:
                    for value in (False, None):
                        absent = deepcopy(good)
                        if value is None:
                            del absent['observation'][gate['path'].split('.')[1]]
                        else:
                            absent['observation'][gate['path'].split('.')[1]] = value
                        self.assertEqual('insufficient_evidence', grade(facility, absent)['verdict'])

    def test_untrusted_results_and_no_execution_cannot_become_product_pass(self):
        case = compile_scenarios(catalog(), load_spec_contracts(ROOT))[0]
        facility, observation = envelope(case)
        observation['source']['kind'] = 'product_run'
        result = grade(facility, observation)
        self.assertEqual('infrastructure_error', result['verdict'])
        self.assertEqual('unverified_product_provenance', result['reason'])
        with self.assertRaisesRegex(ValueError, 'not implemented'):
            summarize_trials([member('a')], [trial('a', 1, 'PASS')], k=1)

    def test_fixed_attempt_accounting_retains_first_failure_missing_slots_and_controls(self):
        # Hand-computed: a=[FAIL,PASS], b=[UNJUDGEABLE,NOT_RUN], control=[PASS,PASS].
        report = summarize_trials([member('a'), member('b'), member('control', dependencyOnly=True)],
            [trial('a', 1, 'FAIL'), trial('a', 2, 'PASS'), trial('b', 1, 'UNJUDGEABLE'),
             trial('control', 1, 'PASS'), trial('control', 2, 'PASS')], k=2, facility_selftest=True)
        self.assertEqual(6, report['plannedTrials'])
        self.assertEqual(2, report['scoredCaseCount'])
        self.assertEqual(1, report['controlDependencyCount'])
        self.assertEqual({'PASS': 1, 'FAIL': 1, 'UNJUDGEABLE': 1, 'INFRA_ERROR': 0, 'NOT_RUN': 1},
                         report['scoredCounts'])
        self.assertEqual(0, report['firstPassRate'])
        self.assertEqual(.5, report['passAtK'])
        self.assertEqual(0, report['passAllK'])
        self.assertEqual(0, report['actualProductRuns'])

    def test_zero_denominator_duplicate_delivery_and_conflicting_trial_are_distinct(self):
        empty = summarize_trials([], [], k=2, facility_selftest=True)
        self.assertIsNone(empty['firstPassRate'])
        self.assertIsNone(empty['passAtK'])
        one = trial('a', 1, 'PASS')
        report = summarize_trials([member('a'), member('a')], [one, deepcopy(one)],
                                  k=1, facility_selftest=True)
        self.assertEqual(1, report['plannedTrials'])
        self.assertEqual(1, report['actualTrials'])
        with self.assertRaisesRegex(ValueError, 'conflicting trial'):
            summarize_trials([member('a')], [one, trial('a', 1, 'FAIL')], k=1, facility_selftest=True)
        with self.assertRaisesRegex(ValueError, 'outside predeclared k'):
            summarize_trials([member('a')], [trial('a', 2, 'PASS')], k=1, facility_selftest=True)

    def test_report_comparison_rejects_changed_protocol_and_preserves_added_removed_members(self):
        pins = {'model': 'synthetic-pinned', 'budget': 'fixed', 'environment': 'isolated'}
        baseline = summarize_trials([member('a'), member('removed')], [trial('a', 1, 'PASS')],
                                    k=1, facility_selftest=True, comparison_pins=pins)
        candidate = summarize_trials([member('a'), member('added')], [trial('a', 1, 'FAIL')],
                                     k=1, facility_selftest=True, comparison_pins=pins)
        comparison = compare_reports(baseline, candidate)
        self.assertTrue(comparison['comparable'])
        self.assertEqual(['a'], comparison['passToFail'])
        self.assertEqual(['added'], comparison['addedCaseIds'])
        self.assertEqual(['removed'], comparison['removedCaseIds'])
        candidate['comparisonPins']['budget'] = 'changed'
        comparison = compare_reports(baseline, candidate)
        self.assertFalse(comparison['comparable'])
        self.assertEqual([], comparison['passToFail'])

    def test_contract_mutations_fail_compilation_and_future_runner_is_explicit(self):
        scenarios = catalog()
        by_key = {s['key']: s for s in scenarios}
        for key in ('eval-trial-resume', 'eval-trial-independent-k', 'eval-trial-cancel'):
            self.assertIn('actual_trial_scheduler', by_key[key]['initialState']['missingDependencies'])
        self.assertFalse(by_key['eval-trial-resume']['initialState']['facts']['resetWithinTrial'])
        self.assertTrue(by_key['eval-trial-independent-k']['initialState']['facts']['resetBetweenTrials'])
        scenarios[0]['checks'][0]['sourceRefs'][0]['quote'] = 'fabricated evaluator clause'
        with self.assertRaisesRegex(ValueError, 'Source quote missing'):
            compile_scenarios(scenarios, load_spec_contracts(ROOT))

    def test_real_bundle_validation_detects_byte_drift_split_leakage_and_exposure(self):
        with tempfile.TemporaryDirectory(prefix='eval-facility-') as directory:
            root = Path(directory)
            quality, definition, members, case = temporary_bundle(root)
            initial = validate_bundle(root, quality, definition, members)
            self.assertTrue(initial['valid'], initial['errors'])
            self.assertEqual('blocked', initial['readiness']['status'])
            self.assertIn('real_product_adapter_missing', initial['readiness']['blockers'])
            # Append whitespace: decoded Case unchanged but frozen exact bytes drift.
            original_path = quality / members['members'][0]['casePath']
            original_path.write_bytes(original_path.read_bytes() + b' ')
            drift = validate_bundle(root, quality, definition, members)
            self.assertIn('case_hash_mismatch', {r['code'] for r in drift['errors']})
            # A second source-group member moves to acceptance: independent group audit catches it.
            second = deepcopy(case)
            second.update(id='fresh-independent-synthetic-sibling', split='acceptance', exposedForTuning=True)
            second_path = 'cases/eval-infrastructure/' + second['id'] + '.json'
            raw = json.dumps(second, ensure_ascii=False).encode()
            (quality / second_path).write_bytes(raw)
            row = deepcopy(members['members'][0])
            row.update(caseId=second['id'], casePath=second_path, caseSha256=hashlib.sha256(raw).hexdigest(),
                       split='acceptance', exposedForTuning=True)
            members['members'].append(row)
            result = validate_bundle(root, quality, definition, members)
            codes = {r['code'] for r in result['errors']}
            self.assertIn('split_leakage', codes)
            self.assertIn('acceptance_exposed', codes)

    def test_evidence_loader_checks_real_bytes_identity_and_adapter_attestation(self):
        # Local callback is a deliberately synthetic test boundary, never installed
        # in a public adapter registry and never used to grade a product Case.
        with tempfile.TemporaryDirectory(prefix='eval-evidence-') as directory:
            root = Path(directory)
            value = {'caseId': 'synthetic-evidence-probe', 'caseVersion': 1,
                     'source': {'kind': 'product_run', 'runId': 'synthetic-loader-test-only',
                                'adapterVersion': 'test-local-only'}, 'observation': {'amount': '17.00'}}
            raw = json.dumps(value).encode()
            path = root / 'observation.json'
            path.write_bytes(raw)
            manifest = {k: value[k] for k in ('caseId', 'caseVersion', 'source')}
            manifest.update(observationArtifact='observation.json', evidence=[{
                'kind': 'result', 'artifact': 'observation.json', 'sha256': hashlib.sha256(raw).hexdigest()}])
            with self.assertRaisesRegex(ValueError, 'unregistered trusted adapter'):
                load_evidence(root, manifest, {})
            registry = {'test-local-only': lambda m, a: a['observation.json']['source'] == value['source']}
            verified = load_evidence(root, manifest, registry)
            self.assertTrue(is_verified(verified))
            verified['observation']['amount'] = '99.00'
            self.assertFalse(is_verified(verified))
            path.write_bytes(raw + b' ')
            with self.assertRaisesRegex(ValueError, 'artifact hash mismatch'):
                load_evidence(root, manifest, registry)
            value['caseVersion'] = 2
            raw = json.dumps(value).encode()
            path.write_bytes(raw)
            manifest['evidence'][0]['sha256'] = hashlib.sha256(raw).hexdigest()
            with self.assertRaisesRegex(ValueError, 'identity mismatch'):
                load_evidence(root, manifest, registry)

    def test_independent_literal_grader_oracle_and_hard_failure_priority(self):
        case = {'id': 'grader-independent-literal', 'version': 1, 'category': 'platform',
                'familyId': 'platform/grader-independent-literal', 'oracle': {
                'requiredEvidence': ['raw-source'], 'checks': [
                    {'checkId': 'amount', 'required': True, 'dimension': 'result',
                     'assertion': {'path': 'observation.amount', 'op': 'eq', 'value': '17.00'},
                     'evidenceRequirements': [{'kind': 'raw-source'}]},
                    {'checkId': 'unauthorized', 'required': True, 'hardConstraint': True,
                     'dimension': 'safety', 'assertion': {'path': 'observation.unauthorized', 'op': 'eq', 'value': 0},
                     'evidenceRequirements': [{'kind': 'raw-source'}]}]}}
        observation = {'caseId': case['id'], 'caseVersion': 1,
            'source': {'kind': 'grader_self_test', 'runId': 'independent-standard', 'adapterVersion': 'test-literal'},
            'evidence': [{'kind': 'raw-source', 'artifact': 'synthetic.json', 'sha256': '1' * 64}],
            'observation': {'amount': '17.00', 'unauthorized': 0}}
        self.assertEqual('pass', grade(case, observation)['verdict'])
        observation['observation'] = {'amount': '18.00', 'unauthorized': 0}
        self.assertEqual('fail', grade(case, observation)['verdict'])
        observation['observation'] = {'unauthorized': 1}
        result = grade(case, observation)
        self.assertEqual('fail', result['verdict'])
        self.assertIn('amount', result['unresolvedCheckIds'])
        observation['observation'] = {'unauthorized': 0}
        self.assertEqual('insufficient_evidence', grade(case, observation)['verdict'])
        result = aggregate_checks([{'checkId': 'hard', 'required': True, 'status': 'FAIL'},
                                   {'checkId': 'missing', 'required': True, 'status': 'UNJUDGEABLE'},
                                   {'checkId': 'optional', 'required': False, 'status': 'INFRA_ERROR'}])
        self.assertEqual('FAIL', result['verdict'])
        self.assertEqual(['missing'], result['unresolvedCheckIds'])

    def test_required_control_missing_failed_and_reused_run_cannot_pass(self):
        cases = {c['id']: c for c in compile_scenarios(catalog(), load_spec_contracts(ROOT))}
        original = cases['fresh-eval-grade-missing']
        control = cases['fresh-eval-grade-known-path']
        facility, primary = envelope(original)
        facility['normalControlRefs'] = deepcopy(original['normalControlRefs'])
        self.assertEqual('insufficient_evidence', grade(facility, primary)['verdict'])
        _, secondary = envelope(control)
        secondary['caseId'] = control['id']
        secondary['source']['runId'] = 'independent-control-self-test'
        secondary['observation']['evaluatedCase'] = deepcopy(control)
        primary['normalControl'] = secondary
        self.assertEqual('pass', grade(facility, primary)['verdict'])
        secondary['observation']['known-facts-pass'] = False
        self.assertEqual('fail', grade(facility, primary)['verdict'])
        secondary['observation']['known-facts-pass'] = True
        secondary['source']['runId'] = primary['source']['runId']
        self.assertEqual('infrastructure_error', grade(facility, primary)['verdict'])


if __name__ == '__main__':
    unittest.main()
