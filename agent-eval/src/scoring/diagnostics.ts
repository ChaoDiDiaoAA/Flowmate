import { z } from 'zod';
import { isDeepStrictEqual } from 'node:util';
import { createHash } from 'node:crypto';
import { ToolCallSnapshotSchema } from '../../../packages/contracts/src/tool-evidence.ts';
import { invoiceToolSchemas } from '../../../packages/contracts/src/invoice.ts';
import { isJsonData } from '../../../packages/contracts/src/tools.ts';
import { ContextSnapshotDetailSchema, PublicContextRequestEvidenceSchema } from '../../../packages/contracts/src/context.ts';
import { DelegateArgsSchema } from '../../../packages/contracts/src/subagents.ts';
import { ResearchPlanToolInputSchema, ResearchClaimBodySchema, ResearchReportBodySchema } from '../../../packages/contracts/src/research.ts';
import type { EvaluationContext, EvaluationScore } from './types.ts';
import type { MetricDefinition } from './catalog.ts';

export const diagnosticEvaluatorIds = ['tool-recall', 'tool-precision', 'tool-error-rate', 'argument-validity', 'max-tool-calls',
    'evidence-presence', 'provenance-presence', 'freshness-compliance', 'partial-failure-honesty', 'latency-budget', 'failure-recovery'] as const;
type DiagnosticId = typeof diagnosticEvaluatorIds[number];
const text = z.string().trim().min(1);
const names = z.array(text).min(1).refine(values => new Set(values).size === values.length, 'Duplicate tool name');
const path = z.array(text).min(1).refine(parts => parts.every(part => !['__proto__', 'constructor', 'prototype'].includes(part)), 'Unsafe evidence path');
const selector = { toolName: text, occurrence: z.number().int().positive().default(1), path };
const check = z.object({ ...selector, equals: z.unknown().refine(value => value !== undefined && isJsonData(value), 'Independent JSON expected value is required') }).strict();
const checks = z.object({ checks: z.array(check).min(1) }).strict();
const sourceChecks = checks.refine(value => value.checks.every(check => check.equals !== null &&
    (typeof check.equals !== 'string' || !!check.equals.trim()) && (typeof check.equals !== 'object' || Object.keys(check.equals).length > 0)), 'Provenance requires a nonempty independent source value');
const base = { required: z.boolean(), reason: text };
export const diagnosticPlanSchema = z.discriminatedUnion('evaluatorId', [
    z.object({ ...base, evaluatorId: z.literal('tool-recall'), params: z.object({ requiredTools: names }).strict() }).strict(),
    z.object({ ...base, evaluatorId: z.literal('tool-precision'), params: z.object({ allowedTools: names.optional(), forbiddenTools: names.optional() }).strict()
        .refine(value => !!value.allowedTools || !!value.forbiddenTools, 'Explicit allowed or forbidden tools required') }).strict(),
    z.object({ ...base, evaluatorId: z.literal('tool-error-rate'), params: z.object({ maxErrorRate: z.number().min(0).max(1).default(0) }).strict() }).strict(),
    z.object({ ...base, evaluatorId: z.literal('argument-validity'), params: z.object({ toolNames: names.optional() }).strict() }).strict(),
    z.object({ ...base, evaluatorId: z.literal('max-tool-calls'), params: z.object({ maxCalls: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER) }).strict() }).strict(),
    z.object({ ...base, evaluatorId: z.literal('evidence-presence'), params: z.object({}).strict() }).strict(),
    z.object({ ...base, evaluatorId: z.literal('provenance-presence'), params: sourceChecks }).strict(),
    z.object({ ...base, evaluatorId: z.literal('freshness-compliance'), params: z.object({ referenceTime: z.string().datetime({ offset: true }), maxAgeMs: z.number().finite().nonnegative(),
        values: z.array(z.object({ ...selector, path: path.refine(parts => !parts.some(part => /^(fetchedAt|retrievedAt)$/i.test(part)), 'Retrieval time is not data time') }).strict()).min(1) }).strict() }).strict(),
    z.object({ ...base, evaluatorId: z.literal('partial-failure-honesty'), params: checks }).strict(),
    z.object({ ...base, evaluatorId: z.literal('latency-budget'), params: z.object({ maxMs: z.number().finite().nonnegative() }).strict() }).strict(),
    z.object({ ...base, evaluatorId: z.literal('failure-recovery'), params: checks }).strict()
]);
export type DiagnosticsPlan = z.infer<typeof diagnosticPlanSchema>;

