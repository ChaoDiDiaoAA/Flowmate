import { isDeepStrictEqual } from 'node:util';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { defineDoc, defineDocFamily, InboxDoc, type ConversationId, type Harness, type InboxItem, type Tx } from '@earendil-works/pi-durable';
import { z } from 'zod';
import { appError, CloudQueueControlQuerySchema, CloudQueueControlSchema, CloudQueueOwnerSchema, CloudQueueReceiptSchema,
  CloudQueueViewSchema, fail, ok, type CloudQueueControl, type CloudQueueControlQuery, type CloudQueueOwner,
  type CloudQueueReceipt, type CloudQueueView, type Result } from '@flowmate/contracts';

type QueueState = { version: number; snapshot: string | null };
type ControlState = { request: string | null; receipt: string | null };
const Queue = defineDoc({ kind: 'flowmate.runtime.queue', version: 1, scope: 'conversation', history: 'latest', fork: 'initial',
  initial: (): QueueState => ({ version: 0, snapshot: null }), checkpointWhen: () => true });
const Control = defineDocFamily({ kind: 'flowmate.runtime.queue-control', version: 1, family: true, scope: 'conversation', history: 'latest', fork: 'initial',
  initial: (_seed: null): ControlState => ({ request: null, receipt: null }), checkpointWhen: () => true });
const originalInput = CloudQueueOwnerSchema.extend({ requestId: z.string().min(1).max(128), inputText: z.string().min(1) }).passthrough();
const queuedInput = originalInput.extend({ controlRequestId: z.string().min(1).max(128), submissionId: z.number().int().positive().safe() });
export const queueSubmissionKey = (attemptId: number, controlRequestId: string) => JSON.stringify(['flowmate.queue', attemptId, controlRequestId]);

