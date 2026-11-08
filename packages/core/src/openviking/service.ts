import { OpenVikingClient, isOpenVikingError } from '@openviking/sdk';
import { z } from 'zod';
import { appError, fail, ok, MemoryEndpointSchema, type MemoryRecallItem, type MemoryRecallResult, type Result } from '@flowmate/contracts';
import { verifyOpenVikingIdentity } from './identity.ts';

const identity = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-][A-Za-z0-9._-]*$/);
const config = z.object({ endpoint: MemoryEndpointSchema, apiKey: z.string().min(1).max(16384),
  owner: z.object({ accountId: identity, userId: identity, peerId: identity }).strict() }).strict();
const request = z.object({ query: z.string().trim().min(1).max(500), timeoutMs: z.number().int().min(1).max(2000),
  allowedEntries: z.array(z.object({ uri: z.string().min(1).max(4096), revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    approvedContent: z.string().min(1).refine(value => new TextEncoder().encode(value).byteLength <= 65000) }).strict()) }).strict();
type AllowedEntry = z.infer<typeof request>['allowedEntries'][number];
const hit = z.object({ uri: z.string().min(1).max(4096), abstract: z.string().optional(), content: z.string().optional() }).passthrough();
const response = z.object({ memories: z.array(hit).optional(), resources: z.array(z.unknown()).optional(),
  skills: z.array(z.unknown()).optional(), total: z.number().int().nonnegative().optional() }).passthrough();
const encoder = new TextEncoder();
const sessionId = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/);
const mirrorMessage = z.object({ role: z.enum(['user', 'assistant']), content: z.string().min(1)
  .refine(value => encoder.encode(value).byteLength <= 65000), sourceMessageIds: z.array(z.string().min(1).max(128)).min(1).max(16),
  turnId: z.string().min(1).max(128) }).strict();

function allowedUri(value: string, roots: readonly string[]): boolean {
  try {
    const url = new URL(value);
    if (url.protocol !== 'viking:' || url.hostname !== 'user' || url.username || url.password || url.port || url.search || value.includes('#')) return false;
    const parts = url.pathname.split('/').slice(1).map(part => decodeURIComponent(part));
    if (parts.some(part => !part || part === '.' || part === '..' || /[\\/\x00-\x1f\x7f]/.test(part))) return false;
    const canonical = `viking://user/${parts.join('/')}`;
    return roots.some(root => canonical === root || canonical.startsWith(root + '/'));
  } catch { return false; }
}

function clipped(value: string, budget: number): { content: string; bytes: number; truncated: boolean } {
  let content = '', bytes = 0;
  for (const character of value) {
    const size = encoder.encode(character).byteLength;
    if (bytes + size > budget) return { content, bytes, truncated: true };
    content += character; bytes += size;
  }
  return { content, bytes, truncated: false };
}

