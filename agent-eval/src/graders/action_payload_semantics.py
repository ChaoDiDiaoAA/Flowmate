"""Independent payload/freeze projections for Actions evidence."""
from decimal import Decimal, InvalidOperation
import hashlib
import json


class IncompleteActionPayloadEvidence(ValueError):
    """The supplied payload ledgers cannot support an unambiguous projection."""


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
PAYLOAD_CHECKS = set(PAYLOAD_CHECK_COUNTS)

_FIELDS = {
    'revisions': {'revisionId', 'workspaceId', 'actionId', 'kind', 'version',
                  'invoiceNumber', 'currency', 'total', 'supplierId', 'lines',
                  'memo', 'extraFields', 'at'},
    'assessments': {'assessmentId', 'workspaceId', 'actionId', 'version',
                    'evidenceDigest', 'at'},
    'actions': {'actionId', 'workspaceId', 'revisionId', 'assessmentVersion',
                'rulesHash', 'target', 'payloadId', 'payloadHash', 'basisHash',
                'basisComponents', 'attachmentRefs', 'logicalActionKey',
                'idempotencyIdentity', 'status', 'at'},
    'payloads': {'payloadId', 'workspaceId', 'actionId', 'body', 'target',
                 'attachmentRefs', 'canonicalHash', 'at'},
    'requests': {'requestId', 'workspaceId', 'actionId', 'payloadId', 'path',
                 'environment', 'target', 'body', 'bodyHash', 'basisHash',
                 'idempotencyIdentity', 'attachmentRefs', 'at'},
    'pages': {'captureId', 'workspaceId', 'actionId', 'payloadId', 'path',
              'environment', 'target', 'body', 'bodyHash', 'basisHash',
              'effectTypes', 'attachmentRefs', 'at'},
    'artifacts': {'artifactId', 'workspaceId', 'name', 'bytesSha256', 'at'},
    'approvals': {'approvalId', 'workspaceId', 'actionId', 'actorId',
                  'recordType', 'status', 'target', 'basisHash', 'payloadHash', 'at'},
    'roleGrants': {'grantId', 'workspaceId', 'principalId', 'subjectId',
                   'configurationVersion', 'operations', 'authority', 'at'},
    'queryResults': {'resultId', 'workspaceId', 'actionId', 'source', 'version',
                     'fieldsHash', 'at'},
}


def _canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True,
                      separators=(',', ':'), allow_nan=False).encode('utf-8')


def _sha(value):
    return hashlib.sha256(_canonical(value)).hexdigest()


def _validate(records, scope):
    if not isinstance(records, dict) or set(records) != set(_FIELDS):
        raise IncompleteActionPayloadEvidence('all ten complete payload ledgers are required')
    identities = {
        'revisions': 'revisionId', 'assessments': 'assessmentId', 'actions': 'actionId',
        'payloads': 'payloadId', 'requests': 'requestId', 'pages': 'captureId',
        'artifacts': 'artifactId', 'approvals': 'approvalId', 'roleGrants': 'grantId',
        'queryResults': 'resultId',
    }
    for table, required in _FIELDS.items():
        rows = records[table]
        if not isinstance(rows, list):
            raise IncompleteActionPayloadEvidence(f'{table} is not a complete ledger')
        seen = set()
        for index, row in enumerate(rows):
            if not isinstance(row, dict) or not required.issubset(row):
                raise IncompleteActionPayloadEvidence(f'{table}[{index}] lacks required fields')
            if type(row['at']) not in (int, float):
                raise IncompleteActionPayloadEvidence(f'{table}[{index}].at is not numeric')
            identity = row[identities[table]]
            if not isinstance(identity, str) or not identity or identity in seen:
                raise IncompleteActionPayloadEvidence(f'{table} identity is missing or duplicated')
            seen.add(identity)
    expected = {'workspaceId', 'actionIds', 'currentActionId', 'windowStart', 'windowEnd',
                'targetContract', 'outputs'}
    if not isinstance(scope, dict) or set(scope) != expected:
        raise IncompleteActionPayloadEvidence('payload scope is incomplete or has unknown fields')
    if not isinstance(scope['workspaceId'], str) or not scope['workspaceId']:
        raise IncompleteActionPayloadEvidence('workspaceId is invalid')
    actions = scope['actionIds']
    if (not isinstance(actions, list) or not actions or
            not all(isinstance(value, str) and value for value in actions) or
            len(actions) != len(set(actions)) or scope['currentActionId'] not in actions):
        raise IncompleteActionPayloadEvidence('action identities are invalid')
    start, end = scope['windowStart'], scope['windowEnd']
    if type(start) not in (int, float) or type(end) not in (int, float) or start > end:
        raise IncompleteActionPayloadEvidence('capture window is invalid')
    contract = scope['targetContract']
    if (not isinstance(contract, dict) or set(contract) != {
            'id', 'requiredPaths', 'allowedPaths', 'basisOrder'} or
            contract['id'] != 'invoice-local-form-v1'):
        raise IncompleteActionPayloadEvidence('unsupported target contract')
    for key in ('requiredPaths', 'allowedPaths', 'basisOrder'):
        values = contract[key]
        if (not isinstance(values, list) or not all(isinstance(value, str) and value for value in values)
                or len(values) != len(set(values))):
            raise IncompleteActionPayloadEvidence(f'invalid target contract {key}')
    outputs = scope['outputs']
    if (not isinstance(outputs, list) or not outputs or
            not all(isinstance(value, str) and value in PAYLOAD_CHECKS for value in outputs) or
            len(outputs) != len(set(outputs))):
        raise IncompleteActionPayloadEvidence('outputs are empty, duplicated or unknown')


