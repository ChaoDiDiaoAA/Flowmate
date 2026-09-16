"""Approved invoice scope and preparation budgets; counts are not coverage claims."""

SCOPE_ID = 'invoice-b2b-no-erp-writeback'
RETIRED_FAMILIES = frozenset({
    'matching/verification-unknown', 'matching/verification-invalid',
    'approval/over-limit', 'approval/at-limit', 'approval/erp-outside-scope',
    'submission/erp-confirmed', 'submission/erp-retry-only',
    'submission/erp-response-lost', 'submission/erp-scope-missing',
})
# These are surviving allocations from the checked 6,000-case baseline. Removed
# cases are not redistributed into other families to fill an obsolete quota.
CASE_COUNTS = {'extraction': 1200, 'matching': 890, 'approval': 487,
               'submission': 800, 'runtime': 1000, 'isolation': 800, 'platform': 400}
REVIEW_BATCHES = [(100, 50, 500), (500, 250, 2500), (1200, 600, sum(CASE_COUNTS.values()))]
