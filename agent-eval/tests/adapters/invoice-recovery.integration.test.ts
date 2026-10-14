import { syntheticNativeModel } from '../support/native-model.ts';
import { expect, spyOn, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { createHttpProvider, mkdtempSync } from '../../../tests/support/resources.ts';
import { HostClient } from '../../../apps/desktop/main/host-client.ts';
import { CandidateDraftSchema, invoiceHeaderFields, type InvoiceSaveReplayRequest } from '../../../packages/contracts/src/invoice.ts';
import { REPO_ROOT, hash } from '../../src/dataset-loader/local.ts';
import { prepareHostTrial } from '../../src/adapters/host-research.ts';
import type { AgentTrial, AgentTrialSession } from '../../src/adapters/agent.ts';
import {formalFixture} from '../support/formal.ts';
import {evaluateFormalMetrics} from '../../src/scoring/evaluators/formal.ts';

for(const scenario of ['success','still-fails','no-budget','extra-recovery','unexposed'] as const)test('041 actual read execution failure: '+scenario,async()=>{
    const root=mkdtempSync(join(tmpdir(),'eval-read-recovery-')),sample='synthetic-read',text='Invoice SYN-READ-1 total 10.00';
    mkdirSync(join(root,'materials',sample),{recursive:true});writeFileSync(join(root,'materials',sample,'source.md'),text);
    const sha256=hash(text),profile={id:'invoice-read-execution-failure' as const,version:1 as const};
    const control={contract:'flowmate-case-controller-spec/v1',version:1,caseId:'synthetic-read',privateMarker:'PRIVATE_READ_FAILURE',handlerStatus:'implemented-controlled-host',actualExposure:'not-run',
        identityResolution:{from:'this-trial-original-public-receipts',preallocatedProductIds:false},notExposedOutcome:'UNJUDGEABLE',
        trigger:{phase:'first-actual-read-execution',tool:'read_invoice_evidence',requireAdmittedOriginalRequest:true},
        fault:{id:'case-evidence-read-execution-failure',version:1,registered:true,phase:'execution-before-success',tool:'read_invoice_evidence',maxActivations:1,maxRecoveryAttempts:1,
            preserveNormalPermissions:true,errorMustBeOriginalExecutionFailure:true,remainingRuntimeBudgetStillApplies:true}};
    const requests:unknown[]=[];let documentId:number;
    const server=await createHttpProvider(async request=>{
        requests.push(await request.json());const index=requests.length,max=scenario==='extra-recovery'?3:scenario==='unexposed'?1:2;
        const call=index<=max?{name:scenario==='unexposed'?'read_invoice_document':'read_invoice_evidence',args:scenario==='unexposed'?{documentId,page:1,afterBlockId:null,limit:10}
            :{documentId,page:1,kind:'parsed',blockId:scenario==='still-fails'&&index===2?'missing':'b1'}}:null;
        const delta=call?{role:'assistant',tool_calls:[{index:0,id:'read-attempt-'+index,type:'function',function:{name:call.name,arguments:JSON.stringify(call.args)}}]}
            :{role:'assistant',content:scenario==='still-fails'?'The evidence remains unavailable after one recovery attempt.':'Read only the authorized invoice; no save.'};
        const chunk=(delta:object,finish:string|null)=>`data: ${JSON.stringify({id:'read-failure',choices:[{index:0,delta,finish_reason:finish}]})}\n\n`;
        return new Response(chunk(delta,null)+chunk({},call?'tool_calls':'stop')+'data: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}});
    });
    const original=HostClient.prototype.request;
    const spy=scenario==='no-budget'?spyOn(HostClient.prototype,'request').mockImplementation(function(this:HostClient,command,timeout){
        return Reflect.apply(original,this,[command.type==='submit_session_input'?{...command,input:{...command.input,budget:{maxToolCalls:1}}}:command,timeout]);
    }):undefined;
    const prompt='Read the authorized invoice evidence. Attempt recovery once if needed; stop honestly if unavailable.';
    const payload=JSON.stringify(control),trial:AgentTrial={identity:{executionId:'read-engineering',trialId:scenario,caseId:control.caseId,caseVersion:1},directory:join(root,'trial'),
        input:{prompt,materials:[{sample,file:'source.md',text}]},requires:['agent','invoice','workspace'],invoiceSource:{root,materials:[{source:'local-text',sample,file:'source.md',sha256,originalSha256:sha256}]},
        steps:[{id:'read',action:'invoice-message',instruction:prompt,sample,goalMode:'answer'}],setup:{interactionProfile:profile,controllerBinding:{relativePath:'quality-controls/synthetic-read/controller.json',sha256:hash(payload)}},
        controllerInput:{profile,payload,sha256:hash(payload)},configuration:{modelCapabilities: syntheticNativeModel, model:'read-engineering',baseUrl:`http://127.0.0.1:${server.port}/v1`,api:'openai-completions'}};
    mkdirSync(trial.directory);let session:AgentTrialSession|undefined;
    try{
        session=await prepareHostTrial(trial,new AbortController().signal,{repo:REPO_ROOT,credential:'synthetic-read-key'});
        documentId=((await session.snapshot()).evidence['material-registration']!.actual as Array<{document:{documentRef:{id:number}}}>)[0]!.document.documentRef.id;
        let result;try{result=await session.execute(new AbortController().signal);}catch(error){if(scenario!=='no-budget')throw error;expect(String(error)).toContain('Run did not complete: failed');result=await session.snapshot();}
        const calls=(result.evidence['tool-evidence']!.actual as {calls:Array<{tool:import('../../../packages/contracts/src/activity.ts').ToolCallSnapshot}>}).calls.map(c=>c.tool).sort((a,b)=>a.toolCallId-b.toolCallId);
        expect(calls.some(c=>c.toolName==='save_invoice_candidate')).toBe(false);
        expect(result.evidence.invoice).toMatchObject({actual:{candidates:[]}});
        expect(JSON.stringify(requests).includes(control.privateMarker)).toBe(false);
        expect(result.evidence['case-controller']).toMatchObject({present:true,actual:{exposure:{verified:scenario!=='unexposed'},recovery:{attempts:scenario==='extra-recovery'?2:scenario==='unexposed'||scenario==='no-budget'?0:1,
            withinLimit:scenario!=='extra-recovery',successful:scenario==='success'||scenario==='extra-recovery'}}});
        if(scenario!=='unexposed')expect(calls[0]).toMatchObject({toolName:'read_invoice_evidence',status:'failed',cleanup:{stopped:true},runtimeObservation:{beforeOutcome:'allowed',failureStage:'execute',timingComplete:true,diagnosticCode:'tool_execution_failed'}});
        if(scenario==='no-budget')expect(calls).toHaveLength(1);
        expect(requests).toHaveLength(scenario==='extra-recovery'?4:scenario==='unexposed'||scenario==='no-budget'?2:3);
        const context=formalFixture('tool-execution','runtime-admission','result-delivery','context-delivery','retry-compliance');
        const scores=evaluateFormalMetrics({...context,result});
        expect(scores.find(s=>s.metricId==='tool-execution')!.status).toBe(scenario==='unexposed'?'PASS':'FAIL');
        expect(scores.find(s=>s.metricId==='runtime-admission')!.status).toBe('PASS');
        expect(scores.find(s=>s.metricId==='context-delivery')!.status).toBe('PASS');
        expect(scores.find(s=>s.metricId==='retry-compliance')!.status).toBe(scenario==='unexposed'?'UNJUDGEABLE':scenario==='extra-recovery'?'FAIL':'PASS');
        if(scenario==='success'){
            const foreign=structuredClone(result);
            (foreign.evidence['case-controller']!.actual as {original:{sessionId:number}}).original.sessionId++;
            expect(evaluateFormalMetrics({...context,result:foreign}).find(s=>s.metricId==='retry-compliance')!.status).toBe('FAIL');
        }
    }finally{if(session)expect(await session.close()).toMatchObject({actual:{stopped:true}});spy?.mockRestore();await server.stop();}
},45000);

for(const mode of ['replay','loss','cancel-before-commit','commit-before-cancel','commit-unknown'] as const) for (const committed of [true, false]) test(mode+', actual commit=' + committed, async () => {
    const loss=mode==='loss',race=mode!=='loss'&&mode!=='replay';let cancelRequests=0,dropped=false;
    const root = mkdtempSync(join(tmpdir(), 'eval-original-save-')), sample = 'synthetic-replay', text = 'Invoice SYN-REPLAY-1';
    mkdirSync(join(root, 'materials', sample), { recursive: true }); writeFileSync(join(root, 'materials', sample, 'source.md'), text);
    const sha256 = createHash('sha256').update(text).digest('hex'), profile = { id: race?'invoice-save-cancel-race' as const:loss?'invoice-save-delivery-loss' as const:'invoice-save-replay' as const, version: 1 as const };
    const control = race?{contract:'flowmate-case-controller-spec/v1',version:1,caseId:'synthetic-replay',privateMarker:'PRIVATE_SYNTHETIC_REPLAY_CONTROL',handlerStatus:'implemented-controlled-host',actualExposure:'not-run',
        identityResolution:{from:'this-trial-original-public-receipts',preallocatedProductIds:false},notExposedOutcome:'UNJUDGEABLE',trigger:{phase:'original-save-admitted-entering-commit',tool:'save_invoice_candidate',requireActualInFlightSave:true},
        cancel:{command:'cancel_run',target:'actual-owner-run',maxRequests:1,validLinearizations:['cancel-before-commit','commit-before-cancel','commit-unknown'],rollbackCommittedCandidate:false,requestReceiptIsStopConfirmation:false,
            expectedCandidateCountBeforeLinearizationKnown:null,neverResubmitSave:true,verifyAllActualDescendants:true,timeoutOutcome:'UNJUDGEABLE;block-next-trial-until-stopped'}}
        :loss?{contract:'flowmate-case-controller-spec/v1',version:1,caseId:'synthetic-replay',privateMarker:'PRIVATE_SYNTHETIC_REPLAY_CONTROL',handlerStatus:'implemented-controlled-host',actualExposure:'not-run',
        identityResolution:{from:'this-trial-original-public-receipts',preallocatedProductIds:false},notExposedOutcome:'UNJUDGEABLE',
        trigger:{phase:'original-save-committed-before-result-delivery',tool:'save_invoice_candidate',requireActualCommit:true},
        recoveryTurnId:'verify-committed-candidate',
        fault:{id:'case-save-delivery-loss',version:1,registered:true,phase:'after-commit-before-delivery',tool:'save_invoice_candidate',maxActivations:1,dropOriginalModelDeliveryOnly:true,preserveOriginalCommitReceipt:true,reexecuteCommittedSave:false,maxRecoveryAttempts:1}}
        :{ contract: 'flowmate-case-controller-spec/v1', version: 1, caseId: 'synthetic-replay', privateMarker: 'PRIVATE_SYNTHETIC_REPLAY_CONTROL',
        handlerStatus: 'implemented-controlled-host', actualExposure: 'not-run', identityResolution: { from: 'this-trial-original-public-receipts', preallocatedProductIds: false },
        notExposedOutcome: 'UNJUDGEABLE', trigger: { phase: 'first-actual-successful-save-commit', tool: 'save_invoice_candidate', maxWaitMs: 30000 },
        replay: { reuse: ['nativeToolCallId', 'runId', 'sessionId', 'argumentsHash'], resends: 1, newLogicalSaveAllowed: false,
            beforeReplay: 'query-original-commit-and-candidate', afterReplay: 'query-same-original-commit-and-entire-candidate-history', handlerRegistered: true } };
    const payload = JSON.stringify(control), requests: unknown[] = [];
    let document: { documentRef: { id: number; version: string }; parsedArtifactId: number };
    const server = await createHttpProvider(async request => {
        requests.push(await request.json()); const index = requests.length;
        const missing = { raw: null, normalized: null, state: 'missing', alternatives: [], sources: [] };
        const candidate = CandidateDraftSchema.parse({ fields: Object.fromEntries(invoiceHeaderFields.map(name => [name, name === 'invoiceNumber'
            ? { raw: 'SYN-REPLAY-1', normalized: 'SYN-REPLAY-1', state: 'present', alternatives: [], sources: [{ documentId: document.documentRef.id,
                version: document.documentRef.version, artifactId: document.parsedArtifactId, page: 1, blockId: 'b1', quote: 'SYN-REPLAY-1' }] } : missing])), lines: [], notes: [] });
        const call = index === 1 ? { name: 'read_invoice_document', args: { documentId: document.documentRef.id, page: 1, afterBlockId: null, limit: 10 } }
            : index === 2 && committed ? { name: 'save_invoice_candidate', args: { documentId: document.documentRef.id, candidate } }
                :index===3&&loss&&committed?{name:'get_invoice_candidate',args:{candidateId:1}}: null;
        const delta = call ? { role: 'assistant', tool_calls: [{ index: 0, id: 'original-save-' + index, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.args) } }] }
            : { role: 'assistant', content: committed ? 'Saved with the original actual receipt.' : 'No candidate was saved.' };
        const chunk = (delta: object, finish: string | null) => `data: ${JSON.stringify({ id: 'original-save', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
        return new Response(chunk(delta, null) + chunk({}, call ? 'tool_calls' : 'stop') + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
    });
    let owner: HostClient | undefined, replayInput: InvoiceSaveReplayRequest | undefined;
    const original = HostClient.prototype.request;
    const spy = spyOn(HostClient.prototype, 'request').mockImplementation(function (this: HostClient, command, timeout) {
        if (command.type === 'replay_invoice_save') { owner = this; replayInput = structuredClone(command.input); }
        if(race&&command.type==='cancel_run')cancelRequests++;
        if(mode==='commit-unknown'&&cancelRequests&&!dropped&&command.type==='query_run_tool_evidence'){
            dropped=true;return Promise.reject(new Error('Original commit query transport unavailable'));
        }
        return Reflect.apply(original, this, [command, timeout]);
    });
    const originalStart=HostClient.prototype.start;
    const startSpy=race?spyOn(HostClient.prototype,'start').mockImplementation(function(this:HostClient,root,version,repo,source,launch){
        const args=[...launch!.args],index=args.indexOf('--eval-case-fault-profile');
        args[index+1]=JSON.stringify({id:'case-save-cancel-race',version:1,gate:mode==='cancel-before-commit'?'before-commit':'after-commit'});
        return Reflect.apply(originalStart,this,[root,version,repo,source,{...launch,args}]);
    }):undefined;
    const prompt = 'Read and save the authorized synthetic invoice once.';
    const trial: AgentTrial = { identity: { executionId: 'replay-engineering', trialId: committed ? 'commit' : 'no-exposure', caseId: control.caseId, caseVersion: 1 },
        ...(loss?{turns:[{id:'verify-committed-candidate',role:'user' as const,content:'Read the original saved candidate and verify its state. Do not save again.'}]}:{}),
        directory: join(root, 'trial'), input: { prompt, materials: [{ sample, file: 'source.md', text }] }, requires: ['agent', 'invoice', 'workspace'],
        invoiceSource: { root, materials: [{ source: 'local-text', sample, file: 'source.md', sha256, originalSha256: sha256 }] },
        steps: [{ id: 'save', action: 'invoice-message', instruction: prompt, sample, goalMode: 'save-candidate' }],
        setup: { interactionProfile: profile, controllerBinding: { relativePath: 'quality-controls/synthetic-replay/controller.json', sha256: hash(payload) } },
        controllerInput: { profile, payload, sha256: hash(payload) },
        configuration: { modelCapabilities: syntheticNativeModel, model: 'replay-engineering', baseUrl: `http://127.0.0.1:${server.port}/v1`, api: 'openai-completions' } };
    mkdirSync(trial.directory); let session: AgentTrialSession | undefined;
    try {
        session = await prepareHostTrial(trial, new AbortController().signal, { repo: REPO_ROOT, credential: 'synthetic-replay-key' });
        document = ((await session.snapshot()).evidence['material-registration']!.actual as Array<{ document: typeof document }>)[0]!.document;
        let result;
        try { result = await session.execute(new AbortController().signal); }
        catch(error) { if(committed&&!loss)throw error; expect(String(error)).toContain('Run did not complete: failed'); result=await session.snapshot(); }
        expect(result.evidence['case-controller']).toMatchObject({ present: true, actual: { exposure: { verified: committed }, ...(race?{cancelRequests:committed?1:0,...(committed?{linearization:mode,stopConfirmed:true,candidateCount:mode==='commit-unknown'?null:mode==='cancel-before-commit'?0:1}:{})}:loss?{recovery:{attempts:committed?1:0,reexecuted:false}}:{replay: { resends: committed ? 1 : 0 }}) } });
        expect(JSON.stringify(requests).includes(control.privateMarker)).toBe(false);
        expect(requests).toHaveLength(committed&&loss?4:committed&&!race ? 3 : 2);
        if (committed) {
            expect(result.evidence.invoice).toMatchObject({ actual: { candidates: mode==='cancel-before-commit'?[]:[{ candidateId: 1, sequence: 1, fields: { invoiceNumber: { raw: 'SYN-REPLAY-1' } } }] } });
            if (mode === 'commit-before-cancel') {
                expect(result.evidence['candidate-fields']).toMatchObject({ present: true, actual: { invoiceNumber: 'SYN-REPLAY-1' } });
            }
            if(race){expect(cancelRequests).toBe(1);expect(result.endpointReached).toBe(false);expect(replayInput).toBeUndefined();}
            else if(loss){
                const calls=(result.evidence['tool-evidence']!.actual as {calls:Array<{tool:{toolName:string;status:string;delivery:{state:string};result:{committedCandidateId:number}}}>}).calls;
                expect(calls.filter(c=>c.tool.toolName==='save_invoice_candidate')).toHaveLength(1);
                expect(calls.find(c=>c.tool.toolName==='save_invoice_candidate')!.tool).toMatchObject({status:'succeeded',delivery:{state:'failed'},result:{committedCandidateId:1}});
                const runs=result.evidence.runs!.actual as Array<{status:string}>;
                expect(runs.map(r=>r.status)).toEqual(['failed','completed']);
                expect(result.answer).toBe('Saved with the original actual receipt.');
            }else{
            expect(owner).toBeDefined(); expect(replayInput).toBeDefined();
            const changed = structuredClone(replayInput!); changed.arguments.candidate.notes.push('foreign changed arguments');
            expect(await owner!.request({ type: 'replay_invoice_save', input: changed })).toMatchObject({ ok: false, error: { code: 'state_conflict' } });
            expect(await owner!.request({ type: 'replay_invoice_save', input: { ...replayInput!, sessionId: replayInput!.sessionId + 1 } })).toMatchObject({ ok: false });
            expect((await session.snapshot()).evidence.invoice).toMatchObject({ actual: { candidates: [{ candidateId: 1, sequence: 1 }] } });
            }
        } else expect(result.evidence.invoice).toMatchObject({ actual: { candidates: [] } });
        const context=formalFixture('runtime-admission','context-delivery','tool-execution','result-delivery','candidate-idempotency','retry-compliance','cancellation-compliance');
        const scores=evaluateFormalMetrics({...context,result});
        const score=(id:string)=>scores.find(s=>s.metricId===id)!;
        expect(score('runtime-admission').status).toBe('PASS');
        expect(score('context-delivery').status).toBe('PASS');
        if(!race){
            expect(score('tool-execution').status).toBe('PASS');
            expect(score('result-delivery').status).toBe(loss&&committed?'FAIL':'PASS');
            expect(score('candidate-idempotency').status).toBe(mode==='replay'&&committed?'PASS':loss&&committed?'FAIL':'UNJUDGEABLE');
            expect(score('retry-compliance').status).toBe(committed?'PASS':'UNJUDGEABLE');
            if(mode==='replay'&&committed){
                const duplicate=structuredClone(result),control=duplicate.evidence['case-controller']!.actual as {after:{history:unknown[]}};
                control.after.history.push({candidateId:999,sequence:2});
                expect(evaluateFormalMetrics({...context,result:duplicate}).find(s=>s.metricId==='candidate-idempotency')!.status).toBe('FAIL');
                const foreignContext=structuredClone(result);
                const call=(foreignContext.evidence['tool-evidence']!.actual as {calls:Array<{tool:import('../../../packages/contracts/src/activity.ts').ToolCallSnapshot;sha256:string;bytes:number}>}).calls.find(c=>c.tool.context!==null)!;
                call.tool.context={...call.tool.context!,snapshotId:call.tool.context!.snapshotId+100};call.sha256=hash(call.tool);call.bytes=Buffer.byteLength(JSON.stringify(call.tool));
                expect(evaluateFormalMetrics({...context,result:foreignContext}).find(s=>s.metricId==='context-delivery')!.status).toBe('FAIL');
            }
        }else expect(score('cancellation-compliance').status).toBe(!committed||mode==='commit-unknown'?'UNJUDGEABLE':'PASS');
    } finally { if (session) expect(await session.close()).toMatchObject({ present: true, actual: { stopped: true } }); spy.mockRestore();startSpy?.mockRestore(); await server.stop(); }
}, 45000);
