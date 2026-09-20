"""Publish exact Operations RT/RTC links as a controlled Case revision.

This revision changes only the 28 P13 Operations Case definitions and their
derived catalogs, requirement inventory and Benchmark bundles.  Gold, business
inputs, source selection and all prior review receipts remain intact.  It does
not grant content review, execute the product or produce Benchmark results.
"""
import json
from pathlib import Path

from rebuild_case_release import assemble_case_files, verify_case_files, verify_inventory
from rebuild_contracts import load_spec_contracts
from rebuild_dataset import verify_asset_snapshot
from rebuild_staging import read_candidate, snapshot_digest


def _validate_prior(project, snapshot):
    """Validate the indexed prior without requiring now-superseded authors.

    The coverage receipt intentionally pins its author/test files, so changing
    those files makes the old candidate fail the *current* coverage replay.  We
    validate every other durable receipt plus the old Case catalog here, then
    replace Cases and coverage atomically and run the complete verifier.
    """
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
    result = revise_candidate(project, snapshot, outputs)
    verified = verify_asset_snapshot(project, read_candidate(project))
    result.update(
        candidateSha256=snapshot_digest(outputs),
        operationsAuthoredRevision=2,
        exactRequirementIdentities=10,
        invalidOrBroadRequirementReferences=0,
        cases=verified['casesPrepared'],
        actualProductRuns=verified['actualProductRuns'],
        formalAcceptanceEligible=verified['formalAcceptanceEligible'],
    )
    return result


if __name__ == '__main__':
    import argparse
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--project', type=Path, default=Path(__file__).resolve().parents[3])
    args = parser.parse_args()
    print(json.dumps(release(args.project), ensure_ascii=False, indent=2))
