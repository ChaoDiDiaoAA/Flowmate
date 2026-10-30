import { z } from 'zod';
import { RuntimeBudgetOverridesSchema } from './runtime.ts';
import { RUNTIME_CONFIG } from './runtime-config.ts';
import { RegisteredToolNameSchema } from './tools.ts';
import { ResourceSelectionSchema } from './resources.ts';
import { ExtensionSelectionSchema } from './extensions.ts';
import { SUBAGENT_ROLE, SUBAGENT_TOOL_NAMES } from './subagents.ts';

const id = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const revision = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const workIdentity = { workId: id, attemptId: id };
const bounded = <Schema extends z.ZodTypeAny>(schema: Schema) => schema.refine(value =>
  new TextEncoder().encode(JSON.stringify(value)).byteLength <= 262_144, 'Durable Run facts exceed the public byte limit.');

export const DurableRuntimeBudgetSchema = RuntimeBudgetOverridesSchema.required().extend({
  maxToolFeedbackBytes: z.number().int().positive().max(RUNTIME_CONFIG.runBudget.maxToolFeedbackBytes),
}).strict().readonly();
export type DurableRuntimeBudget = z.infer<typeof DurableRuntimeBudgetSchema>;
const limits = z.object({
  timeoutMs: z.number().int().min(RUNTIME_CONFIG.ranges.timeoutMs.min).max(RUNTIME_CONFIG.ranges.timeoutMs.max),
  stopGraceMs: z.number().int().min(RUNTIME_CONFIG.ranges.stopGraceMs.min).max(RUNTIME_CONFIG.ranges.stopGraceMs.max),
}).strict().readonly();
const budgetFields = { runtimeBudget: DurableRuntimeBudgetSchema, limits };
export const DurableWorkBudgetSchema = z.object(budgetFields).strict().readonly();
export type DurableWorkBudget = z.infer<typeof DurableWorkBudgetSchema>;

const modelRef = z.object({ provider: z.string().trim().min(1).max(128), model: z.string().trim().min(1).max(128) }).strict().readonly();
const safeEndpoint = z.string().url().max(2048).refine(value => {
  try {
    const url = new URL(value);
    return !url.username && !url.password && !url.search && !url.hash;
  } catch { return false; }
}, 'The recorded endpoint must not contain credentials or request parameters.');

export const DurableRunConfigSnapshotSchema = bounded(z.object({
  version: z.literal(3), runtimeKind: z.literal('durable'),
  name: z.string().trim().min(1).max(128), revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  requestedModel: modelRef, resolvedModel: modelRef.nullable(),
  api: z.string().min(1).max(80).nullable(), endpoint: safeEndpoint.nullable(),
  sdk: z.object({ durable: z.string().min(1).max(32), ai: z.string().min(1).max(32), chord: z.string().min(1).max(32) }).strict().readonly(),
  parameters: z.object({
    maxRetries: z.number().int().min(RUNTIME_CONFIG.ranges.maxRetries.min).max(RUNTIME_CONFIG.ranges.maxRetries.max),
    maxRetryDelayMs: z.number().int().min(RUNTIME_CONFIG.ranges.maxRetryDelayMs.min).max(RUNTIME_CONFIG.ranges.maxRetryDelayMs.max),
  }).strict().readonly(),
  ...budgetFields,
  durable: z.object({ ...workIdentity, configurationRevision: revision }).strict().readonly(),
  resources: ResourceSelectionSchema, extensions: ExtensionSelectionSchema,
  workingDirectory: z.string().min(1).max(4096).nullable(),
}).strict()).readonly();
export type DurableRunConfigSnapshot = z.infer<typeof DurableRunConfigSnapshotSchema>;

export const DurableRunScopeSchema = bounded(z.object({
  version: z.literal(4), ...workIdentity,
  allowedTools: z.array(RegisteredToolNameSchema).refine(values => new Set(values).size === values.length, 'Tools must be unique.').readonly(),
}).strict()).readonly();
export type DurableRunScope = z.infer<typeof DurableRunScopeSchema>;

const outputText = z.string().refine(value => new TextEncoder().encode(value).byteLength <= RUNTIME_CONFIG.llmPayload.maxOutputTextBytes,
  'Durable Run output exceeds its byte limit.');
export const DurableRunOutputSchema = z.object({
  version: z.literal(3), text: outputText, partial: z.boolean(), stopReason: z.string().min(1).max(256),
  responseId: z.string().max(1024).nullable(), responseModel: z.string().max(1024).nullable(),
  durable: z.object(workIdentity).strict().readonly(),
}).strict().readonly();
export type DurableRunOutput = z.infer<typeof DurableRunOutputSchema>;

const childOrigin = {
  parentRunId: id, originToolCallId: id, phaseId: id, itemId: id,
  parentRequestId: z.string().min(1).max(128), role: z.literal(SUBAGENT_ROLE),
};
/** Native child executions share product provenance, with no plugin or JSONL identity. */
export const DurableSubagentConfigSnapshotSchema = bounded(DurableRunConfigSnapshotSchema.unwrap().innerType().extend({
  version: z.literal(4), subagent: z.object(childOrigin).strict().readonly(),
}).strict()).readonly();
export type DurableSubagentConfigSnapshot = z.infer<typeof DurableSubagentConfigSnapshotSchema>;
export const DurableSubagentRunScopeSchema = bounded(z.object({
  version: z.literal(5), ...workIdentity, ...childOrigin,
  allowedTools: z.array(RegisteredToolNameSchema).refine(names => new Set(names).size === names.length
    && names.every(name => (SUBAGENT_TOOL_NAMES as readonly string[]).includes(name)), 'Children use only the existing read-only role tools.').readonly(),
  allowedDocumentIds: z.array(id).refine(ids => new Set(ids).size === ids.length).readonly(),
  allowedArtifactIds: z.array(id).refine(ids => new Set(ids).size === ids.length).readonly(),
  allowedResourcePaths: z.array(z.string().min(1).max(4096)).refine(paths => new Set(paths).size === paths.length).readonly(),
}).strict()).readonly();
export type DurableSubagentRunScope = z.infer<typeof DurableSubagentRunScopeSchema>;
export const DurableSubagentRunOutputSchema = DurableRunOutputSchema.unwrap().extend({
  version: z.literal(4), subagent: z.object(childOrigin).strict().readonly(),
}).strict().readonly();
export type DurableSubagentRunOutput = z.infer<typeof DurableSubagentRunOutputSchema>;
