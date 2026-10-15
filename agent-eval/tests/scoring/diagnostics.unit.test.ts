import { expect, test } from 'bun:test';
import { diagnosticApplicable, diagnosticEvaluatorIds, diagnosticMetricCatalog, diagnosticPlanSchema, evaluateDiagnostic } from '../../src/scoring/diagnostics.ts';
import { observed, task } from '../support/fixtures.ts';
import type { EvaluationContext } from '../../src/scoring/types.ts';
import { ContextSnapshotDetailSchema, PublicContextRequestEvidenceSchema } from '../../../packages/contracts/src/context.ts';

function context(): EvaluationContext {
    const result = observed();
    result.evidence.runs = { present: true, source: 'original Runs', actual: [{ runId: 1, sessionId: 1, scope: { allowedTools: ['list_invoice_pages'], allowedDocumentIds: [1] } }] };
    result.evidence['tool-evidence'] = { present: true, source: 'original tool collection', actual: { calls: [] } };
    return { task: structuredClone(task), result, projected: result.input, judge: null };
}
function plan(c: EvaluationContext, evaluatorId: string, params: unknown, required = true) {
    Object.assign(c.task.expected, { diagnostics: [{ evaluatorId, required, reason: 'Independent Case requirement', params }] });
}
function tool(id = 1, data: unknown = { pages: [] }) {
    const at = '2026-10-13T00:00:00.000Z';
    return { toolCallId: id, runId: 1, sessionId: 1, nativeToolCallId: `call-${id}`, context: null,
        toolName: 'list_invoice_pages', toolVersion: '1', effect: 'READ', status: 'succeeded',
        args: { version: 1, raw: { documentId: 1 }, final: { documentId: 1 } },
        result: { version: 1, status: 'succeeded', committedCandidateId: null, data },
        delivery: { version: 1, state: 'request_observed', messageObservedAt: at, includedInCallSequence: 2, requestDispatchedAt: at, error: null },
        cleanup: { version: 1, stopped: true, stopReason: null, errors: [] }, requestedAt: at, startedAt: at, endedAt: at, stoppedAt: at };
}
function collect(c: EvaluationContext, calls: ReturnType<typeof tool>[], complete = true) {
    c.result.evidence['tool-evidence'] = { present: complete, source: 'original tool collection', actual: {
        calls: calls.map(tool => ({ tool,  bytes: Buffer.byteLength(JSON.stringify(tool)) }))
    } };
}