const namesById: Record<DiagnosticId, string> = {
    'tool-recall': '必需工具召回', 'tool-precision': '工具集合符合性', 'tool-error-rate': '工具调用错误率', 'argument-validity': '工具参数合法性',
    'max-tool-calls': '工具调用次数上限', 'evidence-presence': '可用证据实际送达', 'provenance-presence': '来源结构化事实',
    'freshness-compliance': '数据时效符合性', 'partial-failure-honesty': '部分失败披露事实', 'latency-budget': 'Agent执行延迟预算', 'failure-recovery': '故障恢复事实'
};
export const diagnosticMetricCatalog: readonly MetricDefinition[] = diagnosticEvaluatorIds.map(id => ({
    id: `diagnostic-${id}`, version: 1, name: namesById[id], group: 'diagnostic', unit: '检查机会',
    direction: id === 'tool-error-rate' ? 'down' : 'up',
    numerator: id === 'tool-error-rate' ? '错误调用' : '符合声明的检查机会', denominator: id === 'tool-error-rate' ? '实际执行调用' : '适用检查机会',
    formula: id === 'latency-budget' ? 'Agent执行耗时符合显式预算为1，否则为0；actual保留毫秒原值' : '分子 / 分母'
}));

function selected(context: EvaluationContext, id: DiagnosticId): DiagnosticsPlan | undefined {
    const expected = context.task.expected;
    const declared = z.object({ diagnostics: z.array(z.unknown()).optional() }).passthrough().safeParse(expected);
    if (!declared.success) return;
    const explicit = declared.data.diagnostics?.find(plan => plan && typeof plan === 'object' && 'evaluatorId' in plan && plan.evaluatorId === id);
    if (explicit) {
        const parsed = diagnosticPlanSchema.safeParse(explicit);
        return parsed.success ? parsed.data : undefined;
    }
    const inferred = { evaluatorId: id, required: false, reason: 'Existing Case constraint; required hard constraint is scored separately' };
    const constraints = z.object({ requiredCapabilities: names.optional(), forbiddenCapabilities: names.optional(),
        maxToolCalls: z.number().int().nonnegative().optional(), mustHaveEvidence: z.boolean().optional() }).passthrough().safeParse(expected);
    if (!constraints.success) return;
    let params: unknown;
    if (id === 'tool-recall' && constraints.data.requiredCapabilities?.length) params = { requiredTools: constraints.data.requiredCapabilities };
    if (id === 'tool-precision' && constraints.data.forbiddenCapabilities?.length) params = { forbiddenTools: constraints.data.forbiddenCapabilities };
    if (id === 'max-tool-calls' && constraints.data.maxToolCalls !== undefined) params = { maxCalls: constraints.data.maxToolCalls };
    if (id === 'evidence-presence' && constraints.data.mustHaveEvidence) params = {};
    if (params === undefined) return;
    const parsed = diagnosticPlanSchema.safeParse({ ...inferred, params });
    return parsed.success ? parsed.data : undefined;
}
export function diagnosticApplicable(context: EvaluationContext, id: DiagnosticId): boolean { return selected(context, id) !== undefined; }

type Tool = z.infer<typeof ToolCallSnapshotSchema>;
const additionalInputs: Readonly<Record<string, z.ZodTypeAny>> = { Agent: DelegateArgsSchema,
    save_research_plan: ResearchPlanToolInputSchema, save_research_claim: ResearchClaimBodySchema, save_research_report: ResearchReportBodySchema };
