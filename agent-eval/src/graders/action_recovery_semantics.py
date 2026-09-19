"""Trusted projection for Actions ownership, recovery and control evidence.

The projector accepts complete raw ledgers and Trial identities.  It derives
the remaining control/recovery observations without accepting Case assertions
or expected values.  A missing table, semantic identity, boundary or requested
output is insufficient evidence rather than an empty/zero observation.
"""
from collections import Counter


class IncompleteActionRecoveryEvidence(ValueError):
    """The supplied ledgers cannot support control/recovery projection."""


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
RECOVERY_CHECKS = set(RECOVERY_CHECK_COUNTS)

_FIELDS = {
    'commands': {'commandId', 'workspaceId', 'jobId', 'actionId', 'principalId',
                 'kind', 'result', 'errorKind', 'tokenStatus', 'cause', 'at'},
    'ownershipEvents': {'eventId', 'workspaceId', 'pageId', 'owner', 'principalId', 'at'},
    'operations': {'operationId', 'workspaceId', 'pageId', 'principalId', 'actorKind',
                   'kind', 'status', 'startedAt', 'endedAt'},
    'pageChecks': {'checkId', 'workspaceId', 'pageId', 'kind', 'name', 'status', 'at'},
    'pagePolicies': {'policyId', 'workspaceId', 'pageId', 'automaticWriteEnabled', 'at'},
    'resources': {'resourceId', 'workspaceId', 'jobId', 'actionId', 'kind', 'role',
                  'state', 'owner', 'at'},
    'attemptEvents': {'eventId', 'workspaceId', 'jobId', 'actionId', 'attemptId',
                      'state', 'retryOf', 'approvalId', 'at'},
    'actions': {'actionId', 'workspaceId', 'jobId', 'invoiceId', 'logicalActionKey',
                'status', 'published', 'prepared', 'at'},
    'approvals': {'approvalId', 'workspaceId', 'actionId', 'status', 'basisCurrent', 'at'},
    'jobs': {'jobId', 'workspaceId', 'status', 'completionGaps', 'cause', 'at'},
    'receipts': {'receiptId', 'workspaceId', 'actionId', 'attemptId',
                 'status', 'authority', 'at'},
    'claims': {'claimId', 'workspaceId', 'pageId', 'resourceId', 'owner',
               'decision', 'leaseUntil', 'reclaim', 'at'},
    'controllers': {'controllerId', 'workspaceId', 'principalId', 'status',
                    'startResult', 'at'},
    'applications': {'applicationId', 'workspaceId', 'status', 'title', 'version', 'at'},
    'queries': {'queryId', 'workspaceId', 'principalId', 'kind', 'authorized',
                'status', 'responseCount', 'at'},
    'probes': {'probeId', 'workspaceId', 'kind', 'delivered', 'decision', 'at'},
    'invoiceReadiness': {'recordId', 'workspaceId', 'jobId', 'invoiceId',
                         'prepared', 'receiptLinesComplete', 'at'},
    'retryProofs': {'proofId', 'workspaceId', 'actionId', 'kind', 'authority', 'at'},
}
_ID_FIELD = {
    'commands': 'commandId', 'ownershipEvents': 'eventId', 'operations': 'operationId',
    'pageChecks': 'checkId', 'pagePolicies': 'policyId', 'resources': 'resourceId',
    'attemptEvents': 'eventId', 'actions': 'actionId', 'approvals': 'approvalId',
    'jobs': 'jobId', 'receipts': 'receiptId', 'claims': 'claimId',
    'controllers': 'controllerId', 'applications': 'applicationId',
    'queries': 'queryId', 'probes': 'probeId', 'invoiceReadiness': 'recordId',
    'retryProofs': 'proofId',
}
_SCOPE_FIELDS = {
    'workspaceId', 'jobIds', 'actionIds', 'attemptIds', 'pageIds', 'principalIds',
    'logicalActionKeys', 'windowStart', 'windowEnd', 'boundaries', 'outputs',
}


def _ids(scope, key):
    values = scope[key]
    if (not isinstance(values, list) or not values or
            not all(isinstance(value, str) and value for value in values) or
            len(values) != len(set(values))):
        raise IncompleteActionRecoveryEvidence(f'invalid {key}')
    return set(values)


