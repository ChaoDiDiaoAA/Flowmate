"""Publish the reviewed Actions payload/freeze semantic facility."""
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


RECEIPT = 'manifests/case-reviews/actions-payload-semantics.json'
PREDECESSOR = 'manifests/case-reviews/actions-effect-semantics.json'
READINESS = 'manifests/readiness.json'
REPORT = 'manifests/preparation-report.json'
SOURCE_PATHS = [
    'agent-eval/src/graders/action_payload_semantics.py',
    'agent-eval/tests/comprehensive/test_action_payload_semantics.py',
    'agent-eval/tools/comprehensive/rebuild_scenarios_actions.py',
    'agent-eval/tests/comprehensive/test_rebuild_scenarios_actions.py',
]
TEST_COMMAND = ('python -m pytest agent-eval/tests/comprehensive/test_action_payload_semantics.py '
                'agent-eval/tests/comprehensive/test_rebuild_scenarios_actions.py -q')
PAYLOAD_CHECK_COUNTS = {
    'actual-environment': 1, 'actual-path': 2, 'approval-record-count': 1,
    'assessment-versions': 1, 'attachment-digest-conflicts': 1,
    'attachment-identity': 1, 'candidate-invoice-number': 1,
    'canonical-logical-keys': 2, 'distinct-frozen-actions': 3,
    'effect-types': 1, 'frozen-basis-components': 1,
    'idempotency-identities': 1, 'mapped-fields': 1, 'missing-target-fields': 2,
    'page-payload-mismatches': 1, 'payload-hash-mismatch-count': 1,
    'payload-invoice-number': 1, 'preview-target': 2,
    'query-semantic-mismatches': 1, 'request-or-page-payload-mismatches': 1,
    'request-payload-mismatches': 1, 'review-and-approval-actors': 1,
    'revision-ids': 2, 'revision-memo': 1, 'revision-total': 2,
    'role-grant-authority': 1, 'target-basis-mismatch-count': 1,
    'target-extra-fields': 1, 'total-minor': 1, 'unmapped-source-fields': 1,
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
            if name not in PAYLOAD_CHECK_COUNTS:
                continue
            rows.append({
                'caseId': case['id'], 'caseVersion': case['version'],
                'caseSha256': digest, 'checkId': check['checkId'],
                'checkName': name, 'assertion': deepcopy(check['assertion']),
                'evidenceKinds': sorted(x['kind'] for x in check['evidenceRequirements']
                                        if x.get('required', True)),
                'projector': 'graders.action_payload_semantics.project_action_payload',
            })
    counts = Counter(row['checkName'] for row in rows)
    if counts != Counter(PAYLOAD_CHECK_COUNTS) or len(rows) != 38:
        raise ValueError('Actions payload semantic check inventory differs')
    return rows


def build_receipt(project, snapshot, result):
    if (result.get('command') != TEST_COMMAND or result.get('exitCode') != 0 or
            result.get('passed') != 30 or result.get('productRuns') != 0):
        raise ValueError('Actions payload semantic tests did not complete exactly')
    return {
        'schemaVersion': 1,
        'reviewId': 'actions-payload-freeze-target-semantics',
        'status': 'payload_semantics_addressed_other_q1_pending',
        'scope': 'grader_projection_and_facility_tests_only',
        'predecessor': _ref(snapshot, PREDECESSOR),
        'checkCounts': deepcopy(PAYLOAD_CHECK_COUNTS),
        'affectedCheckCount': 38,
        'checkPins': _check_pins(snapshot),
        'sourcePins': [file_pin(project, path) for path in SOURCE_PATHS],
        'facilityVerification': deepcopy(result),
        'semantics': {
            'completeLedgers': ['revisions', 'assessments', 'actions', 'payloads',
                                'requests', 'pages', 'artifacts', 'approvals',
                                'roleGrants', 'queryResults'],
            'recomputedValues': ['field mapping', 'decimal minor units', 'canonical JSON hash',
                                 'attachment byte identity', 'required/extra fields',
                                 'request/page payload equality', 'target/basis binding',
                                 'logical and idempotency identities'],
            'scopeFilters': ['workspace', 'action', 'capture window', 'target contract'],
            'missingOrAmbiguousEvidence': 'insufficient_evidence',
            'oracleValueReadByProjector': False,
            'sameShapeWrongSemanticFixtures': True,
        },
        'remainingQ1': ('The remaining 85 Actions checks outside the positive submission, common trigger/identity, '
                        'state/authorization, request/effect, and payload/freeze equivalence classes '
                        'still require independent correct/wrong/missing semantic fixtures.'),
        'notClaimed': ['complete_actions_q1', 'trusted_product_collector', 'actual_product_run',
                       'case_content_approval', 'formal_acceptance'],
        'actualProductRuns': 0,
        'formalAcceptanceEligible': False,
    }


def assemble(project, snapshot, result):
    if RECEIPT in snapshot:
        raise ValueError('Actions payload semantic receipt already exists')
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
        Q1='PARTIALLY_ADDRESSED_364_SEMANTIC_CHECKS',
        payloadSemanticChecks=38,
        totalSemanticChecks=364,
        payloadSemanticReceiptRef={
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
        raise ValueError('Actions payload semantic receipt is not replayable')
    readiness = _read(snapshot, READINESS)
    review = readiness.get('actionsReview', {})
    expected_ref = {'path': RECEIPT, 'bytes': len(snapshot[RECEIPT]),
                    'sha256': hashlib.sha256(snapshot[RECEIPT]).hexdigest()}
    blockers = [x for x in readiness.get('blockers', []) if x.get('id') == 'actions_Q1']
    recovery_receipt = 'manifests/case-reviews/actions-recovery-semantics.json'
    presentation_receipt = 'manifests/case-reviews/actions-presentation-semantics.json'
    final = presentation_receipt in snapshot
    expected_q1 = ('ADDRESSED_449_SEMANTIC_CHECKS' if final else
                   'PARTIALLY_ADDRESSED_426_SEMANTIC_CHECKS' if recovery_receipt in snapshot else
                   'PARTIALLY_ADDRESSED_364_SEMANTIC_CHECKS')
    expected_total = 449 if final else 426 if recovery_receipt in snapshot else 364
    expected_detail = (None if final else _read(snapshot, recovery_receipt)['remainingQ1']
                       if recovery_receipt in snapshot else receipt['remainingQ1'])
    if (review.get('Q1') != expected_q1 or
            review.get('positiveSubmissionSemanticChecks') != 30 or
            review.get('commonSemanticChecks') != 163 or
            review.get('stateSemanticChecks') != 68 or
            review.get('effectSemanticChecks') != 65 or
            review.get('payloadSemanticChecks') != 38 or
            review.get('totalSemanticChecks') != expected_total or
            review.get('payloadSemanticReceiptRef') != expected_ref or
            len(blockers) != (0 if final else 1) or
            (not final and blockers[0].get('detail') != expected_detail)):
        raise ValueError('Actions payload semantic readiness differs')
    report = _read(snapshot, REPORT)
    if ((('actions_Q1' in report.get('remainingWork', [])) == final) or
            report.get('actionsDefinitionReview') != review):
        raise ValueError('Actions payload preparation status differs')


def run_tests(project):
    command = [sys.executable, '-m', 'pytest', 'agent-eval/tests/comprehensive/test_action_payload_semantics.py',
               'agent-eval/tests/comprehensive/test_rebuild_scenarios_actions.py', '-q']
    completed = subprocess.run(command, cwd=Path(project).resolve(), capture_output=True,
                               text=True, encoding='utf-8', errors='replace')
    match = re.search(r'(^|\s)(\d+) passed(?:,|\s)', completed.stdout)
    result = {'command': TEST_COMMAND, 'exitCode': completed.returncode,
              'passed': int(match.group(2)) if match else None, 'productRuns': 0}
    if completed.returncode or result['passed'] != 30:
        raise ValueError('Actions payload semantic tests failed:\n' + completed.stdout + completed.stderr)
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
    revision.update(actionsQ1='partially_addressed_364_semantic_checks', affectedChecks=38,
                    actualProductRuns=0, formalAcceptanceEligible=False)
    return revision


if __name__ == '__main__':
    import argparse
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--project', type=Path, default=Path(__file__).resolve().parents[3])
    args = parser.parse_args()
    print(json.dumps(release(args.project), ensure_ascii=False, indent=2))
