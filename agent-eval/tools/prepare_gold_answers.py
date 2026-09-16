"""Prepare source-grounded Gold proposals for human confirmation, never publish them.

Original Gold, human review statements and product execution counts are untouched.
Proposals separate publisher labels, parsed evidence, normalization and uncertainty.
"""
from __future__ import annotations

import argparse
from collections import Counter, defaultdict
from copy import deepcopy
import csv
from datetime import datetime, timezone, date
from decimal import Decimal, InvalidOperation
import html
import json
from pathlib import Path
import re

from prepare_invoice_data import read_json, digest, file_info, write_new, evidence_for
from review_invoice_data import (HEADER_FIELDS, LINE_FIELDS, make_review_form,
                                 verify_current_inventory, refresh_inventory, _replace_json)

NUMERIC = {'quantity','unit_price','net_amount','tax_amount','tax_rate','total_price','total_amount','discount_amount'}


def csv_cell(value):
    text = '' if value is None else str(value)
    return "'" + text if text.lstrip().startswith(('=', '+', '-', '@')) or text.startswith(('\t', '\r', '\n')) else text


def normalize(key, raw):
    text = re.sub(r'\s+',' ',str(raw)).strip()
    result = {'value':None,'alternatives':[],'issues':[]}
    if key in {'invoice_date','due_date'}:
        try:
            if re.fullmatch(r'\d{4}-\d{2}-\d{2}',text):
                result['value']=date.fromisoformat(text).isoformat()
            else:
                match=re.fullmatch(r'(\d{1,2})[/-](\d{1,2})[/-](\d{4})',text)
                if not match: raise ValueError('Unsupported date format')
                a,b,year=map(int,match.groups())
                alternatives=[]
                for month,day in ((a,b),(b,a)):
                    try: alternatives.append(date(year,month,day).isoformat())
                    except ValueError: pass
                result['alternatives']=sorted(set(alternatives))
                if len(result['alternatives'])==1: result['value']=result['alternatives'][0]
                else:result['issues'].append('date_order_ambiguous' if alternatives else 'invalid_date')
        except ValueError: result['issues'].append('date_requires_review')
    elif key=='currency':
        codes=re.findall(r'\b(?:USD|CAD|AUD|NZD|HKD|SGD|EUR|GBP|JPY|CNY|RMB|CHF|INR)\b',text.upper())
        codes=sorted(set('CNY' if x=='RMB' else x for x in codes))
        if len(codes)==1:result['value']=codes[0]
        elif text=='€':result['value']='EUR'
        else:result['issues'].append('currency_not_established_by_symbol')
    elif key in NUMERIC:
        cleaned=re.sub(r'^(?:USD|CAD|AUD|EUR|GBP|CNY|JPY)\s*','',text,flags=re.I)
        cleaned=re.sub(r'^[$€£¥]\s*','',cleaned).rstrip('%').strip()
        if re.fullmatch(r'-?\d{1,3}(?: \d{3})+(?:[.,]\d{1,2})?',cleaned):
            cleaned=cleaned.replace(' ','')
        if re.fullmatch(r'-?\d+[.,]\d{3}',cleaned) or (',' in cleaned and '.' in cleaned):
            result['issues'].append('decimal_or_grouping_ambiguous')
        elif re.fullmatch(r'-?\d+(?:[.,]\d+)?',cleaned):
            try:result['value']=format(Decimal(cleaned.replace(',','.')),'f')
            except InvalidOperation:result['issues'].append('invalid_number')
        else:result['issues'].append('number_requires_review')
    else:result['value']=text or None
    return result


def block_evidence(sid,index,block,note):
    entry={'asset':f'{sid}/content.json','pointer':f'/{index}',
           'pageNumber':block.get('page_idx',0)+1,'note':note}
    if block.get('bbox'):
        entry.update(bbox=block['bbox'],coordinateSpace='source_native')
    return entry


