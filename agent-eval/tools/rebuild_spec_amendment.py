"""Apply the approved 100/80/548 evaluation-plan amendment with full rebinding.

This is a semantic specification revision, not a formatting rebind.  It accepts
exactly two registered paragraph replacements, preserves every Gold byte and
asset identity, rebuilds business/Case source bindings, refreshes derived
review and Benchmark pins, and grants no human review or product result.
"""
from copy import deepcopy
import hashlib
import json
from pathlib import Path

from rebuild_bindings import (BINDING_3_PINS, CURRENT_BINDING_REVISION,
                              CURRENT_PINS, contract_pins)
from rebuild_case_release import assemble_case_files, canonical_digest, verify_inventory
from rebuild_dataset import json_bytes
from rebuild_sources import file_pin
from rebuild_staging import read_candidate, snapshot_digest


RECEIPT = 'manifests/spec-amendment-review.json'
PREVIOUS_BINDING_REVISION = 3
OLD_EVALUATION_SNAPSHOT = (
    '.cache/dataset-rebuild/spec-snapshots/'
    'evaluation-8b249d8003feaf307b15005696b84f9b60b073a5ffb29b2386ef4b663997933c.md')

OLD_PARAGRAPHS = (
    'development、regression、acceptance 的隔离范围须在数据清单中明确，同票副本和简单扰动不能跨组。当前 voxel51 批次采用已确认的原票及近重复组留出：1,200 份核验候选按 600/200/400 划分，600 套关联模拟资料按 300/100/200 划分；原票组及其衍生资料继承同一用途。当前允许版式或供应商跨集合，报告只能称为原票留出，不能声称未见模板或未见供应商测试。需要验证这些泛化能力时另建明确隔离的成员清单，不复制原图。近重复与暴露审查完成前不冻结验收；验收样本一旦用于调参即标暴露并转开发/回归，后续补独立验收集。其他来源的比例、数量和异常配额由相应阶段方案固定。',
    '历史准备规模（2026-09-17 文档修订时保留，非当日重新盘点）为：2,902 份去重输入、1,200 份人工核验任务、600 套模拟资料、5,577 个用例实例、177 个场景族（抽取 1,200、匹配 890、人工复核与提交确认 487、B2B 提交 800、Runtime 1,000、隔离 800、平台基础验证 400）。退役外部验真、ERP 回写与额度审批等 9 个场景族的 423 例，不通过新增重复实例维持旧数量。已有批量审核声明及绑定内容完整保留，变更后的业务资料、case/oracle 和策略重新待复核，不继承旧确认。gold 目录允许保存显式 review_pending 候选，不等于已接受 Gold；本次自动准备不产生人工核验身份或实际评测成绩。开发/回归/验收的核验原票预算为 600/200/400，模拟资料为 300/100/200；用途清单在近重复和暴露检查完成前为 provisional。总实例数、独立原票数和场景族数分别报告，不能用参数化数量代替覆盖证据。',
)
NEW_PARAGRAPHS = (
    'development、regression、acceptance 的隔离范围须在数据清单中明确，同票副本和简单扰动不能跨组。当前 voxel51 活动批次采用本轮受控重制清单：100 份新 Gold 候选在确认三组同一发票多页关系后按 development 51、regression 21、acceptance 28 划分；80 套模拟业务资料按 development 40、regression 16、acceptance 24 划分。原定 Gold 50/20/30 仅是分组前目标，不得为配平拆开同一来源组；原票组及其衍生资料继承同一用途。当前允许版式或供应商跨集合，报告只能称为原票留出，不能声称未见模板或未见供应商测试。需要验证这些泛化能力时另建明确隔离的成员清单，不复制原图。近重复与暴露审查完成前不冻结验收；验收样本一旦用于调参即标暴露并转开发/回归，后续补独立验收集。其他来源的比例、数量和异常配额由相应阶段方案固定。',
    '历史准备规模（2026-09-17 文档修订时保留，非当前活动清单）为：2,902 份去重输入、1,200 份人工核验任务、600 套模拟资料、5,577 个用例实例、177 个场景族（抽取 1,200、匹配 890、人工复核与提交确认 487、B2B 提交 800、Runtime 1,000、隔离 800、平台基础验证 400）。当前受控重制规模为 2,902 份原始输入和 1,414 份提供方标签保持不变，新制 100 份 Gold 候选、80 套模拟业务资料、520 个产品功能 Case 与 28 个评测设施 Case，共 548 个 Case，按 15 个 Harness 功能模块组织；11 项有效 Benchmark 引用同一 Case，不复制计数，BM-06 退役，BM-10 真实业务观察样本为 0。旧材料及审核记录仅在历史目录追溯，不进入当前成员；新 Gold、业务资料、Case、Oracle 和策略不继承旧审核结论。Gold 目录允许保存显式 review_pending 候选，不等于已接受 Gold；自动准备不产生人工核验身份、产品 Trial、Baseline 或评测成绩。用途划分采用 4.1 的当前清单；近重复与暴露审查、内容审核、执行依赖和正式冻结分别记录。总实例数、独立原票数、语义场景数和实际 Trial 数分别报告，不能用参数化数量代替覆盖证据。',
)
APPROVED_COUNTS = {
    'gold': 100, 'business': 80, 'cases': 548,
    'goldSplitCounts': {'development': 51, 'regression': 21, 'acceptance': 28},
    'businessSplitCounts': {'development': 40, 'regression': 16, 'acceptance': 24},
}


