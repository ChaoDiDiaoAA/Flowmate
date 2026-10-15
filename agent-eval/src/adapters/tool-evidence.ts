import type { HostClient } from '../../../apps/desktop/main/host-client.ts';
import { ToolEvidenceRequestSchema, ToolEvidenceResultSchema, ToolCallSnapshotSchema,
    type ToolEvidencePage } from '../../../packages/contracts/src/tool-evidence.ts';
import type { ToolCallSnapshot } from '../../../packages/contracts/src/activity.ts';
import type { RuntimeToolView } from '../../../packages/contracts/src/events.ts';
import type { EvidenceFact } from '../types.ts';

/** Stored raw arguments/results are read through the sole DB owner, never reconstructed from UI previews. */
export async function collectToolEvidence(host: Pick<HostClient, 'request'>,
    tools: ReadonlyArray<Pick<RuntimeToolView, 'runId' | 'sessionId' | 'toolCallId' | 'toolName'>>, pageSize = 8192): Promise<EvidenceFact> {
    const actual: { calls: Array<{ bytes: number; tool: ToolCallSnapshot }>; gap?: string;
        acquisition: 'controller-query'; modelUse: 'requires-original-delivery-and-context-evidence' } = { calls: [],
            acquisition: 'controller-query', modelUse: 'requires-original-delivery-and-context-evidence' };
    const source = 'Host original original ToolCall snapshots: raw/final arguments, result, commit, delivery and cleanup';
    try {
        const seen = new Set<number>();
        for (const identity of tools) {
            if (seen.has(identity.toolCallId)) throw new Error('Repeated original ToolCall identity');
            seen.add(identity.toolCallId);
            const base = { runId: identity.runId, sessionId: identity.sessionId, toolCallId: identity.toolCallId };
            let first: ToolEvidencePage | undefined, offset = 0, complete = false;
            const chunks: string[] = [];
            async function read(offset: number, limit: number, expectedRevision?: number) {
                const input = ToolEvidenceRequestSchema.parse({ ...base, offset, limit, expectedRevision });
                const result = ToolEvidenceResultSchema.parse(await host.request({ type: 'query_run_tool_evidence', input }));
                if (!result.ok) throw new Error('query_run_tool_evidence: ' + result.error.code);
                const p = result.data;
                if (p.runId !== base.runId || p.sessionId !== base.sessionId || p.toolCallId !== base.toolCallId ||
                    p.offset !== offset || Buffer.byteLength(p.chunk) > limit || first && (p.evidenceRevision !== first.evidenceRevision || p.bytes !== first.bytes))
                    throw new Error('Tool evidence page identity, byte cursor or version changed');
                return p;
            }
            for (let page = 0; page < 10000; page++) {
                const p = await read(offset, pageSize, first?.evidenceRevision);
                first ??= p; chunks.push(p.chunk);
                if (p.nextOffset === null) { complete = true; break; }
                if(p.nextOffset!==offset+Buffer.byteLength(p.chunk)||p.nextOffset<=offset)throw Error('Tool evidence cursor made no progress');
                offset = p.nextOffset;
            }
            if (!complete || !first) throw new Error('Tool evidence safety bound exceeded');
            const text = chunks.join('');
            if (Buffer.byteLength(text) !== first.bytes)
                throw new Error('Complete tool evidence length mismatch');
            const tool = ToolCallSnapshotSchema.parse(JSON.parse(text));
            if (tool.runId !== base.runId || tool.sessionId !== base.sessionId || tool.toolCallId !== base.toolCallId || tool.toolName !== identity.toolName)
                throw new Error('Original tool payload belongs to another execution');
            await read(0, 4, first.evidenceRevision);
            actual.calls.push({ bytes: first.bytes, tool });
        }
        return { present: true, actual, source };
    } catch (error) {
        actual.gap = error instanceof Error ? error.message : String(error);
        return { present: false, actual, source };
    }
}
