"""Trusted semantic projections for Actions submission evidence.

The structured grader compares a projected observation with a reviewed Case.
This module defines how a product adapter must derive the five positive
submission counters from complete raw ledgers.  It deliberately does not read
Case assertions or expected values: rejected rows, stale tokens, another
principal/target/Attempt, rows outside the capture window, and non-authoritative
receipts cannot satisfy a positive denominator merely because a table has the
right length.
"""

class IncompleteActionEvidence(ValueError):
    """The supplied ledgers cannot support a semantic projection."""


POSITIVE_SUBMISSION_CHECKS = {
    'admitted-submit-count',
    'submit-send-entry-count',
    'submit-request-count',
    'submit-effect-count',
    'submit-success-count',
    'undeclared-write-request-count',
}

COMMON_ACTION_CHECKS = {
    'command-delivered', 'identity-join-errors', 'observed-fault-count',
    'barrier-arrivals', 'barrier-released',
}

_TABLE_FIELDS = {
    'admissions': {'jobId', 'actionId', 'attemptId', 'operation', 'decision',
                   'tokenStatus', 'principalId', 'targetId', 'logicalActionKey', 'at'},
    'entries': {'jobId', 'actionId', 'attemptId', 'operation', 'admission',
                'principalId', 'targetId', 'logicalActionKey', 'at'},
    'requests': {'jobId', 'actionId', 'attemptId', 'operation', 'dispatched',
                 'principalId', 'targetId', 'logicalActionKey', 'at'},
    'effects': {'actionId', 'attemptId', 'operation', 'status', 'authority',
                'targetId', 'logicalActionKey', 'externalId', 'at'},
    'receipts': {'actionId', 'attemptId', 'status', 'authority', 'targetId',
                 'logicalActionKey', 'externalId', 'at'},
}

_SCOPE_FIELDS = {
    'jobIds', 'actionIds', 'attemptIds', 'principalId', 'targetId',
    'logicalActionKeys', 'windowStart', 'windowEnd', 'declaredWriteOperations',
}


def _set(scope, key):
    value = scope[key]
    if not isinstance(value, list) or not value or not all(isinstance(x, str) and x for x in value):
        raise IncompleteActionEvidence(f'invalid scope {key}')
    if len(set(value)) != len(value):
        raise IncompleteActionEvidence(f'duplicate scope {key}')
    return set(value)


def _validate(records, scope):
    if not isinstance(records, dict) or not isinstance(scope, dict):
        raise IncompleteActionEvidence('records and scope must be objects')
    if set(scope) != _SCOPE_FIELDS:
        raise IncompleteActionEvidence('submission scope is incomplete or has unknown fields')
    if not isinstance(scope['principalId'], str) or not scope['principalId']:
        raise IncompleteActionEvidence('invalid scope principalId')
    if not isinstance(scope['targetId'], str) or not scope['targetId']:
        raise IncompleteActionEvidence('invalid scope targetId')
    if type(scope['windowStart']) not in (int, float) or type(scope['windowEnd']) not in (int, float):
        raise IncompleteActionEvidence('capture window must be numeric')
    if scope['windowStart'] > scope['windowEnd']:
        raise IncompleteActionEvidence('capture window is reversed')
    declared = scope['declaredWriteOperations']
    if not isinstance(declared, list) or not all(isinstance(x, str) and x for x in declared):
        raise IncompleteActionEvidence('declared writes must be an array of operation names')
    for table, required in _TABLE_FIELDS.items():
        rows = records.get(table)
        if not isinstance(rows, list):
            raise IncompleteActionEvidence(f'missing complete {table} ledger')
        for index, row in enumerate(rows):
            if not isinstance(row, dict) or not required.issubset(row):
                raise IncompleteActionEvidence(f'{table}[{index}] lacks semantic identity/status fields')
            if type(row['at']) not in (int, float):
                raise IncompleteActionEvidence(f'{table}[{index}].at is not numeric')


def _in_scope(row, scope, *, needs_job=True, needs_principal=True):
    if not (scope['windowStart'] <= row['at'] <= scope['windowEnd']):
        return False
    if row['actionId'] not in _set(scope, 'actionIds') or row['attemptId'] not in _set(scope, 'attemptIds'):
        return False
    if row['targetId'] != scope['targetId'] or row['logicalActionKey'] not in _set(scope, 'logicalActionKeys'):
        return False
    if needs_job and row['jobId'] not in _set(scope, 'jobIds'):
        return False
    if needs_principal and row['principalId'] != scope['principalId']:
        return False
    return True


