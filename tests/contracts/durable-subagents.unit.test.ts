import { expect, test } from 'bun:test';
import { appError, fail, DelegateArgsSchema, DurableSubagentConfigSnapshotSchema, DurableSubagentRunOutputSchema,
  DurableSubagentRunScopeSchema, RUNTIME_CONFIG, ToolExecutionContextSchema } from '@flowmate/contracts';

const origin = { parentRunId: 1, originToolCallId: 2, phaseId: 3, itemId: 4,
  parentRequestId: 'original-parent-phase', role: 'invoice-evidence-checker' } as const;
const scope = { version: 5, workId: 5, attemptId: 6, ...origin, allowedTools: ['read_invoice_document'],
  allowedDocumentIds: [7], allowedArtifactIds: [8], allowedResourcePaths: [] } as const;

test('Durable child facts retain product provenance without accepting plugin identity or write capabilities', () => {
  expect(DurableSubagentRunScopeSchema.parse(scope)).toEqual(scope);
  for (const name of ['Agent', 'save_invoice_candidate', 'write', 'bash'])
    expect(DurableSubagentRunScopeSchema.safeParse({ ...scope, allowedTools: [name] }).success).toBe(false);
  expect(DurableSubagentRunScopeSchema.safeParse({ ...scope, pluginAgentId: 'old-plugin' }).success).toBe(false);
  expect(DurableSubagentRunScopeSchema.safeParse({ ...scope, allowedDocumentIds: [7, 7] }).success).toBe(false);
  const config = { version: 4, runtimeKind: 'durable', name: 'Original parent model', revision: 1,
    requestedModel: { provider: 'controlled', model: 'explicit' }, resolvedModel: null, api: null, endpoint: null,
    sdk: { durable: '1.4.0', ai: '1.4.0', chord: '1.4.0' }, parameters: { maxRetries: 0, maxRetryDelayMs: 1000 },
    runtimeBudget: { maxToolCalls: 24, maxModelCalls: 12, toolTimeoutMs: 10_000, maxToolFeedbackBytes: RUNTIME_CONFIG.runBudget.maxToolFeedbackBytes },
    limits: { timeoutMs: RUNTIME_CONFIG.request.timeoutMs, stopGraceMs: RUNTIME_CONFIG.request.stopGraceMs },
    durable: { workId: 5, attemptId: 6, configurationRevision: 0 }, resources: { prompt: null, enabledSkills: [] },
    extensions: { enabledExtensions: [] }, workingDirectory: null, subagent: origin };
  expect(DurableSubagentConfigSnapshotSchema.parse(config)).toEqual(config);
  expect(DurableSubagentConfigSnapshotSchema.safeParse({ ...config, subagent: { ...origin, pluginVersion: '0.19.0' } }).success).toBe(false);
  const output = { version: 4, text: 'Evidence remains uncertain.', partial: false, stopReason: 'stop', responseId: null,
    responseModel: null, durable: { workId: 5, attemptId: 6 }, subagent: origin } as const;
  expect(DurableSubagentRunOutputSchema.parse(output)).toEqual(output);
});

test('the native delegate control belongs to trusted execution context and cannot be a model argument', () => {
  const nativeDelegate = async () => fail(appError('subagent_unavailable', 'runtime', 'Controlled native invocation is unavailable.'));
  const context = { runId: 1, sessionId: 2, nativeToolCallId: 'durable-task:3', signal: new AbortController().signal,
    scope: { version: 2, allowedTools: ['Agent'], allowedDocumentIds: [7], allowedArtifactIds: [8], allowedResourcePaths: [] }, nativeDelegate };
  expect(ToolExecutionContextSchema.parse(context).nativeDelegate).toBe(nativeDelegate);
  expect(ToolExecutionContextSchema.safeParse({ ...context, nativeDelegate: 'native-handle' }).success).toBe(false);
  expect(DelegateArgsSchema.safeParse({ prompt: 'Verify the original source.', description: 'Independent source check',
    subagent_type: origin.role, nativeDelegate }).success).toBe(false);
});
