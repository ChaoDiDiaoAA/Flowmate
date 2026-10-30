import type { DbId, ProviderConfig, Result } from './runtime.ts';
import type { PersonalAgentConfiguration } from './personal-agent.ts';
import type { ToolEffect } from './tools.ts';
import { ProviderConfigSchema } from './schemas.ts';
import { z } from 'zod';
import type { DurableChildToolOwner, DurableSubagentIdentity, DurableSubagentObservation } from './durable-subagents.ts';
import type { PersonalHistoryRequest, PersonalHistoryPage, PersonalHistoryEntryRequest, PersonalHistoryEntry } from './personal-history.ts';
import type { DurableCompactionIdentity, DurableCompactionRequest, DurableCompactionObservation } from './durable-compaction.ts';

export type DurableConversationIdentity = { workId: DbId; sessionId: DbId };
export type DurableAttemptIdentity = DurableConversationIdentity & { attemptId: DbId };
export type DurableSubmissionQuery = DurableAttemptIdentity & { requestId: string };
/** Existing product tool schemas, projected by composition without native runtime types. */
export type DurableProductToolDefinition = { name: string; description: string; inputSchema: Record<string, unknown>;
  executionMode: 'parallel' | 'sequential'; effect?: ToolEffect };
export type DurableProductToolCall = DurableSubmissionQuery & { nativeConversationId: number; nativeTaskId: number;
  nativeToolCallId: string; name: string; arguments: unknown; child?: DurableChildToolOwner };
/** The exact committed native model message, including its envelope and diagnostics. */
export type DurableProductToolFeedback = DurableProductToolCall & { nativeEntryId: number; feedbackJson: string };
/** Credential-free, resolved facts; modelJson is interpreted only by the Durable adapter. */
export type DurableModelBinding = { version: 1; configuration: ProviderConfig; modelJson: string;
  request: { authHeader: boolean; headers: Record<string, string | null> } };
const sensitiveModelKeys = new Set(['authorization', 'proxyauthorization', 'apikey', 'accesskey', 'accesskeyid', 'secretaccesskey',
  'awsaccesskeyid', 'awssecretaccesskey', 'awssessiontoken', 'token', 'accesstoken', 'refreshtoken', 'idtoken', 'sessiontoken',
  'clientsecret', 'password', 'passwd', 'credential', 'credentials', 'cookie', 'setcookie', 'secret', 'privatekey']);
const sensitiveHeaderName = /authorization|cookie|api[-_]?key|token|secret|credential/i;
function safeModelHeaders(value: unknown): boolean {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.entries(value).every(([name, header]) => !sensitiveHeaderName.test(name)
      && (header === null || typeof header === 'string' && !header.startsWith('!') && !header.includes('$')));
}
function safeModelEndpoint(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash;
  } catch { return false; }
}
function hasNoModelCredentials(value: unknown): boolean {
  if (Array.isArray(value)) return value.every(hasNoModelCredentials);
  if (value === null || typeof value !== 'object') return true;
  return Object.entries(value).every(([name, nested]) => {
    const key = name.replace(/[-_]/g, '').toLowerCase();
    if (sensitiveModelKeys.has(key)) return false;
    if (['headers', 'requestheaders', 'extraheaders', 'defaultheaders', 'httpheaders'].includes(key) && !safeModelHeaders(nested)) return false;
    return hasNoModelCredentials(nested);
  });
}
function safeModelJson(text: string): boolean {
  try {
    const value: unknown = JSON.parse(text);
    return value !== null && typeof value === 'object' && !Array.isArray(value) && 'baseUrl' in value
      && safeModelEndpoint(value.baseUrl) && hasNoModelCredentials(value);
  } catch { return false; }
}
export const DurableModelBindingSchema: z.ZodType<DurableModelBinding, z.ZodTypeDef, unknown> = z.object({ version: z.literal(1),
  configuration: ProviderConfigSchema, modelJson: z.string().min(1).max(256 * 1024),
  request: z.object({ authHeader: z.boolean(), headers: z.record(z.string().max(256), z.string().max(8192).nullable()) }).strict(),
}).strict().refine(binding => new TextEncoder().encode(JSON.stringify(binding)).byteLength <= 256 * 1024,
  'The resolved model binding exceeds its storage limit.')
  .refine(binding => safeModelHeaders(binding.request.headers) && safeModelJson(binding.modelJson)
    && (!binding.configuration.connection || safeModelEndpoint(binding.configuration.connection.baseUrl)),
  'The resolved model binding contains unsafe endpoint or credential facts.');
