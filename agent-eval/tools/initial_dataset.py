"""Current-only design dataset: prepare, verify and report. Never runs a product."""
from __future__ import annotations

import argparse
from collections import Counter, defaultdict
from copy import deepcopy
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import sys

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'agent-eval/src'))
FORMAT = 'initial-agent-evaluation'
SPECS = ('docs/spec/00_Flowmate完整方案.md', 'agent-eval/docs/spec/01_Flowmate_Agent评测总方案.md')
ACTIVE_BMS = tuple(f'BM-{i:02}' for i in range(1, 13) if i != 6)
BUDGETS = {'extraction': 20, 'matching': 20, 'human_collaboration': 15,
           'evidence_explanation': 15, 'recovery_continuation': 15, 'submission_confirmation': 15}


def encode(value):
    return (json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False) + '\n').encode('utf-8')


def read(path):
    return json.loads(Path(path).read_bytes())


def digest(value):
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True,
                                    separators=(',', ':'), allow_nan=False).encode()).hexdigest()


def pin(path, raw):
    return {'path': path, 'bytes': len(raw), 'sha256': hashlib.sha256(raw).hexdigest()}


def contained(root, relative):
    from rebuild_sources import contained as safe
    result = safe(root, relative)
    node = Path(root).resolve()
    for part in Path(relative).parts:
        node /= part
        if node.is_symlink() or (node.exists() and getattr(node, 'is_junction', lambda: False)()):
            raise ValueError('Links are not allowed: ' + str(node))
    return result


def is_current(project):
    marker = Path(project) / 'agent-eval/data/manifests/active-dataset.json'
    return marker.exists() and read(marker).get('format') == FORMAT


def convert_check(check):
    result = {
        'checkId': check['checkId'], 'capabilities': [],
        'harnessModules': [check['harnessModule']] if check.get('harnessModule') else [],
        'requirementRefs': list(dict.fromkeys([check.get('metricId')] + check.get('requirementRefs', []))),
        'evaluationMode': check['evaluationMode'],
        'criterion': check.get('assertion', {}).get('description', check['checkId']),
        'assertion': deepcopy(check['assertion']),
        'evidenceRequirements': deepcopy(check['evidenceRequirements']),
        'required': check.get('required', True), 'hardConstraint': check.get('hardConstraint', False),
        'preconditions': deepcopy(check.get('preconditions', [])),
        'sourceRefs': deepcopy(check.get('sourceRefs', [])),
    }
    result['requirementRefs'] = [x for x in result['requirementRefs'] if x]
    return result


def old_refs(case):
    return [r.get('caseId', r.get('id')) for field in ('normalControlRefs', 'comparisonRefs')
            for r in case.get(field, [])]


def compact_contracts(old_cases, tasks):
    """Preserve distinct conditions; merge exact semantic duplicates, not fault windows."""
    mapping = {old: task['id'] for task in tasks for old in task['traceability']['legacyIds']}
    suites, signatures = {}, {}
    for old in old_cases:
        if old['harnessModule'] == 'eval-infrastructure' or 'A' in old['evaluationModes']:
            continue
        if old['id'] in mapping:
            # The new complete task retains these direct F/B checks already.
            continue
        module = old['harnessModule']
        setup = {'protocol': 'declared_episode', 'initialState': deepcopy(old['episode']['initialState']),
                 'commands': deepcopy(old['episode']['commands']), 'faults': deepcopy(old['episode']['faults']),
                 'businessRef': deepcopy(old.get('businessRef')), 'businessPatches': deepcopy(old.get('businessPatches', []))}
        checks = [convert_check(c) for c in old['oracle']['checks']]
        signature = digest({'module': module, 'setup': setup, 'input': old['episode']['input'],
                            'checks': [{k:v for k,v in c.items() if k not in ('checkId', 'sourceRefs')} for c in checks],
                            'split': old['split']})
        if signature in signatures:
            existing = signatures[signature]
            existing['traceability']['legacyIds'].append(old['id'])
            mapping[old['id']] = existing['id']
            continue
        sid = 'contract-' + old['id'].removeprefix('fresh-')
        scenario = {'id': sid, 'title': old['title'], 'setup': setup,
                    'exercise': {'input': deepcopy(old['episode']['input']), 'commands': deepcopy(old['episode']['commands'])},
                    'oracle': {'graderRef': 'declared-observations', 'checks': checks},
                    'traceability': {'legacyIds': [old['id']], 'harnessModules': [module],
                                    'modRefs': sorted({r.split('.')[0] for c in checks for r in c['requirementRefs'] if r.startswith('MOD-')}),
                                    'rtRefs': [], 'rtcRefs': [], 'sourceRefs': deepcopy(old.get('sourceRefs', []))},
                    'applicability': {'minimumStage': old['stage'], 'adapterRef': 'product-contract',
                                      'executionEligibility': 'blocked', 'blockers': ['product_adapter_required', 'trusted_collector_required']},
                    'split': old['split'], 'leakageGroup': old['leakageGroup'], 'controlRefs': old_refs(old)}
        suites.setdefault(module, {'schemaVersion': 1, 'kind': 'product_contract',
                                  'id': 'contract-suite-' + module, 'version': 1,
                                  'harnessModule': module, 'scenarios': []})['scenarios'].append(scenario)
        signatures[signature] = scenario
        mapping[old['id']] = sid
    for suite in suites.values():
        for scenario in suite['scenarios']:
            scenario['controlRefs'] = list(dict.fromkeys(mapping[x] for x in scenario['controlRefs']))
    return list(suites.values()), mapping


