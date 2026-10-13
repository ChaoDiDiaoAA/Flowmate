import { expect, test } from 'bun:test';
import { hash } from '../../src/dataset-loader/local.ts';
import { createHash } from 'node:crypto';
import { inspectResearchEvidence } from '../../src/adapters/research-integrity.ts';
import type { EvidenceFact } from '../../src/types.ts';
import type { ToolCallSnapshot } from '../../../packages/contracts/src/activity.ts';
import { researchPlan } from '../../../tests/support/research.ts';

function fixture() {
    const at = '2026-10-11T00:00:00.000Z', text = '甲公司😀持有乙公司。乙公司适用规则丙。';
    const policy = { web: false, domains: [], artifactIds: [3], documentIds: [] };
    const plan = { planId: 10, researchId: 1, revision: 1, runId: 4, toolCallId: 20,
        body: { ...structuredClone(researchPlan), sourcePolicy: policy }, createdAt: at };
    const source = { sourceSnapshotId: 7, researchId: 1, runId: 5, toolCallId: 21, createdAt: at, kind: 'local', address: 'artifact:3', title: 'Synthetic',
        artifactId: 3, documentId: null, fetchedAt: at, publishedAt: null, contentHash: hash(text), relativePath: 'artifacts/research/1/' + hash(text) + '.txt',
        bytes: Buffer.byteLength(text), characters: text.length, truncated: false };
    const ref = { researchId: 1, planId: 10, revision: 1, runId: 5, toolCallId: 21, sourceSnapshotId: 7,
        locator: { start: 0, end: text.length, quote: text } };
    const claim = { claimId: 30, researchId: 1, planId: 10, revision: 1, runId: 4, toolCallId: 22, createdAt: at,
        questionId: 'cost-1', text: '甲公司适用规则丙。', dependencies: [] as number[], evidence: [{ relation: 'supports', ref }],
        verification: { status: 'supported', reasons: ['Product judgment is not independent truth.'] } };
    const report = { reportId: 40, researchId: 1, planId: 10, revision: 1, runId: 4, toolCallId: 23, createdAt: at,
        answer: claim.text, sections: [{ title: 'Result', text: claim.text + ' 未登记的新事实也须后续语义核验。', claimIds: [30] }],
        completeness: 'full', conflicts: [], limitations: [], unresolvedQuestions: [],
        coverage: [{ questionId: 'cost-1', claimIds: [30], status: 'covered', reason: 'Product coverage is not Gold.' }] };
    const tool = (toolCallId: number, runId: number, sessionId: number, toolName: string, args: object, data: object): ToolCallSnapshot => ({
        toolCallId, runId, sessionId, nativeToolCallId: 'synthetic-' + toolCallId, context: null, toolName, toolVersion: 'p15-v1',
        effect: toolName === 'read_research_local' ? 'READ' : 'LOCAL_WRITE', status: 'succeeded', args: { version: 1, raw: structuredClone(args), final: structuredClone(args) },
        result: { version: 1, status: 'succeeded', committedCandidateId: null, data: structuredClone(data) },
        delivery: { version: 1, state: 'request_observed', messageObservedAt: at, includedInCallSequence: 2, requestDispatchedAt: at, error: null },
        cleanup: { version: 1, stopReason: null, stopped: true, errors: [] }, requestedAt: at, startedAt: at, endedAt: at, stoppedAt: at
    });
    const { claimId, researchId, planId, revision, runId, toolCallId, createdAt, ...claimBody } = claim;
    const { reportId, researchId: reportResearch, planId: reportPlan, revision: reportRevision, runId: reportRun, toolCallId: reportTool, createdAt: reportAt, ...reportBody } = report;
    const fact = (actual: unknown): EvidenceFact => ({ present: true, actual, source: 'synthetic original public evidence' });
    const evidence = fact({ task: { researchId: 1, sessionId: 2, title: 'Synthetic', sourcePolicy: policy, status: 'completed', currentPlanId: 10,
        planConfirmed: true, currentRunId: 4, currentReportId: 40, createdAt: at, updatedAt: at }, plans: [plan], discoveredPlanIds: [10], sources: [source],
        sourceTexts: [{ sourceSnapshotId: 7, runId: 5, toolCallId: 21, text, acquisition: 'controller-query', modelUse: 'requires-original-tool-and-context-evidence' }],
        claims: [claim], reports: [report], reportCount: 1 });
    const tools = fact({ calls: [tool(20, 4, 2, 'save_research_plan', plan.body, plan),
        tool(21, 5, 6, 'read_research_local', { artifactId: 3, documentId: null }, { source, excerpt: ref.locator, usage: { requestId: null, credits: null } }),
        tool(22, 4, 2, 'save_research_claim', claimBody, claim), tool(23, 4, 2, 'save_research_report', reportBody, report)].map(tool => ({ tool })) });
    const runs = fact([{ runId: 4, sessionId: 2, kind: 'agent' }, { runId: 5, sessionId: 6, kind: 'subagent', parentRunId: 4 }]);
    const registration = fact([{ artifactId: 3, sample: 'synthetic', file: 'policy.md', sha256: createHash('sha256').update(text).digest('hex') }]);
    const input = { prompt: 'Synthetic research', materials: [{ sample: 'synthetic', file: 'policy.md', text }] };
    return { evidence, tools, runs, registration, input, plan, source, claim, report, text };
}
function inspect(f: ReturnType<typeof fixture>) { return inspectResearchEvidence(f.evidence, f); }
function issues(f: ReturnType<typeof fixture>) {
    const result = inspect(f);
    return { result, codes: (result.actual as { issues: Array<{ code: string }> }).issues.map(issue => issue.code) };
}

