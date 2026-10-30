import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { AgentKernel, AgentTrial, AgentTrialSession } from '../adapters/agent.ts';
import type { CaseExecutionResult } from '../types.ts';
import { scanEvidence } from './evidence-safety.ts';
import { z } from 'zod';
import { artifactJson } from '../artifacts.ts';
const inputSchema = z.object({ prompt: z.string(), materials: z.array(z.object({ sample: z.string(), file: z.string(), text: z.string() }).strict()) }).strict();
const bounded = async <T>(promise: Promise<T>, ms: number): Promise<T> => {
    let timer: ReturnType<typeof setTimeout>;
    try {
        return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Lifecycle timeout')), ms); })]);
    }
    finally {
        clearTimeout(timer!);
    }
};
function actorsStopped(execution: CaseExecutionResult, trial: AgentTrial): boolean {
    if(execution.error?.code==='stop_unconfirmed'||execution.evidence['original-stop-gaps'])return false;
    const race=execution.evidence['case-controller'];
    if(race?.present&&z.object({profile:z.object({id:z.literal('invoice-save-cancel-race')}).passthrough(),
        exposure:z.object({verified:z.literal(true)}).passthrough(),stopConfirmed:z.literal(false)}).passthrough().safeParse(race.actual).success)return false;
    const fact=execution.evidence.runs;
    const runs=fact?.present?z.array(z.object({runId:z.number().int().positive(),status:z.enum(['completed','failed','cancelled']),
        endedAt:z.string().datetime(),stoppedAt:z.string().datetime(),cleanup:z.object({stopped:z.literal(true),lateObservationRequired:z.literal(false)}).passthrough()}).passthrough()).safeParse(fact.actual):null;
    if(!runs?.success||(execution.started&&!runs.data.length))return false;
    const childFact=execution.evidence.subagents;
    const children=z.object({children:z.array(z.object({childRunId:z.number().int().positive(),childSessionId:z.number().int().positive(),
        parentRunId:z.number().int().positive(),parentSessionId:z.number().int().positive(),status:z.enum(['completed','failed','cancelled']),stopConfirmed:z.literal(true),
        cleanup:z.object({stopped:z.literal(true),lateObservationRequired:z.literal(false)}).passthrough()}).passthrough()),stopUnconfirmed:z.array(z.unknown()).length(0)}).passthrough().safeParse(childFact?.actual);
    if(childFact||trial.requires.includes('subagent')||runs.data.some(run=>run.kind==='subagent')){
        if(!childFact?.present||!children.success||!children.data.children.every(child=>
            runs.data.some(run=>run.runId===child.childRunId&&run.sessionId===child.childSessionId&&run.kind==='subagent'&&run.parentRunId===child.parentRunId)&&
            runs.data.some(run=>run.runId===child.parentRunId&&run.sessionId===child.parentSessionId&&run.kind==='agent'))||
            !runs.data.filter(run=>run.kind==='subagent').every(run=>children.data.children.some(child=>child.childRunId===run.runId)))return false;
    }
    const historyFact=execution.evidence['history-operations'];
    if(historyFact||trial.requires.includes('compaction')||trial.steps?.some(step=>['compact-history','restart-host'].includes(step.action))){
        const history=z.array(z.object({action:z.string(),verified:z.boolean().optional(),after:z.unknown().optional()}).passthrough()).safeParse(historyFact?.actual);
        if(!historyFact?.present||!history.success||!history.data.every(operation=>operation.action==='restart-host'?operation.verified===true:
            operation.action!=='compact-history'||z.object({operation:z.object({phase:z.literal('ended'),stopped:z.literal(true)}).passthrough()}).passthrough().safeParse(operation.after).success))return false;
    }
    return true;
}
export type ExecutionPhase = 'preparing' | 'executing' | 'capturing' | 'cleanup';
export async function executeCase(kernel: AgentKernel, trial: AgentTrial, timeoutMs: number, stopGraceMs: number, signal?: AbortSignal,
    onPhase?: (phase: ExecutionPhase) => void, limits?: { prepareTimeoutMs: number; captureTimeoutMs: number }) {
    const phase = (value: ExecutionPhase) => { try { onPhase?.(value); } catch { /* Display observers cannot interrupt the lifecycle. */ } };
    const expectedIdentity=structuredClone(trial.identity),original=structuredClone(trial.input);
    let projected=structuredClone(original);
    mkdirSync(trial.directory,{recursive:true});writeFileSync(join(trial.directory,'owner.json'),JSON.stringify(trial.identity),{flag:'wx'});
    let execution: CaseExecutionResult={identity:trial.identity,started:false,status:'not-started',endpointReached:false,input:trial.input,answer:null,
        artifacts:[],observations:[],evidence:{},configuration:trial.configuration,usage:{},startedAt:null,endedAt:null};
    let session:AgentTrialSession|undefined,stopFailed=false,timedOut=false,captureTimedOut=false,capturing=false,proved=false;
    let initialSnapshotFailed=false,finalSnapshotObserved=false,executionError:CaseExecutionResult['error'],stopEvidenceError:CaseExecutionResult['error'];
    let captureError:{stage:'capturing';code:string;message:string;infrastructure:boolean}|undefined;
    const lifecycleErrors:Array<{stage:string;error:string}>=[];
    const controller=new AbortController();const abort=()=>controller.abort();signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)controller.abort();
    let timer:ReturnType<typeof setTimeout>|undefined,cancellation:Promise<void>|undefined;
    const cancel=()=>{if(!cancellation){try{cancellation=bounded(session!.cancel(),stopGraceMs);}catch(error){cancellation=Promise.reject(error);}void cancellation.catch(()=>{});}return cancellation;};
    const observe=(value:CaseExecutionResult)=>{
        const previous=execution;execution=structuredClone(value);
        if(!isDeepStrictEqual(value.identity,expectedIdentity))throw Error('Actor observation belongs to another Trial');
        if(previous.started&&!execution.started){execution.started=true;execution.startedAt??=previous.startedAt;if(previous.error){execution.error=previous.error;execution.status=previous.status;}}
        if(execution.error?.code==='stop_unconfirmed'&&execution.error.infrastructure){stopFailed=true;stopEvidenceError=execution.error;}
    };
    const captureGap=(error:unknown)=>{
        lifecycleErrors.push({stage:'capturing',error:String(error)});
        captureError={stage:'capturing',code:signal?.aborted?'evidence_capture_cancelled':captureTimedOut||error instanceof Error&&error.message==='Lifecycle timeout'?'evidence_capture_timeout':'evidence_capture_failed',message:String(error),infrastructure:!signal?.aborted};
        const previous=execution.evidence['capture-gaps'];
        execution.evidence['capture-gaps']={present:false,actual:[...(Array.isArray(previous?.actual)?previous.actual:[]),String(error)],source:'Observed bounded original evidence collection failure; actor outcome retained'};
        execution.endpointReached=false;
        if(!execution.error){execution.status=signal?.aborted?'cancelled':'error';execution.error={code:captureError.code,message:captureError.message,infrastructure:captureError.infrastructure};}
    };
    const probe=async(stage:string)=>{try{observe(await bounded(session!.snapshot({stopOnly:true}),stopGraceMs));return actorsStopped(execution,trial);}catch(error){lifecycleErrors.push({stage,error:String(error)});return false;}};
    try{
        if(controller.signal.aborted)throw Error('Cancelled before preparation');
        phase('preparing');const preparing=kernel.prepare(trial,controller.signal);
        let abortPreparation!:()=>void;
        const cancelledPreparation=new Promise<never>((_,reject)=>{abortPreparation=()=>reject(Error('Cancelled during preparation'));controller.signal.addEventListener('abort',abortPreparation,{once:true});if(controller.signal.aborted)abortPreparation();});
        try{session=await bounded(Promise.race([preparing,cancelledPreparation]),limits?.prepareTimeoutMs ?? timeoutMs);}
        catch(error){controller.abort();stopFailed=true;void preparing.then(async late=>{try{await bounded(late.cancel(),stopGraceMs);}finally{await bounded(late.close(),stopGraceMs);}}).catch(()=>{});throw error;}
        finally{controller.signal.removeEventListener('abort',abortPreparation);}
        projected=inputSchema.parse(session.input);
        if(projected.prompt!==original.prompt||(!trial.setup&&!isDeepStrictEqual(projected,original)))throw Error('Unapproved initial input mutation');
        if(projected.materials.some(material=>!original.materials.some(item=>item.sample===material.sample&&item.file===material.file)))throw Error('Unregistered material in prepared input');
        if((scanEvidence(projected).fact.actual as {leaked:boolean}).leaked)throw Error('Secret in prepared input');
        writeFileSync(join(trial.directory,'input.json'),artifactJson({original,input:projected,setup:trial.setup}),{flag:'wx'});
        if(controller.signal.aborted)throw Error('Cancelled before model execution');
        const cancelled=new Promise<never>((_,reject)=>{controller.signal.addEventListener('abort',()=>reject(Error(captureTimedOut?'Evidence collection deadline':timedOut?'Task budget exhausted':'Cancelled')),{once:true});});
        timer=setTimeout(()=>{timedOut=true;controller.abort();},timeoutMs);phase('executing');
        const completed=await Promise.race([session.execute(controller.signal,facts=>{
            if(controller.signal.aborted)throw Error('Actor task already cancelled');
            if(capturing)throw Error('Duplicate quiescence observation');
            observe(facts);
            if(!actorsStopped(execution,trial)){stopFailed=true;throw Error('Original actor stopping unconfirmed before capture');}
            proved=true;clearTimeout(timer);capturing=true;phase('capturing');
            // Read-only capture has its own limit after every model actor is stopped.
            timer=setTimeout(()=>{captureTimedOut=true;controller.abort();},limits?.captureTimeoutMs ?? timeoutMs);
        }),cancelled]);
        observe(completed);
    }catch(error){
        if(capturing){captureGap(error);controller.abort();}
        else{
            controller.abort();if(session){cancel();initialSnapshotFailed=!await probe('snapshot-after-execution-error');}
            executionError={code:timedOut?'task_timeout':signal?.aborted?'cancelled':'execution_error',message:String(error),infrastructure:!timedOut&&!signal?.aborted};
            const knownFailure=execution.status==='failed'&&execution.error&&execution.error.code!=='stop_unconfirmed';
            if(!knownFailure){execution.status=signal?.aborted?'cancelled':timedOut?'timeout':execution.started?'error':'not-started';execution.error=executionError;}
            execution.endpointReached=false;
        }
    }finally{
        clearTimeout(timer);signal?.removeEventListener('abort',abort);
        if(session){
            let cancelFailed=false;
            if(controller.signal.aborted&&!proved){
                try{await cancel();}catch(error){cancelFailed=true;lifecycleErrors.push({stage:'cancel',error:String(error)});}
                const controlled={status:execution.status,error:execution.error};
                finalSnapshotObserved=await probe('snapshot-after-cancel');
                proved=finalSnapshotObserved;
                if(controlled.error&&execution.error?.code!=='stop_unconfirmed'){execution.status=controlled.status;execution.error=controlled.error;execution.endpointReached=false;}
                if(cancelFailed||!proved)stopFailed=true;
                // A stopped timeout/failure can still collect its original evidence, without extending actor execution.
                if(proved&&!cancelFailed&&!signal?.aborted){
                    phase('capturing');const controlledAfterStop={status:execution.status,error:execution.error};
                    let abortCollection!:()=>void;
                    const cancelledCollection=new Promise<never>((_,reject)=>{
                        abortCollection=()=>reject(Error('Evidence collection cancelled'));
                        signal?.addEventListener('abort',abortCollection,{once:true});
                    });
                    try{
                        if(signal?.aborted)throw Error('Evidence collection cancelled');
                        observe(await bounded(Promise.race([session.snapshot(),cancelledCollection]),limits?.captureTimeoutMs ?? timeoutMs));
                        execution.status=controlledAfterStop.status;execution.error=controlledAfterStop.error;execution.endpointReached=false;
                    }
                    catch(error){captureGap(error);}
                    finally{signal?.removeEventListener('abort',abortCollection);}
                }
            }
            phase('cleanup');
            try{
                const cleanup=await bounded(session.close(),stopGraceMs);execution.evidence.cleanup=cleanup;
                const receipt=z.object({closed:z.literal(true),stopped:z.literal(true)}).passthrough().safeParse(cleanup.actual);
                if(!cleanup.present||!receipt.success)throw Error('Cleanup not proven');
                if(cancelFailed){stopFailed=true;execution.status='error';execution.error={code:'cleanup_failed',message:lifecycleErrors.find(item=>item.stage==='cancel')?.error??'Cancellation failed',infrastructure:true};}
            }catch(error){stopFailed=true;lifecycleErrors.push({stage:'close',error:String(error)});if(!execution.error){execution.error={code:'cleanup_failed',message:String(error),infrastructure:true};}execution.status='error';}
        }else phase('cleanup');
    }
    const originalRuns=execution.evidence.runs;
    const race=execution.evidence['case-controller'];
    if(race?.present&&z.object({profile:z.object({id:z.literal('invoice-save-cancel-race'),version:z.literal(1)}).passthrough(),
        exposure:z.object({verified:z.literal(true)}).passthrough(),stopConfirmed:z.literal(false)}).passthrough().safeParse(race.actual).success){
        stopFailed=true;execution.status='error';execution.endpointReached=false;
        execution.error??={code:'stop_unconfirmed',message:'Original save cancellation did not confirm every descendant stopped; later cleanup cannot authorize another Trial.',infrastructure:true};
    }
    const stopping=originalRuns?.present?z.array(z.object({runId:z.number().int().positive(),status:z.enum(['created','running','completed','failed','cancelled']),
        stoppedAt:z.string().datetime().nullable(),cleanup:z.object({stopped:z.boolean(),lateObservationRequired:z.boolean()}).passthrough()}).passthrough()).safeParse(originalRuns.actual):null;
    if(stopping?.success&&stopping.data.some(run=>!['created','running'].includes(run.status)&&(!run.cleanup.stopped||run.cleanup.lateObservationRequired))){
        stopFailed=true;execution.status='error';execution.endpointReached=false;
        execution.error??={code:'stop_unconfirmed',message:'Original terminal Run stopping was unconfirmed; later cleanup does not authorize another Trial.',infrastructure:true};
    }
    if(execution.error?.code==='stop_unconfirmed'&&execution.error.infrastructure){
        stopFailed=true;execution.status='error';execution.endpointReached=false;
    }
    if (!isDeepStrictEqual(execution.identity, expectedIdentity)) {
        execution.evidence['identity-conflict'] = { present: true, actual: { expected: expectedIdentity, observed: structuredClone(execution.identity) },
            source: 'Controller identity comparison; conflicting original evidence is preserved without attribution' };
        execution.identity = structuredClone(expectedIdentity);
        execution.status = 'error';
        execution.endpointReached = false;
        stopFailed = true;
        execution.error = { code: 'identity_mismatch', message: 'Agent evidence belongs to another Trial', infrastructure: true };
    }
    if(initialSnapshotFailed&&(!finalSnapshotObserved||!actorsStopped(execution,trial)))stopFailed=true;
    if(lifecycleErrors.length||stopEvidenceError)execution.evidence['lifecycle-diagnostics']={present:true,actual:{errors:lifecycleErrors,executionError:executionError??null,
        ...(stopEvidenceError?{stopError:stopEvidenceError}:{}),...(captureError?{captureError}:{}),...(initialSnapshotFailed?{stopReconciled:!stopFailed}:{})},source:'Observed controller lifecycle exceptions; actor stop proof and complete evidence collection are separate'};
    // A Trial also owns non-Run operations and stopping; original Run timestamps remain in evidence.
    execution.endedAt = new Date().toISOString();
    const scanned = scanEvidence(execution);
    execution = scanned.value;
    execution.evidence['redaction-scan'] = scanned.fact;
    writeFileSync(join(trial.directory, 'execution.json'), artifactJson(execution));
    return { execution, stopFailed, projected };
}
