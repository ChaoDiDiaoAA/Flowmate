"""Publish focused Runtime error, stop and budget contracts as one revision.

The revision keeps Gold, business inputs, Case identities and module budgets
unchanged.  It rebuilds current authored Cases, coverage and Benchmark bundles,
then runs the complete candidate verifier.  It does not grant content review,
execute the product or produce Benchmark results.
"""
import json
from pathlib import Path

from rebuild_case_release import assemble_case_files, verify_case_files, verify_inventory
from rebuild_contracts import load_spec_contracts
from rebuild_dataset import verify_asset_snapshot
from rebuild_staging import read_candidate, snapshot_digest


REVISED_VERSIONS = {
    'fresh-tool-cross-source-name-collision': 2,
    'fresh-tool-spec-without-handler': 2,
    'fresh-tool-hook-unsafe-final-argument': 2,
    'fresh-tool-product-read-uses-result': 2,
    'fresh-tool-conflicting-evidence-followup': 2,
    'fresh-tool-read-error-is-not-absence': 2,
    'fresh-tool-paged-result-completeness': 2,
    'fresh-tool-malformed-output-not-success': 2,
    'fresh-tool-model-forged-scope': 2,
    'fresh-tool-result-injection-quality-read': 2,
    'fresh-tool-revoked-between-selection-execution': 2,
    'fresh-tool-read-gateway-transient-retry': 3,
    'fresh-tool-read-permanent-no-retry': 2,
    'fresh-tool-read-cancel-stop-unknown': 3,
    'fresh-tool-read-total-deadline-budget': 2,
    'fresh-rt-provider-auth': 2, 'fresh-rt-provider-protocol': 2,
    'fresh-rt-provider-cancel': 2, 'fresh-rt-provider-native-retry': 2,
    'fresh-rt-provider-read-owner': 2, 'fresh-rt-goal-cleanup-fail': 2,
    'fresh-rt-goal-accepted-survives': 3,
    'fresh-rt-events-unbound': 2, 'fresh-rt-events-commit-fail': 3,
    'fresh-rt-log-audit-fail': 2, 'fresh-rt-budget-unknown': 2,
    'fresh-rt-budget-late-usage': 2,
}
REVISED_KEYS = set(REVISED_VERSIONS)


def _validate_prior(project, snapshot):
    """Validate the indexed prior while permitting now-superseded authors."""
    verify_inventory(snapshot)
    contracts = load_spec_contracts(project)
    verify_case_files(snapshot, contracts, require_current_authors=False)
    from rebuild_spec_binding import validate_snapshot as validate_spec_binding
    from rebuild_source_revision import validate_receipt as validate_source_receipt
    from rebuild_actions_review import validate_snapshot as validate_actions_review
    from rebuild_grader_review import validate_snapshot as validate_grader_review
    from rebuild_business_review import validate_business_review_snapshot
    validate_spec_binding(project, snapshot)
    validate_source_receipt(snapshot)
    validate_actions_review(project, snapshot)
    validate_grader_review(project, snapshot)
    validate_business_review_snapshot(snapshot)
    # The coverage receipt pins its own test file.  A legitimate coverage-test
    # revision cannot replay the old receipt against new test bytes.  Other
    # durable receipts and the old indexed Case catalog are verified above;
    # build_revision replaces coverage and its receipt atomically, after which
    # verify_asset_snapshot replays the complete new state.
    report = json.loads(snapshot['manifests/preparation-report.json'])
    if (report.get('goldCandidates'), report.get('businessPackages'),
            report.get('casesPreparedInThisStep'), report.get('actualProductRuns')) != (100, 80, 548, 0):
        raise ValueError('Prior construction counts differ')
    return contracts


def build_revision(project, snapshot):
    project = Path(project).resolve()
    contracts = _validate_prior(project, snapshot)
    from rebuild_cases import compile_scenarios
    from rebuild_extraction import build_extraction_cases
    from rebuild_fixtures import registered_scenarios
    golds = [json.loads(raw) for path, raw in sorted(snapshot.items())
             if path.startswith('gold/')]
    cases = (compile_scenarios(list(registered_scenarios().values()), contracts) +
             build_extraction_cases(golds, contracts))
    outputs = assemble_case_files(snapshot, cases, contracts)
    from rebuild_coverage_review import build_revision as rebuild_coverage
    outputs = rebuild_coverage(project, outputs)
    verify_asset_snapshot(project, outputs)
    return outputs


def release(project):
    from rebuild_staging import candidate_lock, revise_candidate
    project = Path(project).resolve()
    with candidate_lock(project):
        snapshot = read_candidate(project)
    outputs = build_revision(project, snapshot)
    revised = {json.loads(raw)['id']: json.loads(raw) for path, raw in outputs.items()
               if path.startswith('cases/') and json.loads(raw)['id'] in REVISED_KEYS}
    if set(revised) != REVISED_KEYS or any(
            case.get('provenance', {}).get('authoredVersion') != REVISED_VERSIONS[identity] or
            case['version'] != REVISED_VERSIONS[identity] * 1000 + 3
            for identity, case in revised.items()):
        raise ValueError('Runtime contract revision identities or versions differ')
    result = revise_candidate(project, snapshot, outputs)
    verified = verify_asset_snapshot(project, read_candidate(project))
    result.update(
        candidateSha256=snapshot_digest(outputs),
        revisedRuntimeCases=len(revised),
        cases=verified['casesPrepared'],
        actualProductRuns=verified['actualProductRuns'],
        formalAcceptanceEligible=verified['formalAcceptanceEligible'],
    )
    return result


if __name__ == '__main__':
    import argparse
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--project', type=Path, default=Path(__file__).resolve().parents[2])
    args = parser.parse_args()
    print(json.dumps(release(args.project), ensure_ascii=False, indent=2))
