"""Close the authored Runtime/Tools/Events contract audit with replayable proof.

This review covers Case definitions and their facility tests.  It does not
claim that a product adapter exists, that a product Trial ran, or that any
Benchmark passed.
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
from rebuild_source_revision import reindex
from rebuild_sources import file_pin


RECEIPT = 'manifests/case-reviews/runtime-tools-events-contracts.json'
READINESS = 'manifests/readiness.json'
REPORT = 'manifests/preparation-report.json'
BLOCKER = 'runtime_input_evidence_and_error_contract'
TEST_COMMAND = ('python -m pytest agent-eval/tests/test_rebuild_scenarios_foundation.py '
                'agent-eval/tests/test_rebuild_scenarios_runtime.py -q')
EXPECTED_PASSED = 32
EXPECTED_SUBTESTS = 315
SOURCE_PATHS = [
    'agent-eval/tools/rebuild_runtime_evidence_review.py',
    'agent-eval/tools/rebuild_scenarios_foundation.py',
    'agent-eval/tools/rebuild_scenarios_runtime.py',
    'agent-eval/tests/test_rebuild_runtime_evidence_review.py',
    'agent-eval/tests/test_rebuild_scenarios_foundation.py',
    'agent-eval/tests/test_rebuild_scenarios_runtime.py',
]

# Each audit item names the concrete authored cases and the observation paths
# that distinguish the risky condition from its control.  This is an authoring
# review index, not evidence that the product produced those observations.
AUDIT_ITEMS = [
    {'id': 'unique_retry_owner', 'cases': {
        'fresh-tool-read-gateway-transient-retry': ['observation.retry.owner',
            'observation.retry.nonOwnerRetryAttempts', 'observation.retry.gatewayWrapperAttempts'],
        'fresh-rt-provider-native-retry': ['observation.provider.retryOwner',
            'observation.provider.nonOwnerRetryAttempts']}},
    {'id': 'cancel_acceptance_vs_actual_stop', 'cases': {
        'fresh-rt-provider-cancel': ['observation.runtime.cancelAcceptedCount',
            'observation.runtime.cancelledBeforeActualStop', 'observation.runtime.actualStopObserved'],
        'fresh-tool-read-cancel-stop-unknown': ['observation.cancellation.accepted',
            'observation.cancellation.stopConfirmedBeforeRelease',
            'observation.cancellation.stopConfirmedAfterRelease']}},
    {'id': 'budget_and_deadline_through_rebind', 'cases': {
        'fresh-rt-budget-late-usage': ['observation.budget.settledUnitsBeforeRebind',
            'observation.budget.unknownHeldUnitsAfterRebind',
            'observation.budget.rebindAdmissionDecision', 'observation.runtime.deadlineExtensions'],
        'fresh-rt-goal-wait-resume': ['observation.runtime.deadlineExtensions']}},
    {'id': 'query_failure_vs_success_empty', 'cases': {
        'fresh-tool-read-error-is-not-absence': ['observation.enterpriseQuery.returnCategory',
            'observation.enterpriseQuery.returnedSuccessEmpty',
            'observation.agent.claimedSupplierAbsent', 'observation.job.rejectedByOperationError'],
        'fresh-tool-product-read-uses-result': ['observation.enterpriseQuery.returnCategory',
            'observation.enterpriseQuery.matchCount', 'observation.agent.reportedNoSupplierMatch']}},
    {'id': 'committed_fact_survives_delivery_failure', 'cases': {
        'fresh-rt-goal-accepted-survives': ['observation.revision.acceptedCount',
            'observation.toolCall.outputSchemaRejected',
            'observation.toolCall.businessExecutionCount',
            'observation.toolCall.redeliveryTriggeredExecutions']}},
    {'id': 'error_descriptor_identity_and_category', 'cases': {
        'fresh-rt-provider-auth': ['observation.diagnostic.errorId',
            'observation.diagnostic.code', 'observation.diagnostic.source',
            'observation.diagnostic.impactScope',
            'observation.diagnostic.identityChangedAcrossLayers'],
        'fresh-rt-provider-protocol': ['observation.diagnostic.externalCode',
            'observation.diagnostic.rootCauseStatus',
            'observation.diagnostic.defaultedToInternalDefect']}},
    {'id': 'shared_resource_impact_scope', 'cases': {
        'fresh-rt-events-commit-fail': ['observation.diagnostic.initialImpactScope',
            'observation.diagnostic.effectiveImpactScope',
            'observation.runtime.affectedRunAdmissionBlocks',
            'observation.runtime.healthyControlAdmissionSuccesses'],
        'fresh-rt-log-audit-fail': ['observation.runtime.affectedWriteProbeBlocks',
            'observation.runtime.healthyReadProbeSuccesses', 'observation.runtime.globalOverstop']}},
    {'id': 'primary_and_cleanup_errors', 'cases': {
        'fresh-rt-goal-cleanup-fail': ['observation.diagnostic.primaryErrorId',
            'observation.diagnostic.cleanupErrorId',
            'observation.runtime.independentCleanupAttempts',
            'observation.runtime.remainingResourceIdsCsv']}},
    {'id': 'known_partial_usage_preserved', 'cases': {
        'fresh-rt-budget-unknown': ['observation.budget.knownInputUsageUnits',
            'observation.budget.knownPartLost', 'observation.budget.conservativeHeldUnits',
            'observation.budget.unknownRecordedAsZero']}},
    {'id': 'declared_runtime_input_and_stop_evidence', 'cases': {
        'fresh-rt-provider-tool-recover': ['observation.answer.tax',
            'observation.answer.taxEvidenceRef', 'observation.loop.errorResultDelivered'],
        'fresh-rt-budget-deadline': ['observation.runtime.callsAfterDeadline',
            'observation.runtime.actualStopObserved'],
        'fresh-tool-model-forged-scope': ['observation.retry.adapterAttemptCount',
            'observation.retry.observationWindowCompleted',
            'observation.job.rejectedByOperationError'],
        'fresh-tool-revoked-between-selection-execution': ['observation.retry.adapterAttemptCount',
            'observation.retry.observationWindowCompleted',
            'observation.job.rejectedByOperationError']}},
]


def _read(snapshot, path):
    return json.loads(snapshot[path].decode('utf-8-sig'))


def _case_pins(snapshot):
    cases = {_read(snapshot, path)['id']: _read(snapshot, path)
             for path in snapshot if path.startswith('cases/') and path.endswith('.json')}
    pins = []
    for item in AUDIT_ITEMS:
        for case_id, required_paths in item['cases'].items():
            case = cases.get(case_id)
            if case is None:
                raise ValueError('Runtime audit Case missing: ' + case_id)
            actual_paths = {check['assertion']['path'] for check in case['oracle']['checks']}
            missing = sorted(set(required_paths) - actual_paths)
            if missing:
                raise ValueError(f'Runtime audit checks missing for {case_id}: {missing}')
            pins.append({'auditItem': item['id'], 'caseId': case_id,
                         'caseVersion': case['version'], 'caseSha256': canonical_digest(case),
                         'requiredObservationPaths': sorted(required_paths)})
    return sorted(pins, key=lambda row: (row['auditItem'], row['caseId']))


def build_receipt(project, snapshot, result):
    if (result.get('command') != TEST_COMMAND or result.get('exitCode') != 0 or
            result.get('passed') != EXPECTED_PASSED or
            result.get('subtests') != EXPECTED_SUBTESTS or
            result.get('productRuns') != 0):
        raise ValueError('Runtime contract facility tests did not complete exactly')
    return {
        'schemaVersion': 1,
        'reviewId': 'runtime-tools-events-authored-contracts',
        'status': 'authored_runtime_tools_events_contract_gaps_addressed',
        'scope': 'case_definitions_and_facility_tests_only',
        'auditItems': deepcopy(AUDIT_ITEMS),
        'casePins': _case_pins(snapshot),
        'sourcePins': [file_pin(project, path) for path in SOURCE_PATHS],
        'facilityVerification': deepcopy(result),
        'notClaimed': ['trusted_product_adapter', 'trusted_product_collector',
                       'actual_product_run', 'human_content_approval',
                       'benchmark_pass', 'formal_acceptance'],
        'actualProductRuns': 0,
        'formalAcceptanceEligible': False,
    }


def assemble(project, snapshot, result):
    if RECEIPT in snapshot:
        raise ValueError('Runtime contract review receipt already exists')
    outputs = dict(snapshot)
    outputs[RECEIPT] = json_bytes(build_receipt(project, snapshot, result))

    readiness = _read(snapshot, READINESS)
    blockers = readiness.get('blockers', [])
    if sum(row.get('id') == BLOCKER for row in blockers) != 1:
        raise ValueError('Expected one Runtime/Tools/Events contract blocker')
    readiness['blockers'] = [row for row in blockers if row.get('id') != BLOCKER]
    review = {
        'status': 'ADDRESSED_AUTHORED_CONTRACTS',
        'auditItemCount': len(AUDIT_ITEMS),
        'facilityTests': {'passed': EXPECTED_PASSED, 'subtests': EXPECTED_SUBTESTS},
        'actualProductRuns': 0,
        'receiptRef': {'path': RECEIPT, 'bytes': len(outputs[RECEIPT]),
                       'sha256': hashlib.sha256(outputs[RECEIPT]).hexdigest()},
    }
    readiness['runtimeToolsEventsReview'] = deepcopy(review)
    outputs[READINESS] = json_bytes(readiness)

    report = _read(snapshot, REPORT)
    if report.get('remainingWork', []).count(BLOCKER) != 1:
        raise ValueError('Preparation report must contain one Runtime contract item')
    report['remainingWork'] = [item for item in report['remainingWork'] if item != BLOCKER]
    report['runtimeToolsEventsReview'] = deepcopy(review)
    outputs[REPORT] = json_bytes(report)
    reindex(outputs)
    validate_snapshot(project, outputs)
    return outputs


def validate_snapshot(project, snapshot):
    if RECEIPT not in snapshot:
        return
    receipt = _read(snapshot, RECEIPT)
    expected = build_receipt(project, snapshot, receipt.get('facilityVerification', {}))
    if receipt != expected:
        raise ValueError('Runtime contract review receipt is not replayable')
    readiness = _read(snapshot, READINESS)
    if any(row.get('id') == BLOCKER for row in readiness.get('blockers', [])):
        raise ValueError('Runtime contract blocker remains after review')
    review = readiness.get('runtimeToolsEventsReview', {})
    expected_ref = {'path': RECEIPT, 'bytes': len(snapshot[RECEIPT]),
                    'sha256': hashlib.sha256(snapshot[RECEIPT]).hexdigest()}
    if (review.get('status') != 'ADDRESSED_AUTHORED_CONTRACTS' or
            review.get('auditItemCount') != len(AUDIT_ITEMS) or
            review.get('facilityTests') != {'passed': EXPECTED_PASSED,
                                            'subtests': EXPECTED_SUBTESTS} or
            review.get('actualProductRuns') != 0 or review.get('receiptRef') != expected_ref):
        raise ValueError('Runtime contract readiness projection differs')
    report = _read(snapshot, REPORT)
    if (BLOCKER in report.get('remainingWork', []) or
            report.get('runtimeToolsEventsReview') != review):
        raise ValueError('Runtime contract preparation projection differs')


def run_tests(project):
    command = [sys.executable, '-m', 'pytest',
               'agent-eval/tests/test_rebuild_scenarios_foundation.py',
               'agent-eval/tests/test_rebuild_scenarios_runtime.py', '-q']
    completed = subprocess.run(command, cwd=Path(project).resolve(), capture_output=True,
                               text=True, encoding='utf-8', errors='replace')
    passed = re.search(r'(^|\s)(\d+) passed(?:,|\s)', completed.stdout)
    subtests = re.search(r'(\d+) subtests passed', completed.stdout)
    result = {'command': TEST_COMMAND, 'exitCode': completed.returncode,
              'passed': int(passed.group(2)) if passed else None,
              'subtests': int(subtests.group(1)) if subtests else None,
              'productRuns': 0}
    if (completed.returncode or result['passed'] != EXPECTED_PASSED or
            result['subtests'] != EXPECTED_SUBTESTS):
        raise ValueError('Runtime contract facility tests failed:\n' +
                         completed.stdout + completed.stderr)
    return result


def refresh_existing(project, snapshot, result):
    """Refresh a prior authored-contract receipt after versioned Case edits.

    The caller supplies a fresh facility-test result.  This updates only the
    replayable source/Case pins and their readiness projections; it never adds
    a product run or turns facility evidence into product acceptance.
    """
    if RECEIPT not in snapshot:
        return snapshot
    outputs = dict(snapshot)
    outputs[RECEIPT] = json_bytes(build_receipt(project, outputs, result))
    review = {
        'status': 'ADDRESSED_AUTHORED_CONTRACTS',
        'auditItemCount': len(AUDIT_ITEMS),
        'facilityTests': {'passed': EXPECTED_PASSED,
                          'subtests': EXPECTED_SUBTESTS},
        'actualProductRuns': 0,
        'receiptRef': {'path': RECEIPT, 'bytes': len(outputs[RECEIPT]),
                       'sha256': hashlib.sha256(outputs[RECEIPT]).hexdigest()},
    }
    readiness = _read(outputs, READINESS)
    readiness['runtimeToolsEventsReview'] = deepcopy(review)
    outputs[READINESS] = json_bytes(readiness)
    report = _read(outputs, REPORT)
    report['runtimeToolsEventsReview'] = deepcopy(review)
    outputs[REPORT] = json_bytes(report)
    reindex(outputs)
    validate_snapshot(project, outputs)
    return outputs


def release(project):
    from rebuild_dataset import verify_asset_snapshot
    from rebuild_staging import read_candidate, revise_candidate
    project = Path(project).resolve()
    result = run_tests(project)
    snapshot = read_candidate(project)
    verify_asset_snapshot(project, snapshot)
    outputs = assemble(project, snapshot, result)
    verify_asset_snapshot(project, outputs)
    revision = revise_candidate(project, snapshot, outputs)
    revision.update(runtimeToolsEventsContracts='addressed_authored_contracts',
                    auditItems=len(AUDIT_ITEMS), actualProductRuns=0,
                    formalAcceptanceEligible=False)
    return revision


if __name__ == '__main__':
    import argparse
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--project', type=Path, default=Path(__file__).resolve().parents[2])
    args = parser.parse_args()
    print(json.dumps(release(args.project), ensure_ascii=False, indent=2))
