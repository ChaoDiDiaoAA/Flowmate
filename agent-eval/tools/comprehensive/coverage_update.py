"""Review current assets, preview differences, and publish an idempotent revision."""
from collections import Counter
from copy import deepcopy
from pathlib import Path
import argparse
import hashlib
import json
import re

from initial_dataset import (ROOT, ACTIVE_BMS, FORMAT, assets, build_benchmarks, contained,
    encode, read, pin, digest, validate_snapshot, install_snapshot, recover_publication)
from coverage_registry import additions
from coverage_review import coverage_document, checks


def load_current(project, *, for_update=False):
    quality=Path(project)/'agent-eval/data'
    outputs={p.relative_to(quality).as_posix():p.read_bytes() for p in quality.rglob('*')
             if p.is_file() and not p.is_relative_to(quality/'source-labels')}
    inventory=json.loads(outputs['manifests/inventory.json'])
    public={r['path']:contained(project,r['path']).read_bytes() for r in inventory['publicFiles']}
    if for_update:
        # Authoring declarations may have changed since publication. First verify
        # the complete old byte set, then validate its pinned setup independently
        # of the edited registry. Never accept an unpinned manually edited file.
        actual=[pin(p,r) for p,r in sorted(outputs.items()) if p not in
                ('manifests/inventory.json','manifests/active-dataset.json')]
        marker=json.loads(outputs['manifests/active-dataset.json'])
        if inventory['files']!=actual or marker['inventorySha256']!=hashlib.sha256(outputs['manifests/inventory.json']).hexdigest():
            raise ValueError('Current publication digest drift')
        from initial_contract import pinned_baseline_setups
        with pinned_baseline_setups({a['id']:a['setup'] for a,_ in assets(outputs)}):
            validate_snapshot(project,outputs,public,check_review=False)
    else:
        validate_snapshot(project,outputs,public)
    return outputs,public


def asset_index(outputs, public):
    index={a['id']:a for a,_ in assets(outputs)}
    suite=json.loads(public['agent-eval/tests/fixtures/evaluation-selftests.json'])
    for s in suite['scenarios']:
        index[s['id']]=dict(s,kind='eval_selftest',oracle=s['expected'])
    return index


def revised(old, candidate):
    if old is None: return candidate
    before=deepcopy(old);after=deepcopy(candidate)
    before.pop('version',None);after.pop('version',None)
    if before==after: return old
    candidate['version']=old['version']+1
    return candidate


