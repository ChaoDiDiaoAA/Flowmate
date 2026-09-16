"""Publish explicitly reviewed answers and a user-confirmed clarification policy.

Requires a separately recorded human decision. Does not create that decision,
invent missing answers, mark product runs, or assert benchmark acceptance.
"""
from __future__ import annotations

import argparse
from collections import Counter
from copy import deepcopy
from datetime import datetime, timezone
import json
from pathlib import Path

from prepare_invoice_data import read_json, file_info, digest, write_new, safe_relative
from prepare_gold_answers import verify_preparation, field_rows
from review_invoice_data import (verify_current_inventory, refresh_inventory, build_asset_review_record,
                                 _replace_json, CURRENT_CHECKS, validate_current_assets, valid_id)


def settle_form(packet, reviewer):
    form=deepcopy(packet['reviewForm'])
    form['reviewers']=[deepcopy(reviewer)]
    form['coverage']={k:True for k in form['coverage']}
    form['notes']='用户确认已审核无问题；未定值和缺失明细的预期行为为请求澄清。确认的是答案/行为契约，不把未知认定为票面缺失。'
    for _,field in field_rows({'reviewForm':form}):
        settled=field['proposedValueState']=='confirmed' and field['normalizedValue'] is not None
        field['valueState']='confirmed' if settled else 'clarification_required'
        field['inputAvailability']='present' if field['proposedInputAvailability']=='present' else 'unknown'
        field['humanVerified']=True
        field['notes']='用户接受展示的候选及证据；未定内容按已确认策略请求澄清。'
        if not settled:
            field['normalizedValue']=None
            field['expectedAction']='request_clarification'
            field['clarificationReason']=';'.join(field['issues']) or 'value_not_established'
        for evidence in field['evidence']:
            if evidence['asset'].endswith('/original.jpg'):
                evidence['note']='已展示给用户核对的原图定位；沿用解析坐标。未定值仅用于定位澄清问题，不证明票面缺失。'
    if 'no_line_items_recovered_check_original' in packet['documentIssues']:
        form['lineItemsExpectation']={'state':'clarification_required','expectedAction':'request_clarification',
            'reason':'完整明细未建立；要求补充或澄清，不能断言没有明细，也不能补造明细。'}
    return form


def verify_publication(root, report):
    from sync_invoice_scope import scope_baseline
    counts=Counter();line_questions=0;seen=set()
    for descriptor in report['gold']:
        gold=scope_baseline(root,descriptor)
        if gold['sampleId'] in seen or not gold.get('humanVerified') or not gold.get('eligibleForFieldScoring'):
            raise ValueError('Duplicate or unpublished Gold in publication')
        seen.add(gold['sampleId'])
        for _,field in field_rows({'reviewForm':gold}):counts[field['valueState']]+=1
        line_questions+=bool(gold.get('lineItemsExpectation'))
    if len(seen)!=report['goldCount'] or dict(counts)!=report['fieldStates'] or line_questions!=report['lineItemClarificationDocuments']:
        raise ValueError('Gold publication counts differ')
    if file_info(root/report['decision']['path'],root)!=report['decision']:
        raise ValueError('Publication decision changed')
    return {'status':'gold_publication_verified','goldCount':len(seen),'fieldStates':dict(counts)}


