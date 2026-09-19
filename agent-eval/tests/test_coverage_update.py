"""Current-only review publication and typed coverage regression tests."""
from copy import deepcopy
from pathlib import Path
from unittest.mock import patch
import hashlib
import json
import sys
import pytest

ROOT=Path(__file__).resolve().parents[2]
sys.path.insert(0,str(ROOT/'agent-eval/tools'))
from coverage_update import build_current, load_current, validate_reviewed_snapshot
from coverage_review import compile_review
from initial_dataset import validate_snapshot, encode
from initial_contract import validate_asset


@pytest.fixture(scope='module')
def candidate():
    return build_current(ROOT)


def test_all_requirement_classes_reviewed_without_mixed_percentage(candidate):
    outputs,public,preview=candidate
    c=json.loads(outputs['manifests/coverage.json'])
    assert c['schemaVersion']==2 and len(c['requirements'])==451
    assert len(c['original340Disposition'])==340 and len(c['original111Reassessment'])==111
    assert 'overallPassRate' not in c
    assert all(r['actualVerification']['runCount']==0 for r in c['requirements'])
    assert all(r['source'] for r in c['requirements'])
    assert preview['counts']['agentTasks']<=100
    validate_reviewed_snapshot(outputs,public)


def test_review_cannot_be_changed_to_covered_by_metadata_only(candidate):
    outputs,public,_=candidate
    bad=dict(outputs);doc=json.loads(bad['manifests/coverage.json'])
    row=next(r for r in doc['requirements'] if r['designStatus']!='covered')
    row['designStatus']='covered';bad['manifests/coverage.json']=encode(doc)
    with pytest.raises(ValueError,match='Reviewed coverage'): validate_reviewed_snapshot(bad,public)


def test_family_and_statistics_do_not_count_as_atomic_checks(candidate):
    c=json.loads(candidate[0]['manifests/coverage.json'])
    assert all(r['unitType']=='family' for r in c['requirements'] if r['requirementId'].startswith(('MOD-','RT-','DrivingTask-')) and '.' not in r['requirementId'])
    assert all(r['unitType']=='metric' for r in c['requirements'] if r['requirementId'].startswith('ALL.'))
    metric=next(r for r in c['requirements'] if r['requirementId']=='MOD-30.isolation')
    assert any(ref['assetId'].startswith('selftest-') for ref in metric['conditions'][0]['checkRefs'])


def test_unknown_review_episode_rejected(candidate):
    outputs,_,_=candidate
    task=next(json.loads(raw) for path,raw in outputs.items() if path.startswith('cases/') and json.loads(raw)['setup']['protocol']=='coverage_episode')
    validate_asset(task)
    task['setup']['initialState']['inventedSuccess']=True
    with pytest.raises(ValueError,match='coverage episode'):validate_asset(task)


def test_check_is_non_mutating_and_base_assets_unchanged(candidate):
    before,_=load_current(ROOT,for_update=True)
    outputs,_,_=candidate
    for path,raw in before.items():
        if path.startswith(('gold/','business/','manifests/reviews/')):
            assert outputs[path]==raw,path
    # Building a candidate does not publish it.
    for path,raw in before.items():
        assert (ROOT/'agent-eval/data'/path).read_bytes()==raw


def test_rebuilding_same_candidate_does_not_increment_versions(candidate):
    outputs,public,_=candidate
    with patch('coverage_update.load_current',return_value=(outputs,public)):
        second,second_public,preview=build_current(ROOT)
    assert outputs==second
    assert public==second_public
    assert preview['changed'] is False


def test_candidate_passes_existing_snapshot_contract(candidate):
    result=validate_snapshot(ROOT,candidate[0],candidate[1])
    assert result['valid'] and result['actualProductRuns']==0


def test_new_tasks_project_only_input_and_cannot_award_product_pass(candidate):
    from runner.initial_dataset import materialize_task, grade_observation
    for path,raw in candidate[0].items():
        if not path.startswith('cases/task-joint-'):continue
        task=json.loads(raw)
        plan=materialize_task(task)
        assert plan['fixture']['input']==task['task']
        assert 'oracle' not in plan['fixture']['input']
        assert plan['productScoreEligible'] is False
        fake={'verdict':'PASS','observation':{c['assertion']['path'].split('.',1)[1]:c['assertion']['value'] for c in task['oracle']['checks']}}
        result=grade_observation(task,fake)
        assert result['verdict']=='UNJUDGEABLE' and not result['productScoreEligible']


def test_new_supplement_contracts_have_direct_benchmark_membership(candidate):
    outputs=candidate[0]
    members=set()
    for path,raw in outputs.items():
        if path.startswith('manifests/benchmarks/') and path.endswith('/members.json'):
            members.update(m['assetId'] for m in json.loads(raw)['members'] if not m['dependencyOnly'])
    from coverage_supplement import additions
    assert all(s['id'] in members for suite in additions() for s in suite['scenarios'])


def test_parent_navigation_reflects_updated_atomic_conditions(candidate):
    rows={r['requirementId']:r for r in json.loads(candidate[0]['manifests/coverage.json'])['requirements']}
    for row in rows.values():
        for condition in row['conditions']:
            if '#child-' not in condition['conditionId']:continue
            cid=row['requirementId']+'/'+condition['conditionId'].split('#child-',1)[1]
            child=rows[cid.split('#',1)[0]]
            actual=next(c for c in child['conditions'] if c['conditionId']==cid)
            assert condition['status']==actual['status']
            assert condition['checkRefs']==actual['checkRefs']
