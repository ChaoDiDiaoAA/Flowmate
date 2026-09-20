"""Fresh episodes bind exact source clauses, meaningful checks and legal controls."""
from copy import deepcopy
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'tools' / 'comprehensive'))


def contracts_and_scenario():
    from rebuild_contracts import parse_document
    from rebuild_bindings import CURRENT_PINS
    text = '## 8. Metrics\n### 8.5 Runtime\n| `MOD-05.parameters` 参数正确率 | P2；F | 参数必须校验。 |\n'
    product = parse_document('product', 'product.md', '## 6. Tools\n执行前检查参数。\n')
    evaluation = parse_document('evaluation', 'evaluation.md', text)
    # The synthetic clauses exercise compilation, while the binding identity is
    # the explicitly registered current spec revision.  Production code still
    # rejects every unregistered byte pin.
    for document, pin in zip((product, evaluation), CURRENT_PINS, strict=True):
        document.update({key: pin[key] for key in ('path', 'bytes', 'sha256')})
    contracts = {'documents': {'product': product, 'evaluation': evaluation}, 'metrics': evaluation['metrics']}
    refs = [{'spec': 'product', 'section': '6', 'quote': '执行前检查参数。'}]
    spec = {'key': 'tool-argument-valid', 'module': 'tools', 'subcapability': 'registry-parameters',
            'stage': 'P2', 'title': '有效参数只执行一次', 'userInput': '读取当前获准文件。',
            'input': {'selectedFile': 'allowed.txt'},
            'initialState': {'workspace': 'test', 'allowedFiles': ['allowed.txt']},
            'steps': [{'id': 'invoke', 'actor': 'product', 'command': 'gateway.invoke', 'arguments': {'path': 'allowed.txt'}}],
            'faults': [], 'expectedOutcome': '返回已授权文件内容，执行记录和调用身份一致。',
            'forbidden': ['读取范围外文件'], 'controlKeys': [], 'relatedModules': [], 'sourceRefs': refs,
            'checks': [{'key': f'check-{key.lower()}', 'description': description, 'metricId': 'MOD-05.parameters',
                        'mode': 'F', 'path': f'observation.tool.{key}', 'op': 'eq', 'value': value,
                        'evidence': ['trusted-gateway-ledger'], 'sourceRefs': refs}
                       for key, description, value in [('handlerCalls', '有效调用到达一次执行器', 1),
                                                       ('returnedContent', '返回实际文件正文', 'file body'),
                                                       ('scopeViolations', '不产生范围外读取', 0)]]}
    return contracts, spec


class FreshCaseTests(unittest.TestCase):
    def test_explicit_author_revision_is_preserved_and_pinned_by_controls(self):
        from rebuild_bindings import CURRENT_BINDING_REVISION
        from rebuild_cases import compile_scenarios
        contracts, scenario = contracts_and_scenario()
        scenario['version'] = 2
        denied = deepcopy(scenario)
        denied.update(key='denied-revised-control', version=1, input={'selectedFile': 'outside'},
                      controlKeys=[scenario['key']])
        cases = compile_scenarios([scenario, denied], contracts)
        expected = 2000 + CURRENT_BINDING_REVISION
        self.assertEqual(cases[0]['version'], expected)
        self.assertEqual(cases[0]['oracle']['version'], expected)
        self.assertEqual(cases[1]['normalControlRefs'][0]['version'], expected)
        for invalid in (True, 0, -1, '2'):
            scenario['version'] = invalid
            with self.assertRaisesRegex(ValueError, 'revision'):
                compile_scenarios([scenario], contracts)

    def test_compilation_preserves_episodes_and_does_not_award_review(self):
        from rebuild_cases import compile_scenarios
        contracts, scenario = contracts_and_scenario()
        case = compile_scenarios([scenario], contracts)[0]
        self.assertEqual(case['id'], 'fresh-tool-argument-valid')
        self.assertEqual(case['harnessModule'], 'tools')
        self.assertEqual(len(case['oracle']['checks']), 3)
        self.assertEqual(case['executionStatus'], 'not_run')
        self.assertFalse(case['humanVerified'])
        self.assertEqual(case['episode']['commands'], scenario['steps'])
        self.assertNotIn('oracle', case['episode']['input'])
        self.assertEqual(case['oracle']['checks'][0]['metricId'], 'MOD-05.parameters')
        self.assertTrue(case['oracle']['checks'][0]['sourceRefs'][0]['quoteSha256'])

    def test_same_input_and_trigger_cannot_be_replicated_with_new_title_and_id(self):
        from rebuild_cases import compile_scenarios
        contracts, scenario = contracts_and_scenario()
        replica = deepcopy(scenario)
        replica.update(key='other-id', title='different title')
        with self.assertRaisesRegex(ValueError, 'semantic duplicate'):
            compile_scenarios([scenario, replica], contracts)

    def test_reject_unknown_metric_source_or_future_control(self):
        from rebuild_cases import compile_scenarios
        contracts, scenario = contracts_and_scenario()
        changed = deepcopy(scenario)
        changed['checks'][0]['metricId'] = 'invented'
        with self.assertRaisesRegex(ValueError, 'metric'):
            compile_scenarios([changed], contracts)
        changed = deepcopy(scenario)
        changed['checks'][0]['sourceRefs'][0]['quote'] = '不存在的规则'
        with self.assertRaises(ValueError):
            compile_scenarios([changed], contracts)
        changed = deepcopy(scenario)
        changed['key'] = 'attack'
        changed['input'] = {'selectedFile': '../outside'}
        changed['controlKeys'] = [scenario['key']]
        scenario['stage'] = 'P3'
        with self.assertRaisesRegex(ValueError, 'later stage'):
            compile_scenarios([scenario, changed], contracts)

    def test_unknown_config_and_answer_projection_rejected(self):
        from rebuild_cases import compile_scenarios
        contracts, scenario = contracts_and_scenario()
        scenario['unhandledConfiguration'] = True
        with self.assertRaisesRegex(ValueError, 'Unknown'):
            compile_scenarios([scenario], contracts)
        del scenario['unhandledConfiguration']
        scenario['input']['oracle'] = {'answer': 1}
        with self.assertRaisesRegex(ValueError, 'quality-side'):
            compile_scenarios([scenario], contracts)

    def test_product_checks_cannot_use_only_metric_text_as_contract(self):
        from rebuild_cases import compile_scenarios
        contracts, scenario = contracts_and_scenario()
        scenario['checks'][0]['sourceRefs'] = [{'spec': 'evaluation', 'section': '8.5', 'quote': '参数必须校验。'}]
        with self.assertRaisesRegex(ValueError, 'product clause'):
            compile_scenarios([scenario], contracts)


if __name__ == '__main__':
    unittest.main()
