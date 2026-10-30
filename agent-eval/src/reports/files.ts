import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import { artifactJson } from '../artifacts.ts';
import { inside } from '../dataset-loader/local.ts';
import type { LocalReport } from './store.ts';
import {dimensions} from '../scoring/aggregate.ts';

export { EvaluationWriteConflict, acquireEvaluationWrite, atomicText } from '../../../packages/shared/src/evaluation-files.ts';
import { atomicText } from '../../../packages/shared/src/evaluation-files.ts';

export function atomicJson(file: string, value: unknown) { atomicText(file, artifactJson(value)); }
const benchmarkContract=/^flowmate-(?:agent-(?:run|dataset|case)|eval-(?:case|gold|review)|trial-aggregation|semantic-plan|packed-judgment|judge-(?:reference|calibration(?:-report)?))\/v\d+$/;
function dataVersion(value:unknown):number {
    const version=typeof value==='string'&&/^v[1-9]\d*$/.test(value)?Number(value.slice(1)):value;
    if(typeof version!=='number'||!Number.isSafeInteger(version)||version<1)throw Error('Invalid evaluation data version');
    return version;
}
function versions(value:any,publish:boolean,parentKey=''):any {
    if(Array.isArray(value))return value.map(v=>versions(v,publish,parentKey));
    if(!value||typeof value!=='object')return value;
    const benchmark=benchmarkContract.test(value.contract??'')||typeof value.metricId==='string'||'judgeMode'in value||
        typeof value.id==='string'&&typeof value.group==='string'&&typeof value.unit==='string'&&typeof value.formula==='string'||
        ['dataset','rubric','rubrics'].includes(parentKey)||['semantic-batch','answer-relevance'].includes(value.id);
    const opaque=new Set(['actual','expected','evidence','input','output','content','artifacts','gold','fixtures','setup','steps']);
    return Object.fromEntries(Object.entries(value).map(([key,v])=>{
        if(key==='protocolVersion'&&/^flowmate-judge\/v[12]$/.test(String(v)))return[key,publish?'flowmate-judge/v1':'flowmate-judge/v2'];
        if(key==='version'&&benchmark||/^(caseVersion|scoringVersion|rubricVersion)$/.test(key)){
            if(v===undefined)return[key,v];
            const version=dataVersion(v);return[key,publish?'v'+version:version];
        }
        if(key==='contract'&&typeof v==='string'&&benchmarkContract.test(v))return[key,
            publish?v.replace(/\/v\d+$/,'/v1'):v==='flowmate-packed-judgment/v1'?'flowmate-packed-judgment/v2':v];
        if(opaque.has(key)||key==='configuration'&&!value.callId)return[key,v];
        return[key,versions(v,publish,key)];
    }));
}
/** Only benchmark metadata is normalized; original product facts and wire payloads are opaque. */
export const publicVersions=(value:any)=>versions(value,true);
export const executionVersions=(value:any)=>versions(value,false);
export function publicReport(report: LocalReport) {
    const {export:_,...rest}=report;
    return publicVersions(({...rest,artifactFormat:'flowmate-eval-public/v1',trials:report.trials.map(t=>{
        const {execution,judgeCalls,...summary}=t;
        return {...summary,dimensions:dimensions(t.scores,!!t.execution?.started),scores:t.scores.map(({actual,expected,...score})=>score),evidence:{trial:`evidence/${t.trialId}/trial.json`,observation:`evidence/${t.trialId}/observation.json`,events:`evidence/${t.trialId}/events.jsonl`}};
    })}));
}
export function saveEvidence(root:string, report:LocalReport) {
    const ownedDirectory=(path:string)=>{if(lstatSync(path,{throwIfNoEntry:false})?.isSymbolicLink())throw Error('Linked evidence directory rejected');mkdirSync(path,{recursive:true});};
    ownedDirectory(join(root,'evidence'));
    for(const t of report.trials) {
        if(!/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(t.trialId))throw Error('Invalid Trial evidence ID');
        const directory=join(root,'evidence',t.trialId);ownedDirectory(directory);
        const e=t.execution;
        const artifacts=(e?.artifacts??[]).map((a,index)=>{
            const dir=join(directory,'artifacts');ownedDirectory(dir);
            const name=`artifact-${index+1}.json`;atomicJson(join(dir,name),a);
            return {id:a.id,kind:a.kind,file:`artifacts/${name}`};
        });
        if(e){const {observations,evidence,artifacts:_,...facts}=e;atomicJson(join(directory,'trial.json'),publicVersions({...facts,artifacts}));}
        else atomicJson(join(directory,'trial.json'),publicVersions({version:'v1',status:'not-started',identity:{executionId:report.executionId,trialId:t.trialId,caseId:t.caseId,caseVersion:t.caseVersion}}));
        atomicJson(join(directory,'observation.json'),publicVersions({version:'v1',evidence:e?.evidence??{},judgeCalls:t.judgeCalls,
            scoringFacts:t.scores.map(({metricId,actual,expected})=>({metricId,actual,expected}))}));
        const events=(e?.observations??[]).map(o=>JSON.stringify(publicVersions((o))));
        const file=join(directory,'events.jsonl'), prior=existsSync(file)?readFileSync(file,'utf8'):'';
        if(lstatSync(file,{throwIfNoEntry:false})?.isSymbolicLink())throw Error('Linked events rejected');
        const next=events.map(line=>line+'\n').join('');
        if(!next.startsWith(prior))throw Error('Events cannot be reordered or overwritten');
        const fd=openSync(file,'a',0o600);try{writeFileSync(fd,next.slice(prior.length));fsyncSync(fd);}finally{closeSync(fd);}
    }
}
export function readPublicReport(path:string, raw:any, readSource?: (reference: string) => string): LocalReport {
    dataVersion(raw.dataset?.version);
    if(!Array.isArray(raw.trials)||!raw.executionId||!['pending','complete'].includes(raw.scoring))throw Error('Invalid v1 report');
    const root=dirname(path), report=executionVersions(raw);delete report.artifactFormat;
    // The execution DTO is internal; the saved benchmark has a single public v1 contract.
    if(report.aggregation)report.contract='flowmate-agent-run/v2';
    const readText = readSource ?? ((file: string) => readFileSync(inside(root, file), 'utf8'));
    const read=(file:string)=>executionVersions(JSON.parse(readText(file)));
    const ids=new Set();
    for(const t of report.trials){
        if(ids.has(t.trialId)||!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(t.trialId))throw Error('Invalid or duplicate Trial');ids.add(t.trialId);
        const expected=`evidence/${t.trialId}/`;
        if(t.evidence?.trial!==expected+'trial.json'||t.evidence?.observation!==expected+'observation.json'||t.evidence?.events!==expected+'events.jsonl')throw Error('Invalid evidence reference');
        const facts=read(t.evidence.trial), observation=read(t.evidence.observation);
        if(facts.identity.executionId!==report.executionId||facts.identity.trialId!==t.trialId||facts.identity.caseId!==t.caseId)throw Error('Foreign Trial evidence');
        const events=readText(t.evidence.events).split('\n').filter(Boolean).map(line=>executionVersions(JSON.parse(line)));
        t.judgeCalls=observation.judgeCalls??[];
        for(const score of t.scores){const facts=observation.scoringFacts?.find((f:any)=>f.metricId===score.metricId);if(facts)Object.assign(score,facts);}
        const refresh=(v:any):void=>{if(Array.isArray(v)){v.forEach(refresh);return;}if(v&&typeof v==='object'){Object.values(v).forEach(refresh);if(v.tool&&typeof v.bytes==='number')v.bytes=Buffer.byteLength(JSON.stringify(v.tool));}};
        refresh(observation);
        t.execution=facts.status==='not-started'&&!facts.started?null:{...facts,observations:events,evidence:observation.evidence,
            artifacts:facts.artifacts.map((a:any)=>{if(!/^artifacts\/artifact-\d+\.json$/.test(a.file))throw Error('Invalid artifact reference');return read(expected+a.file);})};
        if(t.dimensions&&!isDeepStrictEqual(t.dimensions,dimensions(t.scores,!!t.execution?.started)))throw Error('Dimension summary differs from original scores');
        delete t.evidence;
        delete t.dimensions;
    }
    try { report.export = read('export.json'); }
    catch (error) {
        if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'ENOENT') throw error;
        report.export = { backend: 'local', status: 'disabled' };
    }
    return report as LocalReport;
}
