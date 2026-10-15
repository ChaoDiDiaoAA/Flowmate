import { expect, test } from 'bun:test';
import { researchFixture, researchPlan, researchNeed as need } from '../../support/research.ts';
import { ToolEvidenceResultSchema, ToolCallSnapshotSchema } from '../../../packages/contracts/src/tool-evidence.ts';
import { waitFor } from '../../support/resources.ts';
import type { ToolEvidencePage } from '../../../packages/contracts/src/tool-evidence.ts';

test('the product public query pages original SQL tool facts, rejects ownership/version/boundary changes, and never reexecutes', async () => {
    const question = '汉'.repeat(400) + '😀';
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const f = await researchFixture((_request, index) => index === 1
        ? { tool: 'save_research_plan', args: { ...researchPlan, question }, id: 'original-plan' } : { text: 'Synthetic Plan saved.' }, undefined,
        { toolDefinitions: tools => tools.map(tool => tool.name === 'save_research_plan' ? { ...tool,
            execute: async (...args: Parameters<typeof tool.execute>) => { await held; return tool.execute(...args); } } : tool) });
    const run = await f.start(f.request(1)), runId = need(run.accepted).runId, sessionId = f.session.sessionId;
    let original!: ToolEvidencePage;
    try {
        await waitFor(async () => {
            const call = need(await f.app.listRunToolCalls({ runId, sessionId })).items.find(call => call.status === 'running');
            if (!call) return false;
            original = need(await f.app.queryRunToolEvidence({ runId, sessionId, toolCallId: call.toolCallId, limit: 512 }));
            return true;
        });
    } finally { release(); }
    await run.completion;
    const tool = need(await f.app.listRunToolCalls({ runId, sessionId })).items[0]!;
    const input = { runId, sessionId, toolCallId: tool.toolCallId, limit: 512 };
    const first = need(ToolEvidenceResultSchema.parse(await f.app.queryRunToolEvidence(input)));
    let text = first.chunk, offset = first.nextOffset;
    while (offset !== null) {
        const page = need(ToolEvidenceResultSchema.parse(await f.app.queryRunToolEvidence({ ...input, offset, expectedRevision: first.evidenceRevision })));
        expect(page.evidenceRevision).toBe(first.evidenceRevision); text += page.chunk; offset = page.nextOffset;
    }
    expect(Buffer.byteLength(text)).toBe(first.bytes);
    expect(ToolCallSnapshotSchema.parse(JSON.parse(text))).toMatchObject({ runId, sessionId, nativeToolCallId: 'original-plan',
        args: { raw: { question }, final: { question } }, result: { status: 'succeeded' }, delivery: { state: 'request_observed' } });
    const character = Buffer.from(text).indexOf(Buffer.from('汉'));
    expect(character).toBeGreaterThan(0);
    for (const invalid of [{ ...input, sessionId: 999 }, { ...input, expectedRevision: first.evidenceRevision + 1 },
        { ...input, offset: character + 1, expectedRevision: first.evidenceRevision }, { ...input, offset: 1 }, { ...input, limit: 1 }])
        expect(await f.app.queryRunToolEvidence(invalid)).toMatchObject({ ok: false });
    expect(await f.app.queryRunToolEvidence({ ...input, offset: original.nextOffset!, expectedRevision: original.evidenceRevision }))
        .toMatchObject({ ok: false, error: { code: 'state_conflict' } });
    expect(first.evidenceRevision).toBeGreaterThan(original.evidenceRevision);
    expect(ToolCallSnapshotSchema.parse(JSON.parse(text)).evidenceRevision).toBe(first.evidenceRevision);
    expect(need(await f.app.listRunToolCalls({ runId, sessionId })).items).toHaveLength(1);
    expect(f.requests).toHaveLength(2);
}, 30000);