test('independent research structure binds child source receipts, exact declared text and immutable root saves without asserting semantic truth', () => {
    const f = fixture(), result = inspect(f);
    expect(result).toMatchObject({ present: true, actual: { contract: 'flowmate-research-integrity/v1', valid: true,
        reports: [{ reportId: 40, claimIds: [30] }], links: [{ claimId: 30, evidenceIndex: 0, valid: true }],
        sourceBindings: [{ sourceSnapshotId: 7, sample: 'synthetic', file: 'policy.md' }], semanticStatus: 'not-assessed' } });
    expect((result.actual as { issues: unknown[] }).issues).toEqual([]);
    expect(JSON.stringify(result.actual)).not.toContain('Claim Precision');
});

test('source identity, declared bytes, quote offsets and surrogate boundaries are checked independently of supported/full', () => {
    for (const [change, expected] of [
        [(f: ReturnType<typeof fixture>) => { f.claim.evidence[0]!.ref.runId = 999; }, 'reference-origin'],
        [(f: ReturnType<typeof fixture>) => { f.claim.evidence[0]!.ref.locator.quote = '错'.repeat(f.text.length); }, 'reference-quote'],
        [(f: ReturnType<typeof fixture>) => { Object.assign(f.claim.evidence[0]!.ref.locator, { start: 4, end: 5, quote: f.text.slice(4, 5) }); }, 'reference-boundary'],
        [(f: ReturnType<typeof fixture>) => { f.source.address = 'artifact:999'; }, 'source-address'],
        [(f: ReturnType<typeof fixture>) => { (f.registration.actual as Array<{ sha256: string }>)[0]!.sha256 = 'c'.repeat(64); }, 'source-material'],
        [(f: ReturnType<typeof fixture>) => { f.input.materials[0]!.text = 'changed declared text'; }, 'source-material'],
        [(f: ReturnType<typeof fixture>) => { f.source.contentHash = 'b'.repeat(64); }, 'source-body']
    ] as const) {
        const f = fixture(); change(f);
        const output = issues(f);
        expect(output.result).toMatchObject({ present: true, actual: { valid: false, semanticStatus: 'not-assessed' } });
        expect(output.codes).toContain(expected);
    }
});

