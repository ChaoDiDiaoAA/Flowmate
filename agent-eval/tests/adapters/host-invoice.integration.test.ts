import { syntheticNativeModel } from '../support/native-model.ts';
import { goldByCaseId } from '../../src/datasets/gold.ts';
import { scenariosByName } from '../../src/testing/scenarios.ts';
import { flowmateAgentV1Dataset } from '../../src/datasets/cases.ts';
import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHttpProvider, mkdtempSync, waitFor } from '../../../tests/support/resources.ts';
import { prepareHostTrial } from '../../src/adapters/host-research.ts';
import { REPO_ROOT } from '../../src/dataset-loader/local.ts';
import type { AgentTrial, AgentTrialSession } from '../../src/adapters/agent.ts';
import { invoiceHeaderFields, type InvoiceField } from '../../../packages/contracts/src/invoice.ts';
import { executeCase } from '../../src/execution/execute-case.ts';
import { ResourceManifestSchema } from '../../../packages/contracts/src/resources.ts';
import { ExtensionManifestSchema } from '../../../packages/contracts/src/extensions.ts';
import type { ToolCallSnapshot } from '../../../packages/contracts/src/activity.ts';
import { tasks as facilityCases } from '../fixtures/minimal-dataset.ts';
import { evaluateAll } from '../../src/scoring/evaluate.ts';
import { aggregate } from '../../src/scoring/aggregate.ts';
import {formalFixture} from '../support/formal.ts';
import {evaluateFormalMetrics} from '../../src/scoring/evaluators/formal.ts';

function fixture(paginated=false,semantic=false,currency=false) {
    const root = mkdtempSync(join(tmpdir(), 'eval-invoice-host-')), source = join(root, 'source');
    const materials: Array<{ source: 'voxel51'; sample: string; file: 'content.json' | 'pages.json';   }> = [];
    const visible: AgentTrial['input']['materials'] = [],sourceFiles:NonNullable<NonNullable<AgentTrial['invoiceSource']>['files']>=[];
    for (const [sample, amount] of [['000001', '113.00'], ['000002', '226.00']] as const) {
        const directory = join(source, sample); mkdirSync(directory, { recursive: true });
        const files = { 'original.png': Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/a54AAAAASUVORK5CYII=', 'base64'),
            'content.json': Buffer.from(JSON.stringify([...(paginated?[{type:'text',text:'Invoice introduction',bbox:[0,0,1,1],page_idx:0}]:[]),...(semantic?[
                {type:'text',text:'Subtotal '+(sample==='000001'?'100.00':'200.00'),bbox:[0,0,1,1],page_idx:0},
                {type:'text',text:'Tax '+(sample==='000001'?'13.00':'26.00'),bbox:[0,0,1,1],page_idx:0}]:[]),{ type: 'text', text: 'Total ' + amount+(currency?' $':''), bbox: [0, 0, 1, 1], page_idx: 0 }])),
            'pages.json': Buffer.from(JSON.stringify([{ pageNumber: 1, text: (paginated?'Invoice introduction\n\n':'')+(semantic?'Subtotal '+(sample==='000001'?'100.00':'200.00')+'\n\nTax '+(sample==='000001'?'13.00':'26.00')+'\n\n':'')+'Total ' + amount+(currency?' $':''), blockCount: semantic?3:paginated?2:1 }])) };
        for (const [name, bytes] of Object.entries(files)) writeFileSync(join(directory, name), bytes);
        writeFileSync(join(directory, 'metadata.json'), JSON.stringify({ schemaVersion: 1, sampleId: sample, datasetId: 'voxel51-hq-invoice-ocr',
            sourceRecordId: 'synthetic-' + sample, datasetRevision: 'engineering-invoice', qualityStatus: 'not_checked',
            allowedUsesClaim: ['development'], licenseVerification: 'not_verified', files: Object.entries(files).map(([path, bytes]) => ({ path, bytes: bytes.length })) }));
        for(const name of [...Object.keys(files),'metadata.json']){const bytes=readFileSync(join(directory,name));sourceFiles.push({path:'invoice-input/'+sample+'/'+name,encoding:'base64',content:bytes.toString('base64'),bytes:bytes.length});}
        for (const file of ['content.json', 'pages.json'] as const) {
            materials.push({ source: 'voxel51', sample, file,  });
            visible.push({ sample, file, text: files[file].toString('utf8') });
        }
    }
    mkdirSync(join(source, '000003')); writeFileSync(join(source, '000003', 'gold.json'), 'UNSELECTED_QUALITY_CANARY');
    return { root, source, materials, visible,files:sourceFiles };
}
function response(delta: object, tool = false, usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number }) {
    const chunk = (delta: object, finish: string | null) => `data: ${JSON.stringify({ id: 'invoice-fixture', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
    return new Response(chunk(delta, null) + chunk({}, tool ? 'tool_calls' : 'stop') + (usage ? 'data: ' + JSON.stringify({ choices: [], usage }) + '\n\n' : '') + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
}

for (const action of ['branch-history', 'fork-history', 'compact-history'] as const) test('invoice ' + action + ' uses its original public history and keeps the selected document', async () => {
    const f = fixture(), requests: unknown[] = [];
    const inventory = (offset: number) => '\nAuthorized synthetic inventory history to preserve:\n' + Array.from({ length: 330 }, (_, row) => {
        const index = offset + row;
        return `Record ${index}: synthetic item SKU-${index}, quantity ${index + 1}, unit amount 1.00; reference row ${index}; pending invoice reconciliation.`;
    }).join('\n');
    const server = await createHttpProvider(async request => {
        requests.push(await request.json());
        return response({ role: 'assistant', content: action === 'compact-history' && requests.length === 5
            ? '## Goal\nKeep ORIGINAL_INVOICE_POLICY.\n## Progress\nThe invoice total is 113.00; retain its source.\n## Next Steps\nAnswer the user.'
            : 'Original synthetic answer ' + requests.length });
    });
    const prompt = 'ORIGINAL_INVOICE_POLICY: read the selected invoice only.', item: AgentTrial = {
        identity: { executionId: 'invoice-history-engineering', trialId: action, caseId: 'synthetic-history', caseVersion: 1 },
        directory: join(f.root, 'trial'), requires: ['agent', 'invoice', 'workspace', action === 'compact-history' ? 'compaction' : 'history'],
        input: { prompt, materials: f.visible }, invoiceSource: { root: f.source,files:f.files, materials: f.materials },
        configuration: { modelCapabilities: syntheticNativeModel, model: 'history-fixture', baseUrl: `http://127.0.0.1:${server.port}/v1`, api: 'openai-completions' },
        steps: [
            { id: 'original', action: 'invoice-message', instruction: prompt, sample: '000001', goalMode: 'answer' },
            { id: 'later', action: 'user-message', instruction: 'LATER_BRANCH_ONLY: keep this later note only on its own branch.' + (action === 'compact-history' ? inventory(330) : '') },
            ...(action === 'compact-history' ? [660, 990].map(offset => ({ id: 'seed-' + offset, action: 'user-message' as const, instruction: inventory(offset) })) : []),
            action === 'compact-history' ? { id: 'history', action } : action === 'fork-history'
                ? { id: 'history', action, fromStep: 'original', target: 'result', title: 'Original invoice fork' }
                : { id: 'history', action, fromStep: 'original', target: 'result' },
            { id: 'continue', action: 'invoice-message', instruction: 'Continue the effective invoice history without saving.', sample: '000001', goalMode: 'answer' }
        ]
    };
    mkdirSync(item.directory);
    let session: AgentTrialSession | undefined;
    try {
        session = await prepareHostTrial(item, new AbortController().signal, { repo: REPO_ROOT, credential: 'synthetic-invoice-history-key' });
        const result = await session.execute(new AbortController().signal);
        expect(result).toMatchObject({ status: 'completed', endpointReached: true, evidence: { 'history-operations': { present: true } } });
        const operations = result.evidence['history-operations']!.actual as Array<{ action: string; after?: { operation: { stopped: boolean; generated: boolean } } }>;
        expect(operations).toHaveLength(1); expect(operations[0]!.action).toBe(action);
        expect(requests).toHaveLength(action === 'compact-history' ? 6 : 3);
        expect(JSON.stringify(requests.at(-1))).toContain('ORIGINAL_INVOICE_POLICY');
        if (action !== 'compact-history') expect(JSON.stringify(requests.at(-1))).not.toContain('LATER_BRANCH_ONLY');
        else expect(operations[0]!.after!.operation).toMatchObject({ stopped: true, generated: true });
        expect(result.evidence.invoice).toMatchObject({ present: true, actual: { candidates: [], workspace: { candidateRef: null, documentRef: { id: 1 } } } });
    } finally { if (session) expect(await session.close()).toMatchObject({ present: true, actual: { stopped: true } }); await server.stop(); }
}, 45000);

