import { appError, fail, ok, normalizeNativeHistoryPageRequest, normalizeSessionHistoryEntryRequest,
  NativeHistoryInspectionSchema, NativeHistoryPageResultSchema, SessionHistoryEntryResultSchema, NativeSessionEntrySchema } from '@flowmate/contracts';
import type { AgentPort, HistoryEntryDisplayFields, HistoryEntrySummary, HistorySelectionReason, NativeHistoryPage,
  NativeHistoryPageRequest, NativeHistoryRecoveryBundle, NativeSessionEntry, Result, SessionHistoryEntryDetail,
  SessionHistoryEntryRequest, SessionSnapshot } from '@flowmate/contracts';
import type { SessionRepository, SessionRow } from '../storage/repositories.ts';

type TextPart = { kind: NonNullable<SessionHistoryEntryDetail['part']>['kind']; text: string };
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value), 'utf8');
const invalid = () => fail(appError('input_invalid', 'input', 'History text position is invalid.'));
const tooLarge = () => fail(appError('context_evidence_too_large', 'runtime', 'Safe history display exceeds the response budget.'));
function prefix(text: string, limit: number): string {
  const data = Buffer.from(text); let end = Math.min(limit, data.length);
  while (end > 0 && end < data.length && (data[end]! & 0xc0) === 0x80) end--;
  return data.subarray(0, end).toString('utf8');
}
function preview(text: string) { const value = prefix(text, 1024); return { text: value, truncated: value !== text }; }
function contentParts(content: unknown): TextPart[] {
  if (typeof content === 'string') return [{ kind: 'text', text: content }];
  if (!Array.isArray(content)) return [];
  return content.flatMap<TextPart>(part => part.type === 'text' ? [{ kind: 'text' as const, text: part.text }]
    : part.type === 'thinking' ? [{ kind: 'thinking' as const, text: part.thinking }] : []);
}
function imageFacts(content: unknown) {
  const imageMimeTypes = Array.isArray(content) ? [...new Set(content.filter(part => part.type === 'image').map(part => part.mimeType as string))] : [];
  return { hasImages: imageMimeTypes.length > 0, imageMimeTypes };
}
/** Display only; SDK owns context conversion and structural eligibility. */
function display(entry: NativeSessionEntry): { fields: HistoryEntryDisplayFields; parts: TextPart[] } {
  switch (entry.type) {
    case 'message': {
      const message = entry.message;
      const parts: TextPart[] = message.role === 'bashExecution' ? [{ kind: 'command', text: message.command }, { kind: 'output', text: message.output }]
        : message.role === 'branchSummary' || message.role === 'compactionSummary' ? [{ kind: 'summary', text: message.summary }]
        : contentParts(message.content);
      return { fields: { type: 'message', role: message.role, toolName: message.role === 'toolResult' ? preview(message.toolName) : null,
        callId: message.role === 'toolResult' ? message.toolCallId : null, isError: message.role === 'toolResult' ? message.isError : null,
        stopReason: message.role === 'assistant' ? message.stopReason : null, ...imageFacts(message.content) }, parts };
    }
    case 'model_change': return { fields: { type: entry.type, provider: preview(entry.provider), modelId: preview(entry.modelId) }, parts: [] };
    case 'thinking_level_change': return { fields: { type: entry.type, thinkingLevel: preview(entry.thinkingLevel) }, parts: [] };
    case 'compaction': return { fields: { type: entry.type, firstKeptEntryId: entry.firstKeptEntryId, tokensBefore: entry.tokensBefore }, parts: [{ kind: 'summary', text: entry.summary }] };
    case 'branch_summary': return { fields: { type: entry.type, fromId: entry.fromId }, parts: [{ kind: 'summary', text: entry.summary }] };
    case 'custom': return { fields: { type: entry.type, customType: preview(entry.customType), hasOpaqueData: entry.data !== undefined }, parts: [] };
    case 'custom_message': return { fields: { type: entry.type, customType: preview(entry.customType), display: entry.display,
      hasOpaqueData: entry.details !== undefined, ...imageFacts(entry.content) }, parts: contentParts(entry.content) };
    case 'label': return { fields: { type: entry.type, targetId: entry.targetId, label: entry.label === undefined ? null : preview(entry.label) },
      parts: entry.label === undefined ? [] : [{ kind: 'text', text: entry.label }] };
    case 'session_info': return { fields: { type: entry.type, name: entry.name === undefined ? null : preview(entry.name) },
      parts: entry.name === undefined ? [] : [{ kind: 'text', text: entry.name }] };
  }
}
type Loaded = { row: SessionRow; bundle: NativeHistoryRecoveryBundle; blocked: boolean };
export function createHistoryReader(deps: { repository: SessionRepository; agent: AgentPort;
  project: (row: SessionRow) => SessionSnapshot; managementReason: (row: SessionRow) => HistorySelectionReason | null }) {
  function summarize(loaded: Loaded): Result<{ session: SessionSnapshot; summaries: HistoryEntrySummary[] }> {
    const { history, commit, seed } = loaded.bundle;
    if (!history || !commit || !deps.agent.inspectSessionHistory)
      return fail(appError('session_history_unavailable', 'session', 'Saved native history is unavailable.'));
    const inspected = deps.agent.inspectSessionHistory({ history, seed });
    if (!inspected.ok) return inspected;
    const parsed = NativeHistoryInspectionSchema.safeParse(inspected.data);
    const positions = new Map(parsed.success ? parsed.data.positions.map(position => [position.entryId, position]) : []);
    if (!parsed.success || positions.size !== history.entries.length || history.entries.some(entry => !positions.has(entry.id)))
      return fail(appError('session_history_invalid', 'session', 'Native history inspection is incomplete.'));
    const origins = new Map(seed.origins.map(origin => [origin.nativeEntryId, origin]));
    const managementReason = deps.managementReason(loaded.row);
    const summaries = history.entries.map((rawEntry, sequence): HistoryEntrySummary => {
      const entry = NativeSessionEntrySchema.parse(rawEntry);
      const position = positions.get(entry.id)!; const origin = origins.get(entry.id)!;
      const reason: HistorySelectionReason | null = history.unusable ? 'history-invalid' : loaded.blocked ? 'source-unavailable'
        : managementReason ?? (position.contextState === 'complete' ? null : position.contextState === 'empty' ? 'empty-context'
          : position.contextState === 'unsupported' ? 'context-unsupported' : 'incomplete-tool-pair');
      const text = preview(display(entry).parts.map(part => part.text).join('\n'));
      return { sequence, entryId: entry.id, parentId: entry.parentId, type: entry.type, timestamp: entry.timestamp,
        isCurrentPath: position.isCurrentPath, isLeaf: entry.id === history.leafId, preview: text.text, truncated: text.truncated,
        originSessionId: origin.originSessionId, originRunId: origin.originRunId, canSelect: reason === null, cannotSelectReason: reason };
    });
    return ok({ session: deps.project({ ...loaded.row, modelUseBlocked: loaded.blocked }), summaries });
  }
  function read<T>(sessionId: number, revision: number | undefined, project: (loaded: Loaded, summaries: HistoryEntrySummary[], session: SessionSnapshot) => Result<T>): Result<T> {
    return deps.repository.readHistorySnapshot(sessionId, loaded => {
      if (!loaded.bundle.history || !loaded.bundle.commit) return fail(appError('session_history_unavailable', 'session', 'Saved native history is unavailable.'));
      if (revision !== undefined && revision !== loaded.bundle.commit.commitRevision)
        return fail(appError('state_conflict', 'session', 'History changed. Reload to continue.', true));
      const result = summarize(loaded); if (!result.ok) return result;
      return project(loaded, result.data.summaries, result.data.session);
    });
  }
  return {
    list(raw: NativeHistoryPageRequest): Result<NativeHistoryPage> {
      const request = normalizeNativeHistoryPageRequest(raw); if (!request.ok) return request;
      const { sessionId, expectedCommitRevision, afterSequence, limit } = request.data;
      return read(sessionId, expectedCommitRevision, (loaded, summaries, session) => {
        const remaining = summaries.filter(item => afterSequence === undefined || item.sequence > afterSequence);
        const items = remaining.slice(0, limit); const commit = loaded.bundle.commit!;
        const result = () => ok({ session, commit, items, nextAfterSequence: remaining.length > items.length ? items.at(-1)?.sequence ?? null : null });
        while (items.length && bytes(result()) > 1048576) items.pop();
        if (remaining.length && !items.length || bytes(result()) > 1048576) return tooLarge();
        const parsed = NativeHistoryPageResultSchema.safeParse(result());
        return parsed.success ? result() : fail(appError('session_history_invalid', 'session', 'History display is invalid.'));
      });
    },
    detail(raw: SessionHistoryEntryRequest): Result<SessionHistoryEntryDetail> {
      const request = normalizeSessionHistoryEntryRequest(raw); if (!request.ok) return request;
      return read(request.data.sessionId, request.data.expectedCommitRevision, (loaded, summaries) => {
        const index = loaded.bundle.history!.entries.findIndex(entry => entry.id === request.data.entryId);
        if (index < 0) return invalid();
        const { fields, parts } = display(NativeSessionEntrySchema.parse(loaded.bundle.history!.entries[index]!));
        const base = { summary: summaries[index]!, commit: loaded.bundle.commit!, fields };
        if (bytes(ok({ ...base, part: null, partIndex: 0, offset: 0, next: null })) > 131072) return tooLarge();
        let { partIndex, offset } = request.data;
        if (!parts.some(part => part.text.length)) {
          if (partIndex !== 0 || offset !== 0) return invalid();
          const result = ok({ ...base, part: null, partIndex: 0, offset: 0, next: null });
          return SessionHistoryEntryResultSchema.safeParse(result).success ? result : tooLarge();
        }
        if (partIndex >= parts.length) return invalid();
        const original = Buffer.from(parts[partIndex]!.text);
        if (offset > original.length || offset < original.length && (original[offset]! & 0xc0) === 0x80) return invalid();
        while (partIndex < parts.length && offset === Buffer.byteLength(parts[partIndex]!.text)) { partIndex++; offset = 0; }
        if (partIndex >= parts.length) return invalid();
        const part = parts[partIndex]!; const source = Buffer.from(part.text).subarray(offset).toString('utf8');
        function result(limit: number): Result<SessionHistoryEntryDetail> {
          const text = prefix(source, limit); const end = offset + Buffer.byteLength(text);
          let next: SessionHistoryEntryDetail['next'] = null;
          if (end < Buffer.byteLength(part.text)) next = { partIndex, offset: end };
          else { const nextIndex = parts.findIndex((item, n) => n > partIndex && item.text.length > 0); if (nextIndex >= 0) next = { partIndex: nextIndex, offset: 0 }; }
          return ok({ ...base, part: { kind: part.kind, text }, partIndex, offset, next });
        }
        let limit = Math.min(65536, Buffer.byteLength(source));
        if (bytes(result(limit)) > 131072) {
          let low = 0, high = limit;
          while (low < high) { const mid = Math.ceil((low + high) / 2); if (bytes(result(mid)) <= 131072) low = mid; else high = mid - 1; }
          limit = low;
        }
        const selected = result(limit);
        return SessionHistoryEntryResultSchema.safeParse(selected).success ? selected : tooLarge();
      });
    },
  };
}
