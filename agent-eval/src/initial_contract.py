"""Strict schema-v1 authoring contracts for the initial evaluation dataset.

Opaque business payloads remain data. Harness configurations, by contrast,
must match a registered declaration and cannot introduce executable options.
"""
from functools import lru_cache
from contextlib import contextmanager
from contextvars import ContextVar
from pathlib import Path, PurePosixPath
import json
import re
import sys

TOOLS = Path(__file__).resolve().parents[1] / 'tools'
if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))

TASK_KEYS = {'schemaVersion', 'kind', 'id', 'version', 'title', 'classification',
             'task', 'setup', 'interactions', 'oracle', 'controlRefs', 'comparisonRefs',
             'traceability', 'applicability', 'split', 'leakageGroup', 'lifecycle'}
SCENARIO_KEYS = {'id', 'title', 'setup', 'exercise', 'oracle', 'traceability',
                 'applicability', 'split', 'leakageGroup', 'controlRefs'}
CHECK_REQUIRED = {'checkId', 'capabilities', 'harnessModules', 'requirementRefs',
                  'evaluationMode', 'criterion', 'assertion', 'evidenceRequirements',
                  'required', 'hardConstraint'}
SOURCE_KEYS = {'path', 'specSha256', 'section', 'heading', 'startLine', 'quote',
               'quoteSha256', 'interpretationReview', 'spec'}
CAPABILITIES = {'tool_use', 'memory', 'planning', 'reasoning', 'interaction',
                'context_use', 'resource_use', 'delegation', 'recovery'}
BUSINESS_TASK_TYPES = {'extraction', 'matching', 'human_collaboration',
                       'evidence_explanation', 'recovery_continuation', 'submission_confirmation'}

_PINNED_BASELINE_SETUPS = ContextVar('pinned_baseline_setups', default=None)


@contextmanager
def pinned_baseline_setups(setups):
    """Validate a digest-checked old publication before applying authored edits.

    Only the update command supplies these exact old setups. Candidate validation,
    normal verification and execution assembly always use the current registry.
    """
    token = _PINNED_BASELINE_SETUPS.set(setups)
    try:
        yield
    finally:
        _PINNED_BASELINE_SETUPS.reset(token)


def _same(left, right):
    return json.dumps(left, sort_keys=True, allow_nan=False) == json.dumps(right, sort_keys=True, allow_nan=False)


def object_fields(value, required, optional=(), label='object'):
    if not isinstance(value, dict):
        raise ValueError(f'{label} must be an object')
    missing, unknown = set(required) - value.keys(), value.keys() - set(required) - set(optional)
    if missing or unknown:
        raise ValueError(f'{label}: missing={sorted(missing)}, unknown={sorted(unknown)}')


def text(value, label):
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f'{label} must be nonempty text')


def strings(value, label, nonempty=False):
    if not isinstance(value, list) or (nonempty and not value):
        raise ValueError(f'{label} must be an array')
    for item in value:
        text(item, label)
    if len(value) != len(set(value)):
        raise ValueError(f'{label} contains duplicates')


def safe_relative(path):
    text(path, 'asset path')
    if ('\\' in path or ':' in path or '%' in path or path.startswith('/')
            or any(part in {'', '.', '..'} for part in path.split('/'))
            or PurePosixPath(path).is_absolute()):
        raise ValueError('asset path must be relative and contained')
    return path


def asset_ref(ref, model_input=False):
    object_fields(ref, {'root', 'path'}, {'sha256', 'bytes', 'id', 'version'}, 'asset reference')
    if ref['root'] not in {'project', 'quality'}:
        raise ValueError('unknown asset root')
    safe_relative(ref['path'])
    if model_input:
        parts = ref['path'].lower().split('/')
        suffix = ref['path'].removeprefix('data/invoices/voxel51/')
        source_path = re.fullmatch(r'[A-Za-z0-9_-]+/(?:content\.json|assets/images/[A-Za-z0-9_./-]+)', suffix)
        if (ref['root'] != 'project' or not ref['path'].startswith('data/invoices/voxel51/') or not source_path
                or any(p in {'gold', 'annotation', 'annotations', 'fields', 'quality', 'oracle'} for p in parts)):
            raise ValueError('quality assets cannot be model inputs')
    if 'sha256' in ref and (not isinstance(ref['sha256'], str) or not re.fullmatch('[a-f0-9]{64}', ref['sha256'])):
        raise ValueError('invalid asset digest')
    for key in ('bytes', 'version'):
        if key in ref and (type(ref[key]) is not int or ref[key] < (1 if key == 'version' else 0)):
            raise ValueError(f'invalid asset {key}')


