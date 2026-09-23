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
    | { type: 'host_state'; state: Partial<Omit<DesktopState, 'modelCredentials'>> & Pick<DesktopState, 'version' | 'ready' | 'host' | 'appVersion' | 'userDataPath'> };
};

export type HostOutput = HostReady | HostResponse | HostEvent;

export function parseHostCommand(value: unknown): HostCommand | null {
  const parsed = hostCommandSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}