def _scoped(records, scope, table, *, action=True):
    rows = [row for row in records[table]
            if row['workspaceId'] == scope['workspaceId']
            and scope['windowStart'] <= row['at'] <= scope['windowEnd']]
    if action:
        rows = [row for row in rows if row['actionId'] in set(scope['actionIds'])]
    return rows


def _one(rows, description):
    if len(rows) != 1:
        raise IncompleteActionPayloadEvidence(description + ' is missing or ambiguous')
    return rows[0]


def _minor(total):
    try:
        value = Decimal(total) * 100
    except (InvalidOperation, TypeError):
        raise IncompleteActionPayloadEvidence('revision total is not exact decimal')
    if value != value.to_integral_value():
        raise IncompleteActionPayloadEvidence('revision total has nonintegral minor units')
    return int(value)


def _mapped(revision):
    lines = []
    for line in revision['lines']:
        required = {'lineId', 'orderLineId', 'quantity', 'unitPrice'}
        if not isinstance(line, dict) or not required.issubset(line):
            raise IncompleteActionPayloadEvidence('revision line cannot be mapped')
        lines.append({'line_ref': line['lineId'], 'po_line': line['orderLineId'],
                      'quantity': line['quantity'], 'price': line['unitPrice']})
    return {'invoice_no': revision['invoiceNumber'], 'currency': revision['currency'],
            'total_minor': _minor(revision['total']), 'supplier_id': revision['supplierId'],
            'lines': lines}


def _path_exists(value, path):
    current = value
    for part in path.replace(']', '').replace('[', '.').split('.'):
        if part == '':
            continue
        if isinstance(current, list):
            try:
                current = current[int(part)]
            except (ValueError, IndexError):
                return False
        elif isinstance(current, dict) and part in current:
            current = current[part]
        else:
            return False
    return current is not None and current != ''


def _leaf_paths(value, prefix=''):
    if isinstance(value, dict):
        result = []
        for key, child in value.items():
            result.extend(_leaf_paths(child, f'{prefix}.{key}' if prefix else key))
        return result
    if isinstance(value, list):
        result = []
        for index, child in enumerate(value):
            result.extend(_leaf_paths(child, f'{prefix}[{index}]'))
        return result
    return [prefix]


def _payload_mismatches(payload, rows):
    expected_hash = _sha(payload['body'])
    mismatches = 0
    for row in rows:
        if (row['payloadId'] != payload['payloadId'] or row['body'] != payload['body'] or
                row['bodyHash'] != expected_hash or row['target'] != payload['target'] or
                row['attachmentRefs'] != payload['attachmentRefs']):
            mismatches += 1
    return mismatches


