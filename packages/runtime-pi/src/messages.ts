import { z } from 'zod';
import type { Message } from '@earendil-works/pi-ai';
import { type SessionEntry } from '@earendil-works/pi-coding-agent';
import { createHash } from 'node:crypto';
import { ResourceBindingSchema, ResourceExpansionEvidenceSchema, resourceRefKey } from '@flowmate/contracts';
import type { ResourceBinding, ResourceExpansionEvidence } from '@flowmate/contracts';
import { appError, fail, ok, InputRecordV2Schema, invoiceToolSchemas, INVOICE_TOOL_NAMES,
  SessionMessageViewSchema, FillInvoiceFormOutputSchema, SessionInputContentSchema, formatExecutionPrompt, WorkspaceContextSchema } from '@flowmate/contracts';
import type { DbId, MessageDisplayBlock, MessageRunInput, NativeMessageProjectionInput,
  NativeSessionHistory, Result, SessionMessageView, SessionMessagesPage, MessageSessionInput } from '@flowmate/contracts';
export { formatExecutionPrompt } from '@flowmate/contracts';
import { validateNativeHistory, validateLlmMessages, managerFor } from './memory/history.ts';
export { validateNativeHistory } from './memory/history.ts';

const textLimit = 65_536;
const pageLimit = 1_048_576;
const id = z.string().min(1);
const finite = z.number().finite();
const dbId = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const text = z.object({ type: z.literal('text'), text: z.string(), textSignature: z.string().optional() }).passthrough();
const image = z.object({ type: z.literal('image'), data: z.string(), mimeType: id }).passthrough();
const thinking = z.object({ type: z.literal('thinking'), thinking: z.string(), thinkingSignature: z.string().optional(),
  redacted: z.boolean().optional() }).passthrough();
const toolCall = z.object({ type: z.literal('toolCall'), id, name: id, arguments: z.record(z.unknown()),
  thoughtSignature: z.string().optional(), namespace: z.string().optional() }).passthrough();
const usage = z.object({ input: finite, output: finite, cacheRead: finite, cacheWrite: finite, totalTokens: finite,
  cacheWrite1h: finite.optional(), reasoning: finite.optional(),
  cost: z.object({ input: finite, output: finite, cacheRead: finite, cacheWrite: finite, total: finite }).passthrough() }).passthrough();
const diagnostics = z.object({ type: z.string(), timestamp: finite,
  error: z.object({ name: z.string().optional(), message: z.string(), stack: z.string().optional(),
    code: z.union([z.string(), finite]).optional() }).passthrough().optional(), details: z.record(z.unknown()).optional() }).passthrough();
const messageSchema = z.discriminatedUnion('role', [
  z.object({ role: z.literal('user'), content: z.union([z.string(), z.array(z.discriminatedUnion('type', [text, image]))]), timestamp: finite }).passthrough(),
  z.object({ role: z.literal('assistant'), content: z.array(z.discriminatedUnion('type', [text, thinking, toolCall])),
    api: id, provider: id, model: z.string(), usage,
    stopReason: z.enum(['pending', 'stop', 'length', 'toolUse', 'error', 'aborted', 'deferred']), timestamp: finite,
    responseId: z.string().optional(), responseModel: z.string().optional(), providerThinkingLevel: z.string().optional(),
    errorMessage: z.string().optional(), rawStopReason: z.string().optional(), endTurn: z.boolean().optional(),
    diagnostics: z.array(diagnostics).optional(), deferred: z.object({ provider: z.string(), modelId: z.string(),
      api: z.string(), id: z.string(), expiresAt: finite.optional(), pollAfterMs: finite.optional(), data: z.unknown().optional() }).passthrough().optional(),
  }).passthrough(),
  z.object({ role: z.literal('toolResult'), toolCallId: id, toolName: id, content: z.array(z.discriminatedUnion('type', [text, image])),
    isError: z.boolean(), timestamp: finite, details: z.unknown().optional(), usage: usage.optional(),
    addedToolNames: z.array(z.string()).optional() }).passthrough(),
]);
const runInputSchema = z.object({ runId: dbId, goalMode: z.enum(['answer', 'save-candidate', 'fill-form']).nullable(),
  workingDirectory: z.string().min(1).max(4096).optional(),
  workspaceContext: WorkspaceContextSchema.optional(),
  input: z.union([z.object({ version: z.literal(1), goal: z.string(), text: z.string(), messageTimestamp: finite }).strict(),
    InputRecordV2Schema]) }).strict();

