import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, lstatSync } from 'node:fs';
import { basename, dirname, join, relative, resolve, isAbsolute } from 'node:path';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { experimentPlanSchema,baselineReferenceSchema,gateThresholdsSchema,type GateThresholds, type ExperimentPlan, type ExperimentArm, type ExperimentRecord, type BaselineRecord,
  type GateResult, type ExperimentComparison } from '../../../packages/contracts/src/evaluation-experiments.ts';
import { findDataset } from '../execution/plan.ts';
import { runBatch } from '../execution/runner.ts';
import { resolveEvaluationBudgets } from '../execution/budgets.ts';
import { agentConfig, evaluationEnv, localAgentCredential, prepareAgentConfig, prepareAgentConnection, sameAgentConnection,
  type EvaluationAgentCredential } from '../configuration.ts';
import { productAgent } from '../adapters/agent.ts';
import { codeIdentity, changedSourcePaths, type EvaluationRuntime } from '../execution/source.ts';
import { inside, selectCases, type LocalDataset } from '../dataset-loader/local.ts';
import { atomicJson, acquireEvaluationWrite } from '../reports/files.ts';
import { readReport, reportPath, safeId } from '../reports/store.ts';
import { compareExecutionSets, evidenceValidity, assessGate,baselineReference,defaultGateThresholds, type ExecutionEvidence } from './compare.ts';
import { createArchive, archiveReference, findArchive, listArchives, readArchive, readArchivePart, readSnapshot, writeArchivePart, finishArchive } from '../reports/archive.ts';
import { writeRunReadme } from '../reports/readme.ts';
import { readScoringRevision, readScoringRevisionReport } from '../execution/score-retry.ts';
export { experimentPlanSchema };
export type { ExperimentPlan, ExperimentRecord, BaselineRecord, GateResult, ExperimentComparison };