test('two independent local invoice Trials do not inherit candidates, native history, files or experience', async () => {
    const f = fixture(), requests: unknown[] = [];
    let document: { documentRef: { id: number; version: string }; parsedArtifactId: number }, repetition = 0;
    const server = await createHttpProvider(async request => {
        requests.push(await request.json());
        const stage = (requests.length - 1) % 3;
        if (stage === 2) return response({ role: 'assistant', content: 'PRIVATE_TRIAL_' + repetition });
        const missing: InvoiceField = { raw: null, normalized: null, state: 'missing', alternatives: [], sources: [] };
        const fields = Object.fromEntries(invoiceHeaderFields.map(name => [name, structuredClone(missing)]));
        fields.totalAmount = { raw: '113.00', normalized: '113.00', state: 'present', alternatives: [], sources: [{
            documentId: document.documentRef.id, version: document.documentRef.version, artifactId: document.parsedArtifactId,
            page: 1, blockId: 'b1', quote: 'Total 113.00' }] };
        const name = stage === 0 ? 'read_invoice_document' : 'save_invoice_candidate';
        const args = stage === 0 ? { documentId: document.documentRef.id, page: 1, afterBlockId: null, limit: 10 }
            : { documentId: document.documentRef.id, candidate: { fields, lines: [], notes: ['PRIVATE_TRIAL_' + repetition] } };
        return response({ role: 'assistant', tool_calls: [{ index: 0, id: 'independent-' + requests.length,
            type: 'function', function: { name, arguments: JSON.stringify(args) } }] }, true);
    }, '0.0.0.0');
    try {
        for (repetition = 1; repetition <= 2; repetition++) {
            const directory = join(f.root, 'trial-' + repetition); mkdirSync(directory);
            const item: AgentTrial = {
                identity: { executionId: 'invoice-independent-engineering', trialId: 'trial-' + repetition, caseId: 'synthetic', caseVersion: 1 },
                directory, requires: ['agent', 'invoice', 'workspace'],
                input: { prompt: 'Read and save this synthetic invoice.', materials: f.visible }, invoiceSource: { root: f.source,files:f.files, materials: f.materials },
                steps: [{ id: 'save', action: 'invoice-message', instruction: 'Read and save this synthetic invoice.', sample: '000001', goalMode: 'save-candidate' }],
                configuration: { modelCapabilities: syntheticNativeModel, model: 'independent-fixture', baseUrl: `http://127.0.0.1:${server.port}/v1`, api: 'openai-completions' }
            };
            const session = await prepareHostTrial(item, new AbortController().signal, { repo: REPO_ROOT, credential: 'synthetic-independent-key' });
            try {
                const before = await session.snapshot();
                document = (before.evidence['material-registration']!.actual as Array<{ document: typeof document }>)[0]!.document;
                expect(before.evidence.invoice).toMatchObject({ present: true, actual: { jobs: [], candidates: [], workspace: { jobId: null, candidateRef: null } } });
                expect(before.evidence['new-candidates']).toMatchObject({ present: true, actual: [] });
                expect(JSON.stringify(before.evidence.history)).not.toContain('PRIVATE_TRIAL_1');
                for (const file of ['previous-trial.txt', 'experience.json']) expect(existsSync(join(directory, 'product/runtime', file))).toBe(false);
                const result = await session.execute(new AbortController().signal);
                expect(result).toMatchObject({ status: 'completed', endpointReached: true, evidence: { invoice: { present: true,
                    actual: { candidates: [{ candidateId: 1, jobId: 1, notes: ['PRIVATE_TRIAL_' + repetition] }] } } } });
                expect((result.evidence.invoice!.actual as { candidates: unknown[] }).candidates).toHaveLength(1);
                expect(result.evidence.invoice).toMatchObject({ actual: { workspace: { candidateRef: null } } });
                expect(result.evidence['candidate-fields']).toMatchObject({ present: true, actual: { totalAmount: '113.00' } });
                expect(result.evidence['candidate-values']).toMatchObject({ present: true, actual: { fields: { totalAmount: { normalized: '113.00', state: 'present' } } } });
                expect(result.evidence['new-candidates']).toMatchObject({ present: true, actual: [{ candidateId: 1, runId: 1 }] });
                if (repetition === 2) expect(JSON.stringify(requests.slice(3))).not.toContain('PRIVATE_TRIAL_1');
                writeFileSync(join(directory, 'product/runtime/previous-trial.txt'), 'PRIVATE_TRIAL_' + repetition);
                writeFileSync(join(directory, 'product/runtime/experience.json'), JSON.stringify({ private: 'PRIVATE_TRIAL_' + repetition }));
            } finally { expect(await session.close()).toMatchObject({ present: true, actual: { stopped: true } }); }
        }
        expect(requests).toHaveLength(6);
    } finally { await server.stop(); }
}, 65000);

test('a stale UI selection cannot replace the original candidate committed by the last saving Run', async () => {
    const f=fixture(); let requestCount=0;
    let document:{documentRef:{id:number;version:string};parsedArtifactId:number};
    const server=await createHttpProvider(async()=>{
        const stage=requestCount++%3;
        if(stage===2)return response({role:'assistant',content:'Saved the synthetic invoice.'});
        const missing:InvoiceField={raw:null,normalized:null,state:'missing',alternatives:[],sources:[]};
        const fields=Object.fromEntries(invoiceHeaderFields.map(name=>[name,structuredClone(missing)]));
        fields.totalAmount={raw:'113.00',normalized:'113.00',state:'present',alternatives:[],sources:[{documentId:document.documentRef.id,
            version:document.documentRef.version,artifactId:document.parsedArtifactId,page:1,blockId:'b1',quote:'Total 113.00'}]};
        const name=stage===0?'read_invoice_document':'save_invoice_candidate';
        const args=stage===0?{documentId:document.documentRef.id,page:1,afterBlockId:null,limit:10}:{documentId:document.documentRef.id,candidate:{fields,lines:[],notes:[]}};
        return response({role:'assistant',tool_calls:[{index:0,id:'stale-selection-'+requestCount,type:'function',function:{name,arguments:JSON.stringify(args)}}]},true);
    });
    const prompt='Read and save this synthetic invoice.', item:AgentTrial={identity:{executionId:'selection-engineering',trialId:'stale',caseId:'synthetic-selection',caseVersion:1},
        directory:join(f.root,'trial'),requires:['agent','invoice','workspace'],input:{prompt,materials:f.visible},invoiceSource:{root:f.source,files:f.files,materials:f.materials},
        steps:[{id:'first',action:'invoice-message',instruction:prompt,sample:'000001',goalMode:'save-candidate'},
            {id:'select-first',action:'select-candidate',fromStep:'first',ordinal:1},
            {id:'second',action:'invoice-message',instruction:'Save a new original candidate for the same invoice.',sample:'000001',goalMode:'save-candidate'}],
        configuration:{modelCapabilities:syntheticNativeModel,model:'selection-fixture',baseUrl:`http://127.0.0.1:${server.port}/v1`,api:'openai-completions'}};
    mkdirSync(item.directory);let session:AgentTrialSession|undefined;
    try{
        session=await prepareHostTrial(item,new AbortController().signal,{repo:REPO_ROOT,credential:'synthetic-selection-key'});
        document=((await session.snapshot()).evidence['material-registration']!.actual as Array<{document:typeof document}>)[0]!.document;
        const result=await session.execute(new AbortController().signal);
        expect(result.evidence.invoice).toMatchObject({actual:{workspace:{candidateRef:{id:1}},candidates:[{candidateId:1,runId:1},{candidateId:2,runId:2}]}});
        expect(result.evidence['original-candidate']).toMatchObject({present:true,actual:{candidateId:2,runId:2}});
    }finally{if(session)expect(await session.close()).toMatchObject({present:true,actual:{stopped:true}});await server.stop();}
},45000);