def _read(snapshot, path):
    return json.loads(snapshot[path].decode('utf-8-sig'))


def _pin(path, raw):
    return {'path': path, 'bytes': len(raw), 'sha256': hashlib.sha256(raw).hexdigest()}


def _tree(project, relative):
    project = Path(project).resolve()
    root = (project / relative).resolve()
    if not root.is_relative_to(project) or not root.is_dir():
        raise ValueError('Specification-amendment history is missing')
    return {path.relative_to(root).as_posix(): path.read_bytes()
            for path in root.rglob('*') if path.is_file()}


def reindex(outputs):
    outputs['manifests/inventory.json'] = json_bytes({'schemaVersion': 3, 'files': [
        _pin(path, raw) for path, raw in sorted(outputs.items())
        if path != 'manifests/inventory.json']})


def registered_amendment(project):
    project = Path(project).resolve()
    old_path = project / OLD_EVALUATION_SNAPSHOT
    if not old_path.is_file() or file_pin(project, OLD_EVALUATION_SNAPSHOT) != {
            'path': OLD_EVALUATION_SNAPSHOT,
            'bytes': BINDING_3_PINS[1]['bytes'],
            'sha256': BINDING_3_PINS[1]['sha256']}:
        raise ValueError('Registered prior evaluation specification is missing')
    old_raw = old_path.read_bytes()
    current_path = project / CURRENT_PINS[1]['path']
    current_raw = current_path.read_bytes()
    if _pin(CURRENT_PINS[1]['path'], current_raw) != CURRENT_PINS[1]:
        raise ValueError('Current evaluation specification differs from registered amendment')
    expected = old_raw
    changes = []
    for previous, current in zip(OLD_PARAGRAPHS, NEW_PARAGRAPHS, strict=True):
        before, after = previous.encode('utf-8'), current.encode('utf-8')
        if expected.count(before) != 1:
            raise ValueError('Approved prior paragraph is not unique')
        expected = expected.replace(before, after)
        changes.append({'previousSha256': hashlib.sha256(before).hexdigest(),
                        'currentSha256': hashlib.sha256(after).hexdigest()})
    if expected != current_raw:
        raise ValueError('Evaluation specification has changes outside the approved paragraphs')
    if file_pin(project, CURRENT_PINS[0]['path']) != CURRENT_PINS[0]:
        raise ValueError('Product specification changed during evaluation-plan amendment')
    current_snapshot = ('.cache/dataset-rebuild/spec-snapshots/evaluation-'
                        + CURRENT_PINS[1]['sha256'] + '.md')
    snapshot_path = project / current_snapshot
    if snapshot_path.exists() and snapshot_path.read_bytes() != current_raw:
        raise ValueError('Current evaluation specification snapshot collision')
    snapshot_path.parent.mkdir(parents=True, exist_ok=True)
    snapshot_path.write_bytes(current_raw)
    return {
        'previousBindingRevision': PREVIOUS_BINDING_REVISION,
        'currentBindingRevision': CURRENT_BINDING_REVISION,
        'changedParagraphCount': len(changes),
        'changes': changes,
        'approvedCounts': deepcopy(APPROVED_COUNTS),
        'previousSnapshot': file_pin(project, OLD_EVALUATION_SNAPSHOT),
        'currentSnapshot': file_pin(project, current_snapshot),
    }


