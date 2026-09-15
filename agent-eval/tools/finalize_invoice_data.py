"""Stage one current dataset from checked machine drafts; never delete source data.

Publication is a separate checked directory swap. Actual human reviews/runs make
this initial consolidation inapplicable: use review intake for ongoing changes.
"""
from __future__ import annotations

import argparse
import copy
import csv
from collections import Counter
from datetime import datetime, timezone
import json
from pathlib import Path
import re
import shutil
import sys

from prepare_invoice_data import digest, file_info, read_json, safe_relative, write_new


def checked_snapshot(root):
    root = Path(root)
    inventory = read_json(root/'manifests/inventory.json')
    entries = list(inventory['files'])
    expected = {'manifests/inventory.json'}
    workflow = root/'manifests/workflow-inventory.json'
    if workflow.exists():
        supplement = read_json(workflow)
        if supplement['baseInventorySha256'] != digest(root/'manifests/inventory.json'):
            raise ValueError('Supplement points to a changed baseline')
        entries += supplement['files']
        expected.add('manifests/workflow-inventory.json')
    for entry in entries:
        if entry['path'] in expected:
            raise ValueError('Repeated inventory entry')
        path = safe_relative(root, entry['path'])
        if not path.is_file() or path.is_symlink() or path.stat().st_size != entry['bytes'] or digest(path) != entry['sha256']:
            raise ValueError(f'Source changed: {entry["path"]}')
        expected.add(entry['path'])
    actual = {p.relative_to(root).as_posix() for p in root.rglob('*') if p.is_file()}
    if actual != expected:
        raise ValueError('Unlisted or missing source files')
    return {'inventorySha256': digest(root/'manifests/inventory.json'),
            'workflowInventorySha256': digest(workflow) if workflow.exists() else None,
            'files': len(actual)}


def verify_retirable(root):
    root = Path(root)
    for folder in ('manifests/reviews', 'runs'):
        if any(p.is_file() and p.name != 'README.md' for p in (root/folder).rglob('*')):
            raise ValueError('Actual review/run records require history-preserving maintenance')
    for folder in ('gold', 'business', 'cases'):
        for path in (root/folder).rglob('*.json'):
            value = read_json(path)
            if (value.get('humanVerified') or value.get('reviewedBy') or value.get('reviewSubmission')
                    or value.get('reviewStatus', 'pending') not in ('pending', 'review_pending')
                    or value.get('executionStatus', 'not_run') != 'not_run'):
                raise ValueError(f'Cannot retire reviewed or executed asset: {path.name}')


def canonical_path(kind, value):
    identity = value.get('sampleId') if kind in ('gold', 'business') else value.get('id')
    if not isinstance(identity, str) or not re.fullmatch(r'[a-zA-Z0-9_-]+', identity):
        raise ValueError('Unsafe asset identity')
    if kind == 'case':
        category = value['category']
        if category not in ('extraction', 'matching', 'approval', 'submission', 'runtime', 'isolation', 'platform'):
            raise ValueError('Unknown category')
        return f'cases/{category}/{identity}.json'
    if kind == 'policy':
        return 'manifests/fixture-policy.json'
    if kind not in ('gold', 'business'):
        raise ValueError('Unknown asset kind')
    return f'{kind}/{identity}.json'


def revise_case(value, descriptor):
    revised = copy.deepcopy(value)
    revised['version'] = value.get('version', 1) + 1
    revised['oracle']['version'] = value['oracle'].get('version', 1) + 1
    revised['revisionProvenance'] = {
        'kind': 'automated_draft_revision', 'priorVersion': value.get('version', 1),
        'priorSha256': descriptor['sha256'],
        'reason': 'Current specification mapping, atomic evidence rules, independent controls and concrete scenario preparation.',
        'humanVerified': False, 'actualProductRun': False}
    return revised


def write_inventory(root, provenance):
    target = root/'manifests/inventory.json'
    write_new(target, {'schemaVersion': 2, 'kind': 'single_current_dataset',
                       'datasetId': 'flowmate-invoices', 'revision': 1,
                       'createdAt': datetime.now(timezone.utc).isoformat(),
                       'migrationProvenance': provenance,
                       'files': [file_info(p, root) for p in sorted(root.rglob('*'))
                                 if p.is_file() and p != target]})


