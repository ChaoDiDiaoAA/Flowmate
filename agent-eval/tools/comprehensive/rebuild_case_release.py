"""Build and verify an authored Case catalog inside the fresh candidate.

No old Case or answer is read. Case authoring remains explicit; missing modules,
unreviewed content and absent product adapters remain visible in every report.
"""
from collections import Counter
import hashlib
import json
import re

from harness_paths import canonical_case_path
from rebuild_contracts import load_spec_contracts, resolve_source_ref
from rebuild_dataset import MODULE_BUDGETS, json_bytes


def canonical_digest(value):
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True,
                                    separators=(',', ':'), allow_nan=False).encode()).hexdigest()


def _validate_cases(cases, assets, contracts, require_current_authors=True):
    by_id, semantic = {}, set()
    counts = Counter()
    sources = {d['path']: {'path': d['path'], 'sha256': d['sha256']}
               for d in contracts['documents'].values()}
    docs = {d['path']: key for key, d in contracts['documents'].items()}
    for case in cases:
        identity = case['id']
        if identity in by_id:
            raise ValueError('Duplicate Case identity')
        canonical_case_path(case)
        if (case.get('schemaVersion') != 3 or type(case.get('version')) is not int or case['version'] < 1 or
                case.get('provenance', {}).get('legacyCasesRead') is not False):
            raise ValueError('Only fresh schema3 Cases may enter this candidate')
        if (case.get('humanVerified') is not False or case.get('formalAcceptanceEligible') is not False or
                case.get('reviewStatus') != 'pending' or case.get('executionStatus') != 'not_run' or
                case.get('executionEligibility', {}).get('status') != 'dependencies_missing'):
            raise ValueError('This construction step cannot grant review or product results')
        if case.get('sourceSpecHashes') != sources:
            raise ValueError('Source specification digest differs')
        key = case.get('semanticScenarioKey')
        if not isinstance(key, str) or not key or key in semantic:
            raise ValueError('Duplicate or missing semantic condition')
        semantic.add(key)
        if case.get('split') not in {'development', 'regression', 'acceptance'} or not case.get('leakageGroup'):
            raise ValueError('Case split and leakage group required')
        if not re.fullmatch(r'P(?:[0-9]|1[0-3])', case.get('stage', '')):
            raise ValueError('Invalid Case stage')
        checks = case.get('oracle', {}).get('checks', [])
        if not checks or len({x['checkId'] for x in checks}) != len(checks):
            raise ValueError('Missing or duplicate checks')
        for check in checks:
            metric = contracts['metrics'].get(check['metricId'])
            if not metric or check.get('metricVersionRef') != canonical_digest(metric['definition']):
                raise ValueError('Metric definition changed')
            if not check.get('evidenceRequirements') or not check.get('sourceRefs'):
                raise ValueError('Direct evidence and Source references required')
            if case['harnessModule'] != 'eval-infrastructure' and not any(
                    docs.get(ref['path']) == 'product' for ref in check['sourceRefs']):
                raise ValueError('Direct product clause required for a product check')
            for ref in check['sourceRefs']:
                expected = resolve_source_ref(contracts, {'spec': docs.get(ref['path']),
                    'section': ref['section'], 'quote': ref['quote']})
                if ref != expected:
                    raise ValueError('Source reference drift')
        gold_ref = case['oracle'].get('fieldGoldRef')
        if gold_ref:
            if gold_ref not in assets or not gold_ref.startswith('gold/'):
                raise ValueError('Missing Gold dependency')
            gold = json.loads(assets[gold_ref])
            if (case['oracle'].get('fieldGoldSha256') != canonical_digest(gold) or
                    case['oracle'].get('fieldGoldVersion') != gold.get('version') or
                    case.get('sampleId') != gold.get('sampleId') or
                    case['split'] != gold.get('split') or case['leakageGroup'] != gold.get('leakageGroup')):
                raise ValueError('Gold digest, identity, split or group differs')
        if 'businessRef' in case:
            from rebuild_business_projection import validate_reference, validate_case_business
            ref = case['businessRef']
            validate_reference(ref)
            if ref['path'] not in assets:
                raise ValueError('Missing Business dependency')
            try:
                business = json.loads(assets[ref['path']])
            except (UnicodeError, ValueError) as exc:
                raise ValueError('Business dependency is unreadable JSON') from exc
            validate_case_business(case, business, contracts)
        elif 'businessPatches' in case or case.get('inputMode') == 'controlled_business_episode':
            raise ValueError('Business Case must declare its exact dependency')
        counts[case['harnessModule']] += 1
        by_id[identity] = case
    for module, count in counts.items():
        if count > MODULE_BUDGETS[module]:
            raise ValueError('Module exceeds approved Case budget')
    groups = {}
    for case in cases:
        group = case['leakageGroup']
        if group in groups and groups[group] != case['split']:
            raise ValueError('Leakage group crosses data uses')
        groups[group] = case['split']
        seen = set()
        for ref in case.get('normalControlRefs', []):
            control = by_id.get(ref['caseId'])
            if (not control or control['id'] == case['id'] or control['id'] in seen or
                    control.get('normalControlRefs') or ref.get('version') != control['version'] or
                    ref.get('caseSha256') != canonical_digest(control) or
                    int(control['stage'][1:]) > int(case['stage'][1:]) or
                    control['split'] != case['split'] or control['leakageGroup'] != group or
                    control.get('controlPairKey') != case.get('controlPairKey')):
                raise ValueError('Invalid or drifting normal control dependency')
            seen.add(control['id'])
        seen_comparisons = set()
        for ref in case.get('comparisonRefs', []):
            peer = by_id.get(ref.get('caseId'))
            fields = ref.get('equalInputFields')
            checks = ref.get('checkIds')
            if (set(ref) != {'caseId', 'version', 'caseSha256', 'checkIds', 'equalInputFields',
                             'purpose', 'protocol', 'peerMustPass'} or
                    not peer or peer['id'] == case['id'] or peer['id'] in seen_comparisons or
                    ref.get('protocol') != 'paired_independent_trials' or ref.get('peerMustPass') is not False or
                    not isinstance(ref.get('purpose'), str) or not ref['purpose'].strip() or
                    ref.get('version') != peer['version'] or ref.get('caseSha256') != canonical_digest(peer) or
                    peer['split'] != case['split'] or peer['leakageGroup'] != group or
                    int(peer['stage'][1:]) > int(case['stage'][1:]) or
                    not isinstance(checks, list) or not checks or len(set(checks)) != len(checks) or
                    not set(checks).issubset({c['checkId'] for c in case['oracle']['checks']}) or
                    not isinstance(fields, list) or not fields or len(set(fields)) != len(fields) or
                    any(f not in case['episode']['input'] or f not in peer['episode']['input'] or
                        case['episode']['input'][f] != peer['episode']['input'][f] for f in fields)):
                raise ValueError('Invalid or drifting comparison dependency')
            seen_comparisons.add(peer['id'])
    if not require_current_authors:
        return counts
    # A catalog hash proves bytes, not that required predicates/controls survived.
    # Rebuild from explicit authored definitions and the quality-side Gold pins.
    # Unknown protocols and editorial revisions need an updated authoring source.
    from rebuild_cases import compile_scenarios
    from rebuild_extraction import build_extraction_cases
    from rebuild_fixtures import registered_scenarios
    registry = registered_scenarios()
    episodes, golds = [], []
    for case in cases:
        protocol = case.get('scenarioProtocol')
        if protocol == {'kind': 'fresh_declarative_episode', 'version': 1}:
            if case['id'] not in registry:
                raise ValueError('Case missing from authored scenario registry')
            episodes.append(registry[case['id']])
        elif protocol == {'kind': 'fresh_invoice_extraction', 'version': 1}:
            golds.append(json.loads(assets[case['oracle']['fieldGoldRef']]))
        else:
            raise ValueError('Unknown authored Case protocol')
    authored = compile_scenarios(episodes, contracts) + build_extraction_cases(golds, contracts)
    if {c['id']: c for c in authored} != by_id:
        raise ValueError('Case differs from its authored source revision')
    return counts


