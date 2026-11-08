import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { readFileSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { z } from 'zod';
import { appError, BrowserPageSchema, browserTabGroup, fail, ok, type AppError, type BrowserPage, type BrowserTarget, type DesktopBridgeRequest, type DesktopBridgeResult, type Result } from '@flowmate/contracts';

type Owner = { workId: number; itemId: number; workspaceId?: string };
type Binding = { target: BrowserTarget; session: string; tabId: number | null; workspaceId?: string };

const unavailable = () => fail(appError('browser_unavailable', 'runtime', 'The selected browser page is unavailable.'));
const page = BrowserPageSchema.extend({ text: z.string().max(22000) });
class BrowserStatusFailure extends Error { constructor(readonly fact: AppError) { super(fact.code); } }

export function resolveKimiWebBridgeExecutable(userDataRoot: string, env: NodeJS.ProcessEnv): string | null {
  const path = z.string().min(1).max(4096).refine(isAbsolute);
  if (env.FLOWMATE_WEBBRIDGE_EXE) {
    const value = path.safeParse(env.FLOWMATE_WEBBRIDGE_EXE); return value.success ? value.data : null;
  }
  try {
    const file = join(userDataRoot, 'data', 'kimi-webbridge.json'); if (statSync(file).size > 8192) return null;
    const value = z.object({ version: z.literal(1), executable: path }).strict().safeParse(JSON.parse(readFileSync(file, 'utf8')));
    return value.success ? value.data.executable : null;
  } catch (error) {
    return error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT'
      ? join(homedir(), '.kimi-webbridge', 'bin', 'kimi-webbridge.exe') : null;
  }
}

export function createKimiWebBridge(port: number) {
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw Error('Invalid WebBridge port.');
  const connectionId = randomUUID(), bindings = new Map<string, Binding>();
  const key = (owner: Owner) => JSON.stringify([owner.workspaceId ?? null, owner.workId, owner.itemId]);
  let closed = false;
  const command = async (session: string, action: string, args: object, signal: AbortSignal): Promise<unknown> => {
    const response = await fetch(`http://127.0.0.1:${port}/command`, { method: 'POST', redirect: 'error',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action, session, args }),
      signal: AbortSignal.any([signal, AbortSignal.timeout(10000)]) });
    if (!response.ok || !response.body) throw Error('WebBridge unavailable.');
    const reader = response.body.getReader(), chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
      while (true) {
        const part = await reader.read(); if (part.done) break;
        bytes += part.value.byteLength; if (bytes > 262144) throw Error('WebBridge response too large.');
        chunks.push(part.value);
      }
    } finally { await reader.cancel().catch(() => {}); }
    return z.object({ ok: z.literal(true), data: z.unknown() }).passthrough()
      .parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)))).data;
  };
  const revoke = (owner: Owner) => { bindings.delete(key(owner)); };
  return {
    async verifyTabSelection(): Promise<boolean> {
      const session = `flowmate-check-${randomUUID()}`, signal = AbortSignal.timeout(15000);
      const server = createServer((_request, response) => { response.writeHead(200, { 'content-type': 'text/plain' }); response.end('Flowmate browser check'); });
      const tabs: number[] = [];
      let selected = false, cleaned = false;
      try {
        await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
        const address = server.address(); if (!address || typeof address === 'string') throw Error('Browser test listener unavailable.');
        const urls = [`http://127.0.0.1:${address.port}/first`, `http://127.0.0.1:${address.port}/second`];
        for (const url of urls) {
          const opened = z.object({ success: z.literal(true), tabId: z.number().int().positive().safe() }).passthrough()
            .parse(await command(session, 'navigate', { url, newTab: true, group_title: 'Flowmate check' }, signal));
          tabs.push(opened.tabId);
        }
        if (tabs[0] === tabs[1]) throw Error('WebBridge reused the diagnostic tab.');
        for (let index = 0; index < tabs.length; index++) {
          const result = z.object({ type: z.literal('object'), value: z.object({ url: z.string().url() }).strict() }).passthrough()
            .parse(await command(session, 'evaluate', { tabId: tabs[index], code: '(()=>({url:String(location.href)}))()' }, signal));
          if (result.value.url !== urls[index]) throw Error('WebBridge ignored the diagnostic tab.');
        }
        selected = !closed && !signal.aborted;
      } catch { /* A failed diagnostic cannot authorize a user page. */ }
      finally {
        const closedSession = await command(session, 'close_session', {}, AbortSignal.timeout(2000)).catch(() => null);
        server.closeAllConnections();
        if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()));
        const result = z.object({ success: z.literal(true), closed: z.number().int().nonnegative() }).passthrough().safeParse(closedSession);
        cleaned = result.success && result.data.closed === tabs.length;
      }
      return selected && cleaned;
    },
    selectedTarget(owner: Owner): Result<BrowserTarget> {
      const binding = bindings.get(key(owner));
      return closed || !binding?.tabId ? unavailable() : ok({ ...binding.target });
    },
    async bind(owner: Owner, rawUrl: string, signal: AbortSignal): Promise<Result<BrowserTarget>> {
      revoke(owner);
      let url: URL;
      try {
        url = new URL(rawUrl);
        if (rawUrl.length > 2048 || !['http:', 'https:'].includes(url.protocol) || url.username || url.password)
          throw Error('Invalid browser URL.');
      } catch { return fail(appError('input_invalid', 'input', 'The browser URL is invalid.')); }
      if (closed || signal.aborted) return unavailable();
      const binding: Binding = { target: { connectionId, bindingId: randomUUID(), origin: url.origin },
        session: `flowmate-${randomUUID()}`, tabId: null, ...(owner.workspaceId ? { workspaceId: owner.workspaceId } : {}) };
      bindings.set(key(owner), binding);
      try {
        const result = z.object({ success: z.literal(true), tabId: z.number().int().positive().safe() }).passthrough().parse(
          await command(binding.session, 'navigate', { url: url.href, newTab: true,
            group_title: browserTabGroup({ workId: owner.workId, itemId: owner.itemId, cloud: !!owner.workspaceId }) }, signal));
        if (closed || signal.aborted || bindings.get(key(owner)) !== binding) return unavailable();
        binding.tabId = result.tabId;
        return ok({ ...binding.target });
      } catch {
        if (bindings.get(key(owner)) === binding) revoke(owner);
        return unavailable();
      }
    },
    async read(owner: Owner, target: BrowserTarget, signal: AbortSignal): Promise<Result<BrowserPage>> {
      const binding = bindings.get(key(owner));
      if (closed || signal.aborted || !binding?.tabId || !isDeepStrictEqual(binding.target, target)) return unavailable();
      const code = `(()=>{if(location.origin!==${JSON.stringify(binding.target.origin)})return {denied:true};`
        + 'const text=String(document.body?.innerText??""),part=text.slice(0,22000);'
        + 'const safe=part.length&&/[\\uD800-\\uDBFF]/.test(part[part.length-1])?part.slice(0,-1):part;'
        + 'return {url:location.href,title:String(document.title).slice(0,2048),text:safe,truncated:safe.length<text.length}})()';
      try {
        const envelope = z.object({ type: z.literal('object'), value: z.unknown() }).passthrough().parse(
          await command(binding.session, 'evaluate', { tabId: binding.tabId, code }, signal));
        const result = page.parse(envelope.value);
        const url = new URL(result.url);
        if (url.origin !== binding.target.origin || closed || signal.aborted || bindings.get(key(owner)) !== binding)
          throw Error('Browser target changed.');
        let text = '', bytes = 0;
        for (const character of result.text) {
          const length = Buffer.byteLength(character, 'utf8'); if (bytes + length > 22000) break;
          text += character; bytes += length;
        }
        return ok({ url: url.origin + url.pathname, title: result.title, text, truncated: result.truncated || text.length < result.text.length });
      } catch {
        if (bindings.get(key(owner)) === binding) revoke(owner);
        return unavailable();
      }
    },
    revoke,
    revokeWorkspace(workspaceId: string) { for (const [id, binding] of bindings) if (binding.workspaceId === workspaceId) bindings.delete(id); },
    close() { closed = true; bindings.clear(); },
  };
}

