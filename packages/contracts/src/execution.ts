import { z } from "zod";
import { AssetRefSchema, SchemaVersionSchema } from "./common.js";

export const RunIdentitySchema = z.object({
  jobId: z.string().min(1), runId: z.string().min(1), generation: z.number().int().nonnegative(), candidateId: z.string().min(1),
}).strict();
export type RunIdentity = z.infer<typeof RunIdentitySchema>;

export const RunStatusSchema = z.enum(["created", "running", "cancelling", "succeeded", "failed", "cancelled", "interrupted"]);
export type RunStatus = z.infer<typeof RunStatusSchema>;
export const CleanupStatusSchema = z.enum(["pending", "complete", "incomplete"]);
export type CleanupStatus = z.infer<typeof CleanupStatusSchema>;

export const ToolResultSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), value: z.unknown(), evidence: z.array(AssetRefSchema) }).strict(),
  z.object({ ok: z.literal(false), error: z.object({ code: z.string().min(1), retryable: z.boolean(), message: z.string().min(1) }).strict() }).strict(),
]);
export type ToolResult<T> = { ok: true; value: T; evidence: z.infer<typeof AssetRefSchema>[] } | { ok: false; error: { code: string; retryable: boolean; message: string } };

export const RuntimeEventSchema = RunIdentitySchema.extend({
  schemaVersion: SchemaVersionSchema,
  eventId: z.string().min(1), seq: z.number().int().nonnegative(), at: z.string().datetime({ offset: true }),
  sessionId: z.string().min(1).nullable(), delegationId: z.string().min(1).nullable(),
  type: z.string().min(1), payloadRef: AssetRefSchema.nullable(),
}).strict();
export type RuntimeEvent = z.infer<typeof RuntimeEventSchema>;