for(const scenario of ['running','completed-first','no-read'] as const)test('038 cancels an actual parent only after both children have original read evidence, scenario='+scenario,async()=>{
    const expose=scenario!=='no-read';
    const f=fixture(),requests:Array<{messages:Array<{role:string;content:unknown}>}>=[],profile={id:'invoice-parent-cancel' as const,version:1 as const};
    const control=structuredClone(scenariosByName['subagent-cancel-preserve-commits'].files['quality-controls/FM-038/controller.json'].json);
    control.handlerStatus='implemented-controlled-host';control.profile=profile;
    const extension=ExtensionManifestSchema.parse(JSON.parse(readFileSync(join(REPO_ROOT,'resources/extensions/subagents-v1.json'),'utf8')));
    control.extensionRef={id:extension.id,version:extension.version};const payload=JSON.stringify(control);
    let document:{documentRef:{id:number;version:string};parsedArtifactId:number},parentRequests=0,release!:()=>void;
    const hold=new Promise<void>(resolve=>release=resolve);
    const server=await createHttpProvider(async request=>{
        const body=await request.json() as typeof requests[number];requests.push(body);
        const child=String(body.messages[0]?.content).startsWith('Verify invoice evidence');
        if(child){
            if(!expose)return response({role:'assistant',content:'No fresh tool read; report that limitation.'});
            const first=body.messages.some(message=>message.role==='user'&&JSON.stringify(message.content).includes('Check 0 and retain'));
            if(body.messages.some(message=>message.role==='tool')){
                if(scenario==='completed-first'&&first)return response({role:'assistant',content:'Completed first check: original total 113.00 from block b1; no saving authorized.'});
                await hold;return response({role:'assistant',content:'Original total 113.00; no saving authorized.'});
            }
            if(scenario==='completed-first'&&!first)await new Promise(resolve=>setTimeout(resolve,500));
            return response({role:'assistant',tool_calls:[{index:0,id:'child-read-'+requests.length,type:'function',function:{name:'read_invoice_document',arguments:JSON.stringify({documentId:document.documentRef.id,page:1,afterBlockId:null,limit:10})}}]},true);
        }
        if(++parentRequests===1)return response({role:'assistant',tool_calls:[0,1].map(index=>({index,id:'parent-child-'+index,type:'function',function:{name:'Agent',arguments:JSON.stringify({subagent_type:'invoice-evidence-checker',description:'Independent read-only check '+index,prompt:'Read only the authorized invoice. Check '+index+' and retain exact source references.',run_in_background:false})}}))},true);
        return response({role:'assistant',content:'Both checks returned without fresh reads; no business writes.'});
    });
    const prompt='Use two restricted children to inspect this invoice read-only. I may stop the work; do not create an invoice job or save.';
    const item:AgentTrial={identity:{executionId:'controlled-parent-cancel',trialId:expose?'exposed':'not-exposed',caseId:'FM-038',caseVersion:1},directory:join(f.root,'trial'),
        input:{prompt,materials:f.visible.filter(m=>m.sample==='000001')},invoiceSource:{root:f.source,files:f.files,materials:f.materials.filter(m=>m.sample==='000001')},requires:['agent','invoice','workspace','subagent'],
        setup:{interactionProfile:profile,controllerBinding:{relativePath:'quality-controls/FM-038/controller.json'}},controllerInput:{profile,payload},
        steps:[{id:'request',action:'invoice-message',instruction:prompt,sample:'000001',goalMode:'answer',workspaceMode:'selected-document'}],
        configuration:{modelCapabilities: syntheticNativeModel, model:'invoice-fixture',baseUrl:`http://127.0.0.1:${server.port}/v1`,api:'openai-completions',extensions:{enabledExtensions:[{id:extension.id,version:extension.version}]}}};
    mkdirSync(item.directory);let session:AgentTrialSession|undefined;
    try{
        session=await prepareHostTrial(item,new AbortController().signal,{repo:REPO_ROOT,credential:'synthetic-parent-cancel-key'});
        expect(JSON.stringify(session.input)).not.toContain('CASE-CONTROL');
        document=((await session.snapshot()).evidence['material-registration']!.actual as Array<{document:typeof document}>)[0]!.document;
        const result=await session.execute(AbortSignal.timeout(40000)),again=await session.snapshot();
        expect(result.evidence.invoice).toMatchObject({actual:{jobs:[],candidates:[]}});
        expect(result.evidence.subagents).toMatchObject({present:true,actual:{children:[{},{}],stopUnconfirmed:[]}});
        const runs=result.evidence.runs!.actual as Array<{kind:string;status:string;stoppedAt:string|null;cleanup:{stopped:boolean}}>;
        expect(runs).toHaveLength(3);expect(runs.every(run=>run.stoppedAt!==null&&run.cleanup.stopped)).toBe(true);
        const formalContext=formalFixture('subtask-scope','subtask-stop','cancellation-compliance');
        const formalScores=evaluateFormalMetrics({...formalContext,result});
        expect(formalScores.find(s=>s.metricId==='subtask-scope')!.status).toBe('PASS');
        for(const metricId of ['subtask-stop','cancellation-compliance']){
            expect(formalScores.find(s=>s.metricId===metricId)!.status).toBe(expose?'PASS':'UNJUDGEABLE');
            if(expose){
                const wrong=structuredClone(result);(wrong.evidence['case-controller']!.actual as {stopping:{confirmed:boolean}}).stopping.confirmed=false;
                expect(evaluateFormalMetrics({...formalContext,result:wrong}).find(s=>s.metricId===metricId)!.status).toBe('FAIL');
            }
        }
        const wrongScope=structuredClone(result);
        (wrongScope.evidence.runs!.actual as Array<{scope:{allowedTools:string[]}}>)[0]!.scope.allowedTools=[];
        expect(evaluateFormalMetrics({...formalContext,result:wrongScope}).find(s=>s.metricId==='subtask-scope')!.status).toBe('FAIL');
        const wrongOrigin=structuredClone(result);
        const childRun=(wrongOrigin.evidence.runs!.actual as Array<{kind:string;config:{subagent?:{parentRequestSequence:number}}}>).find(run=>run.kind==='subagent')!;
        childRun.config.subagent!.parentRequestSequence++;
        expect(evaluateFormalMetrics({...formalContext,result:wrongOrigin}).find(s=>s.metricId==='subtask-scope')!.status).toBe('FAIL');
        const missingRequest=structuredClone(result);missingRequest.evidence['context-requests']={present:false,actual:null,source:'Original request collection unavailable'};
        expect(evaluateFormalMetrics({...formalContext,result:missingRequest}).find(s=>s.metricId==='subtask-scope')!.status).toBe('UNJUDGEABLE');
        if(expose){
            expect(result.status).toBe('cancelled');expect(result.endpointReached).toBe(false);expect(parentRequests).toBe(1);
            expect(result.evidence['case-controller']).toMatchObject({present:true,actual:{exposure:{verified:true,cancelRequests:1},stopping:{confirmed:true,timedOut:false},committedFactsPreserved:true}});
            expect(again.evidence['case-controller']).toEqual(result.evidence['case-controller']);
            expect(runs[0]!.status).toBe('cancelled');expect(result.evidence['tool-evidence']!.present).toBe(true);
            if(scenario==='completed-first')expect(runs.some(run=>run.kind==='subagent'&&run.status==='completed')).toBe(true);
            else expect(runs.every(run=>run.status==='cancelled')).toBe(true);
            const authored={expected:{checks:goldByCaseId['FM-038'].checks}};
            expect(authored.expected.checks.every((check:{trigger?:string})=>check.trigger==='started')).toBe(true);
            const context={task:facilityCases[0]!,result,projected:result.input,judge:null};
            const scored=await evaluateAll(context,authored.expected.checks);expect(scored.scores.every(score=>score.status==='PASS')).toBe(true);
            expect(aggregate(scored.scores,result).status).toBe('UNJUDGEABLE');
            const check=authored.expected.checks.find((check:{evidence?:string;path?:unknown[]})=>check.evidence==='case-controller'&&JSON.stringify(check.path)===JSON.stringify(['stopping','confirmed']));expect(check).toBeDefined();
            const wrong=structuredClone(result);(wrong.evidence['case-controller']!.actual as {stopping:{confirmed:boolean}}).stopping.confirmed=false;
            expect((await evaluateAll({...context,result:wrong},[check])).scores[0]!.status).toBe('FAIL');
        }else{
            expect(result.status).toBe('completed');expect(parentRequests).toBe(2);
            expect(result.evidence['case-controller']).toMatchObject({present:false,actual:{exposure:null,stopping:null}});
        }
    }finally{release();if(session)expect((await session.close()).present).toBe(true);server.stop(true);}
},50000);

test('024 commits its declared user history before native manual compaction and saves with the retained current correction', async () => {
    const f = fixture(false, false, true), declaration = flowmateAgentV1Dataset.cases.find(task => task.id === 'FM-024')!;
    const scenario = scenariosByName[declaration.input.fixture!.name], requests: Array<Record<string, unknown>> = [];
    const finalText = declaration.input.turns!.find(turn => turn.id === 'request')!.content;
    let document: { documentRef: { id: number; version: string }; parsedArtifactId: number }, summaryCalls = 0;
    const server = await createHttpProvider(async request => {
        const body = await request.json() as Record<string, unknown>; requests.push(body);
        const messages = body.messages as Array<{ role: string; content: unknown }>, serialized = JSON.stringify(body);
        if (requests.length === 1) return response({ role: 'assistant', tool_calls: [{ index: 0, id: 'manual-original-read', type: 'function',
            function: { name: 'read_invoice_document', arguments: JSON.stringify({ documentId: document.documentRef.id, page: 1, afterBlockId: null, limit: 10 }) } }] }, true);
        if (serialized.includes('structured context checkpoint') || serialized.includes('context summarization assistant')) {
            summaryCalls++;
            return response({ role: 'assistant', content: 'MANUAL_NATIVE_CHECKPOINT: selected invoice total 113.00 and $ are from original block b1. Inventory records are earlier user data, not invoice evidence. Preserve current user corrections.' });
        }
        if (JSON.stringify([...messages].reverse().find(message => message.role === 'user')).includes(finalText)) {
            if (messages.at(-1)?.role === 'tool') return response({ role: 'assistant', content: 'Saved the original invoice with the latest user-supplied CNY correction.' });
            const fields: Record<string, InvoiceField> = Object.fromEntries(invoiceHeaderFields.map(name => [name,
                { raw: null, normalized: null, state: 'missing', alternatives: [], sources: [] }]));
            fields.currency = { raw: '$', normalized: 'CNY', state: 'present', alternatives: [], sources: [{ documentId: document.documentRef.id,
                version: document.documentRef.version, artifactId: document.parsedArtifactId, page: 1, blockId: 'b1', quote: '$' }] };
            return response({ role: 'assistant', tool_calls: [{ index: 0, id: 'manual-save', type: 'function', function: { name: 'save_invoice_candidate',
                arguments: JSON.stringify({ documentId: document.documentRef.id, candidate: { fields, lines: [], notes: ['CNY is the latest user correction; inventory is not invoice evidence.'] } }) } }] }, true);
        }
        return response({ role: 'assistant', content: 'Read-only user data retained with its original source; no candidate saved.' });
    });
    const item: AgentTrial = { identity: { executionId: 'controlled-manual', trialId: 'manual-024', caseId: 'FM-024', caseVersion: 1 },
        directory: join(f.root, 'trial'), input: { prompt: declaration.input.prompt, materials: f.visible.filter(material => material.sample === '000001') },
        turns: declaration.input.turns, invoiceSource: { root: f.source,files:f.files, materials: f.materials.filter(material => material.sample === '000001') },
        requires: scenario.requires, steps: scenario.steps.map((step: { instruction?: string }) => step.instruction === '$input' ? { ...step, instruction: declaration.input.prompt } : step),
        configuration: { modelCapabilities: syntheticNativeModel, model: 'manual-invoice', baseUrl: `http://127.0.0.1:${server.port}/v1`, api: 'openai-completions' } };
    mkdirSync(item.directory); let session: AgentTrialSession | undefined;
    try {
        session = await prepareHostTrial(item, new AbortController().signal, { repo: REPO_ROOT, credential: 'synthetic-manual-key' });
        document = ((await session.snapshot()).evidence['material-registration']!.actual as Array<{ document: typeof document }>)[0]!.document;
        const result = await session.execute(AbortSignal.timeout(45000));
        expect({ started: result.started, status: result.status, endpointReached: result.endpointReached, error: result.error })
            .toMatchObject({ started: true, status: 'completed', endpointReached: true });
        expect(summaryCalls).toBe(1);
        const inputs = result.evidence.inputs!.actual as Array<{ content: { text: string }; status: string; nativeEntryId: string | null }>;
        const seeds = declaration.input.turns!.filter(turn => turn.id.startsWith('history-'));
        expect(seeds).toHaveLength(3);
        for (const seed of seeds) expect(inputs.find(input => input.content.text === seed.content)).toMatchObject({ status: 'consumed', nativeEntryId: expect.any(String) });
        expect(result.evidence['user-turns']).toMatchObject({ present: true, actual: expect.any(Array) });
        expect(result.evidence['history-operations']).toMatchObject({ present: true, actual: [{ action: 'compact-history', after: { operation: {
            nativeOutcome: 'succeeded', generated: true, saved: expect.any(Object), stopped: true, capacity: { contextWindow: 131072 }
        } }, continuedUse: { verified: true, summaryWireInclusion: 'confirmed' } }] });
        const finalRequest = requests.find(request => JSON.stringify(request).includes(finalText));
        expect(JSON.stringify(finalRequest)).toContain('MANUAL_NATIVE_CHECKPOINT');
        expect(JSON.stringify(finalRequest)).toContain('CNY');
        expect(JSON.stringify(requests[0])).not.toContain('SKU-');
        expect(JSON.stringify(requests[0])).not.toContain(finalText);
        expect(result.evidence.invoice).toMatchObject({ actual: { candidates: [{ fields: { currency: { normalized: 'CNY' } } }] } });
        expect(result.configuration.modelCapabilities).toEqual(syntheticNativeModel);
        expect(JSON.stringify(result.evidence.history!.actual)).toContain('MANUAL_NATIVE_CHECKPOINT');
    } finally { if (session) expect((await session.close()).present).toBe(true); await server.stop(); }
}, 60000);

