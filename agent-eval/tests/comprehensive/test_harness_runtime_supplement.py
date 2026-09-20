"""Independent checks of RTC supplement preparation, never product verdicts."""
from copy import deepcopy
from pathlib import Path
import re
import sys
import unittest

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / 'agent-eval' / 'tools'))
import harness_runtime_supplement as supplement


def collect():
    cases = []
    def add(group, slug, title, state, commands, checks, **options):
        cases.append({
            'id': group + '-' + slug, 'title': title,
            'initialState': {'conditions': deepcopy(state), 'nativeSetup': {'persistedEntriesProvided': False}},
            'commands': deepcopy(commands),
            'expected': [{'path':'observation.' + row[0], 'value':deepcopy(row[1]),
                          'description':row[2], 'op':row[3] if len(row) == 4 else 'eq'} for row in checks],
            'phase':options['phase'], 'module':options['module'],
            'sourceSection':options['section'], 'sourceAnchor':options['anchor'],
            'input':deepcopy(options['input']), 'refs':options['refs'],
            'normalControlId':options['control'],
            'enabledMode':{'required': options['enabled']},
            'adapterRequirements': {'status':'pending_product_harness_adapter',
                                    'syntheticNativeHistoryAllowed':False}, 'evidence':[],
        })
    supplement.register(add, cases)
    return cases


class HarnessRuntimeSupplementTests(unittest.TestCase):
    def test_gap_set_is_backed_by_direct_checks(self):
        gap_set = {
            'RTC-01-01','RTC-01-02','RTC-02-03','RTC-02-04','RTC-03-01','RTC-03-03',
            'RTC-04-01','RTC-06-03','RTC-06-09','RTC-05-04','RTC-05-05','RTC-14-02',
            'RTC-14-03','RTC-14-04','RTC-07-01','RTC-07-05','RTC-08-01','RTC-08-02',
            'RTC-08-05','RTC-10-01','RTC-10-03','RTC-10-05','RTC-11-02','RTC-11-03',
            'RTC-11-04','RTC-11-05','RTC-12-01','RTC-12-04','RTC-12-05','RTC-13-02',
            'RTC-13-04','RTC-09-02','RTC-09-04','RTC-15-02','RTC-16-02','RTC-16-03',
            'RTC-16-04','RTC-16-05',
        }
        direct = {key for case in collect() for check in case['expected'] for key in check['requirementKeys']}
        reused = {key for keys in supplement.EXISTING_CHECK_LINKS.values() for key in keys}
        self.assertEqual(direct | reused, gap_set)

    def test_anchor_section_and_unique_identifiers(self):
        lines = (ROOT / 'agent-eval/docs/spec/01_Flowmate_Agent评测总方案.md').read_text(encoding='utf-8-sig').splitlines()
        section, indexed = '', []
        for line in lines:
            heading = re.match(r'^#{1,6}\s+(\d+(?:\.\d+)*)\b', line)
            if heading:
                section = heading.group(1)
            indexed.append((section, line))
        cases = collect()
        self.assertEqual(len(cases), len({case['id'] for case in cases}))
        for case in cases:
            with self.subTest(case=case['id']):
                matches = [section for section, line in indexed if case['sourceAnchor'] in line]
                self.assertEqual(matches, [case['sourceSection']])

    def test_rejection_controls_have_compatible_capabilities_and_phase(self):
        cases = collect()
        by_id = {case['id']: case for case in cases}
        by_id['manifest-verified-load'] = {'phase':'P1','enabledMode':{'required':['execution_manifest']}}
        for case in cases:
            if case['normalControlId']:
                with self.subTest(case=case['id']):
                    control = by_id[case['normalControlId']]
                    self.assertLessEqual(int(control['phase'][1:]), int(case['phase'][1:]))
                    self.assertTrue(set(control['enabledMode']['required']) <= set(case['enabledMode']['required']))

    def test_unknown_existing_selector_fails_and_repeat_link_is_idempotent(self):
        cases = []
        for (sid, path), keys in supplement.EXISTING_CHECK_LINKS.items():
            item = next((item for item in cases if item['id'] == sid), None)
            if item is None:
                item = {'id':sid,'refs':[],'expected':[],'requirementKeys':[]}
                cases.append(item)
            item['expected'].append({'path':path,'requirementKeys':[]})
        supplement.apply_existing_links(cases)
        once = deepcopy(cases)
        supplement.apply_existing_links(cases)
        self.assertEqual(cases, once)
        cases[0]['expected'][0]['path'] = 'observation.unrelated'
        with self.assertRaisesRegex(ValueError, 'RTC_LINK_SELECTOR_MISMATCH'):
            supplement.apply_existing_links(cases)

    def test_native_plans_never_claim_generated_history_or_evidence(self):
        for case in collect():
            self.assertEqual(case['adapterRequirements']['status'], 'pending_product_harness_adapter')
            self.assertFalse(case['adapterRequirements']['syntheticNativeHistoryAllowed'])
            self.assertNotIn('expected', case['input'])
            self.assertNotIn('commands', case['input'])
            self.assertNotIn('entries', case['initialState'])
            self.assertNotIn('header', case['initialState'])
            self.assertFalse(case['initialState']['nativeSetup']['persistedEntriesProvided'])

    def test_retries_and_recovery_variants_keep_stage_and_authority_boundaries(self):
        by_id = {case['id']: case for case in collect()}
        readonly = by_id['session-rtc-readonly-retry-owner']
        model = by_id['session-rtc-retry-layer-budget']
        self.assertEqual(readonly['phase'], 'P2')
        self.assertEqual(model['phase'], 'P3')
        self.assertEqual(readonly['initialState']['conditions']['modelRetryLimit'], 0)
        self.assertIn('verified_pi_model_retry', model['enabledMode']['required'])
        copy = by_id['session-rtc-backup-test-copy-isolated']
        original = by_id['session-rtc-migration-failure-original-restore']
        self.assertNotEqual(copy['initialState']['conditions']['restorationKind'],
                            original['initialState']['conditions']['restorationKind'])
        copy_checks = {c['path']: c['value'] for c in copy['expected']}
        self.assertEqual(copy_checks['observation.recovery.inheritedProductionSendPermits'], 0)


if __name__ == '__main__':
    unittest.main()