def semantic_projection(value):
    value = deepcopy(value)
    ignored = {'version', 'authoredVersion', 'caseSha256', 'sha256', 'bytes', 'specSha256',
                'startLine', 'sourceBindingRevision', 'assetSha256',
                'specRefs', 'creationSpecRefs', 'sourceSpecHashes', 'sourceRefs',
                'requirementRefs'}

    def visit(node):
        if isinstance(node, dict):
            for key in list(node):
                if key in ignored:
                    node.pop(key)
                else:
                    visit(node[key])
        elif isinstance(node, list):
            for item in node:
                visit(item)
    visit(value)
    return value


def projection_digest(value):
    return canonical_digest(semantic_projection(value))


def _transitions(previous, current, prefix):
    old = {_read(previous, path)['id']: (path, _read(previous, path))
           for path in previous if path.startswith(prefix)}
    new = {_read(current, path)['id']: (path, _read(current, path))
           for path in current if path.startswith(prefix)}
    if set(old) != set(new):
        raise ValueError('Specification amendment changed membership: ' + prefix)
    rows = []
    for identity in sorted(old):
        old_path, before = old[identity]
        new_path, after = new[identity]
        if old_path != new_path or semantic_projection(before) != semantic_projection(after):
            raise ValueError('Specification amendment changed asset semantics: ' + identity)
        rows.append({'id': identity, 'path': old_path,
                     'previousVersion': before['version'], 'currentVersion': after['version'],
                     'previousSha256': hashlib.sha256(previous[old_path]).hexdigest(),
                     'currentSha256': hashlib.sha256(current[new_path]).hexdigest(),
                     'semanticProjectionSha256': projection_digest(after)})
    return rows


def verify_prior(project, snapshot):
    verify_inventory(snapshot)
    if RECEIPT in snapshot:
        raise ValueError('Candidate is already amended')
    from rebuild_spec_binding import validate_snapshot as validate_binding_3
    validate_binding_3(project, snapshot)
    report = _read(snapshot, 'manifests/preparation-report.json')
    if (report.get('specRefs') != BINDING_3_PINS or
            report.get('sourceBindingRevision') != PREVIOUS_BINDING_REVISION):
        raise ValueError('Only registered binding 3 can receive this amendment')
    counts = (sum(path.startswith('gold/') for path in snapshot),
              sum(path.startswith('business/') for path in snapshot),
              sum(path.startswith('cases/') for path in snapshot))
    if counts != (100, 80, 548):
        raise ValueError('Prior asset membership differs')
    return report


def build_receipt(previous, current, amendment):
    gold = sorted(path for path in previous if path.startswith('gold/'))
    if gold != sorted(path for path in current if path.startswith('gold/')) or any(
            previous[path] != current[path] for path in gold):
        raise ValueError('Specification amendment changed Gold bytes')
    before = snapshot_digest(previous)
    return {
        'schemaVersion': 1,
        'operation': 'approved_dataset_budget_specification_amendment',
        'status': 'SEMANTIC_AMENDMENT_REBOUND_NO_ACCEPTANCE_GRANTED',
        **deepcopy(amendment),
        'previousCandidateSha256': before,
        'historyPath': 'data/.preparation-stage/history/candidate-' + before,
        'previousSpecRefs': deepcopy(BINDING_3_PINS),
        'currentSpecRefs': deepcopy(CURRENT_PINS),
        'gold': {'count': 100, 'bytesUnchanged': True,
                 'aggregateSha256': canonical_digest([
                     {'path': path, 'sha256': hashlib.sha256(previous[path]).hexdigest()}
                     for path in gold])},
        'businessTransitions': _transitions(previous, current, 'business/'),
        'caseTransitions': _transitions(previous, current, 'cases/'),
        'semanticContentChanged': True,
        'assetTaskSemanticsChanged': False,
        'humanReviewGranted': False,
        'actualProductRuns': 0,
        'formalAcceptanceEligible': False,
    }


