"""Publish reviewed atomic requirement-to-check links in the fresh candidate.

This is a metadata/content revision only.  It rebuilds the authored Cases,
coverage review and Benchmark pins in one candidate transaction.  It never
creates a Trial, human review, product observation or PASS result.
"""
import argparse
import hashlib
import json
from pathlib import Path

from rebuild_case_release import assemble_case_files, verify_case_files, verify_inventory
from rebuild_contracts import load_spec_contracts
from rebuild_dataset import json_bytes, verify_asset_snapshot
from rebuild_sources import file_pin
from rebuild_staging import candidate_lock, read_candidate, revise_candidate, snapshot_digest


RECEIPT = 'manifests/case-reviews/atomic-requirement-links.json'
ALLOWED_CHANGED_MODULES = {
    'foundation', 'sessions', 'context', 'memory', 'compaction', 'subagents', 'operations'}


def _pin(path, raw):
    return {'path': path, 'bytes': len(raw), 'sha256': hashlib.sha256(raw).hexdigest()}


def prepare(project):
    project = Path(project).resolve()
    with candidate_lock(project):
        before = read_candidate(project)
        verify_inventory(before)

    from rebuild_cases import compile_scenarios
    from rebuild_extraction import build_extraction_cases
    from rebuild_fixtures import registered_scenarios

    contracts = load_spec_contracts(project)
    golds = [json.loads(raw) for path, raw in sorted(before.items())
             if path.startswith('gold/')]
    cases = compile_scenarios(list(registered_scenarios().values()), contracts)
    cases += build_extraction_cases(golds, contracts)
    old_cases = {json.loads(raw)['id']: json.loads(raw)
                 for path, raw in before.items() if path.startswith('cases/')}
    new_cases = {case['id']: case for case in cases}
    if old_cases.keys() != new_cases.keys() or len(cases) != 548:
        raise ValueError('Atomic link revision must preserve all 548 Case identities')
    changed = sorted(case_id for case_id in new_cases
                     if new_cases[case_id] != old_cases[case_id])
    if not changed:
        raise ValueError('No authored requirement-link revision found')
    if any(new_cases[case_id]['harnessModule'] not in ALLOWED_CHANGED_MODULES
           for case_id in changed):
        raise ValueError('Requirement-link revision changed an unrelated module')
    if any(new_cases[case_id]['version'] <= old_cases[case_id]['version']
           for case_id in changed):
        raise ValueError('Every changed Case needs a higher version')

    outputs = assemble_case_files(before, cases, contracts)
    from rebuild_runtime_evidence_review import (refresh_existing as refresh_runtime_receipt,
                                                 run_tests as run_runtime_tests)
    outputs = refresh_runtime_receipt(project, outputs, run_runtime_tests(project))
    from rebuild_grader_review import refresh_existing as refresh_grader_receipt
    outputs = refresh_grader_receipt(project, outputs)
    from rebuild_coverage_review import build_revision as refresh_coverage
    outputs = refresh_coverage(project, outputs)

    queue = json.loads(outputs['manifests/requirement-review-queue.json'])
    full = [row['requirementId'] for row in queue['requirements']
            if row['reviewDecision'] == 'reviewed_full_coverage_mapping']
    partial = [row['requirementId'] for row in queue['requirements']
               if row['reviewDecision'] == 'reviewed_partial_coverage']
    outputs[RECEIPT] = json_bytes({
        'schemaVersion': 1,
        'reviewId': 'atomic-requirement-direct-check-links-2026-09-19',
        'status': 'CHECK_LINKS_REVIEWED_NO_PRODUCT_EXECUTION',
        'performedBy': 'codex_agent_contract_review',
        'performedAt': '2026-09-19',
        'humanReview': False,
        'method': 'atomic_requirement_case_assertion_evidence_scope_review',
        'beforeMaterialSha256': snapshot_digest(before),
        'changedCaseIds': changed,
        'fullyMappedRequirementIds': full,
        'partiallyMappedRequirementIds': partial,
        'requirementReviewQueueRef': _pin(
            'manifests/requirement-review-queue.json',
            outputs['manifests/requirement-review-queue.json']),
        'sourcePins': [file_pin(project, path) for path in (
            'agent-eval/tools/rebuild_cases.py',
                'agent-eval/tools/rebuild_coverage_review.py',
                'agent-eval/tools/rebuild_requirement_links.py',
                'agent-eval/tools/rebuild_scenarios_foundation.py',
                'agent-eval/tools/rebuild_scenarios_history.py',
                'agent-eval/tools/rebuild_scenarios_operations.py',
                'agent-eval/tools/rebuild_scenarios_subagents.py',
        )],
        'notClaimed': ['human_review', 'product_execution', 'benchmark_pass',
                       'complete_all_requirement_coverage', 'formal_acceptance'],
        'actualProductRuns': 0,
        'formalAcceptanceEligible': False,
    })
    # The binding-4 amendment receipt is a live transition ledger from its
    # archived binding-3 predecessor. Requirement links and authored
    # revision numbers are non-task metadata, so refresh its byte/version
    # transitions while retaining the same historical predecessor.
    from rebuild_spec_amendment import (RECEIPT as SPEC_RECEIPT, _tree,
                                        build_receipt as build_spec_receipt,
                                        registered_amendment)
    previous_spec_receipt = json.loads(before[SPEC_RECEIPT])
    amendment_predecessor = _tree(project, previous_spec_receipt['historyPath'])
    outputs[SPEC_RECEIPT] = json_bytes(build_spec_receipt(
        amendment_predecessor, outputs, registered_amendment(project)))
    from rebuild_coverage_review import reindex
    reindex(outputs)
    verify_case_files(outputs, contracts)
    verify_asset_snapshot(project, outputs)
    result = revise_candidate(project, before, outputs)
    result.update(changedCases=len(changed), fullyMappedRequirements=len(full),
                  partiallyMappedRequirements=len(partial), actualProductRuns=0,
                  activeDatasetChanged=False, formalAcceptanceEligible=False)
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--project', default='.')
    args = parser.parse_args()
    print(json.dumps(prepare(args.project), ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
