import {z} from 'zod';
import {isDeepStrictEqual} from 'node:util';
import {ToolCallSnapshotSchema} from '../../../../packages/contracts/src/tool-evidence.ts';
import {invoiceToolSchemas} from '../../../../packages/contracts/src/invoice.ts';
import {NativeToolOutputSchema,NATIVE_TOOL_NAMES} from '../../../../packages/contracts/src/tools.ts';
import {RunScopeSchema} from '../../../../packages/contracts/src/tool-config.ts';
import {SubagentDetailSchema,SubagentProvenanceSchema} from '../../../../packages/contracts/src/subagents.ts';
import {FrozenInputDefinitionsSchema} from '../../../../packages/contracts/src/input-commands.ts';
import {RunResourceViewSchema} from '../../../../packages/contracts/src/resources.ts';
import {PublicContextRequestEvidenceSchema,ContextSnapshotDetailSchema} from '../../../../packages/contracts/src/context.ts';
import {formalRules,formalMetricMethod} from '../formal-rules.ts';
import {formalMetric} from '../catalog.ts';
import type {EvaluationContext,EvaluationScore,MetricPlan} from '../types.ts';
import {isRequiredScore} from '../types.ts';

const id=z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const runSchema=z.object({runId:id,sessionId:id,kind:z.enum(['agent','subagent','provider']),parentRunId:id.nullable().optional(),originToolCallId:id.nullable().optional(),
    status:z.enum(['created','running','completed','failed','cancelled']),scope:RunScopeSchema,stoppedAt:z.string().nullable(),cleanup:z.record(z.unknown()),config:z.record(z.unknown())}).passthrough();
const contextsSchema=z.array(z.object({runId:id,collected:z.boolean(),requests:z.array(PublicContextRequestEvidenceSchema),snapshots:z.array(ContextSnapshotDetailSchema)}).strict());

