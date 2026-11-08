import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { mkdtempSync } from '../support/resources.ts';

const owner = { workId: 1, itemId: 2 };
const signal = new AbortController().signal;

test('WebBridge resolves the configured executable without requiring an environment variable', async () => {
  const module = await import('../../apps/desktop/main/kimi-webbridge.ts');
  const resolve = Reflect.get(module, 'resolveKimiWebBridgeExecutable');
  expect(typeof resolve).toBe('function'); if (typeof resolve !== 'function') return;
  const root = mkdtempSync(join(tmpdir(), 'flowmate-webbridge-path-'));
  const configured = join(root, 'bin', 'kimi-webbridge.exe'), override = join(root, 'other', 'webbridge.exe');
  expect(resolve(root, {})).toBe(join(homedir(), '.kimi-webbridge', 'bin', 'kimi-webbridge.exe'));
  mkdirSync(join(root, 'data'));
  writeFileSync(join(root, 'data', 'kimi-webbridge.json'), JSON.stringify({ version: 1, executable: configured }));
  expect(resolve(root, {})).toBe(configured);
  expect(resolve(root, { FLOWMATE_WEBBRIDGE_EXE: override })).toBe(override);
  expect(resolve(root, { FLOWMATE_WEBBRIDGE_EXE: 'relative.exe' })).toBeNull();
  writeFileSync(join(root, 'data', 'kimi-webbridge.json'), JSON.stringify({ version: 1, executable: 'relative.exe' }));
  expect(resolve(root, {})).toBeNull();
});

test.skipIf(process.platform !== 'win32')('starts the configured WebBridge and refuses a public listener', async () => {
  const module = await import('../../apps/desktop/main/kimi-webbridge.ts');
  const start = Reflect.get(module, 'startKimiWebBridge');
  expect(typeof start).toBe('function'); if (typeof start !== 'function') return;
  const root = mkdtempSync(join(tmpdir(), 'flowmate-webbridge-start-'));
  const data = join(root, '.kimi-webbridge'), source = join(root, 'fixture.ts'), exe = join(root, 'fixture.exe'), marker = join(root, 'started.txt');
  const disconnected = join(root, 'disconnected.txt'), stopped = join(root, 'stopped.txt');
  mkdirSync(data);
  writeFileSync(source, `import { appendFileSync, existsSync, writeFileSync } from 'node:fs';
    if (process.argv[2] === 'start') {
      if (process.argv[3] !== '--addr' || process.argv[4] !== '127.0.0.1:10086') process.exit(3);
      appendFileSync(${JSON.stringify(marker)}, 'started\\n');
      writeFileSync(${JSON.stringify(join(data, 'daemon.pid'))}, '123');
      writeFileSync(${JSON.stringify(join(data, 'daemon.addr'))}, '127.0.0.1:10086');
    } else if (process.argv[2] === 'status') {
      const running = existsSync(${JSON.stringify(marker)}) && !existsSync(${JSON.stringify(stopped)});
      const connected = running && existsSync(${JSON.stringify(disconnected)});
      if (running && !connected) writeFileSync(${JSON.stringify(disconnected)}, 'checked');
      console.log(JSON.stringify({ running, extension_connected: connected, tab_id_arg: true, port: 10086, version: 'v2.0.32', extension_version: '2.0.32' }));
    } else process.exit(2);`);
  const built = spawnSync(process.execPath, ['build', '--compile', source, '--outfile', exe, '--windows-hide-console', '--no-compile-autoload-dotenv'],
    { encoding: 'utf8', windowsHide: true, timeout: 60000 });
  expect(built.status).toBe(0);
  expect(await start(exe, root)).toEqual({ ok: true, data: undefined });
  expect(readFileSync(marker, 'utf8')).toBe('started\n');
  expect(await start(exe, root)).toEqual({ ok: true, data: undefined });
  expect(readFileSync(marker, 'utf8')).toBe('started\n');
  writeFileSync(stopped, 'stopped');
  writeFileSync(join(data, 'config.json'), JSON.stringify({ addr: '0.0.0.0:10086' }));
  expect(await start(exe, root)).toMatchObject({ ok: false, error: { code: 'browser_listener_unsafe' } });
  expect(readFileSync(marker, 'utf8')).toBe('started\n');
}, 60000);

