"""Publish the reviewed positive-submission semantic projection facility.

This successor keeps the immutable Actions S1 receipt and binds the current
semantic projector, independent fixtures, all 30 affected check occurrences,
and their facility tests.  It resolves only the positive submission-chain part
of Actions Q1; other necessary Actions checks remain pending.
"""
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


RECEIPT = 'manifests/case-reviews/actions-positive-submission-semantics.json'
COMMON_RECEIPT = 'manifests/case-reviews/actions-common-semantics.json'
PREDECESSOR = 'manifests/case-reviews/actions-s1.json'
READINESS = 'manifests/readiness.json'
REPORT = 'manifests/preparation-report.json'
CHECK_NAMES = {
    'admitted-submit-count', 'submit-send-entry-count', 'submit-request-count',
    'submit-effect-count', 'submit-success-count', 'undeclared-write-request-count',
}
SOURCE_PATHS = [
    'agent-eval/src/graders/action_semantics.py',
    'agent-eval/tests/test_action_semantics.py',
    'agent-eval/tools/rebuild_scenarios_actions.py',
    'agent-eval/tests/test_rebuild_scenarios_actions.py',
]
TEST_COMMAND = ('python -m pytest agent-eval/tests/test_action_semantics.py '
                'agent-eval/tests/test_rebuild_scenarios_actions.py -q')


def _read(snapshot, path):
    return json.loads(snapshot[path].decode('utf-8-sig'))


def _affected_checks(snapshot):
    rows = []
    for path in sorted(p for p in snapshot if p.startswith('cases/actions/') and p.endswith('.json')):
        case = _read(snapshot, path)
        selected = [check for check in case['oracle']['checks']
                    if check['checkId'].rsplit(':', 1)[-1] in CHECK_NAMES]
        if not selected:
            continue
        case_digest = canonical_digest(case)
        for check in selected:
            rows.append({
                'caseId': case['id'], 'caseVersion': case['version'],
                'caseSha256': case_digest, 'checkId': check['checkId'],
                'checkName': check['checkId'].rsplit(':', 1)[-1],
                'assertion': deepcopy(check['assertion']),
                'evidenceKinds': sorted(x['kind'] for x in check['evidenceRequirements'] if x.get('required', True)),
                'projector': 'graders.action_semantics.project_submission_chain',
            })
    counts = Counter(row['checkName'] for row in rows)
    if len(rows) != 30 or set(counts) != CHECK_NAMES or set(counts.values()) != {5}:
        raise ValueError('Positive submission semantic check inventory differs')
    return rows


def _predecessor_ref(snapshot):
    raw = snapshot.get(PREDECESSOR)
    if raw is None:
        raise ValueError('Actions S1 predecessor receipt missing')
    return {'path': PREDECESSOR, 'bytes': len(raw), 'sha256': hashlib.sha256(raw).hexdigest()}


def build_receipt(project, snapshot, test_result):
    if (test_result.get('command') != TEST_COMMAND or test_result.get('exitCode') != 0 or
            test_result.get('passed') != 30 or test_result.get('productRuns') != 0):
        raise ValueError('Actions semantic facility verification did not complete exactly')
    return {
        'schemaVersion': 1,
        'reviewId': 'actions-positive-submission-semantic-projection',
        'status': 'positive_submission_semantics_addressed_other_q1_pending',
        'scope': 'grader_projection_and_facility_tests_only',
        'predecessor': _predecessor_ref(snapshot),
        'checkNames': sorted(CHECK_NAMES),
        'affectedCheckCount': 30,
        'checkPins': _affected_checks(snapshot),
        'sourcePins': [file_pin(project, path) for path in SOURCE_PATHS],
        'facilityVerification': deepcopy(test_result),
        'semantics': {
            'filters': ['operation', 'status_or_decision', 'current_token', 'principal', 'target',
                        'job', 'action', 'attempt', 'logical_action_key', 'capture_window', 'authority'],
            'missingCriticalLedgerOrColumn': 'insufficient_evidence',
            'expectedCountReadByProjector': False,
            'sameLengthWrongSemanticFixtures': True,
        },
        'remainingQ1': 'All other necessary Actions checks still require explicit independent correct/wrong/missing semantic fixture coverage.',
        'notClaimed': ['complete_actions_q1', 'trusted_product_collector', 'actual_product_run',
                       'case_content_approval', 'formal_acceptance'],
        'actualProductRuns': 0,
        'formalAcceptanceEligible': False,
    }