/** Known failures survive incomplete collections; a missing denominator is never reconstructed from successes. */
export function evaluateFormalMetrics(context:EvaluationContext):EvaluationScore[]{
    if(!('contract'in context.task))return[];
    const {result,task}=context;
    function original<T>(key:string,schema:z.ZodType<T>):T|undefined{
        const fact=result.evidence[key];if(!fact?.source.trim()||fact.actual===null||fact.actual===undefined)return;
        const parsed=schema.safeParse(fact.actual);return parsed.success?parsed.data:undefined;
    }
    const rawTools=original('tool-evidence',z.object({calls:z.array(z.object({bytes:id,tool:z.unknown()}).passthrough())}).passthrough());
    const parsedTools=rawTools?.calls.map(c=>({record:c,parsed:ToolCallSnapshotSchema.safeParse(c.tool)}));
    const tools=parsedTools?.every(c=>c.parsed.success&&Buffer.byteLength(JSON.stringify(c.record.tool))===c.record.bytes)&&
        new Set(parsedTools.map(c=>c.parsed.success?c.parsed.data.toolCallId:null)).size===parsedTools.length
        ?parsedTools.map(c=>c.parsed.success?c.parsed.data:null).filter(c=>c!==null):undefined;
    const runs=original('runs',z.array(runSchema)),contexts=original('context-requests',contextsSchema);
    const children=original('subagents',z.object({children:z.array(SubagentDetailSchema)}).passthrough())?.children;
    const controller=original('case-controller',z.object({exposure:z.object({verified:z.boolean()}).passthrough().nullable()}).passthrough());
    function values(metricId:string):Array<boolean|null>|undefined{
        if(task.expected.maxToolCalls===0&&['tool-selection','skill-selection','progressive-reading'].includes(metricId)){
            if(!tools||!runs?.some(r=>r.kind==='agent')||tools.some(call=>!runs.some(r=>r.runId===call.runId&&r.sessionId===call.sessionId)))return;
            if(metricId==='tool-selection'&&tools.length)return[false];
            const forbidden=context.gradedScores?.find(s=>s.metricId==='fact-check/forbidden-skills');
            if(metricId!=='tool-selection'&&forbidden?.status==='FAIL')return[false];
            if(!result.evidence['tool-evidence']?.present||!result.evidence.runs?.present)return;
            if(metricId==='tool-selection')return[true];
            const resources=original('resources',z.array(RunResourceViewSchema));
            if(!result.evidence.resources?.present||!resources||!runs.every(run=>resources.some(r=>r.runId===run.runId&&r.sessionId===run.sessionId&&r.gap===null&&r.evidence!==null))||
                !resources.every(r=>runs.some(run=>r.runId===run.runId&&r.sessionId===run.sessionId)))return;
            return forbidden?.status==='PASS'?[true]:undefined;
        }
        if(metricId==='task-success'){
            if(result.status==='cancelled')return[null];
            if(controller&&controller.exposure?.verified!==true)return;
            const required=context.gradedScores?.filter(s=>isRequiredScore(s,context.scoringContext)&&s.metricId!=='task-success');
            if(!required?.length)return;
            const semantic=context.semanticPlan??task.expected.semantic;
            if(task.expected.metrics.some(m=>!m.notApplicable&&['completion-verification','false-completion'].includes(m.metricId)&&
                (!semantic?.criteria.some(c=>c.metricId===m.metricId)||!context.gradedScores?.some(s=>s.metricId===m.metricId))))return;
            if(required.some(s=>s.status==='FAIL'))return[false];
            if(required.some(s=>s.status!=='PASS'))return[null];
            return[result.status==='completed'&&result.endpointReached];
        }
        if(metricId==='tool-execution')return tools?.filter(c=>c.startedAt!==null).map(call=>{
            if(!runs?.some(r=>r.runId===call.runId&&r.sessionId===call.sessionId))return null;
            if(call.status==='failed'||call.status==='cancelled'||!call.cleanup.stopped||call.runtimeObservation?.afterStructure==='invalid'||call.runtimeObservation?.afterDomain==='invalid')return false;
            if(call.status!=='succeeded'||call.result?.status!=='succeeded'||!call.runtimeObservation)return null;
            const schema=invoiceToolSchemas[call.toolName as keyof typeof invoiceToolSchemas]?.output;
            const structure=schema?schema.safeParse(call.result.data).success:NATIVE_TOOL_NAMES.includes(call.toolName as typeof NATIVE_TOOL_NAMES[number])
                ?NativeToolOutputSchema.safeParse(call.result.data).success:call.runtimeObservation.afterStructure==='valid';
            return structure&&['valid','not_applicable'].includes(call.runtimeObservation.afterDomain)&&call.stoppedAt!==null;
        });
        if(metricId==='runtime-admission')return tools?.map(call=>{
            const run=runs?.find(r=>r.runId===call.runId&&r.sessionId===call.sessionId),observation=call.runtimeObservation;
            if(!run||!observation)return null;
            const schema=invoiceToolSchemas[call.toolName as keyof typeof invoiceToolSchemas]?.input;
            const args=z.object({documentId:id.optional()}).passthrough().safeParse(call.args.final);
            const permitted=run.scope.allowedTools.includes(call.toolName)&&(!args.success||args.data.documentId===undefined||run.scope.allowedDocumentIds.includes(args.data.documentId));
            const valid=schema?schema.safeParse(call.args.final).success:true;
            if(!permitted||!valid)return observation.beforeOutcome==='rejected'&&call.startedAt===null;
            const root=run.kind==='subagent'?runs?.find(r=>r.runId===run.parentRunId&&r.kind==='agent'):run;
            const budget=z.object({maxToolCalls:id}).passthrough().safeParse(root?.config.runtimeBudget);
            if(!budget.success||!result.evidence['tool-evidence']?.present)return null;
            const family=new Set(runs?.filter(r=>r.runId===root?.runId||r.parentRunId===root?.runId).map(r=>r.runId));
            if(tools!.filter(t=>family.has(t.runId)&&t.toolCallId<=call.toolCallId).length>budget.data.maxToolCalls)
                return observation.beforeOutcome==='rejected'&&call.startedAt===null;
            // SDK and remaining-budget rejection need their own original evidence, never inferred from success flags.
            return observation.beforeOutcome==='allowed'?true:null;
        });
        if(metricId==='result-delivery')return tools?.filter(c=>c.result!==null).map(call=>{
            if(!runs?.some(r=>r.runId===call.runId&&r.sessionId===call.sessionId))return null;
            if(call.delivery.state==='failed')return false;
            if(call.delivery.state!=='request_observed'||!contexts)return null;
            return contexts.some(c=>c.runId===call.runId&&c.requests.some(request=>request.binding.sessionId===call.sessionId&&request.binding.callSequence===call.delivery.includedInCallSequence&&
                request.attempts.some(a=>a.wireInclusion==='confirmed'&&a.enteredAt!==null)&&request.binding.includedToolResults.some(r=>r.toolCallId===call.toolCallId&&r.originRunId===call.runId&&
                    r.nativeToolCallId===call.nativeToolCallId&&isDeepStrictEqual(r.context,call.context))));
        });
        if(metricId==='context-delivery')return contexts?.flatMap(c=>c.requests.map(request=>{
            const binding=request.binding,snapshot=c.snapshots.find(s=>s.snapshot.id===binding.snapshotId);
            if(!snapshot)return null;
            return c.runId===binding.runId&&snapshot.snapshot.runId===binding.runId&&snapshot.snapshot.sessionId===binding.sessionId&&snapshot.input.inputId===binding.inputId&&
                request.sdkPayload?.inclusion==='confirmed'&&request.attempts.some(a=>a.wireInclusion==='confirmed'&&a.enteredAt!==null)&&
                (tools?tools.filter(t=>t.runId===binding.runId&&t.context?.requestSequence===binding.requestSequence).every(t=>t.context?.snapshotId===binding.snapshotId):null);
        }));
        if(metricId==='candidate-idempotency'){
            if(!controller?.exposure?.verified||!tools)return;
            const replay=z.object({resends:z.literal(1),input:z.object({runId:id,sessionId:id,toolCallId:id,nativeToolCallId:z.string(),rawArguments:z.unknown(),arguments:z.unknown()}).passthrough(),
                receipt:z.object({created:z.literal(false),receipt:z.object({candidateId:id}).passthrough()}).passthrough()}).passthrough().safeParse(controller.replay);
            if(!replay.success)return[false];
            const input=replay.data.input,call=tools.find(t=>t.toolCallId===input.toolCallId);
            return[!!call&&call.runId===input.runId&&call.sessionId===input.sessionId&&call.nativeToolCallId===input.nativeToolCallId&&call.toolName==='save_invoice_candidate'&&
                isDeepStrictEqual(call.args.raw,input.rawArguments)&&isDeepStrictEqual(call.args.final,input.arguments)&&call.result?.committedCandidateId===replay.data.receipt.receipt.candidateId&&
                controller.before!==undefined&&controller.after!==undefined&&isDeepStrictEqual(controller.before,controller.after)];
        }
        if(metricId==='retry-compliance'){
            if(!tools)return;
            if(controller?.exposure?.verified){
                const direct=ToolCallSnapshotSchema.safeParse(controller.original);
                const wrapped=z.object({tool:ToolCallSnapshotSchema}).passthrough().safeParse(controller.original);
                const original=direct.success?direct.data:wrapped.success?wrapped.data.tool:undefined;
                if(!original)return;
                if(!tools.some(t=>isDeepStrictEqual(t,original)))return[false];
                const recovery=z.object({attempts:z.number().int().nonnegative(),reexecuted:z.boolean().optional(),duplicateSave:z.boolean().optional()}).passthrough().safeParse(controller.recovery);
                if(recovery.success){
                    const policy=z.object({maxRecoveryAttempts:z.number().int().nonnegative()}).passthrough().safeParse(controller.policy);
                    if(!policy.success)return;
                    if(original.toolName==='read_invoice_evidence'){
                        const attempts=tools.filter(t=>t.runId===original.runId&&t.toolCallId>original.toolCallId&&['PURE','READ'].includes(t.effect??''));
                        return[original.status==='failed'&&original.runtimeObservation?.failureStage==='execute'&&attempts.length===recovery.data.attempts&&attempts.length<=policy.data.maxRecoveryAttempts&&
                            !tools.some(t=>t.runId===original.runId&&t.toolName==='save_invoice_candidate')];
                    }
                    const saves=tools.filter(t=>t.toolName==='save_invoice_candidate');
                    return[recovery.data.attempts<=policy.data.maxRecoveryAttempts&&recovery.data.reexecuted!==true&&recovery.data.duplicateSave!==true&&saves.length===1&&
                        typeof original.result?.committedCandidateId==='number'&&original.delivery.state==='failed'];
                }
                const replay=z.object({resends:z.number().int().nonnegative()}).passthrough().safeParse(controller.replay);
                if(replay.success){
                    const policy=z.object({maxResends:z.number().int().nonnegative()}).passthrough().safeParse(controller.policy);
                    if(!policy.success)return;
                    return replay.data.resends>policy.data.maxResends?[false]:values('candidate-idempotency');
                }
            }
            return;
        }
        if(metricId==='cancellation-compliance'||metricId==='subtask-stop'){
            if(!controller?.exposure?.verified||!runs)return;
            if(controller.stopConfirmed!==undefined){
                if(controller.linearization==='commit-unknown')return[null];
                return[controller.stopConfirmed===true&&controller.cancelRequests===1&&controller.resends===0&&runs.every(r=>!['created','running'].includes(r.status)&&r.cleanup.stopped===true&&r.stoppedAt!==null)];
            }
            const stopping=z.object({confirmed:z.boolean()}).passthrough().safeParse(controller.stopping);
            if(!stopping.success||!children)return;
            return[stopping.data.confirmed&&controller.committedFactsPreserved===true&&children.every(c=>c.stopConfirmed&&c.cleanup.lateObservationRequired!==true)];
        }
        if(metricId==='subtask-scope')return children?.map(child=>{
            const parent=runs?.find(r=>r.runId===child.parentRunId&&r.sessionId===child.parentSessionId),call=tools?.find(t=>t.toolCallId===child.originToolCallId);
            const run=runs?.find(r=>r.runId===child.childRunId&&r.sessionId===child.childSessionId);
            if(!parent||!call||!run||!contexts)return null;
            const provenance=SubagentProvenanceSchema.safeParse(run.config.subagent),definitions=FrozenInputDefinitionsSchema.safeParse(parent.config.inputDefinitions);
            if(!provenance.success||!definitions.success)return null;
            const origin=provenance.data,role=definitions.data.roles.find(r=>r.id===child.role);
            if(!role)return false;
            const parentRequest=contexts.find(c=>c.runId===parent.runId)?.requests.find(r=>r.binding.requestSequence===origin.parentRequestSequence);
            const firstRequest=contexts.find(c=>c.runId===child.childRunId)?.requests.find(r=>r.binding.requestSequence===1);
            if(!firstRequest)return null;
            return parent.kind==='agent'&&run.kind==='subagent'&&run.parentRunId===parent.runId&&run.originToolCallId===call.toolCallId&&
                call.runId===parent.runId&&call.sessionId===parent.sessionId&&call.nativeToolCallId===child.parentNativeToolCallId&&call.toolName==='Agent'&&
                isDeepStrictEqual(origin.definition,role)&&origin.role===child.role&&
                parentRequest?.binding.nativeSessionId===origin.parentNativeSessionId&&parentRequest.binding.inputId===origin.parentInputId&&
                parentRequest.binding.snapshotId===origin.parentContextSnapshotId&&call.context?.snapshotId===origin.parentContextSnapshotId&&call.context.requestSequence===origin.parentRequestSequence&&
                firstRequest.binding.nativeSessionId===child.childNativeSessionId&&firstRequest.binding.sessionId===child.childSessionId&&firstRequest.binding.inputId===origin.childInputId&&
                isDeepStrictEqual(run.scope,child.scope)&&child.childSessionId!==child.parentSessionId&&
                child.scope.allowedTools.every(t=>parent.scope.allowedTools.includes(t)&&role.tools.includes(t)&&!['Agent','edit','write','bash','powershell'].includes(t))&&
                tools!.filter(t=>t.runId===child.childRunId).every(t=>['PURE','READ'].includes(t.effect??'')&&child.scope.allowedTools.includes(t.toolName))&&
                child.scope.allowedDocumentIds.every(d=>parent.scope.allowedDocumentIds.includes(d))&&child.scope.allowedArtifactIds.every(a=>parent.scope.allowedArtifactIds.includes(a))&&
                child.scope.allowedResourcePaths.every(p=>parent.scope.allowedResourcePaths.includes(p))&&
                children.filter(c=>c.parentRunId===parent.runId&&c.startedAt!==null&&c.startedAt<=child.startedAt!&&(c.stoppedAt===null||!c.stopConfirmed||c.stoppedAt>child.startedAt!)).length<=4;
        });
        return;
    }
    return task.expected.metrics.flatMap<EvaluationScore>((plan:MetricPlan)=>{
        const rule=formalRules.find(r=>r.metricId===plan.metricId);if(!rule)return[];
        const method=formalMetricMethod(task,plan.metricId)!;
        const metric=formalMetric(plan.metricId),base={metricId:metric.id,name:metric.name,version:metric.version,method,required:metric.id==='task-success',evidence:rule.evidence};
        if(plan.notApplicable)return[{...base,value:null,status:'NOT_APPLICABLE' as const,reason:plan.notApplicable,statistics:{unit:metric.unit,numerator:null,denominator:null,missing:null}}];
        if(task.expected.semantic?.criteria.some(c=>c.metricId===metric.id)||context.semanticPlan?.criteria.some(c=>c.metricId===metric.id))return[];
        if(method!=='deterministic')return[{...base,required:['completion-verification','false-completion'].includes(metric.id),value:null,status:'NOT_RUN',reason:'适用语义判据尚未声明，不能用通用相关性代替',
            statistics:{unit:metric.unit,numerator:null,denominator:plan.denominator??null,missing:plan.denominator??null}}];
        const measured=result.started?values(metric.id):undefined;
        const completeKeys=task.expected.maxToolCalls===0&&['tool-selection','skill-selection','progressive-reading'].includes(metric.id)?['tool-evidence','runs']:
            metric.id==='tool-execution'||metric.id==='runtime-admission'?['tool-evidence','runs']:
            metric.id==='result-delivery'||metric.id==='context-delivery'?['tool-evidence','context-requests','runs']:
            metric.id==='retry-compliance'?['tool-evidence','runs','case-controller']:rule.evidence;
        const complete=completeKeys.every(key=>result.evidence[key]?.present);
        const numerator=measured?measured.filter(v=>v===true).length:null;
        const denominator=plan.denominator??(measured&&complete?measured.length:null);
        const mismatch=measured!==undefined&&denominator!==null&&measured.length>denominator;
        const missing=denominator===null?null:measured?Math.max(0,denominator-measured.length)+measured.filter(v=>v===null).length:denominator;
        const failure=measured?.some(v=>v===false)??false;
        const witnessedFailure=failure&&(metric.id!=='task-success'||context.gradedScores?.some(s=>isRequiredScore(s,context.scoringContext)&&s.status==='FAIL'));
        const knownSuccess=missing===0&&denominator!==null&&denominator>0&&!failure;
        const status:EvaluationScore['status']=!result.started?'NOT_RUN':mismatch?'ERROR':witnessedFailure?'FAIL':knownSuccess?'PASS':result.error?.infrastructure?'ERROR':failure?'FAIL':'UNJUDGEABLE';
        return[{...base,status,value:status==='PASS'||status==='FAIL'&&missing===0?numerator!/denominator!:null,reason:mismatch?'原机会数超过事前声明分母':'原单位逐项核对；已知失败保留，缺证与未暴露不记成功',
            ...(mismatch?{actual:{observedOpportunities:measured!.length,observedNumerator:numerator,expectedDenominator:denominator}}:{}),
            statistics:{unit:metric.unit,numerator:mismatch?null:numerator,denominator,missing:mismatch?denominator:missing}}];
    });
}
