import { z } from 'zod';
import { appError, fail, MemoryEndpointSchema, ok, type Result } from '@flowmate/contracts';
import { verifyOpenVikingIdentity } from './identity.ts';

const name = z.string().min(1).max(128).refine(value => value !== '.' && value !== '..' && !/[\/\\\x00-\x1f\x7f]/.test(value));
const command = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('list') }).strict(),
  z.object({ operation: z.enum(['create', 'delete', 'members']), groupId: name }).strict(),
  z.object({ operation: z.enum(['add', 'remove']), groupId: name, userId: name }).strict(),
]);
const configuration = z.object({ endpoint: MemoryEndpointSchema, accountId: name, apiKey: z.string().min(1).max(16384)
  .refine(value => !/[\r\n]/.test(value)), role: z.literal('account-admin') }).strict();
type Command = z.infer<typeof command>;

export function createOpenVikingGroupAdmin(raw: z.infer<typeof configuration> & { fetch?: typeof fetch }) {
  const { fetch: transport = globalThis.fetch, ...settings } = raw;
  const config = configuration.parse(settings);
  const root = new URL(`/api/v1/admin/accounts/${encodeURIComponent(config.accountId)}/groups`, config.endpoint).href;
  return {
    async execute(input: Command): Promise<Result<unknown>> {
      const parsed = command.safeParse(input);
      if (!parsed.success) return fail(appError('input_invalid', 'input', 'The group request is invalid.'));
      const value = parsed.data, reading = value.operation === 'list' || value.operation === 'members';
      const group = 'groupId' in value ? `${root}/${encodeURIComponent(value.groupId)}` : root;
      const path = value.operation === 'create' ? root : value.operation === 'members' ? `${group}/members`
        : value.operation === 'add' || value.operation === 'remove' ? `${group}/members/${encodeURIComponent(value.userId)}` : group;
      const method = value.operation === 'create' ? 'POST' : reading ? 'GET' : value.operation === 'add' ? 'PUT' : 'DELETE';
      const unknown = () => fail(appError(reading ? 'openviking_unavailable' : 'operation_result_unknown', 'runtime',
        reading ? 'OpenViking group information is unavailable.' : 'The original group operation could not be confirmed.', true));
      try {
        const signal = AbortSignal.timeout(10000);
        if (!await verifyOpenVikingIdentity({ endpoint: config.endpoint, apiKey: config.apiKey, accountId: config.accountId,
          role: 'admin', fetch: transport, signal })) return unknown();
        const response = await transport(path, { method, redirect: 'error', signal,
          headers: { 'X-API-Key': config.apiKey, ...(value.operation === 'create' ? { 'Content-Type': 'application/json' } : {}) },
          ...(value.operation === 'create' ? { body: JSON.stringify({ group_id: value.groupId }) } : {}) });
        if (response.status >= 500) return unknown();
        const payload = await response.json() as unknown;
        const envelope = z.object({ status: z.string().optional(), result: z.unknown().optional(), error: z.unknown().optional() }).passthrough().safeParse(payload);
        if (!envelope.success) return unknown();
        if (!response.ok || envelope.data.status === 'error' || envelope.data.error != null)
          return fail(appError('openviking_request_failed', 'runtime', 'OpenViking rejected the group operation.', response.status >= 500));
        if (value.operation === 'list' ? !Array.isArray(envelope.data.result)
          : !envelope.data.result || typeof envelope.data.result !== 'object' || Array.isArray(envelope.data.result)) return unknown();
        return ok(envelope.data.result);
      } catch { return unknown(); }
    },
  };
}
