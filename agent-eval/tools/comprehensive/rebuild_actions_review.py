"""Publish the reviewed Actions S1 definition repair without claiming a run.

The receipt binds the two revised Cases, their authored source/tests and the
facility-test result.  It resolves only the specific definition/test gap.  It
does not approve all Actions content, implement collectors, or create a product
Trial.
"""
from copy import deepcopy
import hashlib
import json
from pathlib import Path
import re
import subprocess
import sys

from rebuild_case_release import canonical_digest
from rebuild_bindings import CURRENT_BINDING_REVISION
from rebuild_dataset import json_bytes
from rebuild_source_revision import reindex
from rebuild_sources import file_pin


RECEIPT = 'manifests/case-reviews/actions-s1.json'
SEMANTIC_RECEIPT = 'manifests/case-reviews/actions-positive-submission-semantics.json'
READINESS = 'manifests/readiness.json'
REPORT = 'manifests/preparation-report.json'
SOURCE = 'agent-eval/tools/comprehensive/rebuild_scenarios_actions.py'
TEST = 'agent-eval/tests/comprehensive/test_rebuild_scenarios_actions.py'
CASES = {
    'fresh-act-submit-cross-job': {
        'version': 2000 + CURRENT_BINDING_REVISION,
        'checks': {
            'admitted-submit-count': 1,
            'submit-send-entry-count': 1,
            'submit-request-count': 1,
            'submit-effect-count': 1,
            'submit-success-count': 1,
            'undeclared-write-request-count': 0,
        },
        'control': 'fresh-act-submit-distinct-objects',
    },
    'fresh-act-submit-distinct-objects': {
        'version': 2000 + CURRENT_BINDING_REVISION,
        'checks': {
            'admitted-submit-count': 2,
            'submit-send-entry-count': 2,
            'submit-request-count': 2,
            'submit-effect-count': 2,
            'submit-success-count': 2,
            'undeclared-write-request-count': 0,
        },
        'control': None,
    },
}


def _read(snapshot, path):
    return json.loads(snapshot[path].decode('utf-8-sig'))


def _case_by_id(snapshot, identity):
    matches = [_read(snapshot, path) for path in snapshot if path.startswith('cases/actions/')
               and _read(snapshot, path).get('id') == identity]
    if len(matches) != 1:
        raise ValueError('Actions S1 Case identity is missing or duplicated: ' + identity)
    return matches[0]


def _validate_case(case, expected, by_id):
    if case.get('version') != expected['version'] or case.get('provenance', {}).get('authoredVersion') != 2:
        raise ValueError('Actions S1 Case revision differs')
    checks = {x['checkId'].rsplit(':', 1)[-1]: x for x in case['oracle']['checks']}
    for name, value in expected['checks'].items():
        check = checks.get(name)
        if (not check or check.get('assertion', {}).get('op') != 'eq' or
                check['assertion'].get('value') != value or not check.get('required') or
                not check.get('evidenceRequirements')):
            raise ValueError('Actions S1 direct check differs: ' + case['id'] + ':' + name)
    control_id = expected['control']
    if control_id is None:
        if case.get('normalControlRefs'):
            raise ValueError('Distinct-object legal control cannot depend on another control')
    else:
        refs = case.get('normalControlRefs', [])
        control = by_id[control_id]
        if (len(refs) != 1 or refs[0].get('caseId') != control_id or
                refs[0].get('version') != control['version'] or
                refs[0].get('caseSha256') != canonical_digest(control)):
            raise ValueError('Cross-Job condition does not pin the revised legal control')


