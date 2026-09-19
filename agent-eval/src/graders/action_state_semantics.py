"""Independent state and authorization projections for Actions evidence.

The trusted collector supplies complete authoritative ledgers and a scope that
identifies *which* entity and observation time belong to the Trial.  The scope
never contains the expected status or decision from a Case.  A caller must turn
``IncompleteActionStateEvidence`` into ``insufficient_evidence`` rather than an
empty value or a guessed state.
"""


class IncompleteActionStateEvidence(ValueError):
    """The supplied ledgers cannot support an unambiguous projection."""


STATE_CHECK_COUNTS = {
    'action-status': 5,
    'after-revoke-action-status': 1,
    'after-revoke-job-status': 1,
    'after-revoke-old-attempt-status': 1,
    'after-ui-error-run-status': 1,
    'approval-status': 14,
    'attempt-approval-ids': 4,
    'attempt-status': 5,
    'before-crash-attempt-status': 2,
    'before-reclaim-attempt-status': 1,
    'job-status': 12,
    'new-approval-status': 3,
    'new-attempt-status': 2,
    'old-action-status': 3,
    'old-attempt-status': 2,
    'origin-run-status': 1,
    'original-attempt-status': 1,
    'original-decision': 6,
    'qualified-operations': 1,
    'selected-approval-id': 1,
    'step-status': 1,
}

STATE_CHECKS = set(STATE_CHECK_COUNTS)

_TABLE_FIELDS = {
    'entitySnapshots': {
        'workspaceId', 'entityType', 'entityId', 'revision', 'values',
        'authoritative', 'at',
    },
    'attemptBindings': {
        'workspaceId', 'actionId', 'attemptId', 'approvalId', 'sequence',
        'authoritative', 'at',
    },
    'dispatchBindings': {
        'workspaceId', 'actionId', 'attemptId', 'approvalId', 'selected',
        'authoritative', 'at',
    },
    'authorizationEvaluations': {
        'workspaceId', 'principalId', 'objectType', 'objectId', 'operation',
        'decision', 'policyVersion', 'authoritative', 'at',
    },
}

_QUERY_FIELDS = {
    'entity_field_at': {
        'output', 'kind', 'entityType', 'entityId', 'field', 'asOf',
    },
    'attempt_approval_ids': {'output', 'kind', 'actionId'},
    'selected_approval_id': {'output', 'kind', 'actionId', 'attemptId'},
    'qualified_operations': {
        'output', 'kind', 'principalId', 'objectType', 'objectId', 'asOf',
    },
}


def _validate_records(records):
    if not isinstance(records, dict) or set(records) != set(_TABLE_FIELDS):
        raise IncompleteActionStateEvidence(
            'state evidence must contain exactly the four complete ledgers')
    for table, required in _TABLE_FIELDS.items():
        rows = records[table]
        if not isinstance(rows, list):
            raise IncompleteActionStateEvidence(f'{table} is not a complete ledger')
        for index, row in enumerate(rows):
            if not isinstance(row, dict) or not required.issubset(row):
                raise IncompleteActionStateEvidence(
                    f'{table}[{index}] lacks identity, authority, state or time fields')
            if type(row['at']) not in (int, float):
                raise IncompleteActionStateEvidence(f'{table}[{index}].at is not numeric')
            if row['authoritative'] not in (True, False):
                raise IncompleteActionStateEvidence(
                    f'{table}[{index}].authoritative is not boolean')
    for index, row in enumerate(records['entitySnapshots']):
        if (not isinstance(row['revision'], int) or row['revision'] < 1 or
                not isinstance(row['values'], dict)):
            raise IncompleteActionStateEvidence(
                f'entitySnapshots[{index}] has invalid revision or values')
    for index, row in enumerate(records['attemptBindings']):
        if not isinstance(row['sequence'], int) or row['sequence'] < 1:
            raise IncompleteActionStateEvidence(
                f'attemptBindings[{index}] has invalid sequence')
    for index, row in enumerate(records['dispatchBindings']):
        if row['selected'] not in (True, False):
            raise IncompleteActionStateEvidence(
                f'dispatchBindings[{index}].selected is not boolean')


