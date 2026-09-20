"""P0 Case/Oracle interpretation only; no product execution or dataset preparation."""
from __future__ import annotations

from typing import Any

STATUSES = ('PASS', 'FAIL', 'UNJUDGEABLE', 'ERROR', 'NOT_RUN')


def validate_cases(value: Any) -> list[dict]:
    if not isinstance(value, dict) or value.get('schemaVersion') != 'p0-stage-cases/v1':
        raise ValueError('expected p0-stage-cases/v1')
    cases = value.get('cases')
    if not isinstance(cases, list) or not cases:
        raise ValueError('P0 cases must not be empty')
    ids = set()
    for case in cases:
        if not isinstance(case, dict) or not isinstance(case.get('id'), str) or case['id'] in ids:
            raise ValueError('invalid or duplicate Case ID')
        ids.add(case['id'])
        if case.get('scope') not in ('product', 'asset', 'facility') or not isinstance(case.get('required'), bool):
            raise ValueError('Case needs explicit scope and required flag')
        oracle = case.get('oracle')
        if not isinstance(oracle, dict) or not any(oracle.get(k) for k in ('tests', 'assertions', 'manual')):
            raise ValueError('Case needs an executable Oracle or an explicit manual evidence gap')
        if set(oracle) - {'tests', 'assertions', 'manual'}:
            raise ValueError('unknown Oracle operation')
        for name in ('tests', 'assertions'):
            if name in oracle and (not isinstance(oracle[name], list) or any(not isinstance(rule, dict) for rule in oracle[name])):
                raise ValueError('Oracle rules must be arrays of objects')
        for rule in oracle.get('tests', []):
            if not all(isinstance(rule.get(k), str) and rule[k] for k in ('file', 'title')):
                raise ValueError('test rule needs file and title')
        for rule in oracle.get('assertions', []):
            if not isinstance(rule.get('path'), str) or len(set(rule) & {'equals', 'equalsPointer', 'minimum'}) != 1:
                raise ValueError('invalid assertion rule')
    return cases


def pointer(value: Any, path: str) -> Any:
    if path == '':
        return value
    if not isinstance(path, str) or not path.startswith('/'):
        raise ValueError('invalid JSON pointer')
    for part in path[1:].split('/'):
        key = part.replace('~1', '/').replace('~0', '~')
        if isinstance(value, list):
            if not key.isdigit():
                raise ValueError('array index must be non-negative')
            value = value[int(key)]
        else:
            value = value[key]
    return value


def _result(statuses: list[str]) -> str:
    # Confirmed failure survives missing other evidence; malformed infrastructure stays visible.
    for status in ('FAIL', 'ERROR', 'UNJUDGEABLE', 'NOT_RUN'):
        if status in statuses:
            return status
    return 'PASS' if statuses else 'ERROR'


def evaluate_case(case: dict, evidence: dict[str, Any]) -> dict:
    outcomes: list[dict] = []
    oracle = case.get('oracle', {})
    def record(status, reason): outcomes.append({'status': status, 'reason': reason})
    for rule in oracle.get('assertions', []):
        path = rule.get('path')
        label = f'{path}{rule.get("pointer", "")}'
        if path not in evidence:
            record('UNJUDGEABLE', f'missing evidence: {path}')
            continue
        try:
            actual = pointer(evidence[path], rule.get('pointer', ''))
            ops = set(rule) & {'equals', 'equalsPointer', 'minimum'}
            if len(ops) != 1 or set(rule) - {'path', 'pointer', 'equals', 'equalsPointer', 'otherPath', 'minimum'}:
                raise ValueError('unsupported assertion')
            if 'minimum' in rule:
                if type(actual) not in (int, float) or type(rule['minimum']) not in (int, float):
                    raise ValueError('minimum requires numeric evidence')
                ok = actual >= rule['minimum']
            else:
                expected = rule.get('equals')
                if 'equalsPointer' in rule:
                    other = rule.get('otherPath', path)
                    if other not in evidence:
                        raise KeyError(other)
                    expected = pointer(evidence[other], rule['equalsPointer'])
                ok = type(actual) is type(expected) and actual == expected
            record('PASS' if ok else 'FAIL', label)
        except (KeyError, IndexError):
            record('UNJUDGEABLE', f'missing field: {label}')
        except (ValueError, TypeError):
            record('ERROR', f'invalid assertion/evidence: {label}')
    for rule in oracle.get('tests', []):
        filename = rule.get('report', 'vitest-product.json')
        report = evidence.get(filename)
        if report is None:
            record('UNJUDGEABLE', f'missing test report: {filename}')
            continue
        try:
            matches = []
            for suite in report['testResults']:
                name = suite.get('name', '').replace('\\', '/')
                if name == rule['file'] or name.endswith('/' + rule['file']):
                    matches.extend(row for row in suite['assertionResults'] if row.get('title') == rule['title'])
            if not matches:
                record('NOT_RUN', f'test not executed: {rule["file"]}::{rule["title"]}')
            elif len(matches) != 1:
                record('ERROR', f'ambiguous test identity: {rule["title"]}')
            else:
                status = {'passed': 'PASS', 'failed': 'FAIL', 'pending': 'NOT_RUN', 'skipped': 'NOT_RUN', 'todo': 'NOT_RUN'}.get(matches[0].get('status'), 'ERROR')
                if status == 'FAIL' and any('[P0_FACILITY]' in str(message) for message in matches[0].get('failureMessages', [])):
                    status = 'ERROR'
                record(status, f'{rule["file"]}::{rule["title"]}')
        except (KeyError, TypeError, AttributeError):
            record('ERROR', f'malformed test report: {filename}')
    if oracle.get('manual'):
        record('NOT_RUN', oracle['manual'])
    return {'id': case['id'], 'scope': case['scope'], 'required': case['required'],
            'status': _result([row['status'] for row in outcomes]), 'observations': outcomes}


def aggregate_stage(rows: list[dict], blockers: list[str]) -> dict:
    counts = {scope: {status: 0 for status in STATUSES} for scope in ('product', 'asset', 'facility')}
    for row in rows:
        counts[row['scope']][row['status']] += 1
    required = [r['status'] for r in rows if r['required']]
    if 'FAIL' in required:
        status = 'FAIL'
    elif blockers:
        status = 'BLOCKED'
    else:
        status = _result(required)
    return {'stageStatus': status, 'productCounts': counts['product'], 'assetCounts': counts['asset'],
            'facilityCounts': counts['facility'], 'blockers': blockers, 'cases': rows}
