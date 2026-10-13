import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { HostClient } from '../../../apps/desktop/main/host-client.ts';
import { mkdtempSync } from '../../../tests/support/resources.ts';
import { REPO_ROOT, hash } from '../../src/dataset-loader/local.ts';
import { collectResearchEvidence } from '../../src/adapters/research-evidence.ts';
import { ResearchEvidenceRequestSchema, ResearchSourcesRequestSchema } from '../../../packages/contracts/src/research.ts';

test('research evidence uses the actual Host and querying never starts a Run', async () => {
    const client = new HostClient(), root = mkdtempSync(join(tmpdir(), 'eval-research-evidence-'));
    expect(await client.start(root, '0.1.0', REPO_ROOT)).toMatchObject({ ok: true });
    try {
        const created = await client.request({ type: 'create_session', input: { title: 'Evidence fixture' } }) as { ok: true; data: { sessionId: number } };
        const sessionId = created.data.sessionId;
        expect(await collectResearchEvidence(client, { sessionId })).toMatchObject({ present: true, actual: null });
        const material = await client.request({ type: 'import_research_material', input: { title: 'Synthetic local policy', format: 'text', text: 'Synthetic source, never formal Gold.' } }) as { ok: true; data: { artifactId: number } };
        await client.request({ type: 'create_research_task', input: { sessionId, title: 'Synthetic read-only evidence',
            sourcePolicy: { web: false, domains: [], artifactIds: [material.data.artifactId], documentIds: [] } } });
        const first = await collectResearchEvidence(client, { sessionId, pageSize: 1 });
        expect(first).toMatchObject({ present: true, actual: { plans: [], sources: [], claims: [], reports: [], sourceTexts: [], reportCount: 0 } });
        expect(await collectResearchEvidence(client, { sessionId, pageSize: 1 })).toEqual(first);
        expect(await client.request({ type: 'list_session_runs', input: { sessionId } })).toMatchObject({ ok: true, data: { items: [] } });
    } finally { expect(await client.close()).toMatchObject({ ok: true }); }
}, 30000);

function transport(overrides: { loop?: boolean; mismatch?: boolean; changedSource?: boolean } = {}) {
    const commands: Array<Parameters<HostClient['request']>[0]> = [];
    const text = 'a'.repeat(3999) + '😀' + 'b'.repeat(100), at = '2026-10-11T00:00:00.000Z';
    const task = { researchId: 1, sessionId: 2, title: 'Fixture', sourcePolicy: { web: false, domains: [], artifactIds: [3], documentIds: [] },
        status: 'planning', currentPlanId: null, planConfirmed: false, currentRunId: null, currentReportId: null, createdAt: at, updatedAt: at };
    const source = { sourceSnapshotId: 7, researchId: 1, runId: 4, toolCallId: 5, createdAt: at, kind: 'local', address: 'material:3', title: 'Fixture',
        artifactId: 3, documentId: null, fetchedAt: at, publishedAt: null, contentHash: hash(text), relativePath: 'artifacts/research/1/' + hash(text) + '.txt',
        bytes: Buffer.byteLength(text), characters: text.length, truncated: false };
    return { text, commands, host: { async request(command: Parameters<HostClient['request']>[0]) {
        commands.push(command);
        if (command.type === 'query_research_for_session') return { ok: true, data: { ...task, sessionId: overrides.mismatch ? 999 : 2 } };
        if (command.type === 'list_research_sources') return { ok: true, data: { items: ResearchSourcesRequestSchema.parse(command.input).beforeId ? [] : [source], nextBeforeId: overrides.loop ? 7 : null } };
        if (command.type === 'list_research_reports') return { ok: true, data: { items: [], nextBeforeId: null } };
        if (command.type === 'query_research_evidence') {
            const offset = ResearchEvidenceRequestSchema.parse(command.input).offset, end = offset === 0 ? 3999 : text.length;
            return { ok: true, data: { source: { ...source, contentHash: overrides.changedSource && offset ? 'a'.repeat(64) : source.contentHash },
                excerpt: { start: offset, end, quote: text.slice(offset, end) }, nextOffset: end === text.length ? null : end } };
        }
        throw new Error('Unexpected write/model command: ' + command.type);
    } } };
}

test('source continuation preserves UTF-16 boundaries and verifies complete text, hash and original Run identity', async () => {
    const f = transport(), evidence = await collectResearchEvidence(f.host, { sessionId: 2, pageSize: 1 });
    expect(evidence).toMatchObject({ present: true, actual: { sourceTexts: [{ sourceSnapshotId: 7, runId: 4, toolCallId: 5,
        text: f.text, acquisition: 'controller-query', modelUse: 'requires-original-tool-and-context-evidence' }], reportCount: 0 } });
    const reads = f.commands.filter(c => c.type === 'query_research_evidence');
    expect(reads.map(c => ResearchEvidenceRequestSchema.parse('input' in c ? c.input : null).offset)).toEqual([0, 3999]);
});

test('foreign identities, repeated page cursors and changing source snapshots leave an explicit evidence gap', async () => {
    for (const overrides of [{ mismatch: true }, { loop: true }, { changedSource: true }]) {
        const f = transport(overrides), evidence = await collectResearchEvidence(f.host, { sessionId: 2, pageSize: 1 });
        expect(evidence.present).toBe(false);
        expect(evidence.actual).toMatchObject({ gap: expect.any(String) });
    }
});
