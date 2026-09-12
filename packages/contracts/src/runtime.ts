/**
 * Runtime-facing contract entrypoint.
 *
 * The initial P0 implementation kept these schemas in execution.ts while the
 * package was being bootstrapped. Keep that compatibility path intact and
 * expose the canonical runtime boundary named by the project layout.
 */
export * from "./execution.js";

import { z } from "zod";
import { SchemaVersionSchema } from "./common.js";

/** Runtime scope owned by one parent or child Pi session. */
export const MemoryScopeSchema = z.object({
  scopeId: z.string().min(1),
  kind: z.enum(["parent", "child"]),
  jobId: z.string().min(1),
  runId: z.string().min(1),
  generation: z.number().int().nonnegative(),
  candidateId: z.string().min(1),
  parentScopeId: z.string().min(1).nullable(),
}).strict();
export type MemoryScope = z.infer<typeof MemoryScopeSchema>;

/** P0 deliberately disables automatic compaction and retry. */
export const MemoryPolicySchema = z.object({
  schemaVersion: SchemaVersionSchema,
  policyId: z.string().min(1),
  policyVersion: z.string().min(1),
  autoCompactionEnabled: z.literal(false),
  autoRetryEnabled: z.literal(false),
  maxContextTokens: z.number().int().positive().nullable(),
  unknownCapacity: z.enum(["allow", "stop"]),
  maxHistoryEntries: z.number().int().positive().nullable(),
}).strict();
export type MemoryPolicy = z.infer<typeof MemoryPolicySchema>;

export const MemoryCapacitySchema = z.object({
  state: z.enum(["known", "unknown", "exceeded"]),
  usedTokens: z.number().int().nonnegative().nullable(),
  limitTokens: z.number().int().positive().nullable(),
  remainingTokens: z.number().int().nonnegative().nullable(),
}).strict();
export type MemoryCapacity = z.infer<typeof MemoryCapacitySchema>;

export const MemoryStatusSchema = z.object({
  schemaVersion: SchemaVersionSchema,
  scope: MemoryScopeSchema,
  sessionId: z.string().min(1),
  policyId: z.string().min(1),
  policyVersion: z.string().min(1),
  autoCompactionEnabled: z.literal(false),
  autoRetryEnabled: z.literal(false),
  policyApplied: z.boolean(),
  capacity: MemoryCapacitySchema,
  historyEntries: z.number().int().nonnegative(),
  released: z.boolean(),
  limitations: z.array(z.string().min(1)),
}).strict();
export type MemoryStatus = z.infer<typeof MemoryStatusSchema>;

export const MemoryObservationSchema = z.object({
  schemaVersion: SchemaVersionSchema,
  scopeId: z.string().min(1),
  sessionId: z.string().min(1),
  entryId: z.string().min(1).nullable(),
  role: z.enum(["user", "assistant", "tool", "custom", "unknown"]),
  source: z.enum(["session-history", "session-context"]),
  text: z.string(),
  at: z.string().min(1).nullable(),
}).strict();
export type MemoryObservation = z.infer<typeof MemoryObservationSchema>;
