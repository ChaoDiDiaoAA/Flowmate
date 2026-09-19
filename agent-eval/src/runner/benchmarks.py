"""Read-only Benchmark assembly and facility report accounting.

This module has no product runner or trusted report adapter. Assembly always
remains blocked. Result accounting requires explicit facility_selftest=True;
JSON statuses, including PASS, can never become actual product results here.
"""
from __future__ import annotations

import argparse
from collections import Counter
from copy import deepcopy
import hashlib
import json
from pathlib import Path
import re
import sys

if __package__ in {None, ''}:
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

ACTIVE = {f'BM-{number:02}' for number in range(1, 13)} - {'BM-06'}
STATES = ('PASS', 'FAIL', 'UNJUDGEABLE', 'INFRA_ERROR', 'NOT_RUN')
PROFILE_FIELDS = {'candidate', 'k', 'thresholds', 'timeout', 'model', 'promptVersion',
    'skillVersion', 'runtimeVersion', 'toolVersion', 'modelParameters', 'budget',
    'concurrency', 'retryPolicy', 'resetPolicy', 'humanMode', 'workspacePolicyVersion', 'masterDataAt'}
ENVIRONMENT_FIELDS = {'name', 'version', 'kind', 'instancePolicy'}
OBSERVATION_FIELDS = {'population', 'window', 'inclusionExclusion', 'sampling',
    'candidateExposure', 'environment', 'humanComparison', 'outcomes', 'costAndLatency', 'unknownBacklog'}


def canonical_hash(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=False,
        separators=(',', ':'), allow_nan=False).encode('utf-8')).hexdigest()


def _read(path):
    return json.loads(Path(path).read_text(encoding='utf-8-sig'))


def _contained(root, relative):
    if not isinstance(relative, str) or not relative or '\\' in relative or ':' in relative:
        raise ValueError('invalid relative path')
    if relative.startswith('/') or any(part in ('', '.', '..') for part in relative.split('/')):
        raise ValueError('path must be contained')
    root = Path(root).resolve()
    path = (root / relative).resolve(strict=True)
    if not path.is_relative_to(root) or not path.is_file():
        raise ValueError('path escapes root or is not a file')
    return path


def _pinned_file(root, ref):
    path = _contained(root, ref['path'])
    if hashlib.sha256(path.read_bytes()).hexdigest() != ref.get('sha256'):
        raise ValueError('file hash mismatch')
    if 'version' in ref and path.suffix == '.json':
        value = _read(path)
        if not isinstance(value, dict) or value.get('version') != ref['version']:
            raise ValueError('asset version mismatch')
    return path


def _pointer(value, pointer):
    if not isinstance(pointer, str) or not pointer.startswith('/'):
        raise ValueError('absolute JSON pointer required')
    for part in pointer[1:].split('/'):
        part = part.replace('~1', '/').replace('~0', '~')
        value = value[int(part)] if isinstance(value, list) else value[part]
    return value


def _guards(checks):
    return {check['checkId'] for check in checks if check.get('required', True) and (
        check.get('hardConstraint') or check.get('severity') in {'critical', 'high'} or
        check.get('dimension') in {'modelBehavior', 'platformControl', 'actualConsequences', 'safety'})}


def _phase(stage):
    match = re.fullmatch(r'P([0-9]|1[0-3])(?:-([ABC]))?', str(stage))
    if not match:
        raise ValueError('invalid stage')
    return int(match[1]), 'ABC'.find(match[2]) if match[2] else -1