function originals(context: EvaluationContext) {
    const evidence = context.result.evidence;
    const runs = z.array(z.object({ runId: z.number().int().positive(), sessionId: z.number().int().positive(),
        scope: z.object({ allowedTools: z.array(z.string()), allowedDocumentIds: z.array(z.number()), allowedArtifactIds: z.array(z.number()).optional() }).passthrough().optional() }).passthrough()).safeParse(evidence.runs?.actual);
    const collection = z.object({ calls: z.array(z.object({ tool: z.unknown(), sha256: z.string(), bytes: z.number() }).passthrough()) }).passthrough().safeParse(evidence['tool-evidence']?.actual);
    const calls = new Map<number, Tool>(), conflicting = new Set<number>();
    let valid = runs.success && runs.data.length > 0 && new Set(runs.data.map(run => run.runId)).size === runs.data.length &&
        collection.success && !!evidence.runs?.source.trim() && !!evidence['tool-evidence']?.source.trim();
    if (collection.success && runs.success && evidence.runs?.source.trim() && evidence['tool-evidence']?.source.trim()) for (const record of collection.data.calls) {
        const parsed = ToolCallSnapshotSchema.safeParse(record.tool);
        if (!parsed.success || createHash('sha256').update(JSON.stringify(record.tool)).digest('hex') !== record.sha256 ||
            Buffer.byteLength(JSON.stringify(record.tool)) !== record.bytes || !runs.success ||
            !runs.data.some(run => run.runId === parsed.data.runId && run.sessionId === parsed.data.sessionId)) { valid = false; continue; }
        if (conflicting.has(parsed.data.toolCallId)) continue;
        const prior = calls.get(parsed.data.toolCallId);
        if (prior && !isDeepStrictEqual(prior, parsed.data)) { calls.delete(parsed.data.toolCallId); conflicting.add(parsed.data.toolCallId); valid = false; continue; }
        calls.set(parsed.data.toolCallId, parsed.data);
    }
    const authorized = (call: Tool) => {
        const run = runs.success ? runs.data.find(run => run.runId === call.runId && run.sessionId === call.sessionId) : undefined;
        if (!run?.scope?.allowedTools.includes(call.toolName)) return false;
        const args = z.object({ documentId: z.number().nullable().optional(), artifactId: z.number().nullable().optional() }).passthrough().safeParse(call.args.final);
        return args.success && (args.data.documentId == null || run.scope.allowedDocumentIds.includes(args.data.documentId)) &&
            (args.data.artifactId == null || !!run.scope.allowedArtifactIds?.includes(args.data.artifactId));
    };
    return { calls: [...calls.values()].sort((a, b) => a.requestedAt.localeCompare(b.requestedAt) || a.toolCallId - b.toolCallId),
        complete: valid && !!evidence.runs?.present && !!evidence['tool-evidence']?.present, authorized, valid,
        runs: runs.success ? runs.data : [] };
}
function field(value: unknown, parts: readonly string[]): unknown {
    for (const part of parts) {
        if (!value || typeof value !== 'object' || !Object.prototype.hasOwnProperty.call(value, part)) return undefined;
        value = (value as Record<string, unknown>)[part];
    }
    return value;
}

