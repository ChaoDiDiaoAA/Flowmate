import unittest
from pathlib import Path
from invoice_requirements import load_requirements, enrich_cases, build_coverage, validate_coverage

class AlignmentTests(unittest.TestCase):
    def test_exact_spec_catalog(self):
        req = load_requirements(Path(__file__).resolve().parents[2])
        for kind, count in [('MOD',34),('RT',17),('RTC',90),('RTX',6)]:
            self.assertEqual(sum(r['kind']==kind for r in req['requirements']), count)
        for r in req['requirements']:
            self.assertEqual(len(r['source']['sha256']),64)
            self.assertTrue(r['source']['verbatim'])
    def test_labels_are_not_coverage(self):
        req = load_requirements(Path(__file__).resolve().parents[2])
        report = build_coverage([{'id':'fake','requirementRefs':['RTC-01-01']}],req)
        row = next(r for r in report['requirements'] if r['requirementId']=='RTC-01-01')
        self.assertEqual(row['preparedCheckCount'],0)
        self.assertEqual(row['status'],'uncovered')
    def test_duplicate_ids_rejected(self):
        req = load_requirements(Path(__file__).resolve().parents[2])
        with self.assertRaises(ValueError):
            validate_coverage([{'id':'same'},{'id':'same'}],req)


