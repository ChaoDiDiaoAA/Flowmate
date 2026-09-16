"""Human-authored review intake. Never supplies a human identity or approves blank forms.

Recorded attestations are supplied by an actual reviewer, not authenticated identities.
Current datasets use one checked inventory and canonical asset paths.
Legacy release readers remain available for importing older preparations.
"""
from __future__ import annotations

import argparse
import copy
from datetime import datetime, timezone
import json
from pathlib import Path
import re

from prepare_invoice_data import digest, file_info, read_json, safe_relative, write_new
from harness_paths import canonical_case_path, list_current_case_paths

HEADER_FIELDS = ('invoice_number', 'invoice_date', 'due_date', 'buyer_name', 'buyer_address',
                 'buyer_tax_id', 'seller_name', 'seller_address', 'seller_tax_id', 'currency',
                 'net_amount', 'tax_amount', 'tax_rate', 'total_amount', 'discount_amount')
LINE_FIELDS = ('description', 'quantity', 'unit', 'unit_price', 'net_amount', 'tax_rate', 'tax_amount', 'total_price')
STATES = {'confirmed', 'source_not_provided', 'unreadable', 'ambiguous', 'not_applicable', 'clarification_required'}
AVAILABILITY = {'present', 'omitted', 'unreadable', 'not_applicable', 'unknown'}


def need(condition, reason):
    if not condition:
        raise ValueError(reason)


def quality_root(project):
    return Path(project).resolve() / 'agent-eval/data'


def valid_id(value):
    need(isinstance(value, str) and re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.-]{0,100}', value), 'Invalid identity')
    return value


def empty_field(candidate=None):
    return {'candidateReferenceOnly': candidate, 'rawValue': None, 'normalizedValue': None,
            'valueState': 'unverified', 'inputAvailability': 'unverified',
            'alternatives': [], 'evidence': [], 'notes': ''}


def make_review_form(base):
    form = {'schemaVersion': 2, 'kind': 'human_gold_review', 'sampleId': base['sampleId'],
            'baseVersion': base['version'], 'reviewers': [],
            'coverage': {'headerReviewed': False, 'lineItemsReviewed': False,
                         'totalsReviewed': False, 'sourceParseCompared': False},
            'fields': {}, 'lineItems': [], 'notes': '',
            'instructions': '由实际核验人员逐字段核对原图并填写；候选仅供参考，禁止自动批量确认。'}
    for key in HEADER_FIELDS:
        old = base.get('fields', {}).get(key, {})
        candidate = old.get('normalizedValue', old.get('candidateValue'))
        form['fields'][key] = empty_field(candidate)
    for line in base.get('lineItems', []):
        form['lineItems'].append({'rowIndex': line['rowIndex'],
                                  'fields': {key: empty_field(line.get('candidates', {}).get(key, {}).get('candidateValue'))
                                             for key in LINE_FIELDS}})
    return form


def validate_reviewers(reviewers, attestation='attestsOriginalImageReview'):
    need(isinstance(reviewers, list) and 1 <= len(reviewers) <= 2, 'One primary and optional independent secondary reviewer required')
    ids = set()
    for index, reviewer in enumerate(reviewers):
        need(isinstance(reviewer, dict), 'Invalid reviewer record')
        identity = reviewer.get('reviewerId')
        need(isinstance(identity, str) and identity.strip() and identity.strip().casefold() not in ids, 'Reviewer identity missing or repeated')
        need(reviewer.get('performedBy') == 'human' and reviewer.get(attestation) is True,
             'Review must be attested by an actual human')
        need(reviewer.get('role') == ('primary' if index == 0 else 'secondary'), 'Reviewer role/order differs')
        stamp = datetime.fromisoformat(reviewer.get('reviewedAt', '').replace('Z', '+00:00'))
        need(stamp.tzinfo is not None and stamp <= datetime.now(timezone.utc), 'Review time must have timezone and not be in the future')
        ids.add(identity.strip().casefold())


def validate_field(value, sid, product):
    need(isinstance(value, dict) and value.get('valueState') in STATES, 'Field has not been reviewed')
    need(value.get('inputAvailability') in AVAILABILITY, 'Input availability not reviewed')
    if value['valueState'] == 'clarification_required':
        need(value.get('expectedAction') == 'request_clarification' and
             isinstance(value.get('clarificationReason'), str) and value['clarificationReason'].strip(),
             'Clarification Gold requires an explicit expected action and reason')
    if value['valueState'] == 'confirmed':
        need(isinstance(value.get('rawValue'), str) and isinstance(value.get('normalizedValue'), str)
             and value['rawValue'].strip() and value['normalizedValue'].strip(), 'Confirmed field needs raw and normalized strings')
    else:
        need(value.get('normalizedValue') is None, 'Uncertain/absent fields cannot contain a definite normalized answer')
    if value['valueState'] == 'ambiguous':
        need(isinstance(value.get('alternatives'), list) and len(value['alternatives']) >= 2
             and all(isinstance(x,str) and x.strip() for x in value['alternatives'])
             and len(set(value['alternatives'])) == len(value['alternatives']), 'Ambiguous field needs distinct alternative interpretations')
    evidence = value.get('evidence')
    need(isinstance(evidence, list) and evidence, 'Every field requires actual source evidence, including absence/ambiguity')
    pages = read_json(product / sid / 'pages.json')
    need(any(e.get('asset') == sid + '/original.jpg' for e in evidence), 'At least one original-image review reference is required')
    for entry in evidence:
        need(isinstance(entry, dict), 'Invalid evidence')
        asset = entry.get('asset', '')
        need(asset in (sid + '/original.jpg', sid + '/content.json', sid + '/pages.json'), 'Evidence must belong to the reviewed invoice')
        path = safe_relative(product, asset)
        need(path.is_file(), 'Evidence file missing')
        page = entry.get('pageNumber')
        need(type(page) is int and 1 <= page <= len(pages), 'Evidence page out of bounds')
        need(isinstance(entry.get('note'), str) and entry['note'].strip(), 'Evidence requires a locating or absence explanation')
        if 'pointer' in entry:
            need(asset.endswith('/content.json') and re.fullmatch(r'/\d+', entry['pointer']), 'Only concrete content-block pointers accepted')
            blocks = read_json(path)
            idx = int(entry['pointer'][1:])
            need(idx < len(blocks) and blocks[idx].get('page_idx', 0) + 1 == page, 'Evidence block/page mismatch')
        if 'bbox' in entry:
            need(entry.get('coordinateSpace') in ('source_native', 'image_pixels'), 'Evidence bbox coordinate system must be explicit')
            need(isinstance(entry['bbox'], list) and len(entry['bbox']) == 4
                 and all(type(x) in (int, float) for x in entry['bbox']), 'Invalid bounding box')


