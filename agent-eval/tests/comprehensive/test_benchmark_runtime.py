"""Offline Benchmark contracts: real files and explicit facility-only results."""
import copy
import hashlib
import json
from pathlib import Path
import sys
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / 'agent-eval/src'))
try:
    from runner import benchmarks as runtime
except ImportError:
    runtime = None


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(',', ':')).encode()).hexdigest()


class BundleTests(unittest.TestCase):
    def setUp(self):
        self.assertIsNotNone(runtime, 'public Benchmark runtime has not been implemented')
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.project = Path(self.temp.name)
        self.quality = self.project / 'agent-eval/data'
        self.quality.mkdir(parents=True)
        self.definition = {'schemaVersion': 1, 'benchmarkId': 'BM-08', 'version': 1,
            'status': 'draft', 'kind': 'repeatable', 'subsets': {'capability': {}, 'regression': {}},
            'membersRef': 'manifests/benchmarks/BM-08.members.json',
            'executionProtocol': {'k': 2}, 'gradingProtocol': {}, 'comparisonProtocol': {},
            'coverageRequirements': []}
        self.case = {'id': 'attack', 'version': 1, 'stage': 'P0', 'evaluationMode': 'F',
            'split': 'development', 'sampleId': 'sample', 'sampleRole': 'fixture_seed',
            'semanticScenarioKey': 'isolation/path-traversal', 'leakageGroup': 'group',
            'normalControlRefs': [], 'inputAssets': [],
            'category': 'isolation', 'familyId': 'isolation/path-traversal',
            'initialEnvironment': {'scenarioSetup': {'conditions': {}}},
            'oracle': {'version': 1, 'checks': [
                {'checkId': 'result', 'required': True, 'dimension': 'task'},
                {'checkId': 'guard', 'required': True, 'hardConstraint': True, 'dimension': 'platformControl'}]}}
        self.member = self.make_member(self.case)
        self.bundle = {'schemaVersion': 1, 'benchmarkId': 'BM-08',
            'definitionSha256': self.write(self.project, 'agent-eval/benchmarks/BM-08/definition.json', self.definition), 'members': [self.member]}

    def write(self, root, relative, value):
        path = root / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(value, ensure_ascii=False), encoding='utf-8')
        return hashlib.sha256(path.read_bytes()).hexdigest()

    def publish_bundle(self):
        member_sha = self.write(self.quality, self.definition['membersRef'], self.bundle)
        ready_path = 'manifests/benchmarks/BM-08/readiness.json'
        ready_sha = self.write(self.quality, ready_path, {'status': 'blocked'})
        self.write(self.quality, 'manifests/benchmarks/index.json', {
            'sourceCodeRefs': [], 'benchmarks': [{
                'benchmarkId': 'BM-08', 'definitionRef': 'agent-eval/benchmarks/BM-08/definition.json',
                'definitionSha256': self.bundle['definitionSha256'],
                'membersRef': self.definition['membersRef'], 'membersSha256': member_sha,
                'readinessRef': ready_path, 'readinessSha256': ready_sha}]})

    def test_assembly_rejects_members_removed_after_release(self):
        self.publish_bundle()
        self.bundle['members'] = []
        self.write(self.quality, self.definition['membersRef'], self.bundle)
        report = runtime.assemble(self.project, 'BM-08')
        self.assertFalse(report['validation']['valid'])
        self.assertIn('release_reference_invalid', {e['code'] for e in report['validation']['errors']})

    def test_declared_registries_cannot_disappear(self):
        self.bundle.update(splitManifestSha256='0'*64, caseCatalogSha256='0'*64)
        self.assertFalse(self.validate()['valid'])

    def test_case_must_be_current_catalog_member(self):
        self.bundle['caseCatalogSha256'] = self.write(self.quality, 'manifests/case-catalog.json', {'cases': []})
        self.assertIn('case_not_in_catalog', self.codes())

    def make_member(self, case):
        relative = 'cases/isolation/' + case['id'] + '.json'
        case_hash = self.write(self.quality, relative, case)
        grader_hash = self.write(self.project, 'agent-eval/src/graders/test.json', {'version': 2})
        return {**{key: copy.deepcopy(case[key]) for key in ('stage', 'evaluationMode', 'split',
            'sampleId', 'sampleRole', 'semanticScenarioKey', 'leakageGroup', 'normalControlRefs')},
            'caseId': case['id'], 'caseVersion': case['version'], 'casePath': relative,
            'caseSha256': case_hash, 'checkIds': ['result'], 'guardCheckIds': ['guard'],
            'requirementRefs': ['SEC-01'], 'reason': 'Required isolation coverage',
            'subsets': ['capability', 'regression'], 'assets': [],
            'oracleRef': {'pointer': '/oracle', 'sha256': digest(case['oracle']), 'version': 1},
            'rubricRef': {'pointer': '/oracle/checks', 'sha256': digest(case['oracle']['checks']), 'version': 1},
            'graderRefs': [{'path': 'agent-eval/src/graders/test.json', 'sha256': grader_hash, 'contractVersion': 2}],
            'materialStatus': 'structure_checked', 'reviewStatus': 'pending', 'executionStatus': 'not_run'}

    def validate(self):
        return runtime.validate_bundle(self.project, self.quality, self.definition, self.bundle)

    def codes(self):
        return {x['code'] for x in self.validate()['errors']}

    def test_valid_candidate_never_claims_execution_readiness(self):
        report = self.validate()
        self.assertTrue(report['valid'], report['errors'])
        self.assertEqual(report['memberCount'], 1)
        self.assertEqual(report['readiness']['status'], 'blocked')
        self.assertIn('real_product_adapter_missing', report['readiness']['blockers'])
        self.assertIn('trusted_evidence_adapter_missing', report['readiness']['blockers'])

    def test_rejects_duplicate_member_and_definition_drift(self):
        self.bundle['members'].append(copy.deepcopy(self.member))
        self.definition['version'] = 2
        self.assertTrue({'duplicate_member', 'definition_hash_mismatch'} <= self.codes())

    def test_rejects_escape_and_case_hash_drift(self):
        self.member['casePath'] = '../outside.json'
        self.assertIn('case_reference_invalid', self.codes())
        self.member['casePath'] = 'cases/isolation/attack.json'
        self.member['caseSha256'] = '0' * 64
        self.assertIn('case_hash_mismatch', self.codes())

    def test_guards_cannot_be_dropped_and_unknown_checks_rejected(self):
        self.member['guardCheckIds'] = []
        self.member['checkIds'].append('invented')
        self.assertTrue({'required_guard_missing', 'unknown_check'} <= self.codes())

    def test_oracle_and_grader_hash_drift_rejected(self):
        self.member['oracleRef']['sha256'] = '0' * 64
        self.member['graderRefs'][0]['sha256'] = '0' * 64
        self.assertTrue({'oracle_reference_invalid', 'grader_reference_invalid'} <= self.codes())

    def test_input_asset_must_be_pinned(self):
        self.case['inputAssets'] = [{'root': 'quality', 'path': 'inputs/secret.json'}]
        self.bundle['members'] = [self.make_member(self.case)]
        self.assertIn('input_asset_unpinned', self.codes())

    def test_controls_must_be_closed_and_same_split_and_phase(self):
        self.case['normalControlRefs'] = [{'caseId': 'control', 'version': 1}]
        self.member = self.make_member(self.case)
        self.bundle['members'] = [self.member]
        self.assertIn('control_missing', self.codes())
        control = copy.deepcopy(self.case)
        control.update(id='control', normalControlRefs=[], split='regression', stage='P1', scenarioRole='control')
        self.bundle['members'].append(self.make_member(control))
        self.assertTrue({'control_split_mismatch', 'control_stage_mismatch', 'split_leakage'} <= self.codes())

    def test_acceptance_candidate_is_blocked_and_exposed_acceptance_invalid(self):
        self.case['split'] = 'acceptance'
        self.bundle['members'] = [self.make_member(self.case)]
        self.assertIn('acceptance_not_frozen', self.validate()['readiness']['blockers'])
        self.bundle['members'][0]['exposedForTuning'] = True
        self.assertIn('acceptance_exposed', self.codes())

    def test_retired_identity_and_observational_replay_rejected(self):
        self.definition['benchmarkId'] = self.bundle['benchmarkId'] = 'BM-06'
        self.bundle['definitionSha256'] = self.write(self.project, 'agent-eval/benchmarks/' + self.definition['benchmarkId'] + '/definition.json', self.definition)
        self.assertIn('retired_benchmark', self.codes())
        self.definition['benchmarkId'] = self.bundle['benchmarkId'] = 'BM-10'
        self.bundle['definitionSha256'] = self.write(self.project, 'agent-eval/benchmarks/' + self.definition['benchmarkId'] + '/definition.json', self.definition)
        self.assertIn('observational_protocol_required', self.codes())

    def test_control_must_be_declared_independent_normal_and_match_pair(self):
        self.case.update(normalControlRefs=[{'caseId': 'control', 'version': 1}], controlPairKey='pair')
        control = copy.deepcopy(self.case)
        control.update(id='control', normalControlRefs=[], scenarioRole='attack', controlPairKey='other')
        self.bundle['members'] = [self.make_member(self.case), self.make_member(control)]
        self.assertIn('control_not_independent', self.codes())
        self.assertIn('control_pair_mismatch', self.codes())

    def test_earlier_control_stage_is_valid_but_remains_selected_dependency(self):
        self.case.update(stage='P2', normalControlRefs=[{'caseId': 'control', 'version': 1}])
        control = copy.deepcopy(self.case)
        control.update(id='control', stage='P0', normalControlRefs=[], scenarioRole='control')
        self.bundle['members'] = [self.make_member(self.case), self.make_member(control)]
        self.assertTrue(self.validate()['valid'], self.validate()['errors'])
        self.publish_bundle()
        report = runtime.assemble(self.project, 'BM-08', stage='P2')
        self.assertEqual(report['plannedCount'], 2)
        self.assertEqual({m['caseId'] for m in report['members']}, {'attack', 'control'})

    def test_stage_selects_enabled_earlier_cases_without_future_cases(self):
        later = copy.deepcopy(self.case)
        later.update(id='later', stage='P13')
        self.bundle['members'].append(self.make_member(later))
        self.publish_bundle()
        report = runtime.assemble(self.project, 'BM-08', stage='P12-A')
        self.assertEqual([m['caseId'] for m in report['members']], ['attack'])

    def test_source_specs_and_dependencies_cannot_disappear(self):
        self.case['sourceSpecHashes'] = {'spec': {'path': 'spec.md', 'sha256': 'old'}}
        self.bundle['members'] = [self.make_member(self.case)]
        self.assertIn('input_asset_unpinned', self.codes())

    def test_split_registry_pin_and_exposure_are_checked(self):
        split = {'samples': [{'sampleId': 'sample', 'split': 'development', 'leakageGroup': 'group'}]}
        self.bundle['splitManifestSha256'] = self.write(self.quality, 'manifests/splits.json', split)
        self.assertTrue(self.validate()['valid'])
        split['samples'][0]['split'] = 'acceptance'
        self.write(self.quality, 'manifests/splits.json', split)
        self.assertIn('split_manifest_hash_mismatch', self.codes())

    def test_observational_protocol_cannot_authorize_replaying_business(self):
        self.definition.update(benchmarkId='BM-10', kind='observational')
        self.bundle['benchmarkId'] = 'BM-10'
        self.definition['observationProtocol'] = {'productionWritesAllowed': True,
            'repeatBusinessForComparison': True, 'requiredSchema': {}, 'frozenConfig': {}}
        self.bundle['definitionSha256'] = self.write(self.project,
            'agent-eval/benchmarks/BM-10/definition.json', self.definition)
        self.assertIn('observational_replay_forbidden', self.codes())
        self.assertIn('observational_protocol_incomplete', self.codes())

    def test_assembly_rejects_transitive_runtime_code_drift(self):
        self.publish_bundle()
        self.write(self.quality, 'manifests/benchmarks/index.json', {'sourceCodeRefs': [
            {'path': 'agent-eval/src/graders/test.json', 'sha256': '0' * 64}]})
        report = runtime.assemble(self.project, 'BM-08')
        self.assertFalse(report['validation']['valid'])
        self.assertIn('runtime_source_reference_invalid', {e['code'] for e in report['validation']['errors']})
        self.assertEqual(report['materializedCount'], 0)

    def test_current_reviewed_gold_and_pending_grader_are_reported_independently(self):
        self.case['oracle']['fieldGoldRef'] = 'gold/sample.json'
        self.case['scoring'] = {'fieldAnswersUsable': False, 'blockedUntil': ['human_gold_review']}
        self.bundle['members'] = [self.make_member(self.case)]
        gold = {'version': 3, 'humanVerified': True, 'reviewStatus': 'accepted'}
        gold_hash = self.write(self.quality, 'gold/sample.json', gold)
        self.bundle['members'][0]['assets'] = [{'root': 'quality', 'path': 'gold/sample.json',
            'sha256': gold_hash, 'kind': 'gold', 'version': 3}]
        self.bundle['members'][0]['graderBinding'] = {'implementationStatus': 'pending'}
        self.assertTrue(self.validate()['valid'])
        blockers = self.validate()['readiness']['blockers']
        self.assertNotIn('gold_review_pending', blockers)
        self.assertIn('grader_implementation_pending', blockers)
        gold['humanVerified'] = False
        self.bundle['members'][0]['assets'][0]['sha256'] = self.write(self.quality, 'gold/sample.json', gold)
        self.assertIn('gold_review_pending', self.validate()['readiness']['blockers'])

    def test_unresolved_dependencies_are_preserved_in_assembly(self):
        self.case['dependencies'] = ['actual_sdk_entry', 'trusted_tool_gateway']
        self.bundle['members'] = [self.make_member(self.case)]
        self.publish_bundle()
        row = runtime.assemble(self.project, 'BM-08')['members'][0]
        self.assertIn('dependency_unresolved:actual_sdk_entry', row['blockers'])
        self.assertIn('dependency_unresolved:trusted_tool_gateway', row['blockers'])

    def test_malformed_assets_fail_closed_without_crashing(self):
        self.member['assets'] = [None]
        self.assertIn('asset_reference_invalid', self.codes())

    def test_direct_cli_reads_plan_and_preserves_data_bytes(self):
        self.publish_bundle()
        before = {str(p): p.read_bytes() for p in self.project.rglob('*') if p.is_file()}
        result = subprocess.run([sys.executable, str(ROOT / 'agent-eval/src/runner/benchmarks.py'),
            'BM-08', '--project', str(self.project), '--stage', 'P0'], capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        report = json.loads(result.stdout)
        self.assertEqual(report['plannedCount'], 1)
        self.assertEqual(report['actualProductRuns'], 0)
        self.assertEqual(before, {str(p): p.read_bytes() for p in self.project.rglob('*') if p.is_file()})

    def test_assemble_rejects_unknown_configuration_and_keeps_blocked_members(self):
        self.write(self.project, 'agent-eval/benchmarks/BM-08/definition.json', self.definition)
        self.publish_bundle()
        with self.assertRaisesRegex(ValueError, 'unknown'):
            runtime.assemble(self.project, 'BM-08', profile={'invented': True})
        with self.assertRaisesRegex(ValueError, 'stage'):
            runtime.assemble(self.project, 'BM-08', stage='P99')
        report = runtime.assemble(self.project, 'BM-08', stage='P0')
        self.assertEqual((report['plannedCount'], report['blockedCount'], report['actualProductRuns']), (1, 1, 0))
        self.assertEqual(report['members'][0]['status'], 'blocked')
        self.assertNotIn('oracle', report['members'][0]['fixture']['input'])
        self.assertEqual(report['members'][0]['grading']['guardCheckIds'], ['guard'])


class ReportTests(unittest.TestCase):
    def setUp(self):
        self.assertIsNotNone(runtime, 'public Benchmark runtime has not been implemented')
        self.members = [dict(caseId='a', caseVersion=1, caseSha256='a', semanticScenarioKey='scene', sampleId='s',
                             oracleRef={'sha256': 'o'}, rubricRef={'sha256': 'r'}, graderRefs=[{'sha256': 'g'}]),
                        dict(caseId='b', caseVersion=1, caseSha256='b', semanticScenarioKey='scene', sampleId='s',
                             oracleRef={'sha256': 'o'}, rubricRef={'sha256': 'r'}, graderRefs=[{'sha256': 'g'}])]
        self.trials = [dict(caseId='a', caseVersion=1, trialId='a1', attempt=1, status='FAIL'),
                       dict(caseId='a', caseVersion=1, trialId='a2', attempt=2, status='PASS'),
                       dict(caseId='b', caseVersion=1, trialId='b1', attempt=1, status='UNJUDGEABLE')]

    def summary(self, members=None, trials=None, **kwargs):
        return runtime.summarize_trials(self.members if members is None else members,
            self.trials if trials is None else trials, k=2, facility_selftest=True, **kwargs)

    def test_arbitrary_pass_dict_cannot_be_product_result(self):
        with self.assertRaisesRegex(ValueError, 'adapter'):
            runtime.summarize_trials(self.members, self.trials, k=2)

    def test_dependency_controls_have_separate_denominator_and_comparison_role(self):
        members = copy.deepcopy(self.members)
        members[1].update(dependencyOnly=True, controlFor=['a'])
        trials = [dict(self.trials[0], status='FAIL'),
                  dict(caseId='b', caseVersion=1, trialId='b1', attempt=1, status='PASS')]
        report = self.summary(members, trials)
        self.assertEqual(report['scoredCaseCount'], 1)
        self.assertEqual(report['controlDependencyCount'], 1)
        self.assertEqual(report['firstPassRate'], 0)
        self.assertEqual(report['controlCounts']['PASS'], 1)
        altered = copy.deepcopy(members)
        altered[1]['dependencyOnly'] = False
        left = self.summary(members, trials, comparison_pins={'budget': 2})
        right = self.summary(altered, trials, comparison_pins={'budget': 2})
        self.assertIn('b', runtime.compare_reports(left, right)['changedCaseIds'])

    def test_dedupes_shared_trials_without_hiding_missing_or_failed_attempts(self):
        report = self.summary(self.members + self.members[:1], self.trials + self.trials[:1])
        self.assertEqual(report['plannedTrials'], 4)
        self.assertEqual(report['actualTrials'], 3)
        self.assertEqual(report['counts'], {'PASS': 1, 'FAIL': 1, 'UNJUDGEABLE': 1, 'INFRA_ERROR': 0, 'NOT_RUN': 1})
        self.assertEqual(report['uniqueSemanticScenarios'], 1)
        self.assertEqual(report['uniqueSamples'], 1)
        self.assertEqual(report['firstPassRate'], 0)
        self.assertEqual(report['passAtK'], .5)
        self.assertEqual(report['passAllK'], 0)
        self.assertFalse(report['formalAcceptanceEligible'])
        self.assertEqual(report['actualProductRuns'], 0)

    def test_conflicting_trial_or_unplanned_attempt_rejected(self):
        with self.assertRaisesRegex(ValueError, 'conflicting'):
            self.summary(trials=self.trials + [{**self.trials[0], 'status': 'PASS'}])
        with self.assertRaisesRegex(ValueError, 'attempt'):
            self.summary(trials=[{**self.trials[0], 'attempt': 3}])

    def test_infrastructure_errors_and_explicit_not_run_keep_denominator(self):
        report = self.summary(trials=[dict(self.trials[0], status='INFRA_ERROR'),
            dict(self.trials[1], status='NOT_RUN')])
        self.assertEqual(report['counts']['INFRA_ERROR'], 1)
        self.assertEqual(report['counts']['NOT_RUN'], 3)
        self.assertEqual(report['actualTrials'], 1)
        self.assertEqual(report['plannedTrials'], 4)
        self.assertEqual(report['passAtK'], 0)

    def test_changed_predicates_are_not_compared_as_improvement(self):
        left = self.summary(comparison_pins={'environment': 'one'})
        members = copy.deepcopy(self.members)
        members[0]['oracleRef']['sha256'] = 'changed'
        right = self.summary(members, comparison_pins={'environment': 'one'})
        compared = runtime.compare_reports(left, right)
        self.assertFalse(compared['comparable'])
        self.assertEqual(compared['changedCaseIds'], ['a'])
        self.assertEqual(compared['passToFail'], [])
        self.assertEqual(compared['failToPass'], [])

    def test_duplicate_members_cannot_replace_semantic_identity(self):
        duplicate = dict(self.members[0], semanticScenarioKey='other')
        with self.assertRaisesRegex(ValueError, 'conflicting'):
            self.summary(self.members + [duplicate])

    def test_comparison_separates_common_pins_and_membership_changes(self):
        old = self.summary(comparison_pins={'environment': 'one', 'budget': 10})
        new = self.summary(self.members[:1], [dict(self.trials[0], status='PASS')], comparison_pins={'environment': 'one', 'budget': 10})
        compared = runtime.compare_reports(old, new)
        self.assertTrue(compared['comparable'])
        self.assertEqual(compared['removedCaseIds'], ['b'])
        self.assertEqual(compared['failToPass'], ['a'])
        new['comparisonPins']['budget'] = 20
        self.assertFalse(runtime.compare_reports(old, new)['comparable'])


if __name__ == '__main__':
    unittest.main()