def validate_bundle(project, quality_root, definition, members, cases_by_id=None):
    """Check pinned candidate structure separately from real execution readiness.

    File references including definitionSha256 use exact byte hashes. Only the
    embedded oracle/rubric JSON pointers use canonical JSON hashes.
    Optional cases_by_id is checked against disk, never substituted for pinned bytes.
    """
    project, quality_root = Path(project).resolve(), Path(quality_root).resolve()
    roots = {'project': project, 'quality': quality_root,
             'product': project / 'data/invoices/voxel51'}
    errors, blockers = [], {'real_product_adapter_missing', 'trusted_evidence_adapter_missing'}
    def error(code, detail='', case_id=None):
        row = {'code': code, 'detail': str(detail)}
        if case_id is not None:
            row['caseId'] = case_id
        errors.append(row)
    identity = definition.get('benchmarkId')
    if identity == 'BM-06':
        error('retired_benchmark')
    elif identity not in ACTIVE:
        error('unknown_benchmark')
    if definition.get('schemaVersion') != 1 or members.get('schemaVersion') != 1:
        error('schema_version_invalid')
    if members.get('benchmarkId') != identity:
        error('benchmark_identity_mismatch')
    try:
        definition_path = _contained(project, f'agent-eval/benchmarks/{identity}/definition.json')
        if (_read(definition_path) != definition or
                members.get('definitionSha256') != hashlib.sha256(definition_path.read_bytes()).hexdigest()):
            error('definition_hash_mismatch')
    except (OSError, ValueError):
        error('definition_reference_invalid')
    registries = {}
    for filename, field, code in [('splits.json', 'splitManifestSha256', 'split_manifest_hash_mismatch'),
            ('case-catalog.json', 'caseCatalogSha256', 'case_catalog_hash_mismatch')]:
        path = quality_root / 'manifests' / filename
        if field in members and not path.is_file():
            error(code, 'Pinned registry is missing')
        if path.exists():
            if members.get(field) != hashlib.sha256(path.read_bytes()).hexdigest():
                error(code)
            registries[filename] = _read(path)
    if identity == 'BM-10' and definition.get('kind') != 'observational':
        error('observational_protocol_required')
    if definition.get('kind') == 'observational':
        blockers.add('observation_protocol_review_required')
        protocol = definition.get('observationProtocol', {})
        if (protocol.get('productionWritesAllowed') is not False
                or protocol.get('repeatBusinessForComparison') is not False):
            error('observational_replay_forbidden')
        if (OBSERVATION_FIELDS - protocol.get('requiredSchema', {}).keys()
                or OBSERVATION_FIELDS - protocol.get('frozenConfig', {}).keys()):
            error('observational_protocol_incomplete')
        if any(protocol.get('frozenConfig', {}).get(field) is None for field in OBSERVATION_FIELDS):
            blockers.add('observation_config_not_frozen')
    for ref in definition.get('sourceRefs', []):
        try:
            _pinned_file(project, ref)
        except (OSError, ValueError, TypeError, KeyError) as exc:
            error('definition_source_reference_invalid', exc)
    if definition.get('status') != 'frozen':
        blockers.add('definition_not_frozen')
    rows = members.get('members')
    if not isinstance(rows, list):
        error('members_invalid')
        rows = []
    indexed, loaded, paths, groups = {}, {}, set(), {}
    for member in rows:
        if not isinstance(member, dict):
            error('member_invalid')
            continue
        cid = member.get('caseId')
        if not isinstance(cid, str) or not cid:
            error('case_identity_invalid')
            continue
        if cid in indexed:
            error('duplicate_member', case_id=cid)
        indexed[cid] = member
        relative = member.get('casePath')
        if isinstance(relative, str) and relative.casefold() in paths:
            error('duplicate_case_path', case_id=cid)
        if isinstance(relative, str):
            paths.add(relative.casefold())
        try:
            path = _contained(quality_root, relative)
            raw = path.read_bytes()
            if hashlib.sha256(raw).hexdigest() != member.get('caseSha256'):
                error('case_hash_mismatch', case_id=cid)
            case = json.loads(raw.decode('utf-8-sig'))
            if not isinstance(case, dict):
                raise ValueError('case must be an object')
            loaded[cid] = case
        except (OSError, ValueError, TypeError, KeyError) as exc:
            error('case_reference_invalid', exc, cid)
            continue
        if case.get('id') != cid or case.get('version') != member.get('caseVersion'):
            error('case_identity_mismatch', case_id=cid)
        if 'case-catalog.json' in registries:
            entries = [r for r in registries['case-catalog.json'].get('cases', []) if r.get('id') == cid]
            if len(entries) != 1:
                error('case_not_in_catalog', case_id=cid)
            elif entries[0].get('path') != member.get('casePath') or entries[0].get('version') != member.get('caseVersion'):
                error('case_catalog_member_mismatch', case_id=cid)
        catalog = registries.get('case-catalog.json', {}).get('cases', [])
        if catalog and not any(r.get('id') == cid and r.get('path') == relative for r in catalog):
            error('case_catalog_identity_mismatch', case_id=cid)
        expected_folder = case.get('harnessModule', case.get('category'))
        if relative != f'cases/{expected_folder}/{cid}.json':
            error('case_path_identity_mismatch', case_id=cid)
        if cases_by_id is not None and cases_by_id.get(cid) != case:
            error('case_cache_mismatch', case_id=cid)
        for field in ('stage', 'evaluationMode', 'split', 'semanticScenarioKey', 'sampleId', 'sampleRole', 'leakageGroup'):
            if field not in member or (field in case and case[field] != member[field]):
                error('member_metadata_mismatch', field, cid)
        if not member.get('reason') or not member.get('requirementRefs'):
            error('membership_basis_missing', case_id=cid)
        if member.get('normalControlRefs') != case.get('normalControlRefs', []):
            error('control_reference_mismatch', case_id=cid)
        checks = case.get('oracle', {}).get('checks', [])
        check_ids = [c.get('checkId') for c in checks]
        if not checks or len(check_ids) != len(set(check_ids)):
            error('case_checks_invalid', case_id=cid)
        selected, guards = member.get('checkIds', []), member.get('guardCheckIds', [])
        if not isinstance(selected, list) or not isinstance(guards, list):
            error('check_selection_invalid', case_id=cid)
            selected, guards = [], []
        if not selected or len(selected) != len(set(selected)) or len(guards) != len(set(guards)):
            error('check_selection_invalid', case_id=cid)
        if (set(selected) | set(guards)) - set(check_ids):
            error('unknown_check', case_id=cid)
        if _guards(checks) - (set(selected) | set(guards)):
            error('required_guard_missing', case_id=cid)
        for check in checks:
            if check.get('checkId') in set(selected) | set(guards) and check.get('required', True):
                if check.get('ruleStatus') != 'implemented':
                    blockers.add('required_rule_not_implemented')
        if member.get('graderBinding', {}).get('implementationStatus') == 'pending':
            blockers.add('grader_implementation_pending')
        subsets = member.get('subsets', [])
        if not subsets or set(subsets) - {'capability', 'regression'}:
            error('subset_invalid', case_id=cid)
        if _guards(checks) and 'regression' not in subsets:
            error('required_regression_missing', case_id=cid)
        for field, pointer, version in [('oracleRef', '/oracle', case.get('oracle', {}).get('version', case.get('version'))),
                                         ('rubricRef', '/oracle/checks', case.get('version'))]:
            try:
                ref = member[field]
                value = _pointer(case, ref['pointer'])
                if ref['pointer'] != pointer or ref.get('version') != version or ref.get('sha256') != canonical_hash(value):
                    raise ValueError('pointer, hash or version mismatch')
            except (ValueError, KeyError, TypeError, IndexError) as exc:
                error('oracle_reference_invalid' if field == 'oracleRef' else 'rubric_reference_invalid', exc, cid)
        assets = member.get('assets', [])
        pinned = set()
        for ref in assets:
            try:
                if not isinstance(ref, dict) or not ref.get('kind'):
                    raise ValueError('asset kind required')
                asset_path = _pinned_file(roots[ref['root']], ref)
                pinned.add((ref['root'], ref['path']))
                if ref['kind'] == 'gold':
                    gold_record = _read(asset_path)
                    if gold_record.get('humanVerified') is not True or gold_record.get('reviewStatus') != 'accepted':
                        blockers.add('gold_review_pending')
            except (OSError, ValueError, KeyError, TypeError) as exc:
                error('asset_reference_invalid', exc, cid)
        expected = [(ref.get('root'), ref.get('path')) for ref in case.get('inputAssets', [])]
        gold = case.get('oracle', {}).get('fieldGoldRef')
        if gold:
            expected.append(('quality', gold))
        business = case.get('initialEnvironment', {}).get('fixtureBaseRef')
        if business:
            expected.append(('quality', business))
            expected.append(('quality', 'manifests/fixture-policy.json'))
        for source in case.get('sourceSpecHashes', {}).values():
            expected.append(('project', source['path']))
            source_asset = next((r for r in assets if isinstance(r, dict)
                and r.get('root') == 'project' and r.get('path') == source['path']), None)
            if source_asset and source_asset.get('sha256') != source.get('sha256'):
                blockers.add('source_spec_refresh_review_required')
        for ref in expected:
            if ref not in pinned:
                error('input_asset_unpinned', ref, cid)
        if not member.get('graderRefs'):
            error('grader_reference_invalid', 'grader reference required', cid)
        for ref in member.get('graderRefs', []):
            try:
                if not ref.get('version', ref.get('contractVersion')):
                    raise ValueError('grader version required')
                _pinned_file(project, ref)
                if ref.get('implementationStatus') == 'pending':
                    blockers.add('grader_implementation_pending')
            except (OSError, ValueError, KeyError, TypeError) as exc:
                error('grader_reference_invalid', exc, cid)
        group = member.get('leakageGroup')
        if group:
            groups.setdefault(group, set()).add(member.get('split'))
        if member.get('split') == 'acceptance':
            blockers.add('acceptance_not_frozen')
            if member.get('exposedForTuning') or case.get('exposedForTuning'):
                error('acceptance_exposed', case_id=cid)
        for sample in registries.get('splits.json', {}).get('samples', []):
            if sample.get('sampleId') != member.get('sampleId'):
                continue
            if any(sample.get(key) != member.get(key) for key in ('split', 'leakageGroup')):
                error('split_registry_mismatch', case_id=cid)
            if member.get('split') == 'acceptance' and sample.get('exposedForTuning'):
                error('acceptance_exposed', case_id=cid)
        if member.get('reviewStatus') not in {'reviewed', 'verified', 'approved'}:
            blockers.add('member_review_pending')
        if member.get('executionStatus') not in {'not_run', 'NOT_RUN'}:
            error('candidate_execution_claim', case_id=cid)
    for group, splits in groups.items():
        if len(splits) > 1:
            error('split_leakage', group)
    for cid, member in indexed.items():
        for ref in member.get('normalControlRefs', []):
            control = indexed.get(ref.get('caseId'))
            if control is None:
                error('control_missing', ref.get('caseId'), cid)
                continue
            if control.get('caseVersion') != ref.get('version'):
                error('control_version_mismatch', case_id=cid)
            if control.get('split') != member.get('split'):
                error('control_split_mismatch', case_id=cid)
            try:
                if _phase(control.get('stage')) > _phase(member.get('stage')):
                    error('control_stage_mismatch', case_id=cid)
            except ValueError:
                error('control_stage_mismatch', case_id=cid)
            control_case = loaded.get(control['caseId'], {})
            case = loaded.get(cid, {})
            if control.get('normalControlRefs') or control_case.get('scenarioRole') != 'control':
                error('control_not_independent', case_id=cid)
            if case.get('controlPairKey') and case.get('controlPairKey') != control_case.get('controlPairKey'):
                error('control_pair_mismatch', case_id=cid)
            if set(member.get('subsets', [])) - set(control.get('subsets', [])):
                error('control_subset_missing', case_id=cid)
    if errors:
        blockers.add('structural_validation_failed')
    return {'benchmarkId': identity, 'valid': not errors, 'errors': errors,
            'memberCount': len(rows), 'readiness': {'status': 'blocked', 'blockers': sorted(blockers)}}


