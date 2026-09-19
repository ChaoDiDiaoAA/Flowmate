"""Initial dataset contracts keep executable claims and scoring separate."""
from copy import deepcopy
from pathlib import Path
from contextlib import redirect_stdout
import hashlib
import io
import json
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'agent-eval/src'))
sys.path.insert(0, str(ROOT / 'agent-eval/tools'))

from initial_contract import validate_asset
from runner.initial_dataset import materialize_task, grade_observation, assemble_benchmark, main, resolve_asset


def task():
    from rebuild_fixtures import registered_scenarios
    legacy, episode = next((key, value) for key, value in registered_scenarios().items() if 'businessId' not in value)
    return {'schemaVersion': 1, 'kind': 'agent_task', 'id': 'test-task', 'version': 1,
        'title': 'A complete task',
        'classification': {'capabilities': ['tool_use'],
            'taskShape': {'stepStructure': 'multi_step', 'interactionMode': 'single_turn', 'longHorizon': False},
            'difficulty': {'level': 'medium', 'basis': ['multiple steps'], 'status': 'author_estimate'},
            'conditions': [], 'targetFailureModes': [],
            'business': {'domain': 'invoice', 'primaryTaskType': 'extraction', 'relatedTaskTypes': []}},
        'task': {'messages': [{'role': 'user', 'content': episode['userInput']}],
                 'context': deepcopy(episode['input']), 'assetRefs': []},
        'setup': {'protocol': 'declared_episode', 'initialState': deepcopy(episode['initialState']),
                  'commands': deepcopy(episode['steps']), 'faults': deepcopy(episode['faults']),
                  'businessRef': None, 'businessPatches': []},
        'interactions': [],
        'oracle': {'graderRef': 'structured_assertions', 'checks': [{
            'checkId': 'check-1', 'capabilities': ['tool_use'], 'harnessModules': ['tools'],
            'requirementRefs': [], 'evaluationMode': 'A', 'criterion': 'Evidence supports success',
            'assertion': {'path': 'observation.completed', 'op': 'eq', 'value': True},
            'evidenceRequirements': [{'kind': 'actual-result', 'required': True}],
            'required': True, 'hardConstraint': True}]},
        'controlRefs': [], 'comparisonRefs': [],
        'traceability': {'modRefs': [], 'rtRefs': [], 'rtcRefs': [], 'sourceRefs': [],
                         'legacyIds': [legacy], 'harnessModules': [episode['module']]},
        'applicability': {'minimumStage': 'P1', 'adapterRef': None,
                          'executionEligibility': 'blocked', 'blockers': ['product_adapter_required']},
        'split': 'development', 'leakageGroup': 'test-group',
        'lifecycle': {'material': 'candidate', 'review': 'pending'}}


class InitialContractTests(unittest.TestCase):
    def test_accept_valid_task_and_reject_unknown_nested_configuration(self):
        validate_asset(task())
        for path in [(), ('classification',), ('classification', 'taskShape'),
                     ('task',), ('setup',), ('applicability',), ('lifecycle',)]:
            case = task()
            node = case
            for key in path:
                node = node[key]
            node['unknownConfig'] = True
            with self.assertRaises(ValueError, msg=str(path)):
                validate_asset(case)

    def test_unknown_protocol_command_and_initial_state_fail_closed(self):
        for alter in [lambda c: c['setup'].__setitem__('protocol', 'execute_shell'),
                      lambda c: c['setup']['commands'][0].__setitem__('command', 'adapter.unknown'),
                      lambda c: c['setup']['commands'][0]['arguments'].__setitem__('unknownOption', True),
                      lambda c: c['setup']['initialState'].__setitem__('unknownPrivilege', True)]:
            case = task()
            alter(case)
            with self.assertRaises(ValueError):
                validate_asset(case)

    def test_grading_never_enters_input_or_harness(self):
        case = task()
        case['oracle']['goldRef'] = {'root': 'quality', 'path': 'gold/private.json'}
        result = materialize_task(case)
        self.assertEqual('materialized', result['status'])
        self.assertNotIn('goldRef', str(result['fixture']))
        self.assertNotIn('check-1', str(result['fixture']))
        self.assertEqual(case['oracle'], result['grading']['oracle'])
        self.assertEqual('NOT_RUN', result['fixture']['harness']['executionStatus'])
        result['fixture']['input']['context']['modified'] = True
        self.assertNotIn('modified', case['task']['context'])

    def test_scoped_assets_reject_traversal_and_quality_input(self):
        for ref in [{'root': 'project', 'path': '../secret.json'},
                    {'root': 'project', 'path': 'C:\\secret.json'},
                    {'root': 'quality', 'path': 'gold/answer.json'}]:
            case = task()
            case['task']['assetRefs'] = [ref]
            with self.assertRaises(ValueError):
                materialize_task(case)

    def test_missing_evidence_and_selfreported_success_never_product_pass(self):
        for observation in [{}, {'observation': {'completed': True}},
                            {'source': {'kind': 'grader_self_test'}, 'observation': {'completed': True}}]:
            result = grade_observation(task(), observation)
            self.assertEqual('UNJUDGEABLE', result['verdict'])
            self.assertFalse(result['productScoreEligible'])
            self.assertEqual('UNJUDGEABLE', result['checks'][0]['status'])

    def test_controls_cannot_reference_self_or_duplicate(self):
        for refs in [['test-task'], ['control', 'control']]:
            case = task()
            case['controlRefs'] = refs
            with self.assertRaises(ValueError):
                validate_asset(case)

    def test_unknown_nested_check_types_and_taxonomy_fail_closed(self):
        for alter in [lambda c: c['oracle']['checks'][0]['assertion'].__setitem__('execute', True),
                      lambda c: c['oracle']['checks'][0].__setitem__('evaluationMode', 'C'),
                      lambda c: c['applicability'].__setitem__('minimumStage', 'P99'),
                      lambda c: c['classification'].__setitem__('capabilities', ['invented']),
                      lambda c: c['classification'].__setitem__('capabilities', ['delegation'])]:
            case = task()
            alter(case)
            with self.assertRaises(ValueError):
                validate_asset(case)

    def test_non_invoice_project_file_and_tampered_input_pin_are_rejected(self):
        case = task()
        case['task']['assetRefs'] = [{'root': 'project', 'path': 'agent-eval/data/source-labels/a.json'}]
        with self.assertRaises(ValueError):
            validate_asset(case)
        with tempfile.TemporaryDirectory() as temp:
            source = Path(temp) / 'data/invoices/voxel51/one/content.json'
            source.parent.mkdir(parents=True)
            source.write_text('{}', encoding='utf-8')
            with self.assertRaises(ValueError):
                resolve_asset({'root': 'project', 'path': source.relative_to(temp).as_posix(),
                               'sha256': '0' * 64}, temp, None, model_input=True)


