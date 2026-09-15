"""Synthetic tests of human-review intake and immutable release handling."""
import copy
import json
from pathlib import Path
import tempfile
import unittest

from review_invoice_data import (make_review_form, validate_review, publish_review, freeze_v1,
                                resolve_release, publish_asset_revisions, resolve_asset)


class ReviewWorkflowTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.project = Path(self.tmp.name)
        self.quality = self.project / 'agent-eval/data'
        self.product = self.project / 'data/invoices/voxel51'
        (self.quality/'gold').mkdir(parents=True)
        (self.quality/'manifests').mkdir()
        (self.product/'000001').mkdir(parents=True)
        (self.product/'000001/content.json').write_text('[{"text":"Invoice TEST-1","page_idx":0}]')
        (self.product/'000001/original.jpg').write_bytes(b'fixture-only')
        (self.product/'000001/pages.json').write_text('[{"pageNumber":1}]')
        from prepare_invoice_data import file_info, digest
        sample = self.product/'000001'
        metadata = {'sampleId':'000001','originalSha256':digest(sample/'original.jpg'),
                    'files':[file_info(sample/name,sample) for name in ('original.jpg','content.json','pages.json')]}
        (sample/'metadata.json').write_text(json.dumps(metadata))
        (self.product/'manifest.json').write_text(json.dumps({'datasetVersion':'fixture-v1','samples':[
            {'sampleId':'000001','originalSha256':metadata['originalSha256'],
             'metadata':file_info(sample/'metadata.json',self.product)}]}))
        self.base = {'id':'gold-000001','sampleId':'000001','version':1,'split':'development',
                     'status':'review_pending','fields':{},'lineItems':[]}
        (self.quality/'gold/000001.json').write_text(json.dumps(self.base))
        (self.quality/'cases/approval').mkdir(parents=True)
        self.case={'id':'approval-fixture','sampleId':'000001','category':'approval','split':'development','version':1,
                   'initialEnvironment':{'syntheticTotal':'100.00'}}
        (self.quality/'cases/approval/approval-fixture.json').write_text(json.dumps(self.case))
        from prepare_invoice_data import file_info
        desc=file_info(self.quality/'gold/000001.json',self.quality)
        case_desc=file_info(self.quality/'cases/approval/approval-fixture.json',self.quality)
        (self.quality/'manifests/inventory.json').write_text(json.dumps({'version':'fixture-v1','files':[desc,case_desc]}))
        freeze_v1(self.project)

    def tearDown(self):
        self.tmp.cleanup()

    def reviewed(self):
        form=make_review_form(self.base)
        form['reviewers']=[{'reviewerId':'SYNTHETIC-TEST-HUMAN','role':'primary','performedBy':'human',
                            'reviewedAt':'2020-01-01T12:00:00+00:00','attestsOriginalImageReview':True}]
        form['coverage']={k:True for k in form['coverage']}
        for field in form['fields'].values():
            field.update(valueState='source_not_provided',inputAvailability='not_applicable',
                         evidence=[{'asset':'000001/original.jpg','pageNumber':1,'note':'Synthetic absence review'}])
        form['fields']['invoice_number'].update(valueState='confirmed',rawValue='TEST-1',normalizedValue='TEST-1',inputAvailability='present')
        return form

    def test_blank_form_cannot_be_accepted(self):
        with self.assertRaises(ValueError): validate_review(make_review_form(self.base),self.base,self.product)

    def test_ai_attestation_is_not_human_verification(self):
        form=self.reviewed(); form['reviewers'][0]['performedBy']='ai'
        with self.assertRaises(ValueError): validate_review(form,self.base,self.product)

    def test_bad_evidence_and_unreviewed_field_are_rejected(self):
        form=self.reviewed(); form['fields']['invoice_number']['evidence'][0]['asset']='../private.txt'
        with self.assertRaises(ValueError): validate_review(form,self.base,self.product)
        form=self.reviewed(); form['fields']['currency']['valueState']='unverified'
        with self.assertRaises(ValueError): validate_review(form,self.base,self.product)

    def test_publish_preserves_original_and_pins_new_version(self):
        original=(self.quality/'gold/000001.json').read_bytes()
        result=publish_review(self.project,self.reviewed(),'fixture-v1','review-fixture-1')
        self.assertEqual((self.quality/'gold/000001.json').read_bytes(),original)
        released=resolve_release(self.project,'review-fixture-1')
        self.assertEqual(released['gold']['000001']['version'],2)
        self.assertEqual(released['gold']['000001']['reviewLevel'],'single_human')
        self.assertTrue(result['humanVerified'])
        with self.assertRaises(FileExistsError): publish_review(self.project,self.reviewed(),'fixture-v1','review-fixture-1')

    def test_base_tampering_is_detected(self):
        (self.quality/'gold/000001.json').write_text('{"tampered":true}')
        with self.assertRaises(ValueError): resolve_release(self.project,'fixture-v1')

    def test_changed_source_cannot_publish_review(self):
        for name in ('original.jpg', 'content.json', 'pages.json', 'metadata.json'):
            path=self.product/'000001'/name
            original=path.read_bytes()
            path.write_bytes(original+b' ')
            with self.assertRaises(ValueError):
                publish_review(self.project,self.reviewed(),'fixture-v1','bad-source')
            self.assertFalse((self.quality/'manifests/releases/bad-source.json').exists())
            path.write_bytes(original)

    def test_published_review_pins_source_bytes(self):
        result=publish_review(self.project,self.reviewed(),'fixture-v1','review-fixture-1')
        self.assertEqual(len(result['sourceSnapshot']['files']),3)
        (self.product/'000001/original.jpg').write_bytes(b'changed-after-review')
        with self.assertRaises(ValueError): resolve_release(self.project,'review-fixture-1')

    def test_second_reviewer_must_be_distinct(self):
        form=self.reviewed()
        secondary=copy.deepcopy(form['reviewers'][0]); secondary['role']='secondary'
        secondary['reviewerId']=' synthetic-test-human '
        form['reviewers'].append(secondary)
        with self.assertRaises(ValueError): validate_review(form,self.base,self.product)

    def test_uncertainty_cannot_hide_a_definite_answer(self):
        form=self.reviewed(); f=form['fields']['currency']
        f.update(valueState='ambiguous', normalizedValue='USD', alternatives=['USD','CAD'])
        with self.assertRaises(ValueError): validate_review(form,self.base,self.product)

    def test_draft_delta_keeps_v1_and_cannot_claim_review(self):
        value=copy.deepcopy(self.case)
        value['initialEnvironment']['syntheticTotal']='9999.99'
        value['reviewStatus']='approved'; value['executionStatus']='passed'
        publish_asset_revisions(self.project,[{'kind':'case','id':value['id'],'value':value}],
                                'fixture-v1','boundary-v2','Add approved-plan boundary fixture')
        old=resolve_asset(self.project,'fixture-v1','case',value['id'])['value']
        new=resolve_asset(self.project,'boundary-v2','case',value['id'])['value']
        self.assertEqual(old['initialEnvironment']['syntheticTotal'],'100.00')
        self.assertEqual(new['version'],2)
        self.assertEqual(new['reviewStatus'],'pending')
        self.assertEqual(new['executionStatus'],'not_run')

    def test_draft_revision_cannot_silently_move_holdout(self):
        value=copy.deepcopy(self.case); value['split']='acceptance'
        with self.assertRaises(ValueError):
            publish_asset_revisions(self.project,[{'kind':'case','id':value['id'],'value':value}],
                                    'fixture-v1','bad-v2','bad reassignment')
        self.assertFalse((self.quality/'manifests/releases/bad-v2.json').exists())