def build_current(project):
    before,previous_public=load_current(project,for_update=True)
    outputs=dict(before)
    for addition in additions():
        if addition['kind']=='agent_task':
            path=f"cases/{addition['id']}.json"
            old=json.loads(outputs[path]) if path in outputs else None
            outputs[path]=encode(revised(old,deepcopy(addition)))
        elif addition['kind']=='product_contract':
            path=f"contracts/{addition['harnessModule']}.json"
            old=json.loads(outputs[path]) if path in outputs else None
            suite=deepcopy(old) if old else deepcopy(addition)
            by={s['id']:s for s in suite['scenarios']}
            for s in addition['scenarios']: by[s['id']]=deepcopy(s)
            suite['scenarios']=list(by.values())
            outputs[path]=encode(revised(old,suite))
        else:
            raise ValueError('Unexpected reviewed asset kind')
    index=asset_index(outputs,previous_public)
    requirements=json.loads(outputs['manifests/requirements.json'])
    old_coverage=json.loads(outputs['manifests/coverage.json'])
    coverage=coverage_document(requirements,index,old_coverage)
    outputs['manifests/coverage.json']=encode(coverage)
    task_assets=[a for a,_ in assets(outputs) if a.get('kind')=='agent_task']
    suites=[json.loads(raw) for p,raw in outputs.items() if p.startswith('contracts/')]
    rows=[r for _,r in assets(outputs)]
    outputs['manifests/case-catalog.json']=encode({'schemaVersion':1,'cases':rows,
        'agentTaskCount':len(task_assets),'contractScenarioCount':sum(len(s['scenarios']) for s in suites)})
    old_modules=json.loads(outputs['manifests/module-catalog.json'])
    for module in old_modules['modules']:
        mid=module['id']
        mapped=[(a,r) for a,r in assets(outputs) if any(mid in c['harnessModules'] for c in checks(a))]
        module['agentTaskIds']=[a['id'] for a,r in mapped if r['kind']=='agent_task']
        module['contractScenarioIds']=[a['id'] for a,r in mapped if r['kind']=='product_contract']
        module['directCheckCount']=sum(sum(mid in c['harnessModules'] for c in checks(a)) for a,r in mapped)
        module['coverageMeaning']='直接检查关联数，不等于完整要求覆盖；条件结论见coverage.json。'
    outputs['manifests/module-catalog.json']=encode(old_modules)
    partitions=json.loads(outputs['manifests/splits.json'])
    pa={a['id']:a for a in partitions['assets']}
    for a in task_assets: pa[a['id']]={k:a[k] for k in ('id','split','leakageGroup')}
    partitions['assets']=list(pa.values()); outputs['manifests/splits.json']=encode(partitions)
    report=json.loads(outputs['manifests/preparation-report.json'])
    public,bm_counts=build_benchmarks(Path(project),outputs,report['specRefs'])
    for path,raw in previous_public.items():
        if path not in public: public[path]=raw
    # Definition body changes must not reuse an existing content identity.
    for bm in ACTIVE_BMS:
        path=f'agent-eval/benchmarks/{bm}/definition.json'
        old=json.loads(previous_public[path]);new=json.loads(public[path])
        public[path]=encode(revised(old,new))
        mp=f'manifests/benchmarks/{bm}/members.json'; members=json.loads(outputs[mp])
        members['definitionPin']=pin(path,public[path]);outputs[mp]=encode(members)
    views=json.loads(outputs['manifests/views.json'])
    for key in ('capabilities','conditions','taskTypes','benchmarks'):views[key]={}
    for a in task_assets:
        for key in ('capabilities','conditions'):
            for value in a['classification'][key]:views[key].setdefault(value,[]).append(a['id'])
        views['taskTypes'].setdefault(a['classification']['business']['primaryTaskType'],[]).append(a['id'])
    for bm in ACTIVE_BMS:
        views['benchmarks'][bm]=[m['assetId'] for m in json.loads(outputs[f'manifests/benchmarks/{bm}/members.json'])['members'] if not m['dependencyOnly']]
    outputs['manifests/views.json']=encode(views)
    product_assets={a['id']:a for a,_ in assets(outputs)}
    original_ids=report.get('coverageReview',{}).get('baselineAssetIds')
    if original_ids is None:original_ids=sorted(a['id'] for a,_ in assets(before))
    report.update(agentTasks=len(task_assets),contractSuites=len(suites),
        contractScenarios=sum(len(s['scenarios']) for s in suites),benchmarks=bm_counts,
        taskTypeCounts=dict(Counter(a['classification']['business']['primaryTaskType'] for a in task_assets)),
        semanticTaskCount=len({digest({'task':a['task'],'setup':a['setup'],'interactions':a['interactions']}) for a in task_assets}))
    report['coverageReview']={'requirements':len(coverage['requirements']),'statistics':coverage['statistics'],
        'reviewStatus':'ai_reviewed_pending_human','baselineAssetIds':original_ids,
        'original340Disposition':dict(Counter(coverage['original340Disposition'].values())),
        'original111Reassessment':dict(Counter(coverage['original111Reassessment'].values())),
        'newAgentTasks':sum(aid not in original_ids for aid,a in product_assets.items() if a.get('kind')=='agent_task'),
        'newContractScenarios':sum(aid not in original_ids for aid,a in product_assets.items() if a.get('kind')!='agent_task'),
        'aggregateFacilityTests':9,'aggregateFacilityTestRef':'agent-eval/tests/test_coverage_metrics.py',
        'measurementProtocols':len(requirements['metrics']),
        'remainingDesignConditions':sum(c['status']!='covered' for r in coverage['requirements'] if r['unitType']=='atomic' for c in r['conditions']),
        'remainingDesignConditionScope':'仅原子条件；父级复合要求的未完设计另查family条件，不能将此数解释为全部产品缺口。',
        'unresolvedFamilyIds':[r['requirementId'] for r in coverage['requirements'] if r['unitType']=='family' and r['designStatus']!='covered'],
        'interpretation':'缺口未归零；父级、原子条件与指标分开统计。新增数据只完成设计，不形成执行或人工核验。'}
    outputs['manifests/preparation-report.json']=encode(report)
    from initial_documentation import render_data_readme
    body=render_data_readme(report,task_assets[0])
    body=body.replace('`invoice_extraction` / `declared_episode`','`invoice_extraction` / `declared_episode` / `coverage_episode`')
    body+='\n\n## 覆盖复核与当前修订\n\n覆盖清单采用 schemaVersion: 2；任务与契约结构仍为 1。父级功能、原子条件和测量指标分别统计。\n\n'
    body+='| 字段 | 含义 |\n|---|---|\n'
    for key,meaning in [('requirements','全部登记项的逐条件核对'),('unitType','family/atomic/metric，禁止混合分母'),('conditions','条件、checkRefs、理由与covered/partial/missing设计状态'),('childRequirementRefs/childStatuses','父级汇总依赖，不能因有子项就算完整'),('source','原文章节或指标行；固定规范摘要仍见requirements.json'),('executionReadiness','当前缺失执行依赖'),('actualVerification','真实执行状态，当前NOT_RUN'),('measurementProtocol','指标单位、分母、证据与聚合实现边界'),('original340Disposition/original111Reassessment','原未关联项及已有引用项的复核去向')]:
        body+=f'| `{key}` | {meaning} |\n'
    body+='\n```powershell\npython agent-eval/tools/comprehensive/coverage_update.py check --project .\npython agent-eval/tools/comprehensive/coverage_update.py publish --project .\npython agent-eval/tools/comprehensive/coverage_update.py verify --project .\n```\n\ncheck 只读预览；publish 从当前资产与受控声明更新当前清单，不读取旧暂存数据；相同输入重复发布无变化。未审核内容不继承人工确认。原28个数据夹具自检与新增9个聚合代码自检分别计数，均不构成产品成绩。\n'
    outputs['README.md']=body.encode('utf-8')
    repin(outputs,public,report)
    validate_snapshot(project,outputs,public)
    differences=[p for p,raw in outputs.items() if before.get(p)!=raw]
    public_differences=[p for p,raw in public.items() if previous_public.get(p)!=raw]
    preview={'changed':bool(differences or public_differences),'changedDataFiles':differences,
        'changedPublicFiles':public_differences,'counts':json.loads(outputs['manifests/active-dataset.json'])['counts'],
        'coverageReview':report['coverageReview'],'actualProductRuns':0,'baselineCount':0}
    return outputs,public,preview


