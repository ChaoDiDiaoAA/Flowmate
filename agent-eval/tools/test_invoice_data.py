"""Preparation safeguards, not tests of the future product runtime."""
import tempfile
import unittest
from pathlib import Path

from prepare_invoice_data import safe_relative, write_new, decimal_value, group_records


class PreparationSafeguards(unittest.TestCase):
    def test_rejects_escaping_and_absolute_paths(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            for bad in ('../outside.jpg', '/outside.jpg', 'C:/outside.jpg', '..\\outside.jpg'):
                with self.subTest(path=bad), self.assertRaises(ValueError):
                    safe_relative(root, bad)
            self.assertEqual(safe_relative(root, 'assets/images/a.jpg'), root / 'assets/images/a.jpg')

    def test_no_clobber_even_when_bytes_match(self):
        with tempfile.TemporaryDirectory() as folder:
            p = Path(folder) / 'a.json'
            p.write_text('original', encoding='utf-8')
            with self.assertRaises(FileExistsError):
                write_new(p, {'replacement': True})
            self.assertEqual(p.read_text(), 'original')

    def test_duplicate_keeps_all_source_ids(self):
        groups = group_records([{'id': '000002', 'sha256': 'same'},
                                {'id': '000001', 'sha256': 'same'},
                                {'id': '000003', 'sha256': 'other'}])
        self.assertEqual(groups['000001'], ['000001', '000002'])
        self.assertEqual(groups['000003'], ['000003'])

    def test_decimal_does_not_guess_ambiguous_separator(self):
        self.assertEqual(str(decimal_value('42,32')), '42.32')
        self.assertEqual(str(decimal_value('1234.56')), '1234.56')
        for ambiguous in ('1,234', '1.234', '1,234.56', '$ 12.00', '', 'NaN'):
            self.assertIsNone(decimal_value(ambiguous))


if __name__ == '__main__':
    unittest.main()