def rebuild_audit(project, source, target, cases, splits):
    """Reuse checked image analysis only; rebuild catalog-dependent review queues."""
    from audit_invoice_assets import build_batches
    old = source/'manifests/audit'
    if not old.exists():
        old = source/'manifests/audit-v1'
    report = read_json(old/'audit-report.json')
    if report['sourceManifestSha256'] != digest(project/'data/invoices/voxel51/manifest.json'):
        raise ValueError('Near-duplicate analysis belongs to different originals')
    if report['splitManifestSha256'] != digest(source/'manifests/splits.json'):
        raise ValueError('Near-duplicate analysis belongs to different splits')
    destination = target/'manifests/audit'
    destination.mkdir(parents=True)
    for name in ('sample-features.json', 'near-duplicate-pairs.jsonl', 'near-duplicate-groups.json'):
        shutil.copy2(old/name, destination/name)
    features = read_json(destination/'sample-features.json')['samples']
    feature_index = {s['sampleId']: s for s in features}
    members = copy.deepcopy(splits['samples'])
    for entry in members:
        entry['hasPublisherLabels'] = feature_index[entry['sampleId']]['hasPublisherLabels']
    batches = build_batches(members, cases)
    write_new(destination/'batches.json', {'kind': 'cumulative_review_batches',
              'selectionPolicy': 'family_coverage_then_category_share_with_input_closure', 'batches': batches})
    case_index = {c['id']: c for c in cases}
    sample_index = {s['sampleId']: s for s in members}
    with (destination/'review-queue.csv').open('x', encoding='utf-8-sig', newline='') as stream:
        writer = csv.DictWriter(stream, fieldnames=['assetKind', 'assetId', 'firstBatch', 'split', 'assetRef', 'status'])
        writer.writeheader()
        seen = set()
        for batch in batches:
            for kind in ('gold', 'business', 'cases'):
                for identity in batch[kind]:
                    if (kind, identity) in seen:
                        continue
                    seen.add((kind, identity))
                    asset = case_index[identity] if kind == 'cases' else sample_index[identity]
                    ref = canonical_path('case', asset) if kind == 'cases' else f'{kind}/{identity}.json'
                    writer.writerow(dict(assetKind=kind, assetId=identity, firstBatch=batch['batchId'],
                                         split=asset['split'], assetRef=ref, status='review_pending'))
    report.update(kind='machine_asset_audit', revision=2,
                  analysisReuse={'sourceAuditSha256': digest(old/'audit-report.json'),
                                 'reason': 'Original bytes, source analysis and split membership unchanged; queues rebuilt.'},
                  splitManifestSha256=digest(target/'manifests/splits.json'),
                  caseCatalogSha256=digest(target/'manifests/case-catalog.json'),
                  batches=[{k: b[k] for k in ('batchId', 'counts', 'coveredFamilyCount', 'uncoveredFamilies',
                                            'goldSplitLabelCounts', 'businessSplitLabelCounts')} for b in batches])
    report.pop('version', None)
    write_new(destination/'audit-report.json', report)
    return report


