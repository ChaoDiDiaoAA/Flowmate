"""Every declared legal control is required; one green control cannot mask another."""
from copy import deepcopy
import hashlib
import json
from pathlib import Path
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'agent-eval/src'))
from graders.observations import grade
from runner.evidence import load_evidence, is_verified
from contracts import case_sha256


def assets():
    def case(identity, control=False):
        return {'schemaVersion': 3, 'id': identity, 'version': 1, 'category': 'runtime', 'stage': 'P2',
                'split': 'development', 'controlPairKey': 'controlled-pair',
                'scenarioRole': 'control' if control else 'condition',
                'oracle': {'requiredEvidence': ['ledger'], 'checks': [
                    {'checkId': identity + ':outcome', 'dimension': 'mechanism', 'required': True,
                     'assertion': {'path': 'observation.valid', 'op': 'eq', 'value': True},
                     'evidenceRequirements': [{'kind': 'ledger'}]}]}}
    def observation(c):
        return {'caseId': c['id'], 'caseVersion': 1,
                'source': {'kind': 'grader_self_test', 'runId': c['id'] + '-trial', 'adapterVersion': 'test'},
                'evidence': [{'kind': 'ledger', 'artifact': 'evidence.json', 'sha256': 'f' * 64}],
                'observation': {'valid': True, 'evaluatedCase': deepcopy(c)}}
    primary = case('deny')
    controls = [case('allow-native', True), case('allow-plugin', True)]
    primary['normalControlRefs'] = [{'caseId': c['id'], 'version': 1, 'caseSha256': case_sha256(c)} for c in controls]
    obs = observation(primary)
    return primary, obs, [observation(c) for c in controls]


class ControlClosureTests(unittest.TestCase):
    def test_one_legacy_control_does_not_close_two_dependencies(self):
        case, obs, controls = assets()
        obs['normalControl'] = controls[0]
        result = grade(case, obs)
        self.assertEqual(result['verdict'], 'insufficient_evidence')
        self.assertTrue(any(c.get('controlCaseId') == 'allow-plugin' and c['status'] == 'UNJUDGEABLE'
                            for c in result['checks']))

    def test_all_independent_controls_required_and_each_reported(self):
        case, obs, controls = assets()
        obs['normalControls'] = controls
        result = grade(case, obs)
        self.assertEqual(result['verdict'], 'pass')
        self.assertEqual({c['controlCaseId'] for c in result['checks'] if 'controlCaseId' in c},
                         {'allow-native', 'allow-plugin'})

    def test_failed_control_is_not_hidden_by_missing_other_control(self):
        case, obs, controls = assets()
        controls[0]['observation']['valid'] = False
        obs['normalControls'] = controls[:1]
        self.assertEqual(grade(case, obs)['verdict'], 'fail')

    def test_duplicate_unexpected_and_ambiguous_envelopes_rejected(self):
        for mutation in ('duplicate', 'unexpected', 'both'):
            case, obs, controls = assets()
            obs['normalControls'] = controls
            if mutation == 'duplicate':
                controls.append(deepcopy(controls[0]))
            elif mutation == 'unexpected':
                controls[1]['caseId'] = 'not-in-plan'
            else:
                obs['normalControl'] = controls[0]
            self.assertEqual(grade(case, obs)['verdict'], 'infrastructure_error', mutation)

    def test_wrong_evaluated_identity_or_nested_control_rejected(self):
        for mutation in ('identity', 'nested', 'future', 'pair'):
            case, obs, controls = assets()
            obs['normalControls'] = controls
            actual = controls[1]['observation']['evaluatedCase']
            if mutation == 'identity':
                actual['id'] = 'substitute'
            elif mutation == 'nested':
                actual['normalControlRefs'] = [{'caseId': 'nested', 'version': 1}]
            elif mutation == 'future':
                actual['stage'] = 'P3'
            else:
                actual['controlPairKey'] = 'unrelated'
            self.assertEqual(grade(case, obs)['verdict'], 'infrastructure_error', mutation)

    def test_single_control_legacy_contract_still_works(self):
        case, obs, controls = assets()
        case['normalControlRefs'] = case['normalControlRefs'][:1]
        obs['normalControl'] = controls[0]
        self.assertEqual(grade(case, obs)['verdict'], 'pass')

    def test_failed_control_survives_other_duplicate_envelope(self):
        case, obs, controls = assets()
        controls[0]['observation']['valid'] = False
        controls.append(deepcopy(controls[1]))
        obs['normalControls'] = controls
        result = grade(case, obs)
        self.assertEqual(result['verdict'], 'fail')
        self.assertTrue(any(c['status'] == 'INFRA_ERROR' for c in result['checks']))
        self.assertTrue(any(c.get('controlCaseId') == 'allow-native' and c['status'] == 'FAIL'
                            for c in result['checks']))

    def test_control_oracle_rewrite_or_missing_pin_never_passes(self):
        for mutation in ('rewrite', 'missing-pin'):
            case, obs, controls = assets()
            obs['normalControls'] = controls
            if mutation == 'rewrite':
                controls[0]['observation']['valid'] = False
                controls[0]['observation']['evaluatedCase']['oracle']['checks'][0]['assertion']['value'] = False
            else:
                del case['normalControlRefs'][0]['caseSha256']
            result = grade(case, obs)
            self.assertNotEqual(result['verdict'], 'pass')
            self.assertEqual(result['checks'][1]['reason'], 'control_definition_digest_mismatch'
                             if mutation == 'rewrite' else 'control_definition_digest_not_pinned')

    def test_controls_cannot_reuse_parent_or_each_others_run(self):
        for duplicate_parent in (False, True):
            case, obs, controls = assets()
            obs['normalControls'] = controls
            controls[1]['source']['runId'] = obs['source']['runId'] if duplicate_parent else controls[0]['source']['runId']
            self.assertEqual(grade(case, obs)['verdict'], 'infrastructure_error')

    def test_loader_requires_each_control_sealed_and_parent_covers_control_bytes(self):
        case, obs, controls = assets()
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            def seal(value, suffix, children=None):
                value = deepcopy(value)
                value['source']['kind'] = 'product_run'
                raw = json.dumps(value).encode()
                name = suffix + '.json'
                (root / name).write_bytes(raw)
                manifest = {k: value[k] for k in ('caseId', 'caseVersion', 'source')}
                manifest.update(observationArtifact=name, evidence=[
                    {'kind': 'ledger', 'artifact': name, 'sha256': hashlib.sha256(raw).hexdigest()}])
                if children is not None:
                    manifest['normalControls'] = children
                return load_evidence(root, manifest, {'test': lambda m, d: True})
            sealed = [seal(c, str(i)) for i, c in enumerate(controls)]
            parent = seal(obs, 'parent', sealed)
            self.assertTrue(is_verified(parent))
            self.assertEqual(grade(case, parent)['verdict'], 'pass')
            parent['normalControls'][0]['observation']['valid'] = False
            self.assertFalse(is_verified(parent))
            controls[0]['observation']['valid'] = False
            controls[0]['observation']['evaluatedCase']['oracle']['checks'][0]['assertion']['value'] = False
            rewritten = seal(controls[0], 'rewritten')
            attacked = seal(obs, 'attacked', [rewritten, sealed[1]])
            self.assertTrue(is_verified(attacked))
            self.assertEqual(grade(case, attacked)['verdict'], 'infrastructure_error')
            with self.assertRaisesRegex(ValueError, 'independently verified'):
                seal(obs, 'bad', [dict(sealed[0]), sealed[1]])


if __name__ == '__main__':
    unittest.main()