def text_candidates(blocks,sid):
    result=defaultdict(list)
    party=None
    def add(key,value,i,origin='parsed_text'):
        if value and value.strip():result[key].append({'rawValue':value.strip(),'origin':origin,
            'evidence':[block_evidence(sid,i,blocks[i],'解析文字定位；原图仍需确认。')]})
    for i,block in enumerate(blocks):
        text=block.get('text','').strip()
        if not text:continue
        match=re.search(r'\binvoice\s*(?:no\.?|number|#)\s*:?\s*([A-Za-z0-9][A-Za-z0-9/-]*)',text,re.I)
        if match:add('invoice_number',match[1],i)
        if re.fullmatch(r'(seller|supplier)\s*:',text,re.I):party='seller'
        elif re.fullmatch(r'(client|buyer|bill to)\s*:',text,re.I):party='buyer'
        if party:
            tax=re.search(r'tax\s*(?:id|number|no\.?)\s*:?\s*([A-Za-z0-9-]+)',text,re.I)
            if tax:add(party+'_tax_id',tax[1],i)
        for key,label in [('invoice_date',r'(?:date of issue|invoice date)'),('due_date',r'due date')]:
            if re.search(label,text,re.I):
                value=re.search(r'\d{1,4}[/-]\d{1,2}[/-]\d{1,4}',text)
                if value:add(key,value[0],i)
                elif i+1<len(blocks):
                    nxt=blocks[i+1].get('text','').strip()
                    if re.fullmatch(r'\d{1,4}[/-]\d{1,2}[/-]\d{1,4}',nxt):add(key,nxt,i+1)
        # Only explicit amount labels; bare amounts elsewhere remain unassigned.
        for key,label in [('total_amount',r'(?:grand total|invoice total|amount due|total amount|total)'),
                          ('net_amount',r'(?:subtotal|net total)'),('tax_amount',r'(?:tax amount|total tax|VAT)'),
                          ('discount_amount',r'discount')]:
            m=re.fullmatch(label+r'\s*:?\s*([$€£¥]?\s*-?\d+[.,]\d{2})',text,re.I)
            if m:add(key,m[1],i)
    # Currency is read from explicit codes or visible symbols, never seller country.
    for i,block in enumerate(blocks):
        text=html.unescape(re.sub('<[^>]*>',' ',block.get('table_body',block.get('text',''))))
        tokens=re.findall(r'\b(?:USD|CAD|AUD|NZD|HKD|SGD|EUR|GBP|JPY|CNY|RMB|CHF|INR)\b|[$€£¥]',text)
        for token in sorted(set(tokens)):add('currency',token,i)
    return dict(result)


def publisher_candidates(base_field,sid,blocks):
    value=base_field.get('candidateValue')
    if value is None or not str(value).strip():return []
    refs=evidence_for({'id':sid,'content':blocks},value)
    for entry in refs:
        entry.update(note='候选文字与解析块匹配；需核对票面及字段归属。',coordinateSpace='source_native')
        if entry.get('bbox') is None:entry.pop('bbox',None)
    return [{'rawValue':str(value),'origin':base_field.get('candidateSource','publisher_annotation'),
             'providerLocator':base_field.get('providerLocator'),'evidence':refs}]


def propose_field(key,candidates,sid,blocks):
    enriched=[]
    for candidate in candidates:
        c=deepcopy(candidate);c['normalization']=normalize(key,c['rawValue']);enriched.append(c)
    # Prefer explicit parsed values for display, retaining every label alternative.
    enriched.sort(key=lambda c:(not c['origin'].startswith('parsed'),not bool(c['evidence'])))
    values={c['normalization']['value'] for c in enriched if c['normalization']['value'] is not None}
    # Decimal spelling differences are not conflicting values.
    comparison={str(Decimal(v).normalize()) if key in NUMERIC else v for v in values}
    issues=sorted({issue for c in enriched for issue in c['normalization']['issues']})
    selected=enriched[0] if enriched else None
    ambiguous=len(comparison)>1
    if ambiguous:issues.append('source_values_conflict')
    if enriched and not any(c['evidence'] for c in enriched):issues.append('publisher_value_without_parse_match')
    if not enriched:issues.append('not_found_in_parse_or_labels_check_original')
    normalized=None if ambiguous else next((c['normalization']['value'] for c in enriched if c['normalization']['value'] is not None),None)
    proposed='ambiguous' if ambiguous or (enriched and normalized is None) else 'confirmed' if normalized is not None else 'needs_original_check'
    evidence=[]
    for c in enriched:
        for entry in c['evidence']:
            if entry not in evidence:evidence.append(entry)
    # An original reference is a locator for the human, not a claim it was reviewed.
    originals=[]
    for entry in evidence:
        ref={'asset':f'{sid}/original.jpg','pageNumber':entry['pageNumber'],
             'note':'请核对原图对应区域；此定位由解析生成，尚未人工确认。'}
        if entry.get('bbox'):ref.update(bbox=entry['bbox'],coordinateSpace='source_native')
        if ref not in originals:originals.append(ref)
    if not originals:originals=[{'asset':f'{sid}/original.jpg','pageNumber':1,
        'note':'需检查完整原图；解析未找到不能证明票面缺失。'}]
    return {'rawValue':selected['rawValue'] if selected else None,'normalizedValue':normalized,
        'valueState':'unverified','inputAvailability':'unverified',
        'proposedValueState':proposed,'proposedInputAvailability':'present' if evidence else 'needs_original_check',
        'alternatives':sorted(values | {v for c in enriched for v in c['normalization']['alternatives']}),
        'evidence':originals+evidence,'notes':'机器整理的候选，需实际核验后选择值状态。',
        'humanVerified':False,'issues':issues,'candidates':enriched}