def validate_review(form, base, product_root):
    need(form.get('kind') == 'human_gold_review' and form.get('sampleId') == base['sampleId']
         and form.get('baseVersion') == base['version'], 'Review/base identity mismatch')
    validate_reviewers(form.get('reviewers'))
    coverage = form.get('coverage', {})
    need(all(coverage.get(k) is True for k in ('headerReviewed', 'lineItemsReviewed', 'totalsReviewed', 'sourceParseCompared')),
         'Whole-document coverage has not been attested')
    fields = form.get('fields', {})
    need(set(fields) == set(HEADER_FIELDS), 'Header review is incomplete or contains unsupported keys')
    for value in fields.values():
        validate_field(value, base['sampleId'], Path(product_root))
    lines = form.get('lineItems')
    need(isinstance(lines, list), 'Line review list is required')
    need([line.get('rowIndex') for line in lines] == list(range(len(lines))), 'Line indices must be consecutive and preserve reviewed order')
    need(len(lines) >= len(base.get('lineItems', [])) or form.get('lineCountCorrectionReason'), 'Removing candidate rows requires a documented correction')
    for line in lines:
        need(set(line.get('fields', {})) == set(LINE_FIELDS), 'Line review is incomplete')
        for value in line['fields'].values():
            validate_field(value, base['sampleId'], Path(product_root))
    if form.get('lineItemsExpectation'):
        expectation = form['lineItemsExpectation']
        need(expectation.get('state') == 'clarification_required' and
             expectation.get('expectedAction') == 'request_clarification' and
             isinstance(expectation.get('reason'), str) and expectation['reason'].strip(),
             'Unresolved line items require an explicit clarification expectation')
    return True


def freeze_v1(project):
    need(not is_current_dataset(project), 'Current datasets use the single inventory; legacy freezing is disabled')
    root = quality_root(project)
    inventory_path = root / 'manifests/inventory.json'
    inventory = read_json(inventory_path)
    version = valid_id(inventory['version'])
    target = root / 'manifests/releases' / (version + '.json')
    if target.exists():
        release = read_json(target)
        need(release['inventory']['sha256'] == digest(inventory_path), 'Frozen inventory changed')
        return release
    assets = []
    for descriptor in inventory['files']:
        path = descriptor['path']
        if re.fullmatch(r'gold/\d{6}\.json', path):
            candidate = read_json(safe_relative(root, path))
            need(digest(root / path) == descriptor['sha256'], 'v1 candidate differs from original inventory')
            assets.append({'kind': 'gold', 'sampleId': candidate['sampleId'], 'version': candidate['version'], 'file': descriptor})
    release = {'schemaVersion': 1, 'id': version, 'parentRelease': None,
               'kind': 'immutable_preparation_snapshot', 'createdAt': datetime.now(timezone.utc).isoformat(),
               'inventory': file_info(inventory_path, root),
               'productManifestSha256': digest(Path(project) / 'data/invoices/voxel51/manifest.json'),
               'assets': assets, 'humanVerifiedCount': 0, 'formalAcceptanceEligible': False}
    write_new(target, release)
    return release