export type DurableModelPreparation = DurableSubmissionQuery & { config: ProviderConfig };
export type DurableModelRestore = DurableSubmissionQuery & { binding: DurableModelBinding };
export type DurableSubmissionInput = DurableModelPreparation & { text: string; binding?: DurableModelBinding;
  thinkingLevel?: PersonalAgentConfiguration['thinkingLevel'] };
export type DurableConversationView = DurableConversationIdentity & { nativeConversationId: number };
export type DurableAttemptStopRequest = DurableAttemptIdentity & { stopGraceMs: number };
export type DurableAttemptStopResult = DurableAttemptIdentity & { stopped: boolean; reason: 'stopped' | 'not-started' | 'stop-unconfirmed' };
export type DurableHistoryQuery = DurableConversationIdentity & { limit?: number; beforeEntryId?: number };
/** Native record text for internal product projection; never a legacy SessionEntry. */
export type DurableHistoryEntryView = { nativeEntryId: number; kind: string; json: string };
export type DurableHistoryPage = DurableConversationView & { entries: readonly DurableHistoryEntryView[]; nextBeforeEntryId: number | null };
export type DurableHistoryOwner = DurableConversationIdentity & { child?: DurableSubagentIdentity };
export type DurablePublicHistoryQuery = DurableHistoryOwner & Omit<PersonalHistoryRequest, 'target'>;
export type DurablePublicHistoryEntryQuery = DurableHistoryOwner & Omit<PersonalHistoryEntryRequest, 'target'>;
export type DurableSubmissionView = DurableSubmissionQuery & {
  nativeConversationId: number;
  nativeSubmissionId: number;
  status: 'queued' | 'placed' | 'done' | 'unanswered';
  answer: string | null;
  reason: string | null;
};
/** Facts from the exact native input, successful model consumption and its owned execution scope. */
export type DurableSubmissionObservation = DurableSubmissionQuery & {
  nativeConversationId: number;
  nativeSubmissionId: number;
  nativeEntryId: number | null;
  status: DurableSubmissionView['status'];
  consumedAt: string | null;
  execution: 'active' | 'closed' | 'unknown';
};

/** Internal execution I/O. Business commands authorize attempts before crossing this port. */
export interface DurableRuntimePort {
  openConversation(input: DurableConversationIdentity): Promise<Result<DurableConversationView>>;
  prepareModel(input: DurableModelPreparation): Promise<Result<DurableModelBinding>>;
  restoreModel(input: DurableModelRestore): Promise<Result<void>>;
  submit(input: DurableSubmissionInput): Promise<Result<DurableSubmissionView>>;
  getSubmission(input: DurableSubmissionQuery): Promise<Result<DurableSubmissionView | null>>;
  observeSubmission(input: DurableSubmissionQuery): Promise<Result<DurableSubmissionObservation | null>>;
  observeSubagent(input: DurableSubagentIdentity): Promise<Result<DurableSubagentObservation | null>>;
  waitForSubmission(input: DurableSubmissionQuery): Promise<Result<DurableSubmissionView>>;
  stopAttempt(input: DurableAttemptStopRequest): Promise<Result<DurableAttemptStopResult>>;
  resumeAttempt(input: DurableAttemptIdentity): Promise<Result<void>>;
  queryHistory(input: DurableHistoryQuery): Promise<Result<DurableHistoryPage>>;
  queryHistoryPage(input: DurablePublicHistoryQuery): Promise<Result<PersonalHistoryPage>>;
  queryHistoryEntry(input: DurablePublicHistoryEntryQuery): Promise<Result<PersonalHistoryEntry>>;
  compact(input: DurableCompactionRequest): Promise<Result<DurableCompactionObservation>>;
  queryCompaction(input: DurableCompactionIdentity): Promise<Result<DurableCompactionObservation | null>>;
  cancelCompaction(input: DurableCompactionIdentity): Promise<Result<DurableCompactionObservation>>;
  close(): Promise<Result<void>>;
}