test('diagnostic catalog and strict plans enumerate eleven independent diagnostics', () => {
    expect(diagnosticEvaluatorIds).toHaveLength(11);
    expect(diagnosticMetricCatalog.map(m => m.id)).toEqual(diagnosticEvaluatorIds.map(id => `diagnostic-${id}`));
    expect(diagnosticPlanSchema.safeParse({ evaluatorId: 'latency-budget', required: true, reason: 'budget', params: { maxMs: 1000 } }).success).toBe(true);
    expect(diagnosticPlanSchema.safeParse({ evaluatorId: 'latency-budget', required: true, reason: 'budget', params: { maxMs: 1000, invented: true } }).success).toBe(false);
    expect(diagnosticPlanSchema.safeParse({ evaluatorId: 'freshness-compliance', required: true, reason: 'data time', params: {
        referenceTime: '2026-10-13T00:00:00Z', maxAgeMs: 1000, values: [{ toolName: 'list_invoice_pages', occurrence: 1, path: ['result', 'data', 'fetchedAt'] }] } }).success).toBe(false);
});
test('applicability is declaration-only; optional tools never become a complete whitelist', () => {
    const c = context(); Object.assign(c.task.expected, { optionalCapabilities: ['list_invoice_pages'] });
    expect(diagnosticApplicable(c, 'tool-precision')).toBe(false);
    expect(evaluateDiagnostic(c, 'tool-precision')).toBeUndefined();
    Object.assign(c.task.expected, { requiredCapabilities: ['list_invoice_pages'] });
    expect(diagnosticApplicable({ task: c.task } as EvaluationContext, 'tool-recall')).toBe(true);
});
test('semantic diagnostic siblings do not disable local plans; invalid local overrides do not infer a pass', () => {
    const c = context(); plan(c, 'max-tool-calls', { maxCalls: 0 });
    const declarations = (c.task.expected as { diagnostics: unknown[] }).diagnostics;
    declarations.push({ evaluatorId: 'task-judge', required: true, reason: 'Disclosure', params: { metricId: 'diagnostic-partial-failure-explanation', denominator: 1, evidence: ['answer'] } });
    expect(evaluateDiagnostic(c, 'max-tool-calls')).toMatchObject({ status: 'PASS' });
    Object.assign(c.task.expected, { maxToolCalls: 0 });
    declarations[0] = { evaluatorId: 'max-tool-calls', required: true, reason: 'Invalid', params: { maxCalls: -1 } };
    expect(evaluateDiagnostic(c, 'max-tool-calls')).toBeUndefined();
});
test('required recall uses declared denominator and does not trust answer claims', () => {
    const c = context(); plan(c, 'tool-recall', { requiredTools: ['list_invoice_pages'] });
    c.result.answer = 'I used list_invoice_pages';
    expect(evaluateDiagnostic(c, 'tool-recall')).toMatchObject({ status: 'FAIL', required: true, statistics: { numerator: 0, denominator: 1 } });
    collect(c, [tool()]);
    expect(evaluateDiagnostic(c, 'tool-recall')).toMatchObject({ status: 'PASS', value: 1 });
    const raw = c.result.evidence['tool-evidence']!.actual as { calls: Array<{ bytes:number }> };raw.calls[0]!.bytes++;
    expect(evaluateDiagnostic(c, 'tool-recall')).toMatchObject({ status: 'UNJUDGEABLE', value: null });
});
test('known forbidden and over-budget calls survive partial acquisition', () => {
    const c = context(); collect(c, [tool()], false);
    plan(c, 'tool-precision', { forbiddenTools: ['list_invoice_pages'] });
    expect(evaluateDiagnostic(c, 'tool-precision')).toMatchObject({ status: 'FAIL' });
    plan(c, 'max-tool-calls', { maxCalls: 0 });
    expect(evaluateDiagnostic(c, 'max-tool-calls')).toMatchObject({ status: 'FAIL' });
    plan(c, 'max-tool-calls', { maxCalls: 2 });
    expect(evaluateDiagnostic(c, 'max-tool-calls')).toMatchObject({ status: 'UNJUDGEABLE' });
});
test('argument validity retains raw argument failure after final arguments were corrected', () => {
    const c = context(), call = tool(); call.args.raw = {} as typeof call.args.raw;
    collect(c, [call]); plan(c, 'argument-validity', {});
    expect(evaluateDiagnostic(c, 'argument-validity')).toMatchObject({ status: 'FAIL' });
});
test('no calls do not create a perfect error rate or argument score', () => {
    const c = context();
    plan(c, 'tool-error-rate', {});
    expect(evaluateDiagnostic(c, 'tool-error-rate')).toMatchObject({ status: 'NOT_APPLICABLE', value: null });
    plan(c, 'argument-validity', {});
    expect(evaluateDiagnostic(c, 'argument-validity')).toMatchObject({ status: 'NOT_APPLICABLE', value: null });
});
test('verified execution failure persists with a partial collection and infrastructure error', () => {
    const c = context(), call = tool();
    Object.assign(call, { status: 'failed', result: { version: 1, status: 'failed', committedCandidateId: null,
        error: { code: 'tool_failed', category: 'tool', message: 'Failed', retryable: false } } });
    collect(c, [call], false); plan(c, 'tool-error-rate', {});
    c.result.error = { code: 'capture_failed', message: 'Partial capture', infrastructure: true };
    expect(evaluateDiagnostic(c, 'tool-error-rate')).toMatchObject({ status: 'FAIL', statistics: { numerator: 1, denominator: null } });
    c.result.evidence['tool-evidence']!.source = '';
    expect(evaluateDiagnostic(c, 'tool-error-rate')).toMatchObject({ status: 'ERROR' });
});
test('empty original Run collection cannot prove a zero-call budget was met', () => {
    const c = context(); plan(c, 'max-tool-calls', { maxCalls: 0 });
    c.result.evidence.runs!.actual = [];
    expect(evaluateDiagnostic(c, 'max-tool-calls')).toMatchObject({ status: 'UNJUDGEABLE' });
});
test('latency uses Agent execution interval and a declared budget', () => {
    const c = context(); plan(c, 'latency-budget', { maxMs: 1000 });
    expect(evaluateDiagnostic(c, 'latency-budget')).toMatchObject({ status: 'PASS', actual: 1000 });
    c.result.endedAt = '2026-09-23T00:00:02Z';
    expect(evaluateDiagnostic(c, 'latency-budget')).toMatchObject({ status: 'FAIL', actual: 2000 });
    c.result.started = false;
    expect(evaluateDiagnostic(c, 'latency-budget')).toMatchObject({ status: 'NOT_RUN' });
});
test('freshness evaluates declared data time, not newly fetched old data', () => {
    const c = context(); plan(c, 'freshness-compliance', { referenceTime: '2026-10-13T00:00:00Z', maxAgeMs: 86400000,
        values: [{ toolName: 'list_invoice_pages', occurrence: 1, path: ['result', 'data', 'publishedAt'] }] });
    collect(c, [tool(1, { publishedAt: '2020-01-01T00:00:00Z', fetchedAt: '2026-10-13T00:00:00Z' })]);
    expect(evaluateDiagnostic(c, 'freshness-compliance')).toMatchObject({ status: 'FAIL' });
});
test('provenance compares independent structured facts, not keywords', () => {
    const c = context(); c.result.answer = 'failure retry recovered';
    for (const id of ['provenance-presence'] as const) {
        plan(c, id, { checks: [{ toolName: 'list_invoice_pages', occurrence: 1, path: ['result', 'data', 'sourceId'], equals: 'source-A' }] });
        expect(evaluateDiagnostic(c, id)).toMatchObject({ status: 'UNJUDGEABLE' });
        collect(c, [tool(1, { sourceId: 'source-B' })]);
        expect(evaluateDiagnostic(c, id)).toMatchObject({ status: 'FAIL' });
        collect(c, [tool(1, { sourceId: 'source-A' })]);
        expect(evaluateDiagnostic(c, id)).toMatchObject({ status: 'PASS' });
        collect(c, []);
    }
});