def resolve_release(project, release_id=None):
    if is_current_dataset(project):
        index = current_asset_index(project)
        validate_current_assets(quality_root(project), Path(project)/'data/invoices/voxel51')
        gold = {identity: resolve_asset(project, None, kind, identity, index)['value']
                for kind, identity in index if kind == 'gold'}
        return {'id': 'current', 'gold': gold,
                'descriptors': {identity: index[('gold', identity)]['file'] for identity in gold},
                'humanVerifiedCount': sum(v.get('humanVerified') is True for v in gold.values()),
                'formalAcceptanceEligible': False, 'identityVerification': 'submitter_attestation_only'}
    root = quality_root(project)
    chain = []
    seen = set()
    current = valid_id(release_id)
    while current:
        need(current not in seen and len(chain) < 10000, 'Release cycle or excessive depth')
        seen.add(current)
        release = read_json(root / 'manifests/releases' / (valid_id(current) + '.json'))
        need(release['id'] == current, 'Release identity differs from filename')
        chain.append(release)
        current = release.get('parentRelease')
    gold = {}
    descriptors = {}
    for release in reversed(chain):
        if release.get('inventory'):
            path = safe_relative(root, release['inventory']['path'])
            need(digest(path) == release['inventory']['sha256'], 'Base inventory hash changed')
            need(digest(Path(project)/'data/invoices/voxel51/manifest.json') == release['productManifestSha256'], 'Product manifest changed')
        for asset in release['assets']:
            if asset['kind'] != 'gold':
                continue
            path = safe_relative(root, asset['file']['path'])
            need(digest(path) == asset['file']['sha256'], 'Pinned asset changed')
            value = read_json(path)
            need(value['sampleId'] == asset['sampleId'] and value['version'] == asset['version'], 'Pinned asset identity mismatch')
            if asset['version'] > 1:
                need(asset['sampleId'] in gold, 'Reviewed asset has no parent')
                snapshot = verify_source_snapshot(Path(project)/'data/invoices/voxel51', asset['sampleId'])
                need(value.get('sourceSnapshot') == snapshot, 'Reviewed source snapshot changed')
                validate_review(value['reviewSubmission'], gold[asset['sampleId']], Path(project)/'data/invoices/voxel51')
                need(value['humanVerified'] is True and value['reviewedBy'] == [r['reviewerId'] for r in value['reviewSubmission']['reviewers']], 'False review identity')
                need(value['fields'] == value['reviewSubmission']['fields'] and value['lineItems'] == value['reviewSubmission']['lineItems'], 'Reviewed values differ from attested submission')
            gold[asset['sampleId']] = value
            descriptors[asset['sampleId']] = asset['file']
    return {'id': release_id, 'gold': gold, 'descriptors': descriptors,
            'humanVerifiedCount': sum(v.get('humanVerified') is True for v in gold.values()),
            'formalAcceptanceEligible': False,
            'limitations': ['审核身份来自提交者声明，工具不提供身份认证', '正式验收仍需用例/划分/能力及评分证据就绪']}


def verify_source_snapshot(product, sid):
    """Verify actual bytes through the release-pinned manifest and metadata."""
    manifest = read_json(product/'manifest.json')
    members = [s for s in manifest['samples'] if s['sampleId'] == sid]
    need(len(members) == 1, 'Source sample missing or repeated')
    member = members[0]
    meta_path = safe_relative(product, member['metadata']['path'])
    need(member['metadata']['path'] == sid+'/metadata.json', 'Source metadata identity mismatch')
    need(file_info(meta_path, product) == member['metadata'], 'Source metadata bytes changed')
    metadata = read_json(meta_path)
    need(metadata['sampleId'] == sid and metadata['originalSha256'] == member['originalSha256'], 'Source identity changed')
    files = metadata['files']
    names = [f['path'] for f in files]
    need(len(names) == len(set(names)) and {'original.jpg','content.json','pages.json'}.issubset(names), 'Source descriptors incomplete')
    sample = product/sid
    for descriptor in files:
        path = safe_relative(sample, descriptor['path'])
        need(file_info(path, sample) == descriptor, 'Source file bytes changed: '+descriptor['path'])
    need(digest(sample/'original.jpg') == member['originalSha256'], 'Original digest differs')
    return {'productManifestSha256':digest(product/'manifest.json'),
            'metadata':copy.deepcopy(member['metadata']), 'files':copy.deepcopy(files)}


def publish_review(project, form, base_release, release_id):
    need(not is_current_dataset(project), 'Use submit_asset_review for the current dataset')
    root = quality_root(project)
    release_id = valid_id(release_id)
    release_path = root / 'manifests/releases' / (release_id + '.json')
    if release_path.exists():
        raise FileExistsError(release_path)
    parent = resolve_release(project, base_release)
    sid = form.get('sampleId')
    need(sid in parent['gold'], 'Unknown reviewed sample')
    base = parent['gold'][sid]
    source_snapshot = verify_source_snapshot(Path(project)/'data/invoices/voxel51', sid)
    validate_review(form, base, Path(project)/'data/invoices/voxel51')
    value = {'schemaVersion': 2, 'id': base['id'], 'version': base['version'] + 1,
             'sampleId': sid, 'split': base['split'], 'parentRelease': base_release,
             'parentAsset': parent['descriptors'][sid], 'status': 'human_reviewed',
             'humanVerified': True, 'reviewLevel': 'double_human' if len(form['reviewers']) == 2 else 'single_human',
             'reviewedBy': [r['reviewerId'] for r in form['reviewers']],
             'reviewedAt': form['reviewers'][-1]['reviewedAt'],
             'acceptedGoldVersion': base['version'] + 1,
             'fields': copy.deepcopy(form['fields']), 'lineItems': copy.deepcopy(form['lineItems']),
             'reviewSubmission': copy.deepcopy(form), 'eligibleForFieldScoring': True,
             'formalAcceptanceEligible': False, 'sourceEvidence': base.get('sourceEvidence'),
             'sourceSnapshot': source_snapshot}
    # Separate immutable file: concurrent branches cannot overwrite each other's v2.
    target = root / 'gold' / f'{sid}.{release_id}.v{value["version"]}.json'
    write_new(target, value)
    release = {'schemaVersion': 1, 'id': release_id, 'kind': 'human_review_delta', 'parentRelease': base_release,
               'createdAt': datetime.now(timezone.utc).isoformat(),
               'assets': [{'kind': 'gold', 'sampleId': sid, 'version': value['version'], 'file': file_info(target, root)}],
               'formalAcceptanceEligible': False, 'identityVerification': 'submitter_attestation_only'}
    write_new(release_path, release)
    return value