/** Preserve SDK optional undefined fields; reject non-JSON objects rather than silently stringify them away. */
function jsonSafe(value: unknown, path = new Set<object>()): boolean {
  if (value === null || value === undefined || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value !== 'object' || path.has(value)) return false;
  if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) return false;
  path.add(value);
  const keys = Reflect.ownKeys(value);
  const valid = Array.isArray(value)
    ? keys.length === value.length + 1 && keys.every(key => key === 'length' || (typeof key === 'string'
      && /^(0|[1-9]\d*)$/.test(key) && Number(key) < value.length
      && Object.getOwnPropertyDescriptor(value, key)?.value !== undefined
      && jsonSafe(Object.getOwnPropertyDescriptor(value, key)?.value, path)))
    : keys.every(key => {
      if (typeof key !== 'string') return false;
      const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
      return descriptor.enumerable && 'value' in descriptor && jsonSafe(descriptor.value, path);
    });
  path.delete(value);
  return valid;
}
function invalid<T = never>(): Result<T> {
  return fail(appError('session_history_invalid', 'session', 'Conversation history is incompatible or incomplete.'));
}
export const validateModelMessages = validateLlmMessages;

export type MessageViewContext = {
  entryId: string | null; runId: DbId | null; liveOrdinal: number | null;
  persistence: SessionMessageView['persistence']; phase: SessionMessageView['phase']; runInput?: MessageRunInput;
  productInput?: { text: string; promptText: string; inputId?: number; resourceBinding?: ResourceBinding; resourceExpansion?: ResourceExpansionEvidence };
};
function limitedBlocks(blocks: MessageDisplayBlock[]): { blocks: MessageDisplayBlock[]; truncated: boolean } {
  let remaining = textLimit; let truncated = blocks.length > 256;
  const output = blocks.slice(0, 256).map(block => {
    if (block.type !== 'text') return block;
    const bytes = new TextEncoder().encode(block.text);
    if (bytes.length <= remaining) { remaining -= bytes.length; return block; }
    let end = remaining;
    while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end--;
    const value = new TextDecoder().decode(bytes.subarray(0, end));
    remaining -= end; truncated = true;
    return { type: 'text' as const, text: value };
  });
  return { blocks: output, truncated };
}
function nativeUserText(content: string | { type: 'text'; text: string }[]): string {
  return typeof content === 'string' ? content : content.filter(block => block.type === 'text').map(block => block.text).join('');
}
function resultSummary(message: Extract<Message, { role: 'toolResult' }>): string {
  if (message.isError) return 'The tool returned an error. See the error details.';
  // Projection does not grant tool permission. The Executor validates the active registry;
  // structurally valid SDK/test tools retain their actual result identity without exposing output.
  if (message.toolName !== 'fill_invoice_form'
    && !INVOICE_TOOL_NAMES.includes(message.toolName as typeof INVOICE_TOOL_NAMES[number])) return 'Tool result received.';
  try {
    const output: unknown = JSON.parse(message.content.map(block => block.type === 'text' ? block.text : '').join(''));
    if (message.toolName === 'fill_invoice_form') {
      const parsed = FillInvoiceFormOutputSchema.safeParse(output);
      return parsed.success ? `Filled candidate ${parsed.data.candidateId} (version ${parsed.data.candidateSequence}) into the invoice form.`
        : 'Result summary unavailable.';
    }
    if (message.toolName === 'read_invoice_document') {
      const parsed = invoiceToolSchemas.read_invoice_document.output.safeParse(output);
      return parsed.success ? `Read page ${parsed.data.page}; returned ${parsed.data.blocks.length} parsed blocks.` : 'Result summary unavailable.';
    }
    const schema = invoiceToolSchemas[message.toolName as typeof INVOICE_TOOL_NAMES[number]].output;
    return schema.safeParse(output).success ? 'Tool result received.' : 'Result summary unavailable.';
  } catch { return 'Result summary unavailable.'; }
}

