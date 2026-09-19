"""Publish the reviewed Actions request/effect semantic facility."""
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


RECEIPT = 'manifests/case-reviews/actions-effect-semantics.json'
PREDECESSOR = 'manifests/case-reviews/actions-state-semantics.json'
READINESS = 'manifests/readiness.json'
REPORT = 'manifests/preparation-report.json'
SOURCE_PATHS = [
    'agent-eval/src/graders/action_effect_semantics.py',
    'agent-eval/tests/test_action_effect_semantics.py',
    'agent-eval/tools/rebuild_scenarios_actions.py',
    'agent-eval/tests/test_rebuild_scenarios_actions.py',
]
TEST_COMMAND = ('python -m pytest agent-eval/tests/test_action_effect_semantics.py '
                'agent-eval/tests/test_rebuild_scenarios_actions.py -q')
EFFECT_CHECK_COUNTS = {
    'admission-count': 3, 'attempt-send-entry-count': 1,
    'authoritative-success-count': 5, 'authorized-query-count': 1,
    'browser-submit-requests': 2, 'business-effects': 8,
    'duplicate-command-effects': 1, 'expired-run-scope-uses': 1,
    'network-requests': 26, 'new-write-requests': 1, 'resend-requests': 3,
    'sends-before-current-approval': 1, 'stale-suggestion-authorized-operations': 1,
    'submit-after-resume-count': 1, 'submit-requests': 4, 'submitted-invoices': 1,
    'unauthorized-effects': 2, 'writes-after-kill': 1,
    'writes-after-schema-change': 1, 'writes-after-stop': 1,
}


def _read(snapshot, path):
    return json.loads(snapshot[path].decode('utf-8-sig'))


def _ref(snapshot, path):
    raw = snapshot.get(path)
    if raw is None:
        raise ValueError('Required predecessor receipt missing')
    return {'path': path, 'bytes': len(raw), 'sha256': hashlib.sha256(raw).hexdigest()}


def _check_pins(snapshot):
    rows = []
    for path in sorted(p for p in snapshot if p.startswith('cases/actions/') and p.endswith('.json')):
        case = _read(snapshot, path)
        digest = canonical_digest(case)
        for check in case['oracle']['checks']:
            name = check['checkId'].rsplit(':', 1)[-1]
            if name not in EFFECT_CHECK_COUNTS:
                continue
            rows.append({
                'caseId': case['id'], 'caseVersion': case['version'],
                'caseSha256': digest, 'checkId': check['checkId'],
                'checkName': name, 'assertion': deepcopy(check['assertion']),
                'evidenceKinds': sorted(x['kind'] for x in check['evidenceRequirements']
                                        if x.get('required', True)),
                'projector': 'graders.action_effect_semantics.project_action_effects',
            })
    counts = Counter(row['checkName'] for row in rows)
    if counts != Counter(EFFECT_CHECK_COUNTS) or len(rows) != 65:
        raise ValueError('Actions request/effect semantic check inventory differs')
    return rows


def build_receipt(project, snapshot, result):
    if (result.get('command') != TEST_COMMAND or result.get('exitCode') != 0 or
            result.get('passed') != 30 or result.get('productRuns') != 0):
        raise ValueError('Actions request/effect semantic tests did not complete exactly')
    return {
        'schemaVersion': 1,
        'reviewId': 'actions-request-admission-effect-receipt-semantics',
        'status': 'request_effect_semantics_addressed_other_q1_pending',
        'scope': 'grader_projection_and_facility_tests_only',
        'predecessor': _ref(snapshot, PREDECESSOR),
        'checkCounts': deepcopy(EFFECT_CHECK_COUNTS),
        'affectedCheckCount': 65,
        'checkPins': _check_pins(snapshot),
        'sourcePins': [file_pin(project, path) for path in SOURCE_PATHS],
        'facilityVerification': deepcopy(result),
        'semantics': {
            'completeLedgers': ['admissions', 'sendEntries', 'requests', 'effects', 'receipts'],
            'scopeFilters': ['workspace', 'job', 'action', 'attempt', 'principal', 'target',
                             'logical action', 'capture window', 'declared write operations'],
            'boundaryFilters': ['current approval', 'resume', 'schema change', 'kill', 'stop',
                                'new-work window'],
            'successJoin': 'authoritative SUCCEEDED receipt joins one authoritative applied target effect by effect/action/attempt',
            'duplicateEffectRule': 'excess applied target effects grouped by originating request',
            'missingOrAmbiguousEvidence': 'insufficient_evidence',
            'oracleValueReadByProjector': False,
            'sameLengthWrongSemanticFixtures': True,
        },
        'remainingQ1': ('The remaining 123 Actions checks outside the positive submission, common trigger/identity, '
                        'state/authorization, and request/effect equivalence classes still require '
                        'independent correct/wrong/missing semantic fixtures.'),
        'notClaimed': ['complete_actions_q1', 'trusted_product_collector', 'actual_product_run',
                       'case_content_approval', 'formal_acceptance'],
        'actualProductRuns': 0,
        'formalAcceptanceEligible': False,
    }


