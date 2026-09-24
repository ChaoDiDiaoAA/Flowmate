import { z } from 'zod';
import type { AgentRunEvent, DesktopState } from '@flowmate/contracts';

const requestId = z.string().min(1).max(128);
const modelId = z.string().regex(/^[a-zA-Z0-9._-]{1,64}$/);
const dbId = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const pageLimit = z.number().int().min(1).max(100);
const sessionTitle = z.string().trim().min(1).refine((value) => [...value].length <= 120 && new TextEncoder().encode(value).byteLength <= 480);
const credentialRef = z.string().regex(/^[a-zA-Z0-9_-]{16,80}$/);
const boundedText = z.string().refine((value) => new TextEncoder().encode(value).byteLength <= 65_536);

const hostCommandSchema = z.discriminatedUnion('type', [
  z.object({ version: z.literal(1), requestId, type: z.literal('get_state') }).strict(),
  z.object({ version: z.literal(1), requestId, type: z.literal('save_settings'), settings: z.unknown() }).strict(),
  z.object({
    version: z.literal(1), requestId, type: z.literal('call_provider'),
    input: z.object({
      goal: z.string().min(1).max(4096), text: z.string().max(65_536), modelId,
      timeoutMs: z.number().int().min(100).max(120_000).optional(),
    }).strict(),
    apiKey: z.string().min(1).max(4096),
  }).strict(),
  z.object({ version: z.literal(1), requestId, type: z.literal('cancel_provider'), targetRequestId: requestId }).strict(),
  z.object({ version: z.literal(1), requestId, type: z.literal('query_run'), runId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER) }).strict(),
  z.object({ version: z.literal(1), requestId, type: z.literal('create_session'), input: z.object({ title: sessionTitle.optional() }).strict() }).strict(),
  z.object({
    version: z.literal(1), requestId, type: z.literal('list_sessions'),
    input: z.object({
      limit: pageLimit.optional(),
      before: z.object({ updatedAt: z.string().datetime({ offset: true }), sessionId: dbId }).strict().optional(),
    }).strict(),
  }).strict(),
  z.object({ version: z.literal(1), requestId, type: z.literal('query_session'), sessionId: dbId }).strict(),
  z.object({
    version: z.literal(1), requestId, type: z.literal('list_session_runs'),
    input: z.object({ sessionId: dbId, beforeRunId: dbId.optional(), limit: pageLimit.optional() }).strict(),
  }).strict(),
  z.object({ version: z.literal(1), requestId, type: z.literal('query_prompt_trace'), runId: dbId, callSequence: dbId.optional() }).strict(),
  z.object({
    version: z.literal(1), requestId, type: z.literal('start_run'),
    input: z.object({
      sessionId: dbId,
      text: boundedText,
      modelId,
      timeoutMs: z.number().int().min(100).max(120_000).optional(),
    }).strict(),
    apiKey: z.string().min(1).max(4096),
    expectedSettingsRevision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    expectedCredentialRef: credentialRef,
  }).strict(),
  z.object({ version: z.literal(1), requestId, type: z.literal('cancel_run'), runId: dbId }).strict(),
  z.object({ version: z.literal(1), requestId, type: z.literal('query_runtime_state') }).strict(),
  z.object({ version: z.literal(1), requestId, type: z.literal('close') }).strict(),
]);

export type HostCommand = z.infer<typeof hostCommandSchema>;

export type HostReady = {
  version: 1;
  type: 'ready';
  state: Partial<Omit<DesktopState, 'modelCredentials'>> & Pick<DesktopState, 'version' | 'ready' | 'host' | 'appVersion' | 'userDataPath'>;
};

export type HostResponse = { version: 1; type: 'response'; requestId: string; value: unknown };

export type HostEvent = {
  version: 1;
  type: 'event';
  event:
    | { type: 'provider_observation'; requestId: string; runId: number; sequence: number; observation: string; at: string; data: Readonly<Record<string, unknown>> }
    | { type: 'provider_finished'; requestId: string; runId: number; result: unknown }
    | { type: 'host_state'; state: Partial<Omit<DesktopState, 'modelCredentials'>> & Pick<DesktopState, 'version' | 'ready' | 'host' | 'appVersion' | 'userDataPath'> }
    | { type: 'agent_run_event'; requestId: string; value: AgentRunEvent };
};

export type HostOutput = HostReady | HostResponse | HostEvent;

export function parseHostCommand(value: unknown): HostCommand | null {
  const parsed = hostCommandSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}