class EnrichmentTests(unittest.TestCase):
    @staticmethod
    def fixture_cases():
        from copy import deepcopy
        from invoice_case_catalog import CATALOG
        output=[]
        for category in ('runtime','isolation','platform'):
            for index in range(160):
                family=CATALOG[category][index % len(CATALOG[category])]
                cid=f'{category}-{index:05d}'
                output.append({'id':cid,'category':category,'split':'development' if (index//len(CATALOG[category]))%2 else 'holdout',
                    'sampleId':str(index),'leakageGroup':str(index),'version':1,
                    'familyId':category+'/'+family['id'],'semanticScenarioKey':category+'/'+family['id'],
                    'stage':family['phase'],'normalControlFamily':category+'/'+family['normalControl'] if family['normalControl'] else None,
                    'initialEnvironment':{'scenarioSetup':deepcopy(family['initialState']),'fixtureBaseRef':'old'},
                    'oracle':{'assertions':deepcopy(family['expected']),'forbidden':deepcopy(family['forbidden']),
                              'requiredEvidence':deepcopy(family['evidence']),'fieldGoldRef':None},
                    'scoring':{},'blockedUntil':[],'inputAssets':['old'],'risks':[]})
        return output

    def test_enrichment_preserves_identity_and_blocks_unimplemented(self):
        from copy import deepcopy
        original=self.fixture_cases(); snapshot=deepcopy(original)
        req=load_requirements(Path(__file__).resolve().parents[2])
        result=enrich_cases(original,req)
        self.assertEqual(original,snapshot)
        self.assertEqual([(c['id'],c['category'],c['sampleId'],c['split']) for c in original],
                         [(c['id'],c['category'],c['sampleId'],c['split']) for c in result])
        self.assertTrue(all(c['oracle']['checks'] for c in result))
        self.assertTrue(all(any(x['ruleStatus']=='unimplemented' and x['required'] for x in c['oracle']['checks']) for c in result))
        history=[c for c in result if c['familyId']=='runtime/history-corrupt']
        self.assertTrue(history);self.assertTrue(all(c['stage']=='P4' for c in history))
        from collections import defaultdict
        indices=defaultdict(list)
        for case in result: indices[case['semanticScenarioKey']].append(case['replicaIndex'])
        self.assertTrue(all(v==list(range(1,len(v)+1)) for v in indices.values()))
        validate_coverage([c for c in result if c["category"] != "isolation"],req)

    def test_positive_controls_independent_and_new_setup_truthful(self):
        req=load_requirements(Path(__file__).resolve().parents[2])
        result=enrich_cases(self.fixture_cases(),req)
        controls=[c for c in result if c.get('scenarioRole')=='control']
        self.assertTrue(controls)
        self.assertTrue(all(c['normalControlFamily'] is None for c in controls))
        self.assertTrue(any(c['familyId']=='isolation/allowed-approve' for c in controls))
        new=[c for c in result if c.get('coverageContribution')=='specific_condition_variant']
        self.assertTrue(new)
        for c in new:
            self.assertEqual(c['inputAssets'],[])
            self.assertIsNone(c['initialEnvironment']['fixtureBaseRef'])
            self.assertEqual(c['sampleRole'],'allocation_anchor_only')
            self.assertEqual(c['executionStatus'],'not_run')
        for c in result:
            if c.get('scenarioRole')=='attack':
                self.assertTrue(any(x['assertion']['path']=='observation.isolation.attackReach.observed'
                    for x in c['oracle']['checks'] if x.get('assertion')))

    def test_exact_source_location_and_phase_mapping(self):
        req=load_requirements(Path(__file__).resolve().parents[2])
        self.assertEqual(sum(r['kind']=='DrivingTask' for r in req['requirements']),14)
        for r in req['requirements']:
            path=Path(__file__).resolve().parents[2]/r['source']['path']
            text=path.read_text(encoding='utf-8-sig').splitlines()
            self.assertEqual(text[r['source']['lineStart']-1],r['source']['verbatim'])
        row=next(r for r in req['requirements'] if r['id']=='CRIT-3.23.3-07')
        self.assertIn('清理按',row['source']['verbatim'])


class CoverageIntegrityTests(unittest.TestCase):
    def setUp(self):
        self.req=load_requirements(Path(__file__).resolve().parents[2])
        self.cases=enrich_cases([c for c in EnrichmentTests.fixture_cases() if c['category']=='runtime'],self.req)

    def test_forged_coverage_rejected(self):
        report=build_coverage(self.cases,self.req)
        report['requirements'][0]['preparedCheckCount']+=1
        with self.assertRaises(ValueError): validate_coverage(self.cases,self.req,report)

    def test_check_unknown_and_unlisted_requirement_rejected(self):
        self.cases[0]['oracle']['checks'][0]['requirementRefs']=['MOD-999']
        with self.assertRaises(ValueError): validate_coverage(self.cases,self.req)
        self.cases[0]['oracle']['checks'][0]['requirementRefs']=['MOD-34']
        with self.assertRaises(ValueError): validate_coverage(self.cases,self.req)

    def test_stale_source_and_wrong_driving_phase_rejected(self):
        from copy import deepcopy
        bad=deepcopy(self.cases)
        bad[0]['sourceSpecHashes']={}
        with self.assertRaises(ValueError): validate_coverage(bad,self.req)
        bad=deepcopy(self.cases)
        bad[0]['drivingTask']['requirementId']='DrivingTask-P13'
        with self.assertRaises(ValueError): validate_coverage(bad,self.req)

    def test_controls_must_be_pinned_and_equivalent(self):
        from copy import deepcopy
        allcases=enrich_cases(EnrichmentTests.fixture_cases(),self.req)
        attack=next(c for c in allcases if c['familyId']=='isolation/boundary-approve')
        control=next(c for c in allcases if c['id']==attack['normalControlRefs'][0]['caseId'])
        pair=[attack,control]
        attack.pop('normalControlRefs',None)
        with self.assertRaises(ValueError): validate_coverage(pair,self.req)
        attack['normalControlRefs']=[{'caseId':control['id'],'version':control['version']}]
        validate_coverage(pair,self.req)
        for field,value in [('split','wrong'),('operation','read_invoice'),('stage','P13'),('version',999)]:
            bad=deepcopy(pair);bad[1][field]=value
            with self.assertRaises(ValueError): validate_coverage(bad,self.req)


class EvidenceIndependenceTests(unittest.TestCase):
    def test_safety_consequences_do_not_require_model_trace(self):
        req=load_requirements(Path(__file__).resolve().parents[2])
        cases=enrich_cases(EnrichmentTests.fixture_cases(),req)
        case=next(c for c in cases if c['category']=='isolation')
        bypath={c['assertion']['path']:c for c in case['oracle']['checks'] if c.get('assertion')}
        leak=bypath['observation.isolation.protectedSentinelLeaks']
        self.assertEqual([e['kind'] for e in leak['evidenceRequirements']],['controlled_target_state'])
        model=bypath['observation.isolation.model.unauthorizedRequests']
        self.assertEqual([e['kind'] for e in model['evidenceRequirements']],['actual_input_reach_and_calls'])
        self.assertIn('actual_input_reach_and_calls',case['oracle']['requiredEvidence'])

    def test_submission_payload_safety_and_write_evidence(self):
        from copy import deepcopy
        from invoice_case_catalog import CATALOG
        family=CATALOG['submission'][0]
        template=EnrichmentTests.fixture_cases()[0]
        template.update(id='submission-test',category='submission',familyId='submission/'+family['id'],
            stage='P12',dependencies=[])
        template['oracle']={'assertions':deepcopy(family['expected']),
            'forbidden':deepcopy(family['forbidden']),'requiredEvidence':deepcopy(family['evidence'])}
        req=load_requirements(Path(__file__).resolve().parents[2])
        case=enrich_cases([template],req)[0]
        checks={c['assertion']['path']:c for c in case['oracle']['checks'] if c.get('assertion')}
        self.assertIn('observation.external.submittedAmountsAndLinesMatchFrozenPayload',checks)
        self.assertIn('observation.external.finalAdmissionRespected',checks)
        self.assertEqual([e['kind'] for e in checks['observation.external.unauthorizedEffects']['evidenceRequirements']],['目标模拟台账及回读'])
        self.assertIn('实际发送载荷与目标身份',case['oracle']['requiredEvidence'])

if __name__=='__main__': unittest.main()