export function evaluateDiagnostic(context: EvaluationContext, id: DiagnosticId): EvaluationScore | undefined {
    const plan = selected(context, id); if (!plan) return;
    const { result } = context, original = originals(context);
    let ok: boolean | undefined, actual: unknown, numerator: number | null = null, denominator: number | null = null, missing: number | null = null;
    let unavailable = false;
    const sources = ['tool-evidence', 'runs'];
    if (plan.evaluatorId === 'latency-budget') {
        sources.splice(0, sources.length, 'execution.startedAt', 'execution.endedAt');
        const start = result.startedAt ? Date.parse(result.startedAt) : NaN, end = result.endedAt ? Date.parse(result.endedAt) : NaN;
        actual = Number.isFinite(start) && Number.isFinite(end) && end >= start ? end - start : null;
        ok = typeof actual === 'number' ? actual <= plan.params.maxMs : undefined;
    } else if (plan.evaluatorId === 'max-tool-calls') {
        actual = original.calls.length;
        ok = original.calls.length > plan.params.maxCalls ? false : original.complete ? true : undefined;
    } else if (plan.evaluatorId === 'tool-recall') {
        denominator = plan.params.requiredTools.length;
        numerator = plan.params.requiredTools.filter(name => original.calls.some(call => call.toolName === name)).length;
        actual = [...new Set(original.calls.map(call => call.toolName))];
        ok = numerator === denominator && original.valid ? true : original.complete && !result.error?.infrastructure ? false : undefined;
        missing = original.complete ? 0 : denominator - numerator;
    } else if (plan.evaluatorId === 'tool-precision') {
        const failures = original.calls.filter(call => plan.params.forbiddenTools?.includes(call.toolName) || plan.params.allowedTools && !plan.params.allowedTools.includes(call.toolName));
        numerator = original.calls.length - failures.length; denominator = original.complete ? original.calls.length : null;
        missing=original.complete?0:null;
        actual = original.calls.map(call => call.toolName);
        ok = failures.length ? false : original.complete ? true : undefined;
        unavailable = original.complete && !original.calls.length;
    } else if (plan.evaluatorId === 'tool-error-rate') {
        const executed = original.calls.filter(call => call.startedAt !== null);
        const failures = executed.filter(call => call.status === 'failed' || call.status === 'cancelled' || call.runtimeObservation?.afterStructure === 'invalid' ||
            call.runtimeObservation?.afterDomain === 'invalid' || call.status==='succeeded'&&(call.stoppedAt === null || !call.cleanup.stopped));
        const unknown = executed.filter(call => !failures.includes(call)&&(call.status === 'running' || call.status === 'requested' || !call.runtimeObservation));
        numerator = failures.length; denominator = original.complete ? executed.length : null;
        missing=original.complete?unknown.length:null;
        actual = { errors: numerator, executions: denominator };
        ok = original.complete && executed.length && failures.length/executed.length>plan.params.maxErrorRate ? false :
            original.complete && !unknown.length && executed.length ? true : failures.length && plan.params.maxErrorRate === 0 ? false : undefined;
        unavailable = original.complete && !executed.length;
    } else if (plan.evaluatorId === 'argument-validity') {
        const calls = original.calls.filter(call => !plan.params.toolNames || plan.params.toolNames.includes(call.toolName));
        const conclusions = calls.map(call => {
            const schema = invoiceToolSchemas[call.toolName as keyof typeof invoiceToolSchemas]?.input ?? additionalInputs[call.toolName];
            return schema ? schema.safeParse(call.args.raw).success && schema.safeParse(call.args.final).success : undefined;
        });
        actual = conclusions; numerator = conclusions.filter(value => value === true).length; denominator = original.complete ? calls.length : null;
        missing=original.complete?conclusions.filter(value=>value===undefined).length:null;
        ok = conclusions.includes(false) ? false : original.complete && conclusions.length && conclusions.every(value => value === true) ? true : undefined;
        unavailable = original.complete && !calls.length;
    } else if (plan.evaluatorId === 'evidence-presence') {
        sources.push('context-requests', 'input-projection');
        const fact = result.evidence['context-requests'];
        const contexts = z.array(z.object({ runId: z.number(), collected: z.boolean(), requests: z.array(PublicContextRequestEvidenceSchema),
            snapshots: z.array(ContextSnapshotDetailSchema) }).strict()).safeParse(fact?.actual);
        if (original.complete && contexts.success && fact?.source.trim()) {
            let delivered = false, complete = fact.present && contexts.data.length > 0;
            for (const frame of contexts.data) {
                const run = original.runs.find(run => run.runId === frame.runId);
                if (!run?.scope || !frame.collected || !frame.requests.length) { complete = false; continue; }
                for (const request of frame.requests) {
                    const binding = request.binding;
                    const snapshot = frame.snapshots.find(detail => detail.snapshot.id === binding.snapshotId && detail.snapshot.runId === run.runId &&
                        detail.snapshot.sessionId === run.sessionId && detail.input.inputId === binding.inputId);
                    const observed = binding.runId === run.runId && binding.sessionId === run.sessionId && snapshot && request.sdkPayload?.inclusion === 'confirmed' &&
                        request.attempts.some(attempt => attempt.wireInclusion === 'confirmed' && attempt.enteredAt !== null);
                    if (!observed) { complete = false; continue; }
                    const projection = snapshot.snapshot.json.modelProjection;
                    delivered ||= projection.fragments.some(fragment => run.scope!.allowedDocumentIds.includes(fragment.documentRef.id) && fragment.windows.some(window => !!window.text.trim())) ||
                        !!projection.candidate?.values.some(item => item.value.sources.length > 0 && item.value.sources.every(source => run.scope!.allowedDocumentIds.includes(source.documentId)));
                    delivered ||= original.calls.some(call => original.authorized(call) && call.runId === run.runId && call.result?.status === 'succeeded' &&
                        call.delivery.state === 'request_observed' && call.delivery.includedInCallSequence === binding.callSequence &&
                        binding.includedToolResults.some(ref => ref.toolCallId === call.toolCallId && ref.originRunId === call.runId &&
                            ref.nativeToolCallId === call.nativeToolCallId && isDeepStrictEqual(ref.context, call.context)) &&
                        (typeof call.result.data === 'string' ? !!call.result.data.trim() : Array.isArray(call.result.data) ? call.result.data.length > 0 :
                            !!call.result.data && typeof call.result.data === 'object' && Object.keys(call.result.data).length > 0));
                }
            }
            ok = delivered ? true : complete ? false : undefined; actual = { delivered };
        }
    } else {
        const selectors = plan.evaluatorId === 'freshness-compliance' ? plan.params.values : plan.params.checks;
        const needsFailure=plan.evaluatorId==='partial-failure-honesty'||plan.evaluatorId==='failure-recovery';
        const faults=original.calls.filter(call=>call.status==='failed'||call.delivery.state==='failed'||
            call.runtimeObservation?.afterStructure==='invalid'||call.runtimeObservation?.afterDomain==='invalid');
        const outcomes = selectors.map(selector => {
            // An ordinal cannot be resolved through a partial or conflicting collection.
            if (!original.complete) return undefined;
            const call = original.calls.filter(call => call.toolName === selector.toolName)[selector.occurrence - 1];
            if (!call || !original.authorized(call)) return undefined;
            if(needsFailure&&!faults.some(fault=>fault.runId===call.runId&&fault.sessionId===call.sessionId&&fault.requestedAt<=call.requestedAt))return undefined;
            const value = field(call, selector.path);
            if (value === undefined) return undefined;
            if (plan.evaluatorId === 'freshness-compliance') {
                const parsed = z.string().datetime({ offset: true }).safeParse(value);
                if (!parsed.success) return undefined;
                const age = Date.parse(plan.params.referenceTime) - Date.parse(parsed.data);
                return age >= 0 && age <= plan.params.maxAgeMs;
            }
            return 'equals' in selector ? isDeepStrictEqual(value, selector.equals) : undefined;
        });
        numerator = outcomes.filter(value => value === true).length; denominator = selectors.length; missing = outcomes.filter(value => value === undefined).length;
        actual = outcomes; ok = outcomes.includes(false) ? false : outcomes.every(value => value === true) ? true : undefined;
    }
    const status: EvaluationScore['status'] = !result.started ? 'NOT_RUN' : ok === false ? 'FAIL' : unavailable ? 'NOT_APPLICABLE' :
        ok === true ? 'PASS' : result.error?.infrastructure ? 'ERROR' : 'UNJUDGEABLE';
    const hasCounts=numerator!==null||denominator!==null;
    const measured=hasCounts?numerator!==null&&denominator!==null&&denominator>0&&missing===0?numerator/denominator:null:
        status==='PASS'?1:status==='FAIL'?0:null;
    return { evaluatorId: id, evaluatorVersion: 1, category: 'diagnostic', applicabilityReason: plan.reason,
        metricId: `diagnostic-${id}`, name: namesById[id], version: 1, method: 'deterministic', required: plan.required,
        value: status === 'PASS' || status === 'FAIL' ? measured : null, status,
        reason: status === 'PASS' ? 'Verified original evidence satisfies the independent Case declaration' : status === 'FAIL' ? 'Verified original evidence violates the independent Case declaration' :
            status === 'NOT_APPLICABLE' ? 'No actual call opportunity; no perfect score is fabricated' : 'Necessary original evidence is unavailable or the Agent did not execute',
        evidence: sources, actual, expected: plan.params,
        ...(denominator !== null || numerator !== null ? { statistics: { unit: '检查机会', numerator, denominator, missing } } : {}) };
}
