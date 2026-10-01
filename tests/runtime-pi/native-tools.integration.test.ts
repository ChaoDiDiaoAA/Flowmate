import { describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { delimiter, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { NATIVE_TOOL_NAMES, NativeToolOutputSchema, ToolExecutionFailure, ok } from '@flowmate/contracts';
import type { ProductToolContext, NativeToolOutput } from '@flowmate/contracts';
import { createNativeTools, getNativeToolParameters } from '../../packages/runtime-pi/src/native-tools.ts';
import { deferCleanup, mkdtempSync } from '../support/resources.ts';

function fixture() {
  if (process.platform === 'win32') {
    const git = Bun.which('git');
    const gitBin = git && resolve(dirname(git), '..', 'bin');
    if (!gitBin || !existsSync(join(gitBin, 'bash.exe'))) throw new Error('Native SDK integration requires installed Git Bash.');
    const pathKey = Object.keys(process.env).find(key => key.toLowerCase() === 'path') ?? 'PATH';
    const priorPath = process.env[pathKey];
    process.env[pathKey] = gitBin + delimiter + (priorPath ?? '');
    deferCleanup(() => { if (priorPath === undefined) delete process.env[pathKey]; else process.env[pathKey] = priorPath; });
  }
  const priorOffline = process.env.PI_OFFLINE;
  process.env.PI_OFFLINE = '1';
  deferCleanup(() => { if (priorOffline === undefined) delete process.env.PI_OFFLINE; else process.env.PI_OFFLINE = priorOffline; });
  const root = mkdtempSync(join(tmpdir(), 'flowmate-native-tools-'));
  const working = join(root, 'working');
  mkdirSync(working);
  writeFileSync(join(working, 'note.txt'), 'alpha\nbeta\nalpha gamma\n');
  const ctx: ProductToolContext = { runId: 1, sessionId: 2, scope: { version: 2, allowedTools: [...NATIVE_TOOL_NAMES],
    allowedDocumentIds: [], allowedArtifactIds: [], allowedResourcePaths: [] } };
  const runtime = createNativeTools({ getWorkingDirectory: () => ok(working) });
  function execute(name: typeof NATIVE_TOOL_NAMES[number], input: unknown, signal = new AbortController().signal) {
    const definition = runtime.definitions.find(tool => tool.name === name)!;
    return definition.execute(definition.inputSchema.parse(input), { nativeToolCallId: `native-${name}`, signal }, ctx);
  }
  return { root, working, runtime, execute };
}

describe('Pi native tool factory bridge', () => {
  it('uses all eight SDK parameter schemas and ordinary Run context without a filesystem permission layer', async () => {
    const f = fixture();
    expect(f.runtime.definitions.map(tool => tool.name)).toEqual([...NATIVE_TOOL_NAMES]);
    for (const definition of f.runtime.definitions) {
      expect(getNativeToolParameters(definition)).toMatchObject({ type: 'object' });
      expect(definition.version).toBe('pi-0.85.1');
    }
    expect(await f.execute('read', { path: 'note.txt', offset: 2, limit: 1 })).toMatchObject({ content: [{ text: expect.stringContaining('beta') }] });
    await f.execute('write', { path: 'nested/result.txt', content: 'hello\n' });
    expect(await f.execute('edit', { path: 'nested/result.txt', edits: [{ oldText: 'hello', newText: 'world' }] })).toMatchObject({ details: { firstChangedLine: 1 } });
    expect(readFileSync(join(f.working, 'nested/result.txt'), 'utf8')).toBe('world\n');
    const outside = join(f.root, 'ordinary-absolute.txt');
    await f.execute('write', { path: outside, content: 'SDK absolute paths' });
    expect(JSON.stringify(await f.execute('read', { path: outside }))).toContain('SDK absolute paths');
    expect(JSON.stringify(await f.execute('ls', { path: '.' }))).toContain('note.txt');
    for (const name of ['grep', 'find'] as const) {
      try { expect(JSON.stringify(await f.execute(name, { path: '.', pattern: name === 'grep' ? 'alpha' : '*.txt' }))).toContain('note.txt'); }
      catch (error) { expect(error).toBeInstanceOf(ToolExecutionFailure); const data = (error as ToolExecutionFailure<NativeToolOutput>).data; expect(data?.content[0]?.type === 'text' ? data.content[0].text : '').toMatch(/available|downloaded/i); }
    }
  }, 15_000);

  it('uses SDK image handling, missing-file errors and parameter normalization', async () => {
    const f = fixture();
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4//8/AAX+Av4N70a4AAAAAElFTkSuQmCC', 'base64');
    writeFileSync(join(f.working, 'pixel.png'), png);
    const image = await f.execute('read', { path: 'pixel.png' });
    expect(image.content.some(block => block.type === 'image')).toBe(true);
    expect(NativeToolOutputSchema.safeParse(image).success).toBe(true);
    try { await f.execute('read', { path: 'timed out missing.txt' }); throw new Error('Expected native failure'); }
    catch (error) {
      expect(error).toBeInstanceOf(ToolExecutionFailure);
      expect((error as ToolExecutionFailure).error.code).toBe('tool_execution_failed');
      const data = (error as ToolExecutionFailure<NativeToolOutput>).data;
      expect(data?.content[0]?.type === 'text' ? data.content[0].text : '').toContain('timed out missing.txt');
    }
    const read = f.runtime.definitions.find(tool => tool.name === 'read')!;
    expect(read.inputSchema.parse({ path: 'note.txt', offset: '2', limit: null })).toEqual({ path: 'note.txt', offset: 2 });
    expect(read.inputSchema.safeParse({}).success).toBe(false);
  });

  for (const name of process.platform === 'win32' ? ['bash', 'powershell'] as const : ['bash'] as const) {
  it(`delegates ${name} output truncation and fullOutputPath to the SDK without another file copy`, async () => {
    const f = fixture();
    const command = name === 'powershell' ? "[Console]::Out.Write(('x'*60000))" : "printf '%60000s' | tr ' ' x";
    const short = await f.execute(name, { command: name === 'powershell' ? "Write-Output 'sdk-shell'" : "printf sdk-shell" });
    expect(NativeToolOutputSchema.safeParse(short).success).toBe(true);
    try { await f.execute(name, { command: name === 'powershell' ? "Write-Output 'timeout: actual-error'; exit 7" : "printf 'timeout: actual-error'; exit 7" }); throw new Error('Expected native failure'); }
    catch (error) {
      expect(error).toBeInstanceOf(ToolExecutionFailure);
      expect((error as ToolExecutionFailure).error.code).toBe('tool_execution_failed');
      const data = (error as ToolExecutionFailure<NativeToolOutput>).data;
      expect(NativeToolOutputSchema.safeParse(data).success).toBe(true);
      expect(JSON.stringify(data)).toContain('Command exited with code 7');
    }
    const output = await f.execute(name, { command });
    const path = (output.details as { fullOutputPath: string }).fullOutputPath;
    expect(typeof path).toBe('string');
    expect((output.details as { truncation: { truncated: boolean } }).truncation.truncated).toBe(true);
    expect(readFileSync(path, 'utf8')).toHaveLength(60000);
    expect(JSON.stringify(output)).toContain(path.replaceAll('\\', '\\\\'));
    deferCleanup(async () => { const { rm } = await import('node:fs/promises'); await rm(path, { force: true }); });
  }, 10_000);

  it(`propagates ${name} cancellation and SDK timeout and never performs a later command side effect`, async () => {
    const f = fixture();
    const command = name === 'powershell' ? "Set-Content -LiteralPath started.txt -Value started; Start-Sleep -Seconds 2; Set-Content -LiteralPath marker.txt -Value late"
      : 'echo started > started.txt; sleep 2; echo late > marker.txt';
    const controller = new AbortController();
    const pending = f.execute(name, { command }, controller.signal);
    for (let attempt = 0; !existsSync(join(f.working, 'started.txt')) && attempt < 200; attempt++)
      await new Promise(resolve => setTimeout(resolve, 10));
    const started = existsSync(join(f.working, 'started.txt'));
    controller.abort();
    await expect(pending).rejects.toMatchObject({ error: { code: 'tool_cancelled' } });
    expect(started).toBe(true);
    await expect(f.execute(name, { command, timeout: 0.1 })).rejects.toMatchObject({ error: { code: 'tool_timeout' } });
    await new Promise(resolve => setTimeout(resolve, 2300));
    expect(existsSync(join(f.working, 'marker.txt'))).toBe(false);
  }, 10_000);
  }
});
