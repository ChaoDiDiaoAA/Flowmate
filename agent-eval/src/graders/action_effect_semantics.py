"""Semantic counters for Actions requests, admissions and target effects.

The projector consumes complete ledgers plus trusted Trial identities and
boundary timestamps.  It never consumes an expected counter.  Missing tables,
critical columns, required boundaries or ambiguous receipt/effect joins are
reported as insufficient evidence by raising ``IncompleteActionEffectEvidence``.
"""
from collections import Counter


class IncompleteActionEffectEvidence(ValueError):
    """The supplied action/effect ledgers cannot support a projection."""


EFFECT_CHECK_COUNTS = {
    'admission-count': 3,
    'attempt-send-entry-count': 1,
    'authoritative-success-count': 5,
    'authorized-query-count': 1,
    'browser-submit-requests': 2,
    'business-effects': 8,
    'duplicate-command-effects': 1,
    'expired-run-scope-uses': 1,
    'network-requests': 26,
    'new-write-requests': 1,
    'resend-requests': 3,
    'sends-before-current-approval': 1,
    'stale-suggestion-authorized-operations': 1,
    'submit-after-resume-count': 1,
    'submit-requests': 4,
    'submitted-invoices': 1,
    'unauthorized-effects': 2,
    'writes-after-kill': 1,
    'writes-after-schema-change': 1,
    'writes-after-stop': 1,
}

EFFECT_CHECKS = set(EFFECT_CHECK_COUNTS)

_FIELDS = {
    'admissions': {
        'admissionId', 'workspaceId', 'jobId', 'actionId', 'attemptId',
        'principalId', 'operation', 'decision', 'tokenId', 'tokenStatus', 'at',
    },
    'sendEntries': {
        'entryId', 'workspaceId', 'jobId', 'actionId', 'attemptId',
        'principalId', 'operation', 'phase', 'approvalId', 'at',
    },
    'requests': {
        'requestId', 'workspaceId', 'jobId', 'actionId', 'attemptId',
        'principalId', 'operation', 'channel', 'purpose', 'retryOf',
        'authorization', 'runScopeStatus', 'suggestionStatus', 'at',
    },
    'effects': {
        'effectId', 'workspaceId', 'jobId', 'actionId', 'attemptId',
        'targetId', 'logicalActionKey', 'effectType', 'status', 'authority',
        'authorized', 'requestId', 'at',
    },
    'receipts': {
        'receiptId', 'workspaceId', 'actionId', 'attemptId', 'targetId',
        'logicalActionKey', 'status', 'authority', 'effectId', 'at',
    },
}

_BOUNDARY_FOR = {
    'new-write-requests': 'newWorkAt',
    'submit-after-resume-count': 'resumeAt',
    'writes-after-schema-change': 'schemaChangeAt',
    'writes-after-kill': 'killAt',
    'writes-after-stop': 'stopAt',
    'sends-before-current-approval': 'approvalCurrentAt',
}


def _ids(scope, key):
    values = scope[key]
    if not isinstance(values, list) or not values or not all(
            isinstance(value, str) and value for value in values):
        raise IncompleteActionEffectEvidence(f'invalid {key}')
    if len(values) != len(set(values)):
        raise IncompleteActionEffectEvidence(f'duplicate {key}')
    return set(values)


def _validate(records, scope):
    if not isinstance(records, dict) or set(records) != set(_FIELDS):
        raise IncompleteActionEffectEvidence('five complete action/effect ledgers are required')
    for table, required in _FIELDS.items():
        rows = records[table]
        if not isinstance(rows, list):
            raise IncompleteActionEffectEvidence(f'{table} is not a complete ledger')
        seen = set()
        identity_field = {
            'admissions': 'admissionId', 'sendEntries': 'entryId',
            'requests': 'requestId', 'effects': 'effectId', 'receipts': 'receiptId',
        }[table]
        for index, row in enumerate(rows):
            if not isinstance(row, dict) or not required.issubset(row):
                raise IncompleteActionEffectEvidence(f'{table}[{index}] lacks semantic fields')
            if type(row['at']) not in (int, float):
                raise IncompleteActionEffectEvidence(f'{table}[{index}].at is not numeric')
            identity = row[identity_field]
            if not isinstance(identity, str) or not identity or identity in seen:
                raise IncompleteActionEffectEvidence(f'{table} identity is missing or duplicated')
            seen.add(identity)
    expected = {
        'workspaceId', 'jobIds', 'actionIds', 'attemptIds', 'targetIds',
        'logicalActionKeys', 'principalIds', 'windowStart', 'windowEnd',
        'declaredWriteOperations', 'boundaries', 'outputs',
    }
    if not isinstance(scope, dict) or set(scope) != expected:
        raise IncompleteActionEffectEvidence('effect scope is incomplete or has unknown fields')
    if not isinstance(scope['workspaceId'], str) or not scope['workspaceId']:
        raise IncompleteActionEffectEvidence('invalid workspaceId')
    for key in ('jobIds', 'actionIds', 'attemptIds', 'targetIds',
                'logicalActionKeys', 'principalIds'):
        _ids(scope, key)
    start, end = scope['windowStart'], scope['windowEnd']
    if type(start) not in (int, float) or type(end) not in (int, float) or start > end:
        raise IncompleteActionEffectEvidence('invalid capture window')
    writes = scope['declaredWriteOperations']
    if not isinstance(writes, list) or not writes or not all(
            isinstance(value, str) and value for value in writes):
        raise IncompleteActionEffectEvidence('declared writes are invalid')
    boundaries = scope['boundaries']
    if not isinstance(boundaries, dict) or set(boundaries) != {
            'newWorkAt', 'resumeAt', 'schemaChangeAt', 'killAt', 'stopAt',
            'approvalCurrentAt'}:
        raise IncompleteActionEffectEvidence('boundary map is incomplete or has unknown fields')
    if any(value is not None and type(value) not in (int, float)
           for value in boundaries.values()):
        raise IncompleteActionEffectEvidence('boundary timestamp is invalid')
    outputs = scope['outputs']
    if (not isinstance(outputs, list) or not outputs or
            not all(isinstance(value, str) and value in EFFECT_CHECKS for value in outputs) or
            len(outputs) != len(set(outputs))):
        raise IncompleteActionEffectEvidence('outputs are empty, duplicated or unknown')
    for output in outputs:
        boundary = _BOUNDARY_FOR.get(output)
        if boundary and boundaries[boundary] is None:
            raise IncompleteActionEffectEvidence(f'{output} requires {boundary}')


