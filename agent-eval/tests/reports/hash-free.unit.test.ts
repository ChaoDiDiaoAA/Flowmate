import { expect, test } from 'bun:test';
import { artifactJson } from '../../src/artifacts.ts';
import { mkdtempSync, readFileSync, rmSync, mkdirSync, writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { reportFixture,comparisonFacts } from '../support/fixtures.ts';
import { readReport, saveReport, comparison } from '../../src/reports/store.ts';
import {aggregate} from '../../src/scoring/aggregate.ts';
import {publicVersions,executionVersions} from '../../src/reports/files.ts';
import {registerSecrets} from '../../src/execution/evidence-safety.ts';

test('hash-free report comparison rejects changed native model capacities in actual snapshots', () => {
    const root = mkdtempSync(join(tmpdir(), 'eval-native-compare-'));
    try {
        const directories = ['a', 'b'].map(name => { const directory = join(root, name); mkdirSync(directory); return directory; });
        const declaration = comparisonFacts();
        for (const directory of directories) { saveReport(join(directory, 'report.json'), reportFixture()); writeFileSync(join(directory, 'snapshot.json'), artifactJson(declaration)); }
        const left = readReport(join(directories[0]!, 'report.json')), right = readReport(join(directories[1]!, 'report.json'));
        expect(comparison(left, right)).toHaveLength(1);
        for (const change of [{ contextWindow: 262144 }, { maxTokens: 65536 }, { providers: ['different-source'] }]) {
            const changed = structuredClone(declaration); Object.assign(changed.configuration.modelCapabilities, change);
            writeFileSync(join(directories[1]!, 'snapshot.json'), artifactJson(changed));
            expect(() => comparison(left, right)).toThrow('identical snapshot declarations');
        }
    } finally { rmSync(root, { recursive: true, force: true }); }
});

test('comparison requires saved source and Agent configuration facts on both sides',()=>{
    const root=mkdtempSync(join(tmpdir(),'eval-missing-comparison-facts-'));
    try{
        const directories=['left','right'].map(name=>{const directory=join(root,name);mkdirSync(directory);return directory;});
        const reports=directories.map(directory=>{const file=join(directory,'report.json');saveReport(file,reportFixture());return readReport(file);});
        expect(()=>comparison(reports[0]!,reports[1]!)).toThrow('original execution conditions');
        expect(()=>comparison(reportFixture(),reportFixture())).toThrow('original execution conditions');
        const declaration=comparisonFacts();
        writeFileSync(join(directories[0]!,'snapshot.json'),artifactJson(declaration));
        expect(()=>comparison(reports[0]!,reports[1]!)).toThrow('original execution conditions');
        writeFileSync(join(directories[1]!,'snapshot.json'),artifactJson(declaration));
        expect(comparison(reports[0]!,reports[1]!)).toHaveLength(1);
        for(const incomplete of [{configuration:declaration.configuration},{runtimeSource:declaration.runtimeSource},
            {...declaration,runtimeSource:{dependencies:{},files:[]}}]){
            writeFileSync(join(directories[1]!,'snapshot.json'),artifactJson(incomplete));
            expect(()=>comparison(reports[0]!,reports[1]!)).toThrow('original execution conditions');
        }
        const changed=structuredClone(declaration);changed.runtimeSource.files[0]!.text+='\nChanged actual implementation.';
        writeFileSync(join(directories[1]!,'snapshot.json'),artifactJson(changed));
        expect(()=>comparison(reports[0]!,reports[1]!)).toThrow('identical snapshot declarations');
        registerSecrets(['synthetic-comparison-private-key']);
        const secret=structuredClone(declaration);secret.runtimeSource.files[0]!.text+='\nsynthetic-comparison-private-key';
        for(const directory of directories)writeFileSync(join(directory,'snapshot.json'),artifactJson(secret));
        expect(()=>comparison(reports[0]!,reports[1]!)).toThrow('credential in execution conditions');
        unlinkSync(join(directories[0]!,'snapshot.json'));
        writeFileSync(join(directories[1]!,'snapshot.json'),artifactJson(declaration));
        expect(()=>comparison(reports[0]!,reports[1]!)).toThrow('original execution conditions');
    }finally{rmSync(root,{recursive:true,force:true});}
});

test('artifact serialization preserves original source text and serialized tool arguments',()=>{
    const text='a'.repeat(64),request=JSON.stringify({data:{text,tool:'read'}});
    const value={caseId:'FM-001',version:2,nested:[{text}],request};
    expect(JSON.parse(artifactJson(value))).toEqual(value);
    expect(JSON.parse(artifactJson({error:new Error('Original failure')}))).toEqual({error:'Error: Original failure'});
});
test('public benchmark versions preserve actual product/source version fields',()=>{
    const product={contract:'product-result/v2',version:7,documentRef:{id:4,version:'v1'}};
    const r=reportFixture();r.trials[0]!.execution!.evidence.original={present:true,actual:product,source:'original product query'};
    const directory=mkdtempSync(join(tmpdir(),'eval-original-version-')),file=join(directory,'report.json');
    try{saveReport(file,r);expect(readReport(file).trials[0]!.execution!.evidence.original!.actual).toEqual(product);expect(publicVersions(product)).toEqual(product);}
    finally{rmSync(directory,{recursive:true,force:true});}
});
test('Judge protocol and formal catalog publish v1 while historical internal protocols remain readable',()=>{
    const value={protocolVersion:'flowmate-judge/v2',catalog:[{id:'tool-selection',group:'tools',unit:'工具选择',formula:'n/d',version:1}]};
    const published=publicVersions(value);
    expect(published.protocolVersion).toBe('flowmate-judge/v1');
    expect(published.catalog[0].version).toBe('v1');
    expect(executionVersions(published)).toEqual(value);
});
test('reports separate result, process and safety; cancellation cannot erase a known safety failure',()=>{
    const report=reportFixture(),trial=report.trials[0]!;
    trial.execution!.status='cancelled';
    trial.scores.push({metricId:'no-secret',name:'Secrets',version:1,method:'deterministic',required:true,status:'FAIL',value:0,reason:'Observed leak',evidence:['redaction-scan']});
    expect(aggregate(trial.scores,trial.execution!).status).toBe('FAIL');
    const directory=mkdtempSync(join(tmpdir(),'eval-dimensions-')),file=join(directory,'report.json');
    try{saveReport(file,report);const disk=JSON.parse(readFileSync(file,'utf8'));expect(disk.trials[0].dimensions).toMatchObject({result:{status:'PASS'},process:{status:'NOT_APPLICABLE'},safety:{status:'FAIL'}});}
    finally{rmSync(directory,{recursive:true,force:true});}
});
test('saved reports are hash-free and remain readable and exportable',()=>{
    const directory=mkdtempSync(join(tmpdir(),'eval-public-report-')),file=join(directory,'summary.json');
    try {
        const report=reportFixture();saveReport(file,report);
        expect(readFileSync(file,'utf8')).not.toMatch(/"[^"\n]*(?:hash|sha256)[^"\n]*"\s*:/i);
        expect(readReport(file).trials[0]!.status).toBe(report.trials[0]!.status);
        report.trials[0]!.execution!.answer='Changed original answer with identical summary';
        expect(()=>saveReport(file,report)).toThrow('immutable');
    } finally {rmSync(directory,{recursive:true,force:true});}
});

test('legacy identity-only reports keep original scores but cannot assert equivalence or be overwritten',()=>{
 const directory=mkdtempSync(join(tmpdir(),'eval-legacy-identity-')),file=join(directory,'summary.json');
 try{const report:any=reportFixture();delete report.trials[0].caseConditions;report.dataset.hash='legacy-only';
 writeFileSync(file,JSON.stringify(report));const bytes=readFileSync(file,'utf8'),stored=readReport(file);
 expect(stored.trials[0]!.scores).toEqual(report.trials[0].scores);expect(stored.history?.verification).toBe('unverified');
 expect(()=>comparison(stored,stored)).toThrow('verified original');expect(()=>saveReport(file,stored)).toThrow('read-only');
 expect(readFileSync(file,'utf8')).toBe(bytes);
 }finally{rmSync(directory,{recursive:true,force:true});}
});
