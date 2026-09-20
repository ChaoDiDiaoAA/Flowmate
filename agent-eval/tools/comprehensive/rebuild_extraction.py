"""One whole-invoice Case per freshly selected source; never copy legacy answers.

This builds quality-side task contracts. It does not annotate images, grant a
review, flatten uncertain line correspondence or execute an extraction model.
"""
from copy import deepcopy
from rebuild_bindings import case_version, binding_revision
import base64
import hashlib
import json
from pathlib import Path, PurePosixPath
import re

from rebuild_contracts import resolve_source_ref
from rebuild_sources import contained


TASK = ('请依据本次获准的发票解析，提取票头、买卖方、日期、币种、金额和全部明细，'
        '保留原始表示并逐项提供页码和内容定位。区分缺失、歧义及冲突；'
        '没有充分依据时如实说明，不猜币种、不补零，不用计算结果覆盖票面内容。'
        '本次只产生字段候选，不接受业务修订、不审批或提交。')
POLICY = {
    'fields': ('MOD-11.fields', '字段保存原值、规范值、来源/证据定位、缺失/歧义/冲突和修订号。'),
    'lines': ('MOD-11.lines', '发票模型包括票头、买卖方、日期/币种、净额/税额/总额、明细与外部关联。'),
    'evidence': ('MOD-11.evidence', '模型根据获准输入与证据产生的预测，保留原始结果及来源'),
    'uncertainty': ('MOD-11.uncertainty', '未知币种不猜、缺失不填零、票面与计算值冲突同时保留。'),
}
EXTRACTION_AUTHOR_VERSION = 3


def _digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=False,
                                    separators=(',', ':'), allow_nan=False).encode()).hexdigest()