test('foreign/missing dependencies, cycles, report Plan versions and missing immutable tool receipts retain explicit failures', () => {
    for (const [change, expected] of [
        [(f: ReturnType<typeof fixture>) => { f.claim.dependencies = [999]; }, 'claim-dependency'],
        [(f: ReturnType<typeof fixture>) => { f.claim.dependencies = [30]; }, 'claim-dependency-order'],
        [(f: ReturnType<typeof fixture>) => { f.report.revision = 2; }, 'report-plan'],
        [(f: ReturnType<typeof fixture>) => { f.report.sections[0]!.claimIds = [999]; }, 'report-claim'],
        [(f: ReturnType<typeof fixture>) => { f.report.coverage[0]!.questionId = 'unplanned-question'; }, 'report-coverage'],
        [(f: ReturnType<typeof fixture>) => { (f.tools.actual as { calls: unknown[] }).calls.pop(); }, 'origin-tool'],
        [(f: ReturnType<typeof fixture>) => { (f.runs.actual as Array<{ sessionId: number }>)[0]!.sessionId = 999; }, 'origin-run']
    ] as const) {
        const f = fixture(); change(f);
        expect(issues(f).codes).toContain(expected);
        expect(inspect(f)).toMatchObject({ present: true, actual: { valid: false } });
    }
});

test('an acquisition gap stays unknown and cannot erase a separately known invalid reference', () => {
    const f = fixture(); f.tools.present = false;
    expect(inspect(f)).toMatchObject({ present: false, actual: { valid: null } });
    f.claim.evidence[0]!.ref.runId = 999;
    expect(inspect(f)).toMatchObject({ present: false, actual: { valid: false, links: [{ valid: false }] } });
    const partial = fixture(); partial.evidence.present = false;
    Object.assign(partial.evidence.actual!, { sourceTexts: [], gap: 'Original source body is unavailable.' });
    expect(inspect(partial)).toMatchObject({ present: false, actual: { valid: null, links: [{ valid: null }] } });
    partial.claim.evidence[0]!.ref.revision = 2;
    expect(inspect(partial)).toMatchObject({ present: false, actual: { valid: false, links: [{ valid: false }] } });
});

test('missing paged records remain unknown when acquisition stopped, while observed contradictions remain invalid', () => {
    const f = fixture(); f.evidence.present = false;
    Object.assign(f.evidence.actual!, { plans: [], claims: [], gap: 'Plan query failed after the report page was collected.' });
    expect(inspect(f)).toMatchObject({ present: false, actual: { valid: null } });
    const broken = fixture(); broken.tools.present = false;
    (broken.tools.actual as { calls: Array<{ tool: ToolCallSnapshot }> }).calls[1]!.tool.toolName = 'different-original-tool';
    expect(inspect(broken)).toMatchObject({ present: false, actual: { valid: false, links: [{ valid: false }] } });
    const receipt = fixture(); receipt.tools.present = false;
    (receipt.tools.actual as { calls: Array<{ tool: ToolCallSnapshot }> }).calls[2]!.tool.args.final = {};
    expect(issues(receipt).codes).toContain('origin-receipt');
    expect(inspect(receipt)).toMatchObject({ present: false, actual: { valid: false } });
});

test('a confirmed missing research task is a known absent endpoint, not a valid empty graph', () => {
    const f = fixture(); f.evidence.actual = null;
    expect(inspect(f)).toMatchObject({ present: true, actual: { valid: false } });
    Object.assign(f, { evidence: { present: true, source: 'confirmed empty research', actual: { task: null, plans: [], discoveredPlanIds: [],
        sources: [], claims: [], reports: [], sourceTexts: [], reportCount: 0 } } });
    expect(inspect(f)).toMatchObject({ present: true, actual: { valid: false } });
    f.evidence.present = false;
    expect(inspect(f)).toMatchObject({ present: false, actual: { valid: null } });
});

test('missing identities and explicit collection gaps are unknown, but observed Run and material contradictions survive partial collections', () => {
    for (const change of [
        (f: ReturnType<typeof fixture>) => { f.evidence.present = false; Object.assign(f.evidence.actual!, { sources: [], sourceTexts: [] }); },
        (f: ReturnType<typeof fixture>) => { f.evidence.present = false; Object.assign(f.evidence.actual!, { reports: [], reportCount: 0 }); },
        (f: ReturnType<typeof fixture>) => { f.tools.present = false; (f.tools.actual as { calls: unknown[] }).calls.pop(); },
        (f: ReturnType<typeof fixture>) => { f.runs.present = false; f.runs.actual = []; },
        (f: ReturnType<typeof fixture>) => { f.registration.present = false; f.registration.actual = []; },
        (f: ReturnType<typeof fixture>) => { Object.assign(f.evidence.actual!, { gap: 'Caller left present=true despite a collection failure.' }); }
    ]) {
        const f = fixture(); change(f);
        expect(inspect(f)).toMatchObject({ present: false, actual: { valid: null } });
    }
    const run = fixture(); run.runs.present = false;
    (run.runs.actual as Array<{ sessionId: number }>)[0]!.sessionId = 999;
    expect(inspect(run)).toMatchObject({ present: false, actual: { valid: false } });
    const material = fixture(); material.registration.present = false;
    (material.registration.actual as Array<{ sha256: string }>)[0]!.sha256 = 'd'.repeat(64);
    expect(inspect(material)).toMatchObject({ present: false, actual: { valid: false, links: [{ valid: false }] } });
});