test('WebBridge status reports disconnected extensions, version mismatches and invalid listener facts', async () => {
  const module = await import('../../apps/desktop/main/kimi-webbridge.ts');
  const parse = Reflect.get(module, 'parseKimiWebBridgeStatus');
  expect(typeof parse).toBe('function'); if (typeof parse !== 'function') return;
  const status = { running: true, extension_connected: true, tab_id_arg: true, port: 10086, version: 'v2.0.32', extension_version: '2.0.32' };
  expect(parse(status, '123', '127.0.0.1:10086')).toEqual({ ok: true, data: { pid: 123, port: 10086 } });
  expect(parse({ ...status, running: false }, '', '')).toMatchObject({ ok: false, error: { code: 'browser_daemon_unavailable' } });
  expect(parse({ ...status, extension_connected: false }, '123', '127.0.0.1:10086')).toMatchObject({ ok: false, error: { code: 'browser_extension_disconnected' } });
  expect(parse({ ...status, tab_id_arg: false }, '123', '127.0.0.1:10086')).toMatchObject({ ok: false, error: { code: 'browser_tab_target_unsupported' } });
  expect(parse({ ...status, extension_version: '1.0.0' }, '123', '127.0.0.1:10086')).toMatchObject({ ok: false, error: { code: 'browser_version_mismatch' } });
  expect(parse(status, '123', '127.0.0.1:9999')).toMatchObject({ ok: false, error: { code: 'browser_status_invalid' } });
});

async function browser(port: number) {
  const module = await import('../../apps/desktop/main/kimi-webbridge.ts').catch(() => null);
  expect(module).not.toBeNull();
  return module!.createKimiWebBridge(port);
}

function fixture(ignoreTabId = false, failClose = false, closedCount = 2) {
  let nextTab = 0, reads = 0;
  const groups: string[] = [];
  let pause: { entered: () => void; wait: Promise<void> } | undefined;
  const tabs = new Map<number, { url: string; text: string }>();
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    const command = await request.json() as { action: string; args: { url?: string; tabId?: number; code?: string; group_title?: string } };
    if (command.action === 'navigate' && command.args.url) {
      groups.push(command.args.group_title ?? '');
      const tabId = ++nextTab; tabs.set(tabId, { url: command.args.url, text: 'allowed page' });
      return Response.json({ ok: true, data: { success: true, tabId, url: command.args.url } });
    }
    if (command.action === 'evaluate' && command.args.tabId && command.args.code) {
      const page = tabs.get(ignoreTabId ? nextTab : command.args.tabId); if (!page) return Response.json({ ok: false, error: { code: 'tab_missing' } });
      if (pause) { pause.entered(); await pause.wait; }
      const url = new URL(page.url);
      const document = { title: 'Fixture', body: { get innerText() { reads++; return page.text; } } };
      const value = runInNewContext(command.args.code, { location: { origin: url.origin, href: url.href }, document });
      return Response.json({ ok: true, data: { type: 'object', value } });
    }
    if (command.action === 'close_session') return failClose ? Response.json({ ok: false }) : Response.json({ ok: true, data: { success: true, closed: closedCount } });
    return Response.json({ ok: false, error: { code: 'unsupported' } });
  } });
  const port = server.port; if (port === undefined) throw Error('Fixture port is unavailable.');
  return { port, tabs, groups, reads: () => reads, stop: () => server.stop(true),
    pause: (entered: () => void, wait: Promise<void>) => { pause = { entered, wait }; } };
}

test('a browser binding cannot be borrowed by another Work or workspace', async () => {
  const f = fixture();
  try {
    const bridge = await browser(f.port);
    const bound = await bridge.bind(owner, 'https://example.test/report', signal);
    expect(bound.ok).toBe(true); if (!bound.ok) return;
    expect(await bridge.read({ ...owner, itemId: 3 }, bound.data, signal)).toMatchObject({ ok: false });
    expect(await bridge.read({ ...owner, workspaceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }, bound.data, signal)).toMatchObject({ ok: false });
    expect(f.reads()).toBe(0);
    expect(await bridge.read(owner, bound.data, signal)).toMatchObject({ ok: true, data: { text: 'allowed page', truncated: false } });
    expect(f.reads()).toBe(1);
  } finally { f.stop(); }
});

