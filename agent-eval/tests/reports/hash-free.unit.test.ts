import { expect, test } from 'bun:test';
import { artifactJson } from '../../src/artifacts.ts';
import { mkdtempSync, readFileSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { reportFixture } from '../support/fixtures.ts';
import { readReport, saveReport, comparison } from '../../src/reports/store.ts';
import {aggregate} from '../../src/scoring/aggregate.ts';
import {publicVersions,executionVersions} from '../../src/reports/files.ts';
import { syntheticNativeModel } from '../support/native-model.ts';

test('hash-free report comparison rejects changed native model capacities in actual snapshots', () => {
    const root = mkdtempSync(join(tmpdir(), 'eval-native-compare-'));
    try {
        const directories = ['a', 'b'].map(name => { const directory = join(root, name); mkdirSync(directory); return directory; });
        const declaration = { version: 'v1', configuration: { model: 'native-model', modelCapabilities: syntheticNativeModel } };
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

test('every public serialization strips nested digests, including JSON encoded inside requests',()=>{
    const digest='a'.repeat(64);
    const result=artifactJson({caseId:'FM-001',version:2,hash:digest,nested:[{originalSha256:digest,text:'evidence'}],
        request:JSON.stringify({data:{contentHash:digest,tool:'read'}})});
    expect(result).not.toMatch(/hash|sha256|\b[a-f0-9]{64}\b/i);
    expect(JSON.parse(result)).toEqual({caseId:'FM-001',version:2,nested:[{text:'evidence'}],request:'{"data":{"tool":"read"}}'});
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
