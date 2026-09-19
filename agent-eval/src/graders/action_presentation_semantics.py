"""Trusted projection for Actions model reports, errors and workbench views."""
from copy import deepcopy


class IncompleteActionPresentationEvidence(ValueError):
    """The supplied presentation ledgers cannot support a projection."""


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
PRESENTATION_CHECKS = set(PRESENTATION_CHECK_COUNTS)

_FIELDS = {
    'modelReports': {'reportId', 'workspaceId', 'jobId', 'actionId', 'ownership',
                     'reportedActionStatus', 'reportedJobStatus', 'acknowledgesUnknown',
                     'claimsSubmission', 'grounded', 'at'},
    'diagnostics': {'diagnosticId', 'workspaceId', 'jobId', 'name',
                    'required', 'present', 'at'},
    'errors': {'recordId', 'workspaceId', 'layer', 'descriptor', 'at'},
    'views': {'viewId', 'workspaceId', 'jobId', 'actionId', 'attemptId',
              'kind', 'authorized', 'fields', 'at'},
    'steps': {'stepId', 'workspaceId', 'jobId', 'state', 'owner', 'reason',
              'checkpoint', 'allowed', 'history', 'visible', 'current', 'at'},
    'appConfigs': {'configId', 'workspaceId', 'contextIsolation', 'nodeIntegration', 'at'},
    'jobTransitions': {'transitionId', 'workspaceId', 'jobId', 'status', 'cause', 'at'},
}
_ID_FIELD = {
    'modelReports': 'reportId', 'diagnostics': 'diagnosticId', 'errors': 'recordId',
    'views': 'viewId', 'steps': 'stepId', 'appConfigs': 'configId',
    'jobTransitions': 'transitionId',
}
_SAFE_ERROR_FIELDS = {
    'schemaVersion', 'errorId', 'code', 'category', 'source', 'safeMessage',
    'impactScope', 'recoveryAction', 'requestId', 'jobId',
}
_UNSAFE_NAMES = {'error', 'cause', 'stack', 'trace', 'secret', 'credential', 'token'}


def _ids(scope, key):
    values = scope[key]
    if (not isinstance(values, list) or not values or
            not all(isinstance(value, str) and value for value in values) or
            len(values) != len(set(values))):
        raise IncompleteActionPresentationEvidence(f'invalid {key}')
    return set(values)


def _validate(records, scope):
    if not isinstance(records, dict) or set(records) != set(_FIELDS):
        raise IncompleteActionPresentationEvidence('all presentation ledgers are required')
    for table, required in _FIELDS.items():
        rows = records[table]
        if not isinstance(rows, list):
            raise IncompleteActionPresentationEvidence(f'{table} is not a ledger')
        seen = set()
        for index, row in enumerate(rows):
            if not isinstance(row, dict) or not required.issubset(row):
                raise IncompleteActionPresentationEvidence(f'{table}[{index}] lacks semantic fields')
            identity = row[_ID_FIELD[table]]
            if not isinstance(identity, str) or not identity or identity in seen:
                raise IncompleteActionPresentationEvidence(f'{table} identity is missing or duplicated')
            seen.add(identity)
            if type(row['at']) not in (int, float):
                raise IncompleteActionPresentationEvidence(f'{table}[{index}].at is invalid')
    expected = {'workspaceId', 'jobIds', 'actionIds', 'attemptIds',
                'windowStart', 'windowEnd', 'outputs'}
    if not isinstance(scope, dict) or set(scope) != expected:
        raise IncompleteActionPresentationEvidence('presentation scope is incomplete or unknown')
    if not isinstance(scope['workspaceId'], str) or not scope['workspaceId']:
        raise IncompleteActionPresentationEvidence('invalid workspaceId')
    for key in ('jobIds', 'actionIds', 'attemptIds'):
        _ids(scope, key)
    start, end = scope['windowStart'], scope['windowEnd']
    if type(start) not in (int, float) or type(end) not in (int, float) or start > end:
        raise IncompleteActionPresentationEvidence('invalid capture window')
    outputs = scope['outputs']
    if (not isinstance(outputs, list) or not outputs or len(outputs) != len(set(outputs)) or
            not all(value in PRESENTATION_CHECKS for value in outputs)):
        raise IncompleteActionPresentationEvidence('outputs are empty, duplicated or unknown')


def _in_window(row, scope):
    return (row['workspaceId'] == scope['workspaceId'] and
            scope['windowStart'] <= row['at'] <= scope['windowEnd'])


def _latest(rows):
    return max(rows, key=lambda row: row['at']) if rows else None


def _unsafe_count(value, *, top=False):
    if isinstance(value, dict):
        count = 0
        for key, nested in value.items():
            lower = str(key).lower()
            if (not top and any(name in lower for name in _UNSAFE_NAMES)):
                count += 1
            count += _unsafe_count(nested)
        return count
    if isinstance(value, list):
        return sum(_unsafe_count(item) for item in value)
    if isinstance(value, str):
        lowered = value.lower()
        return int('secret-token' in lowered or 'begin private key' in lowered)
    return 0