class InitialAssemblyTests(unittest.TestCase):
    def snapshot(self, project, later=False):
        quality = project / 'agent-eval/data'
        entries, members, pins = [], [], []
        def write(relative, value):
            raw = json.dumps(value, ensure_ascii=False).encode()
            destination = quality / relative
            destination.parent.mkdir(parents=True, exist_ok=True)
            destination.write_bytes(raw)
            pin = {'path': relative, 'sha256': hashlib.sha256(raw).hexdigest(), 'bytes': len(raw)}
            pins.append(pin)
            return pin
        for identity, dependency in [('test-task', False), ('test-control', True)]:
            case = task()
            case['id'] = identity
            case['controlRefs'] = [] if dependency else ['test-control']
            case['applicability']['minimumStage'] = 'P3' if later and dependency else 'P1'
            pin = write(f'cases/{identity}.json', case)
            entries.append({'id': identity, 'kind': 'agent_task', 'version': 1, **pin})
            members.append({'assetId': identity, 'assetKind': 'agent_task', 'version': 1, **pin,
                'checkIds': ['check-1'], 'guardCheckIds': ['check-1'], 'split': 'development',
                'stage': case['applicability']['minimumStage'], 'subsets': ['capability', 'regression'],
                'dependencyOnly': dependency, 'controlRefs': case['controlRefs']})
        write('manifests/case-catalog.json', {'schemaVersion': 1, 'cases': entries})
        definition = project / 'agent-eval/benchmarks/BM-08/definition.json'
        definition.parent.mkdir(parents=True)
        definition.write_text('{}', encoding='utf-8')
        definition_pin = {'path': definition.relative_to(project).as_posix(), 'bytes': 2,
                          'sha256': hashlib.sha256(b'{}').hexdigest()}
        write('manifests/benchmarks/BM-08/members.json', {'schemaVersion': 1, 'benchmarkId': 'BM-08',
            'members': members, 'definitionPin': definition_pin})
        write('manifests/benchmarks/BM-08/readiness.json', {'benchmarkId': 'BM-08',
              'executionEligibility': 'blocked', 'blockers': ['content_review']})
        inventory = write('manifests/inventory.json', {'files': deepcopy(pins), 'publicFiles': [definition_pin]})
        write('manifests/active-dataset.json', {'format': 'initial-agent-evaluation', 'inventorySha256': inventory['sha256']})

    def test_filter_keeps_required_control_and_later_stage_blocker(self):
        with tempfile.TemporaryDirectory() as temp:
            project = Path(temp)
            self.snapshot(project, later=True)
            result = assemble_benchmark('BM-08', project, stage='P1', capability='tool_use')
            self.assertEqual(['test-task'], result['selectedIds'])
            self.assertEqual(['test-control'], result['dependencyIds'])
            self.assertIn('dependency_requires_later_stage', result['blockers'])
            self.assertIn('content_review', result['blockers'])
            self.assertEqual(0, result['actualProductRuns'])

    def test_export_is_model_only_and_never_overwrites_authoritative_assets(self):
        with tempfile.TemporaryDirectory() as temp:
            project = Path(temp)
            self.snapshot(project)
            destination = project / '.cache/exports/model-inputs.jsonl'
            with redirect_stdout(io.StringIO()):
                main(['BM-08', '--project', str(project), '--output', str(destination)])
            lines = [json.loads(line) for line in destination.read_text(encoding='utf-8').splitlines()]
            self.assertEqual(2, len(lines))
            self.assertTrue(all(set(line) == {'messages', 'context', 'assetRefs'} for line in lines))
            for output in [destination, project / 'agent-eval/data/new.jsonl']:
                with self.assertRaises(ValueError), redirect_stdout(io.StringIO()):
                    main(['BM-08', '--project', str(project), '--output', str(output)])

    def test_manifest_or_definition_drift_fails_before_assembly(self):
        with tempfile.TemporaryDirectory() as temp:
            project = Path(temp)
            self.snapshot(project)
            path = project / 'agent-eval/benchmarks/BM-08/definition.json'
            path.write_text('{"altered":true}', encoding='utf-8')
            with self.assertRaises(ValueError):
                assemble_benchmark('BM-08', project)


if __name__ == '__main__':
    unittest.main()
