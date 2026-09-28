import { describe, expect, it } from 'bun:test';
import { parseHostCommand } from '../../apps/host/protocol.ts';

describe('versioned desktop Host protocol', () => {
  it('accepts only typed commands and bounded identifiers', () => {
    expect(parseHostCommand({ version: 1, requestId: 'rpc-1', type: 'query_run', runId: 2 })).toEqual({
      version: 1, requestId: 'rpc-1', type: 'query_run', runId: 2,
    });
    expect(parseHostCommand({ version: 1, requestId: 'rpc-2', type: 'query_run', runId: -1 })).toBeNull();
    expect(parseHostCommand({ version: 1, requestId: 'rpc-3', type: 'query_run', runId: 1, sql: 'DROP TABLE runs' })).toBeNull();
    expect(parseHostCommand({ version: 2, requestId: 'rpc-4', type: 'get_state' })).toBeNull();
  });

  it('keeps the ephemeral model credential only on the explicit provider command', () => {
    const value = {
      version: 1,
      requestId: 'run-request-1',
      type: 'call_provider',
      input: { goal: 'Reply briefly', text: 'Hello', modelId: 'model-1' },
      apiKey: 'synthetic-test-key',
    } as const;
    expect(parseHostCommand(value)).toEqual(value);
    expect(parseHostCommand({ ...value, input: { ...value.input, modelId: '../outside' } })).toBeNull();
    expect(parseHostCommand({ ...value, apiKey: undefined })).toBeNull();
  });

  it('accepts strict session and Agent commands with credentials only on Main-to-Host start', () => {
    expect(parseHostCommand({ version: 1, requestId: 'new-1', type: 'create_session', input: { title: 'Invoice' } }))
      .toEqual({ version: 1, requestId: 'new-1', type: 'create_session', input: { title: 'Invoice' } });
    expect(parseHostCommand({ version: 1, requestId: 'sessions-1', type: 'list_sessions', input: { limit: 20 } })).not.toBeNull();
    expect(parseHostCommand({ version: 1, requestId: 'query-session-1', type: 'query_session', sessionId: 5 })).not.toBeNull();
    expect(parseHostCommand({ version: 1, requestId: 'rename-session-1', type: 'rename_session', input: { sessionId: 5, title: 'Invoice review' } })).not.toBeNull();
    expect(parseHostCommand({ version: 1, requestId: 'rename-session-2', type: 'rename_session', input: { sessionId: 5, title: '  ' } })).toBeNull();
    expect(parseHostCommand({ version: 1, requestId: 'delete-1', type: 'delete_session', sessionId: 5 })).toEqual({ version: 1, requestId: 'delete-1', type: 'delete_session', sessionId: 5 });
    expect(parseHostCommand({ version: 1, requestId: 'delete-2', type: 'delete_session', sessionId: -1 })).toBeNull();
    expect(parseHostCommand({ version: 1, requestId: 'runs-1', type: 'list_session_runs', input: { sessionId: 5, limit: 20 } })).not.toBeNull();
    expect(parseHostCommand({ version: 1, requestId: 'trace-1', type: 'query_prompt_trace', runId: 5, callSequence: 1 })).not.toBeNull();
    expect(parseHostCommand({ version: 1, requestId: 'trace-2', type: 'query_prompt_trace', runId: 5, raw: true })).toBeNull();
    expect(parseHostCommand({ version: 1, requestId: 'runtime-1', type: 'query_runtime_state' })).not.toBeNull();

    const start = {
      version: 1,
      requestId: 'agent-1',
      type: 'start_run',
      input: { sessionId: 5, text: 'Invoice summary', modelId: 'profile-1', timeoutMs: 60_000 },
      apiKey: 'synthetic-test-key',
      expectedSettingsRevision: 4,
      expectedCredentialRef: 'credential_reference_1234',
    } as const;
    expect(parseHostCommand(start)).toEqual(start);
    expect(parseHostCommand({ ...start, input: { ...start.input, apiKey: 'renderer-secret' } })).toBeNull();
    expect(parseHostCommand({ ...start, expectedCredentialRef: '../outside' })).toBeNull();
    expect(parseHostCommand({ ...start, expectedSettingsRevision: 0 })).toBeNull();
    expect(parseHostCommand({ ...start, type: 'cancel_run', runId: 5 })).toBeNull();
    expect(parseHostCommand({ version: 1, requestId: 'stop-1', type: 'cancel_run', runId: 5, apiKey: 'secret' })).toBeNull();
  });
});