class CurrentReviewWorkflowTests(unittest.TestCase):
    tearDown = ReviewWorkflowTests.tearDown
    reviewed = ReviewWorkflowTests.reviewed
    def setUp(self):
        ReviewWorkflowTests.setUp(self)
        from prepare_invoice_data import file_info
        inventory = {'kind':'single_current_dataset', 'schemaVersion':1,
                     'files':[file_info(p,self.quality) for p in sorted(self.quality.rglob('*'))
                              if p.is_file() and p != self.quality/'manifests/inventory.json']}
        (self.quality/'manifests/inventory.json').write_text(json.dumps(inventory))

    def form(self, kind='case', identity='approval-fixture'):
        from review_invoice_data import make_asset_review_form
        form=make_asset_review_form(self.project,kind,identity)
        form.update(recordId='review-fixture', owner='fixture-owner', decision='accept',
                    exposure={'scope':'development','reviewed':True,'notes':'Synthetic test scope'},
                    rationale='Reviewed the complete synthetic fixture')
        form['reviewers']=[{'reviewerId':'SYNTHETIC-TEST-HUMAN','role':'primary','performedBy':'human',
                            'reviewedAt':'2020-01-01T12:00:00+00:00','attestsContentReview':True}]
        form['checks']={k:True for k in form['checks']}
        form['evidence']=[dict(form['target'],note='Synthetic content review')]
        return form

    def test_current_blank_and_ai_forms_rejected(self):
        from review_invoice_data import make_asset_review_form, submit_asset_review
        with self.assertRaises(ValueError):
            submit_asset_review(self.project,make_asset_review_form(self.project,'case','approval-fixture'))
        form=self.form(); form['reviewers'][0]['performedBy']='ai'
        with self.assertRaises(ValueError): submit_asset_review(self.project,form)

    def test_current_submit_preserves_parent_and_updates_single_index(self):
        from review_invoice_data import submit_asset_review, verify_current_inventory
        form=self.form(); result=submit_asset_review(self.project,form)
        self.assertTrue(result['humanVerified'])
        self.assertFalse(result['formalAcceptanceEligible'])
        self.assertEqual(result['executionStatus'],'not_run')
        record=json.loads((self.quality/'manifests/reviews/review-fixture.json').read_text())
        self.assertEqual(record['parentValue'],self.case)
        self.assertEqual(record['parentAsset'],form['target'])
        verify_current_inventory(self.project)
        self.assertEqual(json.loads((self.quality/'cases/approval/approval-fixture.json').read_text()),result)
        with self.assertRaises(ValueError): submit_asset_review(self.project,form)

    def test_current_cannot_bless_unrelated_tampering_or_new_files(self):
        from review_invoice_data import refresh_inventory, register_workflow_files
        (self.quality/'gold/000001.json').write_text('{}')
        with self.assertRaises(ValueError): refresh_inventory(self.project)
        with self.assertRaises(ValueError): register_workflow_files(self.project)

    def test_current_target_hash_checks_and_unresolved_disputes(self):
        from review_invoice_data import submit_asset_review
        form=self.form(); form['target']['sha256']='0'*64
        with self.assertRaises(ValueError): submit_asset_review(self.project,form)
        form=self.form(); form['disputes']=[{'id':'d1','issue':'ambiguous oracle','status':'open'}]
        with self.assertRaises(ValueError): submit_asset_review(self.project,form)

    def test_current_gold_still_requires_original_field_review(self):
        from review_invoice_data import submit_asset_review
        form=self.form('gold','000001')
        with self.assertRaises(ValueError): submit_asset_review(self.project,form)
        form['goldReview']=self.reviewed()
        result=submit_asset_review(self.project,form)
        self.assertTrue(result['eligibleForFieldScoring'])

    def test_current_review_checks_source_integrity(self):
        from review_invoice_data import submit_asset_review
        form=self.form()
        for name in ('original.jpg','content.json','pages.json','metadata.json'):
            p=self.product/'000001'/name; original=p.read_bytes(); p.write_bytes(original+b' ')
            with self.assertRaises(ValueError): submit_asset_review(self.project,form)
            p.write_bytes(original)

    def test_current_business_policy_and_adjudication(self):
        from review_invoice_data import refresh_inventory, submit_asset_review
        for kind, relative, value in (
            ('business','business/000001.json',dict(self.case,id='business-000001')),
            ('policy','manifests/fixture-policy.json',{'id':'fixture-policy','version':1})):
            path=self.quality/relative; path.parent.mkdir(parents=True,exist_ok=True)
            path.write_text(json.dumps(value))
            refresh_inventory(self.project,[relative])
            form=self.form(kind,value['id']); form['recordId']='review-'+kind
            form['disputes']=[{'id':'d1','issue':'Synthetic ambiguity','status':'resolved',
                              'resolution':'Reviewed scope supports proposed content',
                              'adjudicators':form['reviewers'],'evidence':form['evidence']}]
            result=submit_asset_review(self.project,form)
            self.assertTrue(result['humanVerified'])
            self.assertFalse(result['formalAcceptanceEligible'])

    def test_current_new_file_requires_explicit_registration(self):
        from review_invoice_data import refresh_inventory
        path=self.quality/'manifests/note.json'; path.write_text('{}')
        with self.assertRaises(ValueError): refresh_inventory(self.project)
        refresh_inventory(self.project,['manifests/note.json'])
        refresh_inventory(self.project)

    def test_current_missing_checks_rejected(self):
        from review_invoice_data import submit_asset_review
        form=self.form(); form['checks'].pop('checksAndOracle')
        with self.assertRaises(ValueError): submit_asset_review(self.project,form)

    def test_current_review_record_validation_rejects_fake_flip(self):
        from review_invoice_data import validate_current_assets
        value=copy.deepcopy(self.case); value.update(humanVerified=True,reviewStatus='accepted')
        (self.quality/'cases/approval/approval-fixture.json').write_text(json.dumps(value))
        with self.assertRaises(ValueError): validate_current_assets(self.quality,self.product)

    def test_current_record_validation_accepts_real_submission(self):
        from review_invoice_data import submit_asset_review, validate_current_assets
        submit_asset_review(self.project,self.form())
        validate_current_assets(self.quality,self.product)
        path=self.quality/'manifests/reviews/review-fixture.json'
        record=json.loads(path.read_text()); record['parentText']='{}'; path.write_text(json.dumps(record))
        with self.assertRaises(ValueError): validate_current_assets(self.quality,self.product)

    def test_current_initialize_exports_only_gold_without_reviews(self):
        from review_invoice_data import initialize, verify_current_inventory
        result=initialize(self.project)
        self.assertEqual(result['newBlankReviewForms'],1)
        self.assertEqual(result['humanReviewsPerformed'],0)
        self.assertTrue((self.quality/'manifests/review-forms/000001.json').exists())
        self.assertFalse((self.quality/'manifests/review-forms/case').exists())
        self.assertEqual(initialize(self.project)['newBlankReviewForms'],0)
        verify_current_inventory(self.project)

    def test_current_initialize_preserves_existing_flat_gold_form(self):
        from review_invoice_data import initialize, refresh_inventory
        path=self.quality/'manifests/review-forms/000001.json'
        path.parent.mkdir(parents=True)
        original=json.dumps(make_review_form(self.base)); path.write_text(original)
        refresh_inventory(self.project,['manifests/review-forms/000001.json'])
        self.assertEqual(initialize(self.project)['newBlankReviewForms'],0)
        self.assertEqual(path.read_text(),original)

    def test_current_gold_review_updates_only_report_review_count(self):
        from review_invoice_data import submit_asset_review, refresh_inventory, verify_current_inventory
        path=self.quality/'manifests/preparation-report.json'
        report={'humanVerifiedInvoices':0,'executedCases':0,'caseDrafts':1,'notes':['Preserve report facts']}
        path.write_text(json.dumps(report))
        refresh_inventory(self.project,['manifests/preparation-report.json'])
        form=self.form('gold','000001'); form['goldReview']=self.reviewed()
        submit_asset_review(self.project,form)
        self.assertEqual(json.loads(path.read_text()),dict(report,humanVerifiedInvoices=1))
        verify_current_inventory(self.project)


if __name__=='__main__': unittest.main()
