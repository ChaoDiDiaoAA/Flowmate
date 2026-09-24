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

  it('accepts Agent Session commands and only accepts an API key beside a Send', () => {
    expect(parseHostCommand({ version: 1, requestId: 'session-1', type: 'create_session', title: 'Invoice A' })).toEqual({
      version: 1, requestId: 'session-1', type: 'create_session', title: 'Invoice A',
    });
    const send = {
      version: 1, requestId: 'agent-1', type: 'start_agent_run',
      input: { sessionId: 3, text: 'Follow up', modelId: 'model-a' }, apiKey: 'synthetic-key',
    } as const;
    expect(parseHostCommand(send)).toEqual(send);
    expect(parseHostCommand({ ...send, input: { ...send.input, nativeSessionId: 'forged' } })).toBeNull();
    expect(parseHostCommand({ version: 1, requestId: 'list-1', type: 'list_sessions', limit: 50 })).not.toBeNull();
    expect(parseHostCommand({ version: 1, requestId: 'cancel-1', type: 'cancel_run', runId: 3 })).not.toBeNull();
  });
});
