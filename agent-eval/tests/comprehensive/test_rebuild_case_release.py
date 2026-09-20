"""Candidate changes preserve source answers and require explicit, hashed history."""
from copy import deepcopy
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'tools' / 'comprehensive'))
from rebuild_dataset import json_bytes, stage_files
from rebuild_cases import compile_scenarios
from test_rebuild_cases import contracts_and_scenario


def asset_snapshot():
    return {'gold/fresh.json': b'{"reviewStatus":"pending"}\n',
            'business/fresh.json': b'{"kind":"independent_fixture"}\n',
            'manifests/source-audit.json': b'{"preserved":true}\n',
            'manifests/selection.json': b'{"status":"provisional"}\n',
            'manifests/preparation-report.json': json_bytes({
                'status': 'construction_candidate_not_published', 'actualProductRuns': 0,
                'baselineCount': 0, 'formalAcceptanceEligible': False,
                'calibrationBatch': {'caseTarget': 60, 'cases': [], 'status': 'incomplete'},
                'remainingWork': ['complete_548_case_designs']})}


class CandidateRevisionTests(unittest.TestCase):
    def test_initial_staging_and_verifier_refuse_interrupted_swap(self):
        from rebuild_dataset import verify_assets
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            parent = root / 'data/.preparation-stage'
            parent.mkdir(parents=True)
            (parent / 'rebuild.pending.json').write_text('{"status":"swap_pending"}')
            for operation in (lambda: stage_files(root, asset_snapshot()), lambda: verify_assets(root)):
                with self.assertRaisesRegex(ValueError, 'Pending'):
                    operation()
            self.assertFalse((parent / 'rebuild').exists())
            (parent / 'rebuild.pending.json').unlink()
            (parent / 'rebuild.lock').write_text('writer')
            with self.assertRaisesRegex(ValueError, 'locked'):
                stage_files(root, asset_snapshot())
            self.assertFalse((parent / 'rebuild').exists())

    def test_revision_archives_exact_previous_tree_and_repeats_without_new_history(self):
        from rebuild_staging import read_candidate, revise_candidate
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            old = asset_snapshot()
            stage_files(root, old)
            new = dict(old, **{'cases/tools/new.json': b'{"id":"new"}'})
            result = revise_candidate(root, old, new)
            archive = root / result['historyPath']
            self.assertEqual(read_candidate(root), new)
            self.assertEqual({p.relative_to(archive).as_posix(): p.read_bytes()
                              for p in archive.rglob('*') if p.is_file()}, old)
            self.assertFalse(revise_candidate(root, new, new)['changed'])
            self.assertEqual(len(list(archive.parent.iterdir())), 1)

    def test_source_edits_concurrent_changes_lock_and_path_escape_are_not_overwritten(self):
        from rebuild_staging import read_candidate, revise_candidate
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            old = asset_snapshot()
            stage_files(root, old)
            new = dict(old, **{'cases/tools/new.json': b'{}'})
            for relative in ['gold/fresh.json', 'business/fresh.json', 'manifests/source-audit.json',
                             'manifests/selection.json']:
                bad = dict(new)
                bad[relative] = b'changed'
                with self.assertRaisesRegex(ValueError, 'preserved'):
                    revise_candidate(root, old, bad)
            with self.assertRaises(ValueError):
                revise_candidate(root, old, dict(new, **{'../outside': b'bad'}))
            lock = root / 'data/.preparation-stage/rebuild.lock'
            lock.write_text('another writer')
            with self.assertRaisesRegex(ValueError, 'locked'):
                revise_candidate(root, old, new)
            self.assertEqual(lock.read_text(), 'another writer')
            lock.unlink()
            changed = root / 'data/.preparation-stage/rebuild/gold/fresh.json'
            changed.write_bytes(b'human edit')
            with self.assertRaisesRegex(ValueError, 'changed'):
                revise_candidate(root, old, new)
            self.assertEqual(read_candidate(root)['gold/fresh.json'], b'human edit')

    def test_failed_install_restores_previous_candidate(self):
        from rebuild_staging import read_candidate, revise_candidate
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            old = asset_snapshot()
            stage_files(root, old)
            new = dict(old, **{'cases/tools/new.json': b'{}'})
            rename = Path.rename
            def fail_install(path, destination):
                if path.name == 'candidate':
                    raise OSError('injected install failure')
                return rename(path, destination)
            with patch.object(Path, 'rename', fail_install):
                with self.assertRaisesRegex(OSError, 'install failure'):
                    revise_candidate(root, old, new)
            self.assertEqual(read_candidate(root), old)
            self.assertFalse((root / 'data/.preparation-stage/rebuild.lock').exists())