test('the dedicated Chrome group identifies the Work and invoice being approved', async () => {
  const f = fixture();
  try {
    const bridge = await browser(f.port);
    expect((await bridge.bind({ ...owner, workspaceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }, 'https://example.test/report', signal)).ok).toBe(true);
    expect(f.groups).toEqual(['Flowmate Cloud Work 1 Item 2']);
    expect(f.reads()).toBe(0);
  } finally { f.stop(); }
});

test('a WebBridge that ignores tabId is rejected before binding or reading a page', async () => {
  const f = fixture(true);
  try {
    const module = await import('../../apps/desktop/main/kimi-webbridge.ts');
    const manager = module.createKimiWebBridgeManager(async () => ({ pid: 10, port: f.port }));
    expect(await manager.open()).toMatchObject({ ok: false });
    expect(f.reads()).toBe(0);
    manager.close();
  } finally { f.stop(); }
});

test('a WebBridge that cannot close its diagnostic session is not enabled', async () => {
  const f = fixture(false, true);
  try {
    const module = await import('../../apps/desktop/main/kimi-webbridge.ts');
    const manager = module.createKimiWebBridgeManager(async () => ({ pid: 10, port: f.port }));
    expect(await manager.open()).toMatchObject({ ok: false });
    expect(f.reads()).toBe(0);
    manager.close();
  } finally { f.stop(); }
});

test('a WebBridge that leaves the diagnostic tabs open is not enabled', async () => {
  const f = fixture(false, false, 0);
  try {
    const module = await import('../../apps/desktop/main/kimi-webbridge.ts');
    const manager = module.createKimiWebBridgeManager(async () => ({ pid: 10, port: f.port }));
    expect(await manager.open()).toMatchObject({ ok: false });
    manager.close();
  } finally { f.stop(); }
});

test('a bound tab changing origin is rejected before page text is read', async () => {
  const f = fixture();
  try {
    const bridge = await browser(f.port);
    const bound = await bridge.bind(owner, 'https://example.test/report', signal);
    expect(bound.ok).toBe(true); if (!bound.ok) return;
    f.tabs.get(1)!.url = 'https://outside.test/private';
    f.tabs.get(1)!.text = 'outside secret';
    expect(await bridge.read(owner, bound.data, signal)).toMatchObject({ ok: false });
    expect(f.reads()).toBe(0);
  } finally { f.stop(); }
});

test.each(['https://user:fixture-secret@example.test/report', 'blob:https://example.test/document'])
  ('an unsupported same-origin result URL is rejected before projection: %s', async url => {
    const f = fixture();
    try {
      const bridge = await browser(f.port);
      const bound = await bridge.bind(owner, 'https://example.test/report', signal);
      if (!bound.ok) throw Error(bound.error.code);
      f.tabs.get(1)!.url = url;
      expect(await bridge.read(owner, bound.data, signal)).toMatchObject({ ok: false, error: { code: 'browser_unavailable' } });
    } finally { f.stop(); }
  });

test('a different path on the bound origin is readable and a closed tab is refused', async () => {
  const f = fixture();
  try {
    const bridge = await browser(f.port);
    const bound = await bridge.bind(owner, 'https://example.test/report', signal);
    expect(bound.ok).toBe(true); if (!bound.ok) return;
    f.tabs.get(1)!.url = 'https://example.test/archive?token=fixture-secret#private-fragment';
    expect(await bridge.read(owner, bound.data, signal)).toMatchObject({ ok: true, data: { url: 'https://example.test/archive' } });
    f.tabs.delete(1);
    expect(await bridge.read(owner, bound.data, signal)).toMatchObject({ ok: false });
    expect(f.reads()).toBe(1);
  } finally { f.stop(); }
});

test('revocation while a page read is in flight suppresses its result', async () => {
  const f = fixture();
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  try {
    const bridge = await browser(f.port);
    const bound = await bridge.bind(owner, 'https://example.test/report', signal);
    expect(bound.ok).toBe(true); if (!bound.ok) return;
    f.pause(entered.resolve, release.promise);
    const pending = bridge.read(owner, bound.data, signal);
    await entered.promise; bridge.revoke(owner); release.resolve();
    expect(await pending).toMatchObject({ ok: false });
  } finally { release.resolve(); f.stop(); }
});

