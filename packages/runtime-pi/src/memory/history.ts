import { isDeepStrictEqual } from 'node:util';
import { SessionManager, convertToLlm, type FileEntry, type SessionEntry, type AgentSession } from '@earendil-works/pi-coding-agent';
import { NativeSessionHistorySchema, NativeAgentMessageSchema, NativeHistoryRecoveryBundleSchema, appError, fail, ok } from '@flowmate/contracts';
import type { NativeSessionHistory, NativeHistoryRecoverySeed, HistoryCommitState, Result, NativeHistoryInspection, NativeSessionEntry } from '@flowmate/contracts';

type AgentMessage = AgentSession['messages'][number];
export const invalidHistory = () => fail(appError('session_history_invalid', 'session', 'Conversation history is incompatible or incomplete.'));
export function managerFor(history: NativeSessionHistory): SessionManager {
  const manager = SessionManager.inMemory(history.header.cwd, undefined, structuredClone([history.header, ...history.entries]) as FileEntry[]);
  if (history.leafId === null) manager.resetLeaf(); else manager.branch(history.leafId);
  if (!isDeepStrictEqual(JSON.parse(JSON.stringify([manager.getHeader(), ...manager.getEntries()])), JSON.parse(JSON.stringify([history.header, ...history.entries])))
    || manager.getLeafId() !== history.leafId) throw new Error('sdk_history_changed');
  return manager;
}
export function referenceIds(entry: NativeSessionHistory['entries'][number] | SessionEntry): string[] {
  const e = entry as NativeSessionEntry;
  if (e.type === 'label' || e.type === 'context_edit') return [e.targetId];
  if (e.type === 'compaction') return [e.firstKeptEntryId];
  const reference = e.type === 'branch_summary' ? e.fromId
    : e.type === 'message' && e.message.role === 'branchSummary' ? e.message.fromId : null;
  return reference === null || reference === 'root' ? [] : [reference];
}
function validSequence(messages: readonly AgentMessage[], complete: boolean): boolean {
  const used = new Set<string>(), pending = new Map<string, string>();
  const converted = convertToLlm([...messages]);
  for (const [index, message] of converted.entries()) {
    if (message.role === 'toolResult') {
      if (pending.get(message.toolCallId) !== message.toolName) return false;
      pending.delete(message.toolCallId);
    } else {
      if (pending.size) {
        // Fixed SDK handleRunFailure appends this terminal after an awaited
        // admission refusal. It records the abort, never completes a tool pair.
        if (!complete && index === converted.length - 1 && message.role === 'assistant'
          && message.stopReason === 'aborted' && typeof message.errorMessage === 'string' && message.errorMessage.length > 0
          && message.content.length === 1 && message.content[0]?.type === 'text' && message.content[0].text === ''
          && Object.keys(message.content[0]).length === 2) continue;
        return false;
      }
      if (message.role === 'assistant') for (const part of message.content) if (part.type === 'toolCall') {
        if (used.has(part.id)) return false;
        used.add(part.id); pending.set(part.id, part.name);
      }
    }
  }
  return !complete || pending.size === 0;
}
export function validateAgentContext(messages: readonly AgentMessage[], complete = true): Result<void> {
  try {
    if (!Array.isArray(messages) || Object.getPrototypeOf(messages) !== Array.prototype
      || Reflect.ownKeys(messages).length !== messages.length + 1) return invalidHistory();
    for (let i = 0; i < messages.length; i++) {
      const descriptor = Object.getOwnPropertyDescriptor(messages, i);
      if (!descriptor || !('value' in descriptor) || !NativeAgentMessageSchema.safeParse(descriptor.value).success) return invalidHistory();
    }
    if (!validSequence(messages, complete)) return invalidHistory();
    return ok(undefined);
  } catch { return invalidHistory(); }
}
export function validateLlmMessages(messages: readonly AgentMessage[]): Result<void> {
  const validated = validateAgentContext(messages);
  if (!validated.ok) return validated;
  if (messages.some(m => !['system', 'user', 'assistant', 'toolResult'].includes(m.role))) return invalidHistory();
  return ok(undefined);
}
export function validateNativeHistory(history: NativeSessionHistory): Result<void> {
  try {
    const parsed = NativeSessionHistorySchema.safeParse(history);
    if (!parsed.success || history.header.version !== 3) return invalidHistory();
    const manager = managerFor(history), calls = new Set<string>();
    for (const entry of parsed.data.entries) {
      if (entry.type === 'context_edit') {
        const target = manager.getEntry(entry.targetId);
        const editable = target?.type === 'custom_message'
          || target?.type === 'message' && ['user', 'assistant', 'toolResult'].includes(target.message.role);
        if (!editable || entry.parentId === null
          || !manager.getBranch(entry.parentId).some(parent => parent.id === entry.targetId)) return invalidHistory();
      }
      if (entry.type === 'message' && entry.message.role === 'assistant') for (const block of entry.message.content) if (block.type === 'toolCall') {
        if (calls.has(block.id)) return invalidHistory(); calls.add(block.id);
      }
      if (entry.type === 'message') {
        const path = manager.getBranch(entry.id).flatMap(e => e.type === 'message' ? [e.message] : []);
        if (!validSequence(path, false)) return invalidHistory();
      }
    }
    return ok(undefined);
  } catch { return invalidHistory(); }
}
export function validateRecovery(history: NativeSessionHistory, seed: NativeHistoryRecoverySeed, commit: HistoryCommitState): Result<void> {
  try {
    if (!validateNativeHistory(history).ok || !NativeHistoryRecoveryBundleSchema.safeParse({ history, seed, commit }).success) return invalidHistory();
    const inputs = new Set<number>();
    for (const input of seed.inputs) if (input.inputId !== null) {
      if (inputs.has(input.inputId)) return invalidHistory(); inputs.add(input.inputId);
    }
    const bound = new Set(seed.inputs.map(i => i.nativeEntryId));
    if (history.entries.some(e => e.type === 'message' && (e.message as AgentMessage).role === 'user' && !bound.has(e.id))) return invalidHistory();
    return ok(undefined);
  } catch { return invalidHistory(); }
}
export function inspectSessionHistory(input: { history: NativeSessionHistory; seed: NativeHistoryRecoverySeed }): Result<NativeHistoryInspection> {
  const { history, seed } = input;
  const valid = validateRecovery(history, seed, { commitRevision: 0, entryCount: history.entries.length, leafId: history.leafId });
  if (!valid.ok) return valid;
  try {
    const manager = managerFor(history), path = new Set(manager.getBranch().map(e => e.id));
    return ok({ positions: history.entries.map(entry => {
      manager.branch(entry.id); const messages = manager.buildSessionContext().messages;
      const contextState = messages.length === 0 ? 'empty' : validateAgentContext(messages).ok ? 'complete'
        : validateAgentContext(messages, false).ok ? 'incomplete-tool-pair' : 'unsupported';
      return { entryId: entry.id, isCurrentPath: path.has(entry.id), contextState };
    }) });
  } catch { return invalidHistory(); }
}
export function buildForkSessionHistory(input: { source: NativeSessionHistory; targetEntryId: string }): Result<NativeSessionHistory> {
  const { source, targetEntryId } = input;
  if (!validateNativeHistory(source).ok || source.unusable || !source.entries.some(e => e.id === targetEntryId)) return invalidHistory();
  try {
    const manager = managerFor(source); manager.branch(targetEntryId);
    const context = manager.buildSessionContext();
    if (!validateAgentContext(context.messages).ok || context.messages.length === 0) return invalidHistory();
    const included = new Set(manager.getBranch().map(e => e.id)), entries = new Map(source.entries.map(e => [e.id, e]));
    let changed = true;
    while (changed) {
      changed = false;
      const add = (id: string) => { if (!included.has(id)) { included.add(id); changed = true; } };
      for (const id of [...included]) {
        const entry = entries.get(id)!;
        if (entry.parentId !== null) add(entry.parentId);
        for (const reference of referenceIds(entry)) add(reference);
      }
      for (const entry of source.entries) if (entry.type === 'label' && typeof entry.targetId === 'string' && included.has(entry.targetId)) add(entry.id);
    }
    const header = SessionManager.inMemory(source.header.cwd).getHeader()!;
    const fork: NativeSessionHistory = { storageVersion: 1, header, entries: structuredClone(source.entries.filter(e => included.has(e.id))), leafId: targetEntryId, unusable: false };
    if (!validateNativeHistory(fork).ok || !isDeepStrictEqual(managerFor(fork).buildSessionContext(), context)) return invalidHistory();
    return ok(fork);
  } catch { return invalidHistory(); }
}