def build_receipt(project, snapshot, test_result):
    project = Path(project).resolve()
    cases = {identity: _case_by_id(snapshot, identity) for identity in CASES}
    for identity, expected in CASES.items():
        _validate_case(cases[identity], expected, cases)
    if (test_result.get('exitCode') != 0 or test_result.get('passed') != 23 or
            test_result.get('command') != 'python -m pytest agent-eval/tests/comprehensive/test_rebuild_scenarios_actions.py -q'):
        raise ValueError('Actions facility verification did not complete exactly')
    return {
        'schemaVersion': 1,
        'reviewId': 'actions-s1-cross-job-positive-control',
        'status': 'addressed_definition_and_facility_tests',
        'finding': 'Distinct-object legal control must count admissions, send entries, requests, effects and authoritative successes across all Jobs and paths.',
        'scope': 'definition_and_grader_facility_only',
        'notClaimed': ['complete_actions_content_review', 'trusted_product_collector',
                       'actual_product_run', 'formal_acceptance'],
        'casePins': [{'id': identity, 'version': case['version'],
                      'caseSha256': canonical_digest(case),
                      'checkExpectations': deepcopy(CASES[identity]['checks'])}
                     for identity, case in sorted(cases.items())],
        'authorPins': [file_pin(project, SOURCE), file_pin(project, TEST)],
        'facilityVerification': deepcopy(test_result),
        'actualProductRuns': 0,
        'formalAcceptanceEligible': False,
    }


def assemble(project, snapshot, test_result):
    if RECEIPT in snapshot:
        raise ValueError('Actions S1 receipt already exists')
    outputs = dict(snapshot)
    receipt = build_receipt(project, snapshot, test_result)
    outputs[RECEIPT] = json_bytes(receipt)
    readiness = _read(snapshot, READINESS)
    blockers = readiness.get('blockers', [])
    if sum(x.get('id') == 'actions_S1' for x in blockers) != 1:
        raise ValueError('Expected one unresolved Actions S1 blocker')
    readiness['blockers'] = [x for x in blockers if x.get('id') != 'actions_S1']
    readiness.setdefault('actionsReview', {})['S1'] = 'ADDRESSED_DEFINITION_AND_FACILITY_TESTS'
    readiness['actionsReview']['Q1'] = 'NOT_ADDRESSED'
    readiness['actionsReview']['receiptRef'] = {
        'path': RECEIPT, 'bytes': len(outputs[RECEIPT]),
        'sha256': hashlib.sha256(outputs[RECEIPT]).hexdigest(),
    }
    outputs[READINESS] = json_bytes(readiness)
    report = _read(snapshot, REPORT)
    if report.get('remainingWork', []).count('actions_S1') != 1:
        raise ValueError('Preparation report does not contain exactly one Actions S1 blocker')
    report['remainingWork'] = [x for x in report['remainingWork'] if x != 'actions_S1']
    report['actionsDefinitionReview'] = deepcopy(readiness['actionsReview'])
    outputs[REPORT] = json_bytes(report)
    reindex(outputs)
    validate_snapshot(project, outputs)
    return outputs