def assemble(project, snapshot, test_result):
    if RECEIPT in snapshot:
        raise ValueError('Actions semantic receipt already exists')
    outputs = dict(snapshot)
    receipt = build_receipt(project, snapshot, test_result)
    outputs[RECEIPT] = json_bytes(receipt)
    readiness = _read(snapshot, READINESS)
    blockers = [x for x in readiness.get('blockers', []) if x.get('id') == 'actions_Q1']
    if len(blockers) != 1:
        raise ValueError('Expected exactly one Actions Q1 blocker')
    blockers[0]['detail'] = receipt['remainingQ1']
    review = readiness.setdefault('actionsReview', {})
    review.update(Q1='PARTIALLY_ADDRESSED_POSITIVE_SUBMISSION_SEMANTICS',
                  positiveSubmissionSemanticChecks=30,
                  semanticReceiptRef={'path': RECEIPT, 'bytes': len(outputs[RECEIPT]),
                                      'sha256': hashlib.sha256(outputs[RECEIPT]).hexdigest()})
    outputs[READINESS] = json_bytes(readiness)
    report = _read(snapshot, REPORT)
    if report.get('remainingWork', []).count('actions_Q1') != 1:
        raise ValueError('Preparation report must retain exactly one Actions Q1 blocker')
    report['actionsDefinitionReview'] = deepcopy(review)
    outputs[REPORT] = json_bytes(report)
    reindex(outputs)
    validate_snapshot(project, outputs)
    return outputs


def validate_snapshot(project, snapshot):
    if RECEIPT not in snapshot:
        return
    receipt = _read(snapshot, RECEIPT)
    expected = build_receipt(project, snapshot, receipt.get('facilityVerification', {}))
    if receipt.get('sourcePins') != expected.get('sourcePins'):
        if COMMON_RECEIPT not in snapshot:
            raise ValueError('Actions positive semantic source drift lacks a reviewed successor')
        expected['sourcePins'] = receipt['sourcePins']
    if receipt != expected:
        raise ValueError('Actions semantic receipt is not replayable')
    readiness = _read(snapshot, READINESS)
    review = readiness.get('actionsReview', {})
    ref = review.get('semanticReceiptRef')
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
                   if final else
                   'PARTIALLY_ADDRESSED_426_SEMANTIC_CHECKS'
                   if recovery_receipt in snapshot else
                   'PARTIALLY_ADDRESSED_364_SEMANTIC_CHECKS'
                   if payload_receipt in snapshot else
                   'PARTIALLY_ADDRESSED_326_SEMANTIC_CHECKS'
                   if effect_receipt in snapshot else
                   'PARTIALLY_ADDRESSED_261_SEMANTIC_CHECKS'
                   if state_receipt in snapshot else
                   'PARTIALLY_ADDRESSED_193_SEMANTIC_CHECKS'
                   if COMMON_RECEIPT in snapshot else 'PARTIALLY_ADDRESSED_POSITIVE_SUBMISSION_SEMANTICS')
    expected_detail = (None if final else
                       _read(snapshot, recovery_receipt)['remainingQ1'] if recovery_receipt in snapshot else
                       _read(snapshot, payload_receipt)['remainingQ1'] if payload_receipt in snapshot else
                       _read(snapshot, effect_receipt)['remainingQ1'] if effect_receipt in snapshot else
                       _read(snapshot, state_receipt)['remainingQ1'] if state_receipt in snapshot else
                       receipt['remainingQ1'] if COMMON_RECEIPT not in snapshot else
                       _read(snapshot, COMMON_RECEIPT)['remainingQ1'])
    if (review.get('Q1') != expected_q1 or
            review.get('positiveSubmissionSemanticChecks') != 30 or ref != expected_ref or
            len(blockers) != (0 if final else 1) or
            (not final and blockers[0].get('detail') != expected_detail)):
        raise ValueError('Actions semantic readiness differs from receipt')
    report = _read(snapshot, REPORT)
    if ((('actions_Q1' in report.get('remainingWork', [])) == final) or
            report.get('actionsDefinitionReview') != review):
        raise ValueError('Actions semantic preparation status differs')


def run_facility_tests(project):
    command = [sys.executable, '-m', 'pytest', 'agent-eval/tests/test_action_semantics.py',
               'agent-eval/tests/test_rebuild_scenarios_actions.py', '-q']
    completed = subprocess.run(command, cwd=Path(project).resolve(), capture_output=True,
                               text=True, encoding='utf-8', errors='replace')
    match = re.search(r'(^|\s)(\d+) passed(?:,|\s)', completed.stdout)
    result = {'command': TEST_COMMAND, 'exitCode': completed.returncode,
              'passed': int(match.group(2)) if match else None, 'productRuns': 0}
    if completed.returncode or result['passed'] != 30:
        raise ValueError('Actions semantic facility tests failed:\n' + completed.stdout + completed.stderr)
    return result


def release(project):
    from rebuild_dataset import verify_asset_snapshot
    from rebuild_staging import read_candidate, revise_candidate
    project = Path(project).resolve()
    test_result = run_facility_tests(project)
    snapshot = read_candidate(project)
    outputs = assemble(project, snapshot, test_result)
    verify_asset_snapshot(project, outputs)
    result = revise_candidate(project, snapshot, outputs)
    result.update(actionsQ1='partially_addressed_positive_submission_semantics',
                  affectedChecks=30, actualProductRuns=0, formalAcceptanceEligible=False)
    return result


if __name__ == '__main__':
    import argparse
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--project', type=Path, default=Path(__file__).resolve().parents[2])
    args = parser.parse_args()
    print(json.dumps(release(args.project), ensure_ascii=False, indent=2))
