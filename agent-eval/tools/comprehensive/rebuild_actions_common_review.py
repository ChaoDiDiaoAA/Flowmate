"""Publish the reviewed common Actions trigger/identity semantic facility."""
from collections import Counter
from copy import deepcopy
import hashlib
import json
from pathlib import Path
import re
import subprocess
import sys

from rebuild_case_release import canonical_digest
from rebuild_dataset import json_bytes
from rebuild_source_revision import reindex
from rebuild_sources import file_pin


RECEIPT = 'manifests/case-reviews/actions-common-semantics.json'
PREDECESSOR = 'manifests/case-reviews/actions-positive-submission-semantics.json'
READINESS = 'manifests/readiness.json'
REPORT = 'manifests/preparation-report.json'
CHECK_COUNTS = {
    'command-delivered': 68,
    'identity-join-errors': 68,
    'observed-fault-count': 19,
    'barrier-arrivals': 4,
    'barrier-released': 4,
}
SOURCE_PATHS = [
    'agent-eval/src/graders/action_semantics.py',
    'agent-eval/tests/comprehensive/test_action_semantics.py',
    'agent-eval/tools/comprehensive/rebuild_scenarios_actions.py',
    'agent-eval/tests/comprehensive/test_rebuild_scenarios_actions.py',
]
TEST_COMMAND = ('python -m pytest agent-eval/tests/comprehensive/test_action_semantics.py '
                'agent-eval/tests/comprehensive/test_rebuild_scenarios_actions.py -q')


def _read(snapshot, path):
    return json.loads(snapshot[path].decode('utf-8-sig'))


def _check_pins(snapshot):
    rows = []
    for path in sorted(p for p in snapshot if p.startswith('cases/actions/') and p.endswith('.json')):
        case = _read(snapshot, path)
        digest = canonical_digest(case)
        for check in case['oracle']['checks']:
            name = check['checkId'].rsplit(':', 1)[-1]
            if name in CHECK_COUNTS:
                rows.append({'caseId': case['id'], 'caseVersion': case['version'],
                             'caseSha256': digest, 'checkId': check['checkId'],
                             'checkName': name, 'assertion': deepcopy(check['assertion']),
                             'evidenceKinds': sorted(x['kind'] for x in check['evidenceRequirements']
                                                     if x.get('required', True)),
                             'projector': 'graders.action_semantics.project_action_common'})
    counts = Counter(row['checkName'] for row in rows)
    if counts != Counter(CHECK_COUNTS) or len(rows) != 163:
        raise ValueError('Common Actions semantic check inventory differs')
    return rows


def _ref(snapshot, path):
    raw = snapshot.get(path)
    if raw is None:
        raise ValueError('Required predecessor receipt missing')
    return {'path': path, 'bytes': len(raw), 'sha256': hashlib.sha256(raw).hexdigest()}


def build_receipt(project, snapshot, result):
    if (result.get('command') != TEST_COMMAND or result.get('exitCode') != 0 or
            result.get('passed') != 33 or result.get('productRuns') != 0):
        raise ValueError('Actions common semantic tests did not complete exactly')
    return {
        'schemaVersion': 1,
        'reviewId': 'actions-common-trigger-identity-fault-barrier-semantics',
        'status': 'common_action_semantics_addressed_other_q1_pending',
        'scope': 'grader_projection_and_facility_tests_only',
        'predecessor': _ref(snapshot, PREDECESSOR),
        'checkCounts': deepcopy(CHECK_COUNTS),
        'affectedCheckCount': 163,
        'checkPins': _check_pins(snapshot),
        'sourcePins': [file_pin(project, path) for path in SOURCE_PATHS],
        'facilityVerification': deepcopy(result),
        'semantics': {
            'commandDelivery': 'all declared command/request identities delivered exactly once in window',
            'identityJoin': 'principal/workspace/job/action/attempt/target/logical-action fields compared to trusted bindings',
            'faultTrigger': 'fault identity, request and boundary must match an actual injected record',
            'barrierTrigger': 'distinct declared workers arrive before one harness release',
            'missingCriticalRecordOrColumn': 'insufficient_evidence',
            'oracleValueReadByProjector': False,
        },
        'remainingQ1': 'Actions checks outside the positive submission and common trigger/identity equivalence classes still require independent correct/wrong/missing semantic fixtures.',
        'notClaimed': ['complete_actions_q1', 'trusted_product_collector', 'actual_product_run',
                       'case_content_approval', 'formal_acceptance'],
        'actualProductRuns': 0,
        'formalAcceptanceEligible': False,
    }


def assemble(project, snapshot, result):
    if RECEIPT in snapshot:
        raise ValueError('Actions common semantic receipt already exists')
    outputs = dict(snapshot)
    receipt = build_receipt(project, snapshot, result)
    outputs[RECEIPT] = json_bytes(receipt)
    readiness = _read(snapshot, READINESS)
    blockers = [x for x in readiness.get('blockers', []) if x.get('id') == 'actions_Q1']
    if len(blockers) != 1:
        raise ValueError('Expected one Actions Q1 blocker')
    blockers[0]['detail'] = receipt['remainingQ1']
    review = readiness.setdefault('actionsReview', {})
    review.update(Q1='PARTIALLY_ADDRESSED_193_SEMANTIC_CHECKS',
                  commonSemanticChecks=163, totalSemanticChecks=193,
                  commonSemanticReceiptRef={'path': RECEIPT, 'bytes': len(outputs[RECEIPT]),
                                            'sha256': hashlib.sha256(outputs[RECEIPT]).hexdigest()})
    outputs[READINESS] = json_bytes(readiness)
    report = _read(snapshot, REPORT)
    if report.get('remainingWork', []).count('actions_Q1') != 1:
        raise ValueError('Preparation report must retain Actions Q1')
    report['actionsDefinitionReview'] = deepcopy(review)
    outputs[REPORT] = json_bytes(report)
    reindex(outputs)
    validate_snapshot(project, outputs)
    return outputs


