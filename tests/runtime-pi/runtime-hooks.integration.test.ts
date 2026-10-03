import { expect, it } from 'bun:test';
import { InMemoryCredentialStore } from '@earendil-works/pi-ai';
import { Database } from 'bun:sqlite';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { AgentRunEvent, AgentToolBinding, ProviderConfig, ToolCallSnapshot, ToolRuntimeObservation } from '@flowmate/contracts';
import { createApplication } from '../../apps/composition.ts';
import { PiAgentAdapter } from '../../packages/runtime-pi/src/session.ts';
import { deferCleanup, mkdtempSync } from '../support/resources.ts';

for (const mode of ['schema', 'sdk-block', 'sdk-throw', 'sdk-id-mutate', 'sdk-name-mutate', 'sdk-raw-mutate', 'sdk-id-mutate-throw', 'sdk-normalize', 'duplicate-raw', 'host-cancel', 'after-rewrite', 'after-mutate', 'after-is-error', 'after-oversize', 'after-throw'] as const) {
  it('persists the real SDK hook ordering and fixed outcome for ' + mode, async () => {
    const root = mkdtempSync(join(tmpdir(), 'flowmate-runtime-hooks-'));
    const paths = { root, databaseFile: join(root, 'data/app.sqlite'), artifactsDir: join(root, 'artifacts'),
      outputsDir: join(root, 'outputs'), logsDir: join(root, 'logs'), runtimeDir: join(root, 'runtime') };
    let before = 0, after = 0, business = 0, requests = 0;
    let fixedFacts: Pick<ToolCallSnapshot, 'result' | 'runtimeObservation' | 'endedAt' | 'stoppedAt'> | undefined;
    let queryCall: AgentToolBinding['queryCall'];
    const payloads: Array<{ messages: Array<{ role: string; content: unknown }> }> = [];
    const args = { operation: 'sum', values: ['0.1', '0.2'], scale: mode === 'schema' ? 'invalid' : 2 };
    const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: async request => {
      payloads.push(await request.json() as typeof payloads[number]);
      requests += 1;
      const toolResponse = requests === 1 || mode === 'duplicate-raw' && requests === 2;
      const toolArgs = mode === 'duplicate-raw' && requests === 2 ? { ...args, scale: 3 } : args;
      const delta = toolResponse ? { role: 'assistant', tool_calls: [{ index: 0, id: 'runtime-hook-call', type: 'function',
        function: { name: 'calculate_invoice_amounts', arguments: JSON.stringify(toolArgs) } }] }
        : { role: 'assistant', content: 'Finished.' };
      const finish_reason = toolResponse ? 'tool_calls' : 'stop';
      const chunk = (value: unknown) => 'data: ' + JSON.stringify(value) + '\n\n';
      return new Response(chunk({ id: 'controlled-runtime', model: 'controlled-runtime', choices: [{ index: 0, delta, finish_reason: null }] })
        + chunk({ id: 'controlled-runtime', model: 'controlled-runtime', choices: [{ index: 0, delta: {}, finish_reason }] })
        + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
    } });
    deferCleanup(() => server.stop(true));
    const opened = await createApplication({ paths, logger: { write() {}, close: async () => undefined },
      toolDefinitions: definitions => definitions.map(tool => tool.name === 'calculate_invoice_amounts'
        ? { ...tool, execute: (...call: Parameters<typeof tool.execute>) => { business += 1; return tool.execute(...call); } } : tool),
      agentFactory: definitions => {
      const adapter = new PiAgentAdapter({ cwd: paths.runtimeDir, agentDir: paths.runtimeDir, tools: definitions,
        credentials: new InMemoryCredentialStore(), runtimeApiKey: 'controlled-key', sessionSetup(session) {
          const originalBefore = session.agent.beforeToolCall, originalAfter = session.agent.afterToolCall;
          session.agent.beforeToolCall = async (...call) => {
            before += 1;
            const original = await originalBefore?.(...call);
            if (mode === 'sdk-throw') throw new Error('Controlled SDK before failure.');
            if (mode === 'sdk-id-mutate' || mode === 'sdk-id-mutate-throw') Reflect.set(call[0].toolCall, 'id', 'changed-call');
            if (mode === 'sdk-name-mutate') Reflect.set(call[0].toolCall, 'name', 'changed-tool');
            if (mode === 'sdk-raw-mutate') Reflect.set(call[0].toolCall.arguments, 'scale', 3);
            if (mode === 'sdk-id-mutate-throw') throw new Error('Controlled SDK before mutation failure.');
            if (mode === 'sdk-normalize' || mode === 'duplicate-raw') {
              if (!call[0].args || typeof call[0].args !== 'object') throw new Error('Expected normalized object arguments.');
              Reflect.set(call[0].args, 'scale', 1);
            }
            return mode === 'sdk-block' ? { block: true, reason: 'Controlled SDK block.' } : original;
          };
          session.agent.afterToolCall = async (...call) => {
            after += 1;
            const saved = queryCall?.(call[0].toolCall.id);
            if (!saved?.ok) throw new Error('Expected a saved ToolCall before SDK after.');
            fixedFacts = { result: saved.data.result, runtimeObservation: saved.data.runtimeObservation,
              endedAt: saved.data.endedAt, stoppedAt: saved.data.stoppedAt };
            const original = await originalAfter?.(...call);
            if (mode === 'after-throw') throw new Error('Controlled SDK after failure.');
            if (mode === 'after-is-error') return { ...original, isError: true };
            if (mode === 'after-oversize') return { ...original, content: [{ type: 'text', text: 'x'.repeat(1_000_000) }] };
            if (mode === 'after-mutate') {
              call[0].result.content[0] = { type: 'text', text: 'Forged tool output.' };
              Reflect.set(call[0].result.details as object, 'forged', true);
            }
            return mode === 'after-rewrite' ? { ...original, isError: false,
              content: [{ type: 'text', text: 'Forged tool output.' }], details: { forged: true } } : original;
          };
        } });
      const prepare = adapter.prepare.bind(adapter);
      adapter.prepare = async (...call) => {
        const prepared = await prepare(...call);
        if (!prepared.ok) return prepared;
        const executePrepared = prepared.data.execute;
        return { ...prepared, data: { ...prepared.data, execute: (input, signal, observe) => {
          const binding = input.toolBinding!;
          queryCall = binding.queryCall;
          if (mode !== 'host-cancel') return executePrepared(input, signal, observe);
          const cancelled = new AbortController(); cancelled.abort();
          return executePrepared({ ...input, toolBinding: { ...binding,
            execute: (name, final, context, raw) => binding.execute(name, final,
              { ...context, signal: cancelled.signal }, raw) } }, signal, observe);
        } } };
      };
      return adapter;
    } });
    if (!opened.ok) throw new Error(opened.error.code);
    const app = opened.data;
    let closed = false;
    try {
      const session = await app.createSession({ title: 'Runtime hooks' });
      if (!session.ok) throw new Error(session.error.code);
      const current = await app.readWorkspace();
      if (!current.ok) throw new Error(current.error.code);
      const selected = await app.updateWorkspace({ expectedRevision: current.data.revision,
        change: { kind: 'session', sessionId: session.data.sessionId } });
      if (!selected.ok) throw new Error(selected.error.code);
      const config: ProviderConfig = { version: 1, name: 'Controlled runtime', revision: 1,
        modelRef: { provider: 'runtime-hook-fixture', model: 'controlled-runtime' },
        native: { authPath: join(root, 'unused-auth.json'), modelsPath: null },
        connection: { baseUrl: 'http://127.0.0.1:' + server.port + '/v1', api: 'openai-completions', contextWindow: 64_000, maxTokens: 16_384 },
        parameters: { maxRetries: 0, maxRetryDelayMs: 1000 } };
      let finish!: (event: Extract<AgentRunEvent, { type: 'run_finished' }>) => void;
      const completion = new Promise<Extract<AgentRunEvent, { type: 'run_finished' }>>(resolve => { finish = resolve; });
      const accepted = await app.startRun({ sessionId: session.data.sessionId, text: 'Calculate the sum.', config,
        workspace: { revision: selected.data.revision, sessionId: session.data.sessionId,
          documentRef: null, jobId: null, candidateRef: null }, goalMode: 'answer' },
      { onEvent: event => { if (event.type === 'run_finished') finish(event); } });
      if (!accepted.ok) throw new Error(accepted.error.code);
      const terminal = await completion;
      expect(terminal.result.ok).toBe(true);
      expect(await app.close()).toMatchObject({ ok: true, data: { stopped: true, closed: true } });
      closed = true;
      const db = new Database(paths.databaseFile, { readonly: true });
      try {
        const row = db.query('SELECT status,args_json,result_json,runtime_observation_json,ended_at,stopped_at FROM tool_calls').get() as {
          status: string; args_json: string; result_json: string; runtime_observation_json: string | null;
          ended_at: string; stopped_at: string | null;
        };
        expect(row, JSON.stringify({ requests, before, after, business, terminal })).not.toBeNull();
        const observation: ToolRuntimeObservation | null = row.runtime_observation_json ? JSON.parse(row.runtime_observation_json) : null;
        if (mode === 'duplicate-raw') {
          expect(terminal.result).toMatchObject({ ok: true, data: { status: 'failed', error: { code: 'session_history_invalid' } } });
          expect(requests).toBe(2);
          expect(business).toBe(1);
          expect(row.status).toBe('succeeded');
          expect(JSON.parse(row.args_json)).toMatchObject({ raw: args, final: { ...args, scale: 1 } });
          return;
        }
        const mutated = mode.startsWith('sdk-') && mode.includes('-mutate');
        const sdkRejected = ['schema', 'sdk-block', 'sdk-throw'].includes(mode) || mutated;
        const rejected = sdkRejected || mode === 'host-cancel';
        expect(before).toBe(mode === 'schema' ? 0 : 1);
        expect(after).toBe(sdkRejected ? 0 : 1);
        expect(business).toBe(rejected ? 0 : 1);
        expect(observation).toMatchObject({ beforeOutcome: rejected ? 'rejected' : 'allowed',
          failureStage: mode === 'schema' ? 'sdk_arguments' : sdkRejected ? 'sdk_before' : mode === 'host-cancel' ? 'before' : null });
        if (rejected) expect(observation?.executionDurationMs).toBeNull();
        else expect(observation?.executionDurationMs).toBeGreaterThanOrEqual(0);
        expect(JSON.parse(row.args_json).raw).toEqual(args);
        expect(JSON.parse(row.args_json).final === null).toBe(sdkRejected);
        if (mutated) {
          expect(db.query('SELECT native_tool_call_id AS id,tool_name AS name,status FROM tool_calls').all())
            .toEqual([{ id: 'runtime-hook-call', name: 'calculate_invoice_amounts', status: 'failed' }]);
          expect(db.query('SELECT tool_call_count AS count FROM runs').get()).toEqual({ count: 1 });
          expect(terminal.result).toMatchObject({ ok: true, data: { status: 'completed', stopped: true } });
          expect(requests).toBe(2);
          const entries = db.query('SELECT entry_json AS entry FROM session_native_entries').all() as { entry: string }[];
          const messages = entries.map(entry => JSON.parse(entry.entry).message).filter(Boolean);
          expect(messages.find(message => message.role === 'assistant' && message.stopReason === 'toolUse').content)
            .toEqual([{ type: 'toolCall', id: 'runtime-hook-call', name: 'calculate_invoice_amounts', arguments: args }]);
          expect(messages.find(message => message.role === 'toolResult'))
            .toMatchObject({ toolCallId: 'runtime-hook-call', toolName: 'calculate_invoice_amounts', isError: true });
        }
        if (mode === 'sdk-block') expect(JSON.parse(row.result_json).error.message).toBe('Controlled SDK block.');
        if (mode === 'sdk-throw') expect(JSON.parse(row.result_json).error.message).toBe('Controlled SDK before failure.');
        if (mode === 'schema') expect(JSON.parse(row.result_json).error.message).toContain('first validation errors');
        if (mode === 'sdk-normalize') expect(JSON.parse(row.args_json).final).toEqual({ ...args, scale: 1 });
        if (mode === 'sdk-normalize') {
          const saved = db.query('SELECT config_json,output_json FROM runs').get() as { config_json: string; output_json: string };
          const config = JSON.parse(saved.config_json), output = JSON.parse(saved.output_json);
          expect(config.version).toBe(2);
          expect(config.runtimeBudget).toEqual({ maxToolCalls: 24, maxModelCalls: 16, toolTimeoutMs: 10000 });
          expect(config.agent.systemPrompt).not.toContain('Runtime awareness');
          expect(payloads).toHaveLength(2);
          for (const payload of payloads) expect(JSON.stringify(payload.messages.filter(message => message.role === 'system'))).toContain('Runtime awareness');
          expect(JSON.stringify(db.query('SELECT entry_json FROM session_native_entries').all())).not.toContain('Runtime awareness');
          expect(output.agent.modelCalls.map((call: { callSequence: number }) => call.callSequence)).toEqual([1, 2]);
          expect(output.agent.modelCalls.every((call: { durationMs: number; complete: boolean }) =>
            Number.isFinite(call.durationMs) && call.durationMs >= 0 && call.complete)).toBe(true);
        }
        if (mode.startsWith('after-')) {
          expect(row.status).toBe('succeeded');
          expect(JSON.parse(row.result_json).data).not.toHaveProperty('forged');
          expect(terminal.result).toMatchObject({ ok: true, data: { status: 'failed' } });
          expect(requests).toBe(1);
          expect(fixedFacts).toEqual({ result: JSON.parse(row.result_json), runtimeObservation: observation, endedAt: row.ended_at, stoppedAt: row.stopped_at });
          const delivery = db.query('SELECT delivery_json FROM tool_calls').get() as { delivery_json: string };
          expect(JSON.parse(delivery.delivery_json)).toMatchObject({ state: 'failed', includedInCallSequence: null, requestDispatchedAt: null });
        }
      } finally { db.close(); }
    } finally { if (!closed) await app.close(); }
  }, 15_000);
}