test('page text is truncated at a UTF-8 boundary and reports truncation', async () => {
  const f = fixture();
  try {
    const bridge = await browser(f.port);
    const bound = await bridge.bind(owner, 'https://example.test/report', signal);
    expect(bound.ok).toBe(true); if (!bound.ok) return;
    f.tabs.get(1)!.text = '字'.repeat(8000);
    const result = await bridge.read(owner, bound.data, signal);
    expect(result.ok).toBe(true); if (!result.ok) return;
    expect(result.data.truncated).toBe(true);
    expect(Buffer.byteLength(result.data.text, 'utf8')).toBe(21999);
    expect(result.data.text).toBe('字'.repeat(7333));
  } finally { f.stop(); }
});

test('replacing a browser binding prevents use of the earlier target', async () => {
  const f = fixture();
  try {
    const bridge = await browser(f.port);
    const first = await bridge.bind(owner, 'https://example.test/first', signal);
    const second = await bridge.bind(owner, 'https://example.test/second', signal);
    expect(first.ok && second.ok).toBe(true); if (!first.ok || !second.ok) return;
    expect(await bridge.read(owner, first.data, signal)).toMatchObject({ ok: false });
    expect(await bridge.read(owner, second.data, signal)).toMatchObject({ ok: true });
    expect(f.reads()).toBe(1);
  } finally { f.stop(); }
});

test('a bound target can be resolved without reading and disappears on revocation', async () => {
  const f = fixture();
  try {
    const bridge = await browser(f.port);
    const bound = await bridge.bind(owner, 'https://example.test/report', signal);
    expect(bound.ok).toBe(true); if (!bound.ok) return;
    const selected = Reflect.get(bridge, 'selectedTarget');
    expect(typeof selected).toBe('function'); if (typeof selected !== 'function') return;
    expect(selected(owner)).toEqual(bound);
    expect(selected({ ...owner, itemId: 3 })).toMatchObject({ ok: false });
    expect(f.reads()).toBe(0);
    bridge.revoke(owner);
    expect(selected(owner)).toMatchObject({ ok: false });
  } finally { f.stop(); }
});

test('a restarted WebBridge invalidates bindings before any later read', async () => {
  const f = fixture();
  try {
    const module = await import('../../apps/desktop/main/kimi-webbridge.ts');
    const create = Reflect.get(module, 'createKimiWebBridgeManager');
    expect(typeof create).toBe('function'); if (typeof create !== 'function') return;
    let pid = 10;
    const manager = create(async () => ({ pid, port: f.port }));
    const first = await manager.open(); expect(first.ok).toBe(true); if (!first.ok) return;
    const bound = await first.data.bind(owner, 'https://example.test/report', signal); expect(bound.ok).toBe(true); if (!bound.ok) return;
    pid = 11;
    const second = await manager.open(); expect(second.ok).toBe(true); if (!second.ok) return;
    expect(second.data.selectedTarget(owner)).toMatchObject({ ok: false });
    expect(await first.data.read(owner, bound.data, signal)).toMatchObject({ ok: false });
    expect(f.reads()).toBe(0);
    manager.close();
  } finally { f.stop(); }
});

test('a WebBridge restart during a read suppresses the page before desktop delivery', async () => {
  const f = fixture(), entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  try {
    const module = await import('../../apps/desktop/main/kimi-webbridge.ts');
    const handle = Reflect.get(module, 'handleKimiBrowserRequest');
    expect(typeof handle).toBe('function'); if (typeof handle !== 'function') return;
    let pid = 10;
    const manager = module.createKimiWebBridgeManager(async () => ({ pid, port: f.port }));
    const opened = await manager.open(); expect(opened.ok).toBe(true); if (!opened.ok) return;
    const bound = await opened.data.bind(owner, 'https://example.test/report', signal); expect(bound.ok).toBe(true); if (!bound.ok) return;
    f.pause(entered.resolve, release.promise);
    const pending = handle(manager, owner, { kind: 'browser_read', ...owner, proposalId: 3, target: bound.data }, signal);
    await entered.promise; pid = 11; release.resolve();
    expect(await pending).toMatchObject({ ok: false });
    manager.close();
  } finally { release.resolve(); f.stop(); }
});