def resolve_asset_index(project, release_id=None):
    """Build a fixed release index once; callers still hash each resolved asset."""
    if is_current_dataset(project):
        return current_asset_index(project)
    root = quality_root(project)
    chain, seen = [], set()
    current = valid_id(release_id)
    while current:
        need(current not in seen, 'Release cycle')
        seen.add(current)
        record = read_json(root/'manifests/releases'/f'{valid_id(current)}.json')
        need(record['id'] == current, 'Release identity mismatch')
        chain.append(record)
        current = record.get('parentRelease')
    index = {}
    for record in reversed(chain):
        if record.get('inventory'):
            inventory_path = safe_relative(root, record['inventory']['path'])
            need(digest(inventory_path) == record['inventory']['sha256'], 'Frozen inventory changed')
            need(digest(Path(project)/'data/invoices/voxel51/manifest.json') == record['productManifestSha256'], 'Frozen product manifest changed')
            for entry in read_json(inventory_path)['files']:
                path = entry['path']
                if re.fullmatch(r'gold/\d{6}\.json', path):
                    key = ('gold', Path(path).stem)
                elif re.fullmatch(r'business/\d{6}\.json', path):
                    key = ('business', 'business-' + Path(path).stem)
                elif re.fullmatch(r'cases/[^/]+/[^/]+\.json', path):
                    key = ('case', Path(path).stem)
                elif path == 'manifests/fixture-policy.json':
                    key = ('policy', read_json(root/path)['id'])
                else:
                    continue
                index[key] = {'file': entry, 'version': 1}
        for asset in record['assets']:
            asset_id = asset.get('id', asset.get('sampleId'))
            index[(asset['kind'], asset_id)] = {'file': asset['file'], 'version': asset['version']}
    return index


def resolve_asset(project, release_id, kind, asset_id, index=None):
    index = resolve_asset_index(project, release_id) if index is None else index
    need((kind, asset_id) in index, 'Unknown pinned asset')
    descriptor = index[(kind, asset_id)]
    path = safe_relative(quality_root(project), descriptor['file']['path'])
    need(digest(path) == descriptor['file']['sha256'], 'Pinned asset changed')
    value = read_json(path)
    need(value.get('version', 1) == descriptor['version'], 'Pinned version mismatch')
    identity = value.get('sampleId') if kind == 'gold' else value.get('id')
    need(identity == asset_id, 'Pinned asset identity mismatch')
    return {'value': value, 'file': descriptor['file']}


def publish_asset_revisions(project, changes, base_release, release_id, reason):
    """Publish automated draft changes, never human reviews or executable outcomes."""
    need(not is_current_dataset(project), 'Legacy delta publishing is disabled for the current dataset')
    root = quality_root(project)
    release_path = root/'manifests/releases'/f'{valid_id(release_id)}.json'
    if release_path.exists():
        raise FileExistsError(release_path)
    need(isinstance(reason, str) and reason.strip() and changes, 'Revision reason and changed assets are required')
    index = resolve_asset_index(project, base_release)
    staged = []
    seen = set()
    for change in changes:
        kind, identity = change['kind'], valid_id(change['id'])
        need(kind in ('business', 'case', 'policy') and (kind, identity) not in seen, 'Unsupported/repeated draft revision')
        seen.add((kind, identity))
        prior = resolve_asset(project, base_release, kind, identity, index)
        value = copy.deepcopy(change['value'])
        need(value.get('id') == identity and value.get('sampleId') == prior['value'].get('sampleId'), 'Draft identity or source cannot change')
        if kind == 'case':
            need(value.get('category') == prior['value']['category'] and value.get('split') == prior['value']['split'], 'Case category or split changed without a split migration')
            value.update(materialStatus='draft_generated', reviewStatus='pending', executionStatus='not_run', eligibleForAcceptance=False)
            folder = Path(canonical_case_path(value)).parent.as_posix()
        elif kind == 'business':
            need(value.get('split') == prior['value']['split'], 'Business split changed')
            value.update(status='review_pending', humanVerified=False)
            folder = 'business'
        else:
            value.update(status='review_pending')
            folder = 'manifests'
        value.update(version=prior['value'].get('version', 1)+1,
                     parentAsset=prior['file'], parentRelease=base_release,
                     revisionProvenance={'kind':'automated_draft_revision','reason':reason,'humanVerified':False})
        target = root/folder/f'{identity}.{release_id}.v{value["version"]}.json'
        if target.exists():
            raise FileExistsError(target)
        staged.append((target,value,kind,identity))
    assets=[]
    for target,value,kind,identity in staged:
        write_new(target,value)
        assets.append({'kind':kind,'id':identity,'version':value['version'],'file':file_info(target,root)})
    release={'schemaVersion':1,'id':release_id,'kind':'automated_draft_delta','parentRelease':base_release,
             'createdAt':datetime.now(timezone.utc).isoformat(),'assets':assets,'reason':reason,
             'humanReviewsPerformed':0,'formalAcceptanceEligible':False}
    write_new(release_path,release)
    return release