def project_action_payload(records: dict, scope: dict) -> dict:
    """Project payload and frozen-basis observations without a Case oracle."""
    _validate(records, scope)
    current_id = scope['currentActionId']
    actions = _scoped(records, scope, 'actions')
    current = _one([row for row in actions if row['actionId'] == current_id], 'current action')
    revisions = _scoped(records, scope, 'revisions')
    accepted = _one([row for row in revisions if row['revisionId'] == current['revisionId']],
                    'accepted revision')
    candidates = sorted((row for row in revisions if row['kind'] == 'candidate'),
                        key=lambda row: (row['version'], row['at']))
    if not candidates:
        raise IncompleteActionPayloadEvidence('candidate revision is missing')
    payloads = _scoped(records, scope, 'payloads')
    payload = _one([row for row in payloads if row['payloadId'] == current['payloadId']],
                   'current payload')
    assessments = _scoped(records, scope, 'assessments')
    if not any(row['version'] == current['assessmentVersion'] for row in assessments):
        raise IncompleteActionPayloadEvidence('frozen assessment version is missing')
    requests = _scoped(records, scope, 'requests')
    pages = _scoped(records, scope, 'pages')
    artifacts = _scoped(records, scope, 'artifacts', action=False)
    approvals = _scoped(records, scope, 'approvals')
    grants = _scoped(records, scope, 'roleGrants', action=False)
    queries = _scoped(records, scope, 'queryResults')
    mapped = _mapped(accepted)
    contract = scope['targetContract']
    missing = [path for path in contract['requiredPaths'] if not _path_exists(mapped, path)]
    allowed = set(contract['allowedPaths'])
    extras = [path for path in _leaf_paths(payload['body']) if path not in allowed]
    action_refs = current['attachmentRefs']
    if not isinstance(action_refs, list):
        raise IncompleteActionPayloadEvidence('action attachmentRefs is not an array')
    joined = []
    conflicts = 0
    for ref in action_refs:
        if (not isinstance(ref, dict) or set(ref) != {'artifactId', 'workspaceId', 'name', 'sha256'} or
                ref['workspaceId'] != scope['workspaceId']):
            raise IncompleteActionPayloadEvidence('attachment reference is invalid')
        artifact = _one([row for row in artifacts if row['artifactId'] == ref['artifactId']],
                        'attachment artifact')
        joined.append({'artifact': artifact['artifactId'], 'workspace': artifact['workspaceId'],
                       'sha256': artifact['bytesSha256']})
        if artifact['name'] == ref['name'] and artifact['bytesSha256'] != ref['sha256']:
            conflicts += 1
    hashes = [_sha(row['body']) for row in payloads]
    hash_mismatches = sum(row['canonicalHash'] != digest for row, digest in zip(payloads, hashes))
    hash_mismatches += int(current['payloadHash'] != payload['canonicalHash'])
    request_mismatches = _payload_mismatches(payload, requests)
    page_mismatches = _payload_mismatches(payload, pages)
    target_mismatches = sum(
        row['target'] != current['target'] or row['basisHash'] != current['basisHash']
        for row in approvals if row['status'] == 'approved')
    query_groups = {}
    for row in queries:
        query_groups.setdefault(row['version'], set()).add(row['fieldsHash'])
    latest_grant = _one([row for row in grants if row['authority'] == 'role_configuration'
                         and row['configurationVersion'] == max(
                             (candidate['configurationVersion'] for candidate in grants), default=-1)],
                        'current role grant')
    actual_records = requests + pages
    if not actual_records:
        raise IncompleteActionPayloadEvidence('actual request or page evidence is missing')
    actual_paths = {row['path'] for row in actual_records}
    actual_environments = {row['environment'] for row in actual_records}
    if len(actual_paths) != 1 or len(actual_environments) != 1:
        raise IncompleteActionPayloadEvidence('actual target path or environment is ambiguous')
    values = {
        'mapped-fields': mapped,
        'attachment-identity': joined[0] if len(joined) == 1 else joined,
        'preview-target': [current['target']['system'], current['target']['environment'],
                           current['target']['organization']],
        'frozen-basis-components': [name for name in contract['basisOrder']
                                    if name in current['basisComponents']],
        'total-minor': _minor(accepted['total']),
        'revision-total': accepted['total'],
        'payload-hash-mismatch-count': hash_mismatches,
        'missing-target-fields': missing,
        'attachment-digest-conflicts': conflicts,
        'distinct-frozen-actions': len({row['actionId'] for row in actions}),
        'target-basis-mismatch-count': target_mismatches,
        'candidate-invoice-number': candidates[0]['invoiceNumber'],
        'payload-invoice-number': payload['body'].get('invoice_no'),
        'revision-ids': [row['revisionId'] for row in sorted(revisions, key=lambda row: row['version'])],
        'assessment-versions': [row['version'] for row in sorted(assessments, key=lambda row: row['version'])],
        'approval-record-count': len({row['approvalId'] for row in approvals}),
        'review-and-approval-actors': [row['actorId'] for row in sorted(approvals, key=lambda row: row['at'])
                                       if row['recordType'] in {'review', 'approval'}],
        'role-grant-authority': {'principal': latest_grant['principalId'],
                                 'configurationVersion': latest_grant['configurationVersion'],
                                 'subject': latest_grant['subjectId'],
                                 'granted': latest_grant['operations']},
        'actual-path': next(iter(actual_paths)),
        'actual-environment': next(iter(actual_environments)),
        'request-payload-mismatches': request_mismatches,
        'page-payload-mismatches': page_mismatches,
        'request-or-page-payload-mismatches': request_mismatches + page_mismatches,
        'effect-types': sorted({value for row in pages for value in row['effectTypes']}),
        'canonical-logical-keys': len({row['logicalActionKey'] for row in actions}),
        'idempotency-identities': len({row['idempotencyIdentity'] for row in actions + requests}),
        'query-semantic-mismatches': sum(len(values) - 1 for values in query_groups.values()),
        'target-extra-fields': extras,
        'unmapped-source-fields': sorted(accepted['extraFields']),
        'revision-memo': accepted['memo'],
    }
    return {output: values[output] for output in scope['outputs']}
