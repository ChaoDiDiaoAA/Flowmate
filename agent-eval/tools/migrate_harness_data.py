"""History-preserving Harness migration. Stage first; publish only checked bytes.

This prepares cases and offline adapter plans, never product observations.
"""
from __future__ import annotations
import argparse
from collections import Counter
from copy import deepcopy
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import shutil
import sys
import zipfile

from prepare_invoice_data import read_json, digest, file_info, safe_relative
from review_invoice_data import _replace_json as save
from finalize_invoice_data import checked_snapshot
from harness_modules import MODULES, enrich_case, module_catalog
from harness_paths import canonical_case_path

MIGRATION = 'harness-functional-modules'


def _atomic_id(family, path):
    return 'HC-'+family.replace('/', '-')+'-'+hashlib.sha256(path.encode()).hexdigest()[:12]


def _refs(case, requirements):
    known = {r['id'] for r in requirements['requirements']}
    aliases = {a['oldId']:a.get('requirementId') for a in requirements.get('requirementAliases',[])}
    return sorted({aliases.get(r,r) for r in case.get('requirementRefs',[]) if aliases.get(r,r) in known})


def describe_legacy(cases, manual):
    """Explain each actual input/expected predicate using the existing dictionary."""
    before, observations=manual.split('## 附录 B：',1)
    conditions=before.split('## 附录 A：',1)[1]
    def dictionary(text,column):
        result={}
        for line in text.splitlines():
            if not line.startswith('| `'):continue
            cells=[c.strip() for c in line.strip('|').split('|')]
            if len(cells)>column:result[cells[0].strip('`')]=cells[column]
        return result
    condition_names=dictionary(conditions,2);observation_names=dictionary(observations,1)
    for case in cases:
        setup=case['initialEnvironment']['scenarioSetup'].get('conditions',{})
        if case['category']=='extraction':inputs='读取原票 '+case['sampleId']+' 的获准解析与图片；Gold 仅供评分器读取。'
        else:
            inputs=[condition_names.get(k,k)+'：'+json.dumps(v,ensure_ascii=False) for k,v in setup.items()]
            if case['inputMode']=='simulated_structured_invoice':inputs.insert(0,'使用共享业务资料 business/'+case['sampleId']+'.json 的获准输入。')
        case['caseSummary']={'input':inputs,'trigger':'在上述初态执行：'+case['trigger'],
            'expected':[observation_names.get(a['path'],a['path'])+'；要求 '+a['op']+' '+json.dumps(a['value'],ensure_ascii=False)
                        for a in case['oracle']['assertions']]}


def revise_legacy(case, descriptor, requirements):
    value = enrich_case(case)
    value.update(version=case.get('version',1)+1, humanVerified=False, reviewStatus='pending',
                 materialStatus='structure_checked', eligibleForAcceptance=False,
                 formalAcceptanceEligible=False, executionStatus='not_run')
    for key in ('reviewRecord','reviewSubmission','parentAsset','reviewedBy','reviewedAt','contentAcceptance'):
        value.pop(key,None)
    value['oracle']['version'] = case['oracle'].get('version',1)+1
    value['oracle']['status'] = 'review_pending'
    value['sourceSpecHashes'] = requirements['sourceHashes']
    value['requirementRefs'] = _refs(value,requirements)
    value['revisionProvenance'] = {'kind':'harness_contract_revision','priorVersion':case.get('version',1),
        'priorSha256':descriptor['sha256'],'priorPath':descriptor['path'],
        'priorContent':'manifests/harness-migration.json#/history','reviewInheritance':False,
        'actualProductRun':False}
    # The old protected sessions directory is no longer the history authority.
    if value['familyId']=='platform/temporary-cleanup-boundary':
        value['initialEnvironment']['scenarioSetup']['conditions']['protectedRoots']=['database','runs','inputs','manifests']
    return value