export function parseKimiWebBridgeStatus(raw: unknown, pidText: string, address: string): Result<{ pid: number; port: number }> {
  const status = z.object({ running: z.boolean(), extension_connected: z.boolean().optional(), tab_id_arg: z.boolean().optional(),
    port: z.number().int().min(1).max(65535).optional(), version: z.string().optional(), extension_version: z.string().optional() }).passthrough().safeParse(raw);
  const error = (code: string, message: string) => fail(appError(code, 'runtime', message, true));
  if (!status.success) return error('browser_status_invalid', 'WebBridge status is invalid. Check its process and port.');
  if (!status.data.running) return error('browser_daemon_unavailable', 'Start WebBridge and check for a port conflict.');
  if (!status.data.extension_connected) return error('browser_extension_disconnected', 'Enable and connect the Kimi Browser Extension in Chrome.');
  if (!status.data.tab_id_arg) return error('browser_tab_target_unsupported', 'WebBridge cannot select the dedicated tab.');
  if (!status.data.version || !status.data.extension_version || status.data.version.replace(/^v/, '') !== status.data.extension_version)
    return error('browser_version_mismatch', 'WebBridge and the Kimi Browser Extension versions do not match.');
  const pid = Number(pidText.trim());
  if (!status.data.port || !/^[1-9][0-9]*$/.test(pidText.trim()) || !Number.isSafeInteger(pid) || address.trim() !== `127.0.0.1:${status.data.port}`)
    return error('browser_status_invalid', 'WebBridge process or listener facts differ. Check for a port conflict.');
  return ok({ pid, port: status.data.port });
}

