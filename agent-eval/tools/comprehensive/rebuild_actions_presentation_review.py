"""Publish the final Actions model-report, error and view semantic facility."""
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


RECEIPT = 'manifests/case-reviews/actions-presentation-semantics.json'
PREDECESSOR = 'manifests/case-reviews/actions-recovery-semantics.json'
READINESS = 'manifests/readiness.json'
REPORT = 'manifests/preparation-report.json'
SOURCE_PATHS = [
    'agent-eval/src/graders/action_presentation_semantics.py',
    'agent-eval/tests/comprehensive/test_action_presentation_semantics.py',
    'agent-eval/tools/comprehensive/rebuild_scenarios_actions.py',
    'agent-eval/tests/comprehensive/test_rebuild_scenarios_actions.py',
]
TEST_COMMAND = ('python -m pytest agent-eval/tests/comprehensive/test_action_presentation_semantics.py '
                'agent-eval/tests/comprehensive/test_rebuild_scenarios_actions.py -q')
PRESENTATION_CHECK_COUNTS = {
    'model-reported-state': 3, 'error-descriptor-chain': 2,
    'view-action-status': 2, 'view-job-status': 2,
    'diagnostic-gaps': 1, 'error-caused-job-rejections': 1,
    'unsafe-error-field-count': 1, 'desktop-session-title': 1,
    'visible-active-step-ids': 1, 'waiting-reasons': 1,
    'step-view-facts': 1, 'unauthorized-view-records': 1,
    'electron-isolation': 1, 'view-approval-status': 1,
    'safe-error-projection': 1, 'view-attempt-status': 1,
    'view-run-status': 1, 'view-waiting-owner': 1,
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
            if name not in PRESENTATION_CHECK_COUNTS:
                continue
            rows.append({
                'caseId': case['id'], 'caseVersion': case['version'],
                'caseSha256': digest, 'checkId': check['checkId'], 'checkName': name,
                'assertion': deepcopy(check['assertion']),
                'evidenceKinds': sorted(x['kind'] for x in check['evidenceRequirements']
                                        if x.get('required', True)),
                'projector': 'graders.action_presentation_semantics.project_action_presentation',
            })
    if Counter(row['checkName'] for row in rows) != Counter(PRESENTATION_CHECK_COUNTS) or len(rows) != 23:
        raise ValueError('Actions presentation semantic check inventory differs')
    return rows


def build_receipt(project, snapshot, result):
    if (result.get('command') != TEST_COMMAND or result.get('exitCode') != 0 or
            result.get('passed') != 28 or result.get('productRuns') != 0):
        raise ValueError('Actions presentation semantic tests did not complete exactly')
    return {
        'schemaVersion': 1,
        'reviewId': 'actions-model-error-workbench-semantics',
        'status': 'all_actions_semantic_facilities_addressed',
        'scope': 'grader_projection_and_facility_tests_only',
        'predecessor': _ref(snapshot, PREDECESSOR),
        'checkCounts': deepcopy(PRESENTATION_CHECK_COUNTS),
        'affectedCheckCount': 23,
        'checkPins': _check_pins(snapshot),
        'sourcePins': [file_pin(project, path) for path in SOURCE_PATHS],
        'facilityVerification': deepcopy(result),
        'semantics': {
            'completeLedgers': ['modelReports', 'diagnostics', 'errors', 'views', 'steps',
                                'appConfigs', 'jobTransitions'],
            'scopeFilters': ['workspace', 'job', 'action', 'attempt', 'capture window'],
            'modelReportRule': 'derive only from grounded report facts; unsupported combinations stay incomplete',
            'errorRule': 'preserve stable descriptor chain and reject unsafe nested UI fields',
            'missingOrAmbiguousEvidence': 'insufficient_evidence',
            'oracleValueReadByProjector': False,
            'unsafeNestedErrorFixtures': True,
        },
        'remainingQ1': None,
        'notClaimed': ['trusted_product_collector', 'actual_product_run',
                       'case_content_approval', 'formal_acceptance'],
        'actualProductRuns': 0,
        'formalAcceptanceEligible': False,
    }


def assemble(project, snapshot, result):
    if RECEIPT in snapshot:
        raise ValueError('Actions presentation semantic receipt already exists')
    outputs = dict(snapshot)
    receipt = build_receipt(project, snapshot, result)
    outputs[RECEIPT] = json_bytes(receipt)
    readiness = _read(snapshot, READINESS)
    blockers = readiness.get('blockers', [])
    if sum(row.get('id') == 'actions_Q1' for row in blockers) != 1:
        raise ValueError('Expected one Actions Q1 blocker')
    readiness['blockers'] = [row for row in blockers if row.get('id') != 'actions_Q1']
    review = readiness.setdefault('actionsReview', {})
    review.update(
        Q1='ADDRESSED_449_SEMANTIC_CHECKS',
        presentationSemanticChecks=23,
        totalSemanticChecks=449,
        presentationSemanticReceiptRef={
            'path': RECEIPT, 'bytes': len(outputs[RECEIPT]),
            'sha256': hashlib.sha256(outputs[RECEIPT]).hexdigest(),
        },
    )
    outputs[READINESS] = json_bytes(readiness)
    report = _read(snapshot, REPORT)
    if report.get('remainingWork', []).count('actions_Q1') != 1:
        raise ValueError('Preparation report must contain one Actions Q1 item before closure')
    report['remainingWork'] = [item for item in report['remainingWork'] if item != 'actions_Q1']
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
        raise ValueError('Actions presentation semantic receipt is not replayable')
    readiness = _read(snapshot, READINESS)
    review = readiness.get('actionsReview', {})
    expected_ref = {'path': RECEIPT, 'bytes': len(snapshot[RECEIPT]),
                    'sha256': hashlib.sha256(snapshot[RECEIPT]).hexdigest()}
    if (review.get('Q1') != 'ADDRESSED_449_SEMANTIC_CHECKS' or
            review.get('positiveSubmissionSemanticChecks') != 30 or
            review.get('commonSemanticChecks') != 163 or
            review.get('stateSemanticChecks') != 68 or
            review.get('effectSemanticChecks') != 65 or
            review.get('payloadSemanticChecks') != 38 or
            review.get('recoverySemanticChecks') != 62 or
            review.get('presentationSemanticChecks') != 23 or
            review.get('totalSemanticChecks') != 449 or
            review.get('presentationSemanticReceiptRef') != expected_ref):
        raise ValueError('Final Actions semantic readiness differs')
    if any(row.get('id') == 'actions_Q1' for row in readiness.get('blockers', [])):
        raise ValueError('Final Actions readiness retains Q1 blocker')
    report = _read(snapshot, REPORT)
    if ('actions_Q1' in report.get('remainingWork', []) or
            report.get('actionsDefinitionReview') != review):
        raise ValueError('Final Actions preparation status differs')


def run_tests(project):
    command = [sys.executable, '-m', 'pytest', 'agent-eval/tests/comprehensive/test_action_presentation_semantics.py',
               'agent-eval/tests/comprehensive/test_rebuild_scenarios_actions.py', '-q']
    completed = subprocess.run(command, cwd=Path(project).resolve(), capture_output=True,
                               text=True, encoding='utf-8', errors='replace')
    match = re.search(r'(^|\s)(\d+) passed(?:,|\s)', completed.stdout)
    result = {'command': TEST_COMMAND, 'exitCode': completed.returncode,
              'passed': int(match.group(2)) if match else None, 'productRuns': 0}
    if completed.returncode or result['passed'] != 28:
        raise ValueError('Actions presentation semantic tests failed:\n' +
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
    revision.update(actionsQ1='addressed_449_semantic_checks', affectedChecks=23,
                    actualProductRuns=0, formalAcceptanceEligible=False)
    return revision


if __name__ == '__main__':
    import argparse
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--project', type=Path, default=Path(__file__).resolve().parents[3])
    args = parser.parse_args()
    print(json.dumps(release(args.project), ensure_ascii=False, indent=2))