def scenario_case(spec, requirements):
    identity='harness-'+spec['id']
    category=spec['category']
    stage=spec['phase']
    family=category+'/harness-'+spec['id']
    refs=spec.get('refs',[])
    mode=spec.get('mode','F')
    conditions={'harnessScenarioId':spec['id']}
    value={'schemaVersion':2,'id':identity,'version':1,'category':category,'familyId':family,
        'harnessModule':spec['module'],'harnessScenarioId':spec['id'],
        'relatedHarnessModules':spec.get('relatedModules',[]), 'variant':spec['variant'],
        'sampleId':None,'sampleRole':'synthetic_only','inputAssets':[],
        'semanticScenarioKey':family,'replicaIndex':1,'coverageContribution':'specific_condition_variant',
        'leakageGroup':'synthetic-'+(spec.get('normalControlId') or spec['id']),
        'split':'development','splitRationale':'公开制作和审查的合成种子，不冒充未暴露验收样本。',
        'title':spec['title'],'stage':stage,'benchmarks':spec.get('benchmarks',[]),
        'materialStatus':'structure_checked','reviewStatus':'pending','humanVerified':False,
        'executionStatus':'not_run','eligibleForAcceptance':False,'formalAcceptanceEligible':False,
        'inputMode':'harness_synthetic_contract','trigger':spec['trigger'],
        'initialEnvironment':{'kind':'simulated','resetBeforeEachTrial':True,'fixtureBaseRef':None,
            'scenarioSetup':{'fixtureOnly':True,'conditions':conditions,
                'fixtureApplication':{'kind':'trusted_adapter_plan','expectedResultsIncludedInBusinessInput':False,
                    'materialization':'offline_plan_actual_product_adapter_required'}},
            'instanceId':'SIM-'+identity,'workspaceId':'SIM-WS-development',
            'networkPolicy':{'businessTargets':'local_simulators_only','modelProvider':'requires_configured_evaluation_provider',
                'providerConfigured':False,'actualEnterpriseWrites':'forbidden'},
            'observationScope':spec.get('observationScope','case_owned_entities_and_explicit_related_logical_actions')},
        'oracle':{'version':1,'status':'review_pending','basis':spec['sourceSection']+' '+spec['sourceAnchor'],
            'fieldGoldRef':None,'assertions':deepcopy(spec['expected']),'forbidden':spec['forbidden'],
            'requiredEvidence':spec['evidence'],'missingEvidenceVerdict':'insufficient_evidence','checks':[]},
        'requirementRefs':refs,'evaluationMode':mode,
        'fab':{'prepared':[mode],'unprepared':[m for m in ['F','A','B'] if m!=mode], 'actualExecution':[], 'businessE2EClaim':False},
        'drivingTask':{'phase':stage,'requirementId':'DrivingTask-'+stage,'scope':'module_variant'},
        'dependencies':[spec.get('requiredCapability','reviewed_product_adapter'),'trusted_actual_evidence_adapter'],
        'blockedUntil':['actual_product_and_evidence_adapter','content_review'],
        'scoring':{'method':'deterministic_observation_assertions','graderContractVersion':2,
            'graderImplementation':'src/graders/observations.py','hardConstraints':spec['forbidden']},
        'risks':['no_product_run','unreviewed_contract'], 'normalControlFamily':None,
        'sourceSpecHashes':requirements['sourceHashes'],
        'caseSummary':{'input':spec['input'].get('task','使用本场景明确获准的合成输入。')+'；只投影声明的合成资料，可信初态与评分答案不交给模型。','trigger':spec['trigger'],
                       'expected':[a.get('description',a['path']) for a in spec['expected']]},
        'replication':{'kind':'distinct_conditions','countsAsAdditionalCoverage':True,'actualTrials':0},
        'enabledMode':spec.get('enabledMode','declared_stage_capability'),
    }
    value['scenarioRole']='challenge' if spec.get('normalControlId') else 'control'
    value['controlPairKey']='harness-'+(spec.get('normalControlId') or spec['id'])
    value['operation']='harness_contract'
    if spec.get('normalControlId'):
        control='harness-'+spec['normalControlId']
        value['normalControlRefs']=[{'caseId':control,'version':1}]
    return enrich_case(value)