def compact_selftests(old_cases):
    scenarios, mapping, signatures = [], {}, {}
    for old in old_cases:
        if old['harnessModule'] != 'eval-infrastructure':
            continue
        episode = deepcopy(old['episode'])
        expected = [convert_check(c) for c in old['oracle']['checks']]
        signature = digest({'input': episode, 'assertions': [c['assertion'] for c in expected]})
        if signature in signatures:
            mapping[old['id']] = signatures[signature]
            continue
        sid = 'selftest-' + old['id'].removeprefix('fresh-')
        scenarios.append({'id': sid, 'input': episode, 'expected': {'checks': expected},
                          'evidenceOrigin': 'synthetic_selftest'})
        signatures[signature] = sid
        mapping[old['id']] = sid
    return {'schemaVersion': 1, 'kind': 'eval_selftest', 'id': 'evaluation-selftests',
            'version': 1, 'scenarios': scenarios}, mapping


def assets(outputs):
    """Yield catalog identities. A contract variant points into one suite file."""
    for path, raw in sorted(outputs.items()):
        if path.startswith('cases/'):
            value = json.loads(raw)
            yield value, {'id': value['id'], 'kind': value['kind'], 'version': value['version'], **pin(path, raw)}
        elif path.startswith('contracts/'):
            value = json.loads(raw)
            for scenario in value['scenarios']:
                yield scenario, {'id': scenario['id'], 'kind': value['kind'], 'version': value['version'],
                                 **pin(path, raw), 'scenarioId': scenario['id'], 'suiteId': value['id']}


def benchmark_checks(asset):
    from rebuild_benchmark_mapping import METRIC_BENCHMARKS, EXTRACTION, RUNTIME_METRICS, SECURITY_PATHS, RECOVERY_PATHS
    selected = defaultdict(list)
    stage = asset['applicability']['minimumStage']
    modules = set(asset['traceability']['harnessModules'])
    for check in asset['oracle']['checks']:
        targets = set()
        from coverage_supplement import benchmark_checks as reviewed_benchmark_checks
        targets.update(reviewed_benchmark_checks(asset, check))
        for ref in check['requirementRefs']:
            targets.update(METRIC_BENCHMARKS.get(ref, ()))
            # Direct Runtime scene checks contribute only to their native
            # measurement protocol, never because of a module label.
            if ref.startswith('RTC-'):
                targets.add('BM-12' if ref.startswith('RTC-17-') else 'BM-11')
                if ref.startswith('RTC-08-'):
                    targets.add('BM-12')
            if ref.startswith('RTX-'):
                targets.add('BM-12' if ref == 'RTX-06' else 'BM-11')
                targets.add('BM-07')
                if ref=='RTX-03':targets.add('BM-12')
            if ref in EXTRACTION:
                targets.add('BM-01')
            if ref in RUNTIME_METRICS and stage != 'P0' and check['evaluationMode'] in ('F', 'A'):
                targets.add('BM-11')
        observation = (check.get('assertion') or {}).get('path')
        if observation in SECURITY_PATHS:
            targets.add('BM-08')
        if observation in RECOVERY_PATHS:
            targets.add('BM-07')
        if modules & {'subagents'}:
            targets.discard('BM-11')
        for bm in sorted(targets):
            selected[bm].append(check['checkId'])
    return selected