export function createOpenVikingService(raw: { endpoint: string; apiKey: string; owner: { accountId: string; userId: string; peerId: string }; fetch?: typeof fetch; signal?: AbortSignal }) {
  const parsed = config.parse({ endpoint: raw.endpoint, apiKey: raw.apiKey, owner: raw.owner });
  const roots = [`viking://user/${parsed.owner.userId}/memories`, `viking://user/${parsed.owner.userId}/peers/${parsed.owner.peerId}/memories`];
  const transport = raw.fetch ?? globalThis.fetch;
  const baseFetch = async (url: RequestInfo | URL, init?: RequestInit) => {
    if (!await verifyOpenVikingIdentity({ endpoint: parsed.endpoint, apiKey: parsed.apiKey, accountId: parsed.owner.accountId,
      userId: parsed.owner.userId, role: 'user', fetch: transport, signal: init?.signal })) throw Error('memory_identity_unavailable');
    return transport(url, { ...init, redirect: 'error' });
  };
  async function limitedFetch(url: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const reply = await baseFetch(url, init);
    if (!reply.body || !reply.ok) return reply;
    const reader = reply.body.getReader(), chunks: Uint8Array[] = []; let total = 0;
    while (true) {
      const next = await reader.read(); if (next.done) break;
      total += next.value.byteLength; if (total > 300000) { await reader.cancel(); throw Error('memory_response_too_large'); }
      chunks.push(next.value);
    }
    const bytes = new Uint8Array(total); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return new Response(bytes, { status: reply.status, statusText: reply.statusText, headers: reply.headers });
  }
  function readClient(signal: AbortSignal, timeout: number): OpenVikingClient {
    return new OpenVikingClient({ baseUrl: parsed.endpoint, apiKey: parsed.apiKey, actorPeerId: parsed.owner.peerId, timeout,
      fetch: ((url: RequestInfo | URL, init?: RequestInit) => limitedFetch(url, { ...init,
        signal: init?.signal ? AbortSignal.any([signal, init.signal]) : signal })) as typeof fetch });
  }
  const originalSession = (id: string, value: Record<string, unknown>): boolean => {
    const user = z.object({ account_id: z.string(), user_id: z.string() }).passthrough().safeParse(value.user);
    return value.session_id === id && value.uri === `viking://user/${parsed.owner.userId}/sessions/${id}`
      && value.auto_commit_policy === null && user.success && user.data.account_id === parsed.owner.accountId && user.data.user_id === parsed.owner.userId;
  };
  async function verifyMirrorSession(id: string): Promise<boolean> {
    try {
      const client = new OpenVikingClient({ baseUrl: parsed.endpoint, apiKey: parsed.apiKey, actorPeerId: parsed.owner.peerId, timeout: 10000,
        fetch: ((url: RequestInfo | URL, init?: RequestInit) => baseFetch(url, { ...init,
          signal: raw.signal && init?.signal ? AbortSignal.any([raw.signal, init.signal]) : raw.signal ?? init?.signal })) as typeof fetch });
      return originalSession(id, await client.getSession(id));
    } catch { return false; }
  }
  async function mirrorWrite(path: string, body: object): Promise<Result<Record<string, unknown>>> {
    const unknown = () => fail(appError('operation_result_unknown', 'runtime', 'The original OpenViking write could not be confirmed.', true));
    try {
      const reply = await baseFetch(new URL(path, parsed.endpoint), { method: 'POST', signal: raw.signal ? AbortSignal.any([raw.signal, AbortSignal.timeout(10000)]) : AbortSignal.timeout(10000),
        headers: { 'X-API-Key': parsed.apiKey, 'X-OpenViking-Actor-Peer': parsed.owner.peerId, 'Content-Type': 'application/json' },
        body: JSON.stringify(body) });
      if (reply.status >= 500) return unknown();
      const envelope = z.object({ status: z.string().optional(), result: z.record(z.unknown()).optional(), error: z.unknown().optional() })
        .passthrough().safeParse(await reply.json());
      if (!envelope.success) return unknown();
      if (!reply.ok || envelope.data.status === 'error' || envelope.data.error != null)
        return fail(appError('openviking_request_failed', 'runtime', 'OpenViking rejected the original write.'));
      return envelope.data.result ? ok(envelope.data.result) : unknown();
    } catch { return unknown(); }
  }
  return {
    verifyMirrorSession,
    async memoryItemAbsent(uri: string): Promise<boolean> {
      if (roots.includes(uri) || !allowedUri(uri, roots)) return false;
      const timeout = AbortSignal.timeout(10000);
      try {
        await readClient(raw.signal ? AbortSignal.any([raw.signal, timeout]) : timeout, 10000).stat(uri);
      } catch (error) {
        return isOpenVikingError(error, 'NOT_FOUND') && error.statusCode === 404;
      }
      return false;
    },
    async removeMemoryItem(uri: string): Promise<Result<void>> {
      if (roots.includes(uri) || !allowedUri(uri, roots)) return fail(appError('input_invalid', 'input', 'The original memory URI is invalid.'));
      const unknown = () => fail(appError('operation_result_unknown', 'runtime', 'The original memory deletion could not be confirmed.', true));
      try {
        const url = new URL('/api/v1/fs', parsed.endpoint);
        url.searchParams.set('uri', uri); url.searchParams.set('recursive', 'false'); url.searchParams.set('wait', 'true');
        const reply = await limitedFetch(url, { method: 'DELETE', headers: { 'X-API-Key': parsed.apiKey,
          'X-OpenViking-Actor-Peer': parsed.owner.peerId }, signal: raw.signal ? AbortSignal.any([raw.signal, AbortSignal.timeout(10000)]) : AbortSignal.timeout(10000) });
        if (!reply.ok) return unknown();
        const checked = z.object({ status: z.literal('ok'), result: z.object({ uri: z.string(), semantic_status: z.string().optional() }).passthrough() })
          .passthrough().safeParse(await reply.json());
        return checked.success && checked.data.result.uri === uri
          && (checked.data.result.semantic_status === undefined || checked.data.result.semantic_status === 'complete') ? ok(undefined) : unknown();
      } catch { return unknown(); }
    },
    async readMemoryItem(uri: string): Promise<Result<string>> {
      if (roots.includes(uri) || !allowedUri(uri, roots))
        return fail(appError('input_invalid', 'input', 'The original memory URI is invalid.'));
      const abort = new AbortController(), timer = setTimeout(() => abort.abort(), 10000);
      try { return ok(await readClient(raw.signal ? AbortSignal.any([abort.signal, raw.signal]) : abort.signal, 10000).read(uri, 0, -1)); }
      catch { return fail(appError('openviking_unavailable', 'runtime', 'The original memory could not be read.', true)); }
      finally { clearTimeout(timer); }
    },
    async createMemoryItem(uri: string, content: string): Promise<Result<{ contentConfirmed: true; indexComplete: boolean }>> {
      const roots = [`viking://user/${parsed.owner.userId}/memories`];
      if (!allowedUri(uri, roots) || !content.trim() || encoder.encode(content).byteLength > 65000)
        return fail(appError('input_invalid', 'input', 'The original memory content is invalid.'));
      const unknown = () => fail(appError('operation_result_unknown', 'runtime', 'The original memory write could not be confirmed.', true));
      const abort = new AbortController(), timer = setTimeout(() => abort.abort(), 10000);
      try {
        const client = readClient(raw.signal ? AbortSignal.any([abort.signal, raw.signal]) : abort.signal, 10000);
        const written = await client.write(uri, content, { mode: 'create', wait: true });
        if (written.uri !== uri || written.context_type !== 'memory' || written.mode !== 'create' || written.content_updated !== true) return unknown();
        return await client.read(uri, 0, -1) === content
          ? ok({ contentConfirmed: true, indexComplete: written.vector_status === 'complete' }) : unknown();
      } catch { return unknown(); }
      finally { clearTimeout(timer); }
    },
    async verifyRecall(items: MemoryRecallItem[], allowedEntries: AllowedEntry[], timeoutMs: number): Promise<Result<MemoryRecallResult>> {
      const checked = request.safeParse({ query: 'verify', timeoutMs, allowedEntries });
      if (!checked.success) return fail(appError('input_invalid', 'input', 'The original memory verification is invalid.'));
      const abort = new AbortController(), timer = setTimeout(() => abort.abort(), timeoutMs);
      try {
        const client = readClient(raw.signal ? AbortSignal.any([abort.signal, raw.signal]) : abort.signal, timeoutMs);
        for (const item of items) {
          const entry = checked.data.allowedEntries.find(value => value.uri === item.uri && value.revision === item.revision);
          if (!entry || !allowedUri(item.uri, roots) || await client.read(item.uri, 0, -1) !== entry.approvedContent)
            return ok({ status: 'unavailable', items: [] });
        }
        return ok({ status: 'ready', items });
      } catch { return ok({ status: 'unavailable', items: [] }); }
      finally { clearTimeout(timer); }
    },
    async readMirrorMessages(id: string): Promise<Result<string>> {
      if (!sessionId.safeParse(id).success) return fail(appError('input_invalid', 'input', 'The original memory Session is invalid.'));
      const unavailable = () => fail(appError('openviking_unavailable', 'runtime', 'The original memory messages could not be read.', true));
      try {
        if (!await verifyMirrorSession(id)) return unavailable();
        const url = new URL('/api/v1/content/read', parsed.endpoint);
        url.searchParams.set('uri', `viking://user/${parsed.owner.userId}/sessions/${id}/messages.jsonl`);
        url.searchParams.set('offset', '0'); url.searchParams.set('limit', '-1'); url.searchParams.set('raw', 'true');
        const response = await baseFetch(url, { headers: { 'X-API-Key': parsed.apiKey, 'X-OpenViking-Actor-Peer': parsed.owner.peerId },
          signal: raw.signal ? AbortSignal.any([raw.signal, AbortSignal.timeout(10000)]) : AbortSignal.timeout(10000) });
        if (!response.ok || !response.body) return unavailable();
        const reader = response.body.getReader(), chunks: Uint8Array[] = []; let total = 0;
        while (true) {
          const next = await reader.read(); if (next.done) break;
          total += next.value.byteLength; if (total > 1_000_000) { await reader.cancel(); return unavailable(); }
          chunks.push(next.value);
        }
        const bytes = new Uint8Array(total); let offset = 0;
        for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
        const payload = z.object({ status: z.literal('ok'), result: z.string() }).passthrough()
          .safeParse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
        return payload.success ? ok(payload.data.result) : unavailable();
      } catch { return unavailable(); }
    },
    async readMirrorDiff(id: string, uri: string): Promise<Result<{ adds: Array<{ uri: string; after: string }>; changed: string[] }>> {
      const unavailable = () => fail(appError('openviking_unavailable', 'runtime', 'The original memory extraction could not be verified.', true));
      const root = `viking://user/${parsed.owner.userId}/sessions/${id}/history/`;
      if (!sessionId.safeParse(id).success || !uri.startsWith(root) || !/^archive_[0-9]+\/memory_diff\.json$/.test(uri.slice(root.length)))
        return fail(appError('input_invalid', 'input', 'The original memory extraction URI is invalid.'));
      try {
        if (!await verifyMirrorSession(id)) return unavailable();
        const url = new URL('/api/v1/content/read', parsed.endpoint);
        url.searchParams.set('uri', uri); url.searchParams.set('offset', '0'); url.searchParams.set('limit', '-1'); url.searchParams.set('raw', 'true');
        const reply = await limitedFetch(url, { headers: { 'X-API-Key': parsed.apiKey, 'X-OpenViking-Actor-Peer': parsed.owner.peerId },
          signal: raw.signal ? AbortSignal.any([raw.signal, AbortSignal.timeout(10000)]) : AbortSignal.timeout(10000) });
        if (!reply.ok) return unavailable();
        const envelope = z.object({ status: z.literal('ok'), result: z.string() }).passthrough().parse(await reply.json());
        const item = z.object({ uri: z.string().min(1).max(4096) }).passthrough();
        const diff = z.object({ archive_uri: z.string(), operations: z.object({
          adds: z.array(item.extend({ after: z.string().min(1).refine(value => encoder.encode(value).byteLength <= 65000) })).max(128),
          updates: z.array(item).max(128), deletes: z.array(item).max(128),
        }).passthrough() }).passthrough().parse(JSON.parse(envelope.result));
        const all = [...diff.operations.adds, ...diff.operations.updates, ...diff.operations.deletes];
        if (diff.archive_uri !== uri.slice(0, -'/memory_diff.json'.length) || all.some(value => roots.includes(value.uri) || !allowedUri(value.uri, roots))
          || new Set(all.map(value => value.uri)).size !== all.length) return unavailable();
        return ok({ adds: diff.operations.adds.map(value => ({ uri: value.uri, after: value.after })),
          changed: [...new Set([...diff.operations.updates, ...diff.operations.deletes].map(value => value.uri))] });
      } catch { return unavailable(); }
    },
    async readMirrorTask(id: string): Promise<Result<Record<string, unknown> | null>> {
      if (!sessionId.safeParse(id).success) return fail(appError('input_invalid', 'input', 'The original memory task is invalid.'));
      try {
        const client = new OpenVikingClient({ baseUrl: parsed.endpoint, apiKey: parsed.apiKey, actorPeerId: parsed.owner.peerId, timeout: 10000,
          fetch: ((url: RequestInfo | URL, init?: RequestInit) => baseFetch(url, { ...init,
            signal: raw.signal && init?.signal ? AbortSignal.any([raw.signal, init.signal]) : raw.signal ?? init?.signal })) as typeof fetch });
        return ok(await client.getTask(id));
      } catch { return fail(appError('openviking_unavailable', 'runtime', 'The original memory task could not be read.', true)); }
    },
    async createMirrorSession(id: string): Promise<Result<Record<string, unknown>>> {
      if (!sessionId.safeParse(id).success) return fail(appError('input_invalid', 'input', 'The original memory Session is invalid.'));
      const result = await mirrorWrite('/api/v1/sessions', { session_id: id, auto_commit_policy: null });
      return result.ok && !originalSession(id, result.data)
        ? fail(appError('operation_result_unknown', 'runtime', 'The original memory Session could not be confirmed.', true)) : result;
    },
    async appendMirrorMessage(id: string, message: z.infer<typeof mirrorMessage>): Promise<Result<Record<string, unknown>>> {
      const checked = mirrorMessage.safeParse(message);
      if (!sessionId.safeParse(id).success || !checked.success) return fail(appError('input_invalid', 'input', 'The original memory message is invalid.'));
      if (!await verifyMirrorSession(id)) return fail(appError('operation_result_unknown', 'runtime', 'The original memory Session could not be confirmed.', true));
      const result = await mirrorWrite(`/api/v1/sessions/${encodeURIComponent(id)}/messages`, { role: checked.data.role, content: checked.data.content,
        source_message_ids: checked.data.sourceMessageIds, turn_id: checked.data.turnId });
      return result.ok && result.data.session_id !== id
        ? fail(appError('operation_result_unknown', 'runtime', 'The original memory message could not be confirmed.', true)) : result;
    },
    async commitMirrorSession(id: string): Promise<Result<Record<string, unknown>>> {
      if (!sessionId.safeParse(id).success) return fail(appError('input_invalid', 'input', 'The original memory Session is invalid.'));
      if (!await verifyMirrorSession(id)) return fail(appError('operation_result_unknown', 'runtime', 'The original memory Session could not be confirmed.', true));
      const result = await mirrorWrite(`/api/v1/sessions/${encodeURIComponent(id)}/commit`, { keep_recent_count: 0 });
      return result.ok && (typeof result.data.task_id !== 'string' || !result.data.task_id)
        ? fail(appError('operation_result_unknown', 'runtime', 'The original memory task could not be confirmed.', true)) : result;
    },
    async recall(input: { query: string; timeoutMs: number; allowedEntries: AllowedEntry[] }): Promise<Result<MemoryRecallResult>> {
      const checked = request.safeParse(input);
      if (!checked.success) return fail(appError('input_invalid', 'input', 'The memory recall request is invalid.'));
      const abort = new AbortController(), timer = setTimeout(() => abort.abort(), checked.data.timeoutMs);
      try {
        const client = readClient(raw.signal ? AbortSignal.any([abort.signal, raw.signal]) : abort.signal, checked.data.timeoutMs);
        const targets = [...new Set(checked.data.allowedEntries.map(entry => entry.uri).filter(uri => allowedUri(uri, roots)))];
        if (!targets.length) {
          const verified = await verifyOpenVikingIdentity({ endpoint: parsed.endpoint, apiKey: parsed.apiKey, accountId: parsed.owner.accountId,
            userId: parsed.owner.userId, role: 'user', fetch: transport, signal: raw.signal ? AbortSignal.any([abort.signal, raw.signal]) : abort.signal });
          return ok({ status: verified ? 'empty' : 'unavailable', items: [] });
        }
        const found = response.parse(await client.find(checked.data.query, { targetUri: targets, limit: 5, contextType: 'memory' }));
        const items: MemoryRecallItem[] = []; let bytes = 0;
        for (const candidate of found.memories ?? []) {
          const allowed = checked.data.allowedEntries.find(entry => entry.uri === candidate.uri);
          if (!allowedUri(candidate.uri, roots) || !allowed || items.some(value => value.uri === candidate.uri)) continue;
          const value = await client.read(candidate.uri, 0, -1);
          if (value !== allowed.approvedContent || !value.trim()) throw Error('memory_content_unavailable');
          const piece = clipped(value, 6000 - bytes);
          if (!piece.content) break;
          items.push({ uri: candidate.uri, revision: allowed.revision, content: piece.content, truncated: piece.truncated }); bytes += piece.bytes;
          if (items.length === 5 || bytes === 6000) break;
        }
        return ok({ status: items.length ? 'ready' : 'empty', items });
      } catch { return ok({ status: 'unavailable', items: [] }); }
      finally { clearTimeout(timer); }
    },
  };
}
