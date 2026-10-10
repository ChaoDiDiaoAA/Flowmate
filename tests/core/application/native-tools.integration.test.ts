import { describe, expect, it } from 'bun:test';
import { InMemoryCredentialStore } from '@earendil-works/pi-ai';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Database } from 'bun:sqlite';
import { NATIVE_TOOL_NAMES, RESEARCH_PLANNING_TOOL_NAMES, RESEARCH_INVESTIGATION_TOOL_NAMES } from '@flowmate/contracts';
import type { AgentRunEvent, AgentRunSnapshot, ProviderConfig } from '@flowmate/contracts';
import { createApplication } from '../../../apps/composition.ts';
import { PiAgentAdapter } from '../../../packages/runtime-pi/src/session.ts';
import { deferCleanup, mkdtempSync } from '../../support/resources.ts';

describe('native tools through the public Application', () => {
  it.each([false, true])('uses the unique Executor and restores history without replay with SDK-normalized arguments=%s', async (normalized) => {
    const root = mkdtempSync(join(tmpdir(), 'flowmate-native-application-'));
    const working = join(root, 'chosen'); mkdirSync(working);
    writeFileSync(join(working, 'note.txt'), normalized ? 'ignored line\nlocal source text' : 'local source text');
    const product = join(root, 'product');
    const paths = { root: product, databaseFile: join(product, 'data', 'app.sqlite'), runtimeDir: join(product, 'runtime'),
      artifactsDir: join(product, 'artifacts'), outputsDir: join(product, 'outputs'), logsDir: join(product, 'logs') };
    const requests: Array<{ messages: Array<{ role: string; content?: string }>; tools?: Array<{ function: { name: string } }> }> = [];
    const steps = [
      [{ name: 'ls', arguments: { path: '.' } }, { name: 'read', arguments: normalized
        ? { path: 'note.txt', offset: '2', limit: null } : { path: 'note.txt' } }],
      [{ name: 'write', arguments: { path: 'result.txt', content: 'hello\n' } }],
      [{ name: 'edit', arguments: { path: 'result.txt', edits: [{ oldText: 'hello', newText: 'world' }] } }],
      [{ name: 'read', arguments: { path: 'result.txt' } }],
    ];
    const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
      requests.push(await request.json());
      const ordinal = requests.length;
      const calls = steps[ordinal - 1];
      const delta = calls ? { role: 'assistant', tool_calls: calls.map((call, index) => ({ index,
        id: `native-${ordinal}-${index}`, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.arguments) } })) }
        : { role: 'assistant', content: 'The local source text was read and result.txt now contains world.' };
      const chunk = (delta: unknown, reason: string | null) => `data: ${JSON.stringify({ id: `native-response-${ordinal}`,
        model: 'native-model', choices: [{ index: 0, delta, finish_reason: reason }] })}\n\n`;
      return new Response(`${chunk(delta, null)}${chunk({}, calls ? 'tool_calls' : 'stop')}data: [DONE]\n\n`,
        { headers: { 'content-type': 'text/event-stream' } });
    } });
    deferCleanup(() => server.stop(true));
    const config: ProviderConfig = { version: 1, name: 'Controlled native model', revision: 1,
      modelRef: { provider: 'native-fixture', model: 'native-model' }, native: { authPath: join(root, 'unused.json'), modelsPath: null },
      connection: { baseUrl: `http://127.0.0.1:${server.port}/v1`, api: 'openai-completions', contextWindow: 64_000, maxTokens: 16_384 },
      parameters: { maxRetries: 0, maxRetryDelayMs: 100 } };
    const launch = () => createApplication({ paths, logger: { write() {}, close: async () => {} },
      agentFactory: definitions => {
        expect(definitions.map(tool => tool.name).slice(-8)).toEqual([...NATIVE_TOOL_NAMES]);
        const researchNames = new Set<string>([...RESEARCH_PLANNING_TOOL_NAMES, ...RESEARCH_INVESTIGATION_TOOL_NAMES]);
        expect(new Set(definitions.map(tool => tool.name)).size).toBe(definitions.length);
        expect(definitions.filter(tool => !researchNames.has(tool.name))).toHaveLength(24);
        expect(definitions.filter(tool => tool.name === 'Agent')).toHaveLength(1);
        expect(definitions.filter(tool => tool.name === 'list_skill_resources')).toHaveLength(1);
        expect(definitions.filter(tool => tool.name === 'read_skill_resource')).toHaveLength(1);
        return new PiAgentAdapter({ cwd: paths.runtimeDir, agentDir: paths.runtimeDir, tools: definitions,
          credentials: new InMemoryCredentialStore(), runtimeApiKey: 'synthetic-native-key' });
      } });
    let opened = await launch();
    if (!opened.ok) throw new Error(opened.error.code);
    let app = opened.data;
    let sessionId = 0;
    try {
      const before = await app.readWorkspace();
      if (!before.ok) throw new Error(before.error.code);
      const session = await app.createSession({ title: 'File task', expectedRevision: before.data.revision });
      if (!session.ok) throw new Error(session.error.code);
      sessionId = session.data.sessionId;
      const current = await app.readWorkspace();
      if (!current.ok) throw new Error(current.error.code);
      const workspace = { revision: current.data.revision, sessionId, documentRef: current.data.documentRef,
        jobId: current.data.jobId, candidateRef: current.data.candidateRef };
      const terminal = new Promise<AgentRunEvent & { type: 'run_finished' }>(done => {
        void app.startRun({ sessionId, text: 'Read the note and write then edit result.txt.', config,
          goalMode: 'answer', workspace, workingDirectory: working }, { onEvent: event => {
            if (event.type === 'run_finished') done(event);
          } }).then(accepted => { if (!accepted.ok) throw new Error(accepted.error.code); });
      });
      const finished = await terminal;
      expect(finished.result).toMatchObject({ ok: true, data: { status: 'completed', stopped: true, error: null } });
      expect(await app.queryRuntimeState()).toMatchObject({ ok: true, data: { active: null, blocked: false } });
      expect(readFileSync(join(working, 'result.txt'), 'utf8')).toBe('world\n');
      expect(await app.readWorkspace()).toEqual(current);
      expect(requests).toHaveLength(5);
      expect(requests[0]?.tools?.map(tool => tool.function.name)).toEqual(expect.arrayContaining(['read', 'ls', 'edit', 'write']));
      expect(requests[0]?.tools?.map(tool => tool.function.name)).toEqual(expect.arrayContaining(['bash', 'powershell', 'normalize_invoice_values', 'calculate_invoice_amounts']));
      expect(requests[1]?.messages.filter(message => message.role === 'tool').map(message => message.content))
        .toEqual(expect.arrayContaining(['local source text']));
      const messages = await app.listSessionMessages({ sessionId });
      expect(messages.ok).toBe(true);
      if (messages.ok) expect(messages.data.items.filter(message => message.role === 'toolResult')).toHaveLength(5);
    } finally { await app.close(); }
    const db = new Database(paths.databaseFile, { readonly: true });
    const calls = db.query('SELECT tool_name,status,args_json,result_json,delivery_json,cleanup_json FROM tool_calls ORDER BY id').all() as Array<Record<string, string>>;
    expect(calls.map(call => call.tool_name)).toEqual(['ls', 'read', 'write', 'edit', 'read']);
    expect(calls.every(call => call.status === 'succeeded' && JSON.parse(call.delivery_json!).state === 'request_observed'
      && JSON.parse(call.cleanup_json!).stopped)).toBe(true);
    expect(JSON.parse(calls[1]!.result_json!).data.content).toEqual([{ type: 'text', text: 'local source text' }]);
    expect(JSON.parse(calls[1]!.args_json!)).toEqual({ version: 1,
      raw: normalized ? { path: 'note.txt', offset: '2', limit: null } : { path: 'note.txt' },
      final: normalized ? { path: 'note.txt', offset: 2 } : { path: 'note.txt' } });
    expect(db.query('SELECT * FROM jobs').all()).toHaveLength(0);
    db.close();
    opened = await launch(); if (!opened.ok) throw new Error(opened.error.code); app = opened.data;
    try {
      expect((await app.querySession(sessionId))).toMatchObject({ ok: true, data: { historyState: 'recoverable' } });
      const restored = await app.listSessionMessages({ sessionId }); expect(restored.ok).toBe(true);
      expect(requests).toHaveLength(5);
      expect(readFileSync(join(working, 'result.txt'), 'utf8')).toBe('world\n');
    } finally { await app.close(); }
  }, 30_000);
});
