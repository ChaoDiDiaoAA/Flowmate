"""The source register locates contracts; it cannot award requirement coverage."""
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'tools'))


class ContractSourceTests(unittest.TestCase):
    def test_sections_do_not_leak_across_levels_or_fences(self):
        from rebuild_contracts import parse_document
        text = '# Doc\n## 3. Requirements\n### 3.24 Storage\nA fact.\n```md\n## 99 Fake\n```\n## 4. New chapter\nNew fact.\n'
        parsed = parse_document('evaluation', 'spec.md', text)
        self.assertEqual([s['id'] for s in parsed['sections']], ['3', '3.24', '4'])
        self.assertNotIn('New fact.', parsed['sections'][1]['text'])
        self.assertEqual(parsed['sections'][2]['text'], 'New fact.')

    def test_metric_definition_id_is_not_a_mention_or_line_number(self):
        from rebuild_contracts import parse_document
        document = '## 8. Metrics\n### 8.5 Runtime\n| `MOD-02.goal` 完成 | P1；F | 公式 |\n| 引用 MOD-02.goal | context |\n'
        one = parse_document('evaluation', 'spec.md', document)
        two = parse_document('evaluation', 'spec.md', '\n\n' + document)
        self.assertEqual(list(one['metrics']), ['MOD-02.goal'])
        self.assertEqual(list(one['metrics']), list(two['metrics']))
        self.assertFalse(one['metrics']['MOD-02.goal']['reviewed'])
        self.assertIn('公式', one['metrics']['MOD-02.goal']['definition'])

    def test_quote_must_match_the_specific_section_not_anywhere_in_spec(self):
        from rebuild_contracts import parse_document, resolve_source_ref
        doc = parse_document('product', 'spec.md', '## 3. One\n批准不是完成。\n## 4. Two\n其他事实。\n')
        contracts = {'documents': {'product': doc}}
        ref = resolve_source_ref(contracts, {'spec': 'product', 'section': '3', 'quote': '批准不是完成。'})
        self.assertEqual(ref['startLine'], 2)
        with self.assertRaises(ValueError):
            resolve_source_ref(contracts, {'spec': 'product', 'section': '4', 'quote': '批准不是完成。'})

    def test_repeated_excerpt_requires_unambiguous_location(self):
        from rebuild_contracts import parse_document, resolve_source_ref
        doc = parse_document('product', 'spec.md', '## 3. One\n相同句子。\n相同句子。\n')
        with self.assertRaisesRegex(ValueError, 'ambiguous'):
            resolve_source_ref({'documents': {'product': doc}},
                               {'spec': 'product', 'section': '3', 'quote': '相同句子。'})


if __name__ == '__main__':
    unittest.main()