def _configuration(value, allowed, label):
    if value is None:
        return {}
    if not isinstance(value, dict):
        raise ValueError(label + ' must be an object')
    if set(value) - allowed:
        raise ValueError('unknown ' + label + ' fields: ' + ', '.join(sorted(set(value) - allowed)))
    return deepcopy(value)


def assemble(project, benchmark_id, subset='capability', stage=None, split=None, environment=None, profile=None, data_root=None):
    """Resolve and project an offline plan. Does not write or invoke product code."""
    selected_root = Path(data_root).resolve() if data_root else Path(project).resolve() / 'agent-eval/data'
    marker = selected_root / 'manifests/active-dataset.json'
    if marker.exists() and _read(marker).get('format') == 'initial-agent-evaluation':
        if selected_root != Path(project).resolve() / 'agent-eval/data':
            raise ValueError('Initial dataset assembly uses the current project data only')
        if environment is not None or profile is not None:
            raise ValueError('Initial design assembly has no executable profile; product configuration remains blocked')
        from runner.initial_dataset import assemble_benchmark
        return assemble_benchmark(benchmark_id, project, stage, split, subset)
    index_path = selected_root / 'manifests/benchmarks/index.json'
    if index_path.exists() and _read(index_path).get('schemaVersion') == 3:
        from runner.fresh_benchmarks import assemble_fresh
        return assemble_fresh(project, selected_root, benchmark_id, subset, stage, split, environment, profile)
    if data_root is not None:
        raise ValueError('--data-root requires a prepared schema3 Benchmark dataset')
    from runner.materialize import materialize
    if benchmark_id not in ACTIVE:
        raise ValueError('unknown or retired Benchmark')
    if subset not in {'capability', 'regression'}:
        raise ValueError('unknown subset')
    if stage is not None and not re.fullmatch(r'P(?:[0-9]|1[0-3])(?:-[ABC])?', str(stage)):
        raise ValueError('unknown stage')
    if split is not None and split not in {'development', 'regression', 'acceptance'}:
        raise ValueError('unknown split')
    profile = _configuration(profile, PROFILE_FIELDS, 'profile')
    environment = _configuration(environment, ENVIRONMENT_FIELDS, 'environment')
    if environment.get('kind', 'offline') not in {'offline', 'test', 'production_readonly'}:
        raise ValueError('unknown environment kind')
    if 'k' in profile and (type(profile['k']) is not int or profile['k'] < 1):
        raise ValueError('profile k must be a positive integer')
    project = Path(project).resolve()
    quality = project / 'agent-eval/data'
    definition = _read(_contained(project, f'agent-eval/benchmarks/{benchmark_id}/definition.json'))
    bundle = _read(_contained(quality, definition['membersRef']))
    validation = validate_bundle(project, quality, definition, bundle)
    index_path = quality / 'manifests/benchmarks/index.json'
    index = {}
    try:
        index = _read(index_path)
        matches = [entry for entry in index['benchmarks'] if entry.get('benchmarkId') == benchmark_id]
        if len(matches) != 1:
            raise ValueError('Benchmark must have exactly one release index entry')
        entry = matches[0]
        if entry['membersRef'] != definition['membersRef'] or entry['definitionRef'] != f'agent-eval/benchmarks/{benchmark_id}/definition.json':
            raise ValueError('Release and definition paths differ')
        for root, path_key, hash_key in [(project, 'definitionRef', 'definitionSha256'),
                                         (quality, 'membersRef', 'membersSha256'),
                                         (quality, 'readinessRef', 'readinessSha256')]:
            _pinned_file(root, {'path': entry[path_key], 'sha256': entry[hash_key]})
    except (OSError, ValueError, TypeError, KeyError) as exc:
        validation['valid'] = False
        validation['errors'].append({'code': 'release_reference_invalid', 'detail': str(exc)})
        validation['readiness']['blockers'].append('structural_validation_failed')
    if isinstance(index, dict):
        for ref in index.get('sourceCodeRefs', []):
            try:
                _pinned_file(project, ref)
            except (OSError, ValueError, TypeError, KeyError) as exc:
                validation['valid'] = False
                validation['errors'].append({'code': 'runtime_source_reference_invalid', 'detail': str(exc)})
                if 'structural_validation_failed' not in validation['readiness']['blockers']:
                    validation['readiness']['blockers'].append('structural_validation_failed')
    config_blockers = ['profile_missing:' + field for field in sorted(PROFILE_FIELDS) if profile.get(field) is None]
    config_blockers += ['environment_missing:' + field for field in sorted(ENVIRONMENT_FIELDS) if environment.get(field) is None]
    chosen = [m for m in bundle['members'] if subset in m.get('subsets', [])
        and (stage is None or _phase(m.get('stage')) <= _phase(stage)) and (split is None or split == m.get('split'))]
    chosen_ids = {m['caseId'] for m in chosen}
    # A control from an earlier stage is still part of the requested challenge.
    # Pull it into the plan explicitly; never silently remove the dependency.
    by_id = {m['caseId']: m for m in bundle['members']}
    for member in chosen:
        for ref in member.get('normalControlRefs', []):
            control = by_id.get(ref['caseId'])
            if control and control['caseId'] not in chosen_ids:
                chosen.append(control)
                chosen_ids.add(control['caseId'])
    rows = []
    for member in chosen:
        blockers = list(validation['readiness']['blockers']) + config_blockers
        for ref in member.get('normalControlRefs', []):
            if ref['caseId'] not in chosen_ids:
                blockers.append('selected_control_missing:' + ref['caseId'])
        fixture = {'status': 'unsupported', 'input': {}, 'harness': {}, 'limitations': ['structural validation failed']}
        if validation['valid']:
            case = _read(_contained(quality, member['casePath']))
            blockers.extend('dependency_unresolved:' + str(value) for value in case.get('dependencies', []))
            business_ref = case.get('initialEnvironment', {}).get('fixtureBaseRef')
            business = _read(_contained(quality, business_ref)) if business_ref else None
            fixture = materialize(case, business, project / 'data/invoices/voxel51')
            if fixture['status'] != 'materialized':
                blockers.append('fixture_unsupported')
        rows.append({'caseId': member['caseId'], 'caseVersion': member['caseVersion'],
            'status': 'blocked', 'blockers': sorted(set(blockers)), 'fixture': fixture,
            'normalControlRefs': deepcopy(member.get('normalControlRefs', [])),
            'grading': {key: deepcopy(member[key]) for key in ('checkIds', 'guardCheckIds', 'oracleRef', 'rubricRef', 'graderRefs')}})
    return {'benchmarkId': benchmark_id, 'subset': subset, 'plannedCount': len(rows),
        'blockedCount': len(rows), 'materializedCount': sum(r['fixture']['status'] == 'materialized' for r in rows),
        'actualProductRuns': 0, 'formalAcceptanceEligible': False, 'validation': validation,
        'config': {'stage': stage, 'stageMeaning': 'maximum_enabled_phase', 'split': split,
                   'environment': environment, 'profile': profile}, 'members': rows}


