"""Publish replayable facility receipts for extraction and paired-Trial grading.

This resolves only the offline grader/receipt-validator implementation gap. It
does not mark Gold reviewed, execute the product, or create Trial evidence.
"""
from copy import deepcopy
import hashlib
import json
from pathlib import Path
import re
import subprocess
import sys

from rebuild_case_release import canonical_digest
from rebuild_dataset import json_bytes
from rebuild_sources import file_pin


RECEIPT = 'manifests/case-reviews/grader-facilities.json'
READINESS = 'manifests/readiness.json'
REPORT = 'manifests/preparation-report.json'
BLOCKER = 'schema3_extraction_grader_and_paired_trials'
SOURCES = [
    'agent-eval/src/graders/observations.py',
    'agent-eval/src/runner/evidence.py',
    'agent-eval/tools/rebuild_extraction.py',
    'agent-eval/tools/rebuild_cases.py',
    'agent-eval/tests/test_rebuild_extraction.py',
    'agent-eval/tests/test_rebuild_scenarios_subagents.py',
    'agent-eval/tests/test_offline_facilities.py',
    'agent-eval/tests/test_alignment_regressions.py',
    'agent-eval/tools/test_gold_clarification.py',
]
COMMAND = ('python -m pytest agent-eval/tests/test_rebuild_extraction.py '
           'agent-eval/tests/test_offline_facilities.py::GradingTests '
           'agent-eval/tests/test_rebuild_scenarios_subagents.py '
           'agent-eval/tests/test_alignment_regressions.py::EvidenceRegressions '
           'agent-eval/tools/test_gold_clarification.py -q')


def _read(snapshot, path):
    return json.loads(snapshot[path])


def _cases(snapshot):
    return [json.loads(raw) for path, raw in sorted(snapshot.items()) if path.startswith('cases/')]


def _validate_cases(snapshot):
    cases = _cases(snapshot)
    extraction = [case for case in cases if case.get('scenarioProtocol') == {
        'kind': 'fresh_invoice_extraction', 'version': 1}]
    if len(extraction) != 100:
        raise ValueError('Expected exactly 100 current extraction Cases')
    expected_metrics = {'MOD-11.fields', 'MOD-11.lines', 'MOD-11.evidence', 'MOD-11.uncertainty'}
    for case in extraction:
        checks = case['oracle']['checks']
        if ({item.get('metricId') for item in checks} != expected_metrics
                or any(item.get('ruleStatus') != 'implemented' for item in checks)
                or case.get('scoring', {}).get('implementationStatus') != 'available'
                or case['scoring'].get('graderContractVersion') != 3
                or 'schema3_field_and_line_grader' in case['executionEligibility']['missing']):
            raise ValueError('Extraction grader contract is incomplete')
    paired = [case for case in cases if case.get('comparisonRefs')]
    if {case['id'] for case in paired} != {'fresh-sub-read-evidence', 'fresh-sub-read-conflict'}:
        raise ValueError('Unexpected paired-Trial Case membership')
    for case in paired:
        comparison_ids = {check_id for ref in case['comparisonRefs'] for check_id in ref['checkIds']}
        checks = {item['checkId']: item for item in case['oracle']['checks']}
        if ('trusted_paired_trial_receipt_validation' in case['executionEligibility']['missing']
                or any(checks[check_id].get('ruleStatus') != 'implemented'
                       or checks[check_id].get('graderRequirement')
                       != 'trusted_paired_independent_trial_receipts'
                       for check_id in comparison_ids)):
            raise ValueError('Paired-Trial grader contract is incomplete')
    selected = extraction + paired
    return [{'id': case['id'], 'version': case['version'],
             'sha256': canonical_digest(case)} for case in sorted(selected, key=lambda item: item['id'])]


def _reindex(outputs):
    outputs['manifests/inventory.json'] = json_bytes({'schemaVersion': 3, 'files': [
        {'path': path, 'bytes': len(raw), 'sha256': hashlib.sha256(raw).hexdigest()}
        for path, raw in sorted(outputs.items()) if path != 'manifests/inventory.json']})


def build_receipt(project, snapshot, facility):
    return {'schemaVersion': 3, 'reviewId': 'grader-facilities',
            'status': 'OFFLINE_GRADERS_AND_RECEIPT_VALIDATOR_AVAILABLE',
            'scope': ['schema3_extraction_fields_lines_evidence_uncertainty',
                      'paired_independent_trial_receipt_validation'],
            'notClaimed': ['human_gold_review', 'actual_product_adapter',
                           'actual_trial_execution', 'benchmark_score', 'formal_acceptance'],
            'casePins': _validate_cases(snapshot),
            'sourcePins': [file_pin(project, path) for path in SOURCES],
            'facilityVerification': deepcopy(facility), 'actualProductRuns': 0,
            'formalAcceptanceEligible': False}