def bind_atomic_checks(cases, requirements, specs, project=None):
    """Specific observation assertions own links; broad Case tags are navigation."""
    known={r['id']:r for r in requirements['requirements']}
    from harness_scenarios import EXISTING_CHECK_LINKS
    project=Path(project) if project is not None else Path(__file__).resolve().parents[2]
    source_lines=(project/requirements['sourceHashes']['agent-eval/docs/spec/01_Flowmate_Agent评测总方案.md']['path']).read_text(encoding='utf-8-sig').splitlines()
    import re
    sections={};section=''
    for number,line in enumerate(source_lines,1):
        heading=re.match(r'^#{1,6}\s+(\d+(?:\.\d+)*)\b',line)
        if heading:section=heading.group(1)
        sections[number]=section
    additions={}
    for case in cases:
        spec=specs.get(case.get('harnessScenarioId'))
        refs=_refs(case,requirements)
        if spec:
            anchors=[(i+1,line) for i,line in enumerate(source_lines) if spec['sourceAnchor'] in line
                     and sections[i+1]==spec['sourceSection']]
            if len(anchors)!=1:
                raise ValueError('Missing or ambiguous scenario source anchor: '+spec['id'])
            number,line=anchors[0]
            src={**requirements['sourceHashes']['agent-eval/docs/spec/01_Flowmate_Agent评测总方案.md'],
                 'lineStart':number,'lineEnd':number,'verbatim':line}
            atomic_refs=[r for r in spec.get('requirementKeys',[]) if r in known]
            refs=sorted(set(refs+atomic_refs))
            source_parent_refs=[r['id'] for r in known.values() if r['kind']!='atomic'
                and r['source']['lineStart']==number and r['source']['verbatim']==line]
        else:
            precise=[r for r in refs if r.startswith(('RTC-','RTX-','CRIT-'))]
            parent=precise[0] if precise else (refs[0] if refs else 'DrivingTask-'+case['stage'])
            src=known[parent]['source']
        previous={ch.get('assertion',{}).get('path'):ch for ch in case['oracle'].get('checks',[]) if ch.get('assertion')}
        checks=[]
        for assertion in case['oracle']['assertions']:
            path=assertion['path']
            rid=_atomic_id(case['familyId'],path)
            additions.setdefault(rid,{'id':rid,'kind':'case_contract','title':assertion.get('description',case['title']+'：'+path),
                'section':spec['sourceSection'] if spec else known[parent]['section'], 'source':src,
                'productSpec':requirements['sourceHashes']['docs/spec/00_Flowmate完整方案.md'],
                'harnessModule':case['harnessModule'],'requiredModes':[case['evaluationMode']],
                'firstPhaseMention':case['stage'],'parentRequirementIds':refs if spec else [parent],
                'interpretation':'Explicit assertion variant, not a claim to cover all source clauses.',
                'acceptanceStatus':'not_evaluated'})
            old=previous.get(path,{})
            check={'checkId':rid,'dimension':old.get('dimension','mechanism'), 'required':True,
                'hardConstraint':old.get('hardConstraint',spec is not None),
                'assertion':deepcopy(assertion),'ruleStatus':'implemented',
                'evidenceRequirements':deepcopy(old.get('evidenceRequirements') or [{'kind':e,'required':True} for e in case['oracle']['requiredEvidence']]),
                'requirementRefs':[rid], 'coverageScope':'atomic_assertion_only',
                'harnessModule':case['harnessModule'],'drivingTaskRef':'DrivingTask-'+case['stage'],
                'evaluationMode':case['evaluationMode']}
            # Explicit per-assertion linkage is supplied by curated scenario definitions.
            if spec:
                check['requirementRefs']+= [r for r in assertion.get('requirementKeys',[]) if r in known]
                check['requirementRefs']+=source_parent_refs
                for r in check['requirementRefs']:
                    if r in known and known[r].get('kind')=='atomic':
                        known[r].setdefault('harnessModules',[])
                        if case['harnessModule'] not in known[r]['harnessModules']:
                            known[r]['harnessModules'].append(case['harnessModule'])
                        known[r].setdefault('harnessModule',case['harnessModule'])
            elif path != 'observation.runtime.status' and path != 'observation.platform.status':
                check['requirementRefs'] += [parent]
            extra=EXISTING_CHECK_LINKS.get((case.get('harnessScenarioId') or case['familyId'],path),[])
            if set(extra)-set(known):raise ValueError('Unknown precise check requirement')
            check['requirementRefs']=list(dict.fromkeys(check['requirementRefs']+extra))
            checks.append(check)
        # Preserve unresolved legacy rules; they must not disappear in a migration.
        checks += [{**deepcopy(ch),'requirementRefs':[], 'harnessModule':case['harnessModule']}
            for ch in case['oracle'].get('checks',[]) if ch.get('ruleStatus')=='unimplemented']
        if spec:
            # Textual prohibitions need independently implemented evidence rules.
            # Ordinary expected-value assertions cannot silently certify them.
            for prohibition in case['oracle'].get('forbidden', []):
                checks.append({'checkId':'prohibition-'+hashlib.sha256(prohibition.encode()).hexdigest()[:12],
                    'dimension':'platformControl', 'required':True, 'hardConstraint':True,
                    'ruleStatus':'unimplemented', 'description':prohibition,
                    'requirementRefs':[], 'harnessModule':case['harnessModule'],
                    'drivingTaskRef':'DrivingTask-'+case['stage'], 'evaluationMode':case['evaluationMode'],
                    'evidenceRequirements':[{'kind':'trusted_input_and_action_provenance', 'required':True}],
                    'implementationDependency':'actual_projection_and_caller_provenance_adapter'})
        case['oracle']['checks']=checks
        case['requirementRefs']=sorted(set(refs+[r for ch in checks for r in ch['requirementRefs']]))
        case['requirementLinks']={kind:[r for r in case['requirementRefs'] if r.startswith(kind+'-')]
                                 for kind in ('MOD','RT','RTC','RTX','HC')}
        case['subcapabilityRefs']=sorted({r for ch in checks for r in ch['requirementRefs']})
    requirements['requirements'] += list(additions.values())


