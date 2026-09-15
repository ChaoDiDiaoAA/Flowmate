"""Check aggregation shared by offline graders. Missing work never hides a failure."""
def aggregate_checks(checks):
    required = [c for c in checks if c.get('required', True) and c.get('applicable', True)]
    states = {c['status'] for c in required}
    verdict = ('FAIL' if 'FAIL' in states else 'INFRA_ERROR' if 'INFRA_ERROR' in states else
               'UNJUDGEABLE' if not required or states - {'PASS', 'NOT_APPLICABLE'} else 'PASS')
    return {'verdict': verdict, 'unresolvedCheckIds': [c['checkId'] for c in required
            if c['status'] not in {'PASS', 'FAIL', 'NOT_APPLICABLE'}]}


def validate_case(case):
    if case.get('scenarioRole') == 'control' and case.get('normalControlRefs'):
        raise ValueError('CONTROL_MUST_BE_INDEPENDENT')
    checks = case.get('oracle', {}).get('checks')
    if not isinstance(checks, list) or not checks:
        raise ValueError('REQUIRED_CHECKS_MISSING')
    ids = [c.get('checkId') for c in checks]
    if not all(isinstance(x, str) and x for x in ids) or len(set(ids)) != len(ids):
        raise ValueError('INVALID_CHECK_IDENTITIES')
    for check in checks:
        if not check.get('dimension') or type(check.get('required')) is not bool:
            raise ValueError('INVALID_CHECK_CONTRACT')
    if case.get('scenarioRole') == 'attack' and not case.get('normalControlRefs'):
        raise ValueError('ATTACK_CONTROL_MISSING')