test('disclosure and recovery cannot pass when the planned original failure never happened',()=>{
    const c=context();collect(c,[tool(1,{sourceId:'source-A'})]);
    for(const id of ['partial-failure-honesty','failure-recovery'] as const){
        plan(c,id,{checks:[{toolName:'list_invoice_pages',occurrence:1,path:['result','data','sourceId'],equals:'source-A'}]});
        expect(evaluateDiagnostic(c,id)).toMatchObject({status:'UNJUDGEABLE',value:null,statistics:{missing:1}});
    }
});

test('rate values preserve measured ratios independently of their pass fail verdict',()=>{
    const c=context();collect(c,[tool()]);
    plan(c,'tool-recall',{requiredTools:['list_invoice_pages','read_invoice_evidence']});
    expect(evaluateDiagnostic(c,'tool-recall')).toMatchObject({status:'FAIL',value:0.5,statistics:{numerator:1,denominator:2,missing:0}});
    const successful=tool();Object.assign(successful,{runtimeObservation:{version:1,groupKey:'list_invoice_pages/v1',strategyVersion:'runtime-v1',sampleSource:'test',
        beforeOutcome:'allowed',failureStage:null,diagnosticCode:null,afterStructure:'valid',afterDomain:'valid',executionDurationMs:1,timingComplete:true,
        effectiveTimeoutMs:1000,timeoutSource:'configured',runDeadlineTruncated:false,commit:'none_confirmed',commitError:null}});
    collect(c,[successful]);plan(c,'tool-error-rate',{maxErrorRate:0});
    expect(evaluateDiagnostic(c,'tool-error-rate')).toMatchObject({status:'PASS',value:0,statistics:{numerator:0,denominator:1,missing:0}});
});

test('linked original faults permit independent disclosure and recovery fact checks',()=>{
    const c=context(),failed=tool(1);
    Object.assign(failed,{status:'failed',result:{version:1,status:'failed',committedCandidateId:null,error:{code:'tool_failed',category:'tool',message:'Failed',retryable:false}}});
    for(const id of ['partial-failure-honesty','failure-recovery'] as const){
        plan(c,id,{checks:[{toolName:'list_invoice_pages',occurrence:2,path:['result','data','sourceId'],equals:'source-A'}]});
        collect(c,[failed,tool(2,{sourceId:'source-A'})]);
        expect(evaluateDiagnostic(c,id)).toMatchObject({status:'PASS',value:1});
        collect(c,[failed,tool(2,{sourceId:'wrong'})]);
        expect(evaluateDiagnostic(c,id)).toMatchObject({status:'FAIL',value:0});
    }
});