def build_extraction_cases(golds, contracts):
    cases, seen, originals = [], set(), set()
    for gold in golds:
        sample = gold['sampleId']
        if not isinstance(sample, str) or not re.fullmatch(r'[A-Za-z0-9_-]+', sample):
            raise ValueError('Unsafe source identity')
        if sample in seen:
            raise ValueError('Duplicate invoice Case')
        seen.add(sample)
        provenance = gold.get('provenance', {})
        if provenance.get('legacyAnswersRead') is not False or provenance.get('publisherAnswersRead') is not False:
            raise ValueError('Fresh independent answer provenance required')
        if gold.get('schemaVersion') != 3 or gold.get('id') != 'gold-fresh-' + sample:
            raise ValueError('Expected fresh Gold identity')
        if type(gold.get('version')) is not int or gold['version'] < 1:
            raise ValueError('Positive Gold revision required')
        if gold.get('split') not in {'development', 'regression', 'acceptance'} or not gold.get('leakageGroup'):
            raise ValueError('Source split and group required')
        files = {}
        for pin in gold['sourceSnapshot']:
            relative = pin['path']
            path = PurePosixPath(relative)
            if path.is_absolute() or '..' in path.parts or '\\' in relative or ':' in relative or path.parts[0] != sample:
                raise ValueError('Source pin escapes the selected invoice')
            if relative in files or not re.fullmatch('[a-f0-9]{64}', pin['sha256']) or type(pin['bytes']) is not int or pin['bytes'] <= 0:
                raise ValueError('Invalid or duplicate source pin')
            files[relative] = deepcopy(pin)
        if f'{sample}/original.jpg' not in files or f'{sample}/content.json' not in files:
            raise ValueError('Paired original and parse required')
        original = files[f'{sample}/original.jpg']['sha256']
        if original in originals:
            raise ValueError('Repeated original bytes cannot create another invoice Case')
        originals.add(original)
        # A parsed-only task never receives the original image, labels, metadata,
        # source selection rationale or any candidate/settled answer.
        allowed = [pin for path, pin in sorted(files.items()) if path == f'{sample}/content.json'
                   or path.startswith(f'{sample}/assets/images/')]
        input_assets = [dict(pin, path='data/invoices/voxel51/' + pin['path']) for pin in allowed]
        identity = 'fresh-extraction-' + sample
        checks = []
        for key, (metric, quote) in POLICY.items():
            if metric not in contracts['metrics']:
                raise ValueError('Required extraction metric missing')
            source = resolve_source_ref(contracts, {'spec': 'product', 'section': '16.2', 'quote': quote})
            metric_def = contracts['metrics'][metric]
            metric_source = resolve_source_ref(contracts, {'spec': 'evaluation', 'section': metric_def['section'],
                                                          'quote': metric_def['definition']})
            checks.append({'checkId': identity + ':' + key, 'metricId': metric,
                           'metricVersionRef': _digest(metric_def['definition']), 'evaluationMode': 'A',
                           'dimension': 'modelBehavior', 'required': True, 'hardConstraint': False,
                           'ruleStatus': 'implemented', 'collectorStatus': 'product_adapter_required',
                           'graderRequirement': 'reviewed_schema3_' + key,
                           'sourceRefs': [source, metric_source], 'requirementRefs': [metric],
                           'evidenceRequirements': [{'kind': kind, 'required': True} for kind in
                              ['actual-model-input', 'original-extraction-candidate', 'candidate-source-locators']],
                           'coverageScope': 'this_whole_invoice_not_entire_metric'})
        # Every Gold revision changes the scoring authority pinned by this Case,
        # so it must produce a strictly newer Case/Oracle revision.  The author
        # floor records the current task design revision without collapsing
        # Gold v1 and v2 onto the same Case version.
        authored_version = EXTRACTION_AUTHOR_VERSION + gold['version'] - 1
        cases.append({'schemaVersion': 3, 'id': identity, 'version': case_version(authored_version, contracts), 'category': 'extraction',
                      'scenarioProtocol': {'kind': 'fresh_invoice_extraction', 'version': 1},
                      'familyId': 'agent-runtime/whole-invoice-extraction', 'harnessModule': 'agent-runtime',
                      'relatedHarnessModules': ['context', 'tools'], 'subcapabilityRefs': ['whole-invoice-extraction'],
                      'stage': 'P2', 'title': '整票字段、明细与来源核验：' + sample,
                      'trigger': TASK, 'inputMode': 'parsed_only', 'inputAssets': input_assets,
                      'sampleId': sample, 'sampleRole': 'actual_invoice_input',
                      'split': gold['split'], 'leakageGroup': gold['leakageGroup'],
                      'splitStatus': ('selected_set_source_relationship_reviewed'
                          if gold.get('partitionStatus') == 'selected_set_source_relationship_reviewed'
                          else 'provisional_pending_exposure_review'),
                      'semanticScenarioKey': 'whole-invoice:' + original, 'replicaIndex': 1,
                      'caseSummary': {'input': '一份原票对应的获准解析及所引用局部图片。',
                          'trigger': '新建隔离任务，使用固定模型和工具配置产生原始字段候选并保存来源。',
                          'expected': '依据独立核验答案逐字段、逐行和逐证据评分；如实表达输入不可得与歧义。'},
                      'initialEnvironment': {'kind': 'selected_invoice_readonly', 'resetBeforeEachTrial': True,
                          'allowedInputAssets': deepcopy(input_assets), 'priorCandidate': None,
                          'businessWriteAllowed': False, 'approvalPresent': False},
                      'executionPlan': ['verify_and_project_exact_input', 'execute_real_agent_extraction',
                                        'save_original_candidate_and_request_evidence', 'grade_at_frozen_deadline'],
                      'normalControlRefs': [], 'evaluationModes': ['A'], 'evaluationMode': 'A',
                      'oracle': {'version': case_version(authored_version, contracts), 'status': 'content_review_pending',
                          'fieldGoldRef': 'gold/' + gold['id'] + '.json', 'fieldGoldVersion': gold['version'],
                          'fieldGoldSha256': _digest(gold), 'checks': checks,
                          'requiredEvidence': ['actual-model-input', 'original-extraction-candidate', 'candidate-source-locators'],
                          'forbidden': ['读取Gold或提供方答案', '无依据猜值', '用修订后字段冒充原始预测', '执行提交'],
                          'denominatorPolicy': 'retain_all_reviewed_truth_fields_and_report_input_unavailable_slice',
                          'lineMatchingPolicy': 'one_to_one_reviewed_correspondence_required',
                          'thresholdStatus': 'requires_predeclared_stage_protocol'},
                      'scoring': {'method': 'reviewed_schema3_extraction', 'implementationStatus': 'available',
                                  'graderContractVersion': 3,
                                  'graderImplementation': 'agent-eval/src/graders/observations.py'},
                      'provenance': {'method': 'fresh_selected_original_and_contract', 'legacyCasesRead': False, 'authoredVersion': authored_version,
                                     'sourceBindingRevision': binding_revision(contracts)},
                      'sourceSpecHashes': {d['path']: {'path': d['path'], 'sha256': d['sha256']}
                                           for d in contracts['documents'].values()},
                      'materialStatus': 'structure_checked', 'reviewStatus': 'pending', 'humanVerified': False,
                      'executionStatus': 'not_run', 'formalAcceptanceEligible': False,
                      'executionEligibility': {'status': 'dependencies_missing', 'missing': [
                          *([] if gold.get('humanVerified') is True and
                              gold.get('eligibleForFieldScoring') is True
                              else ['original_image_annotation_and_review']),
                          *([] if gold.get('partitionStatus') == 'selected_set_source_relationship_reviewed' else ['split_freeze']),
                          'case_content_review',
                          'actual_product_adapter', 'trusted_evidence_collector',
                          'frozen_execution_and_threshold_profile']},
                      'benchmarks': [], 'benchmarkMembershipStatus': 'direct_check_mapping_pending'})
    return cases


