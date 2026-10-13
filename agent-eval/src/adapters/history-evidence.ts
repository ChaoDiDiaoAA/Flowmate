import type { HostClient } from '../../../apps/desktop/main/host-client.ts';
import { NativeHistoryPageResultSchema, SessionHistoryEntryResultSchema,
    type HistoryCommitState, type HistoryEntrySummary, type HistoryEntryDisplayFields } from '../../../packages/contracts/src/memory.ts';
import { hash } from '../dataset-loader/local.ts';
import type { EvidenceFact } from '../types.ts';
import type { SessionSnapshot } from '../../../packages/contracts/src/runtime.ts';

export type HistoryEvidenceEntry = { summary: HistoryEntrySummary; fields: HistoryEntryDisplayFields; parts: Array<{ index: number; kind: string; text: string }> };
/** Public display text is evidence of saved history, not raw tool arguments, image bytes or model adoption. */
export async function collectHistoryEvidence(host: Pick<HostClient, 'request'>, input: { sessionId: number; pageSize?: number }): Promise<EvidenceFact> {
    const actual: { sessionId: number; session: SessionSnapshot | null; commit: HistoryCommitState | null; entries: HistoryEvidenceEntry[]; acquisition: 'controller-query';
        modelUse: 'requires-original-context-evidence'; gap?: string } = { sessionId: input.sessionId, session: null, commit: null, entries: [],
            acquisition: 'controller-query', modelUse: 'requires-original-context-evidence' };
    const source = 'Host native history queries; one pinned commit, original entry and fork origins; display text only';
    try {
        const summaries: HistoryEntrySummary[] = [], seen = new Set<string>();
        let afterSequence: number | undefined, complete = false;
        for (let page = 0; page < 10000; page++) {
            const result = NativeHistoryPageResultSchema.parse(await host.request({ type: 'query_session_history', input: {
                sessionId: input.sessionId, limit: input.pageSize ?? 100, afterSequence,
                expectedCommitRevision: actual.commit?.commitRevision } }));
            if (!result.ok) throw new Error('query_session_history: ' + result.error.code);
            const p = result.data;
            if (p.session.sessionId !== input.sessionId || actual.commit && hash(p.commit) !== hash(actual.commit))
                throw new Error('Foreign or changed history commit');
            actual.commit ??= p.commit;
            for (const item of p.items) {
                if (seen.has(item.entryId) || item.sequence !== summaries.length) throw new Error('Repeated or missing native history entry');
                if (item.parentId !== null && !seen.has(item.parentId)) throw new Error('Native history parent is missing');
                seen.add(item.entryId); summaries.push(item);
            }
            if (p.nextAfterSequence === null) { complete = true; break; }
            if (!p.items.length || p.nextAfterSequence === afterSequence) throw new Error('Native history page cursor made no progress');
            afterSequence = p.nextAfterSequence;
        }
        if (!complete || summaries.length !== actual.commit!.entryCount) throw new Error('Native history entry count is incomplete');
        for (const summary of summaries) {
            let partIndex = 0, offset = 0, entry: HistoryEvidenceEntry | undefined, done = false;
            for (let page = 0; page < 10000; page++) {
                const result = SessionHistoryEntryResultSchema.parse(await host.request({ type: 'query_session_history_entry', input: {
                    sessionId: input.sessionId, entryId: summary.entryId, expectedCommitRevision: actual.commit!.commitRevision, partIndex, offset } }));
                if (!result.ok) throw new Error('query_session_history_entry: ' + result.error.code);
                const detail = result.data;
                if (hash(detail.commit) !== hash(actual.commit) || hash(detail.summary) !== hash(summary) ||
                    entry && hash(entry.fields) !== hash(detail.fields)) throw new Error('Native history detail identity or fields changed');
                if (detail.partIndex < partIndex || detail.partIndex === partIndex && detail.offset !== offset ||
                    detail.partIndex > partIndex && detail.offset !== 0) throw new Error('Native history detail cursor mismatch');
                if (!entry) { entry = { summary, fields: detail.fields, parts: [] }; actual.entries.push(entry); }
                if (detail.part) {
                    const previous = entry.parts.at(-1);
                    if (previous?.index === detail.partIndex) {
                        if (previous.kind !== detail.part.kind || Buffer.byteLength(previous.text) !== detail.offset) throw new Error('Native history part has a gap');
                        previous.text += detail.part.text;
                    } else {
                        if (detail.offset !== 0) throw new Error('Native history part starts after missing bytes');
                        entry.parts.push({ index: detail.partIndex, kind: detail.part.kind, text: detail.part.text });
                    }
                    if (detail.next && (detail.next.partIndex === detail.partIndex
                        ? detail.next.offset !== detail.offset + Buffer.byteLength(detail.part.text) : detail.next.offset !== 0))
                        throw new Error('Native history continuation byte count mismatch');
                }
                if (detail.next === null) { done = true; break; }
                partIndex = detail.next.partIndex; offset = detail.next.offset;
            }
            if (!done) throw new Error('Native history detail safety bound exceeded');
        }
        // Check the held revision once more; never restart pagination over a newer commit.
        const final = NativeHistoryPageResultSchema.parse(await host.request({ type: 'query_session_history', input: {
            sessionId: input.sessionId, expectedCommitRevision: actual.commit!.commitRevision, limit: 1 } }));
        if (!final.ok || final.data.session.sessionId !== input.sessionId || hash(final.data.commit) !== hash(actual.commit))
            throw new Error('Native history changed before acquisition completed');
        actual.session = final.data.session;
        return { present: true, actual, source };
    } catch (error) {
        actual.gap = error instanceof Error ? error.message : String(error);
        return { present: false, actual, source };
    }
}