def register_workflow_files(project):
    """Append new artifacts to an extension index; reject changes to already indexed files."""
    if is_current_dataset(project):
        return refresh_inventory(project)
    root = quality_root(project)
    baseline = read_json(root/'manifests/inventory.json')
    original = {f['path']: f for f in baseline['files']}
    index_path = root / 'manifests/workflow-inventory.json'
    prior = read_json(index_path) if index_path.exists() else {'files': []}
    for descriptor in prior['files']:
        need(digest(safe_relative(root, descriptor['path'])) == descriptor['sha256'], 'Previously indexed workflow artifact changed')
    descriptors = []
    for path in sorted(root.rglob('*')):
        if not path.is_file():
            continue
        relative = path.relative_to(root).as_posix()
        if relative in original:
            need(digest(path) == original[relative]['sha256'], 'v1 file changed: ' + relative)
            continue
        if relative in ('manifests/inventory.json', 'manifests/workflow-inventory.json'):
            continue
        need(relative.startswith(('manifests/', 'gold/', 'business/', 'cases/', 'runs/')), 'Unexpected quality artifact')
        descriptors.append(file_info(path, root))
    inventory = {'schemaVersion': 1, 'kind': 'append_only_workflow_index',
                 'baseInventorySha256': digest(root/'manifests/inventory.json'),
                 'files': descriptors, 'updatedAt': datetime.now(timezone.utc).isoformat()}
    temporary = root / 'manifests/workflow-inventory.next.json'
    write_new(temporary, inventory)
    temporary.replace(index_path)
    return inventory


def initialize(project):
    if is_current_dataset(project):
        index = current_asset_index(project)
        created = []
        root = quality_root(project)
        for kind, identity in index:
            if kind != 'gold':
                continue
            path = root/'manifests/review-forms'/(identity+'.json')
            if not path.exists():
                write_new(path, make_asset_review_form(project, kind, identity, index=index))
                created.append(path.relative_to(root).as_posix())
        refresh_inventory(project, created)
        return {'dataset': 'current', 'newBlankReviewForms': len(created), 'humanReviewsPerformed': 0}
    root = quality_root(project)
    release = freeze_v1(project)
    destination = root/'manifests/review-forms'
    exported = 0
    for item in release['assets']:
        target = destination / (item['sampleId'] + '.json')
        if not target.exists():
            base = read_json(root/item['file']['path'])
            write_new(target, make_review_form(base))
            exported += 1
    register_workflow_files(project)
    return {'baseRelease': release['id'], 'newBlankReviewForms': exported, 'humanReviewsPerformed': 0}


CURRENT_CHECKS = {
    'gold': ('sourceIntegrity', 'fieldCoverage', 'uncertainty', 'splitAndExposure'),
    'business': ('sourceIntegrity', 'syntheticBoundary', 'businessFacts', 'oracle', 'policyApplicability', 'splitAndExposure'),
    'case': ('sourceIntegrity', 'requirements', 'preconditions', 'checksAndOracle', 'evidenceContract', 'splitAndExposure'),
    'policy': ('scope', 'rules', 'oracle', 'exceptions', 'splitAndExposure'),
}


def is_current_dataset(project):
    return read_json(quality_root(project)/'manifests/inventory.json').get('kind') == 'single_current_dataset'


def _checked_inventory(project, authorized_paths=()):
    root = quality_root(project)
    inventory = read_json(root/'manifests/inventory.json')
    need(inventory.get('kind') == 'single_current_dataset', 'Expected a single current dataset')
    allowed = set(authorized_paths)
    for relative in allowed:
        need(isinstance(relative, str) and relative != 'manifests/inventory.json', 'Invalid authorized path')
        safe_relative(root, relative)
    original = {entry['path']: entry for entry in inventory['files']}
    need(len(original) == len(inventory['files']), 'Duplicate inventory path')
    actual = {p.relative_to(root).as_posix(): p for p in root.rglob('*') if p.is_file()
              and p != root/'manifests/inventory.json'}
    need((set(original) ^ set(actual)) <= allowed, 'Unregistered or missing quality files')
    for relative, entry in original.items():
        safe_relative(root, relative)
        if relative not in allowed:
            need(relative in actual and file_info(actual[relative], root) == entry,
                 'Previously indexed file changed: ' + relative)
    if inventory.get('productManifestSha256'):
        need(digest(Path(project)/'data/invoices/voxel51/manifest.json') == inventory['productManifestSha256'],
             'Product manifest changed')
    return inventory, actual


def verify_current_inventory(project):
    return _checked_inventory(project)[0]


def refresh_inventory(project, authorized_paths=()):
    """Refresh exact authorized paths only; reject unrelated changed/new/deleted bytes.

    Callers must verify the old inventory before performing their declared mutation.
    This local integrity mechanism does not authenticate or sign its callers.
    """
    inventory, actual = _checked_inventory(project, authorized_paths)
    root = quality_root(project)
    updated = copy.deepcopy(inventory)
    updated['files'] = [file_info(actual[key], root) for key in sorted(actual)]
    updated['updatedAt'] = datetime.now(timezone.utc).isoformat()
    _replace_json(root/'manifests/inventory.json', updated)
    return updated


def _replace_json(path, value):
    import os
    import tempfile
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, name = tempfile.mkstemp(prefix='.review-', suffix='.tmp', dir=path.parent)
    temporary = Path(name)
    try:
        with os.fdopen(fd, 'w', encoding='utf-8') as stream:
            json.dump(value, stream, ensure_ascii=False, indent=2)
            stream.write('\n')
        temporary.replace(path)
    finally:
        temporary.unlink(missing_ok=True)


