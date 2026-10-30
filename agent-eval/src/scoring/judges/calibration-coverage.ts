import { isDeepStrictEqual } from 'node:util';
import type { CalibrationReport } from './calibration.ts';
import type { JudgeCall } from '../types.ts';
import { compactScores, semanticMetricBatchRubric, type CompactPlan } from './compact.ts';
import { metricEvaluatorSnapshots } from './evaluators.ts';

/** Matching describes scope and versions, never Judge quality or human acceptance. */
export function calibrationCoverage(report:CalibrationReport|undefined,plan:CompactPlan,configuration:JudgeCall['configuration']|undefined){
 const metricIds=plan.criteria.map(c=>c.metricId);
 const result=(state:'not-provided'|'insufficient-coverage'|'version-mismatch'|'matched',reason:string)=>
  ({state,reason,metricIds,reference:report?.executionId??null,kind:report?.kind??null,acceptance:'not-assessed' as const});
 if(!report)return result('not-provided','No independent calibration reference provided');
 if(!configuration)return result('version-mismatch','The target Judge configuration is unavailable');
 const {rubric:_,...connection}=configuration,{rubric:__,...original}=report.configuration;
 if(report.history||report.scoringVersion!==2||new Set(report.evaluators?.map(def=>def.id)).size!==report.evaluators?.length||
  !isDeepStrictEqual(connection,original)||!report.rubrics.some(r=>isDeepStrictEqual(r,semanticMetricBatchRubric)))
  return result('version-mismatch','Judge, batch rules or selected Evaluator definitions differ');
 const definitions=metricEvaluatorSnapshots(plan);
 if(definitions.some(def=>!report.evaluators?.some(saved=>saved.id===def.id)))
  return result('insufficient-coverage','The reference does not cover every selected Metric');
 if(definitions.some(def=>!report.evaluators?.some(saved=>isDeepStrictEqual(saved,def))))
  return result('version-mismatch','Selected Evaluator definitions differ');
 const scope=(p:CompactPlan)=>JSON.stringify(p.criteria.map(c=>c.metricId).sort());
 const relevant=report.samples.filter(s=>scope(s.plan??s.reference.plan)===scope(plan));
 if(!report.executionComplete||!['tune','validation'].every(partition=>relevant.some(s=>s.partition===partition&&s.call?.error===null&&
  s.call.responseComplete&&compactScores(s.call).every(score=>score.status!=='ERROR'&&score.status!=='NOT_RUN'))))
  return result('insufficient-coverage','Matching single or combined scope lacks completed independent tune and validation references');
 return result('matched','Scope and versions match; semantic acceptance remains not assessed');
}
