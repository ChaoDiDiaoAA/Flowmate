import { chmodSync, lstatSync, realpathSync, unlinkSync } from 'node:fs';
import { createConnection } from 'node:net';
import { dirname, isAbsolute, resolve } from 'node:path';
import { appError, fail, ok, type Result } from '@flowmate/contracts';
import { safeCloudAncestors } from './cloud-paths.ts';

const maxRequestBytes = 1_100_000;
const maxResponseBytes = 14 * 1024 * 1024 + 64 * 1024;
const decoder = new TextDecoder('utf-8', { fatal: true });
const failure = (code: string, message: string) => fail(appError(code, 'runtime', message, true));

function validParent(socketPath: string, owner: boolean): boolean {
  if (process.platform !== 'linux' || !isAbsolute(socketPath) || resolve(socketPath) !== socketPath
    || Buffer.byteLength(socketPath) > 100 || socketPath.includes('\0')) return false;
  try {
    const parent = dirname(socketPath), item = lstatSync(parent);
    if (!item.isDirectory() || item.isSymbolicLink() || realpathSync(parent) !== parent || (item.mode & 0o027) !== 0
      || owner && (typeof process.getuid !== 'function' || item.uid !== process.getuid())) return false;
    return safeCloudAncestors(parent, item.uid);
  } catch { return false; }
}
function hasPath(path: string): boolean {
  try { lstatSync(path); return true; }
  catch (error) { if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false; throw error; }
}
async function readBody(body: ReadableStream<Uint8Array> | null, maximum: number): Promise<string> {
  if (!body) throw Error('missing_body');
  const reader = body.getReader(), chunks: Uint8Array[] = []; let total = 0;
  try {
    for (;;) {
      const part = await reader.read(); if (part.done) break;
      total += part.value.byteLength;
      if (total > maximum) { await reader.cancel(); throw Error('body_too_large'); }
      chunks.push(part.value);
    }
    return decoder.decode(Buffer.concat(chunks, total));
  } finally { reader.releaseLock(); }
}
export { validParent as validCloudSocketParent, hasPath as cloudSocketExists, readBody as readCloudSocketBody };

/** Only an exclusive service owner may remove its own socket after proving no listener exists. */
export async function recoverStaleCloudSocket(path: string): Promise<boolean> {
  try {
    if (!validParent(path, true)) return false;
    const original = lstatSync(path);
    if (!original.isSocket() || original.isSymbolicLink() || typeof process.getuid !== 'function' || original.uid !== process.getuid()
      || (original.mode & 0o007) !== 0) return false;
    const status = await new Promise<'active' | 'refused' | 'unknown'>(resolveStatus => {
      const socket = createConnection({ path }); let finished = false;
      const finish = (value: 'active' | 'refused' | 'unknown') => {
        if (finished) return; finished = true; clearTimeout(timer); socket.destroy(); resolveStatus(value);
      };
      const timer = setTimeout(() => finish('unknown'), 1000);
      socket.once('connect', () => finish('active'));
      socket.once('error', error => finish('code' in error && error.code === 'ECONNREFUSED' ? 'refused' : 'unknown'));
    });
    if (status !== 'refused' || !validParent(path, true)) return false;
    const current = lstatSync(path);
    if (!current.isSocket() || current.isSymbolicLink() || current.dev !== original.dev || current.ino !== original.ino
      || current.uid !== original.uid || current.mode !== original.mode || current.ctimeMs !== original.ctimeMs) return false;
    unlinkSync(path); return true;
  } catch { return false; }
}

/** Socket permissions restrict local access; the handler must authorize every operation. */
export async function listenCloudUnixRpc(input: { socketPath: string; allowStaleSocket?: boolean; handle(value: unknown, signal: AbortSignal): Promise<unknown> }):
Promise<Result<{ close(): Promise<Result<void>> }>> {
  if (!validParent(input.socketPath, true)) return failure('cloud_transport_invalid', 'Cloud socket directory is unavailable or unsafe.');
  let server: ReturnType<typeof Bun.serve> | undefined;
  let stopping = false;
  const active = new Set<Promise<unknown>>();
  try {
    if (hasPath(input.socketPath) && (!input.allowStaleSocket || !await recoverStaleCloudSocket(input.socketPath)))
      return failure('cloud_transport_invalid', 'Cloud socket path is already occupied.');
    const serverOptions = { unix: input.socketPath, idleTimeout: 0, maxRequestBodySize: maxRequestBytes,
        async fetch(request: Request) {
          if (request.method !== 'POST' || new URL(request.url).pathname !== '/rpc') return new Response(null, { status: 404 });
          if (request.headers.get('content-type') !== 'application/json') return new Response(null, { status: 415 });
          let value: unknown;
          try { value = JSON.parse(await readBody(request.body, maxRequestBytes)); }
          catch { return new Response(null, { status: 400 }); }
          if (stopping) return new Response(null, { status: 503 });
          const operation = Promise.resolve().then(() => input.handle(value, request.signal)); active.add(operation);
          try {
            const json = JSON.stringify(await operation);
            if (json === undefined || Buffer.byteLength(json) > maxResponseBytes) return new Response(null, { status: 500 });
            return new Response(json, { headers: { 'content-type': 'application/json' } });
          } catch { return new Response(null, { status: 500 }); }
          finally { active.delete(operation); }
        } };
    // Bun 1.4.4 honors idleTimeout for Unix sockets although its Unix type omits it.
    server = Bun.serve(serverOptions as Omit<typeof serverOptions, 'idleTimeout'>);
    chmodSync(input.socketPath, 0o660);
    const bound = server;
    let closing: Promise<Result<void>> | undefined;
    return ok({ close() {
      closing ??= (async () => {
        stopping = true;
        try { await bound.stop(true); await Promise.allSettled([...active]); return ok(undefined); }
        catch { return failure('cloud_transport_close_failed', 'Cloud socket closure could not be confirmed.'); }
      })();
      return closing;
    } });
  } catch {
    if (server) { try { await server.stop(true); } catch { return failure('cloud_transport_close_failed', 'Cloud socket closure could not be confirmed.'); } }
    return failure('cloud_transport_unavailable', 'Cloud socket could not be opened.');
  }
}

/** A lost response remains unknown; retry policy belongs to the original business operation. */
export async function callCloudUnixRpc(socketPath: string, value: unknown, signal?: AbortSignal): Promise<Result<unknown>> {
  let json: string | undefined;
  try { json = JSON.stringify(value); } catch { return failure('cloud_transport_input_invalid', 'Cloud request is invalid.'); }
  if (json === undefined || Buffer.byteLength(json) > maxRequestBytes)
    return failure('cloud_transport_input_invalid', 'Cloud request exceeds its transport limit.');
  try {
    if (!validParent(socketPath, false)) throw Error('invalid_socket_parent');
    const item = lstatSync(socketPath);
    if (!item.isSocket() || item.isSymbolicLink() || (item.mode & 0o007) !== 0) throw Error('invalid_socket');
    const response = await fetch('http://localhost/rpc', { unix: socketPath, method: 'POST',
      headers: { 'content-type': 'application/json' }, body: json, signal: signal ?? AbortSignal.timeout(30_000) });
    if (!response.ok || response.headers.get('content-type') !== 'application/json') throw Error('invalid_response');
    return ok(JSON.parse(await readBody(response.body, maxResponseBytes)));
  } catch { return failure('cloud_transport_result_unknown', 'The original cloud request result could not be confirmed.'); }
}
