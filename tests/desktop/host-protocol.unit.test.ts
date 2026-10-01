import { describe, expect, it } from 'bun:test';
import { parseHostCommand } from '../../apps/host/protocol.ts';

describe('versioned desktop Host protocol', () => {
  it('validates human candidate commands and original-operation lookup without model or Run fields', () => {
    const base = { operationRef: 'human-fixture-1', jobId: 7, candidateId: 9, expectedCandidateId: 9, expectedRevision: 3 };
    for (const command of [
      { type: 'accept_invoice_candidate', input: { ...base, dirty: false } },
      { type: 'reject_invoice_candidate', input: { ...base, reason: 'Reviewed and incorrect' } },
      { type: 'export_invoice_candidate', input: { operationRef: base.operationRef, candidateId: 9, format: 'json' } },
      { type: 'query_invoice_candidate_operation', input: { kind: 'accept', request: { ...base, dirty: false } } },
    ]) {
      expect(parseHostCommand({ version: 1, requestId: 'human-wire', ...command })).not.toBeNull();
      expect(parseHostCommand({ version: 1, requestId: 'human-wire', ...command, input: { ...command.input, runId: 2 } })).toBeNull();
    }
    expect(parseHostCommand({ version: 1, requestId: 'human-wire', type: 'accept_invoice_candidate', input: { ...base, dirty: true } })).toBeNull();
  });
  it('separates trusted Fill admission from ordinary Send and validates private application replies', () => {
    const input = { modelId: 'profile-1', clientSequence: 3, target: { formInstanceId: 'form-1', expectedRevision: 0 },
      workspace: { revision: 2, documentRef: { id: 4, version: 'v1' }, jobId: 7, candidateRef: { id: 9, sequence: 1 }, sessionId: 12 } };
    const command = { version: 1, requestId: 'fill-1', type: 'submit_invoice_form_input', input,
      expectedSettingsRevision: 4, expectedCredentialRef: 'credential_reference_1234' } as const;
    expect(parseHostCommand(command)).toEqual(command);
    expect(parseHostCommand({ ...command, input: { ...input, goalMode: 'answer' } })).toBeNull();
    expect(parseHostCommand({ ...command, input: { ...input, candidate: {} } })).toBeNull();
    expect(parseHostCommand({ ...command, input: { ...input, clientSequence: 0 } })).toBeNull();
    const receipt = { runId: 101, toolCallId: 21, formInstanceId: 'form-1', candidateId: 9, candidateSequence: 1,
      observedAt: '2026-10-01T00:00:00.000Z', outcome: 'unknown' } as const;
    const reply = { version: 1, requestId: 'application-1', type: 'invoice_form_response', receipt } as const;
    expect(parseHostCommand(reply)).toEqual(reply);
    expect(parseHostCommand({ ...reply, receipt: { ...receipt, outcome: 'applied' } })).toBeNull();
    expect(parseHostCommand({ ...reply, execute: 'arbitrary script' })).toBeNull();
    expect(parseHostCommand({ version: 1, requestId: 'lookup-1', type: 'query_invoice_form_application',
      input: { runId: 101, toolCallId: 21 } })).not.toBeNull();
    expect(parseHostCommand({ version: 1, requestId: 'lookup-2', type: 'query_session_input',
      input: { sessionId: 12, clientSequence: 3 } })).not.toBeNull();
  });
  it('accepts optional working directories on ordinary Runs and rejects retired or forged permissions', () => {
    expect(parseHostCommand({ version: 1, requestId: 'local-new', type: 'create_local_task_session', input: { title: 'Local task' } })).toBeNull();
    expect(parseHostCommand({ version: 1, requestId: 'native-tools', type: 'query_native_tools' })).not.toBeNull();
    expect(parseHostCommand({ version: 1, requestId: 'local-new', type: 'create_local_task_session', input: { title: 'Local task', toolProfile: 'trusted-local' } })).toBeNull();
    const request = { version: 1, requestId: 'local-start', type: 'start_run', input: {
      sessionId: 5, text: 'Read this directory.', modelId: 'profile-1', goalMode: 'answer',
      workspace: { revision: 0, documentRef: null, jobId: null, candidateRef: null, sessionId: 5 },
      workingDirectory: 'D:\\work',
    }, expectedSettingsRevision: 4, expectedCredentialRef: 'credential_reference_1234' } as const;
    expect(parseHostCommand(request)).toEqual(request);
    for (const input of [
      { ...request.input, goalMode: 'unknown' },
      { ...request.input, goalMode: 'local-task' },
      { ...request.input, workingDirectory: 'relative' },
      { ...request.input, workingDirectory: ' ' },
      { ...request.input, localTask: { workingDirectory: 'D:\\work' } },
      { ...request.input, commandAccess: 'all' },
      { ...request.input, workspace: undefined },
    ]) expect(parseHostCommand({ ...request, input })).toBeNull();
  });
  it('accepts only bounded native message queries', () => {
    const request = { version: 1, requestId: 'messages-1', type: 'list_session_messages', input: { sessionId: 4 } };
    expect(parseHostCommand(request)).toMatchObject({ ...request, input: { sessionId: 4, limit: 50 } });
    for (const input of [{ sessionId: 0 }, { sessionId: 4, limit: 101 }, { sessionId: 4, limit: null },
      { sessionId: 4, beforeEntryId: 'x'.repeat(129) }, { sessionId: 4, beforeEntryId: null }, { sessionId: 4, role: 'assistant' }]) {
      expect(parseHostCommand({ ...request, input })).toBeNull();
    }
  });
  it('accepts only typed commands and bounded identifiers', () => {
    expect(parseHostCommand({ version: 1, requestId: 'rpc-1', type: 'query_run', runId: 2 })).toEqual({
      version: 1, requestId: 'rpc-1', type: 'query_run', runId: 2,
    });
    expect(parseHostCommand({ version: 1, requestId: 'rpc-2', type: 'query_run', runId: -1 })).toBeNull();
    expect(parseHostCommand({ version: 1, requestId: 'rpc-3', type: 'query_run', runId: 1, sql: 'DROP TABLE runs' })).toBeNull();
    expect(parseHostCommand({ version: 2, requestId: 'rpc-4', type: 'get_state' })).toBeNull();
  });

  it('accepts provider requests without putting credentials in the command', () => {
    const value = {
      version: 1,
      requestId: 'run-request-1',
      type: 'call_provider',
      input: { goal: 'Reply briefly', text: 'Hello', modelId: 'model-1' },
    } as const;
    expect(parseHostCommand(value)).toEqual(value);
    expect(parseHostCommand({ ...value, input: { ...value.input, modelId: '../outside' } })).toBeNull();
    expect(parseHostCommand({ ...value, apiKey: 'synthetic-test-key' })).toBeNull();
  });

  it('allows only a bounded material identifier for access revocation', () => {
    expect(parseHostCommand({ version: 1, requestId: 'revoke-1', type: 'revoke_document_use', documentId: 8 }))
      .toEqual({ version: 1, requestId: 'revoke-1', type: 'revoke_document_use', documentId: 8 });
    expect(parseHostCommand({ version: 1, requestId: 'revoke-2', type: 'revoke_document_use', documentId: 0 })).toBeNull();
    expect(parseHostCommand({ version: 1, requestId: 'revoke-3', type: 'revoke_document_use', documentId: 8, sessionId: 3 })).toBeNull();
  });

  it('accepts strict session and Agent commands without embedded credentials', () => {
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
      input: {
        sessionId: 5, text: 'Invoice summary', modelId: 'profile-1', timeoutMs: 60_000,
        workspace: { revision: 0, documentRef: null, jobId: null, candidateRef: null, sessionId: 5 }, goalMode: 'answer',
      },
      expectedSettingsRevision: 4,
      expectedCredentialRef: 'credential_reference_1234',
    } as const;
    expect(parseHostCommand(start)).toEqual(start);
    expect(parseHostCommand({ ...start, apiKey: 'synthetic-test-key' })).toBeNull();
    expect(parseHostCommand({ ...start, input: { ...start.input, apiKey: 'renderer-secret' } })).toBeNull();
    expect(parseHostCommand({ ...start, expectedCredentialRef: '../outside' })).toBeNull();
    expect(parseHostCommand({ ...start, expectedSettingsRevision: 0 })).toBeNull();
    expect(parseHostCommand({ ...start, type: 'cancel_run', runId: 5 })).toBeNull();
    expect(parseHostCommand({ version: 1, requestId: 'stop-1', type: 'cancel_run', runId: 5, apiKey: 'secret' })).toBeNull();
  });
});