def repin(outputs,public,report):
    excluded={'manifests/inventory.json','manifests/active-dataset.json'}
    outputs['manifests/inventory.json']=encode({'schemaVersion':1,
        'files':[pin(p,r) for p,r in sorted(outputs.items()) if p not in excluded],
        'publicFiles':[pin(p,r) for p,r in sorted(public.items())],
        'excluded':['source-labels (immutable source manifest)',*sorted(excluded)]})
    marker=json.loads(outputs['manifests/active-dataset.json'])
    marker.update(inventorySha256=hashlib.sha256(outputs['manifests/inventory.json']).hexdigest(),
        counts={k:report[k] for k in ('gold','business','agentTasks','contractSuites','contractScenarios','selftestScenarios')})
    outputs['manifests/active-dataset.json']=encode(marker)


def validate_reviewed_snapshot(outputs,public):
    coverage=json.loads(outputs['manifests/coverage.json'])
    if coverage['schemaVersion']!=2:raise ValueError('Unsupported condition coverage schema')
    requirements=json.loads(outputs['manifests/requirements.json'])
    expected=coverage_document(requirements,asset_index(outputs,public),coverage)
    if expected!=coverage:raise ValueError('Reviewed coverage differs from registered conditions')


def main(argv=None):
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command',choices=['check','publish','verify'])
    parser.add_argument('--project',type=Path,default=ROOT)
    args=parser.parse_args(argv);project=args.project.resolve()
    if args.command=='verify':
        outputs,public=load_current(project);validate_reviewed_snapshot(outputs,public)
        result={'valid':True,'counts':json.loads(outputs['manifests/active-dataset.json'])['counts'],'actualProductRuns':0}
    else:
        if args.command=='publish':recover_publication(project)
        outputs,public,result=build_current(project)
        if args.command=='publish' and result['changed']:
            install_snapshot(project,outputs,public)
    print(json.dumps(result,ensure_ascii=False,indent=2))


if __name__=='__main__':main()
