import { z } from 'zod';
import type { DesktopState } from '@flowmate/contracts';

const requestId = z.string().min(1).max(128);
const modelId = z.string().regex(/^[a-zA-Z0-9._-]{1,64}$/);

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
  z.object({ version: z.literal(1), requestId, type: z.literal('create_session'), title: z.string().trim().min(1).max(120).optional() }).strict(),
  z.object({
    version: z.literal(1), requestId, type: z.literal('list_sessions'),
    limit: z.number().int().min(1).max(100).optional(),
    before: z.object({ updatedAt: z.string().datetime({ offset: true }), sessionId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER) }).strict().optional(),
  }).strict(),
  z.object({ version: z.literal(1), requestId, type: z.literal('query_session'), sessionId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER) }).strict(),
  z.object({
    version: z.literal(1), requestId, type: z.literal('list_session_runs'),
    sessionId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    beforeRunId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
    limit: z.number().int().min(1).max(100).optional(),
  }).strict(),
  z.object({ version: z.literal(1), requestId, type: z.literal('query_runtime_state') }).strict(),
  z.object({
    version: z.literal(1), requestId, type: z.literal('start_agent_run'),
    input: z.object({
      sessionId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
      text: z.string().min(1).max(65_536), modelId,
      timeoutMs: z.number().int().min(100).max(120_000).optional(),
    }).strict(),
    apiKey: z.string().min(1).max(4096),
  }).strict(),
  z.object({ version: z.literal(1), requestId, type: z.literal('cancel_run'), runId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER) }).strict(),
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
    | { type: 'agent_observation'; requestId: string; event: import('@flowmate/contracts').AgentRunEvent }
    | { type: 'agent_finished'; requestId: string; event: Extract<import('@flowmate/contracts').AgentRunEvent, { type: 'run_finished' }> }
    | { type: 'host_state'; state: Partial<Omit<DesktopState, 'modelCredentials'>> & Pick<DesktopState, 'version' | 'ready' | 'host' | 'appVersion' | 'userDataPath'> };
};

export type HostOutput = HostReady | HostResponse | HostEvent;

export function parseHostCommand(value: unknown): HostCommand | null {
  const parsed = hostCommandSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}
