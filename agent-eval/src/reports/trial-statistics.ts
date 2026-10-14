import type { LocalReport, TrialReport } from './store.ts';
import { aggregateTrials, type MetricTotal } from '../scoring/aggregate.ts';
import { formalMetric } from '../scoring/catalog.ts';
import type { GradeStatus } from '../types.ts';
import { isRequiredScore } from '../scoring/types.ts';

export type TrialProbability = { k: number; passAtK: number | null; passAllK: number | null };
export type CaseMetricStatistics = Pick<MetricTotal, 'metricId'|'version'|'unit'|'numerator'|'denominator'|'missing'|'value'|
    'unknownDenominators'|'unknownMissing'|'zeroDenominators'> & {
    name: string; measured: number; applicable: number; issues: string[];
    mean: number | null; variance: number | null; standardDeviation: number | null;
};
export type CaseTrialStatistics = {
    caseId: string; caseVersion: number; planned: number; started: number; statuses: Record<GradeStatus, number>;
    complete: boolean; valid: boolean; reasons: string[];
    trials: Array<{ trialId: string; trialIndex: number; status: GradeStatus }>;
    probabilities: TrialProbability[]; metrics: CaseMetricStatistics[];
};
export type TrialStatistics = {
    trialsPerCase: number; cases: CaseTrialStatistics[];
    dataset: { plannedCases: number; validCases: number; metricsPlanned: number; metricsMeasured: number; probabilities: TrialProbability[] };
};
const states: GradeStatus[] = ['PASS','FAIL','UNJUDGEABLE','ERROR','NOT_RUN'];

function probabilities(n: number, correct: number, valid: boolean): TrialProbability[] {
    let none = 1, all = 1;
    return Array.from({length:n},(_,index)=>{
        const k=index+1;
        none *= Math.max(0,n-correct-index)/(n-index);
        all *= Math.max(0,correct-index)/(n-index);
        return {k,passAtK:valid?1-none:null,passAllK:valid?all:null};
    });
}
function scoringFault(trial: TrialReport) {
    const criteria=trial.semanticPlan?.criteria??[];
    const inactive=new Set(criteria.filter(criterion=>criterion.trigger==='completed-endpoint' &&
        (trial.execution?.status!=='completed'||!trial.execution.endpointReached)).map(criterion=>criterion.metricId));
    const missingRequired=criteria.some(criterion=>{
        if(!criterion.required||inactive.has(criterion.metricId))return false;
        const score=trial.scores.find(score=>score.metricId===criterion.metricId),counts=score?.statistics;
        if(counts?.numerator===0&&counts.denominator===0&&counts.missing===0)return false;
        return !score || !['PASS','FAIL'].includes(score.status) || score.value===null || !counts ||
            counts.numerator===null || counts.denominator===null || counts.missing!==0;
    });
    return trial.execution?.started && trial.execution.error?.infrastructure || trial.scores.some(score=>score.status==='ERROR' ||
        isRequiredScore(score) && !inactive.has(score.metricId) && ['UNJUDGEABLE','NOT_RUN'].includes(score.status)) || missingRequired ||
        trial.judgeCalls.some(call=>call.error || call.responseComplete===false ||
            call.stopReason && call.stopReason!=='stop' || Object.keys(call.compact?.validationErrors??{}).length>0);
}
function executionFinished(trial: TrialReport) {
    return !!trial.execution?.started && !['not-started','cancelled'].includes(trial.execution.status);
}
function metricView(metric: MetricTotal, trials: TrialReport[], planned: number, infer: boolean): CaseMetricStatistics {
    const definition=formalMetric(metric.metricId), values:number[]=[], issues=new Set<string>();let excluded=0;
    for(const trial of trials){
        const plan=trial.metricPlan?.find(plan=>plan.metricId===metric.metricId);
        if(plan?.notApplicable){excluded++;continue;}
        const score=trial.scores.find(score=>score.metricId===metric.metricId);
        const source=metric.sources.find(source=>source.metricId===metric.metricId && source.trialId===trial.trialId);
        let value:number|null=null;
        if(!trial.execution?.started)issues.add('未运行');
        else if(!executionFinished(trial))issues.add('执行中止，未完成');
        else if(metric.metricId==='task-success'){
            if(['PASS','FAIL'].includes(trial.status))value=trial.status==='PASS'?1:0;
            else issues.add(trial.status==='ERROR'?'评分或执行错误':'判定不完整');
        } else if(score?.status==='ERROR')issues.add('评分错误');
        else if(metric.metricId==='DR03'){
            if(score && ['PASS','FAIL'].includes(score.status))value=score.value;
            else issues.add('派生F1证据不足');
        } else if(source && ['PASS','FAIL'].includes(source.status) && source.missing===0 &&
            source.numerator!==null && source.denominator!==null && source.denominator>0) value=source.numerator/source.denominator;
        else issues.add(source?.denominator===0?'零分母':'证据不足');
        if(value!==null && Number.isFinite(value) && infer)values.push(value);
    }
    if(trials.length<planned)issues.add('缺少计划Trial记录');
    if(!infer)issues.add('执行未最终确认或条件失效');
    const mean=values.length?values.reduce((sum,value)=>sum+value,0)/values.length:null;
    const variance=mean!==null&&values.length>1?values.reduce((sum,value)=>sum+(value-mean)**2,0)/(values.length-1):null;
    return {metricId:metric.metricId,name:definition.name,version:metric.version,unit:metric.unit,
        numerator:metric.numerator,denominator:metric.denominator,missing:metric.missing,value:metric.value,
        unknownDenominators:metric.unknownDenominators,unknownMissing:metric.unknownMissing,zeroDenominators:metric.zeroDenominators,
        measured:values.length,applicable:planned-excluded,issues:[...issues],mean,variance,
        standardDeviation:variance===null?null:Math.sqrt(variance)};
}