def _validate(records, scope):
    if not isinstance(records, dict) or set(records) != set(_FIELDS):
        raise IncompleteActionRecoveryEvidence('all recovery ledgers are required')
    for table, required in _FIELDS.items():
        rows = records[table]
        if not isinstance(rows, list):
            raise IncompleteActionRecoveryEvidence(f'{table} is not a ledger')
        seen = set()
        for index, row in enumerate(rows):
            if not isinstance(row, dict) or not required.issubset(row):
                raise IncompleteActionRecoveryEvidence(f'{table}[{index}] lacks semantic fields')
            identity = row[_ID_FIELD[table]]
            if not isinstance(identity, str) or not identity or identity in seen:
                raise IncompleteActionRecoveryEvidence(f'{table} identity is missing or duplicated')
            seen.add(identity)
            for field in ('at', 'startedAt', 'endedAt'):
                if field in row and type(row[field]) not in (int, float):
                    raise IncompleteActionRecoveryEvidence(f'{table}[{index}].{field} is invalid')
    if not isinstance(scope, dict) or set(scope) != _SCOPE_FIELDS:
        raise IncompleteActionRecoveryEvidence('recovery scope is incomplete or has unknown fields')
    if not isinstance(scope['workspaceId'], str) or not scope['workspaceId']:
        raise IncompleteActionRecoveryEvidence('invalid workspaceId')
    for key in ('jobIds', 'actionIds', 'attemptIds', 'pageIds',
                'principalIds', 'logicalActionKeys'):
        _ids(scope, key)
    start, end = scope['windowStart'], scope['windowEnd']
    if type(start) not in (int, float) or type(end) not in (int, float) or start > end:
        raise IncompleteActionRecoveryEvidence('invalid capture window')
    boundaries = scope['boundaries']
    required_boundaries = {'revalidationAt', 'uiErrorAt', 'isolationAt',
                           'stopAt', 'newAttemptAt'}
    if (not isinstance(boundaries, dict) or set(boundaries) != required_boundaries or
            any(type(value) not in (int, float) for value in boundaries.values())):
        raise IncompleteActionRecoveryEvidence('recovery boundaries are incomplete or invalid')
    outputs = scope['outputs']
    if (not isinstance(outputs, list) or not outputs or len(outputs) != len(set(outputs)) or
            not all(value in RECOVERY_CHECKS for value in outputs)):
        raise IncompleteActionRecoveryEvidence('outputs are empty, duplicated or unknown')


def _within(row, scope, field='at'):
    return (row['workspaceId'] == scope['workspaceId'] and
            scope['windowStart'] <= row[field] <= scope['windowEnd'])


def _latest(rows):
    return max(rows, key=lambda row: row['at']) if rows else None


def _overlap(left, right):
    return left['startedAt'] < right['endedAt'] and right['startedAt'] < left['endedAt']


