"""Regression checks for identity preservation, ownership and honest coverage."""
import copy
import json
from pathlib import Path
import sys
import tempfile
import hashlib
import zipfile
import unittest

ROOT=Path(__file__).resolve().parents[3]
sys.path.insert(0,str(ROOT/'agent-eval/tools'))
sys.path.insert(0,str(ROOT/'agent-eval/src'))
from harness_modules import MODULES, FAMILY_MODULE, enrich_case, module_catalog
from harness_paths import canonical_case_path
from invoice_requirements import load_requirements
from migrate_harness_data import revise_legacy, bind_atomic_checks, validate_new_contracts, verify_migration, scenario_case
from prepare_invoice_data import file_info
from graders.observations import grade


class HarnessMigrationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.requirements=load_requirements(ROOT)
        # This module verifies the retired schema-2 migration path.  Its fixture
        # must come from protected history, never from the current 548 Cases.
        archived=list((ROOT/'agent-eval/data/manifests/history').rglob(
            'cases/sessions/runtime-00012.json'))
        if not archived:
            raise AssertionError('Protected legacy migration fixture is missing')
        cls.case=json.loads(archived[0].read_text(encoding='utf-8'))

    def test_all_legacy_families_have_explicit_owner(self):
        self.assertEqual(len(FAMILY_MODULE),177)
        self.assertEqual(set(FAMILY_MODULE.values()),set(MODULES))

    def test_unknown_family_not_guessed_from_title(self):
        value=copy.deepcopy(self.case)
        value.pop('harnessModule',None)
        value.update(familyId='runtime/unregistered',title='session memory context')
        with self.assertRaisesRegex(ValueError,'Unregistered'):enrich_case(value)

    def test_new_case_prohibitions_cannot_silently_pass(self):
        from harness_scenarios import SCENARIOS_BY_ID
        spec=SCENARIOS_BY_ID['manifest-verified-load']
        requirements=copy.deepcopy(self.requirements)
        case=scenario_case(spec,requirements)
        bind_atomic_checks([case],requirements,{spec['id']:spec})
        unresolved=[c for c in case['oracle']['checks'] if c['ruleStatus']=='unimplemented']
        self.assertEqual({c['description'] for c in unresolved},set(case['oracle']['forbidden']))
        self.assertTrue(all(c['required'] and c['hardConstraint'] for c in unresolved))
        observation={'caseId':case['id'],'caseVersion':case['version'],
            'source':{'kind':'grader_self_test','runId':'self-test','adapterVersion':'test'},
            'evidence':[{'kind':k,'artifact':'self-test.json','sha256':'a'*64}
                        for k in case['oracle']['requiredEvidence']], 'observation':{}}
        for a in spec['expected']:
            cursor=observation
            parts=a['path'].split('.')
            for part in parts[:-1]:cursor=cursor.setdefault(part,{})
            cursor[parts[-1]]=copy.deepcopy(a['value'])
        self.assertEqual(grade(case,observation)['verdict'],'insufficient_evidence')

    def test_revision_preserves_identity_and_drops_review(self):
        before=copy.deepcopy(self.case)
        before.update(humanVerified=True,reviewRecord='old-attestation')
        after=revise_legacy(before,{'path':canonical_case_path(before),'sha256':'a'*64},self.requirements)
        self.assertEqual(after['version'],before['version']+1)
        for k in ('id','familyId','sampleId','split','semanticScenarioKey','replicaIndex'):
            self.assertEqual(before[k],after[k])
        self.assertFalse(after['humanVerified'])
        self.assertNotIn('reviewRecord',after)
        self.assertEqual(before['reviewRecord'],'old-attestation')

    def test_assertions_do_not_inherit_all_case_tags(self):
        value=revise_legacy(self.case,{'path':canonical_case_path(self.case),'sha256':'a'*64},self.requirements)
        req=copy.deepcopy(self.requirements)
        bind_atomic_checks([value],req,{})
        checks=[c for c in value['oracle']['checks'] if c.get('assertion')]
        self.assertTrue(all(len(c['requirementRefs'])<len(value['requirementRefs']) for c in checks))
        self.assertNotEqual(checks[0]['requirementRefs'],checks[1]['requirementRefs'])

    def test_plain_json_cannot_claim_product_execution(self):
        case={'id':'harness-probe','version':1,'category':'runtime'}
        result=grade(case,{'caseId':case['id'],'caseVersion':1,
            'source':{'kind':'product_run','runId':'fabricated','adapterVersion':'fake'}})
        self.assertEqual(result['verdict'],'infrastructure_error')

    def test_missing_direct_atomic_link_blocks_publication(self):
        with self.assertRaisesRegex(ValueError,'no direct check'):
            validate_new_contracts([],{'requirements':[{'id':'required-atomic','kind':'atomic'}]})

    def test_runtime_requirements_cannot_disappear_from_coverage(self):
        with self.assertRaisesRegex(ValueError,'Runtime subcapabilities'):
            validate_new_contracts([],{'requirements':[{'id':'RTC-01-01','kind':'RTC'}]})

    def test_empty_modules_still_disclose_required_runtime_capabilities(self):
        catalog=module_catalog([],self.requirements)
        declared={r for m in catalog['modules'] for r in m['requiredSubcapabilities']}
        required={r['id'] for r in self.requirements['requirements'] if r['kind'] in {'RTC','RTX'}}
        self.assertTrue(required.issubset(declared))
        facilities=next(m for m in catalog['modules'] if m['id']=='eval-infrastructure')['facilityObligations']
        self.assertEqual(len(facilities),26)
        self.assertTrue(all(not r['productCaseCoverageCredit'] and not r['wholeRequirementSatisfied'] for r in facilities))
        self.assertEqual(catalog['actualProductRuns'],0)

    def test_protected_ledger_cannot_drop_an_asset(self):
        with tempfile.TemporaryDirectory() as temporary:
            root=Path(temporary);(root/'manifests/history').mkdir(parents=True)
            def write(relative,value):
                p=root/relative;p.parent.mkdir(parents=True,exist_ok=True)
                p.write_text(json.dumps(value),encoding='utf-8');return file_info(p,root)
            old={'id':'x','version':1,'category':'runtime','familyId':'runtime/session-reopen',
                 'sampleId':None,'split':'development','leakageGroup':'g','semanticScenarioKey':'k','replicaIndex':1}
            old_bytes=json.dumps(old).encode();gold_bytes=b'{"id":"gold"}'
            entry=lambda path,raw:{'path':path,'bytes':len(raw),'sha256':hashlib.sha256(raw).hexdigest()}
            prior_case=entry('cases/runtime/x.json',old_bytes);prior_gold=entry('gold/g.json',gold_bytes)
            inv_bytes=json.dumps({'files':[prior_case,prior_gold]}).encode()
            archive=root/'manifests/history/before.zip'
            with zipfile.ZipFile(archive,'w') as z:
                z.writestr('manifests/inventory.json',inv_bytes)
                z.writestr(prior_case['path'],old_bytes);z.writestr(prior_gold['path'],gold_bytes)
                # Catalog is itself part of the verified historical inventory.
            catalog_bytes=json.dumps({'cases':[{'id':'x','path':prior_case['path']}]}).encode()
            inv_bytes=json.dumps({'files':[prior_case,prior_gold,entry('manifests/case-catalog.json',catalog_bytes)]}).encode()
            with zipfile.ZipFile(archive,'w') as z:
                for path,raw in [('manifests/inventory.json',inv_bytes),(prior_case['path'],old_bytes),(prior_gold['path'],gold_bytes),('manifests/case-catalog.json',catalog_bytes)]:z.writestr(path,raw)
            history={**file_info(archive,root),'inventorySha256':hashlib.sha256(inv_bytes).hexdigest()}
            current=write('cases/sessions/x.json',{**old,'version':2,'harnessModule':'sessions','humanVerified':False})
            (root/'gold').mkdir();(root/'gold/g.json').write_bytes(gold_bytes)
            write('manifests/case-catalog.json',{'cases':[{'id':'x','path':current['path']}]})
            write('manifests/requirements.json',{'sourceHashes':{}})
            record={'history':history,'priorSnapshot':{'inventorySha256':history['inventorySha256']},
                    'caseCount':1,'sourceHashes':{},'changedCases':[{'id':'x','prior':prior_case,'current':current}],
                    'addedCases':[],'preservedAssets':[prior_gold]}
            write('manifests/harness-migration.json',record)
            self.assertEqual(verify_migration(root)['cases'],1)
            record['preservedAssets']=[];write('manifests/harness-migration.json',record)
            with self.assertRaisesRegex(ValueError,'Protected history declaration'):
                verify_migration(root)


if __name__=='__main__':unittest.main()
