"""Build check-level Benchmark candidates from the fresh dataset, without runs.

Definitions stay inside the candidate until the complete dataset is published.
No legacy membership, Gold answer or approval is inherited.
"""
import argparse
from collections import Counter
from copy import deepcopy
import hashlib
import json
from pathlib import Path
import sys

from benchmark_definitions import SPECS, build_definition, observation_protocol, render_readme
from rebuild_benchmark_mapping import ACTIVE, RULE_VERSION, classify_fresh_case
from rebuild_case_release import canonical_digest, verify_inventory
from rebuild_dataset import json_bytes
from rebuild_sources import contained
from rebuild_staging import read_candidate, revise_candidate, snapshot_digest

PREFIX = 'manifests/benchmarks/'
CODE_PATHS = ('agent-eval/tools/rebuild_benchmark_mapping.py',
              'agent-eval/tools/rebuild_benchmarks.py',
              'agent-eval/tools/rebuild_publication.py',
              'agent-eval/tools/benchmark_definitions.py',
              'agent-eval/src/runner/benchmarks.py',
              'agent-eval/src/runner/fresh_benchmarks.py',
              'agent-eval/src/runner/materialize.py',
              'agent-eval/src/graders/observations.py')


def pin(path, raw):
    return {'path': path, 'bytes': len(raw), 'sha256': hashlib.sha256(raw).hexdigest()}


def load_cases(snapshot):
    verify_inventory(snapshot)
    catalog = json.loads(snapshot['manifests/case-catalog.json'])
    result = {}
    for row in catalog['cases']:
        raw = snapshot[row['path']]
        if pin(row['path'], raw)['sha256'] != row['sha256']:
            raise ValueError('Case file digest differs: ' + row['id'])
        case = json.loads(raw)
        if case['id'] in result or case['id'] != row['id'] or canonical_digest(case) != row['caseSha256']:
            raise ValueError('Case identity or canonical digest differs')
        if case['version'] != row['version']:
            raise ValueError('Case version differs')
        result[case['id']] = (case, row)
    if {r['path'] for _, r in result.values()} != {p for p in snapshot if p.startswith('cases/')}:
        raise ValueError('Case catalog must include exactly all current files')
    if catalog['caseCount'] != len(result):
        raise ValueError('Case catalog count differs')
    return result


def member(case, row, selection, snapshot):
    checks = case['oracle']['checks']
    refs = []
    for path in [case.get('businessRef', {}).get('path'), case['oracle'].get('fieldGoldRef')]:
        if path:
            if path not in snapshot:
                raise ValueError('Quality asset missing: ' + path)
            refs.append(pin(path, snapshot[path]))
    selected = set(selection['checkIds']) if selection else set()
    return {
        'caseId': case['id'], 'caseVersion': case['version'],
        'caseRef': pin(row['path'], snapshot[row['path']]),
        'caseSha256': canonical_digest(case), 'semanticScenarioKey': case['semanticScenarioKey'],
        'stage': case['stage'], 'split': case['split'], 'leakageGroup': case['leakageGroup'],
        'harnessModule': case['harnessModule'], 'sampleId': case.get('sampleId'),
        'checkIds': sorted(selected),
        'guardCheckIds': [c['checkId'] for c in checks if c.get('required') or c.get('hardConstraint')],
        'checkContracts': [{k: deepcopy(c.get(k)) for k in (
            'checkId', 'metricId', 'metricVersionRef', 'evaluationMode', 'sourceRefs',
            'evidenceRequirements', 'ruleStatus', 'collectorStatus', 'graderRequirement')}
            for c in checks if c['checkId'] in selected or c.get('required') or c.get('hardConstraint')],
        'oraclePin': {'version': case['oracle']['version'], 'sha256': canonical_digest(case['oracle'])},
        'qualityAssets': refs, 'productAssets': deepcopy(case.get('inputAssets', [])),
        'normalControlRefs': deepcopy(case.get('normalControlRefs', [])),
        'comparisonRefs': deepcopy(case.get('comparisonRefs', [])),
        'subsets': ['capability', 'regression'],
        'subsetReasons': {'capability': '本次功能契约的候选测量成员',
                          'regression': '保护必要契约的候选回归；不是已有通过历史'},
        'historicalRunRefs': [], 'dependencyOnly': selection is None,
        'applicability': deepcopy(selection), 'review': 'pending', 'execution': 'NOT_RUN',
    }