export function projectMessageView(message: unknown, context: MessageViewContext): Result<SessionMessageView> {
  try {
    if (!jsonSafe(message) || !jsonSafe(context)) return invalid();
    let candidate = message;
    if (context.phase === 'streaming' && message && typeof message === 'object' && 'role' in message && message.role === 'assistant'
      && 'content' in message && Array.isArray(message.content)) {
      // SDK toolcall_start temporarily uses empty id/name. Only live partials may omit these unformed references.
      // Ended/history/model validation always rejects them; formed references retain their actual SDK identity.
      const content = message.content.filter(block => !(block && typeof block === 'object' && block.type === 'toolCall'
        && typeof block.id === 'string' && typeof block.name === 'string' && (!block.id || !block.name)
        && block.arguments && typeof block.arguments === 'object' && !Array.isArray(block.arguments)));
      candidate = { ...message, content };
    }
    const parsed = messageSchema.safeParse(candidate);
    if (!parsed.success || (parsed.data.role !== 'assistant' && context.phase !== 'ended')) return invalid();
    const source = parsed.data as Message;
    const base = { entryId: context.entryId, runId: context.runId, liveOrdinal: context.liveOrdinal,
      timestamp: source.timestamp, persistence: context.persistence };
    let view: unknown;
    if (source.role === 'user') {
      let visible = nativeUserText(source.content as string | { type: 'text'; text: string }[]);
      let origin: 'product-input' | 'native-content' = 'native-content';
      if (context.productInput !== undefined) {
        const product = z.object({ text: z.string(), promptText: z.string().min(1), inputId: dbId.optional(),
          resourceBinding: ResourceBindingSchema.optional(), resourceExpansion: ResourceExpansionEvidenceSchema.optional() }).strict().safeParse(context.productInput);
        if (!product.success || context.runId === null) return invalid();
        const required = product.data.resourceBinding?.requiredSkill, receipt = product.data.resourceExpansion;
        if (required) {
          if (!receipt || context.persistence !== 'saved' || context.entryId !== receipt.nativeEntryId
            || receipt.inputId !== product.data.inputId || receipt.bundleHash !== product.data.resourceBinding?.bundleHash
            || resourceRefKey(receipt.skill) !== resourceRefKey(required)
            || receipt.expandedTextHash !== createHash('sha256').update(visible).digest('hex')) return invalid();
        } else if (receipt || product.data.promptText !== visible) return invalid();
        visible = product.data.text; origin = 'product-input';
      } else if (context.runInput !== undefined) {
        const run = runInputSchema.safeParse(context.runInput);
        if (!run.success || context.runId !== run.data.runId) return invalid();
        const expected = formatExecutionPrompt({ text: run.data.input.text, business: run.data.goalMode !== null,
          ...(run.data.workingDirectory ? { workingDirectory: run.data.workingDirectory } : {}),
          ...(run.data.goalMode === null ? {} : { goalMode: run.data.goalMode }),
          ...(run.data.input.version === 2 ? { workspaceInput: run.data.input.workspaceInput } : {}),
          ...(run.data.workspaceContext ? { workspaceContext: run.data.workspaceContext } : {}) });
        if (expected !== visible) return invalid();
        visible = run.data.input.text; origin = 'product-input';
      }
      const limited = limitedBlocks([{ type: 'text', text: visible }]);
      view = { ...base, ...limited, role: 'user', phase: 'ended', stopReason: null,
        toolCallId: null, toolName: null, isError: null, textOrigin: origin };
    } else if (source.role === 'assistant') {
      const blocks = source.content.flatMap<MessageDisplayBlock>(block => block.type === 'text'
        ? [{ type: 'text' as const, text: block.text }] : block.type === 'toolCall'
          ? [{ type: 'toolCall' as const, id: block.id, name: block.name }] : []);
      const limited = limitedBlocks(blocks);
      view = { ...base, ...limited, role: 'assistant', phase: context.phase, stopReason: source.stopReason,
        toolCallId: null, toolName: null, isError: null,
        textOrigin: limited.blocks.some(block => block.type === 'text') ? 'native-content' : null };
    } else {
      const summary = resultSummary(source);
      view = { ...base, ...limitedBlocks([{ type: 'text', text: summary }]), role: 'toolResult', phase: 'ended',
        stopReason: null, toolCallId: source.toolCallId, toolName: source.toolName, isError: source.isError, textOrigin: null };
    }
    const checked = SessionMessageViewSchema.safeParse(view);
    if (!checked.success || new TextEncoder().encode(JSON.stringify({ items: [checked.data], nextBeforeEntryId: null })).length > pageLimit) return invalid();
    return ok(checked.data);
  } catch { return invalid(); }
}