def validate_snapshot(project, snapshot):
    if RECEIPT not in snapshot:
        return
    receipt = _read(snapshot, RECEIPT)
    if receipt != build_receipt(project, snapshot, receipt.get('facilityVerification', {})):
        raise ValueError('Actions common semantic receipt is not replayable')
    readiness = _read(snapshot, READINESS)
    review = readiness.get('actionsReview', {})
    expected_ref = {'path': RECEIPT, 'bytes': len(snapshot[RECEIPT]),
                    'sha256': hashlib.sha256(snapshot[RECEIPT]).hexdigest()}
    blockers = [x for x in readiness.get('blockers', []) if x.get('id') == 'actions_Q1']
    state_receipt = 'manifests/case-reviews/actions-state-semantics.json'
    effect_receipt = 'manifests/case-reviews/actions-effect-semantics.json'
    payload_receipt = 'manifests/case-reviews/actions-payload-semantics.json'
    recovery_receipt = 'manifests/case-reviews/actions-recovery-semantics.json'
    presentation_receipt = 'manifests/case-reviews/actions-presentation-semantics.json'
    final = presentation_receipt in snapshot
    expected_q1 = ('ADDRESSED_449_SEMANTIC_CHECKS'
                   if final else 'PARTIALLY_ADDRESSED_426_SEMANTIC_CHECKS'
                   if recovery_receipt in snapshot else 'PARTIALLY_ADDRESSED_364_SEMANTIC_CHECKS'
                   if payload_receipt in snapshot else
                   'PARTIALLY_ADDRESSED_326_SEMANTIC_CHECKS'
                   if effect_receipt in snapshot else
                   'PARTIALLY_ADDRESSED_261_SEMANTIC_CHECKS'
                   if state_receipt in snapshot else 'PARTIALLY_ADDRESSED_193_SEMANTIC_CHECKS')
    expected_total = (449 if final else 426 if recovery_receipt in snapshot else
                      364 if payload_receipt in snapshot else 326 if effect_receipt in snapshot
                      else 261 if state_receipt in snapshot else 193)
    expected_detail = (None if final else _read(snapshot, recovery_receipt)['remainingQ1']
                       if recovery_receipt in snapshot else _read(snapshot, payload_receipt)['remainingQ1']
                       if payload_receipt in snapshot else _read(snapshot, effect_receipt)['remainingQ1']
                       if effect_receipt in snapshot else _read(snapshot, state_receipt)['remainingQ1']
                       if state_receipt in snapshot else receipt['remainingQ1'])
    if (review.get('Q1') != expected_q1 or
            review.get('positiveSubmissionSemanticChecks') != 30 or
            review.get('commonSemanticChecks') != 163 or review.get('totalSemanticChecks') != expected_total or
            review.get('commonSemanticReceiptRef') != expected_ref or
            len(blockers) != (0 if final else 1) or
            (not final and blockers[0].get('detail') != expected_detail)):
        raise ValueError('Actions common semantic readiness differs')
    report = _read(snapshot, REPORT)
    if ((('actions_Q1' in report.get('remainingWork', [])) == final) or
            report.get('actionsDefinitionReview') != review):
        raise ValueError('Actions common semantic preparation status differs')


def run_tests(project):
    command = [sys.executable, '-m', 'pytest', 'agent-eval/tests/comprehensive/test_action_semantics.py',
               'agent-eval/tests/comprehensive/test_rebuild_scenarios_actions.py', '-q']
    completed = subprocess.run(command, cwd=Path(project).resolve(), capture_output=True,
                               text=True, encoding='utf-8', errors='replace')
    match = re.search(r'(^|\s)(\d+) passed(?:,|\s)', completed.stdout)
    result = {'command': TEST_COMMAND, 'exitCode': completed.returncode,
              'passed': int(match.group(2)) if match else None, 'productRuns': 0}
    if completed.returncode or result['passed'] != 33:
        raise ValueError('Actions common semantic tests failed:\n' + completed.stdout + completed.stderr)
    return result


def release(project):
    from rebuild_dataset import verify_asset_snapshot
    from rebuild_staging import read_candidate, revise_candidate
    project = Path(project).resolve()
    result = run_tests(project)
    snapshot = read_candidate(project)
    outputs = assemble(project, snapshot, result)
    verify_asset_snapshot(project, outputs)
    revision = revise_candidate(project, snapshot, outputs)
    revision.update(actionsQ1='partially_addressed_193_semantic_checks', affectedChecks=163,
                    actualProductRuns=0, formalAcceptanceEligible=False)
    return revision


if __name__ == '__main__':
    import argparse
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--project', type=Path, default=Path(__file__).resolve().parents[3])
    args = parser.parse_args()
    print(json.dumps(release(args.project), ensure_ascii=False, indent=2))
