import { expect, it } from 'bun:test';
import { PersonalHistoryRequestSchema, PersonalHistoryPageSchema, PersonalHistoryEntrySchema } from '../../packages/contracts/src/personal-history.ts';
import { InvoiceWorkTimelinePageSchema, compareInvoiceWorkTimelineCursor } from '../../packages/contracts/src/invoice-work-timeline.ts';

const owner = { runtimeKind: 'durable', workId: 1, sessionId: 2, childRunId: null } as const;
const entry = { entryId: 5, kind: 'assistant', createdAt: null, role: 'assistant', preview: { text: '原票', truncated: true },
  byteLength: 200, format: 'pi-durable-entry/v1' } as const;

it('requires a saved watermark for continuation and rejects foreign native controls', () => {
  expect(PersonalHistoryRequestSchema.safeParse({ target: { workId: 1 }, beforeEntryId: 5 }).success).toBe(false);
  expect(PersonalHistoryRequestSchema.safeParse({ target: { workId: 1 }, throughEntryId: 6, beforeEntryId: 5 }).success).toBe(true);
  expect(PersonalHistoryRequestSchema.safeParse({ target: { workId: 1, nativeConversationId: 2 } }).success).toBe(false);
  expect(PersonalHistoryRequestSchema.safeParse({ target: { workId: 1 }, limit: 101 }).success).toBe(false);
});

it('checks native entry order, watermark, continuation and UTF-8 chunk accounting', () => {
  const page = { owner, throughEntryId: 6, entries: [entry], nextBeforeEntryId: 5 };
  expect(PersonalHistoryPageSchema.safeParse(page).success).toBe(true);
  expect(PersonalHistoryPageSchema.safeParse({ ...page, entries: [entry, entry] }).success).toBe(false);
  expect(PersonalHistoryPageSchema.safeParse({ ...page, throughEntryId: 4 }).success).toBe(false);
  expect(PersonalHistoryPageSchema.safeParse({ ...page, nextBeforeEntryId: 4 }).success).toBe(false);
  const chunk = { owner, throughEntryId: 6, entryId: 5, kind: 'assistant', format: 'pi-durable-entry/v1',
    offset: 0, totalBytes: 9, text: '原票', nextOffset: 6 };
  expect(PersonalHistoryEntrySchema.safeParse(chunk).success).toBe(true);
  expect(PersonalHistoryEntrySchema.safeParse({ ...chunk, nextOffset: 2 }).success).toBe(false);
  expect(PersonalHistoryEntrySchema.safeParse({ ...chunk, nextOffset: null }).success).toBe(false);
});

it('uses saved live-fact keys and rejects duplicate time-line facts or forged consumption', () => {
  const first = { occurredAt: '2026-10-29T00:00:00.000Z', sourceKind: 'attempt', sourceId: 3, kind: 'attempt_created',
    key: JSON.stringify(['attempt', 3, 'attempt_created']), workId: 1, itemId: null, summary: 'Attempt accepted.', refs: { attemptId: 3 },
    evidence: { resultRecorded: false, returnedToParent: false, parentConsumed: false, stopConfirmed: false } } as const;
  expect(compareInvoiceWorkTimelineCursor(first, { ...first, sourceId: 2 })).toBeGreaterThan(0);
  const page = { workId: 1, semantics: 'live-facts', entries: [first], nextBefore: null };
  expect(InvoiceWorkTimelinePageSchema.safeParse(page).success).toBe(true);
  expect(InvoiceWorkTimelinePageSchema.safeParse({ ...page, entries: [first, first] }).success).toBe(false);
  expect(InvoiceWorkTimelinePageSchema.safeParse({ ...page, entries: [{ ...first, workId: 2 }] }).success).toBe(false);
  expect(InvoiceWorkTimelinePageSchema.safeParse({ ...page, entries: [{ ...first, evidence: { ...first.evidence, parentConsumed: true } }] }).success).toBe(false);
});
