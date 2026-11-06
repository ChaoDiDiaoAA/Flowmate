import { DesktopActionTargetSchema, type DesktopActionTarget } from '@flowmate/contracts';
import { McpClient, StdioTransport } from '@earendil-works/pi-mcp';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { z } from 'zod';

type Window = DesktopActionTarget['window'];
type Client = { callTool(name: string, args: Record<string, unknown>, options?: { signal?: AbortSignal; timeoutMs?: number }): Promise<{ content: readonly { type: string; text?: string }[]; isError?: boolean }>;
  close(): Promise<void> };

export function resolveKimiPaths(userDataRoot: string, env: NodeJS.ProcessEnv): { pluginRoot: string; runtimeExecutable: string } | null {
  const paths = z.object({ pluginRoot: z.string().min(1).max(4096).refine(isAbsolute), runtimeExecutable: z.string().min(1).max(4096).refine(isAbsolute) }).strict();
  if (env.FLOWMATE_KIMICU_PLUGIN_ROOT !== undefined || env.KIMI_CU_WINDOWS_EXE !== undefined) {
    const value = paths.safeParse({ pluginRoot: env.FLOWMATE_KIMICU_PLUGIN_ROOT, runtimeExecutable: env.KIMI_CU_WINDOWS_EXE });
    return value.success ? value.data : null;
  }
  try {
    const file = join(userDataRoot, 'data', 'kimi-cu.json'); if (statSync(file).size > 8192) return null;
    const value = paths.extend({ version: z.literal(1) }).strict().safeParse(JSON.parse(readFileSync(file, 'utf8')));
    return value.success ? { pluginRoot: value.data.pluginRoot, runtimeExecutable: value.data.runtimeExecutable } : null;
  } catch { return null; }
}

export function kimiChildEnvironment(env: NodeJS.ProcessEnv, runtime: string): Record<string, string> {
  const names = ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'COMSPEC', 'PATHEXT', 'TEMP', 'TMP', 'WINDIR',
    'HOME', 'USERPROFILE', 'LOCALAPPDATA', 'APPDATA', 'USERNAME', 'USER'];
  return { ...Object.fromEntries(names.flatMap(name => env[name] === undefined ? [] : [[name, env[name]!] ])), KIMI_CU_WINDOWS_EXE: runtime };
}

export function createKimiMcpApi(client: Client) {
  const marker = 'FLOWMATE_RESULT:';
  const call = async (expression: string, args: unknown, signal: AbortSignal): Promise<unknown> => {
    const data = JSON.stringify(JSON.stringify(args));
    let result: Awaited<ReturnType<Client['callTool']>>;
    try { result = await client.callTool('js', { code: `var flowmateArgs = JSON.parse(${data});\n${expression}` }, { signal, timeoutMs: 8000 }); }
    catch (error) { await client.close(); throw error; }
    if (result.isError) {
      if (result.content.some(item => item.type === 'text' && item.text?.includes('computer_use_busy'))) throw Error('computer_use_busy');
      await client.close(); throw Error('desktop_operation_failed');
    }
    const text = result.content.find(item => item.type === 'text' && item.text?.startsWith(marker))?.text;
    if (!text) throw Error('desktop_result_invalid');
    return JSON.parse(text.slice(marker.length));
  };
  const write = (expression: string) => `nodeRepl.write(${JSON.stringify(marker)} + JSON.stringify(${expression}), "flowmate-result");`;
  const windowSchema = DesktopActionTargetSchema.shape.window;
  const observeSchema = z.object({ window: windowSchema, tree: z.string(), focused: z.string().nullable(), truncated: z.boolean() }).strict();
  return {
    listWindows: async (signal: AbortSignal): Promise<Window[]> => z.array(windowSchema).parse(await call(
      `var flowmateValue = await kimiCU.list_windows();\n${write('flowmateValue')}`, {}, signal)),
    observe: async (window: Window, signal: AbortSignal) => observeSchema.parse(await call(
      `var flowmateValue = await kimiCU.get_window_state({window: flowmateArgs.window, include_screenshot: false, include_text: true});\n`
      + `var flowmateTree = flowmateValue.accessibility?.tree ?? null;\n`
      + `var flowmateTruncated = !!flowmateTree && flowmateTree.length > 30000;\n`
      + `if (flowmateTruncated) flowmateTree = flowmateTree.slice(0, 30000).replace(/[^\\n]*$/, "");\n`
      + write('{window: flowmateValue.window, tree: flowmateTree, focused: flowmateValue.accessibility?.focused_element ?? null, truncated: flowmateTruncated}'), { window }, signal)),
    click: async (window: Window, index: number, signal: AbortSignal) => { await call(
      `await kimiCU.click({window: flowmateArgs.window, element_index: flowmateArgs.index});\n${write('true')}`, { window, index }, signal); },
    setValue: async (window: Window, index: number, value: string, signal: AbortSignal) => { await call(
      `await kimiCU.set_value({window: flowmateArgs.window, element_index: flowmateArgs.index, value: flowmateArgs.value});\n${write('true')}`,
      { window, index, value }, signal); },
    typeText: async (window: Window, value: string, signal: AbortSignal) => { await call(
      `await kimiCU.type_text({window: flowmateArgs.window, text: flowmateArgs.value});\n${write('true')}`, { window, value }, signal); },
    close: () => client.close(),
  };
}

export async function connectKimiMcp(root: string, runtime: string) {
  if (process.platform !== 'win32' || !isAbsolute(root) || !isAbsolute(runtime) || !existsSync(runtime)
    || ['bundle.json', 'kimi.plugin.json', 'runtime/node-repl.exe', 'skills/kimi-cu/SKILL.md',
      'skills/kimi-cu/references/api.md', 'skills/kimi-cu/references/repl.md'].some(path => !existsSync(join(root, path))))
    throw Error('kimi_plugin_unavailable');
  const bundle = JSON.parse(readFileSync(join(root, 'bundle.json'), 'utf8')) as { kind?: unknown };
  if (bundle.kind !== 'release') throw Error('kimi_plugin_unavailable');
  const client = new McpClient({ name: 'flowmate-desktop', version: '0.1.0', requestTimeoutMs: 10000 });
  try {
    await client.connect(new StdioTransport({ command: join(root, 'runtime/node-repl.exe'), cwd: root,
      env: kimiChildEnvironment(process.env, runtime), inheritEnv: false }));
    if (!(await client.listTools()).some(tool => tool.name === 'js')) throw Error('kimi_plugin_unavailable');
    const ready = await client.callTool('js', { code: 'var { kimiCU } = await import("@kimi/cu"); nodeRepl.write("ready");' }, { timeoutMs: 10000 });
    if (ready.isError || !ready.content.some(item => item.type === 'text' && item.text === 'ready')) throw Error('kimi_plugin_unavailable');
    return { api: createKimiMcpApi(client), onClose: (listener: () => void) => client.onClose(listener) };
  } catch (error) { await client.close().catch(() => {}); throw error; }
}
