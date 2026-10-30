import { z } from 'zod';
import type { Result } from './runtime.ts';

const id = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const position = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const bytes = (text: string) => new TextEncoder().encode(text).byteLength;
const format = z.literal('pi-durable-entry/v1');
export const PersonalHistoryTargetSchema = z.object({ workId: id, childRunId: id.optional() }).strict();
export type PersonalHistoryTarget = z.infer<typeof PersonalHistoryTargetSchema>;
export const PersonalHistoryOwnerSchema = z.object({ runtimeKind: z.literal('durable'), workId: id,
  sessionId: id, childRunId: id.nullable() }).strict();
export type PersonalHistoryOwner = z.infer<typeof PersonalHistoryOwnerSchema>;
export const PersonalHistoryRequestSchema = z.object({ target: PersonalHistoryTargetSchema,
  throughEntryId: position.optional(), beforeEntryId: id.optional(), limit: z.number().int().min(1).max(100).default(50),
}).strict().refine(value => value.beforeEntryId === undefined || value.throughEntryId !== undefined
  && value.beforeEntryId <= value.throughEntryId, 'A continuation needs its original watermark.');
export type PersonalHistoryRequest = z.input<typeof PersonalHistoryRequestSchema>;
export const PersonalHistorySummarySchema = z.object({ entryId: id, kind: z.string().min(1).max(256),
  createdAt: z.string().datetime({ offset: true }).nullable(), role: z.string().min(1).max(128).nullable(),
  preview: z.object({ text: z.string().refine(value => bytes(value) <= 1024), truncated: z.boolean() }).strict(),
  byteLength: position, format,
}).strict();
export const PersonalHistoryPageSchema = z.object({ owner: PersonalHistoryOwnerSchema, throughEntryId: position,
  entries: z.array(PersonalHistorySummarySchema).max(100), nextBeforeEntryId: id.nullable(),
}).strict().refine(value => value.entries.every((entry, index) => entry.entryId <= value.throughEntryId
  && (index === 0 || entry.entryId < value.entries[index - 1]!.entryId))
  && (value.nextBeforeEntryId === null || value.entries.length > 0 && value.nextBeforeEntryId === value.entries.at(-1)!.entryId),
  'History order or watermark disagrees.').refine(value => bytes(JSON.stringify(value)) <= 262_144);
export type PersonalHistoryPage = z.infer<typeof PersonalHistoryPageSchema>;
export const PersonalHistoryEntryRequestSchema = z.object({ target: PersonalHistoryTargetSchema,
  entryId: id, throughEntryId: position, offset: position.default(0), limit: z.number().int().min(1).max(16384).default(16384),
}).strict().refine(value => value.entryId <= value.throughEntryId, 'The entry is outside the captured history.');
export type PersonalHistoryEntryRequest = z.input<typeof PersonalHistoryEntryRequestSchema>;
export const PersonalHistoryEntrySchema = z.object({ owner: PersonalHistoryOwnerSchema, throughEntryId: position,
  entryId: id, kind: z.string().min(1).max(256), format, offset: position, totalBytes: position,
  text: z.string().refine(value => bytes(value) <= 16384), nextOffset: position.nullable(),
}).strict().refine(value => {
  const end = value.offset + bytes(value.text);
  return value.entryId <= value.throughEntryId && end <= value.totalBytes
    && (value.nextOffset === null ? end === value.totalBytes : value.nextOffset === end && end > value.offset && end < value.totalBytes);
}, 'History chunk byte positions disagree.');
export type PersonalHistoryEntry = z.infer<typeof PersonalHistoryEntrySchema>;

/** Native history is a separate read surface; it never implies permission to resume execution. */
export interface PersonalHistoryApi {
  history(input: PersonalHistoryRequest): Promise<Result<PersonalHistoryPage>>;
  historyEntry(input: PersonalHistoryEntryRequest): Promise<Result<PersonalHistoryEntry>>;
}