def _refresh_case_review_receipts(project, previous, outputs):
    steps = []
    from rebuild_actions_review import RECEIPT as r0, build_receipt as b0
    from rebuild_actions_semantic_review import RECEIPT as r1, build_receipt as b1
    from rebuild_actions_common_review import RECEIPT as r2, build_receipt as b2
    from rebuild_actions_state_review import RECEIPT as r3, build_receipt as b3
    from rebuild_actions_effect_review import RECEIPT as r4, build_receipt as b4
    from rebuild_actions_payload_review import RECEIPT as r5, build_receipt as b5
    from rebuild_actions_recovery_review import RECEIPT as r6, build_receipt as b6
    from rebuild_actions_presentation_review import RECEIPT as r7, build_receipt as b7
    from rebuild_runtime_evidence_review import RECEIPT as r8, build_receipt as b8
    from rebuild_grader_review import RECEIPT as r9, build_receipt as b9
    steps.extend(((r0, b0), (r1, b1), (r2, b2), (r3, b3), (r4, b4),
                  (r5, b5), (r6, b6), (r7, b7), (r8, b8), (r9, b9)))
    for path, builder in steps:
        facility = _read(previous, path)['facilityVerification']
        outputs[path] = json_bytes(builder(project, outputs, facility))

    readiness = _read(outputs, 'manifests/readiness.json')
    action_refs = {
        'receiptRef': r0,
        'semanticReceiptRef': r1,
        'commonSemanticReceiptRef': r2,
        'stateSemanticReceiptRef': r3,
        'effectSemanticReceiptRef': r4,
        'payloadSemanticReceiptRef': r5,
        'recoverySemanticReceiptRef': r6,
        'presentationSemanticReceiptRef': r7,
    }
    for key, path in action_refs.items():
        readiness['actionsReview'][key] = _pin(path, outputs[path])
    readiness['runtimeToolsEventsReview']['receiptRef'] = _pin(r8, outputs[r8])
    readiness['graderFacilities']['receiptRef'] = _pin(r9, outputs[r9])
    outputs['manifests/readiness.json'] = json_bytes(readiness)
    report = _read(outputs, 'manifests/preparation-report.json')
    report['actionsDefinitionReview'] = deepcopy(readiness['actionsReview'])
    report['runtimeToolsEventsReview'] = deepcopy(readiness['runtimeToolsEventsReview'])
    report['graderFacilities'] = deepcopy(readiness['graderFacilities'])
    outputs['manifests/preparation-report.json'] = json_bytes(report)
    return outputs


def repair_derived_references(project):
    """Finish a post-swap repair if validation stopped after the atomic swap."""
    from rebuild_staging import candidate_lock, _swap_candidate
    project = Path(project).resolve()
    with candidate_lock(project):
        snapshot = read_candidate(project)
    if RECEIPT not in snapshot:
        raise ValueError('No amended candidate is available to repair')
    outputs = _refresh_case_review_receipts(project, snapshot, dict(snapshot))
    reindex(outputs)
    from rebuild_coverage_review import build_revision as refresh_coverage
    outputs = refresh_coverage(project, outputs)
    reindex(outputs)
    validate_snapshot(project, outputs)
    result = _swap_candidate(project, snapshot, outputs)
    return result


def build_revision(project, previous):
    project = Path(project).resolve()
    verify_prior(project, previous)
    amendment = registered_amendment(project)
    from rebuild_contracts import load_spec_contracts
    contracts = load_spec_contracts(project)
    if contract_pins(contracts) != CURRENT_PINS:
        raise ValueError('Current specifications changed during amendment')
    outputs = dict(previous)
    report = _read(outputs, 'manifests/preparation-report.json')
    report.update(specRefs=deepcopy(CURRENT_PINS),
                  sourceBindingRevision=CURRENT_BINDING_REVISION,
                  specAmendmentReview='approved_100_gold_80_business_548_cases')
    outputs['manifests/preparation-report.json'] = json_bytes(report)

    from rebuild_business_projection import authored_business
    for asset in authored_business(contracts).values():
        outputs['business/' + asset['id'] + '.json'] = json_bytes(asset)
    from rebuild_cases import compile_scenarios
    from rebuild_extraction import build_extraction_cases
    from rebuild_fixtures import registered_scenarios
    golds = [_read(outputs, path) for path in sorted(outputs) if path.startswith('gold/')]
    cases = (compile_scenarios(list(registered_scenarios().values()), contracts) +
             build_extraction_cases(golds, contracts))
    outputs = assemble_case_files(outputs, cases, contracts)
    outputs[RECEIPT] = json_bytes(build_receipt(previous, outputs, amendment))

    from rebuild_business_review import assemble_reviews
    outputs = assemble_reviews(outputs)
    outputs = _refresh_case_review_receipts(project, previous, outputs)
    reindex(outputs)
    from rebuild_coverage_review import build_revision as refresh_coverage
    outputs = refresh_coverage(project, outputs)
    reindex(outputs)
    validate_snapshot(project, outputs, previous)
    return outputs