test('a known error rate lower bound above budget survives an unknown peer execution',()=>{
    const c=context(),failed=tool(1),unknown=tool(2);
    Object.assign(failed,{status:'failed',result:{version:1,status:'failed',committedCandidateId:null,error:{code:'tool_failed',category:'tool',message:'Failed',retryable:false}}});
    collect(c,[failed,unknown]);plan(c,'tool-error-rate',{maxErrorRate:0.25});
    expect(evaluateDiagnostic(c,'tool-error-rate')).toMatchObject({status:'FAIL',value:null,statistics:{numerator:1,denominator:2,missing:1}});
});
test('structured facts require original Run identity and authorization', () => {
    const c = context(); plan(c, 'provenance-presence', { checks: [{ toolName: 'list_invoice_pages', occurrence: 1, path: ['result', 'data', 'sourceId'], equals: 'source-A' }] });
    collect(c, [tool(1, { sourceId: 'source-A' })]);
    c.result.evidence.runs!.actual = [{ runId: 2, sessionId: 2 }];
    expect(evaluateDiagnostic(c, 'provenance-presence')).toMatchObject({ status: 'UNJUDGEABLE' });
    c.result.evidence.runs!.actual = [{ runId: 1, sessionId: 1, scope: { allowedTools: [], allowedDocumentIds: [] } }];
    expect(evaluateDiagnostic(c, 'provenance-presence')).toMatchObject({ status: 'UNJUDGEABLE' });
});
test('usable evidence requires authorized data in an actually dispatched original request', () => {
    const c = context(), at = '2026-10-13T00:00:00Z'; plan(c, 'evidence-presence', {});
    const request = PublicContextRequestEvidenceSchema.parse({ api: 'anthropic-messages', boundAt: at,
        binding: { runId: 1, sessionId: 1, nativeSessionId: 'original', requestSequence: 1, callSequence: 1, inputId: 1, snapshotId: 1,
            includedBindings: [{ originRunId: 1, inputId: 1, nativeEntryId: 'entry-1', snapshotId: 1 }], includedToolResults: [], includedNativeContexts: [] },
        sdkPayload: { observedAt: at, inclusion: 'confirmed', reason: null }, transport: 'observed-fetch',
        attempts: [{ attempt: 1, preparedAt: at, enteredAt: at, responseAt: at, responseStatus: 200, nativeRequestId: null,
            transportErrorCode: null, wireInclusion: 'confirmed', wireReason: null }] });
    const snapshot = ContextSnapshotDetailSchema.parse({ snapshot: { id: 1, sessionId: 1, runId: 1, jobId: null, sequence: 1, createdAt: at,
        json: { version: 1, policyVersion: 'p8-context-v1', text: 'Read evidence', goalMode: 'answer', workspaceContext: null,
            resourcePolicy: 'none', hasWorkingDirectory: false, modelProjection: { taskGoal: null, candidate: null, issues: [], gaps: [],
                fragments: [{ documentRef: { id: 1, version: 'original' }, artifactId: 1, page: 1, blockId: 'b1', reasons: ['document-prefix'], sources: [],
                    windows: [{ start: 0, end: 10, text: 'Authorized' }], originalBytes: 10, includedBytes: 10, truncated: false }] },
            budgets: { projectionBytes: 65536, fragmentBytes: 4096, fragments: 32, issueCount: 20, snapshotBytes: 262144 } } },
        input: { inputId: 1, sessionId: 1, clientSequence: 1, mode: 'prompt', goalMode: 'answer', runId: 1, status: 'consumed',
            processingStatus: 'completed', nativeEntryId: 'entry-1', resultEntryId: null, dispatchedAt: at, createdAt: at, updatedAt: at, error: null } });
    const frames = structuredClone([{ runId: 1, collected: true, requests: [request], snapshots: [snapshot] }]);
    c.result.evidence['context-requests'] = { present: true, source: 'original request journal', actual: frames };
    expect(evaluateDiagnostic(c, 'evidence-presence')).toMatchObject({ status: 'PASS' });
    c.result.evidence.runs!.actual = [{ runId: 1, sessionId: 1, scope: { allowedTools: ['list_invoice_pages'], allowedDocumentIds: [] } }];
    expect(evaluateDiagnostic(c, 'evidence-presence')).toMatchObject({ status: 'FAIL' });
    c.result.evidence.runs!.actual = [{ runId: 1, sessionId: 1, scope: { allowedTools: ['list_invoice_pages'], allowedDocumentIds: [1] } }];
    Object.assign(frames[0]!.requests[0]!, { sdkPayload: { observedAt: null, inclusion: 'unavailable', reason: 'payload_codec_unavailable' } });
    expect(evaluateDiagnostic(c, 'evidence-presence')).toMatchObject({ status: 'UNJUDGEABLE' });
});