def project_action_recovery(records: dict, scope: dict) -> dict:
    """Derive requested control/recovery observations from raw ledgers."""
    _validate(records, scope)
    jobs = _ids(scope, 'jobIds')
    actions = _ids(scope, 'actionIds')
    attempts = _ids(scope, 'attemptIds')
    pages = _ids(scope, 'pageIds')
    principals = _ids(scope, 'principalIds')
    logical_keys = _ids(scope, 'logicalActionKeys')

    commands = [row for row in records['commands'] if _within(row, scope)
                and row['jobId'] in jobs and row['actionId'] in actions
                and row['principalId'] in principals]
    ownership = sorted((row for row in records['ownershipEvents'] if _within(row, scope)
                        and row['pageId'] in pages and row['principalId'] in principals),
                       key=lambda row: row['at'])
    operations = [row for row in records['operations']
                  if row['workspaceId'] == scope['workspaceId']
                  and row['pageId'] in pages and row['principalId'] in principals
                  and scope['windowStart'] <= row['startedAt']
                  and row['endedAt'] <= scope['windowEnd']
                  and row['startedAt'] <= row['endedAt']]
    page_checks = [row for row in records['pageChecks'] if _within(row, scope)
                   and row['pageId'] in pages]
    policies = [row for row in records['pagePolicies'] if _within(row, scope)
                and row['pageId'] in pages]
    resources = [row for row in records['resources'] if _within(row, scope)
                 and row['jobId'] in jobs and row['actionId'] in actions]
    attempt_events = sorted((row for row in records['attemptEvents'] if _within(row, scope)
                             and row['jobId'] in jobs and row['actionId'] in actions
                             and row['attemptId'] in attempts), key=lambda row: row['at'])
    action_rows = [row for row in records['actions'] if _within(row, scope)
                   and row['jobId'] in jobs and row['actionId'] in actions
                   and row['logicalActionKey'] in logical_keys]
    approvals = [row for row in records['approvals'] if _within(row, scope)
                 and row['actionId'] in actions]
    job_rows = [row for row in records['jobs'] if _within(row, scope) and row['jobId'] in jobs]
    receipts = sorted((row for row in records['receipts'] if _within(row, scope)
                       and row['actionId'] in actions and row['attemptId'] in attempts),
                      key=lambda row: row['at'])
    claims = [row for row in records['claims'] if _within(row, scope)
              and row['pageId'] in pages]
    controllers = [row for row in records['controllers'] if _within(row, scope)
                   and row['principalId'] in principals]
    applications = [row for row in records['applications'] if _within(row, scope)]
    queries = [row for row in records['queries'] if _within(row, scope)
               and row['principalId'] in principals]
    probes = [row for row in records['probes'] if _within(row, scope)]
    readiness = [row for row in records['invoiceReadiness'] if _within(row, scope)
                 and row['jobId'] in jobs]
    retry_proofs = [row for row in records['retryProofs'] if _within(row, scope)
                    and row['actionId'] in actions and row['authority'] == 'target']

    failed_commands = [row for row in commands if row['result'] == 'rejected' and row['errorKind']]
    resume_passed = [row['name'] for row in page_checks
                     if row['kind'] == 'resume' and row['status'] == 'passed']
    resume_failed = [row['name'] for row in page_checks
                     if row['kind'] == 'resume' and row['status'] == 'failed']
    mismatches = [row['name'] for row in page_checks
                  if row['kind'] == 'drift' and row['status'] == 'mismatch']
    human_agent_pairs = [(left, right) for i, left in enumerate(operations)
                         for right in operations[i + 1:]
                         if left['actorKind'] != right['actorKind'] and _overlap(left, right)]
    all_overlap_pairs = [(left, right) for i, left in enumerate(operations)
                         for right in operations[i + 1:]
                         if left['principalId'] != right['principalId'] and _overlap(left, right)]
    current_approvals = {row['actionId'] for row in approvals
                         if row['status'] == 'approved' and row['basisCurrent'] is True}
    accepted_reclaims = [row for row in claims if row['reclaim'] is True
                         and row['decision'] == 'accepted']
    latest_reclaim = _latest(accepted_reclaims)
    latest_policy = _latest(policies)
    latest_old_resource = _latest([row for row in resources if row['role'] == 'old'])
    after_ui_resources = [row for row in resources
                          if row['at'] >= scope['boundaries']['uiErrorAt']]
    latest_after_ui = _latest(after_ui_resources)
    active_claim_owners = {row['owner'] for row in claims if row['decision'] == 'accepted'}
    current_controller = _latest([row for row in controllers if row['status'] == 'active'])
    authorized_queries = [row for row in queries if row['authorized'] is True]
    latest_authorized_query = _latest(authorized_queries)
    post_stop_probes = [row for row in probes if row['kind'] == 'post_stop_write'
                        and row['at'] >= scope['boundaries']['stopAt']]
    attempt_ids = {row['attemptId'] for row in attempt_events}
    retry_attempt_ids = {row['attemptId'] for row in attempt_events
                         if row['retryOf'] is not None
                         and row['at'] >= scope['boundaries']['newAttemptAt']}
    gaps = []
    for row in sorted(job_rows, key=lambda item: item['at']):
        if not isinstance(row['completionGaps'], list):
            raise IncompleteActionRecoveryEvidence('job completionGaps must be an array')
        gaps.extend(row['completionGaps'])

    values = {
        'command-error-kind': _latest(failed_commands)['errorKind'] if failed_commands else None,
        'concurrent-human-agent-operations': len(human_agent_pairs),
        'detected-page-mismatches': mismatches,
        'automatic-write-enabled': (latest_policy['automaticWriteEnabled']
                                    if latest_policy else None),
        'ownership-sequence': [row['owner'] for row in ownership],
        'resume-checks': resume_passed,
        'ownership': ownership[-1]['owner'] if ownership else None,
        'resume-gaps': resume_failed,
        'new-clicks-before-revalidation': sum(
            row['kind'] == 'click' and row['startedAt'] < scope['boundaries']['revalidationAt']
            for row in operations),
        'reused-execution-tokens': sum(row['tokenStatus'] in {'reused', 'expired'}
                                       for row in commands),
        'human-operations': sum(row['actorKind'] == 'human' for row in operations),
        'unreleased-resources': [row['kind'] for row in resources
                                 if row['state'] not in {'released', 'stopped'}],
        'active-page-owners': len(active_claim_owners),
        'conflicting-operations': len(all_overlap_pairs),
        'waiting-page-claimants': sum(row['decision'] == 'waiting' for row in claims),
        'prepared-invoices': len({row['invoiceId'] for row in readiness
                                  if row['prepared'] is True}),
        'approved-actions': len({row['actionId'] for row in action_rows
                                 if row['actionId'] in current_approvals}),
        'published-action-count': sum(row['published'] is True for row in action_rows),
        'retry-proof-kind': _latest(retry_proofs)['kind'] if retry_proofs else None,
        'attempt-count': len(attempt_ids),
        'receipt-statuses': [row['status'] for row in receipts],
        'active-logical-actions': len({row['logicalActionKey'] for row in action_rows
                                       if row['status'] not in {'cancelled', 'rejected'}}),
        'completed-jobs': len({row['jobId'] for row in job_rows
                               if row['status'] == 'completed'}),
        'insufficient-receipt-lines': sum(row['receiptLinesComplete'] is not True
                                          for row in readiness),
        'new-attempt-count': len(retry_attempt_ids),
        'unresolved-actions': sum(row['status'] in {'unknown', 'reconciling'}
                                  for row in action_rows),
        'completion-gaps': gaps,
        'lease-expired-at-reclaim': bool(latest_reclaim and
                                         latest_reclaim['leaseUntil'] <= latest_reclaim['at']),
        'reclaim-accepted': bool(latest_reclaim),
        'new-lease-owner': latest_reclaim['owner'] if latest_reclaim else None,
        'old-resource-state': latest_old_resource['state'] if latest_old_resource else None,
        'attempt-state-history': [row['state'] for row in attempt_events],
        'dispatcher-principal': (_latest([row for row in commands
                                          if row['kind'] == 'dispatch'
                                          and row['result'] == 'accepted']) or {}).get('principalId'),
        'application-instance-count': len({row['applicationId'] for row in applications
                                           if row['status'] == 'active'}),
        'active-controller-count': sum(row['status'] == 'active' for row in controllers),
        'rejected-controller-starts': sum(row['startResult'] == 'rejected'
                                           for row in controllers),
        'legal-query-responses': sum(row['responseCount'] for row in authorized_queries
                                     if row['status'] == 'ok'),
        'implicit-runs-started': sum(row['kind'] == 'start_run'
                                     and row['cause'] == 'old_event'
                                     and row['result'] == 'accepted' for row in commands),
        'current-version': max((row['version'] for row in applications), default=None),
        'run-auto-restarts': sum(row['kind'] == 'auto_restart_run'
                                 and row['result'] == 'accepted' for row in commands),
        'after-ui-error-resource-state': latest_after_ui['state'] if latest_after_ui else None,
        'ui-caused-run-terminal-count': sum(
            row['cause'] == 'ui_error' and row['status'] in {'failed', 'cancelled', 'succeeded'}
            for row in job_rows),
        'post-stop-write-probe-delivered': any(row['delivered'] is True
                                                for row in post_stop_probes),
        'post-stop-write-probe-denied': any(row['delivered'] is True
                                             and row['decision'] == 'denied'
                                             for row in post_stop_probes),
        'new-controllers-before-isolation': sum(
            row['startResult'] == 'accepted'
            and scope['boundaries']['uiErrorAt'] < row['at'] < scope['boundaries']['isolationAt']
            for row in controllers),
        'current-controller-principal': (current_controller['principalId']
                                         if current_controller else None),
        'authorized-query-status': (latest_authorized_query['status']
                                    if latest_authorized_query else None),
    }
    return {output: values[output] for output in scope['outputs']}