def assemble(project, snapshot, result):
    if RECEIPT in snapshot:
        raise ValueError('Actions request/effect semantic receipt already exists')
    outputs = dict(snapshot)
    receipt = build_receipt(project, snapshot, result)
    outputs[RECEIPT] = json_bytes(receipt)
    readiness = _read(snapshot, READINESS)
    blockers = [x for x in readiness.get('blockers', []) if x.get('id') == 'actions_Q1']
    if len(blockers) != 1:
        raise ValueError('Expected one Actions Q1 blocker')
    blockers[0]['detail'] = receipt['remainingQ1']
    review = readiness.setdefault('actionsReview', {})
    review.update(
        Q1='PARTIALLY_ADDRESSED_326_SEMANTIC_CHECKS',
        effectSemanticChecks=65,
        totalSemanticChecks=326,
        effectSemanticReceiptRef={
            'path': RECEIPT, 'bytes': len(outputs[RECEIPT]),
            'sha256': hashlib.sha256(outputs[RECEIPT]).hexdigest(),
        },
    )
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
        raise ValueError('Actions request/effect semantic receipt is not replayable')
    readiness = _read(snapshot, READINESS)
    review = readiness.get('actionsReview', {})
    expected_ref = {
        'path': RECEIPT, 'bytes': len(snapshot[RECEIPT]),
        'sha256': hashlib.sha256(snapshot[RECEIPT]).hexdigest(),
    }
    blockers = [x for x in readiness.get('blockers', []) if x.get('id') == 'actions_Q1']
    payload_receipt = 'manifests/case-reviews/actions-payload-semantics.json'
    recovery_receipt = 'manifests/case-reviews/actions-recovery-semantics.json'
    presentation_receipt = 'manifests/case-reviews/actions-presentation-semantics.json'
    final = presentation_receipt in snapshot
    expected_q1 = ('ADDRESSED_449_SEMANTIC_CHECKS'
                   if final else 'PARTIALLY_ADDRESSED_426_SEMANTIC_CHECKS'
                   if recovery_receipt in snapshot else 'PARTIALLY_ADDRESSED_364_SEMANTIC_CHECKS'
                   if payload_receipt in snapshot else 'PARTIALLY_ADDRESSED_326_SEMANTIC_CHECKS')
    expected_total = 449 if final else 426 if recovery_receipt in snapshot else 364 if payload_receipt in snapshot else 326
    expected_detail = (None if final else _read(snapshot, recovery_receipt)['remainingQ1']
                       if recovery_receipt in snapshot else _read(snapshot, payload_receipt)['remainingQ1']
                       if payload_receipt in snapshot else receipt['remainingQ1'])
    if (review.get('Q1') != expected_q1 or
            review.get('positiveSubmissionSemanticChecks') != 30 or
            review.get('commonSemanticChecks') != 163 or
            review.get('stateSemanticChecks') != 68 or
            review.get('effectSemanticChecks') != 65 or
            review.get('totalSemanticChecks') != expected_total or
            review.get('effectSemanticReceiptRef') != expected_ref or
            len(blockers) != (0 if final else 1) or
            (not final and blockers[0].get('detail') != expected_detail)):
        raise ValueError('Actions request/effect semantic readiness differs')
    report = _read(snapshot, REPORT)
    if ((('actions_Q1' in report.get('remainingWork', [])) == final) or
            report.get('actionsDefinitionReview') != review):
        raise ValueError('Actions request/effect preparation status differs')


def run_tests(project):
    command = [sys.executable, '-m', 'pytest', 'agent-eval/tests/test_action_effect_semantics.py',
               'agent-eval/tests/test_rebuild_scenarios_actions.py', '-q']
    completed = subprocess.run(command, cwd=Path(project).resolve(), capture_output=True,
                               text=True, encoding='utf-8', errors='replace')
    match = re.search(r'(^|\s)(\d+) passed(?:,|\s)', completed.stdout)
    result = {'command': TEST_COMMAND, 'exitCode': completed.returncode,
              'passed': int(match.group(2)) if match else None, 'productRuns': 0}
    if completed.returncode or result['passed'] != 30:
        raise ValueError('Actions request/effect semantic tests failed:\n' + completed.stdout + completed.stderr)
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
    revision.update(actionsQ1='partially_addressed_326_semantic_checks', affectedChecks=65,
                    actualProductRuns=0, formalAcceptanceEligible=False)
    return revision


if __name__ == '__main__':
    import argparse
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--project', type=Path, default=Path(__file__).resolve().parents[2])
    args = parser.parse_args()
    print(json.dumps(release(args.project), ensure_ascii=False, indent=2))