def stage(project, output, legacy_release=None):
    project, output = Path(project).resolve(), Path(output).resolve()
    staging_root = project/'data/.preparation-stage'
    if not output.is_relative_to(staging_root) or output == staging_root or output.exists():
        raise ValueError('Output must be a new descendant of project/data/.preparation-stage')
    source = project/'agent-eval/data'
    snapshot = checked_snapshot(source)
    if read_json(source/'manifests/inventory.json').get('kind') == 'single_current_dataset':
        raise ValueError('Already consolidated; use explicit review/audit maintenance instead of reassigning current cases')
    verify_retirable(source)
    from review_invoice_data import resolve_asset_index, resolve_asset, make_review_form
    from invoice_requirements import load_requirements, enrich_cases, build_coverage, validate_coverage
    index = resolve_asset_index(project, legacy_release)
    values = {kind: [] for kind in ('gold', 'business', 'case', 'policy')}
    for (kind, identity), _ in sorted(index.items()):
        resolved = resolve_asset(project, legacy_release, kind, identity, index)
        value = copy.deepcopy(resolved['value'])
        if kind == 'case':
            value = revise_case(value, resolved['file'])
        # Retired draft references become self-contained provenance, not dangling file links.
        if 'parentAsset' in value:
            value['priorDraftProvenance'] = {'sha256': value['parentAsset']['sha256']}
            value.pop('parentAsset', None)
            value.pop('parentRelease', None)
        values[kind].append(value)
    requirements = load_requirements(project)
    cases = enrich_cases(values['case'], requirements)
    coverage = build_coverage(cases, requirements)
    validate_coverage(cases, requirements, coverage)
    output.mkdir(parents=True)
    shutil.copytree(source/'source-labels', output/'source-labels')
    for kind in ('gold', 'business', 'policy'):
        for value in values[kind]:
            write_new(output/canonical_path(kind, value), value)
    for value in values['gold']:
        write_new(output/f'manifests/review-forms/{value["sampleId"]}.json', make_review_form(value))
    for case in cases:
        write_new(output/canonical_path('case', case), case)
    catalog = read_json(source/'manifests/case-catalog.json')
    families = {}
    for case in cases:
        category, identity = case['familyId'].split('/', 1)
        families.setdefault(case['familyId'], {'category': category, 'id': identity, 'title': case['title'],
                                               'phase': case['stage'], 'benchmarks': case['benchmarks']})
    catalog.update(version='current', families=list(families.values()), cases=[{
        **{k: c[k] for k in ('id', 'category', 'familyId', 'sampleId', 'semanticScenarioKey', 'replicaIndex',
                            'sampleRole', 'split', 'stage', 'benchmarks')},
        'path': canonical_path('case', c)} for c in cases])
    write_new(output/'manifests/case-catalog.json', catalog)
    splits = read_json(source/'manifests/splits.json')
    for split, members in splits['members'].items():
        members['cases'] = [c['id'] for c in cases if c['split'] == split]
    write_new(output/'manifests/splits.json', splits)
    views = read_json(source/'manifests/views.json')
    views['stages'] = {f'P{i}': [c['id'] for c in cases if c['stage'] == f'P{i}'] for i in range(14)}
    views['benchmarks'] = {f'BM-{i:02}': [c['id'] for c in cases if f'BM-{i:02}' in c['benchmarks']] for i in range(1, 13)}
    write_new(output/'manifests/views.json', views)
    write_new(output/'manifests/requirements.json', requirements)
    write_new(output/'manifests/coverage.json', coverage)
    shutil.copy2(source/'manifests/review-queue.csv', output/'manifests/review-queue.csv')
    audit_report = rebuild_audit(project, source, output, cases, splits)
    sys.path.insert(0, str(project/'agent-eval/src'))
    from runner.materialize import audit
    materialization = audit(project, output/'manifests/materialization', data_root=output)
    report = read_json(source/'manifests/preparation-report.json')
    semantic = Counter(c['semanticScenarioKey'] for c in cases)
    report.update(version='current', datasetId='flowmate-invoices', revision=1,
                  migrationProvenance=snapshot,
                  scenarioFamilies=len(families), scenarioFamilyCounts=dict(Counter(f['category'] for f in families.values())),
                  distinctSemanticScenarioKeys=len(semantic), replicaInstancesBeyondFirst=sum(n-1 for n in semantic.values()),
                  mechanismAllocationOnlyInstances=sum(c['sampleRole'] == 'allocation_anchor_only' for c in cases),
                  materialization=materialization, requirementsCoverage=coverage.get('summary', {}),
                  currentLayout={'audit': 'manifests/audit', 'materialization': 'manifests/materialization',
                                 'inventory': 'manifests/inventory.json'},
                  historicalDraftDirectoriesRetired=True)
    write_new(output/'manifests/preparation-report.json', report)
    (output/'README.md').write_text(QUALITY_README, encoding='utf-8')
    (output/'runs').mkdir()
    (output/'runs/README.md').write_text('这里只保存实际运行的证据与报告。当前实际产品运行数为 0。离线夹具位于 manifests/materialization/。\n', encoding='utf-8')
    write_inventory(output, snapshot)
    checked_snapshot(output)
    return {'status': 'staged_not_published', 'output': str(output), 'cases': len(cases),
            'families': len(families), 'semanticScenarios': len(semantic), 'actualProductRuns': 0,
            'humanVerifiedInvoices': 0, 'batches': audit_report['batches']}


QUALITY_README = '''# Flowmate 质量数据

这里只有一套当前数据；资产身份、修订号与内容摘要记录在文件中。

- `source-labels/`：提供方标签，不能当成人工答案。
- `gold/`：1,200 份字段核验候选，等待实际人工核验。
- `business/`：600 套模拟资料，金额不能用作原票答案。
- `cases/`：七类共 6,000 个固定用例，未声称实际执行。
- `manifests/inventory.json`：所有质量文件的唯一摘要清单。
- `manifests/requirements.json`、`coverage.json`：主方案条目及检查级覆盖和缺口。
- `manifests/audit/`：近重复线索、累计核验批次和综合任务单。
- `manifests/materialization/`：离线夹具和依赖缺口，不是产品运行证据。
- `manifests/review-forms/`：原票核验空表；实际评审通过审核入口提交。
- `runs/`：实际执行后才写入证据；当前产品运行数为 0。

业务 Agent 只能读取当前用例投影的获准输入，不能遍历此目录。
使用 `python agent-eval/tools/verify_invoice_data.py --project .` 检查；
制作流程和各目录职责见 `docs/data-preparation.md`。
'''


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--project', type=Path, default=Path.cwd())
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--legacy-release', help='Only for resolving a previous machine-draft delta during migration')
    args = parser.parse_args()
    print(json.dumps(stage(args.project, args.output, args.legacy_release), ensure_ascii=False, indent=2))