def assemble(project, snapshot, facility):
    if RECEIPT in snapshot:
        raise ValueError('Grader facility receipt already exists')
    outputs = dict(snapshot)
    outputs[RECEIPT] = json_bytes(build_receipt(project, snapshot, facility))
    readiness = _read(snapshot, READINESS)
    blockers = readiness.get('blockers', [])
    if sum(item.get('id') == BLOCKER for item in blockers) != 1:
        raise ValueError('Expected exactly one grader facility blocker')
    readiness['blockers'] = [item for item in blockers if item.get('id') != BLOCKER]
    readiness['graderFacilities'] = {
        'extraction': 'AVAILABLE_REQUIRES_REVIEWED_GOLD_AND_PRODUCT_EVIDENCE',
        'pairedTrials': 'VALIDATOR_AVAILABLE_REQUIRES_TWO_ACTUAL_TRIALS',
        'receiptRef': {'path': RECEIPT, 'bytes': len(outputs[RECEIPT]),
                       'sha256': hashlib.sha256(outputs[RECEIPT]).hexdigest()}}
    outputs[READINESS] = json_bytes(readiness)
    report = _read(snapshot, REPORT)
    if report.get('remainingWork', []).count(BLOCKER) != 1:
        raise ValueError('Preparation report grader blocker differs')
    report['remainingWork'] = [item for item in report['remainingWork'] if item != BLOCKER]
    report['graderFacilities'] = deepcopy(readiness['graderFacilities'])
    outputs[REPORT] = json_bytes(report)
    _reindex(outputs)
    validate_snapshot(project, outputs)
    return outputs


def refresh_existing(project, snapshot, facility=None):
    """Replace only an existing replay receipt after a pinned source changes."""
    if RECEIPT not in snapshot:
        raise ValueError('Grader facility receipt does not exist')
    previous = _read(snapshot, RECEIPT)
    if (previous.get('actualProductRuns') != 0 or
            previous.get('formalAcceptanceEligible') is not False):
        raise ValueError('Existing grader receipt contains unsupported product claims')
    outputs = dict(snapshot)
    outputs[RECEIPT] = json_bytes(build_receipt(
        project, outputs, facility or previous.get('facilityVerification')))
    readiness = _read(outputs, READINESS)
    if any(item.get('id') == BLOCKER for item in readiness.get('blockers', [])):
        raise ValueError('Existing grader receipt still has its resolved blocker')
    readiness['graderFacilities']['receiptRef'] = {
        'path': RECEIPT, 'bytes': len(outputs[RECEIPT]),
        'sha256': hashlib.sha256(outputs[RECEIPT]).hexdigest()}
    outputs[READINESS] = json_bytes(readiness)
    report = _read(outputs, REPORT)
    report['graderFacilities'] = deepcopy(readiness['graderFacilities'])
    outputs[REPORT] = json_bytes(report)
    _reindex(outputs)
    validate_snapshot(project, outputs)
    return outputs


def validate_snapshot(project, snapshot):
    if RECEIPT not in snapshot:
        return
    receipt = _read(snapshot, RECEIPT)
    if receipt != build_receipt(project, snapshot, receipt.get('facilityVerification')):
        raise ValueError('Grader facility receipt is not replayable')
    verification = receipt['facilityVerification']
    if (verification != {'command': COMMAND, 'exitCode': 0, 'passed': 43, 'productRuns': 0}
            or receipt['actualProductRuns'] != 0 or receipt['formalAcceptanceEligible'] is not False):
        raise ValueError('Grader facility verification differs')
    readiness = _read(snapshot, READINESS)
    if (any(item.get('id') == BLOCKER for item in readiness.get('blockers', []))
            or readiness.get('graderFacilities', {}).get('receiptRef') != {
                'path': RECEIPT, 'bytes': len(snapshot[RECEIPT]),
                'sha256': hashlib.sha256(snapshot[RECEIPT]).hexdigest()}):
        raise ValueError('Grader facility readiness differs')
    report = _read(snapshot, REPORT)
    if BLOCKER in report.get('remainingWork', []) or report.get('graderFacilities') != readiness['graderFacilities']:
        raise ValueError('Grader facility preparation status differs')


def run_tests(project):
    completed = subprocess.run(COMMAND.split(), cwd=Path(project).resolve(), capture_output=True,
                               text=True, encoding='utf-8', errors='replace')
    match = re.search(r'(\d+) passed', completed.stdout)
    result = {'command': COMMAND, 'exitCode': completed.returncode,
              'passed': int(match.group(1)) if match else None, 'productRuns': 0}
    if result != {'command': COMMAND, 'exitCode': 0, 'passed': 43, 'productRuns': 0}:
        raise ValueError('Grader facility tests failed:\n' + completed.stdout + completed.stderr)
    return result


def release(project):
    from rebuild_dataset import verify_asset_snapshot
    from rebuild_staging import candidate_lock, read_candidate, revise_candidate
    project = Path(project).resolve()
    facility = run_tests(project)
    with candidate_lock(project):
        snapshot = read_candidate(project)
        if RECEIPT not in snapshot:
            verify_asset_snapshot(project, snapshot)
    outputs = (refresh_existing(project, snapshot, facility)
               if RECEIPT in snapshot else assemble(project, snapshot, facility))
    # The coverage receipt and Benchmark bundle pin Case/Oracle and authoring
    # source bytes.  Refresh them in the same candidate transaction so a
    # legitimate grader receipt update never leaves an internally stale tree.
    from rebuild_coverage_review import build_revision as refresh_coverage_and_benchmarks
    outputs = refresh_coverage_and_benchmarks(project, outputs)
    # A receipt refresh can precede a separately versioned Case author update.
    # It validates the complete indexed candidate and the exact current Case
    # bytes, while prepare-cases remains responsible for author convergence.
    verify_asset_snapshot(project, outputs, require_current_authors=False)
    result = revise_candidate(project, snapshot, outputs)
    result.update(extractionGrader='available', pairedTrialValidator='available',
                  actualProductRuns=0, formalAcceptanceEligible=False)
    return result


if __name__ == '__main__':
    import argparse
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--project', type=Path, default=Path(__file__).resolve().parents[2])
    args = parser.parse_args()
    print(json.dumps(release(args.project), ensure_ascii=False, indent=2))