def _validate_scope(scope):
    expected = {'workspaceId', 'queries', 'windowStart', 'windowEnd', 'policyVersion'}
    if not isinstance(scope, dict) or set(scope) != expected:
        raise IncompleteActionStateEvidence('state scope is incomplete or has unknown fields')
    if not isinstance(scope['workspaceId'], str) or not scope['workspaceId']:
        raise IncompleteActionStateEvidence('workspaceId is invalid')
    start, end = scope['windowStart'], scope['windowEnd']
    if type(start) not in (int, float) or type(end) not in (int, float) or start > end:
        raise IncompleteActionStateEvidence('capture window is invalid')
    if not isinstance(scope['policyVersion'], int) or scope['policyVersion'] < 1:
        raise IncompleteActionStateEvidence('policyVersion is invalid')
    queries = scope['queries']
    if not isinstance(queries, list) or not queries:
        raise IncompleteActionStateEvidence('queries must be a nonempty array')
    outputs = set()
    for query in queries:
        if not isinstance(query, dict) or query.get('kind') not in _QUERY_FIELDS:
            raise IncompleteActionStateEvidence('unknown state query')
        if set(query) != _QUERY_FIELDS[query['kind']]:
            raise IncompleteActionStateEvidence('state query is incomplete or has unknown fields')
        output = query['output']
        if output not in STATE_CHECKS or output in outputs:
            raise IncompleteActionStateEvidence('unknown or duplicate state output')
        outputs.add(output)
        for key, value in query.items():
            if key not in {'kind', 'asOf'} and (
                    not isinstance(value, str) or not value):
                raise IncompleteActionStateEvidence(f'invalid query field {key}')
        if 'asOf' in query:
            if (type(query['asOf']) not in (int, float) or
                    not start <= query['asOf'] <= end):
                raise IncompleteActionStateEvidence('query asOf is outside the capture window')
        if query['kind'] == 'entity_field_at' and query['field'] not in {'status', 'decision'}:
            raise IncompleteActionStateEvidence('entity query field is not permitted')
    return queries


def _latest_entity(records, scope, query):
    rows = [row for row in records['entitySnapshots']
            if row['workspaceId'] == scope['workspaceId']
            and row['entityType'] == query['entityType']
            and row['entityId'] == query['entityId']
            and row['authoritative'] is True
            and scope['windowStart'] <= row['at'] <= query['asOf']]
    if not rows:
        raise IncompleteActionStateEvidence(
            f"no authoritative snapshot for {query['entityType']}/{query['entityId']}")
    latest_key = max((row['at'], row['revision']) for row in rows)
    latest = [row for row in rows if (row['at'], row['revision']) == latest_key]
    if len(latest) != 1:
        raise IncompleteActionStateEvidence('ambiguous latest entity snapshot')
    value = latest[0]['values'].get(query['field'])
    if not isinstance(value, str) or not value:
        raise IncompleteActionStateEvidence('latest snapshot lacks the requested state field')
    return value


def _attempt_approval_ids(records, scope, query):
    rows = [row for row in records['attemptBindings']
            if row['workspaceId'] == scope['workspaceId']
            and row['actionId'] == query['actionId']
            and row['authoritative'] is True
            and scope['windowStart'] <= row['at'] <= scope['windowEnd']]
    if not rows:
        raise IncompleteActionStateEvidence('no authoritative attempts for action')
    if (len({row['attemptId'] for row in rows}) != len(rows) or
            len({row['sequence'] for row in rows}) != len(rows) or
            any(not isinstance(row['approvalId'], str) or not row['approvalId'] for row in rows)):
        raise IncompleteActionStateEvidence('attempt approval bindings are ambiguous')
    return [row['approvalId'] for row in sorted(rows, key=lambda row: row['sequence'])]


def _selected_approval(records, scope, query):
    rows = [row for row in records['dispatchBindings']
            if row['workspaceId'] == scope['workspaceId']
            and row['actionId'] == query['actionId']
            and row['attemptId'] == query['attemptId']
            and row['authoritative'] is True and row['selected'] is True
            and scope['windowStart'] <= row['at'] <= scope['windowEnd']]
    if len(rows) != 1 or not isinstance(rows[0]['approvalId'], str) or not rows[0]['approvalId']:
        raise IncompleteActionStateEvidence('selected approval is missing or ambiguous')
    return rows[0]['approvalId']


def _qualified_operations(records, scope, query):
    rows = [row for row in records['authorizationEvaluations']
            if row['workspaceId'] == scope['workspaceId']
            and row['principalId'] == query['principalId']
            and row['objectType'] == query['objectType']
            and row['objectId'] == query['objectId']
            and row['policyVersion'] == scope['policyVersion']
            and row['authoritative'] is True
            and scope['windowStart'] <= row['at'] <= query['asOf']]
    if not rows:
        raise IncompleteActionStateEvidence('authorization evaluation ledger has no matching rows')
    latest = {}
    for row in rows:
        key = row['operation']
        if not isinstance(key, str) or not key or row['decision'] not in {'ALLOW', 'DENY'}:
            raise IncompleteActionStateEvidence('invalid authorization evaluation')
        current = latest.get(key)
        if current is None or row['at'] > current['at']:
            latest[key] = row
        elif row['at'] == current['at'] and row['decision'] != current['decision']:
            raise IncompleteActionStateEvidence('conflicting authorization decisions')
    return sorted(operation for operation, row in latest.items() if row['decision'] == 'ALLOW')


def project_action_state(records: dict, scope: dict) -> dict:
    """Project reviewed state outputs without reading any Case oracle value."""
    _validate_records(records)
    queries = _validate_scope(scope)
    result = {}
    for query in queries:
        if query['kind'] == 'entity_field_at':
            value = _latest_entity(records, scope, query)
        elif query['kind'] == 'attempt_approval_ids':
            value = _attempt_approval_ids(records, scope, query)
        elif query['kind'] == 'selected_approval_id':
            value = _selected_approval(records, scope, query)
        else:
            value = _qualified_operations(records, scope, query)
        result[query['output']] = value
    return result