def current_asset_index(project):
    inventory = verify_current_inventory(project)
    root = quality_root(project)
    case_paths = {p.relative_to(root).as_posix() for p in list_current_case_paths(root)}
    index = {}
    for entry in inventory['files']:
        relative = entry['path']
        kind = ('gold' if re.fullmatch(r'gold/[^/]+\.json', relative) else
                'business' if re.fullmatch(r'business/[^/]+\.json', relative) else
                'case' if re.fullmatch(r'cases/[^/]+/[^/]+\.json', relative) else
                'policy' if relative == 'manifests/fixture-policy.json' else None)
        if kind:
            if kind == 'case':
                need(relative in case_paths, 'Inventory case is absent from current catalog')
            value = read_json(root/relative)
            identity = value.get('sampleId') if kind == 'gold' else value.get('id')
            need(identity and (kind, identity) not in index, 'Missing or duplicate asset identity')
            index[(kind, identity)] = {'file': entry, 'version': value.get('version', 1)}
    return index


def make_asset_review_form(project, kind, asset_id, index=None):
    need(kind in CURRENT_CHECKS, 'Unsupported review asset kind')
    base = resolve_asset(project, None, kind, asset_id, index)
    form = {'schemaVersion': 1, 'kind': 'human_asset_review', 'assetKind': kind,
            'assetId': asset_id, 'recordId': '', 'target': copy.deepcopy(base['file']),
            'reviewers': [], 'owner': '', 'decision': 'pending', 'rationale': '',
            'checks': {key: False for key in CURRENT_CHECKS[kind]}, 'evidence': [],
            'disputes': [], 'exposure': {'scope': '', 'reviewed': False, 'notes': ''},
            'identityVerification': 'submitter_attestation_only'}
    if kind == 'gold':
        form['goldReview'] = make_review_form(base['value'])
    return form


def _nonblank(value):
    return isinstance(value, str) and bool(value.strip())


def _review_evidence(root, evidence):
    need(isinstance(evidence, list) and evidence, 'Content review evidence is required')
    for entry in evidence:
        need(isinstance(entry, dict) and _nonblank(entry.get('note')), 'Evidence explanation required')
        path = safe_relative(root, entry.get('path', ''))
        need(path.is_file() and digest(path) == entry.get('sha256'), 'Evidence bytes changed or missing')


def build_asset_review_record(project, submission, prior):
    """Validate a pinned review and build its record without mutating the dataset."""
    root = quality_root(project)
    form = copy.deepcopy(submission)
    need(form.get('kind') == 'human_asset_review', 'Explicit content review form required')
    kind, identity = form.get('assetKind'), form.get('assetId')
    need(kind in CURRENT_CHECKS, 'Unsupported asset kind')
    need(form.get('target') == prior['file'], 'Review target or parent hash differs')
    need(file_info(root/prior['file']['path'],root) == prior['file'] and
         read_json(root/prior['file']['path']) == prior['value'], 'Pinned review base changed')
    record_id = valid_id(form.get('recordId'))
    record_path = root/'manifests/reviews'/(record_id+'.json')
    need(not record_path.exists(), 'Review record already exists')
    validate_reviewers(form.get('reviewers'), 'attestsContentReview')
    need(_nonblank(form.get('owner')) and _nonblank(form.get('rationale')), 'Owner and decision rationale required')
    decision = form.get('decision')
    need(decision in ('accept', 'reject', 'needs_revision'), 'Explicit review decision required')
    need(isinstance(form.get('checks'), dict) and set(form['checks']) == set(CURRENT_CHECKS[kind])
         and all(value is True for value in form['checks'].values()), 'Required content checks incomplete')
    exposure = form.get('exposure', {})
    need(isinstance(exposure, dict) and exposure.get('reviewed') is True and
         _nonblank(exposure.get('scope')) and _nonblank(exposure.get('notes')), 'Exposure assessment required')
    _review_evidence(root, form.get('evidence'))
    disputes = form.get('disputes')
    need(isinstance(disputes, list), 'Dispute register required, including explicit empty list')
    dispute_ids = set()
    for dispute in disputes:
        need(isinstance(dispute, dict), 'Invalid dispute')
        did = valid_id(dispute.get('id'))
        need(did not in dispute_ids and _nonblank(dispute.get('issue')), 'Duplicate or incomplete dispute')
        dispute_ids.add(did)
        need(dispute.get('status') in ('open', 'resolved'), 'Dispute status missing')
        if dispute['status'] == 'resolved':
            need(_nonblank(dispute.get('resolution')), 'Dispute resolution missing')
            validate_reviewers(dispute.get('adjudicators'), 'attestsContentReview')
            _review_evidence(root, dispute.get('evidence'))
        else:
            need(decision != 'accept', 'Unresolved disputes block acceptance')
    value = copy.deepcopy(prior['value'])
    snapshot = None
    if value.get('sampleId'):
        snapshot = verify_source_snapshot(Path(project)/'data/invoices/voxel51', value['sampleId'])
    if kind == 'gold':
        gold_form = form.get('goldReview', {})
        validate_review(gold_form, value, Path(project)/'data/invoices/voxel51')
        need([r['reviewerId'] for r in gold_form['reviewers']] == [r['reviewerId'] for r in form['reviewers']],
             'Gold and content reviewer identities differ')
        value.update(fields=copy.deepcopy(gold_form['fields']), lineItems=copy.deepcopy(gold_form['lineItems']),
                     reviewSubmission=gold_form, sourceSnapshot=snapshot, eligibleForFieldScoring=decision == 'accept')
        if gold_form.get('lineItemsExpectation'):
            value['lineItemsExpectation'] = copy.deepcopy(gold_form['lineItemsExpectation'])
        else:
            value.pop('lineItemsExpectation', None)
    value.update(version=value.get('version', 1)+1, parentAsset=prior['file'],
                 humanVerified=decision == 'accept', reviewStatus='accepted' if decision == 'accept' else decision,
                 status='human_reviewed' if decision == 'accept' else 'review_pending',
                 reviewLevel='double_human' if len(form['reviewers']) == 2 else 'single_human',
                 reviewedBy=[r['reviewerId'] for r in form['reviewers']],
                 reviewedAt=form['reviewers'][-1]['reviewedAt'], owner=form['owner'],
                 contentAcceptance={'decision':decision, 'frozenSha256':prior['file']['sha256'],
                                    'scope':'reviewed_content_only', 'exposure':exposure},
                 reviewRecord=record_path.relative_to(root).as_posix(), formalAcceptanceEligible=False,
                 identityVerification='submitter_attestation_only')
    if kind == 'case':
        value.update(executionStatus='not_run', eligibleForAcceptance=False)
    if kind == 'gold' and decision == 'accept':
        value['acceptedGoldVersion'] = value['version']
    record = {'schemaVersion':1, 'kind':'human_content_review_record', 'id':record_id,
              'assetKind':kind, 'assetId':identity, 'parentAsset':prior['file'],
              'parentValue':prior['value'], 'parentText':(root/prior['file']['path']).read_bytes().decode('utf-8'),
              'resultValue':value, 'submission':form, 'sourceSnapshot':snapshot,
              'createdAt':datetime.now(timezone.utc).isoformat(),
              'identityVerification':'submitter_attestation_only', 'formalAcceptanceEligible':False}
    return record