def prepare_packet(base,blocks,target,source_snapshot):
    from gold_table_candidates import extract_tables
    sid=base['sampleId'];tables=extract_tables(blocks,sid);texts=text_candidates(blocks,sid)
    form=make_review_form(base)
    for key in HEADER_FIELDS:
        candidates=publisher_candidates(base.get('fields',{}).get(key,{}),sid,blocks)
        candidates+=texts.get(key,[])+tables['summary'].get(key,[])
        form['fields'][key]=propose_field(key,candidates,sid,blocks)
    rows=tables['lineItems'];labels=base.get('lineItems',[]);issues=list(tables['issues'])
    form['lineItems']=[]
    if rows and labels and len(rows)!=len(labels):issues.append('parsed_and_label_line_counts_differ')
    for i in range(len(rows) if rows else len(labels)):
        fields={}
        use_label=(not rows or len(rows)==len(labels)) and i<len(labels)
        for key in LINE_FIELDS:
            candidates=deepcopy(rows[i]['fields'].get(key,[])) if rows else []
            if use_label:candidates+=publisher_candidates(labels[i].get('candidates',{}).get(key,{}),sid,blocks)
            fields[key]=propose_field(key,candidates,sid,blocks)
        form['lineItems'].append({'rowIndex':i,'fields':fields})
    if not form['lineItems']:issues.append('no_line_items_recovered_check_original')
    # Arithmetic is a diagnostic only: never correct the invoice to force equality.
    def number(field):
        return Decimal(field['normalizedValue']) if field['normalizedValue'] is not None and not field['issues'] else None
    total=number(form['fields']['total_amount']);net=number(form['fields']['net_amount']);tax=number(form['fields']['tax_amount'])
    arithmetic={'status':'not_enough_unambiguous_values'}
    if all(v is not None for v in (total,net,tax)):
        arithmetic={'status':'consistent' if net+tax==total else 'difference','difference':str(total-net-tax)}
        if arithmetic['status']=='difference':issues.append('header_arithmetic_difference')
    return {'schemaVersion':1,'kind':'gold_answer_preparation','sampleId':sid,'split':base['split'],
        'targetGold':target,'sourceSnapshot':source_snapshot,'status':'pending_human_confirmation',
        'humanVerified':False,'eligibleForFieldScoring':False,'published':False,
        'preparedBy':{'kind':'deterministic_preparation_tool','humanReviewPerformed':False},
        'reviewForm':form,'tableCoverage':tables['tableCoverage'],'arithmetic':arithmetic,
        'documentIssues':issues,'publisherLineCandidates':labels if len(rows)!=len(labels) else [],
        'note':'已有批量审核声明保留；本文件的新增逐字段候选和证据尚未获确认。'}


def field_rows(packet):
    for key,value in packet['reviewForm']['fields'].items():yield 'header.'+key,value
    for line in packet['reviewForm']['lineItems']:
        for key,value in line['fields'].items():yield f"line[{line['rowIndex']}].{key}",value


