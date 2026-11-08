import { expect, test } from 'bun:test';
import { connectKimiMcp, kimiChildEnvironment } from '../../apps/desktop/main/kimi-mcp.ts';

const root = process.env.FLOWMATE_KIMICU_PLUGIN_ROOT;
const runtime = process.env.KIMI_CU_WINDOWS_EXE;

test.skipIf(process.platform !== 'win32' || !root || !runtime)('the installed Kimi plugin lists windows and closes its own connection', async () => {
  const session = await connectKimiMcp(root!, runtime!);
  try {
    const windows = await session.api.listWindows(new AbortController().signal);
    expect(Array.isArray(windows)).toBe(true);
    expect(windows.length).toBeGreaterThan(0);
    expect(windows.every(window => window.id > 0 && typeof window.app === 'string' && typeof window.title === 'string')).toBe(true);
    const codex = windows.find(window => /codex/i.test(`${window.app} ${window.title}`));
    if (codex) {
      const state = await session.api.observe(codex, new AbortController().signal);
      if ('protected' in state) expect(state).toEqual({ protected: true });
      else {
        expect(state.window).toEqual(codex);
        expect(typeof state.tree).toBe('string');
      }
    }
  } finally { await session.api.close(); }
});

test.skipIf(process.platform !== 'win32' || !root || !runtime)('an interrupted Kimi request closes its plugin connection', async () => {
  const node = Bun.which('node'); if (!node) throw Error('node_unavailable');
  const child = Bun.spawn([node, '--import', 'tsx', '--input-type=module', '-e', `
    import { connectKimiMcp } from './apps/desktop/main/kimi-mcp.ts';
    const session = await connectKimiMcp(process.env.FLOWMATE_KIMICU_PLUGIN_ROOT, process.env.KIMI_CU_WINDOWS_EXE);
    let closed = false; session.onClose(() => { closed = true; });
    const controller = new AbortController(), pending = session.api.listWindows(controller.signal);
    controller.abort();
    try { await pending; process.exitCode = 2; } catch { if (!closed) process.exitCode = 3; }
  `], { cwd: process.cwd(), env: { ...kimiChildEnvironment(process.env, runtime!), FLOWMATE_KIMICU_PLUGIN_ROOT: root! },
    stdout: 'pipe', stderr: 'pipe', windowsHide: true });
  const error = await new Response(child.stderr).text();
  expect(await child.exited, error).toBe(0);
}, 15000);