def project_submission_chain(records: dict, scope: dict) -> dict:
    """Return semantic counters from complete raw ledgers.

    The caller converts ``IncompleteActionEvidence`` into an
    ``insufficient_evidence`` result.  This function never accepts an expected
    count and therefore cannot copy the Case oracle into the observation.
    """
    _validate(records, scope)
    admissions = sum(
        row['operation'] == 'submit' and row['decision'] == 'admitted'
        and row['tokenStatus'] == 'current' and _in_scope(row, scope)
        for row in records['admissions'])
    entries = sum(
        row['operation'] == 'submit' and row['admission'] == 'admitted'
        and _in_scope(row, scope) for row in records['entries'])
    requests = sum(
        row['operation'] == 'submit' and row['dispatched'] is True
        and _in_scope(row, scope) for row in records['requests'])
    effects = sum(
        row['operation'] == 'submit' and row['status'] == 'created'
        and row['authority'] == 'target' and _in_scope(row, scope, needs_job=False, needs_principal=False)
        for row in records['effects'])
    effect_keys = {
        (row['actionId'], row['attemptId'], row['targetId'], row['logicalActionKey'], row['externalId'])
        for row in records['effects']
        if row['operation'] == 'submit' and row['status'] == 'created'
        and row['authority'] == 'target' and _in_scope(row, scope, needs_job=False, needs_principal=False)
    }
    successes = sum(
        row['status'] == 'SUCCEEDED' and row['authority'] == 'target'
        and _in_scope(row, scope, needs_job=False, needs_principal=False)
        and (row['actionId'], row['attemptId'], row['targetId'], row['logicalActionKey'], row['externalId']) in effect_keys
        for row in records['receipts'])
    declared = set(scope['declaredWriteOperations'])
    undeclared = sum(
        row['dispatched'] is True and row['operation'] not in declared
        and _in_scope(row, scope) for row in records['requests'])
    return {
        'admitted-submit-count': admissions,
        'submit-send-entry-count': entries,
        'submit-request-count': requests,
        'submit-effect-count': effects,
        'submit-success-count': successes,
        'undeclared-write-request-count': undeclared,
    }


def _rows(records, name, fields):
    rows = records.get(name)
    if not isinstance(rows, list):
        raise IncompleteActionEvidence(f'missing complete {name} records')
    for index, row in enumerate(rows):
        if not isinstance(row, dict) or not fields.issubset(row):
            raise IncompleteActionEvidence(f'{name}[{index}] lacks required fields')
    return rows