def close_dependencies(members, cases, snapshot):
    pending = list(members)
    blockers = []
    while pending:
        cid = pending.pop()
        source = members[cid]
        for key in ('normalControlRefs', 'comparisonRefs'):
            for ref in source[key]:
                target = cases.get(ref['caseId'])
                if not target:
                    raise ValueError('Missing dependency: ' + ref['caseId'])
                case, row = target
                if ref['version'] != case['version'] or ref['caseSha256'] != canonical_digest(case):
                    raise ValueError('Dependency pin drift: ' + ref['caseId'])
                if case['split'] != source['split']:
                    blockers.append('dependency_split_mismatch:' + cid + ':' + case['id'])
                if int(case['stage'][1:].split('-')[0]) > int(source['stage'][1:].split('-')[0]):
                    blockers.append('dependency_later_stage:' + cid + ':' + case['id'])
                if case['id'] not in members:
                    members[case['id']] = member(case, row, None, snapshot)
                    pending.append(case['id'])
    return sorted(set(blockers))


def build_bundle(project, snapshot):
    project = Path(project).resolve()
    cases = load_cases(snapshot)
    selections = {bid: {} for bid in ACTIVE}
    source_pins = {}
    for case, row in cases.values():
        for ck in case['oracle']['checks']:
            for ref in ck['sourceRefs']:
                previous = source_pins.setdefault(ref['path'], ref['specSha256'])
                if previous != ref['specSha256']:
                    raise ValueError('Mixed spec versions')
        for selected in classify_fresh_case(case):
            selections[selected['benchmarkId']][case['id']] = member(case, row, selected, snapshot)
    sources = []
    for path, sha in sorted(source_pins.items()):
        record = pin(path, contained(project, path).read_bytes())
        if record['sha256'] != sha:
            raise ValueError('Source drift: ' + path)
        sources.append(record)
    code = [pin(p, contained(project, p).read_bytes()) for p in CODE_PATHS]
    output, index = {}, []
    for bid in ACTIVE:
        members = selections[bid]
        blockers = close_dependencies(members, cases, snapshot)
        direct = [m for m in members.values() if not m['dependencyOnly']]
        definition = build_definition(bid, deepcopy(SPECS[bid]), sources)
        definition.update(schemaVersion=3, version=2, status='candidate',
                          membershipRuleVersion=RULE_VERSION)
        # The normative scopes remain explicit obligations. Old family selectors
        # are not allowed to silently stand in for the new authored episodes.
        for req in definition['coverageRequirements']:
            req['caseCriteria'] = {'families': [], 'requirementRefs': [], 'assertionPaths': []}
            req['coverageStatus'] = 'atomic_condition_review_pending'
        if bid == 'BM-10':
            definition['observationProtocol'] = observation_protocol()
        coverage = {}
        for m in direct:
            for check in m['checkContracts']:
                if check['checkId'] in m['checkIds']:
                    coverage.setdefault(check['metricId'], []).append({
                        'caseId': m['caseId'], 'checkId': check['checkId'],
                        'scope': 'declared_condition_only', 'sourceRefs': check['sourceRefs']})
        counts = {'caseCount': len(direct), 'dependencyCaseCount': len(members) - len(direct),
                  'assembledCaseCount': len(members),
                  'semanticScenarioCount': len({m['semanticScenarioKey'] for m in direct}),
                  'originalInvoiceCount': len({m['sampleId'] for m in direct if m['sampleId']}),
                  'legalControlCount': len({r['caseId'] for m in direct for r in m['normalControlRefs']}),
                  'actualProductRuns': 0, 'baselineCount': 0}
        bundle = {'schemaVersion': 3, 'benchmarkId': bid, 'status': 'candidate_not_frozen',
                  'members': sorted(members.values(), key=lambda m: m['caseId']), 'counts': counts,
                  'metricCheckCoverage': coverage, 'completeRequirementCoverage': False,
                  'facilityCasesExcluded': sum(c['harnessModule'] == 'eval-infrastructure' for c, _ in cases.values())}
        selection = json.loads(snapshot.get('manifests/selection.json', b'{}'))
        selection_reviewed = selection.get('status') == 'selected_set_source_relationship_review_complete'
        readiness = {'benchmarkId': bid, 'structurallyPrepared': True,
                     'contentReview': 'pending', 'freeze': 'not_frozen', 'execution': 'NOT_RUN',
                     'formalAcceptanceEligible': False,
                     'blockers': blockers + ['content_and_atomic_coverage_review_pending'] +
                        ([] if selection_reviewed else ['split_near_duplicate_and_exposure_review_pending']) + [
                         'product_adapter_and_trusted_evidence_missing', 'grader_calibration_pending',
                         'execution_configuration_not_frozen'],
                     'inheritedCandidateReadiness': json.loads(snapshot.get('manifests/readiness.json', b'{}'))}
        if bid == 'BM-01':
            report = json.loads(snapshot['manifests/preparation-report.json'])
            reviewed = report.get('humanVerifiedGold', 0)
            if reviewed != 100:
                readiness['blockers'].append(
                    'gold_human_review_pending' if report.get('imageAnnotatedGold') == 100
                    else 'new_gold_annotation_and_human_review_pending')
        if bid == 'BM-10': readiness['blockers'].append('real_business_observation_samples_missing')
        base = PREFIX + bid + '/'
        for name, data in [('definition.json', definition), ('members.json', bundle), ('readiness.json', readiness)]:
            output[base + name] = json_bytes(data)
        output[base + 'README.md'] = (render_readme(definition) +
            '\n## 本次新制成员\n\n```json\n' + json.dumps(counts, ensure_ascii=False, indent=2) +
            '\n```\n\n成员按直接检查项生成，联合引用不复制 Case。对照依赖单列；所有成员尚未运行。\n').encode('utf-8')
        index.append({'benchmarkId': bid, 'counts': counts, **{
            name + 'Ref': pin(base + name + '.json', output[base + name + '.json'])
            for name in ('definition', 'members', 'readiness')}})
    output[PREFIX + 'index.json'] = json_bytes({
        'schemaVersion': 3, 'status': 'candidate_not_frozen', 'benchmarks': index,
        'retired': ['BM-06'], 'sourceRefs': sources, 'sourceCodeRefs': code,
        'caseCatalogRef': pin('manifests/case-catalog.json', snapshot['manifests/case-catalog.json']),
        'actualProductRuns': 0, 'baselineCount': 0})
    return output