def _reported_state(report):
    if not report or report['grounded'] is not True:
        return 'unsupported_or_incomplete'
    action = report['reportedActionStatus']
    job = report['reportedJobStatus']
    if action == 'succeeded' and job == 'completed' and report['claimsSubmission'] is True:
        return 'action_succeeded_job_completed'
    if action == 'unknown' and job == 'reconciling' and report['acknowledgesUnknown'] is True:
        return 'unknown_reconciliation_required'
    if (report['ownership'] == 'human_owned' and report['claimsSubmission'] is False
            and job in {'waiting', 'reviewing'}):
        return 'awaiting_human_no_submission'
    return 'unsupported_or_incomplete'


def project_action_presentation(records: dict, scope: dict) -> dict:
    """Derive requested report/error/view observations without oracle values."""
    _validate(records, scope)
    jobs, actions, attempts = (_ids(scope, 'jobIds'), _ids(scope, 'actionIds'),
                               _ids(scope, 'attemptIds'))
    reports = [row for row in records['modelReports'] if _in_window(row, scope)
               and row['jobId'] in jobs and row['actionId'] in actions]
    diagnostics = [row for row in records['diagnostics'] if _in_window(row, scope)
                   and row['jobId'] in jobs]
    errors = sorted((row for row in records['errors'] if _in_window(row, scope)),
                    key=lambda row: row['at'])
    views = [row for row in records['views'] if _in_window(row, scope)
             and row['jobId'] in jobs and row['actionId'] in actions
             and row['attemptId'] in attempts]
    steps = sorted((row for row in records['steps'] if _in_window(row, scope)
                    and row['jobId'] in jobs and row['current'] is True),
                   key=lambda row: row['at'])
    configs = [row for row in records['appConfigs'] if _in_window(row, scope)]
    transitions = [row for row in records['jobTransitions'] if _in_window(row, scope)
                   and row['jobId'] in jobs]
    for row in views:
        if not isinstance(row['fields'], dict):
            raise IncompleteActionPresentationEvidence('view fields must be an object')
    for row in steps:
        if not isinstance(row['allowed'], list) or not isinstance(row['history'], list):
            raise IncompleteActionPresentationEvidence('step lists are invalid')
    status_view = _latest([row for row in views if row['kind'] == 'status'])
    session_view = _latest([row for row in views if row['kind'] == 'session'])
    error_view = _latest([row for row in views if row['kind'] == 'error'])
    latest_config = _latest(configs)
    error_projection = error_view['fields'].get('error') if error_view else None
    unsafe = _unsafe_count(error_projection, top=True) if error_projection is not None else 0
    if (not isinstance(error_projection, dict) or
            set(error_projection) != _SAFE_ERROR_FIELDS or unsafe):
        safe_projection = None
    else:
        safe_projection = deepcopy(error_projection)
    status = status_view['fields'] if status_view else {}
    active_steps = [row for row in steps if row['visible'] is True]
    step_facts = {
        row['stepId']: {
            'state': row['state'], 'owner': row['owner'], 'reason': row['reason'],
            'checkpoint': row['checkpoint'], 'allowed': deepcopy(row['allowed']),
            'history': deepcopy(row['history']),
        }
        for row in active_steps
    }
    values = {
        'model-reported-state': _reported_state(_latest(reports)),
        'diagnostic-gaps': [row['name'] for row in diagnostics
                            if row['required'] is True and row['present'] is not True],
        'error-descriptor-chain': [deepcopy(row['descriptor']) for row in errors],
        'error-caused-job-rejections': sum(
            row['status'] == 'rejected' and row['cause'] == 'error' for row in transitions),
        'unsafe-error-field-count': unsafe,
        'desktop-session-title': (session_view['fields'].get('title')
                                  if session_view else None),
        'visible-active-step-ids': [row['stepId'] for row in active_steps],
        'waiting-reasons': [row['reason'] for row in active_steps
                            if row['state'] == 'waiting'],
        'step-view-facts': step_facts,
        'unauthorized-view-records': sum(row['authorized'] is not True for row in views),
        'electron-isolation': ({'contextIsolation': latest_config['contextIsolation'],
                                'nodeIntegration': latest_config['nodeIntegration']}
                               if latest_config else None),
        'view-approval-status': status.get('approvalStatus'),
        'view-job-status': status.get('jobStatus'),
        'view-action-status': status.get('actionStatus'),
        'safe-error-projection': safe_projection,
        'view-attempt-status': status.get('attemptStatus'),
        'view-run-status': status.get('runStatus'),
        'view-waiting-owner': status.get('waitingOwner'),
    }
    return {output: values[output] for output in scope['outputs']}
