import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { appError, CloudNativeResultReceiptSchema, CloudNativeResultSchema, PersonalHistoryEntrySchema, fail, ok, type AppError, type CloudNativeResult,
  type CloudNativeResultReceipt, type DurableRuntimePort, type Result } from '@flowmate/contracts';
import type { DbHandle, SqlDatabaseStore } from '../packages/core/src/storage/database.ts';

class ReceiptFault extends Error { constructor(readonly detail: AppError) { super(detail.code); } }
function need<T>(value: Result<T>): T { if (!value.ok) throw new ReceiptFault(value.error); return value.data; }
function conflict(): never { throw new ReceiptFault(appError('cloud_result_conflict', 'runtime', 'The original native result does not match its saved facts.')); }
type Row = { receipt_id: string; event_json: string };

/** Authority records only the exact native terminal receipt; retries return its original receipt. */
export class CloudNativeResultReceiver {
  constructor(private readonly database: Pick<DbHandle, 'read' | 'transaction'>,
    private readonly runtime: Pick<DurableRuntimePort, 'getSubmission' | 'observeSubmission' | 'queryHistoryEntry'>, private readonly now: () => string) {}

  private owner(store: SqlDatabaseStore, event: CloudNativeResult): void {
    const row = store.db.query<{ session_id: number }, [number]>('SELECT session_id FROM invoice_works WHERE id=?').get(event.workId);
    const session = need(store.sessions.get(event.sessionId));
    if (!row || row.session_id !== event.sessionId || session.runtimeKind !== 'durable'
      || session.durableRuntimeId !== event.cloudRuntimeId || session.cloudWorkspaceId !== event.workspaceId) conflict();
    const phase = need(store.invoiceWorks.getPhase({ workId: event.workId, attemptId: event.attemptId, requestId: event.requestId }));
    const reviewer = phase && store.db.query('SELECT 1 FROM invoice_work_peer_reviews WHERE phase_id=? AND attempt_id=? AND work_id=? AND item_id=?')
      .get(phase.phaseId, event.attemptId, event.workId, phase.itemId);
    if ((event.participant === 'reviewer') !== Boolean(reviewer)) conflict();
    if (!phase || (phase.basis.executionMode === 'item-lane-approval-v1'
      ? phase.itemId === null || phase.itemId !== event.itemId
      : event.itemId !== undefined || session.durableConversationId !== event.nativeConversationId)
      || phase.nativeConversationId !== null && phase.nativeConversationId !== event.nativeConversationId
      || phase.nativeSubmissionId !== null && phase.nativeSubmissionId !== event.nativeSubmissionId) conflict();
  }

  private prior(store: SqlDatabaseStore, event: CloudNativeResult): CloudNativeResultReceipt | null {
    const row = store.db.query<Row, [string, number, number]>(`SELECT receipt_id,event_json FROM cloud_native_result_receipts
      WHERE durable_runtime_id=? AND native_conversation_id=? AND native_submission_id=?`)
      .get(event.cloudRuntimeId, event.nativeConversationId, event.nativeSubmissionId);
    if (!row) return null;
    if (!isDeepStrictEqual(CloudNativeResultSchema.parse(JSON.parse(row.event_json)), event)) conflict();
    return CloudNativeResultReceiptSchema.parse({ receiptId: row.receipt_id, cloudRuntimeId: event.cloudRuntimeId,
      workId: event.workId, sessionId: event.sessionId, ...(event.itemId === undefined ? {} : { itemId: event.itemId }),
      ...(event.participant ? { participant: event.participant } : {}),
      nativeConversationId: event.nativeConversationId, nativeSubmissionId: event.nativeSubmissionId });
  }