def validate_new_contracts(cases, requirements):
    known={r['id'] for r in requirements['requirements']}
    linked={r for c in cases for ch in c['oracle']['checks'] if ch.get('assertion')
            for r in ch['requirementRefs']}
    missing=[r['id'] for r in requirements['requirements'] if r['kind']=='atomic' and r['id'] not in linked]
    if missing:raise ValueError('Storage atomic contracts have no direct check: '+repr(missing))
    missing_runtime=[r['id'] for r in requirements['requirements'] if r['kind'] in {'RTC','RTX'} and r['id'] not in linked]
    if missing_runtime:raise ValueError('Runtime subcapabilities have no direct check: '+repr(missing_runtime))
    index={c['id']:c for c in cases}
    for c in cases:
        if not c.get('harnessScenarioId'):continue
        if set(c['requirementRefs'])-known:raise ValueError('Unknown supplemental requirement')
        for ref in c.get('normalControlRefs',[]):
            control=index.get(ref['caseId'])
            if not control or control.get('normalControlRefs') or control['version']!=ref['version']:
                raise ValueError('Invalid independent normal control')
            if c['split']!=control['split'] or int(control['stage'][1:])>int(c['stage'][1:]):
                raise ValueError('Control split/phase mismatch')
            required=set(c.get('enabledMode',{}).get('required',[]))
            control_required=set(control.get('enabledMode',{}).get('required',[]))
            if not control_required.issubset(required):
                raise ValueError('Control requires unavailable capabilities: '+c['id'])