def assemble_case_files(snapshot, cases, contracts, require_current_authors=True):
    from harness_modules import MODULES
    cases = sorted(cases, key=lambda c: c['id'])
    counts = _validate_cases(cases, snapshot, contracts, require_current_authors)
    outputs = dict(snapshot)
    generated = {canonical_case_path(c): json_bytes(c) for c in cases}
    for path, previous in snapshot.items():
        if path.startswith('cases/'):
            if path not in generated:
                raise ValueError('Existing candidate Case cannot be silently removed')
            if previous != generated[path] and json.loads(previous)['version'] >= json.loads(generated[path])['version']:
                raise ValueError('Changed Case requires an explicit higher revision')
    outputs.update(generated)
    entries = []
    for case in sorted(cases, key=lambda c: c['id']):
        path = canonical_case_path(case)
        module_contract = MODULES[case['harnessModule']]
        exact_requirement_refs = sorted({
            ref for location in ('requirementLinks', 'runtimeRefs')
            for ref in case.get(location, []) if isinstance(ref, str)
        })
        entries.append({k: case[k] for k in ['id', 'version', 'harnessModule', 'category', 'stage',
                        'split', 'leakageGroup', 'semanticScenarioKey', 'subcapabilityRefs']} |
                       {'path': path, 'bytes': len(outputs[path]), 'sha256': hashlib.sha256(outputs[path]).hexdigest(),
                        'caseSha256': canonical_digest(case),
                        'checkIds': [c['checkId'] for c in case['oracle']['checks']],
                        'directMetricRefs': sorted({c['metricId'] for c in case['oracle']['checks']}),
                        'moduleProductRefs': list(module_contract[2]),
                        'moduleRuntimeRefs': list(module_contract[3]),
                        'exactScenarioRequirementRefs': exact_requirement_refs,
                        'requirementMappingStatus': ('exact_scenario_refs_present_check_review_pending'
                            if exact_requirement_refs else 'module_navigation_only_exact_scenario_review_pending'),
                        'normalControlRefs': case.get('normalControlRefs', [])})
        if case.get('comparisonRefs'):
            entries[-1]['comparisonRefs'] = case['comparisonRefs']
        if case.get('businessRef'):
            entries[-1]['businessRef'] = case['businessRef']
    outputs['manifests/case-catalog.json'] = json_bytes({
        'schemaVersion': 3, 'status': 'full_case_budget_content_review_pending',
        'membershipReview': 'pending', 'caseCount': len(entries), 'cases': entries})
    modules = []
    for module, budget in MODULE_BUDGETS.items():
        members = [c for c in cases if c['harnessModule'] == module]
        name, responsibility, product_refs, runtime_refs = MODULES[module]
        modules.append({'id': module, 'name': name, 'responsibility': responsibility,
            'caseBudget': budget, 'preparedCases': counts[module],
            'remainingCaseBudget': budget - counts[module], 'caseIds': [c['id'] for c in members],
            'subcapabilityCounts': dict(Counter(s for c in members for s in c['subcapabilityRefs'])),
            'moduleProductRefs': list(product_refs), 'moduleRuntimeRefs': list(runtime_refs),
            'requirementNavigationMeaning': (
                'MOD/RT lists define module applicability. Only exact Case/checkId links reviewed '
                'against their declared condition can establish RTC/RTX/critical/atomic coverage.'),
            'directChecks': [{'caseId': c['id'], 'checkId': ck['checkId'], 'metricId': ck['metricId'],
                              'evaluationMode': ck['evaluationMode'], 'sourceRefs': ck['sourceRefs']}
                             for c in members for ck in c['oracle']['checks']],
            'requiredConditionCoverage': 'atomic_requirement_matrix_review_pending',
            'contentReview': 'pending', 'executionEligibility': 'dependencies_missing',
            'actualProductRuns': 0, 'formalAcceptanceEligible': False})
    outputs['manifests/module-catalog.json'] = json_bytes({
        'schemaVersion': 3, 'status': ('full_case_budget_content_review_pending'
            if len(cases) == sum(MODULE_BUDGETS.values()) else 'partial_authored_coverage_not_acceptance'),
        'modules': modules, 'countIsCoverageProof': False})
    report = json.loads(snapshot['manifests/preparation-report.json'])
    if report.get('actualProductRuns') != 0 or report.get('baselineCount') != 0:
        raise ValueError('Construction revision cannot rewrite a measured release')
    human_verified_gold = sum(
        json.loads(data).get('humanVerified') is True
        for path, data in outputs.items() if path.startswith('gold/'))
    report.update(status='full_material_budget_content_review_pending',
        casesPreparedInThisStep=len(cases), casesMissingFromBudget=sum(MODULE_BUDGETS.values()) - len(cases),
        imageAnnotatedGold=sum('annotationRef' in json.loads(data) for path, data in outputs.items() if path.startswith('gold/')),
        humanVerifiedGold=human_verified_gold,
        preparedCaseCounts={m: counts[m] for m in MODULE_BUDGETS},
        independentSemanticScenarios=len({c['semanticScenarioKey'] for c in cases}),
        preparedCaseCheckCount=sum(len(c['oracle']['checks']) for c in cases),
        caseContentReview='pending', atomicRequirementCoverage='review_pending',
        formalAcceptanceEligible=False)
    # Four seed episodes per module; a partial catalog cannot silently allocate
    # absent modules' places to invoice replicas and call the batch complete.
    calibration = [canonical_case_path(c) for module in MODULE_BUDGETS
                   for c in sorted((x for x in cases if x['harnessModule'] == module), key=lambda c: c['id'])[:4]]
    report['calibrationBatch'].update(cases=calibration,
        status='candidate_content_review_pending' if len(calibration) == 60 else 'incomplete')
    outputs['manifests/preparation-report.json'] = json_bytes(report)
    pins = [{'path': path, 'bytes': len(data), 'sha256': hashlib.sha256(data).hexdigest()}
            for path, data in sorted(outputs.items()) if path != 'manifests/inventory.json']
    outputs['manifests/inventory.json'] = json_bytes({'schemaVersion': 3, 'files': pins})
    return outputs