def _in_scope(row, scope, *, target=False):
    if row['workspaceId'] != scope['workspaceId']:
        return False
    if not scope['windowStart'] <= row['at'] <= scope['windowEnd']:
        return False
    if row['actionId'] not in _ids(scope, 'actionIds') or row['attemptId'] not in _ids(scope, 'attemptIds'):
        return False
    if target:
        return (row['targetId'] in _ids(scope, 'targetIds') and
                row['logicalActionKey'] in _ids(scope, 'logicalActionKeys'))
    return (row['jobId'] in _ids(scope, 'jobIds') and
            row['principalId'] in _ids(scope, 'principalIds'))


def _request_rows(records, scope):
    return [row for row in records['requests'] if _in_scope(row, scope)]


def _effect_rows(records, scope):
    return [row for row in records['effects'] if _in_scope(row, scope, target=True)]


def project_action_effects(records: dict, scope: dict) -> dict:
    """Return requested semantic counters without reading expected values."""
    _validate(records, scope)
    requests = _request_rows(records, scope)
    effects = _effect_rows(records, scope)
    admissions = [row for row in records['admissions'] if _in_scope(row, scope)]
    entries = [row for row in records['sendEntries'] if _in_scope(row, scope)]
    receipts = [row for row in records['receipts']
                if row['workspaceId'] == scope['workspaceId']
                and scope['windowStart'] <= row['at'] <= scope['windowEnd']
                and row['actionId'] in _ids(scope, 'actionIds')
                and row['attemptId'] in _ids(scope, 'attemptIds')
                and row['targetId'] in _ids(scope, 'targetIds')
                and row['logicalActionKey'] in _ids(scope, 'logicalActionKeys')]
    applied = [row for row in effects if row['status'] == 'applied' and row['authority'] == 'target']
    applied_by_id = {row['effectId']: row for row in applied}
    successes = [row for row in receipts
                 if row['status'] == 'SUCCEEDED' and row['authority'] == 'target'
                 and row['effectId'] in applied_by_id
                 and applied_by_id[row['effectId']]['actionId'] == row['actionId']
                 and applied_by_id[row['effectId']]['attemptId'] == row['attemptId']]
    writes = set(scope['declaredWriteOperations'])
    values = {
        'network-requests': len({row['requestId'] for row in requests}),
        'business-effects': len({row['effectId'] for row in applied}),
        'authoritative-success-count': len({row['effectId'] for row in successes}),
        'submit-requests': len({row['requestId'] for row in requests if row['operation'] == 'submit'}),
        'admission-count': len({row['admissionId'] for row in admissions
                                if row['decision'] == 'admitted' and row['tokenStatus'] == 'current'}),
        'resend-requests': len({row['requestId'] for row in requests if row['retryOf'] is not None}),
        'browser-submit-requests': len({row['requestId'] for row in requests
                                        if row['operation'] == 'submit' and row['channel'] == 'browser'}),
        'unauthorized-effects': len({row['effectId'] for row in applied if row['authorized'] is False}),
        'attempt-send-entry-count': len({row['entryId'] for row in entries if row['phase'] == 'entered'}),
        'authorized-query-count': len({row['requestId'] for row in requests
                                       if row['operation'] == 'query' and row['authorization'] == 'authorized'}),
        'new-write-requests': len({row['requestId'] for row in requests
                                   if row['operation'] in writes and row['at'] >= scope['boundaries']['newWorkAt']}),
        'submit-after-resume-count': len({row['requestId'] for row in requests
                                          if row['operation'] == 'submit'
                                          and row['at'] >= scope['boundaries']['resumeAt']}),
        'submitted-invoices': len({row['effectId'] for row in applied
                                   if row['effectType'] == 'invoice_created'}),
        'writes-after-schema-change': len({row['requestId'] for row in requests
                                           if row['operation'] in writes
                                           and row['at'] > scope['boundaries']['schemaChangeAt']}),
        'writes-after-kill': len({row['requestId'] for row in requests
                                  if row['operation'] in writes
                                  and row['at'] > scope['boundaries']['killAt']}),
        'writes-after-stop': len({row['requestId'] for row in requests
                                  if row['operation'] in writes
                                  and row['at'] > scope['boundaries']['stopAt']}),
        'sends-before-current-approval': len({row['entryId'] for row in entries
                                              if row['phase'] == 'entered'
                                              and row['at'] < scope['boundaries']['approvalCurrentAt']}),
        'expired-run-scope-uses': len({row['requestId'] for row in requests
                                       if row['runScopeStatus'] == 'expired'}),
        'stale-suggestion-authorized-operations': len({row['requestId'] for row in requests
                                                       if row['suggestionStatus'] == 'stale'
                                                       and row['authorization'] == 'authorized'}),
    }
    effect_groups = Counter(row['requestId'] for row in applied)
    values['duplicate-command-effects'] = sum(count - 1 for count in effect_groups.values() if count > 1)
    return {output: values[output] for output in scope['outputs']}