def make_view(packets,project):
    entries=[]
    for packet in packets:
        sid=packet['sampleId']
        entries.append({'id':sid,'split':packet['split'],
            'image':(project/f'data/invoices/voxel51/{sid}/original.jpg').as_uri(),
            'packet':'../samples/'+sid+'.json','issues':packet['documentIssues'],
            'fields':[{'key':key,'raw':f['rawValue'],'value':f['normalizedValue'],'state':f['proposedValueState'],
                       'issues':f['issues'],'evidence':[e for e in f['evidence'] if e['asset'].endswith('content.json')],
                       'alternatives':f['alternatives']} for key,f in field_rows(packet)]})
    payload=json.dumps(entries,ensure_ascii=False).replace('<','\\u003c')
    return '''<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>Gold 答案与证据核对</title>
<style>body{font:15px system-ui;margin:0;background:#f4f5f7;color:#172230}header{padding:16px;background:white;border-bottom:1px solid #ccc}main{display:grid;grid-template-columns:45% 55%;height:calc(100vh - 110px)}section{overflow:auto;padding:16px}img{width:100%}table{width:100%;border-collapse:collapse;background:white}td,th{padding:9px;text-align:left;border-bottom:1px solid #ddd;vertical-align:top}small{color:#765323}button,select{padding:6px;margin-right:10px}pre{white-space:pre-wrap;font-size:12px}.warn{background:#fff6df}a{color:#1456a4}</style>
<header><a href="../index.html">全部核对页</a> · <b>逐字段候选，尚未发布</b><p><button id="prev">上一张</button><select id="pick"></select><button id="next">下一张</button><a id="json">查看完整答案与证据 JSON</a> <span id="meta"></span></p></header>
<main><section><a id="original" target="_blank"><img id="scan" alt="原始发票"></a></section><section><p id="issues"></p><p>原值与规范值均为候选。空白表示尚未确定；请结合原图确认，尤其是币种、日期、缺失字段及来源冲突。此页面不自动登记人工审核。</p><table><thead><tr><th>字段</th><th>原值 → 规范值</th><th>疑点与证据</th></tr></thead><tbody id="fields"></tbody></table></section></main>
<script>const data='''+payload+''';const pick=document.getElementById('pick');
const esc=x=>String(x??'—').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
data.forEach((p,i)=>{const o=document.createElement('option');o.value=i;o.textContent=p.id;pick.append(o)});
function show(){const p=data[Number(pick.value)];document.getElementById('scan').src=p.image;document.getElementById('original').href=p.image;document.getElementById('json').href=p.packet;document.getElementById('meta').textContent=p.split+' · '+p.fields.length+' 个字段';document.getElementById('issues').textContent=p.issues.join('；');document.getElementById('fields').innerHTML=p.fields.map(f=>'<tr class="'+(f.issues.length?'warn':'')+'"><td>'+esc(f.key)+'</td><td>'+esc(f.raw)+'<br>→ '+esc(f.value)+'</td><td><small>'+esc(f.issues.join('；'))+'</small><details><summary>查看来源 / 备选值</summary><pre>'+esc(JSON.stringify({evidence:f.evidence,alternatives:f.alternatives},null,2))+'</pre></details></td></tr>').join('')}
pick.onchange=show;document.getElementById('prev').onclick=()=>{pick.selectedIndex=Math.max(0,pick.selectedIndex-1);show()};document.getElementById('next').onclick=()=>{pick.selectedIndex=Math.min(data.length-1,pick.selectedIndex+1);show()};show();</script></html>'''