def build_benchmarks(project, outputs, sources):
    indexed = {ref['id']: (asset, ref) for asset, ref in assets(outputs)}
    public, counts = {}, {}
    for bm in ACTIVE_BMS:
        definition = read(project / f'agent-eval/benchmarks/{bm}/definition.json')
        definition.update(schemaVersion=1, version=1, status='design_candidate', sourceRefs=sources,
                          membersRef=f'manifests/benchmarks/{bm}/members.json', baselineRefs=[])
        definition['assetKinds'] = ['agent_task', 'product_contract'] if bm != 'BM-10' else []
        definition['readinessMeaning'] = '设计协议与候选成员；未冻结、未执行，不构成产品成绩。'
        public[f'agent-eval/benchmarks/{bm}/definition.json'] = encode(definition)
        members = {}
        for aid, (asset, ref) in indexed.items():
            checks = benchmark_checks(asset).get(bm, [])
            if not checks:
                continue
            guards = [c['checkId'] for c in asset['oracle']['checks'] if c['hardConstraint']]
            members[aid] = {'assetId': aid, 'assetKind': ref['kind'], 'path': ref['path'],
                'version': ref['version'], 'sha256': ref['sha256'], 'checkIds': checks, 'guardCheckIds': guards,
                'split': asset['split'], 'stage': asset['applicability']['minimumStage'],
                'subsets': ['capability', 'regression'], 'dependencyOnly': False,
                'subsetRationale': {'capability': '当前能力设计覆盖', 'regression': '契约保护候选，无历史运行表现'},
                'controlRefs': asset.get('controlRefs', []) + asset.get('comparisonRefs', []),
                'requirementRefs': sorted({r for c in asset['oracle']['checks'] if c['checkId'] in checks for r in c['requirementRefs']}),
                'gradingDependencies': {'graderRef': asset['oracle']['graderRef'], 'status': 'trusted_product_evidence_required'}}
            if 'scenarioId' in ref:
                members[aid]['scenarioId'] = ref['scenarioId']
        pending = list(members)
        while pending:
            aid = pending.pop()
            for cid in members[aid]['controlRefs']:
                if cid in members:
                    continue
                asset, ref = indexed[cid]
                members[cid] = {'assetId': cid, 'assetKind': ref['kind'], 'path': ref['path'], 'version': ref['version'],
                    'sha256': ref['sha256'], 'checkIds': [c['checkId'] for c in asset['oracle']['checks']],
                    'guardCheckIds': [c['checkId'] for c in asset['oracle']['checks'] if c['hardConstraint']],
                    'split': asset['split'], 'stage': asset['applicability']['minimumStage'],
                    'subsets': ['capability', 'regression'], 'dependencyOnly': True,
                    'subsetRationale': {'capability': '必要对照', 'regression': '必要对照'},
                    'controlRefs': asset.get('controlRefs', []) + asset.get('comparisonRefs', []),
                    'requirementRefs': [], 'gradingDependencies': {'graderRef': asset['oracle']['graderRef'], 'status': 'trusted_product_evidence_required'}}
                if 'scenarioId' in ref:
                    members[cid]['scenarioId'] = ref['scenarioId']
                pending.append(cid)
        rows = sorted(members.values(), key=lambda x:x['assetId'])
        count = {'agentTasks': sum(m['assetKind']=='agent_task' and not m['dependencyOnly'] for m in rows),
                 'contractScenarios': sum(m['assetKind']=='product_contract' and not m['dependencyOnly'] for m in rows),
                 'controls': sum(m['dependencyOnly'] for m in rows), 'actualProductRuns': 0}
        counts[bm] = count
        previous_readme=(project/f'agent-eval/benchmarks/{bm}/README.md').read_text(encoding='utf-8-sig')
        previous_readme=previous_readme.split('\n## 当前初始成员')[0].rstrip()
        previous_readme=previous_readme.replace('当前为 v1 定义草案','当前为结构版本 1 的设计草案')
        previous_readme=previous_readme.replace('实际运行展开清单、配置、证据和成绩保留在质量数据根。',
            '真实执行后的展开清单、配置、证据和成绩保存在 agent-eval/runs/，当前不创建运行记录。')
        public[f'agent-eval/benchmarks/{bm}/README.md']=(previous_readme+'\n\n## 当前初始成员\n\n'
            +f"完整 Agent 任务 {count['agentTasks']} 个，产品契约场景 {count['contractScenarios']} 个，依赖对照 {count['controls']} 个。"
            +'这些数量不能相加当作完整 Agent 任务数；当前成员均为候选、未冻结、未运行。\n').encode('utf-8')
        outputs[f'manifests/benchmarks/{bm}/members.json'] = encode({'schemaVersion': 1, 'benchmarkId': bm,
            'status': 'candidate_not_frozen', 'members': rows, 'counts': count,
            'definitionPin': pin(f'agent-eval/benchmarks/{bm}/definition.json', public[f'agent-eval/benchmarks/{bm}/definition.json'])})
        outputs[f'manifests/benchmarks/{bm}/readiness.json'] = encode({'schemaVersion': 1, 'benchmarkId': bm,
            'material': 'design_defined', 'review': 'pending', 'frozen': False, 'executionEligibility': 'blocked',
            'blockers': ['content_review', 'split_and_exposure_review', 'execution_configuration',
                         'product_adapter', 'trusted_evidence_collector', 'grader_integration'] +
                        (['real_business_observation_population'] if bm == 'BM-10' else []),
            'actualProductRuns': 0, 'baselineCount': 0})
    outputs['manifests/benchmarks/index.json'] = encode({'schemaVersion':1, 'benchmarks': counts, 'retired': ['BM-06']})
    public['agent-eval/benchmarks/catalog.json'] = encode({'schemaVersion': 1, 'benchmarks': [
        {'id':bm, 'status':'candidate', 'definition':f'{bm}/definition.json'} for bm in ACTIVE_BMS],
        'retired': [{'id':'BM-06','reason':'ERP 写入已取消'}]})
    public['agent-eval/benchmarks/README.md']=('''# Benchmark 当前设计协议

当前处于方案设计阶段。11 项有效 Benchmark 引用同一套初始 Agent 任务和产品契约检查；BM-06 已退役，BM-10 真实业务成员为 0。

## 目录与状态

- `catalog.json`：当前有效定义入口及退役编号。
- `BM-xx/definition.json`：目标、输入输出、环境、执行、评分、比较及所需配置，结构版本从 1 开始。
- `BM-xx/README.md`：对应协议的中文解释及当前成员数量。
- `../data/manifests/benchmarks/`：成员、精确文件摘要、直接 checkIds、安全 guardCheckIds、对照和阻断原因；不复制 Case。
- `../runs/`：实际执行后才创建的证据与报告，不是固定数据。

完整 Agent 任务与确定性契约分别统计。F 为机制、A 为实际模型行为、B 为适用业务结果；离线装配不是 Trial，设施测试不是产品成绩。

## 使用

```powershell
python agent-eval/tools/initial_dataset.py verify --project .
python agent-eval/src/runner/initial_dataset.py BM-08 --project . --stage P2 --split development --subset capability
```

`capability` 与 `regression` 是测量目的；development/regression/acceptance 是数据用途。当前 regression 仅为契约保护候选，没有历史通过表现。

模型、预算、k、重置、并发、环境和门槛未固定时保留阻断。必须的合法对照不会被筛选静默删除。真实产品适配器与采证尚未接入，当前全部 NOT_RUN，Baseline 为 0。

各定义的 sourceRefs 固定两份主方案摘要；requirementRefs 与 checkIds 对应直接判据。修改资产后必须重建成员摘要，不覆盖旧身份而伪称可比。当前只保留有效定义，不积累旧数据副本。

## 当前成员数量

| Benchmark | 完整任务 | 产品契约场景 | 依赖对照 |
|---|---:|---:|---:|
'''+''.join(f"| {bm} | {n['agentTasks']} | {n['contractScenarios']} | {n['controls']} |\n" for bm,n in counts.items())).encode('utf-8')
    return public, counts