def materialize_extraction(case, source_root, business=None):
    """Read the exact allowed parse bytes; no quality-side answers are consulted."""
    if source_root is None or business is not None:
        raise ValueError('Extraction needs its explicit source root and no synthetic business package')
    from rebuild_contracts import load_spec_contracts
    contracts = load_spec_contracts(Path(__file__).resolve().parents[3])
    if (case.get('scenarioProtocol') != {'kind': 'fresh_invoice_extraction', 'version': 1} or
            type(case.get('version')) is not int or case['version'] < 1 or
            case['version'] != case_version(case.get('provenance', {}).get('authoredVersion', 0), contracts) or
            case['version'] != case.get('oracle', {}).get('version')):
        raise ValueError('Unregistered extraction protocol or revision')
    sample = case.get('sampleId')
    if not isinstance(sample, str) or not re.fullmatch(r'[A-Za-z0-9_-]+', sample):
        raise ValueError('Invalid selected invoice identity')
    if (case.get('id') != 'fresh-extraction-' + sample or case.get('inputMode') != 'parsed_only' or
            case.get('trigger') != TASK or case.get('category') != 'extraction' or case.get('stage') != 'P2'):
        raise ValueError('Unregistered extraction input contract')
    if any(k in case for k in ('inputOverrides', 'harnessOverrides', 'scenarioSetup')):
        raise ValueError('Unsupported extraction overrides')
    inputs = case.get('inputAssets')
    expected_environment = {'kind': 'selected_invoice_readonly', 'resetBeforeEachTrial': True,
                            'allowedInputAssets': inputs, 'priorCandidate': None,
                            'businessWriteAllowed': False, 'approvalPresent': False}
    if not isinstance(inputs, list) or not inputs or case.get('initialEnvironment') != expected_environment:
        raise ValueError('Unregistered extraction environment')
    sample_root = contained(source_root, sample)
    prefix = 'data/invoices/voxel51/' + sample + '/'
    loaded = {}
    for pin in inputs:
        if not isinstance(pin, dict):
            raise ValueError('Invalid source input descriptor')
        relative = pin.get('path', '')
        if not isinstance(relative, str) or not relative.startswith(prefix):
            raise ValueError('Input is not part of the selected invoice')
        name = relative[len(prefix):]
        if name in loaded or not (name == 'content.json' or name.startswith('assets/images/')):
            raise ValueError('Only parse and its local images are authorized')
        path = contained(sample_root, name)
        raw = path.read_bytes()
        if (type(pin.get('bytes')) is not int or len(raw) != pin['bytes'] or
                hashlib.sha256(raw).hexdigest() != pin.get('sha256')):
            raise ValueError('Selected source bytes differ from the frozen input')
        loaded[name] = raw
    if 'content.json' not in loaded:
        raise ValueError('Missing selected parse')
    parsed = json.loads(loaded['content.json'].decode('utf-8-sig'))
    if not isinstance(parsed, list) or not parsed or not all(isinstance(b, dict) for b in parsed):
        raise ValueError('Expected nonempty source parse blocks')
    referenced = set()
    def collect(value):
        if isinstance(value, dict):
            for key, child in value.items():
                if key in {'img_path', 'image_path'}:
                    if not isinstance(child, str) or not child.startswith('assets/images/') or child not in loaded:
                        raise ValueError('Parse image reference is outside approved assets or missing')
                    referenced.add(child)
                else:
                    collect(child)
        elif isinstance(value, list):
            for child in value:
                collect(child)
    collect(parsed)
    return {'status': 'materialized',
            'input': {'request': TASK, 'document': {'sampleId': sample, 'inputMode': 'parsed_only',
                        'parsedContent': parsed, 'assets': {name: {'encoding': 'base64',
                            'data': base64.b64encode(loaded[name]).decode('ascii')} for name in sorted(referenced)}}},
            'harness': {'kind': 'readonly_extraction_adapter_plan', 'caseId': case['id'],
                        'caseVersion': case['version'], 'sourcePins': deepcopy(inputs),
                        'resetBeforeEachTrial': True, 'businessWriteAllowed': False,
                        'executionStatus': 'NOT_RUN', 'inputMode': 'parsed_only'},
            'fixtureValidation': {'sourceHashesChecked': True, 'oracleRead': False, 'actualProductRun': False},
            'limitations': ['Pinned input projection only; real extraction, trusted collection, reviewed Gold and schema3 scoring remain required.']}