def project_action_common(records: dict, scope: dict) -> dict:
    """Derive common Actions trigger and identity checks from raw records.

    ``commandBindings`` and optional fault/barrier identities come from the
    trusted harness plan.  No expected boolean or count is accepted.  Missing
    records or identity columns remain insufficient evidence.
    """
    if not isinstance(records, dict) or not isinstance(scope, dict):
        raise IncompleteActionEvidence('records and scope must be objects')
    if set(scope) != {'commandBindings', 'faultBindings', 'barrier', 'windowStart', 'windowEnd'}:
        raise IncompleteActionEvidence('common Actions scope is incomplete or has unknown fields')
    start, end = scope['windowStart'], scope['windowEnd']
    if type(start) not in (int, float) or type(end) not in (int, float) or start > end:
        raise IncompleteActionEvidence('invalid common Actions capture window')
    bindings = scope['commandBindings']
    if not isinstance(bindings, list) or not bindings:
        raise IncompleteActionEvidence('command bindings must be a nonempty array')
    required_identity = {'principalId', 'workspaceId', 'jobId', 'actionId', 'attemptId',
                         'targetId', 'logicalActionKey'}
    by_command = {}
    for binding in bindings:
        if (not isinstance(binding, dict) or set(binding) != {'commandId', 'requestId', 'identity'} or
                not isinstance(binding['commandId'], str) or not binding['commandId'] or
                not isinstance(binding['requestId'], str) or not binding['requestId'] or
                not isinstance(binding['identity'], dict) or set(binding['identity']) != required_identity or
                not all(isinstance(value, str) and value for value in binding['identity'].values())):
            raise IncompleteActionEvidence('invalid command binding')
        if binding['commandId'] in by_command:
            raise IncompleteActionEvidence('duplicate command binding')
        by_command[binding['commandId']] = binding
    deliveries = _rows(records, 'commandDeliveries', {'commandId', 'requestId', 'status', 'at'})
    joins = _rows(records, 'identityJoins', {'commandId', 'requestId', 'identity', 'at'})
    faults = _rows(records, 'faults', {'faultId', 'requestId', 'boundary', 'injected', 'at'})
    barriers = _rows(records, 'barrierEvents', {'barrierId', 'kind', 'workerId', 'at'})
    for table, rows in [('commandDeliveries', deliveries), ('identityJoins', joins),
                        ('faults', faults), ('barrierEvents', barriers)]:
        if any(type(row['at']) not in (int, float) for row in rows):
            raise IncompleteActionEvidence(f'{table} contains a nonnumeric timestamp')

    def within(row):
        return start <= row['at'] <= end

    delivered = True
    identity_errors = 0
    for command_id, binding in by_command.items():
        matching = [row for row in deliveries if within(row) and row['commandId'] == command_id
                    and row['requestId'] == binding['requestId'] and row['status'] == 'delivered']
        if len(matching) != 1:
            delivered = False
        related = [row for row in joins if within(row) and row['commandId'] == command_id]
        if len(related) != 1:
            identity_errors += 1
            continue
        row = related[0]
        if (row['requestId'] != binding['requestId'] or not isinstance(row['identity'], dict)
                or set(row['identity']) != required_identity
                or any(row['identity'][field] != binding['identity'][field] for field in required_identity)):
            identity_errors += 1
    identity_errors += sum(within(row) and row['commandId'] not in by_command for row in joins)

    fault_bindings = scope['faultBindings']
    if not isinstance(fault_bindings, list):
        raise IncompleteActionEvidence('fault bindings must be an array')
    seen_faults = set()
    for binding in fault_bindings:
        if (not isinstance(binding, dict) or set(binding) != {'faultId', 'requestId', 'boundary'} or
                not all(isinstance(value, str) and value for value in binding.values())):
            raise IncompleteActionEvidence('invalid fault binding')
        identity = (binding['faultId'], binding['requestId'], binding['boundary'])
        if identity in seen_faults:
            raise IncompleteActionEvidence('duplicate fault binding')
        seen_faults.add(identity)
    observed_faults = sum(
        within(row) and row['injected'] is True
        and (row['faultId'], row['requestId'], row['boundary']) in seen_faults
        for row in faults)

    barrier_scope = scope['barrier']
    arrivals, released = 0, False
    if barrier_scope is not None:
        if (not isinstance(barrier_scope, dict) or set(barrier_scope) != {'barrierId', 'workerIds'} or
                not isinstance(barrier_scope['barrierId'], str) or not barrier_scope['barrierId'] or
                not isinstance(barrier_scope['workerIds'], list) or not barrier_scope['workerIds'] or
                not all(isinstance(worker, str) and worker for worker in barrier_scope['workerIds']) or
                len(set(barrier_scope['workerIds'])) != len(barrier_scope['workerIds'])):
            raise IncompleteActionEvidence('invalid barrier scope')
        barrier_id, workers = barrier_scope['barrierId'], set(barrier_scope['workerIds'])
        arrival_rows = [row for row in barriers if within(row) and row['barrierId'] == barrier_id
                        and row['kind'] == 'arrived' and row['workerId'] in workers]
        arrived_workers = {row['workerId'] for row in arrival_rows}
        arrivals = len(arrived_workers)
        release_rows = [row for row in barriers if within(row) and row['barrierId'] == barrier_id
                        and row['kind'] == 'released' and row['workerId'] == 'harness']
        released = (arrived_workers == workers and len(release_rows) == 1
                    and release_rows[0]['at'] >= max(row['at'] for row in arrival_rows))
    elif barriers:
        raise IncompleteActionEvidence('unexpected barrier records without a declared barrier')
    return {
        'command-delivered': delivered,
        'identity-join-errors': identity_errors,
        'observed-fault-count': observed_faults,
        'barrier-arrivals': arrivals,
        'barrier-released': released,
    }
