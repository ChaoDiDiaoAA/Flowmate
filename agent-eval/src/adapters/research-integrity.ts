import { z } from 'zod';
import { isDeepStrictEqual } from 'node:util';
import { createHash } from 'node:crypto';
import { ClaimSchema, ResearchPlanSchema, ResearchReportSchema, SourceSnapshotSchema,
    ResearchLocatorSchema, EvidenceRefSchema, type ResearchSourcePolicy } from '../../../packages/contracts/src/research.ts';
import { ToolCallSnapshotSchema } from '../../../packages/contracts/src/tool-evidence.ts';
import { collectedResearchSchema } from './research-evidence.ts';
import { hash } from '../dataset-loader/local.ts';
import type { CaseExecutionResult, EvidenceFact } from '../types.ts';

type Issue = { kind: string; id: number | null; code: string; severity: 'invalid' | 'unknown'; evidenceIndex?: number };
const id = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const runsSchema = z.array(z.object({ runId: id, sessionId: id, kind: z.enum(['agent', 'subagent']) }).passthrough());
const toolsSchema = z.object({ calls: z.array(z.object({ tool: ToolCallSnapshotSchema }).passthrough()) }).passthrough();
const registrationSchema = z.array(z.object({ artifactId: id, sample: z.string().min(1), file: z.string().min(1),
    sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict());
const sourceReadSchema = z.object({ source: SourceSnapshotSchema, excerpt: ResearchLocatorSchema,
    evidenceRef: EvidenceRefSchema.nullable().optional(),
    usage: z.object({ requestId: z.string().max(256).nullable(), credits: z.number().finite().nonnegative().nullable() }).strict() }).strict();
const splitsPair = (text: string, at: number) => at > 0 && at < text.length &&
    /[\uD800-\uDBFF]/.test(text[at - 1]!) && /[\uDC00-\uDFFF]/.test(text[at]!);
const allowed = (source: z.infer<typeof SourceSnapshotSchema>, policy: ResearchSourcePolicy) => source.kind === 'local'
    ? policy.artifactIds.includes(source.artifactId!) : policy.documentIds.includes(source.documentId!);

/** Independent structural facts only; product supported/full flags never establish semantic correctness. */
export function inspectResearchEvidence(evidence: EvidenceFact, proof: { runs: EvidenceFact; tools: EvidenceFact;
    registration: EvidenceFact; input: CaseExecutionResult['input'] }): EvidenceFact {
    const issues: Issue[] = [], links: Array<{ claimId: number; evidenceIndex: number; sourceSnapshotId: number; valid: boolean | null }> = [];
    const origins: Array<{ kind: string; id: number; runId: number; toolCallId: number; delivery: string | null }> = [];
    const sourceBindings: Array<{ sourceSnapshotId: number; sample: string; file: string }> = [];
    const reports: Array<{ reportId: number; claimIds: number[] }> = [];
    const actual = { contract: 'flowmate-research-integrity/v1', valid: null as boolean | null,
        semanticStatus: 'not-assessed', issues, origins, sourceBindings, links, reports };
    const add = (kind: string, recordId: number | null, code: string, severity: Issue['severity'] = 'invalid', evidenceIndex?: number) =>
        issues.push({ kind, id: recordId, code, severity, ...(evidenceIndex === undefined ? {} : { evidenceIndex }) });
    const source = 'Independent source/locator/Plan/dependency checks against original Host records, declared input and ToolCall receipts; no semantic score';
    const parsed = collectedResearchSchema.safeParse(evidence.actual), runs = runsSchema.safeParse(proof.runs.actual),
        tools = toolsSchema.safeParse(proof.tools.actual), registration = registrationSchema.safeParse(proof.registration.actual);
    for (const [name, fact, valid] of [['research', evidence, parsed.success || evidence.actual === null], ['runs', proof.runs, runs.success],
        ['tools', proof.tools, tools.success], ['registration', proof.registration, registration.success]] as const)
        if (!fact.present || !valid || !fact.source.trim()) add('collection', null, name + '-unavailable', 'unknown');
    if (evidence.actual === null) {
        add('collection', null, 'missing-task', evidence.present && evidence.source.trim() ? 'invalid' : 'unknown');
        actual.valid = issues.some(i => i.severity === 'invalid') ? false : null;
        return { present: !issues.some(i => i.severity === 'unknown'), actual, source };
    }
    if (!parsed.success) return { present: false, actual, source };
    const data = parsed.data, task = data.task;
    if (data.gap !== undefined) add('collection', null, 'research-unavailable', 'unknown');
    const missing: Issue['severity'] = evidence.present && evidence.source.trim() && data.gap === undefined ? 'invalid' : 'unknown';
    if (!task) {
        add('collection', null, 'missing-task', missing);
    } else {
        const unique = <T>(items: T[], key: (item: T) => number, kind: string) => {
            const map = new Map<number, T>();
            for (const item of items) { if (map.has(key(item))) add(kind, key(item), 'duplicate-identity'); else map.set(key(item), item); }
            return map;
        };
        const plans = unique(data.plans, p => p.planId, 'plan'), sources = unique(data.sources, s => s.sourceSnapshotId, 'source'),
            claims = unique(data.claims, c => c.claimId, 'claim'), bodies = unique(data.sourceTexts, s => s.sourceSnapshotId, 'source-body'),
            reportMap = unique(data.reports, r => r.reportId, 'report'), ownedRuns = unique(runs.success ? runs.data : [], r => r.runId, 'run'),
            calls = unique(tools.success ? tools.data.calls.map(c => c.tool) : [], c => c.toolCallId, 'tool');
        const origin = <T extends { runId: number; toolCallId: number }>(kind: string, recordId: number, record: T,
            name: string, schema: z.ZodTypeAny, stored: unknown, args?: unknown) => {
            const run = ownedRuns.get(record.runId), call = calls.get(record.toolCallId);
            origins.push({ kind, id: recordId, runId: record.runId, toolCallId: record.toolCallId, delivery: call?.delivery.state ?? null });
            if (!run) add(kind, recordId, 'origin-run', runs.success && proof.runs.present && proof.runs.source.trim() ? 'invalid' : 'unknown');
            else if (kind !== 'source' && (run.kind !== 'agent' || run.sessionId !== task.sessionId)) add(kind, recordId, 'origin-run');
            if (!call) { add(kind, recordId, 'origin-tool', tools.success && proof.tools.present && proof.tools.source.trim() ? 'invalid' : 'unknown'); return; }
            if (call.runId !== record.runId || run && call.sessionId !== run.sessionId ||
                call.toolName !== name || call.result?.status !== 'succeeded') {
                add(kind, recordId, 'origin-tool'); return;
            }
            const envelope = kind === 'source' ? sourceReadSchema.safeParse(call.result.data) : null;
            const result = schema.safeParse(envelope?.success ? envelope.data.source : call.result.data);
            if (!result.success || !isDeepStrictEqual(result.data, stored) || args !== undefined && !isDeepStrictEqual(call.args.final, args))
                add(kind, recordId, 'origin-receipt');
        };
        if (data.reportCount !== data.reports.length) add('collection', null, 'report-count');
        if (data.sourceTexts.length < sources.size) add('collection', null, 'source-text-enumeration', 'unknown');
        if (data.sourceTexts.some(body => !sources.has(body.sourceSnapshotId))) add('collection', null, 'source-body-unowned', missing);
        if (new Set(data.discoveredPlanIds).size !== data.discoveredPlanIds.length || data.plans.some(plan => !data.discoveredPlanIds.includes(plan.planId)))
            add('collection', null, 'plan-enumeration');
        if (data.discoveredPlanIds.some(planId => !plans.has(planId))) add('collection', null, 'plan-enumeration', missing);
        if (task.currentPlanId !== null && !plans.has(task.currentPlanId)) add('collection', null, 'current-plan', missing);
        if (task.currentReportId !== null && !reportMap.has(task.currentReportId)) add('collection', null, 'current-report', missing);
        for (const plan of data.plans) {
            if (plan.researchId !== task.researchId || !plan.body.sourcePolicy.artifactIds.every(value => task.sourcePolicy.artifactIds.includes(value)) ||
                !plan.body.sourcePolicy.documentIds.every(value => task.sourcePolicy.documentIds.includes(value))) add('plan', plan.planId, 'plan-scope');
            origin('plan', plan.planId, plan, 'save_research_plan', ResearchPlanSchema, plan, plan.body);
        }
        for (const snapshot of data.sources) {
            const body = bodies.get(snapshot.sourceSnapshotId);
            if (snapshot.researchId !== task.researchId || !allowed(snapshot, task.sourcePolicy)) add('source', snapshot.sourceSnapshotId, 'source-scope');
            if (snapshot.address !== (snapshot.kind === 'local' ? 'artifact:' + snapshot.artifactId : 'document:' + snapshot.documentId) ||
                snapshot.relativePath !== `artifacts/research/${task.researchId}/${snapshot.contentHash}.txt`) add('source', snapshot.sourceSnapshotId, 'source-address');
            if (!body) add('source', snapshot.sourceSnapshotId, 'source-text-unavailable', 'unknown');
            else if (body.runId !== snapshot.runId || body.toolCallId !== snapshot.toolCallId || hash(body.text) !== snapshot.contentHash ||
                body.text.length !== snapshot.characters || Buffer.byteLength(body.text) !== snapshot.bytes) add('source', snapshot.sourceSnapshotId, 'source-body');
            if (snapshot.kind === 'local' && registration.success) {
                const matches = registration.data.filter(m => m.artifactId === snapshot.artifactId);
                const material = matches.length === 1 ? proof.input.materials.filter(m => m.sample === matches[0]!.sample && m.file === matches[0]!.file) : [];
                if (!matches.length) add('source', snapshot.sourceSnapshotId, 'source-material', proof.registration.present && proof.registration.source.trim() ? 'invalid' : 'unknown');
                else if (material.length !== 1 || createHash('sha256').update(material[0]!.text, 'utf8').digest('hex') !== matches[0]!.sha256 ||
                    snapshot.contentHash !== hash(material[0]!.text) || snapshot.bytes !== Buffer.byteLength(material[0]!.text) ||
                    snapshot.characters !== material[0]!.text.length || snapshot.truncated ||
                    body && material[0]!.text !== body.text) add('source', snapshot.sourceSnapshotId, 'source-material');
                else if (body) sourceBindings.push({ sourceSnapshotId: snapshot.sourceSnapshotId, sample: material[0]!.sample, file: material[0]!.file });
            }
            const call = calls.get(snapshot.toolCallId), observed = sourceReadSchema.safeParse(call?.result?.status === 'succeeded' ? call.result.data : null);
            origin('source', snapshot.sourceSnapshotId, snapshot, 'read_research_local', SourceSnapshotSchema, snapshot,
                { artifactId: snapshot.kind === 'local' ? snapshot.artifactId : null, documentId: snapshot.documentId });
            if (observed.success && body) {
                let end = Math.min(4000, body.text.length); if (splitsPair(body.text, end)) end--;
                if (observed.data.excerpt.start !== 0 || observed.data.excerpt.end !== end ||
                    body.text.slice(0, end) !== observed.data.excerpt.quote) add('source', snapshot.sourceSnapshotId, 'source-read-quote');
            }
        }
        for (const claim of data.claims) {
            const plan = plans.get(claim.planId);
            if (!plan) add('claim', claim.claimId, 'claim-plan', missing);
            if (claim.researchId !== task.researchId || plan && (plan.revision !== claim.revision ||
                !plan.body.dimensions.some(d => d.questions.some(q => q.id === claim.questionId)))) add('claim', claim.claimId, 'claim-plan');
            const { claimId, researchId, planId, revision, runId, toolCallId, createdAt, ...body } = claim;
            origin('claim', claim.claimId, claim, 'save_research_claim', ClaimSchema, claim, body);
            for (const dependencyId of claim.dependencies) {
                const dependency = claims.get(dependencyId);
                if (!dependency) add('claim', claim.claimId, 'claim-dependency', missing);
                else if (dependency.planId !== claim.planId || dependency.revision !== claim.revision) add('claim', claim.claimId, 'claim-dependency');
                if (dependencyId >= claim.claimId) add('claim', claim.claimId, 'claim-dependency-order');
            }
            claim.evidence.forEach(({ ref }, evidenceIndex) => {
                const count = issues.length, snapshot = sources.get(ref.sourceSnapshotId), body = bodies.get(ref.sourceSnapshotId);
                if (!snapshot) add('claim', claim.claimId, 'reference-origin', missing, evidenceIndex);
                if (ref.researchId !== claim.researchId || ref.planId !== claim.planId || ref.revision !== claim.revision || snapshot && (
                    ref.runId !== snapshot.runId || ref.toolCallId !== snapshot.toolCallId || plan && !allowed(snapshot, plan.body.sourcePolicy)))
                    add('claim', claim.claimId, 'reference-origin', 'invalid', evidenceIndex);
                if (snapshot && ref.locator.end > snapshot.characters) add('claim', claim.claimId, 'reference-quote', 'invalid', evidenceIndex);
                if (body) {
                    if (body.text.slice(ref.locator.start, ref.locator.end) !== ref.locator.quote)
                        add('claim', claim.claimId, 'reference-quote', 'invalid', evidenceIndex);
                    if (splitsPair(body.text, ref.locator.start) || splitsPair(body.text, ref.locator.end)) add('claim', claim.claimId, 'reference-boundary', 'invalid', evidenceIndex);
                } else add('claim', claim.claimId, 'reference-text-unavailable', 'unknown', evidenceIndex);
                const own = [...issues.slice(count), ...issues.filter(i => i.kind === 'source' && i.id === ref.sourceSnapshotId ||
                    i.kind === 'collection' && i.severity === 'unknown' || i.kind === 'claim' && i.id === claim.claimId &&
                    ['claim-plan', 'origin-run', 'origin-tool', 'origin-receipt', 'origin-run-unavailable', 'origin-tool-unavailable'].includes(i.code))];
                links.push({ claimId: claim.claimId, evidenceIndex, sourceSnapshotId: ref.sourceSnapshotId,
                    valid: own.some(i => i.severity === 'invalid') ? false : own.length ? null : true });
            });
        }
        for (const report of data.reports) {
            const plan = plans.get(report.planId);
            if (!plan) add('report', report.reportId, 'report-plan', missing);
            if (report.researchId !== task.researchId || plan && plan.revision !== report.revision) add('report', report.reportId, 'report-plan');
            const questions = plan?.body.dimensions.flatMap(d => d.questions.map(q => q.id));
            if (questions && (report.coverage.length !== questions.length || report.coverage.some(row => !questions.includes(row.questionId) ||
                row.claimIds.some(claimId => claims.has(claimId) && claims.get(claimId)!.questionId !== row.questionId)))) add('report', report.reportId, 'report-coverage');
            const { reportId, researchId, planId, revision, runId, toolCallId, createdAt, ...body } = report;
            origin('report', report.reportId, report, 'save_research_report', ResearchReportSchema, report, body);
            const pending = [...report.sections.flatMap(s => s.claimIds), ...report.coverage.flatMap(c => c.claimIds)], seen = new Set<number>();
            while (pending.length) {
                const claimId = pending.pop()!; if (seen.has(claimId)) continue; seen.add(claimId);
                const claim = claims.get(claimId);
                if (!claim) add('report', report.reportId, 'report-claim', missing);
                else if (claim.planId !== report.planId || claim.revision !== report.revision) add('report', report.reportId, 'report-claim');
                else pending.push(...claim.dependencies);
            }
            reports.push({ reportId: report.reportId, claimIds: [...seen].sort((a, b) => a - b) });
        }
    }
    actual.valid = issues.some(i => i.severity === 'invalid') ? false : issues.length ? null : true;
    return { present: !issues.some(i => i.severity === 'unknown'), actual, source };
}