for(const expose of [true,false])test('025 builds public user turns and only saves after an actual native auto summary, expose='+expose,async()=>{
    const f=fixture(false,false,true),requests:Array<Record<string,unknown>>=[];
    const seed=structuredClone(scenariosByName['compaction-continue-automatic-history'].files['quality-controls/FM-025/history-seed.json'].json);
    const finalRequest='Continue and save using my latest currency declaration and its user origin; preserve the original source.';
    delete seed.finalRequest;
    seed.finalTurnId='final-save';
    const declaration=flowmateAgentV1Dataset.cases.find(c=>c.id==='FM-025')!;
    const seedTurns='turns' in declaration.input?(declaration.input.turns??[]).filter(turn=>seed.turns.some((ref:{turnId:string})=>ref.turnId===turn.id)):[];
    const profile={id:'invoice-auto-compaction' as const,version:1 as const,reserveTokens:16384 as const,keepRecentTokens:20000 as const},payload=JSON.stringify(seed);
    let document:{documentRef:{id:number;version:string};parsedArtifactId:number},answers=0,summaryCalls=0,providerInput=0,providerOutput=0;
    const chargedResponse=(delta:object,tool=false)=>{providerInput+=10;providerOutput+=2;return response(delta,tool,{prompt_tokens:10,completion_tokens:2,total_tokens:12});};
    const server=await createHttpProvider(async request=>{
        const body=await request.json() as Record<string,unknown>;requests.push(body);const serialized=JSON.stringify(body);
        if(requests.length===1)return chargedResponse({role:'assistant',tool_calls:[{index:0,id:'auto-original-read',type:'function',function:{name:'read_invoice_document',arguments:JSON.stringify({documentId:document.documentRef.id,page:1,afterBlockId:null,limit:10})}}]},true);
        if(serialized.includes('structured context checkpoint')||serialized.includes('context summarization assistant')){
            summaryCalls++;return chargedResponse({role:'assistant',content:'Native checkpoint: authorized invoice total 113.00 from original block b1; original currency is $. Retain user declarations and never treat them as printed facts.'+(serialized.includes('USD')?' The user explicitly declared USD.':'')});
        }
        const messages=body.messages as Array<{role:string;content:unknown}>;
        const last=[...messages].reverse().find(message=>message.role==='user');
        if(JSON.stringify(last).includes(finalRequest)){
            if(messages.at(-1)?.role==='tool')return chargedResponse({role:'assistant',content:'Saved; USD is explicitly supplied by the user.'});
            const fields:Record<string,InvoiceField>=Object.fromEntries(invoiceHeaderFields.map(name=>[name,{raw:null,normalized:null,state:'missing',alternatives:[],sources:[]}]));
            const source={documentId:document.documentRef.id,version:document.documentRef.version,artifactId:document.parsedArtifactId,page:1,blockId:'b1',quote:'$'};
            fields.currency={raw:'$',normalized:'USD',state:'present',alternatives:[],sources:[source]};
            return chargedResponse({role:'assistant',tool_calls:[{index:0,id:'auto-save',type:'function',function:{name:'save_invoice_candidate',arguments:JSON.stringify({documentId:document.documentRef.id,candidate:{fields,lines:[],notes:['USD is from the earlier user declaration.']}})}}]},true);
        }
        answers++;
        const content=expose?Array.from({length:120},(_,index)=>`Review ${answers}, observation ${index}: the selected invoice total is 113.00 and the original currency is $. This read-only review does not authorize saving.\n`).join(''):'Read-only review completed.';
        const chunk=(delta:object,finish:string|null)=>'data: '+JSON.stringify({id:'auto-history',choices:[{index:0,delta,finish_reason:finish}]})+'\n\n';
        // Synthetic provider usage triggers only after enough actual responses form an eligible prefix.
        const input=expose&&answers===10?25000:10;
        providerInput+=input;providerOutput+=Math.ceil(content.length/4);
        return new Response(chunk({role:'assistant',content},null)+chunk({},'stop')+'data: '+JSON.stringify({choices:[],usage:{prompt_tokens:input,completion_tokens:Math.ceil(content.length/4),total_tokens:input+Math.ceil(content.length/4)}})+'\n\ndata: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}});
    });
    const prompt='Start a read-only review; wait for my explicit final saving request.';
    const item:AgentTrial={identity:{executionId:'controlled-auto',trialId:expose?'exposed':'not-exposed',caseId:'FM-025',caseVersion:1},directory:join(f.root,'trial'),input:{prompt,materials:f.visible.filter(m=>m.sample==='000001')},
        turns:[...seedTurns,{id:'final-save',role:'user',content:finalRequest}],
        invoiceSource:{root:f.source,files:f.files,materials:f.materials.filter(m=>m.sample==='000001')},requires:['agent','invoice','workspace','history','compaction'],
        setup:{interactionProfile:profile,controllerBinding:{relativePath:'quality-controls/FM-025/controller.json'}},controllerInput:{profile,payload},
        steps:[{id:'request',action:'invoice-message',instruction:prompt,sample:'000001',goalMode:'answer'}],configuration:{modelCapabilities: {...syntheticNativeModel,contextWindow:expose?40960:262144,maxTokens:16384}, model:'invoice-fixture',baseUrl:`http://127.0.0.1:${server.port}/v1`,api:'openai-completions'}};
    mkdirSync(item.directory);let session:AgentTrialSession|undefined;
    try{
        session=await prepareHostTrial(item,new AbortController().signal,{repo:REPO_ROOT,credential:'synthetic-auto-key'});
        expect(JSON.stringify(session.input)).not.toContain('USD');expect(finalRequest).not.toContain('USD');
        document=((await session.snapshot()).evidence['material-registration']!.actual as Array<{document:typeof document}>)[0]!.document;
        const result=await session.execute(AbortSignal.timeout(45000));
        expect(result.usage).toEqual({inputTokens:providerInput,outputTokens:providerOutput,totalTokens:providerInput+providerOutput,cost:null});
        const inputs=result.evidence.inputs!.actual as Array<{mode:string;content:{text:string};status:string}>;
        expect(inputs.filter(input=>input.status==='consumed')).toHaveLength(expose?18:17);
        expect(result.evidence['user-turns'].actual).toHaveLength(17);
        expect((result.evidence['user-turns'].actual as Array<{consumed:boolean}>).filter(turn=>turn.consumed)).toHaveLength(expose?17:16);
        expect(inputs.every(input=>input.mode==='prompt')).toBe(true);
        expect(result.evidence['interaction-history']!.present).toBe(true);
        if(expose){
            expect(summaryCalls).toBeGreaterThan(0);expect(result.evidence['case-controller']).toMatchObject({present:true,actual:{exposure:{verified:true,seedTurns:16,finalInputConsumed:true,summaryWireInclusion:'confirmed',capacity:{contextWindow:40960,thresholdTokens:24576}}}});
            expect(result.evidence.invoice).toMatchObject({actual:{candidates:[{fields:{currency:{normalized:'USD'}}}]}});
            expect(result.evidence['tool-evidence']!.present).toBe(true);
            expect(JSON.stringify(requests.find(body=>JSON.stringify(body).includes(finalRequest)))).toContain('USD');
            const authored={expected:{checks:goldByCaseId['FM-025'].checks}};
            const check=authored.expected.checks.find((check:{evidence?:string;path?:unknown[]})=>check.evidence==='invoice'&&JSON.stringify(check.path)===JSON.stringify(['candidates',0,'fields','currency','normalized']));
            expect(check).toBeDefined();const context={task:facilityCases[0]!,result,projected:result.input,judge:null};
            expect((await evaluateAll(context,[check])).scores[0]).toMatchObject({status:'PASS'});
            const wrong=structuredClone(result);(wrong.evidence.invoice!.actual as {candidates:Array<{fields:{currency:{normalized:string}}}>}).candidates[0]!.fields.currency.normalized='EUR';
            expect((await evaluateAll({...context,result:wrong},[check])).scores[0]).toMatchObject({status:'FAIL'});
        }else{
            expect(summaryCalls).toBe(0);expect(result.evidence['case-controller']).toMatchObject({present:false,actual:{exposure:null}});
            expect(result.evidence.invoice).toMatchObject({actual:{candidates:[]}});
            expect(JSON.stringify(requests)).not.toContain(finalRequest);
        }
    }finally{if(session)expect((await session.close()).present).toBe(true);server.stop(true);}
},60000);

for(const mode of ['steer','followUp'] as const)for(const expose of [true,false])test('017 delivers a declared live '+mode+' only after an actual read and proves consumption, expose='+expose,async()=>{
    const f=fixture(false,false,true),requests:unknown[]=[],text='The currency is USD, supplied by me; the original only has $.',profile={id:'invoice-currency-steer' as const,version:1 as const};
    const payload=JSON.stringify({contract:'flowmate-future-user-input/v1',mode,currency:'USD',origin:'explicit-user-declaration',turnId:'currency-correction',delivery:'only-after-observed-live-run-before-save',actualDelivery:'not-run'});
    let document:{documentRef:{id:number;version:string};parsedArtifactId:number};
    const server=await createHttpProvider(async request=>{
        requests.push(await request.json());const ordinal=requests.length;
        if(mode==='followUp'&&expose&&ordinal>=2){
            if(ordinal===2)await new Promise(resolve=>setTimeout(resolve,500));
            return response({role:'assistant',content:ordinal===2?'The original currency is ambiguous.':'USD comes from the later user correction. The invoice total remains 113.00.'});
        }
        if(!expose||ordinal===4)return response({role:'assistant',content:expose?'Saved total 113.00; USD is from the user, not the original.':'No read occurred.'});
        if(ordinal===2)await new Promise(resolve=>setTimeout(resolve,500));
        const source={documentId:document.documentRef.id,version:document.documentRef.version,artifactId:document.parsedArtifactId,page:1,blockId:'b1',quote:'Total 113.00'};
        const fields:Record<string,InvoiceField>=Object.fromEntries(invoiceHeaderFields.map(name=>[name,{raw:null,normalized:null,state:'missing',alternatives:[],sources:[]}]));
        fields.totalAmount={raw:'113.00',normalized:'113.00',state:'present',alternatives:[],sources:[source]};
        fields.currency={raw:'$',normalized:'USD',state:'present',alternatives:[],sources:[{...source,quote:'$'}]};
        const name=ordinal<3?'read_invoice_document':'save_invoice_candidate',args=ordinal<3?{documentId:document.documentRef.id,page:1,afterBlockId:null,limit:10}:{documentId:document.documentRef.id,candidate:{fields,lines:[],notes:['USD is explicitly supplied by the consumed user input.']}};
        return response({role:'assistant',tool_calls:[{index:0,id:'steer-'+ordinal,type:'function',function:{name,arguments:JSON.stringify(args)}}]},true);
    });
    const initialPrompt=mode==='followUp'?'Read the invoice without saving. I may provide a later currency correction.':'Read and save the invoice. I may provide a currency correction while it runs.';
    const item:AgentTrial={identity:{executionId:'controlled-steer',trialId:expose?'exposed':'not-exposed',caseId:'synthetic-steer',caseVersion:1},directory:join(f.root,'trial'),
        turns:[{id:'currency-correction',role:'user',content:text,mode}],
        input:{prompt:initialPrompt,materials:f.visible.filter(m=>m.sample==='000001')},invoiceSource:{root:f.source,files:f.files,materials:f.materials.filter(m=>m.sample==='000001')},
        requires:['agent','invoice','workspace'],setup:{interactionProfile:profile,controllerBinding:{relativePath:'quality-controls/synthetic-steer/controller.json'}},
        controllerInput:{profile,payload},configuration:{modelCapabilities: syntheticNativeModel, model:'invoice-fixture',baseUrl:`http://127.0.0.1:${server.port}/v1`,api:'openai-completions'},
        steps:[{id:'request',action:'invoice-message',instruction:initialPrompt,sample:'000001',goalMode:mode==='followUp'?'answer':'save-candidate'}]};
    mkdirSync(item.directory);let session:AgentTrialSession|undefined;
    try{
        session=await prepareHostTrial(item,new AbortController().signal,{repo:REPO_ROOT,credential:'synthetic-steer-key'});
        expect(JSON.stringify(session.input)).not.toContain(text);
        document=((await session.snapshot()).evidence['material-registration']!.actual as Array<{document:typeof document}>)[0]!.document;
        const result=await session.execute(AbortSignal.timeout(20000)),inputs=result.evidence.inputs!.actual as Array<{inputId:number;mode:string;runId:number;status:string;content:{text:string}}>;
        expect(JSON.stringify(requests[0])).not.toContain(text);expect(JSON.stringify(requests)).not.toContain('quality-controls');
        if(expose){
            expect(requests).toHaveLength(mode==='followUp'?3:4);expect(JSON.stringify(requests[2])).toContain(text);
            expect(inputs.filter(input=>input.mode===mode)).toMatchObject([{status:'consumed',content:{text}}]);
            expect(result.evidence['user-turns']).toMatchObject({present:true,actual:[{turnId:'currency-correction',submitted:true,accepted:true,consumed:true,status:'consumed'}]});
            expect(inputs.filter(input=>input.mode==='prompt')).toHaveLength(1);expect(new Set(inputs.map(input=>input.runId)).size).toBe(1);
            expect(result.evidence['case-controller']).toMatchObject({present:true,actual:{profile,exposure:{verified:true,deliveries:1,consumed:true,wireInclusion:'confirmed'}}});
            expect(result.evidence['candidate-fields']).toMatchObject({present:mode==='steer'});
            if(mode==='steer')expect(result.evidence['candidate-fields']!.actual).toMatchObject({currency:'USD',totalAmount:'113.00'});
            if(mode==='followUp')expect(result.evidence.invoice!.actual).toMatchObject({candidates:[]});
            else expect(result.evidence.invoice!.actual).toMatchObject({candidates:[{runId:inputs[0]!.runId,fields:{currency:{raw:'$',normalized:'USD'}}}]});
            expect(result.evidence['interaction-history']).toMatchObject({present:true});
            const evidenceTask=structuredClone(facilityCases[0]!);Object.assign(evidenceTask.expected,{mustHaveEvidence:true});
            expect((await evaluateAll({task:evidenceTask,result,projected:result.input,judge:null},[])).scores.find(s=>s.metricId==='case-evidence-required')).toMatchObject({status:'PASS'});
            for(const empty of ['',[],{}]){
                const missing=structuredClone(result);
                for(const frame of missing.evidence['context-requests']!.actual as Array<{snapshots:Array<{snapshot:{json:{modelProjection:{fragments:unknown[];candidate:null|unknown}}}}>}>){
                    for(const snapshot of frame.snapshots){snapshot.snapshot.json.modelProjection.fragments=[];snapshot.snapshot.json.modelProjection.candidate=null;}
                }
                for(const record of (missing.evidence['tool-evidence']!.actual as {calls:Array<{tool:ToolCallSnapshot;bytes:number}>}).calls){
                    if(record.tool.result?.status==='succeeded')record.tool.result.data=empty;
                    record.bytes=Buffer.byteLength(JSON.stringify(record.tool));
                }
                expect((await evaluateAll({task:evidenceTask,result:missing,projected:missing.input,judge:null},[])).scores.find(s=>s.metricId==='case-evidence-required')).toMatchObject({status:'FAIL'});
            }
            if(mode==='steer'){
            const authored={expected:{checks:goldByCaseId['FM-017'].checks}};
            const check=authored.expected.checks.find((check:{evidence?:string;path?:unknown[]})=>check.evidence==='invoice'&&JSON.stringify(check.path)===JSON.stringify(['candidates',0,'fields','currency','normalized']));
            expect(check).toBeDefined();
            const context={task:facilityCases[0]!,result,projected:result.input,judge:null};
            expect((await evaluateAll(context,[check])).scores[0]).toMatchObject({status:'PASS'});
            const wrong=structuredClone(result);(wrong.evidence.invoice!.actual as {candidates:Array<{fields:{currency:{normalized:string}}}>}).candidates[0]!.fields.currency.normalized='EUR';
            expect((await evaluateAll({...context,result:wrong},[check])).scores[0]).toMatchObject({status:'FAIL'});
            }
        }else{
            expect(inputs).toHaveLength(1);expect(JSON.stringify(requests)).not.toContain(text);
            expect(result.evidence['user-turns']).toMatchObject({actual:[{turnId:'currency-correction',submitted:false,accepted:false,consumed:false,status:'planned'}]});
            expect(result.evidence['case-controller']).toMatchObject({present:false,actual:{profile,exposure:null}});
            expect(result.evidence.runs!.actual).toMatchObject([mode==='followUp'?{status:'completed'}:{status:'failed',error:{code:'agent_goal_not_met'}}]);
        }
        expect(await session.close()).toMatchObject({present:true,actual:{closed:true,stopped:true}});
    }finally{if(session)await session.close();await server.stop();}
},30000);

for (const isolation of [undefined] as const) test
('actual ' + (isolation ?? 'local') + ' Host registers only declared invoices and binds each saved candidate to the selected Workspace', async () => {
    const f = fixture(), requests: unknown[] = [];
    let documents: Array<{ sample: string; document: { documentRef: { id: number; version: string }; parsedArtifactId: number } }> = [];
    const server = await createHttpProvider(async request => {
        requests.push(await request.json());
        const index = Math.floor((requests.length - 1) / 3), doc = documents[index]!.document, stage = (requests.length - 1) % 3;
        if (stage === 2) return response({ role: 'assistant', content: 'Saved selected invoice candidate.' });
        const source = { documentId: doc.documentRef.id, version: doc.documentRef.version, artifactId: doc.parsedArtifactId, page: 1, blockId: 'b1', quote: 'Total ' + (index ? '226.00' : '113.00') };
        const field: InvoiceField = { raw: null, normalized: null, state: 'missing', alternatives: [], sources: [] };
        const fields: Record<string, InvoiceField> = Object.fromEntries(invoiceHeaderFields.map(name => [name, structuredClone(field)]));
        fields.totalAmount = { raw: index ? '226.00' : '113.00', normalized: index ? '226.00' : '113.00', state: 'present', alternatives: [], sources: [source] };
        const name = stage === 0 ? 'read_invoice_document' : 'save_invoice_candidate';
        const args = stage === 0 ? { documentId: doc.documentRef.id, page: 1, afterBlockId: null, limit: 10 }
            : { documentId: doc.documentRef.id, candidate: { fields, lines: [], notes: [] } };
        return response({ role: 'assistant', tool_calls: [{ index: 0, id: 'invoice-tool-' + requests.length, type: 'function', function: { name, arguments: JSON.stringify(args) } }] }, true);
    }, isolation ? '0.0.0.0' : undefined);
    const item: AgentTrial = { identity: { executionId: 'invoice-engineering', trialId: 'invoice-1', caseId: 'invoice-case', caseVersion: 1 },
        directory: join(f.root, 'trial'), input: { prompt: 'Read and save the selected invoice.', materials: f.visible }, requires: ['agent', 'invoice', 'workspace'],
        configuration: { modelCapabilities: syntheticNativeModel, model: 'invoice-fixture', baseUrl: `http://${isolation ? '127.0.0.1' : '127.0.0.1'}:${server.port}/v1`, api: 'openai-completions' } };
    mkdirSync(item.directory);
    Object.assign(item, { invoiceSource: { root: f.source,files:f.files, materials: f.materials }, steps: [
        { id: 'first', action: 'invoice-message', instruction: item.input.prompt, sample: '000001', goalMode: 'save-candidate' },
        { id: 'second', action: 'invoice-message', instruction: 'Switch to the second invoice and save its own candidate.', sample: '000002', goalMode: 'save-candidate' },
        { id: 'select', action: 'select-candidate', fromStep: 'second', ordinal: 1 },
        { id: 'unchanged', action: 'edit-candidate', patch: { fields: { totalAmount: '226.00' } } },
        { id: 'edit', action: 'edit-candidate', patch: { fields: { totalAmount: '999.00' }, notes: ['FUTURE_USER_EDIT_MARKER'] } },
        { id: 'reject', action: 'reject-candidate', reason: 'The user rejected this version.' },
        { id: 'reselect', action: 'select-candidate', fromStep: 'edit', ordinal: 1 },
        { id: 'correct', action: 'edit-candidate', patch: { fields: { totalAmount: '250.00' } } },
        { id: 'accept', action: 'accept-candidate' },
        { id: 'json', action: 'export', format: 'json' },
        { id: 'csv', action: 'export', format: 'csv' },
        { id: 'markdown', action: 'export', format: 'markdown' },
        { id: 'replay', action: 'input-replay', fromStep: 'second' }
    ] });
    let session: AgentTrialSession | undefined;
    try {
        session = await prepareHostTrial(item, new AbortController().signal, { repo: REPO_ROOT, credential: 'synthetic-invoice-key' });
        documents = (await session.snapshot()).evidence['material-registration']!.actual as typeof documents;
        expect(documents.map(d => d.sample)).toEqual(['000001', '000002']);
        const result = await session.execute(new AbortController().signal);
        expect(result).toMatchObject({ status: 'completed', endpointReached: true, evidence: {
            'material-registration': { present: true }, invoice: { present: true }, 'input-projection': { present: true },
            'candidate-fields': { present: true, actual: { totalAmount: '226.00' } }
        } });
        expect(requests).toHaveLength(6);
        expect(result.artifacts.filter(a => a.kind === 'candidate')).toHaveLength(4);
        expect(JSON.stringify(requests)).not.toContain('UNSELECTED_QUALITY_CANARY');
        expect(JSON.stringify(requests)).not.toContain('FUTURE_USER_EDIT_MARKER');
        const facts = result.evidence.invoice!.actual as { jobs: Array<{ jobId: number; documentRef: { id: number }; acceptedCandidateId: number }>;
            candidates: Array<{ candidateId: number; jobId: number; runId: number | null; origin?: string; basedOnCandidateId?: number; status: string;
                fields: { totalAmount: { normalized: string; sources: unknown[]; valueOrigin?: string } } }>;
            operations: Array<{ stepId?: string; result: { changed?: boolean }; readback?: unknown }> };
        expect(facts.jobs.map(j => j.documentRef.id)).toEqual(documents.map(d => d.document.documentRef.id));
        expect(facts.candidates.map(c => c.jobId)).toEqual([facts.jobs[0]!.jobId, ...Array(3).fill(facts.jobs[1]!.jobId)]);
        expect(facts.candidates.slice(2).map(c => [c.origin, c.runId, c.basedOnCandidateId, c.status])).toEqual([
            ['human_edit', null, facts.candidates[1]!.candidateId, 'rejected'],
            ['human_edit', null, facts.candidates[2]!.candidateId, 'accepted']
        ]);
        expect(facts.candidates[1]!.fields.totalAmount.normalized).toBe('226.00');
        expect(facts.candidates[3]!.fields.totalAmount).toMatchObject({ normalized: '250.00', valueOrigin: 'user-provided', sources: [] });
        expect(facts.jobs[1]!.acceptedCandidateId).toBe(facts.candidates[3]!.candidateId);
        expect(facts.operations.find(o => o.stepId === 'unchanged')).toMatchObject({ result: { changed: false }, readback: null });
        expect(result.evidence['selected-candidate-fields']).toMatchObject({ present: true, actual: { totalAmount: '250.00' } });
        const exports = result.artifacts.filter(a => a.kind === 'invoice-export');
        expect(exports).toHaveLength(3);
        expect(exports.every(a => JSON.stringify(a.content).includes('FUTURE_USER_EDIT_MARKER'))).toBe(true);
        const exported = JSON.parse((exports[0]!.content as { text: string }).text);
        expect(exported).toMatchObject({ candidateId: facts.candidates[3]!.candidateId, origin: 'human_edit', fields: { totalAmount: { normalized: '250.00' } } });
        expect(result.evidence.runs!.actual).toHaveLength(2);
        const context = result.evidence['context-requests']!.actual as Array<{ snapshots: Array<{ snapshot: { json: { workspaceContext: { documentRef: { id: number } } } } }> }>;
        expect(context.map(r => r.snapshots[0]!.snapshot.json.workspaceContext.documentRef.id)).toEqual(documents.map(d => d.document.documentRef.id));
        expect(result.evidence['tool-evidence']).toMatchObject({ present: true, actual: { calls: expect.any(Array) } });
        expect(await session.snapshot()).toMatchObject({ endpointReached: true }); expect(requests).toHaveLength(6);
        const reference = (exports[0]!.content as { reference: { relativePath: string } }).reference;
        const exportedPath = join(item.directory, 'product', reference.relativePath), originalBytes = readFileSync(exportedPath);
        writeFileSync(exportedPath, 'changed export bytes');
        let changed: Awaited<ReturnType<AgentTrialSession['snapshot']>> | undefined;
        try { changed = await session.snapshot(); }
        finally { writeFileSync(exportedPath, originalBytes); }
        expect(changed!.started).toBe(true);
        expect(changed!.endpointReached).toBe(false);
        expect(changed!.evidence.runs).toEqual(result.evidence.runs);
        expect(changed!.evidence['capture-gaps']).toMatchObject({ present: false });
        expect(JSON.stringify(changed!.evidence['capture-gaps']!.actual)).toContain('Original invoice export bytes are unavailable');
        expect(changed!.evidence['invoice-exports']!.present).toBe(false);
        expect(requests).toHaveLength(6);
        expect(await session.snapshot()).toMatchObject({ endpointReached: true });
        const copied = join(item.directory, 'runtime', 'invoice-input');
        expect(readdirSync(copied).sort()).toEqual(['000001', '000002']);
        expect(readdirSync(join(copied, '000001')).sort()).toEqual(['content.json', 'metadata.json', 'original.png', 'pages.json']);
        expect(readFileSync(join(copied, '000001', 'original.png'))).toEqual(readFileSync(join(f.source,'000001/original.png')));
        expect(await session.close()).toMatchObject({ present: true, actual: { stopped: true } });
    } finally { if (session) await session.close(); await server.stop(); }
}, 45000);

test('invoice registration rejects unbound files and changed source bytes before creating a Host', async () => {
    for (const change of ['missing-pages', 'changed-original', 'changed-content', 'changed-projection', 'extra-file'] as const) {
        const f = fixture(), directory = join(f.root, 'trial'); mkdirSync(directory);
        if (change === 'missing-pages') f.materials = f.materials.filter(m => m.file !== 'pages.json');
        if (change === 'changed-original') writeFileSync(join(f.source, '000001', 'original.png'), 'changed');
        if (change === 'changed-content') writeFileSync(join(f.source, '000001', 'content.json'), '[]');
        if (change === 'changed-projection') f.visible[0]!.text += 'UNAUTHORIZED';
        if (change === 'extra-file') writeFileSync(join(f.source, '000001', 'gold.json'), 'QUALITY_CANARY');
        const item: AgentTrial = { identity: { executionId: 'invoice-negative', trialId: change, caseId: 'invoice-negative', caseVersion: 1 },
            directory, input: { prompt: 'Selected invoice.', materials: f.visible }, requires: ['agent', 'invoice', 'workspace'], configuration: {} };
        Object.assign(item, { invoiceSource: { root: f.source,files:f.files, materials: f.materials }, steps: [
            { id: 'first', action: 'invoice-message', instruction: item.input.prompt, sample: '000001', goalMode: 'answer' }
        ] });
        await expect(prepareHostTrial(item, new AbortController().signal, { repo: REPO_ROOT, credential: 'synthetic' })).rejects.toThrow('Invoice');
        expect(readdirSync(directory)).toEqual([]);
    }
});

test('an invoice answer claiming a save cannot replace a persisted candidate or a business endpoint', async () => {
    const f = fixture(); let requests = 0;
    const server = await createHttpProvider(async () => { requests++; return response({ role: 'assistant', content: 'I saved the invoice candidate.' }); });
    const item: AgentTrial = { identity: { executionId: 'invoice-no-save', trialId: 'invoice-no-save-1', caseId: 'invoice-no-save', caseVersion: 1 },
        directory: join(f.root, 'trial'), input: { prompt: 'Save the selected invoice candidate.', materials: f.visible.filter(m => m.sample === '000001') },
        requires: ['agent', 'invoice', 'workspace'], configuration: { modelCapabilities: syntheticNativeModel, model: 'invoice-fixture', baseUrl: `http://127.0.0.1:${server.port}/v1`, api: 'openai-completions' } };
    Object.assign(item, { invoiceSource: { root: f.source,files:f.files, materials: f.materials.filter(m => m.sample === '000001') }, steps: [
        { id: 'first', action: 'invoice-message', instruction: item.input.prompt, sample: '000001', goalMode: 'save-candidate' }
    ] });
    try {
        const result = await executeCase({ readiness: () => ({ ready: true, reason: 'Controlled engineering only' }),
            prepare: (trial, signal) => prepareHostTrial(trial, signal, { repo: REPO_ROOT, credential: 'synthetic-no-save' }) }, item, 20000, 10000);
        expect(result).toMatchObject({ stopFailed: false, execution: { endpointReached: false, artifacts: [], evidence: {
            invoice: { present: true, actual: { candidates: [] } }, 'candidate-fields': { present: false },
            'task-endpoint': { present: true, actual: false }, cleanup: { present: true, actual: { stopped: true } }
        } } });
        expect(requests).toBe(1);
    } finally { await server.stop(); }
}, 45000);

for (const profile of ['source-quote-trim', 'source-check-denial'] as const) test('actual registered invoice Hook profile ' + profile + ' preserves final admission and legal reading', async () => {
    const f = fixture(), requests: unknown[] = [], denial = profile === 'source-check-denial';
    const manifest = ExtensionManifestSchema.parse(JSON.parse(readFileSync(join(REPO_ROOT, 'resources/extensions/invoice-v1.json'), 'utf8')));
    const ref = { id: manifest.id, version: manifest.version };
    let document: { documentRef: { id: number; version: string }; parsedArtifactId: number };
    const server = await createHttpProvider(async request => {
        requests.push(await request.json());
        if (requests.length === 4) return response({ role: 'assistant', content: denial ? 'Source checking was denied; the original invoice still reads total 113.00. Nothing was saved.' : 'Saved the original invoice candidate after source checking.' });
        const source = { documentId: document.documentRef.id, version: document.documentRef.version, artifactId: document.parsedArtifactId,
            page: 1, blockId: 'b1', quote: 'Total 113.00' };
        let name: string, args: unknown;
        if (requests.length === 1 || requests.length === 3 && denial) {
            name = 'read_invoice_document'; args = { documentId: document.documentRef.id, page: 1, afterBlockId: null, limit: 10 };
        } else if (requests.length === 2) {
            name = 'check_invoice_sources'; args = { documentId: document.documentRef.id, sources: [{ ...source, quote: denial ? source.quote : '  ' + source.quote + '  ' }] };
        } else {
            const fields: Record<string, InvoiceField> = Object.fromEntries(invoiceHeaderFields.map(name => [name, { raw: null, normalized: null, state: 'missing', alternatives: [], sources: [] }]));
            fields.totalAmount = { raw: '113.00', normalized: '113.00', state: 'present', alternatives: [], sources: [source] };
            name = 'save_invoice_candidate'; args = { documentId: document.documentRef.id, candidate: { fields, lines: [], notes: [] } };
        }
        return response({ role: 'assistant', tool_calls: [{ index: 0, id: 'hook-' + requests.length, type: 'function', function: { name, arguments: JSON.stringify(args) } }] }, true);
    });
    const item: AgentTrial = { identity: { executionId: 'invoice-hooks', trialId: profile, caseId: 'invoice-hook', caseVersion: 1 },
        directory: join(f.root, 'trial'), input: { prompt: denial ? 'Read the selected invoice without saving and report any actual restriction.' : 'Check the sources and save the selected invoice.', materials: f.visible.filter(m => m.sample === '000001') },
        invoiceSource: { root: f.source,files:f.files, materials: f.materials.filter(m => m.sample === '000001') }, requires: ['agent', 'invoice', 'workspace', 'extension'],
        configuration: { modelCapabilities: syntheticNativeModel, model: 'invoice-fixture', baseUrl: `http://127.0.0.1:${server.port}/v1`, api: 'openai-completions', extensions: { enabledExtensions: [ref] } } };
    mkdirSync(item.directory);
    Object.assign(item, { setup: { extensionProfile: { id: profile, version: 1 } }, steps: [{ id: 'request', action: 'invoice-message', instruction: item.input.prompt,
        sample: '000001', goalMode: denial ? 'answer' : 'save-candidate', workspaceMode: denial ? 'selected-document' : 'start-task' },
        ...(!denial ? [{ id: 'selected', action: 'select-candidate', fromStep: 'request', ordinal: 1 }] : [])] });
    let session: AgentTrialSession | undefined;
    try {
        session = await prepareHostTrial(item, new AbortController().signal, { repo: REPO_ROOT, credential: 'synthetic-hook-key' });
        expect((await session.snapshot()).evidence['case-controller']).toMatchObject({ present: false, actual: { exposure: null } });
        document = ((await session.snapshot()).evidence['material-registration']!.actual as Array<{ document: typeof document }>)[0]!.document;
        const result = await session.execute(new AbortController().signal);
        expect(result).toMatchObject({ status: 'completed', endpointReached: true, evidence: { 'tool-evidence': { present: true }, extensions: { present: true } } });
        expect(requests).toHaveLength(4);
        const calls = (result.evidence['tool-evidence']!.actual as { calls: Array<{ tool: ToolCallSnapshot }> }).calls;
        const check = calls.find(c => c.tool.toolName === 'check_invoice_sources')!.tool;
        expect(result.evidence['case-controller']).toMatchObject({ present: true, actual: { profile: { id: profile, version: 1 },
            exposure: { verified: true, calls: [{ runId: check.runId, sessionId: check.sessionId, toolCallId: check.toolCallId,
                nativeToolCallId: check.nativeToolCallId }] } } });
        expect(check.status).toBe(denial ? 'failed' : 'succeeded');
        expect(check.args.raw).toMatchObject({ documentId: document.documentRef.id, sources: [{ quote: denial ? 'Total 113.00' : '  Total 113.00  ' }] });
        if (denial) {
            expect(check.args.final).toBeNull();
            expect(check.startedAt).toBeNull();
            expect(check.runtimeObservation).toMatchObject({ beforeOutcome: 'rejected', failureStage: 'sdk_before', executionDurationMs: null });
            expect(calls.filter(c => c.tool.toolName === 'read_invoice_document' && c.tool.status === 'succeeded')).toHaveLength(2);
        } else {
            expect(check.args.final).toMatchObject({ documentId: document.documentRef.id, sources: [{ quote: 'Total 113.00', documentId: document.documentRef.id, artifactId: document.parsedArtifactId }] });
            expect(check.runtimeObservation).toMatchObject({ beforeOutcome: 'allowed', failureStage: null });
            expect(result.evidence['candidate-fields']).toMatchObject({ present: true, actual: { totalAmount: '113.00' } });
        }
        expect(JSON.stringify(result.evidence.extensions!.actual)).toContain(profile);
        expect(JSON.stringify(result.evidence.extensions!.actual)).toContain(denial ? 'eval_source_check_denied' : 'eval_source_quote_trimmed');
        const facts = result.evidence.invoice!.actual as { jobs: unknown[]; candidates: unknown[] };
        expect(facts.jobs).toHaveLength(denial ? 0 : 1); expect(facts.candidates).toHaveLength(denial ? 0 : 1);
        expect((await session.snapshot()).evidence['tool-evidence']).toEqual(result.evidence['tool-evidence']);
        expect(requests).toHaveLength(4);
    } finally { if (session) expect(await session.close()).toMatchObject({ present: true, actual: { stopped: true } }); await server.stop(); }
}, 45000);

test('a selected Skill with a genuinely absent candidate dependency leaves legal invoice reading available', async () => {
    const f = fixture(), requests: unknown[] = [];
    const manifest = ResourceManifestSchema.parse(JSON.parse(readFileSync(join(REPO_ROOT, 'resources/skills/invoice-review-handoff/resource.json'), 'utf8')));
    const ref = { kind: 'skill' as const, id: manifest.id, version: manifest.version };
    let document: { documentRef: { id: number; version: string }; parsedArtifactId: number };
    const server = await createHttpProvider(async request => {
        requests.push(await request.json());
        if (requests.length === 2) return response({ role: 'assistant', content: 'The requested handoff Skill needs get_invoice_candidate, unavailable without a task. I read the authorized original instead: total 113.00. No candidate was saved.' });
        return response({ role: 'assistant', tool_calls: [{ index: 0, id: 'dependency-alternative-read', type: 'function', function: {
            name: 'read_invoice_document', arguments: JSON.stringify({ documentId: document.documentRef.id, page: 1, afterBlockId: null, limit: 10 }) } }] }, true);
    });
    const item: AgentTrial = { identity: { executionId: 'skill-missing-dependency', trialId: 'skill-dependency-1', caseId: 'skill-dependency', caseVersion: 1 },
        directory: join(f.root, 'trial'), input: { prompt: 'Use invoice-review-handoff for this selected invoice; read only, without creating a task or candidate.', materials: f.visible.filter(m => m.sample === '000001') },
        invoiceSource: { root: f.source,files:f.files, materials: f.materials.filter(m => m.sample === '000001') }, requires: ['agent', 'invoice', 'workspace'],
        configuration: { modelCapabilities: syntheticNativeModel, model: 'invoice-fixture', baseUrl: `http://127.0.0.1:${server.port}/v1`, api: 'openai-completions', resources: { prompt: null, enabledSkills: [ref] } } };
    mkdirSync(item.directory);
    Object.assign(item, { steps: [{ id: 'read', action: 'invoice-message', instruction: item.input.prompt, sample: '000001', goalMode: 'answer', workspaceMode: 'selected-document' }] });
    let session: AgentTrialSession | undefined;
    try {
        session = await prepareHostTrial(item, new AbortController().signal, { repo: REPO_ROOT, credential: 'synthetic-skill-dependency' });
        document = ((await session.snapshot()).evidence['material-registration']!.actual as Array<{ document: typeof document }>)[0]!.document;
        const result = await session.execute(new AbortController().signal);
        expect(result).toMatchObject({ status: 'completed', endpointReached: true, evidence: { resources: { present: true }, invoice: { present: true, actual: { jobs: [], candidates: [] } } } });
        expect(requests).toHaveLength(2);
        expect(JSON.stringify(requests[0])).toContain('invoice-review-handoff');
        expect(JSON.stringify(requests[0])).toContain('Partial (4/5 capabilities)');
        expect(JSON.stringify(requests[0])).toContain('get_invoice_candidate');
        const request = requests[0] as { tools: Array<{ function: { name: string } }> };
        expect(request.tools.some(t => t.function.name === 'get_invoice_candidate')).toBe(false);
        expect(request.tools.some(t => t.function.name === 'read_invoice_document')).toBe(true);
        expect(JSON.stringify(result.evidence.resources!.actual)).toContain('resource_dependency_missing');
        expect(JSON.stringify(result.evidence.resources!.actual)).toContain(ref.version);
        expect(result.evidence.tools).toMatchObject({ present: true, actual: [{ toolName: 'read_invoice_document', status: 'succeeded' }] });
        expect((await session.snapshot()).evidence.resources).toEqual(result.evidence.resources);
        expect(requests).toHaveLength(2);
    } finally { if (session) expect(await session.close()).toMatchObject({ present: true, actual: { stopped: true } }); await server.stop(); }
}, 45000);

test('invoice correction survives an actual Host restart before the explicit saving task', async () => {
    const f = fixture(), requests: unknown[] = [];
    let document: { documentRef: { id: number; version: string }; parsedArtifactId: number };
    const server = await createHttpProvider(async request => {
        requests.push(await request.json());
        if ([2, 3, 6].includes(requests.length)) return response({ role: 'assistant', content: 'Saved answer ' + requests.length });
        const source = { documentId: document.documentRef.id, version: document.documentRef.version, artifactId: document.parsedArtifactId, page: 1, blockId: 'b1', quote: 'Total 113.00' };
        const fields: Record<string, InvoiceField> = Object.fromEntries(invoiceHeaderFields.map(name => [name, { raw: null, normalized: null, state: 'missing', alternatives: [], sources: [] }]));
        fields.totalAmount = { raw: '113.00', normalized: '113.00', state: 'present', alternatives: [], sources: [source] };
        const name = requests.length === 5 ? 'save_invoice_candidate' : 'read_invoice_document';
        const args = requests.length !== 5 ? { documentId: document.documentRef.id, page: 1, afterBlockId: null, limit: 10 }
            : { documentId: document.documentRef.id, candidate: { fields, lines: [], notes: [] } };
        return response({ role: 'assistant', tool_calls: [{ index: 0, id: 'restart-invoice-tool-' + requests.length, type: 'function', function: { name, arguments: JSON.stringify(args) } }] }, true);
    });
    const item: AgentTrial = { identity: { executionId: 'invoice-restart', trialId: 'invoice-restart-1', caseId: 'invoice-restart', caseVersion: 1 },
        directory: join(f.root, 'trial'), input: { prompt: 'Browse the selected invoice only; my preliminary total is 112.00.', materials: f.visible.filter(m => m.sample === '000001') },
        invoiceSource: { root: f.source,files:f.files, materials: f.materials.filter(m => m.sample === '000001') }, requires: ['agent', 'invoice', 'workspace', 'history'],
        configuration: { modelCapabilities: syntheticNativeModel, model: 'invoice-fixture', baseUrl: `http://127.0.0.1:${server.port}/v1`, api: 'openai-completions' } };
    mkdirSync(item.directory);
    Object.assign(item, { steps: [
        { id: 'browse', action: 'invoice-message', instruction: item.input.prompt, sample: '000001', goalMode: 'answer', workspaceMode: 'selected-document' },
        { id: 'correct', action: 'user-message', instruction: 'CORRECTION_ONLY_NOW: the total is 113.00 as printed; do not save yet.' },
        { id: 'restart', action: 'restart-host' },
        { id: 'start', action: 'invoice-message', instruction: 'SAVE_ONLY_AFTER_RESTART using the latest saved user correction.', sample: '000001', goalMode: 'save-candidate' },
        { id: 'select', action: 'select-candidate', fromStep: 'start', ordinal: 1 }
    ] });
    let session: AgentTrialSession | undefined;
    try {
        session = await prepareHostTrial(item, new AbortController().signal, { repo: REPO_ROOT, credential: 'synthetic-invoice-restart' });
        document = ((await session.snapshot()).evidence['material-registration']!.actual as Array<{ document: typeof document }>)[0]!.document;
        const result = await session.execute(new AbortController().signal);
        expect(result).toMatchObject({ status: 'completed', endpointReached: true,
            evidence: { 'candidate-fields': { present: true, actual: { totalAmount: '113.00' } } } });
        expect(requests).toHaveLength(6);
        expect(JSON.stringify(requests[0])).not.toContain('CORRECTION_ONLY_NOW');
        expect(JSON.stringify(requests[0])).not.toContain('SAVE_ONLY_AFTER_RESTART');
        expect(JSON.stringify(requests[3])).toContain('CORRECTION_ONLY_NOW');
        expect(JSON.stringify(requests[3])).toContain(item.input.prompt);
        const restart = (result.evidence['history-operations']!.actual as Array<{ action: string; verified: boolean;
            before: { tools: unknown[]; invoice: { workspace: { documentRef: unknown; jobId: number | null }; jobs: unknown[]; candidates: unknown[] } }; after: unknown }>)[0]!;
        expect(restart).toMatchObject({ action: 'restart-host', verified: true,
            before: { invoice: { workspace: { documentRef: document.documentRef, jobId: null }, jobs: [], candidates: [] } } });
        expect(restart.after).toEqual(restart.before);
        expect(restart.before.tools).toHaveLength(1);
        const invoice = result.evidence.invoice!.actual as { jobs: unknown[]; candidates: Array<{ fields: { totalAmount: InvoiceField } }> };
        expect(invoice.jobs).toHaveLength(1); expect(invoice.candidates).toHaveLength(1);
        expect(invoice.candidates[0]!.fields.totalAmount).toMatchObject({ normalized: '113.00', sources: [{ documentId: document.documentRef.id }] });
        expect(result.evidence.inputs!.actual).toHaveLength(3);
        expect(result.evidence.tools!.actual).toHaveLength(3);
        expect((await session.snapshot()).evidence['history-operations']).toEqual(result.evidence['history-operations']);
        expect(requests).toHaveLength(6);
    } finally { if (session) expect(await session.close()).toMatchObject({ present: true, actual: { stopped: true } }); await server.stop(); }
}, 45000);

for (const startTask of [false, true]) test('New Session preserves the invoice without a Job until explicit Start Task: ' + startTask, async () => {
    const f = fixture(), requests: unknown[] = [];
    let document: { documentRef: { id: number; version: string }; parsedArtifactId: number };
    const server = await createHttpProvider(async request => {
        requests.push(await request.json());
        if (requests.length === 2 || requests.length === 5) return response({ role: 'assistant', content: requests.length === 2 ? 'The selected invoice total is 113.00.' : 'Saved the original selected invoice.' });
        const save = requests.length === 4;
        const source = { documentId: document.documentRef.id, version: document.documentRef.version, artifactId: document.parsedArtifactId, page: 1, blockId: 'b1', quote: 'Total 113.00' };
        const fields: Record<string, InvoiceField> = Object.fromEntries(invoiceHeaderFields.map(name => [name, { raw: null, normalized: null, state: 'missing', alternatives: [], sources: [] }]));
        fields.totalAmount = { raw: '113.00', normalized: '113.00', state: 'present', alternatives: [], sources: [source] };
        const name = save ? 'save_invoice_candidate' : 'read_invoice_document';
        const args = save ? { documentId: document.documentRef.id, candidate: { fields, lines: [], notes: [] } }
            : { documentId: document.documentRef.id, page: 1, afterBlockId: null, limit: 10 };
        return response({ role: 'assistant', tool_calls: [{ index: 0, id: 'workspace-tool-' + requests.length, type: 'function', function: { name, arguments: JSON.stringify(args) } }] }, true);
    });
    const item: AgentTrial = { identity: { executionId: 'workspace-new-session', trialId: 'workspace-' + startTask, caseId: 'workspace-case', caseVersion: 1 },
        directory: join(f.root, 'trial'), input: { prompt: 'Start a new chat and answer the selected invoice total without saving.', materials: f.visible.filter(m => m.sample === '000001') },
        invoiceSource: { root: f.source,files:f.files, materials: f.materials.filter(m => m.sample === '000001') }, requires: ['agent', 'invoice', 'workspace'],
        configuration: { modelCapabilities: syntheticNativeModel, model: 'invoice-fixture', baseUrl: `http://127.0.0.1:${server.port}/v1`, api: 'openai-completions' } };
    mkdirSync(item.directory);
    Object.assign(item, { steps: [
        { id: 'browse', action: 'invoice-message', instruction: item.input.prompt, sample: '000001', goalMode: 'answer', workspaceMode: 'new-session' },
        ...(startTask ? [{ id: 'start', action: 'invoice-message', instruction: 'START_TASK_ONLY_NOW: save the selected invoice.', sample: '000001', goalMode: 'save-candidate', workspaceMode: 'start-task' }] : [])
    ] });
    let session: AgentTrialSession | undefined;
    try {
        session = await prepareHostTrial(item, new AbortController().signal, { repo: REPO_ROOT, credential: 'synthetic-workspace-key' });
        const registration = (await session.snapshot()).evidence['material-registration']!.actual as Array<{ document: typeof document }>;
        document = registration[0]!.document;
        const result = await session.execute(new AbortController().signal);
        expect(result).toMatchObject({ status: 'completed', endpointReached: true });
        expect(requests).toHaveLength(startTask ? 5 : 2);
        expect(JSON.stringify(requests[0])).not.toContain('START_TASK_ONLY_NOW');
        const facts = result.evidence.invoice!.actual as { workspace: { jobId: number | null; documentRef: unknown }; jobs: unknown[]; candidates: unknown[];
            operations: Array<{ mode?: string; before?: { sessionId: number }; result?: { sessionId: number; jobId: number | null; documentRef: unknown } }> };
        const newSession = facts.operations.find(operation => operation.mode === 'new-session')!;
        expect(newSession).toBeDefined();
        expect(newSession.result!.sessionId).not.toBe(newSession.before!.sessionId);
        expect(newSession.result).toMatchObject({ jobId: null, documentRef: document.documentRef });
        expect(facts.jobs).toHaveLength(startTask ? 1 : 0);
        expect(facts.candidates).toHaveLength(startTask ? 1 : 0);
        expect(facts.workspace.documentRef).toEqual(document.documentRef);
        const inputs = result.evidence.inputs!.actual as Array<{ content: { workspaceContext: { jobId: number | null } } }>;
        expect(inputs.at(-1)!.content.workspaceContext.jobId).toBeNull();
        expect((await session.snapshot()).evidence.invoice).toEqual(result.evidence.invoice);
        expect(requests).toHaveLength(startTask ? 5 : 2);
    } finally { if (session) expect(await session.close()).toMatchObject({ present: true, actual: { stopped: true } }); await server.stop(); }
}, 45000);