def submit_asset_review(project, submission, base_release=None, release_id=None):
    """Record declared human review of exact current content, without authenticating it."""
    if not is_current_dataset(project):
        need(submission.get('kind') == 'human_gold_review' and base_release and release_id,
             'Legacy intake requires explicit gold review and parent release')
        return publish_review(project, submission, base_release, release_id)
    root = quality_root(project)
    index = current_asset_index(project)
    kind, identity = submission.get('assetKind'), submission.get('assetId')
    prior = resolve_asset(project, None, kind, identity, index)
    record = build_asset_review_record(project, submission, prior)
    value = record['resultValue']
    record_path = root/value['reviewRecord']
    report_path = root/'manifests/preparation-report.json'
    report = None
    if kind == 'gold' and report_path.exists():
        report = read_json(report_path)
        report['humanVerifiedInvoices'] = sum(
            (value if asset_id == identity else read_json(root/descriptor['file']['path'])).get('humanVerified') is True
            for (asset_kind, asset_id), descriptor in index.items() if asset_kind == 'gold')
    verify_current_inventory(project)
    write_new(record_path, record)
    _replace_json(root/prior['file']['path'], value)
    authorized_paths = [prior['file']['path'], record_path.relative_to(root).as_posix()]
    if report is not None:
        _replace_json(report_path, report)
        authorized_paths.append(report_path.relative_to(root).as_posix())
    refresh_inventory(project, authorized_paths)
    return value


