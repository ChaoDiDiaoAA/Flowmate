import { z } from 'zod';
import { isDeepStrictEqual } from 'node:util';
import { ToolCallSnapshotSchema } from '../../../packages/contracts/src/tool-evidence.ts';
import { PublicContextRequestEvidenceSchema, ContextSnapshotDetailSchema } from '../../../packages/contracts/src/context.ts';
import { RunResourceViewSchema } from '../../../packages/contracts/src/resources.ts';
import type { CaseConstraints } from '../dataset-loader/authoring.ts';
import type { EvaluationContext, EvaluationScore } from './types.ts';
import { renderInlineUserInput } from '../inline-materials.ts';

/** Case constraints grade original Trial evidence; they never set product execution budgets. */
export function evaluateCaseConstraints({ task, result, projected: originalInput }: EvaluationContext): EvaluationScore[] {
    const expected = task.expected as typeof task.expected & Partial<CaseConstraints>;
    const scores: EvaluationScore[] = [];
    const fact = (key: string) => result.evidence[key];
    const runs = z.array(z.object({ runId: z.number().int().positive(), sessionId: z.number().int().positive() }).passthrough()).safeParse(fact('runs')?.actual);
    const collection = z.object({ calls: z.array(z.object({ tool: z.unknown(),  bytes: z.number().optional() }).passthrough()) }).passthrough().safeParse(fact('tool-evidence')?.actual);
    const tools = new Map<number, z.infer<typeof ToolCallSnapshotSchema>>();
    let valid = collection.success && runs.success;
    if (collection.success) for (const record of collection.data.calls) {
        const parsed = ToolCallSnapshotSchema.safeParse(record.tool);
        if (!parsed.success || record.bytes !== undefined && Buffer.byteLength(JSON.stringify(record.tool)) !== record.bytes ||
            !runs.success || !runs.data.some(r => r.runId === parsed.data.runId && r.sessionId === parsed.data.sessionId)) {
            valid = false; continue;
        }
        const prior = tools.get(parsed.data.toolCallId);
        if (prior && !isDeepStrictEqual(prior, parsed.data)) { valid = false; continue; }
        tools.set(parsed.data.toolCallId, parsed.data);
    }
    const calls = [...tools.values()];
    const complete = valid && !!fact('tool-evidence')?.present && !!fact('runs')?.present;
    const add = (metricId: string, name: string, ok: boolean | undefined, actual: unknown, wanted: unknown, evidence: string[]) => {
        const status = !result.started ? 'NOT_RUN' : ok === false ? 'FAIL' : ok === true ? 'PASS' : result.error?.infrastructure ? 'ERROR' : 'UNJUDGEABLE';
        scores.push({ metricId, name, version: 1, method: 'deterministic', required: true,
            value: status === 'PASS' ? 1 : status === 'FAIL' ? 0 : null, status,
            reason: status === 'PASS' ? '原始执行证据满足题目约束' : status === 'FAIL' ? '原始执行证据违反题目约束' : '必要执行证据不完整，不能推定通过',
            actual, expected: wanted, evidence });
    };
    if (expected.maxToolCalls !== undefined) add('case-max-tool-calls', '工具调用上限',
        calls.length > expected.maxToolCalls ? false : complete ? true : undefined, calls.length, expected.maxToolCalls, ['tool-evidence', 'runs']);
    if (expected.requiredCapabilities?.length) add('case-required-capabilities', '必要工具调用',
        expected.requiredCapabilities.every(name => calls.some(call => call.toolName === name)) ? true : complete && !result.error?.infrastructure ? false : undefined,
        [...new Set(calls.map(call => call.toolName))], expected.requiredCapabilities, ['tool-evidence', 'runs']);
    if (expected.forbiddenCapabilities?.length) add('case-forbidden-capabilities', '禁止工具请求',
        calls.some(call => expected.forbiddenCapabilities!.includes(call.toolName)) ? false : complete ? true : undefined,
        [...new Set(calls.map(call => call.toolName))], expected.forbiddenCapabilities, ['tool-evidence', 'runs']);

    const contexts = z.array(z.object({ runId: z.number(), collected: z.boolean(), requests: z.array(PublicContextRequestEvidenceSchema), snapshots: z.array(ContextSnapshotDetailSchema) }).strict()).safeParse(fact('context-requests')?.actual);
    if (expected.mustHaveEvidence) {
        const projected = fact('input-projection');
        const renderedInput = renderInlineUserInput(originalInput);
        const inline = z.object({ materials: z.array(z.object({ sample: z.string(), file: z.string(), text: z.string() }).strict()).min(1), renderedText: z.string(),
            delivery: z.object({ inputId: z.number().int().positive(), sessionId: z.number().int().positive(), runId: z.number().int().positive(),
                nativeEntryId: z.string().min(1), snapshotId: z.number().int().positive(), requestSequence: z.number().int().positive() }).strict().nullable() }).strict()
            .safeParse(fact('inline-materials')?.actual);
        const inlineDelivery = inline.success && fact('inline-materials')?.present && inline.data.materials.some(material => material.text.trim().length > 0) &&
            isDeepStrictEqual(inline.data.materials, originalInput.materials) && isDeepStrictEqual(result.input, originalInput) &&
            inline.data.renderedText === renderedInput ? inline.data.delivery : null;
        const delivered = contexts.success && contexts.data.some(frame => frame.requests.some(request => {
            if (request.sdkPayload?.inclusion !== 'confirmed' || !request.attempts.some(a => a.wireInclusion === 'confirmed' && a.enteredAt !== null)) return false;
            const snapshot = frame.snapshots.find(s => s.snapshot.id === request.binding.snapshotId && s.snapshot.runId === frame.runId && s.snapshot.sessionId === request.binding.sessionId);
            const projection = snapshot?.snapshot.json.modelProjection;
            if (inlineDelivery && inline.success && frame.runId === inlineDelivery.runId && request.binding.sessionId === inlineDelivery.sessionId &&
                request.binding.requestSequence === inlineDelivery.requestSequence && snapshot?.snapshot.id === inlineDelivery.snapshotId &&
                snapshot.snapshot.json.text === renderedInput && request.attempts.some(attempt => attempt.responseStatus !== null) &&
                request.binding.includedBindings.some(binding => binding.inputId === inlineDelivery.inputId && binding.originRunId === inlineDelivery.runId &&
                    binding.nativeEntryId === inlineDelivery.nativeEntryId && binding.snapshotId === inlineDelivery.snapshotId)) return true;
            return !!projection && (projection.fragments.some(f => f.windows.some(w => w.text.trim().length > 0)) || !!projection.candidate?.values.length) ||
                calls.some(call => {
                    const data=call.result?.status==='succeeded'?call.result.data:undefined;
                    const usable=typeof data==='string'?!!data.trim():Array.isArray(data)?data.length>0:data&&typeof data==='object'?Object.keys(data).length>0:data!==null&&data!==undefined;
                    return usable&&call.runId===frame.runId&&
                    call.delivery.state === 'request_observed' && request.binding.includedToolResults.some(ref => ref.toolCallId === call.toolCallId &&
                        ref.originRunId === call.runId && ref.nativeToolCallId === call.nativeToolCallId && isDeepStrictEqual(ref.context, call.context));
                });
        }));
        const knownAbsent = complete && !!projected?.present && contexts.success && !!fact('context-requests')?.present &&
            contexts.data.every(frame => frame.collected && frame.requests.every(request => request.sdkPayload?.inclusion === 'confirmed' &&
                request.transport === 'observed-fetch' && request.attempts.some(attempt => attempt.enteredAt !== null) &&
                request.attempts.every(attempt => attempt.wireInclusion === 'confirmed') &&
                frame.snapshots.some(snapshot => snapshot.snapshot.id === request.binding.snapshotId &&
                    snapshot.snapshot.runId === frame.runId && snapshot.snapshot.sessionId === request.binding.sessionId)));
        add('case-evidence-required', '实际送达的授权证据', delivered ? true : knownAbsent ? false : undefined,
            { delivered: delivered ? true : knownAbsent ? false : null }, true, ['context-requests', 'tool-evidence']);
    }

    if (expected.requiredSkills?.length || expected.forbiddenSkills?.length) {
        const resources = z.array(RunResourceViewSchema).safeParse(fact('resources')?.actual);
        const used = new Set<string>(), unknown = new Set<string>();
        if (resources.success) for (const run of resources.data) {
            for (const request of run.evidence?.requests ?? []) for (const check of request.contentChecks) {
                if (check.ref.kind === 'skill' && ['expanded-body', 'tool-output', 'derived-source'].includes(check.scope) &&
                    check.sdkInclusion !== 'not-included' && check.wireInclusion !== 'not-included' &&
                    (check.sdkInclusion === 'unknown' || check.wireInclusion === 'unknown')) unknown.add(check.ref.id);
                if (check.ref.kind === 'skill' && ['expanded-body', 'tool-output'].includes(check.scope) && check.sdkInclusion === 'confirmed' && check.wireInclusion === 'confirmed' &&
                    (run.evidence?.reads.some(read => read.ref.kind === 'skill' && read.ref.id === check.ref.id && read.requestSequence <= request.callSequence) ||
                        run.evidence?.expansions.some(expansion => expansion.skill.id === check.ref.id))) used.add(check.ref.id);
            }
        }
        const attempted = new Set(used);
        if (resources.success) for (const run of resources.data) {
            for (const expansion of run.evidence?.expansions ?? []) attempted.add(expansion.skill.id);
            for (const read of run.evidence?.reads ?? []) if (read.ref.kind === 'skill') attempted.add(read.ref.id);
        }
        for (const call of calls) {
            const args = z.object({ skill: z.string() }).passthrough().safeParse(call.args.raw);
            if (['read_skill_resource', 'list_skill_resources'].includes(call.toolName) && args.success) attempted.add(args.data.skill);
        }
        const resourceComplete = resources.success && !!fact('resources')?.present && resources.data.every(r => r.gap === null && r.evidence !== null) && complete &&
            (expected.maxToolCalls!==0||runs.success&&runs.data.some(r=>r.kind==='agent')&&
                runs.data.every(run=>resources.data.some(r=>r.runId===run.runId&&r.sessionId===run.sessionId))&&
                resources.data.every(r=>runs.data.some(run=>r.runId===run.runId&&r.sessionId===run.sessionId)));
        if (expected.requiredSkills?.length) add('fact-check/required-skills', '必要 Skill 的实际读取',
            expected.requiredSkills.every(skill => used.has(skill)) ? true : resourceComplete && !result.error?.infrastructure &&
                expected.requiredSkills.some(skill => !used.has(skill) && !unknown.has(skill)) ? false : undefined,
            [...used], expected.requiredSkills, ['resources', 'tool-evidence']);
        if (expected.forbiddenSkills?.length) add('fact-check/forbidden-skills', '禁止 Skill 的请求或读取',
            expected.forbiddenSkills.some(skill => attempted.has(skill)) ? false : resourceComplete &&
                expected.forbiddenSkills.every(skill => !unknown.has(skill)) ? true : undefined,
            [...attempted], expected.forbiddenSkills, ['resources', 'tool-evidence']);
    }
    if (expected.requiredSubagentRoles?.length) {
        const children = z.object({ children: z.array(z.object({ role: z.string(), childRunId: z.number().int().positive() }).passthrough()) }).passthrough().safeParse(fact('subagents')?.actual);
        const roles = children.success ? children.data.children.map(child => child.role) : [];
        add('fact-check/required-subagent-roles', '必要子 Agent 角色', expected.requiredSubagentRoles.every(role => roles.includes(role)) ? true :
            children.success && !!fact('subagents')?.present && !result.error?.infrastructure ? false : undefined, roles, expected.requiredSubagentRoles, ['subagents']);
    }
    return scores;
}