def build(project):
    """Build a replacement in memory. No old data is removed before validation."""
    from initial_tasks import build_tasks
    from invoice_requirements import load_requirements
    from rebuild_contracts import load_spec_contracts
    project = Path(project).resolve()
    quality = project / 'agent-eval/data'
    old_cases = [read(p) for p in sorted((quality/'cases').rglob('*.json'))]
    gold = [read(p) for p in sorted((quality/'gold').glob('*.json'))]
    business = [read(p) for p in sorted((quality/'business').glob('*.json'))]
    if (len(old_cases), len(gold), len(business)) != (548,100,80):
        raise ValueError('Initial migration requires inspected 548/100/80 inputs; current-only repeat uses verify')
    source_manifest = read(project/'data/invoices/voxel51/manifest.json')
    label_manifest = read(quality/'source-labels/voxel51/manifest.json')
    outputs = {}
    # Preserve current Gold values, extract current annotation evidence, remove embedded old answers.
    for asset in gold:
        old_ref = asset.get('annotationRef')
        if old_ref:
            packet = read(contained(quality, old_ref['path']))
            path = f'manifests/reviews/annotations/{asset["id"]}.json'
            raw = encode({'schemaVersion':1, 'kind':'preserved_image_annotation',
                          'annotation':packet['annotation'], 'originDigest':old_ref['sha256'],
                          'humanVerified':False, 'meaning':'保留当前图像标注依据；不包含旧 Gold 正文。'})
            outputs[path] = raw
            asset['annotationRef'] = pin(path, raw)
        previous = asset.pop('previousGoldRef', None)
        if previous or old_ref:
            asset['version'] += 1
        # Existing partition references point at previous answer snapshots: replace with current facts below.
        for key in ('partitionReviewRef', 'sourceRelationshipReviewRef'):
            asset.pop(key, None)
        outputs[f'gold/{asset["id"]}.json'] = encode(asset)
    for asset in business:
        outputs[f'business/{asset["id"]}.json'] = encode(asset)
    for old_review in (quality/'manifests/business-reviews').glob('*.json'):
        packet=read(old_review)
        matching=next((a for a in business if a['id']==packet.get('assetRef',{}).get('id')),None)
        if matching is not None and packet['assetRef'].get('assetSha256')==digest(matching):
            outputs[f'manifests/reviews/business/{old_review.name}']=old_review.read_bytes()
    for old_review in (quality/'manifests/partition-reviews').glob('*.json'):
        packet=read(old_review)
        if 'review' in packet:
            outputs[f'manifests/reviews/partitions/{old_review.name}']=encode({
                'schemaVersion':1,'kind':'preserved_source_relationship_evidence','review':packet['review'],
                'meaning':'保留原票关系依据，不保留旧 Gold 正文，不授予新内容人工核验。'})
    tasks = build_tasks(project, old_cases, gold, business)
    if not 1 <= len(tasks) <= 100:
        raise ValueError('Agent task budget exceeded or empty')
    suites, mapping = compact_contracts(old_cases, tasks)
    selftests, self_mapping = compact_selftests(old_cases)
    for task in tasks:
        outputs[f'cases/{task["id"]}.json'] = encode(task)
    for suite in suites:
        outputs[f'contracts/{suite["harnessModule"]}.json'] = encode(suite)
    # Current exact source pins, not stale inherited preparation hashes.
    sources = [pin(path, (project/path).read_bytes()) for path in SPECS]
    requirements = load_requirements(project)
    requirements['schemaVersion'] = 1
    metrics = load_spec_contracts(project)['metrics']
    requirements['metrics'] = metrics
    outputs['manifests/requirements.json'] = encode(requirements)
    selection = read(quality/'manifests/selection.json')
    baseline_paths=list((quality/'manifests/history').rglob('splits.json'))
    baseline=read(baseline_paths[0]) if len(baseline_paths)==1 else None
    if baseline is None:
        raise ValueError('Expected one preserved source-use baseline to extract')
    source_constraints=[{k:r[k] for k in ('sampleId','split','leakageGroup')}
                        for r in baseline['samples']]
    outputs['manifests/splits.json'] = encode({'schemaVersion':1, 'status':'candidate_not_frozen',
        'sourceUseConstraints':source_constraints,
        'sourceConstraintOriginDigest':hashlib.sha256(baseline_paths[0].read_bytes()).hexdigest(),
        'samples':[{k:row[k] for k in ('sampleId','originalSha256','groupId','split','priorUses','groupPriorUses','exposureStatus') if k in row}
                   for row in selection['samples']],
        'assets':[{'id':a['id'], 'split':a['split'], 'leakageGroup':a['leakageGroup']} for a in gold+business+tasks],
        'policy':'同原票与近重复组不跨用途；当前输入已进入制作过程，不声明未见 Holdout。',
        'reviewStatus':'pending_current_release_review', 'formalAcceptanceEligible':False})
    outputs['manifests/fixture-policy.json'] = encode({'schemaVersion':1, 'kind':'simulation_only',
        'policies':list({digest(a['policy']):a['policy'] for a in business}.values()),
        'enterprisePolicyVerified':False, 'businessWrites':'local_simulated_targets_only'})
    rows = [ref for _,ref in assets(outputs)]
    outputs['manifests/case-catalog.json'] = encode({'schemaVersion':1, 'cases':rows,
        'agentTaskCount':len(tasks),'contractScenarioCount':sum(len(s['scenarios']) for s in suites)})
    module_old = read(quality/'manifests/module-catalog.json')['modules']
    modules = []
    direct = defaultdict(list)
    for asset,ref in assets(outputs):
        for check in asset['oracle']['checks']:
            for rid in check['requirementRefs']:
                direct[rid].append({'assetId':asset['id'],'checkId':check['checkId'],'kind':ref['kind']})
    for previous in module_old:
        module = previous['id']
        matching = [(asset,ref) for asset,ref in assets(outputs) if any(module in c['harnessModules'] for c in asset['oracle']['checks'])]
        modules.append({'id':module,'name':previous['name'],'responsibility':previous['responsibility'],
            'agentTaskIds':[a['id'] for a,r in matching if r['kind']=='agent_task'],
            'contractScenarioIds':[a['id'] for a,r in matching if r['kind']=='product_contract'],
            'selftestCount':len(selftests['scenarios']) if module=='eval-infrastructure' else 0,
            'directCheckCount':sum(sum(module in c['harnessModules'] for c in a['oracle']['checks']) for a,r in matching),
            'actualProductRuns':0, 'coverageMeaning':'直接检查项的设计覆盖，不代表模块完成。'})
    outputs['manifests/module-catalog.json'] = encode({'schemaVersion':1,'modules':modules,'countIsCoverageProof':False})
    all_requirements = {r['id'] for r in requirements['requirements']} | set(metrics)
    outputs['manifests/coverage.json'] = encode({'schemaVersion':1,'directChecks':dict(sorted(direct.items())),
        'requirementsWithoutDirectCheck':sorted(all_requirements-set(direct)),
        'unresolvedReferences':sorted(set(direct)-all_requirements),
        'interpretation':'直接引用只证明定义了该条件的检查；不得据此宣称整项要求或产品通过。',
        'actualProductRuns':0, 'formalAcceptanceEligible':False})
    migration = []
    for old in old_cases:
        destination = mapping.get(old['id']) or self_mapping.get(old['id'])
        migration.append({'oldId':old['id'], 'oldVersion':old['version'], 'oldDigest':digest(old),
                          'newId':destination, 'disposition':'represented' if destination else 'retired_from_initial_budget',
                          'reason':'任务重组或独立契约/设施归属' if destination else '初始任务精简；必要要求通过覆盖清单保留缺口，不保留旧正文。'})
    outputs['manifests/migration.json'] = encode({'schemaVersion':1,'oldDefinitionCount':len(old_cases),'records':migration})
    public, benchmark_counts = build_benchmarks(project, outputs, sources)
    public['agent-eval/tests/fixtures/evaluation-selftests.json'] = encode(selftests)
    views = {'schemaVersion':1,'capabilities':{},'conditions':{},'taskTypes':{},'benchmarks':{},'golden':[],'failures':[]}
    for facet,key in [('capabilities','capabilities'),('conditions','conditions')]:
        for task in tasks:
            for value in task['classification'][key]: views[facet].setdefault(value,[]).append(task['id'])
    for task in tasks:
        views['taskTypes'].setdefault(task['classification']['business']['primaryTaskType'],[]).append(task['id'])
    for bm in ACTIVE_BMS:
        views['benchmarks'][bm] = [m['assetId'] for m in json.loads(outputs[f'manifests/benchmarks/{bm}/members.json'])['members'] if not m['dependencyOnly']]
    outputs['manifests/views.json'] = encode(views)
    report = {'schemaVersion':1,'format':FORMAT,'phase':'design','specRefs':sources,
        'originals':2902,'publisherLabels':1414,'gold':len(gold),'humanVerifiedGold':sum(a.get('humanVerified',False) for a in gold),
        'business':len(business),'agentTasks':len(tasks),'taskBudgetMaximum':100,
        'taskTypeCounts':dict(Counter(t['classification']['business']['primaryTaskType'] for t in tasks)),
        'contractSuites':len(suites),'contractScenarios':sum(len(s['scenarios']) for s in suites),
        'selftestSuites':1,'selftestScenarios':len(selftests['scenarios']),'benchmarks':benchmark_counts,
        'actualProductRuns':0,'baselineCount':0,'formalAcceptanceEligible':False,
        'materialStatus':'design_materials_prepared','reviewStatus':'pending','latestOnly':True,
        'limitations':['未执行真实产品；适配器与可信采证等待实现。','Gold 保留当前真实核验状态。',
                      '初始代表任务不宣称所有主方案条件已覆盖；参见 coverage.json。'],
        'sourcePins':[pin('data/invoices/voxel51/manifest.json',(project/'data/invoices/voxel51/manifest.json').read_bytes()),
                      pin('agent-eval/data/source-labels/voxel51/manifest.json',(quality/'source-labels/voxel51/manifest.json').read_bytes())]}
    report['independentOriginalsInTasks']=len({t['setup']['initialState']['sampleId'] for t in tasks
                                             if t['setup']['protocol']=='invoice_extraction'})
    report['semanticTaskCount']=len({digest({'task':t['task'],'setup':t['setup'],'interactions':t['interactions']}) for t in tasks})
    outputs['manifests/preparation-report.json'] = encode(report)
    from initial_documentation import render_data_readme
    outputs['README.md'] = render_data_readme(report, tasks[0]).encode('utf-8')
    outputs['manifests/inventory.json'] = encode({'schemaVersion':1,'files':[pin(p,r) for p,r in sorted(outputs.items())],
        'publicFiles':[pin(p,r) for p,r in sorted(public.items())],
        'excluded':['source-labels (immutable source manifest)', 'manifests/inventory.json', 'manifests/active-dataset.json']})
    outputs['manifests/active-dataset.json'] = encode({'schemaVersion':1,'format':FORMAT,'status':'design_materials_prepared',
        'inventorySha256':hashlib.sha256(outputs['manifests/inventory.json']).hexdigest(),
        'counts':{k:report[k] for k in ('gold','business','agentTasks','contractSuites','contractScenarios','selftestScenarios')},
        'humanVerifiedGold':report['humanVerifiedGold'],'actualProductRuns':0,'baselineCount':0,
        'formalAcceptanceEligible':False,'latestOnly':True})
    return outputs, public


