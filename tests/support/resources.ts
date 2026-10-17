import type { ElectronApplication } from 'playwright';
import { existsSync, mkdtempSync as createTemp, rmSync } from 'node:fs';
import { once } from 'node:events';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { DatabaseSync } from 'node:sqlite';

// E2E runs in Node; core tests keep their existing Bun database and hooks.
export const Database = process.versions.bun ? (await import('bun:sqlite')).Database : class {
  private readonly db: DatabaseSync;
  constructor(path: string, options: { readonly?: boolean } = {}) { this.db = new DatabaseSync(path, { readOnly: options.readonly }); }
  query(sql: string) { return this.db.prepare(sql); }
  close() { this.db.close(); }
};

export async function createHttpProvider(fetch: (request: Request) => Response | Promise<Response>, hostname = '127.0.0.1') {
  const server = createServer(async (request, response) => {
    const abort = new AbortController();
    response.on('close', () => abort.abort());
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = Buffer.concat(chunks).toString('utf8');
      const result = await fetch(new Request(`http://127.0.0.1${request.url}`, { method: request.method,
        headers: new Headers(request.rawHeaders.reduce<Array<[string, string]>>((pairs, value, i, values) => {
          if (i % 2 === 0) pairs.push([value, values[i + 1]!]); return pairs;
        }, [])), ...(body ? { body } : {}), signal: abort.signal }));
      if (response.destroyed) return;
      response.writeHead(result.status, Object.fromEntries(result.headers));
      if (result.body) await pipeline(Readable.from(result.body), response);
      else response.end();
    } catch (error) { if (!response.destroyed) response.destroy(error instanceof Error ? error : new Error(String(error))); }
  });
  server.listen(0, hostname);
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Controlled Provider has no port.');
  return { port: address.port, async stop(_force = true) {
    server.closeAllConnections();
    if (server.listening) await new Promise<void>((resolveClosed, reject) => server.close(error => error ? reject(error) : resolveClosed()));
  } };
}