/** Controls mutate Inbox and save their receipt in one Pi Durable commit. Business authorization is supplied by the caller. */
export function createDurableQueueController(options: { harness: Harness; resolve(owner: CloudQueueOwner): Promise<ConversationId | undefined>;
  activePhase?(tx: Tx, conversationId: ConversationId, owner: CloudQueueOwner, requestId: string): Promise<boolean> }) {
  const safe = async <T>(action: () => Promise<T>): Promise<Result<T>> => {
    try { return ok(await action()); }
    catch (error) {
      const code = error instanceof Error && ['input_invalid', 'state_conflict', 'cloud_queue_too_large'].includes(error.message)
        ? error.message : 'cloud_queue_unavailable';
      return fail(appError(code, 'runtime', 'The original native queue could not be confirmed.', code === 'cloud_queue_unavailable'));
    }
  };
  const conversation = async (owner: CloudQueueOwner) => {
    const id = await options.resolve(owner); if (id === undefined) throw Error('state_conflict'); return id;
  };
  const capture = (items: readonly InboxItem[]) => {
    const value = JSON.stringify(items);
    if (new TextEncoder().encode(value).byteLength > 262_144) throw Error('cloud_queue_too_large');
    return value;
  };
  const synchronize = (state: QueueState, snapshot: string) => {
    if (state.snapshot === null || !isDeepStrictEqual(JSON.parse(state.snapshot), JSON.parse(snapshot))) {
      if (!Number.isSafeInteger(state.version) || state.version >= Number.MAX_SAFE_INTEGER) throw Error('state_conflict');
      state.version++; state.snapshot = snapshot;
    }
  };
  const users = async (tx: Tx, conversationId: ConversationId, owner: CloudQueueOwner, items: readonly InboxItem[]) => {
    const output: CloudQueueView['items'] = [];
    for (const item of items) {
      if (item.mode === 'write') continue;
      const auxiliary = item.entry?.kind === 'flowmate.queue-input', original = (auxiliary ? queuedInput : originalInput).safeParse(item.entry?.data);
      if ((!auxiliary && item.entry?.kind !== 'flowmate.input') || !original.success || original.data.workId !== owner.workId
        || original.data.sessionId !== owner.sessionId || original.data.attemptId !== owner.attemptId || typeof item.content !== 'string')
        throw Error('state_conflict');
      const controlId = auxiliary ? queuedInput.parse(original.data).controlRequestId : null;
      const saved = await tx.submissionByRequest(conversationId, controlId === null ? JSON.stringify([owner.attemptId, original.data.requestId]) : queueSubmissionKey(owner.attemptId, controlId));
      if (!saved || saved.type !== 'input' || saved.status !== 'queued' || saved.id !== item.id || saved.conversationId !== conversationId)
        throw Error('state_conflict');
      if (auxiliary && queuedInput.parse(original.data).submissionId !== item.id) throw Error('state_conflict');
      output.push({ submissionId: item.id, requestId: original.data.requestId, mode: item.mode, content: item.content });
    }
    if (output.length > 100) throw Error('cloud_queue_too_large');
    return output;
  };
  const parseOwner = (raw: CloudQueueOwner) => {
    const parsed = CloudQueueOwnerSchema.safeParse(raw); if (!parsed.success) throw Error('input_invalid'); return parsed.data;
  };
  return {
    read: (raw: CloudQueueOwner): Promise<Result<CloudQueueView>> => safe(async () => {
      const owner = parseOwner(raw), id = await conversation(owner);
      return options.harness.commit(async tx => {
        const inbox = await tx.doc(InboxDoc, id), state = await tx.doc(Queue, id);
        const items = await users(tx, id, owner, inbox.items), snapshot = capture(inbox.items);
        synchronize(state, snapshot);
        return CloudQueueViewSchema.parse({ ...owner, version: state.version, items });
      }, BACKGROUND_CONTEXT);
    }),
    queryControl: (raw: CloudQueueControlQuery): Promise<Result<CloudQueueReceipt | null>> => safe(async () => {
      const parsed = CloudQueueControlQuerySchema.safeParse(raw); if (!parsed.success) throw Error('input_invalid');
      const input = parsed.data, owner = { workId: input.workId, sessionId: input.sessionId, attemptId: input.attemptId };
      const id = await conversation(owner), saved = await options.harness.snapshot(Control, id, input.controlRequestId, BACKGROUND_CONTEXT);
      if (!saved) return null;
      if (!saved.request || !saved.receipt) throw Error('state_conflict');
      const original = CloudQueueControlSchema.parse(JSON.parse(saved.request)), receipt = CloudQueueReceiptSchema.parse(JSON.parse(saved.receipt));
      if (original.workId !== owner.workId || original.sessionId !== owner.sessionId || original.attemptId !== owner.attemptId
        || receipt.workId !== owner.workId || receipt.sessionId !== owner.sessionId || receipt.attemptId !== owner.attemptId
        || receipt.controlRequestId !== input.controlRequestId) throw Error('state_conflict');
      return receipt;
    }),
    apply: (raw: CloudQueueControl): Promise<Result<CloudQueueReceipt>> => safe(async () => {
      const parsed = CloudQueueControlSchema.safeParse(raw); if (!parsed.success) throw Error('input_invalid');
      const input = parsed.data, owner = { workId: input.workId, sessionId: input.sessionId, attemptId: input.attemptId };
      const id = await conversation(owner);
      return options.harness.commit(async tx => {
        const inbox = await tx.doc(InboxDoc, id), state = await tx.doc(Queue, id), control = await tx.doc(Control, id, input.controlRequestId, null);
        if (control.request !== null || control.receipt !== null) {
          if (!control.request || !control.receipt || !isDeepStrictEqual(CloudQueueControlSchema.parse(JSON.parse(control.request)), input))
            throw Error('state_conflict');
          return CloudQueueReceiptSchema.parse(JSON.parse(control.receipt));
        }
        const items = await users(tx, id, owner, inbox.items), snapshot = capture(inbox.items);
        synchronize(state, snapshot);
        let applied = input.expectedVersion === state.version, submissionId: number | undefined;
        const action = input.action;
        if (applied) {
          if (action.kind === 'enqueue') {
            applied = !!options.activePhase && await options.activePhase(tx, id, owner, action.phaseRequestId);
            if (applied) {
              const requestId = queueSubmissionKey(owner.attemptId, input.controlRequestId);
              if (await tx.submissionByRequest(id, requestId)) throw Error('state_conflict');
              const submission = await tx.createSubmission({ type: 'input', conversationId: id, status: 'queued', requestId });
              submissionId = submission.id;
              inbox.items.push({ id: submission.id, mode: action.mode, content: action.content,
                entry: { kind: 'flowmate.queue-input', data: { ...owner, requestId: action.phaseRequestId,
                  controlRequestId: input.controlRequestId, submissionId: submission.id, inputText: action.content } } });
            }
          } else if (action.kind === 'reorder') {
            const ids = items.map(item => item.submissionId);
            applied = ids.length === action.submissionIds.length && action.submissionIds.every(value => ids.includes(value));
            if (applied) {
              const originals = new Map<number, InboxItem>(inbox.items.filter(item => item.mode !== 'write')
                .map(item => [item.id, JSON.parse(JSON.stringify(item)) as InboxItem]));
              let next = 0;
              for (let index = 0; index < inbox.items.length; index++) if (inbox.items[index]!.mode !== 'write')
                inbox.items[index] = originals.get(action.submissionIds[next++]!)!;
            }
          } else {
            const index = inbox.items.findIndex(item => item.id === action.submissionId && item.mode !== 'write');
            if (index < 0) applied = false;
            else {
              const item = inbox.items[index]!;
              if (item.mode === 'write') throw Error('state_conflict');
              if (action.kind === 'cancel') { inbox.items.splice(index, 1); tx.settleSubmission(item.id, { status: 'unanswered', reason: 'cloud-queue-cancelled' }); }
              else if (action.kind === 'edit') item.content = action.content;
              else item.mode = action.mode;
            }
          }
        }
        if (applied) { if (state.version >= Number.MAX_SAFE_INTEGER) throw Error('state_conflict'); state.version++; state.snapshot = capture(inbox.items); }
        const receipt = CloudQueueReceiptSchema.parse({ ...owner, controlRequestId: input.controlRequestId,
          status: applied ? 'applied' : 'conflict', version: state.version, ...(submissionId === undefined ? {} : { submissionId }) });
        control.request = JSON.stringify(input); control.receipt = JSON.stringify(receipt);
        return receipt;
      }, BACKGROUND_CONTEXT);
    }),
  };
}