def publish(project, decision_path):
    project=Path(project).resolve();root=project/'agent-eval/data';product=project/'data/invoices/voxel51'
    decision_path=Path(decision_path).resolve()
    if decision_path.parent != root/'manifests/reviews':raise ValueError('Decision must be an inventoried review record')
    verify_current_inventory(project);verify_preparation(project)
    decision=read_json(decision_path)
    if (decision.get('kind')!='human_gold_clarification_policy_confirmation'
        or decision.get('policy')!='request_clarification_for_unresolved'
        or decision.get('reviewer',{}).get('performedBy')!='human'):
        raise ValueError('Explicit human clarification decision required')
    publication_id=valid_id(decision['id'])
    output=root/'manifests/gold-publication'/publication_id
    if output.exists():raise ValueError('Publication already exists; verify instead of publishing again')
    prior_confirmation=safe_relative(root,decision['priorConfirmation']['path'])
    if file_info(prior_confirmation,root)!=decision['priorConfirmation']:raise ValueError('Prior confirmation changed')
    prior=read_json(prior_confirmation)
    if prior.get('decision')!='accept_prepared_materials_as_is':raise ValueError('Prepared answers not accepted')
    basis=prior['basisSnapshot']
    if file_info(root/basis['preparationReport']['path'],root)!=basis['preparationReport']:raise ValueError('Preparation changed after review')
    reviewer={'reviewerId':decision['reviewer']['reviewerId'],'performedBy':'human','role':'primary',
              'reviewedAt':decision['confirmationRecordedAt'],'attestsContentReview':True,'attestsOriginalImageReview':True,
              'timestampMeaning':'final_user_confirmation_recorded_at; original review completion time not supplied',
              'identityVerification':'conversation_attestation_only'}
    stage=project/'data/.preparation-stage'/publication_id
    if stage.exists():raise ValueError('A prepared stage exists; inspect it before retrying')
    stage.mkdir(parents=True)
    counts=Counter();gold_descriptors=[];record_paths=[];line_questions=0
    for descriptor in basis['packets']:
        packet_path=safe_relative(root,descriptor['path'])
        if file_info(packet_path,root)!=descriptor:raise ValueError('Candidate changed after user confirmation')
        packet=read_json(packet_path);sid=packet['sampleId'];base_path=root/f'gold/{sid}.json';base=read_json(base_path)
        if file_info(base_path,root)!=packet['targetGold'] or base.get('humanVerified'):raise ValueError('Gold already revised')
        form=settle_form(packet,reviewer)
        for _,field in field_rows({'reviewForm':form}):counts[field['valueState']]+=1
        line_questions+=bool(form.get('lineItemsExpectation'))
        record_id=publication_id+'-'+sid
        submission={'schemaVersion':1,'kind':'human_asset_review','assetKind':'gold','assetId':sid,
            'recordId':record_id,'target':packet['targetGold'],'reviewers':[reviewer],'owner':reviewer['reviewerId'],
            'decision':'accept','rationale':'用户接受已展示答案与证据，并明确要求 Agent 对未定项请求澄清。',
            'checks':{k:True for k in CURRENT_CHECKS['gold']},'disputes':[],
            'exposure':{'scope':'reviewed_source_and_prepared_gold_only','reviewed':True,
                'notes':'保留既有 split。材料已向审核用户展示，并经离线工具处理；未证明模型未接触这些发票，不据此认证正式验收隔离。'},
            'evidence':[{'path':descriptor['path'],'sha256':descriptor['sha256'],'note':'用户审核的具体候选答案与证据'},
                        {'path':decision_path.relative_to(root).as_posix(),'sha256':digest(decision_path),'note':'当前用户对未定项的明确行为结论'}],
            'goldReview':form,'identityVerification':'submitter_attestation_only'}
        record=build_asset_review_record(project,submission,{'file':packet['targetGold'],'value':base})
        write_new(stage/f'gold/{sid}.json',record['resultValue'])
        relative=f'manifests/reviews/{record_id}.json';write_new(stage/relative,record);record_paths.append(relative)
        gold_descriptors.append(file_info(stage/f'gold/{sid}.json',stage))
    if len(gold_descriptors)!=prior['scope']['sampleCount']:raise ValueError('Publication scope mismatch')
    report={'schemaVersion':1,'kind':'reviewed_structured_gold_publication','id':publication_id,
        'createdAt':datetime.now(timezone.utc).isoformat(),'status':'published','decision':file_info(decision_path,root),
        'goldCount':len(gold_descriptors),'fieldStates':dict(counts),'lineItemClarificationDocuments':line_questions,
        'gold':gold_descriptors,'reviewRecords':record_paths,'actualProductRunsAdded':0,'formalAcceptanceEligible':False,
        'caseProtocolStatus':'Case drafts unchanged; freeze run bindings to these Gold versions and hashes before execution.',
        'reviewTiming':'reviewedAt records receipt of final user confirmation, not a separately supplied review completion time.'}
    write_new(stage/f'manifests/gold-publication/{publication_id}/report.json',report)
    verify_current_inventory(project)
    authorized=[]
    for path in sorted(stage.rglob('*.json')):
        relative=path.relative_to(stage).as_posix();_replace_json(root/relative,read_json(path));authorized.append(relative)
    # Atomic JSON writes use host newlines. Pin bytes actually published,
    # never the temporary staging representation.
    report['gold']=[file_info(root/item['path'],root) for item in gold_descriptors]
    _replace_json(root/f'manifests/gold-publication/{publication_id}/report.json',report)
    preparation=read_json(root/'manifests/preparation-report.json')
    preparation['humanVerifiedInvoices']=report['goldCount']
    preparation['goldAnswerPreparation'].update(status='published_with_clarification_expectations',
        publishedGoldAdded=report['goldCount'],publicationReport=f'manifests/gold-publication/{publication_id}/report.json',
        clarificationFieldCount=counts['clarification_required'],lineItemClarificationDocuments=line_questions)
    _replace_json(root/'manifests/preparation-report.json',preparation);authorized.append('manifests/preparation-report.json')
    refresh_inventory(project,authorized)
    validate_current_assets(root,product)
    verify_publication(root,report)
    return {k:v for k,v in report.items() if k not in ('gold','reviewRecords')}


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--project',type=Path,default=Path.cwd());parser.add_argument('--decision',type=Path,required=True)
    args=parser.parse_args();print(json.dumps(publish(args.project,args.decision),ensure_ascii=False,indent=2))
