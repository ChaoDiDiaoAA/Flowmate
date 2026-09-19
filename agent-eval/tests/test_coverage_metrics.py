from pathlib import Path
import sys
import pytest
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src'))
from graders.coverage_metrics import ratio, outcomes, stability, latency, cost, compression


def test_ratio_correct_wrong_missing_zero():
    assert ratio(1, 2)['value'] == .5
    assert ratio(0, 2)['value'] == 0
    assert ratio(None, None, evidence_complete=False)['status'] == 'insufficient_evidence'
    assert ratio(0, 0)['value'] is None
    with pytest.raises(ValueError): ratio(3, 2)


def test_outcomes_keeps_unrun_and_errors():
    r=outcomes(['a','b','c','d'],[{'id':'a','status':'PASS','started':True}, {'id':'b','status':'FAIL','started':True}, {'id':'c','status':'ERROR','started':False}])
    assert r['pass']['value']==.5 and r['confirmed']['value']==.25 and r['judgeable']['value']==.5
    assert r['counts']['NOT_RUN']==1 and r['counts']['ERROR']==1
    assert outcomes([],[])['pass']['value'] is None
    with pytest.raises(ValueError): outcomes(['a'],[{'id':'a','status':'PASS','started':False}])


def test_duplicate_or_unknown_trial_rejected():
    row={'id':'a','status':'FAIL','started':True}
    with pytest.raises(ValueError): outcomes(['a'],[row,row])
    with pytest.raises(ValueError): outcomes([], [row])


def test_repeat_missing_slot_not_all_pass():
    r=stability(['a','b'],2,[{'caseId':'a','repeatIndex':0,'status':'PASS'}, {'caseId':'b','repeatIndex':0,'status':'FAIL'}, {'caseId':'b','repeatIndex':1,'status':'PASS'}])
    assert r['first']['value']==.5 and r['passAtK']['value']==1 and r['passPowerK']['value']==0 and r['missingSlots']==1
    assert stability([],2,[])['first']['value'] is None


def test_repeat_duplicate_rejected():
    row={'caseId':'a','repeatIndex':0,'status':'PASS'}
    with pytest.raises(ValueError): stability(['a'],2,[row,row])


def test_latency_censors_and_rejects_cross_clock():
    row={'id':'a','start':10,'end':None,'cutoff':30,'startClock':'host1','endClock':'host1'}
    assert latency([row])['rightCensored']==[{'id':'a','age':'20'}]
    assert latency([dict(row,end=15)])['completedDurations']==['5']
    with pytest.raises(ValueError): latency([dict(row,endClock='host2')])
    assert latency([])['overdue']['value'] is None


def test_cost_unknown_not_zero_or_success_only():
    r=cost([{'id':'failed','amount':'2.00','currency':'USD'},{'id':'retry','amount':None,'currency':'USD'}],2,0)
    assert r['knownAmount']=='2.00' and r['total'] is None and r['perCompleted'] is None
    assert cost([{'id':'a','amount':'3','currency':'USD'}],2,1)['perProcessed']=='1.5'
    assert cost([],1,0)['total'] is None


def test_cost_currency_and_duplicate_rejected():
    row={'id':'a','amount':'1','currency':'USD'}
    with pytest.raises(ValueError): cost([row,row],1,1)
    with pytest.raises(ValueError): cost([row,dict(row,id='b',currency='EUR')],2,1)


def test_compression_keeps_negative_and_boundary():
    assert compression(100,80,True)==.2 and compression(100,120,True)==-.2
    assert compression(0,0,True) is None and compression(100,80,False) is None