/** Derived diagnostics never change original grades, opportunity totals or identities. */
export function deriveTrialStatistics(report: LocalReport): TrialStatistics {
    if(!Number.isSafeInteger(report.repeat)||report.repeat<1||report.repeat>20)throw Error('Trials must be 1–20');
    const ids=new Set<string>();
    for(const trial of report.trials){
        if(ids.has(trial.trialId))throw Error('Duplicate Trial identity');
        ids.add(trial.trialId);
    }
    const groups=report.contract==='flowmate-agent-run/v2'?aggregateTrials(report).cases:
        [...new Set(report.trials.map(trial=>JSON.stringify([trial.caseId,trial.caseVersion,trial.caseHash])))].map(key=>{
            const trials=report.trials.filter(trial=>JSON.stringify([trial.caseId,trial.caseVersion,trial.caseHash])===key);
            return {caseId:trials[0]!.caseId,caseVersion:trials[0]!.caseVersion,trials:trials.map(t=>({trialId:t.trialId})),metrics:[] as MetricTotal[]};
        });
    const infer=!!report.endedAt && report.scoring==='complete' && !report.sourceInvalidation;
    const cases:CaseTrialStatistics[]=groups.map(group=>{
        const ownIds=new Set(group.trials.map(trial=>trial.trialId));
        const own=report.trials.filter(trial=>ownIds.has(trial.trialId)).sort((a,b)=>a.repetition-b.repetition);
        const indexes=own.map(trial=>trial.repetition);
        if(new Set(indexes).size!==indexes.length)throw Error('Duplicate Case repetition');
        const started=own.filter(trial=>trial.execution?.started).length;
        const complete=own.length===report.repeat && indexes.every((value,index)=>value===index+1) && own.every(executionFinished);
        const reasons:string[]=[];
        if(!complete)reasons.push('计划Trial未完整启动、结束或序号不完整');
        if(!report.executionComplete)reasons.push('Execution未完整结束');
        if(!infer)reasons.push(report.sourceInvalidation?'执行条件失效':'Execution尚未最终保存');
        if(own.some(trial=>!trial.metricPlan?.length))reasons.push('缺少原始正式指标计划');
        if(own.some(trial=>!['PASS','FAIL'].includes(trial.status)))reasons.push('包含不可判定、错误或未运行Trial');
        if(own.some(scoringFault))reasons.push('包含评分或设施故障');
        const valid=reasons.length===0;
        const plannedMetrics=new Set(own.flatMap(trial=>(trial.metricPlan??[]).filter(plan=>!plan.notApplicable).map(plan=>plan.metricId)));
        return {caseId:group.caseId,caseVersion:group.caseVersion,planned:report.repeat,started,
            statuses:Object.fromEntries(states.map(state=>[state,own.filter(trial=>trial.status===state).length])) as Record<GradeStatus,number>,
            complete,valid,reasons,trials:own.map(trial=>({trialId:trial.trialId,trialIndex:trial.repetition,status:trial.status})),
            probabilities:probabilities(report.repeat,own.filter(trial=>trial.status==='PASS').length,valid),
            metrics:group.metrics.filter(metric=>plannedMetrics.has(metric.metricId)).map(metric=>metricView(metric,own,report.repeat,infer))};
    });
    const valid=cases.filter(c=>c.valid);
    return {trialsPerCase:report.repeat,cases,dataset:{plannedCases:cases.length,validCases:valid.length,
        metricsPlanned:new Set(cases.flatMap(c=>c.metrics.map(m=>m.metricId))).size,
        metricsMeasured:new Set(cases.flatMap(c=>c.metrics.filter(m=>m.measured>0).map(m=>m.metricId))).size,
        probabilities:Array.from({length:report.repeat},(_,index)=>({k:index+1,
            passAtK:valid.length?valid.reduce((sum,c)=>sum+c.probabilities[index]!.passAtK!,0)/valid.length:null,
            passAllK:valid.length?valid.reduce((sum,c)=>sum+c.probabilities[index]!.passAllK!,0)/valid.length:null}))}};
}