def prepare(project):
    before = read_candidate(project)
    outputs = dict(before)
    outputs.update(build_bundle(project, before))
    index = json.loads(outputs[PREFIX + 'index.json'])
    views = json.loads(outputs.get('manifests/views.json', b'{"schemaVersion":3}'))
    views['benchmarks'] = {r['benchmarkId']: {'membersRef': r['membersRef'],
        'selection': 'direct_members_only', 'counts': r['counts']} for r in index['benchmarks']}
    outputs['manifests/views.json'] = json_bytes(views)
    report = json.loads(outputs['manifests/preparation-report.json'])
    report['benchmarks'] = {'preparedDefinitions': 11, 'indexRef': pin(PREFIX + 'index.json',
        outputs[PREFIX + 'index.json']), 'membershipReview': 'pending',
        'freeze': 'not_frozen', 'actualProductRuns': 0, 'baselineCount': 0}
    outputs['manifests/preparation-report.json'] = json_bytes(report)
    outputs['manifests/inventory.json'] = json_bytes({'schemaVersion': 3, 'files': [
        pin(path, raw) for path, raw in sorted(outputs.items()) if path != 'manifests/inventory.json']})
    # revise_candidate acquires the writer lock and compares the complete tree.
    result = revise_candidate(project, before, outputs)
    return {'revision': result, 'candidateSha256': snapshot_digest(outputs),
            'benchmarks': json.loads(outputs[PREFIX + 'index.json'])['benchmarks'],
            'actualProductRuns': 0}


def verify(project, quality):
    from initial_dataset import is_current, verify as verify_initial
    if Path(quality).resolve() == Path(project).resolve() / 'agent-eval/data' and is_current(project):
        return dict(verify_initial(project), benchmarkCount=11)
    quality = Path(quality).resolve()
    from rebuild_publication import read_quality_snapshot
    snapshot = read_quality_snapshot(quality)
    expected = build_bundle(project, snapshot)
    if {p: d for p, d in snapshot.items() if p.startswith(PREFIX)} != expected:
        raise ValueError('Benchmark candidate differs from pinned source and member rules')
    index = json.loads(expected[PREFIX + 'index.json'])
    if 'manifests/views.json' in snapshot:
        views = json.loads(snapshot['manifests/views.json'])
        if views.get('benchmarks') != {r['benchmarkId']: {'membersRef': r['membersRef'],
            'selection': 'direct_members_only', 'counts': r['counts']} for r in index['benchmarks']}:
            raise ValueError('Benchmark views differ from members')
    if 'benchmarks' in json.loads(snapshot['manifests/preparation-report.json']):
        report = json.loads(snapshot['manifests/preparation-report.json'])['benchmarks']
        if report['indexRef'] != pin(PREFIX + 'index.json', expected[PREFIX + 'index.json']):
            raise ValueError('Preparation report references another Benchmark bundle')
    return {'valid': True, 'benchmarkCount': len(ACTIVE), 'actualProductRuns': 0}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command', choices=['prepare', 'verify'])
    parser.add_argument('--project', type=Path, default=Path(__file__).resolve().parents[2])
    parser.add_argument('--data-root', type=Path)
    args = parser.parse_args()
    result = prepare(args.project) if args.command == 'prepare' else verify(
        args.project, args.data_root or args.project / 'agent-eval/data')
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