test('a report records the complete two-hop claim dependency closure from original save receipts', () => {
    const f = fixture(), calls = (f.tools.actual as { calls: Array<{ tool: ToolCallSnapshot }> }).calls;
    const premise = { ...structuredClone(f.claim), claimId: 29, toolCallId: 24, text: '甲公司持有乙公司。' };
    f.claim.dependencies = [29];
    (f.evidence.actual as { claims: typeof f.claim[] }).claims.push(premise);
    calls[2]!.tool.result = { ...calls[2]!.tool.result!, data: structuredClone(f.claim) };
    (calls[2]!.tool.args.final as { dependencies: number[] }).dependencies = [29];
    const saved = structuredClone(calls[2]!.tool);
    Object.assign(saved, { toolCallId: 24, nativeToolCallId: 'synthetic-24', result: { ...saved.result!, data: premise } });
    Object.assign(saved.args.final as object, { text: premise.text, dependencies: [] });
    calls.push({ tool: saved });
    expect(inspect(f)).toMatchObject({ present: true, actual: { valid: true, reports: [{ reportId: 40, claimIds: [29, 30] }] } });
});

test('a missing controller body cannot hide source metadata or citation bounds contradicted by acquired declared evidence', () => {
    for (const change of [
        (f: ReturnType<typeof fixture>) => { f.source.contentHash = 'e'.repeat(64); f.source.relativePath = 'artifacts/research/1/' + f.source.contentHash + '.txt'; },
        (f: ReturnType<typeof fixture>) => { f.source.bytes++; },
        (f: ReturnType<typeof fixture>) => { f.source.characters++; }
    ]) {
        const f = fixture(); f.evidence.present = false; Object.assign(f.evidence.actual!, { sourceTexts: [] }); change(f);
        const call = (f.tools.actual as { calls: Array<{ tool: ToolCallSnapshot }> }).calls[1]!.tool;
        (call.result!.data as { source: typeof f.source }).source = structuredClone(f.source);
        expect(issues(f).codes).toContain('source-material');
        expect(inspect(f)).toMatchObject({ present: false, actual: { valid: false, links: [{ valid: false }] } });
    }
    const f = fixture(); f.evidence.present = false; Object.assign(f.evidence.actual!, { sourceTexts: [] });
    const locator = f.claim.evidence[0]!.ref.locator; locator.end++; locator.quote += '外';
    const call = (f.tools.actual as { calls: Array<{ tool: ToolCallSnapshot }> }).calls[2]!.tool;
    call.result = { ...call.result!, data: structuredClone(f.claim) };
    (call.args.final as { evidence: typeof f.claim.evidence }).evidence = structuredClone(f.claim.evidence);
    expect(issues(f).codes).toContain('reference-quote');
    expect(inspect(f)).toMatchObject({ present: false, actual: { valid: false, links: [{ valid: false }] } });
});

test('controller queries and absent next-request delivery never become proof of model source adoption', () => {
    const f = fixture(), calls = (f.tools.actual as { calls: Array<{ tool: ToolCallSnapshot }> }).calls;
    calls[1]!.tool.delivery = { version: 1, state: 'not_attempted', messageObservedAt: null, includedInCallSequence: null, requestDispatchedAt: null, error: null };
    const result = inspect(f);
    expect(result).toMatchObject({ present: true, actual: { valid: true, semanticStatus: 'not-assessed' } });
    expect((result.actual as { origins: Array<{ kind: string; delivery: string }> }).origins.find(o => o.kind === 'source'))
        .toMatchObject({ kind: 'source', id: 7, delivery: 'not_attempted' });
});