def _member_pin(member):
    return {key: deepcopy(member.get(key)) for key in ('caseVersion', 'caseSha256',
        'checkIds', 'guardCheckIds', 'assets', 'oracleRef', 'rubricRef', 'graderRefs',
        'semanticScenarioKey', 'sampleId', 'sampleRole', 'leakageGroup', 'split',
        'dependencyOnly', 'normalControlRefs', 'controlFor')}


def summarize_trials(members, trials, *, k, facility_selftest=False, comparison_pins=None):
    """Count a predeclared k without discarding missing, failed or duplicate trials.

    Product report ingestion deliberately awaits a runner-owned evidence adapter.
    Callers cannot enable it by putting a source or verification flag in a dict.
    """
    if facility_selftest is not True:
        raise ValueError('actual product report evidence adapter is not implemented; explicit facility self-test required')
    if type(k) is not int or k < 1:
        raise ValueError('k must be a predeclared positive integer')
    indexed = {}
    for member in members:
        cid = member['caseId']
        if cid in indexed and _member_pin(indexed[cid]) != _member_pin(member):
            raise ValueError('conflicting member pins')
        indexed[cid] = member
    slots, identities = {}, {}
    for trial in trials:
        cid, attempt, tid = trial['caseId'], trial['attempt'], trial['trialId']
        if cid not in indexed or trial.get('caseVersion') != indexed[cid]['caseVersion']:
            raise ValueError('trial identity is not in planned members')
        if type(attempt) is not int or not 1 <= attempt <= k:
            raise ValueError('attempt outside predeclared k')
        if trial.get('status') not in STATES or not isinstance(tid, str) or not tid:
            raise ValueError('invalid trial status or identity')
        signature = (cid, trial['caseVersion'], attempt, trial['status'])
        if tid in identities and identities[tid] != signature:
            raise ValueError('conflicting trial identity')
        slot = (cid, attempt)
        if slot in slots and (slots[slot]['trialId'] != tid or slots[slot]['status'] != trial['status']):
            raise ValueError('conflicting trial attempt')
        identities[tid], slots[slot] = signature, deepcopy(trial)
    counts = Counter({state: 0 for state in STATES})
    scored_counts, control_counts = counts.copy(), counts.copy()
    case_results, first_pass, any_pass, all_pass, stable = [], 0, 0, 0, 0
    for cid, member in sorted(indexed.items()):
        statuses = [slots.get((cid, attempt), {}).get('status', 'NOT_RUN') for attempt in range(1, k + 1)]
        counts.update(statuses)
        if member.get('dependencyOnly'):
            control_counts.update(statuses)
        else:
            scored_counts.update(statuses)
            first_pass += statuses[0] == 'PASS'
            any_pass += 'PASS' in statuses
            all_pass += all(status == 'PASS' for status in statuses)
            stable += len(set(statuses)) == 1 and 'NOT_RUN' not in statuses
        case_results.append({'caseId': cid, 'pin': _member_pin(member), 'firstStatus': statuses[0], 'statuses': statuses})
    n = len(indexed)
    scored_n = sum(not m.get('dependencyOnly', False) for m in indexed.values())
    rate = lambda value: value / scored_n if scored_n else None
    return {'scope': 'facility_selftest', 'formalAcceptanceEligible': False, 'actualProductRuns': 0,
        'k': k, 'plannedCases': n, 'plannedTrials': n * k,
        'scoredCaseCount': scored_n, 'controlDependencyCount': n - scored_n,
        'scoredCounts': dict(scored_counts), 'controlCounts': dict(control_counts),
        'allRequiredControlsPass': all(value == 0 for state, value in control_counts.items() if state != 'PASS'),
        'actualTrials': sum(t['status'] != 'NOT_RUN' for t in slots.values()),
        'uniqueSemanticScenarios': len({m.get('semanticScenarioKey') for m in indexed.values()} - {None}),
        'uniqueSamples': len({m.get('sampleId') for m in indexed.values()} - {None}),
        'counts': dict(counts), 'firstPassRate': rate(first_pass), 'passAtK': rate(any_pass),
        'passAllK': rate(all_pass), 'stabilityRate': rate(stable), 'caseResults': case_results,
        'comparisonPins': deepcopy(comparison_pins or {}),
        'limitations': ['Facility accounting only; no product verdict, baseline or acceptance.',
                        'Semantic/source counts are not independent statistical samples; no uncertainty estimate is claimed.']}