def _catalog(cases):
    families={}
    for c in cases:
        category,slug=c['familyId'].split('/',1)
        families.setdefault(c['familyId'],{'category':category,'id':slug,'title':c['title'],
            'phase':c['stage'],'benchmarks':c['benchmarks'],'harnessModule':c['harnessModule']})
    return {'schemaVersion':2,'version':'current','organization':'harness_modules','status':'review_pending',
        'families':list(families.values()),'cases':[{**{k:c[k] for k in ('id','version','category','familyId','sampleId',
            'semanticScenarioKey','replicaIndex','sampleRole','split','stage','benchmarks','harnessModule')},
            'path':canonical_case_path(c)} for c in cases]}


def stage(project, output):
    from invoice_requirements import load_requirements, build_coverage, validate_coverage
    from harness_scenarios import SCENARIOS
    from sync_invoice_scope import archive_snapshot
    from audit_invoice_assets import build_batches
    project=Path(project).resolve(); source=project/'agent-eval/data'; output=Path(output).resolve()
    base=project/'data/.preparation-stage'
    if not output.is_relative_to(base) or output==base or output.exists():
        raise ValueError('Use a new contained preparation staging directory')
    if (source/'manifests/harness-migration.json').exists():
        verify_migration(source)
        return {'status':'already_migrated','path':str(source)}
    snapshot=checked_snapshot(source)
    requirements=load_requirements(project)
    old_catalog=read_json(source/'manifests/case-catalog.json')
    old_cases=[read_json(safe_relative(source,r['path'])) for r in old_catalog['cases']]
    cases=[revise_legacy(c,file_info(source/r['path'],source),requirements) for c,r in zip(old_cases,old_catalog['cases'],strict=True)]
    describe_legacy(cases,(source/'README.md').read_text(encoding='utf-8-sig'))
    specs={s['id']:s for s in SCENARIOS}
    if len(specs)!=len(SCENARIOS): raise ValueError('Duplicate scenario identity')
    cases += [scenario_case(s,requirements) for s in SCENARIOS]
    bind_atomic_checks(cases,requirements,specs,project)
    index={c['id']:c for c in cases}
    for case in cases:
        for ref in case.get('normalControlRefs',[]):
            control=index[ref['caseId']]
            ref['version']=control['version']
            if int(control['stage'][1:])>int(case['stage'][1:]):
                raise ValueError('Normal control starts later: '+case['id'])
    coverage=build_coverage(cases,requirements)
    validate_coverage(cases,requirements,coverage)
    validate_new_contracts(cases,requirements)
    shutil.copytree(source,output)
    history=archive_snapshot(source,output)
    # All old current paths are in the verified archive before removal. Deletions
    # are exact files in the staged cases root, never a computed recursive root.
    for row in old_catalog['cases']:
        path=safe_relative(output,row['path'])
        if not path.resolve().is_relative_to((output/'cases').resolve()): raise ValueError('Case escaped staging')
        path.unlink()
    for folder in (output/'cases').iterdir():
        if folder.is_dir() and not any(folder.iterdir()): folder.rmdir()
    for c in cases:
        path=output/canonical_case_path(c);path.parent.mkdir(parents=True,exist_ok=True);save(path,c)
    catalog=_catalog(cases)
    save(output/'manifests/case-catalog.json',catalog)
    save(output/'manifests/requirements.json',requirements)
    save(output/'manifests/coverage.json',coverage)
    save(output/'manifests/module-catalog.json',module_catalog(cases,requirements))
    splits=read_json(source/'manifests/splits.json')
    for split,members in splits['members'].items():members['cases']=[c['id'] for c in cases if c['split']==split]
    splits['syntheticGroups']=[{'caseId':c['id'],'groupId':c['leakageGroup'],'split':c['split']} for c in cases if c['sampleRole']=='synthetic_only']
    save(output/'manifests/splits.json',splits)
    views=read_json(source/'manifests/views.json')
    views['stages']={f'P{i}':[c['id'] for c in cases if c['stage']==f'P{i}'] for i in range(14)}
    views['benchmarks']={f'BM-{i:02}':[c['id'] for c in cases if f'BM-{i:02}' in c['benchmarks']] for i in range(1,13) if i!=6}
    views['modules']={m:[c['id'] for c in cases if c['harnessModule']==m] for m in MODULES}
    save(output/'manifests/views.json',views)
    # Reuse image analysis; rebuild only derived member queues.
    samples=deepcopy(splits['samples'])
    features={f['sampleId']:f for f in read_json(source/'manifests/audit/sample-features.json')['samples']}
    for s in samples:s['hasPublisherLabels']=features[s['sampleId']]['hasPublisherLabels']
    targets=((100,50,500),(500,250,2500),(1200,600,len(cases)))
    batches=build_batches(samples,cases,targets=targets)
    save(output/'manifests/audit/batches.json',{'kind':'cumulative_review_batches','targets':targets,'batches':batches})
    report=read_json(output/'manifests/audit/audit-report.json')
    report.update(splitManifestSha256=digest(output/'manifests/splits.json'),caseCatalogSha256=digest(output/'manifests/case-catalog.json'),
        batches=[{k:b[k] for k in ('batchId','counts','coveredFamilyCount','uncoveredFamilies','goldSplitLabelCounts','businessSplitLabelCounts')} for b in batches])
    save(output/'manifests/audit/audit-report.json',report)
    import csv
    # This is a current worklist, not the immutable human attestation itself.
    queue=output/'manifests/review-queue.csv'
    with queue.open(encoding='utf-8-sig',newline='') as stream:
        reader=csv.DictReader(stream);fieldnames=reader.fieldnames;queue_rows=list(reader)
    for row in queue_rows:
        gold=read_json(output/row['gold_file'])
        row['status']='human_verified' if gold.get('humanVerified') else 'review_pending'
    with queue.open('w',encoding='utf-8-sig',newline='') as stream:
        writer=csv.DictWriter(stream,fieldnames=fieldnames);writer.writeheader();writer.writerows(queue_rows)
    with (output/'manifests/audit/review-queue.csv').open('w',encoding='utf-8-sig',newline='') as stream:
        writer=csv.DictWriter(stream,fieldnames=['assetKind','assetId','firstBatch','split','assetRef','status']);writer.writeheader();seen=set()
        for batch in batches:
            for kind in ('gold','business','cases'):
                for identity in batch[kind]:
                    if (kind,identity) in seen:continue
                    seen.add((kind,identity)); case=index.get(identity) if kind=='cases' else None
                    path=canonical_case_path(case) if case else f'{kind}/{identity}.json'
                    value=case or read_json(output/path)
                    writer.writerow(dict(assetKind=kind,assetId=identity,firstBatch=batch['batchId'],split=value['split'],assetRef=path,status=value.get('reviewStatus','pending')))
    materialization=(output/'manifests/materialization').resolve()
    if materialization.parent != (output/'manifests').resolve():raise ValueError('Unsafe derived output')
    # Only regenerate named preparation files, keeping unrelated retained content.
    for name in ('cases.jsonl','fixtures.jsonl','report.json'):
        if (materialization/name).exists():(materialization/name).unlink()
    materialization.rmdir()
    sys.path.insert(0,str(project/'agent-eval/src'))
    from runner.materialize import audit
    materialized=audit(project,materialization,data_root=output)
    report=read_json(output/'manifests/preparation-report.json');semantic=Counter(c['semanticScenarioKey'] for c in cases)
    report.update(revision=report.get('revision',1)+1,caseDrafts=len(cases),caseCounts=dict(Counter(c['category'] for c in cases)),
        harnessModuleCounts=dict(Counter(c['harnessModule'] for c in cases)),harnessModuleCount=len(MODULES),
        scenarioFamilies=len(catalog['families']),scenarioFamilyCounts=dict(Counter(f['category'] for f in catalog['families'])),
        distinctSemanticScenarioKeys=len(semantic),replicaInstancesBeyondFirst=sum(n-1 for n in semantic.values()),
        caseSplitCounts=dict(Counter(c['split'] for c in cases)),syntheticOnlyCases=sum(c['sampleRole']=='synthetic_only' for c in cases),
        mechanismAllocationOnlyInstances=sum(c['sampleRole']=='allocation_anchor_only' for c in cases),
        materialization=materialized,requirementsCoverage=coverage['summary'],executedCases=0,
        sourceRequirementRecords=sum(r['kind']!='case_contract' for r in requirements['requirements']),
        storageAtomicRequirements=sum(r['kind']=='atomic' for r in requirements['requirements']),
        assertionContractCount=sum(r['kind']=='case_contract' for r in requirements['requirements']),
        acceptedGold=report.get('humanVerifiedInvoices',0),
        acceptedGoldMeaning='已发布且具有人工核验记录的字段Gold数量，不代表正式产品验收通过。',
        remainingWork=['复核本次 Case 与 Oracle 修订；保留未改变的 Gold 核验。','完成近重复与留出暴露审查。','接入实际产品/SDK 及可信观测适配器后运行评测。'])
    save(output/'manifests/preparation-report.json',report)
    protected=[file_info(p,source) for folder in ('gold','source-labels','business','manifests/reviews','runs') for p in sorted((source/folder).rglob('*')) if p.is_file()]
    changes=[{'id':c['id'],'prior':file_info(source/r['path'],source),'current':file_info(output/canonical_case_path(c),output)}
        for c,r in zip(cases[:len(old_cases)],old_catalog['cases'],strict=True)]
    record={'schemaVersion':1,'id':MIGRATION,'createdAt':datetime.now(timezone.utc).isoformat(),
        'priorSnapshot':snapshot,'history':history,'sourceHashes':requirements['sourceHashes'],
        'priorCaseCount':len(old_cases),'caseCount':len(cases),'changedCases':changes,
        'addedCases':[file_info(output/canonical_case_path(c),output) for c in cases[len(old_cases):]],
        'preservedAssets':protected,'reviewInheritance':False,'actualProductRuns':0,
        'verificationMeaning':'Preparation and provenance, not product acceptance.'}
    save(output/'manifests/harness-migration.json',record)
    from harness_documentation import refresh_documents
    refresh_documents(output,cases,requirements,report)
    refresh_inventory(output)
    verify_migration(output)
    return {'status':'staged','path':str(output),'caseCount':len(cases),'addedCases':len(SCENARIOS)}