def prepare(project, refresh=False):
    project=Path(project).resolve();quality=project/'agent-eval/data';product=project/'data/invoices/voxel51'
    output=quality/'manifests/gold-preparation'
    if output.exists() and not refresh:raise ValueError('Gold preparation already exists; inspect current work before replacing it')
    verify_current_inventory(project)
    if refresh:
        verify_preparation(project)
        for path in (output/'samples').glob('*.json'):
            old=read_json(path)
            blank=make_review_form(read_json(quality/f"gold/{old['sampleId']}.json"))
            if old['reviewForm']['coverage']!=blank['coverage'] or old['reviewForm']['reviewers']:
                raise ValueError('Human review has started; do not regenerate its draft')
    def save(path,value):
        if refresh and path.exists():_replace_json(path,value)
        else:write_new(path,value)
    manifest=read_json(product/'manifest.json');samples={s['sampleId']:s for s in manifest['samples']}
    batches=read_json(quality/'manifests/audit/batches.json')['batches']
    order=[];seen=set()
    for batch in batches:
        for sid in batch['gold']:
            if sid not in seen:order.append(sid);seen.add(sid)
    if set(order)!={f.stem for f in (quality/'gold').glob('*.json')}:raise ValueError('Review batches do not cover all current Gold')
    packets=[];issues=Counter();field_status=Counter();first_batch={}
    for batch in batches:
        for sid in batch['gold']:first_batch.setdefault(sid,batch['batchId'])
    for sid in order:
        base_path=quality/f'gold/{sid}.json';base=read_json(base_path)
        if base.get('humanVerified') or base.get('reviewRecord'):raise ValueError('Already reviewed Gold needs an explicit revision path')
        blocks=read_json(product/sid/'content.json')
        snapshot={'originalSha256':samples[sid]['originalSha256'],
                  'files':{name:digest(product/sid/name) for name in ('content.json','pages.json','original.jpg')}}
        packet=prepare_packet(base,blocks,file_info(base_path,quality),snapshot)
        packet['firstReviewBatch']=first_batch[sid]
        save(output/f'samples/{sid}.json',packet);packets.append(packet)
        issues.update(packet['documentIssues'])
        for _,field in field_rows(packet):issues.update(field['issues']);field_status[field['proposedValueState']]+=1
    views=[]
    for offset in range(0,len(packets),100):
        chunk=packets[offset:offset+100];name=f'views/group-{offset//100+1:02}.html'
        dest=output/name;dest.parent.mkdir(parents=True,exist_ok=True);dest.write_text(make_view(chunk,project),encoding='utf-8')
        views.append({'path':name,'samples':[p['sampleId'] for p in chunk]})
    with (output/'fields.csv').open('w',encoding='utf-8-sig',newline='') as stream:
        writer=csv.writer(stream);writer.writerow(['sampleId','firstReviewBatch','split','field','rawCandidate','normalizedCandidate','proposedState','issues','evidence'])
        for packet in packets:
            for key,f in field_rows(packet):
                writer.writerow([csv_cell(v) for v in [packet['sampleId'],packet['firstReviewBatch'],packet['split'],key,f['rawValue'],f['normalizedValue'],
                    f['proposedValueState'],';'.join(f['issues']),json.dumps(f['evidence'],ensure_ascii=False)]])
    report={'schemaVersion':1,'status':'answers_and_evidence_prepared_pending_human_confirmation',
        'createdAt':datetime.now(timezone.utc).isoformat(),'sampleCount':len(packets),
        'fieldCount':sum(field_status.values()),'proposedFieldStates':dict(field_status),'issues':dict(issues),
        'lineItemCount':sum(len(p['reviewForm']['lineItems']) for p in packets),
        'reviewGroups':views,'publishedGoldAdded':0,'humanReviewsPerformedByTool':0,'actualProductRunsAdded':0,
        'baselineInventorySha256':digest(quality/'manifests/inventory.json'),
        'preservedGold':[file_info(p,quality) for p in sorted((quality/'gold').glob('*.json'))],
        'nextStep':'由用户确认具体字段、缺失/歧义和证据，再经现有审核入口发布；此准备工具不创建人工身份或通过记录。'}
    save(output/'report.json',report)
    links=''.join(f'<li><a href="{v["path"]}">第 {i+1} 组：{len(v["samples"])} 张（{v["samples"][0]} 起）</a></li>' for i,v in enumerate(views))
    (output/'index.html').write_text('<!doctype html><meta charset="utf-8"><title>Gold 答案核对</title><style>body{font:18px system-ui;max-width:900px;margin:50px auto;line-height:1.8}a{color:#1456a4}</style><h1>Gold 答案与证据准备</h1><p>'+f'{len(packets)} 份候选 · {report["fieldCount"]:,} 个字段 · 尚未发布</p><p>先按第一组核对。保留既有审核批次和用途；来源与规范值均可追溯，未找到、冲突与不确定项明确标出。'+
        '</p><p><a href="fields.csv">全部字段与疑点 CSV</a> · <a href="report.json">准备报告</a></p><ol>'+links+'</ol>',encoding='utf-8')
    authorized=[p.relative_to(quality).as_posix() for p in output.rglob('*') if p.is_file()]
    preparation=read_json(quality/'manifests/preparation-report.json')
    preparation['goldAnswerPreparation']={k:report[k] for k in ('status','sampleCount','fieldCount','lineItemCount','publishedGoldAdded')}
    preparation['goldAnswerPreparation']['report']='manifests/gold-preparation/report.json'
    _replace_json(quality/'manifests/preparation-report.json',preparation);authorized.append('manifests/preparation-report.json')
    refresh_inventory(project,authorized)
    verify_preparation(project)
    return {k:v for k,v in report.items() if k not in {'preservedGold','reviewGroups'}}


