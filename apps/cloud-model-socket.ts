import { chmodSync, lstatSync } from 'node:fs';
import { appError, AppErrorSchema, CloudModelAttemptRequestSchema, fail, ok, type CloudModelAttemptRequest, type Result } from '@flowmate/contracts';
import type { CloudDeepSeekProxy } from './cloud-deepseek-proxy.ts';
import { cloudSocketExists, readCloudSocketBody, recoverStaleCloudSocket, validCloudSocketParent } from './cloud-unix-rpc.ts';

const maxEnvelopeBytes = 2_300_000;
const unknown = () => fail(appError('cloud_model_result_unknown', 'runtime', 'The original model transport result could not be confirmed.', true));

/** Streams the authorized model response without putting the Authority credential on the Runtime socket. */
export async function listenCloudModelSocket(input: { socketPath: string; proxy: CloudDeepSeekProxy; allowStaleSocket?: boolean;
  prepare?(request: CloudModelAttemptRequest, signal: AbortSignal): Promise<Result<void>> }):
Promise<Result<{ close(): Promise<Result<void>> }>> {
  if (!validCloudSocketParent(input.socketPath, true))
    return fail(appError('cloud_transport_invalid', 'runtime', 'Cloud model socket directory is unavailable or unsafe.'));
  let server: ReturnType<typeof Bun.serve> | undefined, stopping = false;
  const active = new Set<Promise<unknown>>();
  try {
    if (cloudSocketExists(input.socketPath) && (!input.allowStaleSocket || !await recoverStaleCloudSocket(input.socketPath)))
      return fail(appError('cloud_transport_invalid', 'runtime', 'Cloud model socket path is already occupied.'));
    const serverOptions = { unix: input.socketPath, idleTimeout: 0, maxRequestBodySize: maxEnvelopeBytes, async fetch(request: Request) {
      if (request.method !== 'POST' || new URL(request.url).pathname !== '/model') return new Response(null, { status: 404 });
      if (request.headers.get('content-type') !== 'application/json') return new Response(null, { status: 415 });
      let raw: unknown;
      try { raw = JSON.parse(await readCloudSocketBody(request.body, maxEnvelopeBytes)); }
      catch { return new Response(null, { status: 400 }); }
      const parsed = CloudModelAttemptRequestSchema.safeParse(raw);
      if (!parsed.success) return new Response(null, { status: 400 });
      if (stopping) return new Response(null, { status: 503 });
      const operation = (async () => {
        if (input.prepare) {
          try { const prepared = await input.prepare(structuredClone(parsed.data), request.signal); if (!prepared.ok) return prepared; }
          catch { return fail(appError('cloud_authorization_unavailable', 'runtime', 'The original model request could not be reconciled.', true)); }
        }
        return input.proxy.send(parsed.data, request.signal);
      })(); active.add(operation);
      let result: Awaited<typeof operation>;
      try { result = await operation; } finally { active.delete(operation); }
      if (!result.ok) return new Response(JSON.stringify(result.error), { status: 409, headers: { 'content-type': 'application/problem+json' } });
      const response = result.data;
      if (!response.body) return response;
      const reader = response.body.getReader(), ended = Promise.withResolvers<void>(); active.add(ended.promise);
      const finish = () => { active.delete(ended.promise); ended.resolve(); };
      const body = new ReadableStream<Uint8Array>({
        async pull(controller) {
          try { const part = await reader.read(); if (part.done) { controller.close(); finish(); } else controller.enqueue(part.value); }
          catch { controller.error(Error('cloud_model_result_unknown')); finish(); }
        },
        async cancel() { try { await reader.cancel(); } finally { finish(); } },
      });
      return new Response(body, { status: response.status, headers: { 'content-type': response.headers.get('content-type') ?? 'application/json' } });
    } };
    // Bun 1.4.4 honors idleTimeout for Unix sockets although its Unix type omits it.
    server = Bun.serve(serverOptions as Omit<typeof serverOptions, 'idleTimeout'>);
    chmodSync(input.socketPath, 0o660);
    const bound = server; let closing: Promise<Result<void>> | undefined;
    return ok({ close() {
      closing ??= (async () => {
        stopping = true;
        try { await bound.stop(true); await Promise.allSettled([...active]); return ok(undefined); }
        catch { return fail(appError('cloud_transport_close_failed', 'runtime', 'Cloud model socket closure could not be confirmed.', true)); }
      })(); return closing;
    } });
  } catch {
    if (server) try { await server.stop(true); } catch { return fail(appError('cloud_transport_close_failed', 'runtime', 'Cloud model socket closure could not be confirmed.', true)); }
    return fail(appError('cloud_transport_unavailable', 'runtime', 'Cloud model socket could not be opened.', true));
  }
}

export async function callCloudModelSocket(socketPath: string, input: CloudModelAttemptRequest, signal?: AbortSignal): Promise<Result<Response>> {
  const parsed = CloudModelAttemptRequestSchema.safeParse(input);
  if (!parsed.success) return fail(appError('input_invalid', 'input', 'The original cloud model request is invalid.'));
  const body = JSON.stringify(parsed.data);
  if (Buffer.byteLength(body, 'utf8') > maxEnvelopeBytes)
    return fail(appError('input_invalid', 'input', 'The cloud model request exceeds its transport limit.'));
  try {
    if (!validCloudSocketParent(socketPath, false)) return unknown();
    const item = lstatSync(socketPath);
    if (!item.isSocket() || item.isSymbolicLink() || (item.mode & 0o007) !== 0) return unknown();
    const response = await fetch('http://localhost/model', { unix: socketPath, method: 'POST', headers: { 'content-type': 'application/json' }, body, signal });
    if (response.headers.get('content-type') === 'application/problem+json') {
      const error = AppErrorSchema.safeParse(JSON.parse(await readCloudSocketBody(response.body, 8192)));
      return error.success ? fail(error.data) : unknown();
    }
    const type = response.headers.get('content-type');
    return type === 'text/event-stream' || type === 'application/json' ? ok(response) : unknown();
  } catch { return unknown(); }
}