def validate_snapshot(project, outputs, public=None, check_sources=True, check_review=True):
    from initial_contract import validate_asset
    for path,raw in outputs.items():
        contained(Path(project)/'agent-eval/data',path)
        if path.startswith(('cases/','contracts/')):
            validate_asset(json.loads(raw))
    registry = {r['id']:(a,r) for a,r in assets(outputs)}
    task_count = sum(r['kind']=='agent_task' for a,r in registry.values())
    if not 0 < task_count <= 100:
        raise ValueError('Invalid task count')
    refs = [r['id'] for a,r in assets(outputs)]
    if len(refs) != len(set(refs)):
        raise ValueError('Duplicate asset identity')
    groups = defaultdict(set)
    for aid,(a,r) in registry.items():
        groups[a['leakageGroup']].add(a['split'])
        for cid in a.get('controlRefs',[]) + a.get('comparisonRefs',[]):
            if cid not in registry:
                raise ValueError(f'Dangling control: {aid} -> {cid}')
            control = registry[cid][0]
            if control['split'] != a['split']:
                raise ValueError(f'Cross-split control: {aid} -> {cid}')
            if int(control['applicability']['minimumStage'][1:]) > int(a['applicability']['minimumStage'][1:]):
                raise ValueError(f'Later-stage control: {aid} -> {cid}')
        gold_ref=a['oracle'].get('goldRef')
        if gold_ref:
            if gold_ref['path'] not in outputs:
                raise ValueError('Missing Gold dependency')
            gold=json.loads(outputs[gold_ref['path']])
            if (gold_ref['id']!=gold['id'] or gold_ref['version']!=gold['version'] or gold['split']!=a['split']
                    or gold['leakageGroup']!=a['leakageGroup']):
                raise ValueError('Gold identity/version/split mismatch')
        for ref in a.get('task',{}).get('assetRefs',[]):
            if check_sources:
                raw=contained(project,ref['path']).read_bytes()
                if ref.get('sha256') and ref['sha256']!=hashlib.sha256(raw).hexdigest():
                    raise ValueError('Task source digest mismatch')
        business_ref=a['setup'].get('businessRef')
        if business_ref:
            from rebuild_business_projection import project_business
            business=json.loads(outputs[business_ref['path']])
            project_business(business_ref,business,a['setup']['businessPatches'])
            if business['split']!=a['split'] or business['leakageGroup']!=a['leakageGroup']:
                raise ValueError('Business split/group mismatch')
    if any(len(v)>1 for v in groups.values()):
        raise ValueError('Leakage group crosses splits')
    partitions=json.loads(outputs['manifests/splits.json'])
    sample_rows={r['sampleId']:r for r in partitions['samples']}
    constraints={r['sampleId']:r for r in partitions['sourceUseConstraints']}
    if len(constraints)!=2902:
        raise ValueError('Source-use constraints must cover the unchanged source pool')
    gold_groups=defaultdict(set)
    for path,raw in outputs.items():
        if path.startswith('gold/'):
            gold=json.loads(raw); sample=sample_rows[gold['sampleId']]
            if (gold['split'],gold['leakageGroup'])!=(sample['split'],sample['groupId']):
                raise ValueError('Current Gold source partition differs')
            prior=constraints[gold['sampleId']]['split']
            # Development material may become a regression guard; neither is unseen holdout.
            if prior in ('development','regression') and gold['split']=='acceptance':
                raise ValueError('Previously exposed source promoted to holdout')
            gold_groups[gold['leakageGroup']].add(gold['split'])
    if any(len(s)>1 for s in gold_groups.values()):
        raise ValueError('Gold group crosses data uses')
    requirements=json.loads(outputs['manifests/requirements.json'])
    known={r['id'] for r in requirements['requirements']}|set(requirements['metrics'])
    for a,r in registry.values():
        for check in a['oracle']['checks']:
            if not set(check['requirementRefs']) <= known:
                raise ValueError('Unknown requirement reference')
    catalog = json.loads(outputs['manifests/case-catalog.json'])
    if catalog['cases'] != [ref for _,ref in assets(outputs)]:
        raise ValueError('Catalog does not match current files')
    coverage = json.loads(outputs['manifests/coverage.json'])
    if coverage.get('schemaVersion') == 2:
        if public is None:
            raise ValueError('Reviewed coverage requires facility fixture pins')
        from coverage_update import validate_reviewed_snapshot
        if check_review:
            validate_reviewed_snapshot(outputs, public)
    elif coverage.get('schemaVersion') != 1:
        raise ValueError('Unsupported coverage schema')
    for folder,expected in [('gold/',100),('business/',80)]:
        if sum(p.startswith(folder) and p.endswith('.json') for p in outputs)!=expected:
            raise ValueError('Base asset count changed')
    source_refs = json.loads(outputs['manifests/preparation-report.json'])['specRefs']
    if check_sources:
        for expected in source_refs:
            if pin(expected['path'],contained(project,expected['path']).read_bytes())!=expected:
                raise ValueError('Specification digest drift')
    for bm in ACTIVE_BMS:
        members = json.loads(outputs[f'manifests/benchmarks/{bm}/members.json'])['members']
        ids = [m['assetId'] for m in members]
        if len(ids)!=len(set(ids)) or (bm=='BM-10' and ids):
            raise ValueError('Invalid Benchmark members')
        for member in members:
            a,r = registry[member['assetId']]
            if (member['sha256']!=r['sha256'] or member['path']!=r['path']
                    or member['version']!=r['version'] or member['assetKind']!=r['kind']
                    or member.get('scenarioId')!=r.get('scenarioId')):
                raise ValueError('Benchmark pin drift')
            if member['stage']!=a['applicability']['minimumStage'] or member['split']!=a['split']:
                raise ValueError('Benchmark stage or split drift')
            if set(member['controlRefs'])!=set(a.get('controlRefs',[])+a.get('comparisonRefs',[])):
                raise ValueError('Benchmark hides required controls')
            checks={c['checkId'] for c in a['oracle']['checks']}
            if not set(member['checkIds']+member['guardCheckIds'])<=checks:
                raise ValueError('Dangling check reference')
            if not set(member['controlRefs'])<=set(ids):
                raise ValueError('Unclosed Benchmark controls')
        definition_pin=json.loads(outputs[f'manifests/benchmarks/{bm}/members.json'])['definitionPin']
        if public is not None and definition_pin!=pin(definition_pin['path'],public[definition_pin['path']]):
            raise ValueError('Benchmark definition pin drift')
    inventory = json.loads(outputs['manifests/inventory.json'])
    actual = [pin(p,r) for p,r in sorted(outputs.items()) if p not in ('manifests/inventory.json','manifests/active-dataset.json')]
    if inventory['files']!=actual:
        raise ValueError('Inventory digest drift')
    marker=json.loads(outputs['manifests/active-dataset.json'])
    if marker['inventorySha256'] != hashlib.sha256(outputs['manifests/inventory.json']).hexdigest():
        raise ValueError('Active inventory drift')
    if public is not None:
        for expected in inventory['publicFiles']:
            if pin(expected['path'],public[expected['path']])!=expected:
                raise ValueError('Public definition drift')
        if 'agent-eval/tests/fixtures/evaluation-selftests.json' in public:
            validate_asset(json.loads(public['agent-eval/tests/fixtures/evaluation-selftests.json']))
    return {'valid':True,'agentTasks':task_count,'contractScenarios':len(registry)-task_count,
            'actualProductRuns':0,'baselineCount':0,'formalAcceptanceEligible':False}