const cleanup: Array<() => unknown | Promise<unknown>> = [];
export function deferCleanup(fn: () => unknown | Promise<unknown>) { cleanup.push(fn); }
export function mkdtempSync(prefix: string): string {
  const root = createTemp(prefix);
  const rel = relative(resolve(tmpdir()), resolve(root));
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new Error('Test resource must be owned under temp');
  deferCleanup(() => rmSync(root, { recursive: true, force: true }));
  return root;
}
export async function mkdtemp(prefix: string) { return mkdtempSync(prefix); }
export async function waitFor(check: () => Promise<boolean>, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise(resolveWait => setTimeout(resolveWait, 100));
  }
  throw new Error(`Condition did not become true within ${timeoutMs}ms.`);
}
export async function closeDesktopFixture(app: ElectronApplication, userData: string, failure?: Error): Promise<void> {
  const child = app.process();
  const exited = child.exitCode === null && child.signalCode === null ? once(child, 'exit') : Promise.resolve();
  let closeFailure: Error | undefined;
  let quitFailure: unknown;
  try {
    {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([(async () => {
          // Playwright closes its Node connection during app.close(). Keep it
          // available until Flowmate has finished its actual shutdown.
          await Promise.all([app.evaluate(({ app }) => { setImmediate(() => app.quit()); }).catch(error => { quitFailure = error; }), exited]);
          await app.close();
        })(), new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('Graceful desktop close was not confirmed within 20000ms.')), 20_000);
        })]);
        return;
      } catch (error) {
        let probeTimer: ReturnType<typeof setTimeout> | undefined;
        let desktop: unknown;
        try {
          desktop = await Promise.race([
            app.firstWindow().then(page => page.evaluate(async () => {
              const state = await window.flowmate.getState();
              return state.ok ? { ready: state.data.ready, host: state.data.host } : { error: state.error.code };
            })).catch(() => null),
            new Promise(resolveProbe => { probeTimer = setTimeout(() => resolveProbe(null), 1000); }),
          ]);
        } finally { clearTimeout(probeTimer); }
        closeFailure = new Error(`Desktop fixture normal close: ${JSON.stringify({ desktop,
          pid: child.pid, exitCode: child.exitCode, killed: child.killed })}`, {
          cause: quitFailure ? new AggregateError([quitFailure, error], 'Desktop quit and exit confirmation failed') : error });
      } finally { clearTimeout(timer); }
    }
    let runCount = 0;
    const databasePath = join(userData, 'data/app.sqlite');
    if (existsSync(databasePath)) {
      const db = new Database(databasePath, { readonly: true });
      try { runCount = (db.query('SELECT count(*) AS count FROM runs').get() as { count: number }).count; }
      finally { db.close(); }
    }
    if (runCount !== 0) throw closeFailure!;
    const rel = relative(resolve(tmpdir()), resolve(userData));
    if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new Error('Forced desktop cleanup requires an owned temp fixture.');
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      // app.exit destroys the protocol before its evaluation can acknowledge.
      void app.evaluate(({ app }) => app.exit(1)).catch(() => undefined);
      await Promise.race([exited, new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Desktop fixture process exit was not confirmed: ${JSON.stringify({
          pid: child.pid, exitCode: child.exitCode, killed: child.killed, userData, runCount })}`)), 5000);
      })]);
    } finally { clearTimeout(timer); }
    if (closeFailure) throw closeFailure;
  } catch (cleanupError) {
    const secondary = closeFailure && cleanupError !== closeFailure
      ? new Error(`${closeFailure.message}; fallback: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`,
        { cause: new AggregateError([closeFailure, cleanupError], 'Desktop close and fallback failed') })
      : cleanupError;
    if (failure) throw new Error(`${failure.message}; cleanup: ${secondary instanceof Error ? secondary.message : String(secondary)}`,
      { cause: new AggregateError([failure, secondary], 'Desktop body and cleanup failed') });
    throw secondary;
  }
}
export async function cleanupResources() {
  const errors: unknown[] = [];
  for (const close of cleanup.splice(0).reverse()) {
    try { await close(); } catch (error) { errors.push(error); }
  }
  if (errors.length) throw new AggregateError(errors, 'Test resource cleanup failed');
}
if (process.versions.bun) (await import('bun:test')).afterEach(cleanupResources);

export async function installReadGate(app: ElectronApplication, userData: string) {
  await app.evaluate((_electron, root) => {
    const handles = (process as typeof process & { _getActiveHandles(): unknown[] })._getActiveHandles();
    const child = handles.find(value => value && typeof value === 'object' && 'spawnargs' in value && Array.isArray(value.spawnargs)
      && value.spawnargs.includes(root) && value.spawnargs.some(arg => typeof arg === 'string'
        && /(?:^|\/)apps\/(?:host\/main\.ts|start-host\.js)$/.test(arg.replaceAll('\\', '/')))) as import('node:child_process').ChildProcessWithoutNullStreams | undefined;
    if (!child?.stdin || !child.stdout) throw new Error('Actual owned Host pipe is missing.');
    const input = child.stdin, output = child.stdout, write = input.write, emit = output.emit;
    const commands: Array<{ type: string; requestId: string; input?: { runId?: number; snapshotId?: number } }> = [];
    const kinds = new Map<string, string>(), faults = new Map<string, number>();
    let buffer = Buffer.alloc(0), remaining = 0, heldType = 'query_context_snapshot', closeGate = false;
    const held: Buffer[] = [], closeReplies: Buffer[] = []; let heldEnd: unknown[] | null = null;
    child.stdin.write = function (this: typeof input, ...args: Parameters<typeof write>) {
      try { const command = JSON.parse(String(args[0])); commands.push(command); kinds.set(command.requestId, command.type); } catch { /* Forward unchanged. */ }
      return Reflect.apply(write, this, args);
    } as typeof write;
    child.stdout.emit = function (this: typeof output, event: string | symbol, ...args: unknown[]) {
      if (closeGate && event === 'end') { heldEnd = args; return true; }
      if (event !== 'data' || !Buffer.isBuffer(args[0])) return Reflect.apply(emit, this, [event, ...args]);
      buffer = Buffer.concat([buffer, args[0]]); const forward: Buffer[] = [];
      for (let newline = buffer.indexOf(10); newline !== -1; newline = buffer.indexOf(10)) {
        let line = buffer.subarray(0, newline + 1); buffer = buffer.subarray(newline + 1);
        try { const packet = JSON.parse(line.toString());
          if (closeGate && packet.type === 'response' && kinds.get(packet.requestId) === 'close') { closeReplies.push(Buffer.from(line)); continue; }
          if (packet.type === 'response') {
            const kind = kinds.get(packet.requestId)!;
            if ((faults.get(kind) ?? 0) > 0) { packet.value = ['update_resource_selection', 'update_extension_selection', 'save_subagent_definition'].includes(kind)
              ? { ok: false, error: { code: 'operation_result_unknown', category: 'runtime', retryable: true, message: 'Synthetic lost receipt after actual save.' } }
              : kind === 'list_extensions' ? { ok: false, error: { code: 'extension_config_invalid', category: 'input', retryable: false, message: 'The trusted extension manifest is unavailable.' } }
              : { ok: false, error: { code: 'internal_error', category: 'internal', retryable: false, message: 'PRIVATE-CONTEXT sdk credential token', sessionId: packet.value.data?.snapshot?.sessionId, runId: packet.value.data?.snapshot?.runId } };
              line = Buffer.from(JSON.stringify(packet) + '\n'); faults.set(kind, faults.get(kind)! - 1); }
            if (kind === heldType && remaining > 0) { held.push(Buffer.from(line)); remaining--; continue; }
          }
        } catch { /* Production parser receives original malformed bytes. */ }
        forward.push(line);
      }
      return forward.length ? Reflect.apply(emit, this, [event, Buffer.concat(forward), ...args.slice(1)]) : true;
    };
    function finishClose() { closeGate = false; for (const line of closeReplies.splice(0)) Reflect.apply(emit, output, ['data', line]);
      if (heldEnd) { Reflect.apply(emit, output, ['end', ...heldEnd]); heldEnd = null; } }
    Reflect.set(globalThis, 'contextReadGate', { commands, held, closeReplies,
      hold(count: number, type = 'query_context_snapshot') { remaining = count; heldType = type; }, fail(count = 1, type = heldType) { faults.set(type, count); },
      holdHostClose() { closeGate = true; }, finishClose,
      release(index: number) { const line = held[index]; if (line) { Reflect.apply(emit, child.stdout, ['data', line]); held[index] = Buffer.alloc(0); } },
      restore() { for (const line of held) if (line.length) Reflect.apply(emit, child.stdout, ['data', line]); finishClose(); child.stdin.write = write; child.stdout.emit = emit; } });
  }, userData);
}