export function projectSessionMessages(input: NativeMessageProjectionInput): Result<Pick<SessionMessagesPage, 'items' | 'nextBeforeEntryId'>> {
  try {
    if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 100
      || (input.beforeEntryId !== undefined && (typeof input.beforeEntryId !== 'string' || !input.beforeEntryId || input.beforeEntryId.length > 128))) {
      return fail(appError('input_invalid', 'input', 'Conversation message cursor or limit is invalid.'));
    }
    const valid = validateNativeHistory(input.history);
    if (!valid.ok || !jsonSafe(input)) return invalid();
    const entries = new Map(input.history.entries.map(entry => [entry.id, entry]));
    const bindings = new Map<string, number>(); const runs = new Map<number, MessageRunInput>();
    for (const runInput of input.runInputs) {
      if (!runInputSchema.safeParse(runInput).success || runs.has(runInput.runId)) return invalid();
      runs.set(runInput.runId, runInput);
    }
    const productInputs = new Map<string, MessageSessionInput>(); const inputIds = new Set<number>(); const productRunIds = new Set<number>();
    for (const product of input.sessionInputs ?? []) {
      if (!jsonSafe(product) || !dbId.safeParse(product.inputId).success || !dbId.safeParse(product.runId).success
        || !id.safeParse(product.nativeEntryId).success || !SessionInputContentSchema.safeParse(product.content).success
        || productInputs.has(product.nativeEntryId) || inputIds.has(product.inputId)) return invalid();
      const entry = entries.get(product.nativeEntryId);
      if (!entry || entry.type !== 'message' || (entry.message as Message).role !== 'user'
        || !runs.has(product.runId) || !input.bindings.some(binding => binding.entryId === product.nativeEntryId && binding.runId === product.runId)) return invalid();
      productInputs.set(product.nativeEntryId, product); inputIds.add(product.inputId); productRunIds.add(product.runId);
    }
    const userContext = (entryId: string, runId: number) => {
      const product = productInputs.get(entryId);
      if (product?.content.version === 2) return { productInput: { text: product.content.text, promptText: product.content.promptText, inputId: product.inputId,
        ...(product.content.resourceBinding ? { resourceBinding: product.content.resourceBinding } : {}),
        ...(product.resourceExpansion ? { resourceExpansion: product.resourceExpansion } : {}) } };
      if (product && product.content.text !== runs.get(runId)!.input.text) throw new Error('legacy_input_mismatch');
      return { runInput: runs.get(runId)! };
    };
    const userCounts = new Map<number, number>();
    for (const binding of input.bindings) {
      const entry = entries.get(binding.entryId);
      if (!dbId.safeParse(binding.runId).success || !entry || entry.type !== 'message' || bindings.has(binding.entryId) || !runs.has(binding.runId)) return invalid();
      bindings.set(binding.entryId, binding.runId);
      if ((entry.message as Message).role === 'user') {
        const count = (userCounts.get(binding.runId) ?? 0) + 1;
        if (productRunIds.has(binding.runId) ? !productInputs.has(binding.entryId) : count > 1) return invalid();
        userCounts.set(binding.runId, count);
        // A forged binding must fail even when pagination excludes that user from this page.
        const checked = projectMessageView(entry.message, { entryId: entry.id, runId: binding.runId,
          liveOrdinal: null, persistence: 'saved', phase: 'ended', ...userContext(entry.id, binding.runId) });
        if (!checked.ok) return checked;
      }
    }
    const live = new Map<string, number>(); const ordinals = new Set<string>();
    for (const binding of input.liveBindings ?? []) {
      const key = `${binding.runId}:${binding.liveOrdinal}`;
      if (bindings.get(binding.entryId) !== binding.runId || !dbId.safeParse(binding.liveOrdinal).success || live.has(binding.entryId) || ordinals.has(key)) return invalid();
      live.set(binding.entryId, binding.liveOrdinal); ordinals.add(key);
    }
    const path = managerFor(input.history).getBranch().filter((entry): entry is Extract<SessionEntry, { type: 'message' }> => entry.type === 'message' && ['user', 'assistant', 'toolResult'].includes(entry.message.role));
    let end = path.length;
    if (input.beforeEntryId !== undefined) {
      end = path.findIndex(entry => entry.id === input.beforeEntryId);
      if (end < 0) return fail(appError('input_invalid', 'input', 'Conversation cursor is not a message on the current path.'));
    }
    const items: SessionMessageView[] = []; let nextBeforeEntryId: string | null = null;
    for (let index = end - 1; index >= 0 && items.length < input.limit; index--) {
      const entry = path[index]!; const runId = bindings.get(entry.id) ?? null;
      const projected = projectMessageView(entry.message, { entryId: entry.id, runId,
        liveOrdinal: live.get(entry.id) ?? null, phase: 'ended', persistence: 'saved',
        ...(runId === null || (entry.message as Message).role !== 'user' ? {} : userContext(entry.id, runId)) });
      if (!projected.ok) return projected;
      const candidate = [projected.data, ...items]; const cursor = index > 0 ? entry.id : null;
      if (cursor !== null && cursor.length > 128) return invalid();
      if (new TextEncoder().encode(JSON.stringify({ items: candidate, nextBeforeEntryId: cursor })).length > pageLimit) {
        if (items.length === 0) return invalid();
        break;
      }
      items.unshift(projected.data); nextBeforeEntryId = cursor;
    }
    return ok({ items, nextBeforeEntryId });
  } catch { return invalid(); }
}
