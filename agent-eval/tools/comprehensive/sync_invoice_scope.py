"""Revise the current invoice dataset in staging, preserving attested prior bytes.

No product or SDK run is performed. Publication rechecks both inventories and
keeps the previous directory available for rollback until final verification.
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

from finalize_invoice_data import checked_snapshot, rebuild_audit, canonical_path
from invoice_scope import SCOPE_ID, RETIRED_FAMILIES, CASE_COUNTS
from prepare_invoice_data import digest, file_info, read_json, substitute, safe_relative
from review_invoice_data import _replace_json as save


def split_scope_cases(cases):
    return ([deepcopy(c) for c in cases if c['familyId'] not in RETIRED_FAMILIES],
            [deepcopy(c) for c in cases if c['familyId'] in RETIRED_FAMILIES])


def archive_snapshot(source, output):
    snapshot = checked_snapshot(source)
    relative = 'manifests/history/' + snapshot['inventorySha256'] + '.zip'
    path = output/relative
    path.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(path, 'x', zipfile.ZIP_DEFLATED) as archive:
        for asset in sorted(source.rglob('*')):
            if asset.is_file():
                archive.write(asset, asset.relative_to(source).as_posix())
    result = {**file_info(path, output), 'inventorySha256': snapshot['inventorySha256'],
              'purpose': 'Historical content bound by prior review statements; excluded from active cases.'}
    verify_history(output, result)
    return result


def verify_history(root, descriptor):
    path = (root/descriptor['path']).resolve()
    if not path.is_relative_to(root.resolve()) or not path.is_file() or digest(path) != descriptor['sha256']:
        raise ValueError('History archive missing, escaping or changed')
    with zipfile.ZipFile(path) as archive:
        names = archive.namelist()
        if len(set(names)) != len(names):
            raise ValueError('Duplicate history archive members')
        inventory_bytes = archive.read('manifests/inventory.json')
        if hashlib.sha256(inventory_bytes).hexdigest() != descriptor['inventorySha256']:
            raise ValueError('Historical inventory differs')
        inventory = json.loads(inventory_bytes)
        expected = {'manifests/inventory.json'}
        for entry in inventory['files']:
            content = archive.read(entry['path'])
            if len(content) != entry['bytes'] or hashlib.sha256(content).hexdigest() != entry['sha256']:
                raise ValueError('Historical asset differs: '+entry['path'])
            expected.add(entry['path'])
        if set(names) != expected:
            raise ValueError('Historical archive membership differs')


def scope_baseline(root, descriptor):
    """Allow later attested reviews while retaining the exact migration baseline.

    Current reviewer eligibility is independently checked by validate_current_assets.
    This function only proves the byte-level parent chain, never review quality.
    """
    path = safe_relative(root,descriptor['path'])
    raw = path.read_bytes()
    visited = set()
    while True:
        value = json.loads(raw)
        actual = {'path':descriptor['path'],'bytes':len(raw),'sha256':hashlib.sha256(raw).hexdigest()}
        if actual == descriptor:
            return value
        reference = value.get('reviewRecord')
        if not reference or reference in visited:
            raise ValueError('Current content has no review chain to scope baseline')
        visited.add(reference)
        record_path = safe_relative(root,reference)
        if record_path.parent.resolve() != (root/'manifests/reviews').resolve():
            raise ValueError('Review chain escaped review directory')
        record = read_json(record_path)
        parent = record.get('parentAsset',{})
        text = record.get('parentText','').encode('utf-8')
        kind = 'case' if descriptor['path'].startswith('cases/') else 'gold' if descriptor['path'].startswith('gold/') else 'business' if descriptor['path'].startswith('business/') else 'policy'
        identity = value.get('sampleId') if kind in {'gold','business'} else value.get('id')
        if (record.get('kind')!='human_content_review_record' or record.get('id')!=record_path.stem
            or record.get('assetKind')!=kind or record.get('assetId')!=identity
            or record.get('resultValue')!=value or parent!=value.get('parentAsset')
            or parent!=record.get('submission',{}).get('target')
            or parent!={'path':descriptor['path'],'bytes':len(text),'sha256':hashlib.sha256(text).hexdigest()}
            or json.loads(text)!=record.get('parentValue')
            or value.get('version')!=record['parentValue'].get('version',1)+1):
            raise ValueError('Invalid review chain to scope baseline')
        raw = text


def verify_scope_manifest(root, cases):
    """Prove scope membership and protected lineage, not just file checksums."""
    root = Path(root)
    change = read_json(root/'manifests/scope-sync.json')
    if change['scopeId'] != SCOPE_ID or change['counts'] != CASE_COUNTS:
        raise ValueError('Unexpected scope contract')
    if change['history']['inventorySha256'] != change['priorSnapshot']['inventorySha256']:
        raise ValueError('History archive belongs to another prior snapshot')
    verify_history(root, change['history'])
    with zipfile.ZipFile(root/change['history']['path']) as archive:
        prior_catalog = json.loads(archive.read('manifests/case-catalog.json'))
        prior_cases = {c['id']:json.loads(archive.read(c['path'])) for c in prior_catalog['cases']}
        current = {c['id']:c for c in cases}
        removed = {identity for identity,c in prior_cases.items() if c['familyId'] in RETIRED_FAMILIES}
        if set(current) != set(prior_cases)-removed:
            raise ValueError('Scope changed surviving case identities')
        if {c['id'] for c in change['retiredCases']} != removed or len(change['retiredCases']) != len(removed):
            raise ValueError('Retirement audit differs from approved families')
        for identity,c in current.items():
            old = prior_cases[identity]
            if any(c[k] != old[k] for k in ('category','familyId','sampleId','split','leakageGroup','semanticScenarioKey','replicaIndex','stage')):
                raise ValueError('Scope reassigned case identity, split or phase: '+identity)
            if c['category']=='runtime' and c['initialEnvironment'] != old['initialEnvironment']:
                raise ValueError('Scope changed native runtime fixture: '+identity)
        inventory = json.loads(archive.read('manifests/inventory.json'))
        prior_files = {f['path']:f for f in inventory['files']}
        protected = {p for p in prior_files if p.startswith(('gold/','source-labels/','manifests/reviews/','runs/'))}
        if {f['path'] for f in change['preservedAssets']} != protected:
            raise ValueError('Missing protected history declaration')
        for entry in change['preservedAssets']:
            if entry != prior_files[entry['path']]:
                raise ValueError('Protected data or review bytes changed')
            if entry['path'].startswith('gold/'):
                scope_baseline(root,entry)
            elif file_info(root/entry['path'],root) != entry:
                raise ValueError('Protected data or review bytes changed')
        expected_changes = {canonical_path('case',c) for c in cases}
        expected_changes |= {p for p in prior_files if p.startswith('business/')}
        expected_changes.add('manifests/fixture-policy.json')
        if {e['path'] for e in change['changedAssets']} != expected_changes:
            raise ValueError('Changed asset audit differs')
        for entry in change['changedAssets']:
            path = entry['path']
            if entry['prior'] != prior_files[path]:
                raise ValueError('Revision descriptor differs: '+path)
            value = scope_baseline(root,entry['current'])
            old = json.loads(archive.read(path))
            if value.get('version') != old.get('version',1)+1 or value.get('reviewStatus')!='pending' or value.get('humanVerified'):
                raise ValueError('Changed asset inherited prior review: '+path)
            if value['revisionProvenance']['priorSha256'] != entry['prior']['sha256']:
                raise ValueError('Revision lineage differs: '+path)
        for entry in change['retiredCases']:
            old = prior_cases[entry['id']]
            if entry['familyId'] != old['familyId'] or entry['prior'] != prior_files[canonical_path('case',old)]:
                raise ValueError('Retired case lineage differs')


def _changed_revision(value, prior, descriptor):
    value['version'] = prior.get('version', 1)+1
    # Prior attestations certify prior content only. The archive preserves them.
    for key in ('reviewRecord', 'reviewSubmission', 'parentAsset', 'reviewedBy', 'reviewedAt',
                'contentAcceptance', 'reviewLevel', 'identityVerification', 'acceptedGoldVersion'):
        value.pop(key, None)
    value.update(status='review_pending', reviewStatus='pending', humanVerified=False,
                 eligibleForAcceptance=False, formalAcceptanceEligible=False)
    if 'eligibleForFieldScoring' in value:
        value['eligibleForFieldScoring'] = False
    value['revisionProvenance'] = {'kind': 'scope_revision', 'scopeId': SCOPE_ID,
        'priorSha256': descriptor['sha256'], 'priorVersion': prior.get('version', 1),
        'priorContent': 'manifests/scope-sync.json#/history',
        'reviewInheritance': False, 'actualProductRun': False}
    return value


def refresh_case(case, business, catalog):
    """Update affected base specifications without changing case or sample identity."""
    value = deepcopy(case)
    family = catalog.get(case['familyId'])
    if family and (case['category'] in {'matching', 'approval', 'submission'}
                   or case['familyId'] == 'platform/pure-composition'):
        inv = business.get('input', {}).get('invoice', {})
        expanded = substitute(family, {'$sampleId':case['sampleId'], '$caseId':case['id'],
            '$split':case['split'], '$businessId':business.get('id'),
            '$supplierId':inv.get('supplierId'), '$invoiceNumber':inv.get('invoiceNumber')})
        value.update(title=expanded['title'], stage=expanded['phase'], benchmarks=expanded['benchmarks'],
                     trigger=expanded['trigger'], dependencies=expanded['dependencies'], risks=expanded['risk'])
        value['initialEnvironment']['scenarioSetup'] = expanded['initialState']
        value['oracle'].update(basis=expanded['basis'], assertions=expanded['expected'],
            forbidden=expanded['forbidden'], requiredEvidence=expanded['evidence'])
    value['oracle']['version'] = case['oracle'].get('version', 1)+1
    return value


def stage(project, output):
    project, output = Path(project).resolve(), Path(output).resolve()
    staging_root = project/'data/.preparation-stage'
    if output == staging_root or not output.is_relative_to(staging_root) or output.exists():
        raise ValueError('Output must be a new descendant of project/data/.preparation-stage')
    source = project/'agent-eval/data'
    snapshot = checked_snapshot(source)
    if (source/'manifests/scope-sync.json').exists():
        raise ValueError('Scope already revised; do not reassign or repeatedly revise current assets')
    if any(p.is_file() and p.name != 'README.md' for p in (source/'runs').rglob('*')):
        raise ValueError('Actual runs need a separately planned evidence-preserving revision')
    from invoice_case_catalog import CATALOG
    from invoice_requirements import load_requirements, enrich_cases, build_coverage, validate_coverage, _security_families, _replace
    from prepare_invoice_data import make_fixture_policy
    requirements = load_requirements(project)
    prior_cases = [read_json(source/ref['path']) for ref in read_json(source/'manifests/case-catalog.json')['cases']]
    cases, retired = split_scope_cases(prior_cases)
    if Counter(c['category'] for c in cases) != CASE_COUNTS:
        raise ValueError('Surviving allocations differ from reviewed scope; inspect before revising')
    shutil.copytree(source, output)
    history = archive_snapshot(source, output)
    changes = []

    def revise(relative, value):
        old_path = source/relative
        prior = read_json(old_path)
        descriptor = file_info(old_path, source)
        _changed_revision(value, prior, descriptor)
        save(output/relative, value)
        changes.append({'path':relative, 'prior':descriptor, 'current':file_info(output/relative, output)})

    businesses = {}
    for path in sorted((source/'business').glob('*.json')):
        value = read_json(path)
        value['input']['targetSystems'].pop('erp', None)
        revise(path.relative_to(source).as_posix(), value)
        businesses[value['sampleId']] = value
    revise('manifests/fixture-policy.json', make_fixture_policy())
    catalog = {category+'/'+f['id']:f for category, families in CATALOG.items() for f in families}
    security = {f['category']+'/'+f['id']:f for f in _security_families(requirements)}
    refreshed = []
    for case in cases:
        value = refresh_case(case, businesses.get(case['sampleId'], {}), catalog)
        if case.get('securityPair', {}).get('key') == 'approve':
            _replace(value, security[case['familyId']])
        elif case['familyId'] in {'isolation/role-spoof', 'isolation/allowed-approve'}:
            value['initialEnvironment']['scenarioSetup']['conditions'] = deepcopy(catalog[case['familyId']]['initialState']['conditions'])
        _changed_revision(value, case, file_info(source/canonical_path('case',case), source))
        refreshed.append(value)
    cases = enrich_cases(refreshed, requirements, redistribute=False)
    for value in cases:
        relative = canonical_path('case', value)
        save(output/relative, value)
        changes.append({'path':relative, 'prior':file_info(source/relative,source),
                        'current':file_info(output/relative,output)})
    removed = []
    for case in retired:
        relative = canonical_path('case',case)
        path = (output/relative).resolve()
        if not path.is_relative_to(output/'cases'):
            raise ValueError('Retired case escaped staging cases')
        removed.append({'id':case['id'], 'familyId':case['familyId'], 'prior':file_info(source/relative,source)})
        path.unlink()
    families = {}
    for case in cases:
        category, identity = case['familyId'].split('/',1)
        families.setdefault(case['familyId'], {'category':category, 'id':identity,
            'title':case['title'], 'phase':case['stage'], 'benchmarks':case['benchmarks']})
    case_catalog = {'schemaVersion':1, 'version':'current', 'status':'review_pending',
        'families':list(families.values()), 'cases':[{**{k:c[k] for k in (
        'id','category','familyId','sampleId','semanticScenarioKey','replicaIndex','sampleRole','split','stage','benchmarks')},
        'path':canonical_path('case',c)} for c in cases]}
    save(output/'manifests/case-catalog.json',case_catalog)
    splits = read_json(source/'manifests/splits.json')
    for split, members in splits['members'].items():
        members['cases'] = [c['id'] for c in cases if c['split']==split]
    save(output/'manifests/splits.json', splits)
    views = read_json(source/'manifests/views.json')
    views.update(stages={f'P{i}':[c['id'] for c in cases if c['stage']==f'P{i}'] for i in range(14)},
        benchmarks={f'BM-{i:02}':[c['id'] for c in cases if f'BM-{i:02}' in c['benchmarks']]
                    for i in range(1,13) if i!=6})
    save(output/'manifests/views.json',views)
    coverage = build_coverage(cases,requirements)
    validate_coverage(cases,requirements,coverage)
    save(output/'manifests/requirements.json',requirements)
    save(output/'manifests/coverage.json',coverage)
    for name in ('audit','materialization'):
        target = (output/'manifests'/name).resolve()
        if target != output/'manifests'/name or not target.is_relative_to(output):
            raise ValueError('Derived directory escaped staging')
        shutil.rmtree(target)
    audit_report = rebuild_audit(project,source,output,cases,splits)
    sys.path.insert(0,str(project/'agent-eval/src'))
    from runner.materialize import audit
    materialization = audit(project,output/'manifests/materialization',data_root=output)
    semantic = Counter(c['semanticScenarioKey'] for c in cases)
    report = read_json(source/'manifests/preparation-report.json')
    report.update(revision=report.get('revision',1)+1, scopeId=SCOPE_ID,
        caseDrafts=len(cases), caseCounts=dict(Counter(c['category'] for c in cases)),
        caseSplitCounts=dict(Counter(c['split'] for c in cases)),
        scenarioFamilies=len(families), scenarioFamilyCounts=dict(Counter(f['category'] for f in families.values())),
        distinctSemanticScenarioKeys=len(semantic), replicaInstancesBeyondFirst=sum(n-1 for n in semantic.values()),
        mechanismAllocationOnlyInstances=sum(c['sampleRole']=='allocation_anchor_only' for c in cases),
        materialization=materialization, requirementsCoverage=coverage['summary'],
        semanticQuality='scope_revisions_pending_review_prior_attestation_preserved',
        scopeRevision={'record':'manifests/scope-sync.json','retiredCases':len(retired),
                       'changedAssets':len(changes),'priorReviewAppliesToChangedAssets':False})
    if report.get('humanReviewAttestation'):
        report['humanReviewAttestation']['applicability'] = 'historical_hash_bound_assets_only; changed assets require new review'
    report['remainingWork'] = ['复核本次修改的业务资料、用例与模拟策略；旧审核声明仅绑定旧内容。',
        '将已有人工审核声明补充为逐字段 Gold 值与证据，不能由生成脚本代填。',
        '完成近重复、用途隔离和验收暴露审查。',
        '按阶段接入产品及 Pi SDK 后执行真实评测；离线物化不代表产品运行。']
    save(output/'manifests/preparation-report.json',report)
    from invoice_data_readme import refresh_readme
    (output/'README.md').write_text(refresh_readme((source/'README.md').read_text(encoding='utf-8'), cases, report),encoding='utf-8')
    preserved = [file_info(p,source) for folder in ('source-labels','gold','manifests/reviews','runs')
                 for p in sorted((source/folder).rglob('*')) if p.is_file()]
    for descriptor in preserved:
        if digest(output/descriptor['path']) != descriptor['sha256']:
            raise ValueError('Protected content changed: '+descriptor['path'])
    save(output/'manifests/scope-sync.json',{'schemaVersion':1, 'scopeId':SCOPE_ID,
        'createdAt':datetime.now(timezone.utc).isoformat(), 'priorSnapshot':snapshot,
        'history':history, 'retiredCases':removed, 'changedAssets':changes,
        'preservedAssets':preserved, 'counts':dict(Counter(c['category'] for c in cases)),
        'actualProductRunsAdded':0, 'humanReviewsPerformedByGenerator':0})
    inventory = read_json(source/'manifests/inventory.json')
    inventory.update(revision=inventory.get('revision',1)+1,
        files=[file_info(p,output) for p in sorted(output.rglob('*')) if p.is_file() and p!=output/'manifests/inventory.json'])
    save(output/'manifests/inventory.json',inventory)
    checked_snapshot(output)
    if checked_snapshot(source) != snapshot:
        raise ValueError('Current source changed while staging')
    return {'status':'staged_not_published','output':str(output),'cases':len(cases),
            'retiredCases':len(retired),'families':len(families), 'changedAssets':len(changes)}


def publish(project, staged):
    project, staged = Path(project).resolve(), Path(staged).resolve()
    staging_root = project/'data/.preparation-stage'
    if staged == staging_root or not staged.is_relative_to(staging_root):
        raise ValueError('Publication source must be in preparation staging')
    source = project/'agent-eval/data'
    change = read_json(staged/'manifests/scope-sync.json')
    if checked_snapshot(source) != change['priorSnapshot']:
        raise ValueError('Current data changed after staging; refusing replacement')
    verify_history(staged,change['history'])
    from verify_invoice_data import verify
    verify(project/'data/invoices/voxel51',staged)
    backup = staging_root/('before-scope-'+change['priorSnapshot']['inventorySha256'][:16])
    if backup.exists():
        raise ValueError('Rollback directory exists; inspect before publishing')
    if not backup.resolve().is_relative_to(staging_root) or source.resolve()!=project/'agent-eval/data':
        raise ValueError('Publication paths escaped project')
    # Recheck after lengthy validation to catch concurrent review changes.
    if checked_snapshot(source) != change['priorSnapshot']:
        raise ValueError('Current data changed during verification')
    source.rename(backup)
    try:
        staged.rename(source)
        result = verify(project/'data/invoices/voxel51',source)
    except Exception:
        if source.exists():
            source.rename(staged)
        backup.rename(source)
        raise
    return {**result,'status':'published_and_verified','rollbackDirectory':str(backup)}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--project',type=Path,default=Path.cwd())
    choice = parser.add_mutually_exclusive_group(required=True)
    choice.add_argument('--output',type=Path,help='New staging directory')
    choice.add_argument('--publish',type=Path,help='Previously generated and checked staging directory')
    args = parser.parse_args()
    result = publish(args.project,args.publish) if args.publish else stage(args.project,args.output)
    print(json.dumps(result,ensure_ascii=False,indent=2))
