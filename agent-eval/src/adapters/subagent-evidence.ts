import type { HostClient } from '../../../apps/desktop/main/host-client.ts';
import { SubagentPageResultSchema, SubagentDetailResultSchema, type SubagentDetail } from '../../../packages/contracts/src/subagents.ts';
import { hash } from '../dataset-loader/local.ts';
import type { EvidenceFact } from '../types.ts';

/** Child detail proves saved execution and delivery facts; parent adoption requires original parent requests. */
export async function collectSubagentEvidence(host: Pick<HostClient, 'request'>, parents: Array<{ runId: number; sessionId: number }>): Promise<EvidenceFact> {
    const actual: { children: SubagentDetail[]; stopUnconfirmed: number[]; gap?: string } = { children: [], stopUnconfirmed: [] };
    const source = 'Host subagent pages and original child detail; root/child/session/tool linkage and saved stop facts';
    const seen = new Set<number>(), sessions = new Set<number>();
    try {
        if (new Set(parents.map(p => p.runId)).size !== parents.length) throw new Error('Duplicate parent Run');
        for (const parent of parents) {
            let beforeRunId: number | undefined, complete = false;
            for (let page = 0; page < 10000; page++) {
                const result = SubagentPageResultSchema.parse(await host.request({ type: 'list_subagents', input: {
                    parentRunId: parent.runId, parentSessionId: parent.sessionId, beforeRunId, limit: 100 } }));
                if (!result.ok) throw new Error('list_subagents: ' + result.error.code);
                let last = beforeRunId ?? Infinity;
                for (const summary of result.data.items) {
                    if (summary.parentRunId !== parent.runId || summary.parentSessionId !== parent.sessionId ||
                        summary.childRunId >= last || seen.has(summary.childRunId) || sessions.has(summary.childSessionId) ||
                        parents.some(p => p.runId === summary.childRunId || p.sessionId === summary.childSessionId))
                        throw new Error('Foreign, repeated or unordered child Run');
                    seen.add(summary.childRunId); sessions.add(summary.childSessionId); last = summary.childRunId;
                    const detail = SubagentDetailResultSchema.parse(await host.request({ type: 'query_subagent', input: {
                        parentRunId: parent.runId, parentSessionId: parent.sessionId, childRunId: summary.childRunId } }));
                    if (!detail.ok) throw new Error('query_subagent: ' + detail.error.code);
                    // Status may advance during collection; these origin identities cannot change.
                    const origin = ({ childRunId, childSessionId, childNativeSessionId, parentRunId, parentSessionId, originToolCallId,
                        parentNativeToolCallId, pluginAgentId, role }: typeof summary) => ({ childRunId, childSessionId, childNativeSessionId,
                            parentRunId, parentSessionId, originToolCallId, parentNativeToolCallId, pluginAgentId, role });
                    if (hash(origin(summary)) !== hash(origin(detail.data))) throw new Error('Child detail origin changed');
                    actual.children.push(detail.data);
                    if (!detail.data.stopConfirmed) actual.stopUnconfirmed.push(detail.data.childRunId);
                }
                if (result.data.nextBeforeRunId === null) { complete = true; break; }
                if (!result.data.items.length || result.data.nextBeforeRunId !== last) throw new Error('Child page cursor made no progress');
                beforeRunId = result.data.nextBeforeRunId;
            }
            if (!complete) throw new Error('Child page safety bound exceeded');
        }
        return { present: true, actual, source };
    } catch (error) {
        actual.gap = error instanceof Error ? error.message : String(error);
        return { present: false, actual, source };
    }
}