def verify_sources(project):
    project=Path(project).resolve(); quality=project/'agent-eval/data'
    # Verify every immutable input and label file against its existing authoritative manifest.
    from verify_invoice_data import check_descriptor
    source=read(project/'data/invoices/voxel51/manifest.json')
    checked=0
    for row in source['samples']:
        metadata_path=check_descriptor(project/'data/invoices/voxel51',row['metadata']); checked+=1
        metadata=read(metadata_path)
        for descriptor in metadata['files']:
            check_descriptor(metadata_path.parent,descriptor); checked+=1
    labels=read(quality/'source-labels/voxel51/manifest.json')
    for row in labels['samples']:
        for descriptor in row['files']:
            check_descriptor(quality,descriptor)
    if len(source['samples'])!=2902 or len(labels['samples'])!=1414:
        raise ValueError('Immutable source count mismatch')
    return {'originals':2902,'publisherLabels':1414,'verifiedSourceFiles':checked}


def record_cleanup(project, remaining):
    """Record factual cleanup limits; never infer authorization or remove paths."""
    from initial_documentation import render_data_readme
    project=Path(project).resolve(); quality=project/'agent-eval/data'
    if not is_current(project):
        raise ValueError('Current initial release required')
    outputs={p.relative_to(quality).as_posix():p.read_bytes() for p in quality.rglob('*')
             if p.is_file() and not p.is_relative_to(quality/'source-labels')}
    report=json.loads(outputs['manifests/preparation-report.json'])
    report['latestOnlyScope']='agent-eval/data'
    report['cleanup']={'activeSupersededFilesRemoved':780,'projectCleanupComplete':not remaining,
                       'status':'blocked_by_execution_policy' if remaining else 'complete',
                       'remainingPaths':remaining}
    outputs['manifests/preparation-report.json']=encode(report)
    example=next(a for a,r in assets(outputs) if r['kind']=='agent_task')
    outputs['README.md']=render_data_readme(report,example).encode('utf-8')
    inventory=json.loads(outputs['manifests/inventory.json'])
    inventory['files']=[pin(p,r) for p,r in sorted(outputs.items()) if p not in ('manifests/inventory.json','manifests/active-dataset.json')]
    outputs['manifests/inventory.json']=encode(inventory)
    marker=json.loads(outputs['manifests/active-dataset.json'])
    marker['inventorySha256']=hashlib.sha256(outputs['manifests/inventory.json']).hexdigest()
    marker['latestOnlyScope']='agent-eval/data'; marker['projectCleanupComplete']=not remaining
    outputs['manifests/active-dataset.json']=encode(marker)
    public={row['path']:contained(project,row['path']).read_bytes() for row in inventory['publicFiles']}
    validate_snapshot(project,outputs,public)
    for relative in ('README.md','manifests/preparation-report.json','manifests/inventory.json','manifests/active-dataset.json'):
        contained(quality,relative).write_bytes(outputs[relative])
    return report['cleanup']


