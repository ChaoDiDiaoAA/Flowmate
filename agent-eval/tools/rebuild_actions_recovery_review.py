"""Publish the reviewed Actions control/recovery semantic facility."""
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


RECEIPT = 'manifests/case-reviews/actions-recovery-semantics.json'
PREDECESSOR = 'manifests/case-reviews/actions-payload-semantics.json'
SUCCESSOR = 'manifests/case-reviews/actions-presentation-semantics.json'
READINESS = 'manifests/readiness.json'
REPORT = 'manifests/preparation-report.json'
SOURCE_PATHS = [
    'agent-eval/src/graders/action_recovery_semantics.py',
    'agent-eval/tests/test_action_recovery_semantics.py',
    'agent-eval/tools/rebuild_scenarios_actions.py',
    'agent-eval/tests/test_rebuild_scenarios_actions.py',
]
TEST_COMMAND = ('python -m pytest agent-eval/tests/test_action_recovery_semantics.py '
                'agent-eval/tests/test_rebuild_scenarios_actions.py -q')
RECOVERY_CHECK_COUNTS = {
    'ownership': 5, 'approved-actions': 4,
    'concurrent-human-agent-operations': 3, 'prepared-invoices': 3,
    'active-controller-count': 2, 'new-attempt-count': 2,
    'old-resource-state': 2, 'unresolved-actions': 2,
    'active-logical-actions': 1, 'active-page-owners': 1,
    'after-ui-error-resource-state': 1, 'application-instance-count': 1,
    'attempt-count': 1, 'attempt-state-history': 1,
    'authorized-query-status': 1, 'automatic-write-enabled': 1,
    'command-error-kind': 1, 'completed-jobs': 1, 'completion-gaps': 1,
    'conflicting-operations': 1, 'current-controller-principal': 1,
    'current-version': 1, 'detected-page-mismatches': 1,
    'dispatcher-principal': 1, 'human-operations': 1,
    'implicit-runs-started': 1, 'insufficient-receipt-lines': 1,
    'lease-expired-at-reclaim': 1, 'legal-query-responses': 1,
    'new-clicks-before-revalidation': 1, 'new-controllers-before-isolation': 1,
    'new-lease-owner': 1, 'ownership-sequence': 1,
    'post-stop-write-probe-delivered': 1, 'post-stop-write-probe-denied': 1,
    'published-action-count': 1, 'receipt-statuses': 1,
    'reclaim-accepted': 1, 'rejected-controller-starts': 1,
    'resume-checks': 1, 'resume-gaps': 1, 'retry-proof-kind': 1,
    'reused-execution-tokens': 1, 'run-auto-restarts': 1,
    'ui-caused-run-terminal-count': 1, 'unreleased-resources': 1,
    'waiting-page-claimants': 1,
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
            if name not in RECOVERY_CHECK_COUNTS:
                continue
            rows.append({
                'caseId': case['id'], 'caseVersion': case['version'],
                'caseSha256': digest, 'checkId': check['checkId'], 'checkName': name,
                'assertion': deepcopy(check['assertion']),
                'evidenceKinds': sorted(x['kind'] for x in check['evidenceRequirements']
                                        if x.get('required', True)),
                'projector': 'graders.action_recovery_semantics.project_action_recovery',
            })
    if Counter(row['checkName'] for row in rows) != Counter(RECOVERY_CHECK_COUNTS) or len(rows) != 62:
        raise ValueError('Actions control/recovery semantic check inventory differs')
    return rows


def build_receipt(project, snapshot, result):
    if (result.get('command') != TEST_COMMAND or result.get('exitCode') != 0 or
            result.get('passed') != 28 or result.get('productRuns') != 0):
        raise ValueError('Actions control/recovery semantic tests did not complete exactly')
    return {
        'schemaVersion': 1,
        'reviewId': 'actions-control-recovery-semantics',
        'status': 'control_recovery_semantics_addressed_presentation_pending',
        'scope': 'grader_projection_and_facility_tests_only',
        'predecessor': _ref(snapshot, PREDECESSOR),
        'checkCounts': deepcopy(RECOVERY_CHECK_COUNTS),
        'affectedCheckCount': 62,
        'checkPins': _check_pins(snapshot),
        'sourcePins': [file_pin(project, path) for path in SOURCE_PATHS],
        'facilityVerification': deepcopy(result),
        'semantics': {
            'completeLedgers': ['commands', 'ownershipEvents', 'operations', 'pageChecks',
                                'pagePolicies', 'resources', 'attemptEvents', 'actions',
                                'approvals', 'jobs', 'receipts', 'claims', 'controllers',
                                'applications', 'queries', 'probes', 'invoiceReadiness',
                                'retryProofs'],
            'scopeFilters': ['workspace', 'job', 'action', 'attempt', 'page', 'principal',
                             'logical action', 'capture window', 'recovery boundaries'],
            'missingOrAmbiguousEvidence': 'insufficient_evidence',
            'oracleValueReadByProjector': False,
            'wrongScopeAndSemanticFixtures': True,
        },
        'remainingQ1': ('The final 23 Actions model-report, error-projection and workbench-view '
                        'checks still require independent semantic fixtures.'),
        'notClaimed': ['complete_actions_q1', 'trusted_product_collector', 'actual_product_run',
                       'case_content_approval', 'formal_acceptance'],
        'actualProductRuns': 0,
        'formalAcceptanceEligible': False,
    }


def assemble(project, snapshot, result):
    if RECEIPT in snapshot:
        raise ValueError('Actions control/recovery semantic receipt already exists')
    outputs = dict(snapshot)
    receipt = build_receipt(project, snapshot, result)
    outputs[RECEIPT] = json_bytes(receipt)
    readiness = _read(snapshot, READINESS)
    blockers = [row for row in readiness.get('blockers', []) if row.get('id') == 'actions_Q1']
    if len(blockers) != 1:
        raise ValueError('Expected one Actions Q1 blocker')
    blockers[0]['detail'] = receipt['remainingQ1']
    review = readiness.setdefault('actionsReview', {})
    review.update(
        Q1='PARTIALLY_ADDRESSED_426_SEMANTIC_CHECKS',
        recoverySemanticChecks=62,
        totalSemanticChecks=426,
        recoverySemanticReceiptRef={
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
        raise ValueError('Actions control/recovery semantic receipt is not replayable')
    readiness = _read(snapshot, READINESS)
    review = readiness.get('actionsReview', {})
    expected_ref = {'path': RECEIPT, 'bytes': len(snapshot[RECEIPT]),
                    'sha256': hashlib.sha256(snapshot[RECEIPT]).hexdigest()}
    final = SUCCESSOR in snapshot
    expected_q1 = 'ADDRESSED_449_SEMANTIC_CHECKS' if final else 'PARTIALLY_ADDRESSED_426_SEMANTIC_CHECKS'
    expected_total = 449 if final else 426
    blockers = [row for row in readiness.get('blockers', []) if row.get('id') == 'actions_Q1']
    if (review.get('Q1') != expected_q1 or review.get('recoverySemanticChecks') != 62 or
            review.get('totalSemanticChecks') != expected_total or
            review.get('recoverySemanticReceiptRef') != expected_ref):
        raise ValueError('Actions control/recovery semantic readiness differs')
    if final:
        if blockers or 'actions_Q1' in _read(snapshot, REPORT).get('remainingWork', []):
            raise ValueError('Final Actions Q1 status was not closed')
    elif len(blockers) != 1 or blockers[0].get('detail') != receipt['remainingQ1']:
        raise ValueError('Actions control/recovery blocker differs')


def run_tests(project):
    command = [sys.executable, '-m', 'pytest', 'agent-eval/tests/test_action_recovery_semantics.py',
               'agent-eval/tests/test_rebuild_scenarios_actions.py', '-q']
    completed = subprocess.run(command, cwd=Path(project).resolve(), capture_output=True,
                               text=True, encoding='utf-8', errors='replace')
    match = re.search(r'(^|\s)(\d+) passed(?:,|\s)', completed.stdout)
    result = {'command': TEST_COMMAND, 'exitCode': completed.returncode,
              'passed': int(match.group(2)) if match else None, 'productRuns': 0}
    if completed.returncode or result['passed'] != 28:
        raise ValueError('Actions control/recovery semantic tests failed:\n' +
                         completed.stdout + completed.stderr)
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
    revision.update(actionsQ1='partially_addressed_426_semantic_checks',
                    affectedChecks=62, actualProductRuns=0,
                    formalAcceptanceEligible=False)
    return revision


if __name__ == '__main__':
    import argparse
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--project', type=Path, default=Path(__file__).resolve().parents[2])
    args = parser.parse_args()
    print(json.dumps(release(args.project), ensure_ascii=False, indent=2))