def _sources(refs):
    if not isinstance(refs, list):
        raise ValueError('sourceRefs must be an array')
    for ref in refs:
        if isinstance(ref, str):
            text(ref, 'source reference')
        else:
            object_fields(ref, set(), SOURCE_KEYS, 'source reference')
            if not ref:
                raise ValueError('empty source reference')
            if 'path' in ref:
                safe_relative(ref['path'])


def _predicate(predicate, precondition=False):
    required = {'path', 'op', 'value'} | ({'description', 'evidence'} if precondition else set())
    object_fields(predicate, required, {'description'}, 'predicate')
    if not isinstance(predicate['path'], str) or not re.fullmatch(r'observation(?:\.[A-Za-z0-9_-]+)+', predicate['path']):
        raise ValueError('predicate requires an observation path')
    if predicate['op'] not in {'eq', 'lte', 'gte', 'contains', 'absent'}:
        raise ValueError('unknown assertion operator')
    if predicate['op'] in {'lte', 'gte'} and type(predicate['value']) not in (int, float):
        raise ValueError('ordered predicate requires a number')
    if precondition:
        strings(predicate['evidence'], 'precondition evidence', True)


def _oracle(oracle, protocol):
    object_fields(oracle, {'graderRef', 'checks'}, {'goldRef', 'expectedOutcome', 'forbidden'}, 'oracle')
    text(oracle['graderRef'], 'graderRef')
    if 'goldRef' in oracle:
        asset_ref(oracle['goldRef'])
        if oracle['goldRef']['root'] != 'quality':
            raise ValueError('Gold must be quality scoped')
    checks = oracle['checks']
    if not isinstance(checks, list) or not checks:
        raise ValueError('checks must be nonempty')
    seen = set()
    for check in checks:
        object_fields(check, CHECK_REQUIRED, {'preconditions', 'sourceRefs'}, 'check')
        text(check['checkId'], 'checkId')
        if check['checkId'] in seen:
            raise ValueError('duplicate check identity')
        seen.add(check['checkId'])
        for key in ('capabilities', 'harnessModules', 'requirementRefs'):
            strings(check[key], key)
        if set(check['capabilities']) - CAPABILITIES:
            raise ValueError('unknown check capability')
        text(check['criterion'], 'criterion')
        if check['evaluationMode'] not in {'A', 'B', 'F'}:
            raise ValueError('unknown evaluationMode')
        if check['evaluationMode'] != 'A' and check['capabilities']:
            raise ValueError('Agent capability attribution requires an A check')
        for key in ('required', 'hardConstraint'):
            if type(check[key]) is not bool:
                raise ValueError(f'{key} must be boolean')
        if check['assertion'] is None:
            if protocol != 'invoice_extraction' or oracle['graderRef'] != 'reviewed_invoice_extraction':
                raise ValueError('missing assertion outside reviewed extraction')
        else:
            _predicate(check['assertion'])
        evidence = check['evidenceRequirements']
        if not isinstance(evidence, list) or not evidence:
            raise ValueError('check requires evidence')
        for item in evidence:
            object_fields(item, {'kind'}, {'required'}, 'evidence requirement')
            text(item['kind'], 'evidence kind')
            if 'required' in item and type(item['required']) is not bool:
                raise ValueError('evidence required must be boolean')
        if 'preconditions' in check:
            if not isinstance(check['preconditions'], list):
                raise ValueError('preconditions must be an array')
            for condition in check['preconditions']:
                _predicate(condition, True)
        if 'sourceRefs' in check:
            _sources(check['sourceRefs'])


@lru_cache(maxsize=1)
def _registered():
    # These are authored command declarations, never an executable adapter map.
    from rebuild_fixtures import registered_scenarios
    return registered_scenarios()


@lru_cache(maxsize=1)
def _authored_registry():
    from initial_tasks import registered_initial_episodes
    return registered_initial_episodes()


