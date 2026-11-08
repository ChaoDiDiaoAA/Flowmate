import { expect, test } from 'bun:test';
import { createKimiMcpApi, kimiChildEnvironment } from '../../apps/desktop/main/kimi-mcp.ts';
import * as kimi from '../../apps/desktop/main/kimi-mcp.ts';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync } from '../support/resources.ts';

test('the desktop can discover the explicitly installed Kimi runtime without global environment variables', () => {
  const resolve = Reflect.get(kimi, 'resolveKimiPaths');
  expect(typeof resolve).toBe('function'); if (typeof resolve !== 'function') return;
  const root = mkdtempSync(join(tmpdir(), 'flowmate-kimi-paths-'));
  mkdirSync(join(root, 'data'));
  const pluginRoot = join(root, 'plugin'), runtimeExecutable = join(root, 'runtime', 'kimi-cu.exe');
  writeFileSync(join(root, 'data', 'kimi-cu.json'), JSON.stringify({ version: 1, pluginRoot, runtimeExecutable }));
  expect(resolve(root, {})).toEqual({ pluginRoot, runtimeExecutable });
  expect(resolve(root, { FLOWMATE_KIMICU_PLUGIN_ROOT: pluginRoot })).toBeNull();
  expect(resolve(root, { FLOWMATE_KIMICU_PLUGIN_ROOT: pluginRoot, KIMI_CU_WINDOWS_EXE: runtimeExecutable }))
    .toEqual({ pluginRoot, runtimeExecutable });
});

test('the Kimi child receives desktop startup variables but no model credentials', () => {
  expect(kimiChildEnvironment({ PATH: 'node-path', USERNAME: 'user', SECRET_API_KEY: 'private' }, 'D:\\KimiCU\\runtime\\kimi-cu.exe'))
    .toEqual({ PATH: 'node-path', USERNAME: 'user', KIMI_CU_WINDOWS_EXE: 'D:\\KimiCU\\runtime\\kimi-cu.exe' });
});

test('the MCP adapter uses fixed operations and passes UI text only as data', async () => {
  const window = { id: 42, app: 'Example', title: 'Draft' }, signal = new AbortController().signal;
  const calls: Array<{ operation: string; args: unknown }> = [];
  let tree = '[3] Edit value', focused = 'Focused: Edit value';
  const cu = {
    list_windows: async () => [window],
    get_window_state: async (args: unknown) => { calls.push({ operation: 'observe', args });
      return { window, accessibility: { tree, focused_element: focused } }; },
    set_value: async (args: unknown) => { calls.push({ operation: 'setValue', args }); },
  };
  const client = { callTool: async (name: string, args: Record<string, unknown>) => {
    expect(name).toBe('js');
    let output = '';
    const run = new (Object.getPrototypeOf(async function () {}).constructor)('kimiCU', 'nodeRepl', String(args.code));
    await run(cu, { write: (value: string) => { output += value; } });
    return { content: [{ type: 'text' as const, text: output }], isError: false };
  }, close: async () => {} };
  const api = createKimiMcpApi(client);
  expect(await api.listWindows(signal)).toEqual([window]);
  expect(await api.observe(window, signal)).toEqual({ window, tree: '[3] Edit value', focused: 'Focused: Edit value', truncated: false });
  const text = '" ); throw new Error("injected"); //\n开票';
  await api.setValue(window, 3, text, signal);
  expect(calls).toEqual([{ operation: 'observe', args: { window, include_screenshot: false, include_text: true } },
    { operation: 'setValue', args: { window, element_index: 3, value: text } }]);
  tree += '\n' + 'x'.repeat(30000) + '\n[9] Edit IsPassword=true value=fixture-secret';
  expect(await api.observe(window, signal)).toEqual({ protected: true });
  tree = '[3] Edit value';
  focused = 'Focused: 编辑 验证码';
  expect(await api.observe(window, signal)).toEqual({ protected: true });
});

test('the MCP adapter treats an error result as failure, never as successful input', async () => {
  const api = createKimiMcpApi({ callTool: async () => ({ content: [{ type: 'text' as const, text: 'computer_use_busy' }], isError: true }),
    close: async () => {} });
  await expect(api.click({ id: 42, app: 'Example', title: 'Draft' }, 3, new AbortController().signal)).rejects.toThrow('computer_use_busy');
});

test('an interrupted MCP call closes its connection before returning', async () => {
  let closed = false;
  const api = createKimiMcpApi({ callTool: async () => { throw Error('transport timeout'); }, close: async () => { closed = true; } });
  await expect(api.listWindows(new AbortController().signal)).rejects.toThrow();
  expect(closed).toBe(true);
});

test('a failed Kimi cell closes its potentially stale session', async () => {
  let closed = false;
  const api = createKimiMcpApi({ callTool: async () => ({ content: [{ type: 'text' as const, text: 'cell interrupted' }], isError: true }),
    close: async () => { closed = true; } });
  await expect(api.listWindows(new AbortController().signal)).rejects.toThrow();
  expect(closed).toBe(true);
});