def validate_snapshot(project, snapshot, previous=None):
    if RECEIPT not in snapshot:
        raise ValueError('Current binding requires a specification amendment receipt')
    receipt = _read(snapshot, RECEIPT)
    amendment = registered_amendment(project)
    fixed = {
        'schemaVersion': 1,
        'operation': 'approved_dataset_budget_specification_amendment',
        'status': 'SEMANTIC_AMENDMENT_REBOUND_NO_ACCEPTANCE_GRANTED',
        'previousBindingRevision': PREVIOUS_BINDING_REVISION,
        'currentBindingRevision': CURRENT_BINDING_REVISION,
        'previousSpecRefs': BINDING_3_PINS,
        'currentSpecRefs': CURRENT_PINS,
        'semanticContentChanged': True,
        'assetTaskSemanticsChanged': False,
        'humanReviewGranted': False,
        'actualProductRuns': 0,
        'formalAcceptanceEligible': False,
    }
    if any(receipt.get(key) != value for key, value in fixed.items()):
        raise ValueError('Specification amendment receipt contract differs')
    for key in ('changedParagraphCount', 'changes', 'approvedCounts',
                'previousSnapshot', 'currentSnapshot'):
        if receipt.get(key) != amendment[key]:
            raise ValueError('Specification amendment proof differs: ' + key)
    if previous is None:
        previous = _tree(project, receipt['historyPath'])
    verify_prior(project, previous)
    if snapshot_digest(previous) != receipt['previousCandidateSha256']:
        raise ValueError('Specification amendment prior candidate differs')
    expected = build_receipt(previous, snapshot, amendment)
    if receipt != expected:
        raise ValueError('Specification amendment transition receipt differs')
    report = _read(snapshot, 'manifests/preparation-report.json')
    if (report.get('specRefs') != CURRENT_PINS or
            report.get('sourceBindingRevision') != CURRENT_BINDING_REVISION or
            report.get('specAmendmentReview') != 'approved_100_gold_80_business_548_cases'):
        raise ValueError('Preparation report is not on the amended source binding')
    if report.get('requirementsCoverage', {}).get('sourcePlanConflicts') != 0:
        raise ValueError('Amended source still reports a dataset-budget conflict')


def release(project):
    from rebuild_staging import candidate_lock, revise_spec_amendment_candidate
    project = Path(project).resolve()
    with candidate_lock(project):
        previous = read_candidate(project)
    if RECEIPT in previous:
        try:
            from rebuild_dataset import verify_asset_snapshot
            verify_asset_snapshot(project, previous)
        except ValueError:
            repair_derived_references(project)
            previous = read_candidate(project)
            verify_asset_snapshot(project, previous)
        return {'changed': False, 'candidateSha256': snapshot_digest(previous),
                'sourceBindingRevision': CURRENT_BINDING_REVISION,
                'cases': 548, 'business': 80, 'gold': 100,
                'actualProductRuns': 0, 'formalAcceptanceEligible': False}
    outputs = build_revision(project, previous)
    result = revise_spec_amendment_candidate(project, previous, outputs)
    from rebuild_dataset import verify_asset_snapshot
    verified = verify_asset_snapshot(project, read_candidate(project))
    result.update(candidateSha256=snapshot_digest(outputs),
                  sourceBindingRevision=CURRENT_BINDING_REVISION,
                  cases=548, business=80, gold=100,
                  actualProductRuns=verified['actualProductRuns'],
                  formalAcceptanceEligible=verified['formalAcceptanceEligible'])
    return result


if __name__ == '__main__':
    import argparse
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--project', type=Path, default=Path(__file__).resolve().parents[2])
    args = parser.parse_args()
    print(json.dumps(release(args.project), ensure_ascii=False, indent=2))