def _setup(setup, traceability, identity):
    object_fields(setup, {'protocol', 'initialState', 'commands', 'faults', 'businessRef', 'businessPatches'}, label='setup')
    if setup['protocol'] == 'coverage_episode':
        from coverage_registry import registered
        baseline = _PINNED_BASELINE_SETUPS.get()
        expected = baseline.get(identity) if baseline is not None else registered().get(identity, {}).get('setup')
        if expected is None or not _same(setup, expected):
            raise ValueError('unknown or changed coverage episode configuration')
    elif setup['protocol'] == 'declared_episode':
        authored = _authored_registry()
        episodes = [authored[identity]] if identity in authored else [
            _registered()[legacy] for legacy in traceability['legacyIds'] if legacy in _registered()]
        if not episodes:
            raise ValueError('declared episode requires a registered identity')
        episode = episodes[0]
        if any(not _same(setup[key], episode[old]) for key, old in [('initialState', 'initialState'), ('commands', 'steps'), ('faults', 'faults')]):
            raise ValueError('unknown or changed registered episode configuration')
        if not _same(setup['businessPatches'], episode.get('businessPatches', [])):
            raise ValueError('unregistered business patches')
        ref = setup['businessRef']
        if 'businessId' in episode:
            from rebuild_business_projection import validate_reference
            validate_reference(ref)
            if ref['id'] != episode['businessId']:
                raise ValueError('wrong episode business identity')
        elif ref is not None:
            raise ValueError('unexpected business reference')
    elif setup['protocol'] == 'invoice_extraction':
        object_fields(setup['initialState'], {'sampleId', 'inputMode'}, label='extraction initialState')
        text(setup['initialState']['sampleId'], 'sampleId')
        if setup['initialState']['inputMode'] != 'parsed_only':
            raise ValueError('unsupported extraction inputMode')
        if setup['commands'] != [] or setup['faults'] != [] or setup['businessRef'] is not None or setup['businessPatches'] != []:
            raise ValueError('unknown extraction harness configuration')
    else:
        raise ValueError('unknown setup protocol')


def _shared(case):
    trace = case['traceability']
    object_fields(trace, {'modRefs', 'rtRefs', 'rtcRefs', 'sourceRefs', 'legacyIds', 'harnessModules'}, label='traceability')
    for key in trace.keys() - {'sourceRefs'}:
        strings(trace[key], key)
    _sources(trace['sourceRefs'])
    _setup(case['setup'], trace, case['id'])
    _oracle(case['oracle'], case['setup']['protocol'])
    application = case['applicability']
    object_fields(application, {'minimumStage', 'adapterRef', 'executionEligibility', 'blockers'}, label='applicability')
    if not re.fullmatch(r'P(?:[0-9]|1[0-3])(?:-[ABC])?', str(application['minimumStage'])):
        raise ValueError('invalid minimumStage')
    strings(application['blockers'], 'blockers', True)
    if application['executionEligibility'] != 'blocked' or 'product_adapter_required' not in application['blockers']:
        raise ValueError('initial product assets require product_adapter_required blocking')
    if application['adapterRef'] is not None:
        text(application['adapterRef'], 'adapterRef')
    if case['split'] not in {'development', 'regression', 'acceptance'}:
        raise ValueError('unknown split')
    text(case['leakageGroup'], 'leakageGroup')
    for key in ('controlRefs', 'comparisonRefs'):
        if key in case:
            strings(case[key], key)
            if case['id'] in case[key]:
                raise ValueError('self-referential dependency')


