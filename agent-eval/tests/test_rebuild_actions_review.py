from copy import deepcopy
import json
from pathlib import Path
import sys

import pytest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'agent-eval/tools'))

from rebuild_actions_review import assemble, validate_snapshot, RECEIPT
from rebuild_staging import read_candidate


RESULT = {
    'command': 'python -m pytest agent-eval/tests/test_rebuild_scenarios_actions.py -q',
    'exitCode': 0,
    'passed': 23,
    'productRuns': 0,
}


def test_actions_s1_review_is_scoped_and_replayable():
    source = read_candidate(ROOT)
    outputs = source if RECEIPT in source else assemble(ROOT, source, RESULT)
    validate_snapshot(ROOT, outputs)
    receipt = json.loads(outputs[RECEIPT])
    assert receipt['actualProductRuns'] == 0
    assert 'complete_actions_content_review' in receipt['notClaimed']
    readiness = json.loads(outputs['manifests/readiness.json'])
    assert readiness['actionsReview']['S1'] == 'ADDRESSED_DEFINITION_AND_FACILITY_TESTS'
    assert readiness['actionsReview']['Q1'] == 'ADDRESSED_449_SEMANTIC_CHECKS'
    assert 'actions_S1' not in {x['id'] for x in readiness['blockers']}
    assert 'actions_Q1' not in {x['id'] for x in readiness['blockers']}


def test_actions_s1_review_rejects_case_or_status_drift():
    source = read_candidate(ROOT)
    outputs = source if RECEIPT in source else assemble(ROOT, source, RESULT)
    case_path = 'cases/actions/fresh-act-submit-distinct-objects.json'
    bad = dict(outputs)
    case = json.loads(bad[case_path])
    check = next(x for x in case['oracle']['checks'] if x['checkId'].endswith(':submit-request-count'))
    check['assertion']['value'] = 3
    bad[case_path] = json.dumps(case, ensure_ascii=False).encode()
    with pytest.raises(ValueError, match='direct check differs|revised legal control'):
        validate_snapshot(ROOT, bad)

    bad = dict(outputs)
    readiness = json.loads(bad['manifests/readiness.json'])
    readiness['blockers'].append({'id': 'actions_S1', 'status': 'blocked', 'detail': 'stale'})
    bad['manifests/readiness.json'] = json.dumps(readiness, ensure_ascii=False).encode()
    with pytest.raises(ValueError, match='readiness'):
        validate_snapshot(ROOT, bad)