class CaseCatalogTests(unittest.TestCase):
    def setUp(self):
        self.contracts, scenario = contracts_and_scenario()
        self.registry = {'fresh-' + scenario['key']: scenario}
        guard = patch('rebuild_fixtures.registered_scenarios', side_effect=lambda: self.registry)
        guard.start()
        self.addCleanup(guard.stop)
        self.cases = compile_scenarios([scenario], self.contracts)

    def test_catalog_resolves_real_files_preserves_assets_and_reports_incomplete_modules(self):
        from rebuild_case_release import assemble_case_files, verify_case_files
        from harness_paths import list_current_case_paths
        old = asset_snapshot()
        outputs = assemble_case_files(old, self.cases, self.contracts)
        for path in ['gold/fresh.json', 'business/fresh.json', 'manifests/source-audit.json']:
            self.assertEqual(outputs[path], old[path])
        report = json.loads(outputs['manifests/preparation-report.json'])
        self.assertEqual(report['casesPreparedInThisStep'], 1)
        self.assertEqual(report['casesMissingFromBudget'], 547)
        self.assertEqual(report['actualProductRuns'], 0)
        self.assertFalse(report['formalAcceptanceEligible'])
        self.assertEqual(report['calibrationBatch']['status'], 'incomplete')
        with tempfile.TemporaryDirectory() as tmp:
            stage_files(tmp, outputs)
            root = Path(tmp) / 'data/.preparation-stage/rebuild'
            self.assertEqual(len(list_current_case_paths(root)), 1)
        self.assertEqual(verify_case_files(outputs, self.contracts)['caseCount'], 1)
        self.assertEqual(assemble_case_files(outputs, self.cases, self.contracts), outputs)

    def test_unreviewed_release_rejects_fake_scores_duplicate_ids_or_changed_same_version(self):
        from rebuild_case_release import assemble_case_files
        old = asset_snapshot()
        with self.assertRaisesRegex(ValueError, 'Duplicate'):
            assemble_case_files(old, self.cases + self.cases, self.contracts)
        for field, value in [('humanVerified', True), ('executionStatus', 'passed'),
                             ('formalAcceptanceEligible', True)]:
            cases = deepcopy(self.cases)
            cases[0][field] = value
            with self.assertRaisesRegex(ValueError, 'construction'):
                assemble_case_files(old, cases, self.contracts)
        first = assemble_case_files(old, self.cases, self.contracts)
        changed = deepcopy(self.cases)
        changed[0]['title'] += 'changed'
        with self.assertRaisesRegex(ValueError, 'revision'):
            assemble_case_files(first, changed, self.contracts)
        with self.assertRaisesRegex(ValueError, 'removed'):
            assemble_case_files(first, [], self.contracts)

    def test_control_digest_and_direct_source_drift_are_rejected(self):
        from rebuild_case_release import assemble_case_files
        contracts, scenario = contracts_and_scenario()
        denied = deepcopy(scenario)
        denied.update(key='denied-input', input={'selectedFile': 'outside'}, controlKeys=[scenario['key']])
        cases = compile_scenarios([scenario, denied], contracts)
        self.registry['fresh-' + denied['key']] = denied
        cases[1]['normalControlRefs'][0]['caseSha256'] = '0' * 64
        with self.assertRaisesRegex(ValueError, 'control'):
            assemble_case_files(asset_snapshot(), cases, contracts)
        cases = deepcopy(self.cases)
        cases[0]['oracle']['checks'][0]['sourceRefs'][0]['quote'] = 'a rule that does not exist'
        with self.assertRaisesRegex(ValueError, 'Source'):
            assemble_case_files(asset_snapshot(), cases, contracts)

    def test_verifier_catches_tampered_catalog_count_and_gold_dependency(self):
        from rebuild_case_release import assemble_case_files, verify_case_files
        outputs = assemble_case_files(asset_snapshot(), self.cases, self.contracts)
        broken = dict(outputs)
        catalog = json.loads(broken['manifests/case-catalog.json'])
        catalog['cases'][0]['path'] = 'cases/tools/not-this-case.json'
        broken['manifests/case-catalog.json'] = json_bytes(catalog)
        with self.assertRaisesRegex(ValueError, 'catalog'):
            verify_case_files(broken, self.contracts)
        cases = deepcopy(self.cases)
        cases[0]['oracle'].update(fieldGoldRef='gold/missing.json', fieldGoldVersion=1,
                                  fieldGoldSha256='0' * 64)
        with self.assertRaisesRegex(ValueError, 'Gold'):
            assemble_case_files(asset_snapshot(), cases, self.contracts)

    def test_case_enumeration_order_is_not_a_revision_and_inventory_drift_is_rejected(self):
        from rebuild_case_release import assemble_case_files, verify_case_files, verify_inventory
        contracts, scenario = contracts_and_scenario()
        another = deepcopy(scenario)
        another.update(key='a-second-task', input={'selectedFile': 'second.txt'})
        cases = compile_scenarios([scenario, another], contracts)
        self.registry['fresh-' + another['key']] = another
        outputs = assemble_case_files(asset_snapshot(), cases, contracts)
        shuffled = dict(reversed(list(outputs.items())))
        self.assertEqual(assemble_case_files(shuffled, list(reversed(cases)), contracts), outputs)
        self.assertEqual(verify_case_files(shuffled, contracts)['caseCount'], 2)
        verify_inventory(shuffled)
        shuffled['gold/fresh.json'] = b'unindexed reviewer change'
        with self.assertRaisesRegex(ValueError, 'inventory drift'):
            verify_inventory(shuffled)

    def test_required_control_cannot_be_removed_and_metric_cannot_replace_product_rule(self):
        from rebuild_case_release import assemble_case_files
        contracts, scenario = contracts_and_scenario()
        denied = deepcopy(scenario)
        denied.update(key='denied-input', input={'selectedFile': 'outside'}, controlKeys=[scenario['key']])
        self.registry['fresh-' + denied['key']] = denied
        cases = compile_scenarios([scenario, denied], contracts)
        cases[1]['normalControlRefs'] = []
        with self.assertRaisesRegex(ValueError, 'authored'):
            assemble_case_files(asset_snapshot(), cases, contracts)
        from rebuild_contracts import resolve_source_ref
        cases = deepcopy(self.cases)
        for check in cases[0]['oracle']['checks']:
            check['sourceRefs'] = [resolve_source_ref(contracts, {
                'spec': 'evaluation', 'section': '8.5', 'quote': '参数必须校验。'})]
        with self.assertRaisesRegex(ValueError, 'product clause'):
            assemble_case_files(asset_snapshot(), cases, contracts)

    def test_explicit_new_author_version_can_replace_hashed_prior_candidate(self):
        from rebuild_case_release import assemble_case_files, verify_case_files
        before = assemble_case_files(asset_snapshot(), self.cases, self.contracts)
        scenario = next(iter(self.registry.values()))
        scenario['version'] = 2
        scenario['title'] += '；修订说明'
        new_cases = compile_scenarios([scenario], self.contracts)
        with self.assertRaisesRegex(ValueError, 'authored'):
            verify_case_files(before, self.contracts)
        self.assertEqual(verify_case_files(before, self.contracts, require_current_authors=False)['caseCount'], 1)
        after = assemble_case_files(before, new_cases, self.contracts)
        self.assertEqual(verify_case_files(after, self.contracts)['caseCount'], 1)

    def test_comparison_closure_is_checked_even_for_historical_authors(self):
        from rebuild_case_release import _validate_cases
        contracts, scenario = contracts_and_scenario()
        peer = deepcopy(scenario)
        peer.update(key='peer-task', initialState={'mode': 'single'})
        scenario['comparisons'] = [{'scenarioKey': peer['key'], 'checkKeys': ['check-handlercalls'],
            'equalInputFields': ['selectedFile'], 'purpose': 'Compare equal tasks'}]
        scenario['steps'].append({'id': 'collect', 'actor': 'controller', 'command': 'adapter.pair',
                                 'arguments': {'otherScenario': peer['key']}})
        cases = compile_scenarios([scenario, peer], contracts)
        _validate_cases(cases, {}, contracts, require_current_authors=False)
        for change in ('hash', 'group', 'check', 'input', 'stage', 'policy'):
            broken = deepcopy(cases)
            ref = broken[0]['comparisonRefs'][0]
            if change == 'hash': ref['caseSha256'] = '0' * 64
            elif change == 'group': broken[1]['leakageGroup'] = 'other-group'
            elif change == 'check': ref['checkIds'] = ['missing-check']
            elif change == 'input': broken[1]['episode']['input']['selectedFile'] = 'different'
            elif change == 'stage': broken[1]['stage'] = 'P13'
            else: ref['peerMustPass'] = True
            with self.assertRaisesRegex(ValueError, 'comparison'):
                _validate_cases(broken, {}, contracts, require_current_authors=False)


if __name__ == '__main__':
    unittest.main()