def verify(project):
    project=Path(project).resolve(); quality=project/'agent-eval/data'
    outputs={p.relative_to(quality).as_posix():p.read_bytes() for p in quality.rglob('*')
             if p.is_file() and not p.is_relative_to(quality/'source-labels')}
    inventory=json.loads(outputs['manifests/inventory.json'])
    public={x['path']:contained(project,x['path']).read_bytes() for x in inventory['publicFiles']}
    result=validate_snapshot(project,outputs,public)
    report=json.loads(outputs['manifests/preparation-report.json'])
    for expected in report['sourcePins']:
        if pin(expected['path'],contained(project,expected['path']).read_bytes())!=expected:
            raise ValueError('Source manifest changed')
    return dict(result,**verify_sources(project))


def remove_transaction_tree(project, path):
    """Only delete a resolved child of this publisher's private transaction root."""
    parent=Path(project).resolve()/'agent-eval/.initial-publication'
    resolved=Path(path).resolve()
    if not resolved.is_relative_to(parent) or resolved==Path(project).resolve():
        raise ValueError('Unsafe transaction cleanup target')
    if resolved.exists():
        for child in resolved.rglob('*'):
            if child.is_symlink() or getattr(child,'is_junction',lambda:False)():
                raise ValueError('Linked transaction content cannot be removed')
        shutil.rmtree(resolved)