def verify_case_files(outputs, contracts, require_current_authors=True):
    if 'manifests/case-catalog.json' not in outputs:
        if any(p.startswith('cases/') for p in outputs):
            raise ValueError('Case files require their catalog')
        return {'caseCount': 0, 'completeBudget': False}
    cases = [json.loads(data) for path, data in outputs.items() if path.startswith('cases/')]
    expected = assemble_case_files(outputs, cases, contracts, require_current_authors)
    for path in ['manifests/case-catalog.json', 'manifests/module-catalog.json',
                 'manifests/preparation-report.json', 'manifests/inventory.json']:
        if outputs.get(path) != expected[path]:
            raise ValueError(f'Candidate catalog/report differs: {path}')
    return {'caseCount': len(cases), 'completeBudget': len(cases) == sum(MODULE_BUDGETS.values()),
            'actualProductRuns': 0, 'formalAcceptanceEligible': False}


def prepare_cases(project):
    from rebuild_cases import compile_scenarios
    from rebuild_dataset import verify_asset_snapshot
    from rebuild_extraction import build_extraction_cases
    from rebuild_fixtures import registered_scenarios
    from rebuild_staging import candidate_lock, read_candidate, revise_candidate
    with candidate_lock(project):
        snapshot = read_candidate(project)
        # A reviewed author correction may supersede an earlier candidate. Check
        # its exact indexed bytes and closed historical references, then require
        # the *new* output to match current authors and increase changed versions.
        verify_asset_snapshot(project, snapshot, require_current_authors=False)
    contracts = load_spec_contracts(project)
    pinned = {p['path']: p['sha256'] for p in json.loads(snapshot['manifests/preparation-report.json'])['specRefs']}
    if pinned != {d['path']: d['sha256'] for d in contracts['documents'].values()}:
        raise ValueError('Specifications changed during candidate preparation')
    golds = [json.loads(data) for path, data in sorted(snapshot.items()) if path.startswith('gold/')]
    cases = compile_scenarios(list(registered_scenarios().values()), contracts)
    cases += build_extraction_cases(golds, contracts)
    outputs = assemble_case_files(snapshot, cases, contracts)
    # Case revisions invalidate every derived pin that names Case or Oracle
    # bytes. Refresh them in the same candidate transaction so there is never a
    # published tree with new Cases and legacy Benchmark/coverage receipts.
    from rebuild_grader_review import refresh_existing as refresh_grader_receipt
    outputs = refresh_grader_receipt(project, outputs)
    from rebuild_coverage_review import build_revision as refresh_coverage_and_benchmarks
    outputs = refresh_coverage_and_benchmarks(project, outputs)
    verify_case_files(outputs, contracts)
    verify_asset_snapshot(project, outputs)
    result = revise_candidate(project, snapshot, outputs)
    result.update(caseCount=len(cases), actualProductRuns=0, activeDatasetChanged=False,
                  formalAcceptanceEligible=False)
    return result


def verify_inventory(snapshot):
    """Check the exact bytes read, before deriving and re-indexing any outputs."""
    if 'manifests/inventory.json' not in snapshot:
        raise ValueError('Candidate inventory missing')
    actual = [{'path': path, 'bytes': len(data), 'sha256': hashlib.sha256(data).hexdigest()}
              for path, data in sorted(snapshot.items()) if path != 'manifests/inventory.json']
    recorded = json.loads(snapshot['manifests/inventory.json'])
    if recorded != {'schemaVersion': 3, 'files': actual}:
        raise ValueError('Candidate inventory drift; preserve edits and revalidate')