def validate_snapshot(project, snapshot):
    if RECEIPT not in snapshot:
        return
    receipt = _read(snapshot, RECEIPT)
    if set(receipt) != {'schemaVersion', 'reviewId', 'status', 'finding', 'scope', 'notClaimed',
                       'casePins', 'authorPins', 'facilityVerification', 'actualProductRuns',
                       'formalAcceptanceEligible'}:
        raise ValueError('Actions S1 receipt shape differs')
    expected = build_receipt(project, snapshot, receipt['facilityVerification'])
    # The immutable S1 receipt pins the author/test bytes that established S1.
    # A later reviewed facility revision may change those files without
    # rewriting history, but only through the separately validated successor.
    if receipt.get('authorPins') != expected.get('authorPins'):
        if SEMANTIC_RECEIPT not in snapshot:
            raise ValueError('Actions S1 author drift lacks a reviewed successor')
        expected['authorPins'] = receipt['authorPins']
    if receipt != expected:
        raise ValueError('Actions S1 receipt is not replayable from current material')
    readiness = _read(snapshot, READINESS)
    presentation_receipt = 'manifests/case-reviews/actions-presentation-semantics.json'
    recovery_receipt = 'manifests/case-reviews/actions-recovery-semantics.json'
    final = presentation_receipt in snapshot
    expected_q1 = ('ADDRESSED_449_SEMANTIC_CHECKS'
                   if final else
                   'PARTIALLY_ADDRESSED_426_SEMANTIC_CHECKS'
                   if recovery_receipt in snapshot else
                   'PARTIALLY_ADDRESSED_364_SEMANTIC_CHECKS'
                   if 'manifests/case-reviews/actions-payload-semantics.json' in snapshot else
                   'PARTIALLY_ADDRESSED_326_SEMANTIC_CHECKS'
                   if 'manifests/case-reviews/actions-effect-semantics.json' in snapshot else
                   'PARTIALLY_ADDRESSED_261_SEMANTIC_CHECKS'
                   if 'manifests/case-reviews/actions-state-semantics.json' in snapshot else
                   'PARTIALLY_ADDRESSED_193_SEMANTIC_CHECKS'
                   if 'manifests/case-reviews/actions-common-semantics.json' in snapshot else
                   'PARTIALLY_ADDRESSED_POSITIVE_SUBMISSION_SEMANTICS'
                   if SEMANTIC_RECEIPT in snapshot else 'NOT_ADDRESSED')
    if (readiness.get('actionsReview', {}).get('S1') != 'ADDRESSED_DEFINITION_AND_FACILITY_TESTS' or
            readiness['actionsReview'].get('Q1') != expected_q1 or
            any(x.get('id') == 'actions_S1' for x in readiness.get('blockers', [])) or
            (any(x.get('id') == 'actions_Q1' for x in readiness.get('blockers', [])) == final)):
        raise ValueError('Actions readiness does not match its scoped receipt')
    ref = readiness['actionsReview'].get('receiptRef')
    if ref != {'path': RECEIPT, 'bytes': len(snapshot[RECEIPT]),
               'sha256': hashlib.sha256(snapshot[RECEIPT]).hexdigest()}:
        raise ValueError('Actions readiness receipt pin differs')
    report = _read(snapshot, REPORT)
    if ('actions_S1' in report.get('remainingWork', []) or
            (('actions_Q1' in report.get('remainingWork', [])) == final) or
            report.get('actionsDefinitionReview') != readiness['actionsReview']):
        raise ValueError('Actions preparation status differs from readiness')


def run_facility_tests(project):
    command = [sys.executable, '-m', 'pytest', 'agent-eval/tests/comprehensive/test_rebuild_scenarios_actions.py', '-q']
    completed = subprocess.run(command, cwd=Path(project).resolve(), capture_output=True,
                               text=True, encoding='utf-8', errors='replace')
    match = re.search(r'(^|\s)(\d+) passed(?:,|\s)', completed.stdout)
    result = {'command': 'python -m pytest agent-eval/tests/comprehensive/test_rebuild_scenarios_actions.py -q',
              'exitCode': completed.returncode,
              'passed': int(match.group(2)) if match else None,
              'productRuns': 0}
    if completed.returncode or result['passed'] != 23:
        raise ValueError('Actions facility tests failed:\n' + completed.stdout + completed.stderr)
    return result


def release(project):
    from rebuild_dataset import verify_asset_snapshot
    from rebuild_staging import candidate_lock, read_candidate, revise_candidate
    project = Path(project).resolve()
    test_result = run_facility_tests(project)
    with candidate_lock(project):
        snapshot = read_candidate(project)
        verify_asset_snapshot(project, snapshot)
    outputs = assemble(project, snapshot, test_result)
    verify_asset_snapshot(project, outputs)
    result = revise_candidate(project, snapshot, outputs)
    result.update(actionsS1='addressed_definition_and_facility_tests', actionsQ1='not_addressed',
                  actualProductRuns=0, formalAcceptanceEligible=False)
    return result


if __name__ == '__main__':
    import argparse
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--project', type=Path, default=Path(__file__).resolve().parents[3])
    args = parser.parse_args()
    print(json.dumps(release(args.project), ensure_ascii=False, indent=2))