def recover_publication(project):
    transaction=Path(project).resolve()/'agent-eval/.initial-publication'
    journal=transaction/'journal.json'
    if not journal.exists():
        if transaction.exists():
            remove_transaction_tree(project,transaction)
        return
    state=read(journal); quality=Path(project).resolve()/'agent-eval/data'
    if state['state']!='committed':
        if (transaction/'previous').exists():
            if quality.exists():
                os.replace(quality,transaction/'incomplete')
            os.replace(transaction/'previous',quality)
        for relative,existed in state['publicPrevious'].items():
            target=contained(project,relative)
            if existed:
                target.write_bytes(contained(transaction/'previous-public',relative).read_bytes())
            elif target.exists():
                target.unlink()
    remove_transaction_tree(project,transaction)


def prepare(project):
    project=Path(project).resolve()
    recover_publication(project)
    if is_current(project):
        return dict(verify(project),changed=False)
    outputs,public=build(project)
    return install_snapshot(project, outputs, public)


def install_snapshot(project, outputs, public):
    """Install a validated current-only candidate with recoverable publication."""
    project=Path(project).resolve()
    validate_snapshot(project,outputs,public)
    verify_sources(project)
    quality=project/'agent-eval/data'
    stale=[p.relative_to(quality).as_posix() for p in quality.rglob('*') if p.is_file()
           and not p.is_relative_to(quality/'source-labels') and p.relative_to(quality).as_posix() not in outputs]
    transaction=contained(project,'agent-eval/.initial-publication')
    candidate=transaction/'candidate'; candidate.mkdir(parents=True)
    marker='manifests/active-dataset.json'
    for path,raw in outputs.items():
        if path==marker: continue
        target=contained(candidate,path); target.parent.mkdir(parents=True,exist_ok=True); target.write_bytes(raw)
    # Provider labels are copied byte-for-byte only for the transient atomic replacement.
    for original in (quality/'source-labels').rglob('*'):
        if original.is_file():
            relative=original.relative_to(quality).as_posix()
            target=contained(candidate,relative); target.parent.mkdir(parents=True,exist_ok=True)
            target.write_bytes(contained(quality,relative).read_bytes())
    prior={}
    for path in public:
        target=contained(project,path); prior[path]=target.exists()
        if prior[path]:
            backup=contained(transaction/'previous-public',path); backup.parent.mkdir(parents=True,exist_ok=True)
            backup.write_bytes(target.read_bytes())
    journal={'state':'prepared','publicPrevious':prior}
    (transaction/'journal.json').write_bytes(encode(journal))
    try:
        os.replace(quality,transaction/'previous')
        os.replace(candidate,quality)
        for path,raw in public.items():
            target=contained(project,path); target.parent.mkdir(parents=True,exist_ok=True); target.write_bytes(raw)
        # Marker is the last published file, never an advance claim of a complete release.
        (quality/marker).parent.mkdir(parents=True,exist_ok=True)
        (quality/marker).write_bytes(outputs[marker])
        result=verify(project)
        journal['state']='committed'; (transaction/'journal.json').write_bytes(encode(journal))
    except BaseException:
        recover_publication(project)
        raise
    remove_transaction_tree(project,transaction)
    return dict(result,changed=True,removedFiles=len(stale))


def main(argv=None):
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command',choices=['prepare','verify','report'])
    parser.add_argument('--project',type=Path,default=ROOT)
    args=parser.parse_args(argv)
    result=prepare(args.project) if args.command=='prepare' else verify(args.project) if args.command=='verify' else read(args.project/'agent-eval/data/manifests/preparation-report.json')
    print(json.dumps(result,ensure_ascii=False,indent=2))


if __name__=='__main__':
    main()
