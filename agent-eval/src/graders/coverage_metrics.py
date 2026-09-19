"""Deterministic aggregate facility primitives. No product evidence or PASS issuance."""
from decimal import Decimal

STATUSES = {'PASS', 'FAIL', 'UNJUDGEABLE', 'ERROR', 'NOT_RUN'}


def ratio(numerator, denominator, *, evidence_complete=True):
    if type(evidence_complete) is not bool:
        raise ValueError('evidence_complete must be boolean')
    if not evidence_complete:
        return {'status': 'insufficient_evidence', 'value': None}
    if type(numerator) is not int or type(denominator) is not int or not 0 <= numerator <= denominator:
        raise ValueError('invalid population counts')
    return {'status': 'not_computable' if denominator == 0 else 'computed',
            'value': None if denominator == 0 else numerator / denominator}


def outcomes(planned_ids, records):
    if len(set(planned_ids)) != len(planned_ids):
        raise ValueError('duplicate planned identity')
    actual = {}
    for row in records:
        if set(row) != {'id', 'status', 'started'} or row['id'] not in planned_ids or row['status'] not in STATUSES or type(row['started']) is not bool:
            raise ValueError('unknown observation')
        if row['id'] in actual:
            raise ValueError('duplicate execution identity')
        if row['status'] in {'PASS', 'FAIL'} and not row['started']:
            raise ValueError('judged unstarted execution')
        actual[row['id']] = row
    counts = {s: sum(r['status'] == s for r in actual.values()) for s in STATUSES}
    counts['NOT_RUN'] += len(planned_ids) - len(actual)
    n = len(planned_ids)
    return {'counts': counts, 'planned': n,
            'executed': ratio(sum(r['started'] for r in actual.values()), n),
            'judgeable': ratio(counts['PASS'] + counts['FAIL'], n),
            'pass': ratio(counts['PASS'], counts['PASS'] + counts['FAIL']),
            'confirmed': ratio(counts['PASS'], n), 'scope': 'facility_calculation'}


def stability(planned_cases, k, records):
    if type(k) is not int or k < 1 or len(set(planned_cases)) != len(planned_cases):
        raise ValueError('invalid frozen repeat plan')
    slots = {}
    for r in records:
        if set(r) != {'caseId', 'repeatIndex', 'status'} or r['caseId'] not in planned_cases or type(r['repeatIndex']) is not int or not 0 <= r['repeatIndex'] < k or r['status'] not in STATUSES:
            raise ValueError('unknown repeat slot')
        key = (r['caseId'], r['repeatIndex'])
        if key in slots:
            raise ValueError('duplicate repeat slot')
        slots[key] = r['status']
    seq = [[slots.get((c, i), 'NOT_RUN') for i in range(k)] for c in planned_cases]
    return {'first': ratio(sum(s[0] == 'PASS' for s in seq), len(seq)),
            'passAtK': ratio(sum('PASS' in s for s in seq), len(seq)),
            'passPowerK': ratio(sum(all(x == 'PASS' for x in s) for s in seq), len(seq)),
            'missingSlots': len(planned_cases) * k - len(slots), 'independentCases': len(seq)}


def latency(records):
    values, censored = [], []
    ids = set()
    for r in records:
        if set(r) != {'id', 'start', 'end', 'cutoff', 'startClock', 'endClock'} or r['id'] in ids:
            raise ValueError('invalid latency record')
        ids.add(r['id'])
        if r['startClock'] != r['endClock']:
            raise ValueError('incomparable clocks')
        start, cutoff = Decimal(str(r['start'])), Decimal(str(r['cutoff']))
        end = None if r['end'] is None else Decimal(str(r['end']))
        if not start.is_finite() or not cutoff.is_finite() or cutoff < start or (end is not None and (not end.is_finite() or end < start)):
            raise ValueError('invalid timestamp order')
        if end is None or end > cutoff:
            censored.append({'id': r['id'], 'age': str(cutoff-start)})
        else:
            values.append(str(end-start))
    return {'completedDurations': values, 'rightCensored': censored, 'overdue': ratio(len(censored), len(records))}


def cost(entries, processed, completed):
    if type(processed) is not int or type(completed) is not int or not 0 <= completed <= processed:
        raise ValueError('invalid cost population')
    known = Decimal(0); unknown = 0; ids = set(); currency = None
    for e in entries:
        if set(e) != {'id', 'amount', 'currency'} or e['id'] in ids:
            raise ValueError('invalid cost entry')
        ids.add(e['id'])
        if not isinstance(e['currency'], str) or not e['currency'] or currency not in (None, e['currency']):
            raise ValueError('mixed or missing currency')
        currency = e['currency']
        if e['amount'] is None:
            unknown += 1
        else:
            amount = Decimal(str(e['amount']))
            if not amount.is_finite() or amount < 0:
                raise ValueError('invalid amount')
            known += amount
    # Empty/missing cost evidence cannot prove a zero-cost execution.
    complete = bool(entries) and not unknown
    return {'knownAmount': str(known), 'unknownEntries': unknown, 'currency': currency,
            'total': str(known) if complete else None,
            'perProcessed': str(known/processed) if complete and processed else None,
            'perCompleted': str(known/completed) if complete and completed else None}


def compression(before, after, same_boundary):
    if type(before) is not int or type(after) is not int or min(before, after) < 0:
        raise ValueError('invalid token counts')
    if same_boundary is not True or before == 0:
        return None
    return (before-after)/before  # Negative savings are retained.