export async function readKimiWebBridgeStatus(executable: string, userHome = homedir(), env: NodeJS.ProcessEnv = process.env) {
  if (process.platform !== 'win32') throw new BrowserStatusFailure(appError('browser_unavailable', 'runtime', 'Browser reading requires Windows.'));
  const root = join(userHome, '.kimi-webbridge');
  let command: { stdout: string };
  try { command = await promisify(execFile)(executable, ['status'], { windowsHide: true, timeout: 5000, maxBuffer: 65536, env }); }
  catch { throw new BrowserStatusFailure(appError('browser_executable_unavailable', 'runtime', 'The WebBridge executable or status command is unavailable.', true)); }
  const [pidText, address] = await Promise.all([readFile(join(root, 'daemon.pid'), 'utf8').catch(() => ''),
    readFile(join(root, 'daemon.addr'), 'utf8').catch(() => '')]);
  let raw: unknown;
  try { raw = JSON.parse(command.stdout); } catch { raw = null; }
  const parsed = parseKimiWebBridgeStatus(raw, pidText, address);
  if (!parsed.ok) throw new BrowserStatusFailure(parsed.error);
  return parsed.data;
}

export async function startKimiWebBridge(executable: string, userHome = homedir(), env: NodeJS.ProcessEnv = process.env): Promise<Result<void>> {
  if (process.platform !== 'win32' || !isAbsolute(executable)) return unavailable();
  try {
    await readKimiWebBridgeStatus(executable, userHome, env); return ok(undefined);
  } catch (cause) {
    if (!(cause instanceof BrowserStatusFailure)) return unavailable();
    if (cause.fact.code !== 'browser_daemon_unavailable' && cause.fact.code !== 'browser_extension_disconnected') return fail(cause.fact);
    if (cause.fact.code === 'browser_daemon_unavailable') {
      const error = () => fail(appError('browser_listener_unsafe', 'runtime', 'WebBridge must use a 127.0.0.1 listener. Check its configuration.', true));
      let address = '127.0.0.1:10086';
      try {
        const file = join(userHome, '.kimi-webbridge', 'config.json');
        if (statSync(file).size > 65536) return error();
        const config = z.object({ addr: z.string().optional() }).passthrough().safeParse(JSON.parse(readFileSync(file, 'utf8')));
        if (!config.success) return error();
        address = config.data.addr ?? address;
      } catch (errorCause) {
        if (!errorCause || typeof errorCause !== 'object' || !('code' in errorCause) || errorCause.code !== 'ENOENT') return error();
      }
      const match = /^127\.0\.0\.1:([1-9][0-9]{0,4})$/.exec(address);
      if (!match || Number(match[1]) > 65535) return error();
      try { await promisify(execFile)(executable, ['start', '--addr', address], { windowsHide: true, timeout: 10000, maxBuffer: 65536, env }); }
      catch { return fail(appError('browser_executable_unavailable', 'runtime', 'The WebBridge executable could not be started.', true)); }
    }
  }
  const deadline = Date.now() + 15000;
  while (true) {
    try { await readKimiWebBridgeStatus(executable, userHome, env); return ok(undefined); }
    catch (cause) {
      if (!(cause instanceof BrowserStatusFailure)) return unavailable();
      if (!['browser_daemon_unavailable', 'browser_extension_disconnected'].includes(cause.fact.code) || Date.now() >= deadline) return fail(cause.fact);
    }
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
}

export function createKimiWebBridgeManager(status: () => Promise<{ pid: number; port: number }>) {
  let current: { pid: number; port: number; bridge: ReturnType<typeof createKimiWebBridge> } | null = null, closed = false;
  const reset = () => { current?.bridge.close(); current = null; };
  return {
    async open(): Promise<Result<ReturnType<typeof createKimiWebBridge>>> {
      if (closed) return unavailable();
      try {
        const found = await status();
        if (closed || !Number.isSafeInteger(found.pid) || found.pid < 1 || !Number.isSafeInteger(found.port) || found.port < 1 || found.port > 65535)
          throw Error('Invalid WebBridge status.');
        if (current && (current.pid !== found.pid || current.port !== found.port)) reset();
        if (!current) {
          const bridge = createKimiWebBridge(found.port);
          if (!await bridge.verifyTabSelection() || closed) { bridge.close(); throw new BrowserStatusFailure(appError('browser_tab_target_unsupported', 'runtime',
            'WebBridge tab targeting or its diagnostic session could not be confirmed.', true)); }
          if (!current) current = { ...found, bridge };
          else bridge.close();
        }
        return ok(current.bridge);
      } catch (error) { reset(); return error instanceof BrowserStatusFailure ? fail(error.fact) : unavailable(); }
    },
    reset,
    revoke(owner: Owner) { current?.bridge.revoke(owner); },
    revokeWorkspace(workspaceId: string) { current?.bridge.revokeWorkspace(workspaceId); },
    close() { closed = true; reset(); },
  };
}

export async function handleKimiBrowserRequest(manager: ReturnType<typeof createKimiWebBridgeManager>, owner: Owner,
  request: DesktopBridgeRequest, signal: AbortSignal): Promise<DesktopBridgeResult> {
  if (owner.workId !== request.workId || owner.itemId !== request.itemId || signal.aborted
    || request.kind !== 'browser_target' && request.kind !== 'browser_read') return unavailable();
  const opened = await manager.open(); if (!opened.ok) return opened;
  if (signal.aborted) return unavailable();
  if (request.kind === 'browser_target') {
    const target = opened.data.selectedTarget(owner); return target.ok ? ok({ kind: 'browser_target', target: target.data }) : target;
  }
  const result = await opened.data.read(owner, request.target, signal);
  if (!result.ok) return result;
  if (signal.aborted) return unavailable();
  const current = await manager.open();
  if (!current.ok) return current;
  if (current.data !== opened.data || signal.aborted) return unavailable();
  const target = current.data.selectedTarget(owner);
  return target.ok && isDeepStrictEqual(target.data, request.target) ? ok({ kind: 'browser_read', page: result.data }) : unavailable();
}