def refresh_inventory(root):
    root=Path(root); path=root/'manifests/inventory.json';inv=read_json(path)
    inv['revision']=inv.get('revision',1)+1
    inv['files']=[file_info(p,root) for p in sorted(root.rglob('*')) if p.is_file() and p!=path]
    save(path,inv)


def verify_migration(root):
    from sync_invoice_scope import verify_history, scope_baseline
    root=Path(root).resolve(); record=read_json(root/'manifests/harness-migration.json')
    if record['history']['inventorySha256']!=record['priorSnapshot']['inventorySha256']:
        raise ValueError('Migration archive differs from prior inventory')
    verify_history(root,record['history'])
    catalog=read_json(root/'manifests/case-catalog.json'); index={r['id']:r for r in catalog['cases']}
    if len(index)!=len(catalog['cases']) or len(index)!=record['caseCount']:raise ValueError('Harness case denominator mismatch')
    changed_ids={r['id'] for r in record['changedCases']}
    added_ids={Path(r['path']).stem for r in record['addedCases']}
    if (len(changed_ids)!=len(record['changedCases']) or len(added_ids)!=len(record['addedCases'])
            or changed_ids & added_ids or changed_ids | added_ids != set(index)):
        raise ValueError('Migration current identity ledger differs')
    with zipfile.ZipFile(root/record['history']['path']) as archive:
        prior_inventory=json.loads(archive.read('manifests/inventory.json'))
        prior_files={e['path']:e for e in prior_inventory['files']}
        protected={p for p in prior_files if p.startswith(('gold/','business/','source-labels/','manifests/reviews/','runs/'))}
        if ({e['path'] for e in record['preservedAssets']}!=protected
                or len(record['preservedAssets'])!=len(protected)):
            raise ValueError('Protected history declaration incomplete')
        prior=read_json(root/'manifests/requirements.json')
        if prior['sourceHashes']!=record['sourceHashes']:raise ValueError('Migration specs differ')
        old_catalog=json.loads(archive.read('manifests/case-catalog.json'))
        if {c['id'] for c in old_catalog['cases']}!={c['id'] for c in record['changedCases']}:raise ValueError('Migration lost prior cases')
        for row in record['changedCases']:
            before=archive.read(row['prior']['path'])
            if hashlib.sha256(before).hexdigest()!=row['prior']['sha256']:raise ValueError('Migration revision differs')
            old=json.loads(before);new=scope_baseline(root,row['current'])
            if any(old[k]!=new[k] for k in ('id','familyId','category','sampleId','split','leakageGroup','semanticScenarioKey','replicaIndex')):raise ValueError('Migration changed preserved identity')
            if new['version']!=old.get('version',1)+1 or new.get('humanVerified'):raise ValueError('Invalid case revision/review inheritance')
        for row in record['preservedAssets']:
            if row!=prior_files[row['path']]:raise ValueError('Protected archive descriptor differs')
            if row['path'].startswith(('gold/','business/')):
                scope_baseline(root,row)
            elif file_info(root/row['path'],root)!=row:raise ValueError('Protected data changed: '+row['path'])
        for row in record['addedCases']:
            scope_baseline(root,row)
    actual={p.relative_to(root).as_posix() for p in (root/'cases').rglob('*.json')}
    if actual!={r['path'] for r in index.values()}:raise ValueError('Unlisted or missing cases')
    for row in index.values():
        c=read_json(safe_relative(root,row['path']))
        if canonical_case_path(c)!=row['path']:raise ValueError('Noncanonical Harness path')
    return {'status':'harness_lineage_checked','cases':len(index)}