  async receive(raw: unknown): Promise<Result<CloudNativeResultReceipt>> {
    const parsed = CloudNativeResultSchema.safeParse(raw);
    if (!parsed.success) return fail(appError('input_invalid', 'input', 'The cloud native result is invalid.'));
    const event = parsed.data, query = { workId: event.workId, sessionId: event.sessionId,
      ...(event.itemId === undefined ? {} : { itemId: event.itemId }), ...(event.participant ? { participant: event.participant } : {}),
      attemptId: event.attemptId, requestId: event.requestId };
    try {
      const saved = await this.database.read(store => { this.owner(store, event); return this.prior(store, event); });
      if (saved) return ok(saved);
      const view = need(await this.runtime.getSubmission(query)), observed = need(await this.runtime.observeSubmission(query));
      if (!view || !observed || view.workId !== event.workId || observed.workId !== event.workId
        || view.sessionId !== event.sessionId || observed.sessionId !== event.sessionId
        || view.attemptId !== event.attemptId || observed.attemptId !== event.attemptId
        || view.requestId !== event.requestId || observed.requestId !== event.requestId
        || view.itemId !== event.itemId || observed.itemId !== event.itemId
        || view.participant !== event.participant || observed.participant !== event.participant
        || event.participant === 'reviewer' && event.status === 'done' && observed.nativeAnswerEntryId !== event.nativeAnswerEntryId
        || view.nativeConversationId !== event.nativeConversationId || view.nativeSubmissionId !== event.nativeSubmissionId
        || view.status !== event.status || view.answer !== event.answer || view.reason !== event.reason
        || observed.nativeConversationId !== event.nativeConversationId || observed.nativeSubmissionId !== event.nativeSubmissionId
        || observed.nativeEntryId !== event.nativeInputEntryId || observed.consumedAt !== event.consumedAt
        || observed.status !== event.status || observed.execution !== 'closed') conflict();
      const answerEntryId = event.nativeAnswerEntryId;
      if (answerEntryId !== null) {
        let offset = 0, total: number | undefined; const pieces: string[] = [];
        for (;;) {
          const entry = PersonalHistoryEntrySchema.parse(need(await this.runtime.queryHistoryEntry({ workId: event.workId, sessionId: event.sessionId,
            ...(event.itemId === undefined ? {} : { itemId: event.itemId }), ...(event.participant ? { participant: event.participant } : {}),
            entryId: answerEntryId, throughEntryId: answerEntryId, offset, limit: 16384 })));
          if (entry.owner.workId !== event.workId || entry.owner.sessionId !== event.sessionId || entry.owner.childRunId !== null
            || entry.owner.itemId !== event.itemId || entry.owner.participant !== event.participant
            || entry.entryId !== answerEntryId || entry.throughEntryId !== answerEntryId || entry.offset !== offset || entry.kind !== 'pi.assistant'
            || entry.totalBytes > 14 * 1024 * 1024 || total !== undefined && entry.totalBytes !== total) conflict();
          total = entry.totalBytes; pieces.push(entry.text);
          if (entry.nextOffset === null) break;
          offset = entry.nextOffset;
        }
        const native = JSON.parse(pieces.join(''));
        const message = native?.model?.find((item: { role?: string }) => item.role === 'assistant');
        if (native?.id !== answerEntryId || native?.conversationId !== event.nativeConversationId || message?.role !== 'assistant'
          || !Array.isArray(message.content) || message.content.filter((block: { type?: string }) => block.type === 'text')
            .map((block: { text?: string }) => block.text).join('') !== event.answer) conflict();
      }
      return await this.database.transaction(store => {
        this.owner(store, event); const existing = this.prior(store, event); if (existing) return ok(existing);
        const phase = need(store.invoiceWorks.getPhase({ workId: event.workId, attemptId: event.attemptId, requestId: event.requestId }));
        if (!phase) conflict();
        const at = z.string().datetime({ offset: true }).parse(this.now());
        need(store.invoiceWorks.linkPhase({ workId: event.workId, attemptId: event.attemptId, phaseId: phase.phaseId,
          nativeConversationId: event.nativeConversationId, nativeSubmissionId: event.nativeSubmissionId, at }));
        need(store.invoiceWorks.recordPhaseObservation({ observation: observed, at }));
        const receiptId = randomUUID();
        store.db.query(`INSERT INTO cloud_native_result_receipts(receipt_id,durable_runtime_id,work_id,attempt_id,native_conversation_id,
          native_submission_id,event_json,received_at) VALUES(?,?,?,?,?,?,?,?)`).run(receiptId, event.cloudRuntimeId, event.workId, event.attemptId,
          event.nativeConversationId, event.nativeSubmissionId, JSON.stringify(event), at);
        return ok(CloudNativeResultReceiptSchema.parse({ receiptId, cloudRuntimeId: event.cloudRuntimeId, workId: event.workId,
          sessionId: event.sessionId, ...(event.itemId === undefined ? {} : { itemId: event.itemId }),
          ...(event.participant ? { participant: event.participant } : {}),
          nativeConversationId: event.nativeConversationId, nativeSubmissionId: event.nativeSubmissionId }));
      });
    } catch (error) {
      return fail(error instanceof ReceiptFault ? error.detail
        : appError('cloud_result_unavailable', 'runtime', 'The original native result could not be confirmed.', true));
    }
  }
}