def verify_preparation(project):
    project=Path(project).resolve();quality=project/'agent-eval/data';output=quality/'manifests/gold-preparation'
    report=read_json(output/'report.json');count=0;status=Counter();lines=0
    for target in report['preservedGold']:
        if file_info(quality/target['path'],quality)!=target:
            from sync_invoice_scope import scope_baseline
            scope_baseline(quality,target)
        sid=Path(target['path']).stem;packet=read_json(output/f'samples/{sid}.json')
        if packet['targetGold']!=target or packet['published'] or packet['humanVerified'] or packet['reviewForm']['reviewers']:
            raise ValueError('Prepared packet claims publication or review')
        if set(packet['reviewForm']['fields'])!=set(HEADER_FIELDS):raise ValueError('Incomplete header proposal')
        if any(set(row['fields'])!=set(LINE_FIELDS) for row in packet['reviewForm']['lineItems']):raise ValueError('Incomplete line proposal')
        for name,value in packet['sourceSnapshot']['files'].items():
            if digest(project/f'data/invoices/voxel51/{sid}/{name}')!=value:raise ValueError('Prepared evidence source changed')
        blocks=read_json(project/f'data/invoices/voxel51/{sid}/content.json')
        table_cells={}
        for _,field in field_rows(packet):
            if field['valueState']!='unverified' or field['inputAvailability']!='unverified' or field['humanVerified']:raise ValueError('Machine proposal misrepresented as verified')
            for candidate in field['candidates']:
                for evidence in candidate['evidence']:
                    if evidence['asset']!=f'{sid}/content.json' or not re.fullmatch(r'/\d+',evidence['pointer']):
                        raise ValueError('Candidate evidence points outside its source')
                    index=int(evidence['pointer'][1:]);block=blocks[index]
                    if evidence['pageNumber']!=block.get('page_idx',0)+1:raise ValueError('Candidate page differs from source')
                    if evidence.get('bbox') is not None and evidence['bbox']!=block.get('bbox'):raise ValueError('Candidate bounds differ from source')
                    if candidate['origin']=='parsed_table':
                        if index not in table_cells:
                            from gold_table_candidates import _TableParser
                            parsed=_TableParser();parsed.feed(block['table_body']);parsed.close();table_cells[index]=parsed.rows
                        raw=table_cells[index][evidence['tableRow']][evidence['columnIndex']]
                        if raw!=candidate['rawValue']:raise ValueError('Table candidate differs from literal source cell')
            status[field['proposedValueState']]+=1
        lines+=len(packet['reviewForm']['lineItems']);count+=1
    if count!=report['sampleCount'] or sum(status.values())!=report['fieldCount'] or dict(status)!=report['proposedFieldStates'] or lines!=report['lineItemCount']:
        raise ValueError('Preparation counts differ')
    return {'status':'preparation_integrity_passed','samples':count,'publishedGoldAdded':0}


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--project',type=Path,default=Path.cwd());parser.add_argument('--verify',action='store_true');parser.add_argument('--refresh',action='store_true',help='Regenerate inventoried machine drafts before human review starts')
    args=parser.parse_args();print(json.dumps(verify_preparation(args.project) if args.verify else prepare(args.project,args.refresh),ensure_ascii=False,indent=2))