function directory(repo: string, parts: string[], create = true) {
  let root=realpathSync(repo);
  for(const part of ['agent-eval',...parts]) {
    root=join(root,part); if(!existsSync(root)) { if(create)mkdirSync(root); else continue; }
    if(lstatSync(root).isSymbolicLink()||realpathSync(root).toLowerCase()!==resolve(root).toLowerCase())throw Error('Linked experiment directory rejected');
  }
  return root;
}
function file(repo:string,kind:'records'|'baselines'|'gates'|'comparisons',id:string,experimentId?:string,create=true) {
  safeId(id);
  if(kind==='records')return archiveReference(findArchive(repo,id),'experiment');
  if(kind==='baselines')return join(directory(repo,[],create),'baselines.json');
  if(!experimentId)throw Error('Experiment identity is required for comparisons and gates');
  return archiveReference(findArchive(repo,safeId(experimentId)),kind,id);
}
function read<T>(repo:string,kind:'records'|'baselines',id:string):T {
  if(kind==='records')return readArchivePart(file(repo,kind,id,undefined,false));
  const value=list<BaselineRecord>(repo,'baselines').find(item=>item.id===id);if(!value)throw Error('Unknown Baseline');return value as T;
}
function list<T>(repo:string,kind:'records'|'baselines'):T[] {
  if(kind==='records')return listArchives(repo).flatMap(path=>{const record=readArchive(path).experiment;return record?[record as T]:[];});
  const path=join(directory(repo,[],false),'baselines.json');if(!existsSync(path))return [];
  if(lstatSync(path).isSymbolicLink())throw Error('Linked Baseline collection rejected');
  const stored=JSON.parse(readFileSync(path,'utf8'));
  if(stored.contract!=='flowmate-baselines/v1'||!Array.isArray(stored.records)||new Set(stored.records.map((row:any)=>row.id)).size!==stored.records.length)
    throw Error('Invalid Baseline collection');
  return stored.records;
}
export function listExperiments(repo:string):ExperimentRecord[] { return list(repo,'records'); }
export function listBaselines(repo:string):BaselineRecord[] { return list(repo,'baselines'); }
function loadEvidence(repo:string,ids:string[],scoringRevision?:string,runId?:string):ExecutionEvidence[] {
  return ids.map(id=>{
    const path=reportPath(repo,id);
    const revision = scoringRevision && runId ? readScoringRevision(repo,runId,scoringRevision) : undefined;
    const report = revision?.executions[id] ? readScoringRevisionReport(repo,runId!,scoringRevision!,id) : readReport(path);
    return {report,snapshot:readSnapshot(path),evidenceRef:relative(repo,path).replaceAll('\\','/') + (revision ? '&scoringRevision='+revision.id : '')};
  });
}
function armEvidence(repo:string,record:ExperimentRecord,armId:string,scoringRevision?:string) {
  const arm=record.arms.find(arm=>arm.id===armId);
  if(record.status!=='complete'||!arm||arm.status!=='complete')throw Error('Experiment arm is incomplete, stopped or blocked');
  const declaration=[record.plan.control,...record.plan.candidates].find(arm=>arm.id===armId);
  if(!declaration)throw Error('Missing experiment arm declaration');
  const evidence=loadEvidence(repo,arm.executionIds,scoringRevision,record.id),expected=config(record.plan,declaration);
  for(const item of evidence)for(const [key,value]of Object.entries(expected))
    if(!isDeepStrictEqual(item.snapshot.configuration?.[key],value))throw Error('Observed Agent configuration differs from declared arm: '+key);
  return evidence;
}
export type ExperimentDependencies = Omit<NonNullable<Parameters<typeof runBatch>[2]>,'run'|'runtime'> & {
  agentCredentials?: EvaluationAgentCredential[];
  run?: typeof runBatch;
  loadBenchmark?: (repo:string,id:string,revision:number)=>LocalDataset[];
  prepareRuntime?: (repo:string,ref:string,output:string)=>Promise<{runtime:EvaluationRuntime;cleanup:()=>void}>;
};
async function benchmark(repo:string,plan:ExperimentPlan,deps:ExperimentDependencies) {
  if(deps.loadBenchmark)return deps.loadBenchmark(repo,plan.benchmark.id,plan.benchmark.revision);
  if(plan.benchmark.id==='baseline') {
    if(plan.benchmark.revision!==1)throw Error('Original benchmark revision is unavailable');
    return ['flowmate-agent-v1','flowmate-research-v1'].map(dataset=>findDataset(repo,{dataset,version:1}));
  }
  const {loadPublishedBenchmark}=await import('../curation/publication.ts');
  return loadPublishedBenchmark(repo,plan.benchmark.id,plan.benchmark.revision);
}
async function prepareRuntime(repo:string,ref:string,output:string,ownedBase:string) {
  const ownedRoot=realpathSync(ownedBase),target=resolve(output),location=relative(ownedRoot,target);
  if(!location||location.startsWith('..')||isAbsolute(location))throw Error('Runtime checkout must stay inside its owned experiment directory');
  const git=(args:string[])=>execFileSync('git',['-C',repo,...args],{encoding:'utf8',windowsHide:true,stdio:'pipe'}).trim();
  const commit=git(['rev-parse','--verify',ref+'^{commit}']);
  git(['worktree','add','--detach',target,commit]);
  const createdOutput=realpathSync(target);
  if(createdOutput!==target)throw Error('Runtime checkout path changed during creation');
  const cleanup=()=>{
    const currentRoot=realpathSync(ownedBase),currentOutput=realpathSync(target),local=relative(currentRoot,currentOutput);
    if(currentRoot!==ownedRoot||currentOutput!==createdOutput||lstatSync(target).isSymbolicLink()||!local||local.startsWith('..')||isAbsolute(local))
      throw Error('Runtime checkout ownership changed; refusing cleanup outside its original directory');
    git(['worktree','remove','--force',currentOutput]);
  };
  try {
    if(!existsSync(join(output,'bun.lock'))||!existsSync(join(output,'apps/host/main.ts')))throw Error('Referenced source lacks supported Host or pinned dependencies');
    execFileSync(process.env.FLOWMATE_BUN_EXECUTABLE?.trim()||'bun',['--no-env-file','install','--frozen-lockfile'],
      {cwd:output,windowsHide:true,stdio:'pipe',timeout:180000});
    // The existing prepareLocalHost builds this referenced Host for each actual Trial.
    return {runtime:{mode:'development' as const,repository:output},cleanup};
  } catch(error) {cleanup();throw error;}
}
function config(plan:ExperimentPlan,arm:ExperimentArm) {
  return {environment:plan.environment,evaluationBudgets:plan.evaluationBudgets,...arm.model,...(arm.systemPrompt===undefined?{}:{systemPrompt:arm.systemPrompt}),
    ...(arm.strategy===undefined?{}:{strategy:arm.strategy}),...(arm.resources===undefined?{}:{resources:arm.resources})};
}
export async function runExperiment(repo:string,input:unknown,deps:ExperimentDependencies={}):Promise<ExperimentRecord> {
  const plan=experimentPlanSchema.parse(input);
  if(plan.id&&listExperiments(repo).some(record=>record.id===plan.id))throw Error('Experiment identity already exists');
  const archive=createArchive(repo,{selection:plan.benchmark.selection,compare:plan.axes.includes('model'),id:plan.id});
  const id=safeId(plan.id??archive.id),target=archiveReference(archive.file,'experiment'),release=acquireEvaluationWrite(target);
  try {
  const record:ExperimentRecord={contract:'flowmate-experiment/v1',id,createdAt:new Date().toISOString(),plan,
    attribution:plan.axes.length===1?'single-axis':'combination',status:'running',
    arms:[plan.control,...plan.candidates].map(arm=>({id:arm.id,status:'pending',executionIds:[]}))};
  const save=()=>writeArchivePart(target,record); save();
  try {
    const env=evaluationEnv(repo,deps.env??process.env);
    plan.evaluationBudgets ??= resolveEvaluationBudgets(env);
    save();
    const datasets=await benchmark(repo,plan,deps);
    if(!datasets.length)throw Error('Benchmark contains no runnable dataset groups');
    const perArm=datasets.reduce((sum,data)=>sum+selectCases(data,plan.benchmark.selection).length*plan.repeats,0),armCount=1+plan.candidates.length;
    deps.onProgress?.({type:'plan',selection:plan.benchmark.selection,evaluationBudgets:plan.evaluationBudgets,caseCount:perArm/plan.repeats,trialsPerCase:plan.repeats,total:perArm*armCount,
      datasets:datasets.map(data=>({id:data.manifest.id,caseCount:selectCases(data,plan.benchmark.selection).length,total:selectCases(data,plan.benchmark.selection).length*plan.repeats*armCount}))});
    const frozenDatasets=structuredClone(datasets);
    const harnessBefore=codeIdentity(repo);
    for(const [index,arm] of [plan.control,...plan.candidates].entries()) {
      const state=record.arms[index]!;
      if(deps.signal?.aborted){record.status='stopped';state.status='stopped';state.reason='Cancelled before arm execution';break;}
      let prepared:Awaited<ReturnType<NonNullable<ExperimentDependencies['prepareRuntime']>>>|undefined;
      state.status='running';save();
      try {
        if(arm.codeRef){
          const ownedRoot=directory(repo,['runs',basename(dirname(archive.file)),'runtime']),output=join(ownedRoot,arm.id);
          prepared=deps.prepareRuntime?await deps.prepareRuntime(repo,arm.codeRef,output):await prepareRuntime(repo,arm.codeRef,output,ownedRoot);
        }
        const runtime=prepared?.runtime??{mode:'development' as const,repository:repo};
        state.runtimeRepository=runtime.mode==='development'?runtime.repository:runtime.layout.runtimeRoot;
        const identity=codeIdentity(state.runtimeRepository,undefined,runtime);
        state.sourceCommit='commit'in identity?String(identity.commit):undefined;
        if(arm.codeRef) {
          const expected=execFileSync('git',['-C',repo,'rev-parse','--verify',arm.codeRef+'^{commit}'],{encoding:'utf8',windowsHide:true}).trim();
          if(runtime.mode!=='development'||realpathSync(runtime.repository)===realpathSync(repo)||state.sourceCommit!==expected)
            throw Error('Referenced code must execute its actual isolated checkout');
        }
        const {loadBenchmark:_,prepareRuntime:__,run:___,agentCredentials:credentials,...runnerDeps}=deps;
        let preparedAgent = arm.model ? undefined : runnerDeps.preparedAgent;
        if ((!runnerDeps.kernel || runnerDeps.kernel === productAgent) && (arm.model || credentials?.length)) {
          const connection = arm.model ? (({reasoning:_,...connection})=>connection)(arm.model)
            : credentials?.length === 1 ? credentials[0]!.connection : agentConfig(repo,env).configuration;
          const matching = credentials?.filter(entry=>sameAgentConnection(entry.connection,connection)) ?? [];
          if (matching.length > 1) throw Error('Ambiguous explicit Agent credentials for experiment arm');
          const controlKey = index === 0 && plan.axes.includes('model') && plan.candidates.length === 1 && sameAgentConnection(connection, { model: 'deepseek-flash', api: 'anthropic-messages',
            baseUrl: 'https://api.deepseek.com/anthropic' }) ? env.FLOWMATE_EVAL_DEEPSEEK_API_KEY?.trim() : undefined;
          const key = localAgentCredential(connection) ?? matching[0]?.apiKey ?? controlKey;
          preparedAgent = key ? await prepareAgentConnection(connection,key,undefined,{fetcher:deps.fetcher,signal:deps.signal})
            : await prepareAgentConfig(repo,env,connection,undefined,{fetcher:deps.fetcher,signal:deps.signal});
        }
        const results=await(deps.run??runBatch)(repo,{datasets:structuredClone(frozenDatasets),selection:plan.benchmark.selection,
          repeat:plan.repeats,backend:'local',judge:'required',config:config(plan,arm)},
          {...runnerDeps,runFile:archive.file,env,runtime,preparedAgent,onProgress(event){
            if(event.type==='dataset-start'&&!state.executionIds.includes(event.executionId)){state.executionIds.push(event.executionId);save();}
            if(event.type!=='plan')deps.onProgress?.('index'in event?{...event,index:event.index+index*perArm,total:perArm*armCount}:event);
          }});
        for(const result of results)if(!state.executionIds.includes(result.report.executionId))state.executionIds.push(result.report.executionId);
        if(deps.signal?.aborted||results.some(r=>r.stopped)){state.status='stopped';record.status='stopped';state.reason='Execution stopped; original facts retained';}
        else if(results.length!==datasets.length||results.some(r=>!r.report.executionComplete||r.report.sourceInvalidation))
          {state.status='blocked';record.status='blocked';state.reason='Incomplete dataset groups or source invalidation';}
        else state.status='complete';
        if(changedSourcePaths(harnessBefore,codeIdentity(repo)).length){state.status='blocked';record.status='blocked';state.reason='Common harness source changed during experiment';}
      } catch(error) {state.status='blocked';record.status='blocked';state.reason=error instanceof Error?error.message:String(error);}
      finally {prepared?.cleanup();save();}
      if(record.status!=='running')break;
    }
    if(record.status==='running')record.status='complete';
  } catch(error) {record.status='blocked';record.reason=error instanceof Error?error.message:String(error);}
  save();finishArchive(archive.file, record.status === 'complete' ? 'complete' : record.status === 'stopped' ? 'stopped' : 'blocked');writeRunReadme(archive.file);return record;
  } finally {release();}
}
export function compareExperiment(repo:string,id:string,scoringRevision?:string):ExperimentComparison[] {
  const record=read<ExperimentRecord>(repo,'records',id);
  return record.plan.candidates.map(candidate=>{
    let comparison:ExperimentComparison;
    try {comparison=compareExecutionSets(armEvidence(repo,record,record.plan.control.id,scoringRevision),armEvidence(repo,record,candidate.id,scoringRevision),record.plan.axes);}
    catch(error){comparison=blockedComparison(record,String(error));}
    writeArchivePart(file(repo,'comparisons',candidate.id+(scoringRevision?'-'+scoringRevision:''),id),comparison);return comparison;
  });
}
function blockedComparison(record:ExperimentRecord,reason:string):ExperimentComparison {
  return {status:'blocked',reasons:[{code:'experiment-unavailable',message:reason,evidenceRefs:[`agent-eval/experiments/${record.id}/experiment.json`]}],
    metrics:[],assertions:[],scope:{selection:record.plan.benchmark.selection,datasets:[],cases:0,trials:0},attribution:record.attribution,evidenceKind:'unknown'};
}
export function createBaseline(repo:string,input:{experimentId:string;armId:string;baselineId?:string;scoringRevision?:string}):BaselineRecord {
  const record=read<ExperimentRecord>(repo,'records',input.experimentId),evidence=armEvidence(repo,record,input.armId,input.scoringRevision);
  const comparison=compareExecutionSets(evidence,evidence,[]),invalid=evidenceValidity(evidence);
  if(comparison.status==='blocked'||invalid.length)throw Error('Baseline requires complete measured original evidence: '+[...comparison.reasons,...invalid].map(r=>r.message).join('; '));
  const id=safeId(input.baselineId??'baseline-'+randomUUID()),target=file(repo,'baselines',id),release=acquireEvaluationWrite(target);
  try {
  const previous=listBaselines(repo);
  if(previous.some(value=>value.id===id))throw Error('Baseline identity already exists; existing baselines are never automatically replaced');
  const baseline:BaselineRecord={contract:'flowmate-baseline/v1',id,createdAt:new Date().toISOString(),experimentId:record.id,armId:input.armId,
    executionIds:[...record.arms.find(arm=>arm.id===input.armId)!.executionIds],...(input.scoringRevision?{scoringRevision:input.scoringRevision}:{}),plan:record.plan,
    conditions:evidence.map(e=>({dataset:e.report.dataset,scoringConfiguration:e.report.scoringConfiguration,snapshot:e.snapshot})),evidenceKind:comparison.evidenceKind,
    reference:baselineReference(evidence,comparison),thresholds:defaultGateThresholds(comparison)};
  atomicJson(target,{contract:'flowmate-baselines/v1',records:[...previous,baseline]});return baseline;
  } finally {release();}
}
export function checkGate(repo:string,input:{baselineId:string;experimentId:string;armId:string;fullRelease?:boolean;scoringRevision?:string}):GateResult {
  const record=read<ExperimentRecord>(repo,'records',input.experimentId);let comparison:ExperimentComparison,thresholds:GateThresholds|undefined;
  try {
    const baseline=read<BaselineRecord>(repo,'baselines',input.baselineId);
    if(!baseline.reference||!baseline.thresholds)throw Error('Baseline reference metrics and thresholds are unavailable; old records remain read-only');
    const reference=baselineReferenceSchema.parse(baseline.reference);thresholds=gateThresholdsSchema.parse(baseline.thresholds);
    const left=loadEvidence(repo,baseline.executionIds,baseline.scoringRevision,baseline.experimentId);
    if(!isDeepStrictEqual(baseline.plan.benchmark,record.plan.benchmark)||baseline.plan.repeats!==record.plan.repeats||baseline.plan.environment!==record.plan.environment)
      throw Error('Baseline benchmark revision, selection, repeats or environment differs');
    const conditions=left.map(e=>({dataset:e.report.dataset,scoringConfiguration:e.report.scoringConfiguration,snapshot:e.snapshot}));
    if(!isDeepStrictEqual(conditions,baseline.conditions))throw Error('Baseline original conditions changed since explicit creation');
    if(!isDeepStrictEqual(baselineReference(left),reference))throw Error('Baseline reference measurements changed since explicit creation');
    comparison=compareExecutionSets(left,armEvidence(repo,record,input.armId,input.scoringRevision),record.plan.axes);
  } catch(error){comparison=blockedComparison(record,String(error));}
  const gate:GateResult={...input,...assessGate(comparison,input.fullRelease,thresholds),id:'gate-'+randomUUID()};
  writeArchivePart(file(repo,'gates',gate.id!,record.id),gate);return gate;
}
