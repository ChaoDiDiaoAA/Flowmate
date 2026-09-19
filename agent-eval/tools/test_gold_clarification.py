import copy
import json
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src'))
from review_invoice_data import validate_field
from graders.observations import _extraction


class ClarificationGoldTests(unittest.TestCase):
    def test_publication_rejects_staging_hash_with_different_newlines(self):
        from publish_gold_answers import verify_publication
        from prepare_invoice_data import file_info
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);(root/'gold').mkdir()
            path=root/'gold/s1.json';decision=root/'decision.json';decision.write_text('{}')
            gold={'sampleId':'s1','humanVerified':True,'eligibleForFieldScoring':True,
                  'fields':{'currency':{'valueState':'confirmed'}},'lineItems':[]}
            raw=json.dumps(gold,indent=2)
            path.write_bytes(raw.encode())
            report={'gold':[file_info(path,root)],'goldCount':1,'fieldStates':{'confirmed':1},
                    'lineItemClarificationDocuments':0,'decision':file_info(decision,root)}
            path.write_bytes(raw.replace('\n','\r\n').encode())
            with self.assertRaises(ValueError):verify_publication(root,report)
            report['gold']=[file_info(path,root)]
            self.assertEqual(verify_publication(root,report)['goldCount'],1)

    def test_user_resolution_keeps_uncertainty_and_adds_document_question(self):
        from publish_gold_answers import settle_form
        candidate={'rawValue':'$', 'normalizedValue':None, 'proposedValueState':'ambiguous',
                   'proposedInputAvailability':'present','alternatives':[], 'evidence':[],
                   'issues':['currency_not_established_by_symbol']}
        packet={'reviewForm':{'coverage':{'headerReviewed':False},'fields':{'currency':candidate},'lineItems':[]},
                'documentIssues':['no_line_items_recovered_check_original']}
        form=settle_form(packet,{'reviewerId':'TEST'})
        self.assertEqual(form['fields']['currency']['valueState'],'clarification_required')
        self.assertIsNone(form['fields']['currency']['normalizedValue'])
        self.assertEqual(form['lineItemsExpectation']['expectedAction'],'request_clarification')
        self.assertNotIn('valueState',packet['reviewForm']['fields']['currency'])

    def field(self):
        return {'valueState':'clarification_required', 'inputAvailability':'unknown',
                'rawValue':None, 'normalizedValue':None, 'alternatives':[],
                'expectedAction':'request_clarification', 'clarificationReason':'value_not_established',
                'evidence':[{'asset':'s1/original.jpg','pageNumber':1,'note':'Whole page; value unresolved.'}]}

    def grade(self, actual, requests):
        gold={'sampleId':'s1','version':2,'humanVerified':True,'eligibleForFieldScoring':True,'reviewedBy':['TEST human'],
              'reviewedAt':'2026-01-01','sourceEvidence':{'original':'s1/original.jpg'},
              'fields':{'currency':self.field()},'lineItems':[]}
        obs={'observation':{'extraction':{'fields':{'currency':actual},'lineItems':[],
                                        'clarificationRequests':requests}}}
        return _extraction({'sampleId':'s1','oracle':{'fieldGoldVersion':2}},obs,gold)

    def test_unknown_is_valid_without_inventing_absence_or_alternatives(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);(root/'s1').mkdir()
            (root/'s1/pages.json').write_text('[{}]')
            (root/'s1/original.jpg').write_bytes(b'test')
            validate_field(self.field(),'s1',root)
            bad=self.field();bad['normalizedValue']='USD'
            with self.assertRaises(ValueError):validate_field(bad,'s1',root)
            bad=self.field();bad.pop('expectedAction')
            with self.assertRaises(ValueError):validate_field(bad,'s1',root)

    def test_targeted_question_and_unknown_value_pass(self):
        result=self.grade(self.field(),[{'target':'fields.currency','question':'Which currency is intended?'}])
        self.assertEqual(result['verdict'],'pass')

    def test_null_without_question_does_not_pass(self):
        self.assertNotEqual(self.grade(self.field(),[])['verdict'],'pass')

    def test_guessed_value_fails_even_with_question(self):
        actual=self.field();actual.update(valueState='confirmed',normalizedValue='USD')
        self.assertEqual(self.grade(actual,[{'target':'fields.currency','question':'USD?'}])['verdict'],'fail')

    def test_question_for_unrelated_field_does_not_pass(self):
        self.assertNotEqual(self.grade(self.field(),[{'target':'fields.seller_name','question':'Who?'}])['verdict'],'pass')

    def test_missing_line_items_requires_question_not_empty_success(self):
        gold={'sampleId':'s1','version':2,'humanVerified':True,'eligibleForFieldScoring':True,'reviewedBy':['TEST human'],
              'reviewedAt':'2026-01-01','sourceEvidence':{'original':'s1/original.jpg'},
              'fields':{'currency':self.field()},'lineItems':[],
              'lineItemsExpectation':{'state':'clarification_required','expectedAction':'request_clarification'}}
        prediction={'fields':{'currency':self.field()},'lineItems':[],
                    'clarificationRequests':[{'target':'fields.currency','question':'Which currency?'}]}
        case={'sampleId':'s1','oracle':{'fieldGoldVersion':2}}
        self.assertNotEqual(_extraction(case,{'observation':{'extraction':prediction}},gold)['verdict'],'pass')
        prediction['clarificationRequests'].append({'target':'lineItems','question':'Please provide the missing line items.'})
        self.assertEqual(_extraction(case,{'observation':{'extraction':prediction}},gold)['verdict'],'pass')
        prediction['lineItems']=[{'rowIndex':0,'fields':{}}]
        self.assertEqual(_extraction(case,{'observation':{'extraction':prediction}},gold)['verdict'],'fail')


if __name__=='__main__':unittest.main()