def publish(project, staged):
    project=Path(project).resolve(); staged=Path(staged).resolve();root=project/'agent-eval/data'
    if not staged.is_relative_to(project/'data/.preparation-stage'):raise ValueError('Unsafe staged root')
    change=read_json(staged/'manifests/harness-migration.json')
    if checked_snapshot(root)!=change['priorSnapshot']:raise ValueError('Source changed after staging')
    checked_snapshot(staged);verify_migration(staged)
    from verify_invoice_data import verify
    verify(project/'data/invoices/voxel51',staged)
    backup=staged.parent/('before-'+change['priorSnapshot']['inventorySha256'])
    if backup.exists():raise ValueError('Rollback directory already exists')
    # Both resolved destinations are explicitly within the user's project.
    if not root.is_relative_to(project) or not backup.is_relative_to(project):raise ValueError('Publication escaped project')
    root.rename(backup)
    try:staged.rename(root)
    except BaseException:
        backup.rename(root);raise
    return {'status':'published','path':str(root),'rollback':str(backup)}


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command',choices=['stage','publish','verify'])
    parser.add_argument('--project',type=Path,default=Path.cwd());parser.add_argument('--output',type=Path)
    args=parser.parse_args()
    if args.command=='stage':result=stage(args.project,args.output)
    elif args.command=='publish':result=publish(args.project,args.output)
    else:result=verify_migration(args.output or args.project/'agent-eval/data')
    print(json.dumps(result,ensure_ascii=False,indent=2))