def compare_reports(baseline, candidate):
    """Compare common unchanged pins; list additions/removals outside the denominator."""
    if baseline.get('scope') != 'facility_selftest' or candidate.get('scope') != 'facility_selftest':
        raise ValueError('actual product report evidence adapter is not implemented')
    left = {row['caseId']: row for row in baseline['caseResults']}
    right = {row['caseId']: row for row in candidate['caseResults']}
    common = left.keys() & right.keys()
    changed = sorted(cid for cid in common if left[cid]['pin'] != right[cid]['pin'])
    unchanged = sorted(common - set(changed))
    reasons = []
    if baseline.get('k') != candidate.get('k'):
        reasons.append('k_mismatch')
    if not baseline.get('comparisonPins') or baseline.get('comparisonPins') != candidate.get('comparisonPins'):
        reasons.append('comparison_pins_missing_or_different')
    if changed:
        reasons.append('member_pins_changed')
    if not unchanged:
        reasons.append('no_common_unchanged_members')
    comparable = not reasons
    return {'scope': 'facility_selftest', 'comparable': comparable, 'reasons': reasons,
        'commonCaseIds': unchanged, 'changedCaseIds': changed,
        'addedCaseIds': sorted(right.keys() - left.keys()), 'removedCaseIds': sorted(left.keys() - right.keys()),
        'passToFail': [cid for cid in unchanged if left[cid]['firstStatus'] == 'PASS' and right[cid]['firstStatus'] == 'FAIL'] if comparable else [],
        'failToPass': [cid for cid in unchanged if left[cid]['firstStatus'] == 'FAIL' and right[cid]['firstStatus'] == 'PASS'] if comparable else [],
        'formalAcceptanceEligible': False}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('benchmark_id', choices=sorted(ACTIVE))
    parser.add_argument('--project', type=Path, default=Path(__file__).resolve().parents[3])
    parser.add_argument('--data-root', type=Path, help='Explicit fresh schema3 quality root; assembly remains offline')
    parser.add_argument('--subset', default='capability', choices=['capability', 'regression'])
    parser.add_argument('--stage')
    parser.add_argument('--split')
    parser.add_argument('--profile', type=Path, help='Explicit JSON configuration, never a product adapter')
    parser.add_argument('--environment', type=Path)
    args = parser.parse_args(argv)
    report = assemble(args.project, args.benchmark_id, args.subset, args.stage, args.split,
        _read(args.environment) if args.environment else None, _read(args.profile) if args.profile else None,
        args.data_root)
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0 if report['validation']['valid'] else 1


if __name__ == '__main__':
    raise SystemExit(main())