def validate_current_assets(root, product):
    """Validate review lineage using explicit quality and product roots (staging safe).

    Inventory byte validation is the caller's separate responsibility. Identities are
    attestations, not authenticated signatures; product acceptance stays disabled.
    """
    import hashlib
    root, product = Path(root), Path(product)
    assets = list((root/'gold').glob('*.json')) + list((root/'business').glob('*.json'))
    assets += list_current_case_paths(root)
    if (root/'manifests/fixture-policy.json').exists():
        assets.append(root/'manifests/fixture-policy.json')
    for path in assets:
        value = read_json(path)
        claim = (value.get('humanVerified') is True or value.get('reviewStatus') == 'accepted'
                 or value.get('status') == 'human_reviewed' or value.get('eligibleForFieldScoring') is True)
        need(value.get('formalAcceptanceEligible') is not True and value.get('eligibleForAcceptance') is not True,
             'Content review cannot assert formal product acceptance')
        need(not claim or value.get('reviewRecord'), 'Human review claim has no attested record')
        if not value.get('reviewRecord'):
            continue
        record_path = safe_relative(root, value['reviewRecord'])
        need(record_path.parent == root/'manifests/reviews', 'Review record outside review directory')
        record = read_json(record_path)
        need(record.get('resultValue') == value, 'Current content differs from recorded review result')
        need(record.get('kind') == 'human_content_review_record' and record.get('id') == record_path.stem,
             'Review record identity mismatch')
        parent, form = record['parentValue'], record['submission']
        parent_text = record.get('parentText', '')
        need(hashlib.sha256(parent_text.encode('utf-8')).hexdigest() == record['parentAsset']['sha256']
             and json.loads(parent_text) == parent, 'Review parent content/hash mismatch')
        need(record['parentAsset'] == form.get('target') == value.get('parentAsset') and
             form['target']['path'] == path.relative_to(root).as_posix(), 'Review parent path mismatch')
        kind = record['assetKind']
        identity = value.get('sampleId') if kind == 'gold' else value.get('id')
        need(kind in CURRENT_CHECKS and form.get('assetKind') == kind and
             form.get('assetId') == record.get('assetId') == identity, 'Review asset identity mismatch')
        validate_reviewers(form.get('reviewers'), 'attestsContentReview')
        need(_nonblank(form.get('owner')) and _nonblank(form.get('rationale')), 'Review ownership incomplete')
        need(form.get('decision') in ('accept','reject','needs_revision'), 'Review decision invalid')
        need(set(form.get('checks', {})) == set(CURRENT_CHECKS[kind]) and
             all(v is True for v in form['checks'].values()), 'Review checks incomplete')
        exposure = form.get('exposure', {})
        need(exposure.get('reviewed') is True and _nonblank(exposure.get('scope')) and
             _nonblank(exposure.get('notes')), 'Review exposure incomplete')
        def historical_evidence(entries):
            need(isinstance(entries, list) and entries, 'Review evidence missing')
            for entry in entries:
                if entry.get('path') == form['target']['path']:
                    need(entry.get('sha256') == form['target']['sha256'] and _nonblank(entry.get('note')),
                         'Parent evidence mismatch')
                else:
                    _review_evidence(root, [entry])
        historical_evidence(form.get('evidence'))
        disputes = form.get('disputes')
        need(isinstance(disputes, list), 'Disputes missing')
        seen = set()
        for dispute in disputes:
            did = valid_id(dispute.get('id'))
            need(did not in seen and _nonblank(dispute.get('issue')), 'Dispute identity invalid')
            seen.add(did)
            need(dispute.get('status') in ('open','resolved'), 'Dispute status invalid')
            if dispute['status'] == 'resolved':
                need(_nonblank(dispute.get('resolution')), 'Adjudication missing')
                validate_reviewers(dispute.get('adjudicators'), 'attestsContentReview')
                historical_evidence(dispute.get('evidence'))
            else:
                need(form['decision'] != 'accept', 'Unresolved dispute cannot be accepted')
        need(value.get('humanVerified') == (form['decision'] == 'accept') and
             value.get('reviewedBy') == [r['reviewerId'] for r in form['reviewers']] and
             value.get('formalAcceptanceEligible') is False and
             value.get('owner') == form['owner'] and value.get('reviewedAt') == form['reviewers'][-1]['reviewedAt'] and
             value.get('version') == parent.get('version', 1)+1,
             'Review outcome differs from attestation')
        if value.get('sampleId'):
            need(record.get('sourceSnapshot') == verify_source_snapshot(product, value['sampleId']),
                 'Reviewed source snapshot changed')
        if kind == 'gold':
            validate_review(form.get('goldReview', {}), parent, product)
            need(value['fields'] == form['goldReview']['fields'] and value['lineItems'] == form['goldReview']['lineItems'],
                 'Gold fields differ from attested values')
            need(value.get('lineItemsExpectation') == form['goldReview'].get('lineItemsExpectation'),
                 'Line clarification differs from attested expectation')
            need(value.get('eligibleForFieldScoring') == (form['decision'] == 'accept') and
                 [r['reviewerId'] for r in form['goldReview']['reviewers']] == value['reviewedBy'],
                 'Gold scoring eligibility or reviewers differ')
    return True


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--project', type=Path, default=Path.cwd())
    sub = parser.add_subparsers(dest='command', required=True)
    sub.add_parser('initialize')
    inspect = sub.add_parser('inspect', aliases=['inspect-release']); inspect.add_argument('--release')
    export = sub.add_parser('export-form')
    export.add_argument('--sample'); export.add_argument('--release')
    export.add_argument('--kind', choices=list(CURRENT_CHECKS), default='gold')
    export.add_argument('--asset')
    export.add_argument('--output', type=Path, required=True)
    submit = sub.add_parser('submit')
    submit.add_argument('--review', type=Path, required=True)
    submit.add_argument('--base-release')
    submit.add_argument('--release')
    sub.add_parser('register-workflow')
    args = parser.parse_args()
    if args.command == 'initialize':
        result = initialize(args.project)
    elif args.command == 'register-workflow':
        result = {'workflowArtifacts': len(register_workflow_files(args.project)['files'])}
    elif args.command == 'export-form':
        if is_current_dataset(args.project):
            form = make_asset_review_form(args.project, args.kind, args.asset or args.sample)
        else:
            resolved = resolve_release(args.project, args.release)
            need(args.sample in resolved['gold'], 'Unknown sample in release')
            form = make_review_form(resolved['gold'][args.sample])
        write_new(args.output, form)
        if is_current_dataset(args.project) and args.output.resolve().is_relative_to(quality_root(args.project)):
            refresh_inventory(args.project, [args.output.resolve().relative_to(quality_root(args.project)).as_posix()])
        result = {'templateWritten': str(args.output), 'humanReviewPerformed': False}
    elif args.command in ('inspect', 'inspect-release'):
        resolved = resolve_release(args.project, args.release)
        result = {k: v for k, v in resolved.items() if k not in ('gold', 'descriptors')}
        result['goldSamples'] = len(resolved['gold'])
    else:
        reviewed = submit_asset_review(args.project, read_json(args.review), args.base_release, args.release)
        register_workflow_files(args.project)
        result = {'assetId': reviewed.get('id'), 'version': reviewed['version'], 'reviewLevel': reviewed['reviewLevel'],
                  'formalAcceptanceEligible': False}
    print(json.dumps(result, ensure_ascii=False, indent=2))