def validate_asset(asset):
    """Validate in memory; raise ValueError and never repair rejected data."""
    try:
        json.dumps(asset, allow_nan=False)
    except (TypeError, ValueError) as exc:
        raise ValueError('asset must contain finite JSON values') from exc
    if not isinstance(asset, dict):
        raise ValueError('asset must be an object')
    if type(asset.get('schemaVersion')) is not int or asset['schemaVersion'] != 1:
        raise ValueError('unsupported schemaVersion')
    text(asset.get('id'), 'asset id')
    if type(asset.get('version')) is not int or asset['version'] < 1:
        raise ValueError('version must be a positive integer')
    kind = asset.get('kind')
    if kind == 'agent_task':
        object_fields(asset, TASK_KEYS, label='agent_task')
        text(asset['title'], 'title')
        classification = asset['classification']
        object_fields(classification, {'capabilities', 'taskShape', 'difficulty', 'conditions', 'targetFailureModes', 'business'}, label='classification')
        strings(classification['capabilities'], 'capabilities', True)
        if set(classification['capabilities']) - CAPABILITIES:
            raise ValueError('unknown capability')
        strings(classification['conditions'], 'conditions')
        strings(classification['targetFailureModes'], 'targetFailureModes')
        shape = classification['taskShape']
        object_fields(shape, {'stepStructure', 'interactionMode', 'longHorizon'}, label='taskShape')
        if shape['stepStructure'] not in {'single_step', 'multi_step'} or shape['interactionMode'] not in {'single_turn', 'multi_turn'}:
            raise ValueError('unknown task shape')
        if type(shape['longHorizon']) is not bool:
            raise ValueError('longHorizon must be boolean')
        difficulty = classification['difficulty']
        object_fields(difficulty, {'level', 'basis', 'status'}, label='difficulty')
        for key in ('level', 'status'):
            text(difficulty[key], key)
        if difficulty['level'] not in {'easy', 'medium', 'hard'}:
            raise ValueError('unknown difficulty level')
        if isinstance(difficulty['basis'], list):
            strings(difficulty['basis'], 'difficulty basis', True)
        else:
            text(difficulty['basis'], 'difficulty basis')
        business = classification['business']
        object_fields(business, {'domain', 'primaryTaskType', 'relatedTaskTypes'}, label='business')
        for key in ('domain', 'primaryTaskType'):
            text(business[key], key)
        strings(business['relatedTaskTypes'], 'relatedTaskTypes')
        if business['primaryTaskType'] not in BUSINESS_TASK_TYPES or set(business['relatedTaskTypes']) - BUSINESS_TASK_TYPES:
            raise ValueError('unknown business task type')
        task = asset['task']
        object_fields(task, {'messages', 'context', 'assetRefs'}, label='task')
        if not isinstance(task['messages'], list) or not task['messages']:
            raise ValueError('task requires user messages')
        for message in task['messages']:
            object_fields(message, {'role', 'content'}, label='task message')
            if message['role'] not in {'user', 'system', 'assistant'}:
                raise ValueError('unknown message role')
            text(message['content'], 'message content')
        if not isinstance(task['context'], dict) or not isinstance(task['assetRefs'], list):
            raise ValueError('task context/assetRefs has wrong type')
        for ref in task['assetRefs']:
            asset_ref(ref, model_input=True)
        from rebuild_cases import assert_product_projection
        assert_product_projection(task)
        if not isinstance(asset['interactions'], list):
            raise ValueError('interactions must be array')
        for interaction in asset['interactions']:
            object_fields(interaction, {'interactionId', 'kind', 'after', 'commandRef', 'actor', 'payload'}, label='interaction')
            if interaction['kind'] not in {'user_message', 'human_decision', 'environment_event'}:
                raise ValueError('unknown interaction kind')
            for key in ('interactionId', 'commandRef', 'actor'):
                text(interaction[key], key)
            if interaction['commandRef'] not in {command['id'] for command in asset['setup']['commands']}:
                raise ValueError('unknown interaction commandRef')
        object_fields(asset['lifecycle'], {'material', 'review'}, label='lifecycle')
        for value in asset['lifecycle'].values():
            text(value, 'lifecycle status')
        _shared(asset)
        measured = {capability for check in asset['oracle']['checks'] if check['evaluationMode'] == 'A'
                    for capability in check['capabilities']}
        if set(classification['capabilities']) - measured:
            raise ValueError('classification capability lacks a direct Agent check')
    elif kind in {'product_contract', 'eval_selftest'}:
        keys = {'schemaVersion', 'kind', 'id', 'version', 'scenarios'} | ({'harnessModule'} if kind == 'product_contract' else set())
        object_fields(asset, keys, label=kind)
        if not isinstance(asset['scenarios'], list) or not asset['scenarios']:
            raise ValueError('suite scenarios must be nonempty')
        seen = set()
        for scenario in asset['scenarios']:
            object_fields(scenario, SCENARIO_KEYS if kind == 'product_contract' else {'id', 'input', 'expected', 'evidenceOrigin'}, label='scenario')
            text(scenario['id'], 'scenario id')
            if scenario['id'] in seen:
                raise ValueError('duplicate scenario id')
            seen.add(scenario['id'])
            if kind == 'product_contract':
                text(scenario['title'], 'scenario title')
                _shared(scenario)
                object_fields(scenario['exercise'], {'input', 'commands'}, label='exercise')
                if not isinstance(scenario['exercise']['input'], dict):
                    raise ValueError('exercise input must be an object')
                if scenario['exercise']['commands'] != scenario['setup']['commands']:
                    raise ValueError('exercise differs from registered commands')
            else:
                if scenario['evidenceOrigin'] not in {'synthetic', 'grader_self_test', 'synthetic_selftest'}:
                    raise ValueError('selftests require synthetic evidence origin')
                episode = scenario['input']
                object_fields(episode, {'input', 'initialState', 'commands', 'faults'}, label='selftest input')
                registered = _registered().get('fresh-' + scenario['id'].removeprefix('selftest-'))
                if registered is None or registered['module'] != 'eval-infrastructure':
                    raise ValueError('unregistered selftest declaration')
                expected_episode = {key: registered[old] for key, old in [
                    ('input', 'input'), ('initialState', 'initialState'), ('commands', 'steps'), ('faults', 'faults')]}
                if not _same(episode, expected_episode):
                    raise ValueError('unknown selftest input configuration')
                object_fields(scenario['expected'], {'checks'}, label='selftest expected')
                _oracle({'graderRef': 'synthetic_selftest', 'checks': scenario['expected']['checks']}, 'declared_episode')
    else:
        raise ValueError('unknown asset kind')
    return asset
