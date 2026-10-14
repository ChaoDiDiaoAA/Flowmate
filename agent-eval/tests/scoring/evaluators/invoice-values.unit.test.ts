import { expect, test } from 'bun:test';
import { invoiceHeaderFields, invoiceLineFields } from '@flowmate/contracts';
import { observed, task, projected } from '../../support/fixtures.ts';
import { evaluateAll } from '../../../src/scoring/evaluate.ts';

async function grade(fields: Record<string,string>, rows: Record<string,string>[], goldFields=fields, goldRows=rows, metadata?: unknown) {
    const item=structuredClone(task), result=observed();
    item.expected.reference={status:'verified',fields:goldFields,lineItems:goldRows,excerpt:'Independent synthetic numbers.',basis:'visible-parsed-material'};
    result.evidence['candidate-fields']={present:true,actual:fields,source:'Original model candidate'};
    result.evidence['candidate-line-items']={present:true,actual:rows,source:'Original model lines'};
    if(metadata)result.evidence['candidate-values']={present:true,actual:metadata,source:'Original model field states'};
    return (await evaluateAll({task:item,result,projected,judge:null},[{metric:'reference-fields',required:true},{metric:'line-items',required:true}])).scores;
}

test('exact decimal comparison recognizes representation equality across header and every numeric line field', async()=>{
    const actual={description:'Item',quantity:'1',unitPrice:'175',netAmount:'175.0',taxRate:'10',taxAmount:'17.5',totalAmount:'192.5'};
    const gold={...actual,quantity:'1.00',unitPrice:'175.00',netAmount:'175.00',taxRate:'10.0',taxAmount:'17.50',totalAmount:'192.50'};
    expect((await grade({totalAmount:'192.5'},[actual],{totalAmount:'192.50'},[gold])).map(s=>s.status)).toEqual(['PASS','PASS']);
    for(const [key,value] of Object.entries({quantity:'2',unitPrice:'176',netAmount:'176',taxRate:'0.1',taxAmount:'17.51',totalAmount:'192.51'}))
        expect((await grade({totalAmount:'192.5'},[{...actual,[key]:value}],{totalAmount:'192.50'},[gold]))[1]!.status).toBe('FAIL');
});

test('raw comma amounts, missing values and ambiguous separators never become equivalent by replacing text', async()=>{
    for(const value of ['1,00','1,000','','1 000'])
        expect((await grade({totalAmount:value},[{quantity:value}],{totalAmount:'1'},[{quantity:'1.00'}])).every(s=>s.status==='FAIL')).toBe(true);
    expect((await grade({invoiceNumber:'001'},[{description:'wrong',quantity:'1'}],{invoiceNumber:'1'},[{description:'Item',quantity:'1.00'}])).every(s=>s.status==='FAIL')).toBe(true);
    expect((await grade({},[{quantity:'1'},{quantity:'1'}],{},[{quantity:'1.00'},{quantity:'2'}]))[1]!.actual).toMatchObject({tp:1,fp:1,fn:1});
});

test('field states and required normalization are retained separately from display strings', async()=>{
    const field={raw:'1.00',normalized:'1',state:'present',alternatives:[],sources:[]};
    const metadata={fields:Object.fromEntries(invoiceHeaderFields.map(k=>[k,{...field}])),lines:[Object.fromEntries(invoiceLineFields.map(k=>[k,{...field}]))]};
    expect((await grade({totalAmount:'1'},[{quantity:'1'}],{totalAmount:'1.00'},[{quantity:'1.00'}],metadata)).every(s=>s.status==='PASS')).toBe(true);
    for(const change of [{state:'ambiguous'},{state:'missing'},{normalized:null}]) {
        const changed=structuredClone(metadata);
        Object.assign(changed.fields.totalAmount!,change);Object.assign(changed.lines[0]!.quantity!,change);
        expect((await grade({totalAmount:'1'},[{quantity:'1'}],{totalAmount:'1.00'},[{quantity:'1.00'}],changed)).every(s=>s.status==='FAIL')).toBe(true);
    }
});

test('declared original metadata cannot omit display rows or field identities and fall back to legacy equality',async()=>{
    const field={raw:'1',normalized:'1',state:'present',alternatives:[],sources:[]};
    const metadata={fields:Object.fromEntries(invoiceHeaderFields.map(k=>[k,{...field}])),lines:[]};
    const scores=await grade({totalAmount:'1'},[{quantity:'1'}],{totalAmount:'1.00'},[{quantity:'1.00'}],metadata);
    expect(scores[0]!.status).toBe('PASS');expect(scores[1]!.status).toBe('UNJUDGEABLE');
    expect((await grade({unknown:'1'},[],{unknown:'1'},[],metadata))[0]!.status).toBe('UNJUDGEABLE');
});
